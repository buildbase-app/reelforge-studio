import type { DatabaseKind } from './url';

/**
 * Names in raw SQL (#191). On PostgreSQL every raw statement names its schema,
 * because behind a transaction-mode pooler (PgBouncer, PostgreSQL <= 17) a
 * client's `search_path` is not kept: an unqualified `"Job"` can resolve in
 * another client's schema. The schema comes from the database URL
 * (`?schema=`, else `public`, which is also what Prisma's model queries use).
 *
 * MySQL and SQLite are unchanged: on MySQL the database in the URL is the
 * namespace, fixed per connection at connect time (no search_path, and the
 * pooled connections never switch database); SQLite is one local file.
 */

/** A PostgreSQL schema name RenderWeld accepts in `?schema=` (url.ts): a plain, unquoted identifier. */
export const PG_SCHEMA_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** The schema without `?schema=`: Prisma's own default, so raw SQL and model queries agree. */
export const DEFAULT_PG_SCHEMA = 'public';

/** A double-quoted PostgreSQL identifier, after checking it against PG_SCHEMA_PATTERN (never escapes: refuses). */
export function pgIdent(name: string): string {
  if (!PG_SCHEMA_PATTERN.test(name)) throw new Error(`not a plain SQL identifier: ${JSON.stringify(name.slice(0, 80))}`);
  return `"${name}"`;
}

/** `"schema"."Table"` for PostgreSQL raw SQL (both parts checked). */
export function pgTable(schema: string, table: string): string {
  return `${pgIdent(schema)}.${pgIdent(table)}`;
}

export interface SqlNames {
  /** A column or alias: `"name"` (PostgreSQL, SQLite) or `` `name` `` (MySQL). */
  qi(name: string): string;
  /** A table: `"schema"."Table"` on PostgreSQL, `` `Table` `` on MySQL, `"Table"` on SQLite. Use it for every table in raw SQL. */
  tbl(table: string): string;
  /** The `?n` / `$n` placeholder. */
  ph(i: number): string;
}

/** The quoting helpers of one database. `schema` is required on PostgreSQL. */
export function sqlNames(kind: DatabaseKind, schema?: string): SqlNames {
  if (kind === 'postgresql') {
    if (schema === undefined) throw new Error('PostgreSQL raw SQL needs the schema (Database.schema: the URL\'s ?schema=, else "public")');
    const s = pgIdent(schema);
    return { qi: (n) => pgIdent(n), tbl: (t) => `${s}.${pgIdent(t)}`, ph: (i) => `$${i}` };
  }
  if (kind === 'mysql') return { qi: (n) => `\`${n}\``, tbl: (t) => `\`${t}\``, ph: () => '?' };
  return { qi: (n) => `"${n}"`, tbl: (t) => `"${t}"`, ph: () => '?' };
}
