/**
 * A consumer's lifecycle and what keeps one name from delivering twice: losing the
 * lock ends the round at once, a cursor moved elsewhere rolls the delivery back,
 * `start()` / `stop()` in any interleaving run one loop and release each lock once,
 * and a `pg` pool too small for the consumers' lock connections fails at start.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Pool } from "pg";

import { Consumer } from "../../src/consumer/consumer";
import { CursorConflictError } from "../../src/consumer/errors";
import type { ProcessOptions, TxHandler } from "../../src/consumer/types";
import type { IndexedTx } from "../../src/core/types";
import type { ConsumerLock, ConsumerOrder } from "../../src/stores/consumer-state";
import type { PgDatabase } from "../../src/stores/pg/database";
import { PgStore } from "../../src/stores/pg/pg-store";
import type { Store } from "../../src/stores/store";
import { sleep } from "../../src/util/async";
import { FakeChain, fakeAddress } from "../fixtures/fake-chain";
import { cleanUpStoreTargets, pgDatabaseOf, storeTargets } from "../fixtures/store-targets";

const A = fakeAddress(1);
const B = fakeAddress(2);
const FAST: ProcessOptions = { pollMs: 2, retryMinMs: 0, retryMaxMs: 0 };

afterAll(cleanUpStoreTargets);

async function indexed(store: Store, perAddress = 10) {
  const chain = new FakeChain();
  chain.grow([A, B], perAddress, 2);
  for (const address of [A, B]) {
    await store.addAddress(address, { startLt: 0n });
    await store.write(address, chain.txs(address));
    await store.advanceFrontier(address);
  }
  return chain;
}

const until = async (condition: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(2);
  }
};

const key = (tx: { lt: bigint; address: string }) => `${tx.address}:${tx.lt}`;

/** A promise to resolve from outside. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** A lock as the consumer sees it, which the test can make lose its connection. */
interface TrackedLock {
  lost: boolean;
  releases: number;
}

/**
 * Wraps `store.lockConsumer` so every lock taken is recorded and can be "lost"
 * (`held` turns false as when its connection breaks), and an optional gate delays
 * each attempt.
 */
function trackLocks(store: Store) {
  const take = store.lockConsumer!.bind(store);
  const locks: TrackedLock[] = [];
  let outstanding = 0;
  let maxOutstanding = 0;
  const tracker = {
    locks,
    /** Most locks held at once. */
    get maxOutstanding() {
      return maxOutstanding;
    },
    /** Awaited before each attempt. */
    beforeAttempt: async () => {},
    loseCurrent() {
      const current = locks.at(-1);
      if (current) current.lost = true;
    },
  };
  spyOn(store, "lockConsumer").mockImplementation(async (name: string) => {
    await tracker.beforeAttempt();
    const inner = await take(name);
    if (!inner) return null;
    const tracked: TrackedLock = { lost: false, releases: 0 };
    locks.push(tracked);
    maxOutstanding = Math.max(maxOutstanding, ++outstanding);
    const lock: ConsumerLock = {
      get held() {
        return !tracked.lost && inner.held;
      },
      async release() {
        tracked.releases++;
        if (tracked.releases === 1) outstanding--;
        await inner.release();
      },
    };
    return lock;
  });
  return tracker;
}

for (const target of storeTargets) {
  describe(`${target.name}: a lost lock`, () => {
    for (const order of ["address", "global"] as ConsumerOrder[]) {
      test(`${order} order: the round ends right after the transaction being handled`, async () => {
        const store = await target.make();
        await indexed(store);
        // Global order delivers only up to the watermark: count what a full run delivers.
        const total = await new Consumer("reference", store, () => {}, {
          ...FAST,
          order,
        }).runOnce();
        const locks = trackLocks(store);
        const delivered: IndexedTx[] = [];
        const handler: TxHandler = (tx) => {
          delivered.push(tx);
          if (delivered.length === 3) locks.loseCurrent();
        };
        // batchSize 2: global order refills its buffers, which must not outlive the lock.
        const options = { ...FAST, order, concurrency: 1, batchSize: 2 };
        const consumer = new Consumer("lost", store, handler, options);
        expect(await consumer.runOnce()).toBe(3);
        expect(delivered.length).toBe(3);
        expect(locks.locks[0]!.releases).toBe(1);

        // Started, it re-takes the lock and goes on from the stored cursors.
        consumer.start();
        await consumer.ready();
        await until(() => delivered.length === total);
        await consumer.stop();
        expect(new Set(delivered.map(key)).size).toBe(total);
        expect(locks.locks.every((lock) => lock.releases === 1)).toBe(true);
      });
    }
  });

  describe(`${target.name}: a cursor moved elsewhere`, () => {
    test("rolls back the delivery, ends the round, and the next round resumes from it", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const txs = chain.txs(A);
      const delivered: IndexedTx[] = [];
      let movedElsewhere = false;
      const handler: TxHandler = async (tx) => {
        delivered.push(tx);
        if (tx.lt === txs[2]!.lt && !movedElsewhere) {
          // Another instance (that took the lock this one has not noticed losing)
          // delivered up to txs[5] meanwhile.
          movedElsewhere = true;
          await store.setCursor("cas", A, txs[5]!.lt);
        }
      };
      const consumer = new Consumer("cas", store, handler, {
        ...FAST,
        concurrency: 1,
        // PGlite has one connection: the handler cannot write outside the delivery's transaction.
        transactional: !target.singleSession,
      });
      const conflict = await consumer.runOnce().catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(CursorConflictError);
      expect(conflict).toMatchObject({ consumer: "cas", address: A, expected: txs[1]!.lt });
      expect(await store.getCursor("cas", A)).toBe(txs[5]!.lt);
      const ofA = () => delivered.filter((tx) => tx.address === A).map((tx) => tx.lt);
      expect(ofA()).toEqual(txs.slice(0, 3).map((tx) => tx.lt));

      await consumer.runOnce();
      // txs[2] again (its delivery was rolled back), then on from the moved cursor.
      expect(ofA()).toEqual([...txs.slice(0, 3), ...txs.slice(6)].map((tx) => tx.lt));
      expect(new Set(delivered.filter((tx) => tx.address === B).map(key)).size).toBe(10);
      expect(await store.getCursor("cas", A)).toBe(txs[9]!.lt);
    });
  });

  describe(`${target.name}: lifecycle`, () => {
    test("start() while stop() is finishing waits for it, then starts again", async () => {
      const store = await target.make();
      await indexed(store);
      const locks = trackLocks(store);
      const handling = gate();
      const finish = gate();
      const seen: string[] = [];
      let active = 0;
      let maxActive = 0;
      const handler: TxHandler = async (tx) => {
        maxActive = Math.max(maxActive, ++active);
        if (seen.length === 0) {
          handling.open();
          await finish.opened;
        }
        seen.push(key(tx));
        active--;
      };
      const consumer = new Consumer("ss", store, handler, { ...FAST, concurrency: 1 }).start();
      await consumer.ready();
      await handling.opened;

      let stopped = false;
      const stopping = consumer.stop().then(() => {
        stopped = true;
      });
      consumer.start();
      await sleep(10);
      expect(stopped).toBe(false); // still handling its transaction
      expect(consumer.status().running).toBe(false);
      expect(locks.locks.length).toBe(1);

      finish.open();
      await stopping;
      await consumer.ready();
      expect(consumer.status().running).toBe(true);
      await until(() => seen.length === 20);
      await consumer.stop();

      expect(consumer.status().running).toBe(false);
      expect(maxActive).toBe(1);
      expect(new Set(seen).size).toBe(20);
      expect(locks.locks.length).toBe(2);
      expect(locks.maxOutstanding).toBe(1);
      expect(locks.locks.map((lock) => lock.releases)).toEqual([1, 1]);
    });

    test("stop() while start() is taking the lock undoes the start", async () => {
      const store = await target.make();
      await indexed(store);
      const locks = trackLocks(store);
      const attempting = gate();
      const attempt = gate();
      locks.beforeAttempt = () => {
        attempting.open();
        return attempt.opened;
      };
      const seen: string[] = [];
      const consumer = new Consumer("su", store, (tx) => void seen.push(key(tx)), FAST);
      consumer.start();
      await attempting.opened;
      const stopping = consumer.stop();
      attempt.open();
      await stopping;
      await consumer.ready();
      expect(consumer.status().running).toBe(false);
      expect(seen).toEqual([]);
      expect(locks.locks.map((lock) => lock.releases)).toEqual([1]);
      // Free for the next instance.
      expect(await new Consumer("su", store, () => {}, FAST).runOnce()).toBe(20);
    });

    test("any interleaving of start() and stop() runs one loop and ends as the last call says", async () => {
      const store = await target.make();
      await indexed(store, 30);
      const locks = trackLocks(store);
      let active = 0;
      let maxActive = 0;
      const seen = new Map<string, number>();
      const handler: TxHandler = async (tx) => {
        maxActive = Math.max(maxActive, ++active);
        await sleep(0);
        seen.set(key(tx), (seen.get(key(tx)) ?? 0) + 1);
        active--;
      };
      const consumer = new Consumer("il", store, handler, { ...FAST, concurrency: 1 });
      const stops: Promise<void>[] = [];
      for (let i = 0; i < 12; i++) {
        consumer.start();
        if (i % 3 === 0) await sleep(1);
        stops.push(consumer.stop());
        if (i % 4 === 0) await sleep(1);
      }
      consumer.start();
      await Promise.all(stops);
      await consumer.ready();
      expect(consumer.status().running).toBe(true);
      await until(() => seen.size === 60);
      await consumer.stop();

      expect(maxActive).toBe(1);
      expect([...seen.values()].every((count) => count === 1)).toBe(true);
      expect(locks.maxOutstanding).toBe(1);
      expect(locks.locks.every((lock) => lock.releases === 1)).toBe(true);
      const free = await store.lockConsumer!("il");
      expect(free).not.toBeNull();
      await free!.release();
    });
  });
}

describe("PgStore over a pg.Pool too small for its consumers", () => {
  test("start fails at once with a clear error instead of waiting forever", async () => {
    // Never connects: the check comes before the lock's connection is taken.
    const pool = new Pool({ max: 1 });
    try {
      const consumer = new Consumer("small", new PgStore(pool), () => {}, FAST).start();
      await expect(consumer.ready()).rejects.toThrow(/pg Pool too small.*Raise the pool's max/);
      expect(consumer.status().running).toBe(false);
      await consumer.stop();
    } finally {
      await pool.end();
    }
  });

  const url = process.env.TEST_DATABASE_URL;
  test.skipIf(!url)(
    "real Postgres: consumers deliver transactionally up to max - 1 of them",
    async () => {
      const pool = new Pool({ connectionString: url, max: 3 });
      const schema = `tw_small_${process.pid}`;
      const store = new PgStore(pool, { schema });
      try {
        await store.migrate();
        await indexed(store);
        const counts = new Map<string, number>();
        const make = (name: string) =>
          new Consumer(
            name,
            store,
            async (_tx, ctx) => {
              await (ctx.db as PgDatabase).query("select 1");
              counts.set(name, (counts.get(name) ?? 0) + 1);
            },
            { ...FAST, concurrency: 4 },
          );
        const one = make("one").start();
        const two = make("two").start();
        await Promise.all([one.ready(), two.ready()]);
        const three = make("three").start();
        await expect(three.ready()).rejects.toThrow("pg Pool too small");
        await until(() => counts.get("one") === 20 && counts.get("two") === 20);

        await two.stop();
        three.start();
        await three.ready();
        await until(() => counts.get("three") === 20);
        await Promise.all([one.stop(), three.stop()]);
      } finally {
        await pool.query(`drop schema if exists "${schema}" cascade`);
        await pool.end();
      }
    },
  );
});

describe("PgStore (postgres): a cursor moved elsewhere", () => {
  const target = storeTargets.find((t) => t.realPostgres);
  test.skipIf(!target)("the handler's ctx.db writes roll back with the delivery", async () => {
    const [store, other] = await target!.makePair();
    const chain = await indexed(store);
    const txs = chain.txs(A);
    const schema = (store as PgStore).schema;
    const db = pgDatabaseOf(store as PgStore);
    await db.query(`create table "${schema}".effects (lt bigint primary key)`);
    let movedElsewhere = false;
    const consumer = new Consumer(
      "cas-db",
      store,
      async (tx, ctx) => {
        await (ctx.db as PgDatabase).query(`insert into "${schema}".effects values ($1)`, [
          tx.lt.toString(),
        ]);
        if (tx.lt === txs[2]!.lt && !movedElsewhere) {
          movedElsewhere = true;
          await other.setCursor("cas-db", A, txs[5]!.lt);
        }
      },
      { ...FAST, concurrency: 1 },
    );
    await expect(consumer.runOnce()).rejects.toBeInstanceOf(CursorConflictError);
    const effects = async () =>
      (await db.query(`select lt::text from "${schema}".effects order by lt`)).rows.map((row) =>
        BigInt((row as { lt: string }).lt),
      );
    const ofA = new Set(txs.map((tx) => tx.lt));
    expect((await effects()).filter((lt) => ofA.has(lt))).toEqual([txs[0]!.lt, txs[1]!.lt]);
  });
});
