/**
 * Overload protection over REST and MCP (issue #155, D-103): the priority argument and its per-key maximum,
 * admission by estimated wait (429 queue_full with Retry-After and details), get_capabilities, and the queue-wait
 * histogram with bounded labels plus the Grafana panel and alert rules that use it. Runs on the database of
 * REELFORGE_TEST_DB (SQLite by default). Test ids PRS-nn (docs/providers/queue-and-scaling.md).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@reelforge/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { parsePrometheus } from './otlpReceiver';
import { testDatabase } from './serverProcess';

const { dir, cleanup } = tempDir('reelforge-priority-server-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const repoFile = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
let server: StartedServer;
let admin: string;
let agent: string;
let dropDb: () => Promise<void> = async () => undefined;

async function api(method: string, path: string, key: string | null, body?: unknown) {
  const r = await fetch(`${server.url}${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: r.status, headers: r.headers, json, text };
}
async function mcp(key: string) {
  const client = new Client({ name: 'reelforge-priority-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}
const toolError = (r: any) => {
  expect(r.isError).toBe(true);
  return JSON.parse(r.content[0].text).error;
};
const toolJson = (r: any) => {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text);
};
const cancelAll = async () => {
  for (const j of (await server.service.listJobs({}, { limit: 200 })).jobs) if (j.status === 'queued' || j.status === 'running') await server.service.cancelJob(j.id);
  await server.service.jobs.idle();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion', { delayPerFrameMs: 30 })).registerEngine(fakeEngine('motion-canvas', { delayPerFrameMs: 30 }));
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    { registry, env: { ...database.env, REELFORGE_LICENCE_MODE: 'off', REELFORGE_METRICS_ALLOW_ANONYMOUS: 'true' }, quiet: true }
  );
  admin = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
  agent = (await server.service.keys.create('agent', ['read', 'write', 'render'])).key;
  expect((await api('POST', '/v1/projects', agent, sample)).status).toBe(201);
}, 120_000);
afterAll(async () => {
  await cancelAll().catch(() => undefined);
  await server?.close();
  await dropDb();
  cleanup();
});

describe('priorities and admission over REST and MCP', () => {
  it('PRS-01 priority: defaults per type, lowering allowed, escalation refused with 403 priority_not_allowed on REST and MCP until an admin sets maxPriority', async () => {
    try {
      const prev = await api('POST', '/v1/projects/sample-reel/preview', agent, { sceneId: 'hook' });
      expect(prev.status).toBe(202);
      expect(prev.json.job.priority).toBe('interactive');
      const batch = await api('POST', '/v1/projects/sample-reel/renders', agent, { priority: 'batch' });
      expect(batch.json.job.priority).toBe('batch');
      expect((await api('GET', `/v1/jobs/${batch.json.job.id}`, agent)).json.priority).toBe('batch');
      const up = await api('POST', '/v1/projects/sample-reel/renders', agent, { priority: 'interactive' });
      expect(up.status).toBe(403);
      expect(up.json.error).toMatchObject({ code: 'priority_not_allowed', details: { requested: 'interactive', maxPriority: 'standard' } });
      const client = await mcp(agent);
      try {
        expect(toolError(await client.callTool({ name: 'render_project', arguments: { projectId: 'sample-reel', priority: 'interactive' } }))).toMatchObject({ code: 'priority_not_allowed' });
        expect(toolJson(await client.callTool({ name: 'render_project', arguments: { projectId: 'sample-reel', priority: 'batch' } })).job.priority).toBe('batch');
      } finally {
        await client.close();
      }
      // An admin allows a key to render at interactive priority.
      const vip = await api('POST', '/v1/keys', admin, { name: 'vip', scopes: ['read', 'render'], maxPriority: 'interactive' });
      expect(vip.status).toBe(201);
      expect(vip.json.record.maxPriority).toBe('interactive');
      expect((await api('POST', '/v1/projects/sample-reel/renders', vip.json.key, { priority: 'interactive' })).json.job.priority).toBe('interactive');
      // A non-admin key cannot raise its own maximum.
      expect((await api('PATCH', `/v1/keys/${vip.json.record.id}`, agent, { maxPriority: 'interactive' })).status).toBe(403);
      expect((await api('PATCH', `/v1/keys/${vip.json.record.id}`, admin, { maxPriority: null })).json.maxPriority).toBeUndefined();
      expect((await api('POST', '/v1/projects/sample-reel/renders', vip.json.key, { priority: 'interactive' })).status).toBe(403);
      expect((await api('POST', '/v1/keys', admin, { name: 'bad', maxPriority: 'urgent' })).status).toBe(400);
    } finally {
      await cancelAll();
    }
  });

  it('PRS-02 admission: 429 queue_full with Retry-After and details when the estimated wait exceeds limits.maxEstimatedWaitSeconds; previews ahead of the backlog still start; get_capabilities reports it', async () => {
    expect((await api('PATCH', '/v1/config', admin, { settings: { 'limits.maxEstimatedWaitSeconds': 1 } })).status).toBe(200);
    try {
      const caps = await api('GET', '/v1/capabilities', agent);
      expect(caps.json.limits.jobs.maxEstimatedWaitSeconds).toBe(1);
      expect(caps.json.limits.priority).toMatchObject({ classes: ['interactive', 'standard', 'batch'], maxForThisKey: { render: 'standard', preview: 'interactive' } });
      expect((await api('POST', '/v1/projects/sample-reel/renders', agent, {})).status).toBe(202); // runs (one slot)
      expect((await api('POST', '/v1/projects/sample-reel/renders', agent, {})).status).toBe(202); // waits
      await sleep(1600); // the queued render has now waited longer than the limit, with at most one claim measured
      const r = await api('POST', '/v1/projects/sample-reel/renders', agent, {});
      expect(r.status).toBe(429);
      expect(r.headers.get('retry-after')).toBe('30');
      expect(r.json.error).toMatchObject({
        code: 'queue_full',
        details: { limit: 'limits.maxEstimatedWaitSeconds', max: 1, priority: 'standard', queued: { ahead: 1 }, retryAfterSeconds: 30 },
      });
      expect(r.json.error.details.estimatedWaitSeconds).toBeGreaterThan(1);
      const client = await mcp(agent);
      try {
        expect(toolError(await client.callTool({ name: 'render_project', arguments: { projectId: 'sample-reel' } }))).toMatchObject({ code: 'queue_full', details: { limit: 'limits.maxEstimatedWaitSeconds' } });
        const mcpCaps = toolJson(await client.callTool({ name: 'get_capabilities', arguments: {} }));
        expect(mcpCaps.limits.jobs.maxEstimatedWaitSeconds).toBe(1);
      } finally {
        await client.close();
      }
      // No interactive job is waiting: a preview is admitted (and claimed before the queued render).
      const prev = await api('POST', '/v1/projects/sample-reel/preview', agent, { sceneId: 'hook' });
      expect(prev.status).toBe(202);
      expect((await api('GET', `/v1/jobs/${prev.json.job.id}`, agent)).json.queuePosition).toBe(0);
    } finally {
      await api('PATCH', '/v1/config', admin, { settings: { 'limits.maxEstimatedWaitSeconds': null } });
      await cancelAll();
    }
  }, 60_000);

  it('PRS-03 reelforge_job_queue_wait_seconds: recorded per claim with job type and priority as its only labels; the Grafana panel and alert rules use it', async () => {
    const r = await api('POST', '/v1/projects/sample-reel/preview', agent, { sceneId: 'hook' });
    expect((await api('GET', `/v1/jobs/${r.json.job.id}?wait=50`, agent)).json.status).toBe('succeeded');
    const text = (await api('GET', '/metrics', null)).text;
    const samples = parsePrometheus(text).filter((s) => s.name.startsWith('reelforge_job_queue_wait_seconds'));
    expect(samples.length).toBeGreaterThan(0);
    expect(text).toMatch(/# TYPE reelforge_job_queue_wait_seconds histogram/);
    const count = samples.find((s) => s.name === 'reelforge_job_queue_wait_seconds_count' && s.labels.reelforge_job_type === 'preview' && s.labels.reelforge_job_priority === 'interactive');
    expect(count?.value).toBeGreaterThanOrEqual(1);
    // Bounded: no ids, keys, projects or workers; only these label names and values (each with its renderweld_* twin, #412).
    const fresh = parsePrometheus(text).filter((s) => s.name.startsWith('renderweld_job_queue_wait_seconds'));
    expect(fresh.length).toBe(samples.length);
    for (const s of [...samples, ...fresh]) {
      const names = Object.keys(s.labels).filter((l) => !l.startsWith('otel_scope_'));
      const labels = ['reelforge_job_priority', 'reelforge_job_type', 'renderweld_job_priority', 'renderweld_job_type'];
      expect(names.sort()).toEqual((s.name.endsWith('_bucket') ? ['le', ...labels] : labels).sort());
      expect(['render', 'preview']).toContain(s.labels.reelforge_job_type);
      expect(['interactive', 'standard', 'batch']).toContain(s.labels.reelforge_job_priority);
      expect(s.labels.renderweld_job_type).toBe(s.labels.reelforge_job_type);
      expect(s.labels.renderweld_job_priority).toBe(s.labels.reelforge_job_priority);
    }
    // The SLO thresholds are bucket boundaries, so the alert's quantiles are exact at them.
    const les = new Set(samples.filter((s) => s.name.endsWith('_bucket')).map((s) => s.labels.le));
    expect(les.has('60')).toBe(true);
    expect(les.has('300')).toBe(true);
    // deployment/observability: the panel and the alerts query this histogram by its labels.
    const dash = JSON.parse(repoFile('deployment/observability/grafana-dashboard.json'));
    const panel = dash.panels.find((p: any) => /queue wait/i.test(p.title));
    expect(panel.targets.map((t: any) => t.expr).join('\n')).toMatch(/renderweld_job_queue_wait_seconds_bucket.*renderweld_job_type.*renderweld_job_priority/s);
    const alerts = repoFile('deployment/observability/alerts.yml');
    expect(alerts).toMatch(/renderweld_job_queue_wait_seconds_bucket\{[^}]*renderweld_job_type="preview"[^}]*\}[\s\S]*> 60/);
    expect(alerts).toMatch(/renderweld_job_queue_wait_seconds_bucket\{[^}]*renderweld_job_type="render"[^}]*\}[\s\S]*> 300/);
    // The dashboard and the alert rules use the new metric names only (#412; the old ones are still served).
    expect(repoFile('deployment/observability/grafana-dashboard.json')).not.toMatch(/reelforge_/);
    expect(alerts).not.toMatch(/reelforge_/);
  }, 60_000);
});
