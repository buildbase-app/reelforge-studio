import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { createWorkspaceRouter, DEFAULT_WORKSPACE_ID, hasFilesystemData, importFilesystemV01, type ImportReport, type ReadySignal, type Repositories, type WorkspaceRouter } from '@reelforge/core';
import { MIGRATIONS } from './generated/migrations';
import { applyMigrations, migrationStatus, type MigrationStatus, type RawClient } from './migrate';
import { createPrismaRepositories, isUniqueViolation, type AnyPrismaClient } from './prisma-repositories';
import { DEFAULT_PG_SCHEMA, pgIdent } from './sql';
import { parseDatabaseUrl, parseReadUrl, redactDatabaseUrl, type DatabaseKind, type ParsedDatabaseUrl } from './url';

export interface OpenDatabaseOptions {
  /** file:..., postgresql://..., mysql://... (see resolveDatabaseUrl). */
  url: string;
  /** Queue dispatch (D-105): what the job repository's transactions signal (PrismaRepositoryOptions.readySignal). */
  readySignal?: ReadySignal;
  /**
   * database.readUrl (D-104): a read replica of `url` for the list reads that
   * tolerate lag (READ_REPLICA_READS). Unset: every query goes to `url`.
   * PostgreSQL and MySQL only.
   */
  readUrl?: string;
  /**
   * Pool size for a URL without `?connection_limit=` (the worker role's small
   * default, database.workerConnectionLimit). Unset: the driver's default (10).
   */
  defaultConnectionLimit?: number;
}

/** node-postgres `max` and the mariadb connector's `connectionLimit` both default to 10. */
export const DRIVER_DEFAULT_POOL = 10;

/**
 * The repository reads that go to database.readUrl when it is set (D-104):
 * lists an agent or an admin pages through, where a row written a moment ago
 * on the primary may be missing for the replica's lag. Everything else (job
 * state, claims, quotas, rate limits, keys, licence, idempotency, settings,
 * webhooks, single-row gets and every read-then-write) stays on the primary.
 * docs/providers/queue-and-scaling.md#read-replica lists the same.
 */
export const READ_REPLICA_READS = ['projects.page', 'projects.listVersions', 'jobs.page', 'assets.page', 'themes.list', 'audit.list'] as const;

/** Marker in SystemState once the v0.1 filesystem data was imported. */
export const FS_IMPORT_STATE = 'import.fs-v0.1';

/**
 * One connection pool to the configured database, plus the migrator. The
 * provider (SQLite / PostgreSQL / MySQL) comes from the URL scheme; each has
 * its own generated Prisma client and driver adapter, loaded on demand.
 */
export class Database {
  private repos = new Map<string, Repositories>();
  private router: WorkspaceRouter | null = null;

  private constructor(
    readonly kind: DatabaseKind,
    readonly url: string,
    readonly prisma: AnyPrismaClient,
    /** The replica's client (database.readUrl), or null: everything on the primary. */
    readonly readPrisma: AnyPrismaClient | null,
    readonly readUrl: string | null,
    /** Connections the primary's pool may open (PostgreSQL / MySQL; 1 file handle for SQLite). */
    readonly poolSize: number,
    /** Connections the replica's pool may open, or null without a replica. */
    readonly readPoolSize: number | null,
    private readonly readySignal?: ReadySignal
  ) {}

  /**
   * PostgreSQL: the schema the tables are in, which every raw statement names (#191): the URL's `?schema=`, else
   * `public` (Prisma's default for its model queries too). null on SQLite and MySQL, where the database in the URL is
   * the namespace.
   */
  get schema(): string | null {
    return this.kind === 'postgresql' ? (parseDatabaseUrl(this.url).schema ?? DEFAULT_PG_SCHEMA) : null;
  }

  static async open(opts: OpenDatabaseOptions): Promise<Database> {
    const parsed = parseDatabaseUrl(opts.url);
    const readParsed = opts.readUrl ? parseReadUrl(opts.readUrl, parsed) : null;
    const sized = (p: ParsedDatabaseUrl): ParsedDatabaseUrl => ({ ...p, connectionLimit: p.connectionLimit ?? opts.defaultConnectionLimit });
    const prisma = await createClient(sized(parsed));
    try {
      if (parsed.kind === 'sqlite') {
        // WAL: the server and the CLI can use the file at the same time.
        await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
        await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON');
        await prisma.$executeRawUnsafe('PRAGMA synchronous = NORMAL');
      } else if (parsed.kind === 'postgresql' && parsed.schema) {
        const create = () => prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${pgIdent(parsed.schema!)}`);
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
    let readPrisma: AnyPrismaClient | null = null;
    if (readParsed) {
      // Only a connection check: a replica is read-only, so no schema is created and no migration runs on it.
      readPrisma = await createClient(sized(readParsed));
      try {
        await readPrisma.$queryRawUnsafe('SELECT 1');
      } catch (e) {
        await Promise.all([readPrisma.$disconnect(), prisma.$disconnect()].map((p) => p.catch(() => undefined)));
        throw new Error(`cannot connect to the read replica (${redactDatabaseUrl(opts.readUrl!)}): ${(e as Error).message.trim()}`);
      }
    }
    const pool = (p: ParsedDatabaseUrl) => (p.kind === 'sqlite' ? 1 : (sized(p).connectionLimit ?? DRIVER_DEFAULT_POOL));
    return new Database(parsed.kind, opts.url, prisma, readPrisma, opts.readUrl ?? null, pool(parsed), readParsed ? pool(readParsed) : null, opts.readySignal);
  }

  /** The URL without its password. */
  get displayUrl(): string {
    return redactDatabaseUrl(this.url);
  }

  /** The replica URL without its password, or null. */
  get readDisplayUrl(): string | null {
    return this.readUrl === null ? null : redactDatabaseUrl(this.readUrl);
  }

  private get raw(): RawClient {
    return this.prisma as unknown as RawClient;
  }

  status(): Promise<MigrationStatus> {
    return migrationStatus(this.raw, this.kind, MIGRATIONS[this.kind] ?? [], this.schema ?? undefined);
  }

  /** Apply pending migrations; returns the ids applied. */
  async migrate(log?: (line: string) => void): Promise<string[]> {
    const ran = await applyMigrations(this.raw, this.kind, MIGRATIONS[this.kind] ?? [], log, this.schema ?? undefined);
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
      r = createPrismaRepositories(this.prisma, workspaceId, this.kind, {
        schema: this.schema,
        ...(this.kind === 'mysql' ? { insertId: (sql: string, args: Array<string | number | Date>) => mysqlInsertId(this.prisma, sql, args) } : {}),
        ...(this.readPrisma ? { read: this.readPrisma } : {}),
        ...(this.readySignal ? { readySignal: this.readySignal } : {}),
      });
      this.repos.set(workspaceId, r);
    }
    return r;
  }

  /**
   * The routing bundle the server gives the service (#304): every call goes to the caller's workspace (the API
   * key's, or the one a background task runs in), instance-level state to the default workspace.
   */
  workspaceRepositories(): WorkspaceRouter {
    this.router ??= createWorkspaceRouter({ bind: (id) => this.repositories(id) });
    return this.router;
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
    await Promise.all([this.prisma.$disconnect(), this.readPrisma?.$disconnect()]);
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
        // A database that does not answer (host down, network partition) fails a query after 10 s instead of hanging it.
        connectionTimeoutMillis: 10_000,
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
  // Keep the adapter Prisma connects (same pool, same argument mapping) for mysqlInsertId.
  const factory = new PrismaMariaDb(url.toString());
  const slot: { adapter?: InsertIdQueryable } = {};
  const tapped = new Proxy(factory, {
    get(t, prop) {
      if (prop === 'connect') {
        return async () => {
          const adapter = await t.connect();
          slot.adapter = adapter as unknown as InsertIdQueryable;
          return adapter;
        };
      }
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const client = new PrismaClient({ adapter: tapped }) as unknown as AnyPrismaClient;
  mysqlAdapters.set(client, slot);
  return client;
}

/** The part of Prisma's SQL driver adapter interface (@prisma/driver-adapter-utils SqlQueryable) mysqlInsertId uses. */
interface InsertIdQueryable {
  queryRaw(q: { sql: string; args: unknown[]; argTypes: Array<{ scalarType: 'string' | 'int' | 'datetime'; arity: 'scalar' }> }): Promise<{ lastInsertId?: string }>;
}
const mysqlAdapters = new WeakMap<AnyPrismaClient, { adapter?: InsertIdQueryable }>();

/**
 * MySQL: run one statement through the adapter Prisma connected (its pool, its argument mapping, so a DATETIME is
 * written exactly as Prisma writes it) and return the insert id of the OK packet: the value `LAST_INSERT_ID(expr)`
 * set in that statement, without a second `SELECT LAST_INSERT_ID()` that would need the same connection, hence a
 * transaction (#196). Prisma's raw API returns only rows or the affected-row count.
 */
export async function mysqlInsertId(client: AnyPrismaClient, sql: string, args: Array<string | number | Date>): Promise<number | bigint> {
  const slot = mysqlAdapters.get(client);
  if (!slot) throw new Error('not a MySQL client created by Database');
  if (!slot.adapter) await client.$connect();
  const argTypes = args.map((a) => ({ scalarType: a instanceof Date ? ('datetime' as const) : typeof a === 'number' ? ('int' as const) : ('string' as const), arity: 'scalar' as const }));
  const r = await slot.adapter!.queryRaw({ sql, args, argTypes });
  if (r.lastInsertId === undefined) throw new Error('MySQL returned no insert id');
  // A bigint when it does not fit a double exactly (the sliding-window counter packs two counts into one id, #305).
  const n = BigInt(r.lastInsertId);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

export interface PrepareOptions {
  url: string;
  /** database.readUrl (D-104); never migrated, only connected to. */
  readUrl?: string;
  /** Pool size for URLs without ?connection_limit= (OpenDatabaseOptions). */
  defaultConnectionLimit?: number;
  /** v0.1 data directory to import once (the server's REELFORGE_DATA_DIR). */
  dataDir: string;
  /** Apply pending migrations (default true); otherwise refuse to start on an old schema. */
  migrate?: boolean;
  /** Keep retrying the first connection this long (a database container may still be starting). Default 30. */
  connectTimeoutSeconds?: number;
  log?: (line: string) => void;
  /** Queue dispatch (D-105): see OpenDatabaseOptions.readySignal. */
  readySignal?: ReadySignal;
}

/** Database.open, retried with backoff until `timeoutMs` (configuration errors fail at once). */
export async function openWithRetry(target: string | OpenDatabaseOptions, timeoutMs: number, log?: (line: string) => void): Promise<Database> {
  const opts = typeof target === 'string' ? { url: target } : target;
  // Bad URLs are not worth waiting for.
  const parsed = parseDatabaseUrl(opts.url);
  if (opts.readUrl) parseReadUrl(opts.readUrl, parsed);
  const deadline = Date.now() + timeoutMs;
  for (let delay = 500; ; delay = Math.min(delay * 2, 5000)) {
    try {
      return await Database.open(opts);
    } catch (e) {
      if (Date.now() + delay > deadline) throw e;
      log?.(`waiting for the database (${redactDatabaseUrl(opts.url)}${opts.readUrl ? ` and the read replica ${redactDatabaseUrl(opts.readUrl)}` : ''}): ${(e as Error).message.split('\n').pop()}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** What the server and the CLI do on start: connect, migrate, import v0.1 data once. */
export async function prepareDatabase(opts: PrepareOptions): Promise<{ db: Database; migrated: string[]; imported: ImportReport | null }> {
  const db = await openWithRetry({ url: opts.url, readUrl: opts.readUrl, defaultConnectionLimit: opts.defaultConnectionLimit, ...(opts.readySignal ? { readySignal: opts.readySignal } : {}) }, (opts.connectTimeoutSeconds ?? 30) * 1000, opts.log);
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
