/**
 * Running a consumer name in one place at a time, and managing consumers: rewind,
 * lag, listing and deletion, through `Consumer` and `TonWatch`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";

import { Consumer } from "../../src/consumer/consumer";
import { ConsumerLockedError } from "../../src/consumer/errors";
import type { ProcessOptions, TxHandler } from "../../src/consumer/types";
import type { IndexedTx } from "../../src/core/types";
import { Metrics } from "../../src/metrics/metrics";
import type { PgStore } from "../../src/stores/pg/pg-store";
import type { Store } from "../../src/stores/store";
import { TonWatch } from "../../src/ton-watch";
import { sleep } from "../../src/util/async";
import { silentLogger } from "../../src/util/logger";
import { FakeChain, FakeSource, fakeAddress } from "../fixtures/fake-chain";
import { cleanUpStoreTargets, storeTargets } from "../fixtures/store-targets";

const A = fakeAddress(1);
const B = fakeAddress(2);
const FAST: ProcessOptions = { pollMs: 2, retryMinMs: 0, retryMaxMs: 0 };

afterAll(cleanUpStoreTargets);

async function indexed(store: Store, chain = new FakeChain(), perAddress = 10) {
  chain.grow([A, B], perAddress, 2);
  for (const address of [A, B]) {
    await store.addAddress(address, { startLt: 0n });
    await store.write(address, chain.txs(address));
    await store.advanceFrontier(address);
  }
  return chain;
}

async function grow(store: Store, chain: FakeChain, n: number) {
  chain.grow([A, B], n, 2);
  for (const address of [A, B]) {
    await store.write(address, chain.txs(address).slice(-n));
    await store.advanceFrontier(address);
  }
}

const until = async (condition: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
};

function collector() {
  const delivered: IndexedTx[] = [];
  const handler: TxHandler = (tx) => void delivered.push(tx);
  return { delivered, handler };
}

const key = (tx: { lt: bigint; address: string }) => `${tx.address}:${tx.lt}`;
const keys = (txs: readonly { lt: bigint; address: string }[]) => txs.map(key);
const ofAddress = (txs: IndexedTx[], address: string) => txs.filter((tx) => tx.address === address);

const watchOn = (store: Store, chain: FakeChain) =>
  new TonWatch({
    store,
    source: new FakeSource(chain),
    tickMs: 5,
    maxIdlePollMs: 0,
    logger: silentLogger,
    migrate: false,
  });

for (const target of storeTargets) {
  describe(`${target.name}: single-instance lock`, () => {
    test("a second instance of a running consumer is refused with ConsumerLockedError", async () => {
      const [one, two] = await target.makePair();
      await indexed(one);
      const first = new Consumer("x", one, collector().handler, FAST).start();
      await first.ready();
      expect(first.status().running).toBe(true);

      const second = new Consumer("x", two, collector().handler, FAST);
      const refused = await second
        .start()
        .ready()
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ConsumerLockedError);
      expect((refused as ConsumerLockedError).consumer).toBe("x");
      expect(second.status().running).toBe(false);
      await expect(second.runOnce()).rejects.toBeInstanceOf(ConsumerLockedError);

      // Other names are independent.
      const other = new Consumer("y", two, collector().handler, FAST);
      expect(await other.runOnce()).toBe(20);

      await first.stop();
      expect(await second.runOnce()).toBe(0); // free again; x already delivered everything
      await second.stop();
    });

    test('lock: "wait" takes over when the running instance stops, without duplicates', async () => {
      const [one, two] = await target.makePair();
      const chain = await indexed(one);
      const seen = new Map<string, number>();
      const handler: TxHandler = (tx) => void seen.set(key(tx), (seen.get(key(tx)) ?? 0) + 1);
      const first = new Consumer("w", one, handler, FAST).start();
      await first.ready();
      await until(() => seen.size === 20);

      const second = new Consumer("w", two, handler, { ...FAST, lock: "wait" }).start();
      await second.ready();
      expect(second.status()).toMatchObject({ running: true, waitingForLock: true });

      await first.stop();
      await grow(one, chain, 3);
      second.wake();
      await until(() => seen.size === 26);
      expect(second.status().waitingForLock).toBe(false);
      await second.stop();
      expect([...seen.values()].every((count) => count === 1)).toBe(true);
    });

    test("stop releases the lock; runOnce outside start holds it only for the round", async () => {
      const [one, two] = await target.makePair();
      await indexed(one);
      const a = new Consumer("r", one, collector().handler, FAST);
      const b = new Consumer("r", two, collector().handler, FAST);
      await a.runOnce();
      await b.runOnce();
      a.start();
      await a.ready();
      await expect(b.runOnce()).rejects.toBeInstanceOf(ConsumerLockedError);
      await a.stop();
      await b.runOnce();
    });
  });

  describe(`${target.name}: rewind`, () => {
    test("a stopped consumer: to start, to an lt on one address, to now", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const { delivered, handler } = collector();
      const consumer = new Consumer("rw", store, handler, FAST);
      await consumer.runOnce();
      expect(delivered.length).toBe(20);

      await consumer.rewind("earliest");
      await consumer.runOnce();
      for (const address of [A, B]) {
        expect(keys(ofAddress(delivered.slice(20), address))).toEqual(keys(chain.txs(address)));
      }

      await consumer.rewind(chain.txs(A)[6]!.lt, { addresses: [A] });
      await consumer.runOnce();
      expect(keys(delivered.slice(40))).toEqual(keys(chain.txs(A).slice(7)));

      await grow(store, chain, 4);
      await consumer.rewind("now");
      expect(await consumer.runOnce()).toBe(0);
      expect(await store.getCursor("rw", B)).toBe(chain.txs(B).at(-1)!.lt);
    });

    test("rewind clears failure counts and halts", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const poison = chain.txs(A)[3]!.lt;
      let broken = true;
      const consumer = new Consumer(
        "rf",
        store,
        (tx) => {
          if (broken && tx.lt === poison) throw new Error("boom");
        },
        { retryMinMs: 60_000, retryMaxMs: 60_000 },
      );
      await consumer.runOnce();
      expect(consumer.status().addresses.find((s) => s.address === A)).toMatchObject({
        halted: true,
        failures: 1,
      });
      broken = false;
      await consumer.rewind("earliest", { addresses: [A] });
      expect((await store.listCursors("rf")).find((c) => c.address === A)?.attempts).toBe(0);
      expect(await consumer.runOnce()).toBe(10); // not held back by the old backoff
    });

    test("a running consumer applies it between rounds, mid-batch", async () => {
      const store = await target.make();
      const chain = await indexed(store, new FakeChain(), 30);
      const delivered: IndexedTx[] = [];
      const consumer = new Consumer(
        "live",
        store,
        async (tx) => {
          delivered.push(tx);
          await sleep(1);
        },
        { ...FAST, batchSize: 1000, concurrency: 1 },
      ).start();
      await consumer.ready();
      await until(() => delivered.length >= 10);
      await consumer.rewind("earliest");
      const mark = delivered.length;
      await until(() => ofAddress(delivered.slice(mark), B).length === 30);
      await consumer.stop();
      for (const address of [A, B]) {
        expect(keys(ofAddress(delivered.slice(mark), address))).toEqual(keys(chain.txs(address)));
      }
    });

    test("another instance cannot rewind a running consumer", async () => {
      const [one, two] = await target.makePair();
      await indexed(one);
      const { delivered, handler } = collector();
      const running = new Consumer("busy", one, handler, FAST).start();
      await running.ready();
      await until(() => delivered.length === 20);
      const other = new Consumer("busy", two, collector().handler, FAST);
      await expect(other.rewind("earliest")).rejects.toBeInstanceOf(ConsumerLockedError);
      await running.stop();
      await other.rewind("earliest");
      expect(await two.getCursor("busy", A)).toBe(0n);
    });
  });

  describe(`${target.name}: lag`, () => {
    test("per address: transactions, lt and seconds behind the frontier; gauges", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const txs = chain.txs(A);
      const metrics = new Metrics();
      const consumer = new Consumer(
        "lag",
        store,
        (tx) => {
          if (tx.lt === txs[5]!.lt) throw new Error("stuck");
        },
        { retryMinMs: 60_000, retryMaxMs: 60_000 },
        { metrics },
      );
      expect(consumer.status().lag).toBeNull();
      await consumer.runOnce();
      const lag = await consumer.lag();
      const nowSeconds = Math.floor(Date.now() / 1000);

      const a = lag.addresses.find((x) => x.address === A)!;
      expect(a).toMatchObject({ cursor: txs[4]!.lt, transactions: 5, lt: txs[9]!.lt - txs[4]!.lt });
      expect(Math.abs(a.seconds - (nowSeconds - txs[5]!.utime))).toBeLessThanOrEqual(1);
      expect(lag.addresses.find((x) => x.address === B)).toMatchObject({
        transactions: 0,
        lt: 0n,
        seconds: 0,
      });
      expect(lag).toMatchObject({ transactions: 5, lt: a.lt, seconds: a.seconds });
      expect(consumer.status().lag).toEqual(lag);
      expect(metrics.get("ton_watch_consumer_lag_transactions", { consumer: "lag" })).toBe(5);
      expect(metrics.get("ton_watch_consumer_lag_seconds", { consumer: "lag" })).toBe(a.seconds);
    });

    test("global order: only what is below the watermark counts", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      // B gets 5 more transactions; A stays complete only up to its last one.
      chain.grow([B], 5);
      await store.write(B, chain.txs(B).slice(-5));
      await store.advanceFrontier(B);
      const consumer = new Consumer("glag", store, () => {}, { order: "global" });
      await consumer.runOnce();
      const lag = await consumer.lag();
      expect(lag.transactions).toBe(0);
      expect((await new Consumer("alag", store, () => {}).lag()).transactions).toBe(0);

      const perAddress = new Consumer("plag", store, () => {}, { from: "earliest" });
      await store.setCursor("plag", A, 0n);
      await store.setCursor("plag", B, 0n);
      expect((await perAddress.lag()).transactions).toBe(25);
      const global = new Consumer("glag2", store, () => {}, { order: "global" });
      await store.setCursor("glag2", A, 0n);
      await store.setCursor("glag2", B, 0n);
      const watermark = chain.txs(A).at(-1)!.lt;
      expect((await global.lag()).transactions).toBe(
        chain.txs(B).filter((tx) => tx.lt <= watermark).length + 10,
      );
    });

    test("a started consumer measures lag every lagIntervalMs", async () => {
      const store = await target.make();
      await indexed(store);
      const consumer = new Consumer("auto", store, () => {}, { ...FAST, lagIntervalMs: 1 }).start();
      await consumer.ready();
      await until(() => consumer.status().lag?.transactions === 0);
      await consumer.stop();
    });
  });

  describe(`${target.name}: TonWatch consumer management`, () => {
    test("list, lag, rewind and delete consumers that run elsewhere", async () => {
      const [one, two] = await target.makePair();
      const chain = await indexed(one);
      const elsewhere = new Consumer("remote", one, () => {}, { order: "global" });
      await elsewhere.runOnce();
      const watch = watchOn(two, chain);
      const local = watch.process("local", () => {});
      await local.runOnce();

      const consumers = await watch.consumers();
      expect(consumers.map((c) => [c.name, c.order, c.cursors.length])).toEqual([
        ["local", "address", 2],
        ["remote", "global", 2],
      ]);
      expect((await watch.consumerLag("remote")).transactions).toBe(0);
      await expect(watch.consumerLag("nobody")).rejects.toThrow("unknown consumer");

      await watch.rewindConsumer("remote", "earliest");
      // Global order: only what is below the watermark (B's last transaction is above it).
      const watermark = chain.txs(A).at(-1)!.lt;
      expect((await watch.consumerLag("remote")).transactions).toBe(
        [A, B].flatMap((address) => chain.txs(address)).filter((tx) => tx.lt <= watermark).length,
      );
      await watch.rewindConsumer("local", chain.txs(B)[4]!.lt, { addresses: [B] });
      expect((await watch.consumerLag("local")).transactions).toBe(5);

      elsewhere.start();
      await elsewhere.ready();
      await expect(watch.rewindConsumer("remote", "now")).rejects.toBeInstanceOf(
        ConsumerLockedError,
      );
      await expect(watch.deleteConsumer("remote")).rejects.toBeInstanceOf(ConsumerLockedError);
      await expect(watch.deleteConsumer("local")).rejects.toThrow("registered in this process");
      await elsewhere.stop();

      await watch.deleteConsumer("remote");
      expect((await watch.consumers()).map((c) => c.name)).toEqual(["local"]);
      expect(() => watch.process("local", () => {})).toThrow("already registered");
    });

    test("dead letters through TonWatch: list, replay, discard", async () => {
      const store = await target.make();
      const chain = await indexed(store);
      const [first, second] = [chain.txs(A)[2]!.lt, chain.txs(B)[3]!.lt];
      let broken = true;
      const watch = watchOn(store, chain);
      const consumer = watch.process(
        "dl",
        (tx) => {
          if (broken && (tx.lt === first || tx.lt === second)) throw new Error("bad");
        },
        { onError: "dead-letter", maxAttempts: 1 },
      );
      await consumer.runOnce();
      expect((await watch.deadLetters()).map((l) => l.lt)).toEqual([first, second]);
      expect((await watch.deadLetters({ address: B })).map((l) => l.lt)).toEqual([second]);

      broken = false;
      await watch.replayDeadLetter("dl", A, first);
      expect(await watch.discardDeadLetter("dl", B, second)).toBe(true);
      expect(await watch.deadLetters()).toEqual([]);
      expect(() => watch.replayDeadLetter("other", A, first)).toThrow("not registered");
    });

    test("start refuses, and starts nothing, while a consumer runs elsewhere", async () => {
      const [one, two] = await target.makePair();
      const chain = await indexed(one);
      const running = new Consumer("svc", one, () => {}, FAST).start();
      await running.ready();
      const watch = watchOn(two, chain);
      const other = watch.process("other", () => {});
      watch.process("svc", () => {});
      await expect(watch.start()).rejects.toBeInstanceOf(ConsumerLockedError);
      expect(watch.health().running).toBe(false);
      expect(other.status().running).toBe(false);
      await running.stop();
      await watch.start();
      await watch.stop();
    });
  });
}

describe("PgStore (postgres): a lost lock connection", () => {
  const url = process.env.TEST_DATABASE_URL;
  test.skipIf(!url)("the consumer re-takes its lock and keeps delivering", async () => {
    const target = storeTargets.find((t) => t.realPostgres)!;
    const store = await target.make();
    const chain = await indexed(store);
    const { delivered, handler } = collector();
    const consumer = new Consumer("lost", store, handler, FAST).start();
    await consumer.ready();
    await until(() => delivered.length === 20);

    const admin = new Pool({ connectionString: url });
    try {
      // Holders of this consumer's lock: the two-key form keeps both keys unsigned.
      const lockHolders = async () =>
        (
          await admin.query(
            `select pid from pg_locks where locktype = 'advisory' and granted and objsubid = 2
               and classid = (hashtext($1)::bigint & 4294967295)::oid
               and objid = (hashtext($2)::bigint & 4294967295)::oid`,
            [`ton_watch:${(store as PgStore).schema}`, "lost"],
          )
        ).rows.map((row) => row.pid as number);
      const [pid] = await lockHolders();
      expect(pid).toBeDefined();
      await admin.query(`select pg_terminate_backend($1)`, [pid]);

      await grow(store, chain, 2);
      consumer.wake();
      await until(() => delivered.length === 24);
      const holders = await lockHolders();
      expect(holders.length).toBe(1);
      expect(holders[0]).not.toBe(pid);
    } finally {
      await consumer.stop();
      await admin.end();
    }
    expect(new Set(keys(delivered)).size).toBe(24);
  });
});
