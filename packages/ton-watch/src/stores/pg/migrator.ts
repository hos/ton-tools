import { TonWatchError } from "../../core/errors";
import { SerialQueue, sleep } from "../../util/async";
import type { PgDatabase, PgQueryable, PgSession } from "./database";
import {
  compatibleFrom,
  type Migration,
  migrationChecksum,
  migrations,
  SCHEMA_PLACEHOLDER,
} from "./migrations";

/**
 * Why `migrate()` refused to touch a schema:
 * - `MIGRATION_MODIFIED`: an applied migration's statements differ from this code's
 *   (it was edited).
 * - `MIGRATION_TOO_NEW`: a newer ton-watch applied migrations this code does not know
 *   and marked at least one of them incompatible with it. Upgrade ton-watch.
 * - `MIGRATION_DIVERGED`: the recorded history cannot be reconciled with this code's
 *   (a pre-release schema, an unknown or missing version below the newest applied one).
 */
export type MigrationErrorCode = "MIGRATION_MODIFIED" | "MIGRATION_TOO_NEW" | "MIGRATION_DIVERGED";

/** `migrate()` refused a schema and changed nothing; see `MigrationErrorCode`. */
export class MigrationError extends TonWatchError<MigrationErrorCode> {
  override name = "MigrationError";
}

/** What one `migrateSchema` call did. */
export interface MigrationResult {
  /** Versions applied by this call, ascending. */
  applied: number[];
  /** Applied versions newer than this code knows (all compatible with it), ascending. */
  newer: number[];
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
  compatible_from: number;
}

/** Bookkeeping table. Its shape is frozen like a migration: it exists before any of them. */
const CREATE_HISTORY = `create table if not exists $S.schema_migrations (
  version integer primary key,
  name text not null,
  checksum text not null,
  compatible_from integer not null,
  applied_at timestamptz not null default now()
)`;

/**
 * `create [unique] index concurrently if not exists <name> on …`, the one accepted
 * form of a concurrent index build (`<name>` unquoted, lowercase).
 */
export const CONCURRENT_INDEX: RegExp =
  /^\s*create\s+(?:unique\s+)?index\s+concurrently\s+if\s+not\s+exists\s+([a-z_][a-z0-9_]*)\s+on\s/i;

/** Waits between attempts to take the migration lock. */
const LOCK_RETRY_MIN_MS = 25;
const LOCK_RETRY_MAX_MS = 1_000;

/** In-process queue per database handle: a single-session database cannot tell two lockers apart. */
const queues = new WeakMap<PgDatabase, SerialQueue>();

/** Runs `body` in a transaction on the connection the migration lock is held on. */
type InTransaction = (body: (tx: PgQueryable) => Promise<void>) => Promise<void>;

/**
 * Creates `schema` if missing and applies the pending ones of `list` (default: the
 * real history). Any number of processes may call it at once: everything runs under
 * the advisory lock `hashtext('ton_watch:<schema>')`. Fails with `MigrationError`,
 * before changing anything, when the recorded history does not match `list`.
 *
 * Transactional migrations run in one transaction holding the lock, which needs no
 * dedicated connection. A non-transactional one (`transaction: false`) needs the
 * lock across several transactions, so from there on everything runs on a dedicated
 * session (`db.session()`) holding the session-level lock.
 *
 * The lock is polled with the `try` variants rather than waited for: a waiter
 * blocked inside a statement keeps a snapshot open, and a `create index
 * concurrently` run by the holder waits for every such snapshot — a deadlock.
 */
export function migrateSchema(
  db: PgDatabase,
  schema: string,
  list: readonly Migration[] = migrations,
): Promise<MigrationResult> {
  const queue = queues.get(db) ?? new SerialQueue();
  queues.set(db, queue);
  return queue.run(async () => {
    const first = await withRetry(() =>
      db.transaction(async (tx) => {
        if (!(await tryLock(tx, schema, "pg_try_advisory_xact_lock"))) return null;
        return applyPending(tx, (body) => body(tx), schema, list, true);
      }),
    );
    if (!first.stopped) return { applied: first.applied, newer: first.newer };
    const rest = await withSessionLock(db, schema, (connection, inTransaction) =>
      applyPending(connection, inTransaction, schema, list, false),
    );
    return { applied: [...first.applied, ...rest.applied], newer: rest.newer };
  });
}

async function tryLock(
  connection: PgQueryable,
  schema: string,
  fn: "pg_try_advisory_xact_lock" | "pg_try_advisory_lock",
): Promise<boolean> {
  const { rows } = await connection.query(`select ${fn}(hashtext($1)) as locked`, [
    `ton_watch:${schema}`,
  ]);
  return (rows[0] as { locked: boolean } | undefined)?.locked === true;
}

/** Calls `attempt` until it returns non-null, backing off in between. */
async function withRetry<T>(attempt: () => Promise<T | null>): Promise<T> {
  for (let wait = LOCK_RETRY_MIN_MS; ; wait = Math.min(wait * 2, LOCK_RETRY_MAX_MS)) {
    const result = await attempt();
    if (result !== null) return result;
    await sleep(wait * (0.5 + Math.random()));
  }
}

/**
 * Runs `fn` holding the session-level migration lock on a dedicated session (or on
 * the database itself if it is single-session, as PGlite is).
 */
async function withSessionLock<T>(
  db: PgDatabase,
  schema: string,
  fn: (connection: PgQueryable, inTransaction: InTransaction) => Promise<T>,
): Promise<T> {
  const session: PgSession | null = (await db.session?.()) ?? null;
  const connection: PgQueryable = session ?? db;
  let broken = false;
  try {
    await withRetry(async () =>
      (await tryLock(connection, schema, "pg_try_advisory_lock")) ? true : null,
    );
    try {
      const inTransaction: InTransaction = session
        ? async (body) => {
            await session.query("begin");
            try {
              await body(session);
              await session.query("commit");
            } catch (error) {
              await session.query("rollback").catch(() => {
                broken = true;
              });
              throw error;
            }
          }
        : (body) => db.transaction(body);
      return await fn(connection, inTransaction);
    } finally {
      await connection
        .query(`select pg_advisory_unlock(hashtext($1))`, [`ton_watch:${schema}`])
        .catch(() => {
          // Closing the session below releases the lock as well.
          broken = true;
        });
    }
  } finally {
    session?.release(broken);
  }
}

/**
 * Applies what `list` has beyond the recorded history, in order. With
 * `stopAtNonTransactional`, stops before the first `transaction: false` migration
 * and reports `stopped`.
 */
async function applyPending(
  connection: PgQueryable,
  inTransaction: InTransaction,
  schema: string,
  list: readonly Migration[],
  stopAtNonTransactional: boolean,
): Promise<MigrationResult & { stopped: boolean }> {
  const quoted = `"${schema}"`;
  const run = async (db: PgQueryable, sql: string, params?: unknown[]) =>
    (await db.query(sql.replaceAll(SCHEMA_PLACEHOLDER, quoted), params)).rows;

  await run(connection, `create schema if not exists $S`);
  const columns = (await run(
    connection,
    `select column_name from information_schema.columns
     where table_schema = $1 and table_name = 'schema_migrations'`,
    [schema],
  )) as { column_name: string }[];
  if (columns.length > 0 && !columns.some((c) => c.column_name === "checksum")) {
    throw new MigrationError(
      "MIGRATION_DIVERGED",
      `schema "${schema}" was created by a pre-release ton-watch (its schema_migrations has ` +
        `no checksum column) and cannot be upgraded; drop it or use another schema`,
    );
  }
  await run(connection, CREATE_HISTORY);

  const applied = (
    (await run(
      connection,
      `select version, name, checksum, compatible_from from $S.schema_migrations order by version`,
    )) as AppliedRow[]
  ).map((row) => ({ ...row, version: Number(row.version) }));
  const pending = plan(schema, list, applied);

  const done: number[] = [];
  for (const migration of pending.migrations) {
    const nonTransactional = migration.transaction === false;
    if (nonTransactional && stopAtNonTransactional) {
      return { applied: done, newer: pending.newer, stopped: true };
    }
    const record = (db: PgQueryable) =>
      run(
        db,
        `insert into $S.schema_migrations (version, name, checksum, compatible_from)
         values ($1, $2, $3, $4)`,
        [
          migration.version,
          migration.name,
          migrationChecksum(migration),
          compatibleFrom(migration),
        ],
      );
    if (nonTransactional) {
      for (const statement of migration.up) {
        await dropInvalidIndex(connection, schema, statement);
        await run(connection, statement);
      }
      await record(connection);
    } else {
      await inTransaction(async (tx) => {
        for (const statement of migration.up) await run(tx, statement);
        await record(tx);
      });
    }
    done.push(migration.version);
  }
  return { applied: done, newer: pending.newer, stopped: false };
}

/**
 * Checks the recorded history against `list` and returns what to apply. Throws
 * `MigrationError` on an edited migration, a version gap, or a newer schema that
 * this code is not compatible with.
 */
function plan(
  schema: string,
  list: readonly Migration[],
  applied: AppliedRow[],
): { migrations: Migration[]; newer: number[] } {
  const latest = list.at(-1)?.version ?? 0;
  const known = new Map(list.map((m) => [m.version, m]));
  const appliedVersions = new Set(applied.map((row) => row.version));
  const newer: AppliedRow[] = [];
  for (const row of applied) {
    const migration = known.get(row.version);
    if (migration === undefined) {
      if (row.version < latest) {
        throw new MigrationError(
          "MIGRATION_DIVERGED",
          `schema "${schema}" has migration ${row.version} (${row.name}) applied, ` +
            `which this ton-watch does not have`,
        );
      }
      newer.push(row);
      continue;
    }
    const checksum = migrationChecksum(migration);
    if (row.checksum !== checksum) {
      throw new MigrationError(
        "MIGRATION_MODIFIED",
        `migration ${row.version} (${migration.name}) differs from the one applied to schema ` +
          `"${schema}" (checksum ${checksum.slice(0, 12)}…, applied ${row.checksum.slice(0, 12)}…). ` +
          `Released migrations must never be edited; add a new migration instead`,
      );
    }
  }

  const pending = list.filter((m) => !appliedVersions.has(m.version));
  const newestApplied = applied.at(-1)?.version ?? 0;
  const skipped = pending.find((m) => m.version < newestApplied);
  if (skipped) {
    throw new MigrationError(
      "MIGRATION_DIVERGED",
      `migration ${skipped.version} (${skipped.name}) is not applied to schema "${schema}" ` +
        `but the later migration ${newestApplied} is; a migration must be numbered above ` +
        `every released one`,
    );
  }

  const incompatible = newer.find((row) => Number(row.compatible_from) > latest);
  if (incompatible) {
    throw new MigrationError(
      "MIGRATION_TOO_NEW",
      `schema "${schema}" was migrated to version ${newer.at(-1)!.version} by a newer ` +
        `ton-watch; this one knows versions up to ${latest}, and migration ` +
        `${incompatible.version} (${incompatible.name}) requires code of version ` +
        `${incompatible.compatible_from} or later. Upgrade ton-watch`,
    );
  }
  return { migrations: pending, newer: newer.map((row) => row.version) };
}

/**
 * Before re-running `create index concurrently if not exists <name>`: a build that
 * crashed or failed leaves the index INVALID, which `if not exists` would accept as
 * done. Such an index is dropped so the statement builds it again.
 */
async function dropInvalidIndex(
  connection: PgQueryable,
  schema: string,
  statement: string,
): Promise<void> {
  const name = CONCURRENT_INDEX.exec(statement)?.[1]?.toLowerCase();
  if (name === undefined) return;
  const { rows } = await connection.query(
    `select i.indisvalid as valid from pg_index i
     join pg_class c on c.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2`,
    [schema, name],
  );
  const index = rows[0] as { valid: boolean } | undefined;
  if (index && !index.valid) {
    await connection.query(`drop index concurrently if exists "${schema}"."${name}"`);
  }
}
