import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";

import type { TxRecord } from "../../src/core/types";
import { Maintenance } from "../../src/indexer/maintenance";
import { AddressTable, type TrackedAddress } from "../../src/indexer/tracked-address";
import { WalkScheduler } from "../../src/indexer/walk-scheduler";
import { Metrics } from "../../src/metrics/metrics";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import { silentLogger } from "../../src/util/logger";
import { FakeChain, fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const B = fakeAddress(2);
const T0 = 1_800_000_000_000;

afterEach(() => setSystemTime());

async function setup(opts: { perAccount?: number; startLt?: bigint; gapScanMs?: number } = {}) {
  setSystemTime(T0);
  const chain = new FakeChain();
  chain.grow([A, B], opts.perAccount ?? 40, 4);
  const store = new MemoryStore();
  for (const address of [A, B]) await store.addAddress(address, { startLt: opts.startLt ?? 0n });
  const addresses = new AddressTable();
  const metrics = new Metrics();
  const scheduler = new WalkScheduler(0, async () => {}, metrics); // holds walks only
  const events: unknown[][] = [];
  const maintenance = new Maintenance({
    store,
    addresses,
    scheduler,
    settings: { concurrency: 4, gapScanMs: 60_000 },
    events: { emit: (...args: unknown[]) => events.push(args) > 0 } as any,
    metrics,
    logger: silentLogger,
  });
  /** Mirrors the store into the table, as the indexer does each tick. */
  const refresh = async () => addresses.sync(await store.listAddresses());
  await refresh();
  const observe = (address: string, lastTx: TxRecord | null, syncLt: bigint, utime = 1) => {
    addresses.get(address)!.observed = {
      lastTx: lastTx && { lt: lastTx.lt, hash: lastTx.hash },
      syncLt,
      utime,
    };
  };
  const named = (name: string) => events.filter((e) => e[0] === name);
  return {
    chain,
    store,
    addresses,
    scheduler,
    maintenance,
    metrics,
    events,
    named,
    refresh,
    observe,
  };
}

const tracked = (s: { addresses: AddressTable }, address: string): TrackedAddress =>
  s.addresses.get(address)!;

describe("Maintenance.scanGaps", () => {
  test("advances the frontier and turns every stored gap into one gap walk", async () => {
    const s = await setup();
    const txs = s.chain.txs(A);
    // Stored: 0..9, 20..24, 35..39 → frontier at 9; gaps below 20 and below 35.
    await s.store.write(A, [...txs.slice(0, 10), ...txs.slice(20, 25), ...txs.slice(35)]);
    await s.refresh();
    await s.maintenance.scanGaps();

    expect(tracked(s, A).state.frontier?.lt).toBe(txs[9]!.lt);
    expect(s.named("frontier")).toEqual([["frontier", A, txs[9]!.lt]]);
    expect(tracked(s, A).gapsOpen).toBe(2);
    expect(tracked(s, A).needsMaintenance).toBe(false);
    const walks = s.scheduler.forAddress(A).map((w) => ({
      kind: w.kind,
      cursor: w.cursor.lt,
      floor: w.floorLt,
      top: w.topLt,
      hashOk: w.cursor.hash.equals(txs.find((t) => t.lt === w.cursor.lt)!.hash),
    }));
    expect(walks).toEqual([
      { kind: "gap", cursor: txs[19]!.lt, floor: txs[9]!.lt, top: txs[19]!.lt, hashOk: true },
      { kind: "gap", cursor: txs[34]!.lt, floor: txs[24]!.lt, top: txs[34]!.lt, hashOk: true },
    ]);
    // B has nothing stored: no gaps, no frontier, no walks.
    expect(tracked(s, B).gapsOpen).toBe(0);
    expect(s.scheduler.hasWalks(B)).toBe(false);
  });

  test("a gap already covered by a walk is not scheduled twice", async () => {
    const s = await setup();
    const txs = s.chain.txs(A);
    await s.store.write(A, txs.slice(30));
    await s.refresh();
    await s.maintenance.scanGaps();
    expect(s.scheduler.forAddress(A).length).toBe(1);
    await s.maintenance.scanGaps(true);
    expect(s.scheduler.forAddress(A).length).toBe(1);
    expect(s.named("frontier")).toEqual([]); // nothing anchored yet
  });

  test("a gap's floor is the address's startLt when nothing is stored below it", async () => {
    const s = await setup({ startLt: 0n });
    const txs = s.chain.txs(A);
    await s.store.removeAddress(A, { purge: true });
    await s.store.addAddress(A, { startLt: txs[9]!.lt });
    await s.store.write(A, txs.slice(30));
    await s.refresh();
    await s.maintenance.scanGaps();
    const [walk] = s.scheduler.forAddress(A);
    expect(walk!.floorLt).toBe(txs[9]!.lt);
    expect(walk!.cursor.lt).toBe(txs[29]!.lt);
  });

  test("between full scans only addresses flagged for maintenance are read", async () => {
    const s = await setup();
    const findGaps = spyOn(s.store, "findGaps");
    await s.maintenance.scanGaps(); // first round: full
    expect(findGaps).toHaveBeenCalledTimes(2);
    await s.maintenance.scanGaps();
    expect(findGaps).toHaveBeenCalledTimes(2);
    tracked(s, B).needsMaintenance = true;
    await s.maintenance.scanGaps();
    expect(findGaps.mock.calls.slice(2).map((c) => c[0])).toEqual([B]);
    setSystemTime(T0 + 60_000); // gapScanMs elapsed
    await s.maintenance.scanGaps();
    expect(findGaps).toHaveBeenCalledTimes(5);
    await s.maintenance.scanGaps(true); // forced
    expect(findGaps).toHaveBeenCalledTimes(7);
  });

  test("a store failure keeps the address flagged and is counted", async () => {
    const s = await setup();
    s.store.findGaps = async () => {
      throw new Error("connection reset");
    };
    await s.maintenance.scanGaps();
    expect(tracked(s, A).needsMaintenance).toBe(true);
    expect(s.metrics.get("ton_watch_errors_total", { kind: "network", where: "maintain" })).toBe(2);
  });

  test("frontier events fire only when the frontier moves", async () => {
    const s = await setup();
    const txs = s.chain.txs(A);
    await s.store.write(A, txs.slice(0, 5));
    await s.maintenance.scanGaps(true);
    await s.maintenance.scanGaps(true);
    await s.store.write(A, txs.slice(5, 8));
    await s.maintenance.scanGaps(true);
    expect(s.named("frontier")).toEqual([
      ["frontier", A, txs[4]!.lt],
      ["frontier", A, txs[7]!.lt],
    ]);
  });
});

describe("Maintenance.onWalkFinished", () => {
  test("settled() waits for the frontier updates still running", async () => {
    const s = await setup();
    await s.store.write(A, s.chain.txs(A).slice(0, 5));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const advance = s.store.advanceFrontier.bind(s.store);
    s.store.advanceFrontier = async (address) => {
      await gate;
      return advance(address);
    };
    s.maintenance.onWalkFinished(A);
    let settled = false;
    const done = s.maintenance.settled().then(() => {
      settled = true;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    release();
    await done;
    expect(tracked(s, A).state.frontier?.lt).toBe(s.chain.txs(A)[4]!.lt);
  });

  test("moves the frontier in the background and flags the address", async () => {
    const s = await setup();
    const txs = s.chain.txs(A);
    await s.store.write(A, txs.slice(0, 12));
    tracked(s, A).needsMaintenance = false;
    s.maintenance.onWalkFinished(A);
    expect(tracked(s, A).needsMaintenance).toBe(true);
    await Bun.sleep(0);
    expect(tracked(s, A).state.frontier?.lt).toBe(txs[11]!.lt);
    expect(s.named("frontier")).toEqual([["frontier", A, txs[11]!.lt]]);
    s.maintenance.onWalkFinished(A); // unchanged: no second event
    await Bun.sleep(0);
    expect(s.named("frontier").length).toBe(1);
  });

  test("ignores addresses no longer tracked and counts store failures", async () => {
    const s = await setup();
    s.maintenance.onWalkFinished(fakeAddress(99));
    s.store.advanceFrontier = async () => {
      throw new Error("timed out");
    };
    s.maintenance.onWalkFinished(A);
    await Bun.sleep(0);
    expect(s.events).toEqual([]);
    expect(
      s.metrics.get("ton_watch_errors_total", { kind: "timeout", where: "advanceFrontier" }),
    ).toBe(1);
  });
});

describe("Maintenance.markSynced", () => {
  async function complete(s: Awaited<ReturnType<typeof setup>>, address: string) {
    await s.store.write(address, s.chain.txs(address));
    await s.store.advanceFrontier(address);
    await s.refresh();
  }

  test("records syncLt for complete idle addresses, one store call per tip", async () => {
    const s = await setup();
    await complete(s, A);
    await complete(s, B);
    s.observe(A, s.chain.txs(A).at(-1)!, 5_000_000n, 77);
    s.observe(B, s.chain.txs(B).at(-1)!, 5_000_000n, 77);
    const markSynced = spyOn(s.store, "markSynced");
    await s.maintenance.markSynced();
    expect(markSynced).toHaveBeenCalledTimes(1);
    expect(markSynced).toHaveBeenCalledWith([A, B], 5_000_000n, 77);
    expect(tracked(s, A).state).toMatchObject({ syncedLt: 5_000_000n, syncedUtime: 77 });
    expect((await s.store.getAddress(B))!.syncedLt).toBe(5_000_000n);
    expect(s.named("synced")).toEqual([
      ["synced", A, 5_000_000n],
      ["synced", B, 5_000_000n],
    ]);
  });

  test("addresses observed at different tips are grouped separately", async () => {
    const s = await setup();
    await complete(s, A);
    await complete(s, B);
    s.observe(A, s.chain.txs(A).at(-1)!, 5_000_000n);
    s.observe(B, s.chain.txs(B).at(-1)!, 6_000_000n);
    const markSynced = spyOn(s.store, "markSynced");
    await s.maintenance.markSynced();
    expect(markSynced).toHaveBeenCalledTimes(2);
  });

  test("syncedLt only ever moves forward", async () => {
    const s = await setup();
    await complete(s, A);
    const last = s.chain.txs(A).at(-1)!;
    s.observe(A, last, 5_000_000n);
    await s.maintenance.markSynced();
    s.observe(A, last, 4_000_000n); // an older observation (e.g. a lagging server)
    await s.maintenance.markSynced();
    s.observe(A, last, 5_000_000n); // the same one again
    await s.maintenance.markSynced();
    expect(tracked(s, A).state.syncedLt).toBe(5_000_000n);
    expect((await s.store.getAddress(A))!.syncedLt).toBe(5_000_000n);
    expect(s.named("synced").length).toBe(1);
  });

  test("skips unobserved addresses, ones with walks, and incomplete ones", async () => {
    const s = await setup();
    const txs = s.chain.txs(A);
    // A: stored up to the observed tx, but with a hole → incomplete.
    await s.store.write(A, [...txs.slice(0, 5), ...txs.slice(10)]);
    await s.store.advanceFrontier(A);
    await s.refresh();
    s.observe(A, txs.at(-1)!, 5_000_000n);
    await s.maintenance.markSynced(); // B unobserved
    expect(s.named("synced")).toEqual([]);

    // A complete, but a newer tx is on chain than what is stored.
    await s.store.write(A, txs.slice(5, 10));
    await s.store.advanceFrontier(A);
    await s.refresh();
    s.observe(A, { ...txs.at(-1)!, lt: txs.at(-1)!.lt + 1n }, 5_000_000n);
    await s.maintenance.markSynced();
    expect(s.named("synced")).toEqual([]);

    // Complete and matching, but a walk is still out for it.
    s.observe(A, txs.at(-1)!, 5_000_000n);
    const walk = s.scheduler.add({
      address: A,
      kind: "head",
      cursor: txs.at(-1)!,
      floorLt: 0n,
      topLt: txs.at(-1)!.lt,
    });
    await s.maintenance.markSynced();
    expect(s.named("synced")).toEqual([]);
    s.scheduler.remove(walk);
    await s.maintenance.markSynced();
    expect(s.named("synced")).toEqual([["synced", A, 5_000_000n]]);
  });

  test("an address with no transactions at all is complete", async () => {
    const s = await setup();
    const empty = fakeAddress(50);
    await s.store.addAddress(empty, { startLt: 0n });
    await s.refresh();
    s.observe(empty, null, 3_000_000n);
    await s.maintenance.markSynced();
    expect(s.named("synced")).toEqual([["synced", empty, 3_000_000n]]);
  });

  test("an address whose last tx is at or below startLt is complete with nothing stored", async () => {
    const s = await setup();
    const txs = s.chain.txs(A);
    await s.store.removeAddress(A, { purge: true });
    await s.store.addAddress(A, { startLt: txs.at(-1)!.lt });
    await s.refresh();
    s.observe(A, txs.at(-1)!, 3_000_000n);
    await s.maintenance.markSynced();
    expect(s.named("synced")).toEqual([["synced", A, 3_000_000n]]);
  });
});

describe("AddressTable", () => {
  const state = (address: string, syncedLt = 0n) => ({
    address,
    startLt: 0n,
    active: true,
    head: null,
    frontier: null,
    syncedLt,
    syncedUtime: null,
  });

  test("tracks new addresses with fresh polling state", () => {
    const table = new AddressTable();
    expect(table.size).toBe(0);
    expect(table.anyUnobserved()).toBe(false);
    expect(table.sync([state(A), state(B)])).toEqual([]);
    expect(table.size).toBe(2);
    expect(table.addresses()).toEqual([A, B]);
    expect(table.get(A)).toEqual({
      state: state(A),
      nextPollAt: 0,
      idleStreak: 0,
      verifiedAt: 0,
      needsMaintenance: true,
      gapsOpen: 0,
    });
    expect(table.anyUnobserved()).toBe(true);
  });

  test("updates states in place, keeping observation and polling state", () => {
    const table = new AddressTable();
    table.sync([state(A)]);
    const entry = table.get(A)!;
    entry.observed = { lastTx: null, syncLt: 5n, utime: 1 };
    entry.idleStreak = 4;
    table.sync([state(A, 9n)]);
    expect(table.get(A)).toBe(entry);
    expect(entry.state.syncedLt).toBe(9n);
    expect(entry.idleStreak).toBe(4);
    expect(table.anyUnobserved()).toBe(false);
  });

  test("drops addresses missing from the new list and returns them", () => {
    const table = new AddressTable();
    table.sync([state(A), state(B)]);
    expect(table.sync([state(B)])).toEqual([A]);
    expect(table.get(A)).toBeUndefined();
    expect(table.all().map((t) => t.state.address)).toEqual([B]);
    expect(table.sync([])).toEqual([B]);
    expect(table.size).toBe(0);
  });
});
