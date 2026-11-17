import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registryOf } from "../src/declaration.js";
import { channelKeys, merchantAcceptanceAddress, restKeys, saleOf } from "../src/derive.js";
import {
  NetworkError,
  OrderPaidError,
  Sattleme,
  type Invoice,
  type PaymentStatus,
  type SattlemeOptions
} from "../src/index.js";
import type { NostrEvent } from "../src/nostr/event.js";
import { sealRecord } from "../src/nostr/record.js";
import { openAcceptanceRecord } from "../src/onchain/acceptance.js";
import {
  merchantAcceptanceKeys,
  merchantAcceptanceOf
} from "../src/onchain/merchant-acceptance.js";

import { depositAddress, payment, txid } from "./helpers/chain.js";
import { TestMerchant, bytes } from "./helpers/merchant.js";

/*
 * The merchant's acceptance (SPEC.md, "The merchant's acceptance"), end to end against local
 * relays and fakes of breez.tips and of the explorers: the team's record, read on every relay with
 * the witnesses, pays an order underpaid on-chain down to what the merchant accepted, only when a
 * majority of the merchant's relays hold it, whichever majority answers; the pages of the order's
 * checkout links told by an acceptance record (the server's); the check publishing nothing of it.
 */

const ORIGIN = "https://pay.example";
const ADDRESS = depositAddress(1);
const SATS = 49_000;
/** What came on-chain, and what the merchant accepted. */
const CAME = 30_000;
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
function publishChannel(tolerance: number | undefined, createdAt: number) {
  merchant.publishChannel(
    merchant.channelValue(createdAt, {
      relays: merchant.keyRelays,
      checkout: { origin: ORIGIN },
      ...(tolerance === undefined ? {} : { onchainTolerance: tolerance })
    }),
    createdAt
  );
}

function saleAuthor(ref: string): string {
  return saleOf(
    merchant.integrationKey,
    registryOf(bytesToHex(merchant.registryKey), merchant.reader),
    ref
  ).author;
}

/** Where the merchant's acceptance of `invoice` is (or of what `of` changes of it). */
function addressOf(
  invoice: Invoice,
  of: { ref?: string; address?: string; expiresAt?: number } = {}
): string {
  return merchantAcceptanceAddress(
    merchant.integrationKey,
    saleAuthor(of.ref ?? invoice.ref),
    of.address ?? invoice.onchainAddress!,
    of.expiresAt ?? invoice.expiresAt
  );
}

/**
 * The merchant's acceptance of `invoice` at `received`, as the merchant's app makes it: sealed with
 * the channel's key, signed by the team (or `signer`), dated `createdAt` (a minute ago by
 * default), of `value` when given.
 */
function acceptance(
  invoice: Invoice,
  received: number,
  options: {
    createdAt?: number;
    signer?: Uint8Array;
    value?: unknown;
    of?: { ref?: string; address?: string; expiresAt?: number };
  } = {}
): NostrEvent {
  return sealRecord({
    type: "integration-onchain-accepted",
    value: options.value ?? { version: 1, received },
    signer: options.signer ?? merchant.teamSecret,
    encryptionKey: channelKeys(merchant.integrationKey).encryptionKey,
    address: addressOf(invoice, options.of),
    createdAt: options.createdAt ?? merchant.now - 60
  });
}

/** The relays at `indexes` of the key's (all by default) take `event`, as a relay keeps it. */
function hold(event: NostrEvent, indexes = [0, 1, 2]) {
  for (const index of indexes) merchant.net.get(merchant.keyRelays[index]!).take(event);
}

/** The relays at `indexes` never answer the read of the merchant's acceptance of `invoice`. */
function muteRead(invoice: Invoice, indexes: number[]) {
  const address = addressOf(invoice);
  merchant.keyRelays.forEach((url, index) => {
    merchant.net.get(url).behaviour = indexes.includes(index)
      ? { muteQuery: (filter) => (filter["#d"] ?? []).includes(address) }
      : {};
  });
}

/** The acceptance records of `invoice` the relay holds, as a checkout link's page opens them. */
function acceptanceRecords(invoice: Invoice, relay = merchant.keyRelays[0]!) {
  const keys = restKeys(
    merchant.integrationKey,
    invoice.ref,
    invoice.onchainAddress!,
    invoice.expiresAt
  );
  return (merchant.net.get(relay).events as NostrEvent[]).flatMap((event) => {
    const opened = openAcceptanceRecord(event, keys, BigInt(invoice.sats));
    return opened && opened !== "newer" ? [opened.received] : [];
  });
}

/** What the check sent the relays of the team's, or at the merchant's acceptance's address. */
function sentOfTheTeam(invoice: Invoice): NostrEvent[] {
  const address = addressOf(invoice);
  return merchant.keyRelays.flatMap((url) =>
    merchant.net
      .get(url)
      .received.filter(
        (event) =>
          event.pubkey === merchant.team || event.tags.some(([, value]) => value === address)
      )
  );
}

/** The invoices breez.tips made of `sats`. */
function madeOf(sats: number) {
  return [...merchant.invoices.values()].filter((made) => made.amountMsat === BigInt(sats) * 1000n);
}

/** The status of an order of 49 000 sats with 30 000 in time and the rest asked of 19 000. */
function underpaid(invoice: Invoice): PaymentStatus {
  const [rest] = madeOf(SATS - CAME);
  return {
    state: "open",
    expiresAt: invoice.expiresAt,
    received: String(CAME),
    rest: {
      sats: String(SATS - CAME),
      bolt11: rest!.pr,
      paymentUri: `bitcoin:${ADDRESS}?amount=0.00019&lightning=${rest!.pr}`
    }
  };
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

let invoice: Invoice;
let tx: ReturnType<typeof payment>;
beforeEach(async () => {
  warnings = [];
  merchant = await new TestMerchant().start();
  merchant.publishLot([ADDRESS], 90);
  publishChannel(undefined, 100);
  sattleme = client();
  invoice = await createInvoice();
  merchant.now += 60;
  tx = payment(txid("came"), ADDRESS, CAME);
  merchant.chain.add(ADDRESS, tx);
});

afterEach(async () => {
  await merchant.stop();
});

const unconfirmed = () => ({
  state: "unconfirmed",
  received: String(CAME),
  confirmations: 0,
  txids: [tx.txid]
});

describe("a merchant's acceptance a majority of the relays hold", () => {
  it("pays the order down to it: unconfirmed, then paid, the pages told, nothing published of it", async () => {
    hold(acceptance(invoice, CAME), [0, 1]);
    expect(await sattleme.getStatus(invoice)).toEqual(unconfirmed());
    // No rest asked: the order is paid.
    expect(madeOf(SATS - CAME)).toEqual([]);
    // The acceptance record (the server's, for the pages of the order's checkout links), on every
    // relay: what was received, nothing of the merchant's acceptance itself.
    for (const relay of merchant.keyRelays) {
      expect(acceptanceRecords(invoice, relay)).toEqual([BigInt(CAME)]);
    }
    // The merchant's acceptance never published again, nor anything of the team's.
    expect(sentOfTheTeam(invoice)).toEqual([]);
    expect(merchant.net.get(merchant.keyRelays[2]!).events).not.toContainEqual(
      expect.objectContaining({ pubkey: merchant.team, tags: [["d", addressOf(invoice)]] })
    );

    merchant.chain.confirm(ADDRESS, tx.txid, merchant.chain.height - 2);
    merchant.now = invoice.expiresAt + 3600;
    const paid = { state: "paid", method: "onchain", received: String(CAME), txids: [tx.txid] };
    expect(await sattleme.getStatus(invoice)).toEqual(paid);
    const error = await sattleme.createInvoice({ ref: "R-1", sats: SATS }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderPaidError);
    expect(error).toMatchObject({ status: paid });
    expect(warnings).toEqual([]);
  });

  it.each([
    ["the third failing", [0, 1], [2]],
    ["the first failing, the 2 others holding it", [1, 2], [0]],
    ["every relay answering", [0, 1], []]
  ])("counts whichever majority answers: %s", async (_, holders, failing) => {
    hold(acceptance(invoice, CAME), holders);
    muteRead(invoice, failing);
    expect(await sattleme.getStatus(invoice)).toEqual(unconfirmed());
  });

  it("waits for a relay that holds it and answers late", async () => {
    hold(acceptance(invoice, CAME), [0, 1]);
    merchant.net.get(merchant.keyRelays[0]!).behaviour = { queryDelayMs: 400 };
    expect(await sattleme.getStatus(invoice)).toEqual(unconfirmed());
  });

  it("counts one made before the end after the lease's end: never expired", async () => {
    expect(await sattleme.getStatus(invoice)).toEqual(underpaid(invoice));
    hold(acceptance(invoice, CAME, { createdAt: invoice.expiresAt - 60 }), [1, 2]);
    merchant.now = invoice.expiresAt + 3600;
    expect(await sattleme.getStatus(invoice)).toEqual(unconfirmed());
  });

  it("counts one of less than what came: what came pays", async () => {
    hold(acceptance(invoice, 20_000));
    expect(await sattleme.getStatus(invoice)).toEqual(unconfirmed());
    expect(acceptanceRecords(invoice)).toEqual([BigInt(CAME)]);
  });

  it("asks the whole rest of one of more than what came", async () => {
    hold(acceptance(invoice, 35_000));
    expect(await sattleme.getStatus(invoice)).toEqual(underpaid(invoice));
    expect(acceptanceRecords(invoice)).toEqual([]);
  });
});

describe("a merchant's acceptance only a minority of the relays holds", () => {
  it("never counts, whichever relays answer: the rest asked, then expired", async () => {
    hold(acceptance(invoice, CAME), [0]);
    expect(await sattleme.getStatus(invoice)).toEqual(underpaid(invoice));
    // The relay that holds it and one that does not answer: still a minority's.
    muteRead(invoice, [2]);
    expect(await sattleme.getStatus(invoice)).toEqual(underpaid(invoice));
    muteRead(invoice, []);
    merchant.now = invoice.expiresAt + 60;
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "open", rest: null });
    merchant.now = invoice.expiresAt + 3600;
    expect(await sattleme.getStatus(invoice)).toEqual({ state: "expired", received: String(CAME) });
    expect(acceptanceRecords(invoice)).toEqual([]);
  });

  it("is what remains when a relay that holds it fails and the others that do are a minority", async () => {
    // SPEC.md §27: that check does not count it; a later one, which that relay answers, does.
    hold(acceptance(invoice, CAME), [0, 1]);
    muteRead(invoice, [0]);
    expect(await sattleme.getStatus(invoice)).toEqual(underpaid(invoice));
    muteRead(invoice, []);
    expect(await sattleme.getStatus(invoice)).toEqual(unconfirmed());
  });

  it("counts a relay once, whatever copies of it it sends", async () => {
    const event = acceptance(invoice, CAME);
    // The same event under another signature (BIP-340: any of them verifies): the same record.
    const resigned = {
      ...event,
      sig: bytesToHex(schnorr.sign(hexToBytes(event.id), merchant.teamSecret, bytes(77)))
    };
    expect(resigned.sig).not.toBe(event.sig);
    const relay = merchant.net.get(merchant.keyRelays[0]!);
    relay.store(event);
    relay.store(event);
    relay.store(resigned);
    expect(await sattleme.getStatus(invoice)).toEqual(underpaid(invoice));
    // The count itself, of what the relays sent (the pool already reads a relay's copies of one
    // id once): one relay, whatever copies it sent; then a second one, a majority.
    const keys = merchantAcceptanceKeys(
      merchant.integrationKey,
      merchant.team,
      saleAuthor(invoice.ref),
      ADDRESS,
      invoice.expiresAt
    );
    const terms = { sats: BigInt(SATS), expiresAt: invoice.expiresAt };
    const answers = new Map<string, unknown[]>([
      ["a", [event, event, resigned, { ...event, sig: resigned.sig }]],
      ["b", []],
      ["c", []]
    ]);
    expect(merchantAcceptanceOf(answers, keys, terms, 3)).toEqual({ received: null, newer: false });
    answers.set("b", [resigned]);
    expect(merchantAcceptanceOf(answers, keys, terms, 3)).toEqual({
      received: BigInt(CAME),
      newer: false
    });
  });
});

describe("a record that is not this invoice's merchant's acceptance", () => {
  it.each([
    [
      "of another invoice of the order (another expiresAt)",
      (of: Invoice) => ({ of: { expiresAt: of.expiresAt + 3600 } })
    ],
    ["of another order", () => ({ of: { ref: "R-2" } })],
    ["of another address", () => ({ of: { address: depositAddress(2) } })],
    ["of another team", () => ({ signer: bytes(9) })],
    ["of the whole amount", () => ({ value: { version: 1, received: SATS } })],
    ["of 0 sats", () => ({ value: { version: 1, received: 0 } })],
    ["without a version", () => ({ value: { received: CAME } })]
  ])("is not counted: %s", async (_, options) => {
    hold(acceptance(invoice, CAME, options(invoice)));
    expect(await sattleme.getStatus(invoice)).toEqual(underpaid(invoice));
    expect(warnings).toEqual([]);
  });

  it("is not counted with a damaged signature", async () => {
    const event = acceptance(invoice, CAME);
    const sig = event.sig.slice(0, -1) + (event.sig.endsWith("0") ? "1" : "0");
    for (const url of merchant.keyRelays) merchant.net.get(url).store({ ...event, sig });
    expect(await sattleme.getStatus(invoice)).toEqual(underpaid(invoice));
  });

  // Dated after now: its `created_at` is never compared with now, only with the lease's end.
  it.each([
    ["at the lease's end: counted", 120, true],
    ["a second after the lease's end: not counted", 121, false]
  ])("dated %s", async (_, after, counted) => {
    hold(acceptance(invoice, CAME, { createdAt: invoice.expiresAt + after }));
    expect(await sattleme.getStatus(invoice)).toEqual(counted ? unconfirmed() : underpaid(invoice));
  });
});

describe("a merchant's acceptance of a newer format", () => {
  /** A record of version 2, dated `createdAt`, on every relay with `others` (relays send both). */
  function newerWith(createdAt: number, others: NostrEvent[]) {
    const newer = acceptance(invoice, CAME, { createdAt, value: { version: 2 } });
    for (const url of merchant.keyRelays) {
      for (const event of [...others, newer]) merchant.net.get(url).store(event);
    }
  }
  const warned = () =>
    warnings.filter((w) => /a merchant's acceptance of this order has a newer format/.test(w));

  it("newer than a valid one leaves the order without one, and is warned of", async () => {
    newerWith(merchant.now - 30, [acceptance(invoice, CAME, { createdAt: merchant.now - 60 })]);
    expect(await sattleme.getStatus(invoice)).toEqual(underpaid(invoice));
    expect(warned()).toHaveLength(1);
  });

  it("older than a valid one leaves it counted, and is warned of", async () => {
    newerWith(merchant.now - 90, [acceptance(invoice, CAME, { createdAt: merchant.now - 60 })]);
    expect(await sattleme.getStatus(invoice)).toEqual(unconfirmed());
    expect(warned()).toHaveLength(1);
  });

  it("dated after the lease's end is set aside, and warned of", async () => {
    newerWith(invoice.expiresAt + 121, [acceptance(invoice, CAME)]);
    expect(await sattleme.getStatus(invoice)).toEqual(unconfirmed());
    expect(warned()).toHaveLength(1);
  });
});

describe("a merchant's acceptance with rest invoices, the tolerance, the Lightning part", () => {
  it("takes what rest invoices paid from it once: unconfirmed, then paid, mixed", async () => {
    // 40 000 on-chain: a rest invoice of 9 000, paid; then the transaction replaced (RBF) by one
    // paying 21 000: 30 000 in all, 19 000 asked.
    merchant.chain.drop(ADDRESS, tx.txid);
    const first = payment(txid("first"), ADDRESS, 40_000);
    merchant.chain.add(ADDRESS, first);
    await sattleme.getStatus(invoice);
    const [rest] = madeOf(9000);
    merchant.payInvoice(rest!.paymentHash);
    merchant.now += 1;
    merchant.chain.drop(ADDRESS, first.txid);
    const coins = first.vin.map(({ txid: spent, vout }) => `${spent}:${vout}`);
    const bump = payment(txid("bump"), ADDRESS, 21_000, { coins });
    merchant.chain.add(ADDRESS, bump);
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "open",
      received: "30000",
      rest: { sats: "19000" }
    });
    // The merchant accepts what came: 21 000 due on-chain (30 000 less the 9 000 of the rest).
    hold(acceptance(invoice, CAME));
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "unconfirmed",
      received: "30000",
      confirmations: 0,
      txids: [bump.txid]
    });
    expect(acceptanceRecords(invoice)).toEqual([30_000n]);
    merchant.chain.confirm(ADDRESS, bump.txid, merchant.chain.height - 2);
    merchant.now = invoice.expiresAt + 3600;
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "paid",
      method: "mixed",
      received: "30000",
      txids: [bump.txid],
      preimages: [rest!.preimage]
    });
  });

  it.each([
    ["the merchant's acceptance's, lower", CAME, CAME],
    ["the tolerance's, lower", 48_000, 46_550]
  ])("with the tolerance, judges with the lower: %s", async (_, accepted, came) => {
    await merchant.stop();
    merchant = await new TestMerchant().start();
    merchant.publishLot([ADDRESS], 90);
    publishChannel(500, 100);
    sattleme = client();
    invoice = await createInvoice();
    merchant.now += 60;
    tx = payment(txid("came"), ADDRESS, came);
    merchant.chain.add(ADDRESS, tx);
    hold(acceptance(invoice, accepted));
    expect(await sattleme.getStatus(invoice)).toEqual({ ...unconfirmed(), received: String(came) });
    expect(acceptanceRecords(invoice)).toEqual([BigInt(came)]);
  });

  it("changes nothing once the Lightning invoice is paid", async () => {
    hold(acceptance(invoice, CAME));
    merchant.payInvoice(invoice.paymentHash!);
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "paid", method: "lightning" });
  });

  it("is network when fewer than a majority answer its read", async () => {
    // A first check published the witness and asked the rest: the next one publishes nothing
    // before it reads (the relays that fail its read fail every later read on every relay too).
    expect(await sattleme.getStatus(invoice)).toEqual(underpaid(invoice));
    hold(acceptance(invoice, CAME));
    muteRead(invoice, [1, 2]);
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(NetworkError);
    // Its Lightning invoice paid: paid all the same.
    merchant.payInvoice(invoice.paymentHash!);
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "paid", method: "lightning" });
  });

  it("is seen by waitForPayment at its next check of the on-chain part, the rest given till then", async () => {
    const socket = await merchant.startExplorerSocket();
    const statuses: PaymentStatus[] = [];
    const until = async (condition: () => boolean) => {
      for (let i = 0; i < 300 && !condition(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(condition()).toBe(true);
    };
    /** The full checks so far: each asks the explorer for the address's transactions once. */
    const asked = merchant.chain.asked.length;
    const fullChecks = () =>
      merchant.chain.asked.slice(asked).filter((url) => url.endsWith("/txs")).length;
    const waiting = sattleme.waitForPayment(invoice, {
      intervalMs: 250,
      onStatus: (status) => statuses.push(status)
    });
    // The first full check, and the one the socket's connection starts, ended.
    await until(() => socket.messages.length === 2 && fullChecks() === 2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(statuses.at(-1)).toEqual(underpaid(invoice));
    // The merchant accepts: no message of the explorer, no check of the on-chain part; the checks
    // of the Lightning invoices give the status with its rest still.
    hold(acceptance(invoice, CAME));
    const seen = statuses.length;
    await until(() => statuses.length > seen + 1);
    expect(fullChecks()).toBe(2);
    expect(statuses.slice(seen)).toEqual(statuses.slice(seen).map(() => underpaid(invoice)));
    // The next check of the on-chain part (a block here; every 60 s at least) counts it.
    socket.push({ block: { height: merchant.chain.height } });
    await until(() => statuses.at(-1)?.state === "unconfirmed");
    expect(statuses.at(-1)).toEqual(unconfirmed());
    merchant.chain.confirm(ADDRESS, tx.txid, merchant.chain.height - 2);
    socket.push({ block: { height: merchant.chain.height } });
    expect(await waiting).toEqual({
      state: "paid",
      method: "onchain",
      received: String(CAME),
      txids: [tx.txid]
    });
    expect(acceptanceRecords(invoice)).toEqual([BigInt(CAME)]);
  });
});
