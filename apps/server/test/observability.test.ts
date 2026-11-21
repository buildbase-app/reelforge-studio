import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, resolveConfig, ConfigError } from '@reelforge/core';
import { Redactor, StructuredLogger, routeOf, secretValues, parseOtlpHeaders, startServer, type StartedServer } from '../src/index';
import { REST_ROUTES, INFRA_ROUTES } from '../src/routes';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { parsePrometheus, startOtlpReceiver, type OtlpReceiver } from './otlpReceiver';
import { testDatabase } from './serverProcess';

/**
 * Observability (issue #64, D-050..D-054). Test case ids OBS-xx are listed in
 * docs/providers/observability.md with how each is checked.
 */
const { dir, cleanup } = tempDir('reelforge-obs-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const BOOTSTRAP = 'rf_obsBootstrapKey_0123456789abcdef';
const SECRET_KEY = 'obs-test-secret-key-0123456789-abcdefgh';
const ELEVEN = 'sk_eleven_SECRET_value_123456';
const OTLP_TOKEN = 'hny_SECRET_team_key_abcdef';
let dropDbs: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const d of dropDbs) await d();
  cleanup();
});

const registry = () => new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));
let n = 0;
async function start(env: NodeJS.ProcessEnv = {}) {
  const lines: Array<{ level: string; line: string }> = [];
  const dataDir = join(dir, `srv${n++}`);
  const db = await testDatabase(dataDir);
  dropDbs.push(db.drop);
  const server = await startServer(
    { dataDir, port: 0, host: '127.0.0.1' },
    {
      registry,
      env: { REELFORGE_LICENCE_MODE: 'off', REELFORGE_SECRET_KEY: SECRET_KEY, REELFORGE_BOOTSTRAP_KEY: BOOTSTRAP, ELEVENLABS_API_KEY: ELEVEN, ...db.env, ...env },
      logWrite: (level, line) => lines.push({ level, line }),
      licence: { start: false },
    }
  );
  const json = () => lines.filter((l) => l.line.startsWith('{')).map((l) => JSON.parse(l.line));
  return { server, lines, json, text: () => lines.map((l) => l.line).join('\n') };
}

async function api(server: StartedServer, method: string, path: string, opts: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const key = opts.key === undefined ? BOOTSTRAP : opts.key;
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // text (metrics)
  }
  return { status: res.status, body, text, headers: res.headers };
}

async function renderSample(server: StartedServer, headers: Record<string, string> = {}) {
  await api(server, 'POST', '/v1/projects', { body: sample });
  const r = await api(server, 'POST', '/v1/projects/sample-reel/renders', { body: {}, headers });
  expect(r.status).toBe(202);
  const job = await api(server, 'GET', `/v1/jobs/${r.body.job.id}?wait=50`);
  expect(job.body.status).toBe('succeeded');
  return job.body;
}

async function until<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
  const port = (s.address() as { port: number }).port;
  await new Promise((ok) => s.close(ok));
  return port;
}

describe('logger and redaction (unit)', () => {
  it('OBS-01 stdout exporter: one JSON object per line with time, level, msg, service and fields; level filter; pretty lines', () => {
    const out: Array<[string, string]> = [];
    let level: 'debug' | 'info' | 'warn' | 'error' = 'info';
    const logger = new StructuredLogger({ level: () => level, service: 'svc', write: (l, line) => out.push([l, line]) });
    logger.log('debug', 'hidden');
    logger.log('info', 'hello', { request_id: 'r1', status: 200 });
    expect(out).toHaveLength(1);
    const rec = JSON.parse(out[0]![1]);
    expect(rec).toMatchObject({ level: 'info', msg: 'hello', service: 'svc', request_id: 'r1', status: 200 });
    expect(new Date(rec.time).toString()).not.toBe('Invalid Date');
    level = 'debug'; // logging.level is read on every call (runtime setting)
    logger.log('debug', 'shown');
    expect(out).toHaveLength(2);
    logger.exporter = 'pretty';
    logger.log('warn', 'careful', { route: '/v1/x' });
    expect(out[2]).toEqual(['warn', '[reelforge] warn: careful route=/v1/x']);
  });

  it('OBS-02 redaction: API keys, bearer/basic credentials, URL passwords, signed-URL signatures, secret values and secret-named fields', () => {
    const r = new Redactor(['sk_eleven_SECRET_value_123456', 'short']);
    const line = r.text(
      'key rf_abcdefghijklmnopqrstuv Authorization: Bearer abc.def.ghi123 Basic dXNlcjpwYXNz postgresql://rf:p%40ss@db:5432/x ' +
        '/v1/renders/run_1/output?expires=1&sig=deadbeef01 value sk_eleven_SECRET_value_123456 short'
    );
    expect(line).not.toMatch(/abcdefghijklmnopqrstuv|abc\.def\.ghi123|dXNlcjpwYXNz|p%40ss|deadbeef01|SECRET/);
    expect(line).toContain('rf_[REDACTED]');
    expect(line).toContain('postgresql://rf:[REDACTED]@db:5432/x');
    expect(line).toContain('short'); // values under 6 characters are not matched (they would hit ordinary words)
    const v = r.value({ password: 'x', apiKey: 'y', authorization: 'z', nested: { token: 't', ok: 'fine' }, key_id: 'key_1', err: new Error('rf_abcdefghijklmnopqrstuv broke') }) as any;
    expect(v).toMatchObject({ password: '[REDACTED]', apiKey: '[REDACTED]', authorization: '[REDACTED]', nested: { token: '[REDACTED]', ok: 'fine' }, key_id: 'key_1' });
    expect(v.err.message).toBe('rf_[REDACTED] broke');
    expect(JSON.stringify(v)).not.toContain('abcdefghijklmnopqrstuv');
  });

  it('OBS-02 secretValues: every secret setting, the database password, OTLP header values and provider keys', () => {
    const resolved = resolveConfig({
      env: {
        DATABASE_URL: 'postgresql://rf:Pa55word-xyz@db:5432/rf',
        REELFORGE_OTLP_HEADERS: `x-honeycomb-team=${OTLP_TOKEN},authorization=Basic QWxhZGRpbjpvcGVu`,
        REELFORGE_METRICS_TOKEN: 'metrics-token-0123456789',
        REELFORGE_DATA_DIR: dir,
      },
    });
    const values = secretValues(resolved, { ELEVENLABS_API_KEY: ELEVEN, REMOTION_LAMBDA_REGION: 'us-east-1' });
    expect(values).toEqual(expect.arrayContaining(['Pa55word-xyz', OTLP_TOKEN, 'QWxhZGRpbjpvcGVu', 'metrics-token-0123456789', ELEVEN]));
    expect(values).not.toContain('us-east-1'); // not a secret setting
    expect(parseOtlpHeaders('a=1, b = two%20words ,bad')).toEqual({ a: '1', b: 'two words' });
  });
});

describe('Prometheus metrics, JSON access logs and /readyz (default exporters)', () => {
  let s: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    s = await start();
    await renderSample(s.server);
  }, 120_000);
  afterAll(() => s?.server.close());

  it('OBS-03 access log: request id (given or generated, echoed), key id never the key, route template, status, duration; no query string', async () => {
    const given = await api(s.server, 'GET', '/v1/projects/sample-reel?version=1', { headers: { 'x-request-id': 'req-obs-03' } });
    expect(given.headers.get('x-request-id')).toBe('req-obs-03');
    const made = await api(s.server, 'GET', '/v1/projects/nope');
    expect(made.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const bad = await api(s.server, 'GET', '/v1/projects', { headers: { 'x-request-id': 'has spaces and "quotes"' } });
    expect(bad.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const rec = s.json().find((l) => l.request_id === 'req-obs-03');
    expect(rec).toMatchObject({ level: 'info', method: 'GET', route: '/v1/projects/:id', status: 200, msg: 'GET /v1/projects/:id 200' });
    expect(rec.key_id).toMatch(/^key_/);
    expect(typeof rec.duration_ms).toBe('number');
    expect(s.json().find((l) => l.request_id === made.headers.get('x-request-id'))).toMatchObject({ status: 404, route: '/v1/projects/:id' });
    expect(s.text()).not.toContain(BOOTSTRAP);
    expect(s.text()).not.toContain('version=1');
  });

  it('OBS-04 GET /metrics: valid Prometheus text with HTTP, job, render, queue, licence and build metrics', async () => {
    await api(s.server, 'GET', '/v1/projects');
    const r = await api(s.server, 'GET', '/metrics', { key: null });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
    const samples = parsePrometheus(r.text);
    const find = (name: string, labels: Record<string, string> = {}) => samples.filter((x) => x.name === name && Object.entries(labels).every(([k, v]) => x.labels[k] === v));
    expect(find('http_server_request_duration_seconds_count', { http_route: '/v1/projects', http_request_method: 'GET', http_response_status_code: '200' })[0]?.value).toBeGreaterThanOrEqual(1);
    expect(find('http_server_request_duration_seconds_bucket', { http_route: '/v1/projects', le: '+Inf' }).length).toBeGreaterThan(0);
    expect(find('reelforge_jobs_finished_total', { reelforge_job_type: 'render', reelforge_job_status: 'succeeded' })[0]?.value).toBe(1);
    expect(find('reelforge_job_duration_seconds_count', { reelforge_job_type: 'render' })[0]?.value).toBe(1);
    expect(find('reelforge_render_frames_total', { reelforge_engine: 'remotion' })[0]?.value).toBeGreaterThan(0);
    expect(find('reelforge_render_frames_total', { reelforge_engine: 'motion-canvas' })[0]?.value).toBeGreaterThan(0);
    expect(find('reelforge_render_scene_duration_seconds_count', { reelforge_engine: 'remotion', reelforge_outcome: 'ok' })[0]?.value).toBe(1);
    expect(find('reelforge_render_fps_count', { reelforge_engine: 'remotion' })[0]?.value).toBe(1);
    expect(find('reelforge_jobs_queued')[0]?.value).toBe(0);
    expect(find('reelforge_jobs_running')[0]?.value).toBe(0);
    expect(find('reelforge_jobs_concurrency')[0]?.value).toBe(1);
    expect(find('reelforge_licence_state').map((x) => x.labels.reelforge_licence_state).sort()).toEqual(['checking', 'grace', 'invalid', 'unlicensed', 'valid']);
    expect(find('reelforge_licence_state').reduce((a, x) => a + x.value, 0)).toBe(1);
    expect(find('reelforge_build_info', { reelforge_edition: 'dev' })[0]?.value).toBe(1);
    expect(find('target_info', { service_name: 'reelforge-studio' }).length).toBe(1);
  });

  it('OBS-05 bounded cardinality: routes are templates (unknown paths are "unmatched"), no ids or keys in any label', async () => {
    for (let i = 0; i < 20; i++) await api(s.server, 'GET', `/random-${i}-${Math.random()}`);
    for (let i = 0; i < 5; i++) await api(s.server, 'GET', `/v1/jobs/job_doesnotexist${i}`);
    const samples = parsePrometheus((await api(s.server, 'GET', '/metrics', { key: null })).text);
    const known = new Set([...REST_ROUTES.map((r) => r.path), ...INFRA_ROUTES.map((r) => r.split(' ')[1]!), 'unmatched']);
    const routes = new Set(samples.filter((x) => x.labels.http_route).map((x) => x.labels.http_route!));
    for (const r of routes) expect(known.has(r), `unexpected route label ${r}`).toBe(true);
    expect(routes.has('unmatched')).toBe(true);
    const allValues = samples.flatMap((x) => Object.values(x.labels));
    for (const v of allValues) expect(v).not.toMatch(/(^|[^a-z])(job|run|prv|key|ast)_[a-z0-9]{6,}|sample-reel|random-|rf_/);
    const series = new Set(samples.map((x) => `${x.name}${JSON.stringify(x.labels)}`));
    expect(series.size).toBeLessThan(800);
  });

  it('OBS-14 no secrets in metrics, logs or /readyz: API keys, provider key, secret key', async () => {
    await api(s.server, 'GET', '/v1/capabilities', { key: 'rf_wrongwrongwrongwrongwrong_obs' });
    const metrics = (await api(s.server, 'GET', '/metrics', { key: null })).text;
    const ready = (await api(s.server, 'GET', '/readyz', { key: null })).text;
    for (const secret of [BOOTSTRAP, ELEVEN, SECRET_KEY, 'rf_wrongwrongwrongwrongwrong_obs']) {
      expect(metrics).not.toContain(secret);
      expect(ready).not.toContain(secret);
      expect(s.text()).not.toContain(secret);
    }
  });

  it('OBS-06 /metrics bearer token and exporter "off", changed at runtime over the config API', async () => {
    const token = 'metrics-token-obs-0123456789';
    const up = await api(s.server, 'PATCH', '/v1/config', { body: { settings: { 'observability.metrics.bearerToken': token } } });
    expect(up.status).toBe(200);
    expect(JSON.stringify(up.body)).not.toContain(token);
    expect((await api(s.server, 'GET', '/metrics', { key: null })).status).toBe(401);
    expect((await api(s.server, 'GET', '/metrics', { key: 'metrics-token-obs-WRONG-456789' })).status).toBe(401);
    expect((await api(s.server, 'GET', '/metrics', { key: token })).status).toBe(200);
    expect(s.text()).not.toContain(token);
    await api(s.server, 'PATCH', '/v1/config', { body: { settings: { 'observability.metrics.exporter': 'off' } } });
    const off = await api(s.server, 'GET', '/metrics', { key: token });
    expect(off.status).toBe(404);
    expect(off.body.error.message).toMatch(/observability\.metrics\.exporter is "off"/);
    await api(s.server, 'PATCH', '/v1/config', { body: { settings: { 'observability.metrics.exporter': null, 'observability.metrics.bearerToken': null } } });
    expect((await api(s.server, 'GET', '/metrics', { key: null })).status).toBe(200);
  });

  it('OBS-15 /readyz reports database, storage, ffmpeg, browser and telemetry with status, required and latency', async () => {
    const r = await api(s.server, 'GET', '/readyz', { key: null });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.checks).toEqual({ dataDir: 'ok', database: 'ok', storage: 'ok', ffmpeg: 'ok' });
    const d = r.body.dependencies;
    expect(d.database).toMatchObject({ status: 'ok', required: true });
    expect(d.storage).toMatchObject({ status: 'ok', required: true, driver: 'local' });
    expect(d.storage.freeBytes).toBeGreaterThan(0);
    expect(d.ffmpeg).toMatchObject({ status: 'ok', required: true });
    expect(d.ffmpeg.version).toMatch(/ffmpeg version/);
    expect(d.browser.required).toBe(false);
    expect(['ok', 'not_configured', 'error']).toContain(d.browser.status);
    expect(d.telemetry).toMatchObject({ status: 'not_configured', required: false, logs: 'stdout', metrics: 'prometheus', tracing: 'off' });
    for (const k of ['database', 'storage', 'ffmpeg', 'browser']) expect(typeof d[k].latencyMs).toBe('number');
    expect(s.json().some((l) => l.route === '/readyz')).toBe(false); // probes log at debug, below the default level
  });

  it('routeOf: custom methods keep their literal name', () => {
    const c = { req: { matchedRoutes: [{ path: '/*' }, { path: '/v1/projects/:id/:method{scenes:reorder}' }] } } as never;
    expect(routeOf(c)).toBe('/v1/projects/:id/scenes:reorder');
  });
});

describe('OTLP export to a receiver (traces, logs, metrics)', () => {
  let rx: OtlpReceiver;
  let s: Awaited<ReturnType<typeof start>>;
  const parentTrace = '4bf92f3577b34da6a3ce929d0e0e4736';
  beforeAll(async () => {
    rx = await startOtlpReceiver();
    s = await start({
      REELFORGE_OTLP_ENDPOINT: rx.url,
      REELFORGE_OTLP_PROTOCOL: 'http/json',
      REELFORGE_OTLP_HEADERS: `x-honeycomb-team=${OTLP_TOKEN}`,
      REELFORGE_LOGS_EXPORTER: 'otlp',
      REELFORGE_METRICS_EXPORTER: 'otlp',
      REELFORGE_OTEL_SERVICE_NAME: 'studio-under-test',
    });
    await renderSample(s.server, { traceparent: `00-${parentTrace}-00f067aa0ba902b7-01` });
    await api(s.server, 'GET', '/v1/projects');
    // OBS-13: closing the server flushes the batched spans, log records and a last metrics push.
    await s.server.close();
  }, 120_000);
  afterAll(() => rx?.close());

  it('OBS-07 traces: HTTP → job → engine render → FFmpeg in one trace, continuing the caller\'s traceparent', () => {
    const spans = rx.spans();
    const byName = (name: string) => spans.filter((x) => x.name === name);
    const http = byName('POST /v1/projects/:id/renders')[0]!;
    expect(http).toBeDefined();
    expect(http.traceId).toBe(parentTrace);
    expect(http.parentSpanId).toBe('00f067aa0ba902b7');
    expect(http.attributes).toMatchObject({ 'http.route': '/v1/projects/:id/renders', 'http.response.status_code': 202, 'http.request.method': 'POST' });
    expect(String(http.attributes['reelforge.key_id'])).toMatch(/^key_/);
    const job = byName('job render')[0]!;
    expect(job.parentSpanId).toBe(http.spanId);
    expect(job.attributes['reelforge.job.status']).toBe('succeeded');
    const engines = spans.filter((x) => x.name.startsWith('engine.render '));
    expect(engines.map((e) => e.name).sort()).toEqual(['engine.render motion-canvas', 'engine.render remotion']);
    for (const e of engines) expect(e.parentSpanId).toBe(job.spanId);
    for (const name of ['ffprobe clip', 'ffmpeg assemble', 'ffprobe output', 'ffmpeg decode check', 'ffmpeg poster']) {
      const f = byName(name);
      expect(f.length, name).toBeGreaterThan(0);
      for (const x of f) expect(x.traceId).toBe(parentTrace);
    }
    expect(rx.resourceAttributes()).toMatchObject({ 'service.name': 'studio-under-test', 'service.version': '0.1.0', 'reelforge.edition': 'dev' });
  });

  it('OBS-08 logs over OTLP: records with severity, attributes and trace ids; still JSON on stdout', () => {
    const logs = rx.logs();
    const access = logs.find((l) => l.body === 'POST /v1/projects/:id/renders 202')!;
    expect(access).toBeDefined();
    expect(access.severityText).toBe('INFO');
    expect(access.attributes).toMatchObject({ route: '/v1/projects/:id/renders', status: 202 });
    expect(access.traceId).toBe(parentTrace);
    expect(s.json().some((l) => l.msg === 'POST /v1/projects/:id/renders 202' && l.trace_id === parentTrace)).toBe(true);
  });

  it('OBS-09 metrics pushed over OTLP (last push on shutdown)', () => {
    const names = rx.metricNames();
    expect(names).toEqual(expect.arrayContaining(['http.server.request.duration', 'reelforge.jobs.finished', 'reelforge.render.frames', 'reelforge.jobs.queued', 'reelforge.licence.state']));
  });

  it('OBS-14 OTLP: headers sent to the receiver, never logged; no secret in any exported payload', () => {
    expect(rx.requests.every((q) => q.headers['x-honeycomb-team'] === OTLP_TOKEN)).toBe(true);
    const payload = JSON.stringify(rx.requests.map((q) => q.body));
    for (const secret of [BOOTSTRAP, ELEVEN, SECRET_KEY, OTLP_TOKEN]) {
      expect(payload).not.toContain(secret);
      expect(s.text()).not.toContain(secret);
    }
  });
});

describe('runtime switching and failing receivers', () => {
  let rx: OtlpReceiver;
  let s: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    rx = await startOtlpReceiver();
    s = await start();
  }, 60_000);
  afterAll(async () => {
    await s?.server.close();
    await rx?.close();
  });

  it('OBS-10 tracing switched on and off at runtime with update_config (PATCH /v1/config)', async () => {
    const on = await api(s.server, 'PATCH', '/v1/config', {
      body: { settings: { 'observability.otlp.endpoint': rx.url, 'observability.otlp.protocol': 'http/json' } },
    });
    expect(on.status).toBe(200);
    // tracing.exporter defaults to "otlp" once an endpoint is set
    const cfg = await api(s.server, 'GET', '/v1/config?prefix=observability.tracing');
    expect(cfg.body.settings.find((x: any) => x.key === 'observability.tracing.exporter').value).toBe('otlp');
    await api(s.server, 'GET', '/v1/projects', { headers: { 'x-request-id': 'obs-10' } });
    await until(() => rx.spans().find((x) => x.attributes['reelforge.request_id'] === 'obs-10'), 'span after enabling tracing');
    await api(s.server, 'PATCH', '/v1/config', { body: { settings: { 'observability.tracing.exporter': 'off' } } });
    await new Promise((r) => setTimeout(r, 500));
    const before = rx.spans().length;
    await api(s.server, 'GET', '/v1/projects', { headers: { 'x-request-id': 'obs-10-off' } });
    await new Promise((r) => setTimeout(r, 3000));
    expect(rx.spans().length).toBe(before);
    expect(rx.spans().some((x) => x.attributes['reelforge.request_id'] === 'obs-10-off')).toBe(false);
  }, 30_000);

  it('OBS-11 receiver down: requests keep working; /readyz stays 200 and reports the failing export; one warning in the log', async () => {
    const port = await freePort();
    await api(s.server, 'PATCH', '/v1/config', {
      body: { settings: { 'observability.tracing.exporter': 'otlp', 'observability.otlp.endpoint': `http://127.0.0.1:${port}`, 'observability.otlp.timeoutSeconds': 2 } },
    });
    for (let i = 0; i < 5; i++) expect((await api(s.server, 'GET', '/v1/projects')).status).toBe(200);
    const ready = await until(async () => {
      const r = await api(s.server, 'GET', '/readyz', { key: null });
      return r.body.dependencies.telemetry.status === 'error' ? r : null;
    }, 'telemetry error in /readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.ok).toBe(true);
    expect(ready.body.dependencies.telemetry.otlp.traces).toMatchObject({ ok: false, endpoint: `http://127.0.0.1:${port}` });
    expect(ready.body.dependencies.telemetry.detail).toMatch(/OTLP traces export failing/);
    const warnings = s.json().filter((l) => l.level === 'warn' && /OTLP traces export to .* failed/.test(l.msg));
    expect(warnings.length).toBe(1); // rate-limited: at most one a minute
    for (let i = 0; i < 3; i++) await api(s.server, 'GET', '/v1/projects');
    expect((await api(s.server, 'GET', '/healthz', { key: null })).status).toBe(200);
  }, 40_000);

  it('OBS-12 timeouts and backoff: 503 is retried with backoff inside the timeout; a hanging receiver is cut off at the timeout', async () => {
    rx.mode = 'unavailable';
    rx.requests.length = 0;
    await api(s.server, 'PATCH', '/v1/config', { body: { settings: { 'observability.otlp.endpoint': rx.url, 'observability.otlp.timeoutSeconds': 4 } } });
    await api(s.server, 'GET', '/v1/projects', { headers: { 'x-request-id': 'obs-12' } });
    await until(() => rx.requests.filter((q) => q.path === '/v1/traces').length >= 2, 'a retried export', 15_000);
    const tries = rx.requests.filter((q) => q.path === '/v1/traces');
    const gap = tries[1]!.at - tries[0]!.at;
    expect(gap).toBeGreaterThanOrEqual(700); // first backoff ~1 s (±20 % jitter)
    await until(async () => (await api(s.server, 'GET', '/readyz', { key: null })).body.dependencies.telemetry.otlp?.traces?.ok === false, 'failure recorded', 15_000);

    rx.mode = 'hang';
    rx.requests.length = 0;
    await api(s.server, 'PATCH', '/v1/config', { body: { settings: { 'observability.otlp.timeoutSeconds': 1 } } });
    const t0 = Date.now();
    await api(s.server, 'GET', '/v1/projects', { headers: { 'x-request-id': 'obs-12-hang' } });
    expect(Date.now() - t0).toBeLessThan(1000); // the request never waits for telemetry
    await until(() => rx.requests.some((q) => q.path === '/v1/traces'), 'export attempt', 10_000);
    const sent = Date.now();
    await until(async () => {
      const t = (await api(s.server, 'GET', '/readyz', { key: null })).body.dependencies.telemetry.otlp?.traces;
      return t?.ok === false && Date.parse(t.lastErrorAt) >= sent - 100;
    }, 'timeout recorded', 10_000);
    expect(Date.now() - sent).toBeLessThan(6000);

    rx.mode = 'ok';
    await api(s.server, 'PATCH', '/v1/config', { body: { settings: { 'observability.otlp.timeoutSeconds': 5 } } });
    await api(s.server, 'GET', '/v1/projects');
    await until(async () => (await api(s.server, 'GET', '/readyz', { key: null })).body.dependencies.telemetry.status === 'ok', 'recovery', 15_000);
    expect(s.json().some((l) => /OTLP traces export to .* works again/.test(l.msg))).toBe(true);
  }, 60_000);
});

describe('exporter selected but not configured', () => {
  it('OBS-17 an OTLP exporter without an endpoint: the server starts and serves, the log says why nothing is exported, /readyz says not_configured', async () => {
    const s = await start({ REELFORGE_LOGS_EXPORTER: 'otlp', REELFORGE_METRICS_EXPORTER: 'otlp' });
    try {
      expect((await api(s.server, 'GET', '/v1/projects')).status).toBe(200);
      expect(s.json().some((l) => l.level === 'warn' && /observability\.logs\.exporter, observability\.metrics\.exporter are "otlp" but observability\.otlp\.endpoint is not set/.test(l.msg))).toBe(true);
      const r = await api(s.server, 'GET', '/readyz', { key: null });
      expect(r.status).toBe(200);
      expect(r.body.dependencies.telemetry).toMatchObject({ status: 'not_configured', logs: 'otlp', metrics: 'otlp' });
      expect((await api(s.server, 'GET', '/metrics', { key: null })).status).toBe(404);
    } finally {
      await s.server.close();
    }
  }, 60_000);
});

describe('settings (config schema)', () => {
  const base = { REELFORGE_DATA_DIR: dir };
  it('OBS-16 defaults, env names, OTEL_* aliases and computed defaults', () => {
    const d = resolveConfig({ env: base }).config.observability;
    expect(d).toMatchObject({ serviceName: 'reelforge-studio', logs: { exporter: 'stdout' }, metrics: { exporter: 'prometheus', exportIntervalSeconds: 60 }, tracing: { exporter: 'off', sampleRatio: 1 }, otlp: { protocol: 'http/protobuf', timeoutSeconds: 10 } });
    const o = resolveConfig({ env: { ...base, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/', OTEL_SERVICE_NAME: 'studio-a', REELFORGE_TRACING_SAMPLE_RATIO: '0.25' } }).config.observability;
    expect(o.otlp.endpoint).toBe('http://collector:4318');
    expect(o.tracing).toEqual({ exporter: 'otlp', sampleRatio: 0.25 });
    expect(o.serviceName).toBe('studio-a');
    expect(resolveConfig({ env: { ...base, REELFORGE_LOG_FORMAT: 'text' } }).config.observability.logs.exporter).toBe('pretty');
    expect(resolveConfig({ env: { ...base, REELFORGE_LOG_FORMAT: 'text', REELFORGE_LOGS_EXPORTER: 'stdout' } }).config.observability.logs.exporter).toBe('stdout');
  });

  it('OBS-16 invalid values are refused with the variable name and no secret', () => {
    const bad = (env: NodeJS.ProcessEnv) => {
      try {
        resolveConfig({ env: { ...base, ...env } });
      } catch (e) {
        return (e as ConfigError).message;
      }
      throw new Error('accepted');
    };
    expect(bad({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })).toMatch(/OTEL_EXPORTER_OTLP_PROTOCOL/);
    expect(bad({ REELFORGE_TRACING_SAMPLE_RATIO: '2' })).toMatch(/REELFORGE_TRACING_SAMPLE_RATIO/);
    expect(bad({ REELFORGE_TRACING_SAMPLE_RATIO: 'half' })).toMatch(/must be a number/);
    const m = bad({ REELFORGE_OTLP_HEADERS: 'no-equals-sign-secretvalue' });
    expect(m).toMatch(/REELFORGE_OTLP_HEADERS/);
    expect(m).not.toContain('secretvalue');
    expect(bad({ REELFORGE_METRICS_TOKEN: 'short' })).toMatch(/at least 16/);
  });
});
