import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { SourceError } from "../../src/core/errors";
import type { TxRecord } from "../../src/core/types";
import { PageFetcher } from "../../src/indexer/page-fetcher";
import type { Walk, WalkKind } from "../../src/indexer/walk";
import { WalkRunner } from "../../src/indexer/walk-runner";
import { WalkScheduler } from "../../src/indexer/walk-scheduler";
import type { WalkSplitter } from "../../src/indexer/walk-splitter";
import { Metrics } from "../../src/metrics/metrics";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import type { Logger } from "../../src/util/logger";
import { FakeChain, FakeSource, fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const NOW = 1_800_000_000_000;

afterEach(() => setSystemTime());

interface Setup {
  txs: TxRecord[];
  store: MemoryStore;
  scheduler: WalkScheduler;
  runner: WalkRunner;
  metrics: Metrics;
  finished: string[];
  splits: Walk[];
  events: unknown[][];
  logs: { level: string; message: string }[];
}

async function setup(
  count: number,
  opts: { fetch?: (walk: Walk) => Promise<TxRecord[]>; startLt?: bigint } = {},
): Promise<Setup> {
  const chain = new FakeChain();
  chain.grow([A], count, 4);
  const store = new MemoryStore();
  await store.addAddress(A, { startLt: opts.startLt ?? 0n });
  const metrics = new Metrics();
  // Concurrency 0: walks are only held; the tests run pages by hand.
  const scheduler = new WalkScheduler(0, async () => {}, metrics);
  const source = new FakeSource(chain);
  const fetcher = opts.fetch
    ? ({ fetch: opts.fetch } as unknown as PageFetcher)
    : new PageFetcher(source, null, metrics);
  const finished: string[] = [];
  const splits: Walk[] = [];
  const events: unknown[][] = [];
  const logs: { level: string; message: string }[] = [];
  const log =
    (level: string) =>
    (...args: unknown[]) =>
      logs.push({ level, message: args.join(" ") });
  const logger: Logger = {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
  const runner = new WalkRunner({
    store,
    fetcher,
    scheduler,
    splitter: { maybeSplit: (walk: Walk) => splits.push(walk) } as unknown as WalkSplitter,
    settings: { retryMinMs: 100, retryMaxMs: 1_000, archiveRetryMs: 60_000 },
    events: { emit: (...args: unknown[]) => events.push(args) > 0 } as any,
    metrics,
    logger,
    onWalkFinished: (address) => finished.push(address),
  });
  return {
    txs: chain.txs(A),
    store,
    scheduler,
    runner,
    metrics,
    finished,
    splits,
    events,
    logs,
  };
}

const headWalk = (s: Setup, floorLt = 0n, kind: WalkKind = "head") => {
  const top = s.txs.at(-1)!;
  return s.scheduler.add({
    address: A,
    kind,
    cursor: { lt: top.lt, hash: top.hash },
    floorLt,
    topLt: top.lt,
  });
};

const storedLts = async (store: MemoryStore) =>
  (await store.read(A, 0n, 1n << 62n, 10_000)).map((tx) => tx.lt);

describe("WalkRunner page outcomes", () => {
  test("a walk dropped while its page was being written is neither finished nor continued", async () => {
    const s = await setup(40);
    const walk = headWalk(s);
    const write = s.store.write.bind(s.store);
    s.store.write = async (address, txs) => {
      s.scheduler.dropAddress(address);
      return write(address, txs);
    };
    const cursor = walk.cursor;
    await s.runner.runPage(walk);
    expect(walk.cursor).toBe(cursor);
    expect(s.finished).toEqual([]);
    expect(s.splits).toEqual([]);
  });

  test("advance: stores the page and moves the cursor to the oldest tx's prev link", async () => {
    const s = await setup(40);
    const walk = headWalk(s);
    await s.runner.runPage(walk);
    expect(await storedLts(s.store)).toEqual(s.txs.slice(24).map((tx) => tx.lt));
    expect(walk.cursor.lt).toBe(s.txs[23]!.lt);
    expect(walk.cursor.hash.equals(s.txs[23]!.hash)).toBe(true);
    expect(walk).toMatchObject({ pages: 1, fetched: 16, failures: 0 });
    expect(s.scheduler.has(walk)).toBe(true);
    expect(s.finished).toEqual([]);
    expect(s.splits).toEqual([walk]);
    expect(s.metrics.get("ton_watch_pages_total", { kind: "head" })).toBe(1);
    expect(s.metrics.get("ton_watch_tx_written_total")).toBe(16);
  });

  test("finish: walks down to the account's first transaction, then reports the address", async () => {
    const s = await setup(40);
    const walk = headWalk(s);
    for (let page = 0; page < 3; page++) await s.runner.runPage(walk);
    expect(await storedLts(s.store)).toEqual(s.txs.map((tx) => tx.lt));
    expect(s.scheduler.has(walk)).toBe(false);
    expect(s.finished).toEqual([A]);
    expect(s.splits.length).toBe(2); // only after pages that advanced
  });

  test("finish: stops at floorLt and never writes at or below it", async () => {
    const s = await setup(40);
    const walk = headWalk(s, s.txs[30]!.lt, "gap");
    await s.runner.runPage(walk);
    expect(await storedLts(s.store)).toEqual(s.txs.slice(31).map((tx) => tx.lt));
    expect(s.scheduler.has(walk)).toBe(false);
    expect(s.finished).toEqual([A]);
    expect(s.metrics.get("ton_watch_pages_total", { kind: "gap" })).toBe(1);
  });

  test("finish: a page ending exactly on the floor (oldest.prevLt == floorLt)", async () => {
    const s = await setup(40);
    // First page covers txs[24..39]; its oldest links to txs[23].
    const walk = headWalk(s, s.txs[23]!.lt);
    await s.runner.runPage(walk);
    expect(s.scheduler.has(walk)).toBe(false);
    expect(s.finished).toEqual([A]);
    expect((await storedLts(s.store)).length).toBe(16);
  });

  test("finish: an overlapped walk (everything already stored after page 1) stops early", async () => {
    const s = await setup(64);
    await s.store.write(A, s.txs);
    const walk = headWalk(s);
    await s.runner.runPage(walk);
    // First page: nothing new, but that may be a race with the walk below; keep going.
    expect(s.scheduler.has(walk)).toBe(true);
    await s.runner.runPage(walk);
    expect(s.scheduler.has(walk)).toBe(false);
    expect(s.finished).toEqual([A]);
    expect(walk.pages).toBe(2);
  });

  test("a walk below startLt writes nothing out of scope", async () => {
    const s = await setup(20);
    const walk = headWalk(s, 0n);
    // Store refuses lt <= startLt; the walk floor is what limits fetching.
    await s.store.removeAddress(A, { purge: true });
    await s.store.addAddress(A, { startLt: s.txs[9]!.lt });
    await s.runner.runPage(walk);
    await s.runner.runPage(walk);
    expect(await storedLts(s.store)).toEqual(s.txs.slice(10).map((tx) => tx.lt));
  });
});

describe("WalkRunner retries", () => {
  test("backs off exponentially per consecutive failure, capped at retryMaxMs", async () => {
    setSystemTime(NOW);
    const error = new Error("LITE_SERVER_UNKNOWN: too many requests");
    const s = await setup(5, {
      fetch: async () => {
        throw error;
      },
    });
    const walk = headWalk(s);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      await s.runner.runPage(walk);
      delays.push(walk.notBefore - NOW);
    }
    expect(delays).toEqual([100, 200, 400, 800, 1_000, 1_000]);
    expect(walk).toMatchObject({ failures: 6, lastError: "rate_limit", pages: 0 });
    expect(s.scheduler.has(walk)).toBe(true);
    expect(s.metrics.get("ton_watch_errors_total", { kind: "rate_limit", where: "walk" })).toBe(6);
    expect(s.events.length).toBe(6);
    expect(s.events[0]).toEqual(["fetchError", A, "rate_limit", error]);
    // Logged loudly once, then quietly.
    expect(s.logs.filter((l) => l.level === "warn").length).toBe(1);
    expect(s.logs.filter((l) => l.level === "debug").length).toBe(5);
    expect(s.logs[0]!.message).toContain("retry in 0s");
  });

  test("a success resets the failure count and last error", async () => {
    let fail = true;
    const chain = new FakeChain();
    chain.grow([A], 30, 4); // same deterministic chain as setup() builds
    const fetcher = new PageFetcher(new FakeSource(chain), null, new Metrics());
    const s = await setup(30, {
      fetch: async (walk) => {
        if (fail) throw new SourceError("timeout", "slow");
        return fetcher.fetch(walk);
      },
    });
    const walk = headWalk(s);
    await s.runner.runPage(walk);
    await s.runner.runPage(walk);
    expect(walk).toMatchObject({ failures: 2, lastError: "timeout" });
    fail = false;
    await s.runner.runPage(walk);
    expect(walk.failures).toBe(0);
    expect(walk.lastError).toBeUndefined();
    expect(walk.pages).toBe(1);
  });

  test("repeated archive misses park the walk with archiveRetryMs", async () => {
    setSystemTime(NOW);
    const s = await setup(5, {
      fetch: async () => {
        throw new Error("cannot locate transaction in block with specified logical time");
      },
    });
    const walk = headWalk(s);
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      await s.runner.runPage(walk);
      delays.push(walk.notBefore - NOW);
    }
    // Three misses back off normally; from the fourth on the walk is parked.
    expect(delays).toEqual([100, 200, 400, 60_000, 60_000]);
    expect(walk.lastError).toBe("archive_unavailable");
    expect(s.logs.filter((l) => l.level === "warn").length).toBe(3); // first + each parked retry
  });

  test("a failing store write is retried like a failed fetch", async () => {
    const s = await setup(20);
    s.store.write = async () => {
      throw new Error("connection reset");
    };
    const walk = headWalk(s);
    const cursor = walk.cursor;
    await s.runner.runPage(walk);
    expect(walk.cursor).toBe(cursor); // not advanced past unwritten data
    expect(walk).toMatchObject({ failures: 1, lastError: "network" });
    expect(s.scheduler.has(walk)).toBe(true);
    expect(s.finished).toEqual([]);
  });

  test("a bad page from the source is not written", async () => {
    const chain = new FakeChain();
    chain.grow([A], 30, 4);
    const s = await setup(30, {
      fetch: (walk) =>
        new PageFetcher(new FakeSource(chain, { badResponse: 1 }), null, new Metrics()).fetch(walk),
    });
    const walk = headWalk(s);
    await s.runner.runPage(walk);
    expect(await storedLts(s.store)).toEqual([]);
    expect(walk.lastError).toBe("bad_response");
  });
});
