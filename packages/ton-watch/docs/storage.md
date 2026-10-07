# Storage

[← @ton/watch](../README.md)

`PgStore` is the reference store (works with `pg` and PGlite); `MemoryStore` keeps
everything in process memory, for tests and short-lived tools. Both implement the
`Store` contract (`@ton/watch/advanced`, experimental; custom implementations are
unsupported in 0.x).

`PgStore` keeps its tables in schema `ton_watch` (option `schema`, env
`TON_WATCH_SCHEMA`): `addresses`, `transactions` (primary key `(address_id, lt)`,
which serves ordered reads, prev-link lookups and gap floors — no other index
needed), `cursors` (with the failure state of the transaction after each cursor),
`consumers`, `dead_letters`, `schema_migrations`. Schema changes follow
[docs/migrations.md](migrations.md): never destructive, safe to run from
several processes at once, and checked against frozen copies of every released
migration.

## Querying the tables

You may read these columns directly; they are covered by the [stability
policy](stability.md) (columns are only ever added, never removed or retyped):

| table | stable columns |
|---|---|
| `addresses` | `id`, `address` (lowercase raw), `start_lt`, `active`, `frontier_lt`, `frontier_hash`, `synced_lt` |
| `transactions` | `address_id`, `lt`, `hash`, `prev_lt`, `prev_hash`, `utime`, `boc` |
| `cursors` | `consumer`, `address_id`, `lt` (last delivered) |

Everything else — other columns, `consumers`, `dead_letters`, `schema_migrations` —
is internal: read it through the API or the CLI. Never write to any table, except
the retention delete below.

## Retention

A transaction is stored as its BOC (667 bytes on average in our benchmarks) plus
~110 bytes of row data and index — roughly **1 GB per million transactions**. There
is no automatic retention. To prune, delete old `transactions` rows that are both
below the address's frontier and at or below every consumer's cursor on it:

```sql
delete from ton_watch.transactions t
using ton_watch.addresses a
where t.address_id = a.id
  and t.lt < a.frontier_lt                                   -- keep the frontier and above
  and t.utime < extract(epoch from now() - interval '90 days')
  and not exists (                                           -- keep what a consumer has yet to deliver
    select 1 from ton_watch.cursors c where c.address_id = t.address_id and c.lt < t.lt
  );
```

Rows below the frontier are never re-checked for gaps, so they are not refetched.
What you delete is gone for good: a consumer started later with `from: "earliest"`,
a rewind to `earliest`, and a replay of a dead letter for a deleted transaction
(`TRANSACTION_NOT_FOUND`) no longer see it.
