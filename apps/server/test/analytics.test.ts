import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, ReelforgeService } from '@reelforge/core';
import { prepareDatabase, type Database } from '@reelforge/db';
import { REST_ROUTES, TOOLS, createApp, loadConfig, type ServerConfig } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

/**
 * GET /v1/analytics/summary and get_analytics_summary (#292): read scope, the
 * range caps, REST and MCP agree, figures from real jobs and manifests on the
 * database; and the config entries the dashboard's settings page edits from.
 */
const { dir, cleanup } = tempDir('reelforge-analytics-');
let db: Database;
let service: ReelforgeService;
let admin: string;
let reader: string;
let config: ServerConfig;
let app: ReturnType<typeof createApp>;
let renderId = '';

beforeAll(async () => {
  config = loadConfig({ REELFORGE_DATA_DIR: join(dir, 'data') });
  db = (await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir })).db;
  const registry = new PluginRegistry().registerEngine(fakeEngine('html')).registerEngine(fakeEngine('remotion', { fail: true }));
  service = await ReelforgeService.create(registry, {
    repositories: db.repositories(),
    dataDir: config.dataDir,
    configSources: { env: { REELFORGE_SECRET_KEY: 'test-secret-key-0123456789-abcdefghij', REELFORGE_LICENCE_MODE: 'off' } },
  });
  admin = (await service.keys.create('admin', ['admin'])).key;
  reader = (await service.keys.create('viewer', ['read'])).key;
  app = createApp({ service, config });

  const reel = (projectId: string, engine: string, template: string, seconds = 1) => ({
    schemaVersion: '0.2',
    projectId,
    title: projectId,
    output: { width: 360, height: 640, fps: 30, format: 'mp4' },
    scenes: [
      { id: 'a', engine, template, durationSeconds: seconds, props: { headline: 'One' } },
      { id: 'b', engine, template, durationSeconds: seconds, props: { headline: 'Two' } },
    ],
  });
  const run = async (projectId: string) => {
    const job = ((await (await req('POST', `/v1/projects/${projectId}/renders`, { body: {} })).json()) as any).job;
    return ((await (await req('GET', `/v1/jobs/${job.id}?wait=30`)).json()) as any);
  };
  expect((await req('POST', '/v1/projects', { body: reel('stats-ok', 'html', 'html-title') })).status).toBe(201);
  expect((await req('POST', '/v1/projects', { body: reel('stats-bad', 'remotion', 'kinetic-title', 2) })).status).toBe(201);
  const ok = await run('stats-ok');
  expect(ok.status).toBe('succeeded');
  renderId = ok.result.renderId;
  expect((await run('stats-bad')).status).toBe('failed');
}, 120_000);
afterAll(async () => {
  await service?.jobs.flush();
  await db?.close();
  cleanup();
});

function req(method: string, path: string, opts: { key?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { host: 'localhost' };
  const key = opts.key === undefined ? admin : opts.key;
  if (key) headers.authorization = `Bearer ${key}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}

describe('GET /v1/analytics/summary', () => {
  it('is a read-scope route with an MCP tool of the same scope', () => {
    expect(REST_ROUTES.find((r) => r.path === '/v1/analytics/summary')).toMatchObject({ method: 'GET', scope: 'read', tool: 'get_analytics_summary' });
    expect(TOOLS.find((t) => t.name === 'get_analytics_summary')).toMatchObject({ scope: 'read', annotations: { readOnlyHint: true } });
  });

  it('needs a key; a read key gets the figures of the real jobs and manifests', async () => {
    expect((await req('GET', '/v1/analytics/summary', { key: null })).status).toBe(401);
    const r = await req('GET', '/v1/analytics/summary', { key: reader });
    expect(r.status).toBe(200);
    const s = (await r.json()) as any;
    expect(s.range).toMatchObject({ bucket: 'day', maxRangeDays: 90 });
    expect(s.series).toHaveLength(30);
    expect(s.totals).toMatchObject({ jobs: 2, renders: 2, succeeded: 1, failed: 1, successRate: 0.5, failureRate: 0.5 });
    expect(s.series.at(-1)).toMatchObject({ jobs: 2, succeeded: 1, failed: 1 });
    expect(s.scan).toMatchObject({ jobs: 2, truncated: false });
    expect(s.renderTime.samples).toBe(1);
    expect(s.queueWait.samples).toBe(2);
    expect(s.minutesRendered.renders).toBeCloseTo(2 / 60, 3);
    // Render time per engine from the succeeded render's manifest: two html scenes.
    expect(s.engines).toMatchObject({ renders: 1, sampled: 1 });
    expect(s.engines.byEngine).toEqual([expect.objectContaining({ engine: 'html', scenes: 2, samples: 2 })]);
    expect(s.errors).toEqual([expect.objectContaining({ code: expect.any(String), count: 1 })]);
    expect(s.storage.totalBytes).toBeGreaterThan(0);
    expect(s.storage.renders.count).toBe(1);
    expect(s.webhooks.totals).toMatchObject({ pending: 0, succeeded: 0, dead: 0, successRate: null });
    // No storage location or path for a read key (D-088): only sizes.
    expect(JSON.stringify(s)).not.toContain(config.dataDir);
    expect(JSON.stringify(s)).not.toContain(renderId);
  });

  it('takes from, to and bucket, and refuses ranges over the caps with 400', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const hourly = (await (await req('GET', '/v1/analytics/summary?bucket=hour', { key: reader })).json()) as any;
    expect(hourly.series).toHaveLength(25);
    expect(hourly.totals.jobs).toBe(2);
    const day = (await (await req('GET', `/v1/analytics/summary?from=${today}&to=${today}`, { key: reader })).json()) as any;
    expect(day.series).toHaveLength(1);
    expect(day.totals.jobs).toBe(2);
    for (const q of ['bucket=week', 'from=2020-01-01', 'from=2026-11-01T00:00:00Z&to=2026-10-01T00:00:00Z', 'from=nope', `from=2026-01-01&to=2026-12-31`]) {
      const r = await req('GET', `/v1/analytics/summary?${q}`, { key: reader });
      expect(r.status, q).toBe(400);
      expect(((await r.json()) as any).error.code, q).toBe('bad_request');
    }
  });

  it('get_analytics_summary over MCP returns the same figures as REST', async () => {
    const auth = await service.keys.authenticate(reader);
    if (!auth?.ok) throw new Error('reader key refused');
    const tool = TOOLS.find((t) => t.name === 'get_analytics_summary')!;
    const viaMcp = (await tool.run({ bucket: 'day' }, { service, auth: auth.auth, config })) as any;
    const viaRest = (await (await req('GET', '/v1/analytics/summary?bucket=day', { key: reader })).json()) as any;
    const strip = ({ generatedAt: _g, range: { to: _t, ...range }, ...rest }: any) => ({ ...rest, range });
    expect(strip(viaMcp)).toEqual(strip(viaRest));
    await expect(tool.run({ bucket: 'hour', from: '2026-01-01' }, { service, auth: auth.auth, config })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });
});

describe('config entries for the settings page', () => {
  it('say each setting\'s kind, enum options and number bounds, and still mask secrets', async () => {
    const r = (await (await req('GET', '/v1/config')).json()) as any;
    const by = (key: string) => r.settings.find((s: any) => s.key === key);
    expect(by('dashboard.enabled')).toMatchObject({ kind: 'boolean', scope: 'runtime' });
    expect(by('server.port')).toMatchObject({ kind: 'integer', min: 0, max: 65535, scope: 'startup' });
    const en = r.settings.find((s: any) => s.kind === 'enum');
    expect(en.options.length).toBeGreaterThan(1);
    expect(en.options).toContain(en.value ?? en.options[0]);
    for (const s of r.settings) expect(['string', 'integer', 'number', 'boolean', 'list', 'enum', 'path', 'url']).toContain(s.kind);
    const secret = r.settings.find((s: any) => s.secret);
    expect(['set', 'not set', null, undefined]).toContain(secret.value);
    // A read key cannot read or change the configuration (admin scope).
    expect((await req('GET', '/v1/config', { key: reader })).status).toBe(403);
    expect((await req('PATCH', '/v1/config', { key: reader, body: { settings: { 'dashboard.enabled': true } } })).status).toBe(403);
  });
});
