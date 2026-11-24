import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ElevenLabsTts, PluginRegistry, type AuditEntry, type AuditSink } from '@reelforge/core';
import { TOOLS, startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * Enterprise E2 (#65) over real HTTP, REST and MCP side by side: audit log
 * (AUD-*), sinks (SNK-*), key lifecycle (KEY-*) and idempotency (IDM-*), with
 * an injected clock for expiry, rotation grace and the 24 h idempotency TTL.
 * Case ids and results: docs/providers/audit-and-keys.md.
 */
const { dir, cleanup } = tempDir('reelforge-enterprise-');
const repo = resolve(__dirname, '../../..');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const SECRET_KEY = 'enterprise-test-secret-key-0123456789abcdef';
const ELEVEN = 'sk_eleven_' + 'Q'.repeat(24);
const LICENCE = 'LICEN-CEKEY-SECRE-TVALU-E2345';
let server: StartedServer;
let admin: string;
let env: Record<string, string>;
let clock = Date.now();
let dropDb: () => Promise<void> = async () => undefined;
const captured: AuditEntry[] = [];
const logs: string[] = [];
const stdoutLines: string[] = [];
const secrets: string[] = [SECRET_KEY, ELEVEN, LICENCE];

const captureSink: AuditSink = { id: 'capture', write: (e) => void captured.push(e) };
const brokenSink: AuditSink = { id: 'broken', write: () => Promise.reject(new Error('webhook endpoint down')) };

async function rest(method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${opts.key ?? admin}`, 'user-agent': 'enterprise-test/1.0', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function mcp(key: string) {
  const client = new Client({ name: 'enterprise-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const body = JSON.parse(r.content[0].text);
    return r.isError ? { error: body.error } : body;
  };
  return { client, call, close: () => client.close() };
}

const manifest = (id: string, title = 'Enterprise') => ({ ...sample, projectId: id, title });
const auditList = async (q: string) => (await rest('GET', `/v1/audit?${q}`)).json.events as AuditEntry[];

beforeAll(async () => {
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));
  const database = await testDatabase(dir);
  dropDb = database.drop;
  env = {
    ...database.env,
    REELFORGE_LICENCE_MODE: 'off',
    REELFORGE_SECRET_KEY: SECRET_KEY,
    REELFORGE_RATE_LIMIT_PER_MINUTE: '0',
    REELFORGE_AUDIT_SINKS: 'stdout,capture,broken',
  };
  const origWrite = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...rest: any[]) => {
    const s = String(chunk);
    if (s.startsWith('{"type":"audit"')) {
      stdoutLines.push(s.trim());
      return true;
    }
    return origWrite(chunk, ...rest);
  }) as never);
  const keep = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    { registry: (penv) => registry.registerProvider(new ElevenLabsTts(penv)), env, auditSinks: [captureSink, brokenSink], now: () => clock, logWrite: (_level, line) => keep(line) }
  );
  admin = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
  secrets.push(admin);
}, 60_000);

afterAll(async () => {
  await server?.close();
  vi.restoreAllMocks();
  await dropDb();
  cleanup();
});

describe('audit log (AUD)', () => {
  it('AUD-01 every admin and write call over REST and MCP writes one entry: key id and name, action, target, result, IP, user agent, request id', async () => {
    const r = await rest('POST', '/v1/projects', { body: { manifest: manifest('aud-rest') }, headers: { 'x-request-id': 'req-aud-01' } });
    expect(r.status).toBe(201);
    expect(r.headers.get('x-request-id')).toBe('req-aud-01');
    const m = await mcp(admin);
    expect((await m.call('create_project', { manifest: manifest('aud-mcp') })).meta.id).toBe('aud-mcp');
    expect((await m.call('list_projects')).projects.length).toBeGreaterThanOrEqual(2);
    await m.close();
    await rest('GET', '/v1/projects'); // a read: not audited
    const events = await auditList('action=project.create');
    const restE = events.find((e) => e.targetId === 'aud-rest')!;
    const mcpE = events.find((e) => e.targetId === 'aud-mcp')!;
    const adminId = (await rest('GET', '/v1/keys')).json.keys.find((k: any) => k.name === 'admin').id;
    expect(restE).toMatchObject({ actorType: 'api_key', actorId: adminId, actorName: 'admin', action: 'project.create', targetType: 'project', result: 'success', ip: '127.0.0.1', userAgent: 'enterprise-test/1.0', requestId: 'req-aud-01', data: { via: 'rest', status: 201 } });
    expect(mcpE).toMatchObject({ actorId: adminId, actorName: 'admin', result: 'success', ip: '127.0.0.1', data: { via: 'mcp' } });
    expect(mcpE.requestId).toMatch(/^req_/);
    // AUD-05: UTC timestamps.
    for (const e of [restE, mcpE]) expect(e.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await auditList('action=projects.list')).toEqual([]);
    expect(await auditList('action=project.create&targetId=aud-rest')).toHaveLength(1);
  });

  it('AUD-01b failures and scope refusals are recorded with result failure / denied', async () => {
    const reader = (await rest('POST', '/v1/keys', { body: { name: 'reader', scopes: ['read'] } })).json;
    secrets.push(reader.key);
    expect((await rest('POST', '/v1/projects', { key: reader.key, body: { manifest: manifest('nope') } })).status).toBe(403);
    expect((await rest('POST', '/v1/projects', { body: { manifest: { schemaVersion: '0.2' } } })).status).toBe(422);
    const m = await mcp(reader.key);
    expect((await m.call('update_config', { settings: { 'limits.maxJsonBytes': 9999 } })).error.code).toBe('forbidden');
    await m.close();
    const denied = await auditList(`result=denied&actorId=${reader.record.id}`);
    expect(denied.map((e) => e.action).sort()).toEqual(['config.update', 'project.create']);
    const failed = await auditList('result=failure&action=project.create');
    expect(failed[0]).toMatchObject({ data: { error: 'invalid_manifest', status: 422 } });
  });

  it('AUD-02 no secret values or key material in the audit trail, its exports, the sinks or the server log', async () => {
    expect((await rest('PUT', '/v1/providers/elevenlabs/config', { body: { values: { ELEVENLABS_API_KEY: ELEVEN } } })).status).toBe(200);
    const m = await mcp(admin);
    expect((await m.call('update_config', { settings: { 'licence.key': LICENCE } })).changes).toBeDefined();
    const k = await m.call('create_key', { name: 'secret-check', scopes: ['read'] });
    const rotated = await m.call('rotate_key', { keyId: k.record.id });
    secrets.push(k.key, rotated.key);
    // A caller mistake: a secret pasted where an id belongs never lands in the trail either.
    await m.call('get_key', { keyId: k.key });
    await m.close();
    const jsonl = (await rest('GET', '/v1/audit?format=jsonl')).text;
    const csv = (await rest('GET', '/v1/audit?format=csv')).text;
    const m2 = await mcp(admin);
    const mcpExport = (await m2.call('list_audit_events', { format: 'jsonl' })).content;
    await m2.close();
    const rows = JSON.stringify(await server.service.repos.audit.list({ limit: 1000 }));
    for (const haystack of [jsonl, csv, mcpExport, rows, JSON.stringify(captured), stdoutLines.join('\n'), logs.join('\n')]) {
      for (const s of secrets) expect(haystack.includes(s), `secret ${s.slice(0, 6)}… leaked`).toBe(false);
      expect(haystack).not.toMatch(/rf_[A-Za-z0-9_-]{20,}/);
    }
    expect(jsonl).toContain('"provider.configure"');
    expect(jsonl).toContain('"ELEVENLABS_API_KEY":"set"');
  });

  it('AUD-03 the trail is append-only: no REST route or MCP tool changes or deletes entries', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await rest(method, '/v1/audit')).status).toBe(404);
    const first = (await auditList('limit=1'))[0]!;
    expect((await rest('DELETE', `/v1/audit/${first.id}`)).status).toBe(404);
    expect(TOOLS.filter((t) => /audit/.test(t.name)).map((t) => t.name)).toEqual(['list_audit_events']);
    expect(TOOLS.find((t) => t.name === 'list_audit_events')!.annotations?.readOnlyHint).toBe(true);
  });

  it('AUD-04 a large export streams page by page (REST JSONL and CSV), MCP returns a bounded export', async () => {
    for (let i = 0; i < 2600; i++) await server.service.repos.audit.write({ actorType: 'system', action: 'bulk.load', targetId: `n${i}` });
    const spy = vi.spyOn(server.service.repos.audit, 'list');
    const res = await fetch(`${server.url}/v1/audit?format=jsonl&action=bulk.load`, { headers: { authorization: `Bearer ${admin}` } });
    expect(res.headers.get('content-type')).toMatch(/application\/x-ndjson/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="reelforge-audit-\d{8}T\d{6}Z\.jsonl"/);
    let chunks = 0;
    let text = '';
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      text += new TextDecoder().decode(value);
    }
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2600);
    expect(JSON.parse(lines[0]!).targetId).toBe('n2599');
    expect(chunks).toBeGreaterThanOrEqual(3);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(spy.mock.calls.every(([f]) => (f?.limit ?? 0) <= 1000)).toBe(true);
    spy.mockRestore();
    const csv = (await rest('GET', '/v1/audit?format=csv&action=bulk.load&limit=10')).text.trim().split('\r\n');
    expect(csv).toHaveLength(11);
    expect(csv[0]).toMatch(/^id,at,actorType/);
    const m = await mcp(admin);
    const exp = await m.call('list_audit_events', { format: 'csv', action: 'bulk.load', limit: 2000 });
    expect(exp).toMatchObject({ format: 'csv', count: 2000, truncated: true });
    await m.close();
  }, 60_000);

  it('AUD-06 filters by time, actor, action, target and result, with cursor paging, over REST and MCP', async () => {
    const page1 = (await rest('GET', '/v1/audit?action=bulk.*&limit=1000')).json;
    expect(page1.events).toHaveLength(1000);
    const page2 = (await rest('GET', `/v1/audit?action=bulk.*&limit=1000&cursor=${page1.nextCursor}`)).json;
    expect(page2.events[0].id < page1.events[999].id).toBe(true);
    expect(page1).toMatchObject({ retentionDays: 365, sinks: ['database', 'stdout', 'capture', 'broken'] });
    const m = await mcp(admin);
    const r = await m.call('list_audit_events', { action: 'key.*', from: new Date(Date.now() - 3_600_000).toISOString() });
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.events.every((e: AuditEntry) => e.action.startsWith('key.'))).toBe(true);
    expect((await m.call('list_audit_events', { to: '2000-01-01T00:00:00Z' })).events).toEqual([]);
    expect((await m.call('list_audit_events', { from: 'not a date' })).error.code).toBe('bad_request');
    await m.close();
  });

  it('AUD-07 retention: the sweep deletes entries past audit.retentionDays and records that it did', async () => {
    expect((await rest('PATCH', '/v1/config', { body: { settings: { 'audit.retentionDays': 1 } } })).status).toBe(200);
    const r = await server.service.sweep(Date.now() + 2 * 86_400_000);
    expect(r.auditDeleted).toBeGreaterThan(2600);
    expect((await auditList('action=audit.sweep'))[0]).toMatchObject({ actorType: 'system', data: { retentionDays: 1 } });
    expect(await auditList('action=bulk.load')).toEqual([]);
    await rest('PATCH', '/v1/config', { body: { settings: { 'audit.retentionDays': null } } });
  });
});

describe('audit sinks (SNK)', () => {
  it('SNK-02 stdout: every entry is one JSON line {"type":"audit",...} with the request id', async () => {
    await rest('POST', '/v1/projects', { body: { manifest: manifest('snk-stdout') }, headers: { 'x-request-id': 'req-snk-02' } });
    const line = stdoutLines.map((l) => JSON.parse(l)).find((e) => e.requestId === 'req-snk-02');
    expect(line, JSON.stringify(line)).toMatchObject({ type: 'audit', action: 'project.create', targetType: 'project', targetId: 'snk-stdout', result: 'success', ip: '127.0.0.1' });
  });

  it('SNK-05 plugin sinks get the same entry as the database (several sinks at once)', async () => {
    const db = await auditList('limit=1');
    expect(captured.some((e) => e.id === db[0]!.id)).toBe(true);
  });

  it('SNK-04 a failing sink never blocks or fails the request, and the failure is in the server log', async () => {
    const t0 = Date.now();
    const r = await rest('POST', '/v1/projects', { body: { manifest: manifest('snk-broken') } });
    expect(r.status).toBe(201);
    expect(Date.now() - t0).toBeLessThan(5000);
    await new Promise((res) => setTimeout(res, 20));
    expect(logs.some((l) => l.includes('audit sink broken failed: webhook endpoint down'))).toBe(true);
    expect((await auditList('targetId=snk-broken'))[0]!.action).toBe('project.create');
  });
});

describe('API key lifecycle (KEY)', () => {
  it('KEY-07 render quota per key (REST and MCP), with usage in get_key', async () => {
    const q = (await rest('POST', '/v1/keys', { body: { name: 'quota', scopes: ['write', 'render', 'read'], rendersPerDay: 1 } })).json;
    secrets.push(q.key);
    expect((await rest('POST', '/v1/projects', { key: q.key, body: { manifest: manifest('quota-p') } })).status).toBe(201);
    expect((await rest('POST', '/v1/projects/quota-p/renders', { key: q.key, body: {} })).status).toBe(202);
    const second = await rest('POST', '/v1/projects/quota-p/renders', { key: q.key, body: {} });
    expect(second.status).toBe(429);
    expect(second.json.error).toMatchObject({ code: 'quota_exceeded', details: { period: 'day', limit: 1, used: 1 } });
    const m = await mcp(q.key);
    expect((await m.call('preview_scene', { projectId: 'quota-p' })).error.code).toBe('quota_exceeded');
    await m.close();
    expect((await rest('GET', `/v1/keys/${q.record.id}`)).json).toMatchObject({ rendersPerDay: 1, usage: { rendersToday: 1, rendersThisMonth: 1 } });
    await server.service.jobs.flush();
  });

  it('KEY-06 per-key rate limit over REST and MCP (429 with Retry-After)', async () => {
    const k = (await rest('POST', '/v1/keys', { body: { name: 'slow', scopes: ['read'], rateLimitPerMinute: 3 } })).json;
    secrets.push(k.key);
    for (let i = 0; i < 3; i++) expect((await rest('GET', '/v1/projects', { key: k.key })).status).toBe(200);
    const limited = await rest('GET', '/v1/projects', { key: k.key });
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    await expect(mcp(k.key)).rejects.toThrow(); // the same bucket covers /mcp
    expect((await rest('GET', '/v1/projects')).status).toBe(200); // other keys are unaffected (server default: no limit)
  });

  it('KEY-04 IP allowlist: allowed and refused addresses over REST and MCP; X-Forwarded-For only with server.trustProxy', async () => {
    const ok = (await rest('POST', '/v1/keys', { body: { name: 'ip-ok', scopes: ['read'], ipAllowlist: ['127.0.0.1/32', '::1'] } })).json;
    const no = (await rest('POST', '/v1/keys', { body: { name: 'ip-no', scopes: ['read'], ipAllowlist: ['203.0.113.0/24'] } })).json;
    secrets.push(ok.key, no.key);
    expect((await rest('GET', '/v1/projects', { key: ok.key })).status).toBe(200);
    const refused = await rest('GET', '/v1/projects', { key: no.key });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('ip_not_allowed');
    const m = await mcp(ok.key);
    expect((await m.call('list_projects')).projects).toBeDefined();
    await m.close();
    await expect(mcp(no.key)).rejects.toThrow();
    // A forged X-Forwarded-For is ignored unless the operator trusts the proxy.
    expect((await rest('GET', '/v1/projects', { key: no.key, headers: { 'x-forwarded-for': '203.0.113.5' } })).status).toBe(403);
    await rest('PATCH', '/v1/config', { body: { settings: { 'server.trustProxy': true } } });
    expect((await rest('GET', '/v1/projects', { key: no.key, headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.5' } })).status).toBe(200);
    expect((await rest('GET', '/v1/projects', { key: ok.key, headers: { 'x-forwarded-for': '203.0.113.5' } })).status).toBe(403);
    await rest('PATCH', '/v1/config', { body: { settings: { 'server.trustProxy': null } } });
    const denied = await auditList(`action=auth.denied&actorId=${no.record.id}`);
    expect(denied[0], JSON.stringify(denied[0])).toMatchObject({ result: 'denied', data: { reason: 'ip_not_allowed' }, ip: '127.0.0.1' });
    expect((await rest('POST', '/v1/keys', { body: { name: 'bad', scopes: ['read'], ipAllowlist: ['300.1.1.1/8'] } })).status).toBe(400);
  });

  it('KEY-01 expiry over MCP and REST (injected clock); expired keys are refused and audited', async () => {
    const m = await mcp(admin);
    const k = await m.call('create_key', { name: 'expiring', scopes: ['read'], expiresAt: new Date(clock + 3_600_000).toISOString() });
    secrets.push(k.key);
    expect(k.record).toMatchObject({ status: 'active', expiresAt: new Date(clock + 3_600_000).toISOString() });
    expect((await rest('GET', '/v1/projects', { key: k.key })).status).toBe(200);
    clock += 2 * 3_600_000;
    const r = await rest('GET', '/v1/projects', { key: k.key });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('key_expired');
    await expect(mcp(k.key)).rejects.toThrow();
    expect((await m.call('get_key', { keyId: k.record.id })).status).toBe('expired');
    // update_key can extend it.
    expect((await m.call('update_key', { keyId: k.record.id, expiresAt: null })).status).toBe('active');
    expect((await rest('GET', '/v1/projects', { key: k.key })).status).toBe(200);
    await m.close();
    expect((await auditList(`action=auth.denied&actorId=${k.record.id}`))[0]!.data).toMatchObject({ reason: 'expired' });
    expect((await rest('POST', '/v1/keys', { body: { name: 'past', scopes: ['read'], expiresAt: '2001-01-01T00:00:00Z' } })).status).toBe(400);
  });

  it('KEY-02 rotation: new secret once, old secret works for the grace window (REST and MCP), then stops', async () => {
    const k = (await rest('POST', '/v1/keys', { body: { name: 'rotating', scopes: ['read'] } })).json;
    const m = await mcp(admin);
    const r = await m.call('rotate_key', { keyId: k.record.id, graceHours: 1 });
    secrets.push(k.key, r.key);
    expect(r.key).not.toBe(k.key);
    expect(r.record).toMatchObject({ id: k.record.id, name: 'rotating', status: 'active', previousSecretExpiresAt: new Date(clock + 3_600_000).toISOString() });
    expect((await rest('GET', '/v1/projects', { key: k.key })).status).toBe(200);
    expect((await rest('GET', '/v1/projects', { key: r.key })).status).toBe(200);
    const old = await mcp(k.key);
    expect((await old.call('list_projects')).projects).toBeDefined();
    await old.close();
    clock += 3_600_000 + 1;
    expect((await rest('GET', '/v1/projects', { key: k.key })).status).toBe(401);
    expect((await rest('GET', '/v1/projects', { key: r.key })).status).toBe(200);
    // REST rotation with the server default grace (keys.rotationGraceHours = 24).
    const r2 = (await rest('POST', `/v1/keys/${k.record.id}/rotate`, { body: {} })).json;
    secrets.push(r2.key);
    expect(r2.record.previousSecretExpiresAt).toBe(new Date(clock + 24 * 3_600_000).toISOString());
    expect((await rest('GET', '/v1/projects', { key: r.key })).status).toBe(200);
    await m.close();
    const trail = (await auditList(`targetId=${k.record.id}&action=key.*`)).map((e) => e.action).reverse();
    expect(trail).toEqual(['key.create', 'key.rotate', 'key.rotate']);
  });

  it('KEY-03 revoke over REST and MCP: refused at once, still listed as revoked, cannot revoke yourself', async () => {
    const a = (await rest('POST', '/v1/keys', { body: { name: 'revoke-rest', scopes: ['read'] } })).json;
    const b = (await rest('POST', '/v1/keys', { body: { name: 'revoke-mcp', scopes: ['admin'] } })).json;
    secrets.push(a.key, b.key);
    expect((await rest('POST', `/v1/keys/${a.record.id}/revoke`)).json.status).toBe('revoked');
    const r = await rest('GET', '/v1/projects', { key: a.key });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('key_revoked');
    const m = await mcp(b.key);
    expect((await m.call('revoke_key', { keyId: b.record.id })).error.code).toBe('conflict');
    await m.close();
    const m2 = await mcp(admin);
    expect((await m2.call('revoke_key', { keyId: b.record.id })).status).toBe('revoked');
    expect((await m2.call('list_keys')).keys.find((k: any) => k.id === b.record.id).status).toBe('revoked');
    await m2.close();
    await expect(mcp(b.key)).rejects.toThrow();
    expect((await rest('POST', `/v1/keys/${a.record.id}/rotate`, { body: {} })).json.error.code).toBe('key_revoked');
  });

  it('KEY-09 CLI equivalents: create with expiry and limits, show, update, rotate, revoke, audit list/export', async () => {
    const cli = (args: string[]) => {
      const r = spawnSync(join(repo, 'node_modules/.bin/tsx'), ['apps/server/src/cli.ts', ...args], {
        cwd: repo,
        env: { ...process.env, ...env, REELFORGE_DATA_DIR: join(dir, 'data') },
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (r.status !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    const out = cli(['keys', 'create', '--name', 'cli-key', '--scopes', 'read', '--expires-in', '30d', '--renders-per-day', '5', '--ip-allow', '10.0.0.0/8']);
    const key = out.trim().split('\n').pop()!.trim();
    const id = /\((key_[a-z0-9]+)\)/.exec(out)![1]!;
    secrets.push(key);
    expect(out).toMatch(/5 renders\/day; from 10\.0\.0\.0\/8/);
    expect(JSON.parse(cli(['keys', 'show', id]))).toMatchObject({ id, rendersPerDay: 5, ipAllowlist: ['10.0.0.0/8'] });
    expect(cli(['keys', 'update', id, '--ip-allow', 'none', '--rate-limit', '9'])).toMatch(/9\/min/);
    const rot = cli(['keys', 'rotate', id, '--grace-hours', '2']);
    secrets.push(rot.trim().split('\n').pop()!.trim());
    expect(rot).toMatch(/The old key works until/);
    expect(cli(['keys', 'revoke', id])).toMatch(/Revoked/);
    expect(cli(['keys', 'list'])).toMatch(new RegExp(`${id} .*revoked`));
    const list = cli(['audit', 'list', '--target', id]);
    for (const a of ['key.create', 'key.update', 'key.rotate', 'key.revoke']) expect(list).toContain(a);
    const exported = cli(['audit', 'export', '--format', 'jsonl', '--target', id]).trim().split('\n').map((l) => JSON.parse(l));
    expect(exported.every((e: AuditEntry) => e.actorType === 'cli' && e.actorName?.startsWith('cli'))).toBe(true);
    for (const s of secrets) expect(list + JSON.stringify(exported)).not.toContain(s);
    expect(cli(['audit', 'sweep'])).toMatch(/deleted \d+ audit entr/);
  }, 120_000);
});

describe('idempotency keys (IDM)', () => {
  it('IDM-01 same key and body: the stored response (REST and MCP share keys); one project', async () => {
    const h = { 'idempotency-key': 'idm-01' };
    const a = await rest('POST', '/v1/projects', { body: { manifest: manifest('idm-p') }, headers: h });
    const b = await rest('POST', '/v1/projects', { body: { manifest: manifest('idm-p') }, headers: h });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json).toEqual(a.json);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect(a.headers.get('idempotent-replayed')).toBeNull();
    const m = await mcp(admin);
    const c = await m.call('create_project', { manifest: manifest('idm-p'), idempotencyKey: 'idm-01' });
    expect(c.meta).toEqual(a.json.meta);
    await m.close();
    expect((await rest('GET', '/v1/projects/idm-p/versions')).json.versions).toEqual([1]);
    expect((await auditList('targetId=idm-p&action=project.create')).filter((e) => e.data?.idempotentReplay)).toHaveLength(2);
  });

  it('IDM-02 same key, different body: 422 idempotency_conflict (REST and MCP)', async () => {
    const r = await rest('POST', '/v1/projects', { body: { manifest: manifest('idm-p', 'Other title') }, headers: { 'idempotency-key': 'idm-01' } });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('idempotency_conflict');
    const m = await mcp(admin);
    expect((await m.call('render_project', { projectId: 'idm-p', idempotencyKey: 'idm-01' })).error.code).toBe('idempotency_conflict');
    await m.close();
  });

  it('IDM-03 a repeated render with the same key starts one job only (MCP and REST)', async () => {
    const m = await mcp(admin);
    const j1 = await m.call('render_project', { projectId: 'idm-p', idempotencyKey: 'idm-render-1' });
    const j2 = await m.call('render_project', { projectId: 'idm-p', idempotencyKey: 'idm-render-1' });
    expect(j2.job.id).toBe(j1.job.id);
    const r = await rest('POST', '/v1/projects/idm-p/renders', { body: {}, headers: { 'idempotency-key': 'idm-render-1' } });
    expect(r.status).toBe(202);
    expect(r.json.job.id).toBe(j1.job.id);
    expect((await m.call('list_jobs', { projectId: 'idm-p' })).jobs).toHaveLength(1);
    await m.close();
    await server.service.jobs.flush();
  });

  it('IDM-04 keys expire after 24 h (injected clock): the same key then starts a new job; the sweep removes expired keys', async () => {
    clock += 24 * 3_600_000 + 1000;
    const r = await rest('POST', '/v1/projects/idm-p/renders', { body: {}, headers: { 'idempotency-key': 'idm-render-1' } });
    expect(r.status).toBe(202);
    expect((await rest('GET', '/v1/jobs?projectId=idm-p')).json.jobs).toHaveLength(2);
    await server.service.jobs.flush();
    clock += 24 * 3_600_000 + 1000;
    const swept = await server.service.sweep();
    expect(swept.idempotencyDeleted).toBeGreaterThanOrEqual(2);
    const adminId = (await rest('GET', '/v1/keys')).json.keys.find((k: any) => k.name === 'admin').id;
    expect(await server.service.repos.idempotency.get(adminId, 'idm-01')).toBeNull();
  });

  it('IDM-09 bad keys and calls without a key', async () => {
    expect((await rest('POST', '/v1/projects', { body: { manifest: manifest('idm-bad') }, headers: { 'idempotency-key': 'has spaces' } })).status).toBe(400);
    expect((await rest('POST', '/v1/projects', { body: { manifest: manifest('idm-none') } })).status).toBe(201);
    expect((await rest('POST', '/v1/projects', { body: { manifest: manifest('idm-none') } })).status).toBe(409);
  });
});
