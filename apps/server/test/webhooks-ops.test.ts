import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RenderScene } from '@reelforge/project-schema';
import { PluginRegistry, type EnginePlugin, type LicenceAnswer, type LicenceApi } from '@reelforge/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * Webhooks for operations (#306) over real HTTP, REST and MCP, against a local
 * receiver that verifies every signature with the official standardwebhooks
 * library: one terminal render.* event per render job (blocked, ready after a
 * failed first attempt, failed, timeout, cancelled) with timing, costs, links
 * and the dedupe key; resend; secret rotation with two valid secrets; the
 * delivery log for read keys. Case ids OPS-*: docs/providers/webhooks-and-notifications.md.
 */
const { dir, cleanup } = tempDir('reelforge-webhooks-ops-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const manifest = (projectId: string) => ({ ...sample, projectId, output: { ...sample.output, width: 360, height: 640 } });
const SECRET_KEY = 'webhooks-ops-secret-key-0123456789abcdef';
const LICENCE = 'OPSLI-CENCE-KEY12-34567-ABCDE';
let server: StartedServer;
let admin: string;
let reader: string;
let dropDb: () => Promise<void> = async () => undefined;

/** What the engines do on the next render: render, throw, or wait until stopped. */
let mode: 'ok' | 'fail' | 'hang' = 'ok';
function registry(): PluginRegistry {
  const wrap = (e: EnginePlugin): EnginePlugin => ({
    ...e,
    render: async (scene: RenderScene, ctx) => {
      if (mode === 'fail') {
        ctx.log?.('engine: frame 12 could not be drawn (injected)');
        throw new Error('fake engine failure');
      }
      if (mode === 'hang') await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      return e.render(scene, ctx);
    },
  });
  return new PluginRegistry().registerEngine(wrap(fakeEngine('remotion'))).registerEngine(wrap(fakeEngine('motion-canvas')));
}

interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
  status: number;
}
const received: Received[] = [];
/** Status codes the receiver answers per path, in order (the last one repeats). */
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
  return { status: res.status, json };
}

async function mcp(key = admin) {
  const client = new Client({ name: 'webhooks-ops-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const body = JSON.parse(r.content[0].text);
    return r.isError ? { error: body.error } : body;
  };
  return { call, close: () => client.close() };
}

const until = async (fn: () => boolean | Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
};
/** Successfully answered messages at a path, verified with the official library against `secret`. */
const events = (path: string, secret: string) =>
  received.filter((r) => r.path === path && r.status < 300).map((r) => ({ ...(new Webhook(secret).verify(r.body, r.headers as Record<string, string>) as any), webhookId: r.headers['webhook-id'] as string }));

let hook: { id: string };
let secret: string;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0]!;
      const q = statusFor.get(path);
      const status = q?.length ? (q.length > 1 ? q.shift()! : q[0]!) : 200;
      received.push({ path, headers: req.headers, body, status });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  rxUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  const database = await testDatabase(dir);
  dropDb = database.drop;
  const env = {
    ...database.env,
    REELFORGE_SECRET_KEY: SECRET_KEY,
    REELFORGE_RATE_LIMIT_PER_MINUTE: '0',
    REELFORGE_WEBHOOKS_ALLOW_HTTP: 'true',
    REELFORGE_WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true',
    REELFORGE_WEBHOOKS_RETRY_BASE_SECONDS: '1',
  };
  const quiet = () => undefined;
  vi.spyOn(console, 'log').mockImplementation(quiet);
  vi.spyOn(console, 'error').mockImplementation(quiet);
  server = await startServer({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' }, { registry: registry(), env, licence: { api: licenceApi, start: false }, logWrite: quiet });
  admin = (await server.service.keys.create('admin', ['admin', 'owner', 'write', 'render', 'read'])).key;
  reader = (await server.service.keys.create('reader', ['read'])).key;
  const c = await rest('POST', '/v1/webhooks', { body: { name: 'ops', url: `${rxUrl}/ops`, events: ['render.*'] } });
  expect(c.status).toBe(201);
  hook = c.json.webhook;
  secret = c.json.secret;
}, 60_000);

afterAll(async () => {
  await server?.close();
  receiver?.closeAllConnections();
  await new Promise((r) => receiver?.close(r));
  vi.restoreAllMocks();
  await dropDb();
  cleanup();
});

/** Render a project with the engines in `m` and wait for its terminal render.* event at /ops. */
async function renderWith(m: typeof mode, projectId: string, after?: (jobId: string) => Promise<void>) {
  mode = m;
  expect((await rest('POST', '/v1/projects', { body: { manifest: manifest(projectId) } })).status).toBe(201);
  const r = await rest('POST', `/v1/projects/${projectId}/renders`, { body: {} });
  expect(r.status).toBe(202);
  const jobId = r.json.job.id as string;
  await after?.(jobId);
  await until(() => events('/ops', secret).some((e) => e.data.jobId === jobId), 60_000);
  const mine = events('/ops', secret).filter((e) => e.data.jobId === jobId);
  return { jobId, mine, event: mine[0]! };
}

describe('webhooks for operations (#306)', () => {
  it('OPS-01 render.blocked: a render refused by the licence gets a terminal event (no job), then the licence is activated', async () => {
    expect((await rest('POST', '/v1/projects', { body: { manifest: manifest('ops-blocked') } })).status).toBe(201);
    const r = await rest('POST', '/v1/projects/ops-blocked/renders', { body: {} });
    expect(r.status).toBe(403);
    await until(() => events('/ops', secret).some((e) => e.type === 'render.blocked'));
    const e = events('/ops', secret).find((x) => x.type === 'render.blocked')!;
    expect(e.data).toMatchObject({ kind: 'render', projectId: 'ops-blocked', status: 'blocked', error: { code: r.json.error.code }, licence: { status: 'unlicensed' } });
    expect(e.data.links.licence).toMatch(/\/v1\/licence$/);
    expect((await rest('POST', '/v1/licence', { body: { key: LICENCE } })).status).toBeLessThan(300);
  });

  it('OPS-02 render.ready after a failed first delivery: retried with backoff, then delivered; timing, costs, links and the dedupe key', async () => {
    statusFor.set('/ops', [503, 200]);
    const { jobId, mine, event } = await renderWith('ok', 'ops-ready');
    expect(mine.map((e) => e.type)).toEqual(['render.ready']);
    expect(event.dedupeKey).toBe(`render:${jobId}`);
    expect(event.data).toMatchObject({ jobId, kind: 'render', projectId: 'ops-ready', status: 'succeeded' });
    expect(event.data.renderId).toMatch(/^run_/);
    expect(event.data.timing.renderSeconds).toBeGreaterThan(0);
    expect(event.data.timing.queueSeconds).toBeGreaterThanOrEqual(0);
    expect(event.data.costs.outputBytes).toBeGreaterThan(1000);
    expect(event.data.costs.storageBytes).toBeGreaterThan(event.data.costs.outputBytes);
    expect(typeof event.data.costs.cpuSeconds === 'number' || typeof event.data.costs.cpuUnavailable === 'string').toBe(true);
    expect(event.data.links).toMatchObject({ job: expect.stringMatching(new RegExp(`/v1/jobs/${jobId}$`)), output: expect.stringMatching(/\/v1\/renders\/run_\w+\/output$/) });
    expect(JSON.stringify(event)).not.toContain('downloadUrl');
    // Both attempts carried the same webhook-id; the log shows the failure, then the success (read scope, REST and MCP).
    const tries = received.filter((r) => r.path === '/ops' && JSON.parse(r.body).dedupeKey === `render:${jobId}`);
    expect(tries.map((r) => r.status)).toEqual([503, 200]);
    expect(new Set(tries.map((r) => r.headers['webhook-id'])).size).toBe(1);
    const log = await rest('GET', `/v1/webhooks/${hook.id}/log?eventType=render.ready`, { key: reader });
    expect(log.status).toBe(200);
    const row = log.json.deliveries[0];
    expect(row).toMatchObject({ eventType: 'render.ready', status: 'succeeded', attempts: 2, dedupeKey: `render:${jobId}`, messageId: tries[0]!.headers['webhook-id'] });
    expect(row.attemptLog.map((a: any) => [a.status, a.outcome])).toEqual([[503, 'retry'], [200, 'success']]);
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    expect(log.json.retry).toEqual({ windowHours: 24, maxAttempts: 20, timeoutSeconds: 10 });
    expect(JSON.stringify(log.json)).not.toContain('/ops');
    const m = await mcp(reader);
    const viaMcp = await m.call('get_webhook_log', { webhookId: hook.id, eventType: 'render.ready' });
    expect(viaMcp.deliveries[0].id).toBe(row.id);
    await m.close();
  }, 90_000);

  it('OPS-03 render.failed: typed error code, stage and an excerpt of the engine log', async () => {
    const { mine, event } = await renderWith('fail', 'ops-failed');
    expect(mine.map((e) => e.type)).toEqual(['render.failed']);
    expect(event.data).toMatchObject({ status: 'failed', error: { code: expect.any(String), message: expect.stringContaining('fake engine failure') } });
    expect(event.data.logExcerpt.join('\n')).toContain('fake engine failure');
    expect(event.data.logExcerpt.length).toBeLessThanOrEqual(20);
    expect(event.data.links.logs).toMatch(/\/logs$/);
  }, 90_000);

  it('OPS-04 render.timeout: a render longer than render.timeoutSeconds is stopped and reported as such', async () => {
    expect((await rest('PATCH', '/v1/config', { body: { settings: { 'render.timeoutSeconds': 1 } } })).status).toBe(200);
    try {
      const { mine, event, jobId } = await renderWith('hang', 'ops-timeout');
      expect(mine.map((e) => e.type)).toEqual(['render.timeout']);
      expect(event.data).toMatchObject({ status: 'failed', error: { code: 'render_timeout' } });
      expect(event.data.error.message).toMatch(/render\.timeoutSeconds \(1 s\)/);
      expect((await rest('GET', `/v1/jobs/${jobId}`)).json).toMatchObject({ status: 'failed', error: { code: 'render_timeout' } });
    } finally {
      await rest('PATCH', '/v1/config', { body: { settings: { 'render.timeoutSeconds': null } } });
    }
  }, 90_000);

  it('OPS-05 render.cancelled', async () => {
    const { mine } = await renderWith('hang', 'ops-cancel', async (jobId) => {
      await until(async () => (await rest('GET', `/v1/jobs/${jobId}`)).json.status === 'running');
      expect((await rest('POST', `/v1/jobs/${jobId}/cancel`)).status).toBeLessThan(300);
    });
    expect(mine.map((e) => e.type)).toEqual(['render.cancelled']);
    expect(mine[0]!.data).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
  }, 90_000);

  it('OPS-06 resend: by dedupe key over REST, by delivery over MCP; the receiver sees the same webhook-id; read keys may not resend', async () => {
    const first = events('/ops', secret).find((e) => e.type === 'render.failed')!;
    const before = received.filter((r) => r.path === '/ops').length;
    const r = await rest('POST', `/v1/webhooks/${hook.id}/resend`, { body: { dedupeKey: first.dedupeKey } });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ action: 'queued', delivery: { eventType: 'render.failed', messageId: first.webhookId } });
    await until(() => received.filter((x) => x.path === '/ops').length === before + 1);
    const again = events('/ops', secret).at(-1)!;
    expect(again).toMatchObject({ type: 'render.failed', webhookId: first.webhookId, id: first.id });
    const m = await mcp();
    const resent = await m.call('resend_webhook', { webhookId: hook.id, deliveryId: r.json.delivery.id });
    expect(resent).toMatchObject({ action: 'queued', delivery: { replayOf: r.json.delivery.id, messageId: first.webhookId } });
    await m.close();
    await until(() => received.filter((x) => x.path === '/ops').length === before + 2);
    expect((await rest('POST', `/v1/webhooks/${hook.id}/resend`, { key: reader, body: { dedupeKey: first.dedupeKey } })).status).toBe(403);
    expect((await rest('POST', `/v1/webhooks/${hook.id}/resend`, { body: {} })).status).toBe(400);
  });

  it('OPS-07 rotate_webhook_secret: during the overlap both secrets verify the same message; read keys may not rotate', async () => {
    const m = await mcp();
    const rot = await m.call('rotate_webhook_secret', { webhookId: hook.id, overlapHours: 1 });
    expect(rot.secret).toMatch(/^whsec_/);
    expect(rot.webhook.signing).toMatchObject({ rotating: true });
    const t = await m.call('test_webhook', { webhookId: hook.id, waitSeconds: 10 });
    expect(t.delivery).toMatchObject({ status: 'succeeded' });
    const last = received.filter((r) => r.path === '/ops').at(-1)!;
    expect((last.headers['webhook-signature'] as string).split(' ')).toHaveLength(2);
    expect(new Webhook(secret).verify(last.body, last.headers as Record<string, string>)).toMatchObject({ type: 'webhook.test' });
    expect(new Webhook(rot.secret).verify(last.body, last.headers as Record<string, string>)).toMatchObject({ type: 'webhook.test' });
    expect((await m.call('rotate_webhook_secret', { webhookId: hook.id, endOverlap: true })).webhook.signing.rotating).toBe(false);
    await m.close();
    expect((await rest('POST', `/v1/webhooks/${hook.id}/rotate-secret`, { key: reader, body: {} })).status).toBe(403);
    const audit = (await rest('GET', `/v1/audit?targetId=${hook.id}&limit=200`)).json.events as any[];
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['webhook.resend', 'webhook.rotate_secret']));
    expect(JSON.stringify(audit)).not.toContain(rot.secret.slice(6));
  });
});
