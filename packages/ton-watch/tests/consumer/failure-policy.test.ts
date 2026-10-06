/**
 * `onError`: a transaction whose handler keeps failing is retried forever
 * (default), skipped, or dead-lettered after `maxAttempts`, with attempt counts
 * that survive restarts; dead letters can be listed, replayed and resolved.
 */
import { afterAll, describe, expect, test } from "bun:test";

import { Consumer } from "../../src/consumer/consumer";
import type { HandlerFailure, ProcessOptions, TxHandler } from "../../src/consumer/types";
import type { IndexedTx, TxRecord } from "../../src/core/types";
import { Metrics } from "../../src/metrics/metrics";
import type { DeadLetter } from "../../src/stores/consumer-state";
import type { PgDatabase } from "../../src/stores/pg/database";
import { PgStore } from "../../src/stores/pg/pg-store";
import type { Store } from "../../src/stores/store";
import { FakeChain, fakeAddress } from "../fixtures/fake-chain";
import { cleanUpStoreTargets, storeTargets } from "../fixtures/store-targets";

const A = fakeAddress(1);
const B = fakeAddress(2);
const C = fakeAddress(3);
const NO_BACKOFF: ProcessOptions = { retryMinMs: 0, retryMaxMs: 0 };

afterAll(cleanUpStoreTargets);

async function indexed(store: Store, perAddress = 12) {
  const chain = new FakeChain();
  chain.grow([A, B, C], perAddress, 3);
  for (const address of [A, B, C]) {
    await store.addAddress(address, { startLt: 0n });
    await store.write(address, chain.txs(address));
    await store.advanceFrontier(address);
  }
  return chain;
}

/** A handler that records deliveries and always throws on `poison`. */
function recorder(poison: Set<bigint>) {
  const delivered: IndexedTx[] = [];
  const handler: TxHandler = (tx) => {
    if (poison.has(tx.lt)) throw new Error(`cannot handle ${tx.lt}`);
    delivered.push(tx);
  };
  return { delivered, handler };
}

async function rounds(consumer: Consumer, n: number) {
  for (let i = 0; i < n; i++) await consumer.runOnce();
}

const lts = (txs: readonly { lt: bigint }[]) => txs.map((tx) => tx.lt);
const byLtThenAddress = (a: TxRecord, b: TxRecord) =>
  a.lt < b.lt ? -1 : a.lt > b.lt ? 1 : a.address.localeCompare(b.address);

for (const target of storeTargets) {
  describe(`${target.name}: failure policies`, () => {
    test('"retry" (default) never moves past a failing transaction and persists attempts', async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const poison = chain.txs(A)[4]!.lt;
      const { delivered, handler } = recorder(new Set([poison]));
      const consumer = new Consumer("r", store, handler, { ...NO_BACKOFF, maxAttempts: 2 });
      await rounds(consumer, 8);

      expect(lts(delivered.filter((tx) => tx.address === A))).toEqual(
        lts(chain.txs(A).slice(0, 4)),
      );
      expect(delivered.filter((tx) => tx.address === B).length).toBe(12);
      expect(await store.listDeadLetters()).toEqual([]);
      const cursor = (await store.listCursors("r")).find((c) => c.address === A)!;
      expect(cursor.lt).toBe(chain.txs(A)[3]!.lt);
      expect(cursor.attempts).toBe(8);
      expect(cursor.lastError).toBe(`cannot handle ${poison}`);
      expect(consumer.status().addresses.find((s) => s.address === A)?.failures).toBe(8);
    });

    test('"skip" moves past after maxAttempts, with events and metrics', async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const poison = chain.txs(A)[4]!.lt;
      const { delivered, handler } = recorder(new Set([poison]));
      const metrics = new Metrics();
      const consumer = new Consumer(
        "s",
        store,
        handler,
        { ...NO_BACKOFF, onError: "skip", maxAttempts: 3 },
        { metrics },
      );
      const failures: HandlerFailure[] = [];
      const skipped: DeadLetter[] = [];
      consumer.on("handlerError", (failure) => void failures.push(failure));
      consumer.on("skip", (letter) => void skipped.push(letter));
      await rounds(consumer, 5);

      expect(lts(delivered.filter((tx) => tx.address === A))).toEqual(
        lts(chain.txs(A).filter((tx) => tx.lt !== poison)),
      );
      expect(failures.map((f) => [f.lt, f.attempts, f.action])).toEqual([
        [poison, 1, "retry"],
        [poison, 2, "retry"],
        [poison, 3, "skip"],
      ]);
      expect(skipped).toMatchObject([{ consumer: "s", address: A, lt: poison, attempts: 3 }]);
      expect(await store.listDeadLetters()).toEqual([]);
      expect(metrics.get("ton_watch_consumer_skipped_total", { consumer: "s" })).toBe(1);
      expect(metrics.get("ton_watch_consumer_errors_total", { consumer: "s" })).toBe(3);
      expect(metrics.get("ton_watch_consumer_delivered_total", { consumer: "s" })).toBe(35);
      const cursor = (await store.listCursors("s")).find((c) => c.address === A)!;
      expect(cursor).toMatchObject({ lt: chain.txs(A).at(-1)!.lt, attempts: 0, lastError: null });
    });

    test('"dead-letter" records the transaction and moves past it', async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const poison = chain.txs(B)[7]!;
      const { delivered, handler } = recorder(new Set([poison.lt]));
      const metrics = new Metrics();
      const consumer = new Consumer(
        "d",
        store,
        handler,
        { ...NO_BACKOFF, onError: "dead-letter", maxAttempts: 2 },
        { metrics },
      );
      const letters: DeadLetter[] = [];
      consumer.on("deadLetter", (letter) => void letters.push(letter));
      const before = Date.now();
      await rounds(consumer, 4);

      expect(delivered.length).toBe(35);
      const [stored] = await consumer.deadLetters();
      expect(stored).toMatchObject({
        consumer: "d",
        address: B,
        lt: poison.lt,
        error: `cannot handle ${poison.lt}`,
        attempts: 2,
      });
      expect(stored!.hash.equals(poison.hash)).toBe(true);
      expect(stored!.firstFailureAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(stored!.lastFailureAt.getTime()).toBeGreaterThanOrEqual(
        stored!.firstFailureAt.getTime(),
      );
      expect(letters).toEqual([stored!]);
      expect(metrics.get("ton_watch_consumer_dead_letters_total", { consumer: "d" })).toBe(1);
      expect(await store.getCursor("d", B)).toBe(chain.txs(B).at(-1)!.lt);
    });

    test("isRetryable: a non-retryable error is given up on at the first failure", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const permanent = chain.txs(A)[2]!.lt;
      const transient = chain.txs(B)[5]!.lt;
      const handler: TxHandler = (tx) => {
        if (tx.lt === permanent) throw Object.assign(new Error("rejected"), { permanent: true });
        if (tx.lt === transient) throw new Error("try again");
      };
      const options: ProcessOptions = {
        ...NO_BACKOFF,
        onError: "dead-letter",
        maxAttempts: 3,
        isRetryable: (error) => !(error as { permanent?: boolean }).permanent,
      };
      const failures: HandlerFailure[] = [];
      const consumer = new Consumer("p", store, handler, options);
      consumer.on("handlerError", (failure) => void failures.push(failure));
      await rounds(consumer, 5);

      const letters = await consumer.deadLetters();
      expect(letters.map((l) => [l.address, l.lt, l.attempts])).toEqual([
        [A, permanent, 1],
        [B, transient, 3],
      ]);
      expect(failures.filter((f) => f.lt === permanent).map((f) => f.action)).toEqual([
        "dead-letter",
      ]);
      expect(failures.filter((f) => f.lt === transient).map((f) => f.action)).toEqual([
        "retry",
        "retry",
        "dead-letter",
      ]);
    });

    test('isRetryable does not make "retry" give up', async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const poison = chain.txs(A)[1]!.lt;
      const { delivered, handler } = recorder(new Set([poison]));
      const consumer = new Consumer("pr", store, handler, {
        ...NO_BACKOFF,
        maxAttempts: 1,
        isRetryable: () => false,
      });
      await rounds(consumer, 3);
      expect(delivered.filter((tx) => tx.address === A).length).toBe(1);
      expect(await store.listDeadLetters()).toEqual([]);
      expect((await store.listCursors("pr")).find((c) => c.address === A)?.attempts).toBe(3);
    });

    test("attempt counts survive a restart", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const poison = chain.txs(C)[2]!.lt;
      const options: ProcessOptions = { ...NO_BACKOFF, onError: "dead-letter", maxAttempts: 3 };
      const first = recorder(new Set([poison]));
      await rounds(new Consumer("p", store, first.handler, options), 2);
      expect(await store.listDeadLetters()).toEqual([]);
      expect((await store.listCursors("p")).find((c) => c.address === C)?.attempts).toBe(2);

      // A new process: the third failure is the last one.
      const second = recorder(new Set([poison]));
      const restarted = new Consumer("p", store, second.handler, options);
      const failures: HandlerFailure[] = [];
      restarted.on("handlerError", (failure) => void failures.push(failure));
      await restarted.runOnce();
      expect(failures.map((f) => [f.attempts, f.action])).toEqual([[3, "dead-letter"]]);
      expect((await store.listDeadLetters()).map((l) => [l.lt, l.attempts])).toEqual([[poison, 3]]);
      await rounds(restarted, 2);
      expect(lts(second.delivered.filter((tx) => tx.address === C))).toEqual(
        lts(chain.txs(C).slice(3)),
      );
    });

    test("global order: a dead-lettered transaction does not block the stream", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const poison = chain.txs(A)[5]!.lt;
      const { delivered, handler } = recorder(new Set([poison]));
      const consumer = new Consumer("g", store, handler, {
        ...NO_BACKOFF,
        order: "global",
        onError: "dead-letter",
        maxAttempts: 2,
        batchSize: 4,
      });
      await rounds(consumer, 6);
      // Released up to the watermark: the lowest of the three frontiers.
      const watermark = [A, B, C]
        .map((address) => chain.txs(address).at(-1)!.lt)
        .reduce((min, lt) => (lt < min ? lt : min));
      const expected = [A, B, C]
        .flatMap((address) => chain.txs(address))
        .filter((tx) => tx.lt !== poison && tx.lt <= watermark)
        .sort(byLtThenAddress);
      expect(delivered.map((tx) => `${tx.lt}:${tx.address}`)).toEqual(
        expected.map((tx) => `${tx.lt}:${tx.address}`),
      );
      expect((await store.listDeadLetters()).map((l) => l.lt)).toEqual([poison]);
    });

    test("global order with retries still halts everything at the failing transaction", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const poison = chain.txs(A)[5]!.lt;
      const { delivered, handler } = recorder(new Set([poison]));
      const consumer = new Consumer("gr", store, handler, { ...NO_BACKOFF, order: "global" });
      await rounds(consumer, 4);
      expect(delivered.every((tx) => tx.lt < poison)).toBe(true);
    });

    test("replay redelivers a dead letter and deletes it; a failed replay keeps it", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const poison = chain.txs(A)[1]!;
      const broken = new Set([poison.lt]);
      const replays: boolean[] = [];
      const handler: TxHandler = (tx, ctx) => {
        if (broken.has(tx.lt)) throw new Error("still broken");
        if (tx.lt === poison.lt) replays.push(ctx.replay);
      };
      const consumer = new Consumer("rp", store, handler, {
        ...NO_BACKOFF,
        onError: "dead-letter",
        maxAttempts: 1,
      });
      await rounds(consumer, 2);
      expect((await consumer.deadLetters()).length).toBe(1);

      await expect(consumer.replayDeadLetter(A, poison.lt)).rejects.toThrow("still broken");
      expect(await consumer.deadLetters()).toMatchObject([
        { lt: poison.lt, attempts: 2, error: "still broken" },
      ]);

      broken.clear();
      await consumer.replayDeadLetter(A, poison.lt);
      expect(replays).toEqual([true]);
      expect(await consumer.deadLetters()).toEqual([]);
      await expect(consumer.replayDeadLetter(A, poison.lt)).rejects.toThrow("no dead letter");
    });

    test("resolve deletes a dead letter without redelivering it", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const poison = chain.txs(B)[0]!.lt;
      const { delivered, handler } = recorder(new Set([poison]));
      const consumer = new Consumer("rs", store, handler, {
        ...NO_BACKOFF,
        onError: "dead-letter",
        maxAttempts: 1,
      });
      await rounds(consumer, 2);
      expect(await consumer.resolveDeadLetter(B, poison)).toBe(true);
      expect(await consumer.resolveDeadLetter(B, poison)).toBe(false);
      expect(await consumer.deadLetters()).toEqual([]);
      expect(delivered.some((tx) => tx.lt === poison)).toBe(false);
    });
  });
}

describe("PgStore: transactional dead letters", () => {
  test("a replay's ctx.db writes commit with the dead letter's deletion, or not at all", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite() as unknown as PgDatabase;
    await db.query(`create table effects (lt bigint primary key)`);
    const store = new PgStore(db);
    await store.migrate();
    const chain = await indexed(store, 4);
    const poison = chain.txs(A)[2]!.lt;
    let failAfterWrite = true;
    const consumer = new Consumer(
      "tx",
      store,
      async (tx, ctx) => {
        await (ctx.db as PgDatabase).query(`insert into effects values ($1)`, [tx.lt.toString()]);
        if (tx.lt === poison && failAfterWrite) throw new Error("after the write");
      },
      { ...NO_BACKOFF, onError: "dead-letter", maxAttempts: 2 },
    );
    await rounds(consumer, 3);
    const effects = async () =>
      (await db.query(`select lt::text from effects order by lt`)).rows.map((row) =>
        BigInt((row as { lt: string }).lt),
      );
    expect(await effects()).not.toContain(poison);
    expect((await store.listDeadLetters()).length).toBe(1);

    await expect(consumer.replayDeadLetter(A, poison)).rejects.toThrow("after the write");
    expect(await effects()).not.toContain(poison);

    failAfterWrite = false;
    await consumer.replayDeadLetter(A, poison);
    expect(await effects()).toContain(poison);
    expect(await store.listDeadLetters()).toEqual([]);
  });
});

describe("failure policy options", () => {
  test("invalid values fail at construction", () => {
    const make = (options: Record<string, unknown>) => () =>
      new Consumer("v", {} as Store, () => {}, options as ProcessOptions);
    expect(make({ maxAttempts: 0 })).toThrow("maxAttempts");
    expect(make({ onError: "ignore" })).toThrow("onError");
    expect(make({ lock: "steal" })).toThrow("lock");
    expect(make({ lagIntervalMs: -1 })).toThrow("lagIntervalMs");
    expect(make({ isRetryable: true })).toThrow("isRetryable");
    expect(make({ onError: "skip", maxAttempts: 1, lock: "wait", lagIntervalMs: 0 })).not.toThrow();
  });
});
