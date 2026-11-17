import { afterEach, describe, expect, it } from "vitest";

import { majority, RelayPool, type RelayState } from "../src/nostr/relay.js";
import { leaseAddress } from "../src/onchain/address.js";
import { readLeases } from "../src/onchain/lease.js";
import { MAX_PAGES, RECORD_KIND } from "../src/protocol.js";

import { bytes } from "./helpers/merchant.js";
import { RelayNet, type LocalRelay, type RelayBehaviour } from "./helpers/relay.js";
import { readSpec } from "./helpers/vectors.js";

/*
 * relay-reads.json end to end (PORTING.md, steps 4 and 5): its `lists` and `onEveryRelay` cases,
 * each relay's read made by a local relay and told apart by RelayPool itself, through readLeases,
 * the client's read of the leases of deposit addresses: a complete read (step 3 of "Leasing an
 * address"), and on every relay (a lease's confirmation). test/onchain-vectors.test.ts runs the
 * same cases through readOutcome, the function RelayPool decides them with.
 *
 * What each relay of a case does, by its state:
 * - complete: holds a few events at the lease's address (one page, not full); or 250, at distinct
 *   seconds (it pages: 100, 100, then 50); or caps its answers at 40 events (a page that is not
 *   full: complete, whatever it leaves out, SPEC.md §13 relies on relays that honor the limit).
 * - incomplete: holds 150 events of one second (a full page, then the same page again: no event
 *   it had not sent); or 2 100 at distinct seconds (a 20th page that is full); or never answers
 *   its second page (that page runs out of time).
 * - failed: refuses connections (nothing listens); or accepts them and never answers (mute: its
 *   first page runs out of time).
 * - reading: a relay still reading when the read goes on: one that holds 2 100 events at distinct
 *   seconds and answers each page a quarter of the timeout late (its read would last five
 *   timeouts); or a mute one, when the read goes on before its first page runs out of time.
 */

const vectors = readSpec<{
  lists: { name: string; relays: Exclude<RelayState, "reading">[]; expected: boolean }[];
  onEveryRelay: {
    name: string;
    relays: RelayState[];
    expected: { answered: boolean; complete: boolean };
  }[];
}>("vectors/relay-reads.json");

/**
 * relayTimeoutMs of these reads: each page, the connection included. Ample for a local relay on a
 * busy machine: a relay that reads completely, or ends its read, never runs out of time here.
 */
const TIMEOUT_MS = 2000;
/** How late a relay that is still reading answers each of its pages. */
const SLOW_PAGE_MS = TIMEOUT_MS / 4;
/**
 * How late the relays that read completely answer each page, when the read goes on as soon as a
 * majority read completely and every other relay's read must have ended (or failed) by then.
 */
const LATE_COMPLETE_MS = 400;

const NOW = 1_791_378_000;
const REGISTRY_KEY = bytes(9);
const ADDRESS = "bc1px22v5j99gdwhxqyelg2p6tdcfajjd3njhzn22c2gura2dvxg2xlqw2wte4";
const D = leaseAddress(REGISTRY_KEY, ADDRESS);

let serial = 0;
/**
 * `count` events at the lease's address, anybody's (none opens as a lease: a read pages through
 * them all the same), the newest at NOW; of one second each, or all of NOW.
 */
function events(count: number, oneSecond = false): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    id: (serial++).toString(16).padStart(64, "0"),
    pubkey: "ab".repeat(32),
    created_at: oneSecond ? NOW : NOW - i,
    kind: RECORD_KIND,
    tags: [["d", D]],
    content: "",
    sig: "00".repeat(64)
  }));
}

type Maker =
  | "few"
  | "pages"
  | "caps"
  | "oneSecond"
  | "twentyPages"
  | "stallsAtPage2"
  | "refusesConnections"
  | "mute"
  | "slowPager";

/**
 * The local relays that read as each state does, by name: each made at `url` (null: nothing
 * listens there), `delayMs` how late a relay that reads completely answers each page.
 */
const MAKERS: Record<
  Maker,
  (net: RelayNet, url: string, delayMs?: number) => Promise<LocalRelay | null>
> = {
  few: (net: RelayNet, url: string, delayMs?: number) =>
    hold(net, url, events(3), delayMs ? { queryDelayMs: delayMs } : {}),
  pages: (net: RelayNet, url: string, delayMs?: number) =>
    hold(net, url, events(250), delayMs ? { queryDelayMs: delayMs } : {}),
  caps: (net: RelayNet, url: string, delayMs?: number) =>
    hold(net, url, events(250), { cap: 40, ...(delayMs ? { queryDelayMs: delayMs } : {}) }),
  oneSecond: (net: RelayNet, url: string) => hold(net, url, events(150, true)),
  twentyPages: (net: RelayNet, url: string) => hold(net, url, events(2100)),
  stallsAtPage2: (net: RelayNet, url: string) =>
    hold(net, url, events(250), { muteQuery: (filter) => filter.until !== undefined }),
  refusesConnections: () => Promise.resolve(null),
  mute: (net: RelayNet, url: string) => net.add(url, { mute: true }),
  slowPager: (net: RelayNet, url: string) =>
    hold(net, url, events(2100), { queryDelayMs: SLOW_PAGE_MS })
};

async function hold(
  net: RelayNet,
  url: string,
  held: unknown[],
  behaviour: RelayBehaviour = {}
): Promise<LocalRelay> {
  const relay = await net.add(url, behaviour);
  for (const event of held) relay.store(event);
  return relay;
}

let net: RelayNet | null = null;
let pool: RelayPool | null = null;
afterEach(async () => {
  pool?.close();
  pool = null;
  await net?.close();
  net = null;
});

/**
 * Makes one local relay per maker, reads the leases of ADDRESS on them (on every relay or not),
 * and tells how long the read took: the relays by URL, and what the read gave.
 */
async function read(makers: { maker: Maker; delayMs?: number }[], everyRelay: boolean) {
  net = new RelayNet();
  const urls = makers.map(({ maker }, index) => `wss://${maker}-${index}.test`);
  const relays = new Map<string, LocalRelay | null>();
  for (const [index, { maker, delayMs }] of makers.entries()) {
    relays.set(urls[index]!, await MAKERS[maker](net, urls[index]!, delayMs));
  }
  const socket = net.WebSocket;
  pool = new RelayPool({
    createSocket: (url) => new socket(url),
    timeoutMs: TIMEOUT_MS,
    now: () => NOW
  });
  const started = performance.now();
  const leases = await readLeases(pool, REGISTRY_KEY, [ADDRESS], urls, {
    now: NOW,
    random: (length) => bytes(7, length),
    everyRelay
  });
  return {
    elapsedMs: performance.now() - started,
    relays,
    urls,
    outcome: { answered: leases.answered, complete: leases.complete }
  };
}

/** How many relays each choice of makers made so far: its makers take turns. */
const turns = new Map<string, number>();
/** Every maker the cases used. */
const used = new Set<Maker>();
/** The next of `makers`, in turn: the relays of one state vary from case to case. */
function next(...makers: Maker[]): Maker {
  const key = makers.join();
  const turn = turns.get(key) ?? 0;
  turns.set(key, turn + 1);
  const maker = makers[turn % makers.length]!;
  used.add(maker);
  return maker;
}

describe("relay-reads.json lists, end to end: a complete read of a list", () => {
  it.each(vectors.lists)("$name", async ({ relays, expected }) => {
    // Complete: the read goes on as soon as a majority read completely, the others dropped; so
    // that each of those has ended as the case says by then, they end at once and the relays that
    // read completely answer late. Not complete: the read waits for every relay.
    const makers = relays.map((state): { maker: Maker; delayMs?: number } => {
      if (state === "complete") {
        const maker = next("few", "pages", "caps");
        return expected ? { maker, delayMs: LATE_COMPLETE_MS } : { maker };
      }
      if (state === "incomplete") {
        return {
          maker: expected ? next("oneSecond") : next("oneSecond", "stallsAtPage2", "twentyPages")
        };
      }
      return { maker: expected ? next("refusesConnections") : next("mute", "refusesConnections") };
    });
    const { outcome } = await read(makers, false);
    expect(outcome.complete).toBe(expected);
  });
});

/**
 * When RelayPool goes on with a complete read on every relay while these are its relays' states
 * (SPEC.md §13): once no relay is still reading ("settled"); or, with some still reading, a timeout
 * after a majority read completely ("grace"), or as soon as a majority can no longer read
 * completely ("at once"). Otherwise (null) it never does: it waits for the relays still reading,
 * until each ends or fails.
 */
function goesOnWith(states: readonly RelayState[]): "settled" | "grace" | "at once" | null {
  const count = (state: RelayState) => states.filter((s) => s === state).length;
  const needed = majority(states.length);
  if (count("reading") === 0) return "settled";
  if (count("complete") >= needed) return "grace";
  if (count("complete") + count("reading") < needed) return "at once";
  return null;
}

describe("relay-reads.json onEveryRelay, end to end: a read of a lease's confirmation", () => {
  const producible = vectors.onEveryRelay.filter(({ relays }) => goesOnWith(relays) !== null);
  const waited = vectors.onEveryRelay.filter(({ relays }) => goesOnWith(relays) === null);

  it("has cases of every kind", () => {
    expect(producible.map(({ relays }) => goesOnWith(relays))).toEqual(
      expect.arrayContaining(["at once", "grace", "settled"])
    );
    expect(waited.length).toBeGreaterThan(0);
  });

  it.each(producible)("$name", async ({ relays, expected }) => {
    const when = goesOnWith(relays)!;
    // A relay that is not still reading must have ended or failed when the read goes on: before
    // the timeout after a majority read completely ("grace"), or at once.
    const makers = relays.map((state): { maker: Maker } => {
      if (state === "complete") return { maker: next("few", "pages", "caps") };
      if (state === "incomplete") {
        return {
          maker:
            when === "settled"
              ? next("oneSecond", "stallsAtPage2", "twentyPages")
              : next("oneSecond", "twentyPages")
        };
      }
      if (state === "failed") {
        return {
          maker:
            when === "settled" ? next("refusesConnections", "mute") : next("refusesConnections")
        };
      }
      return { maker: when === "grace" ? next("slowPager") : next("mute") };
    });
    const { outcome, elapsedMs, relays: made, urls } = await read(makers, true);
    expect(outcome).toEqual(expected);
    const reading = urls.filter((_, index) => relays[index] === "reading");
    if (when === "grace") {
      // The relays still reading were waited for a timeout after the majority, not until they end.
      expect(elapsedMs).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
      for (const url of reading) expect(made.get(url)!.queries.length).toBeLessThan(MAX_PAGES);
    }
    if (when === "at once") {
      // Before a mute relay's first page could run out of time: it was still reading.
      expect(elapsedMs).toBeLessThan(TIMEOUT_MS - 100);
    }
  });

  /*
   * The cases RelayPool never goes on with: fewer than a majority read completely while a majority
   * still can, some relays still reading. A complete read on every relay then waits for them
   * (SPEC.md §13: it goes on once every relay did or failed, a timeout after a majority did, or as
   * soon as a majority can no longer read completely), so no local relay can make a relay still
   * reading when it goes on: a relay that reads slowly is waited for until it ends, a mute one
   * until its first page runs out of time. With mute relays in their place, the read goes on once
   * they failed, and gives what the case expects: a relay still reading answered no more than one
   * that failed.
   */
  it.each(waited)("$name: waited for until the relays still reading fail", async (c) => {
    const makers = c.relays.map((state): { maker: Maker } => {
      if (state === "complete") return { maker: next("few", "pages", "caps") };
      if (state === "incomplete") return { maker: next("oneSecond", "twentyPages") };
      if (state === "failed") return { maker: next("refusesConnections") };
      return { maker: next("mute") };
    });
    const { outcome, elapsedMs } = await read(makers, true);
    expect(elapsedMs).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(outcome).toEqual(c.expected);
  });
});

describe("the local relays of these reads", () => {
  it("were of every kind: each state made more than one way", () => {
    expect([...used].sort()).toEqual(Object.keys(MAKERS).sort());
  });
});
