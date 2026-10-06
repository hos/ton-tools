import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { Consumer } from "../../src/consumer/consumer";
import type { HandlerContext, ProcessOptions, TxHandler } from "../../src/consumer/types";
import type { IndexedTx } from "../../src/core/types";
import type { PgDatabase, PgQueryable } from "../../src/stores/pg/database";
import { PgStore } from "../../src/stores/pg/pg-store";
import { FakeChain, fakeAddress } from "../fixtures/fake-chain";

/**
 * Exactly-once effects with `PgStore`: a handler's writes through `ctx.db` commit in
 * the same database transaction as the consumer cursor, and roll back with it.
 */

const A = fakeAddress(1);
const B = fakeAddress(2);
const FAST_RETRY: ProcessOptions = { retryMinMs: 1, retryMaxMs: 1 };

/** Opens a database handle for a "process"; calling it again simulates a restart. */
type Target = [string, () => Promise<{ open: () => PgDatabase; schema: string }>];

const shared = new PGlite();
let seq = 0;
const targets: Target[] = [
  [
    "PGlite",
    async () => ({ open: () => shared as unknown as PgDatabase, schema: `atom_${seq++}` }),
  ],
];

if (process.env.TEST_DATABASE_URL) {
  const { Pool } = await import("pg");
  const { poolDatabase } = await import("../../src/stores/pg/database");
  const url = process.env.TEST_DATABASE_URL;
  const pools: InstanceType<typeof Pool>[] = [];
  const schemas: string[] = [];
  afterAll(async () => {
    const admin = new Pool({ connectionString: url });
    for (const s of schemas) await admin.query(`drop schema if exists "${s}" cascade`);
    await admin.end();
    await Promise.all(pools.map((p) => p.end()));
  });
  targets.push([
    "postgres",
    async () => {
      const schema = `tw_atom_${process.pid}_${seq++}`;
      schemas.push(schema);
      return {
        schema,
        // Each "process" gets its own pool, like a restarted service would.
        open: () => {
          const pool = new Pool({ connectionString: url });
          pools.push(pool);
          return poolDatabase(pool);
        },
      };
    },
  ]);
}

/** Runs rounds until nothing more is delivered. */
async function drain(c: Consumer) {
  while ((await c.runOnce()) > 0) {}
}

for (const [name, target] of targets) {
  describe(`Consumer + PgStore atomicity (${name})`, () => {
    let open: () => PgDatabase;
    let schema: string;
    let store: PgStore;
    let chain: FakeChain;

    const effects = async (address?: string) => {
      const { rows } = await store.db.query(
        `select lt::text from "${schema}".effects ${address ? "where address = $1" : ""} order by lt`,
        address ? [address] : [],
      );
      return rows.map((r) => BigInt((r as { lt: string }).lt));
    };
    const lts = (address: string) => chain.txs(address).map((t) => t.lt);

    /** Records the effect of `tx` through the consumer's transaction. */
    const record = async (tx: IndexedTx, ctx: HandlerContext) => {
      await (ctx.db as PgQueryable).query(
        `insert into "${schema}".effects (lt, address) values ($1, $2)`,
        [tx.lt.toString(), tx.address],
      );
    };

    beforeEach(async () => {
      ({ open, schema } = await target());
      store = new PgStore(open(), { schema });
      await store.migrate();
      await store.db.query(
        `create table "${schema}".effects (lt bigint primary key, address text not null)`,
      );
      chain = new FakeChain();
      chain.grow([A, B], 12, 2);
      for (const address of [A, B]) {
        await store.addAddress(address, { startLt: 0n });
        await store.write(address, chain.txs(address));
        await store.advanceFrontier(address);
      }
    });

    test("handler writes commit together with the cursor", async () => {
      const contexts: unknown[] = [];
      const c = new Consumer("app", store, async (tx, ctx) => {
        contexts.push(ctx.db);
        await record(tx, ctx);
      });
      await drain(c);
      expect(await effects(A)).toEqual(lts(A));
      expect(await effects(B)).toEqual(lts(B));
      expect(await store.getCursor("app", A)).toBe(lts(A).at(-1)!);
      expect(await store.getCursor("app", B)).toBe(lts(B).at(-1)!);
      // Every delivery ran inside a transaction client, not on the pool itself.
      expect(contexts.every((db) => db != null && db !== store.db)).toBe(true);
    });

    test("a handler that throws after writing leaves neither effect nor cursor", async () => {
      const failAt = lts(A)[5]!;
      let failures = 0;
      const c = new Consumer(
        "app",
        store,
        async (tx, ctx) => {
          await record(tx, ctx);
          if (tx.lt === failAt && failures++ === 0) throw new Error("downstream unavailable");
        },
        { ...FAST_RETRY, addresses: [A] },
      );
      await c.runOnce();
      expect(await effects(A)).toEqual(lts(A).slice(0, 5));
      expect(await store.getCursor("app", A)).toBe(lts(A)[4]!);
      expect(c.status().addresses[0]).toMatchObject({ failures: 1 });

      await Bun.sleep(5);
      await drain(c);
      expect(await effects(A)).toEqual(lts(A));
      expect(await store.getCursor("app", A)).toBe(lts(A).at(-1)!);
      expect(failures).toBe(2);
    });

    test("a failing SQL statement in the handler rolls back cleanly", async () => {
      // Pre-existing effect row: the handler's insert hits the primary key.
      const clash = lts(A)[3]!;
      await store.db.query(`insert into "${schema}".effects values ($1, 'other')`, [
        clash.toString(),
      ]);
      const c = new Consumer("app", store, record, { ...FAST_RETRY, addresses: [A] });
      await c.runOnce();
      expect(await store.getCursor("app", A)).toBe(lts(A)[2]!);
      expect((await effects(A)).length).toBe(3);

      await store.db.query(`delete from "${schema}".effects where address = 'other'`);
      await Bun.sleep(5);
      await drain(c);
      expect(await effects(A)).toEqual(lts(A));
    });

    test("a failing cursor write rolls back the handler's effects", async () => {
      const failAt = lts(A)[7]!;
      await store.db.query(`create function "${schema}".refuse() returns trigger as $$
        begin
          if new.lt = ${failAt} then raise exception 'cursor write refused'; end if;
          return new;
        end $$ language plpgsql`);
      await store.db.query(`create trigger refuse before insert or update on "${schema}".cursors
        for each row execute function "${schema}".refuse()`);
      const c = new Consumer("app", store, record, { ...FAST_RETRY, addresses: [A] });
      await c.runOnce();
      expect(await effects(A)).toEqual(lts(A).slice(0, 7));
      expect(await store.getCursor("app", A)).toBe(lts(A)[6]!);

      await store.db.query(`drop trigger refuse on "${schema}".cursors`);
      await Bun.sleep(5);
      await drain(c);
      expect(await effects(A)).toEqual(lts(A));
    });

    test("restart after a failure resumes exactly where the last commit was", async () => {
      const failAt = lts(B)[4]!;
      const first = new Consumer(
        "app",
        store,
        async (tx, ctx) => {
          await record(tx, ctx);
          if (tx.lt === failAt) throw new Error("crash");
        },
        FAST_RETRY,
      );
      await first.runOnce();
      await first.stop();
      expect(await effects(B)).toEqual(lts(B).slice(0, 4));
      expect(await effects(A)).toEqual(lts(A));

      // New process: fresh store over a fresh connection, fresh consumer state.
      const restarted = new PgStore(open(), { schema });
      await restarted.migrate();
      const seen: bigint[] = [];
      const second = new Consumer("app", restarted, async (tx, ctx) => {
        seen.push(tx.lt);
        await record(tx, ctx);
      });
      await drain(second);
      expect(seen).toEqual(lts(B).slice(4));
      expect(await effects()).toEqual([...lts(A), ...lts(B)].sort((x, y) => (x < y ? -1 : 1)));
    });

    test("global order: a failure halts the stream and commits nothing of the failing tx", async () => {
      const all = [...lts(A), ...lts(B)].sort((x, y) => (x < y ? -1 : 1));
      const failAt = all[9]!;
      let failed = false;
      const c = new Consumer(
        "global",
        store,
        async (tx, ctx) => {
          await record(tx, ctx);
          if (tx.lt === failAt && !failed) {
            failed = true;
            throw new Error("once");
          }
        },
        { ...FAST_RETRY, order: "global" },
      );
      // Without markSynced the watermark is each address's frontier, i.e. min of the two heads.
      await c.runOnce();
      expect(await effects()).toEqual(all.slice(0, 9));
      await Bun.sleep(5);
      await drain(c);
      const lastA = lts(A).at(-1)!;
      const lastB = lts(B).at(-1)!;
      const watermark = lastA < lastB ? lastA : lastB;
      expect(await effects()).toEqual(all.filter((lt) => lt <= watermark));
    });

    test("transactional: false gives no ctx.db and commits effects at least once", async () => {
      await store.db.query(`create table "${schema}".log (lt bigint not null)`);
      const failAt = lts(A)[2]!;
      let failures = 0;
      const handler: TxHandler = async (tx, ctx) => {
        expect(ctx.db).toBeUndefined();
        await store.db.query(`insert into "${schema}".log values ($1)`, [tx.lt.toString()]);
        if (tx.lt === failAt && failures++ === 0) throw new Error("once");
      };
      const c = new Consumer("plain", store, handler, {
        ...FAST_RETRY,
        addresses: [A],
        transactional: false,
      });
      await c.runOnce();
      await Bun.sleep(5);
      await drain(c);
      const { rows } = await store.db.query(
        `select lt::text, count(*)::int as n from "${schema}".log group by lt order by lt`,
      );
      const counts = rows as { lt: string; n: number }[];
      expect(counts.map((r) => BigInt(r.lt))).toEqual(lts(A));
      expect(counts.find((r) => BigInt(r.lt) === failAt)?.n).toBe(2);
      expect(counts.filter((r) => r.n !== 1).length).toBe(1);
    });
  });
}
