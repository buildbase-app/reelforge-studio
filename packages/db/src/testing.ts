import { randomBytes } from 'node:crypto';
import { envValue } from '@renderweld/core';
import { Database } from './database';
import type { DatabaseKind } from './url';

/**
 * Fresh, empty databases for tests (contract tests, server e2e):
 *
 *   sqlite      always: a file in `tmpDir`
 *   postgresql  when TEST_POSTGRES_URL is set: a new schema in that database
 *               (TEST_POSTGRES_ISOLATION=database: a new database instead, e.g. behind PgBouncer)
 *   mysql       when TEST_MYSQL_URL is set: a new database (the user needs CREATE/DROP DATABASE)
 */
export interface TestDatabase {
  kind: DatabaseKind;
  url: string;
  drop(): Promise<void>;
}

export function availableTestDatabases(env: NodeJS.ProcessEnv = process.env): DatabaseKind[] {
  return ['sqlite', ...(env.TEST_POSTGRES_URL ? ['postgresql' as const] : []), ...(env.TEST_MYSQL_URL ? ['mysql' as const] : [])];
}

/** REELFORGE_TEST_DB=sqlite|postgres|mysql: which database the server tests use (default sqlite). */
export function serverTestDatabaseKind(env: NodeJS.ProcessEnv = process.env): DatabaseKind {
  const v = (envValue('REELFORGE_TEST_DB', env) ?? 'sqlite').toLowerCase();
  if (v === 'postgres' || v === 'postgresql') return 'postgresql';
  if (v === 'mysql' || v === 'mariadb') return 'mysql';
  if (v === 'sqlite') return 'sqlite';
  throw new Error(`REELFORGE_TEST_DB must be sqlite, postgres or mysql (got "${v}")`);
}

export async function createTestDatabase(kind: DatabaseKind, tmpDir: string, env: NodeJS.ProcessEnv = process.env): Promise<TestDatabase> {
  const name = `rf_t_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  if (kind === 'sqlite') return { kind, url: `file:${tmpDir}/${name}.db`, drop: async () => undefined };
  if (kind === 'postgresql') {
    const base = env.TEST_POSTGRES_URL;
    if (!base) throw new Error('TEST_POSTGRES_URL is not set');
    const u = new URL(base);
    if (env.TEST_POSTGRES_ISOLATION === 'database') {
      // A database per run in the default schema: what runs behind PgBouncer in transaction mode, where a
      // per-client search_path (?schema=) is not kept on PostgreSQL < 18 (#152, D-104).
      const admin = await Database.open({ url: base });
      try {
        await admin.prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      } finally {
        await admin.close();
      }
      u.pathname = `/${name}`;
      return {
        kind,
        url: u.toString(),
        drop: async () => {
          const a = await Database.open({ url: base });
          try {
            await a.prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
          } finally {
            await a.close();
          }
        },
      };
    }
    u.searchParams.set('schema', name);
    return {
      kind,
      url: u.toString(),
      drop: async () => {
        const admin = await Database.open({ url: base });
        try {
          await admin.prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
        } finally {
          await admin.close();
        }
      },
    };
  }
  const base = env.TEST_MYSQL_URL;
  if (!base) throw new Error('TEST_MYSQL_URL is not set');
  const admin = await Database.open({ url: base });
  try {
    await admin.prisma.$executeRawUnsafe(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await admin.close();
  }
  const u = new URL(base);
  u.pathname = `/${name}`;
  return {
    kind,
    url: u.toString(),
    drop: async () => {
      const a = await Database.open({ url: base });
      try {
        await a.prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await a.close();
      }
    },
  };
}
