import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkoutKeys, parseCheckoutFragment, parseCheckoutValue } from "../src/checkout.js";
import { openDeclaration, registryOf } from "../src/declaration.js";
import { restKeys, restRecordAddress, saleOf, type Sale } from "../src/derive.js";
import {
  InvoicePendingError,
  NetworkError,
  OrderPaidError,
  Sattleme,
  type Invoice,
  type PaymentStatus,
  type SattlemeOptions
} from "../src/index.js";
import type { NostrEvent } from "../src/nostr/event.js";
import { nip44Decrypt } from "../src/nostr/nip44.js";
import { sealRecord } from "../src/nostr/record.js";
import { openRestRecord } from "../src/onchain/rest.js";

import { depositAddress, payment, txid } from "./helpers/chain.js";
import { answer } from "./helpers/fetch.js";
import { CALLBACK, TestMerchant } from "./helpers/merchant.js";

/*
 * The rest of an on-chain underpayment (SPEC.md, "The rest of an underpayment"), end to end
 * against local relays and fakes of breez.tips and of the explorers: the invoice of the rest asked
 * by a payment check, declared with `rest` and published in a rest record that a checkout link's
 * page reads; asked once, never without time left nor outside the Lightning address's bounds; a
 * failure only logged; what the rest invoices paid counted with the on-chain payment (`mixed`).
 */

const ORIGIN = "https://pay.example";
const ADDRESS = depositAddress(1);
let merchant: TestMerchant;
let warnings: string[];

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

/** The events every relay holds now (the first relay's). */
function held(): NostrEvent[] {
  return merchant.net.get(merchant.keyRelays[0]!).events as NostrEvent[];
}

function saleOfRef(ref: string): Sale {
  return saleOf(
    merchant.integrationKey,
    registryOf(Buffer.from(merchant.registryKey).toString("hex"), merchant.reader),
    ref
  );
}

/** The declarations of the sale of `ref` the relays hold, opened as the sale. */
function declarations(ref: string) {
  const sale = saleOfRef(ref);
  return held().flatMap((event) => {
    const opened = openDeclaration(event, sale);
    return opened ? [opened] : [];
  });
}

/** The rest records of `invoice` the relays hold, as a checkout link's page opens them. */
function restRecords(invoice: Invoice) {
  const keys = restKeys(
    merchant.integrationKey,
    invoice.ref,
    invoice.onchainAddress!,
    invoice.expiresAt
  );
  return held().flatMap((event) => {
    const opened = openRestRecord(event, keys, {
      sats: BigInt(invoice.sats),
      createdAt: invoice.createdAt,
      expiresAt: invoice.expiresAt
    });
    return opened && opened !== "newer" ? [opened.invoice] : [];
  });
}

/** The invoices breez.tips made of `sats`. */
function madeOf(sats: number) {
  return [...merchant.invoices.values()].filter((made) => made.amountMsat === BigInt(sats) * 1000n);
}

let sattleme: Sattleme;
let invoice: Invoice;

beforeEach(async () => {
  warnings = [];
  merchant = await new TestMerchant().start();
  merchant.publishChannel(
    merchant.channelValue(100, { relays: merchant.keyRelays, checkout: { origin: ORIGIN } }),
    100
  );
  merchant.publishLot([ADDRESS], 90);
  sattleme = client();
  invoice = await sattleme.createInvoice({
    ref: "R-1",
    sats: 49_000,
    durationSeconds: 600,
    note: "Order 1",
    checkout: true
  });
  expect(invoice.onchainAddress).toBe(ADDRESS);
});

afterEach(async () => {
  await merchant.stop();
});

describe("an on-chain underpayment", () => {
  it("asks an invoice of the rest, declares it with `rest` and publishes its record", async () => {
    merchant.now += 60;
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 20_000));
    const status = await sattleme.getStatus(invoice);
    const [made] = madeOf(29_000);
    expect(made).toBeDefined();
    expect(status).toEqual({
      state: "open",
      expiresAt: invoice.expiresAt,
      received: "20000",
      rest: {
        sats: "29000",
        bolt11: made!.pr,
        paymentUri: `bitcoin:${ADDRESS}?amount=0.00029&lightning=${made!.pr}`
      }
    });
    // Until the invoice's end, with the order's note.
    expect(made!.expiry).toBe(invoice.expiresAt - merchant.now);
    expect(made!.comment).toBe("Order 1");
    // Declared for the order's sale, with the order's price and note, marked as a rest.
    expect(declarations("R-1")).toContainEqual(
      expect.objectContaining({
        invoice: made!.pr,
        note: "Order 1",
        rest: { address: ADDRESS, expiresAt: invoice.expiresAt }
      })
    );
    // Its record, which the checkout link's page reads with the keys its link's record carries.
    expect(restRecords(invoice)).toEqual([
      expect.objectContaining({ bolt11: made!.pr, sats: 29_000n, verifyUrl: made!.verify })
    ]);
    const link = parseCheckoutFragment(
      invoice.checkoutUrl!.slice(invoice.checkoutUrl!.indexOf("#"))
    );
    if (link.status !== "link") throw new Error("Not a link");
    const keys = checkoutKeys(link.linkKey);
    const event = held().find((e) => e.tags.some(([n, d]) => n === "d" && d === keys.address))!;
    const { v } = JSON.parse(nip44Decrypt(event.content, keys.encryptionKey)) as { v: unknown };
    const rest = restKeys(merchant.integrationKey, "R-1", ADDRESS, invoice.expiresAt);
    expect(parseCheckoutValue(v)?.rest).toEqual({ author: rest.author, key: rest.key });
    // The rest invoice is no invoice of the order.
    expect(await sattleme.findInvoices("R-1")).toEqual([
      expect.objectContaining({ bolt11: invoice.bolt11, onchainAddress: ADDRESS })
    ]);
    expect(warnings).toEqual([]);
  });

  it("is asked by createInvoice's check of the order's pending invoice, before invoice_pending", async () => {
    merchant.now += 60;
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 20_000));
    // Its payment checked, alone (SPEC.md §21 step 1): as any payment check, it asks for the rest.
    const pending = await sattleme
      .createInvoice({ ref: "R-1", sats: 49_000, checkout: true })
      .catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(InvoicePendingError);
    expect((pending as InvoicePendingError).invoice.onchainAddress).toBe(ADDRESS);
    const [made] = madeOf(29_000);
    expect(made).toBeDefined();
    expect(declarations("R-1")).toContainEqual(
      expect.objectContaining({
        invoice: made!.pr,
        rest: { address: ADDRESS, expiresAt: invoice.expiresAt }
      })
    );
    // Its record, for the pages of the order's checkout links (the new one included).
    expect(restRecords(invoice)).toEqual([expect.objectContaining({ bolt11: made!.pr })]);
    // Shown by the next check, never asked again.
    expect(await sattleme.getStatus(invoice)).toMatchObject({ rest: { bolt11: made!.pr } });
    expect(madeOf(29_000)).toEqual([made]);
    expect(warnings).toEqual([]);
  });

  it("asks it once, and again for a new rest", async () => {
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 20_000));
    const first = await sattleme.getStatus(invoice);
    expect(await client().getStatus(invoice)).toEqual(first);
    expect(madeOf(29_000)).toHaveLength(1);
    // More sent on-chain: a new rest, a new invoice of it.
    merchant.chain.add(ADDRESS, payment(txid("more"), ADDRESS, 10_000));
    const second = await sattleme.getStatus(invoice);
    expect(second).toMatchObject({ received: "30000", rest: { sats: "19000" } });
    expect(madeOf(19_000)).toHaveLength(1);
    expect(
      restRecords(invoice)
        .map(({ sats }) => sats)
        .sort()
    ).toEqual([19_000n, 29_000n]);
  });

  it("is Lightning only below 1 000 sats", async () => {
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 48_500));
    const [status] = [await sattleme.getStatus(invoice)];
    const [made] = madeOf(500);
    expect(status).toMatchObject({
      state: "open",
      received: "48500",
      rest: { sats: "500", bolt11: made!.pr, paymentUri: `lightning:${made!.pr}` }
    });
  });

  it("asks none with less than a minute left, nor outside the Lightning address's bounds", async () => {
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 20_000));
    merchant.now = invoice.expiresAt - 59;
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      rest: {
        sats: "29000",
        bolt11: null,
        paymentUri: `bitcoin:${ADDRESS}?amount=0.00029`
      }
    });
    merchant.now = invoice.expiresAt - 600;
    const pay = merchant.pay;
    merchant.pay = { ...pay, maxSendable: 28_000_000 };
    expect(await sattleme.getStatus(invoice)).toMatchObject({ rest: { bolt11: null } });
    merchant.pay = { ...pay, minSendable: 29_001_000 };
    expect(await sattleme.getStatus(invoice)).toMatchObject({ rest: { bolt11: null } });
    expect(madeOf(29_000)).toEqual([]);
    expect(warnings).toEqual([]);
    // Past the end, no rest at all.
    merchant.now = invoice.expiresAt;
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "open", rest: null });
  });

  it("logs a Lightning address that fails, and asks again at the next check", async () => {
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 20_000));
    merchant.override = (url) =>
      url.origin + url.pathname === CALLBACK ? answer({ oops: true }, 500) : undefined;
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "open",
      rest: { bolt11: null }
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no Lightning invoice of the rest/);
    merchant.override = null;
    const again = (await sattleme.getStatus(invoice)) as Extract<PaymentStatus, { state: "open" }>;
    expect(again.rest?.bolt11).toBe(madeOf(29_000).at(-1)!.pr);
  });

  it("refuses an invoice that does not pay the merchant, logged", async () => {
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 20_000));
    merchant.tamper = (made) => ({ pr: made.pr.replace(/.{8}$/, "qqqqqqqq") });
    expect(await sattleme.getStatus(invoice)).toMatchObject({ rest: { bolt11: null } });
    expect(warnings).toHaveLength(1);
    expect(declarations("R-1").filter(({ rest }) => rest !== null)).toEqual([]);
  });

  it("checks an invoice of the rest another check asked meanwhile", async () => {
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 20_000));
    // Paid as soon as it is made: the check that waited for the other finds it paid.
    merchant.tamper = (made) => {
      merchant.payInvoice(made.paymentHash);
      return {};
    };
    const [first, second] = await Promise.all([
      sattleme.getStatus(invoice),
      sattleme.getStatus(invoice)
    ]);
    expect(madeOf(29_000)).toHaveLength(1);
    expect(first).toMatchObject({ state: "open", rest: { bolt11: madeOf(29_000)[0]!.pr } });
    expect(second).toMatchObject({ state: "unconfirmed", received: "49000" });
  });

  it("declares again on a majority an invoice of the rest a minority holds, before it is used", async () => {
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 20_000));
    const sale = saleOfRef("R-1");
    const [a, b, c] = merchant.keyRelays.map((url) => merchant.net.get(url));
    const refuse = (event: NostrEvent) => (event.pubkey === sale.author ? "blocked" : undefined);
    // Its declaration reaches one relay of three: not to be shown.
    b!.behaviour.refuseEvent = refuse;
    c!.behaviour.refuseEvent = refuse;
    expect(await sattleme.getStatus(invoice)).toMatchObject({ rest: { bolt11: null } });
    expect(warnings).toHaveLength(1);
    const [made] = madeOf(29_000);
    // Still refused: read on the relay that holds it, it cannot be declared on a majority, so
    // nothing is told of the rest (and no other invoice of it is asked).
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(NetworkError);
    expect(madeOf(29_000)).toEqual([made]);
    // Taken again, the third relay slow: read on the first two, declared on a majority, shown.
    b!.behaviour.refuseEvent = undefined;
    c!.behaviour.refuseEvent = undefined;
    c!.behaviour.queryDelayMs = 500;
    expect(await sattleme.getStatus(invoice)).toMatchObject({ rest: { bolt11: made!.pr } });
    const declared = (relay: typeof a) =>
      (relay!.events as NostrEvent[]).some(
        (event) =>
          event.pubkey === sale.author &&
          openDeclaration(event, sale)?.decoded.paymentHash === made!.paymentHash
      );
    expect([a, b, c].filter(declared).length).toBeGreaterThanOrEqual(2);
    // Paid, then read without the first relay: still counted, never asked again.
    merchant.payInvoice(made!.paymentHash);
    c!.behaviour.queryDelayMs = 0;
    a!.behaviour.queryDelayMs = 500;
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "unconfirmed",
      received: "49000"
    });
    expect(madeOf(29_000)).toEqual([made]);
  });

  it("shows an invoice of the rest only once its record is on a majority of the relays", async () => {
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 20_000));
    const author = restKeys(merchant.integrationKey, "R-1", ADDRESS, invoice.expiresAt).author;
    const relays = merchant.keyRelays.map((url) => merchant.net.get(url));
    const recordedOn = () =>
      relays.filter((relay) => (relay.events as NostrEvent[]).some((e) => e.pubkey === author))
        .length;
    // Its record taken by one relay of three: a checkout link's page reading the other two would
    // not see it, nor its payment. Declared, never shown.
    for (const relay of relays.slice(1)) {
      relay.behaviour.refuseEvent = (event) =>
        event.pubkey === author ? "blocked: not now" : undefined;
    }
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      rest: { sats: "29000", bolt11: null, paymentUri: `bitcoin:${ADDRESS}?amount=0.00029` }
    });
    expect(recordedOn()).toBe(1);
    expect(warnings[0]).toMatch(/record of an invoice of the rest was not published/);
    // Still refused: still not shown, never asked again.
    expect(await sattleme.getStatus(invoice)).toMatchObject({ rest: { bolt11: null } });
    const [made] = madeOf(29_000);
    expect(madeOf(29_000)).toEqual([made]);
    // Taken: published again on a majority at the next check, shown.
    for (const relay of relays) relay.behaviour.refuseEvent = undefined;
    expect(await sattleme.getStatus(invoice)).toMatchObject({ rest: { bolt11: made!.pr } });
    expect(recordedOn()).toBeGreaterThanOrEqual(2);
    expect(madeOf(29_000)).toEqual([made]);
  });

  it("never publishes a rest record over one of a newer format, and warns (SPEC.md §12)", async () => {
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 20_000));
    const keys = restKeys(merchant.integrationKey, "R-1", ADDRESS, invoice.expiresAt);
    const relays = merchant.keyRelays.map((url) => merchant.net.get(url));
    // Its record taken by the first relay alone: not known on a majority yet.
    for (const relay of relays.slice(1)) {
      relay.behaviour.refuseEvent = (event) =>
        event.pubkey === keys.author ? "blocked: not now" : undefined;
    }
    await sattleme.getStatus(invoice);
    const [made] = madeOf(29_000);
    // A newer version wrote that invoice's record, in a format this one cannot read, on the second.
    const d = restRecordAddress(keys.key, made!.paymentHash);
    const newer = sealRecord({
      type: "checkout-rest",
      value: { version: 2 },
      signer: keys.secretKey,
      encryptionKey: keys.encryptionKey,
      address: d,
      createdAt: merchant.now - 1,
      tags: [["expiration", String(invoice.expiresAt + 604_800)]]
    });
    relays[1]!.take(newer);
    for (const relay of relays) relay.behaviour.refuseEvent = undefined;
    const sent = relays[1]!.received.length;
    warnings = [];
    // A newer version recorded the invoice: it is shown, and nothing is published over that record.
    expect(await sattleme.getStatus(invoice)).toMatchObject({ rest: { bolt11: made!.pr } });
    expect(madeOf(29_000)).toEqual([made]);
    expect(relays[1]!.received.slice(sent).filter((event) => event.pubkey === keys.author)).toEqual(
      []
    );
    expect(relays[1]!.events).toContainEqual(newer);
    expect(warnings).toContainEqual(
      expect.stringMatching(/a record of an invoice of the rest has a newer format/)
    );
  });

  it("shows an invoice of the rest whose record a majority took in the check, though fewer than a majority answer the read of rest records", async () => {
    merchant.chain.add(ADDRESS, payment(txid("part"), ADDRESS, 20_000));
    const author = restKeys(merchant.integrationKey, "R-1", ADDRESS, invoice.expiresAt).author;
    // Two relays of three take its record, then stall on the read of the rest records.
    for (const url of merchant.keyRelays.slice(1)) {
      merchant.net.get(url).behaviour.muteQuery = (filter) =>
        filter.authors?.includes(author) === true && filter["#d"] === undefined;
    }
    const status = await sattleme.getStatus(invoice);
    const [made] = madeOf(29_000);
    expect(status).toMatchObject({ rest: { sats: "29000", bolt11: made!.pr } });
    expect(restRecords(invoice)).toHaveLength(1);
    // The next check, which took nothing, cannot tell: not shown until a majority answers.
    expect(await sattleme.getStatus(invoice)).toMatchObject({ rest: { bolt11: null } });
    for (const url of merchant.keyRelays) merchant.net.get(url).behaviour.muteQuery = undefined;
    expect(await sattleme.getStatus(invoice)).toMatchObject({ rest: { bolt11: made!.pr } });
    expect(madeOf(29_000)).toEqual([made]);
  });
});

describe("a mixed payment", () => {
  async function underpaid() {
    const tx = payment(txid("part"), ADDRESS, 20_000);
    merchant.chain.add(ADDRESS, tx);
    const status = await sattleme.getStatus(invoice);
    const rest = (status as Extract<PaymentStatus, { state: "open" }>).rest!;
    return {
      tx,
      rest: merchant.invoices.get(madeOf(29_000)[0]!.paymentHash)!,
      bolt11: rest.bolt11
    };
  }

  it("is unconfirmed once the rest is paid, then paid at 3 confirmations, with the preimage", async () => {
    const { tx, rest } = await underpaid();
    merchant.payInvoice(rest.paymentHash);
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "unconfirmed",
      received: "49000",
      confirmations: 0,
      txids: [tx.txid]
    });
    merchant.chain.confirm(ADDRESS, tx.txid, merchant.chain.height - 2);
    merchant.now = invoice.expiresAt + 3600;
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "paid",
      method: "mixed",
      received: "49000",
      txids: [tx.txid],
      preimages: [rest.preimage]
    });
    // The order is paid: its next invoice is refused, without the preimage of its own invoice.
    const error = await sattleme
      .createInvoice({ ref: "R-1", sats: 49_000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderPaidError);
    expect(error).toMatchObject({ preimage: null, status: { method: "mixed" } });
  });

  it("counts a rest paid when the on-chain payment is gone, and expires with all received", async () => {
    const { tx, rest } = await underpaid();
    merchant.payInvoice(rest.paymentHash);
    merchant.chain.drop(ADDRESS, tx.txid);
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "open",
      received: "29000",
      rest: { sats: "20000" }
    });
    merchant.now = invoice.expiresAt + 3600;
    expect(await sattleme.getStatus(invoice)).toEqual({ state: "expired", received: "29000" });
  });

  it("never leases the address again for the order once a witness names it, its payment gone", async () => {
    const { tx, rest } = await underpaid();
    merchant.payInvoice(rest.paymentHash);
    // The on-chain payment gone, the explorer shows nothing paid the address; its witness does
    // (SPEC.md, "Leasing an address"): the earlier invoice's 29 000 never counts for a new one.
    merchant.chain.drop(ADDRESS, tx.txid);
    merchant.now = invoice.expiresAt + 421;
    expect(await sattleme.getStatus(invoice)).toEqual({ state: "expired", received: "29000" });
    const next = await sattleme.createInvoice({ ref: "R-1", sats: 49_000, durationSeconds: 600 });
    expect(next.onchainAddress).toBeNull();
    expect(next.bolt11).not.toBe(invoice.bolt11);
  });

  it("lets the order get a new invoice once the invoice and its rest ended unpaid", async () => {
    await underpaid();
    merchant.now = invoice.expiresAt + 100;
    await expect(sattleme.createInvoice({ ref: "R-1", sats: 49_000 })).rejects.toBeInstanceOf(
      InvoicePendingError
    );
    // The rest invoice ended with the invoice: both final 120 s later.
    merchant.now = invoice.expiresAt + 200;
    const next = await sattleme.createInvoice({ ref: "R-1", sats: 49_000 });
    expect(next.bolt11).not.toBe(invoice.bolt11);
    // The address was paid: never leased again.
    expect(next.onchainAddress).toBeNull();
  });

  it("is paid by waitForPayment once the rest is paid, without a push of the explorer", async () => {
    await merchant.startExplorerSocket();
    const { tx, rest } = await underpaid();
    merchant.chain.confirm(ADDRESS, tx.txid, merchant.chain.height - 2);
    const statuses: PaymentStatus[] = [];
    const waiting = sattleme.waitForPayment(invoice, {
      intervalMs: 250,
      onStatus: (status) => statuses.push(status)
    });
    for (let i = 0; i < 200 && statuses.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(statuses.at(-1)).toMatchObject({ state: "open", rest: { sats: "29000" } });
    merchant.payInvoice(rest.paymentHash);
    expect(await waiting).toEqual({
      state: "paid",
      method: "mixed",
      received: "49000",
      txids: [tx.txid],
      preimages: [rest.preimage]
    });
  });

  it("never ends waitForPayment on what was due before the rest was paid", async () => {
    const { tx, rest } = await underpaid();
    merchant.chain.confirm(ADDRESS, tx.txid, merchant.chain.height - 2);
    // The rest paid in time, its verify URL failing once past the grace period: the full check
    // (no push of the explorer here, the next one is 60 s later) judges the on-chain part against
    // the whole amount, final, and cannot tell the rest.
    merchant.payInvoice(rest.paymentHash);
    merchant.now = invoice.expiresAt + 121;
    let failures = 1;
    merchant.override = (url) =>
      url.href === rest.verify && failures-- > 0 ? answer({ oops: true }, 500) : undefined;
    const statuses: PaymentStatus[] = [];
    // The rest seen paid by the next Lightning check: only a full check, with the 20 000 on-chain
    // all that is due, gives the status (never "expired" with 49 000 received).
    expect(
      await sattleme.waitForPayment(invoice, {
        intervalMs: 250,
        onStatus: (status) => statuses.push(status)
      })
    ).toEqual({
      state: "paid",
      method: "mixed",
      received: "49000",
      txids: [tx.txid],
      preimages: [rest.preimage]
    });
    // Failed once, then read by the Lightning check and by the full check it started.
    expect(failures).toBe(-2);
    expect(statuses.filter(({ state }) => state === "expired")).toEqual([]);
  });
});
