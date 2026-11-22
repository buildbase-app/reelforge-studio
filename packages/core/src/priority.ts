import type { RateLimitRepository } from './repositories';

/**
 * Job priorities and admission by estimated wait (issue #155, D-103).
 *
 * Classes, highest first: `interactive` (previews by default) > `standard`
 * (renders by default) > `batch`. Stored as their rank (0, 1, 2) so the claim
 * can order by the column. The claim order is: effective class, then fairness
 * across keys (fewest running jobs first, D-090), then age. A `batch` job that
 * has waited `queue.priorityAgingSeconds` counts as `standard` (never as
 * `interactive`), so batch work is not starved by a steady stream of renders.
 */
export const PRIORITIES = ['interactive', 'standard', 'batch'] as const;
export type JobPriority = (typeof PRIORITIES)[number];

/** The class a job type gets when the request names none (clamped to the key's maximum). */
export const DEFAULT_PRIORITY: Readonly<Record<string, JobPriority>> = { preview: 'interactive', render: 'standard' };
export const defaultPriority = (type: string): JobPriority => DEFAULT_PRIORITY[type] ?? 'standard';

export const isPriority = (v: unknown): v is JobPriority => typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v);
/** 0 = interactive (claimed first) .. 2 = batch. Unknown or missing: standard. */
export const priorityRank = (p: JobPriority | undefined): number => (p ? PRIORITIES.indexOf(p) : 1);
export const priorityOfRank = (n: number | null | undefined): JobPriority => PRIORITIES[n ?? 1] ?? 'standard';
/** The lower of two classes (the one claimed later). */
export const lowerPriority = (a: JobPriority, b: JobPriority): JobPriority => (priorityRank(a) >= priorityRank(b) ? a : b);

/** The rank `batch` is promoted to after aging. */
export const AGED_RANK = 1;

/**
 * The rank the claim orders by: a `batch` job queued before `now - agingSeconds` counts as `standard`.
 * `agingSeconds` 0 or unset: strict classes. Every repository applies the same rule (in SQL or here).
 */
export function effectiveRank(rank: number, createdAtMs: number, nowMs: number, agingSeconds?: number): number {
  if (rank > AGED_RANK && agingSeconds && agingSeconds > 0 && createdAtMs < nowMs - agingSeconds * 1000) return AGED_RANK;
  return rank;
}

// ---- admission by estimated wait ---------------------------------------------

/**
 * The estimated queue wait of a new job (D-103), from two measured signals:
 *   - the queue head: how long the oldest job that would be claimed before it
 *     (same or higher class) has already waited;
 *   - the drain time: jobs ahead / measured claim throughput (claims per second
 *     across the deployment, a decayed average of the last minutes).
 * The estimate is the smaller of the two. Each alone misleads: the throughput is
 * limited by demand after an idle period (the drain time is then too long), and
 * the head can be one job held back by a per-key running cap while everything
 * else flows (the head age is then too long). Both are only large together when
 * the queue really waits. Without measured throughput the head age alone counts.
 */
export function estimateWaitSeconds(s: { ahead: number; oldestQueuedAt?: string | null; claimsPerSecond: number; nowMs: number }): number {
  if (s.ahead <= 0 || !s.oldestQueuedAt) return 0;
  const head = Math.max(0, (s.nowMs - Date.parse(s.oldestQueuedAt)) / 1000);
  const drain = s.claimsPerSecond > 0 ? s.ahead / s.claimsPerSecond : Infinity;
  return Math.min(head, drain);
}

/** The shared counter every claiming instance adds its claims to (RateLimitWindow, one row per minute; swept after an hour). */
export const CLAIMS_COUNTER_KEY = 'stats:claims';
const WINDOW_MS = 60_000;
/** How far back the throughput looks, and how fast older minutes fade. */
const HORIZON_MS = 10 * WINDOW_MS;
const HALF_LIFE_MS = 2 * WINDOW_MS;

/**
 * Claims per second from per-minute counts: an exponentially decayed average
 * (half-life 2 min) over the last 10 minutes. Minutes without a row count as 0.
 */
export function decayedRate(windows: Array<{ windowStart: string; count: number }>, nowMs: number): number {
  const counts = new Map(windows.map((w) => [Date.parse(w.windowStart), w.count]));
  let num = 0;
  let den = 0;
  for (let start = Math.floor((nowMs - HORIZON_MS) / WINDOW_MS) * WINDOW_MS; start <= nowMs; start += WINDOW_MS) {
    const len = Math.min(WINDOW_MS, nowMs - start);
    if (len <= 0) continue;
    const w = Math.pow(0.5, (nowMs - (start + len / 2)) / HALF_LIFE_MS);
    num += w * (counts.get(start) ?? 0);
    den += w * (len / 1000);
  }
  return den > 0 ? num / den : 0;
}

/**
 * Claim throughput shared by every instance (D-103): claiming instances add
 * their claims to one counter row per minute (batched, at most one write every
 * few seconds per instance); any instance reads the last minutes to estimate
 * the deployment's claim rate. Reads are cached for a few seconds.
 */
export class ClaimRate {
  private pending = 0;
  private timer: NodeJS.Timeout | null = null;
  private cache: { at: number; value: number } | null = null;
  private readonly now: () => number;
  private readonly flushMs: number;

  constructor(
    private readonly repo: RateLimitRepository,
    opts: { now?: () => number; flushMs?: number; log?: (line: string) => void } = {}
  ) {
    this.now = opts.now ?? Date.now;
    this.flushMs = opts.flushMs ?? 5_000;
    this.log = opts.log ?? (() => undefined);
  }
  private readonly log: (line: string) => void;

  /** A job was claimed on this instance. */
  record(n = 1): void {
    this.pending += n;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
    this.timer.unref();
  }

  /** Write the claims counted since the last flush (also on shutdown). Never throws; a failed write is retried at the next flush. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const n = this.pending;
    if (!n) return;
    this.pending = 0;
    const start = new Date(Math.floor(this.now() / WINDOW_MS) * WINDOW_MS).toISOString();
    try {
      await this.repo.hit(CLAIMS_COUNTER_KEY, start, n);
    } catch (e) {
      this.pending += n;
      this.log(`queue: could not store the claim counter (retrying): ${(e as Error).message}`);
    }
  }

  /** The deployment's claims per second (decayed average of the last 10 minutes; this instance's unflushed claims included). */
  async perSecond(): Promise<number> {
    const now = this.now();
    if (this.cache && now - this.cache.at < this.flushMs) return this.cache.value;
    const rows = await this.repo.windows(CLAIMS_COUNTER_KEY, new Date(now - HORIZON_MS - WINDOW_MS).toISOString());
    if (this.pending) {
      const cur = new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS).toISOString();
      const row = rows.find((r) => Date.parse(r.windowStart) === Date.parse(cur));
      if (row) row.count += this.pending;
      else rows.push({ windowStart: cur, count: this.pending });
    }
    const value = decayedRate(rows, now);
    this.cache = { at: now, value };
    return value;
  }
}
