import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, ReelforgeService } from '@renderweld/core';
import { prepareDatabase, type Database } from '@renderweld/db';
import { createApp, loadConfig, type ServerConfig } from '../src/index';
import { requestBaseUrl } from '../src/app';
import { testDatabase } from './serverProcess';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

// #405: without server.publicUrl, links in answers are absolute from the Host the client used, when it is allowed.

const { dir, cleanup } = tempDir('renderweld-links-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
let db: Database;
let dropDb: () => Promise<void> = async () => undefined;
let service: ReelforgeService;
let app: ReturnType<typeof createApp>;
let admin: string;

beforeAll(async () => {
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));
  const config: ServerConfig = loadConfig({ REELFORGE_DATA_DIR: join(dir, 'data') });
  expect(config.publicUrl).toBeUndefined();
  const database = await testDatabase(dir);
  dropDb = database.drop;
  db = (await prepareDatabase({ url: database.url ?? config.databaseUrl, dataDir: config.dataDir })).db;
  service = await ReelforgeService.create(registry, {
    repositories: db.repositories(),
    dataDir: config.dataDir,
    configSources: { env: { REELFORGE_SECRET_KEY: 'links-test-secret-key-0123456789-abcdef', REELFORGE_LICENCE_MODE: 'off', REELFORGE_TRUST_PROXY: 'true' } },
  });
  admin = (await service.keys.create('admin', ['admin', 'owner'])).key;
  app = createApp({ service, config });
});

afterAll(async () => {
  await service?.jobs.flush();
  await db?.close();
  await dropDb();
  cleanup();
});

const req = (method: string, path: string, headers: Record<string, string>, body?: unknown, key: string | null = admin) =>
  app.request(path, {
    method,
    headers: { ...headers, ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

async function renderVia(headers: Record<string, string>) {
  const project = { ...sample, projectId: `links-${Math.random().toString(36).slice(2, 8)}` };
  const created = await req('POST', '/v1/projects', headers, project);
  expect(created.status, await created.clone().text()).toBe(201);
  const start = await req('POST', `/v1/projects/${project.projectId}/renders`, headers, {});
  expect(start.status).toBe(202);
  const job = await service.jobs.waitFor(((await start.json()) as any).job.id, 60_000);
  expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
  return (job.result as { renderId: string }).renderId;
}

describe('absolute links without server.publicUrl (#405)', () => {
  it('LNK-01 a render answers with links on the Host the client used; downloadUrl works without a key', async () => {
    const h = { host: 'localhost:4321' };
    const renderId = await renderVia(h);
    const render = (await (await req('GET', `/v1/renders/${renderId}`, h)).json()) as any;
    for (const k of ['outputUrl', 'posterUrl', 'manifestUrl', 'downloadUrl']) expect(render[k], k).toMatch(/^http:\/\/localhost:4321\/v1\/renders\//);
    // An agent with nothing but the link gets the file.
    const link = new URL(render.downloadUrl);
    const viaLink = await req('GET', link.pathname + link.search, h, undefined, null);
    expect(viaLink.status).toBe(200);
    expect(viaLink.headers.get('content-type')).toMatch(/^video\/mp4/);
  }, 120_000);

  it('LNK-02 behind a trusted proxy the forwarded scheme is used; a Host that is not allowed gets relative links', async () => {
    const renderId = await renderVia({ host: '127.0.0.1:8080' });
    const viaProxy = (await (await req('GET', `/v1/renders/${renderId}`, { host: '127.0.0.1:8080', 'x-forwarded-proto': 'https' })).json()) as any;
    expect(viaProxy.downloadUrl).toMatch(/^https:\/\/127\.0\.0\.1:8080\/v1\/renders\//);
    const unknown = (await (await req('GET', `/v1/renders/${renderId}`, { host: 'attacker.example' })).json()) as any;
    expect(unknown.downloadUrl).toMatch(/^\/v1\/renders\//);
    expect(unknown.outputUrl).toMatch(/^\/v1\/renders\//);
  }, 120_000);
});

describe('requestBaseUrl (#405)', () => {
  const allowed = { allowedHosts: ['localhost', '127.0.0.1', '[::1]', 'studio.lan'] };
  const probe = async (headers: Record<string, string>, opts: { publicUrl?: string; trustProxy?: boolean } = {}) => {
    const h = new Hono();
    h.get('/x', (c) => c.text(requestBaseUrl(c, { ...allowed, ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}) }, opts.trustProxy ?? false) ?? 'none'));
    return (await h.request('http://ignored/x', { headers })).text();
  };

  it('LNK-03 an allowed Host with its port; IPv6; nothing when server.publicUrl is set', async () => {
    expect(await probe({ host: 'studio.lan:4321' })).toBe('http://studio.lan:4321');
    expect(await probe({ host: '[::1]:4321' })).toBe('http://[::1]:4321');
    expect(await probe({ host: 'localhost' }, { publicUrl: 'https://studio.example.com' })).toBe('none');
  });

  it('LNK-04 X-Forwarded-Proto only with server.trustProxy, and only http or https', async () => {
    expect(await probe({ host: 'localhost', 'x-forwarded-proto': 'https' })).toBe('http://localhost');
    expect(await probe({ host: 'localhost', 'x-forwarded-proto': 'http, https' }, { trustProxy: true })).toBe('https://localhost');
    expect(await probe({ host: 'localhost', 'x-forwarded-proto': 'javascript' }, { trustProxy: true })).toBe('http://localhost');
  });

  it('LNK-05 a missing, unknown or malformed Host gives no base', async () => {
    expect(await probe({})).toBe('none');
    expect(await probe({ host: 'evil.example' })).toBe('none');
    expect(await probe({ host: 'localhost/evil' })).toBe('none');
    expect(await probe({ host: 'localhost:notaport' })).toBe('none');
  });
});
