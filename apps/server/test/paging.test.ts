import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PluginRegistry, encodeCursor, type JobRecord } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * Paged lists over REST and MCP (#179, D-102): list_projects, list_jobs and
 * list_assets return one page and nextCursor; calls without the new arguments
 * keep working (first page, same item fields); bad limits and cursors are 400s.
 */
const { dir, cleanup } = tempDir('reelforge-paging-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const PROJECTS = 123;
const JOBS = 61;
let server: StartedServer;
let adminKey: string;
let readKey: string;
let dropDb: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' }, { registry, env: { ...database.env, REELFORGE_LICENCE_MODE: 'off' }, quiet: true });
  adminKey = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
  readKey = (await server.service.keys.create('reader', ['read'])).key;
  for (let i = 0; i < PROJECTS; i++) await server.service.createProject({ ...sample, projectId: `pp-${String(i).padStart(3, '0')}`, title: `Paged ${i}` });
  const base = Date.parse('2026-02-01T00:00:00.000Z');
  for (let i = 0; i < JOBS; i++) {
    const createdAt = new Date(base + Math.floor(i / 3) * 1000).toISOString(); // three jobs per millisecond: ties
    const job: JobRecord = { id: `job_paged${String(i).padStart(3, '0')}`, type: 'render', status: 'succeeded', projectId: i % 2 ? 'pp-001' : 'pp-002', params: {}, createdAt, progress: { stage: 'done', fraction: 1 } };
    await server.service.repos.jobs.insert(job, createdAt);
  }
}, 120_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

async function rest(path: string, key = adminKey) {
  const r = await fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
  return { status: r.status, json: (await r.json()) as any };
}

async function mcp<T>(key: string, fn: (call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; json: any }>, client: Client) => Promise<T>) {
  const client = new Client({ name: 'reelforge-paging-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  try {
    return await fn(async (name, args = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      const text = r.content.find((c) => c.type === 'text')?.text ?? '';
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {
        // SDK input validation errors are plain text
      }
      return { isError: r.isError === true, json };
    }, client);
  } finally {
    await client.close();
  }
}

/** Every page of a REST list, following nextCursor. */
async function walkRest(path: string, field: string, key = adminKey) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const r = await rest(`${path}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ''}`, key);
    expect(r.status).toBe(200);
    ids.push(...r.json[field].map((x: { id: string }) => x.id));
    cursor = r.json.nextCursor;
    pages++;
  } while (cursor && pages < 100);
  return { ids, pages };
}

describe('paged lists (D-102)', () => {
  it('REST: a call without parameters returns the first page of summaries and nextCursor', async () => {
    const r = await rest('/v1/projects');
    expect(r.status).toBe(200);
    expect(r.json.projects).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(typeof r.json.nextCursor).toBe('string');
    expect(Object.keys(r.json.projects[0]).sort()).toEqual(['createdAt', 'durationSeconds', 'id', 'scenes', 'title', 'updatedAt', 'version']);
    expect(r.json.projects[0]).toMatchObject({ id: 'pp-122', title: 'Paged 122', version: 1, scenes: 2, durationSeconds: 7 });
  });

  it('REST: walking nextCursor returns every project once, newest first, and ends with null', async () => {
    const { ids, pages } = await walkRest('/v1/projects?limit=40', 'projects');
    expect(pages).toBe(Math.ceil(PROJECTS / 40));
    expect(ids).toEqual(Array.from({ length: PROJECTS }, (_, i) => `pp-${String(PROJECTS - 1 - i).padStart(3, '0')}`));
    const last = await rest('/v1/projects?limit=200');
    expect(last.json.projects).toHaveLength(PROJECTS);
    expect(last.json.nextCursor).toBeNull();
  });

  it('REST: list_jobs pages all jobs and one project\'s jobs, ties included', async () => {
    const all = await walkRest('/v1/jobs?limit=7', 'jobs');
    expect(all.ids).toHaveLength(JOBS);
    expect(new Set(all.ids).size).toBe(JOBS);
    expect(all.ids[0]).toBe('job_paged060');
    const one = await walkRest('/v1/jobs?projectId=pp-001&limit=4', 'jobs');
    expect(one.ids).toEqual(all.ids.filter((id) => Number(id.slice(-3)) % 2 === 1));
    const first = await rest('/v1/jobs');
    expect(first.json.jobs).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(first.json.nextCursor).toEqual(expect.any(String));
  });

  it('REST: list_assets of a project is one page; the store is paged', async () => {
    const p = await rest('/v1/assets?projectId=pp-000');
    expect(p.status).toBe(200);
    expect(p.json).toEqual({ assets: expect.any(Array), nextCursor: null });
    const store = await rest('/v1/assets?limit=1');
    expect(store.status).toBe(200);
    expect(store.json.nextCursor === null || typeof store.json.nextCursor === 'string').toBe(true);
  });

  it('REST: enforces the page-size cap and refuses tampered or foreign cursors cleanly', async () => {
    for (const limit of ['0', String(MAX_PAGE_SIZE + 1), '-1', '1.5', 'abc', '1e2', '99999999']) {
      const r = await rest(`/v1/projects?limit=${limit}`);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('bad_request');
      expect(r.json.error.message).toMatch(/limit must be an integer from 1 to 200/);
    }
    expect((await rest(`/v1/projects?limit=${MAX_PAGE_SIZE}`)).status).toBe(200);
    const good: string = (await rest('/v1/projects?limit=5')).json.nextCursor;
    const decoded = JSON.parse(Buffer.from(good, 'base64url').toString());
    const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
    const bad = [
      'garbage!!',
      b64('not json'),
      b64([1, 2]),
      b64({ ...decoded, v: 2 }),
      b64({ ...decoded, l: 'jobs' }), // a projects cursor is not a jobs cursor (and vice versa below)
      b64({ ...decoded, f: 'pp-001' }),
      b64({ ...decoded, extra: 1 }),
      b64({ ...decoded, i: "x' OR '1'='1" }),
      b64({ ...decoded, i: 'pp-1; DROP TABLE "Project"' }),
      b64({ ...decoded, t: '2026-02-01' }),
      b64({ ...decoded, t: "2026-02-01T00:00:00.000Z' OR 1=1" }),
      b64({ ...decoded, t: '2026-13-45T00:00:00.000Z' }),
      'A'.repeat(5000),
    ];
    for (const cursor of bad) {
      const r = await rest(`/v1/projects?cursor=${encodeURIComponent(cursor)}`);
      expect(r.status, cursor).toBe(400);
      expect(r.json.error).toMatchObject({ code: 'bad_request', message: expect.stringMatching(/^cursor is invalid/) });
    }
    // A cursor is bound to its list and filter.
    expect((await rest(`/v1/jobs?cursor=${good}`)).status).toBe(400);
    const jobsCursor: string = (await rest('/v1/jobs?projectId=pp-001&limit=2')).json.nextCursor;
    expect((await rest(`/v1/jobs?projectId=pp-002&cursor=${jobsCursor}`)).status).toBe(400);
    expect((await rest(`/v1/jobs?cursor=${jobsCursor}`)).status).toBe(400);
    expect((await rest(`/v1/jobs?projectId=pp-001&cursor=${jobsCursor}`)).status).toBe(200);
    // A projectId no project can have is answered without a query (NUL bytes, quotes).
    for (const pid of ['%00', "x'%20OR%20'1'%3D'1", 'UPPER']) expect((await rest(`/v1/jobs?projectId=${pid}`)).json).toEqual({ jobs: [], nextCursor: null });
    // A well-formed position the client made up only moves the start: still this workspace's rows, still a page.
    const made = encodeCursor('projects', '', { createdAt: '2999-01-01T00:00:00.000Z', id: 'zzz' });
    const r = await rest(`/v1/projects?cursor=${made}`);
    expect(r.status).toBe(200);
    expect(r.json.projects).toHaveLength(DEFAULT_PAGE_SIZE);
  });

  it('scoping is unchanged: every key of the workspace sees the same pages; a cursor carries no rights', async () => {
    const a = await rest('/v1/projects?limit=30', adminKey);
    const b = await rest(`/v1/projects?limit=30&cursor=${a.json.nextCursor}`, readKey);
    const b2 = await rest(`/v1/projects?limit=30&cursor=${a.json.nextCursor}`, adminKey);
    expect(b.status).toBe(200);
    expect(b.json).toEqual(b2.json);
    expect((await rest('/v1/projects', 'rf_' + 'x'.repeat(48))).status).toBe(401);
  });

  it('MCP: the tools take limit and cursor, describe how to page, and match REST', async () => {
    await mcp(readKey, async (call, client) => {
      const { tools } = await client.listTools();
      for (const name of ['list_projects', 'list_jobs', 'list_assets']) {
        const t = tools.find((x) => x.name === name)!;
        expect(t.description).toMatch(/nextCursor/);
        expect(t.description).toMatch(/cursor: nextCursor/);
        expect(Object.keys((t.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(['limit', 'cursor']));
      }
      const first = await call('list_projects');
      expect(first.isError).toBe(false);
      expect(first.json.projects).toHaveLength(DEFAULT_PAGE_SIZE);
      expect(first.json).toEqual((await rest('/v1/projects')).json);
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const r: { json: { projects: Array<{ id: string }>; nextCursor: string | null } } = await call('list_projects', { limit: 60, ...(cursor ? { cursor } : {}) });
        ids.push(...r.json.projects.map((p) => p.id));
        cursor = r.json.nextCursor;
      } while (cursor);
      expect(ids).toHaveLength(PROJECTS);
      expect(new Set(ids).size).toBe(PROJECTS);
      const jobs = await call('list_jobs', { projectId: 'pp-001', limit: 3 });
      expect(jobs.json.jobs).toHaveLength(3);
      expect((await call('list_jobs', { projectId: 'pp-001', limit: 3, cursor: jobs.json.nextCursor })).json).toEqual((await rest(`/v1/jobs?projectId=pp-001&limit=3&cursor=${jobs.json.nextCursor}`)).json);
      const tooBig = await call('list_projects', { limit: MAX_PAGE_SIZE + 1 });
      expect(tooBig.isError).toBe(true);
      const tampered = await call('list_projects', { cursor: 'eyJ2IjoxfQ' });
      expect(tampered.isError).toBe(true);
      expect(tampered.json.error).toMatchObject({ code: 'bad_request', message: expect.stringMatching(/^cursor is invalid/) });
    });
  });
});
