import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

import type { AddressState, Gap, TxId, TxRecord } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import { PgStore } from "../../src/stores/pg/pg-store";
import type { Store } from "../../src/stores/store";
import { fakeAddress, rng } from "../fixtures/fake-chain";

/**
 * Edge cases of the `Store` contract, run against every store, plus a seeded
 * differential test that drives `MemoryStore` and `PgStore` with the same random
 * operation sequence and requires identical observable results.
 *
 * Transactions here are synthetic (stores never parse the BOC), which lets the tests
 * choose any lt, including ones near the bigint column limit.
 */

const A = fakeAddress(1);
const B = fakeAddress(2);
const MAX_LT = (1n << 63n) - 1n;
const ALL = MAX_LT;

const sha = (...parts: unknown[]) => createHash("sha256").update(parts.join("|")).digest();

/**
 * A linked chain over `lts`. `salt(i)` picks the hash variant of tx `i`, so two calls
 * with salts that differ from some index on describe a fork at that index.
 */
function chainOf(
  address: string,
  lts: bigint[],
  options: { firstPrevLt?: bigint; salt?: (i: number) => string } = {},
): TxRecord[] {
  const salt = options.salt ?? (() => "");
  const firstPrevLt = options.firstPrevLt ?? 0n;
  const txs: TxRecord[] = [];
  lts.forEach((lt, i) => {
    const prev = txs[i - 1];
    txs.push({
      address,
      lt,
      hash: sha(address, lt, salt(i)),
      prevLt: prev ? prev.lt : firstPrevLt,
      prevHash: prev
        ? prev.hash
        : firstPrevLt === 0n
          ? Buffer.alloc(32)
          : sha(address, firstPrevLt, ""),
      utime: 1_700_000_000 + i,
      boc: sha("boc", address, lt, salt(i)),
    });
  });
  return txs;
}

const ltsFrom = (start: bigint, count: number, step = 10n) =>
  Array.from({ length: count }, (_, i) => start + BigInt(i) * step);

const hex = (b: Buffer) => b.toString("hex");
const id = (t: TxId | null | undefined) => (t ? { lt: t.lt, hash: hex(t.hash) } : null);
const state = (s: AddressState | null) => s && { ...s, head: id(s.head), frontier: id(s.frontier) };
const gap = (g: Gap) => ({ ...g, prevHash: hex(g.prevHash) });
const rec = (t: TxRecord) => ({
  ...t,
  hash: hex(t.hash),
  prevHash: hex(t.prevHash),
  boc: hex(t.boc),
});

type Factory = [string, () => Promise<Store>];

/** One PGlite instance; every store gets a fresh schema in it (much faster than a new instance). */
let sharedPglite: PGlite | undefined;
let schemaSeq = 0;
const pglite = async () => {
  sharedPglite ??= new PGlite();
  const store = new PgStore(sharedPglite as any, { schema: `edge_${schemaSeq++}` });
  await store.migrate();
  return store;
};

const factories: Factory[] = [
  ["MemoryStore", async () => new MemoryStore()],
  ["PgStore (PGlite)", pglite],
];

if (process.env.TEST_DATABASE_URL) {
  const { Pool } = await import("pg");
  const url = process.env.TEST_DATABASE_URL;
  const admin = new Pool({ connectionString: url });
  const schemas: string[] = [];
  let n = 0;
  afterAll(async () => {
    for (const s of schemas) await admin.query(`drop schema if exists "${s}" cascade`);
    await admin.end();
  });
  factories.push([
    "PgStore (postgres)",
    async () => {
      const pool = new Pool({ connectionString: url });
      const schema = `tw_edge_${process.pid}_${n++}`;
      schemas.push(schema);
      await pool.query(`drop schema if exists "${schema}" cascade`);
      const store = new PgStore(pool, { schema, onClose: () => pool.end() });
      await store.migrate();
      return store;
    },
  ]);
}

for (const [name, make] of factories) {
  describe(`${name} edge cases`, () => {
    let store: Store;

    beforeEach(async () => {
      store = await make();
      await store.addAddress(A, { startLt: 0n });
    });

    test("an address with nothing stored has no head, frontier, gaps or rows", async () => {
      expect(await store.findGaps(A)).toEqual([]);
      expect(await store.advanceFrontier(A)).toBeNull();
      const s = await store.getAddress(A);
      expect(s).toEqual({
        address: A,
        startLt: 0n,
        active: true,
        head: null,
        frontier: null,
        syncedLt: 0n,
        syncedUtime: null,
      });
      expect(await store.read(A, 0n, ALL, 100)).toEqual([]);
      expect(await store.getAddress(B)).toBeNull();
    });

    test("empty and fully duplicate batches insert nothing", async () => {
      const [tx] = chainOf(A, [100n]);
      expect(await store.write(A, [])).toBe(0);
      expect(await store.write(A, [tx!, tx!, tx!])).toBe(1);
      expect(await store.write(A, [tx!])).toBe(0);
      expect((await store.read(A, 0n, ALL, 10)).length).toBe(1);
    });

    test("the first write of an lt wins; a different hash at that lt is ignored", async () => {
      const original = chainOf(A, [100n, 200n]);
      const fork = chainOf(A, [100n, 200n], { salt: (i) => (i === 1 ? "fork" : "") });
      await store.write(A, original);
      expect(await store.write(A, fork)).toBe(0);
      const [, second] = await store.read(A, 0n, ALL, 10);
      expect(second!.hash.equals(original[1]!.hash)).toBe(true);
    });

    test("a single anchored transaction is the frontier", async () => {
      const [tx] = chainOf(A, [100n]);
      await store.write(A, [tx!]);
      expect(await store.findGaps(A)).toEqual([]);
      expect(id(await store.advanceFrontier(A))).toEqual(id(tx));
    });

    test("a single unanchored transaction is a gap down to startLt", async () => {
      const [tx] = chainOf(A, [100n], { firstPrevLt: 90n });
      await store.write(A, [tx!]);
      expect((await store.findGaps(A)).map(gap)).toEqual([
        { address: A, aboveLt: 100n, prevLt: 90n, prevHash: hex(tx!.prevHash), floorLt: 0n },
      ]);
      expect(await store.advanceFrontier(A)).toBeNull();
    });

    test("gap at the start: frontier stays null until the oldest tx arrives", async () => {
      const txs = chainOf(A, ltsFrom(100n, 10));
      await store.write(A, txs.slice(3));
      const gaps = await store.findGaps(A);
      expect(gaps.map((g) => [g.aboveLt, g.prevLt, g.floorLt])).toEqual([[130n, 120n, 0n]]);
      expect(await store.advanceFrontier(A)).toBeNull();
      await store.write(A, txs.slice(0, 3));
      expect((await store.advanceFrontier(A))?.lt).toBe(190n);
    });

    test("a single missing tx between two ranges: floor is its predecessor", async () => {
      const txs = chainOf(A, ltsFrom(100n, 10));
      await store.write(A, [...txs.slice(0, 4), ...txs.slice(5)]);
      expect((await store.findGaps(A)).map((g) => [g.aboveLt, g.prevLt, g.floorLt])).toEqual([
        [150n, 140n, 130n],
      ]);
      expect((await store.advanceFrontier(A))?.lt).toBe(130n);
    });

    test("missing newest transactions are not a gap (the head is just older)", async () => {
      const txs = chainOf(A, ltsFrom(100n, 10));
      await store.write(A, txs.slice(0, 6));
      expect(await store.findGaps(A)).toEqual([]);
      expect((await store.advanceFrontier(A))?.lt).toBe(150n);
      expect((await store.getAddress(A))?.head?.lt).toBe(150n);
    });

    test("every other tx missing: one gap per hole, oldest first; limit applies", async () => {
      const txs = chainOf(A, ltsFrom(100n, 10));
      await store.write(
        A,
        txs.filter((_, i) => i % 2 === 0),
      );
      const gaps = await store.findGaps(A);
      expect(gaps.map((g) => g.aboveLt)).toEqual([120n, 140n, 160n, 180n]);
      expect(gaps.map((g) => g.floorLt)).toEqual([100n, 120n, 140n, 160n]);
      expect((await store.findGaps(A, 2)).map((g) => g.aboveLt)).toEqual([120n, 140n]);
      expect(await store.findGaps(A, 0)).toEqual([]);
      expect((await store.advanceFrontier(A))?.lt).toBe(100n);
    });

    test("gaps below the stored frontier are no longer reported", async () => {
      const txs = chainOf(A, ltsFrom(100n, 10));
      await store.write(A, [...txs.slice(0, 5), ...txs.slice(7)]);
      await store.advanceFrontier(A);
      await store.write(A, txs.slice(5, 7));
      expect((await store.advanceFrontier(A))?.lt).toBe(190n);
      expect(await store.findGaps(A)).toEqual([]);
    });

    test("a prev link with the right lt but the wrong hash is a gap (fork)", async () => {
      const main = chainOf(A, ltsFrom(100n, 4));
      const fork = chainOf(A, ltsFrom(100n, 4), { salt: (i) => (i >= 2 ? "fork" : "") });
      // Store main[0..1] and fork[3], whose prev is fork[2], not main[2].
      await store.write(A, [main[0]!, main[1]!, main[2]!, fork[3]!]);
      expect(fork[3]!.prevHash.equals(main[2]!.hash)).toBe(false);
      const gaps = await store.findGaps(A);
      expect(gaps.map(gap)).toEqual([
        { address: A, aboveLt: 130n, prevLt: 120n, prevHash: hex(fork[2]!.hash), floorLt: 120n },
      ]);
      expect((await store.advanceFrontier(A))?.lt).toBe(120n);
    });

    test("advanceFrontier is idempotent and never moves backwards", async () => {
      const txs = chainOf(A, ltsFrom(100n, 5));
      await store.write(A, txs);
      const first = await store.advanceFrontier(A);
      expect(id(await store.advanceFrontier(A))).toEqual(id(first));
      // A late unanchored write above the frontier does not pull it back.
      const later = chainOf(A, [1_000n], { firstPrevLt: 900n });
      await store.write(A, later);
      expect((await store.advanceFrontier(A))?.lt).toBe(140n);
      expect((await store.getAddress(A))?.frontier?.lt).toBe(140n);
    });

    test("startLt boundaries: lt == startLt dropped, prevLt == startLt anchors", async () => {
      await store.addAddress(B, { startLt: 500n });
      const txs = chainOf(B, [490n, 500n, 501n, 510n]);
      // 490 and 500 are out of scope; 501's prev (500) == startLt, so it is anchored.
      expect(await store.write(B, txs)).toBe(2);
      expect((await store.read(B, 0n, ALL, 10)).map((t) => t.lt)).toEqual([501n, 510n]);
      expect(await store.findGaps(B)).toEqual([]);
      expect((await store.advanceFrontier(B))?.lt).toBe(510n);
    });

    test("startLt boundaries: prevLt == startLt + 1 is a gap with floor startLt", async () => {
      await store.addAddress(B, { startLt: 500n });
      const [tx] = chainOf(B, [510n], { firstPrevLt: 501n });
      await store.write(B, [tx!]);
      expect((await store.findGaps(B)).map((g) => [g.prevLt, g.floorLt])).toEqual([[501n, 500n]]);
      expect(await store.advanceFrontier(B)).toBeNull();
    });

    test("read: afterLt exclusive, uptoLt inclusive, limit honoured", async () => {
      await store.write(A, chainOf(A, ltsFrom(100n, 10)));
      const lts = async (after: bigint, upto: bigint, limit = 100) =>
        (await store.read(A, after, upto, limit)).map((t) => t.lt);
      expect(await lts(100n, 130n)).toEqual([110n, 120n, 130n]);
      expect(await lts(99n, 100n)).toEqual([100n]);
      expect(await lts(105n, 109n)).toEqual([]);
      expect(await lts(130n, 130n)).toEqual([]);
      expect(await lts(150n, 120n)).toEqual([]);
      expect(await lts(0n, ALL, 0)).toEqual([]);
      expect(await lts(0n, ALL, 1)).toEqual([100n]);
      expect(await lts(140n, ALL, 2)).toEqual([150n, 160n]);
      expect(await lts(190n, ALL)).toEqual([]);
    });

    test("read returns the stored record byte for byte", async () => {
      const txs = chainOf(A, ltsFrom(100n, 3));
      await store.write(A, [...txs].reverse());
      expect((await store.read(A, 0n, ALL, 10)).map(rec)).toEqual(txs.map(rec));
    });

    test("lts up to 2^63 - 1 round-trip exactly", async () => {
      await store.addAddress(B, { startLt: MAX_LT - 100n, syncedLt: MAX_LT - 50n, syncedUtime: 7 });
      const txs = chainOf(B, [MAX_LT - 20n, MAX_LT - 1n, MAX_LT], { firstPrevLt: MAX_LT - 100n });
      expect(await store.write(B, txs)).toBe(3);
      expect((await store.advanceFrontier(B))?.lt).toBe(MAX_LT);
      const s = await store.getAddress(B);
      expect([s?.startLt, s?.head?.lt, s?.frontier?.lt, s?.syncedLt]).toEqual([
        MAX_LT - 100n,
        MAX_LT,
        MAX_LT,
        MAX_LT - 50n,
      ]);
      expect((await store.read(B, MAX_LT - 2n, MAX_LT, 10)).map((t) => t.lt)).toEqual([
        MAX_LT - 1n,
        MAX_LT,
      ]);
      await store.setCursor("c", B, MAX_LT);
      expect(await store.getCursor("c", B)).toBe(MAX_LT);
      await store.markSynced([B], MAX_LT, 9);
      expect((await store.getAddress(B))?.syncedLt).toBe(MAX_LT);
    });

    test("addresses are opaque, case-sensitive keys", async () => {
      const lower = fakeAddress(0xabc);
      const upper = lower.toUpperCase();
      await store.addAddress(lower, { startLt: 0n });
      await store.addAddress(upper, { startLt: 5n });
      await store.write(lower, chainOf(lower, [100n]));
      expect((await store.getAddress(upper))?.startLt).toBe(5n);
      expect((await store.getAddress(upper))?.head).toBeNull();
      expect((await store.getAddress(lower))?.head?.lt).toBe(100n);
      expect((await store.listAddresses()).map((s) => s.address)).toEqual([A, lower, upper]);
    });

    test("syncedLt from addAddress, and markSynced edge cases", async () => {
      await store.addAddress(B, { startLt: 0n, syncedLt: 1_000n, syncedUtime: 11 });
      expect((await store.getAddress(B))?.syncedLt).toBe(1_000n);
      await store.markSynced([], 5_000n, 1);
      await store.markSynced([fakeAddress(99)], 5_000n, 1);
      // Not higher: no change, utime kept.
      await store.markSynced([B], 1_000n, 12);
      expect((await store.getAddress(B))?.syncedUtime).toBe(11);
      // Head stored but frontier not advanced yet: not complete.
      await store.write(B, chainOf(B, [100n]));
      await store.markSynced([B], 2_000n, 13);
      expect((await store.getAddress(B))?.syncedLt).toBe(1_000n);
      await store.advanceFrontier(B);
      await store.markSynced([B], 2_000n, 13);
      expect((await store.getAddress(B))?.syncedUtime).toBe(13);
    });

    test("remove: unknown addresses are a no-op; inactive addresses still read", async () => {
      await store.removeAddress(fakeAddress(42));
      await store.removeAddress(fakeAddress(42), { purge: true });
      await store.write(A, chainOf(A, ltsFrom(100n, 3)));
      await store.advanceFrontier(A);
      await store.setCursor("c", A, 110n);
      await store.removeAddress(A);
      await store.removeAddress(A);
      const s = await store.getAddress(A);
      expect([s?.active, s?.frontier?.lt]).toEqual([false, 120n]);
      expect(await store.getCursor("c", A)).toBe(110n);
      expect((await store.read(A, 0n, ALL, 10)).length).toBe(3);
      expect(await store.listAddresses()).toEqual([]);
    });

    test("purge then re-add starts over with the new startLt", async () => {
      await store.addAddress(B, { startLt: 0n });
      await store.write(A, chainOf(A, ltsFrom(100n, 3)));
      await store.advanceFrontier(A);
      await store.setCursor("c1", A, 110n);
      await store.setCursor("c2", A, 100n);
      await store.setCursor("c1", B, 1n);
      await store.removeAddress(A, { purge: true });
      await store.addAddress(A, { startLt: 105n });
      const s = await store.getAddress(A);
      expect([s?.startLt, s?.head, s?.frontier, s?.active]).toEqual([105n, null, null, true]);
      expect(await store.getCursor("c1", A)).toBeNull();
      expect(await store.getCursor("c2", A)).toBeNull();
      expect(await store.getCursor("c1", B)).toBe(1n);
      expect((await store.listAddresses()).map((x) => x.address)).toEqual([B, A]);
      expect(await store.write(A, chainOf(A, ltsFrom(100n, 3)))).toBe(2);
    });

    test("cursors: odd consumer names, moving backwards, independent per address", async () => {
      await store.addAddress(B, { startLt: 0n });
      const names = ["a|b", `x|${A}`, "名前", "", "'; drop table cursors; --"];
      for (const [i, n] of names.entries()) await store.setCursor(n, A, BigInt(i + 1));
      for (const [i, n] of names.entries()) expect(await store.getCursor(n, A)).toBe(BigInt(i + 1));
      for (const n of names) expect(await store.getCursor(n, B)).toBeNull();
      await store.setCursor("a|b", A, 0n);
      expect(await store.getCursor("a|b", A)).toBe(0n);
      await store.removeAddress(B, { purge: true });
      expect(await store.getCursor(`x|${A}`, A)).toBe(2n);
    });
  });
}

describe("MemoryStore specifics", () => {
  test("migrate/close are no-ops, size counts every stored tx, purge shrinks it", async () => {
    const store = new MemoryStore();
    await store.migrate();
    await store.addAddress(A, { startLt: 0n });
    await store.addAddress(B, { startLt: 0n });
    await store.write(A, chainOf(A, ltsFrom(100n, 3)));
    await store.write(B, chainOf(B, ltsFrom(100n, 2)));
    expect(store.size).toBe(5);
    await store.removeAddress(A, { purge: true });
    expect(store.size).toBe(2);
    await store.close();
  });

  test("operations on an address that was never added throw", async () => {
    // PgStore treats these as no-ops instead (see pg-store.test.ts).
    const store = new MemoryStore();
    await expect(store.write(A, [])).rejects.toThrow(/unknown address/);
    await expect(store.findGaps(A)).rejects.toThrow(/unknown address/);
    await expect(store.advanceFrontier(A)).rejects.toThrow(/unknown address/);
    await expect(store.read(A, 0n, ALL, 1)).rejects.toThrow(/unknown address/);
  });
});

/** Seeded random operation sequences, applied to two stores side by side. */
describe("MemoryStore and PgStore agree on random operation sequences", () => {
  const addresses = [fakeAddress(11), fakeAddress(12), fakeAddress(13)];
  const consumers = ["c1", "c2"];

  /** Each address has a main chain and a fork diverging at index 8. */
  function universe(r: () => number) {
    const chains = new Map<string, TxRecord[][]>();
    for (const address of addresses) {
      let lt = 1_000n + BigInt(Math.floor(r() * 1_000));
      const lts: bigint[] = [];
      for (let i = 0; i < 30; i++) {
        lts.push(lt);
        lt += 1n + BigInt(Math.floor(r() * 50));
      }
      chains.set(address, [
        chainOf(address, lts),
        chainOf(address, lts, { salt: (i) => (i >= 8 ? "fork" : "") }),
      ]);
    }
    return chains;
  }

  async function run(seed: number, other: Store) {
    const r = rng(seed);
    const pick = <T>(items: T[]) => items[Math.floor(r() * items.length)]!;
    const chains = universe(r);
    const mem = new MemoryStore();
    const known = new Set<string>();
    const log: string[] = [];
    /** Sanity check that the sequence actually exercised gaps and frontiers. */
    let gapsSeen = 0;
    let frontiersSeen = 0;

    const both = async <T>(
      label: string,
      op: (s: Store) => Promise<T>,
      norm: (v: T) => unknown,
    ) => {
      const [x, y] = await Promise.all([op(mem), op(other)]);
      log.push(label);
      expect({ label, value: norm(y) }).toEqual({ label, value: norm(x) });
    };

    for (let step = 0; step < 400; step++) {
      const address = pick(addresses);
      const roll = r();
      if (!known.has(address) || roll < 0.04) {
        const startLt = r() < 0.5 ? 0n : chains.get(address)![0]![Math.floor(r() * 10)]!.lt;
        await both(
          `add ${address} ${startLt}`,
          (s) => s.addAddress(address, { startLt }),
          () => null,
        );
        known.add(address);
        continue;
      }
      if (roll < 0.45) {
        const variant = chains.get(address)![r() < 0.1 ? 1 : 0]!;
        const from = Math.floor(r() * variant.length);
        const batch = variant.slice(from, from + 1 + Math.floor(r() * 6));
        if (r() < 0.3) batch.reverse();
        if (r() < 0.2 && batch[0]) batch.push(batch[0]);
        await both(
          `write ${address} @${from}`,
          (s) => s.write(address, batch),
          (n) => n,
        );
      } else if (roll < 0.6) {
        await both(
          `advance ${address}`,
          (s) => s.advanceFrontier(address),
          (f) => {
            if (f) frontiersSeen++;
            return id(f);
          },
        );
      } else if (roll < 0.7) {
        const limit = Math.floor(r() * 4);
        await both(
          `gaps ${address}`,
          (s) => s.findGaps(address, limit || undefined),
          (g) => {
            if (g.length > 0) gapsSeen++;
            return g.map(gap);
          },
        );
      } else if (roll < 0.75) {
        const subset = addresses.filter((a) => known.has(a) && r() < 0.7);
        const lt = BigInt(Math.floor(r() * 3_000));
        await both(
          `synced ${lt}`,
          (s) => s.markSynced(subset, lt, step),
          () => null,
        );
      } else if (roll < 0.83) {
        const lts = chains.get(address)![0]!.map((t) => t.lt);
        const after = r() < 0.2 ? 0n : pick(lts) - BigInt(Math.floor(r() * 2));
        const upto = r() < 0.2 ? ALL : pick(lts);
        const limit = Math.floor(r() * 8);
        await both(
          `read ${address} ${after}..${upto}/${limit}`,
          (s) => s.read(address, after, upto, limit),
          (rows) => rows.map(rec),
        );
      } else if (roll < 0.9) {
        const consumer = pick(consumers);
        const lt = BigInt(Math.floor(r() * 3_000));
        await both(
          `cursor ${consumer}`,
          (s) => s.setCursor(consumer, address, lt),
          () => null,
        );
      } else if (roll < 0.93) {
        const purge = r() < 0.4;
        await both(
          `remove ${address} ${purge}`,
          (s) => s.removeAddress(address, { purge }),
          () => null,
        );
        if (purge) known.delete(address);
      }
      // Compare full observable state every step.
      await both(
        "list",
        (s) => s.listAddresses({ includeInactive: true }),
        (list) => list.map(state),
      );
      for (const a of addresses) {
        await both(`get ${a}`, (s) => s.getAddress(a), state);
        if (!known.has(a)) continue;
        for (const c of consumers)
          await both(
            `cursor? ${c}`,
            (s) => s.getCursor(c, a),
            (v) => v,
          );
      }
    }
    return { steps: log.length, gapsSeen, frontiersSeen };
  }

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`seed ${seed}`, async () => {
      const pg = await pglite();
      const { steps, gapsSeen, frontiersSeen } = await run(seed, pg);
      expect(steps).toBeGreaterThan(400);
      expect(gapsSeen).toBeGreaterThan(0);
      expect(frontiersSeen).toBeGreaterThan(0);
    }, 30_000);
  }
});
