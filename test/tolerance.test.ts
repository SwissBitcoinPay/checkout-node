import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkoutKeys, parseCheckoutFragment, parseCheckoutValue } from "../src/checkout.js";
import { registryOf } from "../src/declaration.js";
import { acceptanceRecordAddress, restKeys, saleOf, type Sale } from "../src/derive.js";
import {
  OrderPaidError,
  Sattleme,
  type Invoice,
  type PaymentStatus,
  type SattlemeOptions
} from "../src/index.js";
import type { NostrEvent } from "../src/nostr/event.js";
import { nip44Decrypt } from "../src/nostr/nip44.js";
import { sealRecord } from "../src/nostr/record.js";
import { openAcceptanceRecord } from "../src/onchain/acceptance.js";
import { openSaleLease } from "../src/onchain/lease.js";

import { depositAddress, payment, txid } from "./helpers/chain.js";
import { TestMerchant } from "./helpers/merchant.js";

/*
 * The merchant's tolerance of on-chain underpayments (SPEC.md, "The merchant's tolerance",
 * "Acceptance records"), end to end against local relays and fakes of breez.tips and of the
 * explorers: read in the channel, kept in the order's lease, its payment judged with it whatever
 * the channel says later; a payment short by no more than it is paid (being confirmed first), one
 * short by more asks its whole rest; the pages of the order's checkout links told by an acceptance
 * record, never the tolerance itself.
 */

const ORIGIN = "https://pay.example";
const ADDRESS = depositAddress(1);
/** 5 %: of 49 000 sats, 2 450 may be missing, 46 550 pay the order. */
const TOLERANCE = 500;
const SATS = 49_000;
const LEAST = 46_550;
let merchant: TestMerchant;
let warnings: string[];
let sattleme: Sattleme;

function client(options: Partial<SattlemeOptions> = {}) {
  return new Sattleme({
    key: merchant.key,
    fetch: merchant.http.fetch,
    WebSocket: merchant.net.WebSocket,
    now: () => merchant.now * 1000,
    relayTimeoutMs: 1000,
    logger: { warn: (message) => warnings.push(message) },
    ...options
  });
}

/** Publishes the channel, with `tolerance` (none: no `onchainTolerance`), dated `createdAt`. */
function publishChannel(tolerance: unknown, createdAt: number) {
  merchant.publishChannel(
    merchant.channelValue(createdAt, {
      relays: merchant.keyRelays,
      checkout: { origin: ORIGIN },
      ...(tolerance === undefined ? {} : { onchainTolerance: tolerance })
    }),
    createdAt
  );
}

/** The events the first relay holds. */
function held(relay = merchant.keyRelays[0]!): NostrEvent[] {
  return merchant.net.get(relay).events as NostrEvent[];
}

function saleOfRef(ref: string): Sale {
  return saleOf(
    merchant.integrationKey,
    registryOf(Buffer.from(merchant.registryKey).toString("hex"), merchant.reader),
    ref
  );
}

/** The inside of the sale of `ref`'s lease the relays hold. */
function leaseInside(ref: string): Record<string, unknown> {
  const sale = saleOfRef(ref);
  const leases = held().flatMap((event) => {
    try {
      const opened = openSaleLease(event, sale);
      return opened?.kind === "lease" ? [opened.lease] : [];
    } catch {
      return [];
    }
  });
  expect(leases).toHaveLength(1);
  return leases[0]!.inside;
}

/** The acceptance records of `invoice` the relay holds, as a checkout link's page opens them. */
function acceptances(invoice: Invoice, relay = merchant.keyRelays[0]!) {
  const keys = restKeys(
    merchant.integrationKey,
    invoice.ref,
    invoice.onchainAddress!,
    invoice.expiresAt
  );
  return held(relay).flatMap((event) => {
    const opened = openAcceptanceRecord(event, keys, BigInt(invoice.sats));
    return opened && opened !== "newer" ? [opened] : [];
  });
}

/** The invoices breez.tips made of `sats`. */
function madeOf(sats: number) {
  return [...merchant.invoices.values()].filter((made) => made.amountMsat === BigInt(sats) * 1000n);
}

async function createInvoice(ref = "R-1") {
  const invoice = await sattleme.createInvoice({
    ref,
    sats: SATS,
    durationSeconds: 600,
    note: "Order 1",
    checkout: true
  });
  expect(invoice.onchainAddress).toBe(ADDRESS);
  return invoice;
}

beforeEach(async () => {
  warnings = [];
  merchant = await new TestMerchant().start();
  merchant.publishLot([ADDRESS], 90);
  sattleme = client();
});

afterEach(async () => {
  await merchant.stop();
});

describe("the order's tolerance", () => {
  it("is the channel's, kept in the order's lease, never in what the shop gets", async () => {
    publishChannel(TOLERANCE, 100);
    const invoice = await createInvoice();
    expect(leaseInside("R-1")).toMatchObject({ sats: SATS, tolerance: TOLERANCE });
    // Neither the Invoice nor the checkout link's record (the customer reads it) holds it.
    expect(Object.keys(invoice).sort()).toEqual([
      "bolt11",
      "checkoutUrl",
      "createdAt",
      "expiresAt",
      "fiat",
      "note",
      "onchainAddress",
      "paymentHash",
      "paymentUri",
      "rate",
      "redirectUrl",
      "ref",
      "sats",
      "verifyUrl"
    ]);
    expect(JSON.stringify(invoice)).not.toMatch(/toleran/i);
    const fragment = parseCheckoutFragment(new URL(invoice.checkoutUrl!).hash);
    if (fragment.status !== "link") throw new Error("Not a checkout link");
    const keys = checkoutKeys(fragment.linkKey);
    const link = held().find((event) => event.pubkey === fragment.author)!;
    const plaintext = nip44Decrypt(link.content, keys.encryptionKey);
    expect(plaintext).not.toMatch(/toleran/i);
    const record = JSON.parse(plaintext) as { t: string; v: unknown };
    expect(record.t).toBe("checkout");
    expect(parseCheckoutValue(record.v)).not.toBeNull();
  });

  it.each([
    ["absent", undefined],
    ["0", 0],
    ["a fraction", 2.5],
    ["a string", "500"],
    ["negative", -1],
    ["above 10 %", 1001]
  ])("is none when the channel's is %s: the lease holds none", async (_, value) => {
    publishChannel(value, 100);
    await createInvoice();
    expect(leaseInside("R-1")).not.toHaveProperty("tolerance");
  });

  it("is 10 % at most", async () => {
    publishChannel(1000, 100);
    await createInvoice();
    expect(leaseInside("R-1")).toMatchObject({ tolerance: 1000 });
  });
});

describe("a payment within the tolerance", () => {
  let invoice: Invoice;
  beforeEach(async () => {
    publishChannel(TOLERANCE, 100);
    invoice = await createInvoice();
    merchant.now += 60;
  });

  it("pays the order: being confirmed, then paid at 3 confirmations, without a rest", async () => {
    const tx = payment(txid("least"), ADDRESS, LEAST);
    merchant.chain.add(ADDRESS, tx);
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "unconfirmed",
      received: String(LEAST),
      confirmations: 0,
      txids: [tx.txid]
    });
    expect(madeOf(SATS - LEAST)).toEqual([]);
    merchant.chain.confirm(ADDRESS, tx.txid, merchant.chain.height - 2);
    merchant.now = invoice.expiresAt + 3600;
    const paid = { state: "paid", method: "onchain", received: String(LEAST), txids: [tx.txid] };
    expect(await sattleme.getStatus(invoice)).toEqual(paid);
    // The order is paid: no new invoice for it.
    const error = await sattleme.createInvoice({ ref: "R-1", sats: SATS }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderPaidError);
    expect(error).toMatchObject({ status: paid, preimage: null });
  });

  it("asks the whole rest of a payment short by more", async () => {
    merchant.chain.add(ADDRESS, payment(txid("short"), ADDRESS, LEAST - 1));
    const status = await sattleme.getStatus(invoice);
    const [made] = madeOf(SATS - LEAST + 1);
    expect(made).toBeDefined();
    expect(status).toEqual({
      state: "open",
      expiresAt: invoice.expiresAt,
      received: String(LEAST - 1),
      rest: {
        sats: String(SATS - LEAST + 1),
        bolt11: made!.pr,
        paymentUri: `bitcoin:${ADDRESS}?amount=0.00002451&lightning=${made!.pr}`
      }
    });
    expect(acceptances(invoice)).toEqual([]);
  });

  it("is reached by a second payment after an underpayment", async () => {
    merchant.chain.add(ADDRESS, payment(txid("first"), ADDRESS, 44_100));
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "open",
      received: "44100",
      rest: { sats: "4900" }
    });
    const second = payment(txid("second"), ADDRESS, 2450);
    merchant.chain.add(ADDRESS, second);
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "unconfirmed",
      received: String(LEAST)
    });
  });

  it("with an invoice of the rest paid, needs on-chain only what the tolerance leaves", async () => {
    const tx = payment(txid("part"), ADDRESS, 20_000);
    merchant.chain.add(ADDRESS, tx);
    await sattleme.getStatus(invoice);
    const [rest] = madeOf(29_000);
    merchant.payInvoice(rest!.paymentHash);
    merchant.chain.confirm(ADDRESS, tx.txid, merchant.chain.height - 2);
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "paid",
      method: "mixed",
      received: "49000",
      txids: [tx.txid],
      preimages: [rest!.preimage]
    });
  });

  it("is waited for by waitForPayment until paid", async () => {
    await merchant.startExplorerSocket();
    const tx = payment(txid("least"), ADDRESS, LEAST);
    merchant.chain.add(ADDRESS, tx);
    merchant.chain.confirm(ADDRESS, tx.txid, merchant.chain.height - 2);
    expect(await sattleme.waitForPayment(invoice, { intervalMs: 250 })).toEqual({
      state: "paid",
      method: "onchain",
      received: String(LEAST),
      txids: [tx.txid]
    });
  });
});

describe("the tolerance of the order's creation", () => {
  it("still judges its payment when the channel's is lowered", async () => {
    publishChannel(TOLERANCE, 100);
    const invoice = await createInvoice();
    publishChannel(0, 200);
    merchant.now += 60;
    merchant.chain.add(ADDRESS, payment(txid("least"), ADDRESS, LEAST));
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "unconfirmed" });
  });

  it("never judges a payment of an order created without one", async () => {
    publishChannel(undefined, 100);
    const invoice = await createInvoice();
    publishChannel(TOLERANCE, 200);
    merchant.now += 60;
    merchant.chain.add(ADDRESS, payment(txid("least"), ADDRESS, LEAST));
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "open",
      received: String(LEAST),
      rest: { sats: String(SATS - LEAST) }
    });
    // Past its end, for good: never paid by a tolerance set afterwards.
    merchant.now = invoice.expiresAt + 3600;
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "expired",
      received: String(LEAST)
    });
  });
});

describe("the acceptance record", () => {
  let invoice: Invoice;
  beforeEach(async () => {
    publishChannel(TOLERANCE, 100);
    invoice = await createInvoice();
    merchant.now += 60;
  });

  it("tells the checkout link's page what was received, on every relay, once", async () => {
    merchant.chain.add(ADDRESS, payment(txid("least"), ADDRESS, 47_000));
    await sattleme.getStatus(invoice);
    for (const relay of merchant.keyRelays) {
      expect(acceptances(invoice, relay).map(({ received }) => received)).toEqual([47_000n]);
    }
    // Its address, from the invoice's rest key, and its life, the links'.
    const keys = restKeys(merchant.integrationKey, "R-1", ADDRESS, invoice.expiresAt);
    const { event } = acceptances(invoice)[0]!;
    expect(event.pubkey).toBe(keys.author);
    expect(event.tags).toEqual([
      ["d", acceptanceRecordAddress(keys.key)],
      ["expiration", String(invoice.expiresAt + 604_800)]
    ]);
    // What was received, never the tolerance.
    expect(JSON.parse(nip44Decrypt(event.content, keys.encryptionKey))).toEqual({
      t: "checkout-accepted",
      v: { version: 1, received: 47_000 }
    });
    const sent = merchant.net.get(merchant.keyRelays[0]!).received.length;
    await sattleme.getStatus(invoice);
    // Known on a majority: not published again.
    expect(merchant.net.get(merchant.keyRelays[0]!).received.length).toBe(sent);
  });

  it("is published again, of less, when a replacement lowers what was received", async () => {
    const first = payment(txid("first"), ADDRESS, 48_000);
    merchant.chain.add(ADDRESS, first);
    await sattleme.getStatus(invoice);
    merchant.now += 1;
    merchant.chain.drop(ADDRESS, first.txid);
    // A fee bump of the same coin, paying less.
    const coins = first.vin.map(({ txid: spent, vout }) => `${spent}:${vout}`);
    merchant.chain.add(ADDRESS, payment(txid("bump"), ADDRESS, 47_000, { coins }));
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "unconfirmed",
      received: "47000"
    });
    const received = acceptances(invoice)
      .sort((a, b) => b.event.created_at - a.event.created_at)
      .map(({ received: r }) => r);
    expect(received[0]).toBe(47_000n);
  });

  it("is never published over one of a newer format, which is warned of (SPEC.md §12)", async () => {
    const keys = restKeys(merchant.integrationKey, "R-1", ADDRESS, invoice.expiresAt);
    const newer = sealRecord({
      type: "checkout-accepted",
      value: { version: 2 },
      signer: keys.secretKey,
      encryptionKey: keys.encryptionKey,
      address: acceptanceRecordAddress(keys.key),
      createdAt: merchant.now - 1,
      tags: [["expiration", String(invoice.expiresAt + 604_800)]]
    });
    merchant.net.get(merchant.keyRelays[0]!).take(newer);
    merchant.chain.add(ADDRESS, payment(txid("least"), ADDRESS, 47_000));
    const sent = merchant.keyRelays.map((url) => merchant.net.get(url).received.length);
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "unconfirmed" });
    merchant.keyRelays.forEach((url, i) => {
      const received = merchant.net.get(url).received.slice(sent[i]);
      expect(received.filter((event) => event.pubkey === keys.author)).toEqual([]);
    });
    expect(warnings).toContainEqual(
      expect.stringMatching(/an acceptance record of this order has a newer format/)
    );
  });

  it("is never published for a payment of the whole amount", async () => {
    merchant.chain.add(ADDRESS, payment(txid("whole"), ADDRESS, SATS));
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "unconfirmed" });
    expect(acceptances(invoice)).toEqual([]);
  });

  it("publishes nothing when fewer than a majority answer its read, and publishes at the next check", async () => {
    const keys = restKeys(merchant.integrationKey, "R-1", ADDRESS, invoice.expiresAt);
    const address = acceptanceRecordAddress(keys.key);
    let muting = true;
    for (const relay of merchant.keyRelays.slice(1)) {
      merchant.net.get(relay).behaviour = {
        // The read of the acceptance records alone never answered there.
        muteQuery: (filter) => muting && (filter["#d"] ?? []).includes(address)
      };
    }
    merchant.chain.add(ADDRESS, payment(txid("least"), ADDRESS, LEAST));
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "unconfirmed",
      received: String(LEAST)
    });
    // What those relays hold, of a newer format perhaps, cannot be told: nothing written over it.
    for (const relay of merchant.keyRelays) expect(acceptances(invoice, relay)).toEqual([]);
    expect(warnings).toEqual([
      expect.stringContaining("the acceptance record of a payment was not published")
    ]);
    muting = false;
    await sattleme.getStatus(invoice);
    expect(acceptances(invoice).map(({ received }) => received)).toEqual([BigInt(LEAST)]);
  });

  it("logs a failed publication, never the check's error, and publishes at the next check", async () => {
    const address = (keys = restKeys(merchant.integrationKey, "R-1", ADDRESS, invoice.expiresAt)) =>
      acceptanceRecordAddress(keys.key);
    let refusing = true;
    for (const relay of merchant.keyRelays) {
      merchant.net.get(relay).behaviour = {
        refuseEvent: (event) =>
          refusing && event.tags.some(([name, value]) => name === "d" && value === address())
            ? "blocked: no"
            : undefined
      };
    }
    merchant.chain.add(ADDRESS, payment(txid("least"), ADDRESS, LEAST));
    const status: PaymentStatus = await sattleme.getStatus(invoice);
    expect(status).toMatchObject({ state: "unconfirmed", received: String(LEAST) });
    expect(warnings).toEqual([
      expect.stringContaining("the acceptance record of a payment was not published")
    ]);
    expect(warnings[0]).not.toMatch(/toleran|500/);
    expect(acceptances(invoice)).toEqual([]);
    refusing = false;
    await sattleme.getStatus(invoice);
    expect(acceptances(invoice).map(({ received }) => received)).toEqual([BigInt(LEAST)]);
  });
});
