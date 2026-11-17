import { createServer } from "node:http";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { channelKeys, lotAddress } from "../src/derive.js";
import { getJson } from "../src/http.js";
import {
  ChannelNotFoundError,
  InvalidOptionError,
  InvalidOrderError,
  NetworkError,
  OrderPaidError,
  RateError,
  Sattleme,
  UnsupportedCurrencyError,
  type SattlemeOptions
} from "../src/index.js";
import { signEvent } from "../src/nostr/event.js";
import { recordsThatOpen } from "../src/nostr/record.js";
import { RelayPool, type Keep, type WebSocketLike } from "../src/nostr/relay.js";
import {
  addressTag,
  orderWitnessesOf,
  seenOf,
  witnessAddress,
  witnessEvent
} from "../src/onchain/witness.js";
import { fetchRate } from "../src/rates.js";
import { nodeWebSocket } from "../src/websocket.js";
import { depositAddress, txid } from "./helpers/chain.js";
import { answer, fakeFetch } from "./helpers/fetch.js";
import { PAY_URL, TestMerchant } from "./helpers/merchant.js";

/*
 * What the package refuses or bounds beyond the conformance vectors: options, JavaScript strings
 * that other languages cannot even hold, HTTP answers, a custom rate source that fails, a channel
 * whose reading key is off the curve, the fan-out of payment checks.
 */

const quiet = { warn: () => {} };
let merchant: TestMerchant;

beforeEach(async () => {
  merchant = await new TestMerchant().start();
  merchant.publishChannel(merchant.channelValue(100), 100);
});

afterEach(async () => {
  await merchant.stop();
});

function client(options: Partial<SattlemeOptions> = {}) {
  return new Sattleme({
    key: merchant.key,
    fetch: merchant.http.fetch,
    WebSocket: merchant.net.WebSocket,
    now: () => merchant.now * 1000,
    relayTimeoutMs: 1000,
    logger: quiet,
    ...options
  });
}

describe("options", () => {
  it.each([
    ["options", null],
    ["rateSource", { rateSource: "bitstamp" }],
    ["coingeckoApiKey", { coingeckoApiKey: 5 }],
    // 1 or more visible ASCII characters (SPEC.md §4): empty is invalid, not absent.
    ["coingeckoApiKey", { coingeckoApiKey: "" }],
    ["coingeckoApiKey", { coingeckoApiKey: "CG-key with a space" }],
    ["coingeckoApiKey", { coingeckoApiKey: "CG-clé" }],
    ["fetch", { fetch: "fetch" }],
    ["WebSocket", { WebSocket: {} }],
    ["relayTimeoutMs", { relayTimeoutMs: 3e9 }],
    ["relayTimeoutMs", { relayTimeoutMs: 0 }],
    ["httpTimeoutMs", { httpTimeoutMs: 1.5 }],
    ["httpTimeoutMs", { httpTimeoutMs: 60_001 }],
    ["logger", { logger: {} }],
    ["now", { now: 5 }],
    ["random", { random: "x" }]
  ])("refuses %s %j as an InvalidOptionError", (param, options) => {
    const error = (() => {
      try {
        return new Sattleme(
          options === null ? (null as never) : ({ key: merchant.key, ...options } as never)
        );
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(InvalidOptionError);
    expect((error as InvalidOptionError).param).toBe(param);
  });

  it("refuses an onStatus that is not a function, before any request", async () => {
    const invoice = await client().createInvoice({ ref: "O-2", sats: 1 });
    const error: unknown = await client()
      .waitForPayment(invoice, { onStatus: "log" as never })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOptionError);
    expect((error as InvalidOptionError).param).toBe("onStatus");
  });

  it("bounds waitForPayment's interval", async () => {
    const invoice = await client().createInvoice({ ref: "O-1", sats: 1 });
    for (const intervalMs of [100, 3e9, 1000.5]) {
      await expect(client().waitForPayment(invoice, { intervalMs })).rejects.toBeInstanceOf(
        InvalidOptionError
      );
    }
  });
});

describe("notes JavaScript can hold and other languages cannot", () => {
  it("refuses a lone surrogate", async () => {
    const error = await client()
      .createInvoice({ ref: "N-1", sats: 1, note: "Order \ud800" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOrderError);
    expect((error as InvalidOrderError).param).toBe("note");
  });

  it("counts a note in code points: 100 emojis fit", async () => {
    const invoice = await client().createInvoice({ ref: "N-2", sats: 1, note: "😀".repeat(100) });
    expect(invoice.note).toBe("😀".repeat(100));
    // 400 bytes in UTF-8: more than breez.tips's 255, so not sent as the comment.
    expect([...merchant.invoices.values()][0]!.comment).toBeNull();
  });
});

describe("HTTP answers", () => {
  it("follows no redirect", async () => {
    let redirect: RequestInit["redirect"];
    const fetch = (async (_url: string, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response("{}", { status: 302, headers: { location: "http://evil.example" } });
    }) as typeof globalThis.fetch;
    await expect(getJson("https://breez.tips/x", { fetch, timeoutMs: 1000 })).rejects.toThrow(
      /redirect \(HTTP 302\)/
    );
    expect(redirect).toBe("error");
  });

  it("drops a body larger than 1 MiB", async () => {
    const { fetch } = fakeFetch(() => ({ text: `"${"a".repeat(1 << 20)}"` }));
    await expect(getJson("https://breez.tips/x", { fetch, timeoutMs: 1000 })).rejects.toThrow(
      /more than 1048576 bytes/
    );
    const small = fakeFetch(() => ({ text: `"${"a".repeat(1000)}"` }));
    expect(
      (await getJson("https://breez.tips/x", { fetch: small.fetch, timeoutMs: 1000 })).body
    ).toBe("a".repeat(1000));
  });

  it("reads the Node stream of a node-fetch response, bounded as well", async () => {
    const nodeFetch = (text: string) =>
      (async () => ({
        status: 200,
        ok: true,
        // node-fetch's body is a Node Readable, not a WHATWG stream.
        body: Readable.from([Buffer.from(text.slice(0, 5)), Buffer.from(text.slice(5))])
      })) as unknown as typeof globalThis.fetch;
    const answer = await getJson("https://breez.tips/x", {
      fetch: nodeFetch('{"tag":"payRequest"}'),
      timeoutMs: 1000
    });
    expect(answer).toEqual({ status: 200, ok: true, body: { tag: "payRequest" } });
    await expect(
      getJson("https://breez.tips/x", {
        fetch: nodeFetch(`"${"a".repeat(1 << 20)}"`),
        timeoutMs: 1000
      })
    ).rejects.toThrow(/more than 1048576 bytes/);
  });

  it("reads a body that is not UTF-8 as no JSON", async () => {
    const fetch = (async () =>
      new Response(new Uint8Array([0x22, 0xff, 0x22]), { status: 200 })) as typeof globalThis.fetch;
    expect((await getJson("https://breez.tips/x", { fetch, timeoutMs: 1000 })).body).toBeNull();
  });
});

describe("a custom rate source", () => {
  const context = { fetch: fakeFetch(() => answer({}, 404)).fetch, timeoutMs: 1000 };

  it("turns its own errors into a RateError, with the cause", async () => {
    const cause = new TypeError("fetch failed");
    const error = await fetchRate(
      async () => {
        throw cause;
      },
      "CHF",
      context,
      1_791_378_000
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateError);
    expect((error as RateError).cause).toBe(cause);
  });

  it("keeps the package's errors it throws", async () => {
    for (const thrown of [new UnsupportedCurrencyError("XOF", "mine"), new NetworkError("down")]) {
      await expect(
        fetchRate(
          async () => {
            throw thrown;
          },
          "XOF",
          context,
          1_791_378_000
        )
      ).rejects.toBe(thrown);
    }
  });
});

describe("the channel", () => {
  it("is ignored when its reading key is off the curve", async () => {
    merchant.publishChannel(
      merchant.channelValue(200, { registryReader: "00".repeat(32) }),
      200,
      merchant.keyRelays
    );
    // The newest valid copy stands: the one of 100.
    await expect(client().merchant()).resolves.toMatchObject({ businessName: "Sunrise Bakery" });
    await merchant.stop();
    merchant = await new TestMerchant().start();
    merchant.publishChannel(merchant.channelValue(100, { registryReader: "00".repeat(32) }), 100);
    await expect(client().merchant()).rejects.toBeInstanceOf(ChannelNotFoundError);
  });
});

describe("the earlier invoices of an order", () => {
  it("are checked four at a time", async () => {
    const sattleme = client();
    for (let i = 0; i < 6; i += 1) {
      await sattleme.createInvoice({ ref: "E-1", sats: 1, durationSeconds: 60 });
      merchant.now += 60 + 120;
    }
    let running = 0;
    let most = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const verify = (input instanceof Request ? input.url : input.toString()).includes("/verify/");
      if (verify) {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      try {
        return await merchant.http.fetch(input, init);
      } finally {
        if (verify) running -= 1;
      }
    }) as typeof globalThis.fetch;
    await client({ fetch }).createInvoice({ ref: "E-1", sats: 1 });
    expect(most).toBe(4);
    expect(merchant.invoices.size).toBe(7);
  });
});

describe("what a call started ends when it returns", () => {
  // SPEC.md §13 and §4: once a call returned, nothing it started runs on, but a publication's
  // relays past its majority. Its HTTP requests asked at the same time as a read must end with it.

  /** The merchant's fetch, but the requests `held` takes never answer: each ends at its abort. */
  function holding(held: (url: string) => boolean) {
    const state = { asked: 0, open: 0 };
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!held(url)) return merchant.http.fetch(input, init);
      state.asked += 1;
      state.open += 1;
      return new Promise<Response>((_, reject) => {
        const signal = init!.signal!;
        const end = () => {
          state.open -= 1;
          reject(signal.reason);
        };
        if (signal.aborted) end();
        else signal.addEventListener("abort", end, { once: true });
      });
    }) as typeof globalThis.fetch;
    return { fetch, state };
  }

  it("merchant: the pay request, when the lot cannot be read", async () => {
    // Two relays of three never answer a read of the lot: fewer than a majority answered.
    const lot = lotAddress(merchant.integrationKey);
    for (const url of merchant.keyRelays.slice(1)) {
      merchant.net.get(url).behaviour = {
        muteQuery: (filter) => filter["#d"]?.includes(lot) === true
      };
    }
    const held = holding((url) => url === PAY_URL);
    await expect(client({ fetch: held.fetch }).merchant()).rejects.toBeInstanceOf(NetworkError);
    expect(held.state).toEqual({ asked: 1, open: 0 });
  });

  it("createInvoice: the pay request and the rate, when an earlier invoice was paid", async () => {
    const paid = await client().createInvoice({ ref: "H-1", sats: 1000 });
    merchant.payInvoice(paid.paymentHash!);
    const held = holding((url) => url === PAY_URL);
    const warnings: string[] = [];
    let rateAborted = false;
    let secondAsked = false;
    // The first source would fail after 1.5 s, the list then trying the second (with a warning).
    const slow = (_currency: string, { signal }: { signal?: AbortSignal | undefined }) =>
      new Promise<string>((_, reject) => {
        const timer = setTimeout(() => reject(new NetworkError("No answer")), 1500);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          rateAborted = true;
          reject(signal.reason);
        });
      });
    const second = async () => {
      secondAsked = true;
      return "69012";
    };
    await expect(
      client({
        fetch: held.fetch,
        httpTimeoutMs: 2000,
        logger: { warn: (message: string) => warnings.push(message) }
      }).createInvoice({
        ref: "H-1",
        fiat: { amount: "24.50", currency: "CHF" },
        rateSource: [slow, second]
      })
    ).rejects.toBeInstanceOf(OrderPaidError);
    expect(held.state).toEqual({ asked: 1, open: 0 });
    expect(rateAborted).toBe(true);
    // Past the first source's failure: nothing more was asked, nothing logged.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(secondAsked).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("getStatus: the explorer's height, when its list of the address's transactions failed", async () => {
    const address = depositAddress("held");
    merchant.publishLot([address], 91);
    // Above the Lightning address's bounds: on-chain only.
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const invoice = await client().createInvoice({ ref: "H-2", sats: 49_000 });
    expect(invoice.onchainAddress).toBe(address);
    merchant.override = (url) =>
      url.href.endsWith(`/address/${address}/txs`) ? { status: 503, text: "down" } : undefined;
    const held = holding((url) => url.endsWith("/blocks/tip/height"));
    await expect(client({ fetch: held.fetch }).getStatus(invoice)).rejects.toBeInstanceOf(
      NetworkError
    );
    expect(held.state).toEqual({ asked: 1, open: 0 });
  });
});

describe("relays", () => {
  /** A pool of one call over `createSocket`, closed after `run`. */
  async function withPool<T>(
    createSocket: (url: string) => WebSocketLike,
    run: (pool: RelayPool) => Promise<T>
  ): Promise<T> {
    const pool = new RelayPool({ createSocket, timeoutMs: 2000, now: () => merchant.now });
    try {
      return await run(pool);
    } finally {
      pool.close();
    }
  }

  it("asks nothing more of a relay a read went on without, even once its authentication ends", async () => {
    // SPEC.md §13: the relays a read drops when it goes on end their requests and ask nothing more
    // (no page, no authentication); here the third relay's authentication ends after the read went
    // on, which must neither draw a subscription id nor send the query again.
    // The two that answer do so once the third asked for authentication and was sent it.
    const fast = ["wss://answers-1.test", "wss://answers-2.test"];
    for (const url of fast) await merchant.net.add(url, { queryDelayMs: 150 });
    const slow = await merchant.net.add("wss://authenticates-late.test", {
      requireAuth: true,
      authDelayMs: 600
    });
    let wentOn = false;
    let drawnAfter = 0;
    const socket = merchant.net.WebSocket;
    const pool = new RelayPool({
      createSocket: (url) => new socket(url),
      timeoutMs: 2000,
      now: () => merchant.now,
      random: (length) => {
        if (wentOn) drawnAfter += 1;
        return globalThis.crypto.getRandomValues(new Uint8Array(length));
      }
    });
    try {
      const read = await pool.queryRelays(
        [...fast, "wss://authenticates-late.test"],
        { kinds: [30078] },
        new Uint8Array(32).fill(7),
        { paged: false, keep: (value) => value }
      );
      wentOn = true;
      expect(read.answered).toBe(true);
      expect(slow.queries).toHaveLength(1);
      // Its authentication is answered meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(slow.authenticated).toHaveLength(1);
      expect(slow.queries).toHaveLength(1);
      expect(drawnAfter).toBe(0);
    } finally {
      pool.close();
    }
  });

  it("ends a failed publication's requests: none authenticates nor writes again", async () => {
    // SPEC.md §13: only a publication's relays past its majority may finish their own request after
    // it; one that failed (two relays of three refused) ends the third's at once. The third asks for
    // authentication and answers it 600 ms later: a request still running would then write the
    // event again. Whether the third got the event at all depends on which came first, its write
    // or the refusals: once, or not at all.
    const refusing = ["wss://refuses-1.test", "wss://refuses-2.test"];
    for (const url of refusing) await merchant.net.add(url, { refuse: "blocked: not here" });
    const late = await merchant.net.add("wss://authenticates-late.test", {
      requireAuth: true,
      authDelayMs: 600
    });
    const socket = merchant.net.WebSocket;
    const pool = new RelayPool({
      createSocket: (url) => new socket(url),
      timeoutMs: 2000,
      now: () => merchant.now
    });
    const event = signEvent(
      { kind: 30078, created_at: merchant.now, tags: [["d", "a"]], content: "" },
      new Uint8Array(32).fill(5)
    );
    try {
      await expect(
        pool.publishToQuorum(
          [...refusing, "wss://authenticates-late.test"],
          event,
          new Uint8Array(32).fill(7),
          2
        )
      ).rejects.toThrow("Fewer than 2 relays took the event");
      // Its authentication, if it was sent, is answered meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(late.received.length).toBeLessThanOrEqual(1);
    } finally {
      pool.close();
    }
  });

  it("ends its reads when the call is done, while a relay's authentication runs", async () => {
    // A call that fails (its Lightning address did not answer…) while a read is under way releases
    // its pool: the read ends there, and its relays are asked nothing more once their
    // authentication ends (SPEC.md §13); only a publication's relays past its majority go on.
    const urls = ["wss://auth-late-1.test", "wss://auth-late-2.test", "wss://auth-late-3.test"];
    const late = await Promise.all(
      urls.map((url) => merchant.net.add(url, { requireAuth: true, authDelayMs: 600 }))
    );
    let released = false;
    let drawnAfter = 0;
    const socket = merchant.net.WebSocket;
    const pool = new RelayPool({
      createSocket: (url) => new socket(url),
      timeoutMs: 2000,
      now: () => merchant.now,
      random: (length) => {
        if (released) drawnAfter += 1;
        return globalThis.crypto.getRandomValues(new Uint8Array(length));
      }
    });
    try {
      const read = pool.queryRelays(urls, { kinds: [30078] }, new Uint8Array(32).fill(7), {
        paged: false,
        keep: (value) => value
      });
      // Every relay asked for authentication and was sent it; none answered it yet.
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const relay of late) expect(relay.queries).toHaveLength(1);
      released = true;
      pool.release();
      expect((await read).answered).toBe(false);
      // Their authentications are answered meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 900));
      for (const relay of late) expect(relay.queries).toHaveLength(1);
      expect(drawnAfter).toBe(0);
    } finally {
      pool.close();
    }
  });

  it("never follows a redirect of the WebSocket handshake: a failed connection", async () => {
    // Where the redirect points: a relay that would answer.
    const target = await merchant.net.add("wss://target.test");
    const targetUrl = `ws://127.0.0.1:${target.port}`;
    const redirect = createServer((_, response) => {
      response.writeHead(302, { Location: targetUrl }).end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    const { port } = redirect.address() as { port: number };
    try {
      const started = Date.now();
      const answers = await withPool(
        () => nodeWebSocket(`ws://127.0.0.1:${port}`, 2000),
        (pool) =>
          pool.queryRelays(["wss://relay.test"], { kinds: [30078] }, new Uint8Array(32).fill(7), {
            paged: false,
            keep: (value) => value
          })
      );
      expect(answers.answers.size).toBe(0);
      expect(answers.answered).toBe(false);
      // Failed at the redirect, not at the timeout; the target never asked.
      expect(Date.now() - started).toBeLessThan(1500);
      expect(target.queries).toEqual([]);
    } finally {
      redirect.close();
    }
  });

  it("sends the User-Agent of every request in the WebSocket handshake", async () => {
    // Relays behind a bot protection (Cloudflare's, nostr.wine's) refuse a handshake without one.
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const sent = new Promise<string | undefined>((resolve) =>
      server.once("connection", (_, request) => resolve(request.headers["user-agent"]))
    );
    const { port } = server.address() as { port: number };
    const socket = nodeWebSocket(`ws://127.0.0.1:${port}`, 2000);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("connection failed"));
      });
      expect(await sent).toBe("sattleme-Checkout/1");
    } finally {
      socket.close();
      for (const client of server.clients) client.terminate();
      server.close();
    }
  });

  it("offers no WebSocket compression (permessage-deflate)", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: true });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const offered = new Promise<string | undefined>((resolve) =>
      server.once("connection", (_, request) =>
        resolve(request.headers["sec-websocket-extensions"])
      )
    );
    const { port } = server.address() as { port: number };
    const socket = nodeWebSocket(`ws://127.0.0.1:${port}`, 2000);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("connection failed"));
      });
      expect(await offered).toBeUndefined();
      expect((socket as unknown as { extensions: string }).extensions).toBe("");
    } finally {
      socket.close();
      for (const client of server.clients) client.terminate();
      server.close();
    }
  });

  it("keeps of what a relay sends only what the read keeps, and still pages through the rest", async () => {
    const relay = merchant.net.get(merchant.keyRelays[0]!);
    const filler = "x".repeat(60_000);
    for (let i = 0; i < 300; i += 1) {
      relay.store({
        id: i.toString(16).padStart(64, "0"),
        pubkey: "ab".repeat(32),
        created_at: 1_000_000 - i,
        kind: 30078,
        tags: [["d", "cd".repeat(32)]],
        content: filler,
        sig: "00".repeat(64)
      });
    }
    const wanted = "0".repeat(62) + "ff";
    const read = (paged: boolean) =>
      withPool(
        (url) => new merchant.net.WebSocket(url),
        (pool) =>
          pool.queryRelays([merchant.keyRelays[0]!], { kinds: [30078] }, new Uint8Array(32), {
            paged,
            keep: (value) => ((value as { id?: unknown }).id === wanted ? value : undefined)
          })
      );
    for (const paged of [false, true]) {
      const { answers } = await read(paged);
      expect(answers.get(merchant.keyRelays[0]!)).toEqual([
        expect.objectContaining({ id: wanted, content: filler })
      ]);
    }
    // A complete read: 300 events in pages of 100, one kept; the read complete.
    const complete = await withPool(
      (url) => new merchant.net.WebSocket(url),
      (pool) =>
        pool.queryComplete([merchant.keyRelays[0]!], { kinds: [30078] }, new Uint8Array(32), {
          keep: (value) => ((value as { id?: unknown }).id === wanted ? value : undefined)
        })
    );
    expect(complete.complete).toBe(true);
    expect(complete.answers.get(merchant.keyRelays[0]!)).toHaveLength(1);
    expect(relay.queries.filter((filter) => filter.limit === 100)).toHaveLength(4);
  });

  it("reads a relay's copies of one event once, and keeps nothing a relay adds to it", async () => {
    const url = "wss://copies.test";
    const relay = await merchant.net.add(url);
    const event = merchant.channelEvent(merchant.channelValue(100), 100);
    // Copies that check out: the id and the signature cover none of what a relay adds.
    for (let i = 0; i < 50; i += 1) relay.store({ ...event, padding: "x".repeat(100_000) });
    const { encryptionKey } = channelKeys(merchant.integrationKey);
    const open = recordsThatOpen(() => encryptionKey);
    let opened = 0;
    const keep: Keep = (value) => {
      opened += 1;
      return open(value);
    };
    const reads: ((pool: RelayPool) => Promise<{ answers: Map<string, unknown[]> }>)[] = [
      (pool) =>
        pool.queryRelays([url], { kinds: [30078] }, new Uint8Array(32), {
          paged: false,
          keep
        }),
      (pool) =>
        pool.queryRelays([url], { kinds: [30078] }, new Uint8Array(32), {
          paged: true,
          keep
        }),
      (pool) => pool.queryComplete([url], { kinds: [30078] }, new Uint8Array(32), { keep })
    ];
    for (const read of reads) {
      opened = 0;
      const asked = relay.queries.length;
      const { answers } = await withPool(
        (socketUrl) => new merchant.net.WebSocket(socketUrl),
        read
      );
      expect(answers.get(url)).toStrictEqual([event]);
      // One opening per query that sent the copies (a paged read asks their second again).
      const sent = relay.queries
        .slice(asked)
        .filter((filter) => filter.until === undefined || filter.until >= event.created_at);
      expect(opened).toBe(sent.length);
    }
  });
});

describe("the witnesses of an invoice", () => {
  const seen = seenOf(new Uint8Array(32).fill(2));
  const address = depositAddress("this");
  const elsewhere = depositAddress("elsewhere");
  const sale = "ab".repeat(32);
  const expiresAt = 1_791_379_180;
  const witness = (of: string, tx: string, ofSale: string | null) =>
    witnessEvent(
      seen,
      {
        address: of,
        txid: txid(tx),
        sale: ofSale,
        sats: 1000n,
        inputs: [],
        replacement: false,
        expiresAt: ofSale === null ? null : expiresAt
      },
      1_791_378_400
    );
  /** A record of a newer format (its content `#`) at the witness address of `tx` at `of`. */
  const newer = (of: string, tx: string, tags: string[][], sign = true) => {
    const template = {
      kind: 30078,
      created_at: 1_791_378_400,
      tags: [["d", witnessAddress(seen.addressKey, of, txid(tx), sale)], ...tags],
      content: "#"
    };
    const event = signEvent(template, seen.secretKey);
    return sign ? event : { ...event, sig: "00".repeat(64) };
  };
  const read = (events: unknown[]) => orderWitnessesOf(events, seen, address, sale, expiresAt);

  it("reads those of this read: of the sale, of none, of another sale at the address", () => {
    const witnesses = read([
      witness(address, "mine", sale),
      witness(address, "none", null),
      witness(address, "another's", "cd".repeat(32))
    ]);
    expect([...witnesses.sale.keys()]).toEqual([txid("mine")]);
    expect([...witnesses.none]).toEqual([txid("none")]);
    expect([...witnesses.others.keys()]).toEqual([txid("another's")]);
  });

  it("ignores a witness at another address: a transaction paying two orders pays each its part", () => {
    const witnesses = read([witness(elsewhere, "batch", "cd".repeat(32))]);
    expect([witnesses.sale.size, witnesses.others.size, witnesses.none.size]).toEqual([0, 0, 0]);
  });

  it("keeps a witness of a newer format only with the read's tags and the author's signature", () => {
    const tag = [["o", addressTag(seen.addressKey, address)]];
    const otherTag = [["o", addressTag(seen.addressKey, elsewhere)]];
    expect(read([newer(address, "t", tag)]).newer.size).toBe(1);
    // Another address's, which a relay sends against the filter: of no invoice of this read.
    expect(read([newer(address, "t", otherTag)]).newer.size).toBe(0);
    // Without the seen secret's signature: nothing (SPEC.md §12), not an undecided payment.
    expect(read([newer(address, "t", tag, false)]).newer.size).toBe(0);
  });
});
