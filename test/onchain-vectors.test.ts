import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registryOf, type OpenedDeclaration } from "../src/declaration.js";
import {
  channelKeys,
  lotAddress,
  merchantAcceptanceAddress,
  outerKey,
  restKeys,
  saleKeys,
  saleOf,
  seenKeys
} from "../src/derive.js";
import {
  InvalidInvoiceError,
  NetworkError,
  SattlemeError,
  type InvalidOrderError
} from "../src/errors.js";
import { parseIntegrationKey, type IntegrationKey } from "../src/key.js";
import { decodeBolt11, type Bolt11 } from "../src/lightning/bolt11.js";
import { conversationKey, nip44Decrypt } from "../src/nostr/nip44.js";
import { openRecord, sealRecord } from "../src/nostr/record.js";
import { publicKeyOf, signatureChecks, type NostrEvent } from "../src/nostr/event.js";
import {
  RelayPool,
  entryOf,
  readCompletely,
  readOutcome,
  readPages,
  type PageQuery,
  type RelayState
} from "../src/nostr/relay.js";
import { btcAmount, isDepositAddress, leaseAddress, paymentUri } from "../src/onchain/address.js";
import { Explorer } from "../src/onchain/explorer.js";
import {
  isConfirmedLease,
  isLeased,
  leaseConfirmed,
  leaseEvent,
  openLeaseInside,
  openLeaseOutside,
  openLeaseRecord,
  type LeaseHold,
  type LeaseOutside,
  type LeaseRecord,
  type SaleLeaseRecord
} from "../src/onchain/lease.js";
import {
  acceptanceRecordEvent,
  openAcceptanceRecord,
  publishAcceptance
} from "../src/onchain/acceptance.js";
import { parseLot } from "../src/onchain/lot.js";
import {
  merchantAcceptanceKeys,
  merchantAcceptanceOf,
  openMerchantAcceptance,
  readMerchantAcceptance,
  type MerchantAcceptance
} from "../src/onchain/merchant-acceptance.js";
import { methodsWith, paymentMethods, type LeaseOutcome } from "../src/onchain/methods.js";
import {
  checkOnchainPart,
  combineParts,
  restSummary,
  type LightningPart,
  type RestPart,
  type Settled
} from "../src/onchain/payment.js";
import { paymentParts } from "../src/onchain/replacements.js";
import { dueOnchain, leastAccepted, toleranceOf } from "../src/onchain/tolerance.js";
import {
  addressesNamed,
  addressTag,
  openWitness,
  orderTag,
  orderWitnessesOf,
  seenOf,
  witnessAddress,
  witnessEvent,
  type OrderWitnesses,
  type Witness
} from "../src/onchain/witness.js";
import { checkOrder } from "../src/order.js";
import {
  COMPLETE_READ_LIMIT,
  MAX_PAGES,
  MEMPOOL_URL,
  MERCHANT_ACCEPTANCE_RECORD_TYPE,
  MERCHANT_ACCEPTANCE_VERSION,
  ORDER_TAG,
  WITNESS_RECORD_TYPE,
  WITNESS_VERSION
} from "../src/protocol.js";
import { heldBy, invoicesOf, mayStillBePaid, newestRecords, pendingOutcome } from "../src/sales.js";
import { secureRandomBytes } from "../src/random.js";
import type { PaymentStatus } from "../src/types.js";

import { fakeFetch, type JsonAnswer } from "./helpers/fetch.js";
import { RelayNet } from "./helpers/relay.js";
import { fixedRandom } from "./helpers/rest-vectors.js";
import { appVectors, readSpec } from "./helpers/vectors.js";

/*
 * The package against the on-chain conformance vectors (SPEC.md §31) of the pinned copy of the
 * specification: deposit addresses, the methods of an order, leases, witnesses, replacements and
 * the statuses of an invoice with an address. Read only: these vectors are written in
 * checkout-spec.
 */

type Event = NostrEvent;

/** The error of `run` as the vectors write it: `{ error: code, param? }`. */
function outcome(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof SattlemeError)) throw error;
    const param = (error as InvalidOrderError).param;
    return { error: error.code, ...(param ? { param } : {}) };
  }
}

describe("vectors/app/onchain-lot.json", () => {
  const vector = readSpec<{
    secretKey: string;
    team: string;
    lotAddress: string;
    channelEncryptionKey: string;
    lot: { event: Event; value: { t: string; v: { addresses: string[] } } };
  }>("vectors/app/onchain-lot.json");

  it("opens the lot the merchant's app made, with the integration key alone", () => {
    const access = parseIntegrationKey(vector.secretKey);
    const { encryptionKey } = channelKeys(access.key);
    expect({
      team: access.teamPublicKey,
      lotAddress: lotAddress(access.key),
      channelEncryptionKey: bytesToHex(encryptionKey)
    }).toEqual({
      team: vector.team,
      lotAddress: vector.lotAddress,
      channelEncryptionKey: vector.channelEncryptionKey
    });
    const opened = openRecord(vector.lot.event, {
      type: vector.lot.value.t,
      encryptionKey,
      address: vector.lotAddress,
      author: vector.team,
      parse: (value, event) => parseLot(value, event.created_at)
    });
    expect(opened).toMatchObject({ status: "ok", value: vector.lot.value.v.addresses });
  });
});

describe("vectors/app/merchant-acceptance.json", () => {
  type Record = {
    name: string;
    invoice: number;
    event: Event;
    expected: { received: number; createdAt: number } | "newer" | null;
  };
  const vector = readSpec<{
    secretKey: string;
    team: string;
    channelEncryptionKey: string;
    invoices: {
      ref: string;
      saleKey: string;
      sale: string;
      onchainAddress: string;
      expiresAt: number;
      sats: string;
      acceptanceAddress: string;
    }[];
    records: Record[];
    made: { teamSecret: string; team: string; secretKey: string; records: Record[] };
  }>("vectors/app/merchant-acceptance.json");
  const access = parseIntegrationKey(vector.secretKey);
  const madeAccess = parseIntegrationKey(vector.made.secretKey);

  it("is of the team and the channel's key of its integration key", () => {
    expect([access.teamPublicKey, bytesToHex(channelKeys(access.key).encryptionKey)]).toEqual([
      vector.team,
      vector.channelEncryptionKey
    ]);
  });

  it("made: by a team of its own, for the same integration", () => {
    expect([madeAccess.teamPublicKey, bytesToHex(madeAccess.key)]).toEqual([
      vector.made.team,
      bytesToHex(access.key)
    ]);
    expect(publicKeyOf(hexToBytes(vector.made.teamSecret))).toBe(vector.made.team);
  });

  it.each(vector.invoices)(
    "the merchant's acceptance address of $ref at $expiresAt",
    ({ ref, saleKey, sale, onchainAddress, expiresAt, acceptanceAddress }) => {
      const keys = saleKeys(access.key, ref);
      expect([bytesToHex(keys.key), keys.author]).toEqual([saleKey, sale]);
      expect(merchantAcceptanceAddress(access.key, sale, onchainAddress, expiresAt)).toBe(
        acceptanceAddress
      );
    }
  );

  /**
   * `c` read as a check reads it for its invoice, with the integration key of `secretKey`: through
   * the reading of one record (openMerchantAcceptance), and through the count of a read on every
   * relay where each relay sent it (merchantAcceptanceOf).
   */
  const readRecord = (c: Record, key: IntegrationKey) => {
    const invoice = vector.invoices[c.invoice]!;
    const keys = merchantAcceptanceKeys(
      key.key,
      key.teamPublicKey,
      invoice.sale,
      invoice.onchainAddress,
      invoice.expiresAt
    );
    const terms = { sats: BigInt(invoice.sats), expiresAt: invoice.expiresAt };
    const opened = openMerchantAcceptance(c.event, keys, terms);
    expect(
      opened === null || opened.status === "newer, set aside"
        ? null
        : opened.status === "newer"
          ? "newer"
          : { received: Number(opened.received), createdAt: opened.event.created_at }
    ).toEqual(c.expected);
    const everyRelay = new Map(["a", "b", "c"].map((relay) => [relay, [c.event]]));
    expect(merchantAcceptanceOf(everyRelay, keys, terms, 3).received).toEqual(
      c.expected === null || c.expected === "newer" ? null : BigInt(c.expected.received)
    );
  };

  it.each(vector.records)("$name", (c) => readRecord(c, access));
  it.each(vector.made.records)("$name", (c) => readRecord(c, madeAccess));
});

describe("onchain-addresses.json", () => {
  const { addresses, registry, uris, amounts } = readSpec<{
    addresses: { name: string; address: string; valid: boolean }[];
    registry: { registryKey: string; cases: { address: string; registryAddress: string }[] };
    uris: {
      name: string;
      address: string | null;
      sats: string;
      bolt11: string | null;
      uri: string;
    }[];
    amounts: { sats: string; btc: string }[];
  }>("vectors/onchain-addresses.json");

  it.each(addresses)("$name: $valid", ({ address, valid }) => {
    expect(isDepositAddress(address)).toBe(valid);
  });
  it.each(registry.cases)("the registry address of $address", ({ address, registryAddress }) => {
    expect(leaseAddress(hexToBytes(registry.registryKey), address)).toBe(registryAddress);
  });
  it.each(uris)("payment URI: $name", ({ address, sats, bolt11, uri }) => {
    expect(paymentUri(address, BigInt(sats), bolt11)).toBe(uri);
  });
  it.each(amounts)("$sats sats is $btc BTC", ({ sats, btc }) => {
    expect(btcAmount(BigInt(sats))).toBe(btc);
  });
});

describe("payment-methods.json", () => {
  const { cases } = readSpec<{
    cases: {
      name: string;
      sats: string;
      sendable: { min: string; max: string };
      address: "leased" | "none" | "explorer_failed";
      expected: unknown;
    }[];
  }>("vectors/payment-methods.json");

  it.each(cases)("$name", ({ sats, sendable, address, expected }) => {
    const leased: LeaseOutcome =
      address === "explorer_failed"
        ? { status: address, error: new NetworkError("The explorer did not answer") }
        : { status: address };
    expect(
      outcome(() => {
        const order = checkOrder({ ref: "A-1", sats }, []);
        const methods = methodsWith(
          paymentMethods(
            order.sats!,
            { min: BigInt(sendable.min), max: BigInt(sendable.max) },
            "sats"
          ),
          leased
        );
        return {
          methods: [
            ...(methods.lightning ? ["lightning"] : []),
            ...(methods.onchain ? ["onchain"] : [])
          ]
        };
      })
    ).toEqual(expected);
  });
});

type VectorLeaseRecord = {
  author: string;
  createdAt: number;
  outside: unknown;
  signature?: false;
  id?: false;
  eventId?: string;
};

describe("onchain-leases.json", () => {
  const vectors = readSpec<{
    registryKey: string;
    registryReader: string;
    saleAuthor: string;
    saleSecret: string;
    innerConversationKey: string;
    derived: { address: string; registryAddress: string; outerKey: string }[];
    events: {
      name: string;
      address: string;
      event: Event;
      outside: unknown;
      inside: Record<string, unknown> | null;
      tolerance?: number;
      signature?: false;
      confirmed?: boolean;
    }[];
    leased: {
      name: string;
      records: VectorLeaseRecord[];
      t: number;
      expected: boolean;
      checked: number[];
    }[];
    confirmed: {
      name: string;
      records: VectorLeaseRecord[];
      sale: string;
      lease: number | null;
      t: number;
      complete: boolean;
      expected: boolean;
    }[];
  }>("vectors/onchain-leases.json");
  const registryKey = hexToBytes(vectors.registryKey);
  // The sale of vectors/app/app.json's declaration, in this registry.
  const sale = saleOf(
    hexToBytes(appVectors.parsed.integrationKey),
    registryOf(vectors.registryKey, vectors.registryReader),
    appVectors.declaration.ref
  );

  it("is the sale of the app's declaration", () => {
    expect({
      saleAuthor: sale.author,
      saleSecret: bytesToHex(sale.secretKey),
      innerConversationKey: bytesToHex(sale.innerKey)
    }).toEqual({
      saleAuthor: vectors.saleAuthor,
      saleSecret: vectors.saleSecret,
      innerConversationKey: vectors.innerConversationKey
    });
  });

  it.each(vectors.derived)(
    "the keys of $address",
    ({ address, registryAddress, outerKey: key }) => {
      const d = leaseAddress(registryKey, address);
      expect({
        registryAddress: d,
        outerKey: bytesToHex(outerKey(registryKey, d, sale.author))
      }).toEqual({ registryAddress, outerKey: key });
    }
  );

  const outsideOf = (opened: { outside: LeaseOutside } | null) => {
    if (!opened) return null;
    const { outside } = opened;
    if (outside.kind === "newer") return "newer";
    if (outside.kind === "withdrawn") return { version: 1, withdrawn: true };
    return { version: 1, end: outside.end, sealed: outside.sealed };
  };

  it.each(vectors.events)("$name", (c) => {
    const { address, event, outside, inside, tolerance, signature, confirmed } = c;
    const d = leaseAddress(registryKey, address);
    const record = openLeaseRecord(event, registryKey, d);
    const whole = openLeaseOutside(event, registryKey, d);
    expect(outsideOf(whole)).toEqual(outside);
    // A read keeps of it only its id, author, date and signature, and its outside's end.
    expect(record?.event ?? null).toEqual(
      whole && {
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        sig: event.sig
      }
    );
    // Opening it checks no signature; the record checks it when asked.
    expect(signatureChecks(event)).toBe(signature ?? true);
    if (record) expect(record.signed()).toBe(signature ?? true);
    const opened = whole?.outside.kind === "lease" ? openLeaseInside(whole.outside, d, sale) : null;
    expect(opened?.inside ?? null).toEqual(inside);
    // The order's tolerance it gives: absent, or not one, none.
    expect(opened?.terms.tolerance ?? null).toEqual(inside ? (tolerance ?? 0) : null);
    // Confirmed: `confirmed` true alone (the vector's field, absent: true).
    expect(opened ? isConfirmedLease(opened.terms) : null).toEqual(
      inside ? (confirmed ?? true) : null
    );
  });

  // A lease the package makes for the same sale and terms opens with the vector's keys into the
  // vector's inside.
  it.each(vectors.events.filter(({ inside }) => inside !== null))(
    "makes $name again",
    ({ address, event, outside, inside }) => {
      const v = inside!;
      const fiat = (v.sale as { fiat: { minor: number; digits: number; currency: string } }).fiat;
      const made = leaseEvent({
        sale,
        terms: {
          address,
          sats: BigInt(v.sats as number),
          invoice: v.invoice as string | null,
          verifyUrl: v.verifyUrl as string | null,
          createdAt: v.createdAt as number,
          expiresAt: v.expiresAt as number,
          price: fiat,
          note: (v.sale as { note: string }).note,
          tolerance: (v.tolerance as number | undefined) ?? 0,
          ...("confirmed" in v ? { confirmed: v.confirmed as boolean } : {})
        },
        createdAt: event.created_at
      });
      const d = leaseAddress(registryKey, address);
      expect(made.tags).toEqual([["d", d]]);
      expect(made.pubkey).toBe(vectors.saleAuthor);
      const derived = vectors.derived.find((c) => c.address === address)!;
      const plaintext = nip44Decrypt(made.content, hexToBytes(derived.outerKey));
      expect(new TextEncoder().encode(plaintext).length % 256).toBe(0);
      const record = JSON.parse(plaintext) as { t: string; v: { end: number; sealed: string } };
      expect(record.t).toBe("registry-onchain");
      expect(record.v.end).toBe((outside as { end: number }).end);
      const sealed = nip44Decrypt(record.v.sealed, hexToBytes(vectors.innerConversationKey));
      expect(sealed).toBe(JSON.stringify(inside));
      expect(conversationKey(sale.secretKey, vectors.registryReader)).toEqual(
        hexToBytes(vectors.innerConversationKey)
      );
    }
  );

  /** The records of a vector, as opened (one whose id is not its hash never is). */
  const recordsOf = (records: VectorLeaseRecord[], checked: number[] = []) =>
    records.flatMap(
      ({ author, createdAt, outside, signature, id, eventId }, index): LeaseRecord[] => {
        if (id === false) return [];
        const o = outside as { withdrawn?: boolean; end?: number } | "newer";
        const kind: LeaseHold =
          o === "newer"
            ? { kind: "newer" }
            : o.withdrawn
              ? { kind: "withdrawn" }
              : { kind: "lease", end: o.end! };
        return [
          {
            event: {
              pubkey: author,
              created_at: createdAt,
              id: eventId ?? String(index).padStart(64, "0")
            } as Event,
            d: "",
            outside: kind,
            signed: () => {
              checked.push(index);
              return signature !== false;
            },
            addCopy: () => {}
          }
        ];
      }
    );

  it.each(vectors.leased)("leased: $name", ({ records, t, expected, checked }) => {
    const asked: number[] = [];
    expect(isLeased(recordsOf(records, asked), t)).toBe(expected);
    // The signatures checked: those of the records that would end an older one's hold.
    expect(asked.sort((a, b) => a - b)).toEqual(checked);
  });

  it.each(vectors.confirmed)("confirmed: $name", (c) => {
    const records = recordsOf(c.records);
    // This lease, or one that is not among the records read.
    const own =
      c.lease === null
        ? ({ pubkey: c.sale, created_at: c.t, id: "f".repeat(64) } as Event)
        : records.find(({ event }) => event.id === String(c.lease).padStart(64, "0"))!.event;
    // The read of the address's leases, as the client has it once its lease is published: a
    // majority answered (else it fails with NetworkError, and confirms nothing), complete or not.
    const address = vectors.derived[0]!.address;
    const read = { records: new Map([[address, records]]), answered: true, complete: c.complete };
    expect(leaseConfirmed(read, address, own, c.t)).toBe(c.expected);
  });
});

describe("onchain-witnesses.json", () => {
  const vectors = readSpec<{
    integrationKey: string;
    channelEncryptionKey: string;
    sale: string;
    derived: { seenSecret: string; seenAuthor: string; seenAddressKey: string };
    addresses: { address: string; txid: string; sale: string | null; witnessAddress: string }[];
    orderTags: { address: string; sale: string | null; orderTag: string }[];
    addressTags: { address: string; addressTag: string }[];
    events: { name: string; event: Event; value: unknown; names: string[] }[];
  }>("vectors/onchain-witnesses.json");
  const integrationKey = hexToBytes(vectors.integrationKey);
  const seen = seenOf(integrationKey);

  it("derives the seen keys", () => {
    const keys = seenKeys(integrationKey);
    expect({
      seenSecret: bytesToHex(keys.secretKey),
      seenAuthor: keys.author,
      seenAddressKey: bytesToHex(keys.addressKey)
    }).toEqual(vectors.derived);
    expect(bytesToHex(seen.encryptionKey)).toBe(vectors.channelEncryptionKey);
  });
  it.each(vectors.addresses)("the witness address of $txid, $sale", (c) => {
    expect(witnessAddress(seen.addressKey, c.address, c.txid, c.sale)).toBe(c.witnessAddress);
  });
  it.each(vectors.orderTags)("the order tag of $address, $sale", (c) => {
    expect(orderTag(seen.addressKey, c.address, c.sale)).toBe(c.orderTag);
  });
  it.each(vectors.addressTags)("the address tag of $address", (c) => {
    expect(addressTag(seen.addressKey, c.address)).toBe(c.addressTag);
  });

  const valueOf = (event: Event) => {
    const opened = openWitness(event, seen);
    if (!opened) return null;
    if (opened.status === "newer") return "newer";
    const { witness } = opened;
    return {
      version: 1,
      address: witness.address,
      txid: witness.txid,
      sale: witness.sale,
      sats: Number(witness.sats),
      inputs: witness.inputs,
      replacement: witness.replacement,
      ...("expiresAt" in witness ? { expiresAt: witness.expiresAt } : {})
    };
  };
  it.each(vectors.events)("$name", ({ event, value }) => {
    expect(valueOf(event)).toEqual(value);
  });

  // The addresses an event names when leasing (SPEC.md, "Leasing an address", step 3), as
  // readNamedAddresses keeps them.
  const byTag = new Map(
    vectors.addressTags.map(({ address }) => [addressTag(seen.addressKey, address), address])
  );
  it.each(vectors.events)("names $names: $name", ({ event, names }) => {
    const named = addressesNamed(event, vectors.derived.seenAuthor, byTag);
    expect(named.sort()).toEqual([...names].sort());
  });

  // A witness the package makes for the same value has the vector's `d` and `o` tags (a vector's
  // other tags are ignored), and opens to it.
  it.each(vectors.events.filter(({ value }) => value !== null && value !== "newer"))(
    "makes $name again",
    ({ event, value }) => {
      const v = value as Omit<Witness, "sats"> & { sats: number };
      const made = witnessEvent(seen, { ...v, sats: BigInt(v.sats) }, event.created_at);
      expect(made.pubkey).toBe(vectors.derived.seenAuthor);
      expect(made.tags).toEqual(event.tags.filter(([name]) => name === "d" || name === "o"));
      expect(valueOf(made)).toEqual(value);
    }
  );
});

describe("onchain-replacements.json", () => {
  const { cases } = readSpec<{
    cases: {
      name: string;
      txs: {
        txid: string;
        sats: string;
        inputs: string[];
        order: number | null;
        listed: boolean;
      }[];
      parts: Record<string, { sats: string; root: string }[]>;
    }[];
  }>("vectors/onchain-replacements.json");

  it.each(cases)("$name", ({ txs, parts }) => {
    const made = paymentParts(txs.map((tx) => ({ ...tx, sats: BigInt(tx.sats) })));
    expect(
      Object.fromEntries(
        [...made].map(([txid, list]) => [
          txid,
          list.map(({ sats, root }) => ({ sats: sats.toString(), root }))
        ])
      )
    ).toEqual(parts);
  });
});

describe("onchain-payments.json", () => {
  type VectorWitness = { address?: "other" } & (
    | {
        txid: string;
        sale: "this" | "other" | null;
        sats: number;
        inputs: string[];
        replacement: boolean;
        seenAt: number;
        expiresAt?: number;
      }
    | { txid: string; sale: "newer" }
    | { txid: string; sale: "newer none" }
  );
  /** A merchant's acceptance the relays hold: valid, or of a newer format; `sentBy` of the 3. */
  type VectorMerchantAcceptance = { createdAt: number; id?: string; sentBy?: number } & (
    { received: string } | { newer: true }
  );
  const { invoice, cases } = readSpec<{
    invoice: { onchainAddress: string; sats: string; expiresAt: number };
    cases: {
      name: string;
      now: number;
      lightning: { state: string; preimage?: string } | { error: string } | null;
      explorer: { height: number; txs: unknown[] } | { error: true };
      witnesses: VectorWitness[] | "unreadable";
      witnessesAgain?: VectorWitness[] | "unreadable";
      publishFails: boolean;
      blockcypher: Record<string, string> | { error: true };
      rests?: {
        invoice: string;
        paymentHash: string;
        sats: string;
        createdAt: number;
        expiresAt: number;
        lightning: { state: string; preimage?: string } | { error: string };
      }[];
      tolerance?: number;
      accepted?: string;
      merchantAccepted?: VectorMerchantAcceptance[] | "unreadable";
      expected: unknown;
      published: { txid: string; sale: "this" | null; replacement: boolean }[];
      asked: string[];
      acceptance?: string;
    }[];
  }>("vectors/onchain-payments.json");
  const address = invoice.onchainAddress;
  const sale = appVectors.declaration.saleAuthor;
  const seen = seenOf(hexToBytes(appVectors.parsed.integrationKey));
  const witnessAt = (txid: string, of: string | null) =>
    witnessAddress(seen.addressKey, address, txid, of);
  // Another order's deposit address, and another sale.
  const otherAddress = "bc1p4gmh64rd4m5y5nn8hwfnvtz2mm6lngpmwys5a257klyg03ju0pyqu65xe8";
  const otherSale = saleKeys(hexToBytes(appVectors.parsed.integrationKey), "ANOTHER-ORDER").author;

  /**
   * The event of a witness of the vector, as a relay sends it: made by the seen secret as the
   * client makes witnesses (witnessEvent), at the invoice's address or, `address` "other", at
   * another order's; for the order's sale ("this", with the `expiresAt` of the invoice it is of),
   * another sale (with the invoice's `expiresAt`: nothing here depends on it) or none. One of a
   * newer format: a record of the seen secret at the witness address of its txid and the order's
   * sale ("newer") or none ("newer none"), with that address's `o` tags, dated `newerAt` (the
   * vector gives no date of it).
   */
  const eventOf = (w: VectorWitness, newerAt: number) => {
    const at = w.address === "other" ? otherAddress : address;
    if (w.sale === "newer" || w.sale === "newer none") {
      const of = w.sale === "newer" ? sale : null;
      return sealRecord({
        type: WITNESS_RECORD_TYPE,
        value: { version: WITNESS_VERSION + 1 },
        signer: seen.secretKey,
        encryptionKey: seen.encryptionKey,
        address: witnessAddress(seen.addressKey, at, w.txid, of),
        createdAt: newerAt,
        tags: [
          [ORDER_TAG, orderTag(seen.addressKey, at, of)],
          [ORDER_TAG, addressTag(seen.addressKey, at)]
        ]
      });
    }
    const of = w.sale === "this" ? sale : w.sale === "other" ? otherSale : null;
    return witnessEvent(
      seen,
      {
        address: at,
        txid: w.txid,
        sale: of,
        sats: BigInt(w.sats),
        inputs: w.inputs,
        replacement: w.replacement,
        expiresAt: of === null ? null : (w.expiresAt ?? invoice.expiresAt)
      },
      w.seenAt
    );
  };

  const errorOf = (code: string): SattlemeError =>
    code === "network"
      ? new NetworkError("The Lightning address did not answer")
      : code === "invalid_invoice"
        ? new InvalidInvoiceError("Not this invoice")
        : new SattlemeError(code, code);

  // The merchant's relays, local: the acceptance records of the invoice they hold (`accepted`),
  // and what the check publishes there (`acceptance`). The rest keys of the invoice, for an order
  // of the app's sale.
  const net = new RelayNet();
  const relayUrls = [
    "wss://acceptance-1.test",
    "wss://acceptance-2.test",
    "wss://acceptance-3.test"
  ];
  const rest = restKeys(
    hexToBytes(appVectors.parsed.integrationKey),
    appVectors.declaration.ref,
    address,
    invoice.expiresAt
  );
  beforeAll(async () => {
    for (const url of relayUrls) await net.add(url);
  });
  afterAll(() => net.close());

  /**
   * What the check publishes of an acceptance record when its status is `status` (SPEC.md,
   * "Acceptance records"), as the client does (publishAcceptance), on relays each of which holds
   * one of `accepted` (absent: none holds one), so that every majority that answers reads it: the
   * `received` of the records the relays took, null when none.
   */
  async function acceptancePublished(status: PaymentStatus, now: number, accepted?: string) {
    const relays = relayUrls.map((url) => net.get(url));
    for (const relay of relays) {
      relay.events.length = 0;
      relay.received.length = 0;
    }
    if (accepted !== undefined) {
      const held = acceptanceRecordEvent({
        keys: rest,
        received: BigInt(accepted),
        expiresAt: invoice.expiresAt,
        createdAt: now - 60
      });
      for (const relay of relays) relay.store(held);
    }
    const socket = net.WebSocket;
    const pool = new RelayPool({
      createSocket: (url) => new socket(url),
      timeoutMs: 2000,
      now: () => now
    });
    try {
      await publishAcceptance(
        pool,
        status,
        { sats: BigInt(invoice.sats), expiresAt: invoice.expiresAt },
        () => rest,
        relayUrls,
        { clock: () => now, random: secureRandomBytes, logger: { warn: () => {} } }
      );
    } finally {
      pool.close();
    }
    const took = new Set(
      relays.flatMap((relay) =>
        relay.received.map((event) => {
          const opened = openAcceptanceRecord(event, rest, BigInt(invoice.sats));
          return opened === null || opened === "newer" ? String(opened) : String(opened.received);
        })
      )
    );
    expect(took.size).toBeLessThanOrEqual(1);
    return took.size === 0 ? null : [...took][0]!;
  }

  it("makes witnesses of another order at a deposit address of its own", () => {
    expect([isDepositAddress(otherAddress), otherAddress === address]).toEqual([true, false]);
  });

  // The merchant's acceptances (the team's records, SPEC.md "The merchant's acceptance"), made by a
  // team of merchant-acceptance.json's own (`made`: its secret is in the vector) for the app's
  // integration key, so that they check out: at the address of the invoice of the order's sale.
  const { made: team } = readSpec<{ made: { teamSecret: string; secretKey: string } }>(
    "vectors/app/merchant-acceptance.json"
  );
  const teamAccess = parseIntegrationKey(team.secretKey);
  expect(bytesToHex(teamAccess.key)).toBe(appVectors.parsed.integrationKey);
  const merchantKeys = merchantAcceptanceKeys(
    teamAccess.key,
    teamAccess.teamPublicKey,
    sale,
    address,
    invoice.expiresAt
  );
  const terms = { sats: BigInt(invoice.sats), expiresAt: invoice.expiresAt };
  /**
   * The events of a case's merchant's acceptances, sealed and signed by the team: of its
   * `received` (a number, whatever it is), or of version 2 for one of a newer format, dated its
   * `createdAt`. Where the vector gives two of one date ids, made again until their ids sort as
   * the vector's do (the lowest counts).
   */
  const acceptanceEvents = (name: string, records: VectorMerchantAcceptance[]): NostrEvent[] => {
    const random = fixedRandom(`merchant's acceptance: ${name}`);
    for (;;) {
      const events = records.map((record) =>
        sealRecord({
          type: MERCHANT_ACCEPTANCE_RECORD_TYPE,
          value:
            "newer" in record
              ? { version: MERCHANT_ACCEPTANCE_VERSION + 1 }
              : { version: MERCHANT_ACCEPTANCE_VERSION, received: Number(record.received) },
          signer: hexToBytes(team.teamSecret),
          encryptionKey: merchantKeys.encryptionKey,
          address: merchantKeys.address,
          createdAt: record.createdAt,
          random
        })
      );
      const sorted = records.every(({ id: a }, i) =>
        records.every(({ id: b }, j) => !a || !b || a < b === events[i]!.id < events[j]!.id)
      );
      if (sorted) return events;
    }
  };
  /** The merchant's relays of the vector: 3, of which 2 are a majority. */
  const merchantRelays = [
    "wss://merchant-1.test",
    "wss://merchant-2.test",
    "wss://merchant-3.test"
  ];
  /** What each of the 3 relays holds: each record on the first `sentBy` of them (absent: all). */
  const heldByRelay = (name: string, records: VectorMerchantAcceptance[] | undefined) => {
    const events = acceptanceEvents(name, records ?? []);
    return new Map(
      merchantRelays.map((url, index) => [
        url,
        events.filter((_, i) => index < (records![i]!.sentBy ?? merchantRelays.length))
      ])
    );
  };
  /**
   * The check's read of the merchant's acceptance, through the package's count of what the relays
   * sent (merchantAcceptanceOf), each relay answering with what it holds; "unreadable": fewer than
   * a majority answered (NetworkError, as readMerchantAcceptance throws).
   */
  const countedRead = (c: (typeof cases)[number]) => () =>
    c.merchantAccepted === "unreadable"
      ? Promise.reject(new NetworkError("Fewer than a majority of the merchant's relays answered"))
      : Promise.resolve(
          merchantAcceptanceOf(
            heldByRelay(c.name, c.merchantAccepted),
            merchantKeys,
            terms,
            merchantRelays.length
          )
        );

  // The same, end to end: the merchant's 3 relays, local, each holding what heldByRelay says; the
  // check reads them on every relay (readMerchantAcceptance). The first, which holds every record,
  // answers 150 ms after the others: a read that went on with the first majority to answer would
  // miss what it holds. "unreadable": the 2 others never answer the read.
  const merchantNet = new RelayNet();
  beforeAll(async () => {
    for (const url of merchantRelays) await merchantNet.add(url);
  });
  afterAll(() => merchantNet.close());
  /** Runs `run` with the read over the local relays, then closes its pool. */
  const relayRead = async (
    c: (typeof cases)[number],
    run: (read: () => Promise<MerchantAcceptance>) => Promise<void>
  ) => {
    const held =
      c.merchantAccepted === "unreadable" ? null : heldByRelay(c.name, c.merchantAccepted);
    merchantRelays.forEach((url, index) => {
      const relay = merchantNet.get(url);
      relay.events.length = 0;
      relay.queries.length = 0;
      for (const event of held?.get(url) ?? []) relay.store(event);
      relay.received.length = 0;
      relay.behaviour =
        held === null && index > 0 ? { mute: true } : index === 0 ? { queryDelayMs: 150 } : {};
    });
    const socket = merchantNet.WebSocket;
    const pool = new RelayPool({
      createSocket: (url) => new socket(url),
      timeoutMs: 500,
      now: () => c.now
    });
    try {
      await run(() =>
        readMerchantAcceptance(pool, merchantKeys, terms, merchantRelays, {
          random: secureRandomBytes
        })
      );
    } finally {
      pool.close();
    }
    // Nothing published there: a check never publishes a merchant's acceptance, nor again.
    for (const url of merchantRelays) expect(merchantNet.get(url).received).toEqual([]);
    // Read on every relay, as the check reads it: each relay asked, by its address alone.
    const read = held !== null && merchantRelays.some((url) => merchantNet.get(url).queries.length);
    if (read) {
      for (const url of merchantRelays) {
        expect(merchantNet.get(url).queries).toEqual([
          { kinds: [30078], authors: [merchantKeys.team], "#d": [merchantKeys.address] }
        ]);
      }
    }
  };

  it("makes merchant's acceptances that check out, with the app's integration key", () => {
    const [event] = acceptanceEvents("check", [{ received: "30000", createdAt: 1791378300 }]);
    expect(openMerchantAcceptance(event, merchantKeys, terms)).toMatchObject({
      status: "ok",
      received: 30_000n
    });
  });

  it.each(cases)("$name", (c) => runCase(c, countedRead(c)));

  it.each(cases.filter((c) => c.merchantAccepted !== undefined))(
    "end to end on 3 local relays: $name",
    (c) => relayRead(c, (read) => runCase(c, read))
  );

  /**
   * One case through the package's payment check (checkOnchainPart, combineParts), with
   * `readMerchantAcceptance` as the check's read of the merchant's acceptance; then the acceptance
   * record it publishes (publishAcceptance).
   */
  async function runCase(
    c: (typeof cases)[number],
    readMerchantAcceptance: () => Promise<MerchantAcceptance>
  ) {
    const asked: string[] = [];
    const warnings: string[] = [];
    let readIt = false;
    const published: { txid: string; sale: "this" | null; replacement: boolean }[] = [];
    const text = (value: unknown): JsonAnswer => ({ status: 200, text: String(value) });
    const { fetch } = fakeFetch((url) => {
      const path = url.href;
      if (path === `${MEMPOOL_URL}/address/${address}/txs`) {
        return "error" in c.explorer ? { status: 500, text: "down" } : { json: c.explorer.txs };
      }
      if (path === `${MEMPOOL_URL}/blocks/tip/height`) {
        return "error" in c.explorer ? { status: 500, text: "down" } : text(c.explorer.height);
      }
      if (url.hostname === "api.blockcypher.com") {
        const txid = url.pathname.split("/").at(-1)!;
        asked.push(txid);
        if ("error" in c.blockcypher) return { status: 500, json: { error: "down" } };
        const received = c.blockcypher[txid];
        return received === undefined
          ? { status: 404, json: { error: `Transaction ${txid} not found.` } }
          : { json: { hash: txid, received, confirmations: 0 } };
      }
      throw new Error(`Not asked in this vector: ${path}`);
    });
    // The witnesses the check published, as the relays then hold them.
    const publishedEvents: unknown[] = [];
    let reads = 0;
    const witnesses = (): Promise<OrderWitnesses> => {
      // The first read, then the one after publishing: the vector's witnesses again, unless it
      // says, and those the check published.
      const again = reads++ > 0;
      const held = again ? (c.witnessesAgain ?? c.witnesses) : c.witnesses;
      if (held === "unreadable") {
        return Promise.reject(
          new NetworkError("Fewer than a majority of the merchant's relays answered")
        );
      }
      // What the relays sent to the read (`address` "other": of no invoice of the read, which a
      // relay sent anyway), read as readOrderWitnesses reads it.
      const sent = [
        ...held.map((w) => eventOf(w, c.now - 1)),
        ...(again && c.witnessesAgain === undefined ? publishedEvents : [])
      ];
      return Promise.resolve(orderWitnessesOf(sent, seen, address, sale, invoice.expiresAt));
    };
    // The rest part: the invoices of the rest the relays hold, and the Lightning part of each.
    const rests: RestPart | null = c.rests
      ? {
          invoices: c.rests.map(({ invoice: bolt11, paymentHash, sats, createdAt, expiresAt }) => {
            const decoded = decodeBolt11(bolt11)!;
            // What the vector writes of it is the invoice's own.
            expect({ paymentHash, sats, createdAt, expiresAt }).toEqual({
              paymentHash: decoded.paymentHash,
              sats: (decoded.amountMsat! / 1000n).toString(),
              createdAt: decoded.timestamp,
              expiresAt: decoded.timestamp + decoded.expirySeconds
            });
            return {
              bolt11,
              paymentHash: decoded.paymentHash,
              verifyUrl: `https://breez.tips/lnurlp/verify/${decoded.paymentHash}`,
              sats: decoded.amountMsat! / 1000n,
              createdAt: decoded.timestamp,
              expiresAt: decoded.timestamp + decoded.expirySeconds
            };
          }),
          results: c.rests.map(({ lightning: rest }) =>
            "error" in rest
              ? { ok: false, error: errorOf(rest.error) }
              : { ok: true, value: rest as LightningPart }
          )
        }
      : null;
    const onchain = await checkOnchainPart({
      address,
      sats: BigInt(invoice.sats),
      expiresAt: invoice.expiresAt,
      sale,
      clock: () => c.now,
      // The explorer read: mempool.space, the channel naming no node (bitcoin-nodes.json runs the
      // node's fallback).
      explorer: new Explorer(null, new Map(), () => c.now * 1000),
      http: { fetch, timeoutMs: 1000 },
      readWitnesses: witnesses,
      witnessAddress: witnessAt,
      publish: async (witness) => {
        if (c.publishFails) throw new NetworkError("Fewer than a majority took the witness");
        expect(witness.address).toBe(address);
        // Of this invoice: its expiresAt; of none: null.
        expect(witness.expiresAt).toBe(witness.sale === null ? null : invoice.expiresAt);
        published.push({
          txid: witness.txid,
          sale: witness.sale === null ? null : witness.sale === sale ? "this" : witness.sale,
          replacement: witness.replacement
        } as (typeof published)[number]);
        publishedEvents.push(witnessEvent(seen, witness, c.now));
      },
      logger: { warn: (message) => warnings.push(message) },
      paidByRests: Promise.resolve(restSummary(rests).paid),
      tolerance: Promise.resolve(toleranceOf(c.tolerance)),
      readMerchantAcceptance: () => {
        readIt = true;
        return readMerchantAcceptance();
      }
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    const lightning: Settled<LightningPart> | null =
      c.lightning === null
        ? null
        : "error" in c.lightning
          ? { ok: false, error: errorOf(c.lightning.error) }
          : { ok: true, value: c.lightning as LightningPart };
    let status: PaymentStatus | { error: string };
    try {
      status = combineParts(
        { sats: BigInt(invoice.sats), expiresAt: invoice.expiresAt, address },
        c.now,
        lightning,
        onchain,
        rests
      );
    } catch (error) {
      if (!(error instanceof SattlemeError)) throw error;
      status = { error: error.code };
    }
    expect(status).toEqual(c.expected);
    if (!(c.expected as { error?: string }).error) expect(published).toEqual(c.published);
    expect(asked).toEqual(c.asked);
    // The acceptance record the check publishes, unless the relays hold one of what it received
    // or less (SPEC.md, "Acceptance records"); none when the status is an error.
    const acceptance =
      "error" in status ? null : await acceptancePublished(status, c.now, c.accepted);
    expect(acceptance).toEqual(c.acceptance ?? null);
    // A merchant's acceptance of a newer format is logged when the check read it, whatever its
    // date and how many relays sent it.
    const newer = Array.isArray(c.merchantAccepted) && c.merchantAccepted.some((r) => "newer" in r);
    expect(warnings.filter((w) => /merchant's acceptance .* newer format/.test(w))).toHaveLength(
      newer && readIt ? 1 : 0
    );
  }
});

describe("relay-reads.json", () => {
  const vectors = readSpec<{
    limit: number;
    pages: number;
    cases: {
      name: string;
      pages: ("fails" | [string, unknown][])[];
      expected: { untils: (number | null)[]; answered: boolean; complete: boolean; kept: number };
    }[];
    lists: { name: string; relays: ("complete" | "incomplete" | "failed")[]; expected: boolean }[];
    paged: {
      name: string;
      pages: ("fails" | [string, unknown][])[];
      expected: { untils: (number | null)[]; answered: boolean; kept: number };
    }[];
    onEveryRelay: {
      name: string;
      relays: RelayState[];
      expected: { answered: boolean; complete: boolean };
    }[];
  }>("vectors/relay-reads.json");

  it("has the page's limit and the pages of a read", () => {
    expect([vectors.limit, vectors.pages]).toEqual([COMPLETE_READ_LIMIT, MAX_PAGES]);
  });

  /**
   * One relay answering the pages of a read as `pages` says, in order, through the loop RelayPool
   * runs for it (readCompletely, readPages): each page asked is recorded by its `until` (null: the
   * first), its events as RelayPool's query reads them (entryOf, the ids of that query so far).
   * Every event kept: the vector counts each id once, whatever opens.
   */
  const relayAnswering = (pages: ("fails" | [string, unknown][])[]) => {
    const untils: (number | null)[] = [];
    const ask: PageQuery = (until) => {
      untils.push(until ?? null);
      // A page the vector does not have: a failure, and an `until` the vector does not expect.
      const answer = pages[untils.length - 1] ?? "fails";
      if (answer === "fails") return Promise.reject(new Error("The page fails"));
      const read = new Set<string>();
      return Promise.resolve(
        answer.map(([id, created_at]) => entryOf({ id, created_at }, (value) => value, read))
      );
    };
    return { untils, ask };
  };

  // What RelayPool reads of one relay in a complete read: its loop, readCompletely; rejected, the
  // relay failed (it did not answer).
  it.each(vectors.cases)("$name", async ({ pages, expected }) => {
    const { untils, ask } = relayAnswering(pages);
    const kept: unknown[] = [];
    const end = await readCompletely(ask, undefined, kept).then(
      ({ complete }) => ({ answered: true, complete }),
      () => ({ answered: false, complete: false })
    );
    expect({ untils, ...end, kept: kept.length }).toEqual(expected);
  });

  // What a complete read of a list gives from what each relay's read was: RelayPool's readOutcome.
  it.each(vectors.lists)("$name", ({ relays, expected }) => {
    expect(readOutcome(relays).complete).toBe(expected);
  });

  // What RelayPool reads of one relay in a paged read: its loop, readPages; rejected, the relay
  // failed (it did not answer).
  it.each(vectors.paged)("paged: $name", async ({ pages, expected }) => {
    const { untils, ask } = relayAnswering(pages);
    const kept: unknown[] = [];
    const answered = await readPages(ask, undefined, kept).then(
      () => true,
      () => false
    );
    expect({ untils, answered, kept: kept.length }).toEqual(expected);
  });

  // What a read on every relay gives from what each relay's read was when it went on: RelayPool's
  // readOutcome (only a relay whose read ended answered, never one still reading). The same cases
  // end to end, the states made by local relays: test/relay-reads.test.ts.
  it.each(vectors.onEveryRelay)("on every relay: $name", ({ relays, expected }) => {
    expect(readOutcome(relays)).toEqual(expected);
  });
});

describe("onchain-tolerances.json", () => {
  const vectors = readSpec<{
    values: { name: string; value?: unknown; expected: number }[];
    accepted: { sats: string; tolerance: number; expected: string }[];
    due: {
      sats: string;
      tolerance: number;
      paidByRests: string;
      merchantAccepted?: string;
      expected: string;
    }[];
  }>("vectors/onchain-tolerances.json");

  it.each(vectors.values)("reads $name", ({ value, expected }) => {
    expect(toleranceOf(value)).toBe(expected);
  });

  it.each(vectors.accepted)("accepts $expected of $sats at $tolerance", (c) => {
    expect(leastAccepted(BigInt(c.sats), c.tolerance).toString()).toBe(c.expected);
  });

  it.each(vectors.due)(
    "is due $expected of $sats at $tolerance, $paidByRests paid by rests, accepted $merchantAccepted",
    (c) => {
      const accepted = c.merchantAccepted === undefined ? null : BigInt(c.merchantAccepted);
      expect(
        dueOnchain(BigInt(c.sats), c.tolerance, BigInt(c.paidByRests), accepted).toString()
      ).toBe(c.expected);
    }
  );
});

describe("earlier-invoices.json", () => {
  type Event = { createdAt: number; id: string };
  type Record =
    | {
        address: string;
        invoice: string | null;
        createdAt: number;
        expiresAt: number;
        confirmed?: boolean;
        event: Event;
        sentBy?: number;
      }
    | { address: string; withdrawn: true; event: Event; sentBy?: number }
    | { address: string; newer: true; event: Event; sentBy?: number };
  type Status = { state: "open" | "unconfirmed" | "paid"; received?: string } | { error: string };
  const vectors = readSpec<{
    relays: number;
    cases: {
      name: string;
      relays?: number;
      now: number;
      declarations: {
        invoice: string;
        paymentHash: string;
        createdAt: number;
        expiresAt: number;
        declaredAt: number;
        rest?: true;
        sentBy?: number;
      }[];
      records: Record[];
      statuses?: Status[];
      readFails?: true;
      expected: {
        invoices: {
          paymentHash: string | null;
          onchainAddress: string | null;
          createdAt: number;
          declaredAt: number;
        }[];
        mayBePaid: number[];
        checked: number[];
        outcome: null | { handOut: number } | { orderPaid: number } | { error: string };
      };
    }[];
  }>("vectors/earlier-invoices.json");
  const sats = 49_000n;
  const price = { minor: 49_000, digits: 0, currency: "SAT" };
  // The records as the sale opens them. `d`: the address itself, one per address.
  const eventOf = ({ createdAt, id }: Event) => ({ created_at: createdAt, id }) as NostrEvent;
  const declarationOf = (
    d: (typeof vectors.cases)[number]["declarations"][number]
  ): OpenedDeclaration => ({
    event: eventOf({ createdAt: d.declaredAt, id: d.paymentHash }),
    invoice: d.invoice,
    decoded: {
      paymentHash: d.paymentHash,
      amountMsat: sats * 1000n,
      timestamp: d.createdAt,
      expirySeconds: d.expiresAt - d.createdAt
    } as Bolt11,
    verifyUrl: "https://example.com/verify",
    price,
    note: "order",
    declaredAt: d.declaredAt,
    rest: d.rest ? { address: "", expiresAt: 0 } : null
  });
  const recordOf = (r: Record): SaleLeaseRecord =>
    "withdrawn" in r
      ? { kind: "withdrawn", event: eventOf(r.event), d: r.address }
      : "newer" in r
        ? { kind: "newer", event: eventOf(r.event), d: r.address }
        : {
            kind: "lease",
            lease: {
              event: eventOf(r.event),
              d: r.address,
              terms: {
                address: r.address,
                sats,
                invoice: r.invoice,
                verifyUrl: r.invoice === null ? null : "https://example.com/verify",
                createdAt: r.createdAt,
                expiresAt: r.expiresAt,
                price,
                note: "order",
                tolerance: 0,
                ...(r.confirmed === undefined ? {} : { confirmed: r.confirmed })
              },
              inside: {}
            }
          };

  it.each(vectors.cases)(
    "$name",
    ({ relays, now, declarations, records, statuses, readFails, expected }) => {
      const list = relays ?? vectors.relays;
      const declared = invoicesOf(
        "order",
        declarations.map(declarationOf),
        newestRecords(records.map(recordOf))
      );
      const invoices = declared.map(({ invoice }) => invoice);
      expect(
        invoices.map(({ paymentHash, onchainAddress, createdAt, declaredAt }) => ({
          paymentHash,
          onchainAddress,
          createdAt,
          declaredAt
        }))
      ).toEqual(expected.invoices);
      const mayBePaid = mayStillBePaid(invoices, now);
      expect(mayBePaid).toEqual(expected.mayBePaid);
      // Every one that may still be paid is checked, even alone.
      expect(expected.checked).toEqual(mayBePaid);
      if (mayBePaid.length === 0) {
        expect(statuses).toBeUndefined();
        expect(expected.outcome).toBeNull();
        return;
      }
      // What the read on every relay sent, as readSaleDeclarations counts it: how many relays sent
      // each event (its sentBy, all the relays when absent); nothing when fewer than a majority
      // answered it.
      const sentBy = new Map<string, number>();
      for (const d of declarations) sentBy.set(d.paymentHash, d.sentBy ?? list);
      for (const r of records) sentBy.set(r.event.id, r.sentBy ?? list);
      const held = heldBy(
        mayBePaid.map((index) => declared[index]!),
        readFails ? null : sentBy,
        list
      );
      const settled = mayBePaid.map(
        (index): PromiseSettledResult<{ state: string; received?: string }> => {
          const status = statuses![index]!;
          return "state" in status
            ? { status: "fulfilled", value: status }
            : { status: "rejected", reason: status };
        }
      );
      const outcome = pendingOutcome(settled, held);
      expect(
        "paid" in outcome
          ? { orderPaid: mayBePaid[outcome.paid] }
          : "failed" in outcome
            ? (settled[outcome.failed] as PromiseRejectedResult).reason
            : "unread" in outcome
              ? { error: "network" }
              : { handOut: mayBePaid[outcome.handOut] }
      ).toEqual(expected.outcome);
    }
  );
});
