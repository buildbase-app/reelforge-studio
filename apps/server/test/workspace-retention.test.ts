import { readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, workspacePolicy } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/** Retention per workspace (#487): a stricter policy for one tenant, the instance's as the ceiling. */
const { dir, cleanup } = tempDir('renderweld-ws-retention-');
let server: StartedServer;
let dropDb: () => Promise<void> = async () => undefined;
const keys = { owner: '', acme: '' };
const runs = { home: '', acme: '' };

const reel = (projectId: string) => ({
  schemaVersion: '0.2',
  projectId,
  title: projectId,
  output: { width: 320, height: 568, fps: 30, format: 'mp4' },
  scenes: [{ id: 'one', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'One' } }],
});
const rest = async (method: string, path: string, body: unknown, key: string) => {
  const r = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : {} };
};
async function render(projectId: string, key: string): Promise<string> {
  expect((await rest('POST', '/v1/projects', { manifest: reel(projectId) }, key)).status).toBe(201);
  const { job } = (await rest('POST', `/v1/projects/${projectId}/renders`, {}, key)).json;
  for (let i = 0; i < 300; i++) {
    const j = (await rest('GET', `/v1/jobs/${job.id}?wait=10`, undefined, key)).json;
    if (j.status === 'succeeded') return j.result.renderId as string;
    if (['failed', 'cancelled'].includes(j.status)) throw new Error(`render ${j.status}`);
  }
  throw new Error('render did not finish');
}
/** Make every stored file of a render look `hours` old (the sweep reads the objects' times). */
function age(root: string, runId: string, hours: number) {
  const when = new Date(Date.now() - hours * 3600 * 1000);
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      if (p.includes(`/renders/${runId}`)) utimesSync(p, when, when);
    }
  };
  walk(root);
}

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    { registry: new PluginRegistry().registerEngine(fakeEngine('remotion')), env: { ...database.env, REELFORGE_LICENCE_MODE: 'off', REELFORGE_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_STORAGE_SWEEP_INTERVAL_MINUTES: '0' }, quiet: true }
  );
  keys.owner = (await server.service.keys.create('owner', ['admin', 'owner'])).key;
  const created = await rest('POST', '/v1/workspaces', { id: 'acme', name: 'Acme', adminKey: true, limits: { retentionMaxAgeHours: 1 } }, keys.owner);
  expect(created.status).toBe(201);
  keys.acme = created.json.key;
  runs.home = await render('home-reel', keys.owner);
  runs.acme = await render('acme-reel', keys.acme);
}, 120_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

describe('retention per workspace', () => {
  it('RET-01 the workspace policy is the instance\'s made stricter, never looser', () => {
    const instance = { renderDays: 0, keepLastRendersPerProject: 0, tempHours: 24, cacheDays: 30 };
    expect(workspacePolicy(instance, undefined)).toEqual(instance);
    expect(workspacePolicy(instance, { maxAgeHours: 24 })).toMatchObject({ maxAgeHours: 24 });
    // The instance keeps 3 days: a workspace may ask for 1 day, not 5.
    expect(workspacePolicy({ ...instance, renderDays: 3 }, { maxAgeHours: 24 }).maxAgeHours).toBe(24);
    expect(workspacePolicy({ ...instance, renderDays: 3 }, { maxAgeHours: 120 }).maxAgeHours).toBeUndefined();
    // Keep-last: the smaller one; a workspace alone may set one.
    expect(workspacePolicy({ ...instance, keepLastRendersPerProject: 5 }, { keepLast: 2 }).keepLastRendersPerProject).toBe(2);
    expect(workspacePolicy({ ...instance, keepLastRendersPerProject: 5 }, { keepLast: 10 }).keepLastRendersPerProject).toBe(5);
    expect(workspacePolicy(instance, { keepLast: 3 }).keepLastRendersPerProject).toBe(3);
  });

  it('RET-02 the limits carry the retention: shown in effectiveLimits, validated, cleared with null', async () => {
    const ws = (await rest('GET', '/v1/workspace', undefined, keys.acme)).json;
    expect(ws.effectiveLimits).toMatchObject({ retentionMaxAgeHours: 1 });
    expect((await rest('GET', '/v1/workspace', undefined, keys.owner)).json.effectiveLimits.retentionMaxAgeHours).toBeUndefined();
    const bad = await rest('PATCH', '/v1/workspaces/acme', { limits: { retentionMaxAgeHours: 'a day' } }, keys.owner);
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain('retentionMaxAgeHours');
    expect((await rest('PATCH', '/v1/workspaces/acme', { limits: { retentionMaxAgeHours: 1, retentionKeepLast: null } }, keys.owner)).status).toBe(200);
  });

  it('RET-03 the sweep deletes the strict workspace\'s old renders and keeps the instance\'s', async () => {
    age(join(dir, 'data'), runs.home, 2);
    age(join(dir, 'data'), runs.acme, 2);
    const dry = (await rest('POST', '/v1/storage/cleanup', { dryRun: true }, keys.owner)).json;
    expect(dry.renders.map((r: { workspaceId?: string; renderId: string; reason: string }) => [r.workspaceId ?? 'default', r.renderId, r.reason])).toEqual([['acme', runs.acme, 'older_than_workspace_retention']]);
    const real = (await rest('POST', '/v1/storage/cleanup', {}, keys.owner)).json;
    expect(real.totals.renders).toBe(1);
    expect((await rest('GET', `/v1/renders/${runs.acme}`, undefined, keys.acme)).status).toBe(404);
    expect((await rest('GET', `/v1/renders/${runs.home}`, undefined, keys.owner)).status).toBe(200);
  });

  it('RET-04 a young render is kept, and clearing the workspace retention keeps everything again', async () => {
    const fresh = await render('acme-fresh', keys.acme);
    expect((await rest('POST', '/v1/storage/cleanup', { dryRun: true }, keys.owner)).json.renders).toEqual([]);
    age(join(dir, 'data'), fresh, 2);
    expect((await rest('PATCH', '/v1/workspaces/acme', { limits: { retentionMaxAgeHours: null } }, keys.owner)).status).toBe(200);
    expect((await rest('POST', '/v1/storage/cleanup', { dryRun: true }, keys.owner)).json.renders).toEqual([]);
  }, 120_000);
});
