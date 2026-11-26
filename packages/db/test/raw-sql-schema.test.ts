/**
 * Raw SQL names its schema on PostgreSQL (#191, SQL-01..03 in
 * docs/providers/queue-and-scaling.md). Behind a transaction-mode pooler a
 * client's search_path is not kept, so an unqualified table in raw SQL can
 * resolve in another deployment's schema.
 *
 * SQL-01 (always): a source scan of packages/db/src and scripts/load fails on a
 * table named in raw SQL without the helpers that qualify it (tbl(), table(),
 * pgTable()). SQL-02: the scan's own rules catch known bad statements.
 * SQL-03 (TEST_POSTGRES_URL): every raw statement the repositories and the
 * migrator actually send, recorded on a non-default schema, names that schema.
 */
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_ID, newId, type JobRecord } from '@renderweld/core';
import { createPrismaRepositories, createTestDatabase, migrationStatus, MIGRATIONS, prepareDatabase, sqlNames, type RawClient } from '../src/index';

const root = join(__dirname, '..', '..', '..');
const MODELS = [...readFileSync(join(__dirname, '..', 'prisma', 'postgresql', 'schema.prisma'), 'utf8').matchAll(/^model (\w+) \{/gm)].map((m) => m[1]!);
const TABLES = [...MODELS, '_reelforge_migrations'];
/** Interpolations allowed where SQL expects a table: the helpers that name the schema (sql.ts, migrate.ts, load scripts). */
const QUALIFYING = ['tbl(', 'table(', 'pgTable('];

/** Problems in one source file: tables in raw SQL that do not go through a qualifying helper. */
function unqualifiedTables(text: string): string[] {
  const out: string[] = [];
  const names = TABLES.join('|');
  const lineOf = (i: number) => text.slice(0, i).split('\n').length;
  // A model quoted as a plain identifier (the old `qi('Job')`).
  for (const m of text.matchAll(new RegExp(`\\bqi\\(\\s*['"](${names})['"]\\s*\\)`, 'g'))) out.push(`line ${lineOf(m.index)}: ${m[0]}`);
  // A literal table name where SQL expects a table: FROM "Job", JOIN `Job`, UPDATE Job, INSERT INTO _reelforge_migrations ...
  const kw = String.raw`\b(?:FROM|JOIN|UPDATE|INTO|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+`;
  for (const m of text.matchAll(new RegExp(`${kw}(?:["\`]|\\\\")?(${names})\\b`, 'g'))) out.push(`line ${lineOf(m.index)}: ${m[0]}`);
  // An interpolation where SQL expects a table that is not one of the qualifying helpers (${TABLE}, ${qi('x')}, ...).
  for (const m of text.matchAll(new RegExp(`${kw}\\$\\{([^}]*)\\}`, 'g'))) {
    if (!QUALIFYING.some((q) => m[1]!.startsWith(q))) out.push(`line ${lineOf(m.index)}: ${m[0]}`);
  }
  return out;
}

function sources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'generated' ? [] : walk(join(dir, e.name))) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []));
  return [...walk(join(root, 'packages', 'db', 'src')), ...walk(join(root, 'scripts', 'load'))];
}

describe('raw SQL names its schema (#191)', () => {
  it('SQL-01 no table in raw SQL in packages/db/src or scripts/load without a schema-qualifying helper', () => {
    const files = sources();
    expect(files.some((f) => f.endsWith('prisma-repositories.ts'))).toBe(true);
    expect(MODELS).toContain('Job');
    const problems = files.flatMap((f) => unqualifiedTables(readFileSync(f, 'utf8')).map((p) => `${relative(root, f)} ${p}`));
    expect(problems).toEqual([]);
  });

  it('SQL-02 the scan catches unqualified tables in its known forms', () => {
    const bad = [
      "`SELECT ${qi('id')} FROM ${qi('Job')} WHERE x`",
      '`UPDATE "Job" SET "status" = 1`',
      'q(`SELECT 1 FROM "Job" j LEFT JOIN "JobEvent" e ON e.x = j.id`)',
      "'SELECT `id` FROM `Job` WHERE `id` = ? FOR UPDATE'",
      '`INSERT INTO ${TABLE} (id) VALUES (1)`',
      '`CREATE TABLE IF NOT EXISTS ${TABLE} (id INT)`',
      '"UPDATE \\"RateLimitWindow\\" SET count = count"',
    ];
    for (const b of bad) expect(unqualifiedTables(b), b).not.toEqual([]);
    const good = ["`SELECT ${qi('id')} FROM ${tbl('Job')} ${qi('j')} WHERE x`", "`INSERT INTO ${table(kind, schema)} (id)`", '`SELECT 1 FROM (SELECT pg_notify($1, $2)) s`'];
    for (const g of good) expect(unqualifiedTables(g), g).toEqual([]);
  });

  it('SQL-02 the helper: PostgreSQL names the schema and refuses anything but a plain identifier; MySQL and SQLite are unchanged', () => {
    expect(sqlNames('postgresql', 'tenant_a').tbl('Job')).toBe('"tenant_a"."Job"');
    expect(sqlNames('postgresql', 'public').tbl('Job')).toBe('"public"."Job"');
    expect(sqlNames('mysql').tbl('Job')).toBe('`Job`');
    expect(sqlNames('sqlite').tbl('Job')).toBe('"Job"');
    expect(() => sqlNames('postgresql')).toThrow(/needs the schema/);
    for (const s of ['a"b', 'a.b', 'x; DROP TABLE "Job"', '1abc', '', 'a'.repeat(64)]) expect(() => sqlNames('postgresql', s), s).toThrow(/plain SQL identifier/);
    expect(() => createPrismaRepositories({} as never, DEFAULT_WORKSPACE_ID, 'postgresql')).toThrow(/needs the schema/);
  });
});

const pgUrl = process.env.TEST_POSTGRES_URL;
const tmp = mkdtempSync(join(tmpdir(), 'reelforge-rawsql-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Records the text of every raw statement, inside interactive transactions too. */
function recording<T extends object>(client: T, log: string[]): T {
  const raw = (t: any, prop: string | symbol) => {
    const v = t[prop];
    if (prop === '$executeRawUnsafe' || prop === '$queryRawUnsafe') return (sql: string, ...a: unknown[]) => (log.push(sql), v.call(t, sql, ...a));
    return typeof v === 'function' ? v.bind(t) : v;
  };
  return new Proxy(client, {
    get(t: any, prop) {
      if (prop === '$transaction') return (fn: any, opts?: unknown) => (typeof fn === 'function' ? t.$transaction((tx: any) => fn(new Proxy(tx, { get: raw })), opts) : t.$transaction(fn, opts));
      return raw(t, prop);
    },
  });
}

function queued(over: Partial<JobRecord> = {}): JobRecord {
  return { id: newId('job'), type: 'render', status: 'queued', params: {}, createdAt: new Date().toISOString(), progress: { stage: 'queued', fraction: 0 }, queue: 'database', attempts: 0, ...over };
}

describe.skipIf(!pgUrl)('raw SQL names its schema on PostgreSQL (#191)', () => {
  it('SQL-03 every raw statement of the claim, quota, admission, row-lock, notify and migrator paths names the schema', async () => {
    const t = await createTestDatabase('postgresql', tmp);
    const { db } = await prepareDatabase({ url: t.url, dataDir: join(tmp, 'none') });
    try {
      const schema = db.schema!;
      expect(schema).toBe(new URL(t.url).searchParams.get('schema') ?? 'public'); // a schema per run, or public (TEST_POSTGRES_ISOLATION=database)
      const log: string[] = [];
      const prisma = recording(db.prisma, log);
      const repos = createPrismaRepositories(prisma, DEFAULT_WORKSPACE_ID, 'postgresql', { schema, readySignal: { kind: 'notify', channel: 'rf_sql03' } });
      const now = () => new Date().toISOString();
      const lease = () => new Date(Date.now() + 60_000).toISOString();
      await repos.jobs.insert(queued(), now());
      await repos.jobs.insertWithQuota(queued(), now(), { types: ['render'], windows: [], maxQueuedTotal: 100, maxEstimatedWait: { seconds: 3600, claimsPerSecond: 1, now: now() } });
      await repos.jobs.insertWithQuota(queued({ apiKeyId: 'key_sql03' }), now(), { apiKeyId: 'key_sql03', types: ['render'], windows: [{ since: '2000-01-01T00:00:00Z', limit: 100 }], maxActivePerKey: 10 });
      const one = queued();
      await repos.jobs.insert(one, now());
      expect(await repos.jobs.claim({ workerId: 'w1', types: ['render'], now: now(), leaseUntil: lease(), id: one.id, maxRunningPerKey: 5 })).not.toBeNull();
      const claimed = await repos.jobs.claim({ workerId: 'w1', types: ['render'], now: now(), leaseUntil: lease(), maxRunningPerKey: 5, priorityAgingSeconds: 60 });
      expect(claimed).not.toBeNull();
      await repos.jobs.cancelTree(claimed!.id, now());
      expect(await repos.rateLimits.hit('req_sql03', new Date(0).toISOString())).toBe(1); // the counter's upsert (#196)
      await migrationStatus(recording(db.prisma as unknown as RawClient, log), 'postgresql', MIGRATIONS.postgresql ?? [], schema);

      expect(log.some((s) => /FOR UPDATE SKIP LOCKED/.test(s))).toBe(true);
      expect(log.some((s) => /RateLimitWindow/.test(s))).toBe(true);
      expect(log.some((s) => /ON CONFLICT .* DO UPDATE SET/.test(s))).toBe(true);
      expect(log.some((s) => /ApiKey/.test(s))).toBe(true);
      expect(log.some((s) => /_reelforge_migrations/.test(s))).toBe(true);
      const q = `"${schema}".`;
      const problems: string[] = [];
      for (const sql of log) {
        // (Not UPDATE in FOR UPDATE, nor in an upsert's ON CONFLICT ... DO UPDATE SET: neither names a table.)
        for (const m of sql.matchAll(/\b(FROM|JOIN|(?<!FOR |DO )UPDATE|INTO)\s+([^\s,()]+)/g)) {
          const target = m[2]!;
          // Not tables: the catalogue views, and FROM inside EXTRACT(... FROM ...) or a set-returning function.
          if (target.startsWith(q) || /^(information_schema\.|pg_catalog\.|unnest$)/.test(target)) continue;
          problems.push(`${m[1]} ${target} in: ${sql.slice(0, 160)}`);
        }
      }
      expect(problems).toEqual([]);
    } finally {
      await db.close();
      await t.drop();
    }
  });
});
