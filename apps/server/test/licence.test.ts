import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@reelforge/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { startMockLicenceServer, type MockLicenceServer } from '../../../e2e/mock-licence/server.mjs';
import { testDatabase } from './serverProcess';

/**
 * Licence activation end to end on a real HTTP server against the mock
 * licence server (#25, D-028): valid, limit_reached, revoked, offline within
 * and beyond the grace period (injected clock), 429, REST + MCP + audit.
 * Never the real licence server.
 */
const { dir, cleanup } = tempDir('reelforge-licence-srv-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const KEY = 'MOCKA-BCDEF-GHJKL-MNPQR-STUVW';
const KEY_TEAM = 'MOCKB-BCDEF-GHJKL-MNPQR-STUVW';
const ORG = '6b01478bb42d2c444e99fcd8-mocklice';
const DAY = 86_400_000;
// Starts at the real time: the mock server's HTTP Date is the real clock, and a local clock
// behind the licence server's time gets no grace (clock_skew, D-089). Tests only move it forward.
const clock = { t: Date.now() };
let mock: MockLicenceServer;
let server: StartedServer;
let admin: string;
let reader: string;
let dropDb: () => Promise<void> = async () => undefined;
let env: NodeJS.ProcessEnv;

const registry = () => new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));
const start = (dataDir: string, extraEnv: NodeJS.ProcessEnv = {}) =>
  startServer({ dataDir, port: 0, host: '127.0.0.1' }, { registry, env: { ...env, ...extraEnv }, quiet: true, licence: { now: () => clock.t } });

async function api(method: string, path: string, opts: { key?: string; body?: unknown; srv?: StartedServer } = {}) {
  const res = await fetch(`${(opts.srv ?? server).url}${path}`, {
    method,
    headers: { authorization: `Bearer ${opts.key ?? admin}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function mcp(key: string) {
  const client = new Client({ name: 'licence-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
    return { isError: Boolean(r.isError), body: JSON.parse(r.content[0]!.text!) };
  };
  return { client, call };
}

beforeAll(async () => {
  mock = await startMockLicenceServer({ orgId: ORG, keys: [{ key: KEY, activationLimit: 1 }, { key: KEY_TEAM, activationLimit: 1 }] });
  const database = await testDatabase(dir);
  dropDb = database.drop;
  env = { ...database.env, REELFORGE_SECRET_KEY: 'licence-server-test-secret-0123456789ab', REELFORGE_LICENCE_SERVER_URL: mock.url, REELFORGE_LICENCE_ORG_ID: ORG };
  server = await start(join(dir, 'data'));
  admin = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
  reader = (await server.service.keys.create('reader', ['read', 'write', 'render'])).key;
  await server.service.createProject(sample);
}, 60_000);
afterAll(async () => {
  await server?.close();
  await mock?.close();
  await dropDb();
  cleanup();
});

describe('licence over REST and MCP (mock licence server)', () => {
  it('no key: GET /v1/licence says unlicensed; renders are refused with licence_required and a fix; no request to the licence server', async () => {
    const r = await api('GET', '/v1/licence', { key: reader });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'unlicensed', reason: 'no_key', renderAllowed: false, mode: 'required', key: null, licenceServer: { url: mock.url, orgId: ORG } });
    const render = await api('POST', '/v1/projects/sample-reel/renders', { key: reader, body: {} });
    expect(render.status).toBe(403);
    expect(render.body.error).toMatchObject({ code: 'licence_required', details: { licence: { status: 'unlicensed' } } });
    expect(render.body.error.message).toMatch(/activate_licence/);
    const caps = await api('GET', '/v1/capabilities', { key: reader });
    expect(caps.body.licence).toMatchObject({ status: 'unlicensed', renderAllowed: false });
    // Reading and listing still work.
    expect((await api('GET', '/v1/projects', { key: reader })).status).toBe(200);
    expect(mock.requests).toEqual([]);
  });

  it('POST /v1/licence needs admin; with a key it stores it encrypted, activates (key + instance only) and renders work', async () => {
    expect((await api('POST', '/v1/licence', { key: reader, body: { key: KEY } })).status).toBe(403);
    const r = await api('POST', '/v1/licence', { body: { key: KEY } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'valid', renderAllowed: true, key: 'MOCKA-*****-*****-*****-*****', keySource: 'runtime', item: { title: 'ReelForge Studio (mock)' }, activations: { used: 1, limit: 1 } });
    expect(JSON.stringify(r.body)).not.toContain('BCDEF');
    expect(mock.activations(KEY)).toEqual([r.body.instanceId]);
    // Privacy contract: only the key and the instance id, no credentials or extra headers.
    for (const req of mock.requests) {
      expect(req.fields.every((f) => f === 'key' || f === 'instance')).toBe(true);
      expect(req.headers).not.toContain('authorization');
      expect(req.headers).not.toContain('cookie');
      expect(req.org).toBe(ORG);
    }
    const cfg = await api('GET', '/v1/config?prefix=licence');
    expect(cfg.body.settings.find((s: { key: string }) => s.key === 'licence.key')).toMatchObject({ value: 'set', atRest: 'aes-256-gcm' });
    const render = await api('POST', '/v1/projects/sample-reel/renders', { key: reader, body: {} });
    expect(render.status).toBe(202);
    const done = await api('GET', `/v1/jobs/${render.body.job.id}?wait=30`, { key: reader });
    expect(done.body.status).toBe('succeeded');
    const audit = await server.service.repos.audit.list();
    expect(audit.some((a) => a.action === 'licence.activate' && a.data?.status === 'valid')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('BCDEF-GHJKL');
  }, 60_000);

  it('MCP: get_licence (read), activate_licence / deactivate_licence (admin)', async () => {
    const agent = await mcp(reader);
    const g = await agent.call('get_licence');
    expect(g.isError).toBe(false);
    expect(g.body).toMatchObject({ status: 'valid', key: 'MOCKA-*****-*****-*****-*****' });
    const refused = await agent.call('activate_licence', {});
    expect(refused.isError).toBe(true);
    expect(refused.body.error.code).toBe('forbidden');
    const caps = await agent.call('get_capabilities');
    expect(caps.body.licence).toMatchObject({ status: 'valid', renderAllowed: true });
    await agent.client.close();
  });

  it('limit_reached on a second server with the same key; deactivate on the first frees the slot', async () => {
    // Another server: its own data directory and database (so its own instance id).
    const db2 = await testDatabase(dir);
    const second = await start(join(dir, 'data-second'), db2.env);
    try {
      const k2 = (await second.service.keys.create('admin2', ['admin', 'owner'])).key;
      const r = await api('POST', '/v1/licence', { key: k2, body: { key: KEY }, srv: second });
      expect(r.body).toMatchObject({ status: 'invalid', reason: 'limit_reached', renderAllowed: false });
      expect(r.body.fix).toMatch(/deactivate_licence/);
      // Free the activation on the first server (MCP, admin).
      const adminMcp = await mcp(admin);
      const d = await adminMcp.call('deactivate_licence');
      expect(d.body).toMatchObject({ status: 'invalid', reason: 'deactivated', renderAllowed: false });
      await adminMcp.client.close();
      expect(mock.activations(KEY)).toEqual([]);
      const refused = await api('POST', '/v1/projects/sample-reel/renders', { key: reader, body: {} });
      expect(refused.body.error).toMatchObject({ code: 'licence_invalid', details: { licence: { reason: 'deactivated' } } });
      // The second server takes it.
      const again = await api('POST', '/v1/licence', { key: k2, body: {}, srv: second });
      expect(again.body).toMatchObject({ status: 'valid' });
      expect(mock.activations(KEY)).toEqual([again.body.instanceId]);
      await api('DELETE', '/v1/licence', { key: k2, srv: second });
    } finally {
      await second.close();
      await db2.drop();
    }
    // Back on the first server with another key for the rest of the suite.
    const r = await api('POST', '/v1/licence', { body: { key: KEY_TEAM } });
    expect(r.body).toMatchObject({ status: 'valid', key: 'MOCKB-*****-*****-*****-*****' });
  }, 60_000);

  it('offline within 14 days: grace (warning in /v1/licence and capabilities), renders allowed; 429 backs off; beyond 14 days: refused', async () => {
    const lastSuccess = server.service.getLicence().lastSuccessAt!;
    mock.setMode('drop');
    clock.t += 3 * DAY;
    let r = await api('POST', '/v1/licence', { body: {} });
    expect(r.body).toMatchObject({ status: 'grace', renderAllowed: true, lastSuccessAt: lastSuccess, lastError: { kind: 'unreachable' } });
    expect(r.body.graceUntil).toBe(new Date(Date.parse(lastSuccess) + 14 * DAY).toISOString());
    expect(r.body.warning).toMatch(/renders keep working until/);
    expect((await api('GET', '/v1/capabilities', { key: reader })).body.licence).toMatchObject({ status: 'grace', warning: expect.stringMatching(/offline grace/) });
    const render = await api('POST', '/v1/projects/sample-reel/renders', { key: reader, body: {} });
    expect(render.status).toBe(202);
    await api('GET', `/v1/jobs/${render.body.job.id}?wait=30`, { key: reader });

    mock.setMode('rate_limited');
    r = await api('POST', '/v1/licence', { body: {} });
    expect(r.body).toMatchObject({ status: 'grace', lastError: { kind: 'rate_limited', status: 429, code: 'LICENSE_CHECKS_LIMITED' } });
    expect(Date.parse(r.body.nextCheckAt) - clock.t).toBeGreaterThanOrEqual(120_000);

    mock.setMode('drop');
    clock.t = Date.parse(lastSuccess) + 15 * DAY;
    r = await api('POST', '/v1/licence', { body: {} });
    expect(r.body).toMatchObject({ status: 'invalid', reason: 'grace_expired', renderAllowed: false });
    const refused = await api('POST', '/v1/projects/sample-reel/preview', { key: reader, body: {} });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: 'licence_invalid', details: { licence: { reason: 'grace_expired' } } });
    expect(refused.body.error.message).toMatch(/more than 14 days/);

    // Back online: valid at the next check.
    mock.setMode('normal');
    r = await api('POST', '/v1/licence', { body: {} });
    expect(r.body.status).toBe('valid');
  }, 60_000);

  it('revoked: refused after the next check; reading, listing and downloading existing renders still work', async () => {
    mock.revoke(KEY_TEAM);
    clock.t += DAY;
    const r = await api('POST', '/v1/licence', { body: {} });
    expect(r.body).toMatchObject({ status: 'invalid', reason: 'revoked' });
    const refused = await api('POST', '/v1/projects/sample-reel/renders', { key: reader, body: {} });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('licence_invalid');
    expect(refused.body.error.details.licence.fix).toMatch(/support/);
    const renders = await api('GET', '/v1/projects/sample-reel/renders', { key: reader });
    expect(renders.status).toBe(200);
    expect(renders.body.renders.length).toBeGreaterThan(0);
    const file = await fetch(new URL(renders.body.renders[0].downloadUrl, server.url));
    expect(file.status).toBe(200);
    expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it('a restart on the same database keeps the instance id and the stored state (no network needed to read it)', async () => {
    const before = server.service.getLicence();
    await server.close();
    mock.setMode('drop');
    server = await start(join(dir, 'data'));
    const after = server.service.getLicence();
    expect(after.instanceId).toBe(before.instanceId);
    expect(after.lastSuccessAt).toBe(before.lastSuccessAt);
    mock.setMode('normal');
  }, 60_000);
});
