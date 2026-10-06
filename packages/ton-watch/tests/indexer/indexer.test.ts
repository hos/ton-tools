import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { Indexer } from "../../src/indexer/indexer";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import { PgStore } from "../../src/stores/pg/pg-store";
import type { Store } from "../../src/stores/store";
import { FakeChain, FakeSource, fakeAddress, rng } from "../fixtures/fake-chain";

const addrs = (n: number, offset = 1) =>
  Array.from({ length: n }, (_, i) => fakeAddress(i + offset));

async function expectComplete(store: Store, chain: FakeChain, addresses: string[]) {
  for (const a of addresses) {
    const stored = await store.read(a, 0n, 1n << 62n, 1_000_000);
    const expected = chain.txs(a);
    expect(stored.map((t) => t.lt)).toEqual(expected.map((t) => t.lt));
    expect(stored.every((t, i) => t.hash.equals(expected[i]!.hash))).toBe(true);
    const state = await store.getAddress(a);
    expect(state?.frontier?.lt).toBe(expected.at(-1)?.lt);
  }
}

async function setup(n: number, perAccount: number, opts: { faults?: any; store?: Store } = {}) {
  const chain = new FakeChain();
  const addresses = addrs(n);
  chain.grow(addresses, perAccount, 4);
  const store = opts.store ?? new MemoryStore();
  await store.migrate();
  for (const a of addresses) await store.addAddress(a, { startLt: 0n });
  const source = new FakeSource(chain, opts.faults);
  return { chain, addresses, store, source };
}

describe("Indexer", () => {
  test("backfills full history of many addresses in parallel", async () => {
    const { chain, addresses, store, source } = await setup(10, 100);
    const indexer = new Indexer({ store, source, concurrency: 8, detect: "poll" });
    await indexer.syncOnce();
    await expectComplete(store, chain, addresses);
    // 100 txs / 16 per page → 7 pages per address, nothing fetched twice.
    expect(source.calls.getTransactions).toBe(70);
  });

  test("survives rate limits, timeouts, bad pages and out-of-order responses", async () => {
    const { chain, addresses, store, source } = await setup(6, 120, {
      faults: { seed: 42, rateLimit: 0.2, timeout: 0.1, badResponse: 0.1, latencyMs: [0, 4] },
    });
    const indexer = new Indexer({
      store,
      source,
      concurrency: 12,
      detect: "poll",
      retryMinMs: 1,
      retryMaxMs: 5,
    });
    await indexer.syncOnce(200);
    await expectComplete(store, chain, addresses);
    expect(
      indexer.metrics.get("ton_watch_errors_total", { kind: "rate_limit", where: "walk" }),
    ).toBeGreaterThan(0);
    expect(
      indexer.metrics.get("ton_watch_errors_total", { kind: "bad_response", where: "walk" }),
    ).toBeGreaterThan(0);
  });

  test("history beyond the archive is parked, never skipped, and resumes when served", async () => {
    const { chain, addresses, store, source } = await setup(1, 64);
    const [a] = addresses as [string];
    source.faults = { archiveFloorLt: chain.txs(a)[40]!.lt };
    const indexer = new Indexer({
      store,
      source,
      detect: "poll",
      archiveRetryMs: 1,
      retryMinMs: 1,
      retryMaxMs: 2,
    });
    await indexer.syncOnce(10);
    const state = await store.getAddress(a);
    expect(state?.frontier).toBeNull(); // nothing delivered past the hole
    expect(indexer.status()[0]!.stuck).toBe(1);
    expect(
      indexer.metrics.get("ton_watch_errors_total", { kind: "archive_unavailable", where: "walk" }),
    ).toBeGreaterThan(0);

    source.faults = {}; // archival server appears
    await new Promise((r) => setTimeout(r, 5));
    await indexer.syncOnce();
    await expectComplete(store, chain, addresses);
  });

  test("new transactions after the initial sync are picked up (poll and blocks)", async () => {
    for (const detect of ["poll", "blocks"] as const) {
      const { chain, addresses, store, source } = await setup(5, 20);
      const indexer = new Indexer({ store, source, detect, maxIdlePollMs: 0 });
      await indexer.syncOnce();
      chain.grow(addresses.slice(0, 3), 30, 5);
      await indexer.syncOnce();
      await expectComplete(store, chain, addresses);
    }
  });

  test("resumes after a crash mid-backfill from whatever was written", async () => {
    const { chain, addresses, store, source } = await setup(4, 200);
    const r = rng(9);
    // A previous run wrote random scattered pieces before dying.
    for (const a of addresses) {
      const txs = chain.txs(a);
      for (let i = 0; i < 6; i++) {
        const start = Math.floor(r() * 180);
        await store.write(a, txs.slice(start, start + 10));
      }
    }
    const indexer = new Indexer({ store, source, detect: "poll" });
    await indexer.syncOnce();
    await expectComplete(store, chain, addresses);
    // Already-stored ranges are not refetched wholesale.
    expect(source.calls.getTransactions!).toBeLessThan(4 * Math.ceil(200 / 16) + 4 * 8);
  });

  test("two indexers on the same store converge without duplicates", async () => {
    const { chain, addresses, store } = await setup(5, 150);
    const s1 = new FakeSource(chain, { seed: 1, latencyMs: [0, 3] });
    const s2 = new FakeSource(chain, { seed: 2, latencyMs: [0, 3] });
    const i1 = new Indexer({ store, source: s1, detect: "poll" });
    const i2 = new Indexer({ store, source: s2, detect: "poll" });
    await Promise.all([i1.syncOnce(), i2.syncOnce()]);
    await expectComplete(store, chain, addresses);
  });

  test("works against Postgres (PGlite) with concurrent writers", async () => {
    const store = new PgStore(new PGlite() as any);
    const { chain, addresses, source } = await setup(4, 90, {
      store,
      faults: { seed: 5, latencyMs: [0, 3], rateLimit: 0.1 },
    });
    const indexer = new Indexer({
      store,
      source,
      concurrency: 8,
      detect: "poll",
      retryMinMs: 1,
      retryMaxMs: 5,
    });
    await indexer.syncOnce();
    await expectComplete(store, chain, addresses);
  });

  test("startLt limits history; addresses added at runtime are indexed", async () => {
    const { chain, addresses, store, source } = await setup(2, 50);
    const late = fakeAddress(99);
    chain.grow([late], 30);
    const indexer = new Indexer({ store, source, detect: "poll" });
    await indexer.syncOnce();
    await store.addAddress(late, { startLt: chain.txs(late)[19]!.lt });
    await indexer.syncOnce();
    const stored = await store.read(late, 0n, 1n << 62n, 100);
    expect(stored.map((t) => t.lt)).toEqual(
      chain
        .txs(late)
        .slice(20)
        .map((t) => t.lt),
    );
    expect((await store.getAddress(late))?.frontier?.lt).toBe(chain.txs(late).at(-1)!.lt);
    await expectComplete(store, chain, addresses);
  });

  test("synced point advances for idle addresses (watermark input)", async () => {
    const { chain, addresses, store, source } = await setup(3, 10);
    const indexer = new Indexer({ store, source, detect: "poll", maxIdlePollMs: 0 });
    await indexer.syncOnce();
    const before = (await store.getAddress(addresses[0]!))!.syncedLt;
    expect(before).toBe(chain.tip().syncLt);
    chain.grow([addresses[1]!], 5); // address 0 stays idle
    await indexer.syncOnce();
    expect((await store.getAddress(addresses[0]!))!.syncedLt).toBe(chain.tip().syncLt);
  });
});

describe("long range splitting", () => {
  test("splits one long chain into parallel pieces, without refetching", async () => {
    const run = async (split: boolean) => {
      const { chain, addresses, store, source } = await setup(1, 4000, {
        faults: { seed: 3, latencyMs: [2, 4] },
      });
      const indexer = new Indexer({
        store,
        source,
        concurrency: 16,
        detect: "poll",
        split: split ? { minTxs: 400, targetTxs: 200, maxParts: 16 } : false,
      });
      const t = performance.now();
      await indexer.syncOnce();
      const ms = performance.now() - t;
      await expectComplete(store, chain, addresses);
      return {
        ms,
        pages: source.calls.getTransactions!,
        splits: indexer.metrics.get("ton_watch_split_points_total"),
      };
    };
    const serial = await run(false);
    const parallel = await run(true);
    expect(serial.splits).toBe(0);
    expect(parallel.splits).toBeGreaterThan(8);
    // Each piece ends exactly where the next begins: ≤ 1 extra page per piece.
    expect(parallel.pages).toBeLessThanOrEqual(serial.pages + parallel.splits + 1);
    expect(parallel.ms).toBeLessThan(serial.ms / 3);
  });

  test("a split that finds nothing leaves the walk intact", async () => {
    const { chain, addresses, store, source } = await setup(1, 1000, {
      faults: { noFindTxNear: true },
    });
    const indexer = new Indexer({
      store,
      source,
      detect: "poll",
      split: { minTxs: 100, targetTxs: 50 },
    });
    await indexer.syncOnce();
    await expectComplete(store, chain, addresses);
  });
});

describe("change detection cost", () => {
  test("poll mode backs off idle addresses", async () => {
    const { chain, store, source } = await setup(50, 2);
    const indexer = new Indexer({
      store,
      source,
      detect: "poll",
      tickMs: 100,
      maxIdlePollMs: 3_200,
    });
    await indexer.syncOnce();
    const base = source.calls.getLastTx!;
    // 30 ticks, 100ms apart, chain moving but our addresses idle.
    for (let i = 0; i < 30; i++) {
      chain.grow([fakeAddress(1000)], 1);
      await indexer.tick();
      await new Promise((r) => setTimeout(r, 100));
    }
    const polls = source.calls.getLastTx! - base;
    // Without backoff: 50 × 30 = 1500.
    expect(polls).toBeLessThan(400);
  });

  test("blocks mode costs the same for 10 or 500 idle addresses", async () => {
    const cost = async (n: number) => {
      const { chain, store, source } = await setup(n, 1);
      const indexer = new Indexer({ store, source, detect: "blocks" });
      await indexer.syncOnce();
      const base = source.totalCalls;
      for (let i = 0; i < 20; i++) {
        chain.grow([fakeAddress(100_000)], 1);
        await indexer.tick();
      }
      return source.totalCalls - base;
    };
    const small = await cost(10);
    const large = await cost(500);
    expect(large).toBe(small);
    expect(large).toBe(40); // getTip + getTouchedAccounts per tick
  });

  test("blocks mode matches addresses stored in uppercase hex", async () => {
    const { chain, store, source } = await setup(0, 0);
    const upper = fakeAddress(0xabcdef).toUpperCase();
    const lower = upper.toLowerCase();
    chain.grow([lower], 3);
    await store.addAddress(upper, { startLt: chain.tip().syncLt });
    const indexer = new Indexer({ store, source, detect: "blocks" });
    await indexer.syncOnce();
    chain.grow([lower], 5);
    await indexer.syncOnce();
    expect((await store.read(upper, 0n, 1n << 62n, 100)).length).toBe(5);
  });

  test("blocks mode reconciles: a transaction the listing missed is still found", async () => {
    const { chain, addresses, store, source } = await setup(3, 2);
    const indexer = new Indexer({ store, source, detect: "blocks", reconcileMs: 1 });
    await indexer.syncOnce();
    source.faults = { hideFromListing: new Set([addresses[0]!]) };
    chain.grow(addresses, 4);
    await new Promise((r) => setTimeout(r, 5));
    await indexer.syncOnce();
    await expectComplete(store, chain, addresses);
    expect(indexer.metrics.get("ton_watch_reconcile_misses_total")).toBeGreaterThan(0);
  });

  test("blocks mode falls back to polling when listing is unavailable", async () => {
    const { chain, addresses, store, source } = await setup(3, 5);
    const indexer = new Indexer({ store, source, detect: "blocks" });
    await indexer.syncOnce();
    source.faults = { noBlockListing: true };
    chain.grow(addresses, 7);
    await indexer.syncOnce();
    await expectComplete(store, chain, addresses);
    expect(indexer.metrics.get("ton_watch_detect_fallbacks_total")).toBeGreaterThan(0);
  });
});
