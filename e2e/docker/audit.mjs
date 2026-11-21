// Enterprise E2 (#65) from a separate container, as an agent over MCP (plus a few REST checks):
//   key with an expiry -> rotate -> the old key works inside the grace window -> revoke -> both refused;
//   IP allowlist allow/deny, per-key rate limit, render quota; the audit trail read back over MCP with no
//   secret in it (page, JSONL and CSV exports); a render repeated with the same idempotency key starts one
//   job, a different body is refused; a broken OTLP sink never fails a request.
// Writes /out/audit.json for run.sh (ids to look for in the sinks and the database).
import { readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const URL_ = process.env.URL, KEY = process.env.KEY, BASE = new URL(URL_).origin;
let fail = 0;
const check = (name, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? '✔' : '✘'} ${name}${extra ? `: ${extra}` : ''}`); };
async function connect(key, ua = 'e2e-audit-agent/1.0') {
  const c = new Client({ name: 'e2e-audit', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${key}`, 'User-Agent': ua } } }));
  const raw = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const t = r.content.map((x) => x.text ?? '').join(''); return r.isError ? { error: JSON.parse(t).error } : JSON.parse(t); };
  return { raw, tools: async () => (await c.listTools()).tools.map((t) => t.name), close: () => c.close() };
}
const refused = async (key) => { try { const m = await connect(key); await m.raw('list_projects'); await m.close(); return false; } catch { return true; } };
const rest = (path, key, init = {}) => fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
const RF = /rf_[A-Za-z0-9_-]{20,}/;

const admin = await connect(KEY);
const secrets = [KEY];

// ---- KEY-01/02/03: expiry, rotation grace, revoke ----------------------------------
const created = await admin.raw('create_key', { name: 'e2e-rotating-agent', scopes: ['read', 'write', 'render'], expiresInDays: 1 });
secrets.push(created.key);
const exp = Date.parse(created.record.expiresAt) - Date.now();
check('create_key with an expiry (expiresInDays: 1); the key is shown once', created.record.status === 'active' && exp > 23 * 3600e3 && exp <= 24 * 3600e3 && RF.test(created.key), created.record.expiresAt);
const agent = await connect(created.key);
check('the new key works over MCP', Array.isArray((await agent.raw('list_projects')).projects));
await agent.close();
const rotated = await admin.raw('rotate_key', { keyId: created.record.id, graceHours: 1 });
secrets.push(rotated.key);
check('rotate_key: a new secret, same id, the old secret valid for 1 h', rotated.key !== created.key && rotated.record.id === created.record.id && !!rotated.record.previousSecretExpiresAt, rotated.record.previousSecretExpiresAt);
const old = await connect(created.key);
check('the OLD key still works inside the grace window (MCP)', Array.isArray((await old.raw('list_projects')).projects));
await old.close();
check('the old key works over REST too', (await rest('/v1/projects', created.key)).status === 200);
check('the new key works', !(await refused(rotated.key)));
const revoked = await admin.raw('revoke_key', { keyId: created.record.id });
check('revoke_key: status revoked', revoked.status === 'revoked');
check('after revoke both the old and the new secret are refused', (await refused(created.key)) && (await refused(rotated.key)));
const r401 = await rest('/v1/projects', rotated.key);
check('REST says why: 401 key_revoked', r401.status === 401 && (await r401.json()).error.code === 'key_revoked');
check('a revoked key cannot be rotated', (await admin.raw('rotate_key', { keyId: created.record.id })).error?.code === 'key_revoked');

// ---- KEY-04/06/07: IP allowlist, rate limit, render quota ---------------------------
const myIps = Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => `${i.address}/32`);
const allow = await admin.raw('create_key', { name: 'e2e-ip-allowed', scopes: ['read'], ipAllowlist: myIps });
const deny = await admin.raw('create_key', { name: 'e2e-ip-denied', scopes: ['read'], ipAllowlist: ['203.0.113.0/24'] });
secrets.push(allow.key, deny.key);
check(`IP allowlist ${myIps.join(',')}: allowed from this container`, !(await refused(allow.key)));
const d = await rest('/v1/projects', deny.key);
check('IP allowlist 203.0.113.0/24: refused with 403 ip_not_allowed (REST), MCP refused', d.status === 403 && (await d.json()).error.code === 'ip_not_allowed' && (await refused(deny.key)));
const slow = await admin.raw('create_key', { name: 'e2e-rate', scopes: ['read'], rateLimitPerMinute: 2 });
secrets.push(slow.key);
const codes = []; for (let i = 0; i < 3; i++) codes.push((await rest('/v1/projects', slow.key)).status);
check('per-key rate limit 2/min: the third request is 429', codes.join(',') === '200,200,429', codes.join(','));
const quota = await admin.raw('create_key', { name: 'e2e-quota', scopes: ['read', 'write', 'render'], rendersPerDay: 0 });
secrets.push(quota.key);

// ---- IDM-01/02/03: idempotent create and render ------------------------------------
const m = JSON.parse(readFileSync(process.env.SAMPLE ?? 'sample-reel.json', 'utf8'));
m.projectId = 'e2e-idem-' + Date.now().toString(36); m.title = 'Idempotent';
const idem = `idem-${Date.now().toString(36)}`;
const p1 = await admin.raw('create_project', { manifest: m, idempotencyKey: `${idem}-create` });
const p2 = await admin.raw('create_project', { manifest: m, idempotencyKey: `${idem}-create` });
check('create_project twice with the same idempotencyKey: the stored response, one project', p1.meta?.id === m.projectId && JSON.stringify(p2.meta) === JSON.stringify(p1.meta));
const q = await connect(quota.key);
const qr = await q.raw('render_project', { projectId: m.projectId });
await q.close();
check('render quota 0/day: render_project refused with quota_exceeded', qr.error?.code === 'quota_exceeded', qr.error?.message);
const j1 = await admin.raw('render_project', { projectId: m.projectId, idempotencyKey: `${idem}-render` });
const j2 = await admin.raw('render_project', { projectId: m.projectId, idempotencyKey: `${idem}-render` });
const jobs = (await admin.raw('list_jobs', { projectId: m.projectId })).jobs;
check('render_project repeated with the same idempotencyKey: one job only', j1.job?.id && j2.job?.id === j1.job.id && jobs.length === 1, `job ${j1.job?.id}, ${jobs.length} job(s)`);
const conflict = await admin.raw('render_project', { projectId: m.projectId, backend: 'local', idempotencyKey: `${idem}-render` });
check('same key with different arguments: idempotency_conflict', conflict.error?.code === 'idempotency_conflict');
const rr = await rest(`/v1/projects/${m.projectId}/renders`, KEY, { method: 'POST', body: '{}', headers: { 'Idempotency-Key': `${idem}-render` } });
check('REST with the same Idempotency-Key: the same job, Idempotent-Replayed: true', rr.status === 202 && (await rr.json()).job.id === j1.job.id && rr.headers.get('idempotent-replayed') === 'true');
for (;;) { const j = await admin.raw('get_job', { jobId: j1.job.id, waitSeconds: 45 }); if (['succeeded', 'failed', 'cancelled'].includes(j.status)) { check('the one render finished', j.status === 'succeeded', j.status); break; } }

// ---- SNK-04: a failing sink never fails a request ----------------------------------
await admin.raw('update_config', { settings: { 'audit.otlpEndpoint': 'http://otel-down.invalid:4318/v1/logs' } });
const t0 = Date.now();
const during = await admin.raw('create_theme', { id: 'e2e-sink-down', name: 'Sink down', tokens: { colors: { background: '#000000', surface: '#111111', text: '#ffffff', mutedText: '#aaaaaa', accent: '#ff8800', accent2: '#00aaff' }, fontFamily: 'Inter, sans-serif' } });
check('with the OTLP collector unreachable, a write still succeeds at once', during.id === 'e2e-sink-down' && Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
await new Promise((r) => setTimeout(r, 1500));
await admin.raw('update_config', { settings: { 'audit.otlpEndpoint': 'http://otel:4318/v1/logs' } });

// ---- AUD: the audit trail over MCP ------------------------------------------------
const trail = (await admin.raw('list_audit_events', { targetId: created.record.id, limit: 100 })).events;
const actions = trail.map((e) => e.action);
check('list_audit_events shows the key lifecycle: create, rotate, revoke, denied uses', ['key.create', 'key.rotate', 'key.revoke', 'auth.denied'].every((a) => actions.includes(a)), [...new Set(actions)].join(', '));
const rot = trail.find((e) => e.action === 'key.rotate' && e.result === 'success');
const rotFail = trail.find((e) => e.action === 'key.rotate' && e.result === 'failure');
check('the refused rotation of the revoked key is recorded as a failure with its error code', rotFail?.data?.error === 'key_revoked');
check('entries carry actor key id and name, result, client IP, user agent, request id, UTC time', !!(rot && rot.actorId && rot.actorName && rot.result === 'success' && rot.ip && rot.userAgent && /^req_/.test(rot.requestId) && rot.at.endsWith('Z')), JSON.stringify({ actorName: rot?.actorName, ip: rot?.ip, userAgent: rot?.userAgent, requestId: rot?.requestId, at: rot?.at }));
const deniedUse = trail.find((e) => e.action === 'auth.denied');
check('a refused use of the revoked key is recorded as denied', deniedUse?.result === 'denied' && deniedUse.data?.reason === 'revoked');
const createE = (await admin.raw('list_audit_events', { action: 'project.create', targetId: m.projectId })).events;
check('the replayed create is recorded as a replay', createE.length === 2 && createE.some((e) => e.data?.idempotentReplay === true));
check('filters: action prefix "key.*" and result "denied"', (await admin.raw('list_audit_events', { action: 'key.*' })).events.every((e) => e.action.startsWith('key.')) && (await admin.raw('list_audit_events', { result: 'denied' })).events.every((e) => e.result === 'denied'));
const jsonl = (await admin.raw('list_audit_events', { format: 'jsonl' })).content;
const csv = (await admin.raw('list_audit_events', { format: 'csv' })).content;
const page = JSON.stringify(await admin.raw('list_audit_events', { limit: 1000 }));
const restExport = await (await rest('/v1/audit?format=jsonl', KEY)).text();
check('exports: JSONL lines parse, CSV has the header', jsonl.trim().split('\n').every((l) => JSON.parse(l).id) && csv.startsWith('id,at,actorType,actorId,actorName,action'));
const leaked = secrets.filter((s) => [jsonl, csv, page, restExport].some((h) => h.includes(s)));
check(`no API key secret (${secrets.length} checked) or rf_ key material anywhere in the audit trail or its exports`, leaked.length === 0 && ![jsonl, csv, page, restExport].some((h) => RF.test(h)));
const auditTools = (await admin.tools()).filter((n) => /audit/.test(n));
check('append-only: the only audit tool is list_audit_events (no update or delete)', auditTools.join() === 'list_audit_events', auditTools.join());
const del = await rest('/v1/audit', KEY, { method: 'DELETE' });
check('append-only: DELETE /v1/audit does not exist (404)', del.status === 404);
await admin.close();
writeFileSync('/out/audit.json', JSON.stringify({ keyId: created.record.id, projectId: m.projectId, jobId: j1.job?.id, secrets }));
process.exit(fail ? 1 : 0);
