import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, ReelforgeService } from '@renderweld/core';
import { prepareDatabase, type Database } from '@renderweld/db';
import { DASHBOARD_CSP, TOOLS, createApp, loadConfig, type ServerConfig } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

/**
 * The dashboard route (#292, D-115): off by default, on by file/env or at
 * runtime, strict headers, the same Host check as /mcp; and the API it uses:
 * no data without a key, a read key cannot cancel or retry, GET /v1/me.
 */
const { dir, cleanup } = tempDir('reelforge-dashboard-route-');
const assets = join(dir, 'dashboard');
let db: Database;
let service: ReelforgeService;
let admin: string;
let reader: string;
let config: ServerConfig;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  // A stand-in for the built dashboard: the route serves whatever the build wrote.
  mkdirSync(join(assets, 'assets'), { recursive: true });
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>RenderWeld</title><script type="module" src="assets/app-0123456789.js"></script>');
  writeFileSync(join(assets, 'assets', 'app-0123456789.js'), 'export {};');
  writeFileSync(join(assets, 'assets', 'app-0123456789.css'), 'body{}');
  writeFileSync(join(assets, 'assets', 'icon-192-0123456789.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  writeFileSync(join(assets, 'assets', 'manifest-0123456789.webmanifest'), '{"name":"RenderWeld"}');
  config = { ...loadConfig({ REELFORGE_DATA_DIR: join(dir, 'data') }), dashboardAssetsDir: assets };
  db = (await prepareDatabase({ url: config.databaseUrl, dataDir: config.dataDir })).db;
  service = await ReelforgeService.create(new PluginRegistry().registerEngine(fakeEngine('html', { delayPerFrameMs: 50 })), {
    repositories: db.repositories(),
    dataDir: config.dataDir,
    configSources: { env: { REELFORGE_SECRET_KEY: 'test-secret-key-0123456789-abcdefghij', REELFORGE_LICENCE_MODE: 'off' } },
  });
  admin = (await service.keys.create('admin', ['admin', 'owner'])).key;
  reader = (await service.keys.create('viewer', ['read'])).key;
  app = createApp({ service, config });
});
afterAll(async () => {
  await service?.jobs.flush();
  await db?.close();
  cleanup();
});

function req(method: string, path: string, opts: { key?: string | null; body?: unknown; host?: string } = {}) {
  const headers: Record<string, string> = { host: opts.host ?? 'localhost' };
  const key = opts.key === undefined ? admin : opts.key;
  if (key) headers.authorization = `Bearer ${key}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const setEnabled = async (on: boolean) => expect((await req('PATCH', '/v1/config', { body: { settings: { 'dashboard.enabled': on } } })).status).toBe(200);

describe('dashboard route', () => {
  it('is off by default: 404 that says how to turn it on', async () => {
    expect(config.resolved.config.dashboard.enabled).toBe(false);
    for (const path of ['/dashboard', '/dashboard/', '/dashboard/assets/app-0123456789.js']) {
      const r = await req('GET', path, { key: null });
      expect(r.status, path).toBe(404);
      expect(((await r.json()) as any).error.message).toContain('dashboard.enabled');
    }
  });

  it('turns on from the environment (REELFORGE_DASHBOARD_ENABLED) and the config file', () => {
    expect(loadConfig({ REELFORGE_DASHBOARD_ENABLED: 'true' }).resolved.config.dashboard.enabled).toBe(true);
    const file = join(dir, 'reelforge.yaml');
    writeFileSync(file, 'dashboard:\n  enabled: true\n');
    expect(loadConfig({ REELFORGE_CONFIG: file }).resolved.config.dashboard.enabled).toBe(true);
  });

  it('turns on and off at runtime (PATCH /v1/config, admin only) without a restart', async () => {
    expect((await req('PATCH', '/v1/config', { key: reader, body: { settings: { 'dashboard.enabled': true } } })).status).toBe(403);
    await setEnabled(true);
    expect((await req('GET', '/dashboard/', { key: null })).status).toBe(200);
    await setEnabled(false);
    expect((await req('GET', '/dashboard/', { key: null })).status).toBe(404);
  });

  it('serves the page with a strict CSP, no framing and no cookie, without a key', async () => {
    await setEnabled(true);
    const redirect = await req('GET', '/dashboard', { key: null });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('/dashboard/');

    const page = await req('GET', '/dashboard/', { key: null });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toBe(DASHBOARD_CSP);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(page.headers.get('set-cookie')).toBeNull();
    expect(await page.text()).toContain('assets/app-0123456789.js');

    const js = await req('GET', '/dashboard/assets/app-0123456789.js', { key: null });
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(js.headers.get('content-security-policy')).toBe(DASHBOARD_CSP);
    expect((await req('GET', '/dashboard/assets/app-0123456789.css', { key: null })).headers.get('content-type')).toBe('text/css; charset=utf-8');
    // The kit's app icons and the web app manifest (#413), same-origin only.
    expect(csp).toContain("manifest-src 'self'");
    const png = await req('GET', '/dashboard/assets/icon-192-0123456789.png', { key: null });
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    const manifest = await req('GET', '/dashboard/assets/manifest-0123456789.webmanifest', { key: null });
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json');
    expect(manifest.headers.get('content-security-policy')).toBe(DASHBOARD_CSP);
  });

  it('serves only the built files: no traversal, no other names', async () => {
    await setEnabled(true);
    // (A literal "../" is resolved by the URL parser before the server sees it.)
    for (const path of ['/dashboard/assets/%2e%2e/%2e%2e/package.json', '/dashboard/assets/..%2f..%2fpackage.json', '/dashboard/assets/missing-1.js', '/dashboard/package.json', '/dashboard/assets/app.map']) {
      expect((await req('GET', path, { key: null })).status, path).toBe(404);
    }
  });

  it('answers only on allowed hosts (DNS-rebinding protection, like /mcp)', async () => {
    await setEnabled(true);
    const r = await req('GET', '/dashboard/', { key: null, host: 'evil.example' });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe('forbidden_host');
  });

  it('says when the assets were not built', async () => {
    await setEnabled(true);
    const bare = createApp({ service, config: { ...config, dashboardAssetsDir: join(dir, 'nothing') } });
    const r = await bare.request('/dashboard/', { headers: { host: 'localhost' } });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error.code).toBe('dashboard_not_built');
  });
});

describe('the API the dashboard uses', () => {
  it('gives no data without a key, with the dashboard on', async () => {
    await setEnabled(true);
    for (const path of ['/v1/me', '/v1/jobs', '/v1/projects', '/v1/renders/run_abc', '/v1/jobs/job_abc/events']) {
      const r = await req('GET', path, { key: null });
      expect(r.status, path).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain('Bearer');
    }
    expect((await req('POST', '/v1/jobs/job_abc/cancel', { key: null })).status).toBe(401);
  });

  it('GET /v1/me names the calling key and its scopes, never the secret; get_me over MCP says the same', async () => {
    const r = await req('GET', '/v1/me', { key: reader });
    expect(r.status).toBe(200);
    const me = (await r.json()) as Record<string, unknown>;
    expect(me).toMatchObject({ name: 'viewer', scopes: ['read'] });
    const text = JSON.stringify(me);
    expect(text).not.toContain(reader);
    expect(text).not.toMatch(/"(hash|salt|secret)"/);
    const auth = (await service.keys.authenticate(reader))!;
    if (!auth.ok) throw new Error('reader key refused');
    const viaMcp = (await TOOLS.find((t) => t.name === 'get_me')!.run({}, { service, auth: auth.auth, config })) as Record<string, unknown>;
    expect(viaMcp).toMatchObject({ id: me.id, name: 'viewer', scopes: ['read'] });
  });

  it('a read key sees jobs and renders but cannot cancel or retry', async () => {
    const manifest = {
      schemaVersion: '0.2',
      projectId: 'dash-route',
      title: 'Dashboard route',
      output: { width: 360, height: 640, fps: 30, format: 'mp4' },
      scenes: [{ id: 'a', engine: 'html', template: 'html-title', durationSeconds: 3, props: { headline: 'Hello' } }],
    };
    expect((await req('POST', '/v1/projects', { body: manifest })).status).toBe(201);
    const job = ((await (await req('POST', '/v1/projects/dash-route/renders', { body: {} })).json()) as any).job;
    expect((await req('GET', `/v1/jobs/${job.id}`, { key: reader })).status).toBe(200);
    expect((await req('GET', '/v1/jobs', { key: reader })).status).toBe(200);

    const cancel = await req('POST', `/v1/jobs/${job.id}/cancel`, { key: reader });
    expect(cancel.status).toBe(403);
    expect(((await cancel.json()) as any).error.code).toBe('forbidden');
    expect(((await (await req('GET', `/v1/jobs/${job.id}`)).json()) as any).status).not.toBe('cancelled');

    expect((await req('POST', `/v1/jobs/${job.id}/cancel`)).status).toBe(200);
    expect(((await (await req('GET', `/v1/jobs/${job.id}?wait=30`)).json()) as any).status).toBe('cancelled');
    expect((await req('POST', `/v1/jobs/${job.id}/retry`, { key: reader })).status).toBe(403);
    // The denied calls are in the audit log (D-055).
    const audit = ((await (await req('GET', '/v1/audit?action=job.cancel')).json()) as any).events ?? [];
    expect(audit.some((e: any) => e.result === 'denied')).toBe(true);
  });

  it('a render says where its files are: driver and key prefix (bucket and root stay admin-only)', async () => {
    const job = ((await (await req('POST', '/v1/projects/dash-route/renders', { body: {} })).json()) as any).job;
    const done = ((await (await req('GET', `/v1/jobs/${job.id}?wait=50`)).json()) as any);
    expect(done.status).toBe('succeeded');
    const r = (await (await req('GET', `/v1/renders/${done.result.renderId}`, { key: reader })).json()) as any;
    expect(r.storage).toEqual({ driver: 'local', prefix: `projects/dash-route/renders/${done.result.renderId}/` });
    expect(JSON.stringify(r)).not.toContain(config.dataDir);
    expect((await req('GET', '/v1/storage', { key: reader })).status).toBe(403);
  }, 60_000);
});
