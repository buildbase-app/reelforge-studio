import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_WORKSPACE_ID, hasFilesystemData, importFilesystemV01, type ImportReport, type Repositories } from '@reelforge/core';
import { MIGRATIONS } from './generated/migrations';
import { applyMigrations, migrationStatus, type MigrationStatus, type RawClient } from './migrate';
import { createPrismaRepositories, isUniqueViolation, type AnyPrismaClient } from './prisma-repositories';
import { parseDatabaseUrl, redactDatabaseUrl, type DatabaseKind, type ParsedDatabaseUrl } from './url';

export interface OpenDatabaseOptions {
  /** file:..., postgresql://..., mysql://... (see resolveDatabaseUrl). */
  url: string;
}

/** Marker in SystemState once the v0.1 filesystem data was imported. */
export const FS_IMPORT_STATE = 'import.fs-v0.1';

/**
 * One connection pool to the configured database, plus the migrator. The
 * provider (SQLite / PostgreSQL / MySQL) comes from the URL scheme; each has
 * its own generated Prisma client and driver adapter, loaded on demand.
 */
export class Database {
  private repos = new Map<string, Repositories>();

  private constructor(
    readonly kind: DatabaseKind,
    readonly url: string,
    readonly prisma: AnyPrismaClient
  ) {}

  static async open(opts: OpenDatabaseOptions): Promise<Database> {
    const parsed = parseDatabaseUrl(opts.url);
    const prisma = await createClient(parsed);
    const db = new Database(parsed.kind, opts.url, prisma);
    try {
      if (parsed.kind === 'sqlite') {
        // WAL: the server and the CLI can use the file at the same time.
        await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
        await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON');
        await prisma.$executeRawUnsafe('PRAGMA synchronous = NORMAL');
      } else if (parsed.kind === 'postgresql' && parsed.schema) {
        const create = () => prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${parsed.schema}"`);
        // Two processes creating the schema at the same moment: one gets a duplicate-key error.
        await create().catch((e) => (/23505|already exists/.test(String((e as Error).message)) ? create() : Promise.reject(e)));
      } else {
        await prisma.$queryRawUnsafe('SELECT 1');
      }
    } catch (e) {
      await prisma.$disconnect().catch(() => undefined);
      const hint =
        parsed.kind === 'mysql' && !/allowPublicKeyRetrieval|ssl/i.test(opts.url)
          ? ' (MySQL 8 with caching_sha2_password over plain TCP needs ?allowPublicKeyRetrieval=true on a private network, or TLS with ?ssl=true; see docs/DEPLOY.md)'
          : '';
      throw new Error(`cannot connect to the database (${redactDatabaseUrl(opts.url)}): ${(e as Error).message.trim()}${hint}`);
    }
    return db;
  }

  /** The URL without its password. */
  get displayUrl(): string {
    return redactDatabaseUrl(this.url);
  }

  private get raw(): RawClient {
    return this.prisma as unknown as RawClient;
  }

  status(): Promise<MigrationStatus> {
    return migrationStatus(this.raw, this.kind, MIGRATIONS[this.kind] ?? []);
  }

  /** Apply pending migrations; returns the ids applied. */
  async migrate(log?: (line: string) => void): Promise<string[]> {
    const ran = await applyMigrations(this.raw, this.kind, MIGRATIONS[this.kind] ?? [], log);
    await this.ensureWorkspace(DEFAULT_WORKSPACE_ID, 'Default');
    return ran;
  }

  /** Refuse to run on a schema that is behind (when migrations on start are off). */
  async assertMigrated(): Promise<void> {
    const s = await this.status();
    if (s.pending.length) {
      throw new Error(`the database schema is behind: ${s.pending.length} migration(s) pending (${s.pending.join(', ')}); run \`reelforge migrate\` (or start with REELFORGE_MIGRATE_ON_START=1)`);
    }
  }

  async ensureWorkspace(id: string, name: string): Promise<void> {
    try {
      await this.prisma.workspace.upsert({ where: { id }, create: { id, name }, update: {} });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // created by another process at the same moment
    }
  }

  /** Repositories bound to one workspace (default: the only one today). */
  repositories(workspaceId = DEFAULT_WORKSPACE_ID): Repositories {
    let r = this.repos.get(workspaceId);
    if (!r) {
      r = createPrismaRepositories(this.prisma, workspaceId);
      this.repos.set(workspaceId, r);
    }
    return r;
  }

  async getState(key: string): Promise<string | null> {
    return (await this.prisma.systemState.findUnique({ where: { key } }))?.value ?? null;
  }

  async setState(key: string, value: string): Promise<void> {
    const updatedAt = new Date();
    try {
      await this.prisma.systemState.upsert({ where: { key }, create: { key, value, updatedAt }, update: { value, updatedAt } });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      await this.prisma.systemState.update({ where: { key }, data: { value, updatedAt } });
    }
  }

  /**
   * Import a v0.1 filesystem data directory once. Later calls return null
   * without reading the disk, unless `force` (rows that exist are skipped).
   */
  async importFilesystemOnce(dataDir: string, opts: { force?: boolean; log?: (line: string) => void } = {}): Promise<ImportReport | null> {
    if (!opts.force && (await this.getState(FS_IMPORT_STATE))) return null;
    const report = hasFilesystemData(dataDir) ? await importFilesystemV01(this.repositories(), dataDir, opts.log) : null;
    await this.setState(FS_IMPORT_STATE, JSON.stringify({ at: new Date().toISOString(), dataDir, report }));
    return report;
  }

  /**
   * SQLite only: a consistent copy of the live database (VACUUM INTO), safe
   * while the server runs. PostgreSQL/MySQL: use pg_dump / mysqldump.
   */
  async backupSqlite(file: string): Promise<void> {
    if (this.kind !== 'sqlite') throw new Error(`backup is built in for SQLite only; for ${this.kind} use ${this.kind === 'postgresql' ? 'pg_dump' : 'mysqldump'} (docs/DEPLOY.md)`);
    if (existsSync(file)) throw new Error(`${file} exists; choose a new file name`);
    mkdirSync(dirname(file), { recursive: true });
    await this.prisma.$executeRawUnsafe(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    chmodSync(file, 0o600);
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

async function createClient(p: ParsedDatabaseUrl): Promise<AnyPrismaClient> {
  if (p.kind === 'sqlite') {
    mkdirSync(dirname(p.file!), { recursive: true });
    // The file holds provider settings and key hashes: owner-only, like the old secrets.json.
    // An empty file is a valid empty database; SQLite gives -wal/-shm the same mode.
    if (!existsSync(p.file!)) closeSync(openSync(p.file!, 'a', 0o600));
    for (const f of [p.file!, `${p.file}-wal`, `${p.file}-shm`]) {
      try {
        chmodSync(f, 0o600);
      } catch {
        // missing, or not ours (read-only mounts): leave it
      }
    }
    const [{ PrismaClient }, { PrismaBetterSqlite3 }] = await Promise.all([import('./generated/sqlite/client'), import('@prisma/adapter-better-sqlite3')]);
    return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: p.file!, timeout: 15_000 }) });
  }
  if (p.kind === 'postgresql') {
    const [{ PrismaClient }, { PrismaPg }] = await Promise.all([import('./generated/postgresql/client'), import('@prisma/adapter-pg')]);
    const adapter = new PrismaPg(
      {
        connectionString: p.driverUrl!,
        ...(p.connectionLimit ? { max: p.connectionLimit } : {}),
        ...(p.schema ? { options: `-c search_path="${p.schema}"` } : {}),
      },
      p.schema ? { schema: p.schema } : undefined
    );
    return new PrismaClient({ adapter }) as unknown as AnyPrismaClient;
  }
  const [{ PrismaClient }, { PrismaMariaDb }] = await Promise.all([import('./generated/mysql/client'), import('@prisma/adapter-mariadb')]);
  const url = new URL(p.driverUrl!);
  if (p.connectionLimit) url.searchParams.set('connectionLimit', String(p.connectionLimit));
  return new PrismaClient({ adapter: new PrismaMariaDb(url.toString()) }) as unknown as AnyPrismaClient;
}

export interface PrepareOptions {
  url: string;
  /** v0.1 data directory to import once (the server's REELFORGE_DATA_DIR). */
  dataDir: string;
  /** Apply pending migrations (default true); otherwise refuse to start on an old schema. */
  migrate?: boolean;
  /** Keep retrying the first connection this long (a database container may still be starting). Default 30. */
  connectTimeoutSeconds?: number;
  log?: (line: string) => void;
}

/** Database.open, retried with backoff until `timeoutMs` (configuration errors fail at once). */
export async function openWithRetry(url: string, timeoutMs: number, log?: (line: string) => void): Promise<Database> {
  parseDatabaseUrl(url); // bad URLs are not worth waiting for
  const deadline = Date.now() + timeoutMs;
  for (let delay = 500; ; delay = Math.min(delay * 2, 5000)) {
    try {
      return await Database.open({ url });
    } catch (e) {
      if (Date.now() + delay > deadline) throw e;
      log?.(`waiting for the database (${redactDatabaseUrl(url)}): ${(e as Error).message.split('\n').pop()}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** What the server and the CLI do on start: connect, migrate, import v0.1 data once. */
export async function prepareDatabase(opts: PrepareOptions): Promise<{ db: Database; migrated: string[]; imported: ImportReport | null }> {
  const db = await openWithRetry(opts.url, (opts.connectTimeoutSeconds ?? 30) * 1000, opts.log);
  try {
    let migrated: string[] = [];
    if (opts.migrate ?? true) migrated = await db.migrate(opts.log);
    else await db.assertMigrated();
    const imported = await db.importFilesystemOnce(opts.dataDir, { log: opts.log });
    return { db, migrated, imported };
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
}
