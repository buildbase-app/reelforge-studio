import { resolve } from 'node:path';
import { loadConfigFile, resolveConfig, type ConfigSources, type ResolvedConfig } from '@reelforge/core';
import { StructuredLogger, secretValues, type StructuredLoggerOptions } from './observability/logger';

/**
 * The server's view of the configuration. Every value comes from the one
 * schema in @reelforge/core (packages/core/src/config/schema.ts; reference:
 * docs/CONFIG.md): defaults < config file (REELFORGE_CONFIG) < environment.
 * Runtime settings from the database are applied on top once the database is
 * open (applyServerSettings).
 */
export interface ServerConfig {
  dataDir: string;
  /** database.url: REELFORGE_DATABASE_URL / DATABASE_URL (or _FILE); default file:<dataDir>/reelforge.db (SQLite). */
  databaseUrl: string;
  /** database.readUrl: REELFORGE_DATABASE_READ_URL / DATABASE_READ_URL (or _FILE); a replica for lag-tolerant lists (D-104). */
  databaseReadUrl?: string;
  /** Apply pending migrations on start (REELFORGE_MIGRATE_ON_START, default on). */
  migrateOnStart: boolean;
  /** How long to keep retrying the first database connection (REELFORGE_DB_CONNECT_TIMEOUT_SECONDS, default 30). */
  dbConnectTimeoutSeconds: number;
  cacheDir?: string;
  host: string;
  port: number;
  publicUrl?: string;
  bootstrapKey?: string;
  /** Host names accepted on /mcp (DNS-rebinding protection): localhost, the public URL host and server.allowedHosts. Runtime. */
  allowedHosts: string[];
  /** Requests per minute per API key. Runtime. */
  rateLimitPerMinute: number;
  /** Runtime. */
  renderConcurrency: number;
  /** Runtime. */
  maxUploadBytes: number;
  /** Max JSON body size in bytes. Runtime. */
  maxJsonBytes: number;
  /** Requests in progress per instance before 503 overloaded (overload.ts); 0 = no limit. Runtime. */
  maxInflightRequests: number;
  /** Runtime. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'text' | 'json';
  /** The file and environment the configuration was read from (for the runtime layer and get_config). */
  sources: ConfigSources;
  /** The resolved configuration (file + env) this ServerConfig was made from. */
  resolved: ResolvedConfig;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

export function allowedHostsFor(publicUrl: string | undefined, extra: string[]): string[] {
  const hosts = new Set(LOCAL_HOSTS);
  if (publicUrl) hosts.add(new URL(publicUrl).hostname.toLowerCase());
  for (const h of extra) hosts.add(h.toLowerCase());
  return [...hosts];
}

/** ServerConfig from a resolved configuration. */
export function serverConfigFrom(resolved: ResolvedConfig, sources: ConfigSources): ServerConfig {
  const c = resolved.config;
  const cacheSource = resolved.settings.get('storage.cacheDir')?.source;
  return {
    dataDir: resolve(c.storage.dataDir),
    databaseUrl: c.database.url,
    databaseReadUrl: c.database.readUrl,
    migrateOnStart: c.database.migrateOnStart,
    dbConnectTimeoutSeconds: c.database.connectTimeoutSeconds,
    cacheDir: cacheSource === 'default' ? undefined : resolve(c.storage.cacheDir),
    host: c.server.host,
    port: c.server.port,
    publicUrl: c.server.publicUrl,
    bootstrapKey: c.security.bootstrapKey,
    allowedHosts: allowedHostsFor(c.server.publicUrl, c.server.allowedHosts),
    rateLimitPerMinute: c.limits.rateLimitPerMinute,
    renderConcurrency: c.limits.renderConcurrency,
    maxUploadBytes: c.limits.maxUploadBytes,
    maxJsonBytes: c.limits.maxJsonBytes,
    maxInflightRequests: c.limits.maxInflightRequests,
    logLevel: c.logging.level,
    logFormat: c.logging.format,
    sources,
    resolved,
  };
}

/**
 * Configuration from the config file (REELFORGE_CONFIG) and environment
 * variables (see docs/CONFIG.md). Throws ConfigError listing every problem.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const sources: ConfigSources = { env, file: loadConfigFile(env) };
  return serverConfigFrom(resolveConfig(sources), sources);
}

/**
 * Apply runtime-changeable settings to a running server's config object (the
 * app reads it on every request). At start (`keys` null) only values set at
 * runtime are applied; after a change, the new effective value of each key.
 */
export function applyServerSettings(config: ServerConfig, resolved: ResolvedConfig, keys: string[] | null): void {
  const use = (key: string) => (keys === null ? resolved.settings.get(key)?.source === 'runtime' : keys.includes(key));
  const c = resolved.config;
  if (use('server.allowedHosts')) config.allowedHosts = allowedHostsFor(config.publicUrl, c.server.allowedHosts);
  if (use('limits.rateLimitPerMinute')) config.rateLimitPerMinute = c.limits.rateLimitPerMinute;
  if (use('limits.maxUploadBytes')) config.maxUploadBytes = c.limits.maxUploadBytes;
  if (use('limits.maxJsonBytes')) config.maxJsonBytes = c.limits.maxJsonBytes;
  if (use('limits.maxInflightRequests')) config.maxInflightRequests = c.limits.maxInflightRequests;
  if (use('limits.renderConcurrency')) config.renderConcurrency = c.limits.renderConcurrency;
  if (use('logging.level')) config.logLevel = c.logging.level;
}

/**
 * Engines and the media pipeline read a few settings from process.env
 * (REELFORGE_CHROMIUM_PATH, FFMPEG_PATH, ...). Values from the config file or a
 * REELFORGE_* name are exported under the name that code reads.
 */
export function exportProcessEnv(resolved: ResolvedConfig, target: NodeJS.ProcessEnv = process.env): void {
  for (const s of resolved.settings.values()) {
    const name = s.def.processEnv;
    if (!name || s.source === 'default' || s.value === undefined) continue;
    target[name] = typeof s.value === 'boolean' ? (s.value ? '1' : '0') : String(s.value);
  }
}

export type LogLevel = ServerConfig['logLevel'];

/**
 * The server logger for this configuration: JSON lines or readable lines
 * (observability.logs.exporter), filtered by the runtime log level, secrets
 * redacted (D-051). The OTLP part is attached by Observability.
 */
export function createLogger(config: Pick<ServerConfig, 'logLevel' | 'resolved'>, quiet = false, write?: StructuredLoggerOptions['write']): StructuredLogger {
  const o = config.resolved.config.observability;
  const logger = new StructuredLogger({ level: () => config.logLevel, exporter: o.logs.exporter, service: o.serviceName, quiet, write });
  logger.redactor.setSecrets(secretValues(config.resolved));
  return logger;
}
