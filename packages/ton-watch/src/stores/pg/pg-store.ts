import type { Pool } from "pg";

import type { AddressState, Gap, TxId, TxRecord } from "../../core/types";
import type { AddAddressOptions, Store, StoreTransaction } from "../store";
import { type PgDatabase, type PgQueryable, poolDatabase } from "./database";
import { migrations, SCHEMA_PLACEHOLDER } from "./migrations";

export interface PgStoreOptions {
  /** Postgres schema holding the tables. Created if missing. Default `ton_watch`. */
  schema?: string;
  /** Called by `close()`, e.g. `() => pool.end()`. Not called by default: the pool is yours. */
  onClose?: () => Promise<void>;
}

const DEFAULT_SCHEMA = "ton_watch";
const DEFAULT_GAP_LIMIT = 100;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
/** Postgres silently truncates longer identifiers (NAMEDATALEN - 1). */
const MAX_SCHEMA_LENGTH = 63;

/** `bytea` comes back as a `Buffer` from `pg` and as a `Uint8Array` from PGlite. */
type Bytes = Uint8Array;

interface AddressRow {
  address: string;
  start_lt: string;
  active: boolean;
  frontier_lt: string | null;
  frontier_hash: Bytes | null;
  synced_lt: string;
  synced_utime: string | null;
  head_lt: string | null;
  head_hash: Bytes | null;
}

interface GapRow {
  lt: string;
  prev_lt: string;
  prev_hash: Bytes;
  floor_lt: string;
}

interface TxIdRow {
  lt: string | null;
  hash: Bytes | null;
}

interface TransactionRow {
  lt: string;
  hash: Bytes;
  prev_lt: string;
  prev_hash: Bytes;
  utime: string;
  boc: Bytes;
}

const toBuffer = (bytes: Bytes): Buffer => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
const toHex = (bytes: Buffer) => bytes.toString("hex");

function txIdFrom(lt: string | null, hash: Bytes | null): TxId | null {
  return lt != null && hash != null ? { lt: BigInt(lt), hash: toBuffer(hash) } : null;
}

function addressStateFrom(row: AddressRow): AddressState {
  return {
    address: row.address,
    startLt: BigInt(row.start_lt),
    active: row.active,
    head: txIdFrom(row.head_lt, row.head_hash),
    frontier: txIdFrom(row.frontier_lt, row.frontier_hash),
    syncedLt: BigInt(row.synced_lt),
    syncedUtime: row.synced_utime === null ? null : Number(row.synced_utime),
  };
}

/** Address state plus its head: the newest stored transaction. */
const SELECT_ADDRESS_STATE = `
  select a.address, a.start_lt::text, a.active, a.frontier_lt::text, a.frontier_hash,
    a.synced_lt::text, a.synced_utime::text, h.lt::text as head_lt, h.hash as head_hash
  from $S.addresses a
  left join lateral (
    select lt, hash from $S.transactions t where t.address_id = a.id order by lt desc limit 1
  ) h on true`;

/** Stored transactions above the frontier whose prev link is not satisfied (needs CTE `a`). */
const FROM_UNLINKED = `
  from a join $S.transactions t on t.address_id = a.id and t.lt > coalesce(a.frontier_lt, a.start_lt)
  where t.prev_lt > a.start_lt
    and not exists (
      select 1 from $S.transactions p
      where p.address_id = a.id and p.lt = t.prev_lt and p.hash = t.prev_hash
    )`;

/** Postgres store, the reference implementation. Works with `pg` and PGlite. */
export class PgStore implements Store {
  readonly db: PgDatabase;
  readonly schema: string;
  private readonly quotedSchema: string;
  private readonly onClose?: () => Promise<void>;

  constructor(db: Pool | PgDatabase, options: PgStoreOptions = {}) {
    this.db = "transaction" in db ? db : poolDatabase(db);
    this.schema = options.schema ?? DEFAULT_SCHEMA;
    if (!SCHEMA_NAME.test(this.schema) || this.schema.length > MAX_SCHEMA_LENGTH) {
      throw new Error(
        `invalid schema name: ${this.schema} (lowercase letters, digits and _, at most ${MAX_SCHEMA_LENGTH})`,
      );
    }
    this.quotedSchema = `"${this.schema}"`;
    this.onClose = options.onClose;
  }

  /**
   * Creates the schema and applies pending migrations. Safe to run from several
   * processes at once: everything happens under one advisory lock, because
   * `create ... if not exists` alone races on a fresh database.
   */
  async migrate(): Promise<void> {
    await this.db.transaction(async (tx) => {
      const run = <Row>(sql: string, params?: unknown[]) => this.query<Row>(sql, params, tx);
      await run(`select pg_advisory_xact_lock(hashtext($1))`, [`ton_watch:${this.schema}`]);
      await run(`create schema if not exists $S`);
      await run(`create table if not exists $S.schema_migrations (
        version integer primary key,
        name text not null,
        applied_at timestamptz not null default now()
      )`);
      const applied = await run<{ version: number }>(`select version from $S.schema_migrations`);
      const appliedVersions = new Set(applied.map((row) => Number(row.version)));
      for (const migration of migrations) {
        if (appliedVersions.has(migration.version)) continue;
        for (const statement of migration.up) await run(statement);
        await run(`insert into $S.schema_migrations (version, name) values ($1, $2)`, [
          migration.version,
          migration.name,
        ]);
      }
    });
  }

  async close(): Promise<void> {
    await this.onClose?.();
  }

  async addAddress(address: string, options: AddAddressOptions): Promise<void> {
    await this.query(
      `insert into $S.addresses (address, start_lt, synced_lt, synced_utime)
       values ($1, $2, $3, $4)
       on conflict (address) do update set active = true, updated_at = now()`,
      [
        address,
        options.startLt.toString(),
        (options.syncedLt ?? 0n).toString(),
        options.syncedUtime ?? null,
      ],
    );
  }

  async removeAddress(address: string, options?: { purge?: boolean }): Promise<void> {
    if (options?.purge) {
      await this.query(`delete from $S.addresses where address = $1`, [address]);
    } else {
      await this.query(
        `update $S.addresses set active = false, updated_at = now() where address = $1`,
        [address],
      );
    }
  }

  async getAddress(address: string): Promise<AddressState | null> {
    const [row] = await this.query<AddressRow>(`${SELECT_ADDRESS_STATE} where a.address = $1`, [
      address,
    ]);
    return row ? addressStateFrom(row) : null;
  }

  async listAddresses(options?: { includeInactive?: boolean }): Promise<AddressState[]> {
    const rows = await this.query<AddressRow>(
      `${SELECT_ADDRESS_STATE} where a.active or $1 order by a.id`,
      [!!options?.includeInactive],
    );
    return rows.map(addressStateFrom);
  }

  async write(address: string, txs: TxRecord[]): Promise<number> {
    if (txs.length === 0) return 0;
    const inserted = await this.query(
      `with a as (select id, start_lt from $S.addresses where address = $1)
       insert into $S.transactions (address_id, lt, hash, prev_lt, prev_hash, utime, boc)
       select a.id, u.lt, decode(u.hash, 'hex'), u.prev_lt, decode(u.prev_hash, 'hex'), u.utime,
         decode(u.boc, 'hex')
       from a, unnest($2::bigint[], $3::text[], $4::bigint[], $5::text[], $6::bigint[], $7::text[])
         as u(lt, hash, prev_lt, prev_hash, utime, boc)
       where u.lt > a.start_lt
       on conflict do nothing
       returning lt`,
      [
        address,
        txs.map((tx) => tx.lt.toString()),
        txs.map((tx) => toHex(tx.hash)),
        txs.map((tx) => tx.prevLt.toString()),
        txs.map((tx) => toHex(tx.prevHash)),
        txs.map((tx) => tx.utime),
        txs.map((tx) => toHex(tx.boc)),
      ],
    );
    return inserted.length;
  }

  async findGaps(address: string, limit = DEFAULT_GAP_LIMIT): Promise<Gap[]> {
    const rows = await this.query<GapRow>(
      `with a as (select id, start_lt, frontier_lt from $S.addresses where address = $1)
       select t.lt::text, t.prev_lt::text, t.prev_hash,
         coalesce(
           (select max(q.lt) from $S.transactions q where q.address_id = a.id and q.lt < t.lt),
           a.start_lt
         )::text as floor_lt
       ${FROM_UNLINKED}
       order by t.lt asc
       limit $2`,
      [address, limit],
    );
    return rows.map((row) => ({
      address,
      aboveLt: BigInt(row.lt),
      prevLt: BigInt(row.prev_lt),
      prevHash: toBuffer(row.prev_hash),
      floorLt: BigInt(row.floor_lt),
    }));
  }

  async advanceFrontier(address: string): Promise<TxId | null> {
    const [row] = await this.query<TxIdRow>(
      `with a as (select id, start_lt, frontier_lt from $S.addresses where address = $1),
       gap as (select t.lt ${FROM_UNLINKED} order by t.lt asc limit 1),
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
      [address],
    );
    return row ? txIdFrom(row.lt, row.hash) : null;
  }

  async markSynced(addresses: string[], syncLt: bigint, utime: number): Promise<void> {
    if (addresses.length === 0) return;
    await this.query(
      `update $S.addresses a set synced_lt = $2, synced_utime = $3, updated_at = now()
       where a.address = any($1::text[]) and a.synced_lt < $2
         and a.frontier_lt is not distinct from
           (select max(t.lt) from $S.transactions t where t.address_id = a.id)`,
      [addresses, syncLt.toString(), utime],
    );
  }

  async read(address: string, afterLt: bigint, uptoLt: bigint, limit: number): Promise<TxRecord[]> {
    const rows = await this.query<TransactionRow>(
      `select t.lt::text, t.hash, t.prev_lt::text, t.prev_hash, t.utime::text, t.boc
       from $S.transactions t join $S.addresses a on a.id = t.address_id
       where a.address = $1 and t.lt > $2 and t.lt <= $3
       order by t.lt asc
       limit $4`,
      [address, afterLt.toString(), uptoLt.toString(), limit],
    );
    return rows.map((row) => ({
      address,
      lt: BigInt(row.lt),
      hash: toBuffer(row.hash),
      prevLt: BigInt(row.prev_lt),
      prevHash: toBuffer(row.prev_hash),
      utime: Number(row.utime),
      boc: toBuffer(row.boc),
    }));
  }

  async getCursor(consumer: string, address: string): Promise<bigint | null> {
    const [row] = await this.query<{ lt: string }>(
      `select c.lt::text from $S.cursors c join $S.addresses a on a.id = c.address_id
       where c.consumer = $1 and a.address = $2`,
      [consumer, address],
    );
    return row ? BigInt(row.lt) : null;
  }

  async setCursor(consumer: string, address: string, lt: bigint): Promise<void> {
    await this.query(
      `insert into $S.cursors (consumer, address_id, lt)
       select $1, id, $3 from $S.addresses where address = $2
       on conflict (consumer, address_id) do update set lt = excluded.lt, updated_at = now()`,
      [consumer, address, lt.toString()],
    );
  }

  async transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction((client) => {
      const boundToTransaction: PgDatabase = {
        query: (text, params) => client.query(text, params),
        // Already inside a transaction: nested calls simply join it.
        transaction: (nested) => nested(client),
      };
      const store = new PgStore(boundToTransaction, { schema: this.schema });
      return fn({ store, db: client });
    });
  }

  /** Runs `sql` with `$S` replaced by the schema; rows are typed by the caller. */
  private async query<Row = unknown>(
    sql: string,
    params?: unknown[],
    db: PgQueryable = this.db,
  ): Promise<Row[]> {
    const { rows } = await db.query(sql.replaceAll(SCHEMA_PLACEHOLDER, this.quotedSchema), params);
    return rows as Row[];
  }
}
