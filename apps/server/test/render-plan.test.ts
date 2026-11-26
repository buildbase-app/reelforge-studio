import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/** plan_render / POST /v1/projects/:id/render-plan (#485): an estimate before render_project, from this workspace's renders. */
const { dir, cleanup } = tempDir('renderweld-plan-');
let server: StartedServer;
let dropDb: () => Promise<void> = async () => undefined;
const keys = { admin: '', read: '' };

const reel = (projectId: string, width: number, height: number, extra: Record<string, unknown> = {}) => ({
  schemaVersion: '0.2',
  projectId,
  title: projectId,
  output: { width, height, fps: 30, format: 'mp4' },
  scenes: [
    { id: 'one', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'One' } },
    { id: 'two', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'Two' } },
  ],
  ...extra,
});
const rest = async (method: string, path: string, body?: unknown, key = keys.admin) => {
  const r = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : {} };
};
const mcp = async (name: string, args: Record<string, unknown>, key = keys.read) => {
  const r = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = (await r.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { isError: Boolean(res.result.isError), json: JSON.parse(res.result.content[0]!.text) };
};
async function render(projectId: string) {
  const { job } = (await rest('POST', `/v1/projects/${projectId}/renders`, {})).json;
  for (let i = 0; i < 300; i++) {
    const j = (await rest('GET', `/v1/jobs/${job.id}?wait=10`)).json;
    if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
  }
  throw new Error('render did not finish');
}

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    {
      registry: new PluginRegistry().registerEngine(fakeEngine('remotion', { delayPerFrameMs: 2 })).registerEngine(fakeEngine('motion-canvas')),
      env: { ...database.env, REELFORGE_LICENCE_MODE: 'off', REELFORGE_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0' },
      quiet: true,
    }
  );
  keys.admin = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
  keys.read = (await server.service.keys.create('reader', ['read'])).key;
  for (const m of [reel('vertical', 1080, 1920), reel('square', 1080, 1080), reel('multi', 1080, 1920, { variants: [{ id: 'wide', width: 1920, height: 1080 }, { id: 'sq', width: 1080, height: 1080 }] })]) {
    expect((await rest('POST', '/v1/projects', { manifest: m })).status).toBe(201);
  }
}, 60_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

describe('render plan', () => {
  it('PLAN-10 with no render yet: every output with its frames and length, valid, no estimate ("none"), and nothing queued', async () => {
    const r = await rest('POST', '/v1/projects/square/render-plan', {}, keys.read);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ projectId: 'square', projectVersion: 1, valid: true, errors: [], basis: { renders: 0 } });
    expect(r.json.planId).toMatch(/^plan_[0-9a-f]{24}$/);
    expect(r.json.outputs).toEqual([{ variant: null, width: 1080, height: 1080, fps: 30, frames: 90, seconds: 3, format: 'mp4', estimate: { renderSeconds: null, bytes: null, basis: 'none' } }]);
    expect(r.json.total).toEqual({ outputs: 1, renderSeconds: null, bytes: null });
    expect(r.json.queue).toMatchObject({ queued: 0, estimatedWaitSeconds: 0 });
    expect(r.json.basis.note).toContain('No successful render');
    expect((await rest('GET', '/v1/jobs')).json.jobs).toEqual([]);
  });

  it('PLAN-11 after a render: measured time and size for another size, scaled by pixels; MCP gives the same plan', async () => {
    const done = await render('vertical');
    expect(done.status).toBe('succeeded');
    const v = (await rest('POST', '/v1/projects/vertical/render-plan', {})).json;
    const s = (await rest('POST', '/v1/projects/square/render-plan', {})).json;
    expect(v.basis.renders).toBe(1);
    expect(v.basis.engines).toEqual(['remotion']);
    expect(v.outputs[0].estimate.basis).toBe('measured');
    expect(v.outputs[0].estimate.renderSeconds).toBeGreaterThan(0);
    expect(v.outputs[0].estimate.bytes).toBeGreaterThan(0);
    // Same engine and frames, 1080x1080 against 1080x1920: about 1080/1920 of the time and size.
    const ratio = s.outputs[0].estimate.renderSeconds / v.outputs[0].estimate.renderSeconds;
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.7);
    expect(s.outputs[0].estimate.bytes / v.outputs[0].estimate.bytes).toBeCloseTo(1080 / 1920, 1);
    const viaMcp = await mcp('plan_render', { projectId: 'square' });
    expect(viaMcp.isError).toBe(false);
    expect(viaMcp.json.planId).toBe(s.planId);
    expect(viaMcp.json.outputs[0].estimate).toEqual(s.outputs[0].estimate);
  }, 120_000);

  it('PLAN-12 a project with variants: every variant without `variant`, one with it; an unknown variant is a 400', async () => {
    const all = (await rest('POST', '/v1/projects/multi/render-plan', {})).json;
    expect(all.outputs.map((o: { variant: string; width: number; height: number }) => [o.variant, o.width, o.height])).toEqual([['wide', 1920, 1080], ['sq', 1080, 1080]]);
    expect(all.total.outputs).toBe(2);
    expect(all.total.renderSeconds).toBeCloseTo(all.outputs[0].estimate.renderSeconds + all.outputs[1].estimate.renderSeconds, 5);
    const one = (await rest('POST', '/v1/projects/multi/render-plan', { variant: 'sq' })).json;
    expect(one.outputs.map((o: { variant: string }) => o.variant)).toEqual(['sq']);
    expect(one.planId).not.toBe(all.planId);
    const bad = await rest('POST', '/v1/projects/multi/render-plan', { variant: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain('wide, sq');
  });

  it('PLAN-13 an engine with no sample says "partial"; an invalid project says why; the plan id follows the version', async () => {
    const before = (await rest('POST', '/v1/projects/square/render-plan', {})).json.planId;
    const patched = await rest('PATCH', '/v1/projects/square', { scenes: [{ id: 'mc', engine: 'motion-canvas', template: 'animated-explainer', durationFrames: 60, props: { title: 'MC', points: ['a'] } }] });
    expect(patched.status).toBe(200);
    const p = (await rest('POST', '/v1/projects/square/render-plan', {})).json;
    expect(p.projectVersion).toBe(2);
    expect(p.planId).not.toBe(before);
    expect(p.outputs[0].estimate.basis).toBe('partial');
    expect(p.outputs[0].estimate.renderSeconds).toBeGreaterThan(0);
    // A theme that does not exist: the plan says the render would be refused, and why.
    await rest('PATCH', '/v1/projects/square', { theme: 'no-such-theme' });
    const invalid = (await rest('POST', '/v1/projects/square/render-plan', {})).json;
    expect(invalid.valid).toBe(false);
    expect(JSON.stringify(invalid.errors)).toContain('no-such-theme');
    expect((await rest('POST', '/v1/projects/nope/render-plan', {})).status).toBe(404);
  });
});
