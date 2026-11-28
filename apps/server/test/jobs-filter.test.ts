import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/** list_jobs / GET /v1/jobs filtered by status and type (#292: the dashboard's all-renders view). */
const { dir, cleanup } = tempDir('renderweld-jobs-filter-');
let server: StartedServer;
let key: string;
let dropDb: () => Promise<void> = async () => undefined;
const ids = { render1: '', render2: '', preview: '', failed: '' };

const reel = (projectId: string, engine: 'remotion' | 'motion-canvas') => ({
  schemaVersion: '0.1',
  projectId,
  title: projectId,
  output: { width: 320, height: 568, fps: 30, format: 'mp4' },
  audio: { musicTrack: null, voiceTrack: null },
  assets: [],
  scenes: [engine === 'remotion' ? { id: 'one', engine, template: 'kinetic-title', durationFrames: 45, props: { headline: 'One' } } : { id: 'one', engine, template: 'animated-explainer', durationFrames: 60, props: { title: 'One', points: ['a'] } }],
});
const rest = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
async function start(path: string): Promise<string> {
  const { job } = await (await rest(path, { method: 'POST', body: '{}' })).json();
  for (let i = 0; i < 600; i++) {
    const j = await (await rest(`/v1/jobs/${job.id}`)).json();
    if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return job.id;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job did not finish');
}

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas', { fail: true }));
  server = await startServer({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' }, { registry, env: { ...database.env, RENDERWELD_LICENCE_MODE: 'off' }, quiet: true });
  key = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
  for (const [id, engine] of [['good-a', 'remotion'], ['good-b', 'remotion'], ['bad', 'motion-canvas']] as const) {
    expect((await rest('/v1/projects', { method: 'POST', body: JSON.stringify({ manifest: reel(id, engine) }) })).status).toBe(201);
  }
  ids.render1 = await start('/v1/projects/good-a/renders');
  ids.render2 = await start('/v1/projects/good-b/renders');
  ids.preview = await start('/v1/projects/good-a/preview');
  ids.failed = await start('/v1/projects/bad/renders');
}, 120_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

describe('GET /v1/jobs?status=&type=', () => {
  it('JOBS-10 filters by status and type across projects, newest first, and pages with the filter kept', async () => {
    const list = async (q: string) => ((await (await rest(`/v1/jobs?${q}`)).json()) as { jobs: Array<{ id: string; status: string; type: string }>; nextCursor: string | null });
    expect((await list('status=succeeded&type=render')).jobs.map((j) => j.id)).toEqual([ids.render2, ids.render1]);
    expect((await list('status=succeeded&type=preview')).jobs.map((j) => j.id)).toEqual([ids.preview]);
    expect((await list('status=failed')).jobs.map((j) => j.id)).toEqual([ids.failed]);
    expect((await list('type=render&projectId=good-a')).jobs.map((j) => j.id)).toEqual([ids.render1]);
    const first = await list('status=succeeded&type=render&limit=1');
    expect(first.jobs.map((j) => j.id)).toEqual([ids.render2]);
    const second = await list(`status=succeeded&type=render&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.jobs.map((j) => j.id)).toEqual([ids.render1]);
    // A cursor is tied to its filter.
    expect((await rest(`/v1/jobs?status=failed&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(400);
  });

  it('JOBS-11 an unknown status or type is a 400 naming the allowed values; MCP list_jobs takes the same filters', async () => {
    const bad = await rest('/v1/jobs?status=done');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain('status must be one of queued, running, succeeded, failed, cancelled');
    expect((await rest('/v1/jobs?type=export')).status).toBe(400);
    const r = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_jobs', arguments: { status: 'succeeded', type: 'preview' } } }),
    });
    const body = (await r.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0]!.text).jobs.map((j: { id: string }) => j.id)).toEqual([ids.preview]);
  });
});

describe('GET /v1/assets/:id/file', () => {
  it('ASSET-FILE-01 streams the stored bytes with their type, nosniff and a sandboxing CSP; Range works; no key is 401, unknown is 404', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    const { asset } = await server.service.uploadAsset(png, { filename: 'dot.png' });
    const r = await rest(`/v1/assets/${asset.id}/file`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toMatch(/^sandbox;/);
    expect(r.headers.get('content-disposition')).toBe(`inline; filename="${asset.id}.png"`);
    expect(Buffer.from(await r.arrayBuffer()).equals(png)).toBe(true);
    const part = await fetch(`${server.url}/v1/assets/${asset.id}/file`, { headers: { Authorization: `Bearer ${key}`, Range: 'bytes=0-7' } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(png.subarray(0, 8))).toBe(true);
    expect((await fetch(`${server.url}/v1/assets/${asset.id}/file`)).status).toBe(401);
    expect((await rest('/v1/assets/ast-0000000000000000/file')).status).toBe(404);
  });
});
