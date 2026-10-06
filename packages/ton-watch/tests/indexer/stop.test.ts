/**
 * Prompt stop: `stop()` starts nothing new and retries nothing at once, gives work
 * in flight `stopTimeoutMs` to finish, then abandons it — and whatever was
 * abandoned is refetched after the next start.
 */

import { describe, expect, test } from "bun:test";

import type { TxId } from "../../src/core/types";
import { Indexer } from "../../src/indexer/indexer";
import type { IndexerOptions } from "../../src/indexer/options";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import { FakeChain, FakeSource, fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => {});
/** Slack for timers and the abort unwinding on a loaded machine. */
const EPSILON_MS = 400;

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(2);
  }
}

async function setup(perAccount: number, indexer: Partial<IndexerOptions> = {}) {
  const chain = new FakeChain();
  chain.grow([A], perAccount, 8);
  const store = new MemoryStore();
  await store.addAddress(A, { startLt: 0n });
  const source = new FakeSource(chain);
  const ix = new Indexer({
    store,
    source,
    detect: "poll",
    tickMs: 10,
    maxIdlePollMs: 0,
    split: false,
    retryMinMs: 1,
    retryMaxMs: 5,
    stopTimeoutMs: 100,
    ...indexer,
  });
  const stored = async () => (await store.read(A, 0n, 1n << 62n, 100_000)).map((tx) => tx.lt);
  const complete = async () =>
    (await store.getAddress(A))?.frontier?.lt === chain.txs(A).at(-1)?.lt;
  return { chain, store, source, indexer: ix, stored, complete };
}

/** Times `stop()`. */
async function timedStop(indexer: Indexer): Promise<number> {
  const startedAt = performance.now();
  await indexer.stop();
  return performance.now() - startedAt;
}

describe("Indexer.stop() is prompt", () => {
  test("a page fetch that never answers (and ignores the signal) is abandoned after stopTimeoutMs", async () => {
    const s = await setup(500, { concurrency: 2 });
    const fetch = s.source.getTransactions.bind(s.source);
    let served = 0;
    let signals: (AbortSignal | undefined)[] = [];
    s.source.getTransactions = async (address, from, count, options) => {
      signals.push(options?.signal);
      if (served++ >= 3) return never();
      return fetch(address, from, count);
    };
    s.indexer.start();
    await waitFor(() => served > 3);
    signals = signals.slice(3);
    const elapsed = await timedStop(s.indexer);
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(100 + EPSILON_MS);
    // The hanging calls were told to give up.
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });

  test("a chain tip read that never answers does not hold up stop()", async () => {
    const s = await setup(0);
    let reads = 0;
    s.source.getTip = () => {
      reads++;
      return never();
    };
    s.indexer.start();
    await waitFor(() => reads > 0);
    expect(await timedStop(s.indexer)).toBeLessThan(100 + EPSILON_MS);
  });

  test("an account read that never answers does not hold up stop()", async () => {
    const s = await setup(10);
    let reads = 0;
    s.source.getLastTx = () => {
      reads++;
      return never();
    };
    s.indexer.start();
    await waitFor(() => reads > 0);
    expect(await timedStop(s.indexer)).toBeLessThan(100 + EPSILON_MS);
  });

  test("a walk split lookup that never answers does not hold up stop()", async () => {
    const s = await setup(3_000, {
      split: { minTxs: 50, targetTxs: 20, maxParts: 4 },
      concurrency: 1,
    });
    let lookups = 0;
    s.source.findTxNear = () => {
      lookups++;
      return never();
    };
    s.indexer.start();
    await waitFor(() => lookups > 0);
    expect(await timedStop(s.indexer)).toBeLessThan(100 + EPSILON_MS);
  });

  test("a store write that never returns is given up on as well", async () => {
    const s = await setup(200, { concurrency: 1 });
    let writes = 0;
    const write = s.store.write.bind(s.store);
    s.store.write = (address, txs) => (++writes > 2 ? never() : write(address, txs));
    s.indexer.start();
    await waitFor(() => writes > 2);
    expect(await timedStop(s.indexer)).toBeLessThan(100 + EPSILON_MS);
  });

  test("stopTimeoutMs: 0 abandons at once", async () => {
    const s = await setup(100, { stopTimeoutMs: 0 });
    let calls = 0;
    s.source.getTransactions = () => {
      calls++;
      return never();
    };
    s.indexer.start();
    await waitFor(() => calls > 0);
    expect(await timedStop(s.indexer)).toBeLessThan(EPSILON_MS);
  });

  test("a negative stopTimeoutMs is rejected", () => {
    const store = new MemoryStore();
    const source = new FakeSource(new FakeChain());
    expect(() => new Indexer({ store, source, stopTimeoutMs: -1 })).toThrow(/stopTimeoutMs/);
  });
});

describe("Indexer.stop() grace period", () => {
  test("pages that arrive within stopTimeoutMs are stored", async () => {
    const s = await setup(400, { concurrency: 4, stopTimeoutMs: 1_000 });
    const fetch = s.source.getTransactions.bind(s.source);
    const inFlight = new Set<TxId>();
    let stopping = false;
    const answeredAfterStop: TxId[] = [];
    s.source.getTransactions = async (address, from, count) => {
      inFlight.add(from);
      await sleep(60);
      inFlight.delete(from);
      if (stopping) answeredAfterStop.push(from);
      return fetch(address, from, count);
    };
    s.indexer.start();
    await waitFor(() => inFlight.size > 0 && answeredAfterStop.length === 0);
    await waitFor(async () => (await s.stored()).length > 0);
    stopping = true;
    const elapsed = await timedStop(s.indexer);
    expect(answeredAfterStop.length).toBeGreaterThan(0);
    // Waited for the pages in flight, not for the whole grace period.
    expect(elapsed).toBeLessThan(500);
    const stored = new Set(await s.stored());
    for (const cursor of answeredAfterStop) expect(stored.has(cursor.lt)).toBe(true);
  });

  test("no page, retry or tick starts after stop() is called", async () => {
    const s = await setup(300, { concurrency: 2, retryMinMs: 1, retryMaxMs: 1 });
    let calls = 0;
    s.source.getTransactions = async () => {
      calls++;
      await sleep(30);
      throw new Error("LITE_SERVER_UNKNOWN: timeout");
    };
    const ticks = () => s.source.calls.getTip ?? 0;
    s.indexer.start();
    await waitFor(() => calls >= 4);
    const stopped = s.indexer.stop();
    const callsAtStop = calls;
    const ticksAtStop = ticks();
    await stopped;
    await sleep(60);
    expect(calls).toBe(callsAtStop);
    expect(ticks()).toBe(ticksAtStop);
  });

  test("a failure while stopping is not retried or reported as a fetch error", async () => {
    const s = await setup(100, { concurrency: 1 });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.source.getTransactions = async () => {
      calls++;
      await gate;
      throw new Error("LITE_SERVER_UNKNOWN: timeout");
    };
    const fetchErrors: unknown[] = [];
    s.indexer.on("fetchError", (...args) => fetchErrors.push(args));
    s.indexer.start();
    await waitFor(() => calls > 0);
    const stopped = s.indexer.stop();
    release();
    await stopped;
    expect(fetchErrors).toEqual([]);
  });
});

describe("work abandoned by stop() is refetched after the next start", () => {
  test("an aborted page fetch: the walk resumes from its cursor", async () => {
    const s = await setup(300, { concurrency: 1 });
    const fetch = s.source.getTransactions.bind(s.source);
    let hang = true;
    let calls = 0;
    s.source.getTransactions = (address: string, from: TxId, count: number) => {
      // The first three pages are served, then the fourth hangs.
      if (hang && ++calls > 3) return never();
      return fetch(address, from, count);
    };
    s.indexer.start();
    await waitFor(() => calls > 3);
    expect((await s.stored()).length).toBe(48);
    await s.indexer.stop();
    expect(await s.complete()).toBe(false);

    hang = false;
    s.indexer.start();
    await waitFor(() => s.complete());
    await s.indexer.stop();
    expect(await s.stored()).toEqual(s.chain.txs(A).map((tx) => tx.lt));
  });

  test("a page stuck in a store write: its walk is dropped and the rest is found as a gap", async () => {
    const s = await setup(300, { concurrency: 1 });
    const write = s.store.write.bind(s.store);
    let stuck = true;
    let writes = 0;
    s.store.write = (address, txs) => {
      // The first three pages are written, then the fourth write never returns.
      if (stuck && ++writes > 3) return never();
      return write(address, txs);
    };
    s.indexer.start();
    await waitFor(() => writes > 3);
    expect((await s.stored()).length).toBe(48);
    const elapsed = await timedStop(s.indexer);
    expect(elapsed).toBeLessThan(100 + EPSILON_MS);
    expect(await s.complete()).toBe(false);

    stuck = false;
    s.indexer.start();
    await waitFor(() => s.complete());
    await s.indexer.stop();
    expect(await s.stored()).toEqual(s.chain.txs(A).map((tx) => tx.lt));
    expect(s.indexer.metrics.get("ton_watch_walks_started_total", { kind: "gap" })).toBeGreaterThan(
      0,
    );
  });
});
