import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { InvalidKeyError, Sattleme } from "../src/index.js";
import { parseIntegrationKey } from "../src/key.js";

import { appVectors } from "./helpers/vectors.js";

const KEY = appVectors.secretKey;

describe("the integration's secret key", () => {
  it("reads the key the app made", () => {
    const parsed = parseIntegrationKey(KEY);
    expect(parsed.teamPublicKey).toBe(appVectors.parsed.team);
    expect(bytesToHex(parsed.key)).toBe(appVectors.parsed.integrationKey);
    expect(parsed.relays).toEqual(appVectors.parsed.relays);
  });

  it("keeps the key out of JSON and of console output", () => {
    const parsed = parseIntegrationKey(KEY);
    const keyHex = appVectors.parsed.integrationKey;
    expect(JSON.stringify(parsed)).not.toContain(KEY.split(".")[1]);
    expect(Object.keys(parsed)).toEqual(["teamPublicKey", "relays"]);
    const client = new Sattleme({ key: KEY, logger: { warn: () => {} } });
    expect(JSON.stringify(client)).not.toContain(keyHex);
    expect(JSON.stringify(client)).not.toContain(KEY.split(".")[1]);
  });

  const [team, key, relays] = KEY.slice("sattleme_ck_".length).split(".") as [
    string,
    string,
    string
  ];
  /** `part` (base64url of UTF-8) with a byte order mark before its text. */
  const withBom = (part: string) =>
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(part, "base64url")]).toString(
      "base64url"
    );
  const damaged: [string, string][] = [
    ["empty", ""],
    ["another prefix", KEY.replace("sattleme_ck_", "sattleme_other_")],
    ["a later format's prefix", KEY.replace("sattleme_ck_", "sattleme_ck2_")],
    ["the prefix sattleme_ without ck_", KEY.replace("sattleme_ck_", "sattleme_")],
    ["no prefix", KEY.slice("sattleme_ck_".length)],
    ["a link holding its parts", `https://pay.example/pay#${team}.${key}.${relays}`],
    ["a part missing", `sattleme_ck_${team}.${key}`],
    ["a part too many", `${KEY}.${relays}`],
    ["a key cut short", KEY.slice(0, -3)],
    ["a team cut short", `sattleme_ck_${team.slice(1)}.${key}.${relays}`],
    ["a key too long", `sattleme_ck_${team}.${key}AA.${relays}`],
    ["padding", `sattleme_ck_${team}=.${key}.${relays}`],
    ["standard base64", `sattleme_ck_+${team.slice(1)}.${key}.${relays}`],
    ["unused bits set", `sattleme_ck_${team.slice(0, -1)}b.${key}.${relays}`],
    ["no relay", `sattleme_ck_${team}.${key}.`],
    ["a relay that is not one", `sattleme_ck_${team}.${key}.bG9jYWxob3N0`],
    ["spaces", ` ${KEY}`],
    // Strict UTF-8 keeps it: "\ufeffrelay…" is no relay's host (SPEC.md §8, step 5).
    [
      "a relays part starting with a byte order mark",
      `sattleme_ck_${team}.${key}.${withBom(relays)}`
    ]
  ];

  it.each(damaged)("refuses %s, without the key in the message", (_, text) => {
    let error: unknown;
    try {
      parseIntegrationKey(text);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(InvalidKeyError);
    expect((error as Error).message).not.toContain(key);
    expect((error as Error).message).not.toContain(appVectors.parsed.integrationKey);
  });

  it("refuses a key at construction", () => {
    expect(() => new Sattleme({ key: "nope" })).toThrow(InvalidKeyError);
  });
});
