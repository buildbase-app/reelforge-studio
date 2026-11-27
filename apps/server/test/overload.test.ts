/**
 * Backpressure (#307, D-117): the in-flight cap answers 503 overloaded with Retry-After at once, never refuses
 * health, readiness, metrics, long-polls or event streams, follows the runtime limit, and database capacity
 * errors are told apart from other failures.
 */
import { describe, expect, it } from 'vitest';
import { inflightGuard, isDatabaseOverload, OVERLOAD_RETRY_AFTER_SECONDS } from '../src/overload';

/** A fetch whose requests stay in progress until released. */
function held() {
  const waiting: Array<() => void> = [];
  const fetch = async (req: Request) => {
    await new Promise<void>((ok) => waiting.push(ok));
    return new Response(`ok ${new URL(req.url).pathname}`);
  };
  return { fetch, release: () => waiting.splice(0).forEach((ok) => ok()) };
}
const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://h${path}`, { headers });

describe('in-flight cap', () => {
  it('OVL-01 refuses the request over the limit at once with 503 overloaded and Retry-After; the others complete', async () => {
    const h = held();
    const g = inflightGuard(h.fetch, () => 2);
    const a = g.fetch(get('/v1/projects'));
    const b = g.fetch(get('/v1/projects'));
    const c = await g.fetch(get('/v1/projects'));
    expect(c.status).toBe(503);
    expect(c.headers.get('retry-after')).toBe(String(OVERLOAD_RETRY_AFTER_SECONDS));
    expect(((await c.json()) as { error: { code: string } }).error.code).toBe('overloaded');
    expect(g.stats()).toEqual({ inflight: 2, refused: 1, waiting: 0 });
    h.release();
    expect([(await a).status, (await b).status]).toEqual([200, 200]);
    expect(g.stats().inflight).toBe(0);
    // Capacity is back: the next request is served.
    const d = g.fetch(get('/v1/projects'));
    h.release();
    expect((await d).status).toBe(200);
  });

  it('OVL-02 never refuses health, readiness, metrics, long-polls or event streams, and does not count them', async () => {
    const h = held();
    const g = inflightGuard(h.fetch, () => 1);
    const busy = g.fetch(get('/v1/jobs/j1'));
    const exempt = [get('/healthz'), get('/readyz'), get('/metrics'), get('/v1/jobs/j1?wait=30'), get('/v1/jobs/j1/events'), get('/mcp', { accept: 'application/json, text/event-stream' })].map((r) => g.fetch(r));
    expect(g.stats()).toEqual({ inflight: 1, refused: 0, waiting: 0 });
    h.release();
    for (const r of [busy, ...exempt]) expect((await r).status).toBe(200);
  });

  it('OVL-06 counts every MCP POST although MCP clients accept event streams; only one get_job call that waits is exempt', async () => {
    const h = held();
    const g = inflightGuard(h.fetch, () => 1);
    const mcp = (body: unknown) => {
      const text = JSON.stringify(body);
      return new Request('http://h/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }, body: text });
    };
    const call = (name: string, args: Record<string, unknown> = {}, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    // An ordinary tool call takes the one slot ...
    const busy = g.fetch(mcp(call('list_projects')));
    await Promise.resolve();
    await new Promise((ok) => setTimeout(ok, 0));
    expect(g.stats().inflight).toBe(1);
    // ... so the next ordinary call, a batch that includes a long-poll, a get_job that does not wait and a POST with ?wait= are refused.
    const refused = await Promise.all([
      g.fetch(mcp(call('render_project', { projectId: 'p' }))),
      g.fetch(mcp([call('get_job', { jobId: 'j', waitSeconds: 30 }, 1), call('list_jobs', {}, 2)])),
      g.fetch(mcp(call('get_job', { jobId: 'j' }))),
      g.fetch(new Request('http://h/v1/projects/p/renders?wait=30', { method: 'POST' })),
    ]);
    expect(refused.map((r) => r.status)).toEqual([503, 503, 503, 503]);
    // The MCP long-poll and a GET long-poll wait without a slot.
    const exempt = [g.fetch(mcp(call('get_job', { jobId: 'j', waitSeconds: 30 }))), g.fetch(get('/v1/jobs/j?wait=30'))];
    await new Promise((ok) => setTimeout(ok, 0));
    expect(g.stats()).toEqual({ inflight: 1, refused: 4, waiting: 0 });
    h.release();
    for (const r of [busy, ...exempt]) expect((await r).status).toBe(200);
  });

  it('OVL-03 follows the runtime limit; 0 turns it off', async () => {
    const h = held();
    let limit = 1;
    const g = inflightGuard(h.fetch, () => limit);
    const first = g.fetch(get('/v1/projects'));
    expect((await g.fetch(get('/v1/projects'))).status).toBe(503);
    limit = 0;
    const more = Array.from({ length: 50 }, () => g.fetch(get('/v1/projects')));
    expect(g.stats().inflight).toBe(51);
    h.release();
    for (const r of [first, ...more]) expect((await r).status).toBe(200);
  });
});

describe('waiting for a slot', () => {
  it('OVL-05 a request over the cap waits for a slot, first come first served, and is refused only when the wait runs out', async () => {
    const h = held();
    const g = inflightGuard(h.fetch, () => 1, () => 200);
    const first = g.fetch(get('/v1/a'));
    const second = g.fetch(get('/v1/b'));
    const third = g.fetch(get('/v1/c'));
    await new Promise((r) => setTimeout(r, 10));
    expect(g.stats()).toEqual({ inflight: 1, refused: 0, waiting: 2 });
    h.release(); // the slot goes to /v1/b, then to /v1/c
    expect(await (await first).text()).toBe('ok /v1/a');
    await new Promise((r) => setTimeout(r, 10));
    h.release();
    expect(await (await second).text()).toBe('ok /v1/b');
    await new Promise((r) => setTimeout(r, 10));
    h.release();
    expect(await (await third).text()).toBe('ok /v1/c');
    expect(g.stats()).toEqual({ inflight: 0, refused: 0, waiting: 0 });
    // Nobody frees the slot: the waiter is refused after the wait, and the slot count stays right.
    const busy = g.fetch(get('/v1/d'));
    const t0 = Date.now();
    const late = await g.fetch(get('/v1/e'));
    expect(late.status).toBe(503);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    expect(g.stats()).toEqual({ inflight: 1, refused: 1, waiting: 0 });
    h.release();
    expect((await busy).status).toBe(200);
    expect(g.stats().inflight).toBe(0);
  });
});

describe('database overload', () => {
  it('OVL-04 tells pool and transaction-start timeouts (also as a cause) from other errors', () => {
    expect(isDatabaseOverload(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isDatabaseOverload(Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: 'P2028' }))).toBe(true);
    expect(isDatabaseOverload(Object.assign(new Error('x'), { code: 'P2024' }))).toBe(true);
    expect(isDatabaseOverload(new Error('wrapped', { cause: new Error('retrieve connection from pool timeout after 10001ms') }))).toBe(true);
    expect(isDatabaseOverload(new Error('relation "Job" does not exist'))).toBe(false);
    expect(isDatabaseOverload(Object.assign(new Error('unique'), { code: 'P2002' }))).toBe(false);
    expect(isDatabaseOverload(undefined)).toBe(false);
  });
});
