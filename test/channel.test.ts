import { afterEach, describe, expect, it } from "vitest";

import { readChannel, type ChannelReadOptions } from "../src/channel.js";
import {
  ChannelNotFoundError,
  NetworkError,
  RevokedError,
  Sattleme,
  type Logger
} from "../src/index.js";
import { parseIntegrationKey, type IntegrationKey } from "../src/key.js";
import { RelayPool, type WebSocketFactory } from "../src/nostr/relay.js";
import { RelayNet } from "./helpers/relay.js";
import { bytes, TestMerchant } from "./helpers/merchant.js";
import { appVectors } from "./helpers/vectors.js";

const quiet = { warn: () => {} };
let merchant: TestMerchant;
let net: RelayNet | null = null;

afterEach(async () => {
  await merchant?.stop();
  await net?.close();
  net = null;
});

/** readChannel over a pool of its own, closed once it is done. */
async function readOn(
  access: IntegrationKey,
  options: ChannelReadOptions & { createSocket: WebSocketFactory; timeoutMs: number }
) {
  const pool = new RelayPool({
    createSocket: options.createSocket,
    timeoutMs: options.timeoutMs,
    now: () => Math.floor(Date.now() / 1000)
  });
  try {
    return await readChannel(pool, access, options);
  } finally {
    pool.close();
  }
}

function read(m: TestMerchant, timeoutMs = 2000, logger: Logger = quiet) {
  return readOn(parseIntegrationKey(m.key), {
    createSocket: (url) => new m.net.WebSocket(url),
    timeoutMs,
    logger
  });
}

describe("reading the integration's channel", () => {
  it("reads the channel of the app's vectors with its key alone", async () => {
    net = new RelayNet();
    const relay = await net.add("wss://relay.example");
    relay.store(appVectors.channel.event);
    const { channel, relays } = await readOn(parseIntegrationKey(appVectors.secretKey), {
      createSocket: (url) => new net!.WebSocket(url),
      timeoutMs: 2000,
      logger: quiet
    });
    expect(channel).toMatchObject({
      status: "active",
      businessName: "Sunrise Bakery",
      lightningAddress: "sattleme02c6047f94@breez.tips",
      registryKey: appVectors.channel.value.v.registryKey
    });
    expect(relays).toEqual(["wss://relay.example"]);
    expect(relay.queries).toEqual([
      {
        kinds: [30078],
        authors: [appVectors.parsed.team],
        "#d": [appVectors.derived.channelAddress]
      }
    ]);
  });

  it("keeps the newest copy, and ignores one signed by another key", async () => {
    merchant = await new TestMerchant().start();
    merchant.publishChannel(merchant.channelValue(100), 100);
    merchant.publishChannel(
      merchant.channelValue(200, {
        profile: { businessName: "Old", lightningAddress: "a@b.test", currency: "CHF" }
      }),
      200,
      // On a majority, as the app publishes it: any majority that answers holds it.
      ["wss://relay-a.test", "wss://relay-b.test"]
    );
    // Newer, but by another author: whoever saw the address could publish there.
    merchant.publishChannel(
      merchant.channelValue(300, { status: "removed" }),
      300,
      merchant.keyRelays,
      bytes(66)
    );
    const { channel } = await read(merchant);
    expect(channel).toMatchObject({ businessName: "Old", updatedAt: 200 });
  });

  it("ignores a copy whose updatedAt is not its date, or that is damaged", async () => {
    merchant = await new TestMerchant().start();
    merchant.publishChannel(merchant.channelValue(100), 100);
    merchant.publishChannel(merchant.channelValue(150), 200);
    const relay = merchant.net.get("wss://relay-b.test");
    const good = merchant.channelEvent(merchant.channelValue(300), 300);
    relay.store({ ...good, content: good.content.replace(/^A/, "B") });
    relay.store({ ...good, sig: "00".repeat(64) });
    const { channel } = await read(merchant);
    expect(channel.updatedAt).toBe(100);
  });

  it("ignores a channel whose Lightning address is on an IP address or under localhost, or whose business name holds a lone surrogate", async () => {
    merchant = await new TestMerchant().start();
    merchant.publishChannel(merchant.channelValue(100), 100);
    const profile = merchant.channelValue(0).profile;
    for (const [at, changed] of [
      [200, { lightningAddress: "shop@10.0.0.1" }],
      [201, { lightningAddress: "shop@pay.localhost" }],
      [202, { businessName: "Sunrise \ud800" }]
    ] as const) {
      merchant.publishChannel(
        { ...merchant.channelValue(at), profile: { ...profile, ...changed } },
        at
      );
    }
    const { channel } = await read(merchant);
    expect(channel.updatedAt).toBe(100);
  });

  it("throws RevokedError when the integration was removed", async () => {
    merchant = await new TestMerchant().start();
    merchant.publishChannel(merchant.channelValue(100), 100);
    merchant.publishChannel({ version: 1, status: "removed", updatedAt: 200 }, 200);
    await expect(read(merchant)).rejects.toBeInstanceOf(RevokedError);
  });

  it("warns of a newer format, and ignores it", async () => {
    merchant = await new TestMerchant().start();
    merchant.publishChannel(merchant.channelValue(100), 100);
    merchant.publishChannel({ ...merchant.channelValue(200), version: 2 }, 200);
    const warnings: string[] = [];
    const { channel } = await read(merchant, 2000, { warn: (m: string) => void warnings.push(m) });
    expect(channel.updatedAt).toBe(100);
    expect(warnings).toHaveLength(1);
  });

  it("follows the account's relays where the channel moved, 3 times at most", async () => {
    merchant = new TestMerchant();
    const lists = [
      merchant.keyRelays,
      ["wss://second.test"],
      ["wss://third.test", "wss://third-b.test"],
      ["wss://fourth.test"],
      ["wss://fifth.test"]
    ];
    await merchant.start(lists.slice(1).flat());
    for (let i = 0; i < lists.length; i += 1) {
      const next = lists[i + 1] ?? lists[i]!;
      merchant.publishChannel(
        merchant.channelValue(100 + i, {
          relays: next,
          profile: {
            businessName: `List ${i}`,
            lightningAddress: "sattleme02c6047f94@breez.tips",
            currency: "CHF"
          }
        }),
        100 + i,
        lists[i]
      );
    }
    const { channel, relays } = await read(merchant);
    expect(channel.businessName).toBe("List 3");
    expect(relays).toEqual(["wss://fourth.test"]);
    expect(merchant.net.connections.get("wss://fifth.test")).toBeUndefined();
  });

  it("sees a removal on the list the channel moved to", async () => {
    merchant = await new TestMerchant().start(["wss://new.test"]);
    merchant.publishChannel(merchant.channelValue(100, { relays: ["wss://new.test"] }), 100);
    merchant.publishChannel({ version: 1, status: "removed", updatedAt: 200 }, 200, [
      "wss://new.test"
    ]);
    await expect(read(merchant)).rejects.toBeInstanceOf(RevokedError);
  });

  it("throws NetworkError when the list the channel moved to does not answer", async () => {
    merchant = await new TestMerchant().start();
    merchant.publishChannel(merchant.channelValue(100, { relays: ["wss://gone.test"] }), 100);
    await expect(read(merchant)).rejects.toBeInstanceOf(NetworkError);
  });

  it("throws ChannelNotFoundError when the relays answer without it", async () => {
    merchant = await new TestMerchant().start();
    await expect(read(merchant)).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it("goes on once a majority answered, past a silent relay, and one asking to authenticate", async () => {
    merchant = await new TestMerchant().start([], {
      "wss://relay-a.test": { mute: true },
      "wss://relay-b.test": { requireAuth: true }
    });
    merchant.publishChannel(merchant.channelValue(100), 100, ["wss://relay-b.test"]);
    const started = Date.now();
    // relay-b and relay-c are a majority: the silent relay's 5 s are not waited for.
    const { channel } = await read(merchant, 5000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(channel.updatedAt).toBe(100);
    // A key of this read alone: never the team's nor a sale's.
    const [authKey] = merchant.net.get("wss://relay-b.test").authenticated;
    expect(authKey).toBeDefined();
    expect(authKey).not.toBe(merchant.team);
  });

  it("closes a relay that never completes the handshake, without an uncaught error", async () => {
    merchant = await new TestMerchant().start();
    await merchant.net.addBlackhole("wss://hole.test");
    merchant.publishChannel(merchant.channelValue(100), 100, ["wss://relay-b.test"]);
    const uncaught: unknown[] = [];
    const listener = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", listener);
    try {
      const access = parseIntegrationKey(merchant.key);
      const relays = (list: string[]) => ({ ...access, relays: list, key: access.key });
      const options = {
        createSocket: (url: string) => new merchant.net.WebSocket(url),
        timeoutMs: 300,
        logger: quiet
      };
      // Read on the two others, a majority of three; the hole's connection closed meanwhile.
      const { channel } = await readOn(
        relays(["wss://hole.test", "wss://relay-b.test", "wss://relay-c.test"]),
        options
      );
      expect(channel.updatedAt).toBe(100);
      // One of two is no majority: no answer is no absence.
      await expect(
        readOn(relays(["wss://hole.test", "wss://relay-b.test"]), options)
      ).rejects.toBeInstanceOf(NetworkError);
      // ws reports the aborted handshake on the next tick.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", listener);
    }
  });

  it("throws NetworkError, not an absence, when no relay answers", async () => {
    merchant = await new TestMerchant().start([], {
      "wss://relay-a.test": { mute: true }
    });
    await merchant.net.remove("wss://relay-b.test");
    await merchant.net.remove("wss://relay-c.test");
    const started = Date.now();
    await expect(read(merchant, 300)).rejects.toBeInstanceOf(NetworkError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reads the merchant at every call, as JSON, and keeps nothing open", async () => {
    merchant = await new TestMerchant().start();
    merchant.publishChannel(merchant.channelValue(100), 100);
    const sattleme = new Sattleme({
      key: merchant.key,
      fetch: merchant.http.fetch,
      WebSocket: merchant.net.WebSocket,
      logger: quiet
    });
    const found = await sattleme.merchant();
    expect(found).toEqual({
      businessName: "Sunrise Bakery",
      minSats: "1",
      maxSats: "100000000",
      // No lot of addresses yet: no on-chain payment.
      onchainAddresses: 0
    });
    expect(JSON.parse(JSON.stringify(found))).toEqual(found);
    // Nothing kept: a removal stops the very next call.
    merchant.publishChannel({ version: 1, status: "removed", updatedAt: 200 }, 200);
    await expect(sattleme.merchant()).rejects.toBeInstanceOf(RevokedError);
    expect(merchant.net.connections.get("wss://relay-a.test")).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const url of merchant.keyRelays) {
      expect(merchant.net.get(url).server.clients.size).toBe(0);
    }
  });
});
