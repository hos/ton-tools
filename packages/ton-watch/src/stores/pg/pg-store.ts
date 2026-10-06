import type { Pool } from "pg";

import type { AddressState, Gap, TxId, TxRecord } from "../../types";
import type { AddAddressOptions, Store } from "../store";
import { migrations } from "./migrations";

/** Anything that can run a parameterized query: `pg.Pool`, `pg.PoolClient`, PGlite. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** A queryable that can also run a callback inside a transaction (PGlite has this natively). */
export interface PgDatabase extends PgQueryable {
  transaction<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>;
}

/** Adapts a `pg.Pool` to `PgDatabase`. */
export function poolDatabase(pool: Pool): PgDatabase {
  return {
    query: (text, params) => pool.query(text, params as any[]),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export interface PgStoreOptions {
  /** Postgres schema holding the tables. Created if missing. Default `ton_watch`. */
  schema?: string;
  /** Called by `close()`, e.g. `() => pool.end()`. Not called by default: the pool is yours. */
  onClose?: () => Promise<void>;
}

const buf = (v: unknown): Buffer =>
  Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array);
const big = (v: unknown): bigint => BigInt(v as string);
const hex = (b: Buffer) => b.toString("hex");

/** Postgres store, the reference implementation. Works with `pg` and PGlite. */
export class PgStore implements Store {
  readonly db: PgDatabase;
  readonly schema: string;
  private readonly S: string;
  private readonly onClose?: () => Promise<void>;

  constructor(db: Pool | PgDatabase, options: PgStoreOptions = {}) {
    this.db = "transaction" in db ? db : poolDatabase(db);
    this.schema = options.schema ?? "ton_watch";
    if (!/^[a-z_][a-z0-9_]*$/.test(this.schema)) {
      throw new Error(`invalid schema name: ${this.schema}`);
    }
    this.S = `"${this.schema}"`;
    this.onClose = options.onClose;
  }

  private q(text: string, params?: unknown[]) {
    return this.db.query(text.replaceAll("$S", this.S), params);
  }

  async migrate() {
    await this.q(`create schema if not exists $S`);
    await this.q(`create table if not exists $S.schema_migrations (
      version integer primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )`);
    await this.db.transaction(async (tx) => {
      const run = (sql: string, params?: unknown[]) =>
        tx.query(sql.replaceAll("$S", this.S), params);
      await run(`select pg_advisory_xact_lock(hashtext($1))`, [`ton_watch:${this.schema}`]);
      const { rows } = await run(`select version from $S.schema_migrations`);
      const applied = new Set(rows.map((r) => Number(r.version)));
      for (const m of migrations) {
        if (applied.has(m.version)) continue;
        for (const statement of m.up) await run(statement);
        await run(`insert into $S.schema_migrations (version, name) values ($1, $2)`, [
          m.version,
          m.name,
        ]);
      }
    });
  }

  async close() {
    await this.onClose?.();
  }

  async addAddress(address: string, o: AddAddressOptions) {
    await this.q(
      `insert into $S.addresses (address, start_lt, synced_lt, synced_utime)
       values ($1, $2, $3, $4)
       on conflict (address) do update set active = true, updated_at = now()`,
      [address, o.startLt.toString(), (o.syncedLt ?? 0n).toString(), o.syncedUtime ?? null]
    );
  }

  async removeAddress(address: string, o?: { purge?: boolean }) {
    if (o?.purge) {
      await this.q(`delete from $S.addresses where address = $1`, [address]);
    } else {
      await this.q(
        `update $S.addresses set active = false, updated_at = now() where address = $1`,
        [address]
      );
    }
  }

  private static selectState = `
    select a.address, a.start_lt::text, a.active, a.frontier_lt::text, a.frontier_hash,
      a.synced_lt::text, a.synced_utime, h.lt::text as head_lt, h.hash as head_hash
    from $S.addresses a
    left join lateral (
      select lt, hash from $S.transactions t where t.address_id = a.id order by lt desc limit 1
    ) h on true`;

  private static toState(r: any): AddressState {
    return {
      address: r.address,
      startLt: big(r.start_lt),
      active: r.active,
      head: r.head_lt != null ? { lt: big(r.head_lt), hash: buf(r.head_hash) } : null,
      frontier:
        r.frontier_lt != null ? { lt: big(r.frontier_lt), hash: buf(r.frontier_hash) } : null,
      syncedLt: big(r.synced_lt),
      syncedUtime: r.synced_utime ?? null,
    };
  }

  async getAddress(address: string) {
    const { rows } = await this.q(`${PgStore.selectState} where a.address = $1`, [address]);
    return rows[0] ? PgStore.toState(rows[0]) : null;
  }

  async listAddresses(o?: { includeInactive?: boolean }) {
    const { rows } = await this.q(
      `${PgStore.selectState} where a.active or $1 order by a.id`,
      [!!o?.includeInactive]
    );
    return rows.map(PgStore.toState);
  }

  async write(address: string, txs: TxRecord[]) {
    if (txs.length === 0) return 0;
    const { rows } = await this.q(
      `with a as (select id, start_lt from $S.addresses where address = $1)
       insert into $S.transactions (address_id, lt, hash, prev_lt, prev_hash, utime, boc)
       select a.id, u.lt, decode(u.hash, 'hex'), u.prev_lt, decode(u.prev_hash, 'hex'), u.utime,
         decode(u.boc, 'hex')
       from a, unnest($2::bigint[], $3::text[], $4::bigint[], $5::text[], $6::integer[], $7::text[])
         as u(lt, hash, prev_lt, prev_hash, utime, boc)
       where u.lt > a.start_lt
       on conflict do nothing
       returning lt`,
      [
        address,
        txs.map((t) => t.lt.toString()),
        txs.map((t) => hex(t.hash)),
        txs.map((t) => t.prevLt.toString()),
        txs.map((t) => hex(t.prevHash)),
        txs.map((t) => t.utime),
        txs.map((t) => hex(t.boc)),
      ]
    );
    return rows.length;
  }

  /** Stored transactions above the frontier whose prev link is not satisfied. */
  private static unlinked = `
    from a join $S.transactions t on t.address_id = a.id and t.lt > coalesce(a.frontier_lt, a.start_lt)
    where t.prev_lt > a.start_lt
      and not exists (
        select 1 from $S.transactions p
        where p.address_id = a.id and p.lt = t.prev_lt and p.hash = t.prev_hash
      )`;

  async findGaps(address: string, limit = 100): Promise<Gap[]> {
    const { rows } = await this.q(
      `with a as (select id, start_lt, frontier_lt from $S.addresses where address = $1)
       select t.lt::text, t.prev_lt::text, t.prev_hash,
         coalesce(
           (select max(q.lt) from $S.transactions q where q.address_id = a.id and q.lt < t.lt),
           a.start_lt
         )::text as floor_lt
       ${PgStore.unlinked}
       order by t.lt asc
       limit $2`,
      [address, limit]
    );
    return rows.map((r) => ({
      address,
      aboveLt: big(r.lt),
      prevLt: big(r.prev_lt),
      prevHash: buf(r.prev_hash),
      floorLt: big(r.floor_lt),
    }));
  }

  async advanceFrontier(address: string): Promise<TxId | null> {
    const { rows } = await this.q(
      `with a as (select id, start_lt, frontier_lt from $S.addresses where address = $1),
       gap as (select t.lt ${PgStore.unlinked} order by t.lt asc limit 1),
       f as (
         select t.lt, t.hash from a join $S.transactions t on t.address_id = a.id
         where t.lt > coalesce(a.frontier_lt, a.start_lt)
           and (not exists (select 1 from gap) or t.lt < (select lt from gap))
         order by t.lt desc limit 1
       ),
       upd as (
         update $S.addresses s set frontier_lt = f.lt, frontier_hash = f.hash, updated_at = now()
         from f
         where s.id = (select id from a) and (s.frontier_lt is null or s.frontier_lt < f.lt)
         returning s.frontier_lt, s.frontier_hash
       )
       select coalesce((select frontier_lt from upd), (select frontier_lt from a))::text as lt,
         coalesce((select frontier_hash from upd),
           (select frontier_hash from $S.addresses where id = (select id from a))) as hash`,
      [address]
    );
    const r = rows[0];
    return r?.lt != null ? { lt: big(r.lt), hash: buf(r.hash) } : null;
  }

  async markSynced(addresses: string[], syncLt: bigint, utime: number) {
    if (addresses.length === 0) return;
    await this.q(
      `update $S.addresses a set synced_lt = $2, synced_utime = $3, updated_at = now()
       where a.address = any($1::text[]) and a.synced_lt < $2
         and a.frontier_lt is not distinct from
           (select max(t.lt) from $S.transactions t where t.address_id = a.id)`,
      [addresses, syncLt.toString(), utime]
    );
  }

  async read(address: string, afterLt: bigint, uptoLt: bigint, limit: number) {
    const { rows } = await this.q(
      `select t.lt::text, t.hash, t.prev_lt::text, t.prev_hash, t.utime, t.boc
       from $S.transactions t join $S.addresses a on a.id = t.address_id
       where a.address = $1 and t.lt > $2 and t.lt <= $3
       order by t.lt asc
       limit $4`,
      [address, afterLt.toString(), uptoLt.toString(), limit]
    );
    return rows.map(
      (r): TxRecord => ({
        address,
        lt: big(r.lt),
        hash: buf(r.hash),
        prevLt: big(r.prev_lt),
        prevHash: buf(r.prev_hash),
        utime: Number(r.utime),
        boc: buf(r.boc),
      })
    );
  }

  async getCursor(consumer: string, address: string) {
    const { rows } = await this.q(
      `select c.lt::text from $S.cursors c join $S.addresses a on a.id = c.address_id
       where c.consumer = $1 and a.address = $2`,
      [consumer, address]
    );
    return rows[0] ? big(rows[0].lt) : null;
  }

  async setCursor(consumer: string, address: string, lt: bigint) {
    await this.q(
      `insert into $S.cursors (consumer, address_id, lt)
       select $1, id, $3 from $S.addresses where address = $2
       on conflict (consumer, address_id) do update set lt = excluded.lt, updated_at = now()`,
      [consumer, address, lt.toString()]
    );
  }

  async transaction<T>(fn: (tx: { store: Store; db: unknown }) => Promise<T>): Promise<T> {
    return this.db.transaction((q) => {
      const inner = new PgStore(
        { query: (t, p) => q.query(t, p), transaction: (f) => f(q) },
        { schema: this.schema }
      );
      return fn({ store: inner, db: q });
    });
  }
}
