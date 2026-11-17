import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkoutKeys, parseCheckoutFragment, parseCheckoutValue } from "../src/checkout.js";
import {
  InvoicePendingError,
  NetworkError,
  Sattleme,
  type Invoice,
  type PaymentStatus,
  type SattlemeOptions
} from "../src/index.js";
import type { NostrEvent } from "../src/nostr/event.js";
import { nip44Decrypt } from "../src/nostr/nip44.js";
import { MEMPOOL_URL, MEMPOOL_WEBSOCKET_URL, USER_AGENT } from "../src/protocol.js";
import { secureRandomBytes } from "../src/random.js";

import { FakeExplorerSocket, depositAddress, payment, txid } from "./helpers/chain.js";
import { TestMerchant } from "./helpers/merchant.js";

/*
 * The merchant's Bitcoin node (SPEC.md §31, "The merchant's Bitcoin node"), end to end against
 * local relays and fakes of breez.tips, of mempool.space and of a node on the merchant's network
 * (REST and WebSocket), as PORTING.md step 5 lists: every read of an address and of the chain's
 * height, and waitForPayment's WebSocket, asked of the node and never of mempool.space while it
 * answers; its `fallback` when it does not; the 60 s after a failure; a check's two reads of one
 * explorer; an invalid `bitcoinNode` read as none; the node in a checkout link's record.
 */

const quiet = { warn: () => {} };
const ORIGIN = "https://pay.example";
const NODE = "http://192.168.1.10:3006";
const NODE_WS = "ws://192.168.1.10:3006/api/v1/ws";
const INTERNET_NODE = "https://mempool.shop.example";
const ADDRESS = depositAddress(1);
let merchant: TestMerchant;

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

/** Publishes the channel naming `bitcoinNode` (absent: without the field), served by the fake. */
function publishChannel(bitcoinNode: unknown, createdAt = 100) {
  merchant.publishChannel(
    merchant.channelValue(createdAt, {
      relays: merchant.keyRelays,
      checkout: { origin: ORIGIN },
      ...(bitcoinNode === undefined ? {} : { bitcoinNode })
    }),
    createdAt
  );
  const url = (bitcoinNode as { url?: unknown } | undefined)?.url;
  merchant.chain.node = typeof url === "string" ? url : null;
}

/** Above the Lightning address's bounds: an order paid on-chain only. */
function onchainOnly() {
  merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
}

/** What a link's record holds, as its page opens it. */
function recordOf(invoice: Invoice): Record<string, unknown> {
  const fragment = parseCheckoutFragment(
    invoice.checkoutUrl!.slice(invoice.checkoutUrl!.indexOf("#"))
  );
  if (fragment.status !== "link") throw new Error("Not a link");
  const keys = checkoutKeys(fragment.linkKey);
  const event = (merchant.net.get(merchant.keyRelays[0]!).events as NostrEvent[]).find((e) =>
    e.tags.some(([name, d]) => name === "d" && d === keys.address)
  )!;
  return (JSON.parse(nip44Decrypt(event.content, keys.encryptionKey)) as { v: never }).v;
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 300 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

beforeEach(async () => {
  merchant = await new TestMerchant().start();
  merchant.publishLot([ADDRESS], 90);
});

afterEach(async () => {
  await merchant.stop();
});

describe("a node that answers", () => {
  beforeEach(() => publishChannel({ url: NODE, fallback: "mempool", payers: false }));

  it("is the only explorer asked: the lease, every check, paid at 3 confirmations", async () => {
    const sattleme = client();
    const invoice = await sattleme.createInvoice({ ref: "N-1", sats: 49_000 });
    expect(invoice.onchainAddress).toBe(ADDRESS);
    // The lease: whether the address was paid already, of the node.
    expect(merchant.chain.nodeAsked).toEqual([`${NODE}/api/address/${ADDRESS}/txs`]);
    const tx = payment(txid("node"), ADDRESS, 49_000);
    merchant.chain.add(ADDRESS, tx);
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "unconfirmed" });
    merchant.chain.confirm(ADDRESS, tx.txid, merchant.chain.height - 2);
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "paid",
      method: "onchain",
      received: "49000",
      txids: [tx.txid]
    });
    expect(merchant.chain.mempoolAsked).toEqual([]);
    expect(merchant.chain.nodeAsked.filter((url) => url.endsWith("/blocks/tip/height"))).toEqual([
      `${NODE}/api/blocks/tip/height`,
      `${NODE}/api/blocks/tip/height`
    ]);
    // Over http, with the User-Agent of every request, and no redirect followed (SPEC.md §15).
    const calls = merchant.http.calls.filter(({ url }) => url.href.startsWith(`${NODE}/`));
    expect(calls.length).toBeGreaterThan(0);
    for (const { headers } of calls) expect(headers["User-Agent"]).toBe(USER_AGENT);
  });

  it("follows no redirect of the node: a failure, mempool.space then asked", async () => {
    const invoice = await client().createInvoice({ ref: "N-2", sats: 49_000 });
    let redirect: RequestInit["redirect"] | undefined;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith(`${NODE}/`)) {
        redirect = init?.redirect;
        merchant.chain.asked.push(url);
        return new Response("", { status: 302, headers: { location: `${MEMPOOL_URL}/x` } });
      }
      return merchant.http.fetch(input, init);
    }) as typeof globalThis.fetch;
    expect(await client({ fetch }).getStatus(invoice)).toMatchObject({ state: "open" });
    expect(redirect).toBe("error");
    expect(merchant.chain.mempoolAsked.length).toBe(2);
  });

  it("is watched by waitForPayment on the node's WebSocket, never mempool.space's", async () => {
    const node = new FakeExplorerSocket(await merchant.net.addServer(NODE_WS));
    const mempool = await merchant.startExplorerSocket();
    const sattleme = client();
    const invoice = await sattleme.createInvoice({ ref: "N-3", sats: 49_000 });
    const statuses: PaymentStatus[] = [];
    const waiting = sattleme.waitForPayment(invoice, {
      intervalMs: 60_000,
      onStatus: (status) => statuses.push(status)
    });
    await until(() => node.messages.length === 2 && statuses.length > 0);
    expect(node.messages).toEqual([
      { action: "want", data: ["blocks"] },
      { "track-address": ADDRESS }
    ]);
    const tx = payment(txid("watched"), ADDRESS, 49_000, { height: merchant.chain.height - 2 });
    merchant.chain.add(ADDRESS, tx);
    node.push({ "address-transactions": [tx] });
    expect(await waiting).toMatchObject({ state: "paid", method: "onchain" });
    expect(mempool.connections).toBe(0);
    expect(merchant.chain.mempoolAsked).toEqual([]);
  });
});

describe("a node that does not answer, fallback mempool", () => {
  beforeEach(() => {
    publishChannel({ url: NODE, fallback: "mempool", payers: false });
    // A server outside the merchant's network: no answer.
    merchant.chain.down.add("unreachable");
  });

  it("reads mempool.space instead, and network when both fail", async () => {
    const sattleme = client();
    const invoice = await sattleme.createInvoice({ ref: "F-1", sats: 49_000 });
    expect(invoice.onchainAddress).toBe(ADDRESS);
    const tx = payment(txid("fallback"), ADDRESS, 49_000, { height: merchant.chain.height - 2 });
    merchant.chain.add(ADDRESS, tx);
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "paid", method: "onchain" });
    merchant.chain.down.add("mempool");
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(NetworkError);
  });

  it("asks the node after mempool.space for 60 s once it failed, in the same call", async () => {
    // Two addresses: the first paid already (skipped), the second leased. The node fails the
    // first's read: the second's is asked of mempool.space first.
    const second = depositAddress(2);
    merchant.publishLot([ADDRESS, second], 91);
    merchant.chain.add(ADDRESS, payment(txid("earlier"), ADDRESS, 1000, { height: 1 }));
    // The shuffle's draws (4 bytes) keep the lot's order: the paid one first.
    const random = (length: number) =>
      length === 4 ? new Uint8Array(4).fill(255) : secureRandomBytes(length);
    const invoice = await client({ random }).createInvoice({ ref: "F-2", sats: 49_000 });
    expect(invoice.onchainAddress).toBe(second);
    expect(
      merchant.chain.asked.map(
        (url) => (url.startsWith(NODE) ? "node " : "mempool ") + url.split("/address/")[1]
      )
    ).toEqual([`node ${ADDRESS}/txs`, `mempool ${ADDRESS}/txs`, `mempool ${second}/txs`]);
  });

  it("asks the node after mempool.space within 60 s, in every check of one waitForPayment", async () => {
    merchant.chain.down.delete("unreachable");
    const sattleme = client();
    const invoice = await sattleme.createInvoice({ ref: "F-3", sats: 49_000 });
    merchant.chain.down.add("unreachable");
    const mempool = await merchant.startExplorerSocket();
    const statuses: PaymentStatus[] = [];
    const controller = new AbortController();
    let mark = merchant.chain.asked.length;
    const asked = () => {
      const kinds = merchant.chain.asked
        .slice(mark)
        .map((url) => (url.startsWith(NODE) ? "node" : "mempool"));
      mark = merchant.chain.asked.length;
      return kinds;
    };
    const waiting = sattleme
      .waitForPayment(invoice, {
        intervalMs: 60_000,
        signal: controller.signal,
        onStatus: (status) => statuses.push(status)
      })
      .catch(() => null);
    // The first check: the node, then mempool.space; its WebSocket: the node's refused,
    // mempool.space's connected, which starts a check, of mempool.space first.
    await until(() => statuses.length === 2);
    expect(asked()).toEqual(["node", "node", "mempool", "mempool", "mempool", "mempool"]);
    expect(merchant.net.connections.get(NODE_WS)).toBe(1);
    // mempool.space failing within the 60 s: the node after it, which answers.
    merchant.chain.down.add("mempool");
    merchant.chain.down.delete("unreachable");
    mempool.push({ block: { height: merchant.chain.height } });
    await until(() => statuses.length === 3);
    expect(asked()).toEqual(["mempool", "mempool", "node", "node"]);
    expect(statuses.at(-1)).toMatchObject({ state: "open" });
    // 60 s after its failure: the node first again.
    merchant.now += 60;
    merchant.chain.down.delete("mempool");
    mempool.push({ block: { height: merchant.chain.height } });
    await until(() => statuses.length === 4);
    expect(asked()).toEqual(["node", "node"]);
    controller.abort();
    await waiting;
  });
});

describe("a node that does not answer, fallback none", () => {
  beforeEach(() => {
    publishChannel({ url: NODE, fallback: "none", payers: false });
    merchant.chain.down.add("unreachable");
  });

  it("leases no address: network for an order paid on-chain only, Lightning only otherwise", async () => {
    onchainOnly();
    await expect(client().createInvoice({ ref: "X-1", sats: 2_000_000 })).rejects.toBeInstanceOf(
      NetworkError
    );
    merchant.pay = { ...merchant.pay, maxSendable: 100_000_000_000 };
    const invoice = await client().createInvoice({ ref: "X-2", sats: 49_000 });
    expect(invoice.onchainAddress).toBeNull();
    expect(invoice.bolt11).toMatch(/^lnbc/);
    expect(merchant.chain.mempoolAsked).toEqual([]);
  });

  it("is network, never expired however long the node is down, then paid once it answers", async () => {
    merchant.chain.down.delete("unreachable");
    onchainOnly();
    const sattleme = client();
    const invoice = await sattleme.createInvoice({ ref: "X-3", sats: 2_000_000 });
    expect(invoice.onchainAddress).toBe(ADDRESS);
    merchant.chain.down.add("unreachable");
    // Paid while the lease ran, which no check saw: BlockCypher tells it in time.
    const tx = payment(txid("unseen"), ADDRESS, 2_000_000, { height: merchant.chain.height - 5 });
    merchant.chain.add(ADDRESS, tx);
    merchant.chain.received.set(tx.txid, new Date((invoice.createdAt + 60) * 1000).toISOString());
    merchant.now = invoice.expiresAt + 3600;
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(NetworkError);
    // A new invoice of the order: refused while its earlier one cannot be told.
    await expect(sattleme.createInvoice({ ref: "X-3", sats: 2_000_000 })).rejects.toBeInstanceOf(
      NetworkError
    );
    expect(merchant.chain.mempoolAsked).toEqual([]);
    merchant.chain.down.delete("unreachable");
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "paid",
      method: "onchain",
      received: "2000000",
      txids: [tx.txid]
    });
  });

  it("is watched on the node's WebSocket alone, connected again while it is down", async () => {
    merchant.chain.down.delete("unreachable");
    const mempool = await merchant.startExplorerSocket();
    const sattleme = client();
    const invoice = await sattleme.createInvoice({ ref: "X-4", sats: 49_000 });
    merchant.chain.down.add("unreachable");
    const controller = new AbortController();
    const waiting = sattleme
      .waitForPayment(invoice, { intervalMs: 250, signal: controller.signal })
      .catch(() => null);
    // No node's WebSocket listens: refused, tried again after 1 s.
    await until(() => (merchant.net.connections.get(NODE_WS) ?? 0) >= 2);
    controller.abort();
    await waiting;
    expect(mempool.connections).toBe(0);
    expect(merchant.net.connections.get(MEMPOOL_WEBSOCKET_URL)).toBeUndefined();
    expect(merchant.chain.mempoolAsked).toEqual([]);
  });
});

describe("waitForPayment's WebSocket, fallback mempool", () => {
  it("goes to mempool.space's when the node's fails, and is woken by it", async () => {
    publishChannel({ url: NODE, fallback: "mempool", payers: false });
    const mempool = await merchant.startExplorerSocket();
    const sattleme = client();
    const invoice = await sattleme.createInvoice({ ref: "W-1", sats: 49_000 });
    const statuses: PaymentStatus[] = [];
    const waiting = sattleme.waitForPayment(invoice, {
      intervalMs: 60_000,
      onStatus: (status) => statuses.push(status)
    });
    // The node's WebSocket refuses the connection: mempool.space's at once.
    await until(() => mempool.messages.length === 2 && statuses.length > 0);
    expect(merchant.net.connections.get(NODE_WS)).toBe(1);
    const tx = payment(txid("socket"), ADDRESS, 49_000, { height: merchant.chain.height - 2 });
    merchant.chain.add(ADDRESS, tx);
    mempool.push({ "address-transactions": [tx] });
    expect(await waiting).toMatchObject({ state: "paid", method: "onchain" });
  });
});

describe("one explorer for a check's two reads", () => {
  it("asks both of mempool.space when the node fails either", async () => {
    publishChannel({ url: NODE, fallback: "mempool", payers: false });
    const sattleme = client();
    const invoice = await sattleme.createInvoice({ ref: "O-1", sats: 49_000 });
    // The node gives the address's transactions, and fails the chain's height.
    const tx = payment(txid("one"), ADDRESS, 49_000, { height: merchant.chain.height - 2 });
    merchant.chain.add(ADDRESS, tx);
    merchant.override = (url) =>
      url.href === `${NODE}/api/blocks/tip/height` ? { status: 500, text: "down" } : undefined;
    const before = merchant.chain.asked.length;
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "paid" });
    const asked = merchant.chain.asked.slice(before);
    expect(asked).toContain(`${MEMPOOL_URL}/address/${ADDRESS}/txs`);
    expect(asked).toContain(`${MEMPOOL_URL}/blocks/tip/height`);
  });
});

describe("an invalid bitcoinNode", () => {
  it.each([
    ["http to a public host", { url: "http://node.example", fallback: "mempool", payers: false }],
    ["a fallback of another spelling", { url: NODE, fallback: "Mempool", payers: false }],
    ["payers absent", { url: NODE, fallback: "none" }],
    ["payers not a boolean", { url: INTERNET_NODE, fallback: "none", payers: "true" }],
    ["payers true for a local node", { url: NODE, fallback: "none", payers: true }]
  ])("reads mempool.space, the channel still valid: %s", async (_, bitcoinNode) => {
    publishChannel(bitcoinNode);
    const invoice = await client().createInvoice({ ref: "I-1", sats: 49_000, checkout: true });
    expect(invoice.onchainAddress).toBe(ADDRESS);
    expect(merchant.chain.nodeAsked).toEqual([]);
    expect(merchant.chain.mempoolAsked).toEqual([`${MEMPOOL_URL}/address/${ADDRESS}/txs`]);
    expect(recordOf(invoice)).not.toHaveProperty("bitcoinNode");
  });
});

describe("the record of a checkout link", () => {
  it("holds the node's url and fallback, never payers, with payers true", async () => {
    publishChannel({ url: INTERNET_NODE, fallback: "none", payers: true, name: "Shop node" });
    const invoice = await client().createInvoice({ ref: "L-1", sats: 49_000, checkout: true });
    const record = recordOf(invoice);
    expect(record).toMatchObject({ version: 2, onchainAddress: ADDRESS });
    expect(record.bitcoinNode).toEqual({ url: INTERNET_NODE, fallback: "none" });
    expect(parseCheckoutValue(record)?.bitcoinNode).toEqual({
      url: INTERNET_NODE,
      fallback: "none"
    });
    // The node made the link again for invoice_pending holds it too.
    const pending = await client()
      .createInvoice({ ref: "L-1", sats: 49_000, checkout: true })
      .catch((error: unknown) => error);
    expect(pending).toBeInstanceOf(InvoicePendingError);
    const again = (pending as InvoicePendingError).checkoutUrl!;
    expect(again).not.toBe(invoice.checkoutUrl);
    expect(recordOf({ ...invoice, checkoutUrl: again }).bitcoinNode).toEqual({
      url: INTERNET_NODE,
      fallback: "none"
    });
  });

  it.each([
    ["payers false", { url: INTERNET_NODE, fallback: "mempool", payers: false }],
    ["no node", undefined]
  ])("holds no node with %s", async (_, bitcoinNode) => {
    publishChannel(bitcoinNode);
    const invoice = await client().createInvoice({ ref: "L-2", sats: 49_000, checkout: true });
    const record = recordOf(invoice);
    expect(record.version).toBe(2);
    expect(record).not.toHaveProperty("bitcoinNode");
  });

  it("holds no node in version 1, an order without an address", async () => {
    publishChannel({ url: INTERNET_NODE, fallback: "mempool", payers: true });
    // Below the on-chain floor: Lightning only.
    const invoice = await client().createInvoice({ ref: "L-3", sats: 999, checkout: true });
    expect(invoice.onchainAddress).toBeNull();
    const record = recordOf(invoice);
    expect(record.version).toBe(1);
    expect(record).not.toHaveProperty("bitcoinNode");
  });
});
