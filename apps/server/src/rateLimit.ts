/**
 * Request limits (D-078, #305). Every check returns a RateDecision, from which
 * the server writes the IETF `RateLimit-*` fields and, when refused,
 * `Retry-After` (rateLimitHeaders).
 */
export interface RateDecision {
  allowed: boolean;
  /** Requests per minute; 0: not limited (no headers are sent). */
  limit: number;
  /** Requests left now (after this one, if it was allowed). */
  remaining: number;
  /** Seconds until the full quota is available again. */
  resetSeconds: number;
  /** Seconds to wait before the next request can pass (0 when this one passed). */
  retryAfterSeconds: number;
}

const UNLIMITED: RateDecision = Object.freeze({ allowed: true, limit: 0, remaining: 0, resetSeconds: 0, retryAfterSeconds: 0 });

/** The response headers of a decision: RateLimit-Limit/-Remaining/-Reset and RateLimit-Policy (draft-ietf-httpapi-ratelimit-headers), Retry-After when refused. */
export function rateLimitHeaders(d: RateDecision): Record<string, string> {
  if (d.limit <= 0) return {};
  return {
    'RateLimit-Limit': String(d.limit),
    'RateLimit-Remaining': String(Math.max(0, Math.floor(d.remaining))),
    'RateLimit-Reset': String(Math.max(0, Math.ceil(d.resetSeconds))),
    'RateLimit-Policy': `${d.limit};w=60`,
    ...(d.allowed ? {} : { 'Retry-After': String(Math.max(1, Math.ceil(d.retryAfterSeconds))) }),
  };
}

/** Token bucket per key: `perMinute` requests per minute, bursts up to the same number. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number; limit: number }>();

  /** A number, or a function read on every request (the limit is a runtime setting). */
  constructor(private readonly limit: number | (() => number)) {}

  /** A limit of 0 disables limiting. `override` is the key's own limit (rateLimitPerMinute on the key), if any. */
  take(key: string, override?: number, now = Date.now()): RateDecision {
    const perMinute = override ?? (typeof this.limit === 'function' ? this.limit() : this.limit);
    if (perMinute <= 0) return UNLIMITED;
    const rate = perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: perMinute, updated: now, limit: perMinute };
    // A raised limit applies at once (the extra burst is available); a lowered one caps the bucket.
    if (perMinute > b.limit) b.tokens += perMinute - b.limit;
    b.limit = perMinute;
    b.tokens = Math.min(perMinute, b.tokens + (now - b.updated) * rate);
    b.updated = now;
    this.buckets.set(key, b);
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    return {
      allowed,
      limit: perMinute,
      remaining: Math.floor(b.tokens),
      resetSeconds: (perMinute - b.tokens) / rate / 1000,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)),
    };
  }

  /** Buckets held. */
  get size(): number {
    return this.buckets.size;
  }

  /** Above `max` buckets: drop the full ones (a new bucket starts full anyway), then the oldest, down to 90 % of `max`. */
  prune(now: number, max: number): void {
    if (this.buckets.size <= max) return;
    const target = Math.floor(max * 0.9);
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((now - b.updated) * b.limit) / 60_000 >= b.limit) this.buckets.delete(k);
    }
    for (const k of this.buckets.keys()) {
      if (this.buckets.size <= target) break;
      this.buckets.delete(k);
    }
  }
}

const WINDOW = 60_000;

/**
 * The sliding-window estimate of the last 60 s (#305): this minute's count plus
 * the previous minute's, weighted by how much of it still lies inside the last
 * 60 s. `count` includes the request being checked.
 */
export function slidingWindow(perMinute: number, count: number, previous: number, now: number): RateDecision {
  const windowStart = Math.floor(now / WINDOW) * WINDOW;
  const elapsed = now - windowStart;
  const weight = 1 - elapsed / WINDOW;
  const used = previous * weight + count;
  const allowed = used <= perMinute;
  const toWindowEnd = windowStart + WINDOW - now;
  // When is one more request inside the limit? While the previous minute still weighs: when its share has shrunk
  // enough; otherwise in the next minute, once this minute's share (count) has shrunk enough.
  let retryMs = 0;
  if (!allowed) {
    const room = perMinute - count; // what the previous minute's share must fall to (before counting the next request)
    if (room >= 1 && previous > 0) retryMs = (1 - (room - 1) / previous) * WINDOW - elapsed;
    else retryMs = toWindowEnd + Math.max(0, 1 - (perMinute - 1) / Math.max(count, 1)) * WINDOW;
  }
  // Full quota again: this minute's requests have slid out (the previous minute's are gone by then too).
  const resetMs = count > 0 ? toWindowEnd + WINDOW : previous > 0 ? toWindowEnd : 0;
  return {
    allowed,
    limit: perMinute,
    remaining: Math.max(0, Math.floor(perMinute - used)),
    resetSeconds: resetMs / 1000,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(retryMs / 1000)),
  };
}

/**
 * The per-key limit shared by every instance (limits.rateLimitStore
 * "database", D-078): a sliding window over the last 60 s (#305), from one
 * counter row per key and calendar minute. One statement per request counts it
 * and reads the previous minute's count (RateLimitRepository.slide), so a burst
 * at a minute boundary can no longer reach twice the limit. If the database
 * cannot be reached the request is let through (it would fail on its own
 * database work anyway) and a warning is logged at most once a minute.
 */
export class DatabaseRateLimiter {
  private lastWarn = 0;

  constructor(
    private readonly slide: (key: string, windowStart: string, previousStart: string) => Promise<{ count: number; previous: number }>,
    private readonly limit: () => number,
    private readonly warn: (line: string) => void = () => undefined
  ) {}

  async take(key: string, override?: number, now = Date.now()): Promise<RateDecision> {
    const perMinute = override ?? this.limit();
    if (perMinute <= 0) return UNLIMITED;
    const windowStart = Math.floor(now / WINDOW) * WINDOW;
    let r: { count: number; previous: number };
    try {
      r = await this.slide(key, new Date(windowStart).toISOString(), new Date(windowStart - WINDOW).toISOString());
    } catch (e) {
      if (now - this.lastWarn >= WINDOW) {
        this.lastWarn = now;
        this.warn(`rate limit: the shared counter could not be updated (${(e as Error).message.split('\n').pop()}); requests are not limited until the database answers`);
      }
      return UNLIMITED;
    }
    return slidingWindow(perMinute, r.count, r.previous, now);
  }
}
