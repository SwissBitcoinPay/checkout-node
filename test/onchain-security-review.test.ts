import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registryOf } from "../src/declaration.js";
import { saleOf, type Sale } from "../src/derive.js";
import {
  InvoicePendingError,
  NetworkError,
  OnchainUnavailableError,
  OrderPaidError,
  Sattleme,
  type Invoice,
  type SattlemeOptions
} from "../src/index.js";
import { signEvent, type NostrEvent } from "../src/nostr/event.js";
import { afterCompletePage, entryOf } from "../src/nostr/relay.js";
import { leaseAddress } from "../src/onchain/address.js";
import { leaseEvent, openLeaseRecord, withdrawalEvent } from "../src/onchain/lease.js";
import { sealRecord } from "../src/nostr/record.js";
import { addressTag, orderTag, seenOf, witnessAddress } from "../src/onchain/witness.js";
import type { RandomBytes } from "../src/random.js";

import { depositAddress, payment, txid } from "./helpers/chain.js";
import { TestMerchant } from "./helpers/merchant.js";

/*
 * More attacks on on-chain payments (F1, F2, G3, G4, H1, H2, I1, L1 to L3, R6, R7, and S6 for
 * witnesses), end to end against local relays and fakes of the explorers. Each test states what
 * must hold (test/onchain-security.test.ts holds S1 to S6).
 */

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

/** The kinds of the records of `author` at `d` a relay holds: "lease" or "withdrawn". */
function leaseKinds(relay: { events: unknown[] }, d: string, author: string): string[] {
  return (relay.events as NostrEvent[])
    .filter(
      (e) => e.pubkey === author && e.tags.some(([name, value]) => name === "d" && value === d)
    )
    .map((e) => openLeaseRecord(e, merchant.registryKey, d)?.outside.kind ?? "unopened");
}

describe("F1, F2: leases withdrawn or confirmed", () => {
  it("F1: a withdrawal on one relay only frees the address there, for another order", async () => {
    merchant.publishLot([LOT[0]!], 91);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const [r1, r2, r3] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    const start = merchant.now;
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    const author = saleOfRef("F1-R").author;
    const atD = (event: NostrEvent) =>
      event.pubkey === author && event.tags.some(([name, value]) => name === "d" && value === d);
    // Another server's short lease of the address reaches every relay right after R's: R's lease
    // is not confirmed. R's withdrawal of it reaches r1 only.
    let raced = false;
    for (const relay of relays()) {
      let taken = 0;
      relay.behaviour = {
        onEvent: (event) => {
          if (raced || event.pubkey !== author) return;
          raced = true;
          everywhere(leaseBy("F1-C", LOT[0]!, { createdAt: start, seconds: 60 }));
        },
        refuseEvent: (event) =>
          relay !== r1 && atD(event) && taken++ > 0 ? "blocked: rate-limited" : undefined
      };
    }
    await expect(client().createInvoice({ ref: "F1-R", sats: 49_000 })).rejects.toBeInstanceOf(
      OnchainUnavailableError
    );
    for (const relay of relays()) relay.behaviour = {};
    expect(leaseKinds(r1, d, author)).toEqual(["withdrawn"]);
    expect(leaseKinds(r2, d, author)).toEqual(["lease"]);
    expect(leaseKinds(r3, d, author)).toEqual(["lease"]);
    // The other lease over; R's still running on r2 and r3.
    merchant.now = start + 600;
    r1.behaviour = { queryDelayMs: 500 };
    const again = await client()
      .createInvoice({ ref: "F1-R", sats: 49_000 })
      .catch((error: unknown) => error);
    // R's lease was never confirmed: it gives R no address, and still holds it where it is.
    expect(again).toBeInstanceOf(OnchainUnavailableError);
    r1.behaviour = {};
    r2.behaviour = { queryDelayMs: 500 };
    void r3;
    const other = await client()
      .createInvoice({ ref: "F1-D", sats: 49_000 })
      .catch((error: unknown) => error);
    const dAddress = other instanceof Error ? null : (other as Invoice).onchainAddress;
    // Read on r1 and r3, R's withdrawal is its newest record: the address is free for D.
    expect(dAddress).toBe(LOT[0]);
  });

  it("F2: an invoice shown and paid keeps its address when the order asks again", async () => {
    merchant.publishLot([LOT[0]!, LOT[1]!], 91);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const [r1] = relays() as [ReturnType<typeof relays>[0]];
    const sattleme = client();
    const a = await sattleme.createInvoice({ ref: "F2-A", sats: 49_000, durationSeconds: 900 });
    const x = a.onchainAddress!;
    merchant.chain.add(x, payment(txid("F2 pays"), x, 49_000));
    expect(await sattleme.getStatus(a)).toMatchObject({ state: "unconfirmed", received: "49000" });
    // Another server's lease of x, its withdrawal on r1 only (a blip).
    const b = saleOfRef("F2-B");
    const lb = leaseBy("F2-B", x, { createdAt: merchant.now + 1 });
    everywhere(lb);
    r1.take(withdrawalEvent({ sale: b, address: x, createdAt: merchant.now + 2 }));
    merchant.now += 30;
    r1.behaviour = { queryDelayMs: 500 };
    const again = await sattleme
      .createInvoice({ ref: "F2-A", sats: 49_000, durationSeconds: 900 })
      .catch((error: unknown) => error);
    expect(again).toBeInstanceOf(InvoicePendingError);
    expect((again as InvoicePendingError).invoice.onchainAddress).toBe(x);
  });
});

describe("G3: a flood at a lease's d tag keeps the address only while it lasts", () => {
  it("the lease the flood kept from being confirmed is withdrawn", async () => {
    merchant.publishLot([LOT[0]!], 91);
    // On-chain only: no address, no invoice.
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    const author = saleOfRef("G3-1").author;
    // Whoever watches the relays sees the new lease, and fills its d tag at once: 101 records of
    // one second, so that no read of it is complete. They are signed before the call: the relays
    // and the client share one thread, and signing them inside a relay's answer (before its OK)
    // held the lease's publication past its timeout on a loaded CI runner (NetworkError).
    const flood = Array.from({ length: 101 }, (_, i) => junk(d, merchant.now, i));
    let flooded = false;
    for (const relay of relays()) {
      relay.behaviour = {
        onEvent: (event) => {
          if (flooded || event.pubkey !== author) return;
          flooded = true;
          for (const record of flood) everywhere(record);
        }
      };
    }
    // Time enough for every relay to page through the flood however busy the machine: one that
    // ran out of time would leave fewer than a majority answered (NetworkError), not this.
    const sattleme = client({ relayTimeoutMs: 10_000 });
    await expect(sattleme.createInvoice({ ref: "G3-1", sats: 49_000 })).rejects.toBeInstanceOf(
      OnchainUnavailableError
    );
    expect(flooded).toBe(true);
    for (const relay of relays()) expect(leaseKinds(relay, d, author)).toEqual(["withdrawn"]);
    // The flood over (its records gone): the address is free at once, not at the lease's end.
    const junkAuthors = new Set(
      (relays()[0]!.events as NostrEvent[])
        .filter((e) => e.tags.some(([name, value]) => name === "d" && value === d))
        .map((e) => e.pubkey)
        .filter((pubkey) => pubkey !== author)
    );
    for (const relay of relays()) relay.behaviour = { hide: (e) => junkAuthors.has(e.pubkey) };
    const next = await sattleme.createInvoice({ ref: "G3-2", sats: 49_000 });
    expect(next.onchainAddress).toBe(LOT[0]);
  }, 60_000);
});

describe("G4: a mark a minority took brings back an invoice never shown", () => {
  it("of two invoices that may still be paid, the one shown and paid wins", async () => {
    merchant.publishLot([LOT[0]!, LOT[1]!], 91);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const [r1, r2, r3] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    const author = saleOfRef("G4-R").author;
    // The lease's mark (its second record) reaches r1 only: NetworkError, nothing shown.
    let first: string | null = null;
    for (const relay of [r2, r3]) {
      let taken = 0;
      relay.behaviour = {
        refuseEvent: (event) => {
          if (event.pubkey !== author) return undefined;
          const d = event.tags.find(([name]) => name === "d")?.[1] ?? "";
          first ??= d;
          return d === first && taken++ > 0 ? "blocked: rate-limited" : undefined;
        }
      };
    }
    const sattleme = client();
    await expect(sattleme.createInvoice({ ref: "G4-R", sats: 49_000 })).rejects.toBeInstanceOf(
      NetworkError
    );
    // Asked again while r1 is slow: its lease reads as not confirmed, so another invoice is made,
    // shown and paid.
    r2.behaviour = {};
    r3.behaviour = {};
    r1.behaviour = { queryDelayMs: 500 };
    const shown = await sattleme.createInvoice({ ref: "G4-R", sats: 49_000 });
    expect(shown.onchainAddress).not.toBeNull();
    r1.behaviour = {};
    const t = payment(txid("G4 shown"), shown.onchainAddress!, 49_000);
    merchant.chain.add(shown.onchainAddress!, t);
    expect(await sattleme.getStatus(shown)).toMatchObject({ state: "unconfirmed" });
    merchant.chain.confirm(shown.onchainAddress!, t.txid, merchant.chain.height - 5);
    // Asked again, every relay answering: the first invoice is confirmed on r1, older, and may
    // still be paid; the order was paid with the one shown.
    const again = await sattleme
      .createInvoice({ ref: "G4-R", sats: 49_000 })
      .catch((error: unknown) => error);
    expect(again).toBeInstanceOf(OrderPaidError);
    expect((again as OrderPaidError).invoice.onchainAddress).toBe(shown.onchainAddress);
  });
});

describe("H1: two calls of one order at once (its lock failed)", () => {
  it("the call that loses never ends the lease of the one that won", async () => {
    merchant.publishLot([LOT[0]!], 91);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    const author = saleOfRef("H1-R").author;
    const c = merchant.now;
    // Once the winner's mark (created_at c + 1) is kept, two seconds pass.
    let marked = 0;
    let markedEverywhere = () => {};
    const winnerMarked = new Promise<void>((resolve) => (markedEverywhere = resolve));
    for (const relay of relays()) {
      relay.behaviour = {
        onEvent: (event) => {
          const atD = event.tags.some(([name, value]) => name === "d" && value === d);
          if (event.pubkey === author && event.created_at === c + 1 && atD) {
            merchant.now = c + 2;
            marked += 1;
            if (marked >= relays().length) markedEverywhere();
          }
        }
      };
    }
    // The loser's writes reach the relays once every relay kept the winner's mark: the winner
    // marks first however busy the machine (300 ms late was not enough on a loaded CI runner), and
    // the loser waits for it within its own relay timeout.
    const Base = merchant.net.WebSocket;
    class HeldWrites extends Base {
      override send(data: string) {
        if (String(data).startsWith('["EVENT"')) {
          void winnerMarked.then(() => {
            try {
              super.send(data);
            } catch {
              // Closed meanwhile.
            }
          });
        } else {
          super.send(data);
        }
      }
    }
    const [loser, winner] = await Promise.all([
      client({ WebSocket: HeldWrites, relayTimeoutMs: 10_000 })
        .createInvoice({ ref: "H1-R", sats: 49_000 })
        .catch((error: unknown) => error),
      client()
        .createInvoice({ ref: "H1-R", sats: 49_000 })
        .catch((error: unknown) => error)
    ]);
    for (const relay of relays()) relay.behaviour = {};
    expect(loser).toBeInstanceOf(OnchainUnavailableError);
    expect((winner as Invoice).onchainAddress).toBe(LOT[0]);
    // The winner's mark stays the order's newest record there, on every relay.
    for (const relay of relays()) expect(leaseKinds(relay, d, author)).toEqual(["lease"]);
    merchant.now = c + 30;
    // Another order gets no address; the order's invoice is still the one handed out.
    await expect(client().createInvoice({ ref: "H1-D", sats: 49_000 })).rejects.toBeInstanceOf(
      OnchainUnavailableError
    );
    const again = await client()
      .createInvoice({ ref: "H1-R", sats: 49_000 })
      .catch((error: unknown) => error);
    expect(again).toBeInstanceOf(InvoicePendingError);
    expect((again as InvoicePendingError).invoice.onchainAddress).toBe(LOT[0]);
  }, 60_000);
});

describe("H2: of two invoices that may still be paid, the one shown is handed out", () => {
  // Call 1 (its server's clock `skew` s ahead): its mark reaches r1 only, NetworkError. Call 2
  // (r1 slow) makes and shows another invoice. Call 3 (r2 slow) reads both.
  async function twoPending(skew: number) {
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const [x, y] = [LOT[0]!, LOT[1]!];
    merchant.publishLot([x], 91);
    const [r1, r2, r3] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    const author = saleOfRef("H2-R").author;
    const c1 = merchant.now + skew;
    const refuse = {
      refuseEvent: (event: NostrEvent) =>
        event.pubkey === author && event.created_at > c1 ? "error: down" : undefined
    };
    r2.behaviour = refuse;
    r3.behaviour = refuse;
    await expect(
      client({ now: () => (merchant.now + skew) * 1000 }).createInvoice({
        ref: "H2-R",
        sats: 49_000
      })
    ).rejects.toBeInstanceOf(NetworkError);
    merchant.publishLot([x, y], 92);
    r2.behaviour = {};
    r3.behaviour = {};
    r1.behaviour = { queryDelayMs: 500 };
    const shown = await client().createInvoice({ ref: "H2-R", sats: 49_000 });
    expect(shown.onchainAddress).toBe(y);
    r1.behaviour = {};
    r2.behaviour = { queryDelayMs: 500 };
    const again = await client()
      .createInvoice({ ref: "H2-R", sats: 49_000 })
      .catch((error: unknown) => error);
    expect(again).toBeInstanceOf(InvoicePendingError);
    expect((again as InvoicePendingError).invoice.onchainAddress).toBe(shown.onchainAddress);
  }

  it("the failed call's server's clock 3 s ahead", async () => {
    await twoPending(3);
  });

  it("both of one second, the one never shown sorting last", async () => {
    await twoPending(0);
  });
});

describe("I1: a relay counts for a record only with a copy of it", () => {
  it("an object that only carries the id of the mark never shown counts for nothing", async () => {
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const [x, y] = [LOT[0]!, LOT[1]!];
    merchant.publishLot([x], 91);
    const [r1, r2, r3] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    const author = saleOfRef("I1-R").author;
    const c = merchant.now;
    // Call 1: its mark reaches r1 only, NetworkError.
    const later = {
      refuseEvent: (event: NostrEvent) =>
        event.pubkey === author && event.created_at > c ? "error: down" : undefined
    };
    r2.behaviour = later;
    r3.behaviour = later;
    await expect(client().createInvoice({ ref: "I1-R", sats: 49_000 })).rejects.toBeInstanceOf(
      NetworkError
    );
    // Call 2: r1 slow and refusing the order's records; its invoice, on y, is shown.
    merchant.publishLot([x, y], 92);
    merchant.now = c + 30;
    r2.behaviour = {};
    r3.behaviour = {};
    r1.behaviour = {
      queryDelayMs: 500,
      refuseEvent: (event: NostrEvent) => (event.pubkey === author ? "error: down" : undefined)
    };
    const shown = await client().createInvoice({ ref: "I1-R", sats: 49_000 });
    expect(shown.onchainAddress).toBe(y);
    const at = (relay: ReturnType<typeof relays>[0], address: string) =>
      (relay.events as NostrEvent[]).find(
        (e) =>
          e.pubkey === author &&
          e.tags.some(
            ([name, value]) => name === "d" && value === leaseAddress(merchant.registryKey, address)
          )
      )!;
    const markX = at(r1, x);
    const markY = at(r2, y);
    // Call 3: r3 hides y's mark, and sends an object that only carries x's mark's id.
    r1.behaviour = {};
    r3.behaviour = { hide: (event) => event.id === markY.id };
    r3.store({ ...markX, content: "not the event", sig: "00".repeat(64) });
    merchant.now = c + 60;
    const again = await client()
      .createInvoice({ ref: "I1-R", sats: 49_000 })
      .catch((error: unknown) => error);
    expect(again).toBeInstanceOf(InvoicePendingError);
    expect((again as InvoicePendingError).invoice.onchainAddress).toBe(y);
  });
});

describe("S6 (witnesses): a relay hides another order's witness", () => {
  it("the witnesses read again on every relay still show it: the transaction counts for nothing", async () => {
    merchant.publishLot([LOT[0]!], 91);
    const sattleme = client({ relayTimeoutMs: 4000 });
    const p = await sattleme.createInvoice({ ref: "W6-P", sats: 49_000 });
    const x = p.onchainAddress!;
    const t = payment(txid("W6 paid once"), x, 49_000);
    // Another order's witness of t, in time for it: on r1 (which hides it) and r2 (late), not r3.
    const seen = seenOf(merchant.integrationKey);
    const other = saleOfRef("W6-N").author;
    const witness = sealRecord({
      type: "integration-onchain-seen",
      value: {
        version: 1,
        address: x,
        txid: t.txid,
        sale: other,
        sats: 49_000,
        inputs: t.vin.map(({ txid: spent, vout }) => `${spent}:${vout}`),
        replacement: false,
        expiresAt: p.expiresAt
      },
      signer: seen.secretKey,
      encryptionKey: seen.encryptionKey,
      address: witnessAddress(seen.addressKey, x, t.txid, other),
      createdAt: merchant.now,
      tags: [
        ["o", orderTag(seen.addressKey, x, other)],
        ["o", addressTag(seen.addressKey, x)]
      ]
    });
    const [r1, r2] = relays() as [ReturnType<typeof relays>[0], ReturnType<typeof relays>[0]];
    r1.take(witness);
    r2.take(witness);
    r1.behaviour = { hide: (event) => event.id === witness.id };
    r2.behaviour = { queryDelayMs: 1500 };
    merchant.chain.add(x, t);
    // The first read (r1 and r3) misses it, so this check publishes its own witness; read again
    // on every relay, r2 shows the other's: t is another invoice's, and counts for nothing here.
    expect(await sattleme.getStatus(p)).toMatchObject({ state: "open", received: "0" });
  });
});

describe("R6: a relay that failed is waited for once per call", () => {
  it("two confirmations on every relay, one relay mute: one timeout in all", async () => {
    merchant.publishLot([LOT[0]!, LOT[1]!], 91);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const [r1, r2, r3] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    const author = saleOfRef("R6-R").author;
    // Each lease of the order meets another server's lease of its address at once: not confirmed.
    const competing = new Set<string>();
    for (const relay of [r1, r2]) {
      relay.behaviour = {
        onEvent: (event) => {
          const d = event.tags.find(([name]) => name === "d")?.[1];
          if (event.pubkey !== author || d === undefined || competing.has(d)) return;
          competing.add(d);
          const address = LOT.find((a) => leaseAddress(merchant.registryKey, a) === d)!;
          const other = leaseBy(`R6-OTHER-${address}`, address);
          r1.take(other);
          r2.take(other);
        }
      };
    }
    r3.behaviour = { mute: true };
    const start = performance.now();
    await expect(
      client({ relayTimeoutMs: 3000 }).createInvoice({ ref: "R6-R", sats: 49_000 })
    ).rejects.toBeInstanceOf(OnchainUnavailableError);
    const ms = performance.now() - start;
    expect(competing.size).toBe(2);
    // The first confirmation waits for r3 until its timeout; the second counts it failed at once:
    // under two timeouts (6 s), with time to spare on a busy machine.
    expect(ms).toBeLessThan(5000);
  });
});

describe("R7: a read on every relay keeps the pages a relay sent before the cut", () => {
  it("a relay that holds the lease, still paging at the cut, still shows it", async () => {
    merchant.publishLot([LOT[0]!], 91);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    const [r1, h, r2] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    // Anybody's records at the address's d tag, older than the lease: 20 pages to read.
    for (let i = 0; i < 1950; i += 1) everywhere(junk(d, merchant.now - 10 - i, i));
    const lease = leaseBy("R7-A", LOT[0]!);
    // r1 missed the lease; h hides it; r2 answers each page in 150 ms, its 20 pages outlasting the
    // one timeout the read waits after a majority.
    h.take(lease);
    r2.take(lease);
    h.behaviour = { hide: (event) => event.id === lease.id };
    r2.behaviour = { queryDelayMs: 150 };
    void r1;
    await expect(
      client({ relayTimeoutMs: 1000 }).createInvoice({ ref: "R7-D", sats: 49_000 })
    ).rejects.toBeInstanceOf(OnchainUnavailableError);
  }, 60_000);
});

describe("R8: a relay still reading when a read on every relay ends has not answered", () => {
  it("one relay failed, one read incompletely, one still reading: fewer than a majority answered", async () => {
    merchant.publishLot([LOT[0]!], 91);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    const [r1, r2, r3] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    // Anybody's records at the address's d tag: a full first page, older than the lease.
    for (let i = 0; i < 150; i += 1) everywhere(junk(d, merchant.now - 10 - i, i));
    // r2 fails (it never answers). Once they hold the order's lease, r1 and r3 never answer a
    // second page of the address's leases; r3 answers each query 500 ms late. At the lease's
    // confirmation, r2 failed already, r1 stops incomplete one timeout after its first page, while
    // r3, its first page sent, still waits for its second: a majority can no longer read
    // completely, and only r1 answered.
    const author = saleOfRef("R8").author;
    const second =
      (relay: ReturnType<typeof relays>[0]) => (filter: { "#d"?: string[]; until?: number }) =>
        filter["#d"]?.includes(d) === true &&
        filter.until !== undefined &&
        (relay.events as NostrEvent[]).some(
          (e) => e.pubkey === author && e.tags.some(([name, value]) => name === "d" && value === d)
        );
    r1.behaviour = { muteQuery: second(r1) };
    r2.behaviour = { mute: true };
    r3.behaviour = { muteQuery: second(r3), queryDelayMs: 500 };
    await expect(
      client({ relayTimeoutMs: 1000 }).createInvoice({ ref: "R8", sats: 49_000 })
    ).rejects.toBeInstanceOf(NetworkError);
  }, 30_000);
});

describe("L1, L2: a lease not confirmed beside another call's mark (the order's lock failed)", () => {
  /** The mark of another call of the order `ref`: its lease of `address` at `c`, confirmed at c + 1. */
  function markOf(ref: string, address: string, c: number): NostrEvent {
    return leaseEvent({
      sale: saleOfRef(ref),
      terms: {
        address,
        sats: 49_000n,
        invoice: null,
        verifyUrl: null,
        createdAt: c,
        expiresAt: c + 900,
        price: { minor: 49_000, digits: 0, currency: "SAT" },
        note: ref,
        tolerance: 0,
        confirmed: true
      },
      createdAt: c + 1
    });
  }

  /** The withdrawals of `author` at `d` the relays received. */
  function withdrawals(d: string, author: string): NostrEvent[] {
    return relays().flatMap((relay) =>
      relay.received.filter(
        (event) =>
          event.pubkey === author &&
          openLeaseRecord(event, merchant.registryKey, d)?.outside.kind === "withdrawn"
      )
    );
  }

  it("L1: fewer than a majority answer the confirmation, the minority showing the mark: not withdrawn", async () => {
    merchant.publishLot([LOT[0]!], 91);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    const author = saleOfRef("L1-R").author;
    const mark = markOf("L1-R", LOT[0]!, merchant.now);
    const [r1, r2, r3] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    // Once this call's lease is taken, the other call's mark is everywhere, and r2 and r3 answer
    // reads too late (their writes at once).
    let marked = false;
    for (const relay of relays()) {
      relay.behaviour = {
        onEvent: (event) => {
          if (marked || event.pubkey !== author) return;
          marked = true;
          everywhere(mark);
          r2.behaviour = { queryDelayMs: 5000 };
          r3.behaviour = { queryDelayMs: 5000 };
        }
      };
    }
    await expect(client().createInvoice({ ref: "L1-R", sats: 49_000 })).rejects.toBeInstanceOf(
      NetworkError
    );
    for (const relay of relays()) relay.behaviour = {};
    // r1 showed the mark: no withdrawal, which could have replaced it (same second, a lower id).
    expect(withdrawals(d, author)).toEqual([]);
    for (const relay of [r1, r2, r3]) expect(leaseKinds(relay, d, author)).toEqual(["lease"]);
    merchant.now += 30;
    await expect(client().createInvoice({ ref: "L1-D", sats: 49_000 })).rejects.toBeInstanceOf(
      OnchainUnavailableError
    );
  }, 30_000);

  it("L2: a copy of the mark with a damaged signature, sent first, hides no valid copy", async () => {
    merchant.publishLot([LOT[0]!], 91);
    merchant.pay = { ...merchant.pay, maxSendable: 1_000_000 };
    const d = leaseAddress(merchant.registryKey, LOT[0]!);
    const author = saleOfRef("L2-R").author;
    const mark = markOf("L2-R", LOT[0]!, merchant.now);
    const damaged = { ...mark, sig: (mark.sig[0] === "0" ? "1" : "0") + mark.sig.slice(1) };
    const [r1, r2, r3] = relays() as [
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0],
      ReturnType<typeof relays>[0]
    ];
    // r1 sends the damaged copy alone, first; r2 and r3 the valid one, 100 ms later.
    let marked = false;
    for (const relay of relays()) {
      relay.behaviour = {
        onEvent: (event) => {
          if (marked || event.pubkey !== author) return;
          marked = true;
          everywhere(mark);
          r1.store(damaged);
          r1.behaviour = { hide: (e) => e.id === mark.id && e.sig === mark.sig };
          r2.behaviour = { queryDelayMs: 100 };
          r3.behaviour = { queryDelayMs: 100 };
        }
      };
    }
    await expect(client().createInvoice({ ref: "L2-R", sats: 49_000 })).rejects.toBeInstanceOf(
      OnchainUnavailableError
    );
    for (const relay of relays()) relay.behaviour = {};
    expect(withdrawals(d, author)).toEqual([]);
    for (const relay of [r2, r3]) expect(leaseKinds(relay, d, author)).toEqual(["lease"]);
  }, 30_000);
});

describe("L3: a complete read, a full page whose only new event has no usable date", () => {
  it("asks the page again once (an event not seen before, dated or not), then stops incomplete", () => {
    const seen = new Set<string>();
    const kept: unknown[] = [];
    const page = (events: { id: string; created_at: number }[]) =>
      events.map((event) => entryOf(event, (value) => value));
    const first = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, created_at: 1000 }));
    expect(afterCompletePage(page(first), seen, kept, 1)).toEqual({ until: 1000 });
    const second = [...first.slice(0, 99), { id: "new", created_at: 2 ** 60 }];
    // SPEC.md §13: a new event, undated, lets the read go on from the dated ones.
    expect(afterCompletePage(page(second), seen, kept, 2)).toEqual({ until: 1000 });
    // The same page again brings nothing new: incomplete, never a loop.
    expect(afterCompletePage(page(second), seen, kept, 3)).toEqual({ complete: false });
    // Kept all the same, once.
    expect(kept).toHaveLength(101);
  });
});
