/** Token bucket per key: `perMinute` requests per minute, bursts up to the same number. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(private readonly perMinute: number) {}

  /** Returns 0 if allowed, else seconds to wait. A limit of 0 disables limiting. */
  take(key: string, now = Date.now()): number {
    if (this.perMinute <= 0) return 0;
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, updated: now };
    b.tokens = Math.min(this.perMinute, b.tokens + (now - b.updated) * rate);
    b.updated = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / rate / 1000);
  }
}
