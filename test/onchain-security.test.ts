import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registryOf } from "../src/declaration.js";
import { channelKeys, outerKey, saleOf, type Sale } from "../src/derive.js";
import {
  InvoicePendingError,
  NetworkError,
  OnchainUnavailableError,
  OrderPaidError,
  Sattleme,
  type Invoice,
  type SattlemeOptions
} from "../src/index.js";
import { publicKeyOf, signEvent, type NostrEvent } from "../src/nostr/event.js";
import { leaseAddress } from "../src/onchain/address.js";
import { recordsThatOpen, sealRecord } from "../src/nostr/record.js";
import { RelayPool } from "../src/nostr/relay.js";
import { isLeased, leaseEvent, readLeases } from "../src/onchain/lease.js";
import type { RandomBytes } from "../src/random.js";

import { depositAddress, payment, txid } from "./helpers/chain.js";
import { TestMerchant } from "./helpers/merchant.js";

/*
 * Attacks on on-chain payments (S1 to S6; SPEC.md §13, §21, §31), end to end against local relays
 * and fakes of the explorers. Each test states what must hold.
 */

/** BIP-340 verifications made, all modules included (each costs ~1 ms here). */
const verifications = vi.hoisted(() => ({ count: 0 }));
vi.mock("@noble/curves/secp256k1.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@noble/curves/secp256k1.js")>();
  return {
    ...real,
    schnorr: {
      ...real.schnorr,
      verify: (...args: Parameters<typeof real.schnorr.verify>) => {
        verifications.count += 1;
        return real.schnorr.verify(...args);
      }
    }
  };
});

const quiet = { warn: () => {} };
const LOT = [depositAddress(1), depositAddress(2), depositAddress(3)];
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

function saleOfRef(ref: string): Sale {
  return saleOf(
    merchant.integrationKey,
    registryOf(Buffer.from(merchant.registryKey).toString("hex"), merchant.reader),
    ref
  );
}

/** Reproducible random bytes. */
function seeded(seed: number): RandomBytes {
  let counter = 0;
  return (length) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 32) {
      out.set(sha256(utf8ToBytes(`${seed}/${counter++}`)).slice(0, Math.min(32, length - i)), i);
    }
    return out;
  };
}

/** The lease of `address` by the sale of `ref`, from `createdAt` for `seconds`. */
function leaseBy(
  ref: string,
  address: string,
  {
    createdAt = merchant.now,
    seconds = 900,
    random
  }: Partial<{
    createdAt: number;
    seconds: number;
    random: RandomBytes;
  }> = {}
): NostrEvent {
  return leaseEvent({
    sale: saleOfRef(ref),
    terms: {
      address,
      sats: 1000n,
      invoice: null,
      verifyUrl: null,
      createdAt,
      expiresAt: createdAt + seconds,
      price: { minor: 1000, digits: 0, currency: "SAT" },
      note: ref,
      tolerance: 0
    },
    createdAt,
    random
  });
}

/** A record anybody writes at a registry address (it is public): a throwaway key signs it. */
function junk(d: string, createdAt: number, seed: number, content = "x"): NostrEvent {
  return signEvent(
    { kind: 30078, created_at: createdAt, tags: [["d", d]], content },
    sha256(utf8ToBytes(`throwaway ${seed}`)),
    () => new Uint8Array(32)
  );
}

/** Every relay of the key takes `event`. */
function everywhere(event: NostrEvent) {
  for (const url of merchant.keyRelays) merchant.net.get(url).take(event);
}

function relays() {
  return merchant.keyRelays.map((url) => merchant.net.get(url));
}

beforeEach(async () => {
  merchant = await new TestMerchant().start();
  merchant.publishChannel(merchant.channelValue(100, { relays: merchant.keyRelays }), 100);
});

afterEach(async () => {
  await merchant.stop();
});

// S5's floods and S4's last one sign hundreds of records, then read them from every relay: seconds
// each alone, more on a busy machine (several builds at once, a slow runner). Time enough for that
// (60 s), and for each page (4 s): what they test is what the read decides, not how fast it is.
describe("S5: a paged read of the leases misses a lease every relay holds", () => {
  const d = () => leaseAddress(merchant.registryKey, LOT[0]!);

  beforeEach(() => {
    merchant.publishLot([LOT[0]!], 91);
  });

  it("control: another order's lease keeps the address", async () => {
    everywhere(leaseBy("HOLDER", LOT[0]!));
    expect((await client().createInvoice({ ref: "S5-0", sats: 49_000 })).onchainAddress).toBeNull();
  });

  it("1. ties: a page of records of the lease's very second, with lower ids", async () => {
    for (const relay of relays()) relay.behaviour = { cap: 500 };
    // At equal created_at, the lowest id first (NIP-01; strfry: the last stored first).
    let lease: NostrEvent;
    let seed = 0;
    do lease = leaseBy("HOLDER", LOT[0]!, { random: seeded(seed++) });
    while (lease.id < "c");
    everywhere(lease);
    for (let i = 0, made = 0; made < 500; i += 1) {
      const record = junk(d(), lease.created_at, i);
      if (record.id < lease.id) {
        everywhere(record);
        made += 1;
      }
    }
    expect(
      (await client({ relayTimeoutMs: 4000 }).createInvoice({ ref: "S5-1", sats: 49_000 }))
        .onchainAddress
    ).toBeNull();
  }, 60_000);

  it("2. unusable dates: a page of records dated beyond 2^53", async () => {
    for (const relay of relays()) relay.behaviour = { cap: 500 };
    everywhere(leaseBy("HOLDER", LOT[0]!));
    for (let i = 0; i < 500; i += 1) {
      const record = junk(d(), 2 ** 53 + 2 * (i + 1), i);
      // As a relay that keeps any date stores it (strfry refuses one more than 900 s ahead).
      for (const relay of relays()) relay.store(record);
    }
    expect(
      (await client({ relayTimeoutMs: 4000 }).createInvoice({ ref: "S5-2", sats: 49_000 }))
        .onchainAddress
    ).toBeNull();
  }, 60_000);

  it("3. volume: more than 20 pages of records newer than the lease", async () => {
    for (const relay of relays()) relay.behaviour = { cap: 100 };
    everywhere(leaseBy("HOLDER", LOT[0]!, { createdAt: merchant.now - 600 }));
    for (let i = 0; i < 2001; i += 1) everywhere(junk(d(), merchant.now - 599 + (i % 500), i));
    const invoice = await client({ relayTimeoutMs: 4000 }).createInvoice({
      ref: "S5-3",
      sats: 49_000
    });
    expect(invoice.onchainAddress).toBeNull();
  }, 60_000);

  it("4. order: a relay that answers a filter without a limit oldest first", async () => {
    for (const relay of relays()) relay.behaviour = { oldestFirstWithoutLimit: true };
    everywhere(leaseBy("HOLDER", LOT[0]!));
    for (let i = 0; i < 1000; i += 1) everywhere(junk(d(), merchant.now - 7000 + i, i));
    expect(
      (await client({ relayTimeoutMs: 4000 }).createInvoice({ ref: "S5-4", sats: 49_000 }))
        .onchainAddress
    ).toBeNull();
  }, 60_000);
});

describe("S4: records of any key at the registry addresses hold none of them", () => {
  it("an empty content at each registry address holds none: the order gets one", async () => {
    merchant.publishLot(LOT, 91);
    for (const [i, address] of LOT.entries()) {
      everywhere(junk(leaseAddress(merchant.registryKey, address), merchant.now, 10_000 + i, ""));
    }
    expect(
      (await client().createInvoice({ ref: "S4-1", sats: 49_000 })).onchainAddress
    ).not.toBeNull();
  });

  it("a lease of a newer format, sealed with the registry key, holds its address and is warned of", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    const secret = sha256(utf8ToBytes("a sale of a newer version"));
    const newer = sealRecord({
      type: "registry-onchain",
      value: { version: 2 },
      signer: secret,
      encryptionKey: outerKey(merchant.registryKey, d, publicKeyOf(secret)),
      address: d,
      createdAt: merchant.now - 60
    });
    everywhere(newer);
    const warnings: string[] = [];
    const invoice = await client({
      logger: { warn: (message) => warnings.push(message) }
    }).createInvoice({ ref: "S4-3", sats: 49_000 });
    expect(invoice.onchainAddress).toBeNull();
    expect(warnings).toContainEqual(
      expect.stringMatching(/a lease of the integration's addresses has a newer format/)
    );
  });

  it("a thousand records that do not open cost no signature check each", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    for (let i = 0; i < 1000; i += 1) everywhere(junk(d, merchant.now - i, 20_000 + i, "#"));
    verifications.count = 0;
    await client({ relayTimeoutMs: 4000 }).createInvoice({ ref: "S4-2", sats: 49_000 });
    // The channel, the lot, the order's own records: a handful. Never one per junk record.
    expect(verifications.count).toBeLessThan(50);
  }, 60_000);
});

describe("S1: an earlier invoice whose lease was never confirmed is handed out again", () => {
  it("an order paid on-chain only, whose lease reached one relay", async () => {
    merchant.publishLot([LOT[0]!], 91);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const [r1, r2, r3] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    const author = saleOfRef("S1-R").author;
    const start = merchant.now;
    // r1 takes the order's lease and nothing after it (its withdrawal is lost); r2 and r3 refuse.
    r1.behaviour = {
      refuseEvent: (e) => (e.pubkey === author && e.created_at > start ? "error: down" : undefined)
    };
    const refuse = {
      refuseEvent: (e: NostrEvent) => (e.pubkey === author ? "error: down" : undefined)
    };
    r2.behaviour = refuse;
    r3.behaviour = refuse;
    await expect(client().createInvoice({ ref: "S1-R", sats: 49_000 })).rejects.toBeInstanceOf(
      NetworkError
    );

    // Another order while r1 is slow: r2 and r3, which never got that lease, answer first.
    r1.behaviour = { queryDelayMs: 500 };
    r2.behaviour = {};
    r3.behaviour = {};
    const x = await client()
      .createInvoice({ ref: "S1-X", sats: 49_000 })
      .catch((error: unknown) => error);
    const xHolds = !(x instanceof Error) && (x as Invoice).onchainAddress === LOT[0];

    // The first order again while r2 is slow: r1, which holds its lease, answers.
    r1.behaviour = {};
    r2.behaviour = { queryDelayMs: 500 };
    const again = await client()
      .createInvoice({ ref: "S1-R", sats: 49_000 })
      .catch((error: unknown) => error);
    // Never both: the address handed out to this order while the other holds it.
    const handedOut =
      again instanceof InvoicePendingError
        ? again.invoice.onchainAddress
        : again instanceof Error
          ? null
          : (again as Invoice).onchainAddress;
    expect(xHolds && handedOut === LOT[0]).toBe(false);
  });

  it("an invoice with Lightning whose declaration failed, its withdrawal on one relay", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const [r1, r2, r3] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    const author = saleOfRef("S1-L").author;
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    const start = merchant.now;
    const isLeaseRecord = (e: NostrEvent) =>
      e.tags.some(([name, value]) => name === "d" && value === d);
    const mine = (e: NostrEvent) => e.pubkey === author;
    // r1: the lease and the declaration, not the withdrawal. r2: the lease and the withdrawal,
    // not the declaration. r3: the lease only.
    r1.behaviour = {
      refuseEvent: (e) =>
        mine(e) && isLeaseRecord(e) && e.created_at > start ? "error: down" : undefined
    };
    r2.behaviour = {
      refuseEvent: (e) => (mine(e) && !isLeaseRecord(e) ? "error: down" : undefined)
    };
    r3.behaviour = {
      refuseEvent: (e) =>
        mine(e) && (!isLeaseRecord(e) || e.created_at > start) ? "error: down" : undefined
    };
    await expect(client().createInvoice({ ref: "S1-L", sats: 49_000 })).rejects.toBeInstanceOf(
      NetworkError
    );

    // Another order while r1 is slow: r2's withdrawal frees the address.
    r1.behaviour = { queryDelayMs: 500 };
    r2.behaviour = {};
    r3.behaviour = {};
    const x = await client().createInvoice({ ref: "S1-X", sats: 49_000 });
    const xHolds = x.onchainAddress === LOT[0];

    // The first order again while r2 is slow.
    r1.behaviour = {};
    r2.behaviour = { queryDelayMs: 500 };
    const again = await client()
      .createInvoice({ ref: "S1-L", sats: 49_000 })
      .catch((error: unknown) => error);
    const handedOut =
      again instanceof InvoicePendingError
        ? again.invoice.onchainAddress
        : again instanceof Error
          ? null
          : (again as Invoice).onchainAddress;
    expect(xHolds && handedOut === LOT[0]).toBe(false);
  });
});

describe("S2: a transaction evicted, then broadcast again during a later lease, pays two orders", () => {
  it("the first order's witness names it", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const sattleme = client();
    const p = await sattleme.createInvoice({ ref: "S2-P", sats: 49_000, durationSeconds: 600 });
    const address = p.onchainAddress!;
    // Paid with a very low fee, seen while P's lease runs: P's witness.
    const t = payment(txid("S2 low fee"), address, 49_000);
    merchant.chain.add(address, t);
    expect(await sattleme.getStatus(p)).toMatchObject({ state: "unconfirmed" });
    // Evicted from the mempools: the explorer lists nothing for the address.
    merchant.chain.drop(address, t.txid);
    merchant.now = p.expiresAt + 120 + 301;
    expect(await sattleme.getStatus(p)).toEqual({ state: "expired", received: "0" });

    const n = await sattleme.createInvoice({ ref: "S2-N", sats: 49_000, durationSeconds: 600 });
    // The payer's wallet broadcasts T again during N's lease; it is mined.
    merchant.chain.add(address, t);
    if (n.onchainAddress === address) await sattleme.getStatus(n);
    merchant.chain.confirm(address, t.txid, merchant.chain.height - 5);
    // The payer asks for P again: the shop checks P's earlier invoice.
    const pAgain = await sattleme
      .createInvoice({ ref: "S2-P", sats: 49_000 })
      .catch((error: unknown) => error);
    const nPaid = n.onchainAddress === address && (await sattleme.getStatus(n)).state === "paid";
    const pPaid = pAgain instanceof OrderPaidError;
    // One transaction, one order.
    expect(nPaid && pPaid).toBe(false);
  });

  it("no check saw it while the first lease ran: BlockCypher's time", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const sattleme = client();
    const p = await sattleme.createInvoice({ ref: "S2-Q", sats: 49_000, durationSeconds: 600 });
    const address = p.onchainAddress!;
    const t = payment(txid("S2 unseen"), address, 49_000);
    // BlockCypher received it while P's lease ran; no check of P saw it; it is evicted.
    merchant.chain.received.set(t.txid, new Date((p.createdAt + 10) * 1000).toISOString());
    merchant.now = p.expiresAt + 120 + 301;
    expect(await sattleme.getStatus(p)).toEqual({ state: "expired", received: "0" });

    const n = await sattleme.createInvoice({ ref: "S2-M", sats: 49_000, durationSeconds: 600 });
    expect(n.onchainAddress).toBe(address);
    merchant.chain.add(address, t);
    expect(await sattleme.getStatus(n)).toMatchObject({ state: "unconfirmed", received: "49000" });
    merchant.chain.confirm(address, t.txid, merchant.chain.height - 5);
    const pAgain = await sattleme
      .createInvoice({ ref: "S2-Q", sats: 49_000 })
      .catch((error: unknown) => error);
    const nPaid = (await sattleme.getStatus(n)).state === "paid";
    const pPaid = pAgain instanceof OrderPaidError;
    expect(nPaid && pPaid).toBe(false);
  });
});

describe("S3: the witness of an earlier invoice of the order counts for a later one", () => {
  it("an underpayment of an expired invoice counts again for the next one", async () => {
    merchant.publishLot([LOT[0]!], 91);
    // On-chain only: no rest invoice is asked.
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const sattleme = client();
    const first = await sattleme.createInvoice({ ref: "S3-R", sats: 49_000, durationSeconds: 600 });
    const address = first.onchainAddress!;
    const t = payment(txid("S3 part"), address, 30_000);
    merchant.chain.add(address, t);
    expect(await sattleme.getStatus(first)).toMatchObject({ state: "open", received: "30000" });
    merchant.now = first.expiresAt + 121;
    // Underpaid for good: the merchant settles the 30 000 sats with the customer.
    expect(await sattleme.getStatus(first)).toEqual({ state: "expired", received: "30000" });
    // T leaves the mempool (evicted).
    merchant.chain.drop(address, t.txid);
    merchant.now = first.expiresAt + 120 + 301;
    const second: Invoice | Error = await sattleme
      .createInvoice({ ref: "S3-R", sats: 49_000, durationSeconds: 600 })
      .catch((error: unknown) => error as Error);
    if (second instanceof Error) {
      // No address for it (the fix): nothing can count twice.
      expect(second).toBeInstanceOf(OnchainUnavailableError);
      return;
    }
    expect(second.onchainAddress).toBe(address);
    // T broadcast again after the second invoice's end: late, whatever its witness.
    merchant.now = second.expiresAt + 3600;
    merchant.chain.add(address, t);
    expect(await sattleme.getStatus(second)).toEqual({ state: "expired", received: "0" });
  });

  it("a witness of the earlier invoice, made after the later one leased the address", async () => {
    merchant.publishLot([LOT[0]!], 91);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const sattleme = client();
    const first = await sattleme.createInvoice({ ref: "S3-Q", sats: 49_000, durationSeconds: 600 });
    const address = first.onchainAddress!;
    const t = payment(txid("S3 unseen part"), address, 30_000);
    // Received by BlockCypher while the first lease ran; no check saw it; then evicted.
    merchant.chain.received.set(t.txid, new Date((first.createdAt + 10) * 1000).toISOString());
    // Beyond the reads of leases (7200 s), where the order's own records keep it off the address.
    merchant.now = first.createdAt + 7300;
    expect(await sattleme.getStatus(first)).toEqual({ state: "expired", received: "0" });
    const second = await sattleme.createInvoice({
      ref: "S3-Q",
      sats: 49_000,
      durationSeconds: 600
    });
    expect(second.onchainAddress).toBe(address);
    // T comes back after the second invoice's end; the first invoice is checked first.
    merchant.now = second.expiresAt + 3600;
    merchant.chain.add(address, t);
    const firstStatus = await sattleme.getStatus(first);
    const secondStatus = await sattleme.getStatus(second);
    const counted = [firstStatus, secondStatus].filter(
      (status) => "received" in status && status.received === "30000"
    );
    // T was received once: it counts for one invoice at most.
    expect(counted.length).toBeLessThanOrEqual(1);
  });
});

describe("S6: a hostile relay hides a lease from the majority that reads", () => {
  // The confirmation reads on every relay (SPEC.md §13): r2, late but in time, shows the lease.
  it("the lease reached H and r2 only; H and r1 answer first", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const [r1, h, r2] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    const lease = leaseBy("S6-A", LOT[0]!);
    // r1 refused it.
    h.take(lease);
    r2.take(lease);
    h.behaviour = { hide: (event) => event.id === lease.id };
    // r2 answers its reads 1.5 s late, well within the timeout (4 s): H and r1 answer first,
    // whatever the load of the machine running the test.
    r2.behaviour = { queryDelayMs: 1500 };
    void r1;
    const invoice = await client({ relayTimeoutMs: 4000 }).createInvoice({
      ref: "S6-B",
      sats: 49_000
    });
    expect(invoice.onchainAddress).toBeNull();
  });
});

describe("copies of a record under ids of their own: a read keeps none of them whole", () => {
  /** `event` with another tag and date, its id recomputed, its signature left as it is. */
  function copyOf(event: NostrEvent, index: number, filler: string): NostrEvent {
    const copy = {
      pubkey: event.pubkey,
      created_at: event.created_at - 1 - index,
      kind: event.kind,
      tags: [...event.tags, ["x", filler]],
      content: event.content
    };
    const { pubkey, created_at, kind, tags, content } = copy;
    const id = bytesToHex(
      sha256(utf8ToBytes(JSON.stringify([0, pubkey, created_at, kind, tags, content])))
    );
    return { id, ...copy, sig: event.sig };
  }

  it("a lease: of each copy, only its id, author, date and signature are kept", async () => {
    const lease = leaseBy("OTHER", LOT[0]!, { createdAt: merchant.now - 60 });
    everywhere(lease);
    const filler = "y".repeat(50_000);
    // Relays that keep them all (anybody can write at a lease's address): read on any majority.
    const copies = Array.from({ length: 200 }, (_, i) => copyOf(lease, i, filler));
    for (const relay of relays()) for (const copy of copies) relay.store(copy);
    const pool = new RelayPool({
      createSocket: (url) => new merchant.net.WebSocket(url),
      timeoutMs: 2000,
      now: () => merchant.now
    });
    try {
      const read = await readLeases(pool, merchant.registryKey, [LOT[0]!], merchant.keyRelays, {
        now: merchant.now,
        random: seeded(1)
      });
      const records = read.records.get(LOT[0]!)!;
      // Every copy opens as the lease does (its id is its hash, its content decrypts).
      expect(records).toHaveLength(201);
      for (const { event } of records) {
        expect(Object.keys(event).sort()).toEqual(["created_at", "id", "pubkey", "sig"]);
      }
      expect(JSON.stringify(records.map(({ event }) => event)).length).toBeLessThan(201 * 400);
      // Only the lease is signed: the walk still finds the address leased.
      expect(records.filter((record) => record.signed()).map(({ event }) => event.id)).toEqual([
        lease.id
      ]);
      expect(isLeased(records, merchant.now)).toBe(true);
    } finally {
      pool.close();
    }
  }, 30_000);

  it("a signed record: a copy is not kept, its signature does not check out", () => {
    const keys = channelKeys(merchant.integrationKey);
    const keep = recordsThatOpen((_, author) =>
      author === merchant.team ? keys.encryptionKey : null
    );
    const channel = merchant.channelEvent(merchant.channelValue(100), 100);
    expect(keep(channel)).toStrictEqual(channel);
    expect(keep(copyOf(channel, 0, "z".repeat(1000)))).toBeUndefined();
    expect(keep({ ...channel, sig: "00".repeat(64) })).toBeUndefined();
    // Another key's: not opened, not kept.
    expect(keep({ ...channel, pubkey: "ab".repeat(32) })).toBeUndefined();
  });
});
