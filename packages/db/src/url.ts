import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export type DatabaseKind = 'sqlite' | 'postgresql' | 'mysql';

export interface ParsedDatabaseUrl {
  kind: DatabaseKind;
  /** SQLite: absolute file path. */
  file?: string;
  /** PostgreSQL / MySQL: the URL to hand to the driver (our own parameters removed). */
  driverUrl?: string;
  /** PostgreSQL `?schema=`: tables live in this schema (default: the user's search_path, normally public). */
  schema?: string;
  /** `?connection_limit=`: pool size (PostgreSQL / MySQL). */
  connectionLimit?: number;
}

/** The default: a SQLite file on the data volume. */
export function defaultDatabaseUrl(dataDir: string): string {
  return `file:${join(resolve(dataDir), 'reelforge.db')}`;
}

/**
 * DATABASE_URL, else the contents of DATABASE_URL_FILE (Docker/Kubernetes
 * secrets: the URL usually holds a password), else SQLite on the data volume.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv, dataDir: string): string {
  if (env.DATABASE_URL) return env.DATABASE_URL.trim();
  if (env.DATABASE_URL_FILE) {
    let text: string;
    try {
      text = readFileSync(env.DATABASE_URL_FILE, 'utf8').trim();
    } catch (e) {
      throw new Error(`cannot read DATABASE_URL_FILE: ${(e as Error).message}`);
    }
    if (!text) throw new Error('DATABASE_URL_FILE is empty');
    return text;
  }
  return defaultDatabaseUrl(dataDir);
}

/** The URL without its password, for logs and /v1/capabilities. */
export function redactDatabaseUrl(url: string): string {
  if (url.startsWith('file:')) return url;
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    for (const k of [...u.searchParams.keys()]) if (/pass|secret|token|key/i.test(k)) u.searchParams.set(k, '***');
    return u.toString();
  } catch {
    return '(unparseable database URL)';
  }
}

/** Picks the database from the URL scheme. */
export function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
  if (url.startsWith('file:')) {
    let path = url.slice('file:'.length).replace(/\?.*$/, '');
    if (path.startsWith('//')) path = decodeURIComponent(new URL(url).pathname); // file:///abs/path
    if (!path) throw new Error('DATABASE_URL file: needs a path, e.g. file:/data/reelforge.db');
    return { kind: 'sqlite', file: isAbsolute(path) ? path : resolve(path) };
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`DATABASE_URL is not a valid URL (${redactDatabaseUrl(url)})`);
  }
  const scheme = u.protocol.replace(/:$/, '');
  if (scheme === 'mongodb' || scheme === 'mongodb+srv') {
    throw new Error(
      'MongoDB is not supported yet: Prisma 7 has no MongoDB support (Prisma recommends 6.19 for MongoDB). Use SQLite (default), PostgreSQL or MySQL/MariaDB; see docs/DEPLOY.md.'
    );
  }
  const take = (name: string) => {
    const v = u.searchParams.get(name);
    u.searchParams.delete(name);
    return v ?? undefined;
  };
  const limit = take('connection_limit');
  const connectionLimit = limit === undefined ? undefined : Number(limit);
  if (connectionLimit !== undefined && !(Number.isInteger(connectionLimit) && connectionLimit > 0)) {
    throw new Error('DATABASE_URL connection_limit must be a positive integer');
  }
  if (scheme === 'postgres' || scheme === 'postgresql') {
    const schema = take('schema');
    if (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) throw new Error('DATABASE_URL schema must be a plain identifier');
    return { kind: 'postgresql', driverUrl: u.toString(), schema, connectionLimit };
  }
  if (scheme === 'mysql' || scheme === 'mariadb') {
    if (!u.pathname || u.pathname === '/') throw new Error('DATABASE_URL for MySQL needs a database name, e.g. mysql://user:pass@host:3306/reelforge');
    return { kind: 'mysql', driverUrl: u.toString(), connectionLimit };
  }
  throw new Error(`DATABASE_URL scheme "${scheme}:" is not supported; use file: (SQLite), postgresql:// or mysql:// (MariaDB too)`);
}

/**
 * database.readUrl (D-104): a replica for the reads that tolerate lag. Same
 * database kind as the primary, and never SQLite (one local file has no
 * replica). Throws with the URL redacted.
 */
export function parseReadUrl(readUrl: string, primary: ParsedDatabaseUrl): ParsedDatabaseUrl {
  if (primary.kind === 'sqlite') {
    throw new Error(
      'DATABASE_READ_URL (database.readUrl) needs PostgreSQL or MySQL: SQLite is one local file and has no read replica. Unset it, or move to PostgreSQL/MySQL (docs/DEPLOY.md#database)'
    );
  }
  let parsed: ParsedDatabaseUrl;
  try {
    parsed = parseDatabaseUrl(readUrl);
  } catch (e) {
    throw new Error(`DATABASE_READ_URL: ${(e as Error).message.replace(/^DATABASE_URL /, '')}`);
  }
  if (parsed.kind !== primary.kind) {
    throw new Error(`DATABASE_READ_URL is ${parsed.kind} but DATABASE_URL is ${primary.kind}: the read replica must be a replica of the primary database (${redactDatabaseUrl(readUrl)})`);
  }
  return parsed;
}
