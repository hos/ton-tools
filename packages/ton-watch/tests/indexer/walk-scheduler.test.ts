import { describe, expect, test } from "bun:test";

import type { WalkKind, WalkRange } from "../../src/indexer/walk";
import { WalkScheduler } from "../../src/indexer/walk-scheduler";
import { Metrics } from "../../src/metrics/metrics";

const A = "0:aa";
const B = "0:bb";

const range = (kind: WalkKind, topLt: bigint, floorLt = 0n, address = A): WalkRange => ({
  address,
  kind,
  cursor: { lt: topLt, hash: Buffer.alloc(32) },
  floorLt,
  topLt,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise with its resolver exposed. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("WalkScheduler concurrency", () => {
  test("never runs more pages at once than the limit, and finishes every walk", async () => {
    let scheduler!: WalkScheduler;
    let inFlight = 0;
    let maxInFlight = 0;
    let pages = 0;
    const perWalkRunning = new Map<number, number>();
    let calls = 0;
    scheduler = new WalkScheduler(
      3,
      async (walk) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        perWalkRunning.set(walk.id, (perWalkRunning.get(walk.id) ?? 0) + 1);
        expect(perWalkRunning.get(walk.id)).toBe(1); // one page at a time per walk
        await sleep(++calls % 3); // out-of-order completions
        pages++;
        walk.pages++;
        if (walk.pages === 3) scheduler.remove(walk);
        perWalkRunning.set(walk.id, 0);
        inFlight--;
      },
      new Metrics(),
    );
    for (let i = 0; i < 10; i++) scheduler.add(range(i % 2 ? "head" : "gap", BigInt(i + 1)));
    expect(scheduler.pagesInFlight).toBe(3);
    while (scheduler.hasPendingWork()) await scheduler.whenIdle(20);
    expect(maxInFlight).toBe(3);
    expect(pages).toBe(30);
    expect(scheduler.all()).toEqual([]);
  });

  test("a single walk never has two pages in flight even with spare capacity", async () => {
    const gate = deferred();
    let starts = 0;
    const scheduler = new WalkScheduler(
      8,
      async () => {
        starts++;
        await gate.promise;
      },
      new Metrics(),
    );
    scheduler.add(range("head", 10n));
    scheduler.pump();
    scheduler.pump();
    expect(starts).toBe(1);
    expect(scheduler.pagesInFlight).toBe(1);
    scheduler.remove(scheduler.all()[0]!);
    gate.resolve();
    await scheduler.whenIdle();
    expect(scheduler.pagesInFlight).toBe(0);
  });
});

describe("WalkScheduler priority", () => {
  test("head walks run before gap walks, then the one waiting longest", async () => {
    const order: string[] = [];
    const blocker = deferred();
    let scheduler!: WalkScheduler;
    const names = ["blocker", "gap-recent", "gap-old", "head-recent", "head-old", "gap-fresh"];
    const nameOf = (walk: { topLt: bigint }) => names[Number(walk.topLt)]!;
    scheduler = new WalkScheduler(
      1,
      async (walk) => {
        order.push(nameOf(walk));
        if (nameOf(walk) === "blocker") await blocker.promise;
        scheduler.remove(walk);
      },
      new Metrics(),
    );
    const add = (name: string, kind: WalkKind, notBefore = 0) => {
      const walk = scheduler.add(range(kind, BigInt(names.indexOf(name))));
      walk.notBefore = notBefore;
    };
    add("blocker", "gap");
    const now = Date.now();
    add("gap-recent", "gap", now - 10);
    add("gap-old", "gap", now - 1_000);
    add("head-recent", "head", now - 5);
    add("head-old", "head", now - 500);
    add("gap-fresh", "gap", 0);
    blocker.resolve();
    while (scheduler.hasPendingWork()) await scheduler.whenIdle(20);
    expect(order).toEqual([
      "blocker",
      "head-old",
      "head-recent",
      "gap-fresh",
      "gap-old",
      "gap-recent",
    ]);
  });
});

describe("WalkScheduler retry timers", () => {
  test("a walk waiting on its retry delay is started by the wake timer, not before", async () => {
    const runs: number[] = [];
    let scheduler!: WalkScheduler;
    scheduler = new WalkScheduler(
      2,
      async (walk) => {
        runs.push(Date.now());
        if (runs.length === 1) walk.notBefore = Date.now() + 40;
        else scheduler.remove(walk);
      },
      new Metrics(),
    );
    scheduler.add(range("gap", 5n));
    await sleep(10);
    expect(runs.length).toBe(1);
    await sleep(80);
    expect(runs.length).toBe(2);
    expect(runs[1]! - runs[0]!).toBeGreaterThanOrEqual(38);
  });

  test("walks retry in order of their retry time", async () => {
    const retried: bigint[] = [];
    let scheduler!: WalkScheduler;
    scheduler = new WalkScheduler(
      4,
      async (walk) => {
        if (walk.failures === 0) {
          walk.failures = 1;
          walk.notBefore = Date.now() + Number(walk.topLt); // topLt doubles as the delay
          return;
        }
        retried.push(walk.topLt);
        scheduler.remove(walk);
      },
      new Metrics(),
    );
    scheduler.add(range("gap", 60n));
    scheduler.add(range("gap", 15n));
    while (scheduler.all().length > 0) await sleep(5);
    expect(retried).toEqual([15n, 60n]);
  });

  test("stop() cancels the wake timer of waiting walks", async () => {
    let runs = 0;
    const scheduler = new WalkScheduler(
      2,
      async (walk) => {
        runs++;
        walk.notBefore = Date.now() + 20;
      },
      new Metrics(),
    );
    scheduler.add(range("gap", 5n));
    await scheduler.whenIdle();
    expect(runs).toBe(1);
    scheduler.stop();
    await sleep(60);
    expect(runs).toBe(1);
    expect(scheduler.hasPendingWork()).toBe(true); // still scheduled, just not woken
  });
});

describe("WalkScheduler bookkeeping", () => {
  const idle = () => new WalkScheduler(0, async () => {}, new Metrics());

  test("covers, highestTopLt, forAddress, hasWalks, has and remove", () => {
    const scheduler = idle();
    const w1 = scheduler.add(range("gap", 100n, 50n));
    scheduler.add(range("head", 300n, 200n));
    scheduler.add(range("head", 999n, 0n, B));

    expect(scheduler.covers(A, 50n)).toBe(false); // floor is exclusive
    expect(scheduler.covers(A, 51n)).toBe(true);
    expect(scheduler.covers(A, 100n)).toBe(true); // top is inclusive
    expect(scheduler.covers(A, 150n)).toBe(false);
    expect(scheduler.covers(A, 250n)).toBe(true);
    expect(scheduler.covers(B, 51n)).toBe(true);
    expect(scheduler.covers("0:cc", 51n)).toBe(false);

    expect(scheduler.highestTopLt(A, 0n)).toBe(300n);
    expect(scheduler.highestTopLt(A, 400n)).toBe(400n);
    expect(scheduler.highestTopLt("0:cc", 7n)).toBe(7n);

    expect(scheduler.forAddress(A).length).toBe(2);
    expect(scheduler.hasWalks(B)).toBe(true);
    expect(scheduler.has(w1)).toBe(true);
    scheduler.remove(w1);
    expect(scheduler.has(w1)).toBe(false);
    expect(scheduler.covers(A, 51n)).toBe(false);
    expect(scheduler.all().length).toBe(2);
  });

  test("walk ids are unique and the walk starts with clean progress", () => {
    const scheduler = idle();
    const a = scheduler.add(range("gap", 1n));
    const b = scheduler.add(range("head", 2n), { split: true });
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ pages: 0, fetched: 0, failures: 0, notBefore: 0, split: false });
    expect(b.split).toBe(true);
  });

  test("counts started walks by kind", () => {
    const metrics = new Metrics();
    const scheduler = new WalkScheduler(0, async () => {}, metrics);
    scheduler.add(range("gap", 1n));
    scheduler.add(range("gap", 2n));
    scheduler.add(range("head", 3n));
    expect(metrics.get("ton_watch_walks_started_total", { kind: "gap" })).toBe(2);
    expect(metrics.get("ton_watch_walks_started_total", { kind: "head" })).toBe(1);
  });

  test("dropAddress drops all of an address's walks, including the running one", async () => {
    const gate = deferred();
    const scheduler = new WalkScheduler(1, () => gate.promise, new Metrics());
    const running = scheduler.add(range("head", 10n));
    const waiting = scheduler.add(range("gap", 5n));
    const other = scheduler.add(range("gap", 5n, 0n, B));
    expect(running.running).toBe(true);
    scheduler.dropAddress(A);
    expect(scheduler.has(running)).toBe(false);
    expect(scheduler.has(waiting)).toBe(false);
    expect(scheduler.has(other)).toBe(true);
    expect(scheduler.pagesInFlight).toBe(1); // the page in flight still completes
    scheduler.remove(other);
    gate.resolve();
    await scheduler.whenIdle();
  });

  test("stop() starts no new pages until resume()", async () => {
    let runs = 0;
    const scheduler: WalkScheduler = new WalkScheduler(
      1,
      async (walk) => {
        runs++;
        scheduler.remove(walk);
      },
      new Metrics(),
    );
    scheduler.stop();
    scheduler.add(range("gap", 5n));
    await sleep(10);
    expect(runs).toBe(0);
    scheduler.resume();
    await scheduler.whenIdle();
    expect(runs).toBe(1);
  });

  test("hasPendingWork ignores walks failing repeatedly and parked walks", () => {
    const scheduler = idle();
    expect(scheduler.hasPendingWork()).toBe(false);
    const walk = scheduler.add(range("gap", 1n));
    expect(scheduler.hasPendingWork()).toBe(true);
    walk.failures = 4;
    expect(scheduler.hasPendingWork()).toBe(true);
    walk.failures = 5;
    expect(scheduler.hasPendingWork()).toBe(false);
    walk.failures = 4;
    walk.lastError = "archive_unavailable";
    expect(scheduler.hasPendingWork()).toBe(false); // parked (> 3 archive misses)
    walk.running = true;
    expect(scheduler.hasPendingWork()).toBe(true);
  });

  test("whenIdle resolves when the last page finishes, or after its timeout", async () => {
    const gate = deferred();
    const scheduler = new WalkScheduler(2, () => gate.promise, new Metrics());
    let idle = false;
    void scheduler.whenIdle().then(() => {
      idle = true;
    });
    const walk = scheduler.add(range("gap", 1n));
    await sleep(5);
    expect(idle).toBe(false);
    scheduler.remove(walk);
    gate.resolve();
    await sleep(0);
    expect(idle).toBe(true);

    const t = Date.now();
    await scheduler.whenIdle(15);
    expect(Date.now() - t).toBeGreaterThanOrEqual(13);
  });
});
