import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test";

import { exponentialBackoff, withJitter } from "../../src/util/backoff";

describe("exponentialBackoff", () => {
  test("starts at minMs and doubles per further failure", () => {
    expect([1, 2, 3, 4, 5].map((n) => exponentialBackoff(n, 100, 1_000_000))).toEqual([
      100, 200, 400, 800, 1600,
    ]);
  });

  test("is capped at maxMs", () => {
    expect(exponentialBackoff(5, 100, 1000)).toBe(1000);
    expect(exponentialBackoff(4, 100, 800)).toBe(800);
    expect(exponentialBackoff(1_000, 100, 60_000)).toBe(60_000);
    expect(exponentialBackoff(Number.MAX_SAFE_INTEGER, 1, 5)).toBe(5);
  });

  test("never exceeds maxMs even when minMs does", () => {
    expect(exponentialBackoff(1, 5_000, 1_000)).toBe(1_000);
  });
});

describe("withJitter", () => {
  let random: Mock<() => number> | undefined;
  afterEach(() => {
    random?.mockRestore();
    random = undefined;
  });

  test("spans [delay/2, delay)", () => {
    random = spyOn(Math, "random").mockReturnValue(0);
    expect(withJitter(1000)).toBe(500);
    random.mockReturnValue(0.999999);
    expect(withJitter(1000)).toBeLessThan(1000);
    expect(withJitter(1000)).toBeGreaterThan(999);
    random.mockReturnValue(0.5);
    expect(withJitter(1000)).toBe(750);
  });

  test("real randomness stays in bounds", () => {
    for (let i = 0; i < 1000; i++) {
      const value = withJitter(200);
      expect(value).toBeGreaterThanOrEqual(100);
      expect(value).toBeLessThan(200);
    }
  });

  test("zero stays zero", () => {
    expect(withJitter(0)).toBe(0);
  });
});
