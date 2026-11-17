import { describe, expect, it } from "vitest";

import { MAX_JSON_DEPTH, readJson } from "../src/json.js";

/*
 * JSON as every implementation reads it (SPEC.md §2): JSON.parse's reading, and no more than 64
 * arrays and objects nested one in another.
 */

const nested = (depth: number, inner = "1") => "[".repeat(depth) + inner + "]".repeat(depth);

describe("readJson", () => {
  it("reads 64 arrays and objects nested, and refuses 65", () => {
    expect(MAX_JSON_DEPTH).toBe(64);
    expect(readJson(nested(64))).toEqual(JSON.parse(nested(64)));
    expect(() => readJson(nested(65))).toThrow(SyntaxError);
    // Objects and arrays count together.
    const mixed = (depth: number) =>
      '{"a":'.repeat(depth / 2) + nested(depth / 2) + "}".repeat(depth / 2);
    expect(() => readJson(mixed(64))).not.toThrow();
    expect(() => readJson(mixed(66))).toThrow(SyntaxError);
  });

  it("counts no bracket inside a string, an escaped quote included", () => {
    const text = `[${JSON.stringify("[[[[" + "{".repeat(100) + '\\"]]]')}]`;
    expect(readJson(text)).toEqual(JSON.parse(text));
    expect(readJson(`{"a\\"[[[":${nested(63)}}`)).toEqual(JSON.parse(`{"a\\"[[[":${nested(63)}}`));
  });

  it("reads what JSON.parse reads, as SPEC.md §2 says", () => {
    // Of members with one name, the last; numbers as doubles, whatever their length.
    expect(readJson('{"a":1,"a":2}')).toEqual({ a: 2 });
    expect(readJson(`[${"9".repeat(5000)}]`)).toEqual([Infinity]);
    expect(readJson("[1e400, -1e400, 5e2, 500.0]")).toEqual([Infinity, -Infinity, 500, 500]);
    // A name holding U+0000 is a name like any other.
    expect(readJson('{"\\u0000a":1}')).toEqual({ "\u0000a": 1 });
  });

  it("refuses what is not JSON", () => {
    for (const text of ["[01]", "[1,]", "[1] ", "﻿[1]", "", "[", "]"]) {
      expect(() => readJson(text), text).toThrow(SyntaxError);
    }
  });
});
