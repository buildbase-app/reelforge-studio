import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, encodeCursor, type JobRecord } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * #184 on the server's database (REELFORGE_TEST_DB=sqlite|postgres|mysql):
 * - get_render after a restart (cold in-process index) reads the render's project from its job by run id: no
 *   project is read and storage is only touched under the owning project (no full scan);
 * - list_jobs with parentId lists one render's children, paged, with the filter bound into the cursor.
 */
const { dir, cleanup } = tempDir('reelforge-render-lookup-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const dataDir = join(dir, 'data');
const PROJECTS = 30;
const OWNER = 'rl-017';
let server: StartedServer;
let env: Record<string, string>;
let adminKey: string;
let runId: string;
let dropDb: () => Promise<void> = async () => undefined;
const registry = () => new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));
const start = () => startServer({ dataDir, port: 0, host: '127.0.0.1' }, { registry: registry(), env: { ...env, RENDERWELD_LICENCE_MODE: 'off' }, quiet: true });

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  env = database.env;
  server = await start();
  adminKey = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
  for (let i = 0; i < PROJECTS; i++) await server.service.createProject({ ...sample, projectId: `rl-${String(i).padStart(3, '0')}` });
  const job = await server.service.jobs.waitFor((await server.service.startRender(OWNER)).id, 120_000);
  expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
  runId = job.result!.renderId as string;
  // A fanned-out render's children (D-097), written as the database queue writes them: 7 units and a join, ties on createdAt.
  const base = Date.parse('2026-04-01T00:00:00.000Z');
  const child = (id: string, type: string, parentId: string, ms: number): JobRecord => ({ id, type, status: 'succeeded', projectId: OWNER, parentId, params: { projectId: OWNER, runId: 'run_fanned' }, createdAt: new Date(base + ms).toISOString(), progress: { stage: 'done', fraction: 1 } });
  await server.service.repos.jobs.insert({ ...child('job_rlparent', 'render', '', 0), parentId: undefined, params: { projectId: OWNER, runId: 'run_fanned' } }, new Date(base).toISOString());
  for (let i = 0; i < 7; i++) await server.service.repos.jobs.insert(child(`job_rlunit${i}`, 'render_unit', 'job_rlparent', 1 + Math.floor(i / 3)), new Date(base).toISOString());
  await server.service.repos.jobs.insert(child('job_rljoin', 'render_join', 'job_rlparent', 1), new Date(base).toISOString());
  await server.service.repos.jobs.insert(child('job_rlotherunit', 'render_unit', 'job_rlparent2', 1), new Date(base).toISOString());
  // Restart: a new process has an empty render index (as another api instance would).
  await server.close();
  server = await start();
}, 180_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

async function rest(path: string) {
  const r = await fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${adminKey}` } });
  return { status: r.status, json: (await r.json()) as any };
}

/** Count calls to every method of the project and job repositories and of the storage driver from now on. */
function instrument() {
  const calls: Record<string, number> = {};
  const stats: string[] = [];
  const lists: string[] = [];
  const wrap = (name: string, target: Record<string, unknown>) => {
    for (const k of Object.keys(target)) {
      const f = target[k];
      if (typeof f !== 'function') continue;
      target[k] = (...args: unknown[]) => {
        calls[`${name}.${k}`] = (calls[`${name}.${k}`] ?? 0) + 1;
        return (f as (...a: unknown[]) => unknown).apply(target, args);
      };
    }
  };
  const driver = server.service.storage.driver as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  for (const k of ['stat', 'list', 'get'] as const) originals.set(k, driver[k]);
  for (const k of ['stat', 'list', 'get'] as const) {
    const f = driver[k] as (...a: unknown[]) => unknown;
    driver[k] = (...args: unknown[]) => {
      calls[`storage.${k}`] = (calls[`storage.${k}`] ?? 0) + 1;
      if (k === 'stat' || k === 'get') stats.push(String(args[0]));
      if (k === 'list') lists.push(String(args[0]));
      return f.apply(driver, args);
    };
  }
  const repos = server.service.repos as unknown as { projects: Record<string, unknown>; jobs: Record<string, unknown> };
  const saved = { projects: { ...repos.projects }, jobs: { ...repos.jobs } };
  wrap('projects', repos.projects);
  wrap('jobs', repos.jobs);
  return {
    calls,
    stats,
    lists,
    restore() {
      Object.assign(repos.projects, saved.projects);
      Object.assign(repos.jobs, saved.jobs);
      for (const [k, f] of originals) driver[k] = f;
    },
  };
}

describe('get_render after a restart (#184)', () => {
  it('reads the owning project from the job by run id: no project read, no storage listing, keys of one project only', async () => {
    const probe = instrument();
    try {
      const r = await rest(`/v1/renders/${runId}`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json).toMatchObject({ renderId: runId, projectId: OWNER });
      expect(probe.calls['jobs.projectOfRun']).toBe(1);
      expect(Object.keys(probe.calls).filter((k) => k.startsWith('projects.'))).toEqual([]); // before #184: projects.list() of all 30
      expect(probe.lists).toEqual([]);
      expect(probe.stats.length).toBeGreaterThan(0);
      for (const key of probe.stats) expect(key.startsWith(`projects/${OWNER}/renders/${runId}/`), key).toBe(true);
      // Found once, then answered by the in-process index.
      expect((await rest(`/v1/renders/${runId}`)).status).toBe(200);
      expect(probe.calls['jobs.projectOfRun']).toBe(1);
    } finally {
      probe.restore();
    }
  });

  it('an unknown or malformed run id is a 404 without any scan', async () => {
    const probe = instrument();
    try {
      expect((await rest('/v1/renders/run_doesnotexist1')).status).toBe(404);
      expect(probe.calls['jobs.projectOfRun']).toBe(1);
      // A job whose render is not in storage (the fanned-out render above never committed one): one stat of that key only.
      expect((await rest('/v1/renders/run_fanned')).status).toBe(404);
      expect((await rest('/v1/renders/not-a-run')).status).toBe(404);
      expect(probe.calls['jobs.projectOfRun']).toBe(2);
      expect(Object.keys(probe.calls).filter((k) => k.startsWith('projects.'))).toEqual([]);
      expect(probe.lists).toEqual([]);
      expect(probe.stats).toEqual([`projects/${OWNER}/renders/run_fanned/render-manifest.json`]);
    } finally {
      probe.restore();
    }
  });

  it('the manifest and the output file are found the same way after a restart', async () => {
    await server.close();
    server = await start();
    const r = await fetch(`${server.url}/v1/renders/${runId}/output?file=render-manifest.json`, { headers: { authorization: `Bearer ${adminKey}` } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { kind: string }).kind).toBe('render');
  });
});

describe('list_jobs with parentId (#184)', () => {
  // (createdAt, id) descending: unit 6 alone in the newest millisecond, then units 5..3, then units 2..0 and the join.
  const kids = ['job_rlunit6', 'job_rlunit5', 'job_rlunit4', 'job_rlunit3', 'job_rlunit2', 'job_rlunit1', 'job_rlunit0', 'job_rljoin'];

  it('lists the units and the join of one render, newest first, paged; other jobs stay out', async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await rest(`/v1/jobs?parentId=job_rlparent&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      expect(r.json.jobs.length).toBeLessThanOrEqual(3);
      for (const j of r.json.jobs) expect(j.parentId).toBe('job_rlparent');
      ids.push(...r.json.jobs.map((j: { id: string }) => j.id));
      cursor = r.json.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(ids).toEqual(kids);
    expect((await rest(`/v1/jobs?parentId=job_rlparent&projectId=${OWNER}&limit=200`)).json.jobs.map((j: { id: string }) => j.id)).toEqual(kids);
    expect((await rest('/v1/jobs?parentId=job_rlparent&projectId=rl-000')).json).toEqual({ jobs: [], nextCursor: null });
    expect((await rest('/v1/jobs?parentId=job_nosuch')).json).toEqual({ jobs: [], nextCursor: null });
    expect((await rest(`/v1/jobs?parentId=${encodeURIComponent("x' OR '1'='1")}`)).json).toEqual({ jobs: [], nextCursor: null });
  });

  it('a cursor is bound to its filter: another parentId, projectId or no filter answers 400', async () => {
    const first = await rest('/v1/jobs?parentId=job_rlparent&limit=2');
    const c = encodeURIComponent(first.json.nextCursor);
    expect((await rest(`/v1/jobs?parentId=job_rlparent&limit=2&cursor=${c}`)).status).toBe(200);
    for (const q of ['parentId=job_rlparent2', 'projectId=' + OWNER, '', `parentId=job_rlparent&projectId=${OWNER}`]) {
      const r = await rest(`/v1/jobs?${q}&cursor=${c}`);
      expect(r.status, q).toBe(400);
      expect(r.json.error.code).toBe('bad_request');
    }
    // A cursor of the projectId-only list is refused with parentId added.
    const byProject = await rest(`/v1/jobs?projectId=${OWNER}&limit=1`);
    expect((await rest(`/v1/jobs?projectId=${OWNER}&parentId=job_rlparent&cursor=${encodeURIComponent(byProject.json.nextCursor)}`)).status).toBe(400);
    // A hand-made cursor for the parent filter with an edited filter string is refused too.
    const forged = encodeCursor('jobs', '|parent:job_rlparent2', { createdAt: '2026-04-01T00:00:00.002Z', id: 'job_rlunit5' });
    expect((await rest(`/v1/jobs?parentId=job_rlparent&cursor=${forged}`)).status).toBe(400);
  });

  it('MCP list_jobs takes parentId and pages the same way', async () => {
    const client = new Client({ name: 'reelforge-render-lookup-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${adminKey}` } } }));
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'list_jobs')!;
      expect(tool.description).toContain('parentId');
      expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(expect.arrayContaining(['projectId', 'parentId', 'limit', 'cursor']));
      const call = async (args: Record<string, unknown>) => {
        const r = (await client.callTool({ name: 'list_jobs', arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
        return { isError: r.isError === true, text: r.content[0]?.text ?? '' };
      };
      const p1 = JSON.parse((await call({ parentId: 'job_rlparent', limit: 5 })).text);
      const p2 = JSON.parse((await call({ parentId: 'job_rlparent', limit: 5, cursor: p1.nextCursor })).text);
      expect([...p1.jobs, ...p2.jobs].map((j: { id: string }) => j.id)).toEqual(kids);
      expect(p2.nextCursor).toBeNull();
      expect((await call({ parentId: 'job_rlparent2', cursor: p1.nextCursor })).isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
