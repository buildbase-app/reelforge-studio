import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDatabaseUrl } from '@reelforge/db';

/** REELFORGE_BOOTSTRAP_KEY, or the contents of REELFORGE_BOOTSTRAP_KEY_FILE (Docker/K8s secrets). */
function bootstrapKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.REELFORGE_BOOTSTRAP_KEY) return env.REELFORGE_BOOTSTRAP_KEY;
  if (env.REELFORGE_BOOTSTRAP_KEY_FILE) {
    try {
      return readFileSync(env.REELFORGE_BOOTSTRAP_KEY_FILE, 'utf8').trim() || undefined;
    } catch (e) {
      throw new Error(`cannot read REELFORGE_BOOTSTRAP_KEY_FILE: ${(e as Error).message}`);
    }
  }
  return undefined;
}

export interface ServerConfig {
  dataDir: string;
  /** DATABASE_URL / DATABASE_URL_FILE; default file:<dataDir>/reelforge.db (SQLite). */
  databaseUrl: string;
  /** Apply pending migrations on start (REELFORGE_MIGRATE_ON_START, default on). */
  migrateOnStart: boolean;
  /** How long to keep retrying the first database connection (REELFORGE_DB_CONNECT_TIMEOUT_SECONDS, default 30). */
  dbConnectTimeoutSeconds: number;
  cacheDir?: string;
  host: string;
  port: number;
  publicUrl?: string;
  bootstrapKey?: string;
  /** Host names accepted on /mcp (DNS-rebinding protection). */
  allowedHosts: string[];
  /** Requests per minute per API key. */
  rateLimitPerMinute: number;
  renderConcurrency: number;
  maxUploadBytes: number;
  /** Max JSON body size in bytes. */
  maxJsonBytes: number;
}

function int(v: string | undefined, def: number, name: string): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer (got "${v}")`);
  return n;
}

/** Configuration from environment variables (see docs/DEPLOY.md). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const publicUrl = env.REELFORGE_PUBLIC_URL?.replace(/\/+$/, '') || undefined;
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) throw new Error('REELFORGE_PUBLIC_URL must start with http:// or https://');
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (publicUrl) allowedHosts.add(new URL(publicUrl).hostname);
  for (const h of (env.REELFORGE_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) allowedHosts.add(h);
  const dataDir = resolve(env.REELFORGE_DATA_DIR || 'data');
  const migrate = (env.REELFORGE_MIGRATE_ON_START ?? '1').trim().toLowerCase();
  if (!['1', '0', 'true', 'false', 'yes', 'no', ''].includes(migrate)) throw new Error('REELFORGE_MIGRATE_ON_START must be 1 or 0');
  return {
    dataDir,
    databaseUrl: resolveDatabaseUrl(env, dataDir),
    migrateOnStart: !['0', 'false', 'no'].includes(migrate),
    dbConnectTimeoutSeconds: int(env.REELFORGE_DB_CONNECT_TIMEOUT_SECONDS, 30, 'REELFORGE_DB_CONNECT_TIMEOUT_SECONDS'),
    cacheDir: env.REELFORGE_CACHE_DIR ? resolve(env.REELFORGE_CACHE_DIR) : undefined,
    host: env.REELFORGE_HOST || '127.0.0.1',
    port: int(env.REELFORGE_PORT, 4321, 'REELFORGE_PORT'),
    publicUrl,
    bootstrapKey: bootstrapKey(env),
    allowedHosts: [...allowedHosts],
    rateLimitPerMinute: int(env.REELFORGE_RATE_LIMIT_PER_MINUTE, 300, 'REELFORGE_RATE_LIMIT_PER_MINUTE'),
    renderConcurrency: Math.max(1, int(env.REELFORGE_RENDER_CONCURRENCY, 1, 'REELFORGE_RENDER_CONCURRENCY')),
    maxUploadBytes: int(env.REELFORGE_MAX_UPLOAD_BYTES, 200 * 1024 * 1024, 'REELFORGE_MAX_UPLOAD_BYTES'),
    maxJsonBytes: int(env.REELFORGE_MAX_JSON_BYTES, 2 * 1024 * 1024, 'REELFORGE_MAX_JSON_BYTES'),
  };
}
