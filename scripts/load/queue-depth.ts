/**
 * Queue depth (issue #307): what one claim costs as the queue grows, on PostgreSQL and MySQL.
 *
 * For each database and each depth (LOAD_DEPTHS, default 5 000, 10 000 and 20 000 queued jobs):
 *   1. a fresh database, migrated; `depth` queued jobs over LOAD_DEPTH_KEYS keys (one heavy key with
 *      40 %, 2 % without a key, the rest spread evenly), 10 % interactive previews, 75 % standard and
 *      15 % batch renders, plus as many finished jobs as history;
 *   2. EXPLAIN of the claim's statements, taken from the real code path: PostgreSQL through
 *      auto_explain (ANALYZE, BUFFERS) on a dedicated session, read back from the container log;
 *      MySQL as statement digests with rows examined per call (performance_schema);
 *   3. LOAD_DEPTH_WORKERS worker processes (each with a pool of 2, like worker containers) claim, finish
 *      (fenced) and enqueue a replacement for LOAD_DEPTH_SECONDS, so the depth stays put;
 *   4. per claim: latency p50/p95/p99 as the worker sees it, claims/s, and the database time and rows
 *      (MySQL, examined) or buffers (PostgreSQL) of the claim's statements per claim;
 *      then the exactly-once check (no job claimed twice, every claimed job finished once).
 *
 *   pnpm load:depth                                                   # PostgreSQL 17 + MySQL 8.4 in Docker
 *   LOAD_DEPTHS=1000 LOAD_DEPTH_SECONDS=5 LOAD_DEPTH_DBS=postgresql pnpm load:depth   # quick look
 *
 * Settings (environment): `cfg` below. Containers are named LOAD_PREFIX-depth-pg / -mysql and removed at
 * the end with their volumes (LOAD_KEEP=1 keeps them). Results: LOAD_OUT/<date>-depth.json and .md.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_WORKSPACE_ID, newId, type JobRecord } from '@renderweld/core';
import { Database, prepareDatabase, sqlNames } from '@renderweld/db';
import { env, envNum, hostFingerprint, LoadAvgSampler, num, round, sh, sleep, summary } from './lib';

const repo = resolve(import.meta.dirname, '../..');
export const cfg = {
  dbs: env('LOAD_DEPTH_DBS', 'postgresql,mysql').split(','),
  depths: env('LOAD_DEPTHS', '5000,10000,20000').split(',').map(Number),
  keys: envNum('LOAD_DEPTH_KEYS', 200),
  workers: envNum('LOAD_DEPTH_WORKERS', 10),
  seconds: envNum('LOAD_DEPTH_SECONDS', 20),
  history: env('LOAD_DEPTH_HISTORY', 'depth'),
  explainClaims: envNum('LOAD_DEPTH_EXPLAIN_CLAIMS', 3),
  /** MySQL: seconds of the extra phase with the slow log on (statement costs). */
  statsSeconds: envNum('LOAD_DEPTH_STATS_SECONDS', 5),
  prefix: env('LOAD_PREFIX', 'rf-load'),
  pgImage: env('LOAD_PG_IMAGE', 'mirror.gcr.io/library/postgres:17'),
  mysqlImage: env('LOAD_MYSQL_IMAGE', 'mirror.gcr.io/library/mysql:8.4'),
  pgPort: envNum('LOAD_DEPTH_PG_PORT', 55463),
  mysqlPort: envNum('LOAD_DEPTH_MYSQL_PORT', 55464),
  /** Existing servers instead of containers (admin URLs; a database per run is created and dropped): the CI smoke. */
  pgUrl: env('LOAD_DEPTH_PG_URL', ''),
  mysqlUrl: env('LOAD_DEPTH_MYSQL_URL', ''),
  out: resolve(repo, env('LOAD_OUT', 'out/load')),
  keep: env('LOAD_KEEP', '0') === '1',
  label: env('LOAD_LABEL', ''),
};

const PW = randomBytes(12).toString('hex');
const PG = `${cfg.prefix}-depth-pg`;
const MY = `${cfg.prefix}-depth-mysql`;
/** A worker process of steady() (one per worker, like worker containers). */
const isChild = process.env.LOAD_DEPTH_CHILD === '1';
const work = isChild ? '' : mkdtempSync(join(tmpdir(), 'rf-depth-'));
const log = (s: string) => console.log(`[depth ${new Date().toISOString().slice(11, 19)}] ${s}`);
const adminUrl = { postgresql: '', mysql: '' };

function containerIp(name: string): string | undefined {
  return sh('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name], { allowFail: true }) || undefined;
}

async function waitFor(url: string, seconds = 120) {
  for (let i = 0; i < seconds; i++) {
    try {
      const d = await Database.open({ url });
      await d.close();
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`database did not start: ${url.replace(PW, '***')}`);
}

async function startDatabases() {
  if (cfg.pgUrl) adminUrl.postgresql = cfg.pgUrl;
  if (cfg.mysqlUrl) adminUrl.mysql = cfg.mysqlUrl;
  if (cfg.dbs.includes('postgresql') && !cfg.pgUrl) {
    sh('docker', ['rm', '-f', '-v', PG], { allowFail: true });
    sh('docker', ['run', '-d', '--name', PG, '-p', `127.0.0.1:${cfg.pgPort}:5432`, '--shm-size=1g', '-e', `POSTGRES_PASSWORD=${PW}`, cfg.pgImage,
      '-c', 'max_connections=300', '-c', 'shared_buffers=512MB', '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'pg_stat_statements.track=top']);
    // The bridge address when the host routes to it (no docker-proxy in the path), else the published port.
    await sleep(3000);
    const ip = containerIp(PG);
    adminUrl.postgresql = `postgresql://postgres:${PW}@${ip ?? '127.0.0.1'}:${ip ? 5432 : cfg.pgPort}/postgres`;
    await waitFor(adminUrl.postgresql);
    const d = await Database.open({ url: adminUrl.postgresql });
    await d.prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    await d.close();
  }
  if (cfg.dbs.includes('mysql') && !cfg.mysqlUrl) {
    sh('docker', ['rm', '-f', '-v', MY], { allowFail: true });
    sh('docker', ['run', '-d', '--name', MY, '-p', `127.0.0.1:${cfg.mysqlPort}:3306`, '-e', `MYSQL_ROOT_PASSWORD=${PW}`, cfg.mysqlImage, '--max-connections=300']);
    await sleep(15_000);
    const ip = containerIp(MY);
    adminUrl.mysql = `mysql://root:${PW}@${ip ?? '127.0.0.1'}:${ip ? 3306 : cfg.mysqlPort}/mysql?allowPublicKeyRetrieval=true`;
    await waitFor(adminUrl.mysql, 180);
  }
}

const dbUrl = (kind: string, name: string, limit: number) => {
  const u = new URL(adminUrl[kind as 'postgresql']);
  u.pathname = `/${name}`;
  u.searchParams.set('connection_limit', String(limit));
  return u.toString();
};

async function admin<T>(kind: string, fn: (d: Database) => Promise<T>): Promise<T> {
  const d = await Database.open({ url: adminUrl[kind as 'postgresql'] });
  try {
    return await fn(d);
  } finally {
    await d.close();
  }
}

// ---- the queue --------------------------------------------------------------

/** The key of the i-th seeded job: 40 % the heavy key, 2 % none, the rest spread over the other keys. */
function keyFor(i: number): string | null {
  const r = (i * 7919) % 100;
  if (r < 40) return 'key_0';
  if (r < 42) return null;
  return `key_${1 + (i % (cfg.keys - 1))}`;
}
/** 10 % interactive previews, 75 % standard renders, 15 % batch renders. */
function classFor(i: number): { type: string; priority: number } {
  const r = (i * 104729) % 100;
  if (r < 10) return { type: 'preview', priority: 0 };
  if (r < 85) return { type: 'render', priority: 1 };
  return { type: 'render', priority: 2 };
}

function jobRow(i: number, status: string, createdAt: Date) {
  const c = classFor(i);
  const k = keyFor(i);
  return {
    id: newId('job'),
    workspaceId: DEFAULT_WORKSPACE_ID,
    type: c.type,
    status,
    params: '{}',
    progress: JSON.stringify({ stage: status, fraction: status === 'queued' ? 0 : 1 }),
    createdAt,
    queue: 'database',
    attempts: status === 'queued' ? 0 : 1,
    priority: c.priority,
    ...(k ? { apiKeyId: k } : {}),
    ...(status === 'succeeded' ? { startedAt: createdAt, finishedAt: createdAt } : {}),
  };
}

async function seed(db: Database, depth: number) {
  const history = cfg.history === 'depth' ? depth : Number(cfg.history);
  const now = Date.now();
  const rows = [
    ...Array.from({ length: history }, (_, i) => jobRow(i, 'succeeded', new Date(now - 3_600_000 + i))),
    // Queued over the last ~10 minutes, oldest first, so the batch class has aged and unaged jobs.
    ...Array.from({ length: depth }, (_, i) => jobRow(i, 'queued', new Date(now - 600_000 + Math.floor((i * 600_000) / depth)))),
  ];
  for (let i = 0; i < rows.length; i += 1000) await db.prisma.job.createMany({ data: rows.slice(i, i + 1000) });
  // Table names through the schema-qualifying helper, as in the app's raw SQL (#191).
  const { tbl } = sqlNames(db.kind, db.schema ?? undefined);
  if (db.kind === 'postgresql') await db.prisma.$executeRawUnsafe(`ANALYZE ${tbl('Job')}`);
  else await db.prisma.$queryRawUnsafe(`ANALYZE TABLE ${tbl('Job')}`);
}

/** PostgreSQL: the plans of the claim's statements, EXPLAIN (ANALYZE, BUFFERS) through auto_explain on a dedicated session. */
async function explainPg(name: string, depth: number) {
  const settings = ["session_preload_libraries = 'auto_explain'", 'auto_explain.log_min_duration = 0', 'auto_explain.log_analyze = on', 'auto_explain.log_buffers = on', 'auto_explain.log_timing = on', "auto_explain.log_format = 'text'"];
  await admin('postgresql', async (a) => {
    for (const s of settings) await a.prisma.$executeRawUnsafe(`ALTER DATABASE "${name}" SET ${s}`);
  });
  const since = new Date(Date.now() - 1000).toISOString();
  const d = await Database.open({ url: dbUrl('postgresql', name, 1) });
  try {
    const jobs = d.repositories().jobs;
    for (let i = 0; i < cfg.explainClaims; i++) {
      const now = Date.now();
      const j = await jobs.claim({ workerId: `explain-${i}`, types: ['render', 'preview'], now: new Date(now).toISOString(), leaseUntil: new Date(now + 60_000).toISOString(), priorityAgingSeconds: 600 });
      if (j) await jobs.transition({ ...j, status: 'succeeded', finishedAt: new Date().toISOString() }, new Date().toISOString(), { workerId: `explain-${i}`, attempts: j.attempts ?? 1 });
    }
  } finally {
    await d.close();
    await admin('postgresql', (a) => a.prisma.$executeRawUnsafe(`ALTER DATABASE "${name}" RESET ALL`));
  }
  await sleep(500);
  const logs = sh('sh', ['-c', `docker logs --since ${since} ${PG} 2>&1`], { allowFail: true });
  // Keep the last claim's plans (the first may still be warming caches), statements about "Job" only.
  // The claim's reads and locks (SELECT / WITH), not the update and event insert that follow.
  const plans = logs.split(/\n(?=\S+ \S+ UTC \[\d+\] LOG:)/).filter((p) => p.includes('duration:') && p.includes('"Job"') && /Query Text: (SELECT|WITH)/.test(p));
  const perClaim = Math.max(1, Math.round(plans.length / cfg.explainClaims));
  return { depth, plans: plans.slice(-perClaim).map((p) => p.replace(/^.*?LOG:\s+/, '').trim()) };
}

/** Statement statistics start from zero. PostgreSQL: pg_stat_statements (in the admin database). MySQL: see captureMysql. */
async function resetStats(kind: string) {
  // A server without pg_stat_statements (the CI smoke) runs without statement costs.
  if (kind === 'postgresql') await admin(kind, (a) => a.prisma.$queryRawUnsafe('SELECT pg_stat_statements_reset()')).catch(() => undefined);
}

/** Claim-path statements: the plan reads and the row lock (not the update, event and replacement insert that follow). */
const CLAIM_PATH = /WITH RECURSIVE|GROUP BY|SKIP LOCKED|ORDER BY [`"]createdAt[`"], [`"]id[`"] LIMIT/i;

/**
 * The statements on Job by total time: calls, mean ms, rows (MySQL: examined) and buffers per call. MySQL's driver
 * runs binary-protocol statements, which its statement digests do not aggregate; they are read from the slow log
 * (long_query_time 0, table output) of a short separate phase, normalised with STATEMENT_DIGEST_TEXT.
 */
async function topStatements(kind: string, name: string): Promise<Array<{ statement: string; calls: number; totalMs: number; meanMs: number; rowsPerCall?: number; buffersPerCall?: number; rowsExaminedPerCall?: number; rowsSentPerCall?: number }>> {
  return admin(kind, async (a) => {
    if (kind === 'postgresql') {
      const rows = (await a.prisma.$queryRawUnsafe(
        `SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 600) AS q, calls, total_exec_time AS t, rows, shared_blks_hit + shared_blks_read AS b
         FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = $1 AND query ILIKE '%"Job"%' ORDER BY total_exec_time DESC LIMIT 20`,
        name
      ).catch(() => [])) as Array<{ q: string; calls: unknown; t: unknown; rows: unknown; b: unknown }>;
      return rows.map((r) => ({ statement: r.q, calls: num(r.calls), totalMs: round(num(r.t)), meanMs: round(num(r.t) / Math.max(1, num(r.calls)), 3), rowsPerCall: round(num(r.rows) / Math.max(1, num(r.calls)), 1), buffersPerCall: round(num(r.b) / Math.max(1, num(r.calls)), 1) }));
    }
    const raw = (await a.prisma.$queryRawUnsafe(
      `SELECT CONVERT(sql_text USING utf8mb4) AS q, CAST(SECOND(query_time) * 1000 + MICROSECOND(query_time) / 1000 AS DOUBLE) AS t, rows_examined AS ex, rows_sent AS sent
       FROM mysql.slow_log WHERE db = ? AND CONVERT(sql_text USING utf8mb4) LIKE '%\`Job\`%'`,
      name
    )) as Array<{ q: string; t: unknown; ex: unknown; sent: unknown }>;
    // Literals out, so the statements group by shape (as a digest would).
    const shape = (q: string) => q.replace(/'(?:[^'\\]|\\.)*'/g, '?').replace(/\b\d+(\.\d+)?\b/g, '?').replace(/\s+/g, ' ').slice(0, 600);
    const by = new Map<string, { calls: number; t: number; ex: number; sent: number }>();
    for (const r of raw) {
      const k = shape(r.q);
      const x = by.get(k) ?? { calls: 0, t: 0, ex: 0, sent: 0 };
      x.calls++;
      x.t += num(r.t);
      x.ex += num(r.ex);
      x.sent += num(r.sent);
      by.set(k, x);
    }
    return [...by]
      .sort((x, y) => y[1].t - x[1].t)
      .slice(0, 20)
      .map(([q, r]) => ({ statement: q, calls: r.calls, totalMs: round(r.t), meanMs: round(r.t / r.calls, 3), rowsExaminedPerCall: round(r.ex / r.calls, 1), rowsSentPerCall: round(r.sent / r.calls, 1) }));
  });
}

/** Database milliseconds and rows (PostgreSQL: buffers) per claim, over the claim-path statements. */
function claimCost(statements: Awaited<ReturnType<typeof topStatements>>, claimCalls: number) {
  const path = statements.filter((s) => CLAIM_PATH.test(s.statement));
  const per = (f: (s: (typeof path)[number]) => number) => round(path.reduce((a, s) => a + f(s), 0) / Math.max(1, claimCalls), 2);
  return {
    dbMsPerClaim: per((s) => s.totalMs),
    ...(path[0]?.buffersPerCall !== undefined ? { buffersPerClaim: per((s) => (s.buffersPerCall ?? 0) * s.calls) } : { rowsExaminedPerClaim: per((s) => (s.rowsExaminedPerCall ?? 0) * s.calls) }),
  };
}

/** One worker process (LOAD_DEPTH_CHILD=1): claim, finish (fenced), enqueue a replacement, until `end`; prints its numbers. */
async function child() {
  const e = process.env;
  const db = await Database.open({ url: e.DEPTH_URL! });
  const jobs = db.repositories().jobs;
  const w = e.DEPTH_WORKER!;
  let seq = Number(e.DEPTH_SEQ);
  const claimMs: number[] = [];
  let empty = 0;
  let errors = 0;
  const errorSamples: string[] = [];
  console.log('ready');
  await new Promise((ok) => process.stdin.once('data', ok));
  const end = Date.now() + Number(e.DEPTH_SECONDS) * 1000;
  while (Date.now() < end) {
    const t0 = performance.now();
    const now = Date.now();
    let job: JobRecord | null = null;
    try {
      job = await jobs.claim({ workerId: w, types: ['render', 'preview'], now: new Date(now).toISOString(), leaseUntil: new Date(now + 60_000).toISOString(), priorityAgingSeconds: 600 });
    } catch (err) {
      errors++;
      if (errorSamples.length < 5) errorSamples.push(String((err as Error).message).slice(0, 300));
      continue;
    }
    claimMs.push(round(performance.now() - t0, 2));
    if (!job) {
      empty++;
      await sleep(50);
      continue;
    }
    const at = new Date().toISOString();
    await jobs.transition({ ...job, status: 'succeeded', finishedAt: at }, at, { workerId: w, attempts: job.attempts ?? 1 });
    // The replacement: drawn from the same mix, so the depth (and the classes) stay put.
    const r = jobRow(seq++, 'queued', new Date());
    await jobs.insert({ id: r.id, type: r.type, status: 'queued', params: {}, createdAt: at, progress: { stage: 'queued', fraction: 0 }, queue: 'database', attempts: 0, ...(r.apiKeyId ? { apiKeyId: r.apiKeyId } : {}), priority: (['interactive', 'standard', 'batch'] as const)[r.priority] }, at);
  }
  await db.close();
  console.log(JSON.stringify({ claimMs, empty, errors, errorSamples }));
}

/** Workers (one process each, like worker containers) that keep the depth constant. */
async function steady(kind: string, name: string, seconds: number) {
  const kids = Array.from({ length: cfg.workers }, (_, i) => {
    const c = spawn(process.execPath, ['--import', 'tsx', import.meta.filename], {
      cwd: repo,
      env: { ...process.env, LOAD_DEPTH_CHILD: '1', DEPTH_URL: dbUrl(kind, name, 2), DEPTH_WORKER: `w${i}`, DEPTH_SEQ: String(10_000_000 * (i + 1)), DEPTH_SECONDS: String(seconds) },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    c.stdout!.on('data', (d) => (out += d));
    return { c, out: () => out, done: new Promise<void>((ok) => c.on('exit', () => ok())) };
  });
  for (const k of kids) while (!k.out().includes('ready')) await sleep(100);
  const load = new LoadAvgSampler().start();
  for (const k of kids) k.c.stdin!.write('go\n');
  await Promise.all(kids.map((k) => k.done));
  const hostLoad = load.stop();
  const res = kids.map((k) => JSON.parse(k.out().trim().split('\n').pop()!) as { claimMs: number[]; empty: number; errors: number; errorSamples: string[] });
  const claimMs = res.flatMap((r) => r.claimMs);
  const empty = res.reduce((a, r) => a + r.empty, 0);
  return {
    claimCalls: claimMs.length,
    claims: claimMs.length - empty,
    claimsPerSecond: round((claimMs.length - empty) / seconds),
    empty,
    errors: res.reduce((a, r) => a + r.errors, 0),
    errorSamples: res.flatMap((r) => r.errorSamples).slice(0, 5),
    claimMs: summary(claimMs),
    hostLoadAvg: hostLoad,
  };
}

/** MySQL: a short second phase with every statement in the slow log table (its own cost kept out of the main numbers). */
async function captureMysql(name: string) {
  const set = (on: boolean) => admin('mysql', async (a) => {
    for (const s of on ? ["SET GLOBAL log_output = 'TABLE'", 'SET GLOBAL long_query_time = 0', 'TRUNCATE TABLE mysql.slow_log', 'SET GLOBAL slow_query_log = ON'] : ['SET GLOBAL slow_query_log = OFF', 'SET GLOBAL long_query_time = 10'])
      await a.prisma.$executeRawUnsafe(s);
  });
  await set(true);
  try {
    const run = await steady('mysql', name, cfg.statsSeconds);
    return { statements: await topStatements('mysql', name), claimCalls: run.claimCalls };
  } finally {
    await set(false);
    await admin('mysql', (a) => a.prisma.$executeRawUnsafe('TRUNCATE TABLE mysql.slow_log'));
  }
}

/** No job claimed twice, every claimed job finished exactly once, nothing left running. */
async function exactlyOnce(kind: string, name: string) {
  const d = await Database.open({ url: dbUrl(kind, name, 2) });
  try {
    const p = d.prisma;
    const { qi, tbl } = sqlNames(d.kind, d.schema ?? undefined);
    const twice = (message: string) => `SELECT COUNT(*) AS n FROM (SELECT ${qi('jobId')} FROM ${tbl('JobEvent')} WHERE ${qi('type')} = 'status' AND ${qi('message')} = '${message}' GROUP BY ${qi('jobId')} HAVING COUNT(*) > 1) x`;
    const [a] = (await p.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM ${tbl('Job')} WHERE ${qi('attempts')} > 1`)) as Array<{ n: unknown }>;
    const [b] = (await p.$queryRawUnsafe(twice('running'))) as Array<{ n: unknown }>;
    const [c] = (await p.$queryRawUnsafe(twice('succeeded'))) as Array<{ n: unknown }>;
    const [r] = (await p.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM ${tbl('Job')} WHERE ${qi('status')} = 'running'`)) as Array<{ n: unknown }>;
    const res = { reclaimed: num(a!.n), claimedTwice: num(b!.n), finishedTwice: num(c!.n), leftRunning: num(r!.n) };
    return { ...res, ok: res.reclaimed === 0 && res.claimedTwice === 0 && res.finishedTwice === 0 && res.leftRunning === 0 };
  } finally {
    await d.close();
  }
}

async function runOne(kind: string, depth: number) {
  const name = `rfdepth_${depth}`;
  await admin(kind, async (a) => {
    if (kind === 'postgresql') {
      await a.prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await a.prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    } else {
      await a.prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${name}\``);
      await a.prisma.$executeRawUnsafe(`CREATE DATABASE \`${name}\``);
    }
  });
  try {
    const p = await prepareDatabase({ url: dbUrl(kind, name, 4), dataDir: join(work, `${kind}-${depth}`) });
    const t0 = Date.now();
    await seed(p.db, depth);
    log(`${kind} ${depth}: seeded in ${round((Date.now() - t0) / 1000)} s`);
    // The plans come from the container's log, so only with a container this script started.
    const explain = kind === 'postgresql' && !cfg.pgUrl ? await explainPg(name, depth) : null;
    await p.db.close();
    await resetStats(kind);
    log(`${kind} ${depth}: ${cfg.workers} workers for ${cfg.seconds} s`);
    const run = await steady(kind, name, cfg.seconds);
    const statements = kind === 'postgresql' ? await topStatements(kind, name) : undefined;
    const check = await exactlyOnce(kind, name);
    const stats = statements ? { statements, claimCalls: run.claimCalls } : await captureMysql(name);
    const cost = claimCost(stats.statements, stats.claimCalls);
    log(`${kind} ${depth}: ${run.claimsPerSecond} claims/s, claim p50/p95/p99 ${run.claimMs.p50}/${run.claimMs.p95}/${run.claimMs.p99} ms, ${cost.dbMsPerClaim} DB ms per claim, errors ${run.errors}, exactly-once ${check.ok ? 'OK' : 'FAILED'}`);
    return { kind, depth, ...run, ...cost, statements: stats.statements, explain, exactlyOnce: check };
  } finally {
    await admin(kind, (a) => a.prisma.$executeRawUnsafe(kind === 'postgresql' ? `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)` : `DROP DATABASE IF EXISTS \`${name}\``)).catch(() => undefined);
  }
}

function markdown(doc: { host: ReturnType<typeof hostFingerprint>; label: string; results: Array<Awaited<ReturnType<typeof runOne>>> }) {
  const lines = [
    `# Queue depth ${doc.label ? `(${doc.label}) ` : ''}${doc.host.date}`,
    '',
    `Lower bound, shared host: ${doc.host.vcpu} vCPU ${doc.host.cpuModel}, ${doc.host.ramGiB} GiB, load average at start ${doc.host.loadAvgAtStart.join(' ')}. ${cfg.workers} workers, ${cfg.keys} keys, ${cfg.seconds} s per run.`,
    '',
    '| Database | Queued | Claims/s | Claim p50 ms | p95 ms | p99 ms  DB ms per claim | Rows or buffers per claim | Errors | Exactly once | Host load (mean) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...doc.results.map((r) => `| ${r.kind} | ${r.depth} | ${r.claimsPerSecond} | ${r.claimMs.p50} | ${r.claimMs.p95} | ${r.claimMs.p99} | ${r.dbMsPerClaim} | ${'buffersPerClaim' in r ? `${r.buffersPerClaim} buffers` : `${r.rowsExaminedPerClaim} rows`} | ${r.errors} | ${r.exactlyOnce.ok ? 'yes' : 'NO'} | ${r.hostLoadAvg.mean} |`),
    '',
  ];
  for (const r of doc.results) {
    lines.push(`## ${r.kind}, ${r.depth} queued: top statements on Job`, '', '```');
    for (const s of r.statements) lines.push(`${s.calls} calls, mean ${s.meanMs} ms, ${'buffersPerCall' in s ? `${s.buffersPerCall} buffers, ${s.rowsPerCall} rows` : `${s.rowsExaminedPerCall} rows examined`} per call: ${s.statement}`);
    lines.push('```', '');
    if (r.explain) lines.push('Plans (auto_explain, ANALYZE, BUFFERS):', '', '```', ...r.explain.plans, '```', '');
  }
  return lines.join('\n');
}

async function main() {
  mkdirSync(cfg.out, { recursive: true });
  const host = hostFingerprint();
  log(`${host.vcpu} vCPU, load average ${host.loadAvgAtStart.join(' ')}; ${cfg.dbs.join(', ')}; depths ${cfg.depths.join(', ')}`);
  await startDatabases();
  const results = [];
  for (const kind of cfg.dbs) for (const depth of cfg.depths) results.push(await runOne(kind, depth));
  const doc = { label: cfg.label, host: { ...host, loadAvgAtEnd: loadavg().map((x) => round(x, 2)) }, config: cfg, results };
  const file = join(cfg.out, `${host.date.replace(/[:.]/g, '-').slice(0, 19)}-depth${cfg.label ? `-${cfg.label}` : ''}`);
  writeFileSync(`${file}.json`, JSON.stringify(doc, null, 2));
  writeFileSync(`${file}.md`, markdown(doc));
  console.log(markdown({ ...doc, results: results.map((r) => ({ ...r, explain: null })) }));
  log(`results: ${file}.json and .md`);
  if (results.some((r) => !r.exactlyOnce.ok || r.errors)) process.exitCode = 1;
}

function cleanup() {
  if (!cfg.keep) for (const [c, external] of [[PG, cfg.pgUrl], [MY, cfg.mysqlUrl]] as const) if (!external) sh('docker', ['rm', '-f', '-v', c], { allowFail: true });
  rmSync(work, { recursive: true, force: true });
}

if (isChild) {
  await child();
  process.exit();
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  cleanup();
}
process.exit();
