/**
 * Shared helpers for the load test (issue #151, docs/PERFORMANCE.md):
 * percentiles, the database sampler (connections, lock waits, transactions,
 * hot tables, top statements), DB container CPU, and the host fingerprint
 * every published number is footnoted with.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpus, loadavg, totalmem } from 'node:os';
import { Database } from '@renderweld/db';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v) : ((v as number) ?? 0));
export const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Nearest-rank percentile of an already sorted array. */
export function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export function summary(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: round(pct(s, 50)), p95: round(pct(s, 95)), p99: round(pct(s, 99)), max: round(s[s.length - 1] ?? 0) };
}

export function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
export const envNum = (name: string, fallback: number) => Number(env(name, String(fallback)));

export function sh(cmd: string, args: string[], opts: { allowFail?: boolean; input?: string } = {}): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input: opts.input }).trim();
  } catch (e) {
    if (opts.allowFail) return '';
    const err = e as { stderr?: string; message: string };
    throw new Error(`${cmd} ${args.join(' ')} failed: ${err.stderr || err.message}`);
  }
}

/** The machine the numbers were measured on (the store rule: every number gets this footnote). */
export function hostFingerprint() {
  const cpu = cpus();
  return {
    date: new Date().toISOString(),
    vcpu: cpu.length,
    cpuModel: cpu[0]?.model ?? 'unknown',
    ramGiB: round(totalmem() / 1024 ** 3, 1),
    kernel: sh('uname', ['-r'], { allowFail: true }),
    node: process.version,
    disk: sh('sh', ['-c', "df -h / | awk 'NR==2{print $2\" total, \"$4\" free\"}'"], { allowFail: true }),
    loadAvgAtStart: loadavg().map((x) => round(x, 2)),
  };
}

/** Samples the host load average every second (the shared sandbox has other workloads). */
export class LoadAvgSampler {
  private samples: number[] = [];
  private timer?: NodeJS.Timeout;
  start() {
    this.samples = [];
    this.timer = setInterval(() => this.samples.push(loadavg()[0]!), 1000);
    return this;
  }
  stop() {
    clearInterval(this.timer);
    const s = this.samples;
    return { min: round(Math.min(...s, Infinity) === Infinity ? 0 : Math.min(...s), 2), max: round(Math.max(0, ...s), 2), mean: round(s.reduce((a, b) => a + b, 0) / (s.length || 1), 2) };
  }
}

/** CPU% of a container (docker stats), sampled in the background; 100 = one full vCPU. */
export class ContainerCpuSampler {
  private samples: number[] = [];
  private running = false;
  constructor(private readonly container: string | undefined) {}
  start() {
    this.samples = [];
    if (!this.container) return this;
    this.running = true;
    const loop = async () => {
      while (this.running) {
        const out = await new Promise<string>((ok) => {
          const c = spawn('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}', this.container!]);
          let s = '';
          c.stdout.on('data', (d) => (s += d));
          c.on('exit', () => ok(s));
          c.on('error', () => ok(''));
        });
        const v = Number.parseFloat(out);
        if (Number.isFinite(v)) this.samples.push(v);
      }
    };
    void loop();
    return this;
  }
  stop() {
    this.running = false;
    if (!this.container) return null;
    const s = this.samples;
    return { meanPct: round(s.reduce((a, b) => a + b, 0) / (s.length || 1)), maxPct: round(Math.max(0, ...s)), samples: s.length };
  }
}

/**
 * Database-side evidence, read on a direct (not pooled) admin connection:
 * connections by state, lock waits (the hot-row signature), commits/s, rows
 * written per hot table, and the top statements (pg_stat_statements).
 */
export class DbSampler {
  private timer?: NodeJS.Timeout;
  private conn: number[] = [];
  private active: number[] = [];
  private lockWaits: number[] = [];
  private lockWaitQueries = new Map<string, number>();
  private busy = false;
  private before?: { xact: number; tables: Map<string, number[]>; at: number };

  private constructor(
    private readonly admin: Database,
    private readonly app: Database,
    private readonly dbName: string
  ) {}

  /** `adminUrl`: a superuser on the server (pg_stat_activity, pg_stat_statements); `dbUrl`: the load database, direct. */
  static async open(adminUrl: string, dbUrl: string, dbName: string) {
    return new DbSampler(await Database.open({ url: adminUrl }), await Database.open({ url: dbUrl }), dbName);
  }

  private q<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]> {
    return this.admin.prisma.$queryRawUnsafe(sql, ...args) as Promise<T[]>;
  }

  private async counters() {
    const [x] = await this.q<{ x: unknown }>(`SELECT xact_commit + xact_rollback AS x FROM pg_stat_database WHERE datname = $1`, this.dbName);
    const t = (await this.app.prisma.$queryRawUnsafe(`SELECT relname AS t, n_tup_ins AS i, n_tup_upd AS u, n_tup_del AS d FROM pg_stat_user_tables`)) as Array<{ t: string; i: unknown; u: unknown; d: unknown }>;
    return { xact: num(x?.x), tables: new Map(t.map((r) => [r.t, [num(r.i), num(r.u), num(r.d)]])), at: Date.now() };
  }

  async start() {
    this.conn = [];
    this.active = [];
    this.lockWaits = [];
    this.lockWaitQueries.clear();
    await this.q(`SELECT pg_stat_statements_reset()`).catch(() => undefined);
    this.before = await this.counters();
    this.timer = setInterval(() => void this.tick(), 1000);
    return this;
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = await this.q<{ state: string | null; wait: string | null; query: string | null }>(
        `SELECT state, wait_event_type AS wait, left(query, 120) AS query FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        this.dbName
      );
      this.conn.push(rows.length);
      this.active.push(rows.filter((r) => r.state === 'active').length);
      const waiting = rows.filter((r) => r.wait === 'Lock');
      this.lockWaits.push(waiting.length);
      for (const w of waiting) {
        const k = (w.query ?? '').replace(/\$\d+/g, '?');
        this.lockWaitQueries.set(k, (this.lockWaitQueries.get(k) ?? 0) + 1);
      }
    } catch {
      // a sample lost under load is fine
    } finally {
      this.busy = false;
    }
  }

  async stop() {
    clearInterval(this.timer);
    const secs = (Date.now() - this.before!.at) / 1000;
    // Table counters reach the shared statistics within about a second of each transaction.
    await sleep(1500);
    const after = await this.counters();
    const top = await this.q<{ query: string; calls: unknown; total: unknown; mean: unknown; rows: unknown }>(
      `SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS query, calls, round(total_exec_time::numeric, 1) AS total, round(mean_exec_time::numeric, 3) AS mean, rows
         FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = $1 ORDER BY total_exec_time DESC LIMIT 12`,
      this.dbName
    ).catch(() => []);
    // The job-cap lock statements (#180): their mean execution time is the time spent waiting for the lock.
    const capLocks = await this.q<{ query: string; calls: unknown; total: unknown; mean: unknown }>(
      `SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS query, calls, round(total_exec_time::numeric, 1) AS total, round(mean_exec_time::numeric, 3) AS mean
         FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = $1 AND (query LIKE '%SET "id" = "id"%' OR query LIKE '%SET "count" = "count"%') ORDER BY total_exec_time DESC`,
      this.dbName
    ).catch(() => []);
    const [st] = await this.q<{ n: unknown }>(`SELECT COALESCE(SUM(calls), 0) AS n FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = $1`, this.dbName).catch(() => [{ n: 0 }]);
    const tables = [...after.tables.entries()]
      .map(([table, [i, u, d]]) => {
        const b = this.before!.tables.get(table) ?? [0, 0, 0];
        return { table, inserts: i! - b[0]!, updates: u! - b[1]!, deletes: d! - b[2]! };
      })
      .filter((r) => r.inserts + r.updates + r.deletes > 0)
      .sort((a, b) => b.inserts + b.updates + b.deletes - (a.inserts + a.updates + a.deletes));
    const max = (a: number[]) => Math.max(0, ...a);
    const mean = (a: number[]) => round(a.reduce((x, y) => x + y, 0) / (a.length || 1));
    return {
      seconds: round(secs),
      // Commits and rollbacks in the load database (the samplers' own reads are a few per second).
      txPerSecond: round((after.xact - this.before!.xact) / ((after.at - this.before!.at) / 1000)),
      // Statements (pg_stat_statements calls; BEGIN/COMMIT count too).
      statementsPerSecond: round(num(st?.n) / secs),
      connections: { mean: mean(this.conn), max: max(this.conn) },
      activeConnections: { mean: mean(this.active), max: max(this.active) },
      lockWaits: {
        mean: mean(this.lockWaits),
        max: max(this.lockWaits),
        bySql: [...this.lockWaitQueries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([sql, samples]) => ({ sql, samples })),
      },
      rowsWrittenPerSecond: Object.fromEntries(tables.map((t) => [t.table, round((t.inserts + t.updates + t.deletes) / secs)])),
      tables,
      topStatements: top.map((r) => ({ query: r.query, calls: num(r.calls), totalMs: num(r.total), meanMs: num(r.mean), rows: num(r.rows) })),
      capLockStatements: capLocks.map((r) => ({ query: r.query, calls: num(r.calls), totalMs: num(r.total), meanMs: num(r.mean) })),
    };
  }

  async close() {
    clearInterval(this.timer);
    await Promise.all([this.admin.close(), this.app.close()]);
  }
}

/** PostgreSQL version and the settings that matter for throughput. */
export async function pgFingerprint(adminUrl: string) {
  const db = await Database.open({ url: adminUrl });
  try {
    const [v] = (await db.prisma.$queryRawUnsafe(`SELECT version() AS v`)) as Array<{ v: string }>;
    const names = ['max_connections', 'shared_buffers', 'work_mem', 'synchronous_commit', 'fsync', 'wal_level', 'max_wal_size', 'checkpoint_timeout', 'effective_cache_size'];
    const rows = (await db.prisma.$queryRawUnsafe(`SELECT name, setting, unit FROM pg_settings WHERE name = ANY($1)`, names)) as Array<{ name: string; setting: string; unit: string | null }>;
    return { version: v!.v.split(' on ')[0], settings: Object.fromEntries(rows.map((r) => [r.name, r.unit ? `${r.setting} ${r.unit}` : r.setting])) };
  } finally {
    await db.close();
  }
}
