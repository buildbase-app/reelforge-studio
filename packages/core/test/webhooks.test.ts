import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { SMTPServer } from 'smtp-server';
import { Webhook } from 'standardwebhooks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILTIN_PROVIDERS,
  RuntimeConfig,
  WebhookService,
  checkTargetUrl,
  classifyStatus,
  createMemoryRepositories,
  eventMatches,
  eventText,
  isPrivateAddress,
  maskUrl,
  messageIdFor,
  newSigningSecret,
  postOnce,
  renderOutcome,
  signPayload,
  signatureHeaders,
  validEventFilter,
  verifySignature,
  type EmailSettings,
  type NotificationProvider,
  type Repositories,
  type SendContext,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
} from '../src/index';

/**
 * Outbound events (#66): signatures (WHK-01..), delivery, retries and the
 * outbox (WHK-*), notification providers (NTF-*). Case ids:
 * docs/providers/webhooks-and-notifications.md.
 */

// ---- a scriptable HTTP receiver -----------------------------------------------------

interface Hit {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}
type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

class Receiver {
  hits: Hit[] = [];
  routes = new Map<string, Handler | number[]>();
  server!: Server;
  url = '';
  async start() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const path = (req.url ?? '/').split('?')[0]!;
        this.hits.push({ path, headers: req.headers, body });
        const r = this.routes.get(path);
        if (typeof r === 'function') return r(req, body, res);
        const status = Array.isArray(r) && r.length ? (r.length > 1 ? r.shift()! : r[0]!) : 200;
        res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  on(path: string, h: Handler | number[]) {
    this.routes.set(path, h);
    return `${this.url}${path}`;
  }
  of(path: string) {
    return this.hits.filter((h) => h.path === path);
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
}

const SECRET_KEY = 'test-secret-key-0123456789-abcdefghijklmnop';
const until = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
};

interface Harness {
  repos: Repositories;
  settings: RuntimeConfig;
  svc: WebhookService;
  clock: { t: number };
  logs: string[];
  audits: Array<Record<string, unknown>>;
}

async function harness(env: Record<string, string> = {}, opts: { repos?: Repositories; providers?: NotificationProvider[]; start?: boolean; fetch?: typeof fetch } = {}): Promise<Harness> {
  const repos = opts.repos ?? createMemoryRepositories();
  const settings = new RuntimeConfig(repos, {
    env: {
      REELFORGE_SECRET_KEY: SECRET_KEY,
      REELFORGE_WEBHOOKS_ALLOW_HTTP: 'true',
      REELFORGE_WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true',
      REELFORGE_WEBHOOKS_RETRY_BASE_SECONDS: '10',
      REELFORGE_WEBHOOKS_TIMEOUT_SECONDS: '2',
      ...env,
    },
  });
  await settings.load();
  const clock = { t: Date.parse('2026-11-21T12:00:00Z') };
  const logs: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const svc = new WebhookService({
    repo: repos.webhooks,
    settings,
    now: () => clock.t,
    pollMs: 20,
    log: (_l, line) => logs.push(line),
    audit: async (e) => void audits.push(e as never),
    providers: opts.providers,
    fetch: opts.fetch,
  });
  if (opts.start !== false) svc.start();
  return { repos, settings, svc, clock, logs, audits };
}

const harnesses: Harness[] = [];
async function h(env?: Record<string, string>, opts?: Parameters<typeof harness>[1]) {
  const x = await harness(env, opts);
  harnesses.push(x);
  return x;
}
afterEach(async () => {
  for (const x of harnesses.splice(0)) await x.svc.stop(100);
});

const rx = new Receiver();
beforeAll(async () => void (await rx.start()));
afterAll(async () => rx.stop());

/** Wait for a delivery to leave pending/delivering at the current clock, or to reach `status`. */
async function settled(x: Harness, id: string, status?: string) {
  let d: WebhookDeliveryRecord | null = null;
  await until(async () => {
    d = await x.repos.webhooks.getDelivery(id);
    return !!d && d.attempts > 0 && (status ? d.status === status : d.status !== 'delivering');
  });
  return d!;
}
async function onlyDelivery(x: Harness, endpointId: string) {
  await x.svc.flush();
  await until(async () => (await x.repos.webhooks.listDeliveries({ endpointId })).length > 0);
  return (await x.repos.webhooks.listDeliveries({ endpointId }))[0]!;
}

// ---- WHK-01: signatures ---------------------------------------------------------------

describe('Standard Webhooks signatures (WHK-01)', () => {
  // Reference test vector of the Standard Webhooks libraries (libraries/javascript/src/webhook.test.ts and
  // libraries/python/tests/test_webhooks.py, "sign function works"), checked 2026-11-21.
  const key = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const msgId = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const payload = '{"test": 2432232314}';

  it('matches the reference test vector', () => {
    expect(signPayload(key, msgId, 1614265330, payload)).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    // The secret works with and without the whsec_ prefix, like the reference libraries.
    expect(signPayload('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', msgId, 1614265330, payload)).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('our headers verify with the official standardwebhooks library, also with two secrets (rotation)', () => {
    const a = newSigningSecret();
    const b = newSigningSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const ts = Math.floor(Date.now() / 1000);
    const headers = signatureHeaders([a, b], 'msg_test1', ts, payload);
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
    expect(new Webhook(a).verify(payload, headers)).toEqual({ test: 2432232314 });
    expect(new Webhook(b).verify(payload, headers)).toEqual({ test: 2432232314 });
    expect(() => new Webhook(newSigningSecret()).verify(payload, headers)).toThrow();
  });

  it('verifySignature: reference negative cases (bad signature, unknown version, old/new timestamps, missing headers, multi-signature)', () => {
    const now = 1614265330_000;
    const good = signatureHeaders([key], msgId, 1614265330, payload);
    expect(() => verifySignature(key, good, payload, { now })).not.toThrow();
    expect(() => verifySignature(key, { ...good, 'webhook-signature': 'v1,dawfeoifkpqwoekfpqoekf' }, payload, { now })).toThrow(/no matching/);
    expect(() => verifySignature(key, { ...good, 'webhook-signature': `v2,${good['webhook-signature'].slice(3)}` }, payload, { now })).toThrow(/no matching/);
    expect(() => verifySignature(key, { ...good, 'webhook-signature': 'v1,' }, payload, { now })).toThrow();
    expect(() => verifySignature(key, good, payload, { now: now + 301_000 })).toThrow(/too old/);
    expect(() => verifySignature(key, good, payload, { now: now - 301_000 })).toThrow(/too new/);
    expect(() => verifySignature(key, { 'webhook-id': msgId }, payload, { now })).toThrow(/missing/);
    expect(() => verifySignature(key, good, `${payload} `, { now })).toThrow(/no matching/);
    const multi = { ...good, 'webhook-signature': ['v1', 'v1,not-base64!', 'v2,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=', good['webhook-signature']].join(' ') };
    expect(() => verifySignature(key, multi, payload, { now })).not.toThrow();
  });
});

// ---- WHK-02: event filters ---------------------------------------------------------

describe('event filters and payloads (WHK-02)', () => {
  it('exact types, prefixes and * (job.progress and audit.entry only by name; webhook.test never by filter)', () => {
    expect(eventMatches(['job.*'], 'job.failed')).toBe(true);
    expect(eventMatches(['job.*'], 'render.ready')).toBe(false);
    expect(eventMatches(['*'], 'key.created')).toBe(true);
    expect(eventMatches(['*'], 'job.progress')).toBe(false);
    expect(eventMatches(['job.*'], 'job.progress')).toBe(false);
    expect(eventMatches(['job.progress'], 'job.progress')).toBe(true);
    expect(eventMatches(['*'], 'audit.entry')).toBe(false);
    expect(eventMatches(['*', 'webhook.test'], 'webhook.test')).toBe(false);
    expect(validEventFilter('job.*')).toBe(true);
    expect(validEventFilter('render.ready')).toBe(true);
    expect(validEventFilter('nope.*')).toBe(false);
    expect(validEventFilter('job.finished')).toBe(false);
  });

  it('plain-text rendering flattens the data', () => {
    const text = eventText({ id: 'evt_1', type: 'job.failed', timestamp: '2026-11-21T12:00:00.000Z', data: { job: { id: 'job_1', type: 'render', error: { code: 'render_failed', message: 'boom' } } } });
    expect(text).toContain('ReelForge: render job_1 failed: render_failed');
    expect(text).toContain('job.error.message: boom');
  });

  it('masks URLs to host and first path segment', () => {
    expect(maskUrl('https://hooks.slack.com/services/T000/B000/XXXX')).toBe('https://hooks.slack.com/services/…');
    expect(maskUrl('https://example.com/hook?token=abc')).toBe('https://example.com/hook/…');
    expect(maskUrl('https://example.com')).toBe('https://example.com');
  });

  it('status classification: 2xx success; 408/425/429/5xx retry; other 4xx and 3xx failed (WHK-06)', () => {
    expect([200, 204, 299].map(classifyStatus)).toEqual(['success', 'success', 'success']);
    expect([408, 425, 429, 500, 502, 503, 504].map(classifyStatus).every((c) => c === 'retry')).toBe(true);
    expect([301, 302, 400, 401, 403, 404, 410, 413, 422].map(classifyStatus).every((c) => c === 'failed')).toBe(true);
  });
});

// ---- WHK-03: SSRF guard ------------------------------------------------------------------

describe('SSRF guard (WHK-03)', () => {
  const strict = { allowHttp: false, allowPrivateNetworks: false };
  it('refuses http, credentials, private/loopback/link-local literals and local names when saving', () => {
    for (const u of ['http://example.com/h', 'https://user:pw@example.com/h', 'https://127.0.0.1/h', 'https://10.1.2.3/h', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/h', 'https://[fe80::1]/h', 'https://[::ffff:127.0.0.1]/h', 'https://localhost/h', 'https://db.internal/h', 'https://100.64.0.1/h']) {
      expect(() => checkTargetUrl(u, strict), u).toThrow(/url_not_allowed|only https|credentials|refusing/);
    }
    expect(checkTargetUrl('https://hooks.example.com/x', strict).host).toBe('hooks.example.com');
    expect(checkTargetUrl('http://127.0.0.1:9/x', { allowHttp: true, allowPrivateNetworks: true }).port).toBe('9');
    expect(isPrivateAddress('192.168.1.1') && isPrivateAddress('fd00::1') && !isPrivateAddress('8.8.8.8')).toBe(true);
  });

  it('checks the address at connect time: a name that resolves to a private/loopback address is refused', async () => {
    const name = hostname();
    const addrs = await lookup(name, { all: true }).catch(() => []);
    if (!addrs.length || !addrs.every((a) => isPrivateAddress(a.address))) return; // this host's name is public or unknown: nothing to test here
    const r = await postOnce(`https://${name}:9/hook`, '{}', {}, { ...strict, timeoutMs: 2000 });
    expect(r.refused).toBe(true);
    expect(r.error).toMatch(/non-public address/);
  });

  it('a private target is refused at delivery even when it was saved earlier (setting turned off after a restart)', async () => {
    const x = await h({ REELFORGE_WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'false', REELFORGE_WEBHOOKS_ALLOW_HTTP: 'true' });
    const at = new Date().toISOString();
    const ep: WebhookEndpointRecord = { id: 'whk_old', name: 'old', type: 'webhook', url: { value: rx.on('/ssrf', [200]), scheme: 'plain' }, events: ['*'], enabled: true, secret: { value: newSigningSecret(), scheme: 'plain' }, createdAt: at, updatedAt: at };
    await x.repos.webhooks.insertEndpoint(ep);
    await x.svc.test('whk_old');
    const d = await onlyDelivery(x, 'whk_old');
    const done = await settled(x, d.id, 'dead');
    expect(done.attempts).toBe(1);
    expect(done.lastError).toMatch(/private|refusing/);
    expect(rx.of('/ssrf')).toHaveLength(0);
  });

  it('create_webhook refuses private targets unless the start-up setting allows them', async () => {
    const x = await h({ REELFORGE_WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'false', REELFORGE_WEBHOOKS_ALLOW_HTTP: 'false' });
    await expect(x.svc.create({ name: 'a', url: 'https://127.0.0.1/h', events: ['*'] })).rejects.toMatchObject({ code: 'url_not_allowed' });
    await expect(x.svc.create({ name: 'a', url: 'http://example.com/h', events: ['*'] })).rejects.toMatchObject({ code: 'url_not_allowed' });
    await expect(x.settings.update({ 'webhooks.allowPrivateNetworks': true })).rejects.toMatchObject({ code: 'startup_only_setting' });
  });
});

// ---- WHK-04..: delivery -------------------------------------------------------------------

describe('delivery through the outbox', () => {
  it('WHK-04 signed POST to the endpoint; the receiver verifies it with the official library; one attempt in the log', async () => {
    const x = await h();
    const url = rx.on('/ok', [204]);
    const { webhook, secret } = await x.svc.create({ name: 'n8n', url, events: ['job.*', 'render.ready'] });
    expect(secret).toMatch(/^whsec_/);
    expect(webhook.url).toBe(`${rx.url}/ok`);
    expect(JSON.stringify(webhook)).not.toContain(secret!);
    x.svc.emit('job.succeeded', { job: { id: 'job_1', type: 'render', status: 'succeeded' } });
    x.svc.emit('key.created', { keyId: 'key_1' }); // not subscribed
    const d = await onlyDelivery(x, webhook.id);
    const done = await settled(x, d.id, 'succeeded');
    expect(done).toMatchObject({ attempts: 1, lastStatus: 204, eventType: 'job.succeeded' });
    const hit = rx.of('/ok').at(-1)!;
    expect(hit.headers['webhook-id']).toBe(d.messageId);
    expect(hit.headers['content-type']).toBe('application/json');
    const wh = new Webhook(secret!);
    // The official library checks the timestamp against the real clock; the harness clock is fixed, so check with ours too.
    expect(() => verifySignature(secret!, hit.headers as Record<string, string>, hit.body, { now: x.clock.t })).not.toThrow();
    expect(() => wh.verify(hit.body, { ...(hit.headers as Record<string, string>) })).toThrow(/timestamp/i);
    const body = JSON.parse(hit.body);
    expect(body).toMatchObject({ type: 'job.succeeded', data: { job: { id: 'job_1' } } });
    expect(body.id).toMatch(/^evt_/);
    const log = await x.repos.webhooks.listAttempts(d.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ attempt: 1, status: 204, outcome: 'success' });
    expect((await x.repos.webhooks.listDeliveries({ endpointId: webhook.id })).length).toBe(1);
  });

  it('WHK-05 retries 5xx/429 with exponential backoff and jitter, honours Retry-After, then succeeds; same webhook-id on every attempt', async () => {
    const x = await h();
    let n = 0;
    const url = rx.on('/flaky', (_q, _b, res) => {
      n++;
      if (n === 1) return res.writeHead(500).end();
      if (n === 2) return res.writeHead(429, { 'retry-after': '120' }).end();
      res.writeHead(200).end('ok');
    });
    const { webhook } = await x.svc.create({ name: 'flaky', url, events: ['*'] });
    x.svc.emit('key.revoked', { keyId: 'key_9' });
    const d = await onlyDelivery(x, webhook.id);
    let s = await settled(x, d.id, 'pending');
    expect(s.attempts).toBe(1);
    const wait1 = Date.parse(s.nextAttemptAt) - x.clock.t;
    expect(wait1).toBeGreaterThanOrEqual(8_000); // 10 s ±20 %
    expect(wait1).toBeLessThanOrEqual(12_000);
    x.clock.t += 11_999;
    if (wait1 > 11_999) x.clock.t += 1;
    await until(async () => (await x.repos.webhooks.getDelivery(d.id))!.attempts === 2);
    s = (await x.repos.webhooks.getDelivery(d.id))!;
    const wait2 = Date.parse(s.nextAttemptAt) - x.clock.t;
    expect(wait2).toBeGreaterThanOrEqual(120_000 - 50); // Retry-After 120 s beats 20 s ±20 %
    x.clock.t += 121_000;
    s = await settled(x, d.id, 'succeeded');
    expect(s.attempts).toBe(3);
    const ids = rx.of('/flaky').map((hit) => hit.headers['webhook-id']);
    expect(new Set(ids)).toEqual(new Set([d.messageId]));
    expect((await x.repos.webhooks.listAttempts(d.id)).map((a) => [a.status, a.outcome])).toEqual([[500, 'retry'], [429, 'retry'], [200, 'success']]);
  });

  it('WHK-05b backoff doubles, is capped, and stays within ±20 % jitter', async () => {
    const x = await h({ REELFORGE_WEBHOOKS_RETRY_BASE_SECONDS: '30', REELFORGE_WEBHOOKS_RETRY_MAX_DELAY_SECONDS: '14400' }, { start: false });
    expect([1, 2, 3, 4].map((n) => x.svc.backoffMs(n, undefined, () => 0.5))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(x.svc.backoffMs(20, undefined, () => 0.5)).toBe(14_400_000);
    expect(x.svc.backoffMs(1, undefined, () => 0)).toBe(24_000);
    expect(x.svc.backoffMs(1, undefined, () => 1)).toBe(36_000);
    // The defaults (15 attempts) span about 24 hours.
    const total = Array.from({ length: 14 }, (_, i) => x.svc.backoffMs(i + 1, undefined, () => 0.5)).reduce((a, b) => a + b, 0);
    expect(total / 3_600_000).toBeGreaterThan(20);
    expect(total / 3_600_000).toBeLessThan(28);
  });

  it('WHK-06 a 4xx (not 408/429) fails for good after one attempt; 410 Gone also disables the endpoint', async () => {
    const x = await h();
    const { webhook: a } = await x.svc.create({ name: 'bad', url: rx.on('/400', [400]), events: ['*'] });
    const { webhook: b } = await x.svc.create({ name: 'gone', url: rx.on('/410', [410]), events: ['*'] });
    x.svc.emit('key.created', { keyId: 'k' });
    const da = await settled(x, (await onlyDelivery(x, a.id)).id, 'dead');
    const db = await settled(x, (await onlyDelivery(x, b.id)).id, 'dead');
    expect(da).toMatchObject({ attempts: 1, lastStatus: 400 });
    expect(db).toMatchObject({ attempts: 1, lastStatus: 410 });
    await until(async () => (await x.svc.get(b.id)).enabled === false);
    expect((await x.svc.get(b.id)).disabledReason).toMatch(/410 Gone/);
    expect(x.audits.some((e) => e.action === 'webhook.disable')).toBe(true);
  });

  it('WHK-07 dead letter after maxAttempts; replay sends it again with the same webhook-id and payload', async () => {
    const x = await h({ REELFORGE_WEBHOOKS_MAX_ATTEMPTS: '2' });
    const statuses = [503, 503, 200];
    const url = rx.on('/dead', statuses);
    const { webhook } = await x.svc.create({ name: 'dead', url, events: ['config.changed'] });
    x.svc.emit('config.changed', { keys: ['limits.rateLimitPerMinute'] });
    const d = await onlyDelivery(x, webhook.id);
    await settled(x, d.id, 'pending');
    x.clock.t += 60_000;
    const dead = await settled(x, d.id, 'dead');
    expect(dead.attempts).toBe(2);
    expect(x.logs.some((l) => l.includes('failed for good after 2 attempt(s)'))).toBe(true);
    const list = await x.svc.listDeliveries(webhook.id, { status: 'dead' });
    expect(list.deliveries).toHaveLength(1);
    expect(list.deliveries[0]!.attemptLog).toHaveLength(2);
    await expect(x.svc.replay(webhook.id, 'dlv_nope')).rejects.toMatchObject({ status: 404 });
    const { delivery } = await x.svc.replay(webhook.id, d.id);
    expect(delivery).toMatchObject({ messageId: d.messageId, replayOf: d.id, status: 'pending', attempts: 0 });
    const replayed = await settled(x, delivery.id, 'succeeded');
    expect(replayed.payload).toEqual(d.payload);
    expect(rx.of('/dead').map((hit) => hit.headers['webhook-id'])).toEqual([d.messageId, d.messageId, d.messageId]);
    expect(rx.of('/dead').at(-1)!.body).toBe(JSON.stringify(d.payload));
    // A pending delivery cannot be replayed.
    await x.svc.stop(100);
    const y = await h({}, { repos: x.repos, start: false });
    await y.svc.test(webhook.id);
    const pending = (await y.repos.webhooks.listDeliveries({ endpointId: webhook.id, status: 'pending' }))[0]!;
    await expect(y.svc.replay(webhook.id, pending.id)).rejects.toMatchObject({ status: 409 });
  });

  it('WHK-08 a hanging receiver times out after webhooks.timeoutSeconds and is retried', async () => {
    const x = await h({ REELFORGE_WEBHOOKS_TIMEOUT_SECONDS: '1' });
    const url = rx.on('/hang', () => undefined);
    const { webhook } = await x.svc.create({ name: 'hang', url, events: ['*'] });
    const started = Date.now();
    x.svc.emit('key.created', { keyId: 'k' });
    const d = await settled(x, (await onlyDelivery(x, webhook.id)).id, 'pending');
    expect(Date.now() - started).toBeLessThan(4000);
    expect(d.attempts).toBe(1);
    expect(d.lastError).toMatch(/timed out after 1000 ms/);
  });

  it('WHK-09 receiver down (connection refused): retried, the server log is not flooded', async () => {
    const x = await h();
    const { webhook } = await x.svc.create({ name: 'down', url: 'http://127.0.0.1:9/nothing', events: ['*'] });
    x.svc.emit('key.created', { keyId: 'k' });
    const d = await settled(x, (await onlyDelivery(x, webhook.id)).id, 'pending');
    expect(d.lastError).toMatch(/ECONNREFUSED/);
    expect(d.lastStatus).toBeUndefined();
  });

  it('WHK-10 survives a restart: pending rows are sent by the next process; an expired lease (crash mid-attempt) is picked up again', async () => {
    const repos = createMemoryRepositories();
    const x = await h({}, { repos, start: false });
    const url = rx.on('/restart', [200]);
    const { webhook } = await x.svc.create({ name: 'restart', url, events: ['*'] });
    x.svc.emit('key.created', { keyId: 'k1' });
    const d = await onlyDelivery(x, webhook.id);
    expect(d.status).toBe('pending');
    // A "crashed" worker claimed a second one and died: its lease expires.
    x.svc.emit('key.revoked', { keyId: 'k1' });
    await x.svc.flush();
    const claimed = await repos.webhooks.claim(new Date(x.clock.t).toISOString(), new Date(x.clock.t + 1000).toISOString(), 1);
    expect(claimed).toHaveLength(1);
    const y = await h({}, { repos });
    y.clock.t = x.clock.t;
    await until(async () => (await repos.webhooks.countByStatus(webhook.id)).succeeded === 1);
    expect((await repos.webhooks.countByStatus(webhook.id)).delivering).toBe(1);
    y.clock.t += 2000;
    await until(async () => (await repos.webhooks.countByStatus(webhook.id)).succeeded === 2);
  });

  it('WHK-11 graceful shutdown: a finished attempt is recorded; one still in flight is handed back as pending and sent after the restart', async () => {
    const repos = createMemoryRepositories();
    const x = await h({}, { repos });
    let release: () => void = () => undefined;
    let slow = true;
    const url = rx.on('/slow', (_q, _b, res) => {
      if (!slow) return res.writeHead(200).end();
      release = () => res.writeHead(200).end();
    });
    const { webhook } = await x.svc.create({ name: 'slow', url, events: ['*'] });
    x.svc.emit('key.created', { keyId: 'k' });
    await until(() => rx.of('/slow').length === 1);
    const r = await x.svc.stop(150);
    expect(r).toEqual({ finished: 0, released: 1 });
    release();
    const d = (await repos.webhooks.listDeliveries({ endpointId: webhook.id }))[0]!;
    expect(d).toMatchObject({ status: 'pending', attempts: 0 });
    slow = false;
    const y = await h({}, { repos });
    y.clock.t = x.clock.t + 1;
    const done = await settled(y, d.id, 'succeeded');
    expect(done.attempts).toBe(1);
    expect(new Set(rx.of('/slow').map((hit) => hit.headers['webhook-id']))).toEqual(new Set([d.messageId]));
    // A fast attempt finishes inside the grace time and is recorded.
    const z = await h({}, { repos });
    z.clock.t = y.clock.t;
    await y.svc.stop(100);
    await z.svc.test(webhook.id);
    expect((await z.svc.stop(2000)).released).toBe(0);
  });

  it('WHK-12 no secret reaches the delivery log, the audit entries, the server log or list results', async () => {
    const tokenUrl = rx.on('/services/T000/B000/SUPERSECRETTOKEN123', [400]);
    const leaky: NotificationProvider = {
      id: 'slack',
      channel: 'slack',
      displayName: 'leaky test slack',
      configured: () => ({ ok: true }),
      async send(ctx) {
        return { outcome: 'failed', status: 400, error: `could not post to ${ctx.url} with Bearer abcdefghijklmnop and ${ctx.secrets.join(',')}` };
      },
    };
    const x = await h({}, { providers: [leaky] });
    const { webhook, secret } = await x.svc.create({ name: 'chat', type: 'slack', url: tokenUrl, events: ['*'] });
    expect(secret).toBeUndefined();
    const { webhook: wh, secret: whsec } = await x.svc.create({ name: 'hook', url: rx.on('/sig400', [400]), events: ['*'] });
    x.svc.emit('key.created', { keyId: 'k', name: 'x', apiKey: 'rf_should_not_be_here_123456789' });
    const d = await settled(x, (await onlyDelivery(x, webhook.id)).id, 'dead');
    await settled(x, (await onlyDelivery(x, wh.id)).id, 'dead');
    const everything = JSON.stringify({
      d,
      attempts: await x.repos.webhooks.listAttempts(d.id),
      list: await x.svc.list(),
      deliveries: await x.svc.listDeliveries(webhook.id, { includePayload: true }),
      deliveries2: await x.svc.listDeliveries(wh.id, { includePayload: true }),
      audits: x.audits,
      logs: x.logs,
      stored: await x.repos.webhooks.listEndpoints(),
    });
    expect(everything).not.toContain('SUPERSECRETTOKEN123');
    expect(everything).not.toContain(whsec!.slice(6));
    expect(everything).not.toContain('abcdefghijklmnop');
    expect(everything).not.toContain('rf_should_not_be_here');
    expect(d.lastError).toContain('[redacted]');
    // At rest: URL and secret are AES-256-GCM ciphertext.
    const stored = (await x.repos.webhooks.getEndpoint(wh.id))!;
    expect(stored.url!.scheme).toBe('aes-256-gcm');
    expect(stored.secret!.scheme).toBe('aes-256-gcm');
  });

  it('WHK-13 secret rotation: both signatures during the grace window, only the new one after it', async () => {
    const x = await h();
    const url = rx.on('/rotate', [200]);
    const { webhook, secret: oldSecret } = await x.svc.create({ name: 'rotate', url, events: ['*'] });
    const r = await x.svc.update(webhook.id, { rotateSecret: true, graceHours: 1 });
    expect(r.secret).toMatch(/^whsec_/);
    expect(r.webhook.signing).toMatchObject({ rotating: true });
    await x.svc.test(webhook.id);
    await until(() => rx.of('/rotate').length === 1);
    let hit = rx.of('/rotate').at(-1)!;
    expect((hit.headers['webhook-signature'] as string).split(' ')).toHaveLength(2);
    expect(() => verifySignature(oldSecret!, hit.headers as Record<string, string>, hit.body, { now: x.clock.t })).not.toThrow();
    expect(() => verifySignature(r.secret!, hit.headers as Record<string, string>, hit.body, { now: x.clock.t })).not.toThrow();
    x.clock.t += 3_600_001;
    await x.svc.test(webhook.id);
    await until(() => rx.of('/rotate').length === 2);
    hit = rx.of('/rotate').at(-1)!;
    expect((hit.headers['webhook-signature'] as string).split(' ')).toHaveLength(1);
    expect(() => verifySignature(oldSecret!, hit.headers as Record<string, string>, hit.body, { now: x.clock.t })).toThrow();
    expect(x.audits.find((e) => e.action === 'webhook.rotate_secret')).toBeDefined();
    expect(JSON.stringify(x.audits)).not.toContain(r.secret!.slice(6));
  });

  it('WHK-14 two workers on one outbox: every delivery is sent exactly once', async () => {
    const repos = createMemoryRepositories();
    const url = rx.on('/once', [200]);
    const x = await h({}, { repos });
    const { webhook } = await x.svc.create({ name: 'once', url, events: ['*'] });
    const y = await h({}, { repos });
    y.clock.t = x.clock.t;
    for (let i = 0; i < 20; i++) x.svc.emit('key.created', { keyId: `k${i}` });
    await x.svc.flush();
    await until(async () => (await repos.webhooks.countByStatus(webhook.id)).succeeded === 20);
    const ids = rx.of('/once').map((hit) => hit.headers['webhook-id']);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('WHK-15 emit never blocks or throws, even when the outbox cannot be written', async () => {
    const x = await h();
    await x.svc.create({ name: 'any', url: rx.on('/any', [200]), events: ['*'] });
    x.repos.webhooks.enqueue = async () => {
      throw new Error('database is down');
    };
    const t = Date.now();
    expect(() => x.svc.emit('key.created', { keyId: 'k' })).not.toThrow();
    expect(Date.now() - t).toBeLessThan(20);
    await x.svc.flush();
    expect(x.logs.some((l) => l.includes('could not be queued: database is down'))).toBe(true);
  });

  it('WHK-16 validation: bad events, missing url, email without recipients, no REELFORGE_SECRET_KEY', async () => {
    const x = await h();
    await expect(x.svc.create({ name: 'a', url: `${rx.url}/x`, events: ['job.finished'] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(x.svc.create({ name: 'a', events: ['*'] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(x.svc.create({ name: 'a', type: 'email', email: { provider: 'smtp', to: [] }, events: ['*'] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(x.svc.create({ name: 'a', type: 'email', email: { provider: 'smtp', to: ['not-an-address'] }, events: ['*'] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(x.svc.create({ name: 'a', url: `${rx.url}/x`, events: ['*'], extra: 1 })).rejects.toMatchObject({ code: 'bad_request' });
    const y = await h({ REELFORGE_SECRET_KEY: '' });
    await expect(y.svc.create({ name: 'a', url: `${rx.url}/x`, events: ['*'] })).rejects.toMatchObject({ code: 'secret_key_required', status: 409 });
  });

  it('WHK-17 deleting an endpoint abandons its pending deliveries; retention removes old finished deliveries with their attempts (append-only otherwise)', async () => {
    const x = await h({ REELFORGE_WEBHOOKS_DELIVERY_RETENTION_DAYS: '30' }, { start: false });
    const { webhook } = await x.svc.create({ name: 'gone', url: `${rx.url}/x`, events: ['*'] });
    x.svc.emit('key.created', { keyId: 'k' });
    await x.svc.flush();
    expect((await x.svc.delete(webhook.id)).abandoned).toBe(1);
    expect((await x.repos.webhooks.countByStatus(webhook.id)).dead).toBe(1);
    expect(await x.svc.sweep(x.clock.t + 29 * 86_400_000)).toBe(0);
    expect(await x.svc.sweep(x.clock.t + 31 * 86_400_000)).toBe(1);
    expect(await x.repos.webhooks.countByStatus(webhook.id)).toEqual({ pending: 0, delivering: 0, succeeded: 0, dead: 0 });
  });

  it('WHK-18 disabled endpoints get no new deliveries; enabling clears the reason', async () => {
    const x = await h({}, { start: false });
    const { webhook } = await x.svc.create({ name: 'off', url: `${rx.url}/x`, events: ['*'], enabled: false });
    x.svc.emit('key.created', { keyId: 'k' });
    await x.svc.flush();
    expect((await x.repos.webhooks.listDeliveries({ endpointId: webhook.id })).length).toBe(0);
    expect((await x.svc.update(webhook.id, { enabled: true })).webhook.enabled).toBe(true);
  });
});

// ---- NTF: notification providers (shared contract suite) ------------------------------

const smtpAuth = { user: 'mailer', pass: 'smtp-pass-0123456789' };
const smtpMail: Array<{ from: string; to: string[]; data: string }> = [];
let smtpServer: SMTPServer;
let smtpPort = 0;
let smtpMode: 'ok' | 'tempfail' | 'permfail' = 'ok';
beforeAll(async () => {
  smtpServer = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _s, cb) {
      if (auth.username === smtpAuth.user && auth.password === smtpAuth.pass) return cb(null, { user: auth.username });
      cb(new Error('Invalid username or password'));
    },
    onData(stream, session, cb) {
      let data = '';
      stream.on('data', (c) => (data += c));
      stream.on('end', () => {
        if (smtpMode === 'tempfail') return cb(Object.assign(new Error('try again later'), { responseCode: 451 }));
        if (smtpMode === 'permfail') return cb(Object.assign(new Error('mailbox unavailable'), { responseCode: 550 }));
        smtpMail.push({ from: session.envelope.mailFrom ? (session.envelope.mailFrom as { address: string }).address : '', to: session.envelope.rcptTo.map((r) => r.address), data });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtpServer.listen(0, '127.0.0.1', r));
  smtpPort = (smtpServer.server.address() as AddressInfo).port;
});
afterAll(async () => new Promise<void>((r) => smtpServer.close(() => r())));

const CREDS = { resend: 're_test_key_0123456789', postmark: 'pm-token-0123456789', sendgrid: 'SG.test-key-0123456789', sesId: 'AKIDTESTSES0123', sesSecret: 'ses-secret-0123456789abcdef' };

function emailSettings(base: string, over: Partial<EmailSettings> = {}): EmailSettings {
  return {
    from: 'ReelForge <studio@example.com>',
    smtp: { host: '127.0.0.1', port: smtpPort, security: 'none', user: smtpAuth.user, password: smtpAuth.pass },
    resend: { apiKey: CREDS.resend, baseUrl: `${base}/resend` },
    postmark: { serverToken: CREDS.postmark, baseUrl: `${base}/postmark`, messageStream: 'outbound' },
    sendgrid: { apiKey: CREDS.sendgrid, baseUrl: `${base}/sendgrid` },
    ses: { region: 'eu-west-1', accessKeyId: CREDS.sesId, secretAccessKey: CREDS.sesSecret, endpoint: `${base}/ses` },
    ...over,
  };
}

interface ProviderCase {
  id: string;
  type: WebhookEndpointRecord['type'];
  email?: WebhookEndpointRecord['email'];
  /** Path on the receiver the provider calls (HTTP providers). */
  path?: string;
  /** Make the next call answer with this outcome. */
  answer(kind: 'ok' | 'retry' | 'reject' | 'down'): { email?: Partial<EmailSettings>; url?: string };
  /** What the receiver must have seen after an ok send. */
  check(): void;
}

const event = { id: 'evt_contract', type: 'job.failed', timestamp: '2026-11-21T12:00:00.000Z', data: { job: { id: 'job_c', type: 'render', status: 'failed', error: { code: 'render_failed', message: 'out of memory' } } } };
const delivery = (): WebhookDeliveryRecord => ({ id: 'dlv_c', endpointId: 'whk_c', messageId: 'msg_contract', eventId: event.id, eventType: event.type, payload: event, status: 'delivering', attempts: 0, nextAttemptAt: '', createdAt: '', updatedAt: '' });

function httpCase(id: string, type: ProviderCase['type'], path: string, check: (hit: Hit) => void, email?: ProviderCase['email']): ProviderCase {
  return {
    id,
    type,
    email,
    path,
    answer(kind) {
      if (kind === 'down') return { url: 'http://127.0.0.1:9/x', email: { resend: { apiKey: CREDS.resend, baseUrl: 'http://127.0.0.1:9' }, postmark: { serverToken: CREDS.postmark, baseUrl: 'http://127.0.0.1:9', messageStream: 'outbound' }, sendgrid: { apiKey: CREDS.sendgrid, baseUrl: 'http://127.0.0.1:9' }, ses: { region: 'eu-west-1', accessKeyId: CREDS.sesId, secretAccessKey: CREDS.sesSecret, endpoint: 'http://127.0.0.1:9' } } };
      const status = kind === 'ok' ? (id === 'email:sendgrid' ? 202 : 200) : kind === 'retry' ? 503 : id.startsWith('email:') ? 401 : 400;
      rx.on(path, (_q, _b, res) => res.writeHead(status, { 'content-type': 'application/json' }).end(kind === 'ok' ? '{"id":"x","MessageId":"x"}' : `{"message":"answer ${status}","name":"Err"}`));
      return { url: `${rx.url}${path}` };
    },
    check() {
      const hit = rx.of(path).at(-1);
      expect(hit, `${id} called ${path}`).toBeDefined();
      check(hit!);
    },
  };
}

const PROVIDER_CASES: ProviderCase[] = [
  httpCase('webhook', 'webhook', '/c/webhook', (hit) => {
    expect(hit.headers['webhook-id']).toBe('msg_contract');
    expect(JSON.parse(hit.body)).toEqual(event);
  }),
  httpCase('slack', 'slack', '/c/slack/services/T/B/X', (hit) => {
    const b = JSON.parse(hit.body);
    expect(b.text).toContain('failed');
    expect(b.blocks[0].type).toBe('section');
    expect(hit.headers['webhook-signature']).toBeUndefined();
  }),
  httpCase('discord', 'discord', '/c/discord/api/webhooks/1/abc', (hit) => {
    const b = JSON.parse(hit.body);
    expect(b.content).toContain('job.error.message: out of memory');
    expect(b.content.length).toBeLessThanOrEqual(2000);
    expect(b.allowed_mentions).toEqual({ parse: [] });
  }),
  httpCase('teams', 'teams', '/c/teams/workflows/x', (hit) => {
    const b = JSON.parse(hit.body);
    expect(b.type).toBe('message');
    expect(b.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(b.attachments[0].content.type).toBe('AdaptiveCard');
  }),
  httpCase('email:resend', 'email', '/resend/emails', (hit) => {
    expect(hit.headers.authorization).toBe(`Bearer ${CREDS.resend}`);
    expect(hit.headers['idempotency-key']).toBe('msg_contract');
    expect(JSON.parse(hit.body)).toMatchObject({ from: 'ReelForge <studio@example.com>', to: ['ops@example.com'], subject: expect.stringContaining('failed') });
    // The message id header under the new and the old name (#412).
    expect(JSON.parse(hit.body).headers).toEqual({ 'X-Renderweld-Message-Id': 'msg_contract', 'X-Reelforge-Message-Id': 'msg_contract' });
  }, { provider: 'resend', to: ['ops@example.com'] }),
  httpCase('email:postmark', 'email', '/postmark/email', (hit) => {
    expect(hit.headers['x-postmark-server-token']).toBe(CREDS.postmark);
    expect(JSON.parse(hit.body)).toMatchObject({ From: 'ReelForge <studio@example.com>', To: 'ops@example.com', MessageStream: 'outbound', TextBody: expect.stringContaining('render_failed') });
    expect(JSON.parse(hit.body).Headers).toEqual([{ Name: 'X-Renderweld-Message-Id', Value: 'msg_contract' }, { Name: 'X-Reelforge-Message-Id', Value: 'msg_contract' }]);
  }, { provider: 'postmark', to: ['ops@example.com'] }),
  httpCase('email:sendgrid', 'email', '/sendgrid/v3/mail/send', (hit) => {
    expect(hit.headers.authorization).toBe(`Bearer ${CREDS.sendgrid}`);
    expect(JSON.parse(hit.body)).toMatchObject({ personalizations: [{ to: [{ email: 'ops@example.com' }] }], from: { email: 'ReelForge <studio@example.com>' }, content: [{ type: 'text/plain' }] });
    expect(JSON.parse(hit.body).headers).toEqual({ 'X-Renderweld-Message-Id': 'msg_contract', 'X-Reelforge-Message-Id': 'msg_contract' });
  }, { provider: 'sendgrid', to: ['ops@example.com'] }),
  httpCase('email:ses', 'email', '/ses/v2/email/outbound-emails', (hit) => {
    expect(hit.headers.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${CREDS.sesId}/\\d{8}/eu-west-1/ses/aws4_request`));
    expect(JSON.parse(hit.body)).toMatchObject({ FromEmailAddress: 'ReelForge <studio@example.com>', Destination: { ToAddresses: ['ops@example.com'] }, Content: { Simple: { Body: { Text: { Data: expect.stringContaining('render_failed') } } } } });
    expect(JSON.parse(hit.body).Content.Simple.Headers).toEqual([{ Name: 'X-Renderweld-Message-Id', Value: 'msg_contract' }, { Name: 'X-Reelforge-Message-Id', Value: 'msg_contract' }]);
  }, { provider: 'ses', to: ['ops@example.com'] }),
  {
    id: 'email:smtp',
    type: 'email',
    email: { provider: 'smtp', to: ['ops@example.com'] },
    answer(kind) {
      smtpMode = kind === 'retry' ? 'tempfail' : 'ok';
      if (kind === 'reject') return { email: { smtp: { host: '127.0.0.1', port: smtpPort, security: 'none', user: smtpAuth.user, password: 'wrong-password' } } };
      if (kind === 'down') return { email: { smtp: { host: '127.0.0.1', port: 9, security: 'none' } } };
      return {};
    },
    check() {
      const m = smtpMail.at(-1)!;
      expect(m.to).toEqual(['ops@example.com']);
      expect(m.from).toBe('studio@example.com');
      expect(m.data).toContain('Message-ID: <msg_contract@reelforge.local>');
      expect(m.data).toMatch(/X-Renderweld-Message-Id: msg_contract/i);
      expect(m.data).toMatch(/X-Reelforge-Message-Id: msg_contract/i);
      expect(m.data).toContain('render_failed');
    },
  },
];

describe.each(PROVIDER_CASES)('notification provider contract: $id (NTF-01..09)', (pc) => {
  const provider = BUILTIN_PROVIDERS.find((p) => p.id === pc.id)!;
  const run = async (kind: 'ok' | 'retry' | 'reject' | 'down') => {
    const a = pc.answer(kind);
    const email = { ...emailSettings(rx.url), ...(a.email ?? {}) } as EmailSettings;
    const ctx: SendContext = {
      endpoint: { id: 'whk_c', name: 'c', type: pc.type, events: ['*'], enabled: true, createdAt: '', updatedAt: '', ...(pc.email ? { email: pc.email } : {}) },
      url: a.url,
      secrets: pc.type === 'webhook' ? [newSigningSecret()] : [],
      delivery: delivery(),
      timeoutMs: 3000,
      signal: new AbortController().signal,
      policy: { allowHttp: true, allowPrivateNetworks: true },
      email,
      fetch,
      now: Date.now,
    };
    return provider.send(ctx);
  };
  const noCredential = (s: string | undefined) => {
    for (const v of [...Object.values(CREDS), smtpAuth.pass, 'wrong-password']) expect(s ?? '').not.toContain(v);
  };

  it('is installed and reports its configuration', () => {
    expect(provider).toBeDefined();
    expect(provider.configured(emailSettings(rx.url)).ok).toBe(true);
    if (pc.type === 'email') expect(provider.configured(emailSettings(rx.url, { from: undefined })).missing).toContain('notifications.email.from');
  });
  it('delivers: success, in the format the service expects', async () => {
    const r = await run('ok');
    expect(r.outcome, r.error).toBe('success');
    pc.check();
  });
  it('a temporary failure (5xx / SMTP 4xx) is retried', async () => {
    const r = await run('retry');
    expect(r.outcome).toBe('retry');
    noCredential(r.error);
  });
  it('a rejection (bad credentials / 4xx) is not retried, and the error names the fix without the credential', async () => {
    const r = await run('reject');
    expect(r.outcome).toBe('failed');
    if (pc.type === 'email') expect(r.error).toMatch(/check notifications\.email\./);
    noCredential(r.error);
  });
  it('service down: retried with a clear error, never thrown', async () => {
    const r = await run('down');
    expect(r.outcome).toBe('retry');
    expect(r.error).toBeTruthy();
    noCredential(r.error);
  });
});

describe('email through the outbox (NTF-10)', () => {
  it('an email channel whose provider is not configured is retried with what to set; once set, it is delivered', async () => {
    const x = await h({ REELFORGE_SMTP_HOST: '127.0.0.1', REELFORGE_SMTP_PORT: String(smtpPort), REELFORGE_SMTP_SECURITY: 'none', REELFORGE_SMTP_USER: smtpAuth.user, REELFORGE_SMTP_PASSWORD: smtpAuth.pass });
    smtpMode = 'ok';
    const { webhook } = await x.svc.create({ name: 'ops mail', type: 'email', email: { provider: 'smtp', to: ['ops@example.com'] }, events: ['licence.state_changed'] });
    expect(webhook.provider).toMatchObject({ id: 'email:smtp', configured: false, missing: 'notifications.email.from' });
    x.svc.emit('licence.state_changed', { status: 'grace', previous: { status: 'valid' } });
    const d = await settled(x, (await onlyDelivery(x, webhook.id)).id, 'pending');
    expect(d.lastError).toMatch(/not configured: set notifications\.email\.from/);
    await x.settings.update({ 'notifications.email.from': 'studio@example.com' });
    x.clock.t += 60_000;
    await settled(x, d.id, 'succeeded');
    expect(smtpMail.at(-1)!.data).toContain('licence valid -> grace');
    expect(JSON.stringify(await x.repos.webhooks.listAttempts(d.id))).not.toContain(smtpAuth.pass);
  });
});

// ---- webhooks for operations (#306): WHK-40.. ------------------------------------------

describe('webhooks for operations (#306)', () => {
  it('WHK-40 terminal render events: one outcome per job, by status and error code', () => {
    expect(renderOutcome({ status: 'succeeded' })).toBe('render.ready');
    expect(renderOutcome({ status: 'cancelled', error: { code: 'cancelled', message: 'x' } })).toBe('render.cancelled');
    expect(renderOutcome({ status: 'failed', error: { code: 'render_failed', message: 'x' } })).toBe('render.failed');
    expect(renderOutcome({ status: 'failed', error: { code: 'job_failed', message: 'x' } })).toBe('render.failed');
    expect(renderOutcome({ status: 'failed', error: { code: 'render_timeout', message: 'x' } })).toBe('render.timeout');
    expect(renderOutcome({ status: 'failed', error: { code: 'qa_failed', message: 'x' } })).toBe('render.qa_failed');
    expect(renderOutcome({ status: 'failed', error: { code: 'qa_loudness', message: 'x' } })).toBe('render.qa_failed');
    expect(renderOutcome({ status: 'failed', error: { code: 'licence_invalid', message: 'x' } })).toBe('render.blocked');
    expect(renderOutcome({ status: 'running' })).toBeNull();
    expect(renderOutcome({ status: 'queued' })).toBeNull();
    for (const t of ['render.ready', 'render.failed', 'render.cancelled', 'render.timeout', 'render.qa_failed', 'render.blocked']) {
      expect(validEventFilter(t), t).toBe(true);
      expect(eventMatches(['render.*'], t), t).toBe(true);
      expect(eventMatches(['*'], t), t).toBe(true);
    }
  });

  it('WHK-41 dedupe key: the same outcome reaches an endpoint under one webhook-id however often it is emitted; it is in the body', async () => {
    const x = await h({}, { start: false });
    const a = (await x.svc.create({ name: 'a', url: rx.on('/dedupe-a', [200]), events: ['render.*'] })).webhook;
    const b = (await x.svc.create({ name: 'b', url: rx.on('/dedupe-b', [200]), events: ['render.failed'] })).webhook;
    x.svc.emit('render.failed', { jobId: 'job_1' }, { dedupeKey: 'render:job_1' });
    x.svc.emit('render.failed', { jobId: 'job_1' }, { dedupeKey: 'render:job_1' });
    x.svc.emit('render.failed', { jobId: 'job_2' }, { dedupeKey: 'render:job_2' });
    await x.svc.flush();
    const da = await x.repos.webhooks.listDeliveries({ endpointId: a.id });
    const db = await x.repos.webhooks.listDeliveries({ endpointId: b.id });
    expect(da).toHaveLength(3);
    const one = da.filter((d) => d.dedupeKey === 'render:job_1');
    expect(one).toHaveLength(2);
    expect(one[0]!.eventId).not.toBe(one[1]!.eventId);
    expect(one[0]!.messageId).toBe(one[1]!.messageId);
    expect(one[0]!.messageId).toBe(messageIdFor(a.id, 'render:job_1'));
    expect(db.find((d) => d.dedupeKey === 'render:job_1')!.messageId).not.toBe(one[0]!.messageId);
    expect(da.find((d) => d.dedupeKey === 'render:job_2')!.messageId).not.toBe(one[0]!.messageId);
    expect(one[0]!.payload).toMatchObject({ type: 'render.failed', dedupeKey: 'render:job_1' });
    // Events without a key: their id is the key.
    x.svc.emit('render.ready', { jobId: 'job_3' });
    await x.svc.flush();
    const r = (await x.repos.webhooks.listDeliveries({ endpointId: a.id, eventType: 'render.ready' }))[0]!;
    expect(r.dedupeKey).toBeUndefined();
    expect(r.messageId).toBe(messageIdFor(a.id, r.eventId));
  });

  it('WHK-42 retries for up to webhooks.retryWindowHours: the last attempt lands on the end of the window, then the delivery is dead with the reason', async () => {
    const x = await h({ REELFORGE_WEBHOOKS_RETRY_WINDOW_HOURS: '1' });
    const { webhook } = await x.svc.create({ name: 'down', url: rx.on('/window', [503]), events: ['*'] });
    x.svc.emit('key.created', { keyId: 'k1' });
    const d = await onlyDelivery(x, webhook.id);
    const deadline = Date.parse(d.createdAt) + 3_600_000;
    let s = await settled(x, d.id);
    for (let i = 0; i < 25 && s.status === 'pending'; i++) {
      expect(Date.parse(s.nextAttemptAt)).toBeLessThanOrEqual(deadline);
      const n = s.attempts;
      x.clock.t = Date.parse(s.nextAttemptAt);
      await until(async () => (await x.repos.webhooks.getDelivery(d.id))!.attempts > n);
      s = await settled(x, d.id);
    }
    expect(s.status).toBe('dead');
    expect(s.attempts).toBeLessThan(20);
    expect(s.lastError).toMatch(/HTTP 503; no more attempts: the retry window \(webhooks.retryWindowHours, 1 h\) ended/);
    const log = await x.repos.webhooks.listAttempts(d.id);
    expect(Date.parse(log.at(-1)!.at)).toBe(deadline);
    expect(log.at(-1)!.outcome).toBe('failed');
    expect(x.logs.some((l) => l.includes('send it again with resend_webhook'))).toBe(true);
  });

  it('WHK-43 resend: a waiting delivery is sent now; a dead one again with the same webhook-id; an outcome by dedupeKey to an endpoint that never got it', async () => {
    const x = await h();
    let up = false;
    const url = rx.on('/resend', (_q, _b, res) => void res.writeHead(up ? 200 : 500).end());
    const { webhook } = await x.svc.create({ name: 'resend', url, events: ['render.*'] });
    x.svc.emit('render.failed', { jobId: 'job_9', error: { code: 'render_failed' } }, { dedupeKey: 'render:job_9' });
    const d = await onlyDelivery(x, webhook.id);
    let s = await settled(x, d.id, 'pending');
    expect(Date.parse(s.nextAttemptAt)).toBeGreaterThan(x.clock.t);
    up = true;
    // Waiting for its next attempt: rescheduled to now, no new row.
    const r1 = await x.svc.resend(webhook.id, { deliveryId: d.id });
    expect(r1).toMatchObject({ action: 'rescheduled', delivery: { id: d.id } });
    s = await settled(x, d.id, 'succeeded');
    expect(s.attempts).toBe(2);
    // Finished: queued again as a replay with the same webhook-id.
    const r2 = await x.svc.resend(webhook.id, { dedupeKey: 'render:job_9' });
    expect(r2.action).toBe('queued');
    expect(r2.delivery).toMatchObject({ replayOf: d.id, messageId: d.messageId, dedupeKey: 'render:job_9' });
    await settled(x, r2.delivery.id, 'succeeded');
    // A new endpoint never got the event: by eventId (or dedupeKey) it gets it under its own webhook-id.
    const late = (await x.svc.create({ name: 'late', url: rx.on('/resend-late', [200]), events: ['job.failed'] })).webhook;
    const r3 = await x.svc.resend(late.id, { eventId: d.eventId });
    expect(r3.action).toBe('queued');
    expect(r3.delivery.messageId).toBe(messageIdFor(late.id, 'render:job_9'));
    expect(r3.delivery.replayOf).toBeUndefined();
    await settled(x, r3.delivery.id, 'succeeded');
    expect(JSON.parse(rx.of('/resend-late')[0]!.body)).toMatchObject({ type: 'render.failed', dedupeKey: 'render:job_9', data: { jobId: 'job_9' } });
    expect(x.audits.filter((e) => e.action === 'webhook.resend').map((e) => (e.data as { action: string }).action)).toEqual(['rescheduled', 'queued', 'queued']);
    // Refusals.
    await expect(x.svc.resend(webhook.id, {})).rejects.toMatchObject({ status: 400 });
    await expect(x.svc.resend(webhook.id, { deliveryId: d.id, eventId: d.eventId })).rejects.toMatchObject({ status: 400 });
    await expect(x.svc.resend(webhook.id, { dedupeKey: 'render:job_none' })).rejects.toMatchObject({ status: 404 });
    await expect(x.svc.resend(late.id, { deliveryId: d.id })).rejects.toMatchObject({ status: 404 });
    await expect(x.svc.resend('whk_none', { deliveryId: d.id })).rejects.toMatchObject({ status: 404 });
    await x.svc.update(late.id, { enabled: false });
    await expect(x.svc.resend(late.id, { eventId: d.eventId })).rejects.toMatchObject({ status: 409 });
  });

  it('WHK-44 rotate_webhook_secret: both secrets verify during the overlap; endOverlap stops the old one; a secret brought by the receiver is not echoed', async () => {
    const x = await h();
    const url = rx.on('/rotate2', [200]);
    const { webhook, secret: s1 } = await x.svc.create({ name: 'rotate2', url, events: ['*'] });
    const r = await x.svc.rotateSecret(webhook.id, { overlapHours: 2 });
    expect(r.secret).toMatch(/^whsec_/);
    expect(r.webhook.signing).toMatchObject({ rotating: true, previousSecretValidUntil: new Date(x.clock.t + 7_200_000).toISOString() });
    await x.svc.test(webhook.id);
    await until(() => rx.of('/rotate2').length === 1);
    let hit = rx.of('/rotate2').at(-1)!;
    expect(() => verifySignature(s1!, hit.headers as Record<string, string>, hit.body, { now: x.clock.t })).not.toThrow();
    expect(() => verifySignature(r.secret!, hit.headers as Record<string, string>, hit.body, { now: x.clock.t })).not.toThrow();
    const own = newSigningSecret();
    const r2 = await x.svc.rotateSecret(webhook.id, { secret: own, overlapHours: 1 });
    expect(r2.secret).toBeUndefined();
    expect(JSON.stringify(r2)).not.toContain(own.slice(6));
    await x.svc.test(webhook.id);
    await until(() => rx.of('/rotate2').length === 2);
    hit = rx.of('/rotate2').at(-1)!;
    // Never more than two: the oldest secret dropped out.
    expect((hit.headers['webhook-signature'] as string).split(' ')).toHaveLength(2);
    expect(() => verifySignature(own, hit.headers as Record<string, string>, hit.body, { now: x.clock.t })).not.toThrow();
    expect(() => verifySignature(r.secret!, hit.headers as Record<string, string>, hit.body, { now: x.clock.t })).not.toThrow();
    expect(() => verifySignature(s1!, hit.headers as Record<string, string>, hit.body, { now: x.clock.t })).toThrow();
    const end = await x.svc.rotateSecret(webhook.id, { endOverlap: true });
    expect(end.webhook.signing).toMatchObject({ rotating: false });
    await x.svc.test(webhook.id);
    await until(() => rx.of('/rotate2').length === 3);
    hit = rx.of('/rotate2').at(-1)!;
    expect((hit.headers['webhook-signature'] as string).split(' ')).toHaveLength(1);
    expect(() => verifySignature(r.secret!, hit.headers as Record<string, string>, hit.body, { now: x.clock.t })).toThrow();
    await expect(x.svc.rotateSecret(webhook.id, { endOverlap: true, overlapHours: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(x.svc.rotateSecret(webhook.id, { secret: 'not-a-secret' })).rejects.toMatchObject({ status: 400 });
    expect(x.audits.filter((e) => e.action === 'webhook.rotate_secret')).toHaveLength(3);
    expect(JSON.stringify(x.audits)).not.toContain(own.slice(6));
  });

  it('WHK-45 the delivery log: status, attempts and latency per delivery, a summary, the retry policy; no payload, no target URL', async () => {
    const x = await h();
    const url = rx.on('/log/secret-token-path', [500, 200]);
    const { webhook } = await x.svc.create({ name: 'log', url, events: ['*'] });
    x.svc.emit('key.created', { keyId: 'k1' });
    const d = await onlyDelivery(x, webhook.id);
    const p = await settled(x, d.id, 'pending');
    const view = await x.svc.log(webhook.id);
    expect(view.deliveries[0]).toMatchObject({ id: d.id, status: 'pending', attempts: 1, lastStatus: 500, giveUpAt: new Date(Date.parse(d.createdAt) + 24 * 3_600_000).toISOString() });
    expect(view.retry).toEqual({ windowHours: 24, maxAttempts: 20, timeoutSeconds: 2 });
    x.clock.t = Date.parse(p.nextAttemptAt);
    await settled(x, d.id, 'succeeded');
    const done = await x.svc.log(webhook.id, { status: 'succeeded' });
    const row = done.deliveries[0]! as Record<string, any>;
    expect(row.attemptLog.map((a: any) => [a.attempt, a.status, a.outcome])).toEqual([[1, 500, 'retry'], [2, 200, 'success']]);
    expect(row.latencyMs).toBe(row.attemptLog[1].durationMs);
    expect(row.giveUpAt).toBeUndefined();
    expect(done.summary).toMatchObject({ deliveries: 1, attempts: 2, successRate: 0.5 });
    expect(done.summary.latencyMs.max).toBeGreaterThanOrEqual(0);
    expect(done.webhook).toEqual({ id: webhook.id, name: 'log', type: 'webhook', enabled: true });
    const text = JSON.stringify(done);
    expect(text).not.toContain('secret-token-path');
    expect(text).not.toContain('"payload"');
    expect(text).not.toContain('k1');
    await expect(x.svc.log('whk_none')).rejects.toMatchObject({ status: 404 });
  });
});
