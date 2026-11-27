import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/** get_render_output reports the plan's estimate next to the actual render time (#485), for renders started from a plan. */
const { dir, cleanup } = tempDir('renderweld-estimate-');
let server: StartedServer;
let dropDb: () => Promise<void> = async () => undefined;
let key = '';

const reel = (projectId: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: '0.2',
  projectId,
  title: projectId,
  output: { width: 320, height: 568, fps: 30, format: 'mp4' },
  scenes: [{ id: 'one', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'One' } }],
  ...extra,
});
const rest = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : {} };
};
/**
 * Waits for the job to finish and, when it succeeded, to be stored: get_job answers from the worker's live state,
 * and a plan reads the stored successful renders, which on a slower database trail it by a few milliseconds.
 */
async function finish(jobId: string) {
  for (let i = 0; i < 300; i++) {
    const j = (await rest('GET', `/v1/jobs/${jobId}?wait=10`)).json;
    if (j.status === 'succeeded') {
      for (let k = 0; k < 100; k++) {
        const { jobs } = (await rest('GET', '/v1/jobs?status=succeeded&type=render')).json as { jobs: Array<{ id: string }> };
        if (jobs.some((x) => x.id === jobId)) return j;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`job ${jobId} was never stored as succeeded`);
    }
    if (['failed', 'cancelled'].includes(j.status)) return j;
  }
  throw new Error('job did not finish');
}

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    { registry: new PluginRegistry().registerEngine(fakeEngine('remotion', { delayPerFrameMs: 2 })), env: { ...database.env, REELFORGE_LICENCE_MODE: 'off', REELFORGE_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0' }, quiet: true }
  );
  key = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
  for (const m of [reel('first'), reel('planned'), reel('multi', { variants: [{ id: 'a', width: 320, height: 320 }, { id: 'b', width: 568, height: 320 }] })]) {
    expect((await rest('POST', '/v1/projects', { manifest: m })).status).toBe(201);
  }
}, 60_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

describe('estimate against actual', () => {
  it('EST-01 a render without a plan reports no estimate', async () => {
    const job = await finish((await rest('POST', '/v1/projects/first/renders', {})).json.job.id);
    expect(job.status).toBe('succeeded');
    const out = (await rest('GET', `/v1/renders/${job.result.renderId}`)).json;
    expect(out.estimate).toBeUndefined();
  }, 120_000);

  it('EST-02 with planId, the job keeps the estimate and get_render_output reports it with the actual time and the ratio', async () => {
    const plan = (await rest('POST', '/v1/projects/planned/render-plan', {})).json;
    expect(plan.outputs[0].estimate.basis).toBe('measured');
    const started = await rest('POST', '/v1/projects/planned/renders', { planId: plan.planId });
    expect(started.status).toBe(202);
    expect(started.json.job.params.estimate).toEqual({ planId: plan.planId, ...plan.outputs[0].estimate });
    const job = await finish(started.json.job.id);
    const out = (await rest('GET', `/v1/renders/${job.result.renderId}`)).json;
    expect(out.estimate).toMatchObject({ planId: plan.planId, renderSeconds: plan.outputs[0].estimate.renderSeconds, basis: 'measured' });
    expect(out.estimate.actualSeconds).toBeGreaterThan(0);
    expect(out.estimate.ratio).toBeCloseTo(out.estimate.actualSeconds / plan.outputs[0].estimate.renderSeconds, 1);
  }, 120_000);

  it('EST-03 every variant of a batch keeps its own output\'s estimate; a stale planId is refused', async () => {
    const plan = (await rest('POST', '/v1/projects/multi/render-plan', {})).json;
    const started = await rest('POST', '/v1/projects/multi/renders', { planId: plan.planId });
    expect(started.status).toBe(202);
    const byVariant = Object.fromEntries((started.json.jobs as Array<{ params: { variant: string; estimate: { renderSeconds: number } } }>).map((j) => [j.params.variant, j.params.estimate.renderSeconds]));
    expect(byVariant).toEqual({ a: plan.outputs[0].estimate.renderSeconds, b: plan.outputs[1].estimate.renderSeconds });
    for (const j of started.json.jobs) await finish(j.id);
    expect((await rest('PATCH', '/v1/projects/multi', { title: 'changed' })).status).toBe(200);
    const stale = await rest('POST', '/v1/projects/multi/renders', { planId: plan.planId });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('plan_changed');
  }, 120_000);
});
