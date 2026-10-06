/**
 * End to end through the public API, from the client's side: a service indexes,
 * consumers ask "what comes after what I processed", and get it — in order, once —
 * across new blocks, restarts and outages.
 */

import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { silentLogger } from "../src/logger";
import { MemoryStore } from "../src/stores/memory-store";
import { PgStore } from "../src/stores/pg/pg-store";
import type { Store } from "../src/stores/store";
import type { IndexedTx } from "../src/types";
import { TonWatch } from "../src/watch";
import { FakeChain, FakeSource, fakeAddress } from "./fixtures/fake-chain";

const A = fakeAddress(1);
const B = fakeAddress(2);
const C = fakeAddress(3);

const until = async (cond: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const make = (chain: FakeChain, store: Store, faults = {}) =>
  new TonWatch({
    store,
    source: new FakeSource(chain, faults),
    tickMs: 10,
    maxIdlePollMs: 0,
    logger: silentLogger,
  });

const lts = (txs: { lt: bigint }[]) => txs.map((t) => t.lt);

describe("TonWatch end to end", () => {
  test("from now: only new transactions, in order, as blocks arrive", async () => {
    const chain = new FakeChain();
    chain.grow([A, B], 20);
    const watch = make(chain, new MemoryStore());
    await watch.addAddress(A, { from: "now" });
    await watch.addAddress(B, { from: "now" });
    const got: IndexedTx[] = [];
    watch.process("c", (tx) => void got.push(tx), { pollMs: 10 });
    await watch.start();

    for (let block = 0; block < 5; block++) {
      chain.grow([A, B], 7, 2);
      const expected = [...chain.txs(A).slice(20), ...chain.txs(B).slice(20)].length;
      await until(() => got.length === expected);
    }
    await watch.stop();
    for (const a of [A, B]) {
      expect(lts(got.filter((t) => t.address === a))).toEqual(lts(chain.txs(a).slice(20)));
    }
    expect(got[0]!.transaction.lt).toBe(got[0]!.lt); // parsed lazily from the BOC
  });

  test("restart resumes at the next unprocessed transaction, nothing twice", async () => {
    const chain = new FakeChain();
    chain.grow([A], 300, 5);
    const store = new MemoryStore();
    const seen = new Map<string, number>();
    const handler = (tx: IndexedTx) =>
      void seen.set(tx.hash.toString("hex"), (seen.get(tx.hash.toString("hex")) ?? 0) + 1);

    // First process: indexes everything, consumer stops part way.
    const w1 = make(chain, store);
    await w1.addAddress(A, { from: "genesis" });
    let count = 0;
    w1.process(
      "billing",
      async (tx) => {
        handler(tx);
        count++;
        await new Promise((r) => setTimeout(r, 1)); // slow consumer: stopped mid-stream
      },
      { batchSize: 10 },
    );
    await w1.start();
    await until(() => count >= 120);
    await w1.stop();
    const processedBefore = count;
    expect(processedBefore).toBeLessThan(300);
    const cursor = await store.getCursor("billing", chain.txs(A)[0]!.address);
    expect(cursor).toBe(chain.txs(A)[processedBefore - 1]!.lt);

    // Meanwhile the chain moves on. Second process picks up exactly after the cursor.
    chain.grow([A], 50);
    const firstAfter: bigint[] = [];
    const w2 = make(chain, store);
    w2.process("billing", (tx) => {
      handler(tx);
      firstAfter.push(tx.lt);
    });
    await w2.start();
    await until(() => seen.size === 350);
    await w2.stop();
    expect(firstAfter[0]).toBe(chain.txs(A)[processedBefore]!.lt);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  test("outage: service down while the chain moves, catches up in order on restart", async () => {
    const chain = new FakeChain();
    chain.grow([A, B], 10);
    const store = new MemoryStore();
    const w1 = make(chain, store);
    await w1.addAddress(A, { from: "now" });
    await w1.addAddress(B, { from: "now" });
    await w1.start();
    await new Promise((r) => setTimeout(r, 50));
    await w1.stop();

    chain.grow([A, B], 600, 7); // "seven weeks" of traffic while down
    const got: bigint[] = [];
    const w2 = make(chain, store, { latencyMs: [0, 2], rateLimit: 0.05, seed: 4 });
    w2.process("c", (tx) => {
      if (tx.address === A) got.push(tx.lt);
    });
    await w2.start();
    await until(() => got.length === 600, 20_000);
    await w2.stop();
    expect(got).toEqual(lts(chain.txs(A).slice(10)));
  }, 30_000);

  test("a late consumer can start from the beginning or from now", async () => {
    const chain = new FakeChain();
    chain.grow([A], 40);
    const watch = make(chain, new MemoryStore());
    await watch.addAddress(A, { from: "genesis" });
    await watch.start();
    await until(async () => (await watch.addresses())[0]?.frontier?.lt === chain.txs(A).at(-1)!.lt);

    const all: bigint[] = [];
    const fresh: bigint[] = [];
    watch.process("history", (tx) => void all.push(tx.lt), { from: "start" });
    watch.process("live", (tx) => void fresh.push(tx.lt), { from: "now" });
    await until(() => all.length === 40);
    chain.grow([A], 5);
    await until(() => all.length === 45 && fresh.length === 5);
    await watch.stop();
    expect(fresh).toEqual(lts(chain.txs(A).slice(40)));
  });

  test("global order across addresses, released up to the watermark", async () => {
    const chain = new FakeChain();
    chain.grow([A, B, C], 5);
    const watch = make(chain, new MemoryStore());
    for (const a of [A, B, C]) await watch.addAddress(a, { from: "now" });
    const got: IndexedTx[] = [];
    watch.process("ordered", (tx) => void got.push(tx), { order: "global" });
    await watch.start();
    chain.grow([A, B, C], 30, 4);
    await until(() => got.length === 90);
    await watch.stop();
    const order = lts(got);
    expect(order).toEqual([...order].sort((x, y) => (x < y ? -1 : 1)));
    expect((await watch.watermark())! >= order.at(-1)!).toBe(true);
  });

  test("removed addresses stop flowing; health reflects the service", async () => {
    const chain = new FakeChain();
    chain.grow([A, B], 5);
    const watch = make(chain, new MemoryStore());
    await watch.addAddress(A);
    await watch.addAddress(B);
    expect(watch.health().status).toBe("down");
    const got: IndexedTx[] = [];
    watch.process("c", (tx) => void got.push(tx));
    await watch.start();
    await until(() => watch.health().status === "ok");
    await watch.removeAddress(B);
    chain.grow([A, B], 10);
    await until(() => got.filter((t) => t.address === A).length === 10);
    await new Promise((r) => setTimeout(r, 100));
    await watch.stop();
    expect(got.filter((t) => t.address === B).length).toBe(0);
    expect(watch.health().running).toBe(false);
  });

  test("on Postgres (PGlite): handler writes and positions survive a crash-restart exactly once", async () => {
    const chain = new FakeChain();
    chain.grow([A], 80, 4);
    const db = new PGlite();
    await db.query(`create table seen (lt bigint primary key)`);
    let crashes = 0;
    const handler = async (tx: IndexedTx, ctx: { db?: unknown }) => {
      await (ctx.db as PGlite).query(`insert into seen values ($1)`, [tx.lt.toString()]);
      // Every 9th transaction fails once after writing: must roll back and retry.
      if (Number(tx.lt % 9n) === 0 && crashes++ % 2 === 0) throw new Error("boom");
    };
    const w1 = make(chain, new PgStore(db as any));
    await w1.addAddress(A, { from: "genesis" });
    w1.process("pg", handler, { retryMinMs: 1, retryMaxMs: 2 });
    await w1.start();
    await until(
      async () =>
        (await db.query<{ n: number }>(`select count(*)::int n from seen`)).rows[0]!.n >= 30,
    );
    await w1.stop({ closeStore: false });

    const w2 = make(chain, new PgStore(db as any));
    w2.process("pg", handler, { retryMinMs: 1, retryMaxMs: 2 });
    await w2.start();
    await until(
      async () =>
        (await db.query<{ n: number }>(`select count(*)::int n from seen`)).rows[0]!.n === 80,
      10_000,
    );
    await w2.stop({ closeStore: false });
    const { rows } = await db.query<{ lt: string }>(`select lt::text from seen order by lt`);
    expect(rows.map((r) => BigInt(r.lt))).toEqual(lts(chain.txs(A)));
  }, 20_000);
});
