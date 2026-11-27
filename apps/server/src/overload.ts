/**
 * Backpressure for an api instance (#307, D-117). Under a burst every request used to queue inside the
 * process, behind the database pool (10 connections per api instance by default), with no bound: in the load
 * test 5 000 renders in 30 s left thousands of requests waiting, so CRUD calls answered after the client's
 * 10 s timeout or failed with 500 when the pool's own wait ran out ("timeout exceeded when trying to
 * connect"). Now:
 *
 *   - at most `limits.maxInflightRequests` requests are in progress per instance; one more waits up to
 *     `limits.inflightWaitMs` for a slot (first come first served), then is answered with 503 `overloaded` and
 *     `Retry-After`, before any database work, so a client backs off instead of piling on; health, readiness and metrics are never refused (an orchestrator must still see the
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
/**
 * Requests that mostly wait without a database connection: long-polls and event streams. Only reads: a GET
 * with `?wait=` or an event-stream GET, and on /mcp a single `get_job` call with `waitSeconds` (the MCP
 * long-poll). Every other MCP POST is counted, although MCP clients send `Accept: application/json,
 * text/event-stream` on every request.
 */
const waitingRead = (req: Request, url: URL): boolean =>
  req.method === 'GET' && (url.searchParams.has('wait') || (req.headers.get('accept') ?? '').includes('text/event-stream') || url.pathname.endsWith('/events'));

/** A long-poll body is a few hundred bytes; anything larger, or not exactly one get_job call that waits, is counted. */
const MCP_LONG_POLL_MAX_BYTES = 4096;

/** A POST /mcp small enough to be a long-poll: only those bodies are read before the cap (from a clone). */
function mayBeMcpLongPoll(req: Request, url: URL): boolean {
  if (req.method !== 'POST' || url.pathname !== '/mcp') return false;
  const declared = Number(req.headers.get('content-length'));
  return Number.isFinite(declared) && declared > 0 && declared <= MCP_LONG_POLL_MAX_BYTES;
}

/** Whether a POST /mcp body is one JSON-RPC `tools/call` of `get_job` with `waitSeconds` > 0 (read from a clone). */
export async function isMcpLongPoll(req: Request): Promise<boolean> {
  try {
    const m = JSON.parse(await req.clone().text()) as { method?: unknown; params?: { name?: unknown; arguments?: { waitSeconds?: unknown } } };
    return !Array.isArray(m) && m.method === 'tools/call' && m.params?.name === 'get_job' && Number(m.params?.arguments?.waitSeconds) > 0;
  } catch {
    return false;
  }
}

// The server's fetch callback: a request, then whatever the HTTP adapter passes (bindings), handed on unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fetch = (req: Request, ...rest: any[]) => Response | Promise<Response>;

export interface InflightGuard<F extends Fetch = Fetch> {
  fetch: F;
  /** Requests in progress now, waiting for a slot now, and refused so far (for tests). */
  stats(): { inflight: number; refused: number; waiting: number };
}

/**
 * Wrap an app's fetch with the in-flight cap. `limit()` (0 = off) and `waitMs()` are read per request (runtime
 * settings). A request over the cap waits up to `waitMs()` for a slot, first come first served, so a short burst
 * is absorbed without letting more requests at the database pool; then it is refused with 503.
 */
export function inflightGuard<F extends Fetch>(fetch: F, limit: () => number, waitMs: () => number = () => 0): InflightGuard<F> {
  let inflight = 0;
  let refused = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    // The slot goes straight to the next waiter (in-flight unchanged), else it is free.
    if (next) next();
    else inflight--;
  };
  /** Wait up to `wait` ms for a slot handed over by release(); false when the wait runs out. */
  const queue = (wait: number) =>
    new Promise<boolean>((ok) => {
      const grant = () => {
        clearTimeout(timer);
        ok(true);
      };
      const timer = setTimeout(() => {
        const i = waiting.indexOf(grant);
        if (i >= 0) waiting.splice(i, 1);
        ok(false);
      }, wait);
      waiting.push(grant);
    });
  return {
    stats: () => ({ inflight, refused, waiting: waiting.length }),
    fetch: ((req: Request, ...rest: unknown[]) => {
      const url = new URL(req.url);
      if (EXEMPT.has(url.pathname) || waitingRead(req, url)) return fetch(req, ...rest);
      if (mayBeMcpLongPoll(req, url)) return isMcpLongPoll(req).then((longPoll) => (longPoll ? fetch(req, ...rest) : admit(req, rest)));
      return admit(req, rest);
    }) as F,
  };

  /** Into a slot at once when one is free (no extra tick), else wait for one, or refuse. */
  function admit(req: Request, rest: unknown[]) {
    const max = limit() > 0 ? limit() : Infinity;
    const run = async () => {
      try {
        return await fetch(req, ...rest);
      } finally {
        release();
      }
    };
    const refuse = () => {
      refused++;
      return overloadedResponse(`the server has ${inflight} requests in progress (limits.maxInflightRequests ${max}); retry after ${OVERLOAD_RETRY_AFTER_SECONDS} s`);
    };
    // A free slot: in at once (no extra tick). Else wait for one, or refuse when waiting is off.
    if (inflight < max) {
      inflight++;
      return run();
    }
    const wait = waitMs();
    if (wait <= 0) return refuse();
    return queue(wait).then((granted) => (granted ? run() : refuse()));
  }
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
