import { describe, expect, it } from "vitest";

import {
  InvalidOrderError,
  NetworkError,
  RATE_SOURCES,
  RateError,
  UnsupportedCurrencyError,
  currencyDigits,
  fiatToSats,
  type RateSource
} from "../src/index.js";
import {
  fetchFirstRate,
  fetchRate,
  formatDecimal,
  parseDecimal,
  parseFiat,
  rateSourceList
} from "../src/rates.js";

import { answer, fakeFetch, type JsonAnswer } from "./helpers/fetch.js";

const NOW = 1_791_385_300;

function context(route: (url: URL) => JsonAnswer) {
  const http = fakeFetch(route);
  return { http, context: { fetch: http.fetch, timeoutMs: 1000 } };
}

async function priceOf(
  source: RateSource,
  currency: string,
  route: (url: URL) => JsonAnswer,
  coingeckoApiKey?: string
) {
  const { http, context: ctx } = context(route);
  const quote = await fetchRate(source, currency, { ...ctx, coingeckoApiKey }, NOW);
  return { info: quote.info, calls: http.calls };
}

describe("exact conversion", () => {
  it("rounds up to the next whole sat: 24.50 CHF at 69 012 CHF/BTC", () => {
    // ⌈2450 × 10^8 / 6 901 200⌉: the exact quotient is 35 501.07…
    const exact = (2450n * 100_000_000n) / 6_901_200n;
    expect(exact).toBe(35_501n);
    expect((2450n * 100_000_000n) % 6_901_200n).not.toBe(0n);
    expect(fiatToSats({ amount: "24.50", currency: "CHF" }, "69012")).toBe(35_502n);
    expect(fiatToSats({ amount: "24.5", currency: "CHF" }, "69012.000")).toBe(35_502n);
  });

  it("gives exactly the quotient when it is whole", () => {
    // 1 CHF at 100 000 CHF/BTC: 1000 sats exactly.
    expect(fiatToSats({ amount: "1.00", currency: "CHF" }, "100000")).toBe(1000n);
  });

  it("reads a price as its exact decimal, a Coinbase string with 16 decimals included", () => {
    const price = "69025.1084416666694295";
    expect(formatDecimal(parseDecimal(price)!)).toBe(price);
    // ⌈2450 × 10^8 × 10^16 / (690251084416666694295 × 10^2)⌉, on integers.
    const dividend = 2450n * 100_000_000n * 10n ** 16n;
    const divisor = 690251084416666694295n * 100n;
    expect(fiatToSats({ amount: "24.50", currency: "CHF" }, price)).toBe(
      (dividend + divisor - 1n) / divisor
    );
  });

  it("reads exponent notation", () => {
    expect(parseDecimal("8e-8")).toEqual({ units: 8n, scale: 8 });
    expect(formatDecimal(parseDecimal("8e-8")!)).toBe("0.00000008");
    expect(parseDecimal("1.5e+21")).toEqual({ units: 1_500_000_000_000_000_000_000n, scale: 0 });
    expect(parseDecimal("6.9012e4")).toEqual({ units: 69012n, scale: 0 });
    expect(parseDecimal("69012.50")).toEqual({ units: 690125n, scale: 1 });
  });

  it.each([
    0,
    69012,
    Number.NaN,
    "0",
    "0.000",
    "-69012",
    "",
    "abc",
    "1,5",
    " ",
    " 69012",
    "69012\n",
    "0x10",
    "1e65",
    "1".repeat(65)
  ])("refuses the price %s", (price) => {
    expect(parseDecimal(price)).toBeNull();
    expect(() => fiatToSats({ amount: "1", currency: "CHF" }, price as string)).toThrow(RateError);
  });

  it("takes the currency's decimals from its table, whatever the platform's locale data", () => {
    expect(currencyDigits("CHF")).toBe(2);
    expect(currencyDigits("JPY")).toBe(0);
    expect(currencyDigits("BHD")).toBe(3);
    // The app's decimals (Intl), not ISO 4217's 2: the app leaves out sales of other decimals.
    expect(currencyDigits("RSD")).toBe(0);
    // Not currencies an order is priced in: any three letters, a fund, gold, bitcoin, lower case.
    for (const code of ["ABC", "CHE", "XAU", "XXX", "BTC", "SAT", "chf", "hasOwnProperty"]) {
      expect(currencyDigits(code)).toBeNull();
    }
    expect(parseFiat({ amount: "1500", currency: "JPY" })).toEqual({
      amount: "1500",
      currency: "JPY",
      minor: "1500",
      digits: 0
    });
    expect(parseFiat({ amount: "24.500", currency: "CHF" })).toMatchObject({
      amount: "24.50",
      currency: "CHF",
      minor: "2450"
    });
  });

  it.each([
    [{ amount: "24.505", currency: "CHF" }],
    [{ amount: "1.5", currency: "JPY" }],
    [{ amount: "0", currency: "CHF" }],
    [{ amount: "0.00", currency: "CHF" }],
    [{ amount: "-1", currency: "CHF" }],
    [{ amount: "1e3", currency: "CHF" }],
    [{ amount: 24.5, currency: "CHF" }],
    [{ amount: "24.50", currency: "SAT" }],
    [{ amount: "24.50", currency: "CHFX" }],
    [{ amount: "99999999999999999", currency: "CHF" }]
  ])("refuses the price %j", (fiat) => {
    expect(() => parseFiat(fiat as { amount: string; currency: string })).toThrow(
      InvalidOrderError
    );
  });
});

describe("rate sources", () => {
  it("knows its sources by name", () => {
    expect(RATE_SOURCES).toEqual(["coingecko", "mempool", "opennode", "coinbase", "kraken"]);
  });

  it("CoinGecko, dated, with or without a Demo key", async () => {
    const route = (url: URL) =>
      url.pathname.endsWith("/simple/price")
        ? answer({ bitcoin: { chf: 69012, last_updated_at: NOW - 30 } })
        : answer({}, 404);
    const free = await priceOf("coingecko", "CHF", route);
    expect(free.info).toEqual({
      source: "coingecko",
      currency: "CHF",
      price: "69012",
      fetchedAt: NOW,
      time: NOW - 30
    });
    expect(free.calls[0]!.url.href).toBe(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=chf&include_last_updated_at=true"
    );
    expect(free.calls[0]!.headers["x-cg-demo-api-key"]).toBeUndefined();
    // CoinGecko answers HTTP 403 to a request without a User-Agent (SPEC.md §15).
    expect(free.calls[0]!.headers["User-Agent"]).toBe("sattleme-Checkout/1");
    const demo = await priceOf("coingecko", "CHF", route, "demo");
    expect(demo.calls[0]!.headers["x-cg-demo-api-key"]).toBe("demo");
    expect(demo.calls[0]!.headers["User-Agent"]).toBe("sattleme-Checkout/1");
    await expect(priceOf("coingecko", "XYZ", () => answer({ bitcoin: {} }))).rejects.toBeInstanceOf(
      UnsupportedCurrencyError
    );
    await expect(priceOf("coingecko", "CHF", () => answer({ nope: 1 }))).rejects.toBeInstanceOf(
      RateError
    );
  });

  it("mempool.space, dated, its 7 currencies", async () => {
    const body = {
      time: NOW - 60,
      USD: 82977,
      EUR: 74000,
      GBP: 63000,
      CAD: 118000,
      CHF: 69080,
      AUD: 119000,
      JPY: 13187638
    };
    const { info, calls } = await priceOf("mempool", "CHF", () => answer(body));
    expect(info).toMatchObject({ source: "mempool", price: "69080", time: NOW - 60 });
    expect(calls[0]!.url.href).toBe("https://mempool.space/api/v1/prices");
    await expect(priceOf("mempool", "SEK", () => answer(body))).rejects.toBeInstanceOf(
      UnsupportedCurrencyError
    );
    await expect(
      priceOf("mempool", "CHF", () => answer({ ...body, time: undefined }))
    ).rejects.toBeInstanceOf(RateError);
  });

  it("OpenNode", async () => {
    const body = {
      data: {
        BTCCHF: { CHF: 68991.16, BTC: 0.00001449 },
        BTCJPY: { JPY: 13185808.44, BTC: 8e-8 }
      }
    };
    const { info, calls } = await priceOf("opennode", "CHF", () => answer(body));
    expect(info.price).toBe("68991.16");
    expect(calls[0]!.url.href).toBe("https://api.opennode.com/v1/rates");
    await expect(priceOf("opennode", "SEK", () => answer(body))).rejects.toBeInstanceOf(
      UnsupportedCurrencyError
    );
    await expect(priceOf("opennode", "CHF", () => answer({ data: [] }))).rejects.toBeInstanceOf(
      RateError
    );
  });

  it("Coinbase, its decimal strings kept as written", async () => {
    const body = {
      data: { currency: "BTC", rates: { CHF: "69025.1084416666694295", USD: "83000.1" } }
    };
    const { info, calls } = await priceOf("coinbase", "CHF", () => answer(body));
    expect(info.price).toBe("69025.1084416666694295");
    expect(calls[0]!.url.href).toBe("https://api.coinbase.com/v2/exchange-rates?currency=BTC");
    await expect(priceOf("coinbase", "SEK", () => answer(body))).rejects.toBeInstanceOf(
      UnsupportedCurrencyError
    );
    await expect(
      priceOf("coinbase", "CHF", () => answer({ data: { ...body.data, currency: "ETH" } }))
    ).rejects.toBeInstanceOf(RateError);
  });

  it("Kraken, whatever the result's key, its errors read", async () => {
    const ticker = (key: string) =>
      answer({ error: [], result: { [key]: { c: ["69050.00000", "0.1"], a: ["1"] } } });
    const chf = await priceOf("kraken", "CHF", () => ticker("XBTCHF"));
    expect(chf.info.price).toBe("69050");
    expect(chf.calls[0]!.url.href).toBe("https://api.kraken.com/0/public/Ticker?pair=XBTCHF");
    const usd = await priceOf("kraken", "USD", () => ticker("XXBTZUSD"));
    expect(usd.info.price).toBe("69050");
    await expect(
      priceOf("kraken", "ZZZ", () => answer({ error: ["EQuery:Unknown asset pair"] }))
    ).rejects.toBeInstanceOf(UnsupportedCurrencyError);
    await expect(
      priceOf("kraken", "CHF", () => answer({ error: ["EService:Unavailable"] }))
    ).rejects.toBeInstanceOf(RateError);
    await expect(
      priceOf("kraken", "CHF", () =>
        answer({ error: [], result: { A: { c: ["1"] }, B: { c: ["2"] } } })
      )
    ).rejects.toBeInstanceOf(RateError);
  });

  it("refuses a name it does not know", async () => {
    await expect(priceOf("bitstamp" as RateSource, "CHF", () => answer({}))).rejects.toBeInstanceOf(
      RateError
    );
  });

  it("a custom source: a string or a dated price, never a number", async () => {
    const none = () => answer({}, 404);
    expect((await priceOf(async () => "70000.5", "CHF", none)).info).toEqual({
      source: "custom",
      currency: "CHF",
      price: "70000.5",
      fetchedAt: NOW,
      time: null
    });
    // A number may already have lost digits: refused.
    await expect(
      priceOf(async () => 70000 as unknown as string, "CHF", none)
    ).rejects.toBeInstanceOf(RateError);
    const dated = await priceOf(async () => ({ price: "70000", time: NOW - 5 }), "CHF", none);
    expect(dated.info.time).toBe(NOW - 5);
    for (const bad of [0, -5, "abc", Infinity, null]) {
      await expect(
        priceOf(async () => bad as unknown as string, "CHF", none)
      ).rejects.toBeInstanceOf(RateError);
    }
    await expect(
      priceOf(
        async (currency) => {
          throw new UnsupportedCurrencyError(currency, "mine");
        },
        "CHF",
        none
      )
    ).rejects.toBeInstanceOf(UnsupportedCurrencyError);
  });

  it("refuses a price older than an hour, or dated in the future", async () => {
    const none = () => answer({}, 404);
    const dated = (time: number) => async () => ({ price: "69000", time });
    expect((await priceOf(dated(NOW - 3600), "CHF", none)).info.time).toBe(NOW - 3600);
    await expect(priceOf(dated(NOW - 3601), "CHF", none)).rejects.toBeInstanceOf(RateError);
    await expect(priceOf(dated(NOW + 3600), "CHF", none)).rejects.toBeInstanceOf(RateError);
  });

  it("an HTTP failure is a network error, retryable", async () => {
    await expect(priceOf("coinbase", "CHF", () => answer({}, 503))).rejects.toBeInstanceOf(
      NetworkError
    );
    await expect(
      priceOf("coinbase", "CHF", () => {
        throw new TypeError("fetch failed");
      })
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("lists of rate sources", () => {
  const ctx = { fetch: globalThis.fetch, timeoutMs: 1000 };
  const now = () => NOW;
  const quiet = { warn: () => {} };

  it("keeps a list of functions and names in its order, a function alone too", () => {
    const mine = async () => "1";
    expect(rateSourceList(mine)).toEqual([mine]);
    expect(rateSourceList([mine, "kraken", mine])).toEqual([mine, "kraken", mine]);
    expect(rateSourceList(["kraken", mine, "kraken"])).toBeNull();
  });

  it("asks custom sources one at a time, and logs each failure replaced", async () => {
    const asked: string[] = [];
    const source =
      (name: string, run: () => Promise<string>): RateSource =>
      async () => {
        asked.push(name);
        return run();
      };
    const warnings: string[] = [];
    const { info } = await fetchFirstRate(
      [
        source("a", () => Promise.reject(new NetworkError("down"))),
        source("b", () => Promise.reject(new Error("broken"))),
        source("c", () => Promise.resolve("69012.50")),
        source("d", () => Promise.resolve("1"))
      ],
      "CHF",
      ctx,
      now,
      { warn: (message) => warnings.push(message) }
    );
    expect(info).toMatchObject({ source: "custom", price: "69012.5" });
    expect(asked).toEqual(["a", "b", "c"]);
    expect(warnings).toEqual([
      "Rate source custom failed (network): down; trying custom",
      "Rate source custom failed (rate): The custom rate source failed; trying custom"
    ]);
  });

  it("stops at a cancellation, and at an error of another kind", async () => {
    const controller = new AbortController();
    let second = false;
    const list: RateSource[] = [
      async () => {
        controller.abort(new Error("left"));
        throw new NetworkError("down");
      },
      async () => {
        second = true;
        return "1";
      }
    ];
    await expect(
      fetchFirstRate(list, "CHF", { ...ctx, signal: controller.signal }, now, quiet)
    ).rejects.toThrow("left");
    expect(second).toBe(false);
    const invalid = new InvalidOrderError("fiat", "not for this shop");
    await expect(
      fetchFirstRate(
        [
          async () => {
            throw invalid;
          },
          list[1]!
        ],
        "CHF",
        ctx,
        now,
        quiet
      )
    ).rejects.toBe(invalid);
    expect(second).toBe(false);
  });

  it("keeps a single source's own error", async () => {
    const own = new UnsupportedCurrencyError("XAF", "mine");
    await expect(
      fetchFirstRate(
        [
          async () => {
            throw own;
          }
        ],
        "XAF",
        ctx,
        now,
        quiet
      )
    ).rejects.toBe(own);
  });
});
