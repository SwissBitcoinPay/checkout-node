import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { openDeclaration, registryOf } from "../src/declaration.js";
import { acceptanceRecordAddress, restKeys, restRecordAddress, saleOf } from "../src/derive.js";
import { openAcceptanceRecord } from "../src/onchain/acceptance.js";
import {
  openRestRecord,
  restOf,
  restToAsk,
  sendable,
  type RestInvoice
} from "../src/onchain/rest.js";

import { onchainRests } from "./helpers/rest-vectors.js";
import { SPEC_DIR, vectorsOut } from "./helpers/vectors.js";

/*
 * The package against vectors/onchain-rests.json (SPEC.md, "The rest of an underpayment"), and that
 * file against what test/helpers/rest-vectors.ts builds. Made on purpose into a clone of
 * checkout-spec: UPDATE_VECTORS=1 VECTORS_OUT=<clone> npx vitest run test/rest-vectors.test.ts
 */

const FILE = "vectors/onchain-rests.json";
const built = onchainRests();
const text = `${JSON.stringify(built, null, 2)}\n`;
const out = vectorsOut();
if (out) writeFileSync(join(out, FILE), text);

type Vectors = ReturnType<typeof onchainRests>;
const path = join(SPEC_DIR, FILE);
const vectors: Vectors = existsSync(path)
  ? (JSON.parse(readFileSync(path, "utf8")) as Vectors)
  : built;

describe("vectors/onchain-rests.json", () => {
  it("is what rest-vectors.ts builds", () => {
    expect(existsSync(path), `${FILE}: UPDATE_VECTORS=1 VECTORS_OUT=<clone> …`).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(text));
  });

  it.each(vectors.keys)("the rest keys of $ref, $address and $expiresAt", (c) => {
    const keys = restKeys(hexToBytes(vectors.integrationKey), c.ref, c.address, c.expiresAt);
    expect({
      restKey: bytesToHex(keys.key),
      restSecret: bytesToHex(keys.secretKey),
      restAuthor: keys.author,
      restEncryptionKey: bytesToHex(keys.encryptionKey),
      records: c.records.map(({ paymentHash }) => ({
        paymentHash,
        address: restRecordAddress(keys.key, paymentHash)
      })),
      acceptanceAddress: acceptanceRecordAddress(keys.key)
    }).toEqual({
      restKey: c.restKey,
      restSecret: c.restSecret,
      restAuthor: c.restAuthor,
      restEncryptionKey: c.restEncryptionKey,
      records: c.records,
      acceptanceAddress: c.acceptanceAddress
    });
  });

  const { records } = vectors;
  it.each(records.cases)("record: $name", ({ event, expected }) => {
    const key = hexToBytes(records.restKey);
    const keys = restKeys(
      hexToBytes(vectors.integrationKey),
      "ORD-1042",
      vectors.keys[0]!.address,
      records.link.expiresAt
    );
    expect(bytesToHex(keys.key)).toBe(records.restKey);
    const opened = openRestRecord(
      event,
      { key, author: records.restAuthor, encryptionKey: keys.encryptionKey },
      {
        sats: BigInt(records.link.sats),
        createdAt: records.link.createdAt,
        expiresAt: records.link.expiresAt
      }
    );
    expect(
      opened === null || opened === "newer"
        ? opened
        : {
            invoice: opened.invoice.bolt11,
            paymentHash: opened.invoice.paymentHash,
            verifyUrl: opened.invoice.verifyUrl,
            sats: opened.invoice.sats.toString()
          }
    ).toEqual(expected);
  });

  const { acceptances } = vectors;
  it.each(acceptances.cases)("acceptance: $name", ({ event, expected }) => {
    const keys = restKeys(
      hexToBytes(vectors.integrationKey),
      "ORD-1042",
      vectors.keys[0]!.address,
      records.link.expiresAt
    );
    expect(bytesToHex(keys.key)).toBe(acceptances.restKey);
    expect(keys.author).toBe(acceptances.restAuthor);
    const opened = openAcceptanceRecord(event, keys, BigInt(acceptances.link.sats));
    expect(
      opened === null || opened === "newer" ? opened : { received: opened.received.toString() }
    ).toEqual(expected);
  });

  const { declarations } = vectors;
  it.each(declarations.cases)("declaration: $name", ({ event, expected }) => {
    const sale = saleOf(
      hexToBytes(vectors.integrationKey),
      registryOf(declarations.registryKey as string, declarations.registryReader as string),
      declarations.ref
    );
    const opened = openDeclaration(event, sale);
    expect(opened && { invoice: opened.invoice, note: opened.note, rest: opened.rest }).toEqual(
      expected
    );
  });

  it.each(vectors.asking)("asking: $name", (c) => {
    const invoices: (RestInvoice & { id: string })[] = c.rests.map((rest) => ({
      id: rest.id,
      bolt11: rest.id,
      paymentHash: rest.paymentHash,
      verifyUrl: "https://breez.tips/verify",
      sats: BigInt(rest.sats),
      createdAt: rest.createdAt,
      expiresAt: rest.expiresAt
    }));
    const paid = new Set(
      invoices.filter((_, index) => c.rests[index]!.paid).map(({ paymentHash }) => paymentHash)
    );
    const rest = restOf({
      sats: BigInt(c.sats),
      expiresAt: c.expiresAt,
      address: vectors.keys[0]!.address,
      received: BigInt(c.received),
      now: c.now,
      rests: invoices,
      paid
    });
    let ask = restToAsk({
      rest,
      sats: BigInt(c.sats),
      expiresAt: c.expiresAt,
      now: c.now,
      lease: c.lease && { sats: BigInt(c.lease.sats), expiresAt: c.lease.expiresAt }
    });
    if (ask && !sendable(ask.sats, { min: BigInt(c.sendable.min), max: BigInt(c.sendable.max) })) {
      ask = null;
    }
    expect({
      rest: rest && { sats: rest.sats, invoice: rest.bolt11 },
      ask: ask && { sats: ask.sats.toString(), expirySeconds: ask.expirySeconds }
    }).toEqual(c.expected);
  });
});
