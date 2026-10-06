import { describe, expect, test } from "bun:test";

import type { ErrorKind } from "../../src/core/errors";
import { Indexer } from "../../src/indexer/indexer";
import { addressStatus, recordGauges } from "../../src/indexer/status";
import type { TrackedAddress } from "../../src/indexer/tracked-address";
import type { Walk } from "../../src/indexer/walk";
import { Metrics } from "../../src/metrics/metrics";
import type { ChainTip } from "../../src/source/source";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import { FakeChain, FakeSource, fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const B = fakeAddress(2);
const hash = Buffer.alloc(32);

const tracked = (
  overrides: Partial<TrackedAddress["state"]> = {},
  gapsOpen = 0,
): TrackedAddress => ({
  state: {
    address: A,
    startLt: 0n,
    active: true,
    head: { lt: 500n, hash },
    frontier: { lt: 300n, hash },
    syncedLt: 250n,
    syncedUtime: 1_000,
    ...overrides,
  },
  nextPollAt: 0,
  idleStreak: 0,
  verifiedAt: 0,
  needsMaintenance: false,
  gapsOpen,
});

const walk = (overrides: Partial<Walk> = {}): Walk => ({
  address: A,
  kind: "gap",
  cursor: { lt: 1n, hash },
  floorLt: 0n,
  topLt: 1n,
  id: 1,
  pages: 0,
  fetched: 0,
  split: false,
  failures: 0,
  notBefore: 0,
  running: false,
  ...overrides,
});

const parked = () => walk({ lastError: "archive_unavailable", failures: 4 });
const tipAt = (utime: number) => ({ utime }) as ChainTip;

describe("addressStatus", () => {
  test("reports head, frontier, synced point, lag, gaps and walks", () => {
    expect(addressStatus(tracked({}, 2), [walk(), parked()], tipAt(1_030))).toEqual({
      address: A,
      head: 500n,
      frontier: 300n,
      syncedLt: 250n,
      lagSeconds: 30,
      gapsOpen: 2,
      walks: 2,
      stuck: 1,
    });
  });

  test("lag is unknown before the first tick or before the address was ever synced", () => {
    expect(addressStatus(tracked(), [], null).lagSeconds).toBeNull();
    expect(addressStatus(tracked({ syncedUtime: null }), [], tipAt(5)).lagSeconds).toBeNull();
  });

  test("lag never goes negative (a tip older than the synced time)", () => {
    expect(addressStatus(tracked(), [], tipAt(900)).lagSeconds).toBe(0);
  });

  test("an address with nothing stored", () => {
    const status = addressStatus(tracked({ head: null, frontier: null }), [], null);
    expect(status).toMatchObject({ head: null, frontier: null, walks: 0, stuck: 0 });
  });

  test("three archive misses are not yet stuck", () => {
    const unlucky = walk({ lastError: "archive_unavailable", failures: 3 });
    expect(addressStatus(tracked(), [unlucky], null).stuck).toBe(0);
  });
});

describe("recordGauges", () => {
  const statuses = [
    { ...addressStatus(tracked({}, 2), [], tipAt(1_030)) },
    { ...addressStatus(tracked({ address: B, syncedUtime: null }, 3), [], tipAt(1_030)) },
  ];

  test("publishes indexer-wide totals and per-address gauges", () => {
    const metrics = new Metrics();
    recordGauges(metrics, statuses, [walk(), parked(), walk()], true);
    expect(metrics.get("ton_watch_addresses")).toBe(2);
    expect(metrics.get("ton_watch_walks")).toBe(3);
    expect(metrics.get("ton_watch_walks_stuck")).toBe(1);
    expect(metrics.get("ton_watch_gaps_open")).toBe(5);
    expect(metrics.get("ton_watch_max_lag_seconds")).toBe(30);
    expect(metrics.get("ton_watch_address_lag_seconds", { address: A })).toBe(30);
    // B's lag is unknown: its series is omitted, not a sentinel.
    expect(Object.keys(metrics.snapshot())).not.toContain(
      `ton_watch_address_lag_seconds{address="${B}"}`,
    );
    expect(metrics.get("ton_watch_address_gaps_open", { address: B })).toBe(3);
  });

  test("without per-address gauges only totals are published", () => {
    const metrics = new Metrics();
    recordGauges(metrics, statuses, [], false);
    expect(metrics.toPrometheus()).not.toContain("ton_watch_address_");
    expect(metrics.get("ton_watch_max_lag_seconds")).toBe(30);
  });

  test("no addresses: everything zero", () => {
    const metrics = new Metrics();
    recordGauges(metrics, [], [], true);
    expect(metrics.get("ton_watch_addresses")).toBe(0);
    expect(metrics.get("ton_watch_max_lag_seconds")).toBe(0);
  });
});

async function setup(perAccount: number, addresses = [A, B]) {
  const chain = new FakeChain();
  chain.grow(addresses, perAccount, 4);
  const store = new MemoryStore();
  for (const a of addresses) await store.addAddress(a, { startLt: 0n });
  const source = new FakeSource(chain);
  const events: Record<string, unknown[][]> = {
    tick: [],
    frontier: [],
    synced: [],
    fetchError: [],
  };
  const indexer = new Indexer({
    store,
    source,
    detect: "poll",
    retryMinMs: 1,
    retryMaxMs: 2,
    addressMetrics: true,
  });
  indexer.on("tick", (...args) => events.tick!.push(args));
  indexer.on("frontier", (...args) => events.frontier!.push(args));
  indexer.on("synced", (...args) => events.synced!.push(args));
  indexer.on("fetchError", (...args) => events.fetchError!.push(args));
  return { chain, store, source, indexer, events };
}

describe("Indexer events and status", () => {
  test("tick carries the tip; frontier rises to the last tx; synced carries syncLt", async () => {
    const s = await setup(40);
    await s.indexer.syncOnce();
    const tip = s.chain.tip();
    expect(s.events.tick!.length).toBeGreaterThan(0);
    expect((s.events.tick![0]![0] as ChainTip).seqno).toBe(tip.seqno);
    expect(s.indexer.chainTip?.seqno).toBe(tip.seqno);
    for (const address of [A, B]) {
      const lts = s.events.frontier!.filter((e) => e[0] === address).map((e) => e[1] as bigint);
      expect(lts.length).toBeGreaterThan(0);
      expect(lts.every((lt, i) => i === 0 || lt > lts[i - 1]!)).toBe(true);
      expect(lts.at(-1)).toBe(s.chain.txs(address).at(-1)!.lt);
      expect(s.events.synced!).toContainEqual([address, tip.syncLt]);
    }
    expect(s.events.fetchError).toEqual([]);
  });

  test("status() reflects a completed sync", async () => {
    const s = await setup(20);
    expect(s.indexer.status()).toEqual([]); // nothing known before the first tick
    await s.indexer.syncOnce();
    const tip = s.chain.tip();
    expect(s.indexer.status()).toEqual(
      [A, B].map((address) => ({
        address,
        head: s.chain.txs(address).at(-1)!.lt,
        frontier: s.chain.txs(address).at(-1)!.lt,
        syncedLt: tip.syncLt,
        lagSeconds: 0,
        gapsOpen: 0,
        walks: 0,
        stuck: 0,
      })),
    );
    expect(s.indexer.lastTickAt).toBeGreaterThan(0);
    expect(s.indexer.metrics.get("ton_watch_tip_seqno")).toBe(tip.seqno);
    expect(s.indexer.metrics.get("ton_watch_addresses")).toBe(2);
  });

  test("fetchError carries the address, the error kind and the error", async () => {
    const s = await setup(20);
    let failures = 2;
    const real = s.source.getTransactions.bind(s.source);
    s.source.getTransactions = async (...args) => {
      if (failures-- > 0) throw new Error("LITE_SERVER_UNKNOWN: too many requests");
      return real(...args);
    };
    await s.indexer.syncOnce();
    expect(s.events.fetchError!.length).toBe(2);
    const [address, kind, error] = s.events.fetchError![0]! as [string, ErrorKind, Error];
    expect([A, B]).toContain(address);
    expect(kind).toBe("rate_limit");
    expect(error.message).toContain("too many requests");
  });

  test("status shows parked walks as stuck, and the next tick publishes them", async () => {
    const s = await setup(40, [A]);
    s.source.faults = { archiveFloorLt: s.chain.txs(A)[20]!.lt };
    const indexer = new Indexer({
      store: s.store,
      source: s.source,
      detect: "poll",
      split: false,
      retryMinMs: 1,
      retryMaxMs: 1,
      archiveRetryMs: 1,
    });
    await indexer.syncOnce(10);
    const [status] = indexer.status();
    expect(status).toMatchObject({ address: A, frontier: null, stuck: 1, walks: 1 });
    expect(status!.lagSeconds).toBeNull(); // never complete, never synced
    await indexer.tick(); // gauges are published per tick
    expect(indexer.metrics.get("ton_watch_walks_stuck")).toBe(1);
  });

  test("per-address gauges of a removed address are cleared", async () => {
    const s = await setup(5);
    await s.indexer.syncOnce();
    expect(s.indexer.metrics.toPrometheus()).toContain(`address="${B}"`);
    await s.store.removeAddress(B);
    await s.indexer.tick();
    expect(s.indexer.metrics.toPrometheus()).not.toContain(`address="${B}"`);
    expect(s.indexer.metrics.toPrometheus()).toContain(`address="${A}"`);
    expect(s.indexer.status().map((st) => st.address)).toEqual([A]);
  });
});
