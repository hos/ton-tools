import { describe, expect, test } from "bun:test";

import { classifyError, SourceError } from "../src/errors";
import { ServerPool } from "../src/source/pool";

type Behavior = (call: number) => Promise<string>;

function member(id: string, behavior: Behavior, archive = false) {
  let n = 0;
  const calls: number[] = [];
  return {
    id,
    archive,
    calls,
    client: { run: () => (calls.push(Date.now()), behavior(n++)) },
  };
}

const ok =
  (v: string): Behavior =>
  async () =>
    v;
const fail =
  (msg: string): Behavior =>
  async () => {
    throw new Error(msg);
  };

describe("error classification", () => {
  test.each([
    ["LITE_SERVER_UNKNOWN: too many requests", "rate_limit"],
    ["cannot locate transaction in block with specified logical time", "archive_unavailable"],
    [
      "block (0,8000000000000000,1) is not in db (possibly out of sync: shard_client_seqno=1)",
      "not_ready",
    ],
    ["Timeout", "timeout"],
    ["Engine is closed", "network"],
    ["something else", "unknown"],
  ])("%s → %s", (msg, kind) => {
    expect(classifyError(new Error(msg))).toBe(kind as any);
  });
});

describe("ServerPool", () => {
  test("rate-limited server cools down and calls move to the others", async () => {
    const limited = member("limited", fail("too many requests"));
    const healthy = member("healthy", ok("ok"));
    const pool = new ServerPool([limited, healthy], { maxInFlightPerServer: 1 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => pool.call("m", (c) => c.run())),
    );
    expect(results.every((r) => r === "ok")).toBe(true);
    // Once limited it is left alone for its cooldown.
    expect(limited.calls.length).toBeLessThanOrEqual(2);
    expect(pool.stats().find((s) => s.id === "limited")!.coolingDownMs).toBeGreaterThan(0);
  });

  test("archive misses try every regular server, then archival ones", async () => {
    const a = member("a", fail("cannot locate transaction"));
    const b = member("b", fail("cannot locate transaction"));
    const arch = member("archive", ok("old"), true);
    const pool = new ServerPool([a, b, arch]);
    expect(await pool.call("m", (c) => c.run())).toBe("old");
    expect(a.calls.length).toBe(1);
    expect(b.calls.length).toBe(1);
  });

  test("archival servers are not used for normal traffic", async () => {
    const a = member("a", ok("a"));
    const arch = member("archive", ok("arch"), true);
    const pool = new ServerPool([a, arch]);
    for (let i = 0; i < 10; i++) await pool.call("m", (c) => c.run());
    expect(arch.calls.length).toBe(0);
  });

  test("gives up with archive_unavailable when nobody has the data", async () => {
    const pool = new ServerPool([
      member("a", fail("cannot locate transaction")),
      member("b", fail("not in db")),
    ]);
    const err = await pool.call("m", (c) => c.run()).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(classifyError(err)).toBe("archive_unavailable");
  });

  test("timeouts are enforced and retried elsewhere", async () => {
    const slow = member("slow", () => new Promise((r) => setTimeout(() => r("late"), 1_000)));
    const fast = member("fast", async () => "fast");
    // Make the slow one look best so it is picked first.
    const pool = new ServerPool([slow, fast], { timeoutMs: 30 });
    pool.members[1]!.latency = 10_000;
    expect(await pool.call("m", (c) => c.run())).toBe("fast");
    expect(pool.stats().find((s) => s.id === "slow")!.errors.timeout).toBe(1);
  });

  test("respects the per-server in-flight bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const m = member("only", async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return "x";
    });
    const pool = new ServerPool([m], { maxInFlightPerServer: 3 });
    await Promise.all(Array.from({ length: 30 }, () => pool.call("m", (c) => c.run())));
    expect(peak).toBe(3);
  });

  test("stops after maxAttempts on persistent errors", async () => {
    const m = member("bad", fail("weird failure"));
    const pool = new ServerPool([m], { maxAttempts: 3 });
    await expect(pool.call("m", (c) => c.run())).rejects.toThrow("weird failure");
    expect(m.calls.length).toBe(3);
  });
});
