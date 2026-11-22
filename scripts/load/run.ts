/**
 * Load test (issue #151, docs/PERFORMANCE.md): one command that starts the
 * scaled topology, runs the scenarios, checks every job exactly once, and
 * writes the numbers with the conditions they were measured under.
 *
 * Topology: PostgreSQL (container, pg_stat_statements on), optionally
 * PgBouncer in transaction mode in front of it, LOAD_API_INSTANCES api
 * processes (`REELFORGE_ROLE=api`, the server from source) with
 * `connection_limit=LOAD_API_POOL`, worker processes on the database queue.
 *
 *   (a) CRUD mix over REST: many keys, one hot key (default limit: 429s expected),
 *       one hot key with a high limit (every request updates the same RateLimitWindow row)
 *   (b) LOAD_RENDERS renders enqueued (idempotency keys) while the CRUD mix runs; fake-engine
 *       workers (scripts/load/queue-worker.ts); then one real short reel on a real worker
 *   (c) queue-only claim throughput with LOAD_CLAIM_WORKERS workers (real JobRunners)
 *   after each of (b) and (c): the exactly-once check (scripts/load/check.ts)
 *
 *   pnpm load:smoke                                   # about 30 s of load, direct connections only
 *   pnpm load                                         # full: direct and PgBouncer, 10/50/200 workers
 *   LOAD_POOLERS=pgbouncer LOAD_SCENARIOS=c pnpm load # one part
 *
 * Settings (environment): see `cfg` below. Results: LOAD_OUT/<date>-<profile>.json and .md.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { newId, type JobRecord } from '@reelforge/core';
import { Database, prepareDatabase } from '@reelforge/db';
import { exactlyOnce } from './check';
import { MIX, runCrud, type CrudTarget } from './crud';
import { ContainerCpuSampler, DbSampler, env, envNum, hostFingerprint, LoadAvgSampler, num, pgFingerprint, round, sh, sleep } from './lib';
import { renderMarkdown } from './report';

const repo = resolve(import.meta.dirname, '../..');
const smoke = env('LOAD_PROFILE', 'full') === 'smoke';
export const cfg = {
  profile: smoke ? 'smoke' : 'full',
  scenarios: env('LOAD_SCENARIOS', 'a,b,c').split(','),
  poolers: env('LOAD_POOLERS', smoke ? 'direct' : 'direct,pgbouncer').split(','),
  seconds: envNum('LOAD_SECONDS', smoke ? 8 : 60),
  connections: envNum('LOAD_CONNECTIONS', 64),
  apiInstances: envNum('LOAD_API_INSTANCES', 2),
  apiPool: envNum('LOAD_API_POOL', 10),
  workerPool: envNum('LOAD_WORKER_POOL', 2),
  keys: envNum('LOAD_KEYS', smoke ? 20 : 200),
  manyKeysLimitPerMinute: envNum('LOAD_MANY_KEYS_LIMIT', 6000),
  projects: envNum('LOAD_PROJECTS', smoke ? 20 : 100),
  seedJobs: envNum('LOAD_SEED_JOBS', smoke ? 10 : 50),
  renders: envNum('LOAD_RENDERS', smoke ? 50 : 500),
  fakeWorkers: envNum('LOAD_FAKE_WORKERS', smoke ? 10 : 50),
  fakeWorkMs: envNum('LOAD_FAKE_WORK_MS', smoke ? 1000 : 3000),
  realReel: env('LOAD_REAL_REEL', '1') === '1',
  claimWorkers: env('LOAD_CLAIM_WORKERS', smoke ? '10' : '10,50,200').split(',').map(Number),
  claimJobs: envNum('LOAD_CLAIM_JOBS', smoke ? 1000 : 5000),
  idleSeconds: envNum('LOAD_IDLE_SECONDS', smoke ? 5 : 10),
  warmupSeconds: envNum('LOAD_WARMUP_SECONDS', smoke ? 3 : 15),
  out: resolve(repo, env('LOAD_OUT', 'out/load')),
  prefix: env('LOAD_PREFIX', 'rf-load'),
  pgImage: env('LOAD_PG_IMAGE', 'mirror.gcr.io/library/postgres:17'),
  pgArgs: env('LOAD_PG_ARGS', '-c max_connections=600 -c shared_buffers=512MB'),
  bouncerImage: env('LOAD_PGBOUNCER_IMAGE', 'mirror.gcr.io/edoburu/pgbouncer@sha256:8638aa563607256d3c7440437534195f1066a92b68015d89ae9d6b935b444a6d'),
  bouncerPoolSize: envNum('LOAD_PGBOUNCER_POOL', 20),
  pgPort: envNum('LOAD_PG_PORT', 55461),
  bouncerPort: envNum('LOAD_PGBOUNCER_PORT', 55462),
  apiPortBase: envNum('LOAD_API_PORT_BASE', 55470),
  keep: env('LOAD_KEEP', '0') === '1',
  /** LOAD_RENDER_KEY=one: every render of (b) from one key (one organisation key feeding the fleet; its row is locked per enqueue). */
  renderKey: env('LOAD_RENDER_KEY', 'many'),
  /** LOAD_MIX=get_project=0.5,get_job=0.5 replaces the CRUD mix of the main runs (crud.ts MIX). */
  mix: process.env.LOAD_MIX ? Object.fromEntries(process.env.LOAD_MIX.split(',').map((x) => [x.split('=')[0]!, Number(x.split('=')[1])])) : undefined,
};

const PW = randomBytes(12).toString('hex');
const ADMIN_KEY = `rf_${randomBytes(24).toString('hex')}`;
const SECRET_KEY = randomBytes(32).toString('base64');
const PG = `${cfg.prefix}-pg`;
const BOUNCER = `${cfg.prefix}-pgbouncer`;
const NET = `${cfg.prefix}-net`;
const work = mkdtempSync(join(tmpdir(), 'rf-load-'));
const children = new Set<ChildProcess>();
const log = (s: string) => console.log(`[load ${new Date().toISOString().slice(11, 19)}] ${s}`);

/**
 * Where the host's processes reach PostgreSQL and PgBouncer: the containers' bridge addresses when the
 * host can route to them (Linux), so Docker's userland port proxy (docker-proxy, a measurable CPU cost
 * per connection under load) is not in the path; else the published ports.
 */
const addr = { pg: `127.0.0.1:${cfg.pgPort}`, bouncer: `127.0.0.1:${cfg.bouncerPort}` };
function useBridge(name: string, port: number): string | undefined {
  if (env('LOAD_VIA_PUBLISHED_PORTS', '0') === '1') return undefined;
  const ip = sh('docker', ['inspect', '-f', `{{ (index .NetworkSettings.Networks "${NET}").IPAddress }}`, name], { allowFail: true });
  if (!ip) return undefined;
  const ok = sh('sh', ['-c', `timeout 2 bash -c '</dev/tcp/${ip}/${port}' && echo ok`], { allowFail: true });
  return ok === 'ok' ? `${ip}:${port}` : undefined;
}
const adminUrl = (db = 'postgres') => `postgresql://postgres:${PW}@${addr.pg}/${db}`;
const appUrl = (pooler: string, db: string, limit: number) => `postgresql://postgres:${PW}@${pooler === 'pgbouncer' ? addr.bouncer : addr.pg}/${db}?connection_limit=${limit}`;

// ---- infrastructure ---------------------------------------------------------

function docker(...args: string[]) {
  return sh('docker', args);
}

async function startPostgres() {
  sh('docker', ['rm', '-f', PG, BOUNCER], { allowFail: true });
  sh('docker', ['network', 'rm', NET], { allowFail: true });
  docker('network', 'create', NET);
  docker('run', '-d', '--name', PG, '--network', NET, '--network-alias', 'postgres', '-p', `127.0.0.1:${cfg.pgPort}:5432`, '--shm-size=1g',
    '-e', `POSTGRES_PASSWORD=${PW}`, cfg.pgImage, ...cfg.pgArgs.split(/\s+/), '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'pg_stat_statements.track=top');
  for (let i = 0; i < 60; i++) {
    if (sh('docker', ['exec', PG, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'], { allowFail: true }).includes('accepting')) break;
    await sleep(1000);
  }
  await sleep(1000);
  addr.pg = useBridge(PG, 5432) ?? addr.pg;
  const db = await Database.open({ url: adminUrl() });
  await db.prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  await db.close();
}

function startPgBouncer(opts: { maxPreparedStatements: number }) {
  sh('docker', ['rm', '-f', BOUNCER], { allowFail: true });
  const dir = join(work, 'pgbouncer');
  mkdirSync(dir, { recursive: true });
  // Transaction mode (#152). The app's URL carries no search_path option (default schema), so no ignore_startup_parameters is needed for it.
  writeFileSync(
    join(dir, 'pgbouncer.ini'),
    [
      '[databases]',
      '* = host=postgres port=5432',
      '[pgbouncer]',
      'listen_addr = 0.0.0.0',
      'listen_port = 6432',
      'auth_type = scram-sha-256',
      'auth_file = /etc/pgbouncer/userlist.txt',
      'pool_mode = transaction',
      `default_pool_size = ${cfg.bouncerPoolSize}`,
      'max_client_conn = 5000',
      'max_db_connections = 0',
      `max_prepared_statements = ${opts.maxPreparedStatements}`,
      'admin_users = postgres',
      'ignore_startup_parameters = extra_float_digits',
      '',
    ].join('\n')
  );
  writeFileSync(join(dir, 'userlist.txt'), `"postgres" "${PW}"\n`);
  sh('chmod', ['-R', 'a+rX', dir]);
  docker('run', '-d', '--name', BOUNCER, '--network', NET, '-p', `127.0.0.1:${cfg.bouncerPort}:6432`, '-v', `${dir}:/etc/pgbouncer:ro`, '--entrypoint', 'pgbouncer', cfg.bouncerImage, '/etc/pgbouncer/pgbouncer.ini');
  addr.bouncer = `127.0.0.1:${cfg.bouncerPort}`;
  for (let i = 0; i < 20; i++) {
    const via = useBridge(BOUNCER, 6432);
    if (via) {
      addr.bouncer = via;
      break;
    }
    if (sh('sh', ['-c', `timeout 2 bash -c '</dev/tcp/127.0.0.1/${cfg.bouncerPort}' && echo ok`], { allowFail: true }) === 'ok' && env('LOAD_VIA_PUBLISHED_PORTS', '0') === '1') break;
    sh('sleep', ['0.5']);
  }
}

async function freshDatabase(name: string) {
  const db = await Database.open({ url: adminUrl() });
  await db.prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await db.prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  await db.close();
  // Migrations on the direct port (PgBouncer is for the app's traffic; #152).
  const p = await prepareDatabase({ url: adminUrl(name), dataDir: join(work, 'migrate') });
  await p.db.close();
}

/** What PgBouncer transaction mode does to ReelForge, tried one by one (the finding is the point, not the speed). */
async function probePgBouncer() {
  const out: Record<string, string> = {};
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      out[label] = 'works';
    } catch (e) {
      out[label] = `fails: ${(e as Error).message.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`;
    }
  };
  const b = (db: string, q = '') => `postgresql://postgres:${PW}@${addr.bouncer}/${db}${q}`;
  for (const mps of [0, 200]) {
    startPgBouncer({ maxPreparedStatements: mps });
    await sleep(1500);
    const name = `rfload_probe_${mps}`;
    const admin = await Database.open({ url: adminUrl() });
    await admin.prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    await admin.close();
    await attempt(`max_prepared_statements=${mps}: migrations through PgBouncer (pg_advisory_xact_lock)`, async () => {
      const p = await prepareDatabase({ url: b(name), dataDir: join(work, 'probe') });
      await p.db.close();
    });
    await attempt(`max_prepared_statements=${mps}: 2 000 queries, 20 concurrent, insert + claim (SKIP LOCKED) + fenced finish`, async () => {
      const db = await Database.open({ url: b(name, '?connection_limit=20') });
      try {
        const jobs = db.repositories().jobs;
        await Promise.all(
          Array.from({ length: 20 }, async (_, w) => {
            for (let i = 0; i < 25; i++) {
              const at = new Date().toISOString();
              await jobs.insert({ id: newId('job'), type: 'render', status: 'queued', params: {}, createdAt: at, progress: { stage: 'queued', fraction: 0 }, queue: 'database', attempts: 0 }, at);
              const now = Date.now();
              const j = await jobs.claim({ workerId: `probe-${w}`, types: ['render'], now: new Date(now).toISOString(), leaseUntil: new Date(now + 60_000).toISOString() });
              if (j) await jobs.transition({ ...j, status: 'succeeded', finishedAt: new Date().toISOString() }, new Date().toISOString(), { workerId: `probe-${w}`, attempts: j.attempts ?? 1 });
            }
          })
        );
      } finally {
        await db.close();
      }
    });
  }
  await attempt('non-default schema (?schema=lschema, sent as the startup parameter options=-c search_path=...): migrations land in it; 200 queries from it and 200 from a default-schema client, interleaved on the same server pool, each see their own schema', async () => {
    const p = await prepareDatabase({ url: b('rfload_probe_200', '?schema=lschema&connection_limit=20'), dataDir: join(work, 'probe2') });
    // A second client on the default schema shares PgBouncer's server pool at the same time: each must keep its own search_path.
    const other = await Database.open({ url: b('rfload_probe_200', '?connection_limit=20') });
    try {
      const ask = (db: Database) => db.prisma.$queryRawUnsafe('SELECT current_schema() AS s') as Promise<Array<{ s: string }>>;
      const [mine, theirs] = await Promise.all([Promise.all(Array.from({ length: 200 }, () => ask(p.db))), Promise.all(Array.from({ length: 200 }, () => ask(other)))]);
      const wrong = mine.filter((r) => r[0]?.s !== 'lschema').length + theirs.filter((r) => r[0]?.s !== 'public').length;
      if (wrong) throw new Error(`${wrong} of 400 queries ran with the other client's search_path`);
    } finally {
      await Promise.all([p.db.close(), other.close()]);
    }
    const direct = await Database.open({ url: adminUrl('rfload_probe_200') });
    try {
      const [t] = (await direct.prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'lschema' AND table_name = 'Job'`)) as Array<{ n: unknown }>;
      if (num(t!.n) !== 1) throw new Error('the tables were not created in schema lschema');
    } finally {
      await direct.close();
    }
  });
  return out;
}

// ---- processes --------------------------------------------------------------

function spawnNode(script: string, envs: Record<string, string>, name: string, opts: { stdin?: boolean } = {}) {
  const c = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: repo,
    env: { ...process.env, ...envs },
    stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  children.add(c);
  let out = '';
  c.stdout!.on('data', (d) => (out += d));
  c.stderr!.on('data', (d) => (out += d));
  c.on('exit', () => children.delete(c));
  return { c, out: () => out, name };
}

async function stopChild(c: ChildProcess, ms = 20_000) {
  if (c.exitCode !== null || c.signalCode) return;
  await new Promise<void>((ok) => {
    c.once('exit', () => ok());
    c.kill('SIGTERM');
    setTimeout(() => c.kill('SIGKILL'), ms).unref();
  });
}

function serverEnv(dbUrl: string, dataDir: string, role: 'api' | 'worker', port: number): Record<string, string> {
  return {
    DATABASE_URL: dbUrl,
    REELFORGE_ROLE: role,
    REELFORGE_HOST: '127.0.0.1',
    REELFORGE_PORT: String(port),
    REELFORGE_DATA_DIR: dataDir,
    REELFORGE_STORAGE_LOCAL_SHARED: 'true',
    REELFORGE_LICENCE_MODE: 'off',
    REELFORGE_BOOTSTRAP_KEY: ADMIN_KEY,
    REELFORGE_SECRET_KEY: SECRET_KEY,
    REELFORGE_MIGRATE_ON_START: 'false',
    REELFORGE_LOG_LEVEL: 'warn',
    // The job caps keep their defaults (database queue: 100 unfinished per key, no total cap). A total cap
    // (LOAD_MAX_QUEUED_JOBS > 0) makes every enqueue lock the one Workspace row; measure it on purpose only.
    ...(process.env.LOAD_MAX_QUEUED_JOBS ? { REELFORGE_MAX_QUEUED_JOBS: process.env.LOAD_MAX_QUEUED_JOBS } : {}),
    // e.g. LOAD_SERVER_NODE_OPTIONS=--cpu-prof --cpu-prof-dir=out/load/prof: where an instance spends its CPU.
    ...(process.env.LOAD_SERVER_NODE_OPTIONS ? { NODE_OPTIONS: process.env.LOAD_SERVER_NODE_OPTIONS } : {}),
  };
}

async function startApis(dbUrl: string, dataDir: string) {
  const apis = Array.from({ length: cfg.apiInstances }, (_, i) =>
    spawnNode('apps/server/src/main.ts', serverEnv(dbUrl, dataDir, 'api', cfg.apiPortBase + i), `api${i}`)
  );
  const urls = apis.map((_, i) => `http://127.0.0.1:${cfg.apiPortBase + i}`);
  for (const [i, u] of urls.entries()) {
    for (let t = 0; ; t++) {
      if (await fetch(`${u}/readyz`).then((r) => r.ok, () => false)) break;
      if (t > 120 || apis[i]!.c.exitCode !== null) throw new Error(`api ${u} did not become ready:\n${apis[i]!.out().slice(-2000)}`);
      await sleep(1000);
    }
  }
  return { apis, urls };
}

/** CPU seconds a process used (utime + stime from /proc). */
function cpuSeconds(pid: number | undefined): number {
  if (!pid) return 0;
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch {
    return 0;
  }
}

// ---- REST helpers -----------------------------------------------------------

async function rest(url: string, key: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, json, headers: r.headers, text };
}

const sample = JSON.parse(readFileSync(join(repo, 'examples/sample-reel.json'), 'utf8')) as Record<string, unknown>;

async function seed(url: string) {
  const mk = async (name: string, limit?: number) => {
    const r = await rest(url, ADMIN_KEY, 'POST', '/v1/keys', { name, scopes: ['read', 'write', 'render'], ...(limit !== undefined ? { rateLimitPerMinute: limit } : {}) });
    if (r.status !== 201) throw new Error(`create key: ${r.status} ${r.text}`);
    return r.json.key as string;
  };
  const many: string[] = [];
  for (let i = 0; i < cfg.keys; i += 20) many.push(...(await Promise.all(Array.from({ length: Math.min(20, cfg.keys - i) }, (_, j) => mk(`load-${i + j}`, cfg.manyKeysLimitPerMinute)))));
  const hot = await mk('load-hot'); // the server default (limits.rateLimitPerMinute 300)
  const hotHigh = await mk('load-hot-high', 1_000_000);
  const projectIds: string[] = [];
  for (let i = 0; i < cfg.projects; i++) {
    const id = `lp-${i}`;
    const r = await rest(url, many[i % many.length]!, 'POST', '/v1/projects', { manifest: { ...sample, projectId: id, title: `Load ${i}` } });
    if (r.status !== 201) throw new Error(`create project: ${r.status} ${r.text}`);
    projectIds.push(id);
  }
  const jobIds: string[] = [];
  for (let i = 0; i < cfg.seedJobs; i++) {
    const r = await rest(url, many[i % many.length]!, 'POST', `/v1/projects/${projectIds[i % projectIds.length]}/renders`, {}, { 'idempotency-key': randomUUID() });
    if (r.status !== 202) throw new Error(`seed render: ${r.status} ${r.text}`);
    jobIds.push((r.json.job as JobRecord).id);
  }
  return { many, hot, hotHigh, projectIds, jobIds };
}

/** Enqueue `n` renders spread over `seconds`, each with its own idempotency key, retried on errors with the same key. */
async function enqueueRenders(urls: string[], keys: string[], projectIds: string[], n: number, seconds: number) {
  const accepted = new Map<string, string>();
  const latency: number[] = [];
  let retries = 0;
  let refused = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      await sleep(t0 + (i * seconds * 1000) / n - Date.now());
      const idem = randomUUID();
      const key = keys[i % keys.length]!;
      for (let attempt = 0; attempt < 8; attempt++) {
        const s = Date.now();
        try {
          const r = await rest(urls[i % urls.length]!, key, 'POST', `/v1/projects/${projectIds[i % projectIds.length]}/renders`, {}, { 'idempotency-key': idem });
          latency.push(Date.now() - s);
          if (r.status === 202) {
            const id = (r.json.job as JobRecord).id;
            const prev = accepted.get(idem);
            if (prev && prev !== id) throw new Error(`idempotency key ${idem} answered two job ids: ${prev}, ${id}`);
            accepted.set(idem, id);
            return;
          }
          retries++;
          await sleep(r.status === 429 ? Number(r.headers.get('retry-after') ?? 1) * 1000 : 500);
        } catch (e) {
          if ((e as Error).message.startsWith('idempotency')) throw e;
          retries++;
          await sleep(500);
        }
      }
      refused++;
    })
  );
  return { ids: [...accepted.values()], retries, refused, latencyMs: latency };
}

/** list_projects on its own (3 sequential calls on a quiet server): projects, median ms, response bytes. */
async function listProbe(url: string, key: string) {
  const ms: number[] = [];
  let bytes = 0;
  let projects = 0;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const r = await rest(url, key, 'GET', '/v1/projects');
    ms.push(performance.now() - t);
    bytes = r.text.length;
    projects = (r.json.projects as unknown[] | undefined)?.length ?? 0;
  }
  return { projects, medianMs: round(ms.sort((a, b) => a - b)[1]!), bytes };
}

async function waitDrained(dbUrl: string, timeoutMs: number) {
  const db = await Database.open({ url: dbUrl });
  try {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const [r] = (await db.prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n, MAX("finishedAt") AS last FROM "Job" WHERE status IN ('queued', 'running')`)) as Array<{ n: unknown }>;
      if (num(r!.n) === 0) break;
      if (Date.now() > end) return { drained: false, left: num(r!.n) };
      await sleep(250);
    }
    const [l] = (await db.prisma.$queryRawUnsafe(`SELECT MAX("finishedAt") AS last FROM "Job"`)) as Array<{ last: Date | null }>;
    return { drained: true, left: 0, lastFinishedAt: l?.last ? new Date(l.last).getTime() : Date.now() };
  } finally {
    await db.close();
  }
}

/** Run one CRUD variant with every sampler. */
async function measured<T>(dbName: string, fn: () => Promise<T>, apis: ChildProcess[]) {
  const sampler = await (await DbSampler.open(adminUrl(), adminUrl(dbName), dbName)).start();
  const cpu = new ContainerCpuSampler(PG).start();
  const load = new LoadAvgSampler().start();
  const cpuBefore = apis.map((a) => cpuSeconds(a.pid));
  const clientBefore = process.cpuUsage();
  const t0 = Date.now();
  const result = await fn();
  const secs = (Date.now() - t0) / 1000;
  const apiCpuPct = apis.map((a, i) => round(((cpuSeconds(a.pid) - cpuBefore[i]!) / secs) * 100));
  const c = process.cpuUsage(clientBefore);
  // The load generator (autocannon) runs in this process, on the same host.
  const clientCpuPct = round(((c.user + c.system) / 1e6 / secs) * 100);
  const db = await sampler.stop();
  await sampler.close();
  return { result, db, dbCpu: cpu.stop(), hostLoadAvg: load.stop(), apiCpuPct, clientCpuPct };
}

// ---- scenarios --------------------------------------------------------------

async function scenarioAB(pooler: string) {
  const dbName = `rfload_${pooler}`;
  await freshDatabase(dbName);
  const dataDir = join(work, `data-${pooler}`);
  mkdirSync(dataDir, { recursive: true });
  const apiDb = appUrl(pooler, dbName, cfg.apiPool);
  const { apis, urls } = await startApis(apiDb, dataDir);
  log(`${pooler}: ${urls.length} api instances ready; seeding ${cfg.keys} keys, ${cfg.projects} projects, ${cfg.seedJobs} jobs`);
  const s = await seed(urls[0]!);
  const target = (keys: string[]): CrudTarget => ({ urls, keys, projectIds: s.projectIds, jobIds: s.jobIds });
  const procs = apis.map((a) => a.c);
  const out: Record<string, unknown> = {};
  try {
    // Not measured: JIT and query-plan warm-up of fresh processes (the first seconds are slower).
    if (cfg.warmupSeconds > 0) await runCrud(target(s.many), { seconds: cfg.warmupSeconds, connections: cfg.connections });
    if (cfg.scenarios.includes('a')) {
      const half = Math.max(5, Math.round(cfg.seconds / 2));
      // create_project makes list_projects (unpaginated: every project and its manifest) dearer as the run goes on;
      // the pair at the end leaves both out, so the cost per request stays put and only the key spread differs.
      const steady = { get_project: 0.35, update_project: 0.15, get_job: 0.3, list_renders: 0.2 };
      for (const [label, keys, secs, mix] of [
        ['many-keys', s.many, cfg.seconds, cfg.mix],
        ['hot-key-default-limit', [s.hot], half, cfg.mix],
        ['steady-many-keys', s.many, half, steady],
        ['steady-hot-key-high-limit', [s.hotHigh], half, steady],
      ] as const) {
        log(`${pooler}: (a) CRUD ${label}, ${secs} s, ${cfg.connections} connections`);
        const before = await listProbe(urls[0]!, s.many[0]!);
        const m = await measured(dbName, () => runCrud(target([...keys]), { seconds: secs, connections: cfg.connections, mix }), procs);
        out[`a:${label}`] = { ...m, mix: mix ?? MIX, listProjects: { before, after: await listProbe(urls[0]!, s.many[0]!) } };
        await sleep(2000);
      }
    }
    if (cfg.scenarios.includes('b')) {
      const procCount = Math.ceil(cfg.fakeWorkers / 10);
      const workers = Array.from({ length: procCount }, (_, p) =>
        spawnNode('scripts/load/queue-worker.ts', { DB_URL: appUrl(pooler, dbName, cfg.workerPool), RUNNERS: String(Math.min(10, cfg.fakeWorkers - p * 10)), WORK_MS: String(cfg.fakeWorkMs), NAME: `fw${p}` }, `fw${p}`)
      );
      for (const w of workers) {
        for (let t = 0; !w.out().includes('"started"'); t++) {
          if (t > 240 || w.c.exitCode !== null) throw new Error(`fake worker did not start:\n${w.out().slice(-1500)}`);
          await sleep(500);
        }
      }
      // The seed jobs were queued before any worker existed: let them drain so the queue wait below is the run's own.
      await waitDrained(adminUrl(dbName), 120_000);
      const since = new Date().toISOString();
      log(`${pooler}: (b) ${cfg.renders} renders over ${cfg.seconds} s on ${cfg.fakeWorkers} fake-engine workers (${cfg.fakeWorkMs} ms each) while the CRUD mix runs`);
      const m = await measured(
        dbName,
        async () => {
          const [crud, enq] = await Promise.all([runCrud(target(s.many), { seconds: cfg.seconds, connections: cfg.connections }), enqueueRenders(urls, cfg.renderKey === 'one' ? [s.hotHigh] : s.many, s.projectIds, cfg.renders, cfg.seconds)]);
          return { crud, enq };
        },
        procs
      );
      const drainBudget = Math.max(120_000, ((cfg.renders * cfg.fakeWorkMs) / cfg.fakeWorkers) * 3);
      const drain = await waitDrained(adminUrl(dbName), drainBudget);
      const check = await exactlyOnce(adminUrl(dbName), { expectedIds: [...s.jobIds, ...m.result.enq.ids], waitSince: since });
      const stops = await Promise.all(workers.map(async (w) => (await stopChild(w.c), w.out().trim().split('\n').pop())));
      const { ids: _ids, latencyMs, ...enq } = m.result.enq;
      const sorted = [...latencyMs].sort((a, b) => a - b);
      out['b:fake-engine'] = {
        ...m,
        result: { crud: m.result.crud, enqueue: { ...enq, accepted: _ids.length, latencyMs: { p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0 } } },
        drain,
        exactlyOnce: check,
        workers: stops,
      };
      log(`${pooler}: (b) exactly-once: ${check.ok ? 'OK' : 'FAILED'} (${check.jobs} jobs, lost ${check.lost}, unexpected ${check.unexpected}, duplicated ${check.duplicated}, queue wait p95 ${check.queueWaitMs.p95} ms)`);
      if (cfg.realReel) out['b:real-reel'] = await realReel(pooler, dbName, dataDir, urls, s, procs, [...s.jobIds, ...m.result.enq.ids]);
    }
  } finally {
    await Promise.all(apis.map((a) => stopChild(a.c)));
  }
  return out;
}

async function realReel(pooler: string, dbName: string, dataDir: string, urls: string[], s: Awaited<ReturnType<typeof seed>>, procs: ChildProcess[], earlier: string[]) {
  log(`${pooler}: (b) one real short reel (html engine, 1 s) on a real worker while the CRUD mix runs`);
  const worker = spawnNode('apps/server/src/main.ts', serverEnv(appUrl(pooler, dbName, cfg.workerPool), dataDir, 'worker', cfg.apiPortBase + 50), 'real-worker');
  for (let t = 0; ; t++) {
    if (await fetch(`http://127.0.0.1:${cfg.apiPortBase + 50}/readyz`).then((r) => r.ok, () => false)) break;
    if (t > 120 || worker.c.exitCode !== null) throw new Error(`real worker did not become ready:\n${worker.out().slice(-2000)}`);
    await sleep(1000);
  }
  try {
    const key = s.many[0]!;
    const manifest = {
      schemaVersion: '0.2',
      projectId: 'lt-real',
      title: 'Load real reel',
      output: { width: 1080, height: 1920, fps: 30, format: 'mp4' },
      scenes: [{ id: 'title', engine: 'html', template: 'html-title', durationSeconds: 1, props: { headline: 'Load test', subline: 'real render' } }],
    };
    const c = await rest(urls[0]!, key, 'POST', '/v1/projects', { manifest });
    if (c.status !== 201) throw new Error(`real reel project: ${c.status} ${c.text}`);
    let since = new Date().toISOString();
    const m = await measured(
      dbName,
      async () => {
        const crud = runCrud({ urls, keys: s.many, projectIds: s.projectIds, jobIds: s.jobIds }, { seconds: Math.max(10, Math.round(cfg.seconds / 2)), connections: cfg.connections });
        const t0 = Date.now();
        since = new Date(t0).toISOString();
        const r = await rest(urls[1 % urls.length]!, key, 'POST', '/v1/projects/lt-real/renders', {}, { 'idempotency-key': randomUUID() });
        if (r.status !== 202) throw new Error(`real reel render: ${r.status} ${r.text}`);
        const id = (r.json.job as JobRecord).id;
        let job: JobRecord;
        for (;;) {
          job = (await rest(urls[0]!, key, 'GET', `/v1/jobs/${id}?wait=30`)).json as unknown as JobRecord;
          if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
        }
        // Enqueue to finished as the client saw it (long-poll included), and the render itself on the worker.
        const seconds = round((Date.now() - t0) / 1000);
        const renderSeconds = job.startedAt && job.finishedAt ? round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000) : null;
        return { crud: await crud, job, seconds, renderSeconds };
      },
      procs
    );
    const job = m.result.job;
    let probe = '';
    const renderId = (job.result as { renderId?: string } | undefined)?.renderId;
    if (job.status === 'succeeded' && renderId) {
      const o = await rest(urls[0]!, key, 'GET', `/v1/renders/${renderId}`);
      const dl = String(o.json.downloadUrl ?? '');
      const file = join(work, 'real.mp4');
      const bytes = Buffer.from(await (await fetch(dl.startsWith('http') ? dl : `${urls[0]}${dl}`)).arrayBuffer());
      writeFileSync(file, bytes);
      probe = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_frames', '-of', 'compact', file], { allowFail: true });
    }
    const check = await exactlyOnce(adminUrl(dbName), { expectedIds: [...earlier, job.id], waitSince: since });
    log(`${pooler}: (b) real reel ${job.status} in ${m.result.seconds} s from enqueue, ${m.result.renderSeconds} s on the worker (${probe}); exactly-once over all jobs: ${check.ok ? 'OK' : 'FAILED'}`);
    return { ...m, result: { crud: m.result.crud, job: { id: job.id, status: job.status, attempts: job.attempts, workerId: job.workerId, error: job.error }, seconds: m.result.seconds, renderSeconds: m.result.renderSeconds, ffprobe: probe }, exactlyOnce: check };
  } finally {
    await stopChild(worker.c, 60_000);
  }
}

async function scenarioC(pooler: string, workersN: number) {
  const dbName = `rfload_${pooler}_c${workersN}`;
  await freshDatabase(dbName);
  const url = appUrl(pooler, dbName, cfg.workerPool);
  // 1. enqueue with the real insert, 20 concurrent inserters (like api instances)
  const ins = await Promise.all(Array.from({ length: 20 }, () => Database.open({ url: appUrl(pooler, dbName, 1) })));
  let seq = 0;
  const te = Date.now();
  await Promise.all(
    ins.map(async (db) => {
      const jobs = db.repositories().jobs;
      while (seq < cfg.claimJobs) {
        seq++;
        const at = new Date().toISOString();
        await jobs.insert({ id: newId('job'), type: 'render', status: 'queued', params: {}, createdAt: at, progress: { stage: 'queued', fraction: 0 }, queue: 'database', attempts: 0, apiKeyId: `key_${seq % 50}` }, at);
      }
    })
  );
  const enqueuePerSecond = round(cfg.claimJobs / ((Date.now() - te) / 1000));
  await Promise.all(ins.map((d) => d.close()));
  // 2. workers: processes of up to 10 JobRunners, each with its own pool, all released at once
  const procCount = Math.ceil(workersN / 10);
  const ws = Array.from({ length: procCount }, (_, p) =>
    spawnNode('scripts/load/queue-worker.ts', { DB_URL: url, RUNNERS: String(Math.min(10, workersN - p * 10)), WORK_MS: '0', NAME: `cw${p}`, WAIT_GO: '1' }, `cw${p}`, { stdin: true })
  );
  for (const w of ws) {
    for (let t = 0; !w.out().includes('"ready"'); t++) {
      if (t > 600 || w.c.exitCode !== null) throw new Error(`claim worker did not load:\n${w.out().slice(-1500)}`);
      await sleep(500);
    }
  }
  log(`${pooler}: (c) ${workersN} workers (${procCount} processes), ${cfg.claimJobs} queued jobs`);
  const busy = await measured(
    dbName,
    async () => {
      const t0 = Date.now();
      for (const w of ws) w.c.stdin!.write('go\n');
      const d = await waitDrained(adminUrl(dbName), 900_000);
      return { t0, ...d };
    },
    []
  );
  const drainSeconds = ((busy.result.lastFinishedAt ?? Date.now()) - busy.result.t0) / 1000;
  // 3. the same workers idle: what polling costs the database
  log(`${pooler}: (c) ${workersN} idle workers for ${cfg.idleSeconds} s`);
  const idle = await measured(dbName, () => sleep(cfg.idleSeconds * 1000), []);
  const stops = await Promise.all(ws.map(async (w) => (await stopChild(w.c), w.out().trim().split('\n').pop())));
  const check = await exactlyOnce(adminUrl(dbName));
  log(`${pooler}: (c) ${workersN} workers: ${round(cfg.claimJobs / drainSeconds)} claims/s; idle ${idle.db.txPerSecond} tx/s; exactly-once ${check.ok ? 'OK' : 'FAILED'}`);
  return {
    workers: workersN,
    processes: procCount,
    jobs: cfg.claimJobs,
    enqueuePerSecond,
    drained: busy.result.drained,
    drainSeconds: round(drainSeconds),
    claimsPerSecond: round(cfg.claimJobs / drainSeconds),
    busy: { db: busy.db, dbCpu: busy.dbCpu, hostLoadAvg: busy.hostLoadAvg },
    idle: { db: idle.db, dbCpu: idle.dbCpu, hostLoadAvg: idle.hostLoadAvg },
    exactlyOnce: check,
    workerExit: stops,
  };
}

// ---- main -------------------------------------------------------------------

async function main() {
  // An api instance validates engine availability before it accepts a render (it never renders itself).
  if (!process.env.REELFORGE_CHROMIUM_PATH) throw new Error('set REELFORGE_CHROMIUM_PATH (Chrome Headless Shell): api instances refuse renders without a browser, and the real reel needs one');
  mkdirSync(cfg.out, { recursive: true });
  const host = hostFingerprint();
  log(`profile ${cfg.profile}; ${host.vcpu} vCPU, ${host.ramGiB} GiB; load average ${host.loadAvgAtStart.join(' ')}; work dir ${work}`);
  await startPostgres();
  const pg = await pgFingerprint(adminUrl());
  log(`${pg.version}; ${JSON.stringify(pg.settings)}`);
  const results: Record<string, unknown> = {};
  let probes: Record<string, string> | undefined;
  for (const pooler of cfg.poolers) {
    const r: Record<string, unknown> = {};
    if (pooler === 'pgbouncer') {
      probes = await probePgBouncer();
      for (const [k, v] of Object.entries(probes)) log(`pgbouncer probe: ${k}: ${v}`);
      startPgBouncer({ maxPreparedStatements: 200 });
      await sleep(1500);
    }
    if (cfg.scenarios.includes('a') || cfg.scenarios.includes('b')) Object.assign(r, await scenarioAB(pooler));
    if (cfg.scenarios.includes('c')) for (const n of cfg.claimWorkers) r[`c:${n}`] = await scenarioC(pooler, n);
    results[pooler] = r;
  }
  const doc = {
    caveat: 'lower bound, shared sandbox (not dedicated) unless LOAD_HARDWARE_NOTE says otherwise',
    hardwareNote: env('LOAD_HARDWARE_NOTE', 'shared container, other workloads running (not dedicated)'),
    host: { ...host, loadAvgAtEnd: (await import('node:os')).loadavg().map((x) => round(x, 2)) },
    postgres: { ...pg, image: cfg.pgImage, args: cfg.pgArgs, pgbouncer: cfg.poolers.includes('pgbouncer') ? { image: cfg.bouncerImage, pool_mode: 'transaction', default_pool_size: cfg.bouncerPoolSize, max_prepared_statements: 200 } : null },
    config: cfg,
    pgbouncerProbes: probes ?? null,
    results,
  };
  const stamp = host.date.replace(/[:.]/g, '-').slice(0, 19);
  const file = join(cfg.out, `${stamp}-${cfg.profile}`);
  writeFileSync(`${file}.json`, JSON.stringify(doc, null, 2));
  writeFileSync(`${file}.md`, renderMarkdown(doc));
  console.log(renderMarkdown(doc));
  log(`results: ${file}.json and .md`);
  const failed = JSON.stringify(results).includes('"ok":false');
  if (failed) {
    log('EXACTLY-ONCE CHECK FAILED (see "exactlyOnce" in the results)');
    process.exitCode = 1;
  }
}

async function cleanup() {
  await Promise.all([...children].map((c) => stopChild(c, 5000)));
  if (!cfg.keep) {
    sh('docker', ['rm', '-f', PG, BOUNCER], { allowFail: true });
    sh('docker', ['network', 'rm', NET], { allowFail: true });
    rmSync(work, { recursive: true, force: true });
  }
}

process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));
try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await cleanup();
}
process.exit();
