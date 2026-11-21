import { describe, expect, it, vi } from 'vitest';
import {
  AuditLog,
  OtlpLogsAuditSink,
  StdoutAuditSink,
  auditToCsv,
  auditToJsonl,
  canonicalJson,
  createMemoryRepositories,
  ipAllowed,
  parseAuditQuery,
  parseCidr,
  redactSecrets,
  requestIdFrom,
  runWithRequest,
  validateKeyOptions,
  withIdempotency,
  type AuditEntry,
  type AuditSink,
} from '../src/index';

/** Unit tests for #65: audit log (AUD-*), sinks (SNK-*), idempotency (IDM-*), key helpers (KEY-*). Case ids: docs/providers/audit-and-keys.md. */

const RF_KEY = `rf_${'A1b2C3d4'.repeat(5)}`;

describe('audit: secrets never reach the log (AUD-02)', () => {
  it('redacts rf_ keys, bearer tokens, private keys and secret-named properties, keeps set/not set markers', () => {
    const out = redactSecrets({
      note: `used ${RF_KEY} today`,
      header: 'Authorization: Bearer abcdefghijklmnop',
      pem: '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
      apiKey: 'sk-live-123456',
      ELEVENLABS_API_KEY: 'set',
      password: 'hunter2',
      clientSecret: '',
      nested: [{ token: 'tok_1234567890' }, { secret: { kept: 'object recursed' } }],
      fine: 'nothing here',
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(RF_KEY);
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).not.toContain('MIIabc');
    expect(text).not.toContain('sk-live');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('tok_1234567890');
    expect(out).toMatchObject({ ELEVENLABS_API_KEY: 'set', fine: 'nothing here', note: 'used rf_[redacted] today', apiKey: '[redacted]', nested: [{ token: '[redacted]' }, { secret: { kept: 'object recursed' } }] });
  });

  it('AuditLog.write redacts what a caller passes by mistake', async () => {
    const repos = createMemoryRepositories();
    const log = new AuditLog(repos.audit);
    await log.write({ actorType: 'cli', action: 'test.leak', data: { key: RF_KEY, password: 'p4ss' } });
    expect(JSON.stringify(await repos.audit.list())).not.toMatch(/A1b2C3d4|p4ss/);
  });
});

describe('audit: request context, UTC times and request ids (AUD-05)', () => {
  it('adds key name, IP, user agent, request id and channel for the current caller; times are UTC ISO', async () => {
    const repos = createMemoryRepositories();
    const log = new AuditLog(repos.audit);
    const ctx = { requestId: requestIdFrom('client-req-1'), ip: '203.0.113.9', userAgent: 'agent/1', via: 'mcp' as const, auth: { keyId: 'key_a', name: 'agent', scopes: ['admin' as const] } };
    const e = await runWithRequest(ctx, () => log.write({ actorType: 'api_key', action: 'project.create', targetType: 'project', targetId: 'p' }));
    expect(e).toMatchObject({ actorId: 'key_a', actorName: 'agent', ip: '203.0.113.9', userAgent: 'agent/1', requestId: 'client-req-1', result: 'success', data: { via: 'mcp' } });
    expect(e.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect((ctx as { audited?: boolean }).audited).toBe(true);
    expect(requestIdFrom('bad id with spaces')).toMatch(/^req_[A-Za-z0-9_-]{12}$/);
    expect(requestIdFrom(undefined)).toMatch(/^req_/);
  });

  it('does not attach the caller to an entry about another actor', async () => {
    const repos = createMemoryRepositories();
    const log = new AuditLog(repos.audit);
    const e = await runWithRequest({ requestId: 'r', via: 'rest', ip: '1.2.3.4', auth: { keyId: 'key_a', name: 'a', scopes: ['admin'] } }, () =>
      log.write({ actorType: 'api_key', actorId: 'key_b', action: 'auth.denied', result: 'denied' })
    );
    expect(e.actorId).toBe('key_b');
    expect(e.ip).toBeUndefined();
  });
});

describe('audit sinks', () => {
  const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({ id: 'aud_1', at: '2026-11-21T10:00:00.000Z', actorType: 'api_key', actorId: 'key_1', action: 'key.rotate', result: 'success', ...over });

  it('SNK-01 database: always on, listed first', async () => {
    const log = new AuditLog(createMemoryRepositories().audit, { sinks: [new StdoutAuditSink(() => undefined)] });
    expect(log.activeSinks()).toEqual(['database', 'stdout']);
  });

  it('SNK-02 stdout: one JSON object per line with type "audit"', async () => {
    const lines: string[] = [];
    const log = new AuditLog(createMemoryRepositories().audit, { sinks: [new StdoutAuditSink((l) => lines.push(l))] });
    const e = await log.write({ actorType: 'cli', action: 'key.create', targetType: 'key', targetId: 'key_9' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'audit', ...e });
  });

  it('SNK-03 otlp: batches entries into one OTLP/HTTP JSON logs request', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200 });
    });
    const sink = new OtlpLogsAuditSink({ endpoint: 'http://collector:4318/v1/logs', fetch: fetchMock as never, serviceVersion: '9.9.9' });
    sink.write(entry({ id: 'aud_a', ip: '10.0.0.1', data: { via: 'rest' } }));
    sink.write(entry({ id: 'aud_b', result: 'denied' }));
    await sink.close();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[0]!.url).toBe('http://collector:4318/v1/logs');
    const rl = calls[0]!.body.resourceLogs[0];
    expect(rl.resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'reelforge-studio' } });
    const records = rl.scopeLogs[0].logRecords;
    expect(rl.scopeLogs[0].scope.name).toBe('reelforge.audit');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ timeUnixNano: String(Date.parse('2026-11-21T10:00:00.000Z') * 1e6), severityText: 'INFO', body: { stringValue: 'key.rotate' } });
    expect(records[0].attributes).toContainEqual({ key: 'client.address', value: { stringValue: '10.0.0.1' } });
    expect(records[1].severityText).toBe('WARN');
  });

  it('SNK-04 a failing sink (throwing, rejecting, unreachable OTLP) never fails the write, and the failure is logged', async () => {
    const repos = createMemoryRepositories();
    const warnings: string[] = [];
    const throwing: AuditSink = { id: 'throws', write: () => { throw new Error('boom'); } };
    const rejecting: AuditSink = { id: 'rejects', write: async () => { throw new Error('later boom'); } };
    const otlp = new OtlpLogsAuditSink({ endpoint: 'http://127.0.0.1:9/v1/logs', timeoutMs: 500, log: (_l, line) => warnings.push(line) });
    const log = new AuditLog(repos.audit, { sinks: [throwing, rejecting, otlp], log: (_l, line) => warnings.push(line) });
    const e = await log.write({ actorType: 'cli', action: 'key.create' });
    await otlp.close();
    await new Promise((r) => setTimeout(r, 10));
    expect((await repos.audit.list()).map((x) => x.id)).toEqual([e.id]);
    expect(warnings.some((w) => w.includes('audit sink throws failed: boom'))).toBe(true);
    expect(warnings.some((w) => w.includes('audit sink rejects failed: later boom'))).toBe(true);
    expect(warnings.some((w) => w.includes('audit sink otlp: 1 entry not delivered to http://127.0.0.1:9'))).toBe(true);
  });
});

describe('audit export and queries (AUD-04, AUD-06)', () => {
  it('writes JSON lines and RFC 4180 CSV, neutralising spreadsheet formulas', () => {
    const e: AuditEntry = { id: 'aud_1', at: '2026-11-21T10:00:00.000Z', actorType: 'api_key', actorName: '=HYPERLINK("x")', action: 'project.create', result: 'success', data: { a: 'b,c' } };
    expect(auditToJsonl([e, e]).split('\n')).toHaveLength(3);
    expect(JSON.parse(auditToJsonl([e]).trim())).toEqual(e);
    const csv = auditToCsv([e]);
    expect(csv.split('\r\n')[0]).toBe('id,at,actorType,actorId,actorName,action,targetType,targetId,result,ip,userAgent,requestId,data');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"{""a"":""b,c""}"');
  });

  it('parses filters and refuses bad ones', () => {
    expect(parseAuditQuery({ from: '2026-11-01', action: 'key.*', result: 'denied', limit: '10', actor: 'key_1' })).toEqual({ from: '2026-11-01T00:00:00.000Z', action: 'key.*', result: 'denied', limit: 10, actorId: 'key_1' });
    expect(() => parseAuditQuery({ from: 'yesterday' })).toThrow(/ISO-8601/);
    expect(() => parseAuditQuery({ result: 'ok' })).toThrow(/result/);
    expect(() => parseAuditQuery({ limit: 5000 })).toThrow(/limit/);
    expect(() => parseAuditQuery({ cursor: 'garbage' })).toThrow(/cursor/);
  });

  it('AUD-04 a large export is read one page (at most 1000 rows) at a time, never all at once', async () => {
    const repos = createMemoryRepositories();
    const log = new AuditLog(repos.audit);
    for (let i = 0; i < 2500; i++) await repos.audit.write({ actorType: 'system', action: `bulk.${i % 3}` });
    const spy = vi.spyOn(repos.audit, 'list');
    let rows = 0;
    let maxPage = 0;
    for await (const page of log.pages({})) {
      rows += page.length;
      maxPage = Math.max(maxPage, page.length);
    }
    expect(rows).toBe(2500);
    expect(maxPage).toBeLessThanOrEqual(1000);
    expect(spy.mock.calls.length).toBe(3);
    expect(spy.mock.calls.every(([f]) => (f?.limit ?? 0) <= 1000)).toBe(true);
    const { events, truncated } = await log.all({}, 2000);
    expect(events).toHaveLength(2000);
    expect(truncated).toBe(true);
  });

  it('AUD-07 retention: sweep deletes entries older than retentionDays; 0 keeps everything', async () => {
    const repos = createMemoryRepositories();
    const log = new AuditLog(repos.audit);
    await log.write({ actorType: 'system', action: 'old' });
    expect(await log.sweep(0, Date.now() + 400 * 86_400_000)).toBe(0);
    expect(await log.sweep(365, Date.now() + 364 * 86_400_000)).toBe(0);
    expect(await log.sweep(365, Date.now() + 366 * 86_400_000)).toBe(1);
  });
});

describe('API key helpers (KEY-*)', () => {
  it('KEY-05 parses CIDR blocks and matches IPv4, IPv6 and IPv4-mapped addresses', () => {
    expect(parseCidr('10.1.2.3').text).toBe('10.1.2.3/32');
    expect(parseCidr('2001:db8::/32').text).toBe('2001:db8::/32');
    expect(() => parseCidr('10.0.0.0/33')).toThrow(/prefix/);
    expect(() => parseCidr('example.com')).toThrow(/not an IP/);
    expect(() => parseCidr('10.0.0.0/8/1')).toThrow();
    expect(ipAllowed('10.200.0.1', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('::ffff:10.200.0.1', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('2001:db8::5', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::5', ['2001:db8::/32'])).toBe(false);
    expect(ipAllowed(undefined, ['0.0.0.0/0'])).toBe(false);
  });

  it('validates key options', () => {
    const now = Date.parse('2026-11-21T00:00:00Z');
    expect(validateKeyOptions({ expiresAt: '2027-01-01', rendersPerDay: 3, ipAllowlist: ['10.0.0.1', '10.0.0.1/32'] }, now)).toEqual({ expiresAt: '2027-01-01T00:00:00.000Z', rendersPerDay: 3, ipAllowlist: ['10.0.0.1/32'] });
    expect(validateKeyOptions({ ipAllowlist: [], expiresAt: null }, now)).toEqual({ ipAllowlist: null, expiresAt: null });
    expect(() => validateKeyOptions({ expiresAt: '2020-01-01' }, now)).toThrow(/future/);
    expect(() => validateKeyOptions({ rendersPerDay: -1 }, now)).toThrow(/rendersPerDay/);
    expect(() => validateKeyOptions({ rateLimitPerMinute: 1.5 }, now)).toThrow(/rateLimitPerMinute/);
  });
});

describe('idempotency (IDM-*)', () => {
  it('canonical JSON ignores key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, { y: 2, x: 1 }] } })).toBe('{"a":{"c":[1,{"x":1,"y":2}]},"b":1}');
  });

  it('IDM-05 a failed first call stores nothing, so the same key can be retried', async () => {
    const repo = createMemoryRepositories().idempotency;
    const call = { key: 'k', actorId: 'a', operation: 'create_project' as const, request: { x: 1 }, ttlHours: 24 };
    await expect(withIdempotency(repo, call, async () => { throw new Error('first try fails'); })).rejects.toThrow('first try fails');
    expect(await repo.get('a', 'k')).toBeNull();
    expect(await withIdempotency(repo, call, async () => ({ ok: 1 }))).toEqual({ result: { ok: 1 }, replayed: false });
  });

  it('IDM-06 a second call while the first runs gets 409 idempotency_in_progress; bad keys get 400', async () => {
    const repo = createMemoryRepositories().idempotency;
    const call = { key: 'k2', actorId: 'a', operation: 'render_project' as const, request: {}, ttlHours: 24 };
    let release!: () => void;
    const first = withIdempotency(repo, call, () => new Promise<{ ok: number }>((r) => (release = () => r({ ok: 1 }))));
    await new Promise((r) => setTimeout(r, 5));
    await expect(withIdempotency(repo, call, async () => ({ ok: 2 }))).rejects.toMatchObject({ code: 'idempotency_in_progress', status: 409 });
    release();
    expect((await first).result).toEqual({ ok: 1 });
    await expect(withIdempotency(repo, { ...call, key: 'has space' }, async () => 1)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(withIdempotency(repo, { ...call, key: 'x'.repeat(129) }, async () => 1)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('IDM-07 keys of different callers never collide', async () => {
    const repo = createMemoryRepositories().idempotency;
    const base = { key: 'same', operation: 'create_project' as const, request: { a: 1 }, ttlHours: 24 };
    expect((await withIdempotency(repo, { ...base, actorId: 'key_a' }, async () => 'A')).result).toBe('A');
    expect((await withIdempotency(repo, { ...base, actorId: 'key_b', request: { a: 2 } }, async () => 'B')).result).toBe('B');
  });
});
