import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { parseChannel } from "../src/channel.js";
import {
  checkoutKeys,
  checkoutOriginOf,
  checkoutUrl,
  parseCheckoutFragment,
  parseCheckoutValue,
  redirectShown
} from "../src/checkout.js";
import { CURRENCY_DIGITS } from "../src/currencies.js";
import { NetworkError, RateError, SattlemeError, UnsupportedCurrencyError } from "../src/errors.js";
import { eventId, type EventTemplate } from "../src/nostr/event.js";
import { NewerRecordError } from "../src/nostr/record.js";
import { parseIntegrationKey } from "../src/key.js";
import { decodeBolt11 } from "../src/lightning/bolt11.js";
import {
  checkInvoice,
  descriptionHashOf,
  fetchPayRequest,
  lightningAddressUrl,
  requestInvoice,
  sendableSats,
  verifyPayment,
  type LightningInvoice,
  type PayRequest
} from "../src/lnurl.js";
import { combineParts } from "../src/onchain/payment.js";
import { checkOrder, checkRef, checkStoredInvoice, rateSourceOption } from "../src/order.js";
import {
  DEFAULT_RATE_SOURCES,
  RATE_SOURCES,
  fetchFirstRate,
  fetchRate,
  fiatToSats,
  parseFiat,
  type RateName,
  type RateQuote,
  type RateSource
} from "../src/rates.js";
import { isRelayUrl } from "../src/relays.js";
import { parseHttpsUrl, sameHost } from "../src/urls.js";
import { Sattleme } from "../src/client.js";
import { currencyDigits } from "../src/index.js";
import { fakeFetch } from "./helpers/fetch.js";
import { specVectors } from "./helpers/spec-vectors.js";
import { SPEC_DIR, appVectors, vectorsOut } from "./helpers/vectors.js";

/*
 * The package against the conformance vectors every implementation shares (the pinned copy of the
 * specification, spec/vectors/), and those files against what test/helpers/spec-vectors.ts builds.
 * Made on purpose into a clone of checkout-spec:
 * UPDATE_VECTORS=1 VECTORS_OUT=<clone> npx vitest run test/conformance.test.ts
 */

const SPEC = SPEC_DIR;
const built = specVectors();

const out = vectorsOut();
if (out) {
  for (const [name, value] of Object.entries(built)) {
    writeFileSync(join(out, "vectors", name), `${JSON.stringify(value, null, 2)}\n`);
  }
}

type Outcome = { error: string; param?: string };
type Http = { status: number; body?: unknown; bodyText?: string };

/** The shapes of the vector files (SPEC.md, "Conformance vectors"). */
type Files = {
  "integration-keys.json": { cases: { name: string; key: string; expected: unknown }[] };
  "relay-urls.json": { cases: { url: string; valid: boolean }[] };
  "https-urls.json": {
    urls: { url: string; expected: { host: string; port: number } | null }[];
    sameHost: { a: string; b: string; expected: boolean }[];
    lightningAddresses: { address: string; payUrl: string | null }[];
  };
  "nostr-events.json": {
    cases: { name: string; event: EventTemplate & { pubkey: string }; id: string }[];
  };
  "pay-requests.json": { cases: { name: string; http: Http; expected: unknown }[] };
  "bolt11.json": { cases: { name: string; invoice: string; expected: unknown }[] };
  "fiat.json": {
    cases: { input: { amount: string; currency: string }; expected: unknown }[];
    digits: { code: string; expected: number | null }[];
  };
  "prices.json": {
    text: { price: string; expected: string | null }[];
    numbers: { json: string; expected: string | null }[];
  };
  "conversions.json": {
    cases: { fiat: { amount: string; currency: string }; price: string; sats: string }[];
  };
  "order-text.json": {
    refs: { ref: string; valid: boolean }[];
    notes: { ref: string; note: string | null; expected: { label: string } | Outcome }[];
    comments: { label: string; commentAllowed: number; sent: boolean }[];
  };
  "invoice-checks.json": {
    payRequest: { callback: string; metadata: string };
    cases: {
      name: string;
      answer: { pr: string; verify: string };
      sats: string;
      durationSeconds: number;
      now: number;
      expected: unknown;
    }[];
  };
  "payments.json": {
    invoice: LightningInvoice;
    cases: { name: string; now: number; http: Http; expected: unknown }[];
    stored: { name: string; invoice: unknown; expected: { valid: true } | Outcome }[];
  };
  "rate-sources.json": {
    statuses: { status: number; expected: Outcome }[];
    default: string[];
    values: { name: string; rateSource?: unknown; expected: unknown }[];
    lists: {
      currency: string;
      now: number;
      cases: {
        name: string;
        sources: string[];
        answers: Record<string, string | RateQuote>;
        expected: unknown;
      }[];
    };
  };
  "redirect-urls.json": { cases: { url: string; expected: { shown: string } | Outcome }[] };
  "checkout-links.json": {
    origins: { checkout: unknown; expected: string | null }[];
    derivations: { linkKey: string; address: string; encryptionKey: string }[];
    urls: { origin: string; author: string; linkKey: string; relays: string[]; url: string }[];
    fragments: { name: string; fragment: string; expected: unknown }[];
    records: { name: string; value: unknown; expected: unknown }[];
  };
};

function vectors<K extends keyof Files>(name: K): Files[K] {
  return JSON.parse(readFileSync(join(SPEC, "vectors", name), "utf8")) as Files[K];
}

/** The error of `run` as the vectors write it: `{ error: code, param? }`. */
function outcome(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof SattlemeError)) throw error;
    const param = (error as { param?: string }).param;
    return { error: error.code, ...(param ? { param } : {}) };
  }
}

describe("the vector files", () => {
  it.each(Object.keys(built))("%s is what spec-vectors.ts builds", (name) => {
    const path = join(SPEC, "vectors", name);
    expect(
      existsSync(path),
      `${name}: UPDATE_VECTORS=1 VECTORS_OUT=<checkout-spec clone> npx vitest run test/conformance.test.ts`
    ).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(JSON.stringify(built[name])));
  });

  it("currencies.json is the package's table", () => {
    const { currencies } = JSON.parse(readFileSync(join(SPEC, "currencies.json"), "utf8")) as {
      currencies: Record<string, number>;
    };
    expect(currencies).toEqual({ ...CURRENCY_DIGITS });
  });
});

describe("integration-keys.json", () => {
  it.each(vectors("integration-keys.json").cases)("$name", ({ key, expected }) => {
    expect(
      outcome(() => {
        const parsed = parseIntegrationKey(key);
        return {
          teamPublicKey: parsed.teamPublicKey,
          integrationKey: bytesToHex(parsed.key),
          relays: [...parsed.relays]
        };
      })
    ).toEqual(expected);
  });
});

describe("relay-urls.json", () => {
  it.each(vectors("relay-urls.json").cases)("$url: $valid", ({ url, valid }) => {
    expect(isRelayUrl(url)).toBe(valid);
  });
});

describe("relay addresses beyond relay-urls.json", () => {
  it("refuses a path holding a lone surrogate (SPEC.md §6), and takes a pair of them", () => {
    expect(isRelayUrl("wss://relay.example/\ud800")).toBe(false);
    expect(isRelayUrl("wss://relay.example/a\udc00b")).toBe(false);
    expect(isRelayUrl("wss://relay.example/\ud83d\ude00")).toBe(true);
  });
});

describe("nostr-events.json", () => {
  it.each(vectors("nostr-events.json").cases)("$name", ({ event, id }) => {
    expect(eventId(event.pubkey, event)).toBe(id);
  });
});

describe("https-urls.json", () => {
  const { urls, sameHost: pairs, lightningAddresses } = vectors("https-urls.json");

  it.each(urls)("$url", ({ url, expected }) => {
    expect(parseHttpsUrl(url)).toEqual(expected);
  });

  it.each(pairs)("$a and $b: $expected", ({ a, b, expected }) => {
    expect(sameHost(parseHttpsUrl(a)!, parseHttpsUrl(b)!)).toBe(expected);
  });

  it.each(lightningAddresses)("$address", ({ address, payUrl }) => {
    expect(lightningAddressUrl(address)).toBe(payUrl);
  });
});

describe("bolt11.json", () => {
  it.each(vectors("bolt11.json").cases)("$name", ({ invoice, expected }) => {
    const decoded = decodeBolt11(invoice);
    expect(decoded && { ...decoded, amountMsat: decoded.amountMsat?.toString() ?? null }).toEqual(
      expected
    );
  });
});

describe("fiat.json", () => {
  it.each(vectors("fiat.json").cases)("$input.amount $input.currency", ({ input, expected }) => {
    expect(outcome(() => parseFiat(input))).toEqual(expected);
  });
  it.each(vectors("fiat.json").digits)("currencyDigits($code)", ({ code, expected }) => {
    expect(currencyDigits(code)).toBe(expected);
  });
});

describe("prices.json", () => {
  const now = 1_791_378_000;
  /** What each source answers with a price of one bitcoin in CHF written `price` (JSON text). */
  const bodies: Record<RateName, (price: string) => string> = {
    coingecko: (price) => `{"bitcoin":{"chf":${price},"last_updated_at":${now}}}`,
    mempool: (price) => `{"time":${now},"USD":69012,"CHF":${price}}`,
    opennode: (price) => `{"data":{"BTCCHF":{"CHF":${price}}}}`,
    coinbase: (price) => `{"data":{"currency":"BTC","rates":{"CHF":${price}}}}`,
    kraken: (price) => `{"error":[],"result":{"XBTCHF":{"c":[${price},"0.01"]}}}`
  };
  /**
   * The price each source gives (its RateInfo's), asked as the client asks it (fetchRate), when
   * it writes `price`: null when it gives none (RateError).
   */
  const read = async (price: string) => {
    const prices: [string, string | null][] = [];
    for (const source of RATE_SOURCES) {
      const { fetch } = fakeFetch(() => ({ text: bodies[source](price) }));
      prices.push([
        source,
        await fetchRate(source, "CHF", { fetch, timeoutMs: 1000 }, now).then(
          ({ info }) => info.price,
          (error: unknown) => {
            if (error instanceof RateError) return null;
            throw error;
          }
        )
      ]);
    }
    return Object.fromEntries(prices);
  };
  const everySource = (price: string | null) =>
    Object.fromEntries(RATE_SOURCES.map((source) => [source, price]));
  it.each(vectors("prices.json").text)("text $price", async ({ price, expected }) => {
    expect(await read(JSON.stringify(price))).toEqual(everySource(expected));
  });
  it.each(vectors("prices.json").numbers)("number $json", async ({ json, expected }) => {
    expect(await read(json)).toEqual(everySource(expected));
  });
});

describe("conversions.json", () => {
  it.each(vectors("conversions.json").cases)(
    "$fiat.amount $fiat.currency at $price",
    ({ fiat, price, sats }) => {
      expect(fiatToSats(fiat, price).toString()).toBe(sats);
    }
  );
});

describe("order-text.json", () => {
  const { refs, notes, comments } = vectors("order-text.json");

  it.each(refs)("ref $ref: $valid", ({ ref, valid }) => {
    expect(outcome(() => checkRef(ref))).toEqual(
      valid ? ref : { error: "invalid_order", param: "ref" }
    );
  });

  it.each(notes)("note $note", ({ ref, note, expected }) => {
    const order = { ref, sats: 1, ...(note === null ? {} : { note }) };
    expect(outcome(() => ({ label: checkOrder(order, []).label }))).toEqual(expected);
  });

  it.each(comments)(
    "comment $label, commentAllowed $commentAllowed",
    async ({ label, commentAllowed, sent }) => {
      const { fetch, calls } = fakeFetch(() => ({
        json: { pr: "lnbc1", verify: "https://x.example/v" }
      }));
      const pay: PayRequest = {
        callback: "https://x.example/cb",
        minSendableMsat: 1000n,
        maxSendableMsat: 1_000_000n,
        metadata: "[]",
        commentAllowed
      };
      await requestInvoice(
        pay,
        { sats: 1n, expirySeconds: 60, comment: label },
        { fetch, timeoutMs: 1000 }
      );
      expect(calls[0]!.url.searchParams.get("comment")).toBe(sent ? label : null);
    }
  );
});

describe("invoice-checks.json", () => {
  const { payRequest, cases } = vectors("invoice-checks.json");
  const pay: PayRequest = {
    callback: payRequest.callback,
    minSendableMsat: 1000n,
    maxSendableMsat: 100_000_000n,
    metadata: payRequest.metadata,
    commentAllowed: 0
  };
  /** Which check an InvalidInvoiceError names, by its message. */
  const CHECKS: [RegExp, string][] = [
    [/Not a BOLT11/, "bolt11"],
    [/mainnet/, "network"],
    [/amount/, "amount"],
    [/does not pay the merchant/, "description_hash"],
    [/verify URL/, "verify_url"],
    [/longer than asked/, "duration"],
    [/clock/, "clock"],
    [/no time left/, "expired"]
  ];
  it.each(cases)("$name", ({ answer, sats, durationSeconds, now, expected }) => {
    let result: unknown;
    try {
      checkInvoice(answer, { pay, sats: BigInt(sats), durationSeconds, now });
      result = { valid: true };
    } catch (error) {
      const message = (error as Error).message;
      result = {
        error: (error as SattlemeError).code,
        check: CHECKS.find(([pattern]) => pattern.test(message))?.[1] ?? message
      };
    }
    expect(result).toEqual(expected);
  });
});

describe("pay-requests.json", () => {
  it.each(vectors("pay-requests.json").cases)("$name", async ({ http, expected }) => {
    const { fetch } = fakeFetch(() =>
      http.bodyText === undefined
        ? { status: http.status, json: http.body }
        : { status: http.status, text: http.bodyText }
    );
    const result = await fetchPayRequest("shop@breez.tips", { fetch, timeoutMs: 1000 }).then(
      (pay) => {
        const { min, max } = sendableSats(pay);
        return {
          callback: pay.callback,
          sendable: { min: min.toString(), max: max.toString() },
          commentAllowed: pay.commentAllowed,
          descriptionHash: descriptionHashOf(pay)
        };
      },
      (error: unknown) => {
        if (!(error instanceof SattlemeError)) throw error;
        return { error: error.code };
      }
    );
    expect(result).toEqual(expected);
  });
});

describe("payments.json", () => {
  const { invoice, cases } = vectors("payments.json");
  it.each(cases)("$name", async ({ now, http, expected }) => {
    const { fetch } = fakeFetch(() =>
      http.bodyText === undefined
        ? { status: http.status, json: http.body }
        : { status: http.status, text: http.bodyText }
    );
    // An invoice without an address: its Lightning part, settled, gives its status (combineParts,
    // as the client's check does), or the error.
    const lightning = await verifyPayment(invoice, { fetch, timeoutMs: 1000 }, now).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    expect(
      outcome(() =>
        combineParts(
          { sats: 1n, expiresAt: invoice.expiresAt, address: null },
          now,
          lightning,
          null
        )
      )
    ).toEqual(expected);
  });
});

describe("payments.json, stored invoices", () => {
  it.each(vectors("payments.json").stored)("$name", ({ invoice, expected }) => {
    expect(
      outcome(() => {
        checkStoredInvoice(invoice as Parameters<typeof checkStoredInvoice>[0]);
        return { valid: true };
      })
    ).toEqual(expected);
  });
});

describe("rate-sources.json", () => {
  const { statuses, default: defaults, values, lists } = vectors("rate-sources.json");

  // An answer of any status, as fetch gives it (a Response cannot be made of one above 599).
  it.each(statuses)("HTTP $status", async ({ status, expected }) => {
    const fetch = (async () =>
      ({
        status,
        ok: status >= 200 && status < 300,
        body: null
      }) as unknown as Response) as typeof globalThis.fetch;
    let result: unknown;
    try {
      await fetchRate("coingecko", "CHF", { fetch, timeoutMs: 1000 }, 1_791_378_000);
      result = { ok: true };
    } catch (error) {
      if (!(error instanceof SattlemeError)) throw error;
      result = { error: error.code };
    }
    expect(result).toEqual(expected);
  });

  it("the default list", () => {
    expect(DEFAULT_RATE_SOURCES).toEqual(defaults);
  });

  it.each(values)("rateSource: $name", ({ rateSource, expected }) => {
    const absent = rateSource === undefined;
    // The sources a client asks: rateSourceOption's, the function its constructor reads the
    // option with; and the constructor takes the option, or refuses it with that error.
    expect(outcome(() => ({ sources: rateSourceOption(rateSource) }))).toEqual(expected);
    const constructed = outcome(() => {
      new Sattleme({
        key: appVectors.secretKey,
        ...(absent ? {} : { rateSource: rateSource as RateSource })
      });
      return "taken";
    });
    expect(constructed).toEqual("error" in (expected as object) ? expected : "taken");
    // An order: invalid_order, and the client's sources when it has none.
    const order = { ref: "A-1", fiat: { amount: "1", currency: "CHF" } };
    const checked = outcome(() =>
      checkOrder(absent ? order : { ...order, rateSource: rateSource as RateSource }, ["kraken"])
    );
    if ("error" in (expected as object)) {
      expect(checked).toEqual({ error: "invalid_order", param: "rateSource" });
    } else {
      expect((checked as { rateSources: unknown }).rateSources).toEqual(
        absent ? ["kraken"] : (expected as { sources: string[] }).sources
      );
    }
  });

  it.each(lists.cases)("a list: $name", async ({ sources, answers, expected }) => {
    const asked: string[] = [];
    const ask: typeof fetchRate = async (source, currency, context, now) => {
      const name = source as string;
      asked.push(name);
      const answer = answers[name];
      if (answer === "network") throw new NetworkError(`${name} is down`);
      if (answer === "rate") throw new RateError(`${name} gave no price`);
      if (answer === "unsupported_currency") throw new UnsupportedCurrencyError(currency, name);
      // The price, checked as a source's: §25.
      const got = await fetchRate(async () => answer as RateQuote, currency, context, now);
      return { ...got, info: { ...got.info, source: name } };
    };
    const warnings: string[] = [];
    let result: unknown;
    try {
      const { info } = await fetchFirstRate(
        sources as RateSource[],
        lists.currency,
        { fetch: globalThis.fetch, timeoutMs: 1000 },
        () => lists.now,
        { warn: (message) => warnings.push(message) },
        ask
      );
      result = { source: info.source, price: info.price, asked };
    } catch (error) {
      if (!(error instanceof SattlemeError)) throw error;
      result = { error: error.code, asked };
    }
    expect(result).toEqual(expected);
    // Each failure the next source replaces is logged, never the last one.
    expect(warnings).toHaveLength(asked.length - 1);
  });
});

describe("redirect-urls.json", () => {
  it.each(vectors("redirect-urls.json").cases)("$url", ({ url, expected }) => {
    const order = { ref: "A-1", sats: 1, checkout: true, redirectUrl: url };
    const result = outcome(() => checkOrder(order, []));
    if ("error" in expected) {
      expect(result).toEqual(expected);
      expect(redirectShown(url)).toBeNull();
    } else {
      expect(result).toMatchObject({ redirectUrl: url });
      expect({ shown: redirectShown(url) }).toEqual(expected);
    }
  });
});

describe("checkout-links.json", () => {
  const { origins, derivations, urls, fragments, records } = vectors("checkout-links.json");

  it.each(origins)("origin of $checkout", ({ checkout, expected }) => {
    expect(checkoutOriginOf(checkout)).toBe(expected);
    // Whatever it holds, the channel stays valid.
    const channel = {
      version: 1,
      status: "active",
      role: "integration",
      profile: { businessName: "Sunrise Bakery", lightningAddress: "a@breez.tips" },
      registryKey: "11".repeat(32),
      registryReader: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      checkout,
      updatedAt: 100
    };
    expect(parseChannel(channel, 100)).toMatchObject({ checkoutOrigin: expected });
  });

  it.each(derivations)("derives the keys of $linkKey", ({ linkKey, address, encryptionKey }) => {
    const keys = checkoutKeys(hexToBytes(linkKey));
    expect({ address: keys.address, encryptionKey: bytesToHex(keys.encryptionKey) }).toEqual({
      address,
      encryptionKey
    });
  });

  it.each(urls)("writes $url", ({ origin, author, linkKey, relays, url }) => {
    expect(checkoutUrl(origin, author, hexToBytes(linkKey), relays)).toBe(url);
  });

  it.each(fragments)("fragment: $name", ({ fragment, expected }) => {
    const read = parseCheckoutFragment(fragment);
    expect(
      read.status === "link"
        ? { author: read.author, linkKey: bytesToHex(read.linkKey), relays: read.relays }
        : read.status
    ).toEqual(expected);
  });

  it.each(records)("record: $name", ({ value, expected }) => {
    let read: unknown;
    try {
      const record = parseCheckoutValue(value);
      read = record
        ? {
            sats: record.sats.toString(),
            paymentHash: record.paymentHash,
            onchainAddress: record.onchainAddress,
            expiresAt: record.expiresAt,
            redirect: record.redirectShown,
            rest: record.rest && { author: record.rest.author, key: bytesToHex(record.rest.key) }
          }
        : "invalid";
    } catch (error) {
      if (!(error instanceof NewerRecordError)) throw error;
      read = "newer";
    }
    expect(read).toEqual(expected);
  });
});
