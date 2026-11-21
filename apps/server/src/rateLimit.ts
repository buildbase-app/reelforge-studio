/** Token bucket per key: `perMinute` requests per minute, bursts up to the same number. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number; limit: number }>();

  /** A number, or a function read on every request (the limit is a runtime setting). */
  constructor(private readonly limit: number | (() => number)) {}

  /** Returns 0 if allowed, else seconds to wait. A limit of 0 disables limiting. */
  take(key: string, now = Date.now()): number {
    const perMinute = typeof this.limit === 'function' ? this.limit() : this.limit;
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
