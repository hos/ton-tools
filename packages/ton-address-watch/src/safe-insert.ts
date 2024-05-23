import { ClientBase, Pool, type QueryResultRow } from "pg";
import pgFormat from "pg-format";
import { pgClient } from "./database";

interface insertTemplate {
  columns: string[];
  values: unknown[];
  placeholders: string; // $1,$2 etc
}

export async function safeInsert<T extends QueryResultRow>(
  table: string,
  data: Partial<T>, // Record<string, unknown> - we can use record for easier work,
  options: { pgClient?: ClientBase | Pool; onConflictNothing?: boolean } = {}
) {
  const db = options.pgClient || pgClient;

  const { columns, values, placeholders } = getInsertFromObject(data);
  const query = pgFormat(
    `--sql
    INSERT INTO %I(%I) VALUES (%s)
    ${options.onConflictNothing ? "ON CONFLICT DO NOTHING" : ""}
    RETURNING *
  `,
    table,
    columns,
    placeholders
  );
  const res = await db.query<T>(query, values);
  return res;
}

function getInsertFromObject(input: Record<string, unknown>): insertTemplate {
  const columns: string[] = [];
  const values: unknown[] = [];

  for (const key of Object.keys(input)) {
    columns.push(key);
    values.push(input[key]);
  }

  return {
    columns,
    values,
    placeholders: columns.map((_, i) => `$${i + 1}`).join(","),
  };
}
