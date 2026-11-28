import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/** delete_render (#312): one render or preview goes, with every file, over REST and MCP; nothing else does. */
const { dir, cleanup } = tempDir('renderweld-render-delete-');
let server: StartedServer;
let admin: string;
let reader: string;
let dropDb: () => Promise<void> = async () => undefined;

const manifest = {
  schemaVersion: '0.1',
  projectId: 'del-reel',
  title: 'Delete',
  output: { width: 320, height: 568, fps: 30, format: 'mp4' },
  audio: { musicTrack: null, voiceTrack: null },
  assets: [],
  scenes: [
    { id: 'one', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'One' } },
    { id: 'two', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'Two' } },
  ],
};

const rest = (path: string, key: string | null = admin, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) } });

async function finished(path: string): Promise<string> {
  const { job } = await (await rest(path, admin, { method: 'POST', body: '{}' })).json();
  for (let i = 0; i < 600; i++) {
    const j = await (await rest(`/v1/jobs/${job.id}`)).json();
    if (j.status === 'succeeded') return j.result.renderId as string;
    if (['failed', 'cancelled'].includes(j.status)) throw new Error(JSON.stringify(j.error));
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job did not finish');
}

const runDir = (runId: string) => join(dir, 'data', 'projects', 'del-reel', 'renders', runId);

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' }, { registry: new PluginRegistry().registerEngine(fakeEngine('remotion')), env: { ...database.env, RENDERWELD_LICENCE_MODE: 'off' }, quiet: true });
  admin = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
  reader = (await server.service.keys.create('reader', ['read'])).key;
  expect((await rest('/v1/projects', admin, { method: 'POST', body: JSON.stringify({ manifest }) })).status).toBe(201);
}, 60_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

describe('delete_render', () => {
  it('DEL-10 REST: the render and every file go, its signed link stops working; the other renders and the project stay', async () => {
    const keep = await finished('/v1/projects/del-reel/renders');
    const gone = await finished('/v1/projects/del-reel/renders');
    const summary = await (await rest(`/v1/renders/${gone}`)).json();
    expect(existsSync(join(runDir(gone), 'final.mp4'))).toBe(true);
    const link = new URL(summary.downloadUrl, server.url);
    expect((await fetch(link)).status).toBe(200);

    expect((await rest(`/v1/renders/${gone}`, reader, { method: 'DELETE' })).status).toBe(403);
    expect((await rest(`/v1/renders/${gone}`, null, { method: 'DELETE' })).status).toBe(401);
    expect((await rest(`/v1/renders/${gone}`, admin, { method: 'DELETE' })).status).toBe(204);

    expect(existsSync(runDir(gone))).toBe(false);
    expect((await rest(`/v1/renders/${gone}`)).status).toBe(404);
    expect((await rest(`/v1/renders/${gone}/output`)).status).toBe(404);
    expect((await fetch(link)).status).toBe(404);
    expect((await rest(`/v1/renders/${gone}`, admin, { method: 'DELETE' })).status).toBe(404);
    const listed = (await (await rest('/v1/projects/del-reel/renders')).json()).renders.map((r: { renderId: string }) => r.renderId);
    expect(listed).toContain(keep);
    expect(listed).not.toContain(gone);
    expect(existsSync(join(runDir(keep), 'final.mp4'))).toBe(true);
    expect((await rest('/v1/projects/del-reel')).status).toBe(200);
  }, 120_000);

  it('DEL-11 MCP: delete_render removes a preview and answers what went; it is audited as render.delete', async () => {
    const preview = await finished('/v1/projects/del-reel/preview');
    expect(preview).toMatch(/^prv_/);
    const client = new Client({ name: 'delete-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${admin}` } } }));
    const r: any = await client.callTool({ name: 'delete_render', arguments: { renderId: preview } });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body).toMatchObject({ deleted: preview, projectId: 'del-reel' });
    expect(body.files).toBeGreaterThan(2);
    expect(existsSync(runDir(preview))).toBe(false);
    const again: any = await client.callTool({ name: 'delete_render', arguments: { renderId: preview } });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain('not_found');
    const audit = await (await rest('/v1/audit?action=render.delete')).json();
    expect(audit.events.some((e: { targetId?: string; result: string }) => e.targetId === preview && e.result === 'success')).toBe(true);
    await client.close();
  }, 120_000);
});
