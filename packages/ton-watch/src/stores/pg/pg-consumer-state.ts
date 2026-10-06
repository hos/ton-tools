import type {
  Backlog,
  ConsumerOrder,
  ConsumerRecord,
  CursorState,
  DeadLetter,
  DeadLetterFilter,
} from "../consumer-state";

/** Runs one statement of the store's schema (`$S`); rows are typed by the caller. */
export type SchemaQuery = <Row = unknown>(sql: string, params?: unknown[]) => Promise<Row[]>;

interface CursorRow {
  consumer: string;
  address: string;
  lt: string;
  updated_at: Date;
  attempts: number;
  last_error: string | null;
  first_failure_at: Date | null;
  last_failure_at: Date | null;
}

interface DeadLetterRow {
  consumer: string;
  address: string;
  lt: string;
  hash: Uint8Array;
  error: string;
  attempts: number;
  first_failure_at: Date;
  last_failure_at: Date;
}

interface BacklogRow {
  address: string;
  cursor: string;
  transactions: string;
  newest_lt: string | null;
  oldest_utime: string | null;
}

const CURSOR_COLUMNS = `c.consumer, a.address, c.lt::text, c.updated_at, c.attempts, c.last_error,
  c.first_failure_at, c.last_failure_at`;

const cursorFrom = (row: CursorRow): CursorState => ({
  consumer: row.consumer,
  address: row.address,
  lt: BigInt(row.lt),
  updatedAt: row.updated_at,
  attempts: Number(row.attempts),
  lastError: row.last_error,
  firstFailureAt: row.first_failure_at,
  lastFailureAt: row.last_failure_at,
});

const deadLetterFrom = (row: DeadLetterRow): DeadLetter => ({
  consumer: row.consumer,
  address: row.address,
  lt: BigInt(row.lt),
  hash: Buffer.from(row.hash),
  error: row.error,
  attempts: Number(row.attempts),
  firstFailureAt: row.first_failure_at,
  lastFailureAt: row.last_failure_at,
});

/**
 * The `ConsumerStateStore` statements of `PgStore`: tables `cursors`, `consumers`
 * and `dead_letters`. The lock lives in `consumer-lock.ts`.
 */
export class PgConsumerState {
  constructor(private readonly query: SchemaQuery) {}

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
       on conflict (consumer, address_id) do update set lt = excluded.lt, updated_at = now(),
         attempts = 0, last_error = null, first_failure_at = null, last_failure_at = null`,
      [consumer, address, lt.toString()],
    );
  }

  async compareAndSetCursor(
    consumer: string,
    address: string,
    expected: bigint | null,
    lt: bigint,
  ): Promise<boolean> {
    // Under read committed, an update waiting on a concurrent one re-checks
    // `c.lt = $3` against the committed row, so only one of them matches.
    const rows =
      expected === null
        ? await this.query(
            `insert into $S.cursors (consumer, address_id, lt)
             select $1, id, $3 from $S.addresses where address = $2
             on conflict (consumer, address_id) do nothing
             returning lt`,
            [consumer, address, lt.toString()],
          )
        : await this.query(
            `update $S.cursors c set lt = $4, updated_at = now(), attempts = 0, last_error = null,
               first_failure_at = null, last_failure_at = null
             from $S.addresses a
             where a.id = c.address_id and c.consumer = $1 and a.address = $2 and c.lt = $3
             returning c.lt`,
            [consumer, address, expected.toString(), lt.toString()],
          );
    return rows.length > 0;
  }

  async listCursors(consumer?: string): Promise<CursorState[]> {
    const rows = await this.query<CursorRow>(
      `select ${CURSOR_COLUMNS}
       from $S.cursors c join $S.addresses a on a.id = c.address_id
       where $1::text is null or c.consumer = $1
       order by c.consumer, a.address`,
      [consumer ?? null],
    );
    return rows.map(cursorFrom);
  }

  async recordFailure(
    consumer: string,
    address: string,
    error: string,
  ): Promise<CursorState | null> {
    const [row] = await this.query<CursorRow>(
      `update $S.cursors c set attempts = c.attempts + 1, last_error = $3,
         first_failure_at = coalesce(c.first_failure_at, now()), last_failure_at = now()
       from $S.addresses a
       where a.id = c.address_id and c.consumer = $1 and a.address = $2
       returning ${CURSOR_COLUMNS}`,
      [consumer, address, error],
    );
    return row ? cursorFrom(row) : null;
  }

  async saveConsumer(name: string, order: ConsumerOrder): Promise<void> {
    await this.query(
      `insert into $S.consumers (name, delivery_order) values ($1, $2)
       on conflict (name) do update set delivery_order = excluded.delivery_order, updated_at = now()`,
      [name, order],
    );
  }

  async listConsumers(): Promise<ConsumerRecord[]> {
    const [records, cursors] = await Promise.all([
      this.query<{ name: string; delivery_order: ConsumerOrder | null; created_at: Date | null }>(
        `select name, delivery_order, created_at from $S.consumers
         union all
         select distinct c.consumer, null, null::timestamptz from $S.cursors c
         where not exists (select 1 from $S.consumers k where k.name = c.consumer)
         order by 1`,
      ),
      this.listCursors(),
    ]);
    return records.map((record) => ({
      name: record.name,
      order: record.delivery_order,
      createdAt: record.created_at,
      cursors: cursors.filter((cursor) => cursor.consumer === record.name),
    }));
  }

  async deleteConsumer(name: string): Promise<void> {
    await this.query(
      `with letters as (delete from $S.dead_letters where consumer = $1),
         cursors as (delete from $S.cursors where consumer = $1)
       delete from $S.consumers where name = $1`,
      [name],
    );
  }

  async putDeadLetter(letter: DeadLetter): Promise<void> {
    await this.query(
      `insert into $S.dead_letters
         (consumer, address_id, lt, hash, error, attempts, first_failure_at, last_failure_at)
       select $1, id, $3, decode($4, 'hex'), $5, $6, $7, $8 from $S.addresses where address = $2
       on conflict (consumer, address_id, lt) do update set hash = excluded.hash,
         error = excluded.error, attempts = excluded.attempts,
         first_failure_at = excluded.first_failure_at, last_failure_at = excluded.last_failure_at`,
      [
        letter.consumer,
        letter.address,
        letter.lt.toString(),
        letter.hash.toString("hex"),
        letter.error,
        letter.attempts,
        letter.firstFailureAt,
        letter.lastFailureAt,
      ],
    );
  }

  async updateDeadLetter(letter: DeadLetter): Promise<boolean> {
    const rows = await this.query(
      `update $S.dead_letters d set hash = decode($4, 'hex'), error = $5, attempts = $6,
         first_failure_at = $7, last_failure_at = $8
       from $S.addresses a
       where a.id = d.address_id and d.consumer = $1 and a.address = $2 and d.lt = $3
       returning d.lt`,
      [
        letter.consumer,
        letter.address,
        letter.lt.toString(),
        letter.hash.toString("hex"),
        letter.error,
        letter.attempts,
        letter.firstFailureAt,
        letter.lastFailureAt,
      ],
    );
    return rows.length > 0;
  }

  async listDeadLetters(filter: DeadLetterFilter = {}): Promise<DeadLetter[]> {
    const rows = await this.query<DeadLetterRow>(
      `select d.consumer, a.address, d.lt::text, d.hash, d.error, d.attempts,
         d.first_failure_at, d.last_failure_at
       from $S.dead_letters d join $S.addresses a on a.id = d.address_id
       where ($1::text is null or d.consumer = $1) and ($2::text is null or a.address = $2)
         and ($3::bigint is null or d.lt = $3)
       order by d.consumer, a.address, d.lt
       limit $4`,
      [
        filter.consumer ?? null,
        filter.address ?? null,
        filter.lt?.toString() ?? null,
        filter.limit ?? null,
      ],
    );
    return rows.map(deadLetterFrom);
  }

  async deleteDeadLetter(consumer: string, address: string, lt: bigint): Promise<boolean> {
    const rows = await this.query(
      `delete from $S.dead_letters d using $S.addresses a
       where a.id = d.address_id and d.consumer = $1 and a.address = $2 and d.lt = $3
       returning d.lt`,
      [consumer, address, lt.toString()],
    );
    return rows.length > 0;
  }

  async backlog(consumer: string, uptoLt?: bigint): Promise<Backlog[]> {
    const rows = await this.query<BacklogRow>(
      `select a.address, c.lt::text as cursor, count(t.lt)::text as transactions,
         max(t.lt)::text as newest_lt, min(t.utime)::text as oldest_utime
       from $S.cursors c
       join $S.addresses a on a.id = c.address_id
       left join $S.transactions t on t.address_id = a.id and t.lt > c.lt
         and t.lt <= a.frontier_lt and ($2::bigint is null or t.lt <= $2)
       where c.consumer = $1 and a.active
       group by a.id, a.address, c.lt
       order by a.id`,
      [consumer, uptoLt?.toString() ?? null],
    );
    return rows.map((row) => ({
      address: row.address,
      cursor: BigInt(row.cursor),
      transactions: Number(row.transactions),
      newestLt: row.newest_lt === null ? null : BigInt(row.newest_lt),
      oldestUtime: row.oldest_utime === null ? null : Number(row.oldest_utime),
    }));
  }
}
