import type { PgQueryable } from "../../../src/stores/pg/database";

/**
 * Describes everything in `schema` from the system catalogs — relations, columns
 * (type, nullability, default, identity), constraints, indexes (and whether they
 * are valid), triggers and functions — as stable text with the schema name
 * replaced by `$S`. Two schemas built differently but described alike are the same
 * schema as far as ton-watch is concerned.
 */
export async function describeSchema(db: PgQueryable, schema: string): Promise<string> {
  const rows = async <T>(sql: string) => (await db.query(sql, [schema])).rows as T[];
  const lines: string[] = [];

  const relations = await rows<{ name: string; kind: string }>(
    `select c.relname as name, c.relkind::text as kind from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind not in ('i', 'I') order by c.relname`,
  );
  const columns = await rows<{
    relation: string;
    name: string;
    type: string;
    not_null: boolean;
    default: string | null;
    identity: string;
    generated: string;
  }>(
    `select c.relname as relation, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
       a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default,
       a.attidentity::text as identity, a.attgenerated::text as generated
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where n.nspname = $1 and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
     order by c.relname, a.attnum`,
  );
  // contype 'n' (NOT NULL, catalogued from Postgres 18 on) is covered by the columns.
  const constraints = await rows<{ relation: string; name: string; definition: string }>(
    `select c.relname as relation, k.conname as name, pg_get_constraintdef(k.oid) as definition
     from pg_constraint k
     join pg_class c on c.oid = k.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and k.contype <> 'n'
     order by c.relname, k.conname`,
  );
  const indexes = await rows<{
    relation: string;
    name: string;
    definition: string;
    valid: boolean;
  }>(
    `select c.relname as relation, ic.relname as name, pg_get_indexdef(i.indexrelid) as definition,
       i.indisvalid as valid
     from pg_index i
     join pg_class c on c.oid = i.indrelid
     join pg_class ic on ic.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1
     order by c.relname, ic.relname`,
  );
  const triggers = await rows<{ relation: string; definition: string }>(
    `select c.relname as relation, pg_get_triggerdef(t.oid) as definition
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and not t.tgisinternal
     order by c.relname, t.tgname`,
  );
  const functions = await rows<{ definition: string }>(
    `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as definition
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = $1 order by 1`,
  );

  for (const relation of relations) {
    lines.push(`${KINDS[relation.kind] ?? `relkind ${relation.kind}`} ${relation.name}`);
    for (const c of columns.filter((c) => c.relation === relation.name)) {
      const parts = [`  column ${c.name} ${c.type}`];
      if (c.not_null) parts.push("not null");
      if (c.default !== null) parts.push(`default ${c.default}`);
      if (c.identity) parts.push(`identity ${c.identity === "a" ? "always" : "by default"}`);
      if (c.generated) parts.push(`generated ${c.generated}`);
      lines.push(parts.join(" "));
    }
    for (const k of constraints.filter((k) => k.relation === relation.name)) {
      lines.push(`  constraint ${k.name} ${k.definition}`);
    }
    for (const i of indexes.filter((i) => i.relation === relation.name)) {
      lines.push(`  index ${i.name}${i.valid ? "" : " INVALID"} ${i.definition}`);
    }
    for (const t of triggers.filter((t) => t.relation === relation.name)) {
      lines.push(`  trigger ${t.definition}`);
    }
  }
  for (const f of functions) lines.push(`function ${f.definition}`);

  const qualified = new RegExp(`(?<![\\w"])(?:"${schema}"|${schema})\\.`, "g");
  return `${lines.map((line) => line.replace(qualified, "$S.")).join("\n")}\n`;
}

const KINDS: Record<string, string> = {
  r: "table",
  p: "partitioned table",
  S: "sequence",
  v: "view",
  m: "materialized view",
  f: "foreign table",
  c: "type",
};
