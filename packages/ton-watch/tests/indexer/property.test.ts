/**
 * Randomized tests of the indexer: random chains, address sets, start points,
 * leftovers of earlier runs, source faults, concurrency/split/detection settings,
 * a chain that grows while indexing, crashes and restarts, and a model check of
 * the store's derived state. Each test's seed is in its name.
 */

import { describe, expect, test } from "bun:test";

import { analyzeChain } from "../../src/core/chain";
import type { TxRecord } from "../../src/core/types";
import { Indexer } from "../../src/indexer/indexer";
import type { DetectMode } from "../../src/indexer/options";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import type { Store } from "../../src/stores/store";
import { FakeChain, FakeSource, fakeAddress, rng } from "../fixtures/fake-chain";
import {
  chance,
  expectStoreMatchesChain,
  growRandom,
  InvariantMonitor,
  inScope,
  int,
  LT_MAX,
  newPgStore,
  pick,
  type Rng,
  randomFaults,
  randomStartLt,
  seeds,
  shuffle,
  sleep,
} from "../fixtures/property-helpers";

const addressesFor = (r: Rng, max: number) =>
  shuffle(
    r,
    Array.from({ length: 64 }, (_, i) => fakeAddress(i * 31 + 5)),
  ).slice(0, int(r, 1, max));

/** Random indexer settings; retries kept short so tests stay fast. */
function randomIndexer(r: Rng, store: Store, source: FakeSource, detect?: DetectMode) {
  return new Indexer({
    store,
    source,
    concurrency: pick(r, [1, 2, 3, 5, 8, 16]),
    detect: detect ?? pick(r, ["poll", "blocks", "auto"] as const),
    autoBlocksThreshold: int(r, 1, 6),
    maxIdlePollMs: 0,
    tickMs: int(r, 1, 8),
    retryMinMs: 1,
    retryMaxMs: 4,
    archiveRetryMs: 1,
    split: chance(r, 0.3)
      ? false
      : { minTxs: int(r, 10, 60), targetTxs: int(r, 4, 20), maxParts: int(r, 2, 8) },
  });
}

/**
 * Writes random pieces of each address's chain, as a crashed earlier run would
 * have left them (also below startLt, which the store must ignore).
 */
async function writeLeftovers(r: Rng, store: Store, chain: FakeChain, addresses: string[]) {
  for (const a of addresses) {
    const txs = chain.txs(a);
    if (txs.length === 0 || chance(r, 0.4)) continue;
    for (let i = int(r, 1, 6); i > 0; i--) {
      const start = int(r, 0, txs.length - 1);
      await store.write(a, txs.slice(start, start + int(r, 1, 20)));
    }
    if (chance(r, 0.5)) await store.advanceFrontier(a);
  }
}

async function randomSetup(r: Rng, store: Store, maxAddresses: number, maxTxs: number) {
  const chain = new FakeChain();
  const addresses = addressesFor(r, maxAddresses);
  growRandom(chain, r, addresses, int(r, 0, maxTxs));
  await store.migrate();
  const startLts = new Map<string, bigint>();
  for (const a of addresses) {
    const startLt = randomStartLt(r, chain, a);
    startLts.set(a, startLt);
    await store.addAddress(a, { startLt });
  }
  return { chain, addresses, startLts };
}

describe("indexer property: one-shot sync converges", () => {
  for (const seed of seeds(1, 40)) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      const store = new MemoryStore();
      const { chain, addresses, startLts } = await randomSetup(r, store, 6, 400);
      await writeLeftovers(r, store, chain, addresses);
      const source = new FakeSource(chain, randomFaults(r, seed));
      const indexer = randomIndexer(r, store, source);

      await indexer.syncOnce();

      await expectStoreMatchesChain(store, chain, startLts, `seed ${seed}`);
      const tip = chain.tip();
      for (const a of addresses) {
        // Chain was static: every successful observation was at this tip.
        expect((await store.getAddress(a))?.syncedLt).toBe(tip.syncLt);
      }
      expect(indexer.status().every((s) => s.walks === 0)).toBe(true);
    });
  }
});

describe("indexer property: chain grows while the indexer runs", () => {
  for (const seed of seeds(1001, 14)) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      const store = new MemoryStore();
      const { chain, addresses, startLts } = await randomSetup(r, store, 5, 200);
      const faults = randomFaults(r, seed);
      const source = new FakeSource(chain, faults);
      const indexer = randomIndexer(r, store, source, pick(r, ["poll", "blocks"] as const));
      const monitor = new InvariantMonitor(store, chain, startLts).start();
      const frontierEvents = new Map<string, bigint>();
      const regressions: string[] = [];
      indexer.on("frontier", (address, lt) => {
        const prev = frontierEvents.get(address);
        if (prev !== undefined && lt < prev) regressions.push(`${address}: ${prev} -> ${lt}`);
        frontierEvents.set(address, lt);
      });

      indexer.start();
      for (let burst = int(r, 3, 8); burst > 0; burst--) {
        growRandom(chain, r, addresses, int(r, 1, 60));
        await sleep(int(r, 0, 12));
      }
      await sleep(10);
      await indexer.stop();
      // Whatever the running indexer did not finish, a sync pass on the same store
      // completes; the invariants held throughout. (A fresh indexer: reusing this one
      // can stop short, see the `test.failing` below.)
      const final = new Indexer({ store, source: new FakeSource(chain), detect: "poll" });
      await final.syncOnce();
      expect(await monitor.stop()).toEqual([]);
      expect(regressions).toEqual([]);
      expect(monitor.samples).toBeGreaterThan(1);
      await expectStoreMatchesChain(store, chain, startLts, `seed ${seed}`);
    });
  }
});

/**
 * BUG (found by the test above, seed 96029): when detection fails at a tip (a
 * getLastTx poll or the block listing throws), the address's observation stays at
 * an older tip, but `ChangeDetector.detect` still records the new tip as detected.
 * Ticks at the same masterchain seqno then re-poll only never-observed addresses
 * (src/indexer/change-detector.ts, the `tip.seqno === lastDetectedTip.seqno`
 * branch), and `Indexer.syncOnce` exits on `!anyUnobserved()`, so it returns with
 * the address incomplete although the source is healthy again. A running indexer
 * recovers only when the next block arrives.
 */
describe("indexer: detection failure at the current tip", () => {
  for (const detect of ["poll", "blocks"] as const) {
    test.failing(`${detect}: syncOnce catches up once the source recovers`, async () => {
      const chain = new FakeChain();
      const a = fakeAddress(1);
      chain.grow([a], 5);
      const store = new MemoryStore();
      await store.addAddress(a, { startLt: 0n });
      const source = new FakeSource(chain);
      const indexer = new Indexer({ store, source, detect, maxIdlePollMs: 0 });
      await indexer.syncOnce();

      chain.grow([a], 5);
      source.faults = { rateLimit: 1 };
      const getTip = source.getTip.bind(source);
      source.getTip = async () => chain.tip(); // only detection calls fail
      await indexer.tick();
      source.getTip = getTip;
      source.faults = {};

      await indexer.syncOnce();
      expect((await store.read(a, 0n, LT_MAX, 100)).length).toBe(10);
    });
  }
});

describe("indexer property: crash and restart mid-sync", () => {
  const run = async (seed: number, store: Store, restarts: number) => {
    const r = rng(seed);
    const { chain, addresses, startLts } = await randomSetup(r, store, 4, 300);
    const monitor = new InvariantMonitor(store, chain, startLts).start();
    for (let i = 0; i < restarts; i++) {
      // Sometimes two processes overlap on the same store.
      const count = chance(r, 0.25) ? 2 : 1;
      const indexers = Array.from({ length: count }, (_, k) =>
        randomIndexer(r, store, new FakeSource(chain, randomFaults(r, seed + i * 10 + k))),
      );
      for (const indexer of indexers) indexer.start();
      if (chance(r, 0.5)) growRandom(chain, r, addresses, int(r, 1, 40));
      await sleep(int(r, 0, 15));
      // A crash: stopped at a random point, its in-memory walks lost.
      await Promise.all(indexers.map((indexer) => indexer.stop()));
      if (chance(r, 0.3)) await monitor.check();
    }
    const final = new Indexer({ store, source: new FakeSource(chain), detect: "poll" });
    await final.syncOnce();
    expect(await monitor.stop()).toEqual([]);
    await expectStoreMatchesChain(store, chain, startLts, `seed ${seed}`);
  };

  for (const seed of seeds(2001, 10)) {
    test(`MemoryStore seed ${seed}`, () => run(seed, new MemoryStore(), 6));
  }
  for (const seed of seeds(2501, 3)) {
    test(`PgStore seed ${seed}`, async () => run(seed, await newPgStore(), 4), 20_000);
  }
});

describe("indexer property: addresses added at runtime", () => {
  for (const seed of seeds(3001, 8)) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      const store = new MemoryStore();
      const { chain, addresses, startLts } = await randomSetup(r, store, 3, 150);
      const late = Array.from({ length: int(r, 1, 3) }, (_, i) => fakeAddress(10_000 + i));
      growRandom(chain, r, [...addresses, ...late], int(r, 10, 150));
      const indexer = randomIndexer(r, store, new FakeSource(chain, randomFaults(r, seed)));
      indexer.start();
      for (const a of late) {
        await sleep(int(r, 0, 10));
        growRandom(chain, r, [...addresses, ...late], int(r, 0, 30));
        const startLt = randomStartLt(r, chain, a);
        startLts.set(a, startLt);
        await store.addAddress(a, { startLt });
      }
      await sleep(int(r, 0, 10));
      await indexer.stop();
      const final = new Indexer({ store, source: new FakeSource(chain), detect: "poll" });
      await final.syncOnce();
      await expectStoreMatchesChain(store, chain, startLts, `seed ${seed}`);
    });
  }
});

/**
 * The indexer derives everything from `findGaps` / `advanceFrontier`. Both stores are
 * checked against `analyzeChain` over the stored set after random idempotent writes
 * in random order, plus range reads against a direct filter.
 */
describe("indexer property: store derived state matches the chain model", () => {
  const run = async (seed: number, store: Store) => {
    const r = rng(seed);
    const { chain, addresses, startLts } = await randomSetup(r, store, 3, 150);
    const written = new Map<string, Map<bigint, TxRecord>>();
    for (const a of addresses) written.set(a, new Map());
    const lastFrontier = new Map<string, bigint>();
    for (let step = 0; step < 40; step++) {
      const a = pick(r, addresses);
      const txs = chain.txs(a);
      const startLt = startLts.get(a)!;
      if (txs.length > 0) {
        const from = int(r, 0, txs.length - 1);
        const chunk = shuffle(r, txs.slice(from, from + int(r, 1, 12)));
        const inserted = await store.write(a, chunk);
        const mine = written.get(a)!;
        let expectedNew = 0;
        for (const t of chunk) {
          if (t.lt <= startLt || mine.has(t.lt)) continue;
          mine.set(t.lt, t);
          expectedNew++;
        }
        expect(inserted).toBe(expectedNew);
      }
      if (chance(r, 0.6)) {
        const ascending = [...written.get(a)!.values()].sort((x, y) => (x.lt < y.lt ? -1 : 1));
        const model = analyzeChain(a, ascending, startLt);
        const frontier = await store.advanceFrontier(a);
        expect(frontier?.lt ?? null).toBe(model.frontier?.lt ?? null);
        expect(frontier ? frontier.hash.equals(model.frontier!.hash) : true).toBe(true);
        const prev = lastFrontier.get(a);
        if (prev !== undefined) expect((frontier?.lt ?? 0n) >= prev).toBe(true);
        if (frontier) lastFrontier.set(a, frontier.lt);
        const gaps = await store.findGaps(a);
        const project = (g: { aboveLt: bigint; prevLt: bigint; floorLt: bigint }) => ({
          aboveLt: g.aboveLt,
          prevLt: g.prevLt,
          floorLt: g.floorLt,
        });
        expect(gaps.map(project)).toEqual(model.gaps.map(project));
        // The frontier is exactly the chain's longest stored prefix.
        const prefix = inScope(chain, a, startLt);
        let k = 0;
        while (k < prefix.length && written.get(a)!.has(prefix[k]!.lt)) k++;
        expect(frontier?.lt ?? null).toBe(k > 0 ? prefix[k - 1]!.lt : null);
      }
      if (chance(r, 0.3)) {
        const all = [...written.get(a)!.values()].sort((x, y) => (x.lt < y.lt ? -1 : 1));
        const after = all.length && chance(r, 0.7) ? pick(r, all).lt : 0n;
        const upto = all.length && chance(r, 0.7) ? pick(r, all).lt : LT_MAX;
        const limit = int(r, 1, 30);
        const got = await store.read(a, after, upto, limit);
        const want = all.filter((t) => t.lt > after && t.lt <= upto).slice(0, limit);
        expect(got.map((t) => t.lt)).toEqual(want.map((t) => t.lt));
      }
    }
  };
  for (const seed of seeds(4001, 15)) {
    test(`MemoryStore seed ${seed}`, () => run(seed, new MemoryStore()));
  }
  for (const seed of seeds(4501, 3)) {
    test(`PgStore seed ${seed}`, async () => run(seed, await newPgStore()), 20_000);
  }
});
