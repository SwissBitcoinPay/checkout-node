import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { declarationEvent, openDeclaration } from "../src/declaration.js";
import {
  channelKeys,
  outerKey,
  registryAddress,
  saleKeys,
  saleOf,
  takerKey,
  takerTag
} from "../src/derive.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { decodeBolt11 } from "../src/lightning/bolt11.js";
import { isValidEvent } from "../src/nostr/event.js";
import { conversationKey, nip44Decrypt } from "../src/nostr/nip44.js";
import { parseChannel } from "../src/channel.js";

import { appVectors } from "./helpers/vectors.js";

const { declaration, realInvoice } = appVectors;
const integrationKey = hexToBytes(appVectors.parsed.integrationKey);
const registry = {
  key: hexToBytes(appVectors.channel.value.v.registryKey as string),
  reader: appVectors.channel.value.v.registryReader as string
};

describe("the app's vectors", () => {
  it("give the channel's keys and the integration's mark key", () => {
    const keys = channelKeys(integrationKey);
    expect({
      channelAddress: keys.address,
      channelEncryptionKey: bytesToHex(keys.encryptionKey),
      takerKey: bytesToHex(takerKey(integrationKey))
    }).toEqual(appVectors.derived);
  });

  it("hold a channel the key alone opens, as the package reads it", () => {
    const keys = channelKeys(integrationKey);
    const { event, value } = appVectors.channel;
    expect(isValidEvent(event)).toBe(true);
    expect(event.pubkey).toBe(appVectors.parsed.team);
    expect(event.tags).toEqual([["d", keys.address]]);
    expect(JSON.parse(nip44Decrypt(event.content, keys.encryptionKey))).toEqual(value);
    expect(parseChannel(value.v, event.created_at)).toEqual({
      status: "active",
      businessName: "Sunrise Bakery",
      lightningAddress: "sattleme02c6047f94@breez.tips",
      registryKey: value.v.registryKey,
      registryReader: value.v.registryReader,
      relays: ["wss://relay.example"],
      // The app's channel of this vector names no web app: no checkout link.
      checkoutOrigin: null,
      // Nor a tolerance of on-chain underpayments: none.
      tolerance: 0,
      // Nor a Bitcoin node: mempool.space.
      bitcoinNode: null,
      updatedAt: event.created_at
    });
  });

  it("give every key of the order's sale and of its declaration", () => {
    const sale = saleKeys(integrationKey, declaration.ref);
    expect(bytesToHex(sale.key)).toBe(declaration.saleKey);
    expect(bytesToHex(sale.secretKey)).toBe(declaration.saleSecret);
    expect(sale.author).toBe(declaration.saleAuthor);
    expect(takerTag(takerKey(integrationKey), sale.author)).toBe(declaration.taker);
    expect(registryAddress(registry.key, declaration.paymentHash)).toBe(declaration.address);
    expect(bytesToHex(outerKey(registry.key, declaration.address, sale.author))).toBe(
      declaration.outerKey
    );
    expect(bytesToHex(conversationKey(sale.secretKey, registry.reader))).toBe(
      declaration.innerConversationKey
    );
  });

  it("hold a real breez.tips invoice the package decodes", () => {
    const decoded = decodeBolt11(realInvoice.invoice);
    expect(decoded).toEqual({
      network: "bc",
      amountMsat: BigInt(realInvoice.amountMsat),
      timestamp: realInvoice.timestamp,
      expirySeconds: realInvoice.expirySeconds,
      paymentHash: realInvoice.paymentHash,
      descriptionHash: realInvoice.descriptionHash
    });
  });

  it("hold a declaration the package opens as its sale", () => {
    const { event } = declaration;
    expect(isValidEvent(event)).toBe(true);
    expect(utf8ToBytes(nip44Decrypt(event.content, hexToBytes(declaration.outerKey))).length).toBe(
      declaration.outsideBytes
    );
    expect(openDeclaration(event, saleOf(integrationKey, registry, declaration.ref))).toEqual({
      event,
      invoice: declaration.invoice,
      decoded: decodeBolt11(declaration.invoice),
      verifyUrl: declaration.verifyUrl,
      price: declaration.fiat,
      note: declaration.note,
      declaredAt: event.created_at,
      rest: null
    });
    // Another order's sale does not open it.
    expect(openDeclaration(event, saleOf(integrationKey, registry, "ORD-1043"))).toBeNull();
  });
});

describe("a declaration the package makes", () => {
  const event = declarationEvent({
    sale: saleOf(integrationKey, registry, declaration.ref),
    invoice: declaration.invoice,
    verifyUrl: declaration.verifyUrl,
    paymentHash: declaration.paymentHash,
    price: declaration.fiat,
    note: declaration.note,
    createdAt: declaration.event.created_at
  });

  it("opens with the vector's keys, holding what the app's holds", () => {
    expect(isValidEvent(event)).toBe(true);
    expect(event.kind).toBe(30078);
    expect(event.pubkey).toBe(declaration.saleAuthor);
    expect(event.tags).toEqual([["d", declaration.address]]);
    const outside = nip44Decrypt(event.content, hexToBytes(declaration.outerKey));
    expect(utf8ToBytes(outside).length % 256).toBe(0);
    const { t, v } = JSON.parse(outside) as { t: string; v: { sealed: string } };
    expect(t).toBe("registry-declaration");
    const inside = JSON.parse(
      nip44Decrypt(v.sealed, hexToBytes(declaration.innerConversationKey))
    ) as unknown;
    const app = JSON.parse(
      nip44Decrypt(
        (
          JSON.parse(nip44Decrypt(declaration.event.content, hexToBytes(declaration.outerKey))) as {
            v: { sealed: string };
          }
        ).v.sealed,
        hexToBytes(declaration.innerConversationKey)
      )
    ) as unknown;
    // The same declaration, field for field, as the vector's (which the app made).
    expect(inside).toEqual(app);
    expect(inside).toEqual({
      version: 1,
      invoice: declaration.invoice,
      verifyUrl: declaration.verifyUrl,
      sale: { key: declaration.saleKey, fiat: declaration.fiat, note: declaration.note },
      taker: declaration.taker
    });
  });

  it("is refused with another registry key or reader", () => {
    const otherKey = { ...registry, key: new Uint8Array(32).fill(9) };
    expect(openDeclaration(event, saleOf(integrationKey, otherKey, declaration.ref))).toBeNull();
    const otherReader = { ...registry, reader: appVectors.parsed.team };
    expect(openDeclaration(event, saleOf(integrationKey, otherReader, declaration.ref))).toBeNull();
  });
});
