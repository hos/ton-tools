import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import type { AddressState, TxId } from "../../src/core/types";
import { ChangeDetector } from "../../src/indexer/change-detector";
import type { DetectMode, IndexerSettings } from "../../src/indexer/options";
import { AddressTable } from "../../src/indexer/tracked-address";
import { Metrics } from "../../src/metrics/metrics";
import type { ChainTip, TxSource } from "../../src/source/source";
import { silentLogger } from "../../src/util/logger";
import { fakeAddress } from "../fixtures/fake-chain";

const T0 = 1_800_000_000_000;
const TICK = 1_000;

afterEach(() => setSystemTime());

const id = (lt: bigint): TxId => ({ lt, hash: Buffer.alloc(32, Number(lt % 256n)) });

const tip = (seqno: number): ChainTip => {
  const block = {
    workchain: -1,
    shard: "-9223372036854775808",
    seqno,
    rootHash: Buffer.alloc(32),
    fileHash: Buffer.alloc(32),
  };
  return {
    seqno,
    utime: 1_700_000_000 + seqno,
    block,
    shards: [],
    syncLt: BigInt(seqno) * 1_000_000n,
  };
};

const state = (address: string): AddressState => ({
  address,
  startLt: 0n,
  active: true,
  head: null,
  frontier: null,
  syncedLt: 0n,
  syncedUtime: null,
});

/** A source whose last txs and block listings are set by the test. */
class StubSource implements TxSource {
  readonly maxPageSize = 16;
  readonly lastTx = new Map<string, TxId | null>();
  /** What the next listing returns; `"throw"` throws, `null` cannot tell. */
  listing: Map<string, TxId> | null | "throw" = new Map();
  readonly polled: string[] = [];
  readonly listings: { prev: number; next: number; workchains: number[] }[] = [];
  failing = new Set<string>();

  async getTip(): Promise<ChainTip> {
    return tip(1);
  }
  async getLastTx(address: string): Promise<TxId | null> {
    this.polled.push(address);
    if (this.failing.has(address)) throw new Error("LITE_SERVER_UNKNOWN: timeout");
    return this.lastTx.get(address) ?? null;
  }
  async getTransactions(): Promise<never> {
    throw new Error("unused");
  }
  async getTouchedAccounts(prev: ChainTip, next: ChainTip, workchains: ReadonlySet<number>) {
    this.listings.push({ prev: prev.seqno, next: next.seqno, workchains: [...workchains] });
    if (this.listing === "throw") throw new Error("socket closed");
    return this.listing;
  }
  /** Polls since the last call. */
  take(): string[] {
    return this.polled.splice(0);
  }
}

function setup(
  count: number,
  settings: Partial<IndexerSettings> & { detect?: DetectMode } = {},
  source = new StubSource(),
) {
  setSystemTime(T0);
  const addresses = Array.from({ length: count }, (_, i) => fakeAddress(i + 1));
  const table = new AddressTable();
  table.sync(addresses.map(state));
  const metrics = new Metrics();
  const detector = new ChangeDetector(
    source,
    table,
    {
      concurrency: 4,
      tickMs: TICK,
      detect: "poll",
      autoBlocksThreshold: 50,
      maxIdlePollMs: 30_000,
      reconcileMs: 600_000,
      ...settings,
    },
    metrics,
    silentLogger,
  );
  let seqno = 0;
  let now = T0;
  /** Advances the clock by `ms` and detects on a new tip. */
  const tick = async (ms = TICK) => {
    now += ms;
    setSystemTime(now);
    await detector.detect(tip(++seqno));
  };
  const resync = (list: string[]) => table.sync(list.map(state));
  return { addresses, table, metrics, detector, source, tick, resync, tip: () => tip(seqno) };
}

describe("ChangeDetector poll mode", () => {
  test("the first round reads every address and records the observation", async () => {
    const s = setup(3);
    s.source.lastTx.set(s.addresses[0]!, id(500n));
    await s.tick();
    expect(s.source.take().sort()).toEqual([...s.addresses].sort());
    const [a, b] = s.table.all();
    expect(a!.observed).toEqual({ lastTx: id(500n), syncLt: 1_000_000n, utime: 1_700_000_001 });
    expect(b!.observed?.lastTx).toBeNull(); // an address without txs is observed too
    expect(a!.verifiedAt).toBe(T0 + TICK);
    expect(s.table.anyUnobserved()).toBe(false);
  });

  test("idle addresses back off 1, 3, 7… ticks, capped at maxIdlePollMs; a change resets", async () => {
    const s = setup(1, { maxIdlePollMs: 6_500 });
    const [a] = s.addresses as [string];
    const pollTicks: number[] = [];
    for (let t = 1; t <= 30; t++) {
      if (t === 20) s.source.lastTx.set(a, id(7n)); // activity
      await s.tick();
      if (s.source.take().length > 0) pollTicks.push(t);
    }
    // First poll (changed) → 0; then idle streaks 1, 2, 3 → 1, 3, 7(capped 6.5) ticks.
    expect(pollTicks).toEqual([1, 2, 3, 6, 13, 20, 21, 22, 25]);
    const tracked = s.table.all()[0]!;
    expect(tracked.idleStreak).toBe(3);
  });

  test("on the same tip only addresses never read are polled", async () => {
    const s = setup(2);
    await s.tick();
    s.source.take();
    s.resync([...s.addresses, fakeAddress(99)]);
    await s.detector.detect(s.tip()); // same seqno
    expect(s.source.take()).toEqual([fakeAddress(99)]);
    await s.detector.detect(s.tip());
    expect(s.source.take()).toEqual([]);
  });

  test("a failed read leaves the address unobserved and counts the error", async () => {
    const s = setup(2);
    s.source.failing.add(s.addresses[0]!);
    await s.tick();
    expect(s.table.get(s.addresses[0]!)!.observed).toBeUndefined();
    expect(s.table.get(s.addresses[1]!)!.observed).toBeDefined();
    expect(s.metrics.get("ton_watch_errors_total", { kind: "timeout", where: "getLastTx" })).toBe(
      1,
    );
    s.source.failing.clear();
    s.source.take();
    await s.tick();
    expect(s.source.take()).toContain(s.addresses[0]!); // retried next tick despite backoff
  });

  test("removed addresses are no longer polled, added ones are polled at once", async () => {
    const s = setup(3, { maxIdlePollMs: 0 });
    await s.tick();
    s.source.take();
    s.resync([s.addresses[0]!, fakeAddress(42)]);
    await s.tick();
    expect(s.source.take().sort()).toEqual([s.addresses[0]!, fakeAddress(42)].sort());
  });

  test("never uses block listing in poll mode", async () => {
    const s = setup(100);
    for (let i = 0; i < 3; i++) await s.tick();
    expect(s.source.listings).toEqual([]);
  });
});

describe("ChangeDetector blocks mode", () => {
  test("verifies by polling once, then lists each new range of blocks exactly once", async () => {
    const s = setup(3, { detect: "blocks" });
    await s.tick();
    expect(s.source.take().length).toBe(3);
    expect(s.source.listings).toEqual([]);
    for (let i = 0; i < 4; i++) await s.tick();
    expect(s.source.take()).toEqual([]);
    expect(s.source.listings.map((l) => [l.prev, l.next])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    // A repeated tip lists nothing new.
    await s.detector.detect(s.tip());
    expect(s.source.listings.length).toBe(4);
  });

  test("listed transactions update observations; older listings never move them back", async () => {
    const s = setup(2, { detect: "blocks" });
    const [a, b] = s.addresses as [string, string];
    s.source.lastTx.set(a, id(100n));
    await s.tick();
    s.source.listing = new Map([[a, id(200n)]]);
    await s.tick();
    expect(s.table.get(a)!.observed?.lastTx).toEqual(id(200n));
    expect(s.table.get(b)!.observed?.lastTx).toBeNull();
    expect(s.table.get(b)!.observed?.syncLt).toBe(2_000_000n); // idle, but known up to the tip
    s.source.listing = new Map([[a, id(150n)]]);
    await s.tick();
    expect(s.table.get(a)!.observed?.lastTx).toEqual(id(200n));
    expect(s.table.get(a)!.observed?.utime).toBe(1_700_000_003);
  });

  test("addresses stored in uppercase hex match lowercase listings", async () => {
    const source = new StubSource();
    const s = setup(0, { detect: "blocks" }, source);
    const upper = fakeAddress(0xabc).toUpperCase();
    s.resync([upper]);
    await s.tick();
    source.listing = new Map([[upper.toLowerCase(), id(9n)]]);
    await s.tick();
    expect(s.table.get(upper)!.observed?.lastTx).toEqual(id(9n));
  });

  test("lists only the workchains of watched addresses", async () => {
    const s = setup(0, { detect: "blocks" });
    s.resync([`-1:${"1".repeat(64)}`, `0:${"2".repeat(64)}`, `0:${"3".repeat(64)}`]);
    await s.tick();
    await s.tick();
    expect(s.source.listings[0]!.workchains.sort()).toEqual([-1, 0]);
  });

  test("a failed or inconclusive listing falls back to polling every address", async () => {
    for (const listing of ["throw", null] as const) {
      const s = setup(3, { detect: "blocks" });
      await s.tick();
      s.source.take();
      s.source.listing = listing;
      await s.tick();
      expect(s.source.take().length).toBe(3);
      expect(s.metrics.get("ton_watch_detect_fallbacks_total")).toBe(1);
    }
    const s = setup(1, { detect: "blocks" });
    await s.tick();
    s.source.listing = "throw";
    await s.tick();
    expect(
      s.metrics.get("ton_watch_errors_total", { kind: "network", where: "getTouchedAccounts" }),
    ).toBe(1);
  });

  test("listing is not trusted until every address was read successfully", async () => {
    const s = setup(2, { detect: "blocks" });
    s.source.failing.add(s.addresses[1]!);
    await s.tick();
    s.source.take();
    await s.tick(); // still unverified: polls everyone, no listing
    expect(s.source.listings).toEqual([]);
    expect(s.source.take().length).toBe(2);
    s.source.failing.clear();
    await s.tick();
    s.source.take();
    await s.tick();
    expect(s.source.listings.length).toBe(1);
    expect(s.source.take()).toEqual([]);
  });

  test("an address added at runtime is read directly, the rest come from the listing", async () => {
    const s = setup(3, { detect: "blocks" });
    await s.tick();
    s.source.take();
    s.resync([...s.addresses, fakeAddress(77)]);
    await s.tick();
    expect(s.source.take()).toEqual([fakeAddress(77)]);
    expect(s.source.listings.length).toBe(1);
    await s.tick();
    expect(s.source.take()).toEqual([]);
  });

  test("a source without block listing is polled even in blocks mode", async () => {
    const source = new StubSource();
    (source as any).getTouchedAccounts = undefined;
    const s = setup(2, { detect: "blocks", maxIdlePollMs: 0 }, source);
    await s.tick();
    await s.tick();
    expect(source.take().length).toBe(4);
  });

  test("reconciliation re-reads a few addresses per tick, least recently verified first", async () => {
    // 10 addresses, every one at least each 10 ticks → ceil(10 × 1 / 10) + 1 = 2 per tick.
    const s = setup(10, { detect: "blocks", reconcileMs: 10 * TICK });
    await s.tick();
    s.source.take();
    for (let i = 0; i < 9; i++) await s.tick();
    expect(s.source.take()).toEqual([]);
    const perTick: string[][] = [];
    for (let i = 0; i < 6; i++) {
      await s.tick();
      perTick.push(s.source.take());
    }
    expect(perTick.map((p) => p.length)).toEqual([2, 2, 2, 2, 2, 0]);
    expect(new Set(perTick.flat()).size).toBe(10); // each address once
  });

  test("a transaction the listing missed is found by reconciliation and counted", async () => {
    const s = setup(1, { detect: "blocks", reconcileMs: 2 * TICK });
    const [a] = s.addresses as [string];
    await s.tick();
    s.source.lastTx.set(a, id(300n)); // happened, but never listed
    await s.tick();
    expect(s.table.get(a)!.observed?.lastTx).toBeNull();
    await s.tick();
    expect(s.table.get(a)!.observed?.lastTx).toEqual(id(300n));
    expect(s.metrics.get("ton_watch_reconcile_misses_total")).toBe(1);
    expect(s.table.get(a)!.reconcilingFrom).toBeUndefined();
  });

  test("reconciling an address the listing got right counts no miss", async () => {
    const s = setup(1, { detect: "blocks", reconcileMs: 2 * TICK });
    const [a] = s.addresses as [string];
    await s.tick();
    s.source.lastTx.set(a, id(300n));
    s.source.listing = new Map([[a, id(300n)]]);
    await s.tick();
    await s.tick();
    expect(s.metrics.get("ton_watch_reconcile_misses_total")).toBe(0);
  });
});

describe("ChangeDetector auto mode", () => {
  test("polls below autoBlocksThreshold and lists blocks from it on", async () => {
    const s = setup(2, { detect: "auto", autoBlocksThreshold: 3, maxIdlePollMs: 0 });
    await s.tick();
    await s.tick();
    expect(s.source.listings).toEqual([]);
    s.resync([...s.addresses, fakeAddress(3)]);
    await s.tick(); // verification round in blocks mode: polls all three
    s.source.take();
    await s.tick();
    expect(s.source.listings.length).toBe(1);
    expect(s.source.take()).toEqual([]);
  });

  test("drops back to polling when addresses fall below the threshold", async () => {
    const s = setup(3, { detect: "auto", autoBlocksThreshold: 3, maxIdlePollMs: 0 });
    await s.tick();
    await s.tick();
    expect(s.source.listings.length).toBe(1);
    s.resync(s.addresses.slice(0, 2));
    s.source.take();
    await s.tick();
    expect(s.source.listings.length).toBe(1);
    expect(s.source.take().length).toBe(2);
  });

  // BUG: `blocksVerified` survives a stretch in poll mode. When auto mode switches
  // back to blocks, listing resumes from the last tip only, so a transaction on an
  // address that poll mode was backing off from (not read for a while) is never
  // listed and stays hidden until the next reconciliation (default 10 min).
  test.failing("re-verifies every address when auto switches from poll back to blocks", async () => {
    const s = setup(3, {
      detect: "auto",
      autoBlocksThreshold: 3,
      maxIdlePollMs: 60_000,
      reconcileMs: 3_600_000,
    });
    const [a] = s.addresses as [string];
    await s.tick();
    await s.tick(); // blocks, verified
    s.resync(s.addresses.slice(0, 2)); // poll mode
    for (let i = 0; i < 3; i++) await s.tick(); // `a` idles into backoff
    s.source.lastTx.set(a, id(999n)); // happens while `a` is backed off; not polled
    await s.tick();
    s.resync([...s.addresses.slice(0, 2), fakeAddress(9)]); // back to blocks
    await s.tick();
    await s.tick();
    expect(s.table.get(a)!.observed?.lastTx).toEqual(id(999n));
  });
});
