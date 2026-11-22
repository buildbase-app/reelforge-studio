/** Token bucket per key: `perMinute` requests per minute, bursts up to the same number. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number; limit: number }>();

  /** A number, or a function read on every request (the limit is a runtime setting). */
  constructor(private readonly limit: number | (() => number)) {}

  /**
   * Returns 0 if allowed, else seconds to wait. A limit of 0 disables limiting.
   * `override` is the key's own limit (rateLimitPerMinute on the key), if any.
   */
  take(key: string, override?: number, now = Date.now()): number {
    const perMinute = override ?? (typeof this.limit === 'function' ? this.limit() : this.limit);
    if (perMinute <= 0) return 0;
    const rate = perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: perMinute, updated: now, limit: perMinute };
    // A raised limit applies at once (the extra burst is available); a lowered one caps the bucket.
    if (perMinute > b.limit) b.tokens += perMinute - b.limit;
    b.limit = perMinute;
    b.tokens = Math.min(perMinute, b.tokens + (now - b.updated) * rate);
    b.updated = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / rate / 1000);
  }
}

/**
 * The per-key limit shared by every instance (limits.rateLimitStore
 * "database", D-078): one counter row per key and calendar minute,
 * incremented atomically in the database. A key gets at most `perMinute`
 * requests in each minute, whichever instance answers them. If the database
 * cannot be reached the request is let through (it would fail on its own
 * database work anyway) and a warning is logged at most once a minute.
 */
export class DatabaseRateLimiter {
  private lastWarn = 0;

  constructor(
    private readonly hit: (key: string, windowStart: string) => Promise<number>,
    private readonly limit: () => number,
    private readonly warn: (line: string) => void = () => undefined
  ) {}

  async take(key: string, override?: number, now = Date.now()): Promise<number> {
    const perMinute = override ?? this.limit();
    if (perMinute <= 0) return 0;
    const windowStart = Math.floor(now / 60_000) * 60_000;
    let count: number;
    try {
      count = await this.hit(key, new Date(windowStart).toISOString());
    } catch (e) {
      if (now - this.lastWarn >= 60_000) {
        this.lastWarn = now;
        this.warn(`rate limit: the shared counter could not be updated (${(e as Error).message.split('\n').pop()}); requests are not limited until the database answers`);
      }
      return 0;
    }
    return count <= perMinute ? 0 : Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000));
  }
}
