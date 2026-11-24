import { badRequest } from './errors';
import type { JobRecord, JobRepository } from './repositories';
import type { DeliveryStatus, WebhookRepository } from './webhooks/types';

/**
 * Analytics for the dashboard and agents (get_analytics_summary, GET
 * /v1/analytics/summary; #292). Read from what the studio already records,
 * never from a separate store:
 *
 *   - the Job table: renders per day by status, success and failure rates,
 *     queue wait, job render time, minutes rendered and the top error codes.
 *     Walked newest first from `to` with the keyset page query (index
 *     workspaceId, createdAt, id), stopping at `from` or after SCAN_LIMIT rows;
 *   - render manifests (immutable once written): render time per engine from
 *     each scene's `millis`, for the newest MANIFEST_SAMPLE successful renders
 *     of the range, cached per render;
 *   - storage usage (the same walk as get_storage), cached for USAGE_TTL_MS;
 *   - the webhook outbox: deliveries per status and endpoint (countByStatus).
 *
 * The range is capped (MAX_RANGE_DAYS; hourly buckets MAX_HOURLY_DAYS), so a
 * call costs at most a bounded number of indexed page reads.
 */

export const ANALYTICS_DEFAULT_DAYS = 30;
export const ANALYTICS_MAX_RANGE_DAYS = 90;
export const ANALYTICS_MAX_HOURLY_DAYS = 7;
/** Jobs read per call at most (units and joins of fanned-out renders count too). */
export const ANALYTICS_SCAN_LIMIT = 20_000;
const PAGE_SIZE = 1000;
/** Successful renders whose manifests are read for render time per engine. */
export const ANALYTICS_MANIFEST_SAMPLE = 200;
const MANIFEST_CACHE = 2000;
const MANIFEST_CONCURRENCY = 8;
const USAGE_TTL_MS = 5 * 60_000;
const MAX_ENDPOINTS = 50;
const TOP_ERRORS = 10;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type AnalyticsBucket = 'day' | 'hour';

export interface AnalyticsRange {
  from: string;
  to: string;
  bucket: AnalyticsBucket;
}

export interface AnalyticsPoint {
  /** Start of the bucket (UTC). */
  start: string;
  /** Render and preview jobs created in the bucket. */
  jobs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** Still queued or running. */
  unfinished: number;
}

export interface Percentiles {
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
}

export interface AnalyticsSummary {
  range: AnalyticsRange & { maxRangeDays: number };
  generatedAt: string;
  /** Jobs read. `truncated`: the scan stopped at the limit; the figures then cover `coveredFrom` to `to` only. */
  scan: { jobs: number; limit: number; truncated: boolean; coveredFrom: string };
  totals: AnalyticsPoint & { renders: number; previews: number; successRate: number | null; failureRate: number | null };
  series: AnalyticsPoint[];
  /** Start to finish of successful render and preview jobs. */
  renderTime: Percentiles;
  /** Created to started (the time a job waited for a render slot). */
  queueWait: Percentiles;
  /** Scene render time by engine, from the manifests of the newest successful renders in the range. */
  engines: { renders: number; sampled: number; byEngine: Array<Percentiles & { engine: string; scenes: number; totalMs: number }> };
  /** Length of the successful outputs, in minutes. */
  minutesRendered: { renders: number; previews: number; total: number };
  storage: { measuredAt: string; totalBytes: number; renders: { count: number; bytes: number }; assets: { objects: number; bytes: number } } | { measuredAt: string; error: string };
  errors: Array<{ code: string; count: number; lastAt: string; stage?: string; message: string }>;
  /** Deliveries kept by the outbox retention (not limited to the range), per endpoint and in total. */
  webhooks: {
    totals: Record<DeliveryStatus, number> & { successRate: number | null };
    endpoints: Array<{ id: string; name: string; type: string; enabled: boolean; counts: Record<DeliveryStatus, number>; successRate: number | null }>;
  };
}

export interface StorageUsageReport {
  totalBytes: number;
  renders: { count: number; bytes: number };
  assets: { objects: number; bytes: number };
}

export interface AnalyticsDeps {
  /** The keyset page query of jobs (JobRepository.page, or the runner's, which overlays live in-process state). */
  jobs: Pick<JobRepository, 'page'>;
  webhooks: Pick<WebhookRepository, 'listEndpoints' | 'countByStatus'>;
  /** storage.usage(): walks the render and asset prefixes. */
  storageUsage(): Promise<StorageUsageReport>;
  /** The render manifest, or null when it is gone (retention). */
  readManifest(projectId: string, runId: string): Promise<{ scenes?: Array<{ engine?: unknown; millis?: unknown }> } | null>;
  now(): number;
}

function parseTime(name: 'from' | 'to', v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 40) throw badRequest(`${name} must be an ISO 8601 time or a date (YYYY-MM-DD, UTC)`);
  const t = Date.parse(DATE_ONLY.test(v) ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(t)) throw badRequest(`${name} must be an ISO 8601 time or a date (YYYY-MM-DD, UTC), got ${JSON.stringify(v)}`);
  // A date as `to` means "to the end of that day".
  return name === 'to' && DATE_ONLY.test(v) ? t + DAY : t;
}

/**
 * from / to (ISO time or UTC date; `to` exclusive, a date includes its day)
 * and bucket (day or hour). Defaults: the last 30 days by day, today included.
 * `from` is aligned down to its bucket. Throws bad_request.
 */
export function parseAnalyticsQuery(q: Record<string, unknown>, now: number): { from: number; to: number; bucket: AnalyticsBucket } {
  const bucket = q.bucket === undefined || q.bucket === '' ? 'day' : q.bucket;
  if (bucket !== 'day' && bucket !== 'hour') throw badRequest('bucket must be "day" or "hour"');
  const size = bucket === 'day' ? DAY : HOUR;
  const to = parseTime('to', q.to) ?? now;
  const defaultFrom = bucket === 'day' ? Math.floor(to / DAY) * DAY - (ANALYTICS_DEFAULT_DAYS - 1) * DAY : to - 24 * HOUR;
  const from = Math.floor((parseTime('from', q.from) ?? defaultFrom) / size) * size;
  if (from >= to) throw badRequest('from must be before to');
  const maxDays = bucket === 'day' ? ANALYTICS_MAX_RANGE_DAYS : ANALYTICS_MAX_HOURLY_DAYS;
  if (to - from > maxDays * DAY) {
    throw badRequest(`the range is ${Math.ceil((to - from) / DAY)} days; at most ${maxDays} days with bucket "${bucket}"${bucket === 'hour' ? ` (use bucket "day" for up to ${ANALYTICS_MAX_RANGE_DAYS} days)` : ''}`);
  }
  return { from, to, bucket };
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function percentiles(values: number[]): Percentiles {
  const s = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  return { p50Ms: percentile(s, 50), p95Ms: percentile(s, 95), samples: s.length };
}

const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
const emptyPoint = (start: string): AnalyticsPoint => ({ start, jobs: 0, succeeded: 0, failed: 0, cancelled: 0, unfinished: 0 });
const runIdOf = (j: JobRecord) => (typeof j.params.runId === 'string' ? j.params.runId : typeof j.result?.renderId === 'string' ? j.result.renderId : undefined);

export class Analytics {
  private manifests = new Map<string, Array<{ engine: string; millis: number }> | null>();
  private usage: { at: number; value: AnalyticsSummary['storage'] } | null = null;
  private usageRun: Promise<AnalyticsSummary['storage']> | null = null;

  constructor(private readonly deps: AnalyticsDeps) {}

  async summary(query: Record<string, unknown> = {}): Promise<AnalyticsSummary> {
    const now = this.deps.now();
    const { from, to, bucket } = parseAnalyticsQuery(query, now);
    const [scan, storage, webhooks] = await Promise.all([this.scan(from, to), this.storage(now), this.webhookHealth()]);
    const size = bucket === 'day' ? DAY : HOUR;

    const series: AnalyticsPoint[] = [];
    for (let t = from; t < to; t += size) series.push(emptyPoint(new Date(t).toISOString()));
    const totals = { ...emptyPoint(new Date(from).toISOString()), renders: 0, previews: 0 };
    const renderMs: number[] = [];
    const waitMs: number[] = [];
    const minutes = { renders: 0, previews: 0 };
    const errors = new Map<string, AnalyticsSummary['errors'][number]>();
    const succeeded: JobRecord[] = [];

    for (const j of scan.jobs) {
      const point = series[Math.floor((Date.parse(j.createdAt) - from) / size)];
      if (!point) continue;
      const bump = (p: AnalyticsPoint) => {
        p.jobs++;
        if (j.status === 'succeeded') p.succeeded++;
        else if (j.status === 'failed') p.failed++;
        else if (j.status === 'cancelled') p.cancelled++;
        else p.unfinished++;
      };
      bump(point);
      bump(totals);
      if (j.type === 'preview') totals.previews++;
      else totals.renders++;
      if (j.startedAt) waitMs.push(Date.parse(j.startedAt) - Date.parse(j.createdAt));
      if (j.status === 'succeeded') {
        succeeded.push(j);
        if (j.startedAt && j.finishedAt) renderMs.push(Date.parse(j.finishedAt) - Date.parse(j.startedAt));
        const seconds = Number(j.result?.durationSeconds);
        if (Number.isFinite(seconds) && seconds > 0) minutes[j.type === 'preview' ? 'previews' : 'renders'] += seconds / 60;
      }
      if (j.status === 'failed' && j.error) {
        const code = j.error.code || 'unknown';
        const e = errors.get(code);
        const at = j.finishedAt ?? j.createdAt;
        if (!e) errors.set(code, { code, count: 1, lastAt: at, ...(j.error.stage ? { stage: j.error.stage } : {}), message: j.error.message.slice(0, 300) });
        else {
          e.count++;
          // Jobs come newest first: the first one seen is the latest; keep its message.
          if (at > e.lastAt) e.lastAt = at;
        }
      }
    }

    const round = (n: number) => Math.round(n * 1000) / 1000;
    return {
      range: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket, maxRangeDays: bucket === 'day' ? ANALYTICS_MAX_RANGE_DAYS : ANALYTICS_MAX_HOURLY_DAYS },
      generatedAt: new Date(now).toISOString(),
      scan: { jobs: scan.read, limit: ANALYTICS_SCAN_LIMIT, truncated: scan.truncated, coveredFrom: new Date(scan.truncated ? scan.coveredFrom : from).toISOString() },
      totals: { ...totals, successRate: rate(totals.succeeded, totals.succeeded + totals.failed), failureRate: rate(totals.failed, totals.succeeded + totals.failed) },
      series,
      renderTime: percentiles(renderMs),
      queueWait: percentiles(waitMs),
      engines: await this.engines(succeeded),
      minutesRendered: { renders: round(minutes.renders), previews: round(minutes.previews), total: round(minutes.renders + minutes.previews) },
      storage,
      errors: [...errors.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, TOP_ERRORS),
      webhooks,
    };
  }

  /** Top-level render and preview jobs created in [from, to), newest first, through the keyset page query. */
  private async scan(from: number, to: number): Promise<{ jobs: JobRecord[]; read: number; truncated: boolean; coveredFrom: number }> {
    const fromIso = new Date(from).toISOString();
    const out: JobRecord[] = [];
    // Strictly older than (to, ""): every job created before `to`.
    let after = { createdAt: new Date(to).toISOString(), id: '' };
    let read = 0;
    let coveredFrom = to;
    for (;;) {
      const limit = Math.min(PAGE_SIZE, ANALYTICS_SCAN_LIMIT - read);
      if (limit <= 0) return { jobs: out, read, truncated: true, coveredFrom };
      const rows = await this.deps.jobs.page({}, { limit, after });
      for (const j of rows) {
        if (j.createdAt < fromIso) return { jobs: out, read, truncated: false, coveredFrom: from };
        read++;
        coveredFrom = Date.parse(j.createdAt);
        // Units and joins of a fanned-out render (UNIT_JOB_TYPE, JOIN_JOB_TYPE) count toward the scan, not the figures.
        if ((j.type === 'render' || j.type === 'preview') && !j.parentId) out.push(j);
      }
      if (rows.length < limit) return { jobs: out, read, truncated: false, coveredFrom: from };
      const last = rows[rows.length - 1]!;
      after = { createdAt: last.createdAt, id: last.id };
    }
  }

  /** Scene time per engine from the manifests of the newest successful renders (cached: a manifest never changes). */
  private async engines(succeeded: JobRecord[]): Promise<AnalyticsSummary['engines']> {
    const sample = succeeded.filter((j) => j.projectId && runIdOf(j)).slice(0, ANALYTICS_MANIFEST_SAMPLE);
    const queue = [...sample];
    const scenes: Array<{ engine: string; millis: number }> = [];
    let sampled = 0;
    const worker = async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        const list = await this.manifestScenes(j.projectId!, runIdOf(j)!);
        if (!list) continue;
        sampled++;
        scenes.push(...list);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MANIFEST_CONCURRENCY, queue.length) }, worker));
    const by = new Map<string, number[]>();
    for (const s of scenes) by.set(s.engine, [...(by.get(s.engine) ?? []), s.millis]);
    const byEngine = [...by.entries()]
      .map(([engine, ms]) => ({ engine, scenes: ms.length, totalMs: ms.reduce((n, x) => n + x, 0), ...percentiles(ms) }))
      .sort((a, b) => b.totalMs - a.totalMs || a.engine.localeCompare(b.engine));
    return { renders: succeeded.length, sampled, byEngine };
  }

  private async manifestScenes(projectId: string, runId: string): Promise<Array<{ engine: string; millis: number }> | null> {
    if (this.manifests.has(runId)) return this.manifests.get(runId)!;
    let list: Array<{ engine: string; millis: number }> | null = null;
    try {
      const m = await this.deps.readManifest(projectId, runId);
      if (m) {
        list = (Array.isArray(m.scenes) ? m.scenes : [])
          .filter((s) => typeof s.engine === 'string' && typeof s.millis === 'number' && Number.isFinite(s.millis) && s.millis >= 0)
          .map((s) => ({ engine: (s.engine as string).slice(0, 64), millis: s.millis as number }));
      }
    } catch {
      return null; // unreadable now (storage down): not cached, tried again next time
    }
    if (this.manifests.size >= MANIFEST_CACHE) this.manifests.delete(this.manifests.keys().next().value!);
    this.manifests.set(runId, list);
    return list;
  }

  private async storage(now: number): Promise<AnalyticsSummary['storage']> {
    if (this.usage && now - this.usage.at < USAGE_TTL_MS) return this.usage.value;
    // One walk at a time; concurrent calls share it.
    this.usageRun ??= (async () => {
      const measuredAt = new Date(this.deps.now()).toISOString();
      try {
        const u = await this.deps.storageUsage();
        return { measuredAt, totalBytes: u.totalBytes, renders: { count: u.renders.count, bytes: u.renders.bytes }, assets: { objects: u.assets.objects, bytes: u.assets.bytes } };
      } catch (e) {
        return { measuredAt, error: (e as Error).message };
      }
    })().finally(() => (this.usageRun = null));
    const value = await this.usageRun;
    this.usage = { at: now, value };
    return value;
  }

  private async webhookHealth(): Promise<AnalyticsSummary['webhooks']> {
    const endpoints = (await this.deps.webhooks.listEndpoints()).slice(0, MAX_ENDPOINTS);
    const zero = (): Record<DeliveryStatus, number> => ({ pending: 0, delivering: 0, succeeded: 0, dead: 0 });
    const totals = zero();
    const rows = await Promise.all(
      endpoints.map(async (ep) => {
        const counts = { ...zero(), ...(await this.deps.webhooks.countByStatus(ep.id)) };
        for (const k of Object.keys(totals) as DeliveryStatus[]) totals[k] += counts[k];
        return { id: ep.id, name: ep.name, type: ep.type, enabled: ep.enabled, counts, successRate: rate(counts.succeeded, counts.succeeded + counts.dead) };
      })
    );
    return { totals: { ...totals, successRate: rate(totals.succeeded, totals.succeeded + totals.dead) }, endpoints: rows };
  }
}
