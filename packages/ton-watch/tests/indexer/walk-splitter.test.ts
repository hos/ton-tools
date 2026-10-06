import { describe, expect, test } from "bun:test";

import type { TxId } from "../../src/core/types";
import type { SplitOptions } from "../../src/indexer/options";
import { Run } from "../../src/indexer/run";
import type { Walk } from "../../src/indexer/walk";
import { WalkScheduler } from "../../src/indexer/walk-scheduler";
import { WalkSplitter } from "../../src/indexer/walk-splitter";
import { Metrics } from "../../src/metrics/metrics";
import type { TxSource } from "../../src/source/source";
import { silentLogger } from "../../src/util/logger";

const A = "0:aa";
const id = (lt: bigint): TxId => ({ lt, hash: Buffer.alloc(32, Number(lt % 256n)) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A walk over (0, 10_000] that fetched 100 txs and is at lt 9_000: 10 lt per tx,
 * so ~900 txs remain.
 */
function setup(
  findTxNear: (lt: bigint) => Promise<TxId | null> = async (lt) => id(lt - 7n),
  settings: Partial<SplitOptions> = {},
) {
  const metrics = new Metrics();
  const run = new Run();
  const scheduler = new WalkScheduler(0, async () => {}, metrics); // holds walks only
  const asked: { lt: bigint; hint: unknown }[] = [];
  const source = {
    findTxNear: (_address: string, lt: bigint, hint?: unknown) => {
      asked.push({ lt, hint });
      return findTxNear(lt);
    },
  } as unknown as TxSource;
  const splitter = new WalkSplitter(
    { minTxs: 100, targetTxs: 300, maxParts: 32, ...settings },
    source,
    scheduler,
    metrics,
    silentLogger,
    () => run,
  );
  const walk = scheduler.add({
    address: A,
    kind: "gap",
    cursor: id(9_000n),
    floorLt: 0n,
    topLt: 10_000n,
  });
  walk.pages = 3;
  walk.fetched = 100;
  return { metrics, scheduler, splitter, walk, asked, run };
}

/** Every walk's (floorLt, cursor] span, sorted: must tile (0, 9_000] exactly. */
function expectTiling(walks: Walk[], floor: bigint, top: bigint) {
  const spans = walks
    .map((walk) => [walk.floorLt, walk.cursor.lt] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  expect(spans[0]![0]).toBe(floor);
  for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBe(spans[i - 1]![1]);
  expect(spans.at(-1)![1]).toBe(top);
}

describe("WalkSplitter.maybeSplit", () => {
  test("cuts the rest of a long walk into adjacent pieces with no overlap and no hole", async () => {
    const s = setup();
    s.splitter.maybeSplit(s.walk);
    expect(s.walk.split).toBe(true);
    // 900 remaining / 300 per piece = 3 parts: 2 split points at 1/3 and 2/3.
    expect(s.asked.map((a) => a.lt)).toEqual([3_000n, 6_000n]);
    expect(s.asked[0]!.hint).toEqual({ ltPerTx: 10, signal: s.run.signal });
    await flush();
    const walks = s.scheduler.all();
    expect(walks.length).toBe(3);
    const pieces = walks.filter((walk) => walk !== s.walk);
    expect(pieces.map((p) => [p.floorLt, p.cursor.lt, p.topLt])).toEqual([
      [0n, 2_993n, 2_993n],
      [2_993n, 5_993n, 5_993n],
    ]);
    expect(pieces.every((p) => p.split && p.kind === "gap" && p.address === A)).toBe(true);
    expect(s.walk.floorLt).toBe(5_993n);
    expect(s.walk.topLt).toBe(10_000n);
    expectTiling(walks, 0n, 9_000n);
    expect(s.metrics.get("ton_watch_splits_total")).toBe(1);
    expect(s.metrics.get("ton_watch_split_points_total")).toBe(2);
  });

  test("pieces keep the kind of the walk they came from", async () => {
    const s = setup();
    s.walk.kind = "head";
    s.splitter.maybeSplit(s.walk);
    await flush();
    expect(s.scheduler.all().every((walk) => walk.kind === "head")).toBe(true);
  });

  test("is capped at maxParts", async () => {
    const s = setup(undefined, { targetTxs: 10, maxParts: 4 });
    s.splitter.maybeSplit(s.walk);
    expect(s.asked.map((a) => a.lt)).toEqual([2_250n, 4_500n, 6_750n]);
    await flush();
    expect(s.scheduler.all().length).toBe(4);
    expectTiling(s.scheduler.all(), 0n, 9_000n);
  });

  test("leaves walks alone that are too young, already split, empty, or short", () => {
    const cases: [string, (walk: Walk) => void][] = [
      ["fewer than 3 pages", (walk) => (walk.pages = 2)],
      ["already split", (walk) => (walk.split = true)],
      ["nothing fetched", (walk) => (walk.fetched = 0)],
      ["below minTxs", (walk) => (walk.floorLt = 8_100n)], // ~90 txs left
    ];
    for (const [name, mutate] of cases) {
      const s = setup();
      mutate(s.walk);
      const wasSplit = s.walk.split;
      s.splitter.maybeSplit(s.walk);
      expect({ name, asked: s.asked.length }).toEqual({ name, asked: 0 });
      expect(s.walk.split).toBe(wasSplit);
    }
  });

  test("a range worth fewer than two pieces is marked split but not cut", () => {
    const s = setup(undefined, { targetTxs: 600 }); // 900 / 600 → 1 part
    s.splitter.maybeSplit(s.walk);
    expect(s.walk.split).toBe(true);
    expect(s.asked.length).toBe(0);
    expect(s.metrics.get("ton_watch_splits_total")).toBe(0);
  });

  test("minTxs boundary: exactly minTxs remaining splits", () => {
    const s = setup(undefined, { minTxs: 900 });
    s.splitter.maybeSplit(s.walk);
    expect(s.asked.length).toBe(2);
    const t = setup(undefined, { minTxs: 901 });
    t.splitter.maybeSplit(t.walk);
    expect(t.asked.length).toBe(0);
  });
});

describe("WalkSplitter split points", () => {
  test("settled() waits for split points still being looked up, then for the split", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = setup(async (lt) => {
      await gate;
      return id(lt);
    });
    s.splitter.maybeSplit(s.walk);
    let settled = false;
    const done = s.splitter.settled().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    release();
    await done;
    expect(s.scheduler.all().length).toBeGreaterThan(1);
  });

  test("a failing findTxNear is counted and its point skipped; the others still split", async () => {
    const s = setup(async (lt) => {
      if (lt === 3_000n) throw new Error("LITE_SERVER_UNKNOWN: timeout");
      return id(lt - 1n);
    });
    s.splitter.maybeSplit(s.walk);
    await flush();
    expect(s.metrics.get("ton_watch_errors_total", { kind: "timeout", where: "findTxNear" })).toBe(
      1,
    );
    const pieces = s.scheduler.all().filter((walk) => walk !== s.walk);
    expect(pieces.map((p) => [p.floorLt, p.topLt])).toEqual([[0n, 5_999n]]);
    expect(s.walk.floorLt).toBe(5_999n);
    expectTiling(s.scheduler.all(), 0n, 9_000n);
  });

  test("when nothing is found the walk stays whole", async () => {
    for (const find of [async () => null, async () => Promise.reject(new Error("boom"))]) {
      const s = setup(find);
      s.splitter.maybeSplit(s.walk);
      await flush();
      expect(s.scheduler.all()).toEqual([s.walk]);
      expect(s.walk.floorLt).toBe(0n);
      expect(s.walk.split).toBe(true); // not retried every page
      expect(s.metrics.get("ton_watch_split_points_total")).toBe(0);
    }
  });

  test("points outside what is left of the walk and duplicates are dropped", async () => {
    const answers = [id(0n), id(9_000n)]; // on the floor, on the cursor
    const s = setup(async () => answers.shift() ?? id(4_000n), { targetTxs: 100, maxParts: 5 });
    s.splitter.maybeSplit(s.walk);
    expect(s.asked.length).toBe(4);
    await flush();
    // Only 4_000 survives, once.
    const pieces = s.scheduler.all().filter((walk) => walk !== s.walk);
    expect(pieces.map((p) => [p.floorLt, p.topLt])).toEqual([[0n, 4_000n]]);
    expect(s.walk.floorLt).toBe(4_000n);
    expect(s.metrics.get("ton_watch_split_points_total")).toBe(1);
  });

  test("points the walk passed while they were being found are dropped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = setup(async (lt) => {
      await gate;
      return id(lt);
    });
    s.splitter.maybeSplit(s.walk);
    s.walk.cursor = id(5_000n); // the walk kept going meanwhile
    release();
    await flush();
    const pieces = s.scheduler.all().filter((walk) => walk !== s.walk);
    expect(pieces.map((p) => [p.floorLt, p.topLt])).toEqual([[0n, 3_000n]]);
    expectTiling(s.scheduler.all(), 0n, 5_000n);
  });

  test("a walk that finished while points were being found is not split", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = setup(async (lt) => {
      await gate;
      return id(lt);
    });
    s.splitter.maybeSplit(s.walk);
    s.scheduler.remove(s.walk);
    release();
    await flush();
    expect(s.scheduler.all()).toEqual([]);
    expect(s.metrics.get("ton_watch_split_points_total")).toBe(0);
  });
});
