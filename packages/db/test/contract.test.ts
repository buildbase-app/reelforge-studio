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
  AuditLog,
  JobRunner,
  KeyStore,
  withIdempotency,
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

  describe('API key lifecycle (#65)', () => {
    it('round-trips every lifecycle field, updates atomically, clears with null and finds the previous secret by prefix', async () => {
      const t = now();
      await repos.keys.insert({
        id: 'key_life', name: 'life', scopes: ['read'], prefix: 'rf_life', salt: 's1', hash: 'h1', createdAt: t,
        expiresAt: later(3_600_000), rateLimitPerMinute: 7, rendersPerDay: 2, rendersPerMonth: 30, ipAllowlist: ['10.0.0.0/8', '2001:db8::/32'],
      });
      const got = await repos.keys.get('key_life');
      expect(got).toMatchObject({ rateLimitPerMinute: 7, rendersPerDay: 2, rendersPerMonth: 30, ipAllowlist: ['10.0.0.0/8', '2001:db8::/32'] });
      expect(got!.expiresAt).toMatch(/Z$/);
      const exp = later(7_200_000);
      const rotated = await repos.keys.update('key_life', {
        secret: { prefix: 'rf_new1', salt: 's2', hash: 'h2' },
        prev: { prefix: 'rf_life', salt: 's1', hash: 'h1', expiresAt: exp },
        rotatedAt: t,
        rateLimitPerMinute: null,
        ipAllowlist: null,
      });
      expect(rotated).toMatchObject({ prefix: 'rf_new1', hash: 'h2', prev: { prefix: 'rf_life', salt: 's1', hash: 'h1', expiresAt: exp }, rotatedAt: t, rendersPerDay: 2 });
      expect(rotated!.rateLimitPerMinute).toBeUndefined();
      expect(rotated!.ipAllowlist).toBeUndefined();
      expect((await repos.keys.findByPrefix('rf_life')).map((k) => k.id)).toEqual(['key_life']);
      expect((await repos.keys.findByPrefix('rf_new1')).map((k) => k.id)).toEqual(['key_life']);
      const revoked = await repos.keys.update('key_life', { revokedAt: later(10), prev: null, expiresAt: null });
      expect(revoked!.prev).toBeUndefined();
      expect(revoked!.expiresAt).toBeUndefined();
      expect(revoked!.revokedAt).toBeDefined();
      expect(await repos.keys.findByPrefix('rf_life')).toEqual([]);
      expect(await repos.keys.update('missing', { name: 'x' })).toBeNull();
      expect(await repos.keys.get('missing')).toBeNull();
      expect(await repos.keys.delete('key_life')).toBe(true);
    });

    it('KeyStore: expiry, rotation grace (injected clock), revocation and IP allowlist on this database', async () => {
      let clock = Date.now();
      const audit = new AuditLog(repos.audit);
      const store = new KeyStore(repos.keys, { now: () => clock, audit: (e) => audit.write(e), rotationGraceHours: () => 2 });
      const { key, record } = await store.create('lifecycle', ['read'], { expiresAt: new Date(clock + 86_400_000).toISOString(), ipAllowlist: ['192.0.2.0/24'] }, { actorType: 'cli' });
      expect((await store.authenticate(key, { ip: '192.0.2.7' })).ok).toBe(true);
      expect((await store.authenticate(key, { ip: '::ffff:192.0.2.9' })).ok).toBe(true);
      expect(await store.authenticate(key, { ip: '198.51.100.1' })).toMatchObject({ ok: false, reason: 'ip_not_allowed', key: { id: record.id } });
      expect(await store.authenticate(key)).toMatchObject({ ok: false, reason: 'ip_not_allowed' });
      await store.update(record.id, { ipAllowlist: null });
      const { key: fresh } = await store.rotate(record.id);
      expect((await store.verify(fresh))?.keyId).toBe(record.id);
      expect((await store.authenticate(key)).ok && (await store.verify(key))?.previousSecret).toBe(true);
      clock += 2 * 3_600_000 + 1;
      expect(await store.verify(key)).toBeNull();
      expect(await store.verify(fresh)).not.toBeNull();
      clock += 86_400_000;
      expect(await store.authenticate(fresh)).toMatchObject({ ok: false, reason: 'expired' });
      expect((await store.get(record.id)).status).toBe('expired');
      await store.update(record.id, { expiresAt: null });
      await store.revoke(record.id);
      expect(await store.authenticate(fresh)).toMatchObject({ ok: false, reason: 'revoked' });
      expect((await store.get(record.id)).status).toBe('revoked');
      const trail = (await repos.audit.list({ targetId: record.id, limit: 20 })).map((e) => e.action).reverse();
      expect(trail).toEqual(['key.create', 'key.update', 'key.rotate', 'key.update', 'key.revoke']);
      expect(JSON.stringify(await repos.audit.list({ targetId: record.id }))).not.toContain(key.slice(3));
      expect(JSON.stringify(await repos.audit.list({ targetId: record.id }))).not.toContain(fresh.slice(3));
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
      priority: 'standard',
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

    it('counts the jobs an API key started since a time, by type (render quotas)', async () => {
      const t0 = later(-60_000);
      await repos.jobs.insert(job('job_q1', { apiKeyId: 'key_q', type: 'render', status: 'succeeded', createdAt: later(1) }), now());
      await repos.jobs.insert(job('job_q2', { apiKeyId: 'key_q', type: 'preview', status: 'succeeded', createdAt: later(2) }), now());
      await repos.jobs.insert(job('job_q3', { apiKeyId: 'key_q', type: 'other', status: 'succeeded', createdAt: later(3) }), now());
      await repos.jobs.insert(job('job_q4', { apiKeyId: 'key_other', type: 'render', status: 'succeeded', createdAt: later(4) }), now());
      expect(await repos.jobs.countByApiKey('key_q', t0, ['render', 'preview'])).toBe(2);
      expect(await repos.jobs.countByApiKey('key_q', later(100_000), ['render', 'preview'])).toBe(0);
      expect((await repos.jobs.get('job_q1'))?.apiKeyId).toBe('key_q');
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

  describe('licence state', () => {
    it('creates the instance id once, round-trips every field, and keeps the instance id on save', async () => {
      expect(await repos.licence.get()).toBeNull();
      const t0 = now();
      const first = await repos.licence.init('rf-instance-a', t0);
      expect(first).toEqual({ instanceId: 'rf-instance-a', updatedAt: t0 });
      // A second start (or a second process) gets the stored instance id, not its own.
      expect((await repos.licence.init('rf-instance-b', later(5))).instanceId).toBe('rf-instance-a');
      const full = {
        instanceId: 'rf-instance-a',
        keyHash: 'h'.repeat(64),
        answer: { valid: true, reason: null, key: { status: 'active', activations: 1, activationLimit: 1, expiresAt: null }, item: { id: 'itm_1', title: 'ReelForge' }, instance: { instance: 'rf-instance-a', activatedAt: t0 } },
        lastCheckedAt: later(10),
        lastSuccessAt: later(10),
        lastError: { kind: 'unreachable', message: 'connect ECONNREFUSED', at: later(9) },
        activatedAt: t0,
        deactivatedAt: later(11),
        nextCheckAt: later(86_400_000),
        highWaterAt: later(12),
        updatedAt: later(12),
      };
      await repos.licence.save(full);
      expect(await repos.licence.get()).toEqual(full);
      // Clearing optional fields; a different instance id is ignored.
      const t3 = later(20);
      await repos.licence.save({ instanceId: 'rf-other', lastCheckedAt: t3, updatedAt: t3 });
      expect(await repos.licence.get()).toEqual({ instanceId: 'rf-instance-a', lastCheckedAt: t3, updatedAt: t3 });
    });

    it('single flight per deployment (D-098): claimCheck lets exactly one of many concurrent callers take a due check; save with ifUpdatedAt is a compare-and-set', async () => {
      const t = Date.parse(later(30));
      const iso = (ms: number) => new Date(ms).toISOString();
      const lease = 120_000;
      const claim = (at: number, unusable = false) => repos.licence.claimCheck({ now: iso(at), leaseUntil: iso(at + lease), ...(unusable ? { orLaterThan: iso(at + 2 * lease) } : {}) });
      // nextCheckAt is unset after the save above: due. Ten instances at once, one wins.
      const won = await Promise.all(Array.from({ length: 10 }, () => claim(t)));
      expect(won.filter(Boolean)).toHaveLength(1);
      expect((await repos.licence.get())!).toMatchObject({ nextCheckAt: iso(t + lease), updatedAt: iso(t) });
      // Within the lease: nobody else; after it: one again.
      expect(await claim(t + 60_000)).toBe(false);
      expect((await Promise.all(Array.from({ length: 5 }, () => claim(t + lease + 1)))).filter(Boolean)).toHaveLength(1);
      // The winner stores its answer with the next check a day later: not due, not taken.
      const s = (await repos.licence.get())!;
      await repos.licence.save({ ...s, nextCheckAt: iso(t + 86_400_000), updatedAt: iso(t + lease + 2) });
      expect(await claim(t + 3_600_000)).toBe(false);
      // orLaterThan: a check planned further away than that may be taken (nothing usable stored for a changed key), once.
      expect((await Promise.all(Array.from({ length: 5 }, () => claim(t + 3_600_000, true)))).filter(Boolean)).toHaveLength(1);
      const cur = (await repos.licence.get())!;
      expect(await repos.licence.save({ ...cur, highWaterAt: iso(t + 5) }, { ifUpdatedAt: iso(t) })).toBe(false);
      expect(await repos.licence.save({ ...cur, highWaterAt: iso(t + 5), updatedAt: iso(t + lease + 9) }, { ifUpdatedAt: cur.updatedAt })).toBe(true);
      expect((await repos.licence.get())!).toMatchObject({ highWaterAt: iso(t + 5), updatedAt: iso(t + lease + 9) });
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
      expect(e1.result).toBe('success');
    });

    it('round-trips who, result, IP, user agent and request id; times are UTC ISO strings', async () => {
      const e = await repos.audit.write({
        actorType: 'api_key', actorId: 'key_rt', actorName: 'agent ü', action: 'project.create', targetType: 'project', targetId: 'p-rt',
        result: 'failure', ip: '2001:db8::1', userAgent: 'agent/1.0 '.repeat(40), requestId: 'req_abc', data: { error: 'invalid_manifest', via: 'mcp' },
      });
      const [got] = await repos.audit.list({ actorId: 'key_rt' });
      expect(got).toEqual(e);
      expect(got!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    });

    it('filters by time, actor, action (exact and prefix), target and result, and pages with a cursor', async () => {
      await sleep(5);
      const t0 = now();
      await sleep(5);
      const made = [];
      for (let i = 0; i < 7; i++) {
        made.push(await repos.audit.write({ actorType: 'api_key', actorId: i % 2 ? 'key_f1' : 'key_f2', action: i % 3 ? 'key.rotate' : 'project.render', targetType: 'key', targetId: `t${i % 2}`, result: i === 6 ? 'denied' : 'success' }));
      }
      const since = { from: t0 };
      expect(await repos.audit.list({ ...since, actorId: 'key_f1' })).toHaveLength(3);
      expect(await repos.audit.list({ ...since, action: 'key.*' })).toHaveLength(4);
      expect(await repos.audit.list({ ...since, action: 'key.rotate', targetId: 't1' })).toHaveLength(2);
      expect(await repos.audit.list({ ...since, result: 'denied' })).toHaveLength(1);
      expect(await repos.audit.list({ ...since, targetType: 'key' })).toHaveLength(7);
      expect(await repos.audit.list({ from: later(60_000) })).toEqual([]);
      expect((await repos.audit.list({ ...since, to: t0 }))).toEqual([]);
      const pages: string[][] = [];
      let before: { at: string; id: string } | undefined;
      for (;;) {
        const page = await repos.audit.list({ ...since, before, limit: 3 });
        pages.push(page.map((e) => e.id));
        if (page.length < 3) break;
        before = { at: page[2]!.at, id: page[2]!.id };
      }
      expect(pages.flat()).toEqual([...made].reverse().map((e) => e.id));
    });

    it('is append-only: the repository can insert, list and apply retention, nothing else', async () => {
      expect(Object.keys(repos.audit).sort()).toEqual(['deleteOlderThan', 'list', 'write']);
      const old = await repos.audit.write({ actorType: 'system', action: 'test.old' });
      const cutoff = later(10);
      await sleep(20);
      const keep = await repos.audit.write({ actorType: 'system', action: 'test.new' });
      const deleted = await repos.audit.deleteOlderThan(cutoff);
      expect(deleted).toBeGreaterThanOrEqual(1);
      const ids = (await repos.audit.list({ limit: 1000 })).map((e) => e.id);
      expect(ids).not.toContain(old.id);
      expect(ids).toContain(keep.id);
    });
  });

  describe('idempotency keys (#65)', () => {
    const rec = (key: string, extra: Record<string, unknown> = {}) => ({
      actorId: 'key_i', key, operation: 'render_project', requestHash: 'h1', status: 'pending' as const, createdAt: now(), expiresAt: later(3_600_000), ...extra,
    });

    it('begins once per (actor, key), completes, deletes and sweeps expired records', async () => {
      expect(await repos.idempotency.begin(rec('k1'))).toBe(true);
      expect(await repos.idempotency.begin(rec('k1', { requestHash: 'h2' }))).toBe(false);
      expect(await repos.idempotency.begin(rec('k1', { actorId: 'key_other' }))).toBe(true);
      expect(await repos.idempotency.get('key_i', 'k1')).toMatchObject({ status: 'pending', requestHash: 'h1' });
      await repos.idempotency.complete('key_i', 'k1', { job: { id: 'job_1' }, nested: { ü: [1, 2] } });
      expect(await repos.idempotency.get('key_i', 'k1')).toMatchObject({ status: 'done', response: { job: { id: 'job_1' }, nested: { ü: [1, 2] } } });
      await repos.idempotency.delete('key_i', 'k1');
      expect(await repos.idempotency.get('key_i', 'k1')).toBeNull();
      await repos.idempotency.begin(rec('k-old', { expiresAt: later(-1000) }));
      expect(await repos.idempotency.deleteExpired(now())).toBeGreaterThanOrEqual(1);
      expect(await repos.idempotency.get('key_i', 'k-old')).toBeNull();
      expect(await repos.idempotency.get('key_other', 'k1')).not.toBeNull();
    });

    it('lets exactly one of several concurrent first calls win', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => repos.idempotency.begin(rec('k-race'))));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('withIdempotency: one run per key, a replay, a conflict, and expiry after the TTL (injected clock)', async () => {
      let clock = Date.now();
      let runs = 0;
      const call = (request: unknown) =>
        withIdempotency(repos.idempotency, { key: 'idem-1', actorId: 'key_w', operation: 'render_project', request, ttlHours: 24, now: () => clock }, async () => ({ job: { id: `job_${++runs}` } }));
      expect(await call({ projectId: 'p', backend: undefined })).toEqual({ result: { job: { id: 'job_1' } }, replayed: false });
      expect(await call({ projectId: 'p' })).toEqual({ result: { job: { id: 'job_1' } }, replayed: true });
      await expect(call({ projectId: 'other' })).rejects.toMatchObject({ code: 'idempotency_conflict', status: 422 });
      clock += 24 * 3_600_000 + 1;
      expect(await call({ projectId: 'other' })).toEqual({ result: { job: { id: 'job_2' } }, replayed: false });
      expect(runs).toBe(2);
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
          expect(ran.flat()).toEqual(['0001_init', '0002_runtime_settings', '0003_licence_state', '0004_audit_keys_idempotency', '0005_webhooks', '0006_job_queue', '0007_render_fan_out', '0008_list_paging', '0009_job_run_id', '0010_job_priority', '0011_dispatch_outbox', '0012_instance_lease', '0013_webhook_operations']);
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
