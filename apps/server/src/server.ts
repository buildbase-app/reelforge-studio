import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { ReelforgeService, type PluginRegistry } from '@reelforge/core';
import { prepareDatabase, resolveDatabaseUrl, type Database } from '@reelforge/db';
import { createApp } from './app';
import { loadConfig, type ServerConfig } from './config';
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
  opts: { registry?: PluginRegistry; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}
): Promise<StartedServer> {
  const env = opts.env ?? process.env;
  const config = { ...loadConfig(env), ...overrides };
  // A data directory given in code (tests) also moves the default SQLite file.
  if (overrides.dataDir && !overrides.databaseUrl) config.databaseUrl = resolveDatabaseUrl(env, config.dataDir);
  await mkdir(config.dataDir, { recursive: true });
  const log = (line: string) => {
    if (!opts.quiet) console.log(`[reelforge] ${line}`);
  };
  const { db, imported } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrate: config.migrateOnStart, connectTimeoutSeconds: config.dbConnectTimeoutSeconds, log });
  if (imported) {
    const { warnings, ...counts } = imported;
    log(`imported v0.1 data from ${config.dataDir}: ${JSON.stringify(counts)}${warnings.length ? ` (${warnings.length} warnings)` : ''}`);
  }
  // Providers read their keys from this object; keys set through the API are written into it.
  const providerEnv: NodeJS.ProcessEnv = { ...env };
  let service: ReelforgeService;
  try {
    service = await ReelforgeService.create(opts.registry ?? createDefaultRegistry(providerEnv), {
    repositories: db.repositories(),
    providerEnv,
    dataDir: config.dataDir,
    cacheDir: config.cacheDir,
    renderConcurrency: config.renderConcurrency,
    serverVersion: SERVER_VERSION,
    publicUrl: config.publicUrl,
    maxUploadBytes: config.maxUploadBytes,
  });
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
  if (await service.keys.bootstrap(config.bootstrapKey)) {
    if (!opts.quiet) console.log('[reelforge] stored REELFORGE_BOOTSTRAP_KEY as admin key "bootstrap"');
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
  if (!opts.quiet) {
    console.log(`[reelforge] ReelForge Studio ${SERVER_VERSION} listening on ${url} (data: ${config.dataDir})`);
    console.log(`[reelforge] REST ${url}/v1  MCP ${url}/mcp`);
    console.log(`[reelforge] database: ${db.kind} ${db.displayUrl}`);
    if ((await service.keys.count()) === 0) {
      console.log('[reelforge] no API keys yet: run `pnpm keys:create --name me` or set REELFORGE_BOOTSTRAP_KEY');
    }
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
      await service.jobs.flush();
      await db.close();
    },
  };
}
