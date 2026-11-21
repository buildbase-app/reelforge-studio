import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { ReelforgeService, type PluginRegistry, type ServiceConfig } from '@reelforge/core';
import { defaultDatabaseUrl, prepareDatabase, type Database } from '@reelforge/db';
import { createApp } from './app';
import { applyServerSettings, createLogger, exportProcessEnv, loadConfig, type ServerConfig } from './config';
import { createDefaultRegistry } from './registry';

export const SERVER_VERSION = '0.1.0';

export interface StartedServer {
  url: string;
  port: number;
  service: ReelforgeService;
  config: ServerConfig;
  db: Database;
  close(): Promise<void>;
}

/** Build the service and app, apply the bootstrap key, and listen. */
export async function startServer(
  overrides: Partial<ServerConfig> = {},
  opts: {
    /** The plugins; a function receives the environment object providers must read (runtime settings are written into it). */
    registry?: PluginRegistry | ((providerEnv: NodeJS.ProcessEnv) => PluginRegistry);
    env?: NodeJS.ProcessEnv;
    quiet?: boolean;
    /** Licence checks: tests inject the licence API, fetch or clock (ServiceConfig.licence). */
    licence?: ServiceConfig['licence'];
  } = {}
): Promise<StartedServer> {
  const env = opts.env ?? process.env;
  const config: ServerConfig = { ...loadConfig(env), ...overrides };
  // A data directory given in code (tests) also moves the default SQLite file.
  if (overrides.dataDir && !overrides.databaseUrl && config.resolved.settings.get('database.url')?.source === 'default') {
    config.databaseUrl = defaultDatabaseUrl(config.dataDir);
  }
  exportProcessEnv(config.resolved);
  await mkdir(config.dataDir, { recursive: true });
  const logger = createLogger(config, opts.quiet);
  const log = (line: string) => logger('info', line);
  if (config.sources.file) log(`config file: ${config.sources.file.path}`);
  for (const w of config.resolved.warnings) logger('warn', w);
  const { db, imported } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: config.migrateOnStart, connectTimeoutSeconds: config.dbConnectTimeoutSeconds, log });
  if (imported) {
    const { warnings, ...counts } = imported;
    log(`imported v0.1 data from ${config.dataDir}: ${JSON.stringify(counts)}${warnings.length ? ` (${warnings.length} warnings)` : ''}`);
  }
  // Providers read their keys from this object; keys set through the API are written into it.
  const providerEnv: NodeJS.ProcessEnv = { ...env };
  let service: ReelforgeService;
  try {
    const registry = typeof opts.registry === 'function' ? opts.registry(providerEnv) : (opts.registry ?? createDefaultRegistry(providerEnv));
    service = await ReelforgeService.create(registry, {
      repositories: db.repositories(),
      providerEnv,
      dataDir: config.dataDir,
      cacheDir: config.cacheDir,
      renderConcurrency: config.renderConcurrency,
      serverVersion: SERVER_VERSION,
      publicUrl: config.publicUrl,
      maxUploadBytes: config.maxUploadBytes,
      configSources: config.sources,
      licence: opts.licence,
      log: logger,
    });
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
  // Runtime settings stored in the database win over the file and environment; changes apply at once.
  applyServerSettings(config, service.settings.current, null);
  service.settings.onChange((resolved, keys) => {
    applyServerSettings(config, resolved, keys);
    logger('info', `configuration changed at runtime: ${keys.join(', ')}`);
  });
  if (await service.keys.bootstrap(config.bootstrapKey)) {
    log('stored REELFORGE_BOOTSTRAP_KEY as admin key "bootstrap"');
  }
  const app = createApp({ service, config });
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s));
  });
  // Agents poll with keep-alive connections; a short server keep-alive races with
  // their next request (ECONNRESET) while a render keeps the event loop busy.
  const http = server as unknown as { keepAliveTimeout: number; headersTimeout: number };
  http.keepAliveTimeout = 65_000;
  http.headersTimeout = 66_000;
  const port = (server.address() as AddressInfo).port;
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const url = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${port}`;
  log(`ReelForge Studio ${SERVER_VERSION} listening on ${url} (data: ${config.dataDir})`);
  log(`REST ${url}/v1  MCP ${url}/mcp`);
  log(`database: ${db.kind} ${db.displayUrl}`);
  if (existsSync(join(config.dataDir, 'secrets.json'))) {
    logger('warn', `${join(config.dataDir, 'secrets.json')} (v0.1) still holds provider keys in plain text; they are in the database now${service.settings.cipher ? ' (encrypted)' : ''}: delete the file once you have checked them`);
  }
  if (!service.settings.cipher) log('REELFORGE_SECRET_KEY is not set: provider keys and other secrets cannot be stored through the API (see docs/CONFIG.md)');
  if ((await service.keys.count()) === 0) {
    log('no API keys yet: run `pnpm keys:create --name me` or set REELFORGE_BOOTSTRAP_KEY');
  }
  return {
    url,
    port,
    service,
    config,
    db,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      service.licence.stop();
      await service.jobs.flush();
      await db.close();
    },
  };
}
