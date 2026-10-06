import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { Consumer } from "../../src/consumer/consumer";
import type { IndexedTx } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import { PgStore } from "../../src/stores/pg/pg-store";
import type { Store } from "../../src/stores/store";
import { FakeChain, fakeAddress, rng } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const B = fakeAddress(2);
const C = fakeAddress(3);

async function seeded(store: Store = new MemoryStore(), n = 60) {
  const chain = new FakeChain();
  chain.grow([A, B, C], n, 2);
  await store.migrate();
  for (const a of [A, B, C]) await store.addAddress(a, { startLt: 0n });
  return { chain, store };
}

async function writeAll(store: Store, chain: FakeChain, addresses: string[], seed = 1) {
  const r = rng(seed);
  for (const a of addresses) {
    const txs = [...chain.txs(a)];
    // Write in random chunks, in random order.
    const chunks: (typeof txs)[] = [];
    while (txs.length) chunks.push(txs.splice(0, 1 + Math.floor(r() * 10)));
    chunks.sort(() => r() - 0.5);
    for (const c of chunks) await store.write(a, c);
    await store.advanceFrontier(a);
  }
}

/** Runs rounds until nothing more is delivered. */
async function drain(c: Consumer) {
  while ((await c.runOnce()) > 0) {}
}

describe("Consumer (per-address order)", () => {
  test("delivers each address in lt order after out-of-order writes", async () => {
    const { chain, store } = await seeded();
    await writeAll(store, chain, [A, B, C]);
    const seen = new Map<string, bigint[]>();
    const c = new Consumer("t", store, (tx) => {
      seen.set(tx.address, [...(seen.get(tx.address) ?? []), tx.lt]);
    });
    await drain(c);
    for (const a of [A, B, C]) expect(seen.get(a)).toEqual(chain.txs(a).map((t) => t.lt));
  });

  test("never delivers past a gap; continues once it is filled", async () => {
    const { chain, store } = await seeded();
    const txs = chain.txs(A);
    await store.write(A, [...txs.slice(0, 20), ...txs.slice(30)]);
    await store.advanceFrontier(A);
    const got: bigint[] = [];
    const c = new Consumer("t", store, (tx) => void got.push(tx.lt), { addresses: [A] });
    await drain(c);
    expect(got).toEqual(txs.slice(0, 20).map((t) => t.lt));

    await store.write(A, txs.slice(20, 30));
    await store.advanceFrontier(A);
    await drain(c);
    expect(got).toEqual(txs.map((t) => t.lt));
  });

  test("exactly once across restarts", async () => {
    const { chain, store } = await seeded();
    await writeAll(store, chain, [A, B, C]);
    const counts = new Map<string, number>();
    const handler = (tx: IndexedTx) => {
      const k = tx.hash.toString("hex");
      counts.set(k, (counts.get(k) ?? 0) + 1);
    };
    // Several "processes", each stopped after a few transactions.
    for (let run = 0; run < 20; run++) {
      const c = new Consumer("restarts", store, handler, { batchSize: 7, concurrency: 2 });
      await c.runOnce();
    }
    await drain(new Consumer("restarts", store, handler));
    const total = [A, B, C].reduce((n, a) => n + chain.txs(a).length, 0);
    expect(counts.size).toBe(total);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  test("a failing handler halts its address and retries the same tx; others continue", async () => {
    const { chain, store } = await seeded();
    await writeAll(store, chain, [A, B, C]);
    const poison = chain.txs(A)[10]!.lt;
    let failuresLeft = 3;
    const got = new Map<string, bigint[]>();
    const c = new Consumer(
      "t",
      store,
      (tx) => {
        if (tx.lt === poison && failuresLeft > 0) {
          failuresLeft--;
          throw new Error("downstream unavailable");
        }
        got.set(tx.address, [...(got.get(tx.address) ?? []), tx.lt]);
      },
      { retryMinMs: 1, retryMaxMs: 2 },
    );
    await c.runOnce();
    expect(got.get(A)).toEqual(
      chain
        .txs(A)
        .slice(0, 10)
        .map((t) => t.lt),
    );
    expect(got.get(B)?.length).toBe(chain.txs(B).length);
    expect(c.status().addresses.find((s) => s.address === A)?.failures).toBe(1);

    for (let i = 0; i < 10 && (got.get(A)?.length ?? 0) < chain.txs(A).length; i++) {
      await new Promise((r) => setTimeout(r, 3));
      await c.runOnce();
    }
    expect(got.get(A)).toEqual(chain.txs(A).map((t) => t.lt));
    expect(failuresLeft).toBe(0);
  });

  test("from: 'now' skips history and persists its starting point", async () => {
    const { chain, store } = await seeded();
    await writeAll(store, chain, [A]);
    const got: bigint[] = [];
    await drain(
      new Consumer("n", store, (tx) => void got.push(tx.lt), { from: "now", addresses: [A] }),
    );
    expect(got).toEqual([]);
    chain.grow([A], 5);
    await store.write(A, chain.txs(A).slice(-5));
    await store.advanceFrontier(A);
    await drain(
      new Consumer("n", store, (tx) => void got.push(tx.lt), { from: "now", addresses: [A] }),
    );
    expect(got).toEqual(
      chain
        .txs(A)
        .slice(-5)
        .map((t) => t.lt),
    );
  });

  test("start/stop loop wakes on indexer events", async () => {
    const { chain, store } = await seeded();
    const { EventEmitter } = await import("node:events");
    const events = new EventEmitter();
    const got: bigint[] = [];
    const c = new Consumer(
      "loop",
      store,
      (tx) => void got.push(tx.lt),
      { addresses: [A], pollMs: 60_000 },
      { events },
    );
    c.start();
    await store.write(A, chain.txs(A));
    await store.advanceFrontier(A);
    events.emit("frontier", A, 0n);
    for (let i = 0; i < 100 && got.length < chain.txs(A).length; i++)
      await new Promise((r) => setTimeout(r, 5));
    await c.stop();
    expect(got.length).toBe(chain.txs(A).length);
  });
});

describe("Consumer (global order)", () => {
  test("merges addresses by lt and holds at the watermark", async () => {
    const { chain, store } = await seeded();
    await writeAll(store, chain, [A, B]);
    // C is complete only up to its 30th tx.
    await store.write(C, chain.txs(C).slice(0, 30));
    await store.advanceFrontier(C);
    const watermark = chain.txs(C)[29]!.lt;

    const got: IndexedTx[] = [];
    const c = new Consumer("g", store, (tx) => void got.push(tx), {
      order: "global",
      batchSize: 9,
    });
    await drain(c);
    const lts = got.map((t) => t.lt);
    expect(lts).toEqual([...lts].sort((a, b) => (a < b ? -1 : 1)));
    expect(lts.at(-1)! <= watermark).toBe(true);
    const expected = [A, B, C]
      .flatMap((a) => chain.txs(a))
      .filter((t) => t.lt <= watermark)
      .map((t) => t.lt)
      .sort((a, b) => (a < b ? -1 : 1));
    expect(lts).toEqual(expected);

    await store.write(C, chain.txs(C).slice(30));
    await store.advanceFrontier(C);
    await drain(c);
    // A and B are complete only up to their own last tx until confirmed idle at a tip.
    const minHead = [A, B].map((a) => chain.txs(a).at(-1)!.lt).reduce((x, y) => (y < x ? y : x));
    expect(got.at(-1)!.lt <= minHead).toBe(true);
    await store.markSynced([A, B, C], chain.tip().syncLt, chain.tip().utime);
    await drain(c);
    expect(got.length).toBe(chain.txs(A).length * 3);
  });

  test("synced idle addresses do not hold the watermark back", async () => {
    const { chain, store } = await seeded();
    await writeAll(store, chain, [A, B, C]);
    const tip = chain.tip();
    await store.markSynced([A, B, C], tip.syncLt, tip.utime);
    const got: bigint[] = [];
    const c = new Consumer("g", store, (tx) => void got.push(tx.lt), {
      order: "global",
      from: "now",
    });
    await drain(c);
    expect(got).toEqual([]);
    chain.grow([A], 10); // B and C idle
    await store.write(A, chain.txs(A).slice(-10));
    await store.advanceFrontier(A);
    // Only after B and C are confirmed idle at the new tip do A's new txs flow.
    await drain(c);
    expect(got).toEqual([]);
    await store.markSynced([B, C], chain.tip().syncLt, chain.tip().utime);
    await drain(c);
    expect(got).toEqual(
      chain
        .txs(A)
        .slice(-10)
        .map((t) => t.lt),
    );
  });
});

describe("Consumer + Postgres transaction", () => {
  test("handler writes and cursor commit atomically (exactly-once effects)", async () => {
    const db = new PGlite();
    const store = new PgStore(db as any);
    const { chain } = await seeded(store, 20);
    await writeAll(store, chain, [A]);
    await db.query(`create table sales (lt bigint primary key)`);

    let attempts = 0;
    const handler = async (tx: IndexedTx, ctx: { db?: unknown }) => {
      const q = ctx.db as PGlite;
      await q.query(`insert into sales (lt) values ($1)`, [tx.lt.toString()]);
      // Crash after the side effect on every 5th tx, first attempt only.
      if (Number(tx.lt % 5n) === 0 && attempts++ % 2 === 0) throw new Error("crash after write");
    };
    const c = new Consumer("sales", store, handler, {
      addresses: [A],
      retryMinMs: 0,
      retryMaxMs: 0,
    });
    for (let i = 0; i < 50; i++) await c.runOnce();
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from sales`);
    expect(rows[0]!.n).toBe(chain.txs(A).length);
    expect(await store.getCursor("sales", A)).toBe(chain.txs(A).at(-1)!.lt);
  });
});
