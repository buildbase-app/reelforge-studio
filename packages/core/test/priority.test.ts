/**
 * Job priorities and admission by estimated wait in the service and the in-process queue (issue #155, D-103).
 * Test ids PRIS-nn (docs/providers/queue-and-scaling.md). The database claim order is covered by
 * packages/db/test/priority.contract.test.ts (PRI-nn) on every database.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JobRunner,
  PluginRegistry,
  RenderWeldService,
  createMemoryRepositories,
  decayedRate,
  estimateWaitSeconds,
  runWithRequest,
  type AuthContext,
  type JobPriority,
  type Repositories,
} from '../src/index';
import { fakeEngine, tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-priority-');
afterAll(cleanup);
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));

const as = <T>(keyId: string, fn: () => Promise<T>, extra: Partial<AuthContext> = {}) =>
  runWithRequest({ requestId: `req_${keyId}`, via: 'rest', auth: { keyId, name: keyId, scopes: ['render'], ...extra } as AuthContext }, fn);

describe('estimate and rate', () => {
  it('PRIS-01 the estimate is the smaller of the head age and the drain time; the rate is a decayed average of per-minute counts', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 30);
    const at = (s: number) => new Date(now - s * 1000).toISOString();
    expect(estimateWaitSeconds({ ahead: 0, oldestQueuedAt: at(900), claimsPerSecond: 0, nowMs: now })).toBe(0);
    expect(estimateWaitSeconds({ ahead: 10, oldestQueuedAt: at(900), claimsPerSecond: 0, nowMs: now })).toBe(900);
    expect(estimateWaitSeconds({ ahead: 10, oldestQueuedAt: at(900), claimsPerSecond: 1, nowMs: now })).toBe(10);
    expect(estimateWaitSeconds({ ahead: 10, oldestQueuedAt: at(5), claimsPerSecond: 0.01, nowMs: now })).toBe(5);
    // A steady 60 claims per minute for 10 minutes is 1 per second; nothing is 0; a burst long ago weighs little.
    const minute = (k: number) => new Date(Math.floor(now / 60_000) * 60_000 - k * 60_000).toISOString();
    expect(decayedRate(Array.from({ length: 11 }, (_, k) => ({ windowStart: minute(k), count: k === 0 ? 30 : 60 })), now)).toBeCloseTo(1, 1);
    expect(decayedRate([], now)).toBe(0);
    expect(decayedRate([{ windowStart: minute(9), count: 600 }], now)).toBeLessThan(decayedRate([{ windowStart: minute(1), count: 600 }], now));
  });
});

describe('in-process queue', () => {
  it('PRIS-02 the pump starts interactive, then standard, then batch, fairly across keys within a class; positions follow', async () => {
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const runner = new JobRunner({
      repo: createMemoryRepositories().jobs,
      concurrency: 1,
      handlers: {
        render: (ctx) =>
          new Promise((resolve) => {
            started.push(String(ctx.job.params.name));
            gates.set(String(ctx.job.params.name), () => resolve({}));
          }),
      },
    });
    await runner.init();
    const submit = (name: string, priority: JobPriority, apiKeyId: string) => runner.submit('render', { name }, { priority, apiKeyId });
    await submit('first', 'standard', 'key_a');
    await new Promise((r) => setTimeout(r, 10));
    const b = await submit('batch', 'batch', 'key_a');
    await submit('std-a', 'standard', 'key_a');
    await submit('std-b', 'standard', 'key_b');
    const i = await submit('inter', 'interactive', 'key_a');
    expect(runner.queuePosition(i.id)).toBe(0);
    expect(runner.queuePosition(b.id)).toBe(3);
    for (const name of ['first', 'inter', 'std-a', 'std-b', 'batch']) {
      for (let t = 0; !gates.has(name) && t < 200; t++) await new Promise((r) => setTimeout(r, 5));
      gates.get(name)!();
    }
    await runner.idle();
    // When the standard jobs are chosen neither key runs anything, so the oldest goes first.
    expect(started).toEqual(['first', 'inter', 'std-a', 'std-b', 'batch']);
  });
});

describe('RenderWeldService priorities and admission', () => {
  let svc: RenderWeldService;
  let repos: Repositories;
  let offset = 0;

  beforeAll(async () => {
    repos = createMemoryRepositories();
    const registry = new PluginRegistry().registerEngine(fakeEngine('remotion', { delayPerFrameMs: 40 })).registerEngine(fakeEngine('motion-canvas', { delayPerFrameMs: 40 }));
    svc = await RenderWeldService.create(registry, {
      repositories: repos,
      dataDir: join(dir, 'svc'),
      configSources: { env: { RENDERWELD_LICENCE_MODE: 'off' } },
      now: () => Date.now() + offset,
    });
    await svc.createProject(sample);
  });
  afterAll(async () => {
    for (const j of (await svc.listJobs({}, { limit: 200 })).jobs) if (j.status === 'queued' || j.status === 'running') await svc.cancelJob(j.id);
    await svc.jobs.idle();
    await svc.stop();
  });
  const cancelAll = async () => {
    for (const j of (await svc.listJobs({}, { limit: 200 })).jobs) if (j.status === 'queued' || j.status === 'running') await svc.cancelJob(j.id);
    await svc.jobs.idle();
  };

  it('PRIS-03 defaults: previews interactive, renders standard; a key may lower a class but not raise it (403 priority_not_allowed)', async () => {
    try {
      expect((await as('key_n', () => svc.preview('sample-reel'))).priority).toBe('interactive');
      expect((await as('key_n', () => svc.startRender('sample-reel'))).priority).toBe('standard');
      expect((await as('key_n', () => svc.startRender('sample-reel', { priority: 'batch' }))).priority).toBe('batch');
      const err = await as('key_n', () => svc.startRender('sample-reel', { priority: 'interactive' })).catch((e) => e);
      expect(err).toMatchObject({ code: 'priority_not_allowed', status: 403, details: { requested: 'interactive', maxPriority: 'standard', setting: 'key.maxPriority' } });
      await expect(as('key_n', () => svc.preview('sample-reel', { priority: 'urgent' }))).rejects.toMatchObject({ code: 'bad_request', status: 400 });
      // An admin raised this key's maximum: interactive renders are allowed (the default stays standard).
      expect((await as('key_vip', () => svc.startRender('sample-reel', { priority: 'interactive' }), { maxPriority: 'interactive' })).priority).toBe('interactive');
      expect((await as('key_vip', () => svc.startRender('sample-reel'), { maxPriority: 'interactive' })).priority).toBe('standard');
      // A key held to batch: its previews default to batch and cannot ask for more.
      expect((await as('key_low', () => svc.preview('sample-reel'), { maxPriority: 'batch' })).priority).toBe('batch');
      await expect(as('key_low', () => svc.preview('sample-reel', { priority: 'standard' }), { maxPriority: 'batch' })).rejects.toMatchObject({ code: 'priority_not_allowed' });
      // get_capabilities says what the calling key may use.
      expect(await as('key_low', async () => svc.capabilities().limits.priority, { maxPriority: 'batch' })).toEqual({
        classes: ['interactive', 'standard', 'batch'],
        defaults: { preview: 'interactive', render: 'standard' },
        maxForThisKey: { render: 'batch', preview: 'batch' },
        batchAgingSeconds: 600,
      });
      // retry keeps the class, lowered to what the retrying key may use.
      const vip = (await svc.listJobs({}, { limit: 200 })).jobs.find((j) => j.priority === 'interactive' && j.type === 'render')!;
      await svc.cancelJob(vip.id);
      expect((await as('key_n', () => svc.retryJob(vip.id))).priority).toBe('standard');
    } finally {
      await cancelAll();
    }
  });

  it('PRIS-04 keys carry maxPriority from create_key/update_key into the request (escalation needs an admin to set it)', async () => {
    const created = await svc.createKey('pri-key', ['render'], { maxPriority: 'interactive' });
    expect(created.record.maxPriority).toBe('interactive');
    const auth = await svc.keys.verify(created.key);
    expect(auth?.maxPriority).toBe('interactive');
    expect((await svc.keys.update(created.record.id, { maxPriority: null })).maxPriority).toBeUndefined();
    expect((await svc.keys.verify(created.key))?.maxPriority).toBeUndefined();
    await expect(svc.keys.update(created.record.id, { maxPriority: 'urgent' as JobPriority })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('PRIS-05 admission: a start whose estimated wait exceeds limits.maxEstimatedWaitSeconds is refused with 429 queue_full, Retry-After and details; higher classes with nothing ahead still start', async () => {
    await svc.updateConfig({ 'limits.maxEstimatedWaitSeconds': 60 });
    try {
      expect(svc.capabilities().limits.jobs.maxEstimatedWaitSeconds).toBe(60);
      await as('key_a', () => svc.startRender('sample-reel')); // runs (concurrency 1)
      await as('key_a', () => svc.startRender('sample-reel')); // waits
      // Accepted while the queue head has waited less than the limit.
      await as('key_b', () => svc.startRender('sample-reel'));
      // Two hours later (the clock of the service), with no claims measured since: the head waited 7200 s.
      await svc.claimRate.flush(); // the claims so far land in their own (by then old) minute
      offset = 7_200_000;
      const err = await as('key_c', () => svc.startRender('sample-reel')).catch((e) => e);
      expect(err).toMatchObject({
        code: 'queue_full',
        status: 429,
        details: { limit: 'limits.maxEstimatedWaitSeconds', max: 60, priority: 'standard', queued: { ahead: 2 }, retryAfterSeconds: 3600 },
      });
      expect(err.details.estimatedWaitSeconds).toBeGreaterThan(7000);
      expect(err.details.queued.oldestWaitingSeconds).toBeGreaterThan(7000);
      expect(typeof err.details.claimsPerMinute).toBe('number');
      const audited = (await repos.audit.list({ limit: 500 })).filter((e) => e.action === 'limit.rejected' && (e.data as { reason?: string }).reason === 'queue_wait');
      expect(audited).toHaveLength(1);
      // A preview has no interactive job ahead of it: admitted.
      expect((await as('key_c', () => svc.preview('sample-reel'))).status).toBe('queued');
      // 0 turns it off.
      await svc.updateConfig({ 'limits.maxEstimatedWaitSeconds': 0 });
      expect((await as('key_c', () => svc.startRender('sample-reel'))).status).toBe('queued');
    } finally {
      offset = 0;
      await svc.updateConfig({ 'limits.maxEstimatedWaitSeconds': null });
      await cancelAll();
    }
  });
});
