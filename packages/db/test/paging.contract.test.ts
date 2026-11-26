/**
 * Keyset pages of list_projects, list_jobs and list_assets (#179, D-102), on
 * every implementation (memory, SQLite; PostgreSQL / MySQL with TEST_POSTGRES_URL /
 * TEST_MYSQL_URL): a walk returns every row that existed when it started exactly
 * once while rows are inserted (and projects updated) concurrently; summaries
 * come without manifests; positions are parameters, never SQL; workspaces stay apart.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { framesToSeconds, parseProject, totalFrames, type Project } from '@renderweld/project-schema';
import { createMemoryRepositories, readPage, parsePageQuery, type AssetRecord, type JobRecord, type PageAfter, type PageRequest, type Repositories } from '@renderweld/core';
import { Database, availableTestDatabases, createTestDatabase, prepareDatabase, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-db-paging-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
function manifest(id: string, scenes = 2): Project {
  const r = parseProject({ ...sample, projectId: id, title: `T ${id}`, scenes: sample.scenes.slice(0, scenes) });
  if (!r.ok) throw new Error('sample invalid');
  return r.project;
}
/** A fixed base time, so many rows can share one millisecond (ties are broken by id). */
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const at = (ms: number) => new Date(BASE + ms).toISOString();

type Target = { name: string; kind: 'memory' | 'sqlite' | 'postgresql' | 'mysql' };
const targets: Target[] = [{ name: 'memory', kind: 'memory' }, ...availableTestDatabases().map((k) => ({ name: k, kind: k }))];

/** Walk every page with `limit`, running `between` after each page; returns the ids in order. */
async function walk<T extends PageAfter>(list: string, filter: string, limit: number, fetch: (r: PageRequest) => Promise<T[]>, between?: (page: number) => Promise<void>) {
  const ids: string[] = [];
  let cursor: string | null | undefined;
  let pages = 0;
  do {
    const req = parsePageQuery(list, filter, { limit, cursor: cursor ?? undefined });
    const page = await readPage(list, filter, req, fetch);
    expect(page.items.length).toBeLessThanOrEqual(limit);
    ids.push(...page.items.map((r) => r.id));
    cursor = page.nextCursor;
    pages++;
    if (between) await between(pages);
  } while (cursor && pages < 1000);
  return ids;
}

describe.each(targets)('keyset paging: $name', ({ kind }) => {
  let repos: Repositories;
  let other: Repositories;
  let db: Database | undefined;
  let testDb: TestDatabase | undefined;

  beforeAll(async () => {
    if (kind === 'memory') {
      repos = createMemoryRepositories();
      other = createMemoryRepositories('ws-other');
      return;
    }
    testDb = await createTestDatabase(kind, tmp);
    db = (await prepareDatabase({ url: testDb.url, dataDir: join(tmp, 'no-legacy-data') })).db;
    await db.ensureWorkspace('ws-other', 'Other');
    repos = db.repositories();
    other = db.repositories('ws-other');
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });

  const project = (r: Repositories, id: string, createdAt: string, scenes = 2) => r.projects.create({ meta: { id, version: 1, createdAt, updatedAt: createdAt }, manifest: manifest(id, scenes) });
  const job = (id: string, createdAt: string, projectId?: string): JobRecord => ({
    id,
    type: 'render',
    status: 'succeeded',
    ...(projectId ? { projectId } : {}),
    params: {},
    createdAt,
    progress: { stage: 'done', fraction: 1 },
  });

  it('projects: a walk sees every existing project exactly once while others are created and updated', async () => {
    // 130 projects over 40 distinct milliseconds: many share a createdAt, so the id tie-break matters.
    const initial = Array.from({ length: 130 }, (_, i) => ({ id: `pg-${String(i).padStart(3, '0')}`, t: at(i % 40) }));
    for (const p of initial) await project(repos, p.id, p.t);
    let n = 0;
    const seen = await walk('projects', '', 17, (r) => repos.projects.page(r), async (page) => {
      // Concurrent writers between (and during) pages: new projects (newer, so after the walk's start) and updates of existing ones.
      await Promise.all([
        project(repos, `pg-new-${n++}`, at(1000 + page)),
        project(repos, `pg-new-${n++}`, at(1000 + page)),
        repos.projects.saveVersion(initial[(page * 7) % initial.length]!.id, 1, manifest(initial[(page * 7) % initial.length]!.id, 1), at(2000 + page)).catch(() => null),
      ]);
    });
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    for (const p of initial) expect(seen).toContain(p.id); // nothing skipped, updated or not
    // Newest first by (createdAt, id).
    const firstOld = seen.findIndex((id) => id.startsWith('pg-') && !id.startsWith('pg-new'));
    expect(seen.slice(firstOld).filter((id) => !id.startsWith('pg-new'))).toEqual([...initial].sort((a, b) => b.t.localeCompare(a.t) || b.id.localeCompare(a.id)).map((p) => p.id));
  });

  it('projects: concurrent creates racing a walk never produce a duplicate or skip an existing row', async () => {
    const before = await walk('projects', '', 200, (r) => repos.projects.page(r));
    let i = 0;
    const writers = Promise.all(Array.from({ length: 4 }, async () => { for (let k = 0; k < 15; k++) await project(repos, `pr-race-${i++}`, at(5000 + k)); }));
    const during = await walk('projects', '', 9, (r) => repos.projects.page(r));
    await writers;
    expect(new Set(during).size).toBe(during.length);
    for (const id of before) expect(during).toContain(id);
  });

  it('projects: summaries without manifests, current after each version', async () => {
    await project(repos, 'ps-sum', at(9000), 2);
    const m = manifest('ps-sum', 2);
    const [first] = await repos.projects.page({ limit: 1 });
    expect(first).toEqual({ id: 'ps-sum', version: 1, createdAt: at(9000), updatedAt: at(9000), title: 'T ps-sum', scenes: 2, durationSeconds: framesToSeconds(totalFrames(m), m.output.fps) });
    const one = { ...manifest('ps-sum', 1), title: 'Renamed' };
    await repos.projects.saveVersion('ps-sum', 1, one, at(9001));
    expect((await repos.projects.page({ limit: 1 }))[0]).toMatchObject({ version: 2, updatedAt: at(9001), title: 'Renamed', scenes: 1, durationSeconds: framesToSeconds(totalFrames(one), one.output.fps) });
  });

  it.skipIf(kind === 'memory')('projects: rows saved before migration 0008 (no summary columns) still list, from their manifest', async () => {
    await project(repos, 'ps-legacy', at(9500), 2);
    await db!.prisma.project.updateMany({ where: { workspaceId: 'default', id: 'ps-legacy' }, data: { sceneCount: null, durationSeconds: null } });
    const m = manifest('ps-legacy', 2);
    expect((await repos.projects.page({ limit: 1 }))[0]).toMatchObject({ id: 'ps-legacy', title: 'T ps-legacy', scenes: 2, durationSeconds: framesToSeconds(totalFrames(m), m.output.fps) });
  });

  it('jobs: walks all and per project exactly once while jobs are inserted', async () => {
    const initial: JobRecord[] = Array.from({ length: 75 }, (_, i) => job(`job_pg${String(i).padStart(3, '0')}`, at(i % 20), i % 3 === 0 ? 'pj-a' : 'pj-b'));
    for (const j of initial) await repos.jobs.insert(j, j.createdAt);
    let n = 0;
    const all = await walk('jobs', '', 11, (r) => repos.jobs.page({}, r), async (p) => {
      await Promise.all([repos.jobs.insert(job(`job_new${n++}`, at(3000 + p), 'pj-a'), at(3000 + p)), repos.jobs.insert(job(`job_new${n++}`, at(3000 + p)), at(3000 + p))]);
    });
    expect(new Set(all).size).toBe(all.length);
    for (const j of initial) expect(all).toContain(j.id);
    const ofA = await walk('jobs', 'pj-a', 7, (r) => repos.jobs.page({ projectId: 'pj-a' }, r));
    expect(new Set(ofA).size).toBe(ofA.length);
    expect(ofA.filter((id) => id.startsWith('job_pg'))).toEqual(
      initial.filter((j) => j.projectId === 'pj-a').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map((j) => j.id)
    );
    const full = await repos.jobs.list({ projectId: 'pj-a' });
    expect(ofA).toEqual(full.map((j) => j.id));
  });

  it('jobs: walks the children of one parent (parentId) exactly once, in order, without other jobs', async () => {
    // A fanned-out render's units and join (#184): many share a createdAt; another parent's children and the parent itself stay out.
    const kids: JobRecord[] = Array.from({ length: 23 }, (_, i) => ({ ...job(`job_kid${String(i).padStart(3, '0')}`, at(4000 + (i % 4)), 'pk-a'), type: i === 22 ? 'render_join' : 'render_unit', parentId: 'job_kparent' }));
    await repos.jobs.insert(job('job_kparent', at(3999), 'pk-a'), at(3999));
    for (const j of kids) await repos.jobs.insert(j, j.createdAt);
    for (let i = 0; i < 5; i++) await repos.jobs.insert({ ...job(`job_kother${i}`, at(4000 + i), 'pk-a'), type: 'render_unit', parentId: 'job_kparent2' }, at(4000 + i));
    const expected = [...kids].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map((j) => j.id);
    let n = 0;
    const seen = await walk('jobs', '|parent:job_kparent', 4, (r) => repos.jobs.page({ parentId: 'job_kparent' }, r), async () => {
      await repos.jobs.insert(job(`job_knew${n++}`, at(6000 + n), 'pk-a'), at(6000 + n)); // unrelated inserts during the walk
    });
    expect(seen).toEqual(expected);
    expect(await walk('jobs', 'pk-a|parent:job_kparent', 5, (r) => repos.jobs.page({ projectId: 'pk-a', parentId: 'job_kparent' }, r))).toEqual(expected);
    expect(await walk('jobs', 'pk-b|parent:job_kparent', 5, (r) => repos.jobs.page({ projectId: 'pk-b', parentId: 'job_kparent' }, r))).toEqual([]);
    expect(await other.jobs.page({ parentId: 'job_kparent' }, { limit: 50 })).toEqual([]);
  });

  it('assets: walks exactly once in (createdAt, id) order', async () => {
    const asset = (i: number): AssetRecord => {
      const id = `ast-${i.toString(16).padStart(16, '0')}`;
      return { id, sha256: id.padEnd(64, '0'), bytes: 10, contentType: 'image/png', mediaType: 'image', createdAt: at(i % 5), source: 'upload', storageKey: `${id}/f.png` };
    };
    for (let i = 0; i < 23; i++) await repos.assets.insertIfAbsent(asset(i));
    const ids = await walk('assets', '', 4, (r) => repos.assets.page(r));
    expect(ids).toEqual((await repos.assets.list()).map((a) => a.id));
    expect(ids).toHaveLength(23);
  });

  // (A NUL byte is not here: PostgreSQL refuses it in text as an encoding error. The API never passes one:
  // parsePageQuery only accepts ids of [A-Za-z0-9_.:-], and list_jobs answers an impossible projectId itself.)
  it('a position is a parameter, never SQL: hostile ids find nothing extra and break nothing', async () => {
    const total = (await walk('projects', '', 200, (r) => repos.projects.page(r))).length;
    for (const id of ["x' OR '1'='1", 'x" OR "1"="1', "zzz'; DROP TABLE \"Project\"; --", 'zzz\\', '%', 'zzzz_%']) {
      const rows = await repos.projects.page({ limit: 500, after: { createdAt: at(10_000_000), id } });
      expect(rows.length).toBe(total); // every row is older than that time; the id only breaks ties
      await repos.jobs.page({ projectId: id }, { limit: 5 }).then((r) => expect(r).toEqual([]));
    }
    expect((await walk('projects', '', 200, (r) => repos.projects.page(r))).length).toBe(total);
  });

  it('workspaces stay apart: a cursor from one workspace pages only the other workspace\'s rows', async () => {
    await project(other, 'pw-only-other', at(10));
    const mine = await repos.projects.page({ limit: 3 });
    const theirs = await other.projects.page({ limit: 500, after: { createdAt: mine[2]!.createdAt, id: mine[2]!.id } });
    expect(theirs.map((p) => p.id)).toEqual(['pw-only-other']);
    expect((await other.projects.page({ limit: 500 })).map((p) => p.id)).toEqual(['pw-only-other']);
    expect((await repos.projects.page({ limit: 500 })).map((p) => p.id)).not.toContain('pw-only-other');
    expect(await other.jobs.page({}, { limit: 500 })).toEqual([]);
    expect(await other.assets.page({ limit: 500 })).toEqual([]);
  });
});
