import { describe, expect, it } from 'vitest';
import { ANALYTICS_SCAN_LIMIT, Analytics, parseAnalyticsQuery, percentile, type AnalyticsDeps } from '../src/analytics';
import { createMemoryRepositories } from '../src/memory-repositories';
import type { JobRecord } from '../src/repositories';

/** Analytics (#292): buckets, rates, percentiles, the scan bound, manifests, storage and webhook health. */
const NOW = Date.parse('2026-11-24T15:30:00.000Z');
const iso = (t: number) => new Date(t).toISOString();
const DAY = 86_400_000;

function job(id: string, createdAt: number, over: Partial<JobRecord> = {}): JobRecord {
  return { id, type: 'render', status: 'succeeded', projectId: 'p1', params: { runId: `run_${id}` }, createdAt: iso(createdAt), progress: { stage: 'done', fraction: 1 }, ...over };
}

function setup(manifests: Record<string, Array<{ engine: string; millis: number }> | 'throw'> = {}) {
  const repos = createMemoryRepositories();
  let usageCalls = 0;
  let manifestReads = 0;
  const deps: AnalyticsDeps = {
    jobs: repos.jobs,
    webhooks: repos.webhooks,
    storageUsage: async () => {
      usageCalls++;
      return { totalBytes: 5_000, renders: { count: 2, bytes: 4_000 }, assets: { objects: 1, bytes: 1_000 } };
    },
    readManifest: async (_p, runId) => {
      manifestReads++;
      const m = manifests[runId];
      if (m === 'throw') throw new Error('bucket unreachable');
      return m ? { scenes: m } : null;
    },
    now: () => NOW,
  };
  return { repos, analytics: new Analytics(deps), counts: () => ({ usageCalls, manifestReads }) };
}

describe('analytics query', () => {
  it('defaults to the last 30 UTC days by day, today included', () => {
    const q = parseAnalyticsQuery({}, NOW);
    expect(iso(q.from)).toBe('2026-10-26T00:00:00.000Z');
    expect(q.to).toBe(NOW);
    expect(q.bucket).toBe('day');
  });
  it('takes dates (a `to` date includes its day) and ISO times, aligned to the bucket', () => {
    const q = parseAnalyticsQuery({ from: '2026-11-01', to: '2026-11-30' }, NOW);
    expect([iso(q.from), iso(q.to)]).toEqual(['2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z']);
    const h = parseAnalyticsQuery({ from: '2026-11-24T10:45:00Z', bucket: 'hour' }, NOW);
    expect(iso(h.from)).toBe('2026-11-24T10:00:00.000Z');
  });
  it('refuses a bad bucket, a reversed or unparsable range, and ranges over the caps', () => {
    expect(() => parseAnalyticsQuery({ bucket: 'week' }, NOW)).toThrow(/bucket/);
    expect(() => parseAnalyticsQuery({ from: 'yesterday' }, NOW)).toThrow(/ISO 8601/);
    expect(() => parseAnalyticsQuery({ from: '2026-11-20', to: '2026-11-10' }, NOW)).toThrow(/before/);
    expect(() => parseAnalyticsQuery({ from: '2026-08-01', to: '2026-11-24' }, NOW)).toThrow(/at most 90 days/);
    expect(() => parseAnalyticsQuery({ from: '2026-11-01', bucket: 'hour' }, NOW)).toThrow(/at most 7 days with bucket "hour"/);
    expect(parseAnalyticsQuery({ from: '2026-08-27', to: '2026-11-24' }, NOW).bucket).toBe('day'); // exactly 90 days
  });
  it('nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(xs, 50), percentile(xs, 95)]).toEqual([50, 95]);
  });
});

describe('analytics summary', () => {
  it('counts jobs per day by status, rates without cancelled jobs, times, minutes and the top errors', async () => {
    const { repos, analytics } = setup({
      run_a: [
        { engine: 'remotion', millis: 4000 },
        { engine: 'html', millis: 1000 },
      ],
      run_b: [{ engine: 'remotion', millis: 6000 }],
    });
    const today = Math.floor(NOW / DAY) * DAY;
    const at = (d: number, h: number) => today - d * DAY + h * 3_600_000;
    const done = (start: number, waitMs: number, runMs: number, seconds: number) => ({ startedAt: iso(start + waitMs), finishedAt: iso(start + waitMs + runMs), result: { renderId: 'x', durationSeconds: seconds } });
    const fail = (code: string, message: string, t: number) => ({ status: 'failed' as const, error: { code, message, stage: 'render' }, finishedAt: iso(t), startedAt: iso(t - 1000) });
    const rows = [
      job('a', at(0, 9), done(at(0, 9), 2_000, 10_000, 30)),
      job('b', at(0, 10), { ...done(at(0, 10), 4_000, 20_000, 15), type: 'preview' }),
      job('c', at(1, 8), fail('engine_failed', 'remotion crashed', at(1, 8) + 5000)),
      job('d', at(1, 9), fail('engine_failed', 'remotion crashed again', at(1, 9) + 5000)),
      job('e', at(2, 9), fail('storage_unavailable', 'bucket down', at(2, 9) + 5000)),
      job('f', at(2, 10), { status: 'cancelled' }),
      job('g', at(0, 11), { status: 'running', startedAt: iso(at(0, 11) + 1000) }),
      // Not counted: a fan-out unit, a job before the range, a job after `to`.
      job('u', at(0, 9), { type: 'render_unit', parentId: 'a' }),
      job('old', at(40, 0)),
      job('future', NOW + 60_000),
    ];
    for (const r of rows) await repos.jobs.insert(r, r.createdAt);

    const s = await analytics.summary({});
    expect(s.series).toHaveLength(30);
    expect(s.series.at(-1)).toMatchObject({ start: iso(today), jobs: 3, succeeded: 2, unfinished: 1 });
    expect(s.series.at(-2)).toMatchObject({ jobs: 2, failed: 2 });
    expect(s.series.at(-3)).toMatchObject({ jobs: 2, failed: 1, cancelled: 1 });
    expect(s.totals).toMatchObject({ jobs: 7, renders: 6, previews: 1, succeeded: 2, failed: 3, cancelled: 1, unfinished: 1, successRate: 0.4, failureRate: 0.6 });
    expect(s.scan).toMatchObject({ jobs: 8, truncated: false, coveredFrom: s.range.from });
    expect(s.renderTime).toEqual({ p50Ms: 10_000, p95Ms: 20_000, samples: 2 });
    expect(s.queueWait.samples).toBe(6);
    expect(s.queueWait.p95Ms).toBe(4_000);
    expect(s.minutesRendered).toEqual({ renders: 0.5, previews: 0.25, total: 0.75 });
    expect(s.engines.sampled).toBe(2);
    expect(s.engines.byEngine).toEqual([
      { engine: 'remotion', scenes: 2, totalMs: 10_000, p50Ms: 4_000, p95Ms: 6_000, samples: 2 },
      { engine: 'html', scenes: 1, totalMs: 1_000, p50Ms: 1_000, p95Ms: 1_000, samples: 1 },
    ]);
    expect(s.errors).toEqual([
      { code: 'engine_failed', count: 2, lastAt: iso(at(1, 9) + 5000), stage: 'render', message: 'remotion crashed again' },
      { code: 'storage_unavailable', count: 1, lastAt: iso(at(2, 9) + 5000), stage: 'render', message: 'bucket down' },
    ]);
    expect(s.storage).toMatchObject({ totalBytes: 5_000, renders: { count: 2, bytes: 4_000 } });
  });

  it('hour buckets', async () => {
    const { repos, analytics } = setup();
    await repos.jobs.insert(job('h', NOW - 30 * 60_000), '');
    const s = await analytics.summary({ bucket: 'hour' });
    expect(s.series).toHaveLength(25); // the hour 24 h ago, aligned down, to now
    expect(s.series.reduce((n, p) => n + p.jobs, 0)).toBe(1);
    expect(s.series.at(-1)).toMatchObject({ start: '2026-11-24T15:00:00.000Z', jobs: 1 });
  });

  it(`stops after ${ANALYTICS_SCAN_LIMIT} jobs and says which part of the range the figures cover`, async () => {
    const { repos, analytics } = setup();
    const n = ANALYTICS_SCAN_LIMIT + 50;
    for (let i = 0; i < n; i++) await repos.jobs.insert(job(`j${String(i).padStart(6, '0')}`, NOW - (i + 1) * 60_000, { status: 'failed', error: { code: 'x', message: 'y' } }), '');
    const s = await analytics.summary({});
    expect(s.scan.truncated).toBe(true);
    expect(s.scan.jobs).toBe(ANALYTICS_SCAN_LIMIT);
    expect(s.totals.jobs).toBe(ANALYTICS_SCAN_LIMIT);
    expect(s.scan.coveredFrom).toBe(iso(NOW - ANALYTICS_SCAN_LIMIT * 60_000));
  }, 60_000);

  it('caches manifests (immutable) and storage usage; an unreadable manifest is tried again later', async () => {
    const { repos, analytics, counts } = setup({ run_a: [{ engine: 'html', millis: 500 }], run_b: 'throw' });
    await repos.jobs.insert(job('a', NOW - 60_000), '');
    await repos.jobs.insert(job('b', NOW - 120_000), '');
    const first = await analytics.summary({});
    expect(first.engines).toMatchObject({ renders: 2, sampled: 1 });
    await analytics.summary({});
    // run_a read once (cached), run_b twice (the throw is not cached); storage walked once in 5 minutes.
    expect(counts()).toEqual({ usageCalls: 1, manifestReads: 3 });
  });

  it('webhook health: deliveries per status per endpoint and in total', async () => {
    const { repos, analytics } = setup();
    const t = iso(NOW);
    for (const id of ['whk_a', 'whk_b']) await repos.webhooks.insertEndpoint({ id, name: id === 'whk_a' ? 'Render alerts' : 'Ops chat', type: 'webhook', events: ['*'], enabled: id === 'whk_a', createdAt: t, updatedAt: t });
    const d = (id: string, endpointId: string, status: 'succeeded' | 'dead' | 'pending') => ({ id, endpointId, messageId: id, eventId: `evt_${id}`, eventType: 'job.succeeded', payload: {} as never, status, attempts: 1, nextAttemptAt: t, createdAt: t, updatedAt: t });
    await repos.webhooks.enqueue([d('dlv_1', 'whk_a', 'succeeded'), d('dlv_2', 'whk_a', 'succeeded'), d('dlv_3', 'whk_a', 'dead'), d('dlv_4', 'whk_b', 'pending')]);
    const s = await analytics.summary({});
    expect(s.webhooks.totals).toEqual({ pending: 1, delivering: 0, succeeded: 2, dead: 1, successRate: 0.667 });
    expect(s.webhooks.endpoints).toEqual([
      { id: 'whk_a', name: 'Render alerts', type: 'webhook', enabled: true, counts: { pending: 0, delivering: 0, succeeded: 2, dead: 1 }, successRate: 0.667 },
      { id: 'whk_b', name: 'Ops chat', type: 'webhook', enabled: false, counts: { pending: 1, delivering: 0, succeeded: 0, dead: 0 }, successRate: null },
    ]);
  });
});
