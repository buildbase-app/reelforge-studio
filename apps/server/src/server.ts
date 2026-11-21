import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { ReelforgeService, type PluginRegistry } from '@reelforge/core';
import { createApp } from './app';
import { loadConfig, type ServerConfig } from './config';
import { createDefaultRegistry } from './registry';

export const SERVER_VERSION = '0.1.0';

export interface StartedServer {
  url: string;
  port: number;
  service: ReelforgeService;
  config: ServerConfig;
  close(): Promise<void>;
}

/** Build the service and app, apply the bootstrap key, and listen. */
export async function startServer(
  overrides: Partial<ServerConfig> = {},
  opts: { registry?: PluginRegistry; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}
): Promise<StartedServer> {
  const config = { ...loadConfig(opts.env ?? process.env), ...overrides };
  await mkdir(config.dataDir, { recursive: true });
  const service = await ReelforgeService.create(opts.registry ?? createDefaultRegistry(opts.env ?? process.env), {
    dataDir: config.dataDir,
    cacheDir: config.cacheDir,
    renderConcurrency: config.renderConcurrency,
    serverVersion: SERVER_VERSION,
    publicUrl: config.publicUrl,
    maxUploadBytes: config.maxUploadBytes,
  });
  if (await service.keys.bootstrap(config.bootstrapKey)) {
    if (!opts.quiet) console.log('[reelforge] stored REELFORGE_BOOTSTRAP_KEY as admin key "bootstrap"');
  }
  const app = createApp({ service, config });
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const url = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${port}`;
  if (!opts.quiet) {
    console.log(`[reelforge] ReelForge Studio ${SERVER_VERSION} listening on ${url} (data: ${config.dataDir})`);
    console.log(`[reelforge] REST ${url}/v1  MCP ${url}/mcp`);
    if ((await service.keys.count()) === 0) {
      console.log('[reelforge] no API keys yet: run `pnpm keys:create --name me` or set REELFORGE_BOOTSTRAP_KEY');
    }
  }
  return {
    url,
    port,
    service,
    config,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}
