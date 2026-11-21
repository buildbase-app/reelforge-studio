import { resolve } from 'node:path';

export interface ServerConfig {
  dataDir: string;
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
  return {
    dataDir: resolve(env.REELFORGE_DATA_DIR || 'data'),
    cacheDir: env.REELFORGE_CACHE_DIR ? resolve(env.REELFORGE_CACHE_DIR) : undefined,
    host: env.REELFORGE_HOST || '127.0.0.1',
    port: int(env.REELFORGE_PORT, 4321, 'REELFORGE_PORT'),
    publicUrl,
    bootstrapKey: env.REELFORGE_BOOTSTRAP_KEY || undefined,
    allowedHosts: [...allowedHosts],
    rateLimitPerMinute: int(env.REELFORGE_RATE_LIMIT_PER_MINUTE, 300, 'REELFORGE_RATE_LIMIT_PER_MINUTE'),
    renderConcurrency: Math.max(1, int(env.REELFORGE_RENDER_CONCURRENCY, 1, 'REELFORGE_RENDER_CONCURRENCY')),
    maxUploadBytes: int(env.REELFORGE_MAX_UPLOAD_BYTES, 200 * 1024 * 1024, 'REELFORGE_MAX_UPLOAD_BYTES'),
    maxJsonBytes: int(env.REELFORGE_MAX_JSON_BYTES, 2 * 1024 * 1024, 'REELFORGE_MAX_JSON_BYTES'),
  };
}
