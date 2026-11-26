import { serve, type ServerType } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry, ReelforgeService, type EnginePlugin } from '@renderweld/core';
import { prepareDatabase } from '@renderweld/db';
import { createApp, loadConfig } from '@renderweld/server';
import { buildDashboard } from '../build';

/**
 * A real studio on a random port with the dashboard on: SQLite, the given
 * engines, an admin, a read and a render key. For the browser test and the
 * screenshot script.
 */
export async function startStudio(engines: EnginePlugin[], opts: { dashboard?: boolean; env?: Record<string, string>; register?: (r: PluginRegistry) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reelforge-dashboard-'));
  const assets = join(dir, 'dashboard');
  const built = await buildDashboard(assets);
  const env = { REELFORGE_DATA_DIR: join(dir, 'data'), REELFORGE_DASHBOARD_ENABLED: String(opts.dashboard ?? true), ...opts.env };
  const config = { ...loadConfig(env), dashboardAssetsDir: assets };
  const { db } = await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir });
  const registry = new PluginRegistry();
  for (const e of engines) registry.registerEngine(e);
  opts.register?.(registry);
  const service = await ReelforgeService.create(registry, {
    repositories: db.repositories(),
    dataDir: config.dataDir,
    configSources: { env: { ...env, REELFORGE_SECRET_KEY: 'test-secret-key-0123456789-abcdefghij', REELFORGE_LICENCE_MODE: 'off' } },
  });
  const keys = {
    // Upgraded installs give admin keys the owner scope (#304); runtime settings and storage need it.
    admin: (await service.keys.create('ops-admin', ['admin', 'owner'])).key,
    read: (await service.keys.create('ops-viewer', ['read'])).key,
    render: (await service.keys.create('render-agent', ['read', 'write', 'render'])).key,
  };
  const app = createApp({ service, config });
  const server: ServerType = await new Promise((ok) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => ok(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  // localhost is an allowed host by default (the dashboard has the same Host check as /mcp).
  const url = `http://localhost:${port}`;

  const call = async (method: string, path: string, body?: unknown, key = keys.admin) => {
    const res = await fetch(url + path, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as any) : null };
  };
  const waitFor = async (jobId: string, done = ['succeeded', 'failed', 'cancelled']) => {
    // Long-poll for finished states (few requests: the keys have a rate limit); poll for "running".
    const wait = done.includes('running') ? 0 : 20;
    for (let i = 0; i < 600; i++) {
      const job = (await call('GET', `/v1/jobs/${jobId}?wait=${wait}`)).json;
      if (done.includes(job.status)) return job;
      if (!wait) await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`job ${jobId} did not reach ${done.join('/')}`);
  };

  return {
    url,
    keys,
    service,
    built,
    call,
    waitFor,
    async stop() {
      await new Promise<void>((ok) => server.close(() => ok()));
      await service.jobs.flush().catch(() => undefined);
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A two-scene reel of `<engine>-title` scenes (html or hyperframes), `seconds` per scene. */
export function htmlReel(projectId: string, title: string, seconds = 2, engine = 'html') {
  const kicker = (k: string) => (engine === 'html' ? { kicker: k } : {});
  return {
    schemaVersion: '0.2',
    projectId,
    title,
    output: { width: 1080, height: 1920, fps: 30, format: 'mp4' },
    theme: 'midnight',
    scenes: [
      { id: 'hook', engine, template: `${engine}-title`, durationSeconds: seconds, props: { ...kicker('Launch'), headline: title, subline: 'Rendered on this studio' } },
      { id: 'cta', engine, template: `${engine}-title`, durationSeconds: seconds, props: { ...kicker('Next'), headline: 'Swap the props, render again', subline: 'Same manifest, any agent' } },
    ],
  };
}
