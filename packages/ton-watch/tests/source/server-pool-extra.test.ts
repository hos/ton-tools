import { describe, expect, test } from "bun:test";

import { classifyError, type ErrorKind, SourceError } from "../../src/core/errors";
import { Metrics } from "../../src/metrics/metrics";
import { ServerPool } from "../../src/source/liteserver/server-pool";

type Run = () => Promise<string>;

function member(id: string, run: Run, extra: { archive?: boolean; isReady?: () => boolean } = {}) {
  const client = {
    calls: 0,
    run: () => {
      client.calls++;
      return run();
    },
  };
  return { id, client, ...extra };
}

const ok =
  (value: string): Run =>
  async () =>
    value;
const fail =
  (message: string): Run =>
  async () => {
    throw new Error(message);
  };

describe("ServerPool construction and stats", () => {
  test("needs at least one server", () => {
    expect(() => new ServerPool([])).toThrow(/at least one server/);
  });

  test("capacity counts regular servers only", () => {
    const pool = new ServerPool(
      [member("a", ok("a")), member("b", ok("b")), member("x", ok("x"), { archive: true })],
      { maxInFlightPerServer: 3 },
    );
    expect(pool.capacity).toBe(6);
    expect(new ServerPool([member("a", ok("a"))]).capacity).toBe(4);
  });

  test("stats reflect readiness, calls, errors and cooldown", async () => {
    const pool = new ServerPool([
      member("up", ok("up")),
      member("down", ok("down"), { isReady: () => false }),
      member("arch", ok("arch"), { archive: true }),
    ]);
    await pool.call("m", (c) => c.run());
    const [up, down, arch] = pool.stats();
    expect(up).toMatchObject({ id: "up", archive: false, ready: true, calls: 1, inFlight: 0 });
    expect(down).toMatchObject({ id: "down", ready: false, calls: 0, coolingDownMs: 0 });
    expect(arch).toMatchObject({ archive: true, calls: 0, errors: {} });
    expect(Number.isInteger(up!.latencyMs)).toBe(true);
  });

  test("records calls and errors into the given metrics and logger", async () => {
    const metrics = new Metrics();
    const debug: unknown[][] = [];
    const noop = () => {};
    const pool = new ServerPool([member("a", fail("socket closed")), member("b", ok("b"))], {
      metrics,
      logger: { debug: (...args) => debug.push(args), info: noop, warn: noop, error: noop },
    });
    pool.members[1]!.latencyMs = 10_000;
    expect(await pool.call("getThing", (c) => c.run())).toBe("b");
    expect(pool.metrics).toBe(metrics);
    expect(debug.some((line) => String(line[0]).includes("getThing failed on a (network)"))).toBe(
      true,
    );
  });
});

describe("ServerPool error handling", () => {
  test("a not-ready server is skipped for the call and cools down", async () => {
    const lagging = member("lagging", fail("block is not applied"));
    const good = member("good", ok("good"));
    const pool = new ServerPool([lagging, good]);
    pool.members[1]!.latencyMs = 10_000;
    expect(await pool.call("m", (c) => c.run())).toBe("good");
    expect(lagging.client.calls).toBe(1);
    expect(pool.stats()[0]!.errors).toEqual({ not_ready: 1 });
    expect(pool.stats()[0]!.coolingDownMs).toBeGreaterThan(0);
  });

  test("every server not ready: fails with the last error's kind", async () => {
    const pool = new ServerPool([
      member("a", fail("block not found")),
      member("b", fail("seqno not in db")),
    ]);
    const err = await pool.call("m", (c) => c.run()).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.kind).toBe("not_ready");
    expect(err.message).toMatch(/^m: no server could serve the request: /);
    expect(err.cause).toBeInstanceOf(Error);
  });

  test("no connected server until the deadline: a network error", async () => {
    const pool = new ServerPool([member("a", ok("a"), { isReady: () => false })], {
      timeoutMs: 50,
    });
    const started = Date.now();
    const err = await pool.call("m", (c) => c.run()).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.kind).toBe("network");
    expect(err.message).toBe("m: no server could serve the request");
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  test("a server that connects late is used", async () => {
    let up = false;
    setTimeout(() => {
      up = true;
    }, 30);
    const pool = new ServerPool([member("a", ok("a"), { isReady: () => up })]);
    expect(await pool.call("m", (c) => c.run())).toBe("a");
  });

  test("a SourceError keeps its kind when attempts run out", async () => {
    const pool = new ServerPool(
      [
        member("a", async () => {
          throw new SourceError("rate_limit", "custom limit");
        }),
      ],
      { maxAttempts: 1 },
    );
    const err = await pool.call("m", (c) => c.run()).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.kind).toBe("rate_limit");
    expect(err.message).toBe("custom limit");
  });

  test("a plain error is wrapped with its kind when attempts run out", async () => {
    const pool = new ServerPool([member("a", fail("connect ECONNREFUSED"))], {
      maxAttempts: 1,
    });
    const err = await pool.call("getTip", (c) => c.run()).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.kind).toBe("network");
    expect(err.message).toBe("getTip: connect ECONNREFUSED");
  });

  test("repeated rate limits back off exponentially up to maxCooldownMs", async () => {
    const pool = new ServerPool([member("a", fail("Too Many Requests"))], {
      maxAttempts: 1,
      maxCooldownMs: 1_000,
    });
    const cooldowns: number[] = [];
    for (let i = 0; i < 5; i++) {
      pool.members[0]!.cooldownUntil = 0; // let the next call through right away
      await pool.call("m", (c) => c.run()).catch(() => {});
      cooldowns.push(pool.members[0]!.cooldownUntil - Date.now());
    }
    expect(pool.members[0]!.rateLimits).toBe(5);
    expect(Math.max(...cooldowns)).toBeLessThanOrEqual(1_000 * 1.5);
    expect(cooldowns[0]!).toBeLessThan(cooldowns[2]!);
  });

  test("a success resets the failure counters", async () => {
    let n = 0;
    const pool = new ServerPool(
      [
        member("a", async () => {
          if (n++ === 0) throw new Error("socket closed");
          return "ok";
        }),
      ],
      { maxCooldownMs: 10 },
    );
    expect(await pool.call("m", (c) => c.run())).toBe("ok");
    expect(pool.members[0]!.failures).toBe(0);
    expect(pool.members[0]!.rateLimits).toBe(0);
    expect(pool.stats()[0]!.errors).toEqual({ network: 1 });
  });

  test("bad responses on every server fall through to archival ones", async () => {
    const broken: Run = async () => {
      throw new SourceError("bad_response", "broken chain");
    };
    const pool = new ServerPool([
      member("a", broken),
      member("b", broken),
      member("x", ok("x"), { archive: true }),
    ]);
    expect(await pool.call("m", (c) => c.run())).toBe("x");
  });

  // BUG: an `unknown` error neither cools the server down nor rules it out, and
  // latency is only updated on success, so the retry goes straight back to the
  // same (best-scored) server. A server that keeps failing with an unclassified
  // error (e.g. a response that does not parse) burns every attempt while a
  // healthy server sits idle, and the call fails.
  test.failing("an unclassified failure is retried on another server", async () => {
    const odd = member("odd", fail("unexpected account state proof layout"));
    const good = member("good", ok("good"));
    const pool = new ServerPool([odd, good], { maxAttempts: 3 });
    pool.members[1]!.latencyMs = 10_000; // `odd` scores best
    expect(await pool.call("m", (c) => c.run())).toBe("good");
    expect(odd.client.calls).toBe(1);
  });

  test("a waiting call gets a slot as soon as one frees up", async () => {
    let release: () => void = () => {};
    const pool = new ServerPool(
      [
        member(
          "a",
          () =>
            new Promise<string>((resolve) => {
              release = () => resolve("first");
            }),
        ),
      ],
      { maxInFlightPerServer: 1 },
    );
    const first = pool.call("m", (c) => c.run());
    const second = pool.call("m", async () => "second");
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    release();
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    // Woken by the release, not by the 1s busy-wait timer.
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("classifyError", () => {
  test.each<[string, ErrorKind]>([
    // Real liteserver / transport messages.
    ["cannot locate transaction in block with specified logical time", "archive_unavailable"],
    ["block is not applied", "not_ready"],
    ["block not found", "not_ready"],
    ["seqno not in db", "not_ready"],
    ["possibly out of sync: masterchain block seqno 1 is too old", "not_ready"],
    ["state already gc'd", "archive_unavailable"],
    ["cannot load block", "archive_unavailable"],
    ["Timeout", "timeout"],
    ["Engine is closed", "network"],
    ["connect ECONNREFUSED 1.2.3.4:5", "network"],
    ["read ECONNRESET", "network"],
    ["Too Many Requests", "rate_limit"],
    ["HTTP 429", "rate_limit"],
    ["server overloaded", "rate_limit"],
    ["something else entirely", "unknown"],
  ])("%s -> %s", (message, kind) => {
    expect(classifyError(new Error(message))).toBe(kind);
  });

  test("non-Error values", () => {
    expect(classifyError({ message: "timed out" })).toBe("timeout");
    expect(classifyError("socket hang up")).toBe("network");
    expect(classifyError(undefined)).toBe("unknown");
    expect(classifyError(new SourceError("bad_response", "timeout in message"))).toBe(
      "bad_response",
    );
  });
});
