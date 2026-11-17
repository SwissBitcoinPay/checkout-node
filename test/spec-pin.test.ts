import { describe, expect, it } from "vitest";

// @ts-expect-error: a plain ES module of the repository's tooling, without types.
import { checkCopy } from "../scripts/spec.mjs";

/*
 * The pinned copy of the specification (spec/, PORTING.md of checkout-spec): every file of
 * spec/PIN.json is there with its SHA-256, and nothing else. It changes only by taking a newer
 * version of checkout-spec (node scripts/spec.mjs import <clone>), never by hand.
 */
describe("spec/", () => {
  it("is the copy PIN.json pins", () => {
    expect((checkCopy as () => string[])()).toEqual([]);
  });
});
