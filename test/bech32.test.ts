import { describe, expect, it } from "vitest";

import { decodeBech32 } from "../src/lightning/bech32.js";
import { decodeBolt11 } from "../src/lightning/bolt11.js";
import { appVectors } from "./helpers/vectors.js";

/*
 * Bech32 is US-ASCII, in one case (BIP-173), and that case is ASCII's (SPEC.md §6, §19): Unicode's
 * mapping reads the Kelvin sign (U+212A) as a k, so that a text that is no invoice would decode as
 * one.
 */
describe("bech32's case", () => {
  const upper = appVectors.realInvoice.invoice.toUpperCase();
  const at = upper.indexOf("K", upper.lastIndexOf("1"));
  const withAt = (char: string) => `${upper.slice(0, at)}${char}${upper.slice(at + 1)}`;

  it("reads an invoice in upper case", () => {
    expect(decodeBolt11(upper)).toEqual(decodeBolt11(appVectors.realInvoice.invoice));
  });

  it("refuses the Kelvin sign in place of a K", () => {
    expect(at).toBeGreaterThan(0);
    // What Unicode's mapping reads it as: the invoice itself.
    expect(withAt("K").toLowerCase()).toBe(appVectors.realInvoice.invoice);
    expect(decodeBolt11(withAt("K"))).toBeNull();
  });

  it("refuses any character beyond US-ASCII 33 to 126, and mixed case", () => {
    for (const char of ["é", " ", "İ", "k"]) expect(decodeBech32(withAt(char)), char).toBeNull();
  });
});
