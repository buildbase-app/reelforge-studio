import { createHash } from 'node:crypto';
import { DEFAULT_PG_SCHEMA, pgIdent, pgTable } from './sql';
import type { DatabaseKind } from './url';

export interface Migration {
  /** "0001_init": ordered by id. */
  id: string;
  sql: string;
}

export interface MigrationStatus {
  applied: Array<{ id: string; appliedAt: string }>;
  pending: string[];
}

/** The subset of PrismaClient the migrator needs (any of the three generated clients). */
export interface RawClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $transaction<R>(fn: (tx: RawClient) => Promise<R>, options?: { maxWait?: number; timeout?: number }): Promise<R>;
}

const TABLE = '_reelforge_migrations';
/**
 * Arbitrary constant for PostgreSQL advisory locks ("rfmg"). One key for the whole database, whatever the schema:
 * deployments in different schemas of one database only wait for each other's migrations (harmless), and versions
 * before and after #191 still exclude each other during an upgrade.
 */
const PG_LOCK_ID = 0x72666d67;

/**
 * The bookkeeping table. PostgreSQL: schema-qualified (#191), so the migrator never reads another schema's table
 * through a pooler that does not keep the client's search_path.
 */
function table(kind: DatabaseKind, schema: string): string {
  return kind === 'postgresql' ? pgTable(schema, TABLE) : TABLE;
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Split a migration script into statements: on `;` outside quotes and
 * comments. Comment-only chunks are dropped.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (quote) {
      cur += c;
      if (c === quote) {
        if (next === quote) {
          cur += next;
          i += 2;
          continue;
        }
        quote = null;
      }
      i++;
      continue;
    }
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      cur += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function ensureTable(client: RawClient, kind: DatabaseKind, schema: string) {
  await client.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS ${table(kind, schema)} (id VARCHAR(191) NOT NULL PRIMARY KEY, checksum VARCHAR(64) NOT NULL, applied_at VARCHAR(40) NOT NULL)`
  );
}

async function appliedRows(client: RawClient, kind: DatabaseKind, schema: string): Promise<Array<{ id: string; checksum: string; applied_at: string }>> {
  return client.$queryRawUnsafe(`SELECT id, checksum, applied_at FROM ${table(kind, schema)} ORDER BY id`);
}

async function tableExists(client: RawClient, kind: DatabaseKind, schema: string): Promise<boolean> {
  const sql =
    kind === 'sqlite'
      ? `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${TABLE}'`
      : kind === 'postgresql'
        ? `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = '${TABLE}'` // not current_schema() (#191)
        : `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${TABLE}'`;
  return ((await client.$queryRawUnsafe<unknown[]>(sql, ...(kind === 'postgresql' ? [schema] : []))) ?? []).length > 0;
}

function verify(migrations: Migration[], applied: Array<{ id: string; checksum: string }>) {
  const known = new Map(migrations.map((m) => [m.id, m]));
  for (const row of applied) {
    const m = known.get(row.id);
    if (!m) {
      throw new Error(
        `the database has migration ${row.id}, which this version of RenderWeld does not know: it was migrated by a newer version. Run that version (or newer), or restore a backup taken before the upgrade.`
      );
    }
    if (checksum(m.sql) !== row.checksum) {
      throw new Error(`migration ${row.id} was changed after it was applied (checksum mismatch); refusing to continue`);
    }
  }
}

/** `schema`: PostgreSQL only, the schema the tables are in (Database.schema; default `public`). */
export async function migrationStatus(client: RawClient, kind: DatabaseKind, migrations: Migration[], schema: string = DEFAULT_PG_SCHEMA): Promise<MigrationStatus> {
  const applied = (await tableExists(client, kind, schema)) ? await appliedRows(client, kind, schema) : [];
  verify(migrations, applied);
  const done = new Set(applied.map((a) => a.id));
  return {
    applied: applied.map((a) => ({ id: a.id, appliedAt: a.applied_at })),
    pending: migrations.filter((m) => !done.has(m.id)).map((m) => m.id),
  };
}

/**
 * Apply pending migrations, oldest first. Safe to run from several processes
 * at once: PostgreSQL takes an advisory lock, MySQL a named lock, SQLite a
 * write lock, and the applied list is re-read under the lock.
 *
 * Each migration runs in one transaction with its bookkeeping row. PostgreSQL
 * and SQLite roll back a failed migration completely. MySQL commits each DDL
 * statement implicitly, so a migration that fails half way must be repaired
 * by hand (restore the backup; see docs/DEPLOY.md).
 *
 * PostgreSQL: the bookkeeping statements name `schema`, and each migration's
 * transaction starts with `SET LOCAL search_path` to it, because the migration
 * scripts (generated DDL) name their tables without a schema. SET LOCAL lasts
 * for the transaction only, which a transaction-mode pooler keeps on one
 * server connection (#191).
 */
export async function applyMigrations(
  client: RawClient,
  kind: DatabaseKind,
  migrations: Migration[],
  log: (line: string) => void = () => undefined,
  schema: string = DEFAULT_PG_SCHEMA
): Promise<string[]> {
  const ran: string[] = [];
  // Cheap check without a lock; every pending one is re-checked under the lock.
  const { pending } = await migrationStatus(client, kind, migrations, schema);
  for (const m of [...migrations].sort((a, b) => a.id.localeCompare(b.id)).filter((x) => pending.includes(x.id))) {
    // SQLite: foreign key enforcement must be off while tables are rebuilt
    // (a DROP TABLE would cascade); it cannot change inside a transaction.
    if (kind === 'sqlite') await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
    try {
      const applied = await client.$transaction(
        async (tx) => {
          if (kind === 'postgresql') {
            await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${PG_LOCK_ID})`);
            await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${pgIdent(schema)}`);
          }
          if (kind === 'mysql') {
            const [row] = await tx.$queryRawUnsafe<Array<{ l: unknown }>>(`SELECT GET_LOCK('renderweld_migrate', 300) AS l`);
            if (Number(row?.l) !== 1) throw new Error('could not get the migration lock within 300 s');
          }
          try {
            await ensureTable(tx, kind, schema);
            // SQLite: a write takes the database write lock before we read.
            if (kind === 'sqlite') await tx.$executeRawUnsafe(`DELETE FROM ${table(kind, schema)} WHERE 1 = 0`);
            const rows = await appliedRows(tx, kind, schema);
            verify(migrations, rows);
            if (rows.some((r) => r.id === m.id)) return false;
            log(`applying migration ${m.id}`);
            for (const stmt of splitStatements(m.sql)) {
              if (kind === 'sqlite' && /^PRAGMA\s+foreign_keys\s*=/i.test(stmt)) continue;
              await tx.$executeRawUnsafe(stmt);
            }
            if (kind === 'sqlite') {
              const broken = await tx.$queryRawUnsafe<unknown[]>('PRAGMA foreign_key_check');
              if (broken.length) throw new Error(`migration ${m.id} left ${broken.length} rows with broken foreign keys`);
            }
            await tx.$executeRawUnsafe(`INSERT INTO ${table(kind, schema)} (id, checksum, applied_at) VALUES ('${m.id}', '${checksum(m.sql)}', '${new Date().toISOString()}')`);
            return true;
          } finally {
            if (kind === 'mysql') await tx.$queryRawUnsafe(`SELECT RELEASE_LOCK('renderweld_migrate') AS l`);
          }
        },
        { maxWait: 60_000, timeout: 600_000 }
      );
      if (applied) ran.push(m.id);
    } catch (e) {
      throw new Error(`migration ${m.id} failed: ${(e as Error).message}`);
    } finally {
      if (kind === 'sqlite') await client.$executeRawUnsafe('PRAGMA foreign_keys = ON');
    }
  }
  return ran;
}
