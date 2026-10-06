import { describe, expect, test } from "bun:test";

import { Indexer } from "../../src/indexer/indexer";
import type { IndexerOptions } from "../../src/indexer/options";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import { FakeChain, FakeSource, type Faults, fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const B = fakeAddress(2);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(2);
  }
}

async function setup(
  perAccount: number,
  opts: { addresses?: string[]; faults?: Faults; indexer?: Partial<IndexerOptions> } = {},
) {
  const addresses = opts.addresses ?? [A];
  const chain = new FakeChain();
  if (perAccount > 0) chain.grow(addresses, perAccount, 8);
  const store = new MemoryStore();
  for (const a of addresses) await store.addAddress(a, { startLt: 0n });
  const source = new FakeSource(chain, opts.faults);
  const indexer = new Indexer({
    store,
    source,
    detect: "poll",
    tickMs: 10,
    maxIdlePollMs: 0,
    split: false,
    retryMinMs: 1,
    retryMaxMs: 5,
    ...opts.indexer,
  });
  const pages = () => source.calls.getTransactions ?? 0;
  const ticks = () => source.calls.getTip ?? 0;
  const frontier = async (address: string) => (await store.getAddress(address))?.frontier?.lt;
  const complete = async (address: string) =>
    (await frontier(address)) === chain.txs(address).at(-1)?.lt;
  return { chain, store, source, indexer, pages, ticks, frontier, complete };
}

describe("Indexer start/stop", () => {
  test("start() ticks every tickMs until stop(); then it stays quiet", async () => {
    const s = await setup(20);
    s.indexer.start();
    await waitFor(() => s.complete(A));
    await waitFor(() => s.ticks() >= 4);
    await s.indexer.stop();
    const ticks = s.ticks();
    await sleep(50);
    expect(s.ticks()).toBe(ticks);
    expect(s.indexer.lastTickAt).toBeGreaterThan(0);
  });

  test("a second start() while running does not start a second loop", async () => {
    const s = await setup(0, { indexer: { tickMs: 20 } });
    s.indexer.start();
    s.indexer.start();
    await sleep(110);
    await s.indexer.stop();
    // ~6 ticks in 110ms at 20ms; a doubled loop would make ~12.
    expect(s.ticks()).toBeLessThanOrEqual(7);
  });

  test("can be restarted after stop() and picks up new transactions", async () => {
    const s = await setup(10);
    s.indexer.start();
    await waitFor(() => s.complete(A));
    await s.indexer.stop();
    s.chain.grow([A], 25);
    expect(await s.complete(A)).toBe(false);
    s.indexer.start();
    await waitFor(() => s.complete(A));
    await s.indexer.stop();
    const stored = await s.store.read(A, 0n, 1n << 62n, 1_000);
    expect(stored.length).toBe(35);
  });

  test("stop() before the first tick finishes waits for it", async () => {
    const s = await setup(10, { faults: { latencyMs: [20, 20] } });
    s.indexer.start();
    await s.indexer.stop();
    expect(s.indexer.lastTickAt).toBeGreaterThan(0); // the started tick completed
    const ticks = s.ticks();
    await sleep(40);
    expect(s.ticks()).toBe(ticks);
  });

  test("a failing tick is counted and logged; the loop keeps ticking", async () => {
    const s = await setup(5);
    const warnings: unknown[][] = [];
    const indexer = new Indexer({
      store: s.store,
      source: s.source,
      detect: "poll",
      tickMs: 5,
      logger: { debug() {}, info() {}, error() {}, warn: (...args) => warnings.push(args) },
    });
    let failing = 2;
    const getTip = s.source.getTip.bind(s.source);
    s.source.getTip = async () => {
      if (failing-- > 0) throw new Error("socket closed");
      return getTip();
    };
    indexer.start();
    await waitFor(() => s.complete(A));
    await indexer.stop();
    expect(indexer.metrics.get("ton_watch_errors_total", { kind: "network", where: "tick" })).toBe(
      2,
    );
    expect(warnings[0]).toEqual(["tick failed:", "socket closed"]);
  });

  test("stop() waits for pages in flight", async () => {
    const s = await setup(200, { faults: { latencyMs: [10, 10] } });
    let inFlight = 0;
    const fetch = s.source.getTransactions.bind(s.source);
    s.source.getTransactions = async (...args) => {
      inFlight++;
      try {
        return await fetch(...args);
      } finally {
        inFlight--;
      }
    };
    s.indexer.start();
    await waitFor(() => inFlight > 0);
    await s.indexer.stop();
    expect(inFlight).toBe(0);
    expect((await s.store.read(A, 0n, 1n << 62n, 10_000)).length).toBeGreaterThan(0);
  });

  test("stop() does not start new pages, it only waits for the ones in flight", async () => {
    const s = await setup(3_000, { faults: { latencyMs: [2, 2] }, indexer: { concurrency: 2 } });
    s.indexer.start();
    await waitFor(() => s.pages() >= 3);
    const atStop = s.pages();
    await s.indexer.stop();
    expect(s.pages() - atStop).toBeLessThanOrEqual(2);
  });

  test("a stopped indexer does not retry failed pages", async () => {
    const s = await setup(100, { indexer: { retryMinMs: 20, retryMaxMs: 20 } });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    s.source.getTransactions = async () => {
      s.source.calls.getTransactions = (s.source.calls.getTransactions ?? 0) + 1;
      await gate;
      throw new Error("LITE_SERVER_UNKNOWN: timeout");
    };
    s.indexer.start();
    await waitFor(() => s.pages() >= 1);
    const stopped = s.indexer.stop();
    release();
    await stopped;
    const atStop = s.pages();
    await sleep(60);
    expect(s.pages()).toBe(atStop);
  });

  test("stop() then start() without awaiting never runs two ticks at once", async () => {
    const s = await setup(0, { faults: { latencyMs: [5, 5] }, indexer: { tickMs: 20 } });
    let running = 0;
    let maxRunning = 0;
    const getTip = s.source.getTip.bind(s.source);
    s.source.getTip = async () => {
      maxRunning = Math.max(maxRunning, ++running);
      try {
        return await getTip();
      } finally {
        running--;
      }
    };
    s.indexer.start();
    void s.indexer.stop();
    s.indexer.start();
    await sleep(100);
    await s.indexer.stop();
    expect(maxRunning).toBe(1);
  });
});

describe("Indexer address set changes while running", () => {
  test("an address added while running is backfilled", async () => {
    const s = await setup(30);
    s.chain.grow([B], 40);
    s.indexer.start();
    await waitFor(() => s.complete(A));
    await s.store.addAddress(B, { startLt: 0n });
    await waitFor(() => s.complete(B));
    await s.indexer.stop();
    expect((await s.store.read(B, 0n, 1n << 62n, 1_000)).length).toBe(40);
  });

  test("a removed address stops being polled", async () => {
    const s = await setup(5, { addresses: [A, B] });
    s.indexer.start();
    await waitFor(async () => (await s.complete(A)) && (await s.complete(B)));
    await s.store.removeAddress(B);
    await waitFor(() => s.indexer.status().length === 1);
    const lastTx = s.source.getLastTx.bind(s.source);
    const polled: string[] = [];
    s.source.getLastTx = async (address, tip) => {
      polled.push(address);
      return lastTx(address, tip);
    };
    for (let i = 0; i < 3; i++) {
      s.chain.grow([fakeAddress(9)], 1); // a new tip, so idle addresses are polled again
      await sleep(25);
    }
    await s.indexer.stop();
    expect(polled.length).toBeGreaterThan(0);
    expect(polled).not.toContain(B);
  });

  test("removing an address mid-backfill stops fetching its history", async () => {
    const s = await setup(3_000, { faults: { latencyMs: [2, 2] }, indexer: { concurrency: 1 } });
    s.indexer.start();
    await waitFor(() => s.pages() >= 3);
    await s.store.removeAddress(A);
    await waitFor(() => s.indexer.status().length === 0);
    const atRemoval = s.pages();
    await sleep(100);
    await s.indexer.stop();
    expect(s.pages() - atRemoval).toBeLessThanOrEqual(1);
  });

  test("a re-added address resumes from what is already stored", async () => {
    const s = await setup(64, { addresses: [A] });
    await s.indexer.syncOnce();
    await s.store.removeAddress(A);
    await s.indexer.tick();
    s.chain.grow([A], 10);
    await s.store.addAddress(A, { startLt: 0n });
    const before = s.pages();
    await s.indexer.syncOnce();
    expect(await s.complete(A)).toBe(true);
    expect(s.pages() - before).toBe(1); // only the 10 new txs
  });
});

describe("Indexer address shapes", () => {
  test("startLt in the middle of history: nothing at or below it is fetched or stored", async () => {
    const s = await setup(0);
    s.chain.grow([A], 100, 8);
    const txs = s.chain.txs(A);
    await s.store.removeAddress(A, { purge: true });
    await s.store.addAddress(A, { startLt: txs[59]!.lt });
    await s.indexer.syncOnce();
    const stored = await s.store.read(A, 0n, 1n << 62n, 1_000);
    expect(stored.map((tx) => tx.lt)).toEqual(txs.slice(60).map((tx) => tx.lt));
    expect(await s.complete(A)).toBe(true);
    expect(s.pages()).toBe(3); // 40 txs: 16 + 16 + 8, the last page reaching below startLt
  });

  test("startLt at the newest transaction: nothing to fetch, already synced", async () => {
    const s = await setup(0);
    s.chain.grow([A], 20);
    await s.store.removeAddress(A, { purge: true });
    await s.store.addAddress(A, { startLt: s.chain.txs(A).at(-1)!.lt });
    await s.indexer.syncOnce();
    expect(s.pages()).toBe(0);
    const state = await s.store.getAddress(A);
    expect(state).toMatchObject({ head: null, frontier: null, syncedLt: s.chain.tip().syncLt });
  });

  test("an address with no transactions is synced without fetching, then indexed once active", async () => {
    const s = await setup(0);
    s.chain.grow([B], 3); // the chain moves, A stays empty
    await s.indexer.syncOnce();
    expect(s.pages()).toBe(0);
    expect(s.indexer.status()[0]).toMatchObject({ head: null, frontier: null, walks: 0 });
    expect((await s.store.getAddress(A))!.syncedLt).toBe(s.chain.tip().syncLt);
    s.chain.grow([A], 3);
    await s.indexer.syncOnce();
    expect(await s.complete(A)).toBe(true);
  });

  test("a very long walk fetches each page exactly once", async () => {
    const s = await setup(5_000);
    await s.indexer.syncOnce();
    expect(await s.complete(A)).toBe(true);
    expect(s.pages()).toBe(Math.ceil(5_000 / 16));
    expect(s.indexer.metrics.get("ton_watch_walks_started_total", { kind: "head" })).toBe(1);
    expect(s.indexer.metrics.get("ton_watch_walks_started_total", { kind: "gap" })).toBe(0);
  });

  test("drain() resolves at once when there is no work", async () => {
    const s = await setup(0);
    const t = Date.now();
    await s.indexer.drain();
    expect(Date.now() - t).toBeLessThan(20);
  });
});
