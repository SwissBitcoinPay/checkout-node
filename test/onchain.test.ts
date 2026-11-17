import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkoutKeys,
  parseCheckoutFragment,
  parseCheckoutValue,
  type CheckoutRecord
} from "../src/checkout.js";
import { registryOf } from "../src/declaration.js";
import { outerKey, restKeys, saleKeys, saleOf, type Sale } from "../src/derive.js";
import {
  InvalidInvoiceError,
  InvalidOrderError,
  InvoicePendingError,
  NetworkError,
  OnchainUnavailableError,
  OrderPaidError,
  Sattleme,
  type Invoice,
  type PaymentStatus,
  type SattlemeOptions
} from "../src/index.js";
import type { NostrEvent } from "../src/nostr/event.js";
import { conversationKey, nip44Decrypt } from "../src/nostr/nip44.js";
import { leaseAddress } from "../src/onchain/address.js";
import { blockcypherMilliseconds } from "../src/onchain/explorer.js";
import { leaseEvent, openLeaseRecord } from "../src/onchain/lease.js";
import { sealRecord } from "../src/nostr/record.js";
import {
  addressTag,
  openWitness,
  orderTag,
  seenOf,
  witnessAddress,
  type Witness
} from "../src/onchain/witness.js";
import { BLOCKCYPHER_URL, MEMPOOL_URL } from "../src/protocol.js";

import { depositAddress, payment, txid, type EsploraTx } from "./helpers/chain.js";
import { makeInvoice, metadataHash } from "./helpers/lightning.js";
import { METADATA, TestMerchant } from "./helpers/merchant.js";

/*
 * On-chain payments (SPEC.md, "On-chain payments"), end to end against local relays and fakes of
 * breez.tips, of the explorers (REST and WebSocket) and of BlockCypher: the methods of an order by
 * its amount, a lot read and an address leased, two servers leasing one address, a paid address
 * skipped, the witnesses written and read, the statuses of both parts, an order paid on-chain
 * found again, waitForPayment woken by the explorer's WebSocket.
 */

const quiet = { warn: () => {} };
const ORIGIN = "https://pay.example";
const LOT = [depositAddress(1), depositAddress(2), depositAddress(3)];
let merchant: TestMerchant;

function client(options: Partial<SattlemeOptions> = {}) {
  return new Sattleme({
    key: merchant.key,
    fetch: merchant.http.fetch,
    WebSocket: merchant.net.WebSocket,
    now: () => merchant.now * 1000,
    relayTimeoutMs: 1000,
    logger: quiet,
    ...options
  });
}

/** The records the first relay holds now, by kind of record (its `d` tag). */
function held(): NostrEvent[] {
  return merchant.net.get(merchant.keyRelays[0]!).events as NostrEvent[];
}

/** The leases and withdrawals of `address` the relays received, opened by the merchant. */
function leasesOf(address: string) {
  const d = leaseAddress(merchant.registryKey, address);
  return merchant.net.get(merchant.keyRelays[0]!).received.flatMap((event) => {
    const record = openLeaseRecord(event, merchant.registryKey, d);
    // The whole event, as the merchant's app opens it.
    return record ? [{ ...record, event }] : [];
  });
}

/** The inside of a lease, as the merchant's app opens it (registry key and reading key). */
function openAsMerchant(event: NostrEvent): Record<string, unknown> {
  const d = event.tags.find(([name]) => name === "d")![1]!;
  const outside = JSON.parse(
    nip44Decrypt(event.content, outerKey(merchant.registryKey, d, event.pubkey))
  ) as { t: string; v: { end: number; sealed: string } };
  expect(outside.t).toBe("registry-onchain");
  return {
    end: outside.v.end,
    ...(JSON.parse(
      nip44Decrypt(outside.v.sealed, conversationKey(merchant.readerSecret, event.pubkey))
    ) as Record<string, unknown>)
  };
}

/** The witnesses the relays hold, as the merchant's app reads them (by the seen author). */
function witnesses(): (Witness & { seenAt: number })[] {
  const seen = seenOf(merchant.integrationKey);
  return held().flatMap((event) => {
    const opened = openWitness(event, seen);
    return opened?.status === "ok" ? [{ ...opened.witness, seenAt: event.created_at }] : [];
  });
}

/** The sale of `ref`, in the merchant's registry. */
function saleOfRef(ref: string): Sale {
  return saleOf(
    merchant.integrationKey,
    registryOf(Buffer.from(merchant.registryKey).toString("hex"), merchant.reader),
    ref
  );
}

beforeEach(async () => {
  merchant = await new TestMerchant().start();
  merchant.publishChannel(
    merchant.channelValue(100, { relays: merchant.keyRelays, checkout: { origin: ORIGIN } }),
    100
  );
  merchant.publishLot(LOT, 90);
});

afterEach(async () => {
  await merchant.stop();
});

describe("the methods of an order by its amount", () => {
  it("leases an address from 1 000 sats, before the invoice is declared", async () => {
    const invoice = await client().createInvoice({ ref: "ORD-1", sats: 49_000, note: "Order 1" });
    expect(LOT).toContain(invoice.onchainAddress);
    const address = invoice.onchainAddress!;
    expect(invoice.bolt11).toMatch(/^lnbc/);
    expect(invoice.paymentUri).toBe(
      `bitcoin:${address}?amount=0.00049&lightning=${invoice.bolt11}`
    );
    // The explorer was asked whether the address was paid already.
    expect(merchant.chain.asked).toContain(`${MEMPOOL_URL}/address/${address}/txs`);
    // The lease first, then its mark once confirmed, then the declaration: an address is never
    // shown before its lease is confirmed.
    const sale = saleKeys(merchant.integrationKey, "ORD-1");
    const received = merchant.net.get(merchant.keyRelays[0]!).received;
    const lease = received.findIndex((event) =>
      event.tags.some(([, d]) => d === leaseAddress(merchant.registryKey, address))
    );
    expect(lease).toBe(0);
    expect(received).toHaveLength(3);
    expect(received.every((event) => event.pubkey === sale.author)).toBe(true);
    expect(received[1]!.created_at).toBeGreaterThan(received[0]!.created_at);
    expect(openAsMerchant(received[0]!)).toMatchObject({ confirmed: false });
    expect(openAsMerchant(received[1]!)).toEqual({
      end: invoice.expiresAt + 120,
      version: 1,
      address,
      sats: 49000,
      invoice: invoice.bolt11,
      verifyUrl: invoice.verifyUrl,
      createdAt: invoice.createdAt,
      expiresAt: invoice.expiresAt,
      sale: {
        key: Buffer.from(sale.key).toString("hex"),
        fiat: { minor: 49000, digits: 0, currency: "SAT" },
        note: "Order 1"
      },
      taker: saleOfRef("ORD-1").taker,
      confirmed: true
    });
  });

  it("is Lightning only below 1 000 sats: the lot is not even read", async () => {
    const invoice = await client().createInvoice({ ref: "ORD-2", sats: 999 });
    expect(invoice).toMatchObject({
      onchainAddress: null,
      paymentUri: `lightning:${invoice.bolt11}`
    });
    expect(merchant.chain.asked).toEqual([]);
  });

  it("is on-chain only above the Lightning address's maximum", async () => {
    merchant.pay = { ...merchant.pay, maxSendable: 4_000_000_000 };
    const invoice = await client().createInvoice({
      ref: "ORD-3",
      sats: "150000000",
      durationSeconds: 600
    });
    expect(invoice).toMatchObject({
      bolt11: null,
      paymentHash: null,
      verifyUrl: null,
      sats: "150000000",
      createdAt: merchant.now,
      expiresAt: merchant.now + 600
    });
    expect(invoice.paymentUri).toBe(`bitcoin:${invoice.onchainAddress}?amount=1.5`);
    // No invoice asked, nothing declared: the lease alone, then its mark.
    expect(merchant.invoices.size).toBe(0);
    const received = merchant.net.get(merchant.keyRelays[0]!).received;
    expect(received).toHaveLength(2);
    expect(openAsMerchant(received[1]!)).toMatchObject({
      confirmed: true,
      invoice: null,
      verifyUrl: null,
      createdAt: merchant.now,
      expiresAt: merchant.now + 600,
      end: merchant.now + 720
    });
    expect(await client().getStatus(invoice)).toEqual({
      state: "open",
      expiresAt: invoice.expiresAt,
      received: "0",
      rest: null
    });
  });

  it("is Lightning only without a lot, and fails on-chain only", async () => {
    for (const relay of merchant.keyRelays) {
      const store = merchant.net.get(relay).events;
      store.splice(0, store.length);
    }
    merchant.publishChannel(merchant.channelValue(100, { relays: merchant.keyRelays }), 100);
    const sattleme = client();
    expect(await sattleme.merchant()).toMatchObject({ onchainAddresses: 0 });
    expect(await sattleme.createInvoice({ ref: "ORD-4", sats: 49_000 })).toMatchObject({
      onchainAddress: null
    });
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    await expect(sattleme.createInvoice({ ref: "ORD-5", sats: 49_000 })).rejects.toBeInstanceOf(
      OnchainUnavailableError
    );
    // Nothing published for that order.
    expect(merchant.invoices.size).toBe(1);
  });

  it("is Lightning only when the explorer does not answer, and NetworkError on-chain only", async () => {
    merchant.chain.down.add("mempool");
    const sattleme = client();
    expect(await sattleme.createInvoice({ ref: "ORD-6", sats: 49_000 })).toMatchObject({
      onchainAddress: null
    });
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    await expect(sattleme.createInvoice({ ref: "ORD-7", sats: 49_000 })).rejects.toBeInstanceOf(
      NetworkError
    );
  });

  it("refuses more than 21 million bitcoins", async () => {
    await expect(
      client().createInvoice({ ref: "ORD-8", sats: "2100000000000001" })
    ).rejects.toBeInstanceOf(InvalidOrderError);
  });

  it("counts the lot's addresses in merchant()", async () => {
    expect(await client().merchant()).toMatchObject({ onchainAddresses: 3 });
  });
});

describe("leasing an address", () => {
  it("never leases an address another order holds, until its lease ended", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const sattleme = client();
    const first = await sattleme.createInvoice({ ref: "L-1", sats: 49_000, durationSeconds: 60 });
    expect(first.onchainAddress).toBe(LOT[0]);
    const second = await sattleme.createInvoice({ ref: "L-2", sats: 49_000 });
    expect(second.onchainAddress).toBeNull();
    // Its lease ends 120 s after the invoice's end; another server's clock may be 300 s behind.
    merchant.now = first.expiresAt + 120 + 300;
    expect((await sattleme.createInvoice({ ref: "L-3", sats: 49_000 })).onchainAddress).toBeNull();
    merchant.now += 1;
    expect((await sattleme.createInvoice({ ref: "L-4", sats: 49_000 })).onchainAddress).toBe(
      LOT[0]
    );
  });

  it("skips an address paid already, and publishes its witness none", async () => {
    const paid = payment(txid("old"), LOT[0]!, 20_000, { height: 960_000 });
    merchant.chain.add(LOT[0]!, paid);
    merchant.publishLot([LOT[0]!, LOT[1]!], 91);
    const invoice = await client().createInvoice({ ref: "L-5", sats: 49_000 });
    expect(invoice.onchainAddress).toBe(LOT[1]);
    // Whichever was tried first: the paid one is never leased.
    expect(leasesOf(LOT[0]!)).toEqual([]);
    merchant.publishLot([LOT[0]!], 92);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    await expect(client().createInvoice({ ref: "L-6", sats: 49_000 })).rejects.toBeInstanceOf(
      OnchainUnavailableError
    );
    expect(witnesses()).toEqual([
      {
        address: LOT[0],
        txid: paid.txid,
        sale: null,
        sats: 20_000n,
        inputs: [`${txid(`coin of ${paid.txid}`)}:0`],
        replacement: false,
        expiresAt: null,
        seenAt: merchant.now
      }
    ]);
  });

  it("withdraws its lease, unconfirmed, when another server leased the address at once", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    const other = saleOfRef("ANOTHER-SERVER");
    let raced = false;
    // Another server's lease of the same address reaches every relay right after this one's.
    for (const url of merchant.keyRelays) {
      merchant.net.get(url).behaviour = {
        onEvent: (event) => {
          if (raced || !event.tags.some(([, value]) => value === d)) return;
          raced = true;
          const competing = leaseEvent({
            sale: other,
            terms: {
              address: LOT[0]!,
              sats: 1000n,
              invoice: null,
              verifyUrl: null,
              createdAt: merchant.now,
              expiresAt: merchant.now + 900,
              price: { minor: 1000, digits: 0, currency: "SAT" },
              note: "Another order",
              tolerance: 0
            },
            createdAt: merchant.now
          });
          for (const relay of merchant.keyRelays) merchant.net.get(relay).take(competing);
        }
      };
    }
    const invoice = await client().createInvoice({ ref: "L-7", sats: 49_000 });
    // It saw the other lease after its own was on a majority: not confirmed, Lightning only. Its
    // lease, unmarked, is withdrawn: it gives the invoice no address.
    expect(invoice.onchainAddress).toBeNull();
    const records = leasesOf(LOT[0]!).filter(({ event }) => event.pubkey !== other.author);
    expect(records.map(({ outside }) => outside.kind)).toEqual(["lease", "withdrawn"]);
    expect(openAsMerchant(records[0]!.event)).toMatchObject({ confirmed: false });
    expect(records[1]!.event.created_at).toBeGreaterThan(records[0]!.event.created_at);
    const [found] = await client().findInvoices("L-7");
    expect(found).toMatchObject({ bolt11: invoice.bolt11, onchainAddress: null });
  });

  it("leaves its lease, confirmed, when the declaration fails: it holds the address", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    for (const url of merchant.keyRelays.slice(0, 2)) {
      merchant.net.get(url).behaviour = {
        // Leases and withdrawals are taken, declarations refused.
        refuseEvent: (event) =>
          event.tags.some(([, value]) => value === d) ? undefined : "blocked: no"
      };
    }
    await expect(client().createInvoice({ ref: "L-8", sats: 49_000 })).rejects.toBeInstanceOf(
      NetworkError
    );
    // The lease and its mark: never withdrawn.
    expect(leasesOf(LOT[0]!).map(({ outside }) => outside.kind)).toEqual(["lease", "lease"]);
    for (const url of merchant.keyRelays) merchant.net.get(url).behaviour = {};
    // It holds the address until its end: another order gets none.
    expect((await client().createInvoice({ ref: "L-9", sats: 49_000 })).onchainAddress).toBeNull();
  });

  it("leaves its lease, confirmed, when its mark fails: it holds the address", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    for (const url of merchant.keyRelays.slice(1)) {
      let records = 0;
      merchant.net.get(url).behaviour = {
        // The lease is taken; its mark, and any later record of its address, refused.
        refuseEvent: (event) =>
          event.tags.some(([name, value]) => name === "d" && value === d) && records++ > 0
            ? "blocked: no"
            : undefined
      };
    }
    const failed = await client()
      .createInvoice({ ref: "L-11", sats: 49_000 })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(NetworkError);
    expect((failed as NetworkError).message).toMatch(/took the lease/);
    // The lease and its mark, which the first relay alone took: never withdrawn.
    expect(leasesOf(LOT[0]!).map(({ outside }) => outside.kind)).toEqual(["lease", "lease"]);
    expect(leasesOf(LOT[0]!).map(({ event }) => openAsMerchant(event))).toMatchObject([
      { confirmed: false },
      { confirmed: true }
    ]);
    for (const url of merchant.keyRelays) merchant.net.get(url).behaviour = {};
    // It holds the address until its end: another order gets none.
    expect((await client().createInvoice({ ref: "L-12", sats: 49_000 })).onchainAddress).toBeNull();
  });

  it("leaves its lease, confirmed, when the checkout link fails: it holds the address", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    const author = saleOfRef("L-13").author;
    for (const url of merchant.keyRelays.slice(1)) {
      merchant.net.get(url).behaviour = {
        // The sale's records are taken (its lease and mark), the checkout link (of a key of its
        // own) refused.
        refuseEvent: (event) => (event.pubkey === author ? undefined : "blocked: no")
      };
    }
    const failed = await client()
      .createInvoice({ ref: "L-13", sats: 49_000, checkout: true })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(NetworkError);
    expect((failed as NetworkError).message).toMatch(/took the checkout link/);
    // The lease and its mark: never withdrawn. Nothing declared.
    expect(leasesOf(LOT[0]!).map(({ outside }) => outside.kind)).toEqual(["lease", "lease"]);
    const first = merchant.net.get(merchant.keyRelays[0]!).received;
    expect(
      first.filter(
        (event) =>
          event.pubkey === author &&
          !event.tags.some(([name, value]) => name === "d" && value === d)
      )
    ).toEqual([]);
    for (const url of merchant.keyRelays) merchant.net.get(url).behaviour = {};
    // The invoice was never shown (its lease names an invoice never declared): the order gets a
    // new one at once, without the address its lease holds until its end.
    const next = await client().createInvoice({ ref: "L-13", sats: 49_000, checkout: true });
    expect(next.onchainAddress).toBeNull();
    expect(next.checkoutUrl?.startsWith(`${ORIGIN}/`)).toBe(true);
    expect(leasesOf(LOT[0]!).map(({ outside }) => outside.kind)).toEqual(["lease", "lease"]);
  });

  it("refuses an invoice its lease cannot hold, before anything is published", async () => {
    merchant.publishLot([LOT[0]!], 91);
    // The lease seals the invoice twice, as the declaration does, with some 150 bytes more: an
    // invoice of 40 550 characters fits a declaration (its inside within NIP-44's padded 40 960
    // bytes) and not a lease (padded to 49 152 bytes, too large once sealed again).
    merchant.tamper = (m) => {
      const sized = (words: number) =>
        makeInvoice({
          amountMsat: m.amountMsat,
          paymentHash: m.paymentHash,
          descriptionHash: metadataHash(METADATA),
          timestamp: merchant.now,
          expirySeconds: 900,
          extra: [
            ...Array.from({ length: 39 }, (): [number, number[]] => [
              31,
              new Array<number>(1023).fill(0)
            ]),
            [31, new Array<number>(words).fill(0)]
          ]
        });
      return { pr: sized(40_550 - sized(0).length) };
    };
    const sent = merchant.keyRelays.map((url) => merchant.net.get(url).received.length);
    const error = await client()
      .createInvoice({ ref: "L-14", sats: 49_000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidInvoiceError);
    expect((error as InvalidInvoiceError).message).toMatch(/lease of an address/);
    // Nothing published: no lease, no declaration.
    merchant.keyRelays.forEach((url, i) => {
      expect(merchant.net.get(url).received.length).toBe(sent[i]);
    });
  });

  it("publishes nothing but its withdrawal when the lease does not reach a majority", async () => {
    merchant.publishLot([LOT[0]!], 91);
    for (const url of merchant.keyRelays.slice(0, 2)) {
      merchant.net.get(url).behaviour = { refuse: "blocked: no" };
    }
    await expect(client().createInvoice({ ref: "L-10", sats: 49_000 })).rejects.toBeInstanceOf(
      NetworkError
    );
    const third = merchant.net.get(merchant.keyRelays[2]!).received;
    // The lease, then its withdrawal: no mark, no declaration, no link.
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    expect(
      third.map((event) => openLeaseRecord(event, merchant.registryKey, d)?.outside.kind)
    ).toEqual(["lease", "withdrawn"]);
  });
});

describe("the payment of an invoice with an address", () => {
  let sattleme: Sattleme;
  let invoice: Invoice;
  let address: string;

  beforeEach(async () => {
    merchant.publishLot([LOT[0]!], 91);
    sattleme = client();
    invoice = await sattleme.createInvoice({ ref: "P-1", sats: 49_000, durationSeconds: 600 });
    address = invoice.onchainAddress!;
  });

  const sale = () => saleKeys(merchant.integrationKey, "P-1").author;

  it("is unconfirmed once enough is sent, its witness published, then paid at 3 confirmations", async () => {
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "open",
      expiresAt: invoice.expiresAt,
      received: "0",
      rest: null
    });
    const tx = payment(txid("pay"), address, 49_000);
    merchant.chain.add(address, tx);
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "unconfirmed",
      received: "49000",
      confirmations: 0,
      txids: [tx.txid]
    });
    // Seen while the lease runs: the witness of the order's sale, which the merchant's app reads.
    expect(witnesses()).toMatchObject([
      { address, txid: tx.txid, sale: sale(), sats: 49_000n, replacement: false }
    ]);
    merchant.chain.confirm(address, tx.txid, merchant.chain.height - 1);
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "unconfirmed",
      confirmations: 2
    });
    merchant.chain.confirm(address, tx.txid, merchant.chain.height - 2);
    // 3 confirmations on the explorer read (mempool.space): paid, no other explorer asked.
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "paid",
      method: "onchain",
      received: "49000",
      txids: [tx.txid]
    });
    expect(merchant.chain.asked.filter((href) => !href.startsWith(`${MEMPOOL_URL}/`))).toEqual([]);
    // Long after the invoice's end: the witness says it came in time.
    merchant.now = invoice.expiresAt + 3600;
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "paid",
      method: "onchain",
      received: "49000",
      txids: [tx.txid]
    });
    // One witness: a check that finds it adds nothing.
    expect(witnesses()).toHaveLength(1);
    expect(merchant.chain.blockcypherAsked).toEqual([]);
  });

  it("is open while underpaid, then expired with what was received", async () => {
    merchant.chain.add(address, payment(txid("part"), address, 20_000, { height: 969_990 }));
    // Its rest, asked in Lightning too (test/rest.test.ts).
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "open",
      expiresAt: invoice.expiresAt,
      received: "20000",
      rest: { sats: "29000" }
    });
    merchant.now = invoice.expiresAt + 121;
    expect(await sattleme.getStatus(invoice)).toEqual({ state: "expired", received: "20000" });
  });

  it("is expired for a payment no check saw, received late by BlockCypher's time", async () => {
    merchant.now = invoice.expiresAt + 3600;
    const tx = payment(txid("late"), address, 49_000);
    merchant.chain.add(address, tx);
    merchant.chain.received.set(tx.txid, new Date((invoice.expiresAt + 121) * 1000).toISOString());
    expect(await sattleme.getStatus(invoice)).toEqual({ state: "expired", received: "0" });
    expect(merchant.chain.blockcypherAsked).toEqual([
      `${BLOCKCYPHER_URL}/txs/${tx.txid}?limit=1&includeHex=false`
    ]);
    // Of no order: a witness none, so that the merchant's app takes the address out of the lot.
    expect(witnesses()).toMatchObject([{ txid: tx.txid, sale: null }]);
  });

  it("judges a transaction by the clock once the explorer answered, never before it", async () => {
    // The check starts 5 s before the lease's end; the explorer answers 10 s later. Listed then,
    // the transaction was not seen in time: BlockCypher received it 3 s after the end.
    merchant.now = invoice.expiresAt + 115;
    const tx = payment(txid("listed after the end"), address, 49_000);
    merchant.chain.add(address, tx);
    merchant.chain.received.set(tx.txid, new Date((invoice.expiresAt + 123) * 1000).toISOString());
    merchant.override = (url) => {
      if (url.pathname.endsWith(`/address/${address}/txs`)) merchant.now += 10;
      return undefined;
    };
    // Its Lightning part, asked before, not final yet: open, with nothing received on-chain.
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "open", received: "0" });
    expect(witnesses()).toMatchObject([{ txid: tx.txid, sale: null }]);
  });

  it("never writes a witness none over one of a newer format, and warns (SPEC.md §12)", async () => {
    merchant.now = invoice.expiresAt + 3600;
    const tx = payment(txid("late, its witness newer"), address, 49_000);
    merchant.chain.add(address, tx);
    merchant.chain.received.set(tx.txid, new Date((invoice.expiresAt + 121) * 1000).toISOString());
    // A newer version's witness none of it, on every relay: what it holds cannot be read here.
    const seen = seenOf(merchant.integrationKey);
    const newer = sealRecord({
      type: "integration-onchain-seen",
      value: { version: 2 },
      signer: seen.secretKey,
      encryptionKey: seen.encryptionKey,
      address: witnessAddress(seen.addressKey, address, tx.txid, null),
      createdAt: merchant.now - 60,
      tags: [
        ["o", orderTag(seen.addressKey, address, null)],
        ["o", addressTag(seen.addressKey, address)]
      ]
    });
    for (const url of merchant.keyRelays) merchant.net.get(url).take(newer);
    const sent = merchant.keyRelays.map((url) => merchant.net.get(url).received.length);
    const warnings: string[] = [];
    const watched = client({ logger: { warn: (message) => warnings.push(message) } });
    expect(await watched.getStatus(invoice)).toEqual({ state: "expired", received: "0" });
    merchant.keyRelays.forEach((url, i) => {
      const received = merchant.net.get(url).received.slice(sent[i]);
      expect(received.filter((event) => event.pubkey === seen.author)).toEqual([]);
    });
    expect(warnings).toContainEqual(
      expect.stringMatching(/a witness of this address has a newer format/)
    );
  });

  it("counts a payment no check saw that BlockCypher received in time", async () => {
    merchant.now = invoice.expiresAt + 3600;
    const tx = payment(txid("in time"), address, 49_000);
    merchant.chain.add(address, tx);
    merchant.chain.received.set(tx.txid, new Date((invoice.expiresAt + 100) * 1000).toISOString());
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "unconfirmed",
      received: "49000"
    });
    expect(witnesses()).toMatchObject([{ txid: tx.txid, sale: sale(), replacement: false }]);
    // Its witness spares the next check the question.
    await sattleme.getStatus(invoice);
    expect(merchant.chain.blockcypherAsked).toHaveLength(1);
  });

  it("counts a fee bump after the lease's end of a payment seen in time", async () => {
    const first = payment(txid("first"), address, 49_000);
    merchant.chain.add(address, first);
    await sattleme.getStatus(invoice);
    merchant.now = invoice.expiresAt + 3600;
    merchant.chain.drop(address, first.txid);
    const bump = payment(txid("bump"), address, 49_000, {
      coins: [...first.vin.map(({ txid: spent, vout }) => `${spent}:${vout}`), `${txid("fee")}:1`]
    });
    merchant.chain.add(address, bump);
    expect(await sattleme.getStatus(invoice)).toMatchObject({
      state: "unconfirmed",
      received: "49000",
      txids: [bump.txid]
    });
    expect(witnesses()).toContainEqual(
      expect.objectContaining({ txid: bump.txid, sale: sale(), replacement: true })
    );
    // Nothing to ask BlockCypher: all of it stands for the payment it replaces.
    expect(merchant.chain.blockcypherAsked).toEqual([]);
  });

  it("fails with NetworkError when the explorer does not answer, unless Lightning was paid", async () => {
    merchant.chain.down.add("mempool");
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(NetworkError);
    merchant.payInvoice(invoice.paymentHash!);
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "paid", method: "lightning" });
  });

  it("is found by the order's next invoice: pending while confirmed, then paid", async () => {
    const tx: EsploraTx = payment(txid("order"), address, 49_000);
    merchant.chain.add(address, tx);
    await sattleme.getStatus(invoice);
    merchant.now = invoice.expiresAt + 600;
    const pending = await sattleme
      .createInvoice({ ref: "P-1", sats: 49_000 })
      .catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(InvoicePendingError);
    expect((pending as InvoicePendingError).invoice).toMatchObject({
      bolt11: invoice.bolt11,
      onchainAddress: address
    });
    merchant.chain.confirm(address, tx.txid, merchant.chain.height - 5);
    const paid = await sattleme
      .createInvoice({ ref: "P-1", sats: 49_000 })
      .catch((e: unknown) => e);
    expect(paid).toBeInstanceOf(OrderPaidError);
    expect((paid as OrderPaidError).preimage).toBeNull();
    expect((paid as OrderPaidError).status).toEqual({
      state: "paid",
      method: "onchain",
      received: "49000",
      txids: [tx.txid]
    });
  });

  it("is found by findInvoices with its address, an order paid on-chain only too", async () => {
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    merchant.publishLot([LOT[1]!], 92);
    const onchainOnly = await sattleme.createInvoice({ ref: "P-2", sats: 2_000_000, note: "Big" });
    const [found] = await sattleme.findInvoices("P-1");
    expect(found).toEqual({
      ref: "P-1",
      bolt11: invoice.bolt11,
      paymentHash: invoice.paymentHash,
      verifyUrl: invoice.verifyUrl,
      onchainAddress: address,
      paymentUri: invoice.paymentUri,
      sats: "49000",
      fiat: null,
      note: "P-1",
      createdAt: invoice.createdAt,
      expiresAt: invoice.expiresAt,
      declaredAt: merchant.now
    });
    expect(await sattleme.findInvoices("P-2")).toEqual([
      {
        ref: "P-2",
        bolt11: null,
        paymentHash: null,
        verifyUrl: null,
        onchainAddress: onchainOnly.onchainAddress,
        paymentUri: onchainOnly.paymentUri,
        sats: "2000000",
        fiat: null,
        note: "Big",
        createdAt: onchainOnly.createdAt,
        expiresAt: onchainOnly.expiresAt,
        // Its confirmed lease: marked a second after the lease.
        declaredAt: onchainOnly.createdAt + 1
      }
    ]);
    // Pending: its declaration and its lease published again, nothing else made.
    const before = merchant.invoices.size;
    await expect(sattleme.createInvoice({ ref: "P-2", sats: 2_000_000 })).rejects.toBeInstanceOf(
      InvoicePendingError
    );
    expect(merchant.invoices.size).toBe(before);
  });

  it("refuses a stored invoice with an address but no reference", async () => {
    const stored: Partial<Invoice> = { ...invoice };
    delete stored.ref;
    await expect(sattleme.getStatus(stored as Invoice)).rejects.toBeInstanceOf(InvalidOrderError);
    await expect(
      sattleme.getStatus({ ...invoice, onchainAddress: "bc1qnotanaddress" })
    ).rejects.toBeInstanceOf(InvalidOrderError);
  });

  it("reads an invoice without an address field as Lightning only", async () => {
    const stored: Partial<Invoice> = { ...invoice };
    delete stored.onchainAddress;
    delete stored.paymentUri;
    merchant.chain.down.add("mempool");
    expect(await sattleme.getStatus(stored as Invoice)).toMatchObject({
      state: "open",
      received: "0"
    });
  });
});

describe("waitForPayment of an invoice with an address", () => {
  it("checks the on-chain part when the explorer's WebSocket says something changed", async () => {
    const socket = await merchant.startExplorerSocket();
    merchant.publishLot([LOT[0]!], 91);
    const sattleme = client();
    const invoice = await sattleme.createInvoice({ ref: "W-1", sats: 49_000 });
    const address = invoice.onchainAddress!;
    const statuses: PaymentStatus[] = [];
    const waiting = sattleme.waitForPayment(invoice, {
      // Lightning checked once a minute: what moves here is the socket.
      intervalMs: 60_000,
      onStatus: (status) => statuses.push(status)
    });
    const until = async (condition: () => boolean) => {
      for (let i = 0; i < 200 && !condition(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(condition()).toBe(true);
    };
    await until(() => socket.messages.length === 2 && statuses.length > 0);
    expect(socket.messages).toEqual([
      { action: "want", data: ["blocks"] },
      { "track-address": address }
    ]);
    expect(statuses.at(-1)).toMatchObject({ state: "open" });

    const tx = payment(txid("watched"), address, 49_000);
    merchant.chain.add(address, tx);
    socket.push({ "address-transactions": [tx] });
    await until(() => statuses.at(-1)?.state === "unconfirmed");

    merchant.chain.confirm(address, tx.txid, merchant.chain.height - 2);
    socket.push({ block: { height: merchant.chain.height } });
    expect(await waiting).toEqual({
      state: "paid",
      method: "onchain",
      received: "49000",
      txids: [tx.txid]
    });
    // Closed once done.
    await until(() => socket.server.clients.size === 0);
  });

  it("leaves nothing running once it returned: a check it started stops", async () => {
    const socket = await merchant.startExplorerSocket();
    merchant.publishLot([LOT[0]!], 91);
    // The explorer's answers to the address's transactions, held while `gate` is set, as fetch
    // holds a slow answer: until it comes, or until the request's signal aborts.
    let gate: Promise<void> | null = null;
    let release = () => {};
    let held = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (gate !== null && url.endsWith("/txs")) {
        held += 1;
        const signal = init?.signal;
        await Promise.race([
          gate,
          new Promise<never>((_, reject) => {
            const aborted = () => reject(signal!.reason);
            if (signal?.aborted) aborted();
            signal?.addEventListener("abort", aborted, { once: true });
          })
        ]);
      }
      return merchant.http.fetch(input, init);
    }) as typeof globalThis.fetch;
    const until = async (condition: () => boolean) => {
      for (let i = 0; i < 200 && !condition(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(condition()).toBe(true);
    };
    const sattleme = client({ fetch });
    const invoice = await sattleme.createInvoice({ ref: "W-3", sats: 49_000 });
    const address = invoice.onchainAddress!;
    const statuses: PaymentStatus[] = [];
    const waiting = sattleme.waitForPayment(invoice, {
      intervalMs: 250,
      onStatus: (status) => statuses.push(status)
    });
    await until(() => socket.messages.length === 2 && statuses.length > 0);

    // A block: a full check starts, and waits for the explorer's answer.
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    socket.push({ block: { height: merchant.chain.height } });
    await until(() => held > 0);
    // Meanwhile the Lightning invoice is paid: the wait returns.
    merchant.payInvoice(invoice.paymentHash!);
    expect(await waiting).toMatchObject({ state: "paid", method: "lightning" });

    // Then the explorer answers, a part of the amount listed: the check it held would publish its
    // witness, ask an invoice of the rest and declare it. It stopped with the wait.
    const sent = merchant.keyRelays.map((url) => merchant.net.get(url).received.length);
    const made = merchant.invoices.size;
    merchant.chain.add(address, payment(txid("late part"), address, 10_000));
    release();
    await new Promise((resolve) => setTimeout(resolve, 500));
    merchant.keyRelays.forEach((url, i) => {
      expect(merchant.net.get(url).received.length).toBe(sent[i]);
    });
    expect(merchant.invoices.size).toBe(made);
  });

  it("stops when its signal aborts", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const sattleme = client();
    const invoice = await sattleme.createInvoice({ ref: "W-2", sats: 49_000 });
    const controller = new AbortController();
    const waiting = sattleme.waitForPayment(invoice, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop")), 50);
    await expect(waiting).rejects.toThrow("stop");
  });
});

describe("a checkout link to an invoice with an address", () => {
  it("is a record of version 2, which the page reads without the invoice", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const invoice = await client().createInvoice({
      ref: "C-1",
      sats: 49_000,
      checkout: true,
      redirectUrl: "https://shop.example/thanks"
    });
    const fragment = parseCheckoutFragment(
      invoice.checkoutUrl!.slice(invoice.checkoutUrl!.indexOf("#"))
    );
    if (fragment.status !== "link") throw new Error("Not a link");
    const keys = checkoutKeys(fragment.linkKey);
    const event = held().find((e) =>
      e.tags.some(([name, d]) => name === "d" && d === keys.address)
    )!;
    const { v } = JSON.parse(nip44Decrypt(event.content, keys.encryptionKey)) as { v: unknown };
    expect(v).toEqual({
      version: 2,
      businessName: "Sunrise Bakery",
      invoice: invoice.bolt11,
      verifyUrl: invoice.verifyUrl,
      onchainAddress: invoice.onchainAddress,
      sats: 49000,
      createdAt: invoice.createdAt,
      expiresAt: invoice.expiresAt,
      fiat: null,
      note: "C-1",
      redirectUrl: "https://shop.example/thanks",
      // The rest records of this invoice of the order: written by the integration key alone.
      restAuthor: restKeys(
        merchant.integrationKey,
        "C-1",
        invoice.onchainAddress!,
        invoice.expiresAt
      ).author,
      restKey: bytesToHex(
        restKeys(merchant.integrationKey, "C-1", invoice.onchainAddress!, invoice.expiresAt).key
      )
    });
    expect(parseCheckoutValue(v)).toMatchObject<Partial<CheckoutRecord>>({
      onchainAddress: invoice.onchainAddress,
      sats: 49_000n,
      expiresAt: invoice.expiresAt,
      rest: {
        author: restKeys(merchant.integrationKey, "C-1", invoice.onchainAddress!, invoice.expiresAt)
          .author,
        key: restKeys(merchant.integrationKey, "C-1", invoice.onchainAddress!, invoice.expiresAt)
          .key
      }
    });
  });
});

describe("BlockCypher's times", () => {
  it("reads them as BlockCypher writes them, the fraction past milliseconds dropped, and refuses anything else", () => {
    expect(blockcypherMilliseconds("2026-10-10T13:05:12.345Z")).toBe(
      Date.UTC(2026, 9, 10, 13, 5, 12, 345)
    );
    expect(blockcypherMilliseconds("2026-10-10T13:05:12.91Z")).toBe(
      Date.UTC(2026, 9, 10, 13, 5, 12, 910)
    );
    expect(blockcypherMilliseconds("2026-10-10T13:05:12Z")).toBe(Date.UTC(2026, 9, 10, 13, 5, 12));
    // Dropped, never rounded (SPEC.md §31, Explorers).
    expect(blockcypherMilliseconds("2026-10-10T13:05:12.345999999Z")).toBe(
      Date.UTC(2026, 9, 10, 13, 5, 12, 345)
    );
    // Year 75, not 1975: before 1970, never a time in a lease.
    expect(blockcypherMilliseconds("0075-01-01T00:00:00Z")).toBeLessThan(0);
    for (const text of [
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-10-10T24:00:00Z",
      "2026-12-31T23:59:60Z",
      "2026-10-10 13:05:12Z",
      "2026-10-10T13:05:12",
      "2026-10-10t13:05:12z",
      "2026-10-10T15:05:12+02:00",
      "2026-10-10T13:05:12.Z",
      "2026-10-10T13:05:12.0000000000Z"
    ]) {
      expect(blockcypherMilliseconds(text)).toBeNull();
    }
  });
});
