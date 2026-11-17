import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { signEvent } from "../src/nostr/event.js";
import { openRecord, sealRecord } from "../src/nostr/record.js";

import {
  UnknownNip44VersionError,
  conversationKey,
  messageKeys,
  nip44Decrypt,
  nip44Encrypt,
  nip44EncryptWithNonce,
  paddedLength
} from "../src/nostr/nip44.js";

import { readSpec } from "./helpers/vectors.js";

// The official vectors of NIP-44 (https://github.com/paulmillr/nip44, see `source`), the app's copy.
type Vectors = {
  calc_padded_len: [number, number][];
  get_conversation_key: { sec1: string; pub2: string; conversation_key: string }[];
  invalid_get_conversation_key: { sec1: string; pub2: string }[];
  get_message_keys: {
    conversation_key: string;
    keys: { nonce: string; chacha_key: string; chacha_nonce: string; hmac_key: string }[];
  };
  encrypt_decrypt: {
    conversation_key: string;
    nonce: string;
    plaintext: string;
    payload: string;
  }[];
  invalid_decrypt: { conversation_key: string; payload: string; note: string }[];
};
const vectors = readSpec<Vectors>("vectors/nip44/nip44.vectors.json");

describe("NIP-44 v2", () => {
  it("pads plaintexts to the spec's lengths", () => {
    for (const [length, padded] of vectors.calc_padded_len) {
      expect(paddedLength(length)).toBe(padded);
    }
  });

  it("derives the spec's conversation keys, and refuses invalid ones", () => {
    for (const vector of vectors.get_conversation_key) {
      expect(bytesToHex(conversationKey(hexToBytes(vector.sec1), vector.pub2))).toBe(
        vector.conversation_key
      );
    }
    for (const vector of vectors.invalid_get_conversation_key) {
      expect(() => conversationKey(hexToBytes(vector.sec1), vector.pub2)).toThrow();
    }
  });

  it("gives both parties the same conversation key", () => {
    const a = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const b = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const pubA = bytesToHex(schnorr.getPublicKey(a));
    const pubB = bytesToHex(schnorr.getPublicKey(b));
    expect(bytesToHex(conversationKey(a, pubB))).toBe(bytesToHex(conversationKey(b, pubA)));
  });

  it("derives the spec's message keys", () => {
    const key = hexToBytes(vectors.get_message_keys.conversation_key);
    for (const expected of vectors.get_message_keys.keys) {
      const keys = messageKeys(key, hexToBytes(expected.nonce));
      expect(bytesToHex(keys.chachaKey)).toBe(expected.chacha_key);
      expect(bytesToHex(keys.chachaNonce)).toBe(expected.chacha_nonce);
      expect(bytesToHex(keys.hmacKey)).toBe(expected.hmac_key);
    }
  });

  it("encrypts and decrypts the spec's payloads", () => {
    for (const vector of vectors.encrypt_decrypt) {
      const key = hexToBytes(vector.conversation_key);
      expect(nip44EncryptWithNonce(vector.plaintext, key, hexToBytes(vector.nonce))).toBe(
        vector.payload
      );
      expect(nip44Decrypt(vector.payload, key)).toBe(vector.plaintext);
    }
  });

  it("refuses the spec's invalid payloads, telling another version apart", () => {
    for (const vector of vectors.invalid_decrypt) {
      expect(() => nip44Decrypt(vector.payload, hexToBytes(vector.conversation_key))).toThrow();
    }
    expect(() => nip44Decrypt("#future", new Uint8Array(32))).toThrow(UnknownNip44VersionError);
  });

  it("keeps a plaintext's leading byte order mark: UTF-8 is decoded strictly (SPEC.md §6)", () => {
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    expect(nip44Decrypt(nip44Encrypt("\ufeff{}", key), key)).toBe("\ufeff{}");
  });

  it("opens no record whose plaintext starts with a byte order mark: not JSON (SPEC.md §12)", () => {
    const signer = new Uint8Array(32).fill(3);
    const encryptionKey = new Uint8Array(32).fill(4);
    const address = "ab".repeat(32);
    const options = { type: "t", encryptionKey, address, createdAt: 1_791_378_000 };
    const open = (event: unknown) =>
      openRecord(event, {
        ...options,
        author: bytesToHex(schnorr.getPublicKey(signer)),
        parse: (value) => value
      });
    expect(open(sealRecord({ ...options, value: 1, signer }))).toMatchObject({
      status: "ok",
      value: 1
    });
    // The same record, its plaintext after a byte order mark, signed by its author.
    const plaintext = `\ufeff${JSON.stringify({ t: "t", v: 1 })}`.padEnd(256, " ");
    const event = signEvent(
      {
        kind: 30078,
        created_at: options.createdAt,
        tags: [["d", address]],
        content: nip44Encrypt(plaintext, encryptionKey)
      },
      signer
    );
    expect(open(event)).toBeNull();
  });

  it("draws a fresh nonce each time", () => {
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    expect(nip44Encrypt("Sunrise Bakery", key)).not.toBe(nip44Encrypt("Sunrise Bakery", key));
  });
});
