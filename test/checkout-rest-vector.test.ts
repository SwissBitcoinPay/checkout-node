import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";

import { checkoutKeys, parseCheckoutFragment, parseCheckoutValue } from "../src/checkout.js";
import { restKeys, restRecordAddress } from "../src/derive.js";
import { Sattleme, type PaymentStatus } from "../src/index.js";
import type { NostrEvent } from "../src/nostr/event.js";
import { nip44Decrypt } from "../src/nostr/nip44.js";
import { openRestRecord } from "../src/onchain/rest.js";

import { depositAddress, payment, txid } from "./helpers/chain.js";
import { TestMerchant } from "./helpers/merchant.js";
import { fixedRandom } from "./helpers/rest-vectors.js";
import { SPEC_DIR, vectorsOut } from "./helpers/vectors.js";

/*
 * The package's half of the cross-check with the merchant's web app for the rest of an on-chain
 * underpayment: a checkout link to an invoice with an address (createInvoice with `checkout:
 * true`), then a payment check that sees 20 000 of its 49 000 sats on-chain and asks an invoice of
 * the rest, end to end, with fixed random bytes, is the specification's
 * vectors/app/checkout-rest.json. The web app reads the link, the rest key and author its record
 * carries, and the rest record. `source` names no package.
 *
 * Written on purpose only, into a clone of checkout-spec:
 * UPDATE_VECTORS=1 VECTORS_OUT=<clone> npx vitest run test/checkout-rest-vector.test.ts
 */

const FILE = "vectors/app/checkout-rest.json";
const ORIGIN = "https://pay.example";
const ADDRESS = depositAddress("checkout-rest");

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
  merchant.publishLot([ADDRESS], merchant.now - 30);
  const order = {
    ref: "ORD-3002",
    sats: "49000",
    note: "Order 3002",
    durationSeconds: 600,
    checkout: true,
    redirectUrl: "https://shop.example/orders/3002/thanks"
  };
  const sattleme = new Sattleme({
    key: merchant.key,
    fetch: merchant.http.fetch,
    WebSocket: merchant.net.WebSocket,
    now: () => merchant.now * 1000,
    random: fixedRandom("checkout-rest-vector"),
    logger: { warn: () => {} }
  });
  const invoice = await sattleme.createInvoice(order);
  const url = invoice.checkoutUrl!;
  const fragment = parseCheckoutFragment(url.slice(url.indexOf("#")));
  if (fragment.status !== "link") throw new Error("Not a checkout link");
  const keys = checkoutKeys(fragment.linkKey);
  const relay = merchant.net.get("wss://relay.example");
  const linkEvent = relay.received.find((e: NostrEvent) => e.pubkey === fragment.author)!;
  const { v: value } = JSON.parse(nip44Decrypt(linkEvent.content, keys.encryptionKey)) as {
    v: unknown;
  };

  // 20 000 sats in the mempool, a minute later: the check asks an invoice of the 29 000 left.
  merchant.now += 60;
  const tx = payment(txid("checkout-rest"), ADDRESS, 20_000);
  merchant.chain.add(ADDRESS, tx);
  const status = (await sattleme.getStatus(invoice)) as Extract<PaymentStatus, { state: "open" }>;
  const rest = restKeys(merchant.integrationKey, order.ref, ADDRESS, invoice.expiresAt);
  const restEvent = relay.received.find((e: NostrEvent) => e.pubkey === rest.author)!;
  const { v: restValue } = JSON.parse(nip44Decrypt(restEvent.content, rest.encryptionKey)) as {
    v: { invoice: string };
  };
  const made = [...merchant.invoices.values()].find((m) => m.pr === status.rest!.bolt11)!;
  return {
    vector: {
      source:
        "Made by an implementation of this specification (createInvoice with checkout: true, then getStatus once 20 000 of its 49 000 sats came on-chain, end to end) with fixed random bytes, for a channel whose checkout origin is https://pay.example. The sattle.me web app reads it: the link's record of `link.event` and its rest author and key, then the rest record of `rest.event`, the invoice of the rest it shows. `payRequest`: what the merchant's Lightning address answered, for the order's invoice and the invoice of its rest (its `metadata` is their description hash).",
      order,
      payRequest: merchant.pay,
      integrationKey: bytesToHex(merchant.integrationKey),
      origin: ORIGIN,
      relays: merchant.keyRelays,
      onchainAddress: invoice.onchainAddress,
      sats: invoice.sats,
      createdAt: invoice.createdAt,
      expiresAt: invoice.expiresAt,
      transaction: { txid: tx.txid, sats: "20000" },
      link: {
        url,
        linkKey: bytesToHex(fragment.linkKey),
        author: fragment.author,
        address: keys.address,
        encryptionKey: bytesToHex(keys.encryptionKey),
        value,
        event: linkEvent
      },
      rest: {
        restKey: bytesToHex(rest.key),
        restAuthor: rest.author,
        encryptionKey: bytesToHex(rest.encryptionKey),
        address: restRecordAddress(rest.key, made.paymentHash),
        invoice: made.pr,
        paymentHash: made.paymentHash,
        verifyUrl: made.verify,
        sats: "29000",
        value: restValue,
        event: restEvent
      },
      status
    },
    record: parseCheckoutValue(value),
    opened: openRestRecord(restEvent, rest, {
      sats: BigInt(invoice.sats),
      createdAt: invoice.createdAt,
      expiresAt: invoice.expiresAt
    })
  };
}

describe("the rest of an underpayment the web app reads (vectors/app/checkout-rest.json)", () => {
  it("is what the package makes, byte for byte", async () => {
    const { vector, record, opened } = await makeVector();
    expect(record?.rest).toEqual({
      author: vector.rest.restAuthor,
      key: Uint8Array.from(Buffer.from(vector.rest.restKey, "hex"))
    });
    expect(opened).toMatchObject({ invoice: { bolt11: vector.rest.invoice, sats: 29_000n } });
    expect(vector.status.rest).toEqual({
      sats: "29000",
      bolt11: vector.rest.invoice,
      paymentUri: `bitcoin:${vector.onchainAddress}?amount=0.00029&lightning=${vector.rest.invoice}`
    });
    expect(vector.rest.event.tags).toEqual([
      ["d", vector.rest.address],
      ["expiration", String(vector.expiresAt + 604_800)]
    ]);
    const path = join(SPEC_DIR, FILE);
    const text = `${JSON.stringify(vector, null, 2)}\n`;
    const out = vectorsOut();
    if (out) writeFileSync(join(out, FILE), text);
    expect(existsSync(path), `${FILE}: UPDATE_VECTORS=1 VECTORS_OUT=<clone> …`).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(text));
  });
});
