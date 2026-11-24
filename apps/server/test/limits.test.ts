/**
 * Resource limits over REST and MCP (issue #107, D-090, D-091): the same
 * refusal, code and details on both transports, Retry-After on REST, streamed
 * multipart uploads that stop at the byte cap, and the rejection metric.
 * Test ids LIMS-nn (docs/security/HARDENING.md).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PluginRegistry, type ProviderPlugin } from '@reelforge/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { parsePrometheus } from './otlpReceiver';
import { testDatabase } from './serverProcess';

const { dir, cleanup } = tempDir('reelforge-limits-server-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let server: StartedServer;
let admin: string;
let agentA: string;
let agentB: string;
let dropDb: () => Promise<void> = async () => undefined;

const paid: ProviderPlugin = {
  id: 'paid',
  kind: 'tts',
  displayName: 'Paid test provider',
  configured: () => true,
  costNote: 'Costs money per call.',
  env: [],
  params: z.object({ text: z.string().min(1) }),
  cacheKey: (p: unknown) => createHash('sha256').update((p as { text: string }).text).digest('hex').slice(0, 32),
  async run(p: unknown, ctx) {
    return { asset: await ctx.putAsset({ data: Buffer.concat([PNG, Buffer.from((p as { text: string }).text)]), source: 'provider:paid' }) };
  },
};

async function api(method: string, path: string, key: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${server.url}${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
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
  const client = new Client({ name: 'reelforge-limits-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}
const toolError = (r: any) => {
  expect(r.isError).toBe(true);
  return JSON.parse(r.content[0].text).error;
};
const setLimits = (settings: Record<string, unknown>) => api('PATCH', '/v1/config', admin, { settings });
const cancelAll = async () => {
  for (const j of (await server.service.listJobs({}, { limit: 200 })).jobs) if (j.status === 'queued' || j.status === 'running') await server.service.cancelJob(j.id);
  await server.service.jobs.idle();
};

beforeAll(async () => {
  const registry = new PluginRegistry()
    .registerEngine(fakeEngine('remotion', { delayPerFrameMs: 30 }))
    .registerEngine(fakeEngine('motion-canvas', { delayPerFrameMs: 30 }))
    .registerProvider(paid);
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    { registry, env: { ...database.env, REELFORGE_LICENCE_MODE: 'off', REELFORGE_METRICS_ALLOW_ANONYMOUS: 'true', REELFORGE_MAX_UPLOAD_BYTES: String(1024 * 1024) }, quiet: true }
  );
  admin = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
  agentA = (await server.service.keys.create('agent-a', ['read', 'write', 'render'])).key;
  agentB = (await server.service.keys.create('agent-b', ['read', 'write', 'render'])).key;
  expect((await api('POST', '/v1/projects', agentA, sample)).status).toBe(201);
}, 120_000);
afterAll(async () => {
  await cancelAll().catch(() => undefined);
  await server?.close();
  await dropDb();
  cleanup();
});

describe('limits over REST and MCP', () => {
  it('LIMS-01 render limits: REST 422 and the MCP tool error carry the same code and named limits; get_capabilities reports them', async () => {
    expect((await setLimits({ 'limits.maxRenderFrames': 100 })).status).toBe(200);
    try {
      const rest = await api('POST', '/v1/projects/sample-reel/renders', agentA, {});
      expect(rest.status).toBe(422);
      expect(rest.json.error).toMatchObject({ code: 'render_limit_exceeded', details: { limits: [{ limit: 'limits.maxRenderFrames', max: 100, actual: 210 }] } });
      const client = await mcp(agentA);
      const err = toolError(await client.callTool({ name: 'render_project', arguments: { projectId: 'sample-reel' } }));
      expect(err).toEqual(rest.json.error);
      const caps = JSON.parse(((await client.callTool({ name: 'get_capabilities', arguments: {} })) as any).content[0].text);
      expect(caps.limits).toMatchObject({ maxRenderFrames: 100, jobs: { maxQueuedJobsPerKey: 100, maxQueuedJobs: 1000, maxRunningJobsPerKey: null }, providers: { runsPerKeyPerDay: 500, runsPerDay: null } });
      await client.close();
    } finally {
      await setLimits({ 'limits.maxRenderFrames': null });
    }
  });

  it('LIMS-02 job caps: 429 too_many_jobs with Retry-After on REST, the same error over MCP, other keys unaffected; queue_full for everyone', async () => {
    await setLimits({ 'limits.maxQueuedJobsPerKey': 1 });
    try {
      expect((await api('POST', '/v1/projects/sample-reel/renders', agentA, {})).status).toBe(202);
      const rest = await api('POST', '/v1/projects/sample-reel/renders', agentA, {});
      expect(rest.status).toBe(429);
      expect(rest.headers.get('retry-after')).toBe('30');
      expect(rest.json.error).toMatchObject({ code: 'too_many_jobs', details: { limit: 'limits.maxQueuedJobsPerKey', max: 1, used: 1, retryAfterSeconds: 30 } });
      const client = await mcp(agentA);
      expect(toolError(await client.callTool({ name: 'render_project', arguments: { projectId: 'sample-reel' } }))).toEqual(rest.json.error);
      await client.close();
      expect((await api('POST', '/v1/projects/sample-reel/renders', agentB, {})).status).toBe(202);
      // agentA runs one job, agentB has one queued: a total cap of 1 is full.
      await setLimits({ 'limits.maxQueuedJobsPerKey': 0, 'limits.maxQueuedJobs': 1 });
      const full = await api('POST', '/v1/projects/sample-reel/renders', agentA, {});
      expect(full.status).toBe(429);
      expect(full.headers.get('retry-after')).toBe('30');
      expect(full.json.error).toMatchObject({ code: 'queue_full', details: { limit: 'limits.maxQueuedJobs', max: 1 } });
      const audit = await api('GET', '/v1/audit?action=limit.rejected', admin);
      expect(audit.status).toBe(200);
      const reasons = (audit.json.entries ?? audit.json.events ?? []).map((e: any) => e.data?.reason);
      expect(reasons).toEqual(expect.arrayContaining(['render_limit', 'jobs_per_key', 'queue_full']));
    } finally {
      await setLimits({ 'limits.maxQueuedJobsPerKey': null, 'limits.maxQueuedJobs': null });
      await cancelAll();
    }
  });

  it('LIMS-07 job cap under concurrent REST starts: exactly the cap succeed, the rest get 429 too_many_jobs; an idempotent re-submit never counts twice; a cancel frees a slot', async () => {
    await setLimits({ 'limits.maxQueuedJobsPerKey': 3 });
    try {
      const first = await api('POST', '/v1/projects/sample-reel/renders', agentA, {}, { 'idempotency-key': 'lims-07-a' });
      expect(first.status).toBe(202);
      // The same request again is a replay of the same job, not a second start.
      const again = await api('POST', '/v1/projects/sample-reel/renders', agentA, {}, { 'idempotency-key': 'lims-07-a' });
      expect(again.status).toBe(202);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.json.job.id).toBe(first.json.job.id);
      const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => api('POST', '/v1/projects/sample-reel/renders', agentA, {}, { 'idempotency-key': `lims-07-burst-${i}` })));
      expect(burst.filter((r) => r.status === 202)).toHaveLength(2);
      const refused = burst.filter((r) => r.status === 429);
      expect(refused).toHaveLength(8);
      for (const r of refused) expect(r.json.error).toMatchObject({ code: 'too_many_jobs', details: { max: 3, used: 3 } });
      // A refused start stored no idempotency record: the same key goes through once there is room.
      const mine = (await server.service.listJobs({}, { limit: 200 })).jobs.filter((j) => j.status === 'queued' || j.status === 'running');
      expect(mine).toHaveLength(3);
      expect((await api('POST', `/v1/jobs/${first.json.job.id}/cancel`, agentA, {})).status).toBe(200);
      for (let i = 0; i < 200 && (await server.service.getJob(first.json.job.id)).status !== 'cancelled'; i++) await new Promise((r) => setTimeout(r, 25));
      const retried = await api('POST', '/v1/projects/sample-reel/renders', agentA, {}, { 'idempotency-key': `lims-07-burst-${burst.indexOf(refused[0]!)}` });
      expect(retried.status).toBe(202);
      expect(retried.headers.get('idempotent-replayed')).toBeNull();
      // Replaying the first (now cancelled) render's key still returns it and still does not count.
      const replay = await api('POST', '/v1/projects/sample-reel/renders', agentA, {}, { 'idempotency-key': 'lims-07-a' });
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect((await api('POST', '/v1/projects/sample-reel/renders', agentA, {})).status).toBe(429);
    } finally {
      await setLimits({ 'limits.maxQueuedJobsPerKey': null });
      await cancelAll();
    }
  });

  it('LIMS-03 provider calls: 429 provider_limit_exceeded with Retry-After on REST and over MCP (run_provider), cached results allowed', async () => {
    await setLimits({ 'limits.providerRunsPerKeyPerDay': 1 });
    try {
      expect((await api('POST', '/v1/providers/paid/run', agentA, { params: { text: 'first' }, acknowledgeCost: true })).status).toBe(201);
      const rest = await api('POST', '/v1/providers/paid/run', agentA, { params: { text: 'second' }, acknowledgeCost: true });
      expect(rest.status).toBe(429);
      expect(Number(rest.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(rest.json.error).toMatchObject({ code: 'provider_limit_exceeded', details: { limit: 'limits.providerRunsPerKeyPerDay', max: 1, used: 1 } });
      const client = await mcp(agentA);
      const err = toolError(await client.callTool({ name: 'run_provider', arguments: { providerId: 'paid', params: { text: 'third' }, acknowledgeCost: true } }));
      expect(err).toMatchObject({ code: 'provider_limit_exceeded', details: { limit: 'limits.providerRunsPerKeyPerDay', max: 1, used: 1 } });
      const cached = JSON.parse(((await client.callTool({ name: 'run_provider', arguments: { providerId: 'paid', params: { text: 'first' }, acknowledgeCost: true } })) as any).content[0].text);
      expect(cached.cached).toBe(true);
      await client.close();
      expect((await api('POST', '/v1/providers/paid/run', agentB, { params: { text: 'other key' }, acknowledgeCost: true })).status).toBe(201);
    } finally {
      await setLimits({ 'limits.providerRunsPerKeyPerDay': null });
    }
  });

  it('LIMS-04 multipart uploads are streamed: fields after the file still apply; a declared size over the cap is refused at once', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.concat([PNG, Buffer.alloc(300_000, 5)])], { type: 'image/png' }), 'pic.png');
    form.append('projectId', 'sample-reel');
    form.append('assetId', 'pic');
    const ok = await api('POST', '/v1/assets', agentA, form);
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ asset: { contentType: 'image/png', bytes: 300_008 }, projectAssetId: 'pic' });
    expect(readdirSync(join(server.service.cacheDir, 'upload-staging'))).toEqual([]);
    const declared = await api('POST', '/v1/assets', agentA, 'x', { 'content-type': 'multipart/form-data; boundary=b', 'content-length': String(10 * 1024 * 1024) }).catch(() => null);
    if (declared) {
      expect(declared.status).toBe(413);
      expect(declared.json.error).toMatchObject({ code: 'too_large', details: { limit: 'limits.maxUploadBytes' } });
    }
    const missing = new FormData();
    missing.append('projectId', 'sample-reel');
    expect((await api('POST', '/v1/assets', agentA, missing)).json.error.code).toBe('bad_request');
  });

  it('LIMS-05 a chunked upload over the cap gets 413 while the client is still sending; nothing stays on disk', async () => {
    const boundary = 'reelforgeboundary';
    const url = new URL(`${server.url}/v1/assets`);
    let sent = 0;
    const result = await new Promise<{ status: number; body: string; sentAtResponse: number }>((resolve, reject) => {
      const req = httpRequest(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { authorization: `Bearer ${agentA}`, 'content-type': `multipart/form-data; boundary=${boundary}`, 'transfer-encoding': 'chunked' } },
        (res) => {
          const sentAtResponse = sent;
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, sentAtResponse }));
        }
      );
      req.on('error', (e) => (sent > 1024 * 1024 ? undefined : reject(e)));
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`);
      req.write(PNG);
      const chunk = Buffer.alloc(64 * 1024, 9);
      const pump = () => {
        if (req.destroyed || sent > 64 * 1024 * 1024) return req.end();
        sent += chunk.length;
        if (req.write(chunk)) setImmediate(pump);
        else req.once('drain', pump);
      };
      pump();
    });
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body).error).toMatchObject({ code: 'too_large', details: { limit: 'limits.maxUploadBytes', max: 1024 * 1024 } });
    // The answer came long before the 64 MB body was sent: the server stopped reading at the cap.
    expect(result.sentAtResponse).toBeLessThan(16 * 1024 * 1024);
    await new Promise((r) => setTimeout(r, 100));
    expect(readdirSync(join(server.service.cacheDir, 'upload-staging'))).toEqual([]);
  });

  it('LIMS-06 /metrics counts rejections by reason (a fixed set of labels)', async () => {
    const r = await api('GET', '/metrics', null);
    expect(r.status).toBe(200);
    const samples = parsePrometheus(r.text).filter((s) => s.name === 'reelforge_limits_rejections_total');
    const by = Object.fromEntries(samples.map((s) => [s.labels.reelforge_limit_reason, s.value]));
    for (const reason of ['render_limit', 'jobs_per_key', 'queue_full', 'provider_runs_per_key', 'upload_too_large']) expect(by[reason]).toBeGreaterThanOrEqual(1);
    for (const s of samples) expect(['render_limit', 'jobs_per_key', 'queue_full', 'queue_wait', 'render_quota', 'upload_too_large', 'provider_runs_per_key', 'provider_budget']).toContain(s.labels.reelforge_limit_reason);
  });
});
