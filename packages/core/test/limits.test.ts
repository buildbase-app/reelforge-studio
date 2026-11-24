/**
 * Resource limits (issue #107, D-090, D-091): render limits, job caps per key
 * and in total, the per-key running cap of the in-process queue, provider
 * calls per key and per day, and streamed uploads with a hard byte cap.
 * Test ids LIMT-nn (docs/security/HARDENING.md). The database implementations
 * of the counters are covered by packages/db/test/limits.contract.test.ts.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseProject } from '@reelforge/project-schema';
import {
  AssetStore,
  JobRunner,
  PluginRegistry,
  ReelforgeService,
  createMemoryRepositories,
  renderLimitViolations,
  resolveConfig,
  runWithRequest,
  stageStream,
  type AuthContext,
  type ProviderPlugin,
  type Repositories,
} from '../src/index';
import { fakeEngine, tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-limits-');
afterAll(cleanup);
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const defaults = resolveConfig({ env: {} }).config.limits;

const as = <T>(keyId: string, fn: () => Promise<T>) =>
  runWithRequest({ requestId: `req_${keyId}`, via: 'rest', auth: { keyId, name: keyId, scopes: ['admin'] } as AuthContext }, fn);

/** A paid provider double: counts real calls; the same text is a cache hit. */
function countingProvider(): ProviderPlugin & { calls: number } {
  const p = {
    id: 'paid',
    kind: 'tts' as const,
    displayName: 'Paid test provider',
    configured: () => true,
    costNote: 'Costs money per call.',
    env: [],
    params: z.object({ text: z.string().min(1) }),
    cacheKey: (params: unknown) => createHash('sha256').update((params as { text: string }).text).digest('hex').slice(0, 32),
    calls: 0,
    async run(params: unknown, ctx: Parameters<ProviderPlugin['run']>[1]) {
      p.calls++;
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from((params as { text: string }).text)]);
      return { asset: await ctx.putAsset({ data: png, source: 'provider:paid' }) };
    },
  };
  return p;
}

describe('render limits', () => {
  const project = parseProject(sample);
  if (!project.ok) throw new Error('sample does not parse');
  const p = project.project;

  it('LIMT-01 the defaults fit the sample; each limit is named when exceeded; previews are judged on what they render', () => {
    expect(renderLimitViolations(p, defaults)).toEqual([]);
    const tight = { ...defaults, maxScenes: 1, maxRenderSeconds: 5, maxRenderFrames: 200, maxRenderDimension: 1000, maxRenderFps: 25 };
    const v = renderLimitViolations(p, tight);
    expect(v.map((x) => x.limit)).toEqual(['limits.maxScenes', 'limits.maxRenderSeconds', 'limits.maxRenderFrames', 'limits.maxRenderDimension', 'limits.maxRenderFps']);
    expect(v[2]).toMatchObject({ max: 200, actual: 210 });
    expect(v[3]).toMatchObject({ max: 1000, actual: 1920 });
    // A preview of one 90-frame scene at a third of the size fits everything but the frame rate.
    expect(renderLimitViolations(p, tight, { sceneIds: ['hook'], scale: 1 / 3 }).map((x) => x.limit)).toEqual(['limits.maxRenderFps']);
  });
});

describe('ReelforgeService limits', () => {
  let svc: ReelforgeService;
  let repos: Repositories;
  const provider = countingProvider();

  beforeAll(async () => {
    repos = createMemoryRepositories();
    const registry = new PluginRegistry()
      .registerEngine(fakeEngine('remotion', { delayPerFrameMs: 40 }))
      .registerEngine(fakeEngine('motion-canvas', { delayPerFrameMs: 40 }))
      .registerProvider(provider);
    svc = await ReelforgeService.create(registry, { repositories: repos, dataDir: join(dir, 'svc'), configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } } });
    await svc.createProject(sample);
  });
  afterAll(async () => {
    for (const j of (await svc.listJobs({}, { limit: 200 })).jobs) if (j.status === 'queued' || j.status === 'running') await svc.cancelJob(j.id);
    await svc.jobs.idle();
    await svc.stop();
  });

  const rejections = async (reason: string) => (await repos.audit.list({ limit: 500 })).filter((e) => e.action === 'limit.rejected' && (e.data as { reason?: string }).reason === reason);

  it('LIMT-02 a render over a limit is refused up front with 422 naming the limit, audited; validate_project reports it; a smaller preview still starts', async () => {
    await svc.updateConfig({ 'limits.maxRenderFrames': 200, 'limits.maxRenderDimension': 1000 });
    try {
      const err = await as('key_a', () => svc.startRender('sample-reel')).catch((e) => e);
      expect(err).toMatchObject({ code: 'render_limit_exceeded', status: 422 });
      expect(err.details.limits).toEqual([
        { limit: 'limits.maxRenderFrames', max: 200, actual: 210 },
        { limit: 'limits.maxRenderDimension', max: 1000, actual: 1920 },
      ]);
      expect(err.message).toContain('limits.maxRenderFrames allows 200');
      const report = await svc.validateProject('sample-reel');
      expect(report.ok).toBe(false);
      expect(report.errors.map((e) => e.message).join('\n')).toMatch(/render limit: the number of frames is 210; limits.maxRenderFrames allows 200/);
      const [entry] = await rejections('render_limit');
      expect(entry).toMatchObject({ actorType: 'api_key', actorId: 'key_a', result: 'denied', data: { reason: 'render_limit', projectId: 'sample-reel' } });
      // One scene at a third of the size fits: the preview starts.
      const job = await as('key_a', () => svc.preview('sample-reel', { sceneId: 'hook', scale: 1 / 3 }));
      expect(job.status).toBe('queued');
      await svc.cancelJob(job.id);
      await svc.jobs.idle();
      expect(svc.capabilities().limits).toMatchObject({ maxRenderFrames: 200, maxRenderDimension: 1000, maxScenes: 50, minSceneFrames: 3, shortSceneWarnSeconds: 0.25 });
    } finally {
      await svc.updateConfig({ 'limits.maxRenderFrames': null, 'limits.maxRenderDimension': null });
    }
    expect((await svc.validateProject('sample-reel')).ok).toBe(true);
  });

  it('LIMT-03 job caps: one key is refused with 429 too_many_jobs and Retry-After details, other keys are not; a full queue refuses everyone with queue_full', async () => {
    await svc.updateConfig({ 'limits.maxQueuedJobsPerKey': 2 });
    try {
      await as('key_a', () => svc.startRender('sample-reel'));
      await as('key_a', () => svc.startRender('sample-reel'));
      const err = await as('key_a', () => svc.startRender('sample-reel')).catch((e) => e);
      expect(err).toMatchObject({ code: 'too_many_jobs', status: 429, details: { limit: 'limits.maxQueuedJobsPerKey', max: 2, used: 2, retryAfterSeconds: 30 } });
      // retry_job counts the same way.
      const done = (await svc.listJobs()).jobs.find((j) => j.status === 'cancelled');
      if (done) await expect(as('key_a', () => svc.retryJob(done.id))).rejects.toMatchObject({ code: 'too_many_jobs' });
      // Another key still starts.
      const b = await as('key_b', () => svc.startRender('sample-reel'));
      expect(b.status).toBe('queued');
      expect(await rejections('jobs_per_key')).not.toHaveLength(0);
      // Total queue: key_a has one running and one queued, key_b one queued.
      await svc.updateConfig({ 'limits.maxQueuedJobs': 2 });
      const full = await as('key_c', () => svc.startRender('sample-reel')).catch((e) => e);
      expect(full).toMatchObject({ code: 'queue_full', status: 429, details: { limit: 'limits.maxQueuedJobs', max: 2, used: 2, retryAfterSeconds: 30 } });
      expect(await rejections('queue_full')).toHaveLength(1);
      // 0 turns a cap off.
      await svc.updateConfig({ 'limits.maxQueuedJobs': 0, 'limits.maxQueuedJobsPerKey': 0 });
      expect((await as('key_a', () => svc.startRender('sample-reel'))).status).toBe('queued');
      expect(svc.capabilities().limits.jobs).toEqual({ maxQueuedJobsPerKey: null, maxQueuedJobs: null, maxRunningJobsPerKey: null, maxEstimatedWaitSeconds: null });
    } finally {
      await svc.updateConfig({ 'limits.maxQueuedJobsPerKey': null, 'limits.maxQueuedJobs': null });
      for (const j of (await svc.listJobs({}, { limit: 200 })).jobs) if (j.status === 'queued' || j.status === 'running') await svc.cancelJob(j.id);
      await svc.jobs.idle();
    }
  });

  it('LIMT-04 provider calls: a daily cap per key and a server-wide daily budget; cached results do not count; usage is reported on the key', async () => {
    const a = await svc.createKey('limits-a', ['render']);
    const b = await svc.createKey('limits-b', ['render']);
    await svc.updateConfig({ 'limits.providerRunsPerKeyPerDay': 2, 'limits.providerRunsPerDay': 3 });
    try {
      const run = (key: string, text: string) => as(key, () => svc.runProvider('paid', { text }, { acknowledgeCost: true }));
      await run(a.record.id, 'one');
      await run(a.record.id, 'two');
      const err = await run(a.record.id, 'three').catch((e) => e);
      expect(err).toMatchObject({ code: 'provider_limit_exceeded', status: 429, details: { limit: 'limits.providerRunsPerKeyPerDay', max: 2, used: 2 } });
      expect(err.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(err.details.resetsAt).toMatch(/T00:00:00.000Z$/);
      // The same parameters again come from the cache: allowed, not counted.
      expect((await run(a.record.id, 'one')).cached).toBe(true);
      // Another key has its own cap, but the server budget (3) runs out after one more call.
      await run(b.record.id, 'four');
      const budget = await run(b.record.id, 'five').catch((e) => e);
      expect(budget).toMatchObject({ code: 'provider_budget_exhausted', status: 429, details: { limit: 'limits.providerRunsPerDay', max: 3, used: 3 } });
      expect(provider.calls).toBe(3);
      expect((await svc.getKey(a.record.id)).usage.providerRunsToday).toBe(2);
      expect((await svc.getKey(b.record.id)).usage.providerRunsToday).toBe(1);
      expect(await rejections('provider_runs_per_key')).toHaveLength(1);
      expect(await rejections('provider_budget')).toHaveLength(1);
      // The acknowledgement is still required before any counting.
      await expect(as(b.record.id, () => svc.runProvider('paid', { text: 'six' }))).rejects.toMatchObject({ code: 'cost_acknowledgement_required' });
    } finally {
      await svc.updateConfig({ 'limits.providerRunsPerKeyPerDay': null, 'limits.providerRunsPerDay': null });
    }
  });
});

describe('per-key running cap (in-process queue)', () => {
  it('LIMT-05 a key that runs maxRunningPerKey jobs waits while other keys use the free slots', async () => {
    const release = new Map<string, () => void>();
    const runner = new JobRunner({
      repo: createMemoryRepositories().jobs,
      concurrency: 3,
      maxRunningPerKey: () => 1,
      handlers: {
        render: (ctx) => new Promise((resolve) => release.set(String(ctx.job.params.n), () => resolve({}))),
      },
    });
    await runner.init();
    const a1 = await runner.submit('render', { n: 'a1' }, { apiKeyId: 'key_a' });
    const a2 = await runner.submit('render', { n: 'a2' }, { apiKeyId: 'key_a' });
    const b1 = await runner.submit('render', { n: 'b1' }, { apiKeyId: 'key_b' });
    await new Promise((r) => setTimeout(r, 20));
    expect((await runner.get(a1.id)).status).toBe('running');
    expect((await runner.get(b1.id)).status).toBe('running');
    expect((await runner.get(a2.id)).status).toBe('queued');
    expect(runner.queuePosition(a2.id)).toBe(0);
    release.get('a1')!();
    await new Promise((r) => setTimeout(r, 20));
    expect((await runner.get(a2.id)).status).toBe('running');
    release.get('a2')!();
    release.get('b1')!();
    await runner.idle();
  });
});

describe('fair claiming across keys', () => {
  it('LIMT-08 without a running cap, two keys with 20 queued jobs each share 2 slots evenly (in-process queue)', async () => {
    const order: string[] = [];
    const runner = new JobRunner({
      repo: createMemoryRepositories().jobs,
      concurrency: 2,
      handlers: {
        render: async (ctx) => {
          order.push(String(ctx.job.apiKeyId));
          await new Promise((r) => setTimeout(r, 2));
          return {};
        },
      },
    });
    await runner.init();
    // Key A queues all 20 first: a FIFO queue would run all of A before any of B.
    for (const key of ['key_a', 'key_b']) for (let i = 0; i < 20; i++) await runner.submit('render', { i }, { apiKeyId: key });
    await runner.idle();
    expect(order).toHaveLength(40);
    const firstHalf = order.slice(0, 20);
    expect(firstHalf.filter((k) => k === 'key_a').length).toBeGreaterThanOrEqual(9);
    expect(firstHalf.filter((k) => k === 'key_b').length).toBeGreaterThanOrEqual(9);
  });
});

describe('streamed uploads', () => {
  it('LIMT-06 stageStream stops at the byte cap: the source is not read further and the partial file is deleted', async () => {
    const staging = join(dir, 'staging');
    let pulled = 0;
    async function* endless() {
      for (;;) {
        pulled++;
        yield Buffer.alloc(64 * 1024, 1);
      }
    }
    await expect(stageStream(endless(), staging, 1024 * 1024)).rejects.toMatchObject({ code: 'too_large', status: 413, details: { limit: 'limits.maxUploadBytes' } });
    expect(pulled).toBe(17); // 16 chunks fit, the 17th passes the cap
    expect(readdirSync(staging)).toEqual([]);
    // Within the cap: size, hash and the first bytes for sniffing.
    const data = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200_000, 7)]);
    async function* parts() {
      for (let i = 0; i < data.length; i += 10_000) yield data.subarray(i, i + 10_000);
    }
    const staged = await stageStream(parts(), staging, 1024 * 1024);
    expect(staged).toMatchObject({ bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    expect(staged.head.subarray(0, 8)).toEqual(data.subarray(0, 8));
  });

  it('LIMT-07 a URL import without Content-Length is aborted at the cap (connection closed), never buffered; a fitting one is stored', async () => {
    let closedEarly = false;
    let sent = 0;
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' }); // chunked: no Content-Length
      if (req.url === '/small.png') return res.end(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1000, 3)]));
      const tick = () => {
        if (res.destroyed) return;
        sent += 64 * 1024;
        if (sent > 64 * 1024 * 1024) return res.end();
        res.write(Buffer.alloc(64 * 1024, 2), () => setImmediate(tick));
      };
      res.on('close', () => {
        closedEarly = sent < 64 * 1024 * 1024;
      });
      tick();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const staging = join(dir, 'url-staging');
      const store = new AssetStore(createMemoryRepositories().assets, join(dir, 'url-store'), { maxBytes: 512 * 1024, timeoutMs: 10_000, maxRedirects: 0, allowInsecureForTests: true, stagingDir: staging });
      await expect(store.fromUrl(`http://127.0.0.1:${port}/big.png`)).rejects.toMatchObject({ code: 'too_large', status: 413 });
      await new Promise((r) => setTimeout(r, 100));
      expect(closedEarly).toBe(true);
      expect(sent).toBeLessThan(8 * 1024 * 1024);
      expect(readdirSync(staging)).toEqual([]);
      const ok = await store.fromUrl(`http://127.0.0.1:${port}/small.png`);
      expect(ok).toMatchObject({ contentType: 'image/png', bytes: 1008 });
      expect(readdirSync(staging)).toEqual([]);
    } finally {
      server.close();
    }
  });
});
