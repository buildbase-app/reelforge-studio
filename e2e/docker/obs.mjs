// Observability over MCP and against a real OpenTelemetry Collector (issue #64), from a separate container:
//   PHASE=on            update_config: OTLP endpoint (the collector), tracing and logs over OTLP; preview a scene
//   PHASE=check         the collector received the trace HTTP → job → engine render → FFmpeg, the log records, and scraped /metrics
//   PHASE=metrics-otlp  update_config: metrics pushed over OTLP instead of /metrics
//   PHASE=down          (collector stopped) the studio keeps serving; /readyz reports the failing export; settings reset
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const URL_ = process.env.URL, KEY = process.env.KEY, PHASE = process.env.PHASE, EDITION = process.env.EDITION ?? 'dev';
const BASE = new URL(URL_).origin;
const t = new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } });
const c = new Client({ name: 'e2e-observability', version: '1' }); await c.connect(t);
let fail = 0;
const check = (name, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? '✔' : '✘'} ${name}${extra ? `: ${extra}` : ''}`); };
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const txt = r.content.map((x) => x.text ?? '').join('');
  if (r.isError) throw new Error(`${name} failed: ${txt.slice(0, 600)}`);
  try { return JSON.parse(txt); } catch { return txt; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60_000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(1000); } };
const readyz = async () => (await fetch(`${BASE}/readyz`)).json();
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const attrs = (list = []) => Object.fromEntries(list.map((a) => [a.key, a.value?.stringValue ?? (a.value?.intValue !== undefined ? Number(a.value.intValue) : a.value?.boolValue ?? a.value?.doubleValue)]));
const spans = () => lines('/otel/traces.jsonl').flatMap((r) => r.resourceSpans ?? []).flatMap((rs) => (rs.scopeSpans ?? []).flatMap((ss) => (ss.spans ?? []).map((s) => ({ ...s, attributes: attrs(s.attributes), resource: attrs(rs.resource?.attributes) }))));
const logs = () => lines('/otel/logs.jsonl').flatMap((r) => r.resourceLogs ?? []).flatMap((rl) => rl.scopeLogs ?? []).flatMap((sl) => sl.logRecords ?? []).map((l) => ({ ...l, body: l.body?.stringValue ?? '', attributes: attrs(l.attributes) }));
const metricNames = () => new Set(lines('/otel/metrics.jsonl').flatMap((r) => r.resourceMetrics ?? []).flatMap((rm) => rm.scopeMetrics ?? []).flatMap((sm) => sm.metrics ?? []).map((m) => m.name));

if (PHASE === 'on') {
  const up = await call('update_config', { settings: { 'observability.otlp.endpoint': 'http://otel:4318', 'observability.tracing.exporter': 'otlp', 'observability.logs.exporter': 'otlp' } });
  check('update_config selects OTLP for traces and logs at runtime (no restart)', up.settings.every((s) => s.source === 'runtime'), up.changes.map((x) => `${x.key}=${JSON.stringify(x.to)}`).join(', '));
  const cfg = await call('get_config', { prefix: 'observability' });
  const get = (k) => cfg.settings.find((s) => s.key === k);
  check('get_config: metrics stay on Prometheus, OTLP protocol http/protobuf', get('observability.metrics.exporter').value === 'prometheus' && get('observability.otlp.protocol').value === 'http/protobuf');
  const m = JSON.parse(readFileSync(process.env.SAMPLE, 'utf8')); m.projectId = 'obs-e2e-' + Date.now().toString(36);
  await call('create_project', { manifest: m });
  await call('add_scene', { projectId: m.projectId, scene: { id: 'html', engine: 'html', template: 'html-title', durationFrames: 30, props: { headline: 'Traced', subline: 'OTLP' } } });
  const job = await call('preview_scene', { projectId: m.projectId, sceneId: 'html' });
  const jobId = job.jobId ?? job.job?.id ?? job.id;
  let j; for (;;) { j = await call('get_job', { jobId, waitSeconds: 45 }); if (['succeeded', 'failed', 'cancelled'].includes(j.status)) break; }
  check('preview_scene job succeeded', j.status === 'succeeded', jobId);
  writeFileSync('/out/obs.json', JSON.stringify({ jobId, projectId: m.projectId }));
} else if (PHASE === 'check') {
  const { jobId } = JSON.parse(readFileSync('/out/obs.json', 'utf8'));
  const found = await until(() => { const s = spans(); const job = s.find((x) => x.name === 'job preview' && x.attributes['reelforge.job.id'] === jobId); return job && s.some((x) => x.name === 'ffmpeg poster' && x.traceId === job.traceId) ? { s, job } : null; });
  check('the collector received the job span and its FFmpeg spans', Boolean(found));
  if (found) {
    const { s, job } = found;
    const parent = s.find((x) => x.spanId === job.parentSpanId);
    check('job span → parent is the HTTP span of the MCP request', parent?.name === 'POST /mcp' && parent.attributes['http.route'] === '/mcp' && parent.kind === 2, `${parent?.name} kind=${parent?.kind}`);
    check('HTTP span has request id, key id (not the key) and status 200', /^key_|^bootstrap/.test(String(parent?.attributes['reelforge.key_id'])) && parent?.attributes['http.response.status_code'] === 200 && Boolean(parent?.attributes['reelforge.request_id']));
    const engine = s.find((x) => x.name === 'engine.render html' && x.traceId === job.traceId);
    check('engine.render html is a child of the job span', engine?.parentSpanId === job.spanId, JSON.stringify(engine?.attributes ?? {}).slice(0, 200));
    const ff = ['ffprobe clip', 'ffmpeg assemble', 'ffprobe output', 'ffmpeg decode check', 'ffmpeg poster'].map((n) => [n, s.find((x) => x.name === n && x.traceId === job.traceId)]);
    check('FFmpeg steps are spans in the same trace', ff.every(([, x]) => x?.parentSpanId === job.spanId), ff.map(([n, x]) => `${n}:${x ? 'ok' : 'missing'}`).join(', '));
    check('resource attributes: service.name, service.version, edition', job.resource['service.name'] === 'reelforge-studio' && Boolean(job.resource['service.version']) && job.resource['reelforge.edition'] === EDITION, JSON.stringify(job.resource));
    console.log(`   trace ${job.traceId}: ${s.filter((x) => x.traceId === job.traceId).length} spans`);
  }
  const logOk = await until(() => logs().find((l) => l.body === 'POST /mcp 200' && l.attributes.route === '/mcp' && l.attributes.request_id));
  check('the collector received OTLP log records (access log with request id, route, status, trace id)', Boolean(logOk && logOk.traceId), logOk ? JSON.stringify({ body: logOk.body, severity: logOk.severityText, key_id: logOk.attributes.key_id, trace: logOk.traceId }) : '');
  const scraped = await until(() => { const n = metricNames(); return [...n].some((x) => x.startsWith('http_server_request_duration')) && [...n].some((x) => x.startsWith('reelforge_jobs_finished')) ? n : null; });
  check('the collector\'s Prometheus receiver scraped /metrics (http_server_request_duration*, reelforge_jobs_finished*)', Boolean(scraped), scraped ? [...scraped].filter((x) => /^(http_|reelforge_)/.test(x)).slice(0, 8).join(', ') : '');
  const all = ['traces', 'logs', 'metrics'].map((f) => existsSync(`/otel/${f}.jsonl`) ? readFileSync(`/otel/${f}.jsonl`, 'utf8') : '').join('');
  check('no API key in anything the collector received', !all.includes(KEY), `${all.length} bytes`);
  const r = await readyz();
  check('/readyz: telemetry ok (traces and logs exported)', r.dependencies?.telemetry?.status === 'ok' && r.dependencies.telemetry.otlp?.traces?.ok === true, JSON.stringify(r.dependencies?.telemetry?.otlp ?? {}).slice(0, 300));
} else if (PHASE === 'metrics-otlp') {
  await call('update_config', { settings: { 'observability.metrics.exporter': 'otlp', 'observability.metrics.exportIntervalSeconds': 5 } });
  const m = await fetch(`${BASE}/metrics`);
  check('/metrics answers 404 once metrics are pushed over OTLP', m.status === 404);
  await call('list_projects');
  const pushed = await until(() => { const n = metricNames(); return n.has('reelforge.jobs.finished') && n.has('http.server.request.duration') ? n : null; });
  check('the collector received OTLP metrics (reelforge.jobs.finished, http.server.request.duration, reelforge.licence.state)', Boolean(pushed?.has('reelforge.licence.state')), pushed ? [...pushed].filter((x) => x.includes('.')).join(', ') : '');
} else if (PHASE === 'down') {
  let ok = 0; for (let i = 0; i < 5; i++) { await call('list_projects'); ok++; }
  check('with the collector stopped, MCP calls keep working', ok === 5);
  const r = await until(async () => { const x = await readyz(); return x.dependencies?.telemetry?.status === 'error' ? x : null; }, 60_000);
  check('/readyz stays ok (200) and reports the failing OTLP export', Boolean(r?.ok) && r.dependencies.telemetry.required === false, r ? r.dependencies.telemetry.detail?.slice(0, 200) : 'no error reported');
  const reset = Object.fromEntries(['observability.otlp.endpoint', 'observability.tracing.exporter', 'observability.logs.exporter', 'observability.metrics.exporter', 'observability.metrics.exportIntervalSeconds'].map((k) => [k, null]));
  await call('update_config', { settings: reset });
  const after = await readyz();
  check('settings reset over MCP: telemetry not_configured, /metrics back', after.dependencies.telemetry.status === 'not_configured' && (await fetch(`${BASE}/metrics`)).status === 200);
}
await c.close();
process.exit(fail ? 1 : 0);
