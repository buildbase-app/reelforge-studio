/**
 * Backpressure for an api instance (#307, D-1XX). Under a burst every request used to queue inside the
 * process, behind the database pool (10 connections per api instance by default), with no bound: in the load
 * test 5 000 renders in 30 s left thousands of requests waiting, so CRUD calls answered after the client's
 * 10 s timeout or failed with 500 when the pool's own wait ran out ("timeout exceeded when trying to
 * connect"). Now:
 *
 *   - at most `limits.maxInflightRequests` requests are in progress per instance; one more is answered at
 *     once with 503 `overloaded` and `Retry-After`, before any database work, so a client backs off instead
 *     of piling on; health, readiness and metrics are never refused (an orchestrator must still see the
 *     instance, and its load), and long-polls and event streams are not counted (they wait without a
 *     database connection);
 *   - a request that still runs out of database capacity (no pool connection, or no transaction started,
 *     in time) is a 503 `overloaded` with `Retry-After`, not a 500: nothing was written, and a retry is safe.
 *
 * 503, not 429: 429 means "you, this key, sent too many" (the per-key limits and quotas, D-078); overload is
 * the server's state, the same for every key, and clients and load balancers treat 503 + Retry-After as
 * "try again" (RFC 9110 §15.6.4).
 */

/** Seconds a refused client is asked to wait. Short: the queue in front of it drains in well under a second. */
export const OVERLOAD_RETRY_AFTER_SECONDS = 1;
const EXEMPT = new Set(['/healthz', '/readyz', '/metrics']);
/** Requests that mostly wait without a database connection: long-polls and event streams. */
const waits = (req: Request, url: URL) => url.searchParams.has('wait') || (req.headers.get('accept') ?? '').includes('text/event-stream') || url.pathname.endsWith('/events');

// The server's fetch callback: a request, then whatever the HTTP adapter passes (bindings), handed on unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fetch = (req: Request, ...rest: any[]) => Response | Promise<Response>;

export interface InflightGuard<F extends Fetch = Fetch> {
  fetch: F;
  /** Requests in progress now, and refused so far (for /metrics and tests). */
  stats(): { inflight: number; refused: number };
}

/** Wrap an app's fetch with the in-flight cap; `limit()` is read per request (runtime setting; 0 = off). */
export function inflightGuard<F extends Fetch>(fetch: F, limit: () => number): InflightGuard<F> {
  let inflight = 0;
  let refused = 0;
  return {
    stats: () => ({ inflight, refused }),
    fetch: (async (req: Request, ...rest: unknown[]) => {
      const max = limit();
      const url = new URL(req.url);
      if (EXEMPT.has(url.pathname) || waits(req, url)) return fetch(req, ...rest);
      if (max > 0 && inflight >= max) {
        refused++;
        return overloadedResponse(`the server has ${inflight} requests in progress (limits.maxInflightRequests ${max}); retry after ${OVERLOAD_RETRY_AFTER_SECONDS} s`);
      }
      inflight++;
      try {
        return await fetch(req, ...rest);
      } finally {
        inflight--;
      }
    }) as F,
  };
}

export function overloadedResponse(message: string): Response {
  return new Response(JSON.stringify({ error: { code: 'overloaded', message } }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'retry-after': String(OVERLOAD_RETRY_AFTER_SECONDS) },
  });
}

/**
 * Is this the database running out of capacity for this request (rather than a bug or a broken database)?
 * node-postgres: no pool connection within connectionTimeoutMillis; the MariaDB connector: no connection within
 * acquireTimeout; Prisma: an interactive transaction not started within maxWait (P2028), or its pool timeout (P2024).
 */
export function isDatabaseOverload(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    const msg = String((e as { message?: unknown }).message ?? '');
    if (code === 'P2024' || code === 'P2028') return true;
    if (/timeout exceeded when trying to connect|Unable to start a transaction in the given time|retrieve connection from pool timeout|pool timeout/i.test(msg)) return true;
  }
  return false;
}
