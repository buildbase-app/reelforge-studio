import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { createTestDatabase, serverTestDatabaseKind, type TestDatabase } from '@renderweld/db';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

/**
 * Read replica and the worker pool default on the server (issue #152, D-104).
 * Ids REP-nn in docs/providers/queue-and-scaling.md#read-replica. The replica
 * cases need PostgreSQL or MySQL (REELFORGE_TEST_DB=postgres|mysql, or
 * TEST_POSTGRES_URL / TEST_MYSQL_URL set); the SQLite refusal runs always.
 */
const { dir, cleanup } = tempDir('reelforge-replica-');
afterAll(() => cleanup());
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const REPLICA_PASSWORD = 'R3plicaPassw0rdNotInLogs';
const base = { RENDERWELD_LICENCE_MODE: 'off', RENDERWELD_SECRET_KEY: 'replica-test-secret-key-0123456789abcdef' };

describe('database.readUrl on SQLite', () => {
  it('REP-06 the server refuses to start with a read URL on SQLite, says why, and never prints the replica password', async () => {
    const err = await startServer(
      { dataDir: join(dir, 'sqlite'), port: 0, host: '127.0.0.1' },
      { registry: new PluginRegistry(), env: { ...base, RENDERWELD_DATABASE_READ_URL: `postgresql://rf:${REPLICA_PASSWORD}@127.0.0.1:1/rf` }, quiet: true }
    ).catch((e: Error) => e);
    expect(String(err)).toMatch(/DATABASE_READ_URL \(database\.readUrl\) needs PostgreSQL or MySQL: SQLite is one local file/);
    expect(String(err)).not.toContain(REPLICA_PASSWORD);
  });
});

const kind = serverTestDatabaseKind() !== 'sqlite' ? serverTestDatabaseKind() : process.env.TEST_POSTGRES_URL ? 'postgresql' : process.env.TEST_MYSQL_URL ? 'mysql' : null;

/** A URL to the same server that connects but has no tables (PostgreSQL: a schema that does not exist; MySQL: an empty database), with a password the logs must not show. */
async function emptyReplica(): Promise<TestDatabase> {
  if (kind === 'mysql' || process.env.TEST_POSTGRES_ISOLATION === 'database') return createTestDatabase(kind!, dir);
  const u = new URL(process.env.TEST_POSTGRES_URL!);
  u.searchParams.set('schema', `rf_noschema_${randomBytes(4).toString('hex')}`);
  return { kind: 'postgresql', url: u.toString(), drop: async () => undefined };
}

describe.skipIf(!kind)(`read replica and worker pool on ${kind}`, () => {
  let primary: TestDatabase;
  let empty: TestDatabase;
  const servers: StartedServer[] = [];
  const logs: string[] = [];

  const start = async (name: string, env: Record<string, string>) => {
    const e = [fakeEngine('remotion'), fakeEngine('motion-canvas')];
    const s = await startServer(
      { dataDir: join(dir, 'shared'), port: 0, host: '127.0.0.1' },
      {
        registry: () => new PluginRegistry().registerEngine(e[0]!).registerEngine(e[1]!),
        env: { ...base, DATABASE_URL: primary.url, RENDERWELD_STORAGE_LOCAL_SHARED: 'true', ...env },
        queue: { workerId: name, leaseMs: 4000, heartbeatMs: 300, pollMs: 100 },
        logWrite: (_l, line) => void logs.push(line),
      }
    );
    servers.push(s);
    return s;
  };

  beforeAll(async () => {
    primary = await createTestDatabase(kind!, dir);
    empty = await emptyReplica();
  }, 60_000);
  afterAll(async () => {
    for (const s of servers) await s.close().catch(() => undefined);
    await primary?.drop();
    await empty?.drop();
  });

  it('REP-07 the worker role uses database.workerConnectionLimit (3) unless the URL sets connection_limit; other roles keep the driver default', async () => {
    const withLimit = (n: number) => {
      const u = new URL(primary.url);
      u.searchParams.set('connection_limit', String(n));
      return u.toString();
    };
    const w = await start('w-default', { RENDERWELD_ROLE: 'worker' });
    expect(w.db.poolSize).toBe(3);
    const wUrl = await start('w-url', { RENDERWELD_ROLE: 'worker', DATABASE_URL: withLimit(7) });
    expect(wUrl.db.poolSize).toBe(7);
    const wOff = await start('w-off', { RENDERWELD_ROLE: 'worker', RENDERWELD_DB_WORKER_CONNECTION_LIMIT: '0' });
    expect(wOff.db.poolSize).toBe(10);
    const a = await start('api', { RENDERWELD_ROLE: 'api' });
    expect(a.db.poolSize).toBe(10);
    expect(logs.some((l) => /database: (postgresql|mysql) .* \(pool 3\)/.test(l))).toBe(true);
    for (const s of servers.splice(0)) await s.close();
  }, 120_000);

  it('REP-08 with a replica that has no tables, the write journey works (keys, quota, idempotency, rate limit, project writes, a database-queue render, settings, themes, audit); only the lists fail', async () => {
    const s = await start('all-1', {
      RENDERWELD_QUEUE_DRIVER: 'database',
      RENDERWELD_RATE_LIMIT_STORE: 'database',
      RENDERWELD_DATABASE_READ_URL: empty.url,
    });
    expect(s.db.readDisplayUrl).toBeTruthy();
    expect(logs.some((l) => l.includes('database read replica:') && l.includes('lists only: projects.page'))).toBe(true);
    const admin = (await s.service.keys.create('admin', ['admin', 'owner'])).key;
    const rest = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, key = admin) => {
      const res = await fetch(`${s.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, json, headers: res.headers };
    };

    // A key with a render quota and a per-key rate limit (keys, rate-limit windows, quota counts: primary).
    const k = await rest('POST', '/v1/keys', { name: 'agent', scopes: ['read', 'write', 'render'], rendersPerDay: 1, rateLimitPerMinute: 30 });
    expect(k.status).toBe(201);
    const agent = k.json.key as string;
    const create = await rest('POST', '/v1/projects', { manifest: { ...sample, projectId: 'rep', title: 'Replica' } }, { 'idempotency-key': 'rep-1' }, agent);
    expect(create.status).toBe(201);
    const replay = await rest('POST', '/v1/projects', { manifest: { ...sample, projectId: 'rep', title: 'Replica' } }, { 'idempotency-key': 'rep-1' }, agent);
    expect(replay.status).toBe(201); // the stored answer, not a conflict: the idempotency row was read from the primary
    const cur = await rest('GET', '/v1/projects/rep', undefined, {}, agent);
    expect(cur.status).toBe(200);
    expect((await rest('PATCH', '/v1/projects/rep', { title: 'Replica 2' }, { 'if-match': `"${cur.json.meta.version}"` }, agent)).status).toBe(200);
    expect((await rest('GET', '/v1/projects/rep', undefined, {}, agent)).json.manifest.title).toBe('Replica 2');

    // A render through the database queue: insert under the quota, claim, heartbeat, progress, fenced finish.
    const r = await rest('POST', '/v1/projects/rep/renders', {}, {}, agent);
    expect(r.status).toBe(202);
    let job: any;
    for (let i = 0; i < 20 && !['succeeded', 'failed'].includes(job?.status); i++) job = (await rest('GET', `/v1/jobs/${r.json.job.id}?wait=20`, undefined, {}, agent)).json;
    expect(job).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect((await rest('GET', `/v1/jobs/${r.json.job.id}/logs`, undefined, {}, agent)).status).toBe(200);
    const second = await rest('POST', '/v1/projects/rep/renders', {}, {}, agent);
    expect(second.status).toBe(429);
    expect(second.json.error.code).toBe('quota_exceeded');
    expect((await rest('GET', `/v1/keys/${k.json.record.id}`)).json).toMatchObject({ usage: { rendersToday: 1 } });

    // Settings, themes, the licence state, webhooks: all on the primary.
    expect((await rest('PATCH', '/v1/config', { settings: { 'limits.rateLimitPerMinute': 1000 } })).status).toBe(200);
    expect((await rest('GET', '/v1/config')).status).toBe(200);
    expect((await rest('POST', '/v1/themes', { id: 'rep-theme', name: 'Rep', tokens: { colors: { background: '#101010', surface: '#202020', text: '#ffffff', mutedText: '#bbbbbb', accent: '#22aaff', accent2: '#ffaa22' }, fontFamily: 'Arial, sans-serif' } })).status).toBe(201);
    expect((await rest('GET', '/v1/themes/rep-theme')).status).toBe(200);
    expect((await rest('GET', '/v1/licence')).status).toBe(200);
    expect((await rest('GET', '/v1/webhooks')).status).toBe(200);
    expect((await rest('GET', '/v1/keys')).status).toBe(200);
    expect((await rest('GET', '/readyz', undefined)).status).toBe(200);

    // The lag-tolerant lists read the replica, which has no tables here: they fail (500), which proves where they go.
    for (const path of ['/v1/projects', '/v1/jobs', '/v1/assets', '/v1/themes', '/v1/projects/rep/versions', '/v1/audit']) {
      expect((await rest('GET', path)).status, path).toBe(500);
    }
    const replicaPassword = decodeURIComponent(new URL(empty.url).password);
    // Only a real secret can be looked for: CI's password is the word "reelforge", which every log line has.
    if (replicaPassword.length >= 12) expect(logs.join('\n')).not.toContain(replicaPassword);
    await s.service.jobs.flush();
  }, 120_000);
});
