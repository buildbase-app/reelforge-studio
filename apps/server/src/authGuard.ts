import { ipv6Groups } from '@reelforge/core';
import { RateLimiter, type RateDecision } from './rateLimit';

/** limits.preAuth* settings (runtime: read on every request). */
export interface PreAuthSettings {
  /** Requests per minute per client address before the key lookup (0: off). */
  perMinute: number;
  /** Failed authentications per minute per client address; the one that uses them up starts a lockout (0: no lockout). */
  failuresPerMinute: number;
  /** First lockout; each further one doubles it. */
  lockoutSeconds: number;
  /** Longest lockout. */
  lockoutMaxSeconds: number;
}

export type PreAuthVerdict = { allowed: true; decision?: RateDecision } | { allowed: false; scope: 'client_ip' | 'auth_failures'; decision: RateDecision };

interface Failures {
  tokens: number;
  updated: number;
  /** Lockouts so far (the next one lasts lockoutSeconds * 2^strikes, capped). */
  strikes: number;
  lockedUntil: number;
  lastFailure: number;
}

/**
 * The client a limit counts against: the address itself for IPv4, its /64 for
 * IPv6 (one host usually holds a whole /64, so per-address limits would be
 * trivial to sidestep). Unknown when the request did not come over TCP.
 */
export function limiterClient(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const g = ip.includes(':') ? ipv6Groups(ip) : null;
  return g ? `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64` : ip;
}

/**
 * The limits that run before the API key lookup (#305), per client address
 * (server.trustProxy decides which one): a general request budget, and a
 * separate budget for failed authentications with an exponential lockout. A
 * refused request costs no database work. State is per instance and in memory
 * (a shared store would put a database write back in front of every
 * unauthenticated request), bounded to `maxClients` addresses.
 */
export class PreAuthGuard {
  private readonly requests: RateLimiter;
  private readonly failures = new Map<string, Failures>();

  constructor(
    private readonly settings: () => PreAuthSettings,
    private readonly maxClients = 100_000
  ) {
    this.requests = new RateLimiter(() => this.settings().perMinute);
  }

  /** Before the key lookup. Requests without a known client address (not served over TCP) are not limited. */
  check(ip: string | undefined, now = Date.now()): PreAuthVerdict {
    const client = limiterClient(ip);
    if (!client) return { allowed: true };
    const s = this.settings();
    const f = this.failures.get(client);
    if (f && f.lockedUntil > now) {
      const wait = (f.lockedUntil - now) / 1000;
      return { allowed: false, scope: 'auth_failures', decision: { allowed: false, limit: s.failuresPerMinute, remaining: 0, resetSeconds: wait, retryAfterSeconds: Math.ceil(wait) } };
    }
    const decision = this.requests.take(client, undefined, now);
    this.prune(now);
    return decision.allowed ? { allowed: true, decision } : { allowed: false, scope: 'client_ip', decision };
  }

  /** A failed authentication from this client (unknown, revoked or expired key, or none). Returns the lockout in seconds when it starts one. */
  failure(ip: string | undefined, now = Date.now()): number {
    const client = limiterClient(ip);
    const s = this.settings();
    if (!client || s.failuresPerMinute <= 0) return 0;
    const per = s.failuresPerMinute;
    let f = this.failures.get(client);
    // A client quiet for longer than the longest lockout starts over.
    if (f && now - f.lastFailure > s.lockoutMaxSeconds * 1000 && f.lockedUntil <= now) f = undefined;
    f ??= { tokens: per, updated: now, strikes: 0, lockedUntil: 0, lastFailure: now };
    f.tokens = Math.min(per, f.tokens + ((now - f.updated) * per) / 60_000);
    f.updated = now;
    f.lastFailure = now;
    this.failures.delete(client); // re-insert: the map's order is least recently failed first (pruning)
    this.failures.set(client, f);
    f.tokens = Math.max(0, f.tokens - 1);
    // The failure that uses up the budget starts the lockout: the next request from this address needs no lookup.
    if (f.tokens >= 1) return 0;
    const seconds = Math.min(s.lockoutMaxSeconds, s.lockoutSeconds * 2 ** f.strikes);
    f.strikes++;
    f.lockedUntil = now + seconds * 1000;
    return seconds;
  }

  /** Clients tracked (tests, metrics). */
  get size(): { requests: number; failures: number } {
    return { requests: this.requests.size, failures: this.failures.size };
  }

  private prune(now: number): void {
    this.requests.prune(now, this.maxClients);
    if (this.failures.size <= this.maxClients) return;
    const target = Math.floor(this.maxClients * 0.9);
    const maxMs = this.settings().lockoutMaxSeconds * 1000;
    for (const [k, f] of this.failures) {
      if (f.lockedUntil <= now && now - f.lastFailure > maxMs) this.failures.delete(k);
    }
    // Still too many: drop the least recently failed (a locked-out client may be among them; it only loses its lockout).
    for (const k of this.failures.keys()) {
      if (this.failures.size <= target) break;
      this.failures.delete(k);
    }
  }
}
