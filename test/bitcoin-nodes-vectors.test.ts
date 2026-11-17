import { describe, expect, it } from "vitest";

import { parseChannel } from "../src/channel.js";
import { checkoutValue, isCheckoutOrigin, parseCheckoutValue } from "../src/checkout.js";
import { NetworkError } from "../src/errors.js";
import type { HttpOptions } from "../src/http.js";
import { lightningAddressUrl } from "../src/lnurl.js";
import type { WebSocketLike } from "../src/nostr/relay.js";
import { Explorer, explorersToAsk, type ExplorerName } from "../src/onchain/explorer.js";
import { bitcoinNodeOf, parseNodeUrl, recordNodeFor } from "../src/onchain/node.js";
import { watchAddress } from "../src/onchain/watch.js";
import { MEMPOOL_URL, MEMPOOL_WEBSOCKET_URL, NODE_FAILED_RECENTLY_MS } from "../src/protocol.js";
import { isRelayUrl } from "../src/relays.js";
import { parseHttpsUrl } from "../src/urls.js";

import { depositAddress } from "./helpers/chain.js";
import { appVectors, readSpec } from "./helpers/vectors.js";

/*
 * The merchant's Bitcoin node against bitcoin-nodes.json (SPEC.md §31, "The merchant's Bitcoin
 * node"; §30, the record), through the package's own functions, as PORTING.md step 4 asks: its
 * `urls` through the check of a node URL and the URLs the node is read at, its `channels` through
 * the reading of the channel, its `reads` through the explorer's reads (REST, the two reads of a
 * check's step 1, and the WebSocket's connections), its `records` through the reading of a
 * checkout link's record, and its `writes` through the making of one. End to end:
 * test/bitcoin-node.test.ts.
 */

type Node = { url: string; fallback: string; payers: boolean };
const vectors = readSpec<{
  urls: { name: string; url: string; expected: { rest: string; webSocket: string } | null }[];
  channels: { name: string; value?: unknown; expected: Node | null }[];
  reads: {
    name: string;
    node: { fallback: "mempool" | "none"; failedRecently: boolean; answers: boolean } | null;
    mempoolAnswers: boolean;
    expected: { asked: ExplorerName[]; result: ExplorerName | "network" };
  }[];
  records: { name: string; value: Record<string, unknown>; expected: unknown }[];
  writes: { name: string; channel?: unknown; address: boolean; expected: unknown }[];
}>("vectors/bitcoin-nodes.json");

/** The app's channel, valid, with `bitcoinNode` set to `value` (absent: without the field). */
function channelWith(c: { value?: unknown }) {
  const { v } = appVectors.channel.value;
  const createdAt = appVectors.channel.event.created_at;
  const value: Record<string, unknown> = { ...v };
  delete value.bitcoinNode;
  if ("value" in c) value.bitcoinNode = c.value;
  return parseChannel(value, createdAt);
}

describe("bitcoin-nodes.json", () => {
  it.each(vectors.urls)("urls: $name", ({ url, expected }) => {
    const node = parseNodeUrl(url);
    expect(node && { rest: node.rest, webSocket: node.webSocket }).toEqual(expected);
  });

  it.each(vectors.channels)("channels: $name", (c) => {
    const channel = channelWith(c);
    // Valid either way: a node invalid in any way is none.
    expect(channel?.status).toBe("active");
    expect(channel?.status === "active" ? channel.bitcoinNode : undefined).toEqual(c.expected);
    expect(bitcoinNodeOf(c.value)).toEqual(c.expected);
  });

  describe("reads", () => {
    const NODE = "http://192.168.1.10:3006";
    const NOW = 1_791_378_000_000;

    /** The explorer of a case: its node failed 1 ms inside the 60 s when `failedRecently`. */
    function explorerOf(c: (typeof vectors.reads)[number]) {
      const failures = new Map<string, number>();
      if (c.node?.failedRecently) failures.set(NODE, NOW - NODE_FAILED_RECENTLY_MS + 1);
      const node = c.node && { url: NODE, fallback: c.node.fallback, payers: false };
      return new Explorer(node, failures, () => NOW);
    }

    const nameOf = (base: string): ExplorerName =>
      base === MEMPOOL_URL ? "mempool" : base === `${NODE}/api` ? "node" : (null as never);
    const answers = (c: (typeof vectors.reads)[number], name: ExplorerName) =>
      name === "node" ? c.node!.answers : c.mempoolAnswers;

    it.each(vectors.reads)("the explorers asked first: $name", (c) => {
      // explorersToAsk gives every explorer a read may ask; the read stops at the first answer.
      const order = explorersToAsk(
        c.node && { fallback: c.node.fallback, failedRecently: c.node.failedRecently }
      );
      expect(order.slice(0, c.expected.asked.length)).toEqual(c.expected.asked);
    });

    it.each(vectors.reads)("a REST read: $name", async (c) => {
      const asked: ExplorerName[] = [];
      const http = { fetch: globalThis.fetch, timeoutMs: 1000 } as HttpOptions;
      const result = await explorerOf(c)
        .read(http, async (base) => {
          const name = nameOf(base);
          asked.push(name);
          if (!answers(c, name)) throw new NetworkError(`${name} did not answer`);
          return name;
        })
        .catch((error: unknown) => {
          if (!(error instanceof NetworkError)) throw error;
          return "network";
        });
      expect({ asked, result }).toEqual(c.expected);
    });

    it.each(vectors.reads)("step 1, one read of two requests: $name", async (c) => {
      // The address's transactions and the chain's height, of one explorer: when either fails,
      // both are asked of the next one, never one from each.
      for (const failing of ["transactions", "height"]) {
        const asked: string[] = [];
        const http = { fetch: globalThis.fetch, timeoutMs: 1000 } as HttpOptions;
        const request = async (name: ExplorerName, what: string) => {
          asked.push(`${name} ${what}`);
          await Promise.resolve();
          if (!answers(c, name) && what === failing) throw new NetworkError(`${name} failed`);
          return name;
        };
        const result = await explorerOf(c)
          .read(http, async (base) => {
            const [txs, height] = await Promise.all([
              request(nameOf(base), "transactions"),
              request(nameOf(base), "height")
            ]);
            expect(txs).toBe(height);
            return txs;
          })
          .catch((error: unknown) => {
            if (!(error instanceof NetworkError)) throw error;
            return "network";
          });
        expect({ asked, result }).toEqual({
          asked: c.expected.asked.flatMap((name) => [`${name} transactions`, `${name} height`]),
          result: c.expected.result
        });
      }
    });

    it.each(vectors.reads)("a WebSocket's connection: $name", async (c) => {
      // A socket in memory: it answers (opens, then a message) or fails (an error, then closed).
      const asked: string[] = [];
      let connected: string | null = null;
      const watcher = watchAddress(
        (url) => {
          asked.push(url);
          const socket: WebSocketLike = {
            readyState: 0,
            onopen: null,
            onmessage: null,
            onerror: null,
            onclose: null,
            send: () => {},
            close: () => {}
          };
          const name = url === MEMPOOL_WEBSOCKET_URL ? "mempool" : "node";
          queueMicrotask(() => {
            if (answers(c, name)) {
              socket.onopen?.({} as never);
              socket.onmessage?.({ data: JSON.stringify({ block: {} }) } as never);
              connected = name;
            } else {
              socket.onerror?.({} as never);
              socket.onclose?.({} as never);
            }
          });
          return socket;
        },
        explorerOf(c),
        depositAddress(1),
        () => {}
      );
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      watcher.close();
      expect({
        asked: asked.map((url) =>
          url === MEMPOOL_WEBSOCKET_URL
            ? "mempool"
            : url === `ws://192.168.1.10:3006/api/v1/ws`
              ? "node"
              : url
        ),
        result: connected ?? "network"
      }).toEqual(c.expected);
    });
  });

  it.each(vectors.records)("records: $name", ({ value, expected }) => {
    const record = parseCheckoutValue(value);
    // Valid in every case: a node set aside leaves the record valid.
    expect(record).not.toBeNull();
    expect(record!.bitcoinNode).toEqual(expected);
  });

  it.each(vectors.writes)("writes: $name", (c) => {
    // The channel createInvoice read, then the record of its checkout link.
    const channel = channelWith({ ...("channel" in c ? { value: c.channel } : {}) });
    if (channel?.status !== "active") throw new Error("The channel is valid");
    const record = checkoutValue({
      businessName: "Sunrise Bakery",
      invoice: c.address ? null : appVectors.realInvoice.invoice,
      verifyUrl: c.address ? null : "https://breez.tips/lnurlp/verify/x",
      onchainAddress: c.address ? depositAddress(1) : null,
      sats: 150_000_000n,
      createdAt: 1_791_381_280,
      expiresAt: 1_791_382_180,
      fiat: null,
      note: "Order 1042",
      redirectUrl: null,
      rest: null,
      bitcoinNode: recordNodeFor(channel.bitcoinNode)
    });
    expect(record.version).toBe(c.address ? 2 : 1);
    // Absent, never null, when it has none.
    expect("bitcoinNode" in record).toBe(c.expected !== null);
    expect((record as { bitcoinNode?: unknown }).bitcoinNode ?? null).toEqual(c.expected);
  });

  it("leaves every other URL to its own rule: no http, no IP address (SPEC.md §15, §9, §30)", () => {
    // The node URLs only the node's rule allows: http, or an IPv4 host.
    const nodeOnly = vectors.urls
      .filter(({ expected }) => expected !== null)
      .map(({ url }) => url)
      .filter((url) => url.startsWith("http://") || /^https:\/\/[0-9.]+(?::|\/|$)/.test(url));
    expect(nodeOnly.length).toBeGreaterThan(15);
    for (const url of nodeOnly) {
      // An https URL (a pay request's callback, a verify URL, a redirect URL), a checkout origin,
      // a relay: refused.
      expect(parseHttpsUrl(url), url).toBeNull();
      expect(isCheckoutOrigin(url), url).toBe(false);
      expect(isRelayUrl(url.replace(/^http/, "ws")), url).toBe(false);
      // An IP address is never a relay's host, nor a Lightning address's.
      const host = /^https?:\/\/([^/:]+)/.exec(url)![1]!;
      if (/^[0-9.]+$/.test(host)) {
        expect(isRelayUrl(`wss://${host}`), url).toBe(false);
        expect(lightningAddressUrl(`sattleme@${host}`), url).toBeNull();
      }
    }
  });
});
