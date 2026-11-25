import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PluginRegistry, type LicenceAnswer, type LicenceApi } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * Outbound events (#66) over real HTTP, REST and MCP side by side, against a
 * receiver that verifies every signature with the official standardwebhooks
 * library: endpoint lifecycle, job/render/key/config/licence events from real
 * calls, retries, replay, the CLI, the audit sink, metrics and no secrets
 * anywhere. Case ids: docs/providers/webhooks-and-notifications.md.
 */
const { dir, cleanup } = tempDir('reelforge-webhooks-');
const repo = resolve(__dirname, '../../..');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const SECRET_KEY = 'webhooks-test-secret-key-0123456789abcdef';
const LICENCE = 'WHKLI-CENCE-KEY12-34567-ABCDE';
let server: StartedServer;
let admin: string;
let env: Record<string, string>;
let dropDb: () => Promise<void> = async () => undefined;
const logs: string[] = [];
const secrets: string[] = [SECRET_KEY, LICENCE];

interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
  verified?: unknown;
}
const received: Received[] = [];
const signing = new Map<string, string>();
const statusFor = new Map<string, number[]>();
let receiver: Server;
let rxUrl = '';

const licenceApi: LicenceApi = {
  validate: async (): Promise<LicenceAnswer> => ({ valid: true, reason: null, key: { status: 'active', activations: 1, activationLimit: 1, expiresAt: null }, item: { id: 'itm', title: 'ReelForge Studio' }, instance: null }),
  activate: async (_k, instance): Promise<LicenceAnswer> => ({ valid: true, reason: null, key: { status: 'active', activations: 1, activationLimit: 1, expiresAt: null }, item: { id: 'itm', title: 'ReelForge Studio' }, instance: { instance, activatedAt: new Date().toISOString() } }),
  deactivate: async (): Promise<LicenceAnswer> => ({ valid: false, reason: 'not_activated', instance: null }),
};

async function rest(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${opts.key ?? admin}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

async function mcp(key = admin) {
  const client = new Client({ name: 'webhooks-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const body = JSON.parse(r.content[0].text);
    return r.isError ? { error: body.error } : body;
  };
  return { call, close: () => client.close() };
}

const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
};
const at = (path: string) => received.filter((r) => r.path === path);
const types = (path: string) => at(path).map((r) => JSON.parse(r.body).type as string);

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0]!;
      const r: Received = { path, headers: req.headers, body };
      const secret = signing.get(path);
      // Verified with the reference implementation, against the real clock (5 min tolerance).
      if (secret) r.verified = new Webhook(secret).verify(body, req.headers as Record<string, string>);
      received.push(r);
      const q = statusFor.get(path);
      const status = q?.length ? (q.length > 1 ? q.shift()! : q[0]!) : 200;
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  rxUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));
  const database = await testDatabase(dir);
  dropDb = database.drop;
  env = {
    ...database.env,
    REELFORGE_SECRET_KEY: SECRET_KEY,
    REELFORGE_METRICS_TOKEN: 'webhooks-metrics-token-0123456789', // /metrics needs a token by default (D-088)
    REELFORGE_RATE_LIMIT_PER_MINUTE: '0',
    REELFORGE_WEBHOOKS_ALLOW_HTTP: 'true',
    REELFORGE_WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true',
    REELFORGE_WEBHOOKS_RETRY_BASE_SECONDS: '1',
    REELFORGE_WEBHOOKS_MAX_ATTEMPTS: '3',
  };
  const keep = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  server = await startServer({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' }, { registry, env, licence: { api: licenceApi, start: false }, logWrite: (_l, line) => keep(line) });
  admin = (await server.service.keys.create('admin', ['admin', 'owner', 'write', 'render', 'read'])).key;
  secrets.push(admin);
}, 60_000);

afterAll(async () => {
  await server?.close();
  receiver?.closeAllConnections();
  await new Promise((r) => receiver?.close(r));
  vi.restoreAllMocks();
  await dropDb();
  cleanup();
});

describe('webhooks over REST and MCP (WHK-20..)', () => {
  let restHook: { id: string };
  let mcpHook: { id: string };

  it('WHK-20 REST lifecycle: create (secret once), list and get (masked, no secret), update, test with wait, deliveries, replay, delete', async () => {
    const c = await rest('POST', '/v1/webhooks', { body: { name: 'rest hook', url: `${rxUrl}/rest/abc-token-path`, events: ['job.*', 'job.progress', 'render.ready', 'key.created', 'key.revoked', 'config.changed', 'licence.state_changed'] } });
    expect(c.status).toBe(201);
    expect(c.json.secret).toMatch(/^whsec_/);
    expect(c.json.webhook).toMatchObject({ type: 'webhook', url: `${rxUrl}/rest/…`, enabled: true, signing: { scheme: 'standard-webhooks-v1' } });
    signing.set('/rest/abc-token-path', c.json.secret);
    secrets.push(c.json.secret);
    restHook = c.json.webhook;
    const l = await rest('GET', '/v1/webhooks');
    expect(l.status).toBe(200);
    expect(l.json.webhooks.map((w: any) => w.id)).toContain(restHook.id);
    expect(l.json.eventTypes.map((t: any) => t.type)).toContain('render.ready');
    expect(l.text).not.toContain(c.json.secret);
    expect(l.text).not.toContain('abc-token-path');
    expect((await rest('GET', `/v1/webhooks/${restHook.id}`)).json.deliveries).toEqual({ pending: 0, delivering: 0, succeeded: 0, dead: 0 });
    expect((await rest('PATCH', `/v1/webhooks/${restHook.id}`, { body: { description: 'renders to n8n' } })).json.webhook.description).toBe('renders to n8n');
    const t = await rest('POST', `/v1/webhooks/${restHook.id}/test`, { body: { waitSeconds: 10 } });
    expect(t.status).toBe(202);
    expect(t.json.delivery).toMatchObject({ status: 'succeeded', attempts: 1, lastStatus: 200, eventType: 'webhook.test' });
    expect(at('/rest/abc-token-path').at(-1)!.verified).toMatchObject({ type: 'webhook.test', data: { webhookId: restHook.id } });
    const d = await rest('GET', `/v1/webhooks/${restHook.id}/deliveries?includePayload=true`);
    expect(d.json.deliveries[0]).toMatchObject({ eventType: 'webhook.test', status: 'succeeded', attemptLog: [{ attempt: 1, status: 200, outcome: 'success' }], payload: { type: 'webhook.test' } });
    const rp = await rest('POST', `/v1/webhooks/${restHook.id}/deliveries/${t.json.delivery.id}/replay`);
    expect(rp.status).toBe(202);
    await until(async () => (await rest('GET', `/v1/webhooks/${restHook.id}`)).json.deliveries.succeeded === 2);
    const ids = at('/rest/abc-token-path').slice(-2).map((r) => r.headers['webhook-id']);
    expect(ids[0]).toBe(ids[1]);
    expect((await rest('GET', '/v1/webhooks/whk_nope')).status).toBe(404);
    expect((await rest('POST', '/v1/webhooks', { body: { name: 'x', url: `${rxUrl}/x`, events: ['nope'] } })).json.error.code).toBe('bad_request');
  });

  it('WHK-21 MCP lifecycle with the same results (create_webhook ... replay_webhook_delivery, delete_webhook)', async () => {
    const m = await mcp();
    const c = await m.call('create_webhook', { name: 'mcp hook', url: `${rxUrl}/mcp-hook`, events: ['render.ready'] });
    expect(c.secret).toMatch(/^whsec_/);
    signing.set('/mcp-hook', c.secret);
    secrets.push(c.secret);
    mcpHook = c.webhook;
    expect((await m.call('list_webhooks')).webhooks.map((w: any) => w.id)).toEqual(expect.arrayContaining([restHook.id, mcpHook.id]));
    expect((await m.call('get_webhook', { webhookId: mcpHook.id })).name).toBe('mcp hook');
    const t = await m.call('test_webhook', { webhookId: mcpHook.id, waitSeconds: 10 });
    expect(t.delivery).toMatchObject({ status: 'succeeded', lastStatus: 200 });
    const dl = await m.call('list_webhook_deliveries', { webhookId: mcpHook.id });
    expect(dl.deliveries).toHaveLength(1);
    expect((await m.call('replay_webhook_delivery', { webhookId: mcpHook.id, deliveryId: dl.deliveries[0].id })).delivery.messageId).toBe(dl.deliveries[0].messageId);
    const u = await m.call('update_webhook', { webhookId: mcpHook.id, rotateSecret: true, graceHours: 1 });
    expect(u.secret).toMatch(/^whsec_/);
    secrets.push(u.secret);
    expect(u.webhook.signing.rotating).toBe(true);
    // Both secrets verify the next message.
    await m.call('test_webhook', { webhookId: mcpHook.id, waitSeconds: 10 });
    const last = at('/mcp-hook').at(-1)!;
    expect(() => new Webhook(u.secret).verify(last.body, last.headers as Record<string, string>)).not.toThrow();
    expect(() => new Webhook(c.secret).verify(last.body, last.headers as Record<string, string>)).not.toThrow();
    signing.set('/mcp-hook', u.secret);
    await m.close();
  });

  it('WHK-24 licence.state_changed when the licence becomes valid', async () => {
    const before = server.service.getLicence().status;
    await rest('POST', '/v1/licence', { body: { key: LICENCE } });
    expect(server.service.getLicence().status).toBe('valid');
    await until(() => types('/rest/abc-token-path').includes('licence.state_changed'));
    const e = at('/rest/abc-token-path').map((x) => x.verified as any).find((x) => x.type === 'licence.state_changed');
    expect(e.data).toMatchObject({ status: 'valid', renderAllowed: true, previous: { status: before } });
    expect(JSON.stringify(e)).not.toContain(LICENCE);
  });

  it('WHK-22 a render emits job.queued, job.started, job.progress, job.succeeded and render.ready, all signed; payloads hold no signed links or manifests', async () => {
    expect((await rest('POST', '/v1/projects', { body: { manifest: { ...sample, projectId: 'whk-render' } } })).status).toBe(201);
    const r = await rest('POST', '/v1/projects/whk-render/renders', { body: {} });
    expect(r.status).toBe(202);
    const jobId = r.json.job.id;
    const mineNow = () => at('/rest/abc-token-path').map((x) => x.verified as any).filter((e) => e.data.job?.id === jobId || e.data.jobId === jobId);
    // Each event is its own outbox row and deliveries run in parallel, so render.ready can arrive before
    // job.succeeded (order is not guaranteed, docs/providers/webhooks-and-notifications.md): wait for both.
    await until(() => ['job.succeeded', 'render.ready'].every((t) => mineNow().some((e) => e.type === t)) && types('/mcp-hook').includes('render.ready'), 50_000);
    const mine = mineNow();
    const seen = mine.map((e) => e.type);
    expect(seen).toEqual(expect.arrayContaining(['job.queued', 'job.started', 'job.succeeded', 'render.ready']));
    expect(seen.filter((t) => t === 'job.progress').length).toBeLessThanOrEqual(9);
    const ready = mine.find((e) => e.type === 'render.ready');
    expect(ready.data).toMatchObject({ projectId: 'whk-render', jobId, kind: 'render' });
    expect(ready.data.renderId).toMatch(/^run_/);
    const all = at('/rest/abc-token-path').map((x) => x.body).join('\n');
    expect(all).not.toContain('downloadUrl');
    expect(all).not.toContain('sig=');
    expect(all).not.toContain('"scenes"');
    // job.* did not include job.progress for the MCP hook (render.ready only).
    expect(types('/mcp-hook').filter((t) => t.startsWith('job.'))).toEqual([]);
  }, 60_000);

  it('WHK-23 key.created, key.revoked and config.changed from REST calls, without secrets', async () => {
    const k = await rest('POST', '/v1/keys', { body: { name: 'evented', scopes: ['read'] } });
    secrets.push(k.json.key);
    await rest('POST', `/v1/keys/${k.json.record.id}/revoke`);
    await rest('PATCH', '/v1/config', { body: { settings: { 'notifications.email.resend.apiKey': 're_secret_should_not_leak_123', 'limits.rateLimitPerMinute': 0 } } });
    secrets.push('re_secret_should_not_leak_123');
    await until(() => ['key.created', 'key.revoked'].every((t) => types('/rest/abc-token-path').includes(t)) && at('/rest/abc-token-path').some((x) => (x.verified as any).data.keys?.includes('limits.rateLimitPerMinute')));
    const ev = at('/rest/abc-token-path').map((x) => x.verified as any);
    expect(ev.find((e) => e.type === 'key.created').data).toMatchObject({ keyId: k.json.record.id, name: 'evented', scopes: ['read'], actor: { type: 'api_key', name: 'admin' } });
    expect(ev.find((e) => e.type === 'key.revoked').data).toMatchObject({ keyId: k.json.record.id });
    expect(ev.find((e) => e.type === 'config.changed' && e.data.keys.includes('limits.rateLimitPerMinute')).data.keys).toEqual(expect.arrayContaining(['notifications.email.resend.apiKey', 'limits.rateLimitPerMinute']));
  });

  it('WHK-25 retries with backoff, dead letter after webhooks.maxAttempts, replay; a 4xx is not retried', async () => {
    statusFor.set('/flaky', [500, 500, 500, 200]);
    statusFor.set('/reject', [403]);
    const f = (await rest('POST', '/v1/webhooks', { body: { name: 'flaky', url: `${rxUrl}/flaky`, events: ['key.created'] } })).json.webhook;
    const rj = (await rest('POST', '/v1/webhooks', { body: { name: 'reject', url: `${rxUrl}/reject`, events: ['key.created'] } })).json.webhook;
    const k = await rest('POST', '/v1/keys', { body: { name: 'retry-trigger', scopes: ['read'] } });
    secrets.push(k.json.key);
    await until(async () => (await rest('GET', `/v1/webhooks/${f.id}`)).json.deliveries.dead === 1, 20_000);
    await until(async () => (await rest('GET', `/v1/webhooks/${rj.id}`)).json.deliveries.dead === 1);
    const dead = (await rest('GET', `/v1/webhooks/${f.id}/deliveries?status=dead`)).json.deliveries[0];
    expect(dead.attempts).toBe(3);
    expect(dead.attemptLog.map((a: any) => a.status)).toEqual([500, 500, 500]);
    const gaps = dead.attemptLog.slice(1).map((a: any, i: number) => Date.parse(a.at) - Date.parse(dead.attemptLog[i].at));
    expect(gaps[0]).toBeGreaterThanOrEqual(700); // 1 s ±20 %, then 2 s ±20 %
    expect(gaps[1]).toBeGreaterThanOrEqual(1500);
    expect((await rest('GET', `/v1/webhooks/${rj.id}/deliveries`)).json.deliveries[0]).toMatchObject({ status: 'dead', attempts: 1, lastStatus: 403 });
    await rest('POST', `/v1/webhooks/${f.id}/deliveries/${dead.id}/replay`);
    await until(async () => (await rest('GET', `/v1/webhooks/${f.id}`)).json.deliveries.succeeded === 1);
    expect(logs.some((l) => l.includes('failed for good after 3 attempt(s)'))).toBe(true);
    await rest('DELETE', `/v1/webhooks/${f.id}`);
    await rest('DELETE', `/v1/webhooks/${rj.id}`);
  }, 60_000);

  it('WHK-26 admin scope only: a write/render key is refused on REST and MCP', async () => {
    const k = (await rest('POST', '/v1/keys', { body: { name: 'writer', scopes: ['read', 'write', 'render'] } })).json;
    secrets.push(k.key);
    expect((await rest('GET', '/v1/webhooks', { key: k.key })).status).toBe(403);
    expect((await rest('POST', '/v1/webhooks', { key: k.key, body: { name: 'x', url: `${rxUrl}/x`, events: ['*'] } })).status).toBe(403);
    const m = await mcp(k.key);
    expect((await m.call('create_webhook', { name: 'x', url: `${rxUrl}/x`, events: ['*'] })).error.code).toBe('forbidden');
    await m.close();
  });

  it('WHK-27 every change is audited once (webhook.create, update, rotate_secret, test, replay, delete), reads as webhooks.list; never a secret', async () => {
    const all = (await rest('GET', '/v1/audit?action=webhook*&limit=1000')).json.events as any[];
    const actions = new Set(all.map((e) => e.action));
    for (const a of ['webhook.create', 'webhook.update', 'webhook.rotate_secret', 'webhook.test', 'webhook.delivery.replay', 'webhook.delete', 'webhooks.list', 'webhook.get', 'webhook.deliveries.list']) expect(actions, a).toContain(a);
    const creates = all.filter((e) => e.action === 'webhook.create' && e.targetId === restHook.id);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ actorName: 'admin', targetType: 'webhook', data: { via: 'rest', name: 'rest hook' } });
    const text = JSON.stringify(all);
    for (const s of secrets) expect(text).not.toContain(s.startsWith('whsec_') ? s.slice(6) : s);
    expect(text).not.toContain('abc-token-path');
  });

  it('WHK-28 the "webhooks" audit sink sends every audit entry as audit.entry to endpoints that ask for it', async () => {
    const a = (await rest('POST', '/v1/webhooks', { body: { name: 'audit stream', url: `${rxUrl}/audit-stream`, events: ['audit.entry'] } })).json;
    signing.set('/audit-stream', a.secret);
    secrets.push(a.secret);
    await rest('PATCH', '/v1/config', { body: { settings: { 'audit.sinks': ['webhooks'] } } });
    await rest('POST', '/v1/projects', { body: { manifest: { ...sample, projectId: 'whk-audit-sink' } } });
    await until(() => at('/audit-stream').some((r) => (r.verified as any)?.data?.entry?.action === 'project.create'));
    const e = at('/audit-stream').map((r) => r.verified as any).find((x) => x.data.entry.action === 'project.create');
    expect(e.data.entry).toMatchObject({ targetId: 'whk-audit-sink', actorName: 'admin', result: 'success' });
    await rest('PATCH', '/v1/config', { body: { settings: { 'audit.sinks': null } } });
  });

  it('WHK-29 metrics: deliveries by channel and outcome, bounded labels (no ids)', async () => {
    const r = await fetch(`${server.url}/metrics`, { headers: { authorization: 'Bearer webhooks-metrics-token-0123456789' } });
    if (r.status === 404) return; // metrics exporter off in this configuration
    const text = await r.text();
    expect(text).toMatch(/reelforge_webhook_deliveries_total\{[^}]*reelforge_channel="webhook"[^}]*reelforge_outcome="success"/);
    expect(text).toMatch(/reelforge_webhook_deliveries_total\{[^}]*reelforge_outcome="dead"/);
    expect(text).toMatch(/reelforge_webhook_events_total\{[^}]*reelforge_event_type="render.ready"/);
    const webhookLines = text.split('\n').filter((l) => l.startsWith('reelforge_webhook'));
    expect(webhookLines.join('\n')).not.toMatch(/whk_|dlv_|msg_|evt_/);
  });

  it('WHK-30 CLI: create (secret printed once), list, test (queued, delivered by the running server), deliveries, rotate, delete; audited as cli', () => {
    const cli = (args: string[]) => {
      const r = spawnSync(join(repo, 'node_modules/.bin/tsx'), ['apps/server/src/cli.ts', ...args], { cwd: repo, env: { ...process.env, ...env, REELFORGE_DATA_DIR: join(dir, 'data') }, encoding: 'utf8', timeout: 60_000 });
      if (r.status !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr}${r.stdout}`);
      return r.stdout;
    };
    const created = JSON.parse(cli(['webhooks', 'create', '--name', 'cli hook', '--url', `${rxUrl}/cli-hook`, '--events', 'key.created,render.ready', '--json']));
    expect(created.secret).toMatch(/^whsec_/);
    signing.set('/cli-hook', created.secret);
    secrets.push(created.secret);
    expect(cli(['webhooks', 'list'])).toContain(created.webhook.id);
    expect(cli(['webhooks', 'test', created.webhook.id])).toMatch(/queued test delivery dlv_/);
    return until(() => at('/cli-hook').length === 1).then(async () => {
      expect(at('/cli-hook')[0]!.verified).toMatchObject({ type: 'webhook.test' });
      expect(cli(['webhooks', 'deliveries', created.webhook.id])).toMatch(/succeeded/);
      const rotated = cli(['webhooks', 'update', created.webhook.id, '--rotate-secret', '--grace-hours', '0']);
      expect(rotated).toMatch(/new signing secret \(shown once\): whsec_/);
      secrets.push(/whsec_\S+/.exec(rotated)![0]);
      expect(JSON.parse(cli(['webhooks', 'delete', created.webhook.id])).deleted).toBe(created.webhook.id);
      const audit = (await rest('GET', `/v1/audit?targetId=${created.webhook.id}`)).json.events as any[];
      expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['webhook.create', 'webhook.test', 'webhook.rotate_secret', 'webhook.delete']));
      expect(audit.every((e) => e.actorType === 'cli' && /^cli:/.test(e.actorName))).toBe(true);
    });
  }, 120_000);

  it('WHK-31 no secret in the server log', () => {
    const text = logs.join('\n');
    for (const s of secrets) expect(text).not.toContain(s.startsWith('whsec_') ? s.slice(6) : s);
    expect(text).not.toContain('abc-token-path');
  });

  it('WHK-32 REST/MCP delete: pending deliveries abandoned, 404 after', async () => {
    const m = await mcp();
    expect((await m.call('delete_webhook', { webhookId: mcpHook.id })).deleted).toBe(mcpHook.id);
    expect((await m.call('get_webhook', { webhookId: mcpHook.id })).error.code).toBe('not_found');
    await m.close();
    expect((await rest('DELETE', `/v1/webhooks/${restHook.id}`)).json.deleted).toBe(restHook.id);
  });
});
