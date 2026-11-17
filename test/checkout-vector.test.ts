import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";

import { checkoutKeys, parseCheckoutFragment, parseCheckoutValue } from "../src/checkout.js";
import { Sattleme } from "../src/index.js";
import type { NostrEvent } from "../src/nostr/event.js";
import { nip44Decrypt } from "../src/nostr/nip44.js";
import type { RandomBytes } from "../src/random.js";

import { TestMerchant } from "./helpers/merchant.js";
import { SPEC_DIR, vectorsOut } from "./helpers/vectors.js";

/*
 * The package's half of the cross-check with the merchant's web app for checkout links: a link the
 * package makes, end to end (createInvoice with `checkout: true`), with fixed random bytes, is the
 * specification's vectors/app/checkout-link.json. The web app reads its URL, finds its keys, opens
 * its event and shows its record. `source` names no package: checkout-spec is independent of any
 * implementation.
 *
 * Written on purpose only, into a clone of checkout-spec:
 * UPDATE_VECTORS=1 VECTORS_OUT=<clone> npx vitest run test/checkout-vector.test.ts
 */

const FILE = "vectors/app/checkout-link.json";
const ORIGIN = "https://pay.example";
/** A price of one bitcoin in CHF. */
const PRICE = "98000";

/** Random bytes from a counter: the same link, byte for byte, at every run. */
function fixedRandom(): RandomBytes {
  let counter = 0;
  return (length) => {
    const out = new Uint8Array(length);
    for (let filled = 0; filled < length; filled += 32) {
      const block = sha256(
        concatBytes(utf8ToBytes("checkout-vector"), new Uint8Array([counter++]))
      );
      out.set(block.subarray(0, Math.min(32, length - filled)), filled);
    }
    return out;
  };
}

let merchant: TestMerchant;
afterEach(async () => {
  await merchant.stop();
});

async function makeVector() {
  merchant = new TestMerchant();
  merchant.keyRelays = ["wss://relay.example"];
  merchant.now = 1_791_382_000;
  // What the merchant's Lightning address answers (SPEC.md §16): its bounds, its metadata.
  merchant.pay = { ...merchant.pay, maxSendable: 1_000_000_000 };
  await merchant.start();
  merchant.publishChannel(
    merchant.channelValue(merchant.now - 60, { checkout: { origin: ORIGIN } }),
    merchant.now - 60
  );
  const order = {
    ref: "ORD-3001",
    fiat: { amount: "0.02", currency: "CHF" },
    note: "Order 3001",
    durationSeconds: 600,
    checkout: true,
    redirectUrl: "https://shop.example/orders/3001/thanks"
  };
  const sattleme = new Sattleme({
    key: merchant.key,
    fetch: merchant.http.fetch,
    WebSocket: merchant.net.WebSocket,
    now: () => merchant.now * 1000,
    random: fixedRandom(),
    logger: { warn: () => {} },
    rateSource: async () => PRICE
  });
  const invoice = await sattleme.createInvoice(order);
  const url = invoice.checkoutUrl!;
  const fragment = parseCheckoutFragment(url.slice(url.indexOf("#")));
  if (fragment.status !== "link") throw new Error("Not a checkout link");
  const keys = checkoutKeys(fragment.linkKey);
  const event = merchant.net
    .get("wss://relay.example")
    .received.find((received: NostrEvent) => received.pubkey === fragment.author)!;
  const { v: value } = JSON.parse(nip44Decrypt(event.content, keys.encryptionKey)) as {
    v: unknown;
  };
  return {
    vector: {
      source:
        "Made by an implementation of this specification (createInvoice with checkout: true, end to end) with fixed random bytes, for a channel whose checkout origin is https://pay.example. The sattle.me web app reads it: the fragment of `url`, the link's keys, the record of `event` and what it shows. `payRequest`: what the merchant's Lightning address answered (its `metadata` is the invoice's description hash); `price`: a price of one bitcoin in CHF that converts the order to its `sats` (SPEC.md §25).",
      order,
      payRequest: merchant.pay,
      price: PRICE,
      origin: ORIGIN,
      relays: merchant.keyRelays,
      businessName: "Sunrise Bakery",
      invoice: invoice.bolt11,
      verifyUrl: invoice.verifyUrl,
      paymentHash: invoice.paymentHash,
      sats: invoice.sats,
      expiresAt: invoice.expiresAt,
      linkKey: bytesToHex(fragment.linkKey),
      author: fragment.author,
      address: keys.address,
      encryptionKey: bytesToHex(keys.encryptionKey),
      value,
      event,
      url
    },
    record: parseCheckoutValue(value)
  };
}

describe("the checkout link the web app reads (vectors/app/checkout-link.json)", () => {
  it("is what the package makes, byte for byte", async () => {
    const { vector, record } = await makeVector();
    // 0.02 CHF at 98 000 CHF/BTC: ⌈2 × 10^8 / 9 800 000⌉ = ⌈20.4…⌉ = 21 sats.
    expect(vector.sats).toBe("21");
    expect(record).toMatchObject({ sats: 21n, redirectShown: "shop.example" });
    expect(vector.event.tags).toEqual([
      ["d", vector.address],
      ["expiration", String(vector.expiresAt + 604_800)]
    ]);
    const path = join(SPEC_DIR, FILE);
    const text = `${JSON.stringify(vector, null, 2)}\n`;
    const out = vectorsOut();
    if (out) writeFileSync(join(out, FILE), text);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(text));
  });
});
