/**
 * Randomized tests of consumers: transactions are written in random chunks and
 * order while the chain grows, consumers run in random rounds, restart, use random
 * batch sizes / concurrency, and handlers fail at random. Checked on every delivery:
 * chain order (each delivered tx links to the previous one), never past the
 * frontier (per address) or the watermark (global), and, at the end, every
 * transaction exactly once with the cursor persisted. Each test's seed is in its name.
 */

import { describe, expect, test } from "bun:test";

import { Consumer } from "../../src/consumer/consumer";
import type { ProcessOptions } from "../../src/consumer/types";
import { completeUpTo, type IndexedTx, type TxRecord } from "../../src/core/types";
import { Indexer } from "../../src/indexer/indexer";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import type { PgStore } from "../../src/stores/pg/pg-store";
import type { Store } from "../../src/stores/store";
import { FakeChain, FakeSource, fakeAddress, rng } from "../fixtures/fake-chain";
import {
  byLtThenAddress,
  chance,
  growRandom,
  inScope,
  int,
  newPgStore,
  pick,
  type Rng,
  randomFaults,
  seeds,
  shuffle,
  sleep,
} from "../fixtures/property-helpers";

const key = (tx: TxRecord) => `${tx.address}/${tx.lt}`;

/**
 * Stands in for the indexer: reveals the chain to the store in random chunks and
 * order, advances frontiers, and marks addresses synced only when that is true.
 */
class FakeIndexing {
  readonly chain = new FakeChain();
  readonly startLts = new Map<string, bigint>();
  private readonly written = new Map<string, Set<bigint>>();

  constructor(
    private readonly r: Rng,
    readonly store: Store,
    readonly addresses: string[],
  ) {}

  async init() {
    await this.store.migrate();
    growRandom(this.chain, this.r, this.addresses, int(this.r, 0, 60));
    for (const a of this.addresses) {
      const txs = this.chain.txs(a);
      const startLt = txs.length && chance(this.r, 0.4) ? pick(this.r, txs).lt : 0n;
      this.startLts.set(a, startLt);
      this.written.set(a, new Set());
      await this.store.addAddress(a, { startLt });
    }
  }

  unwritten(a: string) {
    const done = this.written.get(a)!;
    return inScope(this.chain, a, this.startLts.get(a)!).filter((t) => !done.has(t.lt));
  }

  /** One random indexing step. */
  async step() {
    const r = this.r;
    const roll = r();
    if (roll < 0.25) {
      growRandom(this.chain, r, this.addresses, int(r, 1, 25));
    } else if (roll < 0.85) {
      const a = pick(r, this.addresses);
      const txs = this.unwritten(a);
      if (txs.length === 0) return;
      const start = int(r, 0, txs.length - 1);
      await this.write(a, shuffle(r, txs.slice(start, start + int(r, 1, 15))));
      if (chance(r, 0.7)) await this.store.advanceFrontier(a);
    } else {
      await this.markSynced();
    }
  }

  async write(a: string, txs: TxRecord[]) {
    await this.store.write(a, txs);
    for (const t of txs) this.written.get(a)!.add(t.lt);
  }

  /** Writes everything, advances every frontier and marks all synced at the tip. */
  async finish() {
    for (const a of this.addresses) {
      await this.write(a, this.unwritten(a));
      await this.store.advanceFrontier(a);
    }
    await this.markSynced();
  }

  private async markSynced() {
    // Sound: only addresses with nothing missing up to the tip.
    const complete = this.addresses.filter((a) => this.unwritten(a).length === 0);
    for (const a of complete) await this.store.advanceFrontier(a);
    const tip = this.chain.tip();
    await this.store.markSynced(complete, tip.syncLt, tip.utime);
  }

  expected(a: string) {
    return inScope(this.chain, a, this.startLts.get(a)!);
  }

  expectedGlobal() {
    return this.addresses.flatMap((a) => this.expected(a)).sort(byLtThenAddress);
  }
}

/**
 * Records deliveries and checks the per-delivery invariants. The checks read the
 * store, so consumers using it run with `transactional: false`: inside a PGlite
 * transaction, a query on the outer connection would wait for it forever.
 */
class DeliveryLog {
  readonly delivered: TxRecord[] = [];
  readonly perAddress = new Map<string, TxRecord[]>();
  readonly counts = new Map<string, number>();
  readonly violations: string[] = [];
  failP = 0;

  constructor(
    private readonly r: Rng,
    private readonly store: Store,
    private readonly startLts: Map<string, bigint>,
    private readonly order: "address" | "global",
    private readonly from: ProcessOptions["from"] = "start",
  ) {}

  handler = async (tx: IndexedTx) => {
    if (chance(this.r, this.failP)) throw new Error("handler failed");
    const states = await this.store.listAddresses();
    const state = states.find((s) => s.address === tx.address)!;
    if (this.order === "address") {
      if (!state.frontier || tx.lt > state.frontier.lt) this.fail(`${key(tx)} past the frontier`);
    } else {
      const watermark = states.map(completeUpTo).reduce((m, lt) => (lt < m ? lt : m));
      if (tx.lt > watermark) this.fail(`${key(tx)} past the watermark ${watermark}`);
      const last = this.delivered.at(-1);
      if (last && byLtThenAddress(last, tx) >= 0) this.fail(`${key(tx)} after ${key(last)}`);
    }
    const mine = this.perAddress.get(tx.address) ?? [];
    const prev = mine.at(-1);
    if (prev) {
      if (tx.prevLt !== prev.lt || !tx.prevHash.equals(prev.hash)) {
        this.fail(`${key(tx)} does not follow ${key(prev)}`);
      }
    } else if (this.from === "start" && tx.prevLt > this.startLts.get(tx.address)!) {
      this.fail(`${key(tx)} is not the first transaction in scope`);
    }
    mine.push(tx);
    this.perAddress.set(tx.address, mine);
    this.delivered.push(tx);
    this.counts.set(key(tx), (this.counts.get(key(tx)) ?? 0) + 1);
  };

  private fail(message: string) {
    if (this.violations.length < 20) this.violations.push(message);
  }
}

const randomConsumer = (
  r: Rng,
  name: string,
  store: Store,
  log: DeliveryLog,
  options: ProcessOptions,
) =>
  new Consumer(name, store, log.handler, {
    batchSize: pick(r, [1, 2, 3, 7, 16, 100]),
    concurrency: int(r, 1, 4),
    retryMinMs: 0,
    retryMaxMs: 0,
    transactional: false,
    ...options,
  });

async function drain(consumer: Consumer) {
  for (let i = 0; i < 10_000; i++) if ((await consumer.runOnce()) === 0) return;
  throw new Error("consumer did not drain");
}

const addressSet = (r: Rng) =>
  Array.from({ length: int(r, 1, 4) }, (_, i) => fakeAddress(0x100 + i * 17));

/** Random indexing interleaved with consumer rounds, restarts and handler failures. */
async function runRandomized(seed: number, store: Store, order: "address" | "global") {
  const r = rng(seed);
  const indexing = new FakeIndexing(r, store, addressSet(r));
  await indexing.init();
  const log = new DeliveryLog(r, store, indexing.startLts, order);
  const name = `c${seed}`;
  const newConsumer = () => randomConsumer(r, name, store, log, { order });
  let consumer = newConsumer();
  for (let step = 0; step < 60; step++) {
    log.failP = pick(r, [0, 0, 0.05, 0.3]);
    const roll = r();
    if (roll < 0.55) await indexing.step();
    else if (roll < 0.9) await consumer.runOnce();
    else consumer = newConsumer(); // restart: in-memory state lost
  }
  await indexing.finish();
  log.failP = 0;
  await drain(newConsumer());

  expect(log.violations).toEqual([]);
  if (order === "global") {
    expect(log.delivered.map(key)).toEqual(indexing.expectedGlobal().map(key));
  }
  for (const a of indexing.addresses) {
    const expected = indexing.expected(a);
    expect((log.perAddress.get(a) ?? []).map(key)).toEqual(expected.map(key));
    const cursor = await store.getCursor(name, a);
    expect(cursor).toBe(expected.at(-1)?.lt ?? indexing.startLts.get(a)!);
  }
  expect([...log.counts.values()].every((n) => n === 1)).toBe(true);
}

describe("consumer property: per-address order", () => {
  for (const seed of seeds(11, 30)) {
    test(`MemoryStore seed ${seed}`, () => runRandomized(seed, new MemoryStore(), "address"));
  }
  for (const seed of seeds(511, 3)) {
    test(`PgStore seed ${seed}`, async () => runRandomized(seed, await newPgStore(), "address"));
  }
});

describe("consumer property: global order", () => {
  for (const seed of seeds(21, 30)) {
    test(`MemoryStore seed ${seed}`, () => runRandomized(seed, new MemoryStore(), "global"));
  }
  for (const seed of seeds(521, 3)) {
    test(`PgStore seed ${seed}`, async () => runRandomized(seed, await newPgStore(), "global"));
  }
});

describe("consumer property: `from` an lt", () => {
  for (const seed of seeds(31, 10)) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      const store = new MemoryStore();
      const indexing = new FakeIndexing(r, store, addressSet(r));
      await indexing.init();
      growRandom(indexing.chain, r, indexing.addresses, int(r, 1, 80));
      const all = indexing.addresses.flatMap((a) => indexing.chain.txs(a));
      const from = all.length && chance(r, 0.8) ? pick(r, all).lt : 0n;
      const log = new DeliveryLog(r, store, indexing.startLts, "address", from);
      for (let i = 0; i < 20; i++) {
        await indexing.step();
        await randomConsumer(r, "f", store, log, { from }).runOnce();
      }
      await indexing.finish();
      await drain(randomConsumer(r, "f", store, log, { from }));
      expect(log.violations).toEqual([]);
      for (const a of indexing.addresses) {
        const expected = indexing.expected(a).filter((t) => t.lt > from);
        expect((log.perAddress.get(a) ?? []).map(key)).toEqual(expected.map(key));
      }
    });
  }
});

describe("consumer property: Postgres effects commit with the cursor", () => {
  /**
   * The handler writes an effect row through `ctx.db`, then fails at random (before
   * or after its write) and the consumer restarts at random: every transaction's
   * effect is committed exactly once.
   */
  for (const seed of seeds(41, 3)) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      const store: PgStore = await newPgStore();
      const indexing = new FakeIndexing(r, store, addressSet(r));
      await indexing.init();
      await store.db.query(`create table effects (address text, lt bigint)`);
      const order = pick(r, ["address", "global"] as const);
      let failP = 0.25;
      const handler = async (tx: IndexedTx, ctx: { db?: unknown }) => {
        const db = ctx.db as PgStore["db"];
        if (chance(r, failP / 2)) throw new Error("before effect");
        await db.query(`insert into effects values ($1, $2)`, [tx.address, tx.lt.toString()]);
        if (chance(r, failP / 2)) throw new Error("after effect");
      };
      const make = () =>
        new Consumer("fx", store, handler, {
          order,
          batchSize: int(r, 1, 10),
          retryMinMs: 0,
          retryMaxMs: 0,
        });
      let consumer = make();
      for (let step = 0; step < 40; step++) {
        if (chance(r, 0.5)) await indexing.step();
        else if (chance(r, 0.85)) await consumer.runOnce();
        else consumer = make();
      }
      await indexing.finish();
      failP = 0;
      await drain(make());
      const { rows } = await store.db.query(
        `select count(*)::int as n, count(distinct (address, lt))::int as d from effects`,
      );
      const total = indexing.addresses.reduce((n, a) => n + indexing.expected(a).length, 0);
      expect(rows[0]).toEqual({ n: total, d: total });
    });
  }
});

/**
 * A store whose cursor writes fail at random: a handler that succeeded may run
 * again (at-least-once), but only for the same transaction, never skipping and
 * never going back further.
 */
describe("consumer property: failing cursor writes give at-least-once, in order", () => {
  const flaky = (store: Store, r: Rng, p: { value: number }): Store =>
    new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "setCursor") {
          return async (consumer: string, address: string, lt: bigint) => {
            if (chance(r, p.value)) throw new Error("cursor write failed");
            return target.setCursor(consumer, address, lt);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  for (const seed of seeds(51, 10)) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      const memory = new MemoryStore();
      const p = { value: 0.2 };
      const store = flaky(memory, r, p);
      const indexing = new FakeIndexing(r, memory, addressSet(r));
      await indexing.init();
      await indexing.finish();
      const order = pick(r, ["address", "global"] as const);
      const seen = new Map<string, TxRecord[]>();
      const violations: string[] = [];
      const handler = (tx: IndexedTx) => {
        const mine = seen.get(tx.address) ?? [];
        const last = mine.at(-1);
        const repeat = last?.lt === tx.lt;
        const next = last ? tx.prevLt === last.lt : tx.prevLt <= indexing.startLts.get(tx.address)!;
        if (!repeat && !next) violations.push(`${key(tx)} after ${last && key(last)}`);
        mine.push(tx);
        seen.set(tx.address, mine);
      };
      const make = () =>
        new Consumer("al", store, handler, {
          order,
          batchSize: int(r, 1, 10),
          concurrency: int(r, 1, 3),
          retryMinMs: 0,
          retryMaxMs: 0,
          transactional: false,
        });
      let consumer = make();
      for (let step = 0; step < 60; step++) {
        if (chance(r, 0.1)) consumer = make();
        // A failed cursor write while loading a position fails the round.
        await consumer.runOnce().catch(() => {});
      }
      p.value = 0;
      await drain(make());
      expect(violations).toEqual([]);
      for (const a of indexing.addresses) {
        const unique = [...new Set((seen.get(a) ?? []).map((t) => t.lt))];
        expect(unique).toEqual(indexing.expected(a).map((t) => t.lt));
      }
    });
  }
});

/**
 * Everything together, running in the background: an indexer with a faulty source
 * on a growing chain, one per-address and one global consumer with failing handlers,
 * all stopped and restarted at random.
 */
describe("consumer property: end to end with a running indexer", () => {
  const run = async (seed: number, store: Store) => {
    const r = rng(seed);
    await store.migrate();
    const chain = new FakeChain();
    const addresses = addressSet(r);
    growRandom(chain, r, addresses, int(r, 0, 80));
    const startLts = new Map<string, bigint>();
    for (const a of addresses) {
      startLts.set(a, 0n);
      await store.addAddress(a, { startLt: 0n });
    }
    const logs = {
      address: new DeliveryLog(r, store, startLts, "address"),
      global: new DeliveryLog(r, store, startLts, "global"),
    };
    const newIndexer = () =>
      new Indexer({
        store,
        source: new FakeSource(chain, randomFaults(r, seed)),
        detect: pick(r, ["poll", "blocks"] as const),
        concurrency: int(r, 1, 8),
        tickMs: int(r, 1, 5),
        maxIdlePollMs: 0,
        retryMinMs: 1,
        retryMaxMs: 4,
      });
    const startConsumers = (indexer: Indexer) =>
      (["address", "global"] as const).map((order) =>
        new Consumer(
          `e2e-${order}`,
          store,
          logs[order].handler,
          {
            order,
            batchSize: int(r, 1, 20),
            pollMs: 5,
            retryMinMs: 1,
            retryMaxMs: 2,
            transactional: false,
          },
          { events: indexer },
        ).start(),
      );

    for (let run = int(r, 2, 4); run > 0; run--) {
      for (const log of Object.values(logs)) log.failP = pick(r, [0, 0.05, 0.2]);
      const indexer = newIndexer();
      indexer.start();
      const consumers = startConsumers(indexer);
      for (let burst = int(r, 1, 4); burst > 0; burst--) {
        growRandom(chain, r, addresses, int(r, 0, 30));
        await sleep(int(r, 2, 15));
      }
      await Promise.all([indexer.stop(), ...consumers.map((c) => c.stop())]);
    }

    // Catch up completely, then let fresh consumers drain.
    const final = new Indexer({ store, source: new FakeSource(chain), detect: "poll" });
    await final.syncOnce();
    for (const log of Object.values(logs)) log.failP = 0;
    for (const order of ["address", "global"] as const) {
      await drain(
        new Consumer(`e2e-${order}`, store, logs[order].handler, { order, transactional: false }),
      );
    }

    const expectedGlobal = addresses.flatMap((a) => inScope(chain, a, 0n)).sort(byLtThenAddress);
    for (const log of Object.values(logs)) {
      expect(log.violations).toEqual([]);
      expect([...log.counts.values()].every((n) => n === 1)).toBe(true);
      for (const a of addresses) {
        expect((log.perAddress.get(a) ?? []).map(key)).toEqual(inScope(chain, a, 0n).map(key));
      }
    }
    expect(logs.global.delivered.map(key)).toEqual(expectedGlobal.map(key));
  };

  for (const seed of seeds(61, 8)) {
    test(`MemoryStore seed ${seed}`, () => run(seed, new MemoryStore()));
  }
  for (const seed of seeds(661, 2)) {
    test(`PgStore seed ${seed}`, async () => run(seed, await newPgStore()), 20_000);
  }
});

/**
 * In "address" order, `from: "now"` is resolved the first round the consumer sees
 * an address, also before anything is indexed for it, so the first indexed
 * transactions are delivered — as in global order.
 */
describe("consumer: from 'now' on an address with nothing indexed yet", () => {
  test("delivers transactions indexed after the consumer started", async () => {
    const chain = new FakeChain();
    const a = fakeAddress(1);
    chain.grow([a], 3);
    const store = new MemoryStore();
    await store.addAddress(a, { startLt: chain.tip().syncLt }); // added "from now"
    const got: bigint[] = [];
    const consumer = new Consumer("n", store, (tx) => void got.push(tx.lt), { from: "now" });
    await consumer.runOnce(); // running, nothing indexed yet

    chain.grow([a], 2);
    await store.write(a, chain.txs(a).slice(-2));
    await store.advanceFrontier(a);
    await consumer.runOnce();
    expect(got).toEqual(
      chain
        .txs(a)
        .slice(-2)
        .map((t) => t.lt),
    );
  });
});

/**
 * Transient store errors while the consumer runs in the background (`start()`),
 * in global order: rounds fail and are retried, nothing is skipped or repeated.
 */
describe("consumer property: transient store errors in a running global consumer", () => {
  for (const seed of seeds(71, 6)) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      const memory = new MemoryStore();
      const indexing = new FakeIndexing(r, memory, addressSet(r));
      await indexing.init();
      await indexing.finish();
      const failing = new Set(["read", "listAddresses", "getCursor"]);
      let failP = 0.2;
      const store = new Proxy(memory, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          if (!failing.has(String(prop))) return value.bind(target);
          return async (...args: unknown[]) => {
            if (chance(r, failP)) throw new Error(`${String(prop)}: connection reset`);
            return value.apply(target, args);
          };
        },
      });
      const log = new DeliveryLog(r, memory, indexing.startLts, "global");
      const consumer = new Consumer("g", store, log.handler, {
        order: "global",
        batchSize: int(r, 1, 10),
        pollMs: 1,
        transactional: false,
      }).start();
      const total = indexing.expectedGlobal().length;
      for (let i = 0; i < 400 && log.delivered.length < total; i++) await sleep(2);
      failP = 0;
      await consumer.stop();
      expect(log.violations).toEqual([]);
      expect(log.delivered.map(key)).toEqual(indexing.expectedGlobal().map(key));
    });
  }
});

/**
 * In "address" order, a store error in one lane (here a failed `read`) fails the
 * round only after the other lanes' workers have stopped, so the next round never
 * delivers an address concurrently with the previous one.
 */
describe("consumer: a store error in one lane of a running per-address consumer", () => {
  test("does not deliver another lane's transactions twice", async () => {
    const chain = new FakeChain();
    const [a, b] = [fakeAddress(1), fakeAddress(2)];
    chain.grow([a, b], 10);
    const store = new MemoryStore();
    for (const x of [a, b]) {
      await store.addAddress(x, { startLt: 0n });
      await store.write(x, chain.txs(x));
      await store.advanceFrontier(x);
    }
    const read = store.read.bind(store);
    let failed = false;
    store.read = async (address, ...rest) => {
      if (address === b && !failed) {
        failed = true;
        throw new Error("connection reset");
      }
      return read(address, ...rest);
    };
    const counts = new Map<bigint, number>();
    const consumer = new Consumer(
      "c",
      store,
      async (tx) => {
        counts.set(tx.lt, (counts.get(tx.lt) ?? 0) + 1);
        await sleep(2); // a handler that takes a moment, e.g. one HTTP call
      },
      { concurrency: 2, pollMs: 1, transactional: false },
    ).start();
    for (let i = 0; i < 200 && counts.size < 20; i++) await sleep(5);
    await consumer.stop();
    expect(counts.size).toBe(20);
    expect([...counts.values()].filter((n) => n > 1)).toEqual([]);
  });
});
