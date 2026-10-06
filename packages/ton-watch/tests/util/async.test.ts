import { describe, expect, test } from "bun:test";

import { mapConcurrent, sleep } from "../../src/util/async";

describe("sleep", () => {
  test("resolves after roughly the given time", async () => {
    const start = performance.now();
    await sleep(25);
    expect(performance.now() - start).toBeGreaterThanOrEqual(20);
  });

  test("zero resolves on the next timer turn", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});

describe("mapConcurrent", () => {
  const tracked = () => {
    let running = 0;
    let peak = 0;
    const fn = async (delay: number) => {
      running++;
      peak = Math.max(peak, running);
      await sleep(delay);
      running--;
      return delay * 10;
    };
    return { fn, peak: () => peak };
  };

  test("keeps input order regardless of completion order", async () => {
    const { fn } = tracked();
    expect(await mapConcurrent([30, 1, 15, 5], 4, fn)).toEqual([300, 10, 150, 50]);
  });

  test("never runs more than `concurrency` at once", async () => {
    const { fn, peak } = tracked();
    const items = Array.from({ length: 20 }, (_, i) => (i % 3) + 1);
    const results = await mapConcurrent(items, 3, fn);
    expect(peak()).toBe(3);
    expect(results).toEqual(items.map((d) => d * 10));
  });

  test("concurrency above the item count runs everything at once", async () => {
    const { fn, peak } = tracked();
    await mapConcurrent([1, 1, 1], 50, fn);
    expect(peak()).toBe(3);
  });

  test("empty input calls nothing", async () => {
    let calls = 0;
    expect(await mapConcurrent([], 4, async () => calls++)).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a failure rejects the whole call", async () => {
    const run = mapConcurrent([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    await expect(run).rejects.toThrow("boom");
  });

  test("rejects a concurrency below 1 instead of silently doing nothing", async () => {
    let calls = 0;
    const run = mapConcurrent([1, 2, 3], 0, async (n) => {
      calls++;
      return n;
    });
    await expect(run).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
