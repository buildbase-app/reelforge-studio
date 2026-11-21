/**
 * Repository contract: the same suite against every implementation.
 *
 *   memory      always (createMemoryRepositories in @reelforge/core)
 *   sqlite      always
 *   postgresql  when TEST_POSTGRES_URL is set (a fresh schema per run)
 *   mysql       when TEST_MYSQL_URL is set (a fresh database per run)
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@reelforge/project-schema';
import {
  JobRunner,
  KeyStore,
  RuntimeConfig,
  ProjectStore,
  createMemoryRepositories,
  importFilesystemV01,
  type JobRecord,
  type Repositories,
} from '@reelforge/core';
import { Database, availableTestDatabases, createTestDatabase, prepareDatabase, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-db-contract-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
function manifest(id: string, title = 'A title'): Project {
  const r = parseProject({ ...sample, projectId: id, title });
  if (!r.ok) throw new Error('sample invalid');
  return r.project;
}
const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Target = { name: string; kind: 'memory' | 'sqlite' | 'postgresql' | 'mysql' };
const targets: Target[] = [{ name: 'memory', kind: 'memory' }, ...availableTestDatabases().map((k) => ({ name: k, kind: k }))];

describe.each(targets)('repository contract: $name', ({ kind }) => {
  let repos: Repositories;
  let db: Database | undefined;
  let testDb: TestDatabase | undefined;

  beforeAll(async () => {
    if (kind === 'memory') {
      repos = createMemoryRepositories();
      return;
    }
    testDb = await createTestDatabase(kind, tmp);
    db = (await prepareDatabase({ url: testDb.url, dataDir: join(tmp, 'no-legacy-data') })).db;
    repos = db.repositories();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });

  describe('projects + versions', () => {
    it('creates at version 1 and refuses duplicates', async () => {
      const t = now();
      await repos.projects.create({ meta: { id: 'p1', version: 1, createdAt: t, updatedAt: t }, manifest: manifest('p1') });
      const got = await repos.projects.get('p1');
      expect(got?.meta).toEqual({ id: 'p1', version: 1, createdAt: t, updatedAt: t });
      expect(got?.manifest).toEqual(manifest('p1'));
      await expect(repos.projects.create({ meta: { id: 'p1', version: 1, createdAt: t, updatedAt: t }, manifest: manifest('p1') })).rejects.toMatchObject({ code: 'conflict', status: 409 });
      expect(await repos.projects.get('missing')).toBeNull();
    });

    it('round-trips JSON exactly (key order, unicode, large documents)', async () => {
      const m = manifest('p-json', 'Ünïcødé — emoji 🎬 "quotes" \\ back');
      const big = { ...m, brief: { ...(m as unknown as { brief?: object }).brief, notes: 'x'.repeat(1_500_000), z: 1, a: 2 } } as unknown as Project;
      const t = now();
      await repos.projects.create({ meta: { id: 'p-json', version: 1, createdAt: t, updatedAt: t }, manifest: big });
      const got = await repos.projects.get('p-json');
      expect(JSON.stringify(got?.manifest)).toBe(JSON.stringify(big));
      expect(await repos.projects.delete('p-json')).toBe(true);
    });

    it('saves versions atomically with optimistic concurrency', async () => {
      const t = later(10);
      const meta = await repos.projects.saveVersion('p1', 1, manifest('p1', 'Second'), t);
      expect(meta).toMatchObject({ id: 'p1', version: 2, updatedAt: t });
      expect(await repos.projects.saveVersion('p1', 1, manifest('p1', 'Stale'), later(20))).toBeNull();
      expect(await repos.projects.saveVersion('missing', 1, manifest('missing'), later(20))).toBeNull();
      expect(await repos.projects.listVersions('p1')).toEqual([1, 2]);
      expect((await repos.projects.getVersion('p1', 1))?.title).toBe('A title');
      expect((await repos.projects.getVersion('p1', 2))?.title).toBe('Second');
      expect(await repos.projects.getVersion('p1', 3)).toBeNull();
      expect((await repos.projects.get('p1'))?.manifest.title).toBe('Second');
    });

    it('lets exactly one of several concurrent saves of the same version win', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => repos.projects.saveVersion('p1', 2, manifest('p1', `race ${i}`), later(30))));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await repos.projects.listVersions('p1')).toEqual([1, 2, 3]);
    });

    it('lists projects with their current manifest, most recently updated first', async () => {
      const t = later(1000);
      await repos.projects.create({ meta: { id: 'p2', version: 1, createdAt: t, updatedAt: t }, manifest: manifest('p2', 'Newest') });
      const list = await repos.projects.list();
      expect(list.map((p) => p.meta.id)).toEqual(['p2', 'p1']);
      expect(list[0]!.manifest.title).toBe('Newest');
      expect(list[1]!.meta.version).toBe(3);
    });

    it('deletes a project with all its versions', async () => {
      expect(await repos.projects.delete('p2')).toBe(true);
      expect(await repos.projects.delete('p2')).toBe(false);
      expect(await repos.projects.get('p2')).toBeNull();
      expect(await repos.projects.listVersions('p2')).toEqual([]);
      expect(await repos.projects.getVersion('p2', 1)).toBeNull();
    });

    it('ProjectStore: serialises in-process writers and retries a writer from another process', async () => {
      const a = new ProjectStore(repos.projects, tmp);
      const b = new ProjectStore(repos.projects, tmp); // "another process": its own lock
      await a.create(manifest('p-race'));
      await Promise.all([
        ...Array.from({ length: 5 }, (_, i) => a.update('p-race', (m) => ({ ...m, title: `${m.title}.a${i}` }))),
        ...Array.from({ length: 5 }, (_, i) => b.update('p-race', (m) => ({ ...m, title: `${m.title}.b${i}` }))),
      ]);
      const got = await a.get('p-race');
      expect(got.meta.version).toBe(11);
      expect(got.manifest.title.split('.')).toHaveLength(11); // no lost update
      await expect(a.update('p-race', (m) => m, 3)).rejects.toMatchObject({ code: 'version_conflict', status: 409 });
    });
  });

  describe('API keys', () => {
    it('stores, finds by prefix, touches and deletes', async () => {
      const base = { scopes: ['read', 'render'] as const, salt: 'aa', hash: 'bb' };
      await repos.keys.insert({ id: 'key_a', name: 'a', prefix: 'rf_aaaa', createdAt: now(), ...base, scopes: [...base.scopes] });
      await repos.keys.insert({ id: 'key_b', name: 'b', prefix: 'rf_bbbb', createdAt: later(5), ...base, scopes: ['admin'] });
      await expect(repos.keys.insert({ id: 'key_a', name: 'dup', prefix: 'rf_aaaa', createdAt: now(), ...base, scopes: ['read'] })).rejects.toMatchObject({ code: 'conflict' });
      expect(await repos.keys.count()).toBe(2);
      expect((await repos.keys.list()).map((k) => k.id)).toEqual(['key_a', 'key_b']);
      const found = await repos.keys.findByPrefix('rf_aaaa');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ id: 'key_a', scopes: ['read', 'render'], salt: 'aa', hash: 'bb' });
      expect(found[0]!.lastUsedAt).toBeUndefined();
      const t = later(10);
      await repos.keys.touch('key_a', t);
      expect((await repos.keys.findByPrefix('rf_aaaa'))[0]!.lastUsedAt).toBe(t);
      expect(await repos.keys.delete('key_a')).toBe(true);
      expect(await repos.keys.delete('key_a')).toBe(false);
      expect(await repos.keys.findByPrefix('rf_aaaa')).toEqual([]);
    });

    it('KeyStore verifies keys created through another instance at once', async () => {
      const server = new KeyStore(repos.keys);
      const cli = new KeyStore(repos.keys);
      const { key } = await cli.create('from-cli', ['read']);
      expect((await server.verify(key))?.name).toBe('from-cli');
      expect(await server.verify(key.slice(0, -1) + (key.endsWith('a') ? 'b' : 'a'))).toBeNull();
    });
  });

  describe('jobs + events', () => {
    const job = (id: string, extra: Partial<JobRecord> = {}): JobRecord => ({
      id,
      type: 'render',
      status: 'queued',
      params: { projectId: 'p1', version: 2, nested: { b: 1, a: [1, 2] } },
      createdAt: now(),
      progress: { stage: 'queued', fraction: 0 },
      ...extra,
    });

    it('inserts, updates, transitions and reads jobs', async () => {
      const j = job('job_a', { projectId: 'p1' });
      await repos.jobs.insert(j, j.createdAt);
      expect(await repos.jobs.get('job_a')).toEqual(j);
      const running = { ...j, status: 'running' as const, startedAt: later(1), progress: { stage: 'render', fraction: 0.25, detail: 'scene 1' } };
      await repos.jobs.transition(running, running.startedAt);
      await repos.jobs.update({ ...running, progress: { stage: 'render', fraction: 0.5 } });
      expect((await repos.jobs.get('job_a'))?.progress).toEqual({ stage: 'render', fraction: 0.5 });
      const done = { ...running, status: 'failed' as const, finishedAt: later(2), error: { code: 'render_failed', message: 'boom', stage: 'encode' } };
      await repos.jobs.transition(done, done.finishedAt);
      expect(await repos.jobs.get('job_a')).toEqual(done);
      await expect(repos.jobs.insert(j, j.createdAt)).rejects.toMatchObject({ code: 'conflict' });
      expect(await repos.jobs.get('job_missing')).toBeNull();
    });

    it('lists newest first with filters, and the unfinished ones', async () => {
      await repos.jobs.insert(job('job_b', { createdAt: later(50), type: 'preview' }), now());
      await repos.jobs.insert(job('job_c', { createdAt: later(60), projectId: 'p1', status: 'running' }), now());
      expect((await repos.jobs.list()).map((j) => j.id)).toEqual(['job_c', 'job_b', 'job_a']);
      expect((await repos.jobs.list({ projectId: 'p1' })).map((j) => j.id)).toEqual(['job_c', 'job_a']);
      expect((await repos.jobs.list({ type: 'preview' })).map((j) => j.id)).toEqual(['job_b']);
      expect((await repos.jobs.list({ status: 'failed' })).map((j) => j.id)).toEqual(['job_a']);
      expect((await repos.jobs.listUnfinished()).map((j) => j.id).sort()).toEqual(['job_b', 'job_c']);
    });

    it('keeps log lines in order, with tail and long lines', async () => {
      const base = Date.now();
      for (let i = 0; i < 12; i++) await repos.jobs.appendLog('job_b', new Date(base + i).toISOString(), `line ${i}`);
      const long = 'y'.repeat(70_000);
      await repos.jobs.appendLog('job_b', new Date(base + 20).toISOString(), long);
      const all = await repos.jobs.logs('job_b');
      expect(all).toHaveLength(13);
      expect(all[0]).toBe(`${new Date(base).toISOString()} line 0`);
      expect(all[12]!.endsWith(long)).toBe(true);
      expect((await repos.jobs.logs('job_b', 3)).map((l) => l.slice(25))).toEqual(['line 10', 'line 11', long]);
      expect(await repos.jobs.logs('job_a')).toEqual([]);
    });

    it('JobRunner: runs a job end to end and marks jobs interrupted by a restart', async () => {
      const runner = new JobRunner({ repo: repos.jobs, handlers: { work: async (ctx) => (ctx.log('working'), ctx.progress('half', 0.5), { ok: true }) } });
      await runner.init(); // job_b and job_c (queued/running in the database) are interrupted
      expect((await runner.get('job_c')).error?.code).toBe('interrupted');
      const j = await runner.submit('work', { x: 1 });
      const done = await runner.waitFor(j.id);
      await runner.flush();
      expect(done.status).toBe('succeeded');
      const stored = await repos.jobs.get(j.id);
      expect(stored).toMatchObject({ status: 'succeeded', result: { ok: true }, progress: { stage: 'done', fraction: 1 } });
      expect((await runner.logs(j.id)).some((l) => l.endsWith('working'))).toBe(true);
      expect((await runner.list({ status: 'succeeded' })).map((x) => x.id)).toContain(j.id);
    });
  });

  describe('themes', () => {
    const theme = (id: string, primary = '#ff0000') => ({
      id,
      name: `Theme ${id}`,
      tokens: { colors: { background: '#000000', primary } },
    }) as never;

    it('inserts, refuses duplicates, replaces, lists by id and deletes', async () => {
      await repos.themes.insert(theme('zeta'), now());
      await repos.themes.insert(theme('alpha'), now());
      await expect(repos.themes.insert(theme('alpha'), now())).rejects.toMatchObject({ code: 'conflict' });
      await repos.themes.put(theme('alpha', '#00ff00'), later(5));
      expect(await repos.themes.get('alpha')).toEqual(theme('alpha', '#00ff00'));
      expect((await repos.themes.list()).map((t) => t.id)).toEqual(['alpha', 'zeta']);
      expect(await repos.themes.delete('zeta')).toBe(true);
      expect(await repos.themes.delete('zeta')).toBe(false);
      expect(await repos.themes.get('zeta')).toBeNull();
    });
  });

  describe('provider settings', () => {
    it('sets and clears several settings at once, keeps the scheme, and never lists values', async () => {
      await repos.providerSettings.apply({ ELEVENLABS_API_KEY: { value: 'secret-1', scheme: 'plain' }, OTHER: { value: 'x', scheme: 'plain' } }, now(), 'elevenlabs');
      expect(await repos.providerSettings.values()).toEqual({ ELEVENLABS_API_KEY: { value: 'secret-1', scheme: 'plain' }, OTHER: { value: 'x', scheme: 'plain' } });
      await repos.providerSettings.apply({ OTHER: null, ELEVENLABS_API_KEY: { value: 'v1.kid.iv.tag.ct', scheme: 'aes-256-gcm' } }, later(5));
      expect(await repos.providerSettings.values()).toEqual({ ELEVENLABS_API_KEY: { value: 'v1.kid.iv.tag.ct', scheme: 'aes-256-gcm' } });
      const list = await repos.providerSettings.list();
      // A set without providerId keeps the stored one.
      expect(list).toEqual([expect.objectContaining({ name: 'ELEVENLABS_API_KEY', providerId: 'elevenlabs', scheme: 'aes-256-gcm' })]);
      expect(JSON.stringify(list)).not.toContain('v1.kid');
      await repos.providerSettings.apply({ ELEVENLABS_API_KEY: null }, later(6));
      expect(await repos.providerSettings.values()).toEqual({});
    });
  });

  describe('runtime settings', () => {
    it('sets, replaces and clears settings atomically with who and when, sorted by key', async () => {
      const t1 = now();
      await repos.settings.apply(
        { 'limits.rateLimitPerMinute': { value: '120', scheme: 'plain' }, 'server.allowedHosts': { value: '["a.example","b"]', scheme: 'plain' } },
        t1,
        'key_admin'
      );
      expect(await repos.settings.list()).toEqual([
        { key: 'limits.rateLimitPerMinute', value: '120', scheme: 'plain', updatedAt: t1, updatedBy: 'key_admin' },
        { key: 'server.allowedHosts', value: '["a.example","b"]', scheme: 'plain', updatedAt: t1, updatedBy: 'key_admin' },
      ]);
      const t2 = later(10);
      const long = 'v1.' + 'x'.repeat(5000);
      await repos.settings.apply({ 'server.allowedHosts': null, 'licence.key': { value: long, scheme: 'aes-256-gcm' }, 'limits.rateLimitPerMinute': { value: '7', scheme: 'plain' } }, t2);
      expect(await repos.settings.list()).toEqual([
        { key: 'licence.key', value: long, scheme: 'aes-256-gcm', updatedAt: t2 },
        { key: 'limits.rateLimitPerMinute', value: '7', scheme: 'plain', updatedAt: t2 },
      ]);
      await repos.settings.apply({ 'licence.key': null, 'limits.rateLimitPerMinute': null, 'not.there': null }, later(20));
      expect(await repos.settings.list()).toEqual([]);
    });

    it('RuntimeConfig: stores runtime values and encrypted secrets that a second instance reads back', async () => {
      const sources = { env: { REELFORGE_SECRET_KEY: 'k'.repeat(40), REELFORGE_RATE_LIMIT_PER_MINUTE: '50' } };
      const a = new RuntimeConfig(repos, sources);
      await a.load();
      expect(a.config.limits.rateLimitPerMinute).toBe(50);
      await a.update({ 'limits.rateLimitPerMinute': 9, 'licence.key': 'LIC-123-secret', 'providers.elevenlabs.apiKey': 'sk_contract_secret' }, 'key_x');
      const b = new RuntimeConfig(repos, sources);
      await b.load();
      expect(b.config.limits.rateLimitPerMinute).toBe(9);
      expect(b.config.licence.key).toBe('LIC-123-secret');
      expect(b.config.providers.elevenlabs.apiKey).toBe('sk_contract_secret');
      const stored = JSON.stringify([await repos.settings.list(), await repos.providerSettings.values()]);
      expect(stored).not.toContain('LIC-123-secret');
      expect(stored).not.toContain('sk_contract_secret');
      await b.update({ 'limits.rateLimitPerMinute': null, 'licence.key': null, 'providers.elevenlabs.apiKey': null });
      expect(await repos.settings.list()).toEqual([]);
      expect(await repos.providerSettings.values()).toEqual({});
    });
  });

  describe('assets', () => {
    it('is content addressed: inserting the same id returns the stored row', async () => {
      const a = {
        id: 'ast-0123456789abcdef',
        sha256: '0123456789abcdef'.repeat(4),
        bytes: 3_000_000_000, // > 2^31
        contentType: 'video/mp4',
        mediaType: 'video' as const,
        createdAt: now(),
        source: 'upload',
        storageKey: 'ast-0123456789abcdef/file.mp4',
        license: { name: 'CC0', redistributable: true },
        metadata: { words: [{ w: 'hi', t: 0.1 }] },
      };
      expect(await repos.assets.insertIfAbsent(a)).toEqual(a);
      expect(await repos.assets.insertIfAbsent({ ...a, source: 'other' })).toEqual(a);
      expect(await repos.assets.get(a.id)).toEqual(a);
      const updated = await repos.assets.update(a.id, { durationSeconds: 1.5 });
      expect(updated).toEqual({ ...a, durationSeconds: 1.5 });
      expect(await repos.assets.update('ast-ffffffffffffffff', { durationSeconds: 1 })).toBeNull();
      await repos.assets.insertIfAbsent({ ...a, id: 'ast-1111111111111111', storageKey: 'ast-1111111111111111/file.mp4', createdAt: later(10), license: undefined, metadata: undefined } as never);
      expect((await repos.assets.list()).map((x) => x.id)).toEqual(['ast-1111111111111111', a.id]);
    });
  });

  describe('audit log', () => {
    it('writes entries and lists them newest first', async () => {
      const e1 = await repos.audit.write({ actorType: 'cli', action: 'key.create', targetType: 'key', targetId: 'key_x' });
      await sleep(5);
      const e2 = await repos.audit.write({ actorType: 'api_key', actorId: 'key_y', action: 'provider.configure', data: { names: ['ELEVENLABS_API_KEY'] } });
      expect(e1.id).not.toBe(e2.id);
      const list = await repos.audit.list({ limit: 10 });
      expect(list.slice(0, 2)).toEqual([e2, e1]);
    });
  });

  describe('v0.1 filesystem import', () => {
    it('imports projects, versions, keys, themes, jobs, logs, settings and asset metadata, idempotently', async () => {
      const legacy = join(tmp, `legacy-${kind}`);
      const fixture = writeLegacyFixture(legacy);
      const report = await importFilesystemV01(repos, legacy);
      expect(report).toMatchObject({ projects: 1, versions: 2, keys: 1, themes: 1, jobs: 1, logLines: 3, assets: 1, providerSettings: 1, warnings: [] });

      const p = await repos.projects.get('legacy-reel');
      expect(p?.meta).toEqual({ id: 'legacy-reel', version: 2, createdAt: fixture.createdAt, updatedAt: fixture.updatedAt });
      expect(p?.manifest.title).toBe('Legacy v2');
      expect((await repos.projects.getVersion('legacy-reel', 1))?.title).toBe('Legacy v1');
      expect((await new KeyStore(repos.keys).verify(fixture.key))?.name).toBe('legacy');
      expect((await repos.themes.get('legacy-theme'))?.id).toBe('legacy-theme');
      expect(await repos.jobs.get('job_legacy')).toMatchObject({ status: 'succeeded', projectId: 'legacy-reel' });
      expect(await repos.jobs.logs('job_legacy')).toEqual([
        '2026-11-01T10:00:00.000Z started render',
        '2026-11-01T10:00:01.000Z ffmpeg says',
        '2026-11-01T10:00:01.000Z   a continuation line',
      ]);
      expect((await repos.providerSettings.values()).LEGACY_KEY).toEqual({ value: 'legacy-value', scheme: 'plain' });
      expect((await repos.assets.get('ast-aaaaaaaaaaaaaaaa'))?.storageKey).toBe('ast-aaaaaaaaaaaaaaaa/file.png');

      const again = await importFilesystemV01(repos, legacy);
      expect(again).toMatchObject({ projects: 0, versions: 0, keys: 0, themes: 0, jobs: 0, logLines: 0, assets: 0, providerSettings: 0 });
      expect(again.skipped).toBeGreaterThanOrEqual(5);
      expect(await repos.projects.listVersions('legacy-reel')).toEqual([1, 2]);
    });
  });

  if (kind !== 'memory') {
    describe('database', () => {
      it('has no pending migrations and migrating again is a no-op', async () => {
        expect((await db!.status()).pending).toEqual([]);
        expect(await db!.migrate()).toEqual([]);
      });

      it('isolates workspaces', async () => {
        await db!.ensureWorkspace('other', 'Other');
        const other = db!.repositories('other');
        expect(await other.projects.get('p1')).toBeNull();
        expect(await other.keys.count()).toBe(0);
        const t = now();
        await other.projects.create({ meta: { id: 'p1', version: 1, createdAt: t, updatedAt: t }, manifest: manifest('p1', 'Other workspace') });
        expect((await repos.projects.get('p1'))?.manifest.title).not.toBe('Other workspace');
      });

      it('imports a data directory only once, and migrates concurrently from two processes on a fresh database', async () => {
        const legacy = join(tmp, `legacy-once-${kind}`);
        writeLegacyFixture(legacy);
        const fresh = await createTestDatabase(kind, tmp);
        try {
          const [a, b] = await Promise.all([Database.open({ url: fresh.url }), Database.open({ url: fresh.url })]);
          // better-sqlite3 is synchronous: two connections in ONE process would block each
          // other's event loop, so SQLite migrates one after the other here (separate
          // processes, like the server and the CLI, wait on SQLite's lock instead).
          const ran = kind === 'sqlite' ? [await a.migrate(), await b.migrate()] : await Promise.all([a.migrate(), b.migrate()]);
          expect(ran.flat()).toEqual(['0001_init', '0002_runtime_settings']);
          const first = await a.importFilesystemOnce(legacy);
          expect(first?.projects).toBe(1);
          expect(await b.importFilesystemOnce(legacy)).toBeNull();
          expect((await b.importFilesystemOnce(legacy, { force: true }))?.projects).toBe(0);
          await Promise.all([a.close(), b.close()]);
        } finally {
          await fresh.drop();
        }
      }, 60_000);
    });
  }
});

/** A data directory as v0.1 wrote it (before the database). */
function writeLegacyFixture(dir: string) {
  const createdAt = '2026-11-01T09:00:00.000Z';
  const updatedAt = '2026-11-01T09:30:00.000Z';
  const pdir = join(dir, 'projects/legacy-reel');
  mkdirSync(join(pdir, 'versions'), { recursive: true });
  mkdirSync(join(pdir, 'assets'), { recursive: true });
  const v1 = manifest('legacy-reel', 'Legacy v1');
  const v2 = manifest('legacy-reel', 'Legacy v2');
  writeFileSync(join(pdir, 'versions/000001.json'), JSON.stringify(v1));
  writeFileSync(join(pdir, 'versions/000002.json'), JSON.stringify(v2));
  writeFileSync(join(pdir, 'project.json'), JSON.stringify(v2));
  writeFileSync(join(pdir, 'meta.json'), JSON.stringify({ id: 'legacy-reel', version: 2, createdAt, updatedAt }));
  const key = `rf_${randomBytes(32).toString('base64url')}`;
  const salt = randomBytes(16).toString('hex');
  writeFileSync(
    join(dir, 'keys.json'),
    JSON.stringify([{ id: 'key_legacy', name: 'legacy', scopes: ['admin'], prefix: key.slice(0, 7), salt, hash: createHash('sha256').update(salt).update(key).digest('hex'), createdAt }])
  );
  mkdirSync(join(dir, 'themes'), { recursive: true });
  writeFileSync(join(dir, 'themes/legacy-theme.json'), JSON.stringify({ id: 'legacy-theme', name: 'Legacy', tokens: {} }));
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ LEGACY_KEY: 'legacy-value' }));
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  writeFileSync(
    join(dir, 'jobs/job_legacy.json'),
    JSON.stringify({ id: 'job_legacy', type: 'render', status: 'succeeded', projectId: 'legacy-reel', params: { projectId: 'legacy-reel', version: 2 }, createdAt, startedAt: createdAt, finishedAt: updatedAt, progress: { stage: 'done', fraction: 1 }, result: { renderId: 'run_x' } })
  );
  writeFileSync(join(dir, 'jobs/job_legacy.log'), '2026-11-01T10:00:00.000Z started render\n2026-11-01T10:00:01.000Z ffmpeg says\n  a continuation line\n');
  mkdirSync(join(dir, 'assets/ast-aaaaaaaaaaaaaaaa'), { recursive: true });
  writeFileSync(join(dir, 'assets/ast-aaaaaaaaaaaaaaaa/file.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(
    join(dir, 'assets/ast-aaaaaaaaaaaaaaaa/meta.json'),
    JSON.stringify({ id: 'ast-aaaaaaaaaaaaaaaa', sha256: 'a'.repeat(64), bytes: 4, contentType: 'image/png', mediaType: 'image', createdAt, source: 'upload' })
  );
  return { key, createdAt, updatedAt };
}
