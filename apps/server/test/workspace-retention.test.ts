import { readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, groupRuns, renderDeletesAt, workspacePolicy } from '@renderweld/core';
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

/** Make only a render's download marker look `hours` old: the first download happened then. */
function ageDownload(root: string, runId: string, hours: number) {
  const when = new Date(Date.now() - hours * 3600 * 1000);
  const walk = (d: string): boolean => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        if (walk(p)) return true;
      } else if (p.endsWith(`/renders/${runId}/downloaded.json`)) {
        utimesSync(p, when, when);
        return true;
      }
    }
    return false;
  };
  expect(walk(root), `download marker of ${runId}`).toBe(true);
}
const download = (runId: string, key: string, headers: Record<string, string> = {}) => fetch(`${server.url}/v1/renders/${runId}/output`, { headers: { authorization: `Bearer ${key}`, ...headers } }).then(async (r) => ({ status: r.status, bytes: (await r.arrayBuffer()).byteLength }));

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    { registry: new PluginRegistry().registerEngine(fakeEngine('remotion')), env: { ...database.env, RENDERWELD_LICENCE_MODE: 'off', RENDERWELD_RATE_LIMIT_PER_MINUTE: '0', RENDERWELD_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0', RENDERWELD_STORAGE_SWEEP_INTERVAL_MINUTES: '0' }, quiet: true }
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

  it('RET-05 delete after download: the policy carries the grace, a render knows when it goes, the marker dates the download', () => {
    const instance = { renderDays: 0, keepLastRendersPerProject: 0, tempHours: 24, cacheDays: 30 };
    const p = workspacePolicy(instance, { deleteAfterDownloadMinutes: 30 });
    expect(p.deleteAfterDownloadMinutes).toBe(30);
    expect(renderDeletesAt(p, { createdAt: '2026-11-25T10:00:00.000Z' })).toBeNull();
    expect(renderDeletesAt(p, { createdAt: '2026-11-25T10:00:00.000Z', downloadedAt: '2026-11-25T11:00:00.000Z' })).toEqual({ at: '2026-11-25T11:30:00.000Z', reason: 'deleted_after_download' });
    // The earlier of the maximum age and the grace.
    const both = workspacePolicy(instance, { maxAgeHours: 1, deleteAfterDownloadMinutes: 120 });
    expect(renderDeletesAt(both, { createdAt: '2026-11-25T10:00:00.000Z', downloadedAt: '2026-11-25T10:10:00.000Z' })).toEqual({ at: '2026-11-25T11:00:00.000Z', reason: 'older_than_workspace_retention' });
    const runs = groupRuns([
      { key: 'projects/p/renders/r1/final.mp4', bytes: 10, modifiedAt: '2026-11-25T10:00:00.000Z' },
      { key: 'projects/p/renders/r1/render-manifest.json', bytes: 1, modifiedAt: '2026-11-25T10:00:01.000Z' },
      { key: 'projects/p/renders/r1/downloaded.json', bytes: 1, modifiedAt: '2026-11-25T12:00:00.000Z' },
    ] as never);
    // The marker dates the download and leaves the render's own date alone.
    expect(runs[0]).toMatchObject({ complete: true, createdAt: '2026-11-25T10:00:01.000Z', downloadedAt: '2026-11-25T12:00:00.000Z' });
  });

  it('RET-06 a render is deleted once the grace after its first download is over; what is not downloaded stays', async () => {
    expect((await rest('PATCH', '/v1/workspaces/acme', { limits: { retentionDeleteAfterDownloadMinutes: 30 } }, keys.owner)).status).toBe(200);
    const delivered = await render('acme-delivered', keys.acme);
    const signed = await render('acme-signed', keys.acme);
    const waiting = await render('acme-waiting', keys.acme);
    const before = (await rest('GET', `/v1/renders/${delivered}`, undefined, keys.acme)).json;
    expect(before.retention).toMatchObject({ downloadedAt: null, deletesAt: null, deleteAfterDownloadMinutes: 30 });
    // Downloads go through this server so it sees them.
    expect(before.downloadVia).toBe('server');
    // A partial range or a non-output file is not a download.
    expect((await download(delivered, keys.acme, { range: 'bytes=0-9' })).status).toBe(206);
    expect((await rest('GET', `/v1/renders/${delivered}/output?file=render-manifest.json`, undefined, keys.acme)).status).toBe(200);
    expect((await rest('GET', `/v1/renders/${delivered}`, undefined, keys.acme)).json.retention.downloadedAt).toBeNull();
    // The whole file is.
    expect((await download(delivered, keys.acme)).status).toBe(200);
    const after = (await rest('GET', `/v1/renders/${delivered}`, undefined, keys.acme)).json.retention;
    expect(Date.parse(after.deletesAt) - Date.parse(after.downloadedAt)).toBe(30 * 60_000);
    expect(after.deleteReason).toBe('deleted_after_download');
    // A signed link (no key) counts too.
    const link = (await rest('GET', `/v1/renders/${signed}`, undefined, keys.acme)).json.downloadUrl as string;
    expect(await fetch(new URL(link, server.url)).then((r) => r.arrayBuffer().then(() => r.status))).toBe(200);
    expect((await rest('GET', `/v1/renders/${signed}`, undefined, keys.acme)).json.retention.downloadedAt).not.toBeNull();
    // Within the grace nothing goes; after it, both downloaded renders go and the other stays.
    expect((await rest('POST', '/v1/storage/cleanup', { dryRun: true }, keys.owner)).json.renders).toEqual([]);
    ageDownload(join(dir, 'data'), delivered, 1);
    ageDownload(join(dir, 'data'), signed, 1);
    const real = (await rest('POST', '/v1/storage/cleanup', {}, keys.owner)).json;
    expect(real.renders.map((r: { renderId: string; reason: string }) => [r.renderId, r.reason]).sort()).toEqual([[delivered, 'deleted_after_download'], [signed, 'deleted_after_download']].sort());
    expect((await rest('GET', `/v1/renders/${delivered}`, undefined, keys.acme)).status).toBe(404);
    expect((await rest('GET', `/v1/renders/${waiting}`, undefined, keys.acme)).status).toBe(200);
  }, 180_000);

  it('RET-07 a workspace admin can tighten its own retention, never loosen or clear it; the owner can', async () => {
    const tighten = (b: unknown, key = keys.acme) => rest('PATCH', '/v1/workspace/retention', b, key);
    const ok = await tighten({ deleteAfterDownloadMinutes: 20, maxAgeHours: 48 });
    expect(ok.status).toBe(200);
    expect(ok.json.effectiveLimits).toMatchObject({ retentionDeleteAfterDownloadMinutes: 20, retentionMaxAgeHours: 48 });
    const looser = await tighten({ deleteAfterDownloadMinutes: 45 });
    expect(looser.status).toBe(403);
    expect(looser.json.error.message).toContain('only tighten');
    expect((await tighten({ maxAgeHours: null })).status).toBe(403);
    expect((await tighten({ maxAgeHours: 0 })).status).toBe(403);
    expect((await tighten({ keepLast: 'five' })).status).toBe(400);
    expect((await tighten({ forever: 1 })).status).toBe(400);
    expect((await tighten({})).status).toBe(400);
    // Nothing changed by the refused calls.
    expect((await rest('GET', '/v1/workspace', undefined, keys.acme)).json.effectiveLimits).toMatchObject({ retentionDeleteAfterDownloadMinutes: 20, retentionMaxAgeHours: 48 });
    // A key without the admin scope cannot.
    const renderKey = (await rest('POST', '/v1/keys', { name: 'renders only', scopes: ['read', 'render'] }, keys.acme)).json.key as string;
    expect((await tighten({ keepLast: 3 }, renderKey)).status).toBe(403);
    // The owner loosens through update_workspace.
    expect((await rest('PATCH', '/v1/workspaces/acme', { limits: null }, keys.owner)).status).toBe(200);
    expect((await rest('GET', '/v1/workspace', undefined, keys.acme)).json.effectiveLimits.retentionMaxAgeHours).toBeUndefined();
    // The owner's own (default) workspace has no row yet; tightening it creates one.
    const home = await tighten({ keepLast: 100 }, keys.owner);
    expect(home.status).toBe(200);
    expect(home.json).toMatchObject({ id: 'default', effectiveLimits: { retentionKeepLast: 100 } });
    // Audited in the workspace it changed.
    const audit = (await rest('GET', '/v1/audit?action=workspace.retention.tighten', undefined, keys.acme)).json;
    expect(audit.events.map((e: { action: string; data: { changed: Record<string, unknown> } }) => [e.action, Object.keys(e.data.changed).sort()])).toContainEqual(['workspace.retention.tighten', ['deleteAfterDownloadMinutes', 'maxAgeHours']]);
  });

  it('RET-08 get_storage shows every workspace\'s own retention and what the sweep applies to it', async () => {
    expect((await rest('PATCH', '/v1/workspaces/acme', { limits: { retentionMaxAgeHours: 12, retentionDeleteAfterDownloadMinutes: 15 } }, keys.owner)).status).toBe(200);
    const storage = (await rest('GET', '/v1/storage', undefined, keys.owner)).json;
    const byId = Object.fromEntries(storage.retention.workspaces.map((w: { workspaceId: string }) => [w.workspaceId, w]));
    expect(byId.acme).toEqual({ workspaceId: 'acme', own: { maxAgeHours: 12, deleteAfterDownloadMinutes: 15 }, applied: { maxAgeHours: 12, keepLast: null, deleteAfterDownloadMinutes: 15 } });
    expect(byId.default).toMatchObject({ own: { keepLast: 100 }, applied: { keepLast: 100 } });
    // The sweep is off in this test server (interval 0), so there is no next run.
    expect(storage.retention.nextSweepAt).toBeNull();
    // A workspace admin cannot read the instance's storage.
    expect((await rest('GET', '/v1/storage', undefined, keys.acme)).status).toBe(403);
  });
});

