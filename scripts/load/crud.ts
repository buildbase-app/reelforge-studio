/**
 * Scenario (a), the CRUD mix (issue #151), with autocannon: create, update,
 * get and list projects, get_job and list_renders over REST, spread over every
 * api instance (client-side round robin stands in for an L4 load balancer).
 * Each operation is its own autocannon instance with a share of the
 * connections (a closed-loop mix: each connection sends its next request when
 * the previous one is answered), so its latency is measured on its own.
 *
 * 429s (rate limits) are counted apart from errors: with one hot key they are
 * the expected answer, not a failure. 503s with Retry-After (`overloaded`, the
 * in-flight cap of #307) are counted apart too, as `shed`: a fast, retryable
 * refusal rather than a timeout or a 500; the report shows them next to errors.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import autocannon from 'autocannon';
import { round, summary } from './lib';

export interface CrudTarget {
  urls: string[];
  /** Keys picked at random per request (one entry = the hot-key run). */
  keys: string[];
  projectIds: string[];
  jobIds: string[];
}

/** Share of the client connections per operation. */
export const MIX: Record<string, number> = {
  get_project: 0.25,
  list_projects: 0.1,
  update_project: 0.15,
  create_project: 0.1,
  get_job: 0.25,
  list_renders: 0.15,
};

const sample = JSON.parse(readFileSync(new URL('../../examples/sample-reel.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;

function request(op: string, t: CrudTarget): { method: string; path: string; body?: string } {
  switch (op) {
    case 'get_project':
      return { method: 'GET', path: `/v1/projects/${pick(t.projectIds)}` };
    case 'list_projects':
      return { method: 'GET', path: '/v1/projects' };
    case 'update_project':
      return { method: 'PATCH', path: `/v1/projects/${pick(t.projectIds)}`, body: JSON.stringify({ title: `load ${randomBytes(4).toString('hex')}` }) };
    case 'create_project': {
      const id = `lc-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
      return { method: 'POST', path: '/v1/projects', body: JSON.stringify({ manifest: { ...sample, projectId: id, title: `Load ${id}` } }) };
    }
    case 'get_job':
      return { method: 'GET', path: `/v1/jobs/${pick(t.jobIds)}` };
    case 'list_renders':
      return { method: 'GET', path: `/v1/projects/${pick(t.projectIds)}/renders` };
    default:
      throw new Error(`unknown op ${op}`);
  }
}

interface OpTally {
  ok: number[];
  limited: number[];
  shed: number;
  errors: number;
  statuses: Record<string, number>;
}

export interface CrudResult {
  seconds: number;
  connections: number;
  apiInstances: number;
  keys: number;
  total: { requests: number; perSecond: number; ok: number; okPerSecond: number; rateLimited: number; shed: number; shedRate: number; errors: number; errorRate: number; latencyMs: ReturnType<typeof summary> };
  ops: Record<string, { requests: number; perSecond: number; ok: number; rateLimited: number; shed: number; errors: number; statuses: Record<string, number>; latencyMs: ReturnType<typeof summary>; rateLimitedLatencyMs: ReturnType<typeof summary> }>;
}

export async function runCrud(t: CrudTarget, opts: { seconds: number; connections: number; mix?: Record<string, number> }): Promise<CrudResult> {
  const mix = opts.mix ?? MIX;
  const tallies = new Map<string, OpTally>();
  const runs: Array<Promise<unknown>> = [];
  for (const [op, share] of Object.entries(mix)) {
    const tally: OpTally = { ok: [], limited: [], shed: 0, errors: 0, statuses: {} };
    tallies.set(op, tally);
    const perUrl = Math.max(1, Math.round((opts.connections * share) / t.urls.length));
    for (const url of t.urls) {
      const first = request(op, t);
      runs.push(
        new Promise((ok, fail) => {
          const inst = autocannon(
            {
              url,
              connections: perUrl,
              duration: opts.seconds,
              timeout: 10,
              method: first.method as autocannon.Request['method'],
              headers: { 'content-type': 'application/json', authorization: `Bearer ${t.keys[0]}` },
              requests: [
                {
                  setupRequest: (req: autocannon.Request) => {
                    const r = request(op, t);
                    return { ...req, method: r.method as autocannon.Request['method'], path: r.path, body: r.body, headers: { ...req.headers, authorization: `Bearer ${pick(t.keys)}` } };
                  },
                },
              ],
            },
            (err, r) => {
              if (err) return fail(err);
              // Socket errors and timeouts never produce a response.
              tally.errors += r.errors;
              if (r.errors) tally.statuses.socketErrorsOrTimeouts = (tally.statuses.socketErrorsOrTimeouts ?? 0) + r.errors;
              ok(r);
            }
          );
          inst.on('response', (_client, status, _bytes, ms) => {
            tally.statuses[status] = (tally.statuses[status] ?? 0) + 1;
            if (status >= 200 && status < 300) tally.ok.push(ms);
            else if (status === 429) tally.limited.push(ms);
            else if (status === 503) tally.shed++;
            else tally.errors++;
          });
        })
      );
    }
  }
  await Promise.all(runs);
  const ops: CrudResult['ops'] = {};
  const allOk: number[] = [];
  let limited = 0;
  let shed = 0;
  let errors = 0;
  for (const [op, x] of tallies) {
    const requests = x.ok.length + x.limited.length + x.shed + x.errors;
    ops[op] = {
      requests,
      perSecond: round(requests / opts.seconds),
      ok: x.ok.length,
      rateLimited: x.limited.length,
      shed: x.shed,
      errors: x.errors,
      statuses: x.statuses,
      latencyMs: summary(x.ok),
      rateLimitedLatencyMs: summary(x.limited),
    };
    for (const v of x.ok) allOk.push(v);
    limited += x.limited.length;
    shed += x.shed;
    errors += x.errors;
  }
  const requests = allOk.length + limited + shed + errors;
  return {
    seconds: opts.seconds,
    connections: opts.connections,
    apiInstances: t.urls.length,
    keys: t.keys.length,
    total: {
      requests,
      perSecond: round(requests / opts.seconds),
      ok: allOk.length,
      okPerSecond: round(allOk.length / opts.seconds),
      rateLimited: limited,
      shed,
      shedRate: round((shed / (requests || 1)) * 100, 3),
      errors,
      errorRate: round((errors / (requests || 1)) * 100, 3),
      latencyMs: summary(allOk),
    },
    ops,
  };
}
