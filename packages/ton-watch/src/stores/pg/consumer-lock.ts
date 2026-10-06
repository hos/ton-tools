import type { ConsumerLock } from "../consumer-state";
import type { PgDatabase, PgQueryable, PgSession } from "./database";

/**
 * Locks held in this process, per database handle. A single-session database
 * (PGlite) cannot tell two holders apart — advisory locks are re-entrant within
 * a session — so the process keeps its own record as well.
 */
const heldInProcess = new WeakMap<PgDatabase, Set<string>>();

/**
 * The two 32-bit keys of the advisory lock: `hashtext('ton_watch:<schema>')` and
 * `hashtext(<consumer name>)` (in `pg_locks`: `locktype = 'advisory'`, `objsubid = 2`).
 * Two names in one schema share a key with probability 2^-32 per pair; such a
 * collision only makes them exclude each other, it never lets one name run twice.
 */
const LOCK_KEYS = `hashtext($1), hashtext($2)`;

/**
 * Takes the session-level advisory lock of consumer `name` in `schema`, on a
 * dedicated connection held until `release()` (the database's only session if it
 * has no `session()`). Resolves to null if anyone holds it.
 */
export async function acquireConsumerLock(
  db: PgDatabase,
  schema: string,
  name: string,
): Promise<ConsumerLock | null> {
  const local = heldInProcess.get(db) ?? new Set<string>();
  heldInProcess.set(db, local);
  const localKey = `${schema}\u0000${name}`;
  if (local.has(localKey)) return null;
  local.add(localKey);

  let session: PgSession | null = null;
  try {
    session = (await db.session?.()) ?? null;
    const connection: PgQueryable = session ?? db;
    const params = [`ton_watch:${schema}`, name];
    const { rows } = await connection.query(
      `select pg_try_advisory_lock(${LOCK_KEYS}) as locked`,
      params,
    );
    if (!(rows[0] as { locked: boolean } | undefined)?.locked) {
      session?.release();
      local.delete(localKey);
      return null;
    }
    return new PgConsumerLock(connection, session, params, () => local.delete(localKey));
  } catch (error) {
    session?.release(true);
    local.delete(localKey);
    throw error;
  }
}

class PgConsumerLock implements ConsumerLock {
  private released = false;
  private lost = false;

  constructor(
    private readonly connection: PgQueryable,
    private readonly session: PgSession | null,
    private readonly params: string[],
    private readonly forget: () => void,
  ) {
    session?.onClose(() => {
      this.lost = true;
    });
  }

  get held(): boolean {
    return !this.released && !this.lost;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.forget();
    let broken = this.lost;
    if (!broken) {
      try {
        await this.connection.query(`select pg_advisory_unlock(${LOCK_KEYS})`, this.params);
      } catch {
        // Closing the connection below releases the lock as well.
        broken = true;
      }
    }
    this.session?.release(broken);
  }
}
