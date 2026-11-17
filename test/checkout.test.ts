import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkoutKeys,
  checkoutUrl,
  parseCheckoutFragment,
  parseCheckoutValue,
  redirectShown
} from "../src/checkout.js";
import { saleKeys } from "../src/derive.js";
import {
  CheckoutUnavailableError,
  InvalidOrderError,
  InvoicePendingError,
  NetworkError,
  Sattleme,
  type Invoice,
  type SattlemeOptions
} from "../src/index.js";
import { isValidEvent, type NostrEvent } from "../src/nostr/event.js";
import { nip44Decrypt } from "../src/nostr/nip44.js";

import { TestMerchant } from "./helpers/merchant.js";
import { openAsOwner } from "./helpers/owner.js";

/*
 * Checkout links (SPEC.md, "Checkout links"): asked with the order, published on a majority of
 * the merchant's relays before the invoice is declared, read by the merchant's web app with what
 * its URL holds alone.
 */

const ORIGIN = "https://pay.example";
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
    rateSource: async () => "99000",
    ...options
  });
}

/** Every event the relays received, in the order the first relay received them. */
function received(): NostrEvent[] {
  return merchant.net.get(merchant.keyRelays[0]!).received;
}

const isCheckout = (event: NostrEvent) => event.tags.some(([name]) => name === "expiration");

/** The link of a checkout URL, read as the page reads it, with its record from the relays. */
function openLink(url: string) {
  expect(url.startsWith(`${ORIGIN}/pay#c.`)).toBe(true);
  const fragment = parseCheckoutFragment(url.slice(url.indexOf("#")));
  if (fragment.status !== "link") throw new Error(`Not a link: ${fragment.status}`);
  const keys = checkoutKeys(fragment.linkKey);
  const copies = fragment.relays.map((relay) =>
    merchant.net
      .get(relay)
      .events.find(
        (value) =>
          (value as NostrEvent).pubkey === fragment.author &&
          (value as NostrEvent).tags.some(([name, d]) => name === "d" && d === keys.address)
      )
  ) as NostrEvent[];
  const [event] = copies;
  if (!event) throw new Error("Not on the relays");
  expect(isValidEvent(event)).toBe(true);
  const { t, v } = JSON.parse(nip44Decrypt(event.content, keys.encryptionKey)) as {
    t: string;
    v: unknown;
  };
  expect(t).toBe("checkout");
  return { fragment, event, copies, value: v, record: parseCheckoutValue(v) };
}

beforeEach(async () => {
  merchant = await new TestMerchant().start();
  merchant.publishChannel(
    merchant.channelValue(100, { relays: merchant.keyRelays, checkout: { origin: ORIGIN } }),
    100
  );
});

afterEach(async () => {
  await merchant.stop();
});

describe("createInvoice with checkout", () => {
  it("publishes the link before the declaration, and gives its URL", async () => {
    const invoice = await client().createInvoice({
      ref: "ORD-1042",
      fiat: { amount: "24.50", currency: "CHF" },
      note: "Order 1042",
      checkout: true,
      redirectUrl: "https://shop.example/orders/1042/thanks"
    });
    const made = [...merchant.invoices.values()][0]!;
    expect(invoice.redirectUrl).toBe("https://shop.example/orders/1042/thanks");
    // JSON as is, with exactly the fields of SPEC.md "Data model": no secret of the link.
    expect(Object.keys(JSON.parse(JSON.stringify(invoice)) as Invoice).sort()).toEqual(
      [
        "ref",
        "bolt11",
        "paymentHash",
        "verifyUrl",
        "onchainAddress",
        "paymentUri",
        "sats",
        "fiat",
        "rate",
        "note",
        "createdAt",
        "expiresAt",
        "checkoutUrl",
        "redirectUrl"
      ].sort()
    );

    const { fragment, event, copies, value, record } = openLink(invoice.checkoutUrl!);
    // On every relay of the merchant, which the URL names.
    expect(fragment.relays).toEqual(merchant.keyRelays);
    expect(copies.every((copy) => copy?.id === event.id)).toBe(true);
    // The link first, then the declaration: a link never names an invoice its URL was not given for.
    const order = received().map((e) => (isCheckout(e) ? "link" : "declaration"));
    expect(order).toEqual(["link", "declaration"]);
    // Its own author, not the sale's; dropped by the relays a week after the invoice's end.
    expect(event.pubkey).not.toBe(saleKeys(merchant.integrationKey, "ORD-1042").author);
    expect(event.tags).toEqual([
      ["d", checkoutKeys(fragment.linkKey).address],
      ["expiration", String(invoice.expiresAt + 604_800)]
    ]);
    expect(event.created_at).toBe(merchant.now);
    expect(value).toEqual({
      version: 1,
      businessName: "Sunrise Bakery",
      invoice: made.pr,
      verifyUrl: made.verify,
      fiat: { minor: 2450, digits: 2, currency: "CHF" },
      note: "Order 1042",
      redirectUrl: "https://shop.example/orders/1042/thanks"
    });
    expect(record).toMatchObject({
      sats: BigInt(invoice.sats),
      redirectShown: "shop.example"
    });
  });

  it("writes an order in sats without a price, and without a redirect URL", async () => {
    const invoice = await client().createInvoice({ ref: "A-1", sats: 49_000n, checkout: true });
    expect(invoice.redirectUrl).toBeNull();
    const { value } = openLink(invoice.checkoutUrl!);
    expect(value).toMatchObject({ fiat: null, note: "A-1", redirectUrl: null });
  });

  it("authenticates the link's publication as its author", async () => {
    for (const relay of merchant.keyRelays)
      merchant.net.get(relay).behaviour = { requireAuth: true };
    const invoice = await client().createInvoice({ ref: "A-1", sats: 100, checkout: true });
    const { fragment } = openLink(invoice.checkoutUrl!);
    expect(merchant.net.get(merchant.keyRelays[0]!).authenticated).toContain(fragment.author);
  });

  it("gives a new link, with new keys, to each invoice", async () => {
    const first = await client().createInvoice({ ref: "A-1", sats: 100, checkout: true });
    const second = await client().createInvoice({ ref: "A-2", sats: 100, checkout: true });
    const a = openLink(first.checkoutUrl!).fragment;
    const b = openLink(second.checkoutUrl!).fragment;
    expect(a.author).not.toBe(b.author);
    expect(bytesToHex(a.linkKey)).not.toBe(bytesToHex(b.linkKey));
  });

  it("publishes nothing more without checkout", async () => {
    const invoice = await client().createInvoice({ ref: "A-1", sats: 100 });
    expect(invoice.checkoutUrl).toBeNull();
    expect(invoice.redirectUrl).toBeNull();
    expect(received().filter(isCheckout)).toHaveLength(0);
  });

  it("refuses checkout when the merchant's app gives no web app, before any invoice", async () => {
    const invalid = [undefined, null, "https://pay.example", { origin: "http://pay.example" }];
    for (const [index, checkout] of invalid.entries()) {
      merchant.publishChannel(
        merchant.channelValue(200 + index, { relays: merchant.keyRelays, checkout }),
        200 + index
      );
      await expect(
        client().createInvoice({ ref: `A-${index}`, sats: 100, checkout: true })
      ).rejects.toBeInstanceOf(CheckoutUnavailableError);
      // The channel stays valid: an invoice without checkout is made.
      await expect(client().createInvoice({ ref: `B-${index}`, sats: 100 })).resolves.toMatchObject(
        { checkoutUrl: null }
      );
    }
    const error = await client()
      .createInvoice({ ref: "C-1", sats: 100, checkout: true })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "checkout_unavailable", retryable: false });
    // Only the invoices made without checkout.
    expect(merchant.invoices.size).toBe(invalid.length);
  });

  const invalidOrders: [string, Record<string, unknown>][] = [
    ["checkout", { checkout: "yes" }],
    ["checkout", { checkout: 1 }],
    ["redirectUrl", { redirectUrl: "https://shop.example/thanks" }],
    ["redirectUrl", { checkout: false, redirectUrl: "https://shop.example/thanks" }],
    ["redirectUrl", { checkout: true, redirectUrl: "http://shop.example/thanks" }],
    ["redirectUrl", { checkout: true, redirectUrl: "javascript://alert(1)" }],
    ["redirectUrl", { checkout: true, redirectUrl: "https://user:pass@shop.example/" }],
    ["redirectUrl", { checkout: true, redirectUrl: 42 }],
    ["redirectUrl", { checkout: true, redirectUrl: "" }]
  ];
  it.each(invalidOrders)("refuses an invalid %s before any request", async (param, fields) => {
    const error = await client()
      .createInvoice({ ref: "A-1", sats: 100, ...fields })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOrderError);
    expect(error).toMatchObject({ param });
    expect(merchant.http.calls).toHaveLength(0);
  });

  it("takes a null redirect URL as none", async () => {
    const invoice = await client().createInvoice({
      ref: "A-1",
      sats: 100,
      checkout: true,
      redirectUrl: null
    });
    expect(invoice.redirectUrl).toBeNull();
  });

  it("declares nothing when fewer than a majority take the link", async () => {
    const refuseLinks = {
      refuseEvent: (e: NostrEvent) => (isCheckout(e) ? "blocked: no" : undefined)
    };
    merchant.net.get("wss://relay-a.test").behaviour = refuseLinks;
    merchant.net.get("wss://relay-b.test").behaviour = refuseLinks;
    await expect(
      client().createInvoice({ ref: "A-1", sats: 100, checkout: true })
    ).rejects.toBeInstanceOf(NetworkError);
    expect(received().filter((e) => !isCheckout(e))).toHaveLength(0);
    // The order gets a new invoice at once: nothing was declared.
    merchant.net.get("wss://relay-a.test").behaviour = {};
    merchant.net.get("wss://relay-b.test").behaviour = {};
    await expect(
      client().createInvoice({ ref: "A-1", sats: 100, checkout: true })
    ).resolves.toMatchObject({ ref: "A-1" });
    expect(merchant.invoices.size).toBe(2);
  });

  it("gives no URL when the declaration fails after the link", async () => {
    const refuseDeclarations = {
      refuseEvent: (e: NostrEvent) => (isCheckout(e) ? undefined : "blocked: no")
    };
    merchant.net.get("wss://relay-a.test").behaviour = refuseDeclarations;
    merchant.net.get("wss://relay-b.test").behaviour = refuseDeclarations;
    await expect(
      client().createInvoice({ ref: "A-1", sats: 100, checkout: true })
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("gives a new link to the pending invoice of an order, with this call's redirect URL", async () => {
    const first = await client().createInvoice({
      ref: "ORD-7",
      fiat: { amount: "0.02", currency: "CHF" },
      note: "Order 7",
      checkout: true,
      redirectUrl: "https://shop.example/7"
    });
    const error = await client()
      .createInvoice({
        ref: "ORD-7",
        fiat: { amount: "0.02", currency: "CHF" },
        checkout: true,
        redirectUrl: "myshop://orders/7"
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvoicePendingError);
    const pending = error as InvoicePendingError;
    expect(pending.invoice.bolt11).toBe(first.bolt11);
    expect(pending.checkoutUrl).not.toBeNull();
    expect(pending.checkoutUrl).not.toBe(first.checkoutUrl);
    const { value, record } = openLink(pending.checkoutUrl!);
    expect(value).toEqual({
      version: 1,
      businessName: "Sunrise Bakery",
      invoice: first.bolt11,
      verifyUrl: first.verifyUrl,
      fiat: { minor: 2, digits: 2, currency: "CHF" },
      note: "Order 7",
      redirectUrl: "myshop://orders/7"
    });
    expect(record?.redirectShown).toBe("myshop://");
    // Without checkout, no link.
    const plain = await client()
      .createInvoice({ ref: "ORD-7", fiat: { amount: "0.02", currency: "CHF" } })
      .catch((e: unknown) => e);
    expect(plain).toMatchObject({ code: "invoice_pending", checkoutUrl: null });
  });

  it("keeps the declaration as it was: no redirect URL in the registry", async () => {
    await client().createInvoice({
      ref: "A-1",
      sats: 100,
      checkout: true,
      redirectUrl: "https://shop.example/thanks"
    });
    const declaration = received().find((e) => !isCheckout(e))!;
    expect(
      Object.keys(openAsOwner(declaration, merchant.registryKey, merchant.readerSecret)).sort()
    ).toEqual(["invoice", "sale", "taker", "verifyUrl", "version"]);
  });
});

describe("a link's parts", () => {
  it("reads a link's fragment back, and only the fragments of checkout links", () => {
    const author = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(7)));
    const linkKey = new Uint8Array(32).fill(8);
    const url = checkoutUrl(ORIGIN, author, linkKey, ["wss://relay.example", "wss://nos.lol"]);
    expect(parseCheckoutFragment(url.slice(url.indexOf("#")))).toEqual({
      status: "link",
      author,
      linkKey,
      relays: ["wss://relay.example", "wss://nos.lol"]
    });
    expect(parseCheckoutFragment("#d.a.b.c")).toEqual({ status: "newer" });
    expect(parseCheckoutFragment("c2.a.b.c")).toEqual({ status: "newer" });
    expect(parseCheckoutFragment("c.a.b")).toEqual({ status: "invalid" });
    // A payment link of the point of sale: its author first, 43 characters.
    expect(parseCheckoutFragment(`${"A".repeat(43)}.${"B".repeat(43)}`)).toEqual({
      status: "other"
    });
  });

  it("shows the host of an https URL and the scheme of an app's link", () => {
    expect(redirectShown("https://shop.example:8443/a?b#c")).toBe("shop.example:8443");
    expect(redirectShown("myshop://orders/42")).toBe("myshop://");
    expect(redirectShown("https://shop.example\\@evil.example")).toBeNull();
  });
});
