import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saleKeys, takerKey, takerTag } from "../src/derive.js";
import {
  InvalidInvoiceError,
  InvalidOptionError,
  InvalidOrderError,
  InvoicePendingError,
  NetworkError,
  OnchainUnavailableError,
  OrderPaidError,
  RevokedError,
  UnsupportedCurrencyError,
  Sattleme,
  type Order,
  type SattlemeOptions
} from "../src/index.js";
import { isValidEvent } from "../src/nostr/event.js";

import { answer } from "./helpers/fetch.js";
import { makeInvoice, metadataHash } from "./helpers/lightning.js";
import { CALLBACK, METADATA, TestMerchant } from "./helpers/merchant.js";
import { openAsOwner } from "./helpers/owner.js";

const quiet = { warn: () => {} };
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

/** Every declaration the relays received. */
function declarations() {
  return merchant.keyRelays.flatMap((url) =>
    merchant.net.get(url).received.filter((event) => event.kind === 30078)
  );
}

beforeEach(async () => {
  merchant = await new TestMerchant().start();
  merchant.publishChannel(merchant.channelValue(100, { relays: merchant.keyRelays }), 100);
});

afterEach(async () => {
  await merchant.stop();
});

describe("createInvoice", () => {
  it("keeps the callback's own query parameters and drops its fragment", async () => {
    merchant.pay = { ...merchant.pay, callback: `${CALLBACK}?k=1#tag` };
    await client().createInvoice({ ref: "ORD-1", sats: 1000n });
    const callback = merchant.http.calls.find(({ url }) => url.pathname.endsWith("/invoice"))!;
    expect(callback.url.hash).toBe("");
    expect(Object.fromEntries(callback.url.searchParams)).toEqual({
      k: "1",
      amount: "1000000",
      expiry: "900",
      comment: "ORD-1"
    });
  });

  it("refuses a pay request whose callback is not an https URL", async () => {
    for (const callback of [
      "https://10.0.0.1/cb",
      "https://pay.localhost/cb",
      "https://user@breez.tips/cb"
    ]) {
      merchant.pay = { ...merchant.pay, callback };
      await expect(client().createInvoice({ ref: "ORD-1", sats: 1000n })).rejects.toBeInstanceOf(
        InvalidInvoiceError
      );
    }
    expect(merchant.http.calls.every(({ url }) => !url.pathname.endsWith("/cb"))).toBe(true);
  });

  it("refuses a pay request whose metadata holds a lone surrogate: it has no UTF-8 to hash", async () => {
    // Valid JSON (an escape), but no text (SPEC.md §6, §16): TextEncoder would hash U+FFFD for it.
    const metadata = '[["text/plain","Pay \ud800"]]';
    merchant.pay = { ...merchant.pay, metadata };
    merchant.tamper = (made) => ({
      pr: makeInvoice({
        amountMsat: made.amountMsat,
        paymentHash: made.paymentHash,
        descriptionHash: metadataHash(metadata),
        timestamp: merchant.now,
        expirySeconds: made.expiry
      })
    });
    await expect(client().createInvoice({ ref: "ORD-1", sats: 1000n })).rejects.toBeInstanceOf(
      InvalidInvoiceError
    );
    expect(merchant.http.calls.every(({ url }) => !url.pathname.endsWith("/invoice"))).toBe(true);
  });

  it("fails with NetworkError on a callback whose host fetch cannot read", async () => {
    // An https URL by its rule (SPEC.md §15), but a punycode label that decodes to nothing.
    merchant.pay = { ...merchant.pay, callback: "https://xn--abc.example/cb" };
    await expect(client().createInvoice({ ref: "ORD-1", sats: 1000n })).rejects.toBeInstanceOf(
      NetworkError
    );
  });

  it("asks, checks and declares the invoice of an order in sats", async () => {
    const invoice = await client().createInvoice({
      ref: "ORD-1042",
      sats: 49_000n,
      note: "Order 1042"
    });
    const made = [...merchant.invoices.values()][0]!;
    expect(invoice).toEqual({
      ref: "ORD-1042",
      bolt11: made.pr,
      paymentHash: made.paymentHash,
      verifyUrl: made.verify,
      // Within the Lightning address's bounds, and no lot of addresses: Lightning only.
      onchainAddress: null,
      paymentUri: `lightning:${made.pr}`,
      sats: "49000",
      fiat: null,
      rate: null,
      note: "Order 1042",
      createdAt: merchant.now,
      expiresAt: merchant.now + 900,
      // No checkout link was asked.
      checkoutUrl: null,
      redirectUrl: null
    });
    // JSON as is: an integrator stores it with the order.
    expect(JSON.parse(JSON.stringify(invoice))).toEqual(invoice);

    const callback = merchant.http.calls.find(({ url }) => url.pathname.endsWith("/invoice"))!;
    expect(Object.fromEntries(callback.url.searchParams)).toEqual({
      amount: "49000000",
      expiry: "900",
      comment: "Order 1042"
    });
    // Every request, with the User-Agent every implementation sends (SPEC.md §15).
    await client().getStatus(invoice);
    expect(merchant.http.calls.length).toBeGreaterThanOrEqual(3);
    for (const { headers } of merchant.http.calls) {
      expect(headers).toEqual({
        Accept: "application/json",
        "User-Agent": "sattleme-Checkout/1"
      });
    }

    // Declared on every relay of the account, signed by the order's sale.
    const events = declarations();
    expect(events).toHaveLength(3);
    const [event] = events;
    const sale = saleKeys(merchant.integrationKey, "ORD-1042");
    expect(isValidEvent(event)).toBe(true);
    expect(event!.pubkey).toBe(sale.author);
    expect(openAsOwner(event!, merchant.registryKey, merchant.readerSecret)).toEqual({
      version: 1,
      invoice: made.pr,
      verifyUrl: made.verify,
      sale: {
        key: bytesToHex(sale.key),
        fiat: { minor: 49000, digits: 0, currency: "SAT" },
        note: "Order 1042"
      },
      taker: takerTag(takerKey(merchant.integrationKey), sale.author)
    });
  });

  it("names the order by its reference without a note, and comments only as allowed", async () => {
    const sattleme = client();
    await sattleme.createInvoice({ ref: "A-1", sats: 100 });
    merchant.pay = { ...merchant.pay, commentAllowed: 2 };
    await client().createInvoice({ ref: "A-2", sats: "100", durationSeconds: 60 });
    merchant.pay = { ...merchant.pay, commentAllowed: undefined };
    await client().createInvoice({ ref: "A-3", sats: 100, durationSeconds: 3600 });
    const comments = [...merchant.invoices.values()].map(({ comment, expiry }) => [
      comment,
      expiry
    ]);
    expect(comments).toEqual([
      ["A-1", 900],
      [null, 60],
      [null, 3600]
    ]);
    expect(
      openAsOwner(declarations()[0]!, merchant.registryKey, merchant.readerSecret)
    ).toMatchObject({ sale: { note: "A-1" } });
  });

  const invalid: [string, Order | Record<string, unknown>][] = [
    ["ref", { sats: 1 }],
    ["ref", { ref: "", sats: 1 }],
    ["ref", { ref: "x".repeat(65), sats: 1 }],
    ["ref", { ref: "CMD 1", sats: 1 }],
    ["ref", { ref: "CMD/1", sats: 1 }],
    ["ref", { ref: "Bestellung-ä", sats: 1 }],
    ["ref", { ref: 1042, sats: 1 }],
    ["sats", { ref: "A" }],
    ["sats", { ref: "A", sats: 1, fiat: { amount: "1", currency: "CHF" } }],
    ["sats", { ref: "A", sats: 0 }],
    ["sats", { ref: "A", sats: -1n }],
    ["sats", { ref: "A", sats: 1.5 }],
    ["sats", { ref: "A", sats: "0x10" }],
    ["sats", { ref: "A", sats: "1e3" }],
    ["sats", { ref: "A", sats: true }],
    ["sats", { ref: "A", sats: Number.MAX_SAFE_INTEGER + 1 }],
    ["durationSeconds", { ref: "A", sats: 1, durationSeconds: 59 }],
    ["durationSeconds", { ref: "A", sats: 1, durationSeconds: 3601 }],
    ["durationSeconds", { ref: "A", sats: 1, durationSeconds: 90.5 }],
    ["durationSeconds", { ref: "A", sats: 1, durationSeconds: "900" }],
    ["durationSeconds", { ref: "A", sats: 1, durationSeconds: null }],
    ["note", { ref: "A", sats: 1, note: "n".repeat(101) }],
    ["note", { ref: "A", sats: 1, note: "line\nbreak" }],
    ["note", { ref: "A", sats: 1, note: 5 }],
    ["fiat", { ref: "A", fiat: { amount: 24.5, currency: "CHF" } }],
    ["fiat", { ref: "A", fiat: { amount: "24.50", currency: "SAT" } }],
    ["rateSource", { ref: "A", sats: 1, rateSource: async () => "1" }],
    ["rateSource", { ref: "A", sats: 1, rateSource: "kraken" }],
    ["rateSource", { ref: "A", fiat: { amount: "1", currency: "CHF" }, rateSource: "bitstamp" }],
    ["rateSource", { ref: "A", fiat: { amount: "1", currency: "CHF" }, rateSource: [] }],
    ["rateSource", { ref: "A", fiat: { amount: "1", currency: "CHF" }, rateSource: null }],
    [
      "rateSource",
      { ref: "A", fiat: { amount: "1", currency: "CHF" }, rateSource: ["kraken", "kraken"] }
    ],
    ["rateSource", { ref: "A", sats: 1, rateSource: ["kraken", "coingecko"] }]
  ];

  it.each(invalid)("refuses an invalid %s before any request", async (param, order) => {
    const error: unknown = await client()
      .createInvoice(order as Order)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOrderError);
    expect((error as InvalidOrderError).param).toBe(param);
    expect(merchant.invoices.size).toBe(0);
    expect(declarations()).toHaveLength(0);
  });

  it("accepts the edges: 64 characters, 100 for the note, 60 and 3600 seconds", async () => {
    const ref = `${"A".repeat(60)}.:_-`;
    await client().createInvoice({ ref, sats: 1, note: "é".repeat(100), durationSeconds: 60 });
    expect(declarations()).toHaveLength(3);
  });

  it("keeps an amount within the Lightning address's bounds, rounded inwards", async () => {
    merchant.pay = { ...merchant.pay, minSendable: 10_001, maxSendable: 1_000_999 };
    const sattleme = client();
    expect(await sattleme.merchant()).toMatchObject({ minSats: "11", maxSats: "1000" });
    const below = await sattleme.createInvoice({ ref: "B-10", sats: 10n }).catch((e: unknown) => e);
    expect(below).toBeInstanceOf(InvalidOrderError);
    expect((below as InvalidOrderError).param).toBe("sats");
    // From 1 000 sats on, on-chain only: no address without a lot.
    const above = await sattleme
      .createInvoice({ ref: "B-1001", sats: 1001n })
      .catch((e: unknown) => e);
    expect(above).toBeInstanceOf(OnchainUnavailableError);
    expect((above as OnchainUnavailableError).retryable).toBe(true);
    await sattleme.createInvoice({ ref: "B-11", sats: 11n });
    await sattleme.createInvoice({ ref: "B-1000", sats: 1000n });
    expect(merchant.invoices.size).toBe(2);
  });

  const tampered: [
    string,
    (made: { pr: string; paymentHash: string; amountMsat: bigint }) => object
  ][] = [
    [
      "an invoice of another network",
      (m) => ({
        pr: makeInvoice({
          network: "tb",
          amountMsat: m.amountMsat,
          paymentHash: m.paymentHash,
          descriptionHash: metadataHash(METADATA),
          timestamp: merchant.now,
          expirySeconds: 900
        })
      })
    ],
    [
      "another amount",
      (m) => ({
        pr: makeInvoice({
          amountMsat: m.amountMsat - 1000n,
          paymentHash: m.paymentHash,
          descriptionHash: metadataHash(METADATA),
          timestamp: merchant.now,
          expirySeconds: 900
        })
      })
    ],
    [
      "no amount",
      (m) => ({
        pr: makeInvoice({
          paymentHash: m.paymentHash,
          descriptionHash: metadataHash(METADATA),
          timestamp: merchant.now,
          expirySeconds: 900
        })
      })
    ],
    [
      "another merchant's invoice",
      (m) => ({
        pr: makeInvoice({
          amountMsat: m.amountMsat,
          paymentHash: m.paymentHash,
          descriptionHash: metadataHash("[]"),
          timestamp: merchant.now,
          expirySeconds: 900
        })
      })
    ],
    [
      "a longer expiry",
      (m) => ({
        pr: makeInvoice({
          amountMsat: m.amountMsat,
          paymentHash: m.paymentHash,
          descriptionHash: metadataHash(METADATA),
          timestamp: merchant.now,
          expirySeconds: 901
        })
      })
    ],
    [
      "no expiry (3600 s)",
      (m) => ({
        pr: makeInvoice({
          amountMsat: m.amountMsat,
          paymentHash: m.paymentHash,
          descriptionHash: metadataHash(METADATA),
          timestamp: merchant.now
        })
      })
    ],
    [
      "a date 5 minutes off",
      (m) => ({
        pr: makeInvoice({
          amountMsat: m.amountMsat,
          paymentHash: m.paymentHash,
          descriptionHash: metadataHash(METADATA),
          timestamp: merchant.now - 301,
          expirySeconds: 900
        })
      })
    ],
    [
      "a date in the future",
      (m) => ({
        pr: makeInvoice({
          amountMsat: m.amountMsat,
          paymentHash: m.paymentHash,
          descriptionHash: metadataHash(METADATA),
          timestamp: merchant.now + 301,
          expirySeconds: 900
        })
      })
    ],
    [
      "a verify URL in http",
      (m) => ({ verify: `http://breez.tips/lnurlp/verify/${m.paymentHash}` })
    ],
    [
      "a verify URL on another host",
      (m) => ({ verify: `https://evil.test/verify/${m.paymentHash}` })
    ],
    ["not an invoice", () => ({ pr: "lnbc1nope" })]
  ];

  it.each(tampered)("refuses %s, and declares nothing", async (_, tamper) => {
    merchant.tamper = tamper;
    await expect(client().createInvoice({ ref: "C-1", sats: 1000 })).rejects.toBeInstanceOf(
      InvalidInvoiceError
    );
    expect(declarations()).toHaveLength(0);
  });

  it("refuses an invoice dated within 5 minutes but already over", async () => {
    merchant.tamper = (m) => ({
      pr: makeInvoice({
        amountMsat: m.amountMsat,
        paymentHash: m.paymentHash,
        descriptionHash: metadataHash(METADATA),
        timestamp: merchant.now - 200,
        expirySeconds: 60
      })
    });
    await expect(
      client().createInvoice({ ref: "C-3", sats: 1000, durationSeconds: 60 })
    ).rejects.toBeInstanceOf(InvalidInvoiceError);
    expect(declarations()).toHaveLength(0);
  });

  it("refuses a valid invoice too large to be declared, as an InvalidInvoiceError", async () => {
    // 70 unknown fields of 1023 words: some 72 000 characters, more than a NIP-44 plaintext holds.
    merchant.tamper = (m) => ({
      pr: makeInvoice({
        amountMsat: m.amountMsat,
        paymentHash: m.paymentHash,
        descriptionHash: metadataHash(METADATA),
        timestamp: merchant.now,
        expirySeconds: 900,
        extra: Array.from({ length: 70 }, () => [31, new Array<number>(1023).fill(0)])
      })
    });
    const error = await client()
      .createInvoice({ ref: "C-4", sats: 1000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidInvoiceError);
    expect((error as InvalidInvoiceError).message).toMatch(/too large to be declared/);
    expect(declarations()).toHaveLength(0);
  });

  it("accepts an invoice dated within 5 minutes", async () => {
    merchant.tamper = (m) => ({
      pr: makeInvoice({
        amountMsat: m.amountMsat,
        paymentHash: m.paymentHash,
        descriptionHash: metadataHash(METADATA),
        timestamp: merchant.now - 300,
        expirySeconds: 899
      })
    });
    const invoice = await client().createInvoice({ ref: "C-2", sats: 1000 });
    expect(invoice.expiresAt).toBe(merchant.now - 300 + 899);
  });

  it("refuses an answer without an invoice, or the service's refusal", async () => {
    merchant.override = (url) =>
      url.pathname.endsWith("/invoice") ? answer({ verify: "https://breez.tips/v" }) : undefined;
    await expect(client().createInvoice({ ref: "D-1", sats: 1 })).rejects.toBeInstanceOf(
      InvalidInvoiceError
    );
    merchant.override = (url) =>
      url.pathname.endsWith("/invoice")
        ? answer({ status: "ERROR", reason: "Amount out of range" }, 400)
        : undefined;
    await expect(client().createInvoice({ ref: "D-2", sats: 1 })).rejects.toBeInstanceOf(
      NetworkError
    );
    merchant.override = (url) => (url.pathname.endsWith("/invoice") ? answer({}, 502) : undefined);
    await expect(client().createInvoice({ ref: "D-3", sats: 1 })).rejects.toBeInstanceOf(
      NetworkError
    );
    expect(declarations()).toHaveLength(0);
  });

  it("gives the invoice once a majority of the relays took its declaration", async () => {
    merchant.net.get("wss://relay-a.test").behaviour = { refuse: "blocked: no" };
    await client().createInvoice({ ref: "E-1", sats: 1 });
  });

  it("gives no invoice without a majority: refusals, an unreachable relay", async () => {
    merchant.net.get("wss://relay-a.test").behaviour = { refuse: "blocked: no" };
    merchant.net.get("wss://relay-b.test").behaviour = { refuse: "error: internal error" };
    await expect(client().createInvoice({ ref: "E-2", sats: 1 })).rejects.toBeInstanceOf(
      NetworkError
    );
    merchant.net.get("wss://relay-b.test").behaviour = {};
    await merchant.net.remove("wss://relay-c.test");
    await expect(client().createInvoice({ ref: "E-3", sats: 1 })).rejects.toBeInstanceOf(
      NetworkError
    );
  });

  it("authenticates to a relay as the order's sale (NIP-42)", async () => {
    merchant.net.get("wss://relay-a.test").behaviour = { requireAuth: true };
    merchant.net.get("wss://relay-b.test").behaviour = { requireAuth: true };
    await client().createInvoice({ ref: "E-4", sats: 1 });
    const sale = saleKeys(merchant.integrationKey, "E-4").author;
    expect(merchant.net.get("wss://relay-b.test").authenticated).toContain(sale);
    expect(
      merchant.net
        .get("wss://relay-b.test")
        .events.filter((event) => (event as { pubkey: string }).pubkey === sale)
    ).toHaveLength(1);
  });

  it("declares on the account's relays the channel names", async () => {
    await merchant.stop();
    merchant = await new TestMerchant().start(["wss://account-a.test", "wss://account-b.test"]);
    merchant.publishChannel(
      merchant.channelValue(100, { relays: ["wss://account-a.test", "wss://account-b.test"] }),
      100,
      [...merchant.keyRelays, "wss://account-a.test", "wss://account-b.test"]
    );
    await client().createInvoice({ ref: "E-5", sats: 1 });
    expect(merchant.net.get("wss://account-b.test").events).toHaveLength(2);
    expect(merchant.net.get("wss://relay-a.test").received).toHaveLength(0);
  });

  it("refuses once the merchant removed the integration", async () => {
    merchant.publishChannel({ version: 1, status: "removed", updatedAt: 200 }, 200);
    await expect(client().createInvoice({ ref: "F-1", sats: 1 })).rejects.toBeInstanceOf(
      RevokedError
    );
    expect(merchant.http.calls).toHaveLength(0);
  });

  it("converts a price in a currency at its rate, and declares the price", async () => {
    const sattleme = client({ rateSource: async () => "69012" });
    const invoice = await sattleme.createInvoice({
      ref: "G-1",
      fiat: { amount: "24.50", currency: "CHF" },
      note: "Order 1042"
    });
    expect(invoice).toMatchObject({
      sats: "35502",
      fiat: { amount: "24.50", currency: "CHF", minor: "2450", digits: 2 },
      rate: { source: "custom", currency: "CHF", price: "69012", fetchedAt: merchant.now }
    });
    expect([...merchant.invoices.values()][0]!.amountMsat).toBe(35_502_000n);
    expect(
      openAsOwner(declarations()[0]!, merchant.registryKey, merchant.readerSecret)
    ).toMatchObject({ sale: { fiat: { minor: 2450, digits: 2, currency: "CHF" } } });
    // Another source for one invoice.
    const other = await sattleme.createInvoice({
      ref: "G-2",
      fiat: { amount: "1500", currency: "JPY" },
      rateSource: async () => "15000000"
    });
    expect(other).toMatchObject({ sats: "10000", rate: { source: "custom", price: "15000000" } });
  });

  it("refuses a converted amount outside the bounds", async () => {
    merchant.pay = { ...merchant.pay, minSendable: 100_000 };
    const sattleme = client({ rateSource: async () => "100000" });
    const error = await sattleme
      .createInvoice({ ref: "G-3", fiat: { amount: "0.05", currency: "CHF" } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOrderError);
    expect((error as InvalidOrderError).param).toBe("fiat");
  });
});

describe("one order, one invoice at a time", () => {
  it("refuses a second invoice while the first may be paid, then allows one", async () => {
    const sattleme = client();
    const first = await sattleme.createInvoice({ ref: "H-1", sats: 1, durationSeconds: 60 });
    const pending = await sattleme.createInvoice({ ref: "H-1", sats: 1 }).catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(InvoicePendingError);
    expect((pending as InvoicePendingError).invoice).toMatchObject({
      bolt11: first.bolt11,
      expiresAt: first.expiresAt,
      sats: "1",
      fiat: null,
      note: "H-1"
    });
    // Its end, then the 120 s a late payment may still be reported in.
    merchant.now = first.expiresAt + 119;
    await expect(sattleme.createInvoice({ ref: "H-1", sats: 1 })).rejects.toBeInstanceOf(
      InvoicePendingError
    );
    merchant.now = first.expiresAt + 120;
    const second = await sattleme.createInvoice({ ref: "H-1", sats: 1 });
    expect(second.bolt11).not.toBe(first.bolt11);
    // Another order is another sale.
    await sattleme.createInvoice({ ref: "H-2", sats: 1 });
  });

  it("refuses a new invoice for an order already paid", async () => {
    const sattleme = client();
    const first = await sattleme.createInvoice({ ref: "H-3", sats: 1, durationSeconds: 60 });
    merchant.payInvoice(first.paymentHash!);
    merchant.now = first.expiresAt + 600;
    const error = await sattleme.createInvoice({ ref: "H-3", sats: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderPaidError);
    expect((error as OrderPaidError).preimage).toBe(
      merchant.invoices.get(first.paymentHash!)!.preimage
    );
  });

  it("refuses a new invoice for an order paid while its invoice may still be paid, never handing it out again", async () => {
    const sattleme = client();
    const first = await sattleme.createInvoice({ ref: "H-4", sats: 1, checkout: false });
    merchant.payInvoice(first.paymentHash!);
    // Within its time: its payment checked even alone (SPEC.md §21, step 1).
    const error = await sattleme.createInvoice({ ref: "H-4", sats: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderPaidError);
    expect((error as OrderPaidError).invoice.bolt11).toBe(first.bolt11);
    expect((error as OrderPaidError).status).toEqual({
      state: "paid",
      method: "lightning",
      preimage: merchant.invoices.get(first.paymentHash!)!.preimage
    });
  });

  it("gives the error of the payment check of the only invoice that may still be paid", async () => {
    const sattleme = client();
    const first = await sattleme.createInvoice({ ref: "H-5", sats: 1 });
    // Its Lightning address does not answer: it may have been paid.
    merchant.override = (url) =>
      url.href.startsWith("https://breez.tips/lnurlp/verify/") ? { status: 503 } : undefined;
    const error = await sattleme.createInvoice({ ref: "H-5", sats: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    merchant.override = null;
    const pending = await sattleme.createInvoice({ ref: "H-5", sats: 1 }).catch((e: unknown) => e);
    expect((pending as InvoicePendingError).invoice.bolt11).toBe(first.bolt11);
  });

  it("declares a pending invoice on a majority again before handing it out", async () => {
    const sattleme = client();
    merchant.net.get("wss://relay-a.test").behaviour = { refuse: "blocked: no" };
    merchant.net.get("wss://relay-b.test").behaviour = { refuse: "blocked: no" };
    await expect(sattleme.createInvoice({ ref: "H-7", sats: 1 })).rejects.toBeInstanceOf(
      NetworkError
    );
    const [made] = [...merchant.invoices.values()];
    // Only relay-c holds its declaration. relay-a answers reads late: relay-b and relay-c are the
    // majority read, and the declaration found is not handed out while the others refuse it.
    merchant.net.get("wss://relay-a.test").behaviour = { refuse: "blocked: no", queryDelayMs: 300 };
    await expect(sattleme.createInvoice({ ref: "H-7", sats: 1 })).rejects.toBeInstanceOf(
      NetworkError
    );
    // Now a majority takes it again: then, and only then, it is handed out.
    merchant.net.get("wss://relay-a.test").behaviour = { queryDelayMs: 300 };
    merchant.net.get("wss://relay-b.test").behaviour = {};
    const pending = await sattleme.createInvoice({ ref: "H-7", sats: 1 }).catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(InvoicePendingError);
    expect((pending as InvoicePendingError).invoice.bolt11).toBe(made!.pr);
    const sale = saleKeys(merchant.integrationKey, "H-7").author;
    for (const url of merchant.keyRelays) {
      expect(
        merchant.net.get(url).events.filter((e) => (e as { pubkey?: string }).pubkey === sale)
      ).toHaveLength(1);
    }
    expect(merchant.invoices.size).toBe(1);
  });

  it("may make another invoice when the majority read lacks one never handed out", async () => {
    const sattleme = client();
    merchant.net.get("wss://relay-a.test").behaviour = { refuse: "blocked: no" };
    merchant.net.get("wss://relay-b.test").behaviour = { refuse: "blocked: no" };
    // Declared on relay-c alone: "do not show this invoice".
    await expect(sattleme.createInvoice({ ref: "H-10", sats: 1 })).rejects.toBeInstanceOf(
      NetworkError
    );
    // relay-a and relay-b answer first, without it: a new invoice, declared on a majority.
    merchant.net.get("wss://relay-a.test").behaviour = {};
    merchant.net.get("wss://relay-b.test").behaviour = {};
    merchant.net.get("wss://relay-c.test").behaviour = { queryDelayMs: 300 };
    const second = await sattleme.createInvoice({ ref: "H-10", sats: 1 });
    expect(merchant.invoices.size).toBe(2);
    expect(second.bolt11).toBe([...merchant.invoices.values()][1]!.pr);
  });

  it("refuses a new invoice for a paid order even when another check gets no answer", async () => {
    const sattleme = client();
    const first = await sattleme.createInvoice({ ref: "H-8", sats: 1, durationSeconds: 60 });
    merchant.now = first.expiresAt + 120;
    const second = await sattleme.createInvoice({ ref: "H-8", sats: 1, durationSeconds: 60 });
    merchant.payInvoice(second.paymentHash!);
    merchant.now = second.expiresAt + 600;
    merchant.override = (url) =>
      url.pathname.endsWith(first.paymentHash!) ? answer({}, 502) : undefined;
    const error = await sattleme.createInvoice({ ref: "H-8", sats: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderPaidError);
    expect((error as OrderPaidError).invoice.bolt11).toBe(second.bolt11);
    // Unpaid, one check without an answer: retry later.
    const other = await sattleme.createInvoice({ ref: "H-9", sats: 1, durationSeconds: 60 });
    merchant.now = other.expiresAt + 120;
    merchant.override = (url) =>
      url.pathname.endsWith(other.paymentHash!) ? answer({}, 502) : undefined;
    await expect(sattleme.createInvoice({ ref: "H-9", sats: 1 })).rejects.toBeInstanceOf(
      NetworkError
    );
  });

  it("makes one invoice when two calls for one order race", async () => {
    const sattleme = client();
    const results = await Promise.allSettled([
      sattleme.createInvoice({ ref: "H-4", sats: 1 }),
      sattleme.createInvoice({ ref: "H-4", sats: 1 })
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(merchant.invoices.size).toBe(1);
  });

  it("finds the invoices declared for an order, and needs a majority to", async () => {
    const sattleme = client({ rateSource: async () => "69012" });
    const first = await sattleme.createInvoice({
      ref: "H-5",
      fiat: { amount: "24.50", currency: "CHF" },
      durationSeconds: 60
    });
    merchant.now = first.expiresAt + 120;
    const second = await sattleme.createInvoice({ ref: "H-5", sats: 7 });
    const found = await sattleme.findInvoices("H-5");
    expect(found.map(({ bolt11 }) => bolt11)).toEqual([first.bolt11, second.bolt11]);
    expect(found[0]).toEqual({
      ref: "H-5",
      bolt11: first.bolt11,
      paymentHash: first.paymentHash,
      verifyUrl: first.verifyUrl,
      onchainAddress: null,
      paymentUri: `lightning:${first.bolt11}`,
      sats: "35502",
      fiat: { amount: "24.50", currency: "CHF", minor: "2450", digits: 2 },
      note: "H-5",
      createdAt: first.createdAt,
      expiresAt: first.expiresAt,
      declaredAt: first.createdAt
    });
    expect(found[1]).toMatchObject({ sats: "7", fiat: null });
    expect(await sattleme.findInvoices("H-6")).toEqual([]);
    await merchant.net.remove("wss://relay-a.test");
    await merchant.net.remove("wss://relay-b.test");
    await expect(sattleme.findInvoices("H-5")).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("relays: one connection each per call, a majority waited for", () => {
  it("makes an invoice over one connection per relay, earlier invoices read included", async () => {
    const sattleme = client();
    const first = await sattleme.createInvoice({ ref: "R-1", sats: 1, durationSeconds: 60 });
    expect(Object.fromEntries(merchant.net.connections)).toEqual({
      "wss://relay-a.test": 1,
      "wss://relay-b.test": 1,
      "wss://relay-c.test": 1
    });
    merchant.now = first.expiresAt + 120;
    // The channel, the order's declarations page after page, the new declaration: one connection.
    await sattleme.createInvoice({ ref: "R-1", sats: 1, durationSeconds: 60 });
    expect(Object.fromEntries(merchant.net.connections)).toEqual({
      "wss://relay-a.test": 2,
      "wss://relay-b.test": 2,
      "wss://relay-c.test": 2
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const url of merchant.keyRelays) {
      const relay = merchant.net.get(url);
      // Every subscription closed once read, and every connection once the call is done.
      expect(relay.closedSubscriptions.length).toBeGreaterThan(0);
      expect(relay.server.clients.size).toBe(0);
    }
  });

  it.each(["mute", "blackhole"])(
    "is not slowed by a relay that never answers (%s)",
    async (kind) => {
      if (kind === "mute") {
        merchant.net.get("wss://relay-c.test").behaviour = { mute: true };
      } else {
        await merchant.net.remove("wss://relay-c.test");
        await merchant.net.addBlackhole("wss://relay-c.test");
      }
      const sattleme = client({ relayTimeoutMs: 5000 });
      const started = Date.now();
      await sattleme.createInvoice({ ref: "R-2", sats: 1 });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(await sattleme.findInvoices("R-2")).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(3000);
    }
  );

  it("stops when its signal aborts, and closes its connections", async () => {
    for (const url of merchant.keyRelays) merchant.net.get(url).behaviour = { queryDelayMs: 2000 };
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("checkout left")), 100);
    const started = Date.now();
    await expect(
      client({ relayTimeoutMs: 5000 }).createInvoice(
        { ref: "R-3", sats: 1 },
        { signal: controller.signal }
      )
    ).rejects.toThrow("checkout left");
    expect(Date.now() - started).toBeLessThan(1000);
    // The relays see each connection close a moment later (a busy machine: up to a second).
    const open = () =>
      merchant.keyRelays.reduce((sum, url) => sum + merchant.net.get(url).server.clients.size, 0);
    for (let i = 0; i < 100 && open() > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const url of merchant.keyRelays) {
      expect(merchant.net.get(url).server.clients.size).toBe(0);
    }
    expect(merchant.invoices.size).toBe(0);
  });
});

describe("rates by name", () => {
  it("takes a source by its name, CoinGecko with its Demo key", async () => {
    merchant.override = (url) =>
      url.hostname === "api.coingecko.com"
        ? answer({ bitcoin: { chf: 69012, last_updated_at: merchant.now - 30 } })
        : url.hostname === "api.kraken.com"
          ? answer({ error: [], result: { XBTCHF: { c: ["70000.0", "0.1"] } } })
          : undefined;
    const sattleme = client({ rateSource: "coingecko", coingeckoApiKey: "demo-key" });
    const invoice = await sattleme.createInvoice({
      ref: "S-1",
      fiat: { amount: "24.50", currency: "CHF" }
    });
    expect(invoice).toMatchObject({ sats: "35502", rate: { source: "coingecko", price: "69012" } });
    const call = merchant.http.calls.find(({ url }) => url.hostname === "api.coingecko.com")!;
    expect(call.headers["x-cg-demo-api-key"]).toBe("demo-key");
    const other = await sattleme.createInvoice({
      ref: "S-2",
      fiat: { amount: "7", currency: "CHF" },
      rateSource: "kraken"
    });
    expect(other.rate).toMatchObject({ source: "kraken", price: "70000" });
  });

  it("refuses an unknown source when the client is made", () => {
    for (const rateSource of ["bitstamp", [], ["kraken", "kraken"], ["kraken", "bitstamp"], null]) {
      expect(() => client({ rateSource: rateSource as never })).toThrow(InvalidOptionError);
    }
    expect(() => client({ coingeckoApiKey: 5 as never })).toThrow(InvalidOptionError);
  });

  it("without rateSource, asks the default list in order until one gives a price", async () => {
    merchant.override = (url) =>
      url.hostname === "api.coingecko.com"
        ? answer({ status: { error_code: 429 } }, 429)
        : url.hostname === "mempool.space"
          ? answer({ time: merchant.now - 10, CHF: 69012 })
          : undefined;
    const warnings: string[] = [];
    const sattleme = client({ logger: { warn: (message: string) => warnings.push(message) } });
    const invoice = await sattleme.createInvoice({
      ref: "D-1",
      fiat: { amount: "24.50", currency: "CHF" }
    });
    expect(invoice).toMatchObject({ sats: "35502", rate: { source: "mempool", price: "69012" } });
    const asked = merchant.http.calls
      .map(({ url }) => url.hostname)
      .filter((host) => !host.endsWith("breez.tips"));
    expect(asked).toEqual(["api.coingecko.com", "mempool.space"]);
    // No key given: CoinGecko is asked without one.
    const call = merchant.http.calls.find(({ url }) => url.hostname === "api.coingecko.com")!;
    expect(call.headers["x-cg-demo-api-key"]).toBeUndefined();
    expect(warnings).toEqual([
      "Rate source coingecko failed (network): coingecko answered HTTP 429; trying mempool"
    ]);
  });

  it("asks an order's list, in its order, and only that list", async () => {
    merchant.override = (url) =>
      url.hostname === "api.kraken.com"
        ? answer({ error: ["EQuery:Unknown asset pair"] })
        : url.hostname === "api.coinbase.com"
          ? answer({ data: { currency: "BTC", rates: { CHF: "69012.00" } } })
          : undefined;
    const sattleme = client({ rateSource: "coingecko" });
    const invoice = await sattleme.createInvoice({
      ref: "D-2",
      fiat: { amount: "24.50", currency: "CHF" },
      rateSource: ["kraken", "coinbase"]
    });
    expect(invoice.rate).toMatchObject({ source: "coinbase", price: "69012" });
    const hosts = merchant.http.calls.map(({ url }) => url.hostname);
    expect(hosts).toContain("api.kraken.com");
    expect(hosts).not.toContain("api.coingecko.com");
  });

  it("gives the last network or rate error when no source of the list has a price", async () => {
    merchant.override = (url) =>
      url.hostname === "api.kraken.com"
        ? answer({ error: ["EQuery:Unknown asset pair"] })
        : url.hostname === "api.coinbase.com"
          ? answer({}, 503)
          : undefined;
    const sattleme = client();
    const order = { fiat: { amount: "1", currency: "CHF" } };
    await expect(
      sattleme.createInvoice({ ref: "D-3", ...order, rateSource: ["coinbase", "kraken"] })
    ).rejects.toBeInstanceOf(NetworkError);
    // Only sources without the currency: unsupported_currency, naming them.
    const error: unknown = await sattleme
      .createInvoice({
        ref: "D-4",
        ...order,
        rateSource: ["kraken", "mempool"],
        fiat: { amount: "1", currency: "THB" }
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedCurrencyError);
    expect((error as Error).message).toBe("None of kraken, mempool has a price in THB");
    expect(merchant.invoices.size).toBe(0);
  });

  it("puts an order's pending invoice before a failing rate source", async () => {
    const sattleme = client({ rateSource: async () => "69012" });
    await sattleme.createInvoice({ ref: "S-3", fiat: { amount: "1", currency: "CHF" } });
    const failing = client({
      rateSource: async () => {
        throw new NetworkError("down");
      }
    });
    await expect(
      failing.createInvoice({ ref: "S-3", fiat: { amount: "1", currency: "CHF" } })
    ).rejects.toBeInstanceOf(InvoicePendingError);
    await expect(
      failing.createInvoice({ ref: "S-4", fiat: { amount: "1", currency: "CHF" } })
    ).rejects.toBeInstanceOf(NetworkError);
    expect(merchant.invoices.size).toBe(1);
  });
});
