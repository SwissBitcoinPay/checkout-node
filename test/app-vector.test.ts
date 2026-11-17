import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";

import { saleKeys, takerKey, takerTag } from "../src/derive.js";
import { Sattleme } from "../src/index.js";
import { parseIntegrationKey } from "../src/key.js";
import type { RandomBytes } from "../src/random.js";

import { makeInvoice, metadataHash } from "./helpers/lightning.js";
import { METADATA, TestMerchant } from "./helpers/merchant.js";
import { SPEC_DIR, appVectors, vectorsOut } from "./helpers/vectors.js";

/*
 * The package's half of the cross-check with the merchant's app: a declaration the package makes,
 * end to end (createInvoice), with the app's integration key and registry (vectors/app/app.json)
 * and fixed random bytes, is the specification's vectors/app/implementation-declaration.json. The
 * app reads it as the owner (the sale, its price, its note, "By": the integration) and as
 * another sale claiming the same payment (a conflict). Either side changing breaks one of the two
 * suites. `source` names no package: checkout-spec is independent of any implementation.
 *
 * Written on purpose only, into a clone of checkout-spec:
 * UPDATE_VECTORS=1 VECTORS_OUT=<clone> npx vitest run test/app-vector.test.ts
 */

const FILE = "vectors/app/implementation-declaration.json";

/** Random bytes from a counter: the same declaration, byte for byte, at every run. */
function fixedRandom(): RandomBytes {
  let counter = 0;
  return (length) => {
    const out = new Uint8Array(length);
    for (let filled = 0; filled < length; filled += 32) {
      const block = sha256(concatBytes(utf8ToBytes("app-vector"), new Uint8Array([counter++])));
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
  merchant.keyRelays = appVectors.parsed.relays;
  merchant.now = 1_791_380_000;
  await merchant.start();
  merchant.net.get("wss://relay.example").store(appVectors.channel.event);
  // breez.tips makes an invoice of the same payment as the app's declaration of ORD-1042: the
  // app reads them as two sales claiming one payment.
  merchant.tamper = (made) => ({
    pr: makeInvoice({
      amountMsat: made.amountMsat,
      paymentHash: appVectors.declaration.paymentHash,
      descriptionHash: metadataHash(METADATA),
      timestamp: merchant.now,
      expirySeconds: made.expiry
    }),
    paymentHash: appVectors.declaration.paymentHash,
    verify: `https://breez.tips/lnurlp/verify/${appVectors.declaration.paymentHash}`
  });
  const sattleme = new Sattleme({
    key: appVectors.secretKey,
    fetch: merchant.http.fetch,
    WebSocket: merchant.net.WebSocket,
    now: () => merchant.now * 1000,
    random: fixedRandom(),
    logger: { warn: () => {} },
    rateSource: async () => "99000"
  });
  const invoice = await sattleme.createInvoice({
    ref: "ORD-2001",
    fiat: { amount: "0.02", currency: "CHF" },
    note: "Order 2001",
    durationSeconds: 600
  });
  const [event] = merchant.net.get("wss://relay.example").received;
  const key = parseIntegrationKey(appVectors.secretKey).key;
  const sale = saleKeys(key, "ORD-2001");
  return {
    source:
      "Made by an implementation of this specification (createInvoice, end to end) with the integration key and the registry of app.json and fixed random bytes. The sattle.me app reads it as the owner of the sale ORD-2001, and as a second sale claiming the payment of app.json's declaration.",
    ref: "ORD-2001",
    note: "Order 2001",
    fiat: { minor: 2, digits: 2, currency: "CHF" },
    sats: invoice.sats,
    invoice: invoice.bolt11,
    paymentHash: invoice.paymentHash,
    verifyUrl: invoice.verifyUrl,
    saleAuthor: sale.author,
    taker: takerTag(takerKey(key), sale.author),
    event
  };
}

describe("the declaration the app reads (vectors/app/implementation-declaration.json)", () => {
  it("is what the package makes, byte for byte", async () => {
    const vector = await makeVector();
    // 0.02 CHF at 99 000 CHF/BTC: ⌈2 × 10^8 / 9 900 000⌉ = ⌈20.2…⌉ = 21 sats.
    expect(vector.sats).toBe("21");
    const path = join(SPEC_DIR, FILE);
    const text = `${JSON.stringify(vector, null, 2)}\n`;
    const out = vectorsOut();
    if (out) writeFileSync(join(out, FILE), text);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(text));
  });
});
