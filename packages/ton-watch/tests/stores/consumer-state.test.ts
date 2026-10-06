/**
 * The `ConsumerStateStore` contract: cursors with failure state, consumer records,
 * dead letters, backlog and the single-instance lock, for every store.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import type { DeadLetter } from "../../src/stores/consumer-state";
import type { PgDatabase } from "../../src/stores/pg/database";
import { migrations } from "../../src/stores/pg/migrations";
import { PgStore } from "../../src/stores/pg/pg-store";
import type { Store } from "../../src/stores/store";
import { FakeChain, fakeAddress } from "../fixtures/fake-chain";
import { cleanUpStoreTargets, storeTargets } from "../fixtures/store-targets";

const A = fakeAddress(1);
const B = fakeAddress(2);

afterAll(cleanUpStoreTargets);

const letter = (overrides: Partial<DeadLetter> = {}): DeadLetter => ({
  consumer: "c",
  address: A,
  lt: 5n,
  hash: Buffer.alloc(32, 7),
  error: "boom",
  attempts: 3,
  firstFailureAt: new Date("2026-01-01T00:00:00Z"),
  lastFailureAt: new Date("2026-01-01T00:01:00Z"),
  ...overrides,
});

for (const target of storeTargets) {
  describe(`${target.name}: consumer state`, () => {
    let store: Store;
    let chain: FakeChain;

    beforeEach(async () => {
      store = await target.make();
      chain = new FakeChain();
      chain.grow([A, B], 10);
      for (const address of [A, B]) {
        await store.addAddress(address, { startLt: 0n });
        await store.write(address, chain.txs(address));
        await store.advanceFrontier(address);
      }
    });

    test("recordFailure counts attempts on a cursor; setCursor clears them", async () => {
      expect(await store.recordFailure("c", A, "no cursor yet")).toBeNull();
      await store.setCursor("c", A, 3n);
      const first = await store.recordFailure("c", A, "e1");
      const second = await store.recordFailure("c", A, "e2");
      expect(first?.attempts).toBe(1);
      expect(second).toMatchObject({ consumer: "c", address: A, lt: 3n, attempts: 2 });
      expect(second?.lastError).toBe("e2");
      expect(second?.firstFailureAt?.getTime()).toBe(first!.firstFailureAt!.getTime());
      expect(second!.lastFailureAt!.getTime()).toBeGreaterThanOrEqual(
        first!.lastFailureAt!.getTime(),
      );

      await store.setCursor("c", A, 4n);
      const [cursor] = await store.listCursors("c");
      expect(cursor).toMatchObject({ lt: 4n, attempts: 0, lastError: null, firstFailureAt: null });
      expect(cursor!.updatedAt).toBeInstanceOf(Date);
    });

    test("listCursors per consumer and for all, ordered", async () => {
      await store.setCursor("b", B, 2n);
      await store.setCursor("a", B, 1n);
      await store.setCursor("a", A, 1n);
      const all = await store.listCursors();
      expect(all.map((c) => `${c.consumer}:${c.address === A ? "A" : "B"}`)).toEqual([
        "a:A",
        "a:B",
        "b:B",
      ]);
      expect((await store.listCursors("b")).map((c) => c.lt)).toEqual([2n]);
    });

    test("consumers: records, order updates, cursor-only consumers, delete", async () => {
      await store.saveConsumer("x", "address");
      await store.saveConsumer("x", "global");
      await store.setCursor("x", A, 2n);
      await store.setCursor("legacy", A, 1n);
      await store.putDeadLetter(letter({ consumer: "x" }));
      const consumers = await store.listConsumers();
      expect(consumers.map((c) => [c.name, c.order, c.cursors.length])).toEqual([
        ["legacy", null, 1],
        ["x", "global", 1],
      ]);
      expect(consumers[0]!.createdAt).toBeNull();
      expect(consumers[1]!.createdAt).toBeInstanceOf(Date);

      await store.deleteConsumer("x");
      expect((await store.listConsumers()).map((c) => c.name)).toEqual(["legacy"]);
      expect(await store.getCursor("x", A)).toBeNull();
      expect(await store.listDeadLetters({ consumer: "x" })).toEqual([]);
    });

    test("dead letters: put replaces, list filters and orders, delete reports", async () => {
      await store.putDeadLetter(letter({ lt: 9n }));
      await store.putDeadLetter(letter({ lt: 5n }));
      await store.putDeadLetter(letter({ address: B, lt: 1n }));
      await store.putDeadLetter(letter({ consumer: "d", lt: 2n }));
      await store.putDeadLetter(letter({ lt: 5n, attempts: 4, error: "again" }));

      const forC = await store.listDeadLetters({ consumer: "c" });
      expect(forC.map((l) => [l.address === A ? "A" : "B", l.lt])).toEqual([
        ["A", 5n],
        ["A", 9n],
        ["B", 1n],
      ]);
      expect(forC[0]).toEqual(letter({ lt: 5n, attempts: 4, error: "again" }));
      expect((await store.listDeadLetters()).length).toBe(4);
      expect((await store.listDeadLetters({ address: B })).length).toBe(1);
      expect((await store.listDeadLetters({ consumer: "c", lt: 9n })).map((l) => l.lt)).toEqual([
        9n,
      ]);
      expect((await store.listDeadLetters({ limit: 2 })).length).toBe(2);

      expect(await store.deleteDeadLetter("c", A, 5n)).toBe(true);
      expect(await store.deleteDeadLetter("c", A, 5n)).toBe(false);
      expect((await store.listDeadLetters({ consumer: "c" })).length).toBe(2);
    });

    test("purging an address drops its cursors and dead letters", async () => {
      await store.setCursor("c", A, 1n);
      await store.putDeadLetter(letter());
      await store.removeAddress(A, { purge: true });
      expect(await store.listCursors("c")).toEqual([]);
      expect(await store.listDeadLetters()).toEqual([]);
    });

    test("backlog: pending transactions up to the frontier, and up to uptoLt", async () => {
      const txs = chain.txs(A);
      await store.setCursor("c", A, txs[3]!.lt);
      await store.setCursor("c", B, chain.txs(B).at(-1)!.lt);
      const [a, b] = await store.backlog("c");
      expect(a).toEqual({
        address: A,
        cursor: txs[3]!.lt,
        transactions: 6,
        newestLt: txs[9]!.lt,
        oldestUtime: txs[4]!.utime,
      });
      expect(b).toMatchObject({ transactions: 0, newestLt: null, oldestUtime: null });

      const [capped] = await store.backlog("c", txs[6]!.lt);
      expect(capped).toMatchObject({ transactions: 3, newestLt: txs[6]!.lt });

      // Never past the frontier; inactive addresses are left out.
      chain.grow([A], 2);
      await store.write(A, chain.txs(A).slice(-1));
      expect((await store.backlog("c"))[0]!.transactions).toBe(6);
      await store.removeAddress(B);
      expect((await store.backlog("c")).map((x) => x.address)).toEqual([A]);
    });

    test("the consumer lock is exclusive per name and free again after release", async () => {
      const [one, two] = await target.makePair();
      const lock = await one.lockConsumer!("c");
      expect(lock?.held).toBe(true);
      expect(await two.lockConsumer!("c")).toBeNull();
      expect(await one.lockConsumer!("c")).toBeNull();
      const other = await two.lockConsumer!("other");
      expect(other).not.toBeNull();

      await lock!.release();
      expect(lock!.held).toBe(false);
      await lock!.release(); // idempotent
      const again = await two.lockConsumer!("c");
      expect(again).not.toBeNull();
      await again!.release();
      await other!.release();
    });
  });
}

describe("PgStore: upgrading a v1 schema keeps consumer positions", () => {
  test("cursors survive with no failures recorded; the new tables are empty", async () => {
    const db = new PGlite() as unknown as PgDatabase;
    const original = [...migrations];
    migrations.splice(1);
    try {
      const v1 = new PgStore(db);
      await v1.migrate();
      await v1.addAddress(A, { startLt: 0n });
      // As v1 wrote it (today's setCursor also resets the v2 columns).
      await db.query(`insert into ton_watch.cursors (consumer, address_id, lt)
        select 'c', id, 42 from ton_watch.addresses`);
    } finally {
      migrations.splice(0, migrations.length, ...original);
    }
    const store = new PgStore(db);
    await store.migrate();
    expect(await store.listCursors()).toMatchObject([{ consumer: "c", lt: 42n, attempts: 0 }]);
    expect(await store.listConsumers()).toMatchObject([{ name: "c", order: null }]);
    expect(await store.listDeadLetters()).toEqual([]);
  });
});
