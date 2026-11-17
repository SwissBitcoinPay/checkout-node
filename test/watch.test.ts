import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebSocketLike } from "../src/nostr/relay.js";
import { Explorer } from "../src/onchain/explorer.js";
import { watchAddress } from "../src/onchain/watch.js";
import { MEMPOOL_WEBSOCKET_URL } from "../src/protocol.js";

import { depositAddress } from "./helpers/chain.js";

/*
 * The explorer's WebSocket while waitForPayment waits (SPEC.md, "Waiting for an on-chain
 * payment"): a lost socket connects again after 1 s, doubled at each failure up to 30 s, a
 * connection lost before it received a message being a failure. Each connection starts a full
 * check: a server that accepts and drops every connection must not have one every second.
 */

/** A socket in memory, opened, answered and dropped by the test. */
class MemorySocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: never) => void) | null = null;
  onmessage: ((event: never) => void) | null = null;
  onerror: ((event: never) => void) | null = null;
  onclose: ((event: never) => void) | null = null;
  readonly sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({} as never);
  }

  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as never);
  }

  drop() {
    this.readyState = 3;
    this.onclose?.({} as never);
  }
}

const ADDRESS = depositAddress(1);
let sockets: MemorySocket[];
let urls: string[];

/** Watches ADDRESS on `explorer`'s WebSockets (mempool.space's by default). */
function watch(
  onChange: () => void = () => {},
  explorer = new Explorer(null, new Map(), () => Date.now())
) {
  return watchAddress(
    (url) => {
      urls.push(url);
      const socket = new MemorySocket();
      sockets.push(socket);
      return socket;
    },
    explorer,
    ADDRESS,
    onChange
  );
}

/** Whether a new connection starts exactly `ms` after now (none before). */
function connectsAfter(ms: number): boolean {
  const before = sockets.length;
  vi.advanceTimersByTime(ms - 1);
  if (sockets.length !== before) return false;
  vi.advanceTimersByTime(1);
  return sockets.length === before + 1;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  urls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the explorer's WebSocket", () => {
  it("tracks the address and checks at each connection", () => {
    const onChange = vi.fn();
    const watcher = watch(onChange);
    expect(urls).toEqual([MEMPOOL_WEBSOCKET_URL]);
    sockets[0]!.open();
    expect(sockets[0]!.sent.map((text) => JSON.parse(text) as unknown)).toEqual([
      { action: "want", data: ["blocks"] },
      { "track-address": ADDRESS }
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);
    sockets[0]!.message({ block: { height: 970_001 } });
    expect(onChange).toHaveBeenCalledTimes(2);
    watcher.close();
  });

  it("waits longer at each connection dropped before a message: 1 s, doubled up to 30 s", () => {
    const onChange = vi.fn();
    const watcher = watch(onChange);
    for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      sockets.at(-1)!.open();
      sockets.at(-1)!.drop();
      expect(connectsAfter(delay)).toBe(true);
    }
    // One check per connection: eight in some 91 s, never one a second.
    sockets.at(-1)!.open();
    expect(onChange).toHaveBeenCalledTimes(8);
    watcher.close();
  });

  it("waits 1 s again once a connection received a message", () => {
    const watcher = watch();
    sockets[0]!.open();
    sockets[0]!.drop();
    expect(connectsAfter(1000)).toBe(true);
    sockets[1]!.open();
    sockets[1]!.drop();
    expect(connectsAfter(2000)).toBe(true);
    sockets[2]!.open();
    sockets[2]!.message({ "address-transactions": [] });
    sockets[2]!.drop();
    expect(connectsAfter(1000)).toBe(true);
    watcher.close();
  });

  it("connects no more once closed", () => {
    const watcher = watch();
    sockets[0]!.open();
    sockets[0]!.drop();
    watcher.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("goes from the node's WebSocket to mempool.space's at once, the node after it for 60 s", () => {
    // `fallback` "mempool" (SPEC.md §31): a connection to the node that fails, or is lost before
    // any message, goes to mempool.space's at once; the delay follows mempool.space's failure.
    const node = "ws://192.168.1.10:3006/api/v1/ws";
    const explorer = new Explorer(
      { url: "http://192.168.1.10:3006", fallback: "mempool", payers: false },
      new Map(),
      () => Date.now()
    );
    const watcher = watch(() => {}, explorer);
    expect(urls).toEqual([node]);
    sockets[0]!.open();
    sockets[0]!.drop();
    expect(urls).toEqual([node, MEMPOOL_WEBSOCKET_URL]);
    sockets[1]!.drop();
    // Both failed: 1 s later, mempool.space's first, the node's at once after it.
    expect(connectsAfter(1000)).toBe(true);
    expect(urls.at(-1)).toBe(MEMPOOL_WEBSOCKET_URL);
    sockets.at(-1)!.drop();
    expect(urls.at(-1)).toBe(node);
    sockets.at(-1)!.drop();
    expect(connectsAfter(2000)).toBe(true);
    expect(urls.at(-1)).toBe(MEMPOOL_WEBSOCKET_URL);
    // mempool.space's answers; lost 60 s after the node's last failure: 1 s later, the node's
    // first again.
    vi.advanceTimersByTime(60_000);
    sockets.at(-1)!.open();
    sockets.at(-1)!.message({ block: {} });
    sockets.at(-1)!.drop();
    expect(connectsAfter(1000)).toBe(true);
    expect(urls.at(-1)).toBe(node);
    watcher.close();
  });

  it("with fallback none, tries the node's WebSocket alone", () => {
    const explorer = new Explorer(
      { url: "https://node.example/mempool", fallback: "none", payers: false },
      new Map(),
      () => Date.now()
    );
    const watcher = watch(() => {}, explorer);
    for (const delay of [1000, 2000, 4000]) {
      sockets.at(-1)!.drop();
      expect(connectsAfter(delay)).toBe(true);
    }
    expect(new Set(urls)).toEqual(new Set(["wss://node.example/mempool/api/v1/ws"]));
    watcher.close();
  });
});
