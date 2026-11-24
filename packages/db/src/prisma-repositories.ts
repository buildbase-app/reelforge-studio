import type { Project, Theme } from '@reelforge/project-schema';
import {
  conflict,
  expiredUpdate,
  isFannedOut,
  isTerminal,
  settleChild,
  stopTree,
  type ChildSettlement,
  type SettlementPlan,
  newId,
  newSequentialId,
  type ApiKeyPatch,
  type ApiKeyRecord,
  type AssetRecord,
  type AuditEntry,
  type AuditFilter,
  type IdempotencyRecord,
  type JobFilter,
  type JobLeaseFence,
  type JobRecord,
  type LicenceStateRecord,
  type PageRequest,
  type ProjectMeta,
  type ProjectSummary,
  type QuotaResult,
  type Repositories,
  projectStats,
  runIdOf,
  type Scope,
  type StoredProject,
  AGED_RANK,
  effectiveRank,
  estimateWaitSeconds,
  isPriority,
  priorityOfRank,
  priorityRank,
  CLAIMED_PREFIX,
  READY_PREFIX,
  newOutboxId,
  announceClaim,
  type ReadySignal,
} from '@reelforge/core';
// One client type for all three databases: the generated clients share the
// same model API (only the SQL dialect differs), so the repositories are
// written once against the SQLite client's types.
import type { PrismaClient } from './generated/sqlite/client';
import type { DatabaseKind } from './url';
import { sqlNames } from './sql';
import { createPrismaWebhookRepository } from './webhook-repository';

export type AnyPrismaClient = PrismaClient;
type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

const iso = (d: Date) => d.toISOString();
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(s: string): T => JSON.parse(s) as T;
const TX = { maxWait: 10_000, timeout: 30_000 };

/**
 * Keyset page (D-102): rows strictly before `after` in (createdAt, id)
 * descending order. Written as `createdAt <= t AND (createdAt < t OR id < i)`
 * so every database can range-scan the (workspaceId, ..., createdAt, id) index.
 */
function keyset(req: PageRequest) {
  const a = req.after;
  if (!a) return {};
  const t = new Date(a.createdAt);
  return { createdAt: { lte: t }, OR: [{ createdAt: { lt: t } }, { id: { lt: a.id } }] };
}
const NEWEST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
/** MySQL claim: queued jobs of a key read per page, then locked one at a time (see claim). */
const CLAIM_CANDIDATES = 16;
/** Usage counters (D-091) share RateLimitWindow with the request windows; their keys start with this. */
const USAGE_PREFIX = 'usage:';
/** RateLimitWindow rows that are only lock targets, never swept; the one below serialises starts under limits.maxQueuedJobs (#180). */
const LOCK_PREFIX = 'lock:';
const QUEUE_LOCK_KEY = `${LOCK_PREFIX}job-queue`;

/** Unique-constraint violation (P2002), whichever database raised it. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

function toLicence(r: {
  instanceId: string;
  keyHash: string | null;
  answer: string | null;
  lastCheckedAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  activatedAt: Date | null;
  deactivatedAt: Date | null;
  nextCheckAt: Date | null;
  highWaterAt: Date | null;
  updatedAt: Date;
}): LicenceStateRecord {
  const opt = (k: string, d: Date | null) => (d ? { [k]: iso(d) } : {});
  return {
    instanceId: r.instanceId,
    ...(r.keyHash !== null ? { keyHash: r.keyHash } : {}),
    ...(r.answer !== null ? { answer: parse(r.answer) } : {}),
    ...opt('lastCheckedAt', r.lastCheckedAt),
    ...opt('lastSuccessAt', r.lastSuccessAt),
    ...(r.lastError !== null ? { lastError: parse(r.lastError) } : {}),
    ...opt('activatedAt', r.activatedAt),
    ...opt('deactivatedAt', r.deactivatedAt),
    ...opt('nextCheckAt', r.nextCheckAt),
    ...opt('highWaterAt', r.highWaterAt),
    updatedAt: iso(r.updatedAt),
  };
}

/**
 * Repositories for one workspace on any of the Prisma-supported databases.
 * `read`: the read replica's client (database.readUrl, D-104), used only by the
 * lag-tolerant list reads in READ_REPLICA_READS (database.ts); every other
 * query uses `prisma`, the primary.
 */
export interface PrismaRepositoryOptions {
  read?: PrismaClient;
  /**
   * Queue dispatch (D-105): how the transactions that make a job claimable tell the workers. `notify`
   * (PostgreSQL only): `pg_notify(channel, 'r:<id>')` in the same transaction (sent on commit, dropped on
   * rollback), and `'c:<id>'` in the claim's transaction of a freshly queued job; `outbox`: a DispatchOutbox
   * row in the same transaction. Unset: nothing (workers poll).
   */
  readySignal?: ReadySignal;
  /**
   * PostgreSQL: the schema the tables are in (Database.schema: the URL's `?schema=`, else `public`). Required there:
   * every raw statement names it (#191). Ignored on SQLite and MySQL.
   */
  schema?: string | null;
  /**
   * MySQL only: runs one statement on the primary's pool and returns the insert id of its OK packet, which carries
   * the value of `LAST_INSERT_ID(expr)` set by that statement (Prisma's raw API drops it). The rate-limit counter
   * uses it to count and read in one round trip (#196). Database supplies it; without it the counter falls back to
   * the same statement and `SELECT LAST_INSERT_ID()` in one transaction (exact, but four round trips).
   */
  insertId?: (sql: string, args: Array<string | number | Date>) => Promise<number | bigint>;
}

export function createPrismaRepositories(prisma: PrismaClient, workspaceId: string, kind: DatabaseKind = 'sqlite', opts: PrismaRepositoryOptions = {}): Repositories {
  const ws = { workspaceId };
  // Replica reads (D-104): lists only. Never job state, claims, quotas, rate limits, keys, licence, idempotency or a read-then-write.
  const replica = opts.read ?? prisma;
  const signal = opts.readySignal;
  if (signal?.kind === 'notify' && kind !== 'postgresql') throw new Error(`queue.dispatch "notify" needs PostgreSQL (LISTEN/NOTIFY); this database is ${kind}`);
  if (signal?.kind === 'bus') throw new Error('readySignal "bus" is for the in-memory repositories');
  // Raw SQL (the queue's row locks): identifier quoting and placeholders differ per database. Every table goes
  // through tbl(): on PostgreSQL it names the schema, so a statement never depends on the connection's search_path,
  // which a transaction-mode pooler does not keep per client (#191; sql.ts).
  const { qi, tbl, ph } = sqlNames(kind, kind === 'postgresql' ? (opts.schema ?? undefined) : undefined);
  // Read committed: a statement after a row lock sees what the previous holder committed (PostgreSQL's default; MySQL's is repeatable read).
  // (Typed against the SQLite client, which only knows Serializable; the PostgreSQL/MySQL clients take ReadCommitted.)
  const lockingTx = (kind === 'sqlite' ? TX : { ...TX, isolationLevel: 'ReadCommitted' }) as typeof TX;
  const fenceWhere = (f: JobLeaseFence) => ({ workerId: f.workerId, attempts: f.attempts, status: 'running' });
  // Rate-limit counter (#196): one statement creates the window or adds to it and returns the new count. The row lock
  // of the upsert makes each count returned distinct, so N concurrent hits get 1..N whatever the database.
  // MySQL has no RETURNING: LAST_INSERT_ID(expr) puts the new count in the statement's OK packet (opts.insertId).
  const rlCols = ['workspaceId', 'key', 'windowStart', 'count'].map(qi).join(', ');
  const hitSql =
    kind === 'mysql'
      ? `INSERT INTO ${tbl('RateLimitWindow')} (${rlCols}) VALUES (?, ?, ?, LAST_INSERT_ID(?)) ON DUPLICATE KEY UPDATE \`count\` = LAST_INSERT_ID(\`count\` + ?)`
      : `INSERT INTO ${tbl('RateLimitWindow')} (${rlCols}) VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)})` +
        ` ON CONFLICT (${qi('workspaceId')}, ${qi('key')}, ${qi('windowStart')}) DO UPDATE SET ${qi('count')} = ${tbl('RateLimitWindow')}.${qi('count')} + excluded.${qi('count')}` +
        ` RETURNING ${qi('count')}`;
  // The sliding window of the per-key request limit (#305): the same upsert, and the previous window's count read
  // in the same statement. PostgreSQL and SQLite: a subquery in RETURNING (SQLite placeholders are positional, so
  // the key is passed twice). MySQL: INSERT ... SELECT from a one-row derived table that sums the previous window;
  // LAST_INSERT_ID carries the new count in its low 32 bits and the previous count in the high ones (the stored
  // count is the low part alone), so one round trip still answers both.
  const prevSql = (w: string, k: string, at: string) =>
    `SELECT p.${qi('count')} FROM ${tbl('RateLimitWindow')} AS p WHERE p.${qi('workspaceId')} = ${w} AND p.${qi('key')} = ${k} AND p.${qi('windowStart')} = ${at}`;
  const slideSql =
    kind === 'mysql'
      ? `INSERT INTO ${tbl('RateLimitWindow')} (${rlCols}) SELECT ?, ?, ?, LAST_INSERT_ID(1 + 4294967296 * d.prev) & 4294967295` +
        ` FROM (SELECT COALESCE(SUM(p.\`count\`), 0) AS prev FROM ${tbl('RateLimitWindow')} AS p WHERE p.\`workspaceId\` = ? AND p.\`key\` = ? AND p.\`windowStart\` = ?) AS d` +
        ` ON DUPLICATE KEY UPDATE \`count\` = LAST_INSERT_ID(${tbl('RateLimitWindow')}.\`count\` + 1 + 4294967296 * d.prev) & 4294967295`
      : `INSERT INTO ${tbl('RateLimitWindow')} (${rlCols}) VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, 1)` +
        ` ON CONFLICT (${qi('workspaceId')}, ${qi('key')}, ${qi('windowStart')}) DO UPDATE SET ${qi('count')} = ${tbl('RateLimitWindow')}.${qi('count')} + 1` +
        ` RETURNING ${qi('count')}, (${kind === 'postgresql' ? prevSql('$1', '$2', '$4') : prevSql('?', '?', '?')}) AS ${qi('previous')}`;

  const toJob = (r: {
    id: string;
    type: string;
    status: string;
    projectId: string | null;
    params: string;
    progress: string;
    result: string | null;
    error: string | null;
    retryOf: string | null;
    apiKeyId: string | null;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    queue: string | null;
    attempts: number;
    workerId: string | null;
    leaseExpiresAt: Date | null;
    cancelRequestedAt: Date | null;
    parentId: string | null;
    pendingChildren: number | null;
    priority: number;
  }): JobRecord => ({
    id: r.id,
    type: r.type,
    status: r.status as JobRecord['status'],
    ...(r.projectId !== null ? { projectId: r.projectId } : {}),
    params: parse(r.params),
    createdAt: iso(r.createdAt),
    ...(r.startedAt ? { startedAt: iso(r.startedAt) } : {}),
    ...(r.finishedAt ? { finishedAt: iso(r.finishedAt) } : {}),
    progress: parse(r.progress),
    ...(r.result !== null ? { result: parse(r.result) } : {}),
    ...(r.error !== null ? { error: parse(r.error) } : {}),
    ...(r.retryOf !== null ? { retryOf: r.retryOf } : {}),
    ...(r.apiKeyId !== null ? { apiKeyId: r.apiKeyId } : {}),
    ...(r.queue === 'database' ? { queue: 'database' as const, attempts: r.attempts } : {}),
    ...(r.workerId !== null ? { workerId: r.workerId } : {}),
    ...(r.leaseExpiresAt ? { leaseExpiresAt: iso(r.leaseExpiresAt) } : {}),
    ...(r.cancelRequestedAt ? { cancelRequestedAt: iso(r.cancelRequestedAt) } : {}),
    ...(r.parentId !== null ? { parentId: r.parentId } : {}),
    ...(r.pendingChildren !== null ? { pendingChildren: r.pendingChildren } : {}),
    priority: priorityOfRank(r.priority),
  });
  /** Columns a fenced (worker) write may change: the lease and a cancel request belong to the heartbeat and other instances. */
  const workerJobData = (j: JobRecord) => {
    const { leaseExpiresAt: _l, cancelRequestedAt: _c, attempts: _a, ...rest } = jobData(j);
    return rest;
  };
  const jobData = (j: JobRecord) => ({
    type: j.type,
    status: j.status,
    projectId: j.projectId ?? null,
    params: json(j.params),
    progress: json(j.progress),
    result: j.result === undefined ? null : json(j.result),
    error: j.error === undefined ? null : json(j.error),
    retryOf: j.retryOf ?? null,
    apiKeyId: j.apiKeyId ?? null,
    createdAt: new Date(j.createdAt),
    startedAt: j.startedAt ? new Date(j.startedAt) : null,
    finishedAt: j.finishedAt ? new Date(j.finishedAt) : null,
    queue: j.queue ?? null,
    attempts: j.attempts ?? 0,
    workerId: j.workerId ?? null,
    leaseExpiresAt: j.leaseExpiresAt ? new Date(j.leaseExpiresAt) : null,
    cancelRequestedAt: j.cancelRequestedAt ? new Date(j.cancelRequestedAt) : null,
    parentId: j.parentId ?? null,
    pendingChildren: j.pendingChildren ?? null,
    runId: runIdOf(j),
    // Only when set: a record without it never resets a stored class (new rows default to standard).
    ...(j.priority ? { priority: priorityRank(j.priority) } : {}),
  });
  const statusEvent = (jobId: string, at: string, status: string) => ({ ...ws, jobId, at: new Date(at), type: 'status', message: status });
  const logEvent = (jobId: string, at: string, line: string) => ({ ...ws, jobId, at: new Date(at), type: 'log', message: line });
  // Queue dispatch (D-105). NOTIFY is transactional: queued with the transaction, delivered when it commits, never
  // when it rolls back, so it needs no outbox. Ids are joined with "," (job ids never contain one) to send them in one
  // statement; COUNT(*) because pg_notify returns void, which the driver cannot map.
  const notifySql = `SELECT COUNT(*) AS n FROM (SELECT pg_notify($1, $2 || x) FROM unnest(string_to_array($3, ',')) AS x) s`;
  const outboxRows = (ids: string[]) => {
    const at = new Date();
    return ids.map((jobId) => ({ ...ws, id: newOutboxId(), jobId, attempts: 0, nextAttemptAt: at, createdAt: at }));
  };
  /** Inside the transaction that makes `ids` claimable: tell the workers (nothing without a ready signal). */
  const ready = async (tx: Tx, ids: string[]) => {
    if (!signal || !ids.length) return;
    if (signal.kind === 'notify') await tx.$queryRawUnsafe(notifySql, signal.channel, READY_PREFIX, ids.join(','));
    else if (signal.kind === 'outbox') await tx.dispatchOutbox.createMany({ data: outboxRows(ids) });
  };
  /** The same, as statements of a batch transaction. */
  const readyBatch = (ids: string[]) =>
    !signal || !ids.length
      ? []
      : signal.kind === 'notify'
        ? [prisma.$queryRawUnsafe(notifySql, signal.channel, READY_PREFIX, ids.join(','))]
        : signal.kind === 'outbox'
          ? [prisma.dispatchOutbox.createMany({ data: outboxRows(ids) })]
          : [];
  /** Inside a claim's transaction (notify only, a freshly queued job): idle workers about to claim it can skip their claim. */
  const claimed = async (tx: Tx, row: { id: string; createdAt: Date }, now: string) => {
    if (signal?.kind === 'notify' && announceClaim(signal, row.createdAt, now)) await tx.$queryRawUnsafe(notifySql, signal.channel, CLAIMED_PREFIX, row.id);
  };
  /** Row lock on a job (a no-op update): PostgreSQL/MySQL lock the row, SQLite takes the write lock. Fan-out locks the parent before any child. */
  const lockJob = (tx: Tx, id: string) => tx.$executeRawUnsafe(`UPDATE ${tbl('Job')} SET ${qi('id')} = ${qi('id')} WHERE ${qi('id')} = ${ph(1)}`, id);
  /** Write a fan-out settlement (D-097) inside the caller's transaction, which already holds the parent's row lock. */
  const applyPlan = async (tx: Tx, plan: SettlementPlan, at: string): Promise<ChildSettlement> => {
    if (plan.parent) {
      await tx.job.updateMany({ where: { ...ws, id: plan.parent.id }, data: jobData(plan.parent) });
      if (plan.parentFinished) await tx.jobEvent.create({ data: statusEvent(plan.parent.id, at, plan.parent.status) });
    }
    if (plan.join) {
      await tx.job.create({ data: { ...ws, id: plan.join.id, ...jobData(plan.join) } });
      await tx.jobEvent.create({ data: statusEvent(plan.join.id, at, 'queued') });
      await ready(tx, [plan.join.id]);
    }
    const cancelled: JobRecord[] = [];
    const stop = [...plan.stop];
    for (const c of plan.cancel) {
      // Only while still queued: a worker may have claimed it since it was read; then ask that worker to stop it.
      const r = await tx.job.updateMany({ where: { ...ws, id: c.id, status: 'queued' }, data: { status: 'cancelled', finishedAt: new Date(at), error: json(c.error) } });
      if (r.count) {
        await tx.jobEvent.create({ data: statusEvent(c.id, at, 'cancelled') });
        cancelled.push(c);
      } else stop.push(c.id);
    }
    if (stop.length) await tx.job.updateMany({ where: { ...ws, id: { in: stop }, status: 'running', cancelRequestedAt: null }, data: { cancelRequestedAt: new Date(at) } });
    return { parent: plan.parent, parentFinished: plan.parentFinished, cancelled, join: plan.join, ...(plan.progressed ? { progressed: true } : {}) };
  };
  /** Settle a fan-out child's parent (the parent row is already locked by this transaction). */
  const settleIn = async (tx: Tx, child: JobRecord, at: string): Promise<ChildSettlement> => {
    const row = child.parentId ? await tx.job.findFirst({ where: { ...ws, id: child.parentId } }) : null;
    const siblings = row ? (await tx.job.findMany({ where: { ...ws, parentId: row.id } })).map(toJob) : [];
    return applyPlan(tx, settleChild(child, row ? toJob(row) : null, siblings, at), at);
  };
  /** A child's fenced final write plus the settlement of its parent: parent row locked first. */
  const finishChildTx = (job: JobRecord, at: string, fence?: JobLeaseFence) =>
    prisma.$transaction(async (tx) => {
      if (job.parentId) await lockJob(tx, job.parentId);
      const where = fence ? { ...ws, id: job.id, ...fenceWhere(fence) } : { ...ws, id: job.id };
      const data = fence ? { ...workerJobData(job), ...(TERMINAL_STATUSES.has(job.status) ? { leaseExpiresAt: null } : {}) } : jobData(job);
      const r = await tx.job.updateMany({ where, data });
      if (!r.count) return null;
      await tx.jobEvent.create({ data: statusEvent(job.id, at, job.status) });
      return settleIn(tx, job, at);
    }, lockingTx);

  /**
   * Claim exactly one job (`worker --once --job <id>`, D-100): the same atomic,
   * fenced claim as JobRepository.claim, with the per-key running cap (D-090),
   * kept apart from the fair-claim query. PostgreSQL/MySQL lock the row with
   * SKIP LOCKED (a job another worker is claiming is skipped), then check the
   * cap; SQLite takes it with one conditional UPDATE under the write lock.
   */
  const claimOne = (o: { workerId: string; types: string[]; now: string; leaseUntil: string; maxRunningPerKey?: number; id: string }) =>
    prisma.$transaction(async (tx) => {
      const typeIn = (first: number) => `${qi('type')} IN (${o.types.map((_, i) => ph(first + i)).join(', ')})`;
      const where = `${qi('workspaceId')} = ${ph(1)} AND ${qi('queue')} = 'database' AND ${qi('status')} = 'queued' AND ${typeIn(2)} AND ${qi('id')} = ${ph(2 + o.types.length)}`;
      const args = [workspaceId, ...o.types, o.id];
      const capped = o.maxRunningPerKey !== undefined;
      let id: string | undefined;
      if (kind === 'sqlite') {
        // One statement under the write lock, the running cap included: atomic, no lost or double claims.
        const cap = capped
          ? ` AND ("apiKeyId" IS NULL OR (SELECT COUNT(*) FROM ${tbl('Job')} "r" WHERE "r"."workspaceId" = "Job"."workspaceId" AND "r"."queue" = 'database' AND "r"."status" = 'running' AND "r"."leaseExpiresAt" IS NOT NULL AND "r"."apiKeyId" = "Job"."apiKeyId") < ?)`
          : '';
        const rows: Array<{ id: string }> = await tx.$queryRawUnsafe(
          `UPDATE ${tbl('Job')} SET "status" = 'running', "workerId" = ? WHERE ${where}${cap} RETURNING "id"`,
          o.workerId,
          ...args,
          ...(capped ? [o.maxRunningPerKey] : [])
        );
        id = rows[0]?.id;
      } else {
        const rows: Array<{ id: string; k: string | null }> = await tx.$queryRawUnsafe(
          `SELECT ${qi('id')}, ${qi('apiKeyId')} AS ${qi('k')} FROM ${tbl('Job')} WHERE ${where} FOR UPDATE SKIP LOCKED`,
          ...args
        );
        const one = rows[0];
        if (one && one.k && capped && (await tx.job.count({ where: { ...ws, queue: 'database', status: 'running', leaseExpiresAt: { not: null }, apiKeyId: one.k } })) >= o.maxRunningPerKey!) return null;
        id = one?.id;
      }
      if (!id) return null;
      const row = await tx.job.update({
        where: { id },
        data: {
          status: 'running',
          workerId: o.workerId,
          attempts: { increment: 1 },
          startedAt: new Date(o.now),
          leaseExpiresAt: new Date(o.leaseUntil),
          cancelRequestedAt: null,
          progress: json({ stage: 'starting', fraction: 0 }),
        },
      });
      await tx.jobEvent.create({ data: statusEvent(id, o.now, 'running') });
      await claimed(tx, row, o.now);
      return toJob(row);
    }, lockingTx);

  /**
   * The claim's plan on PostgreSQL and MySQL (#307, D-117): one row per (key, class) with queued jobs, with the
   * class (`p`), the time of its oldest queued job (`t`) and the key's running jobs (`n`; 0 without a key), in one
   * statement. Before, every claim grouped every queued job (a GROUP BY that read each row from the table: 10.7 ms
   * per claim at ~4 000 queued on PostgreSQL 17, growing with the queue). Both use the claim index (Job_claim_idx:
   * workspaceId, queue, status, apiKeyId, priority, createdAt).
   *   PostgreSQL has two exact plans and takes the cheaper. The GROUP BY reads every queued job (about 1.7 us
   *   each, measured); the recursive skip scan reads one index entry per (key, class): each step is one index
   *   descent to the first job of these types after the previous (key, class), which is the next one's oldest
   *   (35 to 66 us a step on the same host, so 21 to 39 queued jobs' worth). So the skip scan wins once the queue
   *   holds more than SKIP_FACTOR jobs per (key, class), and then the cost no longer grows with the queue. The
   *   GROUP BY also counts the jobs, so it decides; it runs again every PLAN_RECHECK claims or seconds to see the
   *   queue change. The choice is per process and only about cost: both plans give the same order.
   *   MySQL: it cannot seek on an outer reference inside a recursive step (each step read the whole queue) and
   *   does not use a loose index scan for this GROUP BY, so it groups the claim index itself, which covers the
   *   query (no table reads; 8.5 ms instead of 52 ms over 20 000 queued, measured). That index has no room for
   *   `type` (MySQL's 3 072-byte key limit), so `t` is the oldest job of any type: a lower bound, which the lock
   *   loop corrects (see claim).
   */
  const SKIP_FACTOR = 32;
  const PLAN_RECHECK = { claims: 100, ms: 30_000 };
  const planState = { skip: false, plans: 0, checkedAt: 0 };
  const claimPlan = async (types: string[]): Promise<Array<{ k: string | null; p: number; t: number; n: number }>> => {
    const args: unknown[] = [];
    const arg = (v: unknown) => (args.push(v), ph(args.length));
    const c = (a: string, col: string) => `${qi(a)}.${qi(col)}`;
    const ofQueue = (a: string, status: string) => `${c(a, 'workspaceId')} = ${arg(workspaceId)} AND ${c(a, 'queue')} = 'database' AND ${c(a, 'status')} = '${status}'`;
    const running =
      `SELECT ${c('r', 'apiKeyId')} AS ${qi('k')}, COUNT(*) AS ${qi('n')} FROM ${tbl('Job')} ${qi('r')} WHERE ${ofQueue('r', 'running')}` +
      ` AND ${c('r', 'leaseExpiresAt')} IS NOT NULL AND ${c('r', 'apiKeyId')} IS NOT NULL GROUP BY ${c('r', 'apiKeyId')}`;
    let sql: string;
    const skip = kind === 'postgresql' && planState.skip && planState.plans < PLAN_RECHECK.claims && Date.now() - planState.checkedAt < PLAN_RECHECK.ms;
    if (skip) {
      const typeIn = (a: string) => `${c(a, 'type')} IN (${types.map((t) => arg(t)).join(', ')})`;
      const cols = (a: string) => `${c(a, 'apiKeyId')}, ${c(a, 'priority')}, ${c(a, 'createdAt')}`;
      // The next (key, class) after the previous one, keyed and keyless apart (a row comparison is never true for NULL).
      const step = (prev: string, keyed: boolean) =>
        `SELECT ${cols('j')} FROM ${tbl('Job')} ${qi('j')} WHERE ${ofQueue('j', 'queued')} AND ${typeIn('j')} AND ` +
        (keyed
          ? prev ? `(${c('j', 'apiKeyId')}, ${c('j', 'priority')}) > (${c(prev, 'k')}, ${c(prev, 'p')})` : `${c('j', 'apiKeyId')} IS NOT NULL`
          : `${c('j', 'apiKeyId')} IS NULL` + (prev ? ` AND ${c('j', 'priority')} > ${c(prev, 'p')}` : '')) +
        // apiKeyId leads the order also when it is NULL, so the keyless walk reads the claim index too.
        ` ORDER BY ${c('j', 'apiKeyId')}, ${c('j', 'priority')}, ${c('j', 'createdAt')} LIMIT 1`;
      // PostgreSQL only, so the CTE names ("g", "h", "r": no tables) are written as plain quoted identifiers.
      const walk = (name: 'g' | 'h', keyed: boolean) =>
        `"${name}" ("k", "p", "t") AS ((${step('', keyed)}) UNION ALL SELECT ${cols('x')} FROM "${name}", LATERAL (${step(name, keyed)}) "x")`;
      sql =
        `WITH RECURSIVE ${walk('g', true)}, ${walk('h', false)}, "r" AS (${running})` +
        ` SELECT "q".*, COALESCE("r"."n", 0) AS "n" FROM (SELECT * FROM "g" UNION ALL SELECT * FROM "h") "q"` +
        ` LEFT JOIN "r" ON "r"."k" = "q"."k"`;
    } else {
      // PostgreSQL filters the types here (exact `t`) and counts the jobs (the choice above); MySQL groups the
      // covering index without `type` (no table reads; `t` a lower bound).
      const pg = kind === 'postgresql';
      sql =
        `SELECT ${c('q', 'k')}, ${c('q', 'p')}, ${c('q', 't')}, ${c('q', 'c')}, COALESCE(${c('r', 'n')}, 0) AS ${qi('n')} FROM` +
        ` (SELECT ${qi('apiKeyId')} AS ${qi('k')}, ${qi('priority')} AS ${qi('p')}, MIN(${qi('createdAt')}) AS ${qi('t')}, COUNT(*) AS ${qi('c')} FROM ${tbl('Job')} ${qi('j')}${pg ? '' : ` FORCE INDEX (${qi('Job_claim_idx')})`}` +
        ` WHERE ${ofQueue('j', 'queued')}${pg ? ` AND ${c('j', 'type')} IN (${types.map((t) => arg(t)).join(', ')})` : ''} GROUP BY ${qi('apiKeyId')}, ${qi('priority')}) ${qi('q')}` +
        ` LEFT JOIN (${running}) ${qi('r')} ON ${c('r', 'k')} = ${c('q', 'k')}`;
    }
    const rows = (await prisma.$queryRawUnsafe(sql, ...args)) as Array<{ k: string | null; p: unknown; t: unknown; c?: unknown; n: unknown }>;
    if (skip) planState.plans++;
    else if (kind === 'postgresql') {
      const queued = rows.reduce((a, r) => a + Number(r.c), 0);
      Object.assign(planState, { skip: queued > SKIP_FACTOR * rows.length, plans: 0, checkedAt: Date.now() });
    }
    return rows.map((r) => ({ k: r.k, p: Number(r.p), t: new Date(r.t as string).getTime(), n: Number(r.n) }));
  };

  type KeyRow = {
    id: string;
    name: string;
    scopes: string;
    prefix: string;
    salt: string;
    hash: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    prevPrefix: string | null;
    prevSalt: string | null;
    prevHash: string | null;
    prevExpiresAt: Date | null;
    rotatedAt: Date | null;
    rateLimitPerMinute: number | null;
    rendersPerDay: number | null;
    rendersPerMonth: number | null;
    ipAllowlist: string | null;
    maxPriority: string | null;
  };
  const toKey = (r: KeyRow): ApiKeyRecord => ({
    id: r.id,
    name: r.name,
    scopes: parse<Scope[]>(r.scopes),
    prefix: r.prefix,
    salt: r.salt,
    hash: r.hash,
    createdAt: iso(r.createdAt),
    ...(r.lastUsedAt ? { lastUsedAt: iso(r.lastUsedAt) } : {}),
    ...(r.expiresAt ? { expiresAt: iso(r.expiresAt) } : {}),
    ...(r.revokedAt ? { revokedAt: iso(r.revokedAt) } : {}),
    ...(r.prevPrefix && r.prevSalt && r.prevHash && r.prevExpiresAt
      ? { prev: { prefix: r.prevPrefix, salt: r.prevSalt, hash: r.prevHash, expiresAt: iso(r.prevExpiresAt) } }
      : {}),
    ...(r.rotatedAt ? { rotatedAt: iso(r.rotatedAt) } : {}),
    ...(r.rateLimitPerMinute !== null ? { rateLimitPerMinute: r.rateLimitPerMinute } : {}),
    ...(r.rendersPerDay !== null ? { rendersPerDay: r.rendersPerDay } : {}),
    ...(r.rendersPerMonth !== null ? { rendersPerMonth: r.rendersPerMonth } : {}),
    ...(r.ipAllowlist !== null ? { ipAllowlist: parse<string[]>(r.ipAllowlist) } : {}),
    ...(isPriority(r.maxPriority) ? { maxPriority: r.maxPriority } : {}),
  });
  const date = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));
  const keyPatch = (p: ApiKeyPatch) => {
    const d: Record<string, unknown> = {};
    if (p.name !== undefined) d.name = p.name;
    if (p.secret) Object.assign(d, { prefix: p.secret.prefix, salt: p.secret.salt, hash: p.secret.hash });
    if (p.prev !== undefined) {
      Object.assign(d, p.prev === null
        ? { prevPrefix: null, prevSalt: null, prevHash: null, prevExpiresAt: null }
        : { prevPrefix: p.prev.prefix, prevSalt: p.prev.salt, prevHash: p.prev.hash, prevExpiresAt: new Date(p.prev.expiresAt) });
    }
    if (p.rotatedAt !== undefined) d.rotatedAt = new Date(p.rotatedAt);
    if (p.revokedAt !== undefined) d.revokedAt = new Date(p.revokedAt);
    if (p.expiresAt !== undefined) d.expiresAt = date(p.expiresAt);
    if (p.rateLimitPerMinute !== undefined) d.rateLimitPerMinute = p.rateLimitPerMinute;
    if (p.rendersPerDay !== undefined) d.rendersPerDay = p.rendersPerDay;
    if (p.rendersPerMonth !== undefined) d.rendersPerMonth = p.rendersPerMonth;
    if (p.ipAllowlist !== undefined) d.ipAllowlist = p.ipAllowlist === null ? null : json(p.ipAllowlist);
    if (p.maxPriority !== undefined) d.maxPriority = p.maxPriority;
    return d;
  };

  const toAsset = (r: {
    id: string;
    sha256: string;
    bytes: bigint;
    contentType: string;
    mediaType: string;
    storageKey: string;
    source: string;
    originalName: string | null;
    license: string | null;
    durationSeconds: number | null;
    metadata: string | null;
    createdAt: Date;
  }): AssetRecord => ({
    id: r.id,
    sha256: r.sha256,
    bytes: Number(r.bytes),
    contentType: r.contentType,
    mediaType: r.mediaType as AssetRecord['mediaType'],
    createdAt: iso(r.createdAt),
    source: r.source,
    storageKey: r.storageKey,
    ...(r.originalName !== null ? { originalName: r.originalName } : {}),
    ...(r.license !== null ? { license: parse(r.license) } : {}),
    ...(r.durationSeconds !== null ? { durationSeconds: r.durationSeconds } : {}),
    ...(r.metadata !== null ? { metadata: parse(r.metadata) } : {}),
  });

  const toProject = (p: { id: string; version: number; createdAt: Date; updatedAt: Date; versions: Array<{ manifest: string }> }): StoredProject => ({
    meta: { id: p.id, version: p.version, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) },
    manifest: parse<Project>(p.versions[0]!.manifest),
  });
  /** The summary columns written with every version (D-102). */
  const summaryColumns = (m: Project) => {
    const { title, scenes, durationSeconds } = projectStats(m);
    return { title, sceneCount: scenes, durationSeconds };
  };
  const jobWhere = (filter: JobFilter) => ({
    ...(filter.projectId ? { projectId: filter.projectId } : {}),
    ...(filter.parentId ? { parentId: filter.parentId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.type ? { type: filter.type } : {}),
  });
  const latest = { versions: { orderBy: { version: 'desc' as const }, take: 1, select: { manifest: true } } };

  return {
    webhooks: createPrismaWebhookRepository(prisma, workspaceId),
    dispatchOutbox: {
      async claim(now, leaseUntil, limit) {
        const at = new Date(now);
        const candidates = await prisma.dispatchOutbox.findMany({
          where: { ...ws, nextAttemptAt: { lte: at }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: at } }] },
          orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
          take: limit,
        });
        const out = [];
        for (const c of candidates) {
          // Optimistic claim (as the webhook outbox, D-071): only the relay whose conditional update changes the row owns it.
          const n = await prisma.dispatchOutbox.updateMany({ where: { ...ws, id: c.id, lockedUntil: c.lockedUntil }, data: { lockedUntil: new Date(leaseUntil) } });
          if (n.count === 1)
            out.push({
              id: c.id,
              jobId: c.jobId,
              attempts: c.attempts,
              nextAttemptAt: iso(c.nextAttemptAt),
              lockedUntil: leaseUntil,
              ...(c.lastError !== null ? { lastError: c.lastError } : {}),
              createdAt: iso(c.createdAt),
            });
        }
        return out;
      },
      async remove(ids) {
        if (ids.length) await prisma.dispatchOutbox.deleteMany({ where: { ...ws, id: { in: ids } } });
      },
      async retry(id, attempts, nextAttemptAt, error) {
        await prisma.dispatchOutbox.updateMany({ where: { ...ws, id }, data: { attempts, nextAttemptAt: new Date(nextAttemptAt), lockedUntil: null, lastError: error.slice(0, 1000) } });
      },
      async count() {
        return prisma.dispatchOutbox.count({ where: ws });
      },
    },
    workspaceId,

    projects: {
      async create({ meta, manifest }) {
        try {
          await prisma.$transaction([
            prisma.project.create({
              data: { ...ws, id: meta.id, version: meta.version, ...summaryColumns(manifest), createdAt: new Date(meta.createdAt), updatedAt: new Date(meta.updatedAt) },
            }),
            prisma.projectVersion.create({
              data: { ...ws, projectId: meta.id, version: meta.version, manifest: json(manifest), createdAt: new Date(meta.updatedAt) },
            }),
          ]);
        } catch (e) {
          if (isUniqueViolation(e)) throw conflict(`project "${meta.id}" already exists; use update_project or pick another projectId`);
          throw e;
        }
      },
      async get(id) {
        const p = await prisma.project.findUnique({ where: { workspaceId_id: { workspaceId, id } }, include: latest });
        return p && p.versions.length ? toProject(p) : null;
      },
      async getVersion(id, version) {
        const v = await prisma.projectVersion.findUnique({ where: { workspaceId_projectId_version: { workspaceId, projectId: id, version } } });
        return v ? parse<Project>(v.manifest) : null;
      },
      async listVersions(id) {
        const rows = await replica.projectVersion.findMany({ where: { ...ws, projectId: id }, select: { version: true }, orderBy: { version: 'asc' } });
        return rows.map((r) => r.version);
      },
      async list() {
        const rows = await prisma.project.findMany({ where: ws, include: latest, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] });
        return rows.filter((p) => p.versions.length).map(toProject);
      },
      async page(req) {
        const rows = await replica.project.findMany({
          where: { ...ws, ...keyset(req) },
          orderBy: NEWEST,
          take: req.limit,
          select: { id: true, version: true, title: true, sceneCount: true, durationSeconds: true, createdAt: true, updatedAt: true },
        });
        // Rows saved before migration 0008 have no summary columns yet: read just their manifests (at most one page).
        const missing = rows.filter((r) => r.sceneCount === null || r.durationSeconds === null).map((r) => r.id);
        const manifests = new Map<string, Project>();
        if (missing.length) {
          const old = await replica.project.findMany({ where: { ...ws, id: { in: missing } }, include: latest });
          for (const p of old) if (p.versions.length) manifests.set(p.id, parse<Project>(p.versions[0]!.manifest));
        }
        const out: ProjectSummary[] = [];
        for (const r of rows) {
          const meta = { id: r.id, version: r.version, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) };
          const m = manifests.get(r.id);
          if (r.sceneCount !== null && r.durationSeconds !== null) out.push({ ...meta, title: r.title, scenes: r.sceneCount, durationSeconds: r.durationSeconds });
          else if (m) out.push({ ...meta, ...projectStats(m) });
        }
        return out;
      },
      async saveVersion(id, expectedVersion, manifest, updatedAt): Promise<ProjectMeta | null> {
        const at = new Date(updatedAt);
        return prisma.$transaction(async (tx: Tx) => {
          const r = await tx.project.updateMany({
            where: { ...ws, id, version: expectedVersion },
            data: { version: expectedVersion + 1, ...summaryColumns(manifest), updatedAt: at },
          });
          if (r.count !== 1) return null;
          await tx.projectVersion.create({ data: { ...ws, projectId: id, version: expectedVersion + 1, manifest: json(manifest), createdAt: at } });
          const p = await tx.project.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id } } });
          return { id, version: p.version, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) };
        }, TX);
      },
      async delete(id) {
        // Versions go with the project (ON DELETE CASCADE).
        const r = await prisma.project.deleteMany({ where: { ...ws, id } });
        return r.count > 0;
      },
    },

    keys: {
      async list() {
        return (await prisma.apiKey.findMany({ where: ws, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(toKey);
      },
      async get(id) {
        const r = await prisma.apiKey.findFirst({ where: { ...ws, id } });
        return r ? toKey(r) : null;
      },
      async count() {
        return prisma.apiKey.count({ where: ws });
      },
      async insert(k) {
        try {
          await prisma.apiKey.create({
            data: {
              ...ws,
              id: k.id,
              scopes: json(k.scopes),
              createdAt: new Date(k.createdAt),
              lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt) : null,
              ...keyPatch({
                name: k.name,
                secret: { prefix: k.prefix, salt: k.salt, hash: k.hash },
                ...(k.prev ? { prev: k.prev } : {}),
                ...(k.rotatedAt ? { rotatedAt: k.rotatedAt } : {}),
                ...(k.revokedAt ? { revokedAt: k.revokedAt } : {}),
                expiresAt: k.expiresAt ?? null,
                rateLimitPerMinute: k.rateLimitPerMinute ?? null,
                rendersPerDay: k.rendersPerDay ?? null,
                rendersPerMonth: k.rendersPerMonth ?? null,
                ipAllowlist: k.ipAllowlist ?? null,
                maxPriority: k.maxPriority ?? null,
              }),
            } as never,
          });
        } catch (e) {
          if (isUniqueViolation(e)) throw conflict(`key "${k.id}" already exists`);
          throw e;
        }
      },
      async update(id, patch) {
        const r = await prisma.apiKey.updateMany({ where: { ...ws, id }, data: keyPatch(patch) });
        if (!r.count) return null;
        const row = await prisma.apiKey.findFirst({ where: { ...ws, id } });
        return row ? toKey(row) : null;
      },
      async delete(id) {
        return (await prisma.apiKey.deleteMany({ where: { ...ws, id } })).count > 0;
      },
      async findByPrefix(prefix) {
        return (await prisma.apiKey.findMany({ where: { ...ws, OR: [{ prefix }, { prevPrefix: prefix }] } })).map(toKey);
      },
      async touch(id, lastUsedAt) {
        await prisma.apiKey.updateMany({ where: { ...ws, id }, data: { lastUsedAt: new Date(lastUsedAt) } });
      },
    },

    jobs: {
      async insert(job, at) {
        try {
          await prisma.$transaction([
            prisma.job.create({ data: { ...ws, id: job.id, ...jobData(job) } }),
            prisma.jobEvent.create({ data: { ...ws, jobId: job.id, at: new Date(at), type: 'status', message: job.status } }),
            ...readyBatch(job.status === 'queued' && job.queue === 'database' ? [job.id] : []),
          ]);
        } catch (e) {
          if (isUniqueViolation(e)) throw conflict(`job "${job.id}" already exists`);
          throw e;
        }
      },
      async insertWithQuota(job, at, quota) {
        // Short lock (#180, D-090): the job and its event are written first, before any lock (other transactions
        // cannot see them until commit), then the lock, then ONE statement with every count, then commit or
        // roll back. One statement runs under the lock instead of one per count and insert, so the lock is held for
        // two round trips from the api process (the lock's and the count's) instead of four to seven.
        const key = quota.apiKeyId;
        const total = quota.maxQueuedTotal !== undefined;
        const args: unknown[] = [];
        const p = (v: unknown) => (args.push(v), ph(args.length));
        const checks: Array<{ col: string; limit: number; refuse: (used: number) => QuotaResult }> = [];
        // COUNT of the other jobs (the new row is already in) of `types` matching `cond`; built left to right, so
        // the placeholders are numbered in the order their values are pushed.
        const count = (col: string, cond: () => string) =>
          `(SELECT COUNT(*) FROM ${tbl('Job')} WHERE ${qi('workspaceId')} = ${p(workspaceId)} AND ${qi('id')} <> ${p(job.id)}` +
          ` AND ${qi('type')} IN (${quota.types.map(p).join(', ')}) AND ${cond()}) AS ${qi(col)}`;
        const parts: string[] = [];
        if (key) {
          for (const [i, w] of quota.windows.entries()) {
            parts.push(count(`w${i}`, () => `${qi('apiKeyId')} = ${p(key)} AND ${qi('createdAt')} >= ${p(new Date(w.since))}`));
            checks.push({ col: `w${i}`, limit: w.limit, refuse: (used) => ({ ok: false, window: i, used }) });
          }
          if (quota.maxActivePerKey !== undefined) {
            parts.push(count('a', () => `${qi('apiKeyId')} = ${p(key)} AND ${qi('status')} IN ('queued', 'running')`));
            checks.push({ col: 'a', limit: quota.maxActivePerKey, refuse: (used) => ({ ok: false, cap: 'active_per_key', used }) });
          }
        }
        if (total) {
          parts.push(count('q', () => `${qi('status')} = 'queued'`));
          checks.push({ col: 'q', limit: quota.maxQueuedTotal!, refuse: (used) => ({ ok: false, cap: 'queued_total', used }) });
        }
        // Admission by estimated wait (D-103): the queued jobs that would be claimed before the new one (same queue,
        // same or higher class, any type: units take slots too) and the oldest of them, in the same statement.
        const wait = quota.maxEstimatedWait;
        if (wait) {
          // Built per use: each subquery pushes its own placeholder values, in order.
          const ahead = () =>
            `FROM ${tbl('Job')} WHERE ${qi('workspaceId')} = ${p(workspaceId)} AND ${qi('id')} <> ${p(job.id)} AND ` +
            (job.queue ? `${qi('queue')} = ${p(job.queue)}` : `${qi('queue')} IS NULL`) +
            ` AND ${qi('status')} = 'queued' AND ${qi('priority')} <= ${p(priorityRank(job.priority))}`;
          parts.push(`(SELECT COUNT(*) ${ahead()}) AS ${qi('ea')}`);
          parts.push(`(SELECT MIN(${qi('createdAt')}) ${ahead()}) AS ${qi('eo')}`);
        }
        const refusal = new Error('job cap reached');
        const lockMissing = new Error('queue lock row missing');
        let refused: QuotaResult | undefined;
        for (let attempt = 0; ; attempt++) {
          try {
            return await prisma.$transaction(async (tx) => {
              try {
                await tx.job.createMany({ data: [{ ...ws, id: job.id, ...jobData(job) }] });
              } catch (e) {
                if (isUniqueViolation(e)) throw conflict(`job "${job.id}" already exists`);
                throw e;
              }
              await tx.jobEvent.createMany({ data: [statusEvent(job.id, at, job.status)] });
              // Before the lock, so it is not held for one more round trip; a refusal rolls it back with the job.
              if (job.status === 'queued' && job.queue === 'database') await ready(tx, [job.id]);
              if (!parts.length) return { ok: true as const };
              // The lock (a no-op update): with a total queue cap one shared row (every start waits here), else the
              // key's row (starts for this key wait). It is not the Workspace row: every insert holds a foreign-key
              // lock on that, which on MySQL would turn this into a lock upgrade that deadlocks concurrent starts.
              // (Admission by estimated wait alone, without a key: no lock; it is an estimate, not a count to enforce.)
              if (total) {
                const n = await tx.$executeRawUnsafe(
                  `UPDATE ${tbl('RateLimitWindow')} SET ${qi('count')} = ${qi('count')} WHERE ${qi('workspaceId')} = ${ph(1)} AND ${qi('key')} = ${ph(2)}`,
                  workspaceId,
                  QUEUE_LOCK_KEY
                );
                if (!n) throw lockMissing;
              } else if (key) {
                await tx.$executeRawUnsafe(`UPDATE ${tbl('ApiKey')} SET ${qi('id')} = ${qi('id')} WHERE ${qi('id')} = ${ph(1)}`, key);
              }
              // A statement after the lock sees every job committed by the previous holder (read committed).
              const [row] = (await tx.$queryRawUnsafe(`SELECT ${parts.join(', ')}`, ...args)) as Array<Record<string, unknown>>;
              for (const c of checks) {
                const used = Number(row?.[c.col] ?? 0);
                if (used >= c.limit) {
                  refused = c.refuse(used);
                  throw refusal; // roll back the job and its event
                }
              }
              if (wait) {
                const n = Number(row?.['ea'] ?? 0);
                const oldest = row?.['eo'] == null ? null : new Date(row['eo'] as string | Date).toISOString();
                const est = estimateWaitSeconds({ ahead: n, oldestQueuedAt: oldest, claimsPerSecond: wait.claimsPerSecond, nowMs: Date.parse(wait.now) });
                if (est > wait.seconds && oldest) {
                  refused = { ok: false, cap: 'estimated_wait', used: n, oldestQueuedAt: oldest, estimatedWaitSeconds: est };
                  throw refusal;
                }
              }
              return { ok: true as const };
            }, lockingTx);
          } catch (e) {
            if (e === refusal && refused) return refused;
            if (e !== lockMissing || attempt >= 2) throw e;
            // First total-capped start of this workspace: create the lock row (outside a transaction: a unique
            // violation would abort a PostgreSQL transaction), then start over.
            try {
              await prisma.rateLimitWindow.create({ data: { ...ws, key: QUEUE_LOCK_KEY, windowStart: new Date(0), count: 0 } });
            } catch (err) {
              if (!isUniqueViolation(err)) throw err;
            }
          }
        }
      },
      async update(job, fence) {
        if (!fence) return (await prisma.job.updateMany({ where: { ...ws, id: job.id }, data: jobData(job) })).count > 0;
        return (await prisma.job.updateMany({ where: { ...ws, id: job.id, ...fenceWhere(fence) }, data: workerJobData(job) })).count > 0;
      },
      async transition(job, at, fence) {
        if (job.parentId && isTerminal(job.status)) return (await finishChildTx(job, at, fence)) !== null;
        if (!fence) {
          const [r] = await prisma.$transaction([
            prisma.job.updateMany({ where: { ...ws, id: job.id }, data: jobData(job) }),
            prisma.jobEvent.create({ data: statusEvent(job.id, at, job.status) }),
          ]);
          return r.count > 0;
        }
        return prisma.$transaction(async (tx) => {
          const r = await tx.job.updateMany({ where: { ...ws, id: job.id, ...fenceWhere(fence) }, data: { ...workerJobData(job), ...(TERMINAL_STATUSES.has(job.status) ? { leaseExpiresAt: null } : {}) } });
          if (!r.count) return false;
          await tx.jobEvent.create({ data: statusEvent(job.id, at, job.status) });
          return true;
        }, TX);
      },
      async finishChild(job, at, fence) {
        return finishChildTx(job, at, fence);
      },
      async fanOut(parent, children, at, fence) {
        return prisma.$transaction(async (tx) => {
          const r = await tx.job.updateMany({
            where: { ...ws, id: parent.id, ...fenceWhere(fence), cancelRequestedAt: null },
            data: { ...workerJobData({ ...parent, status: 'running' }), pendingChildren: children.length, workerId: null, leaseExpiresAt: null },
          });
          if (!r.count) return (await tx.job.count({ where: { ...ws, id: parent.id, ...fenceWhere(fence) } })) ? ('cancelled' as const) : ('lost' as const);
          for (const c of children) {
            await tx.job.create({ data: { ...ws, id: c.id, ...jobData(c) } });
            await tx.jobEvent.create({ data: statusEvent(c.id, at, c.status) });
          }
          await ready(tx, children.filter((c) => c.status === 'queued').map((c) => c.id));
          return 'ok' as const;
        }, lockingTx);
      },
      async cancelTree(id, at) {
        return prisma.$transaction(async (tx) => {
          await lockJob(tx, id);
          const row = await tx.job.findFirst({ where: { ...ws, id } });
          if (!row || !isFannedOut(toJob(row))) return null;
          const children = (await tx.job.findMany({ where: { ...ws, parentId: id } })).map(toJob);
          const r = await applyPlan(tx, stopTree(toJob(row), children, 'cancelled', { code: 'cancelled', message: 'cancelled while running' }, at), at);
          return [r.parent!, ...r.cancelled];
        }, lockingTx);
      },
      async claim({ workerId, types, now, leaseUntil, maxRunningPerKey, id: only, priorityAgingSeconds }) {
        if (!types.length) return null;
        if (only !== undefined) return claimOne({ workerId, types, now, leaseUntil, maxRunningPerKey, id: only });
        // Priority first (D-103): the highest class, a batch job queued before `agedBefore` counting as standard.
        // Then fair across API keys (D-090): the queued job whose key has the fewest running database-queue jobs,
        // oldest first among equals (jobs without a key count as a key with none running). Optionally only
        // keys below a running cap.
        const capped = maxRunningPerKey !== undefined;
        const aging = priorityAgingSeconds !== undefined && priorityAgingSeconds > 0;
        const take = async (tx: Tx, id: string | undefined) => {
          if (!id) return null;
          const row = await tx.job.update({
            where: { id },
            data: {
              status: 'running',
              workerId,
              attempts: { increment: 1 },
              startedAt: new Date(now),
              leaseExpiresAt: new Date(leaseUntil),
              cancelRequestedAt: null,
              progress: json({ stage: 'starting', fraction: 0 }),
            },
          });
          await tx.jobEvent.create({ data: statusEvent(id, now, 'running') });
          await claimed(tx, row, now);
          return toJob(row);
        };
        if (kind === 'sqlite') {
          // One statement under the write lock (the first write of the transaction waits for it): atomic, no lost
          // claims. Placeholders start at `first`: workspace id (running counts), workspace id, the types, the cap,
          // then the aging cut-off. SQLite is one instance (D-076), so this plan is not on the scale path (#307).
          const agedBefore = aging ? new Date(Date.parse(now) - priorityAgingSeconds! * 1000) : undefined;
          const j = qi('j');
          const running =
            `LEFT JOIN (SELECT ${qi('apiKeyId')}, COUNT(*) AS ${qi('n')} FROM ${tbl('Job')} WHERE ${qi('workspaceId')} = PH0` +
            ` AND ${qi('queue')} = 'database' AND ${qi('status')} = 'running' AND ${qi('leaseExpiresAt')} IS NOT NULL AND ${qi('apiKeyId')} IS NOT NULL GROUP BY ${qi('apiKeyId')}) ${qi('r')}` +
            ` ON ${qi('r')}.${qi('apiKeyId')} = ${j}.${qi('apiKeyId')}`;
          const pick = (first: number) =>
            (`SELECT ${j}.${qi('id')} FROM ${tbl('Job')} ${j} ${running}` +
              ` WHERE ${j}.${qi('workspaceId')} = ${ph(first + 1)} AND ${j}.${qi('queue')} = 'database' AND ${j}.${qi('status')} = 'queued'` +
              ` AND ${j}.${qi('type')} IN (${types.map((_, i) => ph(first + 2 + i)).join(', ')})` +
              (capped ? ` AND COALESCE(${qi('r')}.${qi('n')}, 0) < ${ph(first + 2 + types.length)}` : '') +
              ` ORDER BY ` +
              (aging
                ? `CASE WHEN ${j}.${qi('priority')} > ${AGED_RANK} AND ${j}.${qi('createdAt')} < ${ph(first + 2 + types.length + (capped ? 1 : 0))} THEN ${AGED_RANK} ELSE ${j}.${qi('priority')} END`
                : `${j}.${qi('priority')}`) +
              `, COALESCE(${qi('r')}.${qi('n')}, 0), ${j}.${qi('createdAt')}, ${j}.${qi('id')} LIMIT 1`).replace('PH0', ph(first));
          const args = [workspaceId, workspaceId, ...types, ...(capped ? [maxRunningPerKey] : []), ...(aging ? [agedBefore] : [])];
          return prisma.$transaction(async (tx) => {
            const rows: Array<{ id: string }> = await tx.$queryRawUnsafe(`UPDATE ${tbl('Job')} SET "status" = 'running', "workerId" = ? WHERE "id" = (${pick(2)}) AND "status" = 'queued' RETURNING "id"`, workerId, ...args);
            return take(tx, rows[0]?.id);
          }, lockingTx);
        }
        // PostgreSQL and MySQL (#307, D-117). Plan with one plain read outside the transaction (claimPlan): every
        // (key, class) with queued jobs, its oldest job and the key's running jobs. Then lock one job of the best
        // (key, class) that no other transaction holds (SKIP LOCKED: a job another worker is claiming is skipped,
        // never waited for), falling through to the next when all of its jobs are held. An empty plan (an idle
        // poll) opens no transaction at all.
        const nowMs = Date.parse(now);
        const rank = (a: { e: number; n: number; t: number }, b: { e: number; n: number; t: number }) => a.e - b.e || a.n - b.n || a.t - b.t;
        const order = (await claimPlan(types))
          .map((r) => ({ ...r, e: effectiveRank(r.p, r.t, nowMs, priorityAgingSeconds) }))
          .filter((r) => !capped || r.k === null || r.n < maxRunningPerKey!)
          .sort(rank);
        if (!order.length) return null;
        return prisma.$transaction(async (tx) => {
          const typeIn = (first: number) => `${qi('type')} IN (${types.map((_, i) => ph(first + i)).join(', ')})`;
          let rows: Array<{ id: string }> = [];
          while (order.length && !rows.length) {
            const c = order[0]!;
            // Placeholders in text order (MySQL's are positional): the class, then the key. Key and class lead the
            // claim index after the queue columns, so this reads the (key, class) range in age order.
            const keyWhere = `${qi('priority')} = ${ph(2 + types.length)} AND ` + (c.k === null ? `${qi('apiKeyId')} IS NULL` : `${qi('apiKeyId')} = ${ph(3 + types.length)}`);
            const queuedOfKey = `FROM ${tbl('Job')} WHERE ${qi('workspaceId')} = ${ph(1)} AND ${qi('queue')} = 'database' AND ${qi('status')} = 'queued' AND ${typeIn(2)} AND ${keyWhere}`;
            const keyArgs = [workspaceId, ...types, c.p, ...(c.k === null ? [] : [c.k])];
            if (kind === 'postgresql') {
              // PostgreSQL locks only the rows the LIMIT lets through, whatever the plan.
              rows = await tx.$queryRawUnsafe(`SELECT ${qi('id')} ${queuedOfKey} ORDER BY ${qi('createdAt')}, ${qi('id')} LIMIT 1 FOR UPDATE SKIP LOCKED`, ...keyArgs);
              if (!rows.length) order.shift();
              continue;
            }
            // MySQL locks every matching row its plan reads, not only the one it returns: with a sort
            // `LIMIT 1 FOR UPDATE SKIP LOCKED` locked every queued job of the key, and concurrent claims found
            // nothing to take (#168). So read the candidates in order without locks, then lock them one at a time
            // by primary key, skipping a job another transaction holds or a worker took meanwhile; page on until
            // the (key, class) has none left. The plan's `t` is the oldest job of any type (claimPlan), a lower
            // bound: the first page gives the oldest job of these types, and when that is younger the (key, class)
            // is ranked again with it and yields to a better one (a lazy priority queue: a key only ever grows,
            // so what is taken is the best by the exact order).
            let after: { t: unknown; id: string } | undefined;
            let yielded = false;
            do {
              const page: Array<{ id: string; t: unknown }> = await tx.$queryRawUnsafe(
                `SELECT ${qi('id')}, ${qi('createdAt')} AS ${qi('t')} ${queuedOfKey}` +
                  (after ? ` AND (${qi('createdAt')} > ? OR (${qi('createdAt')} = ? AND ${qi('id')} > ?))` : '') +
                  ` ORDER BY ${qi('createdAt')}, ${qi('id')} LIMIT ${CLAIM_CANDIDATES}`,
                ...keyArgs,
                ...(after ? [after.t, after.t, after.id] : [])
              );
              if (!after && page.length) {
                const t = new Date(page[0]!.t as string).getTime();
                if (t > c.t) {
                  c.t = t;
                  c.e = effectiveRank(c.p, t, nowMs, priorityAgingSeconds);
                  order.sort(rank);
                  if (order[0] !== c) {
                    yielded = true;
                    break;
                  }
                }
              }
              for (const cand of page) {
                rows = await tx.$queryRawUnsafe(`SELECT ${qi('id')} FROM ${tbl('Job')} WHERE ${qi('id')} = ? AND ${qi('status')} = 'queued' FOR UPDATE SKIP LOCKED`, cand.id);
                if (rows.length) break;
              }
              after = page.length === CLAIM_CANDIDATES ? page[page.length - 1] : undefined;
            } while (!rows.length && after);
            if (!rows.length && !yielded) order.splice(order.indexOf(c), 1);
          }
          return take(tx, rows[0]?.id);
        }, lockingTx);
      },
      async heartbeat(workerId, ids, leaseUntil) {
        if (!ids.length) return { held: [], cancelRequested: [] };
        const where = { ...ws, id: { in: ids }, workerId, status: 'running' };
        await prisma.job.updateMany({ where, data: { leaseExpiresAt: new Date(leaseUntil) } });
        const rows = await prisma.job.findMany({ where, select: { id: true, cancelRequestedAt: true } });
        return { held: rows.map((r) => r.id), cancelRequested: rows.filter((r) => r.cancelRequestedAt).map((r) => r.id) };
      },
      async recoverExpired(now, maxAttempts) {
        const requeued: JobRecord[] = [];
        const failed: JobRecord[] = [];
        const settled: JobRecord[] = [];
        const rows = await prisma.job.findMany({ where: { ...ws, queue: 'database', status: 'running', leaseExpiresAt: { lt: new Date(now) } }, orderBy: { leaseExpiresAt: 'asc' }, take: 100 });
        for (const r of rows) {
          const job = toJob(r);
          const u = expiredUpdate(job, now, maxAttempts);
          const next: JobRecord = { ...job, ...u.patch };
          for (const k of u.unset) delete (next as unknown as Record<string, unknown>)[k];
          const child = next.parentId && isTerminal(next.status);
          const done = await prisma.$transaction(async (tx) => {
            // A fan-out child that fails settles its parent: lock the parent first (as finishChild).
            if (child) await lockJob(tx, next.parentId!);
            // Only if nobody renewed or recovered it since we read it.
            const res = await tx.job.updateMany({ where: { ...ws, id: r.id, status: 'running', leaseExpiresAt: r.leaseExpiresAt }, data: jobData(next) });
            if (!res.count) return false;
            await tx.jobEvent.create({ data: logEvent(r.id, now, u.line) });
            await tx.jobEvent.create({ data: statusEvent(r.id, now, next.status) });
            if (next.status === 'queued') await ready(tx, [r.id]);
            if (child) {
              const s = await settleIn(tx, next, now);
              if (s.parentFinished && s.parent) settled.push(s.parent);
              settled.push(...s.cancelled);
            }
            return true;
          }, child ? lockingTx : TX);
          if (done) (next.status === 'queued' ? requeued : failed).push(next);
        }
        return { requeued, failed, settled };
      },
      async release(id, fence, at) {
        return prisma.$transaction(async (tx) => {
          const r = await tx.job.updateMany({
            where: { ...ws, id, ...fenceWhere(fence) },
            data: { status: 'queued', workerId: null, leaseExpiresAt: null, startedAt: null, attempts: { decrement: 1 }, progress: json({ stage: 'queued', fraction: 0 }) },
          });
          if (!r.count) return false;
          await tx.jobEvent.create({ data: logEvent(id, at, `released by worker ${fence.workerId} (shutting down); queued again`) });
          await tx.jobEvent.create({ data: statusEvent(id, at, 'queued') });
          await ready(tx, [id]);
          return true;
        }, TX);
      },
      async takeLease(name, holder, now, until, value) {
        const data = { holder, expiresAt: new Date(until), updatedAt: new Date(now), ...(value !== undefined ? { value } : {}) };
        // One UPDATE with the condition in its WHERE (as claimCheck): the row lock makes exactly one caller win a free lease.
        const r = await prisma.instanceLease.updateMany({ where: { ...ws, name, OR: [{ holder }, { expiresAt: { lte: new Date(now) } }] }, data });
        if (r.count) return true;
        if (await prisma.instanceLease.findUnique({ where: { workspaceId_name: { workspaceId, name } }, select: { name: true } })) return false;
        try {
          await prisma.instanceLease.create({ data: { ...ws, name, ...data } });
          return true;
        } catch (e) {
          // Another instance created it first.
          if (isUniqueViolation(e)) return false;
          throw e;
        }
      },
      async readLease(name) {
        const r = await prisma.instanceLease.findUnique({ where: { workspaceId_name: { workspaceId, name } } });
        return r ? { holder: r.holder, expiresAt: iso(r.expiresAt), updatedAt: iso(r.updatedAt), ...(r.value !== null ? { value: r.value } : {}) } : null;
      },
      async releaseLease(name, holder, at) {
        const r = await prisma.instanceLease.updateMany({ where: { ...ws, name, holder }, data: { expiresAt: new Date(at), updatedAt: new Date(at) } });
        return r.count > 0;
      },
      async cancelQueued(id, at, error) {
        const parentId = (await prisma.job.findFirst({ where: { ...ws, id }, select: { parentId: true } }))?.parentId ?? null;
        return prisma.$transaction(async (tx) => {
          if (parentId) await lockJob(tx, parentId);
          const r = await tx.job.updateMany({ where: { ...ws, id, status: 'queued' }, data: { status: 'cancelled', finishedAt: new Date(at), error: json(error) } });
          if (!r.count) return null;
          await tx.jobEvent.create({ data: statusEvent(id, at, 'cancelled') });
          const row = await tx.job.findFirst({ where: { ...ws, id } });
          if (row && parentId) await settleIn(tx, toJob(row), at);
          return row ? toJob(row) : null;
        }, parentId ? lockingTx : TX);
      },
      async requestCancel(id, at) {
        const r = await prisma.job.updateMany({ where: { ...ws, id, status: 'running', cancelRequestedAt: null }, data: { cancelRequestedAt: new Date(at) } });
        if (r.count) return true;
        return (await prisma.job.count({ where: { ...ws, id, status: 'running' } })) > 0;
      },
      async countQueued(before) {
        const rank = priorityRank(before?.priority);
        const older = before ? { OR: [{ createdAt: { lt: new Date(before.createdAt) } }, { createdAt: new Date(before.createdAt), id: { lt: before.id } }] } : {};
        // Ahead of it: a higher class, or the same class and older (D-103).
        const ahead = before ? { OR: [{ priority: { lt: rank } }, { priority: rank, ...older }] } : {};
        return prisma.job.count({ where: { ...ws, queue: 'database', status: 'queued', ...ahead } });
      },
      async get(id) {
        const r = await prisma.job.findFirst({ where: { ...ws, id } });
        return r ? toJob(r) : null;
      },
      async list(filter = {}) {
        const rows = await prisma.job.findMany({
          where: { ...ws, ...jobWhere(filter) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        return rows.map(toJob);
      },
      async page(filter, req) {
        const rows = await replica.job.findMany({
          where: { ...ws, ...jobWhere(filter), ...keyset(req) },
          orderBy: NEWEST,
          take: req.limit,
        });
        return rows.map(toJob);
      },
      async projectOfRun(runId) {
        // Index (workspaceId, runId), migration 0009; the workspace scope stays: another workspace's run is not found.
        const row = await prisma.job.findFirst({ where: { ...ws, runId, projectId: { not: null } }, select: { projectId: true } });
        return row?.projectId ?? null;
      },
      async listUnfinished() {
        return (await prisma.job.findMany({ where: { ...ws, status: { in: ['queued', 'running'] } } })).map(toJob);
      },
      async countByApiKey(apiKeyId, since, types) {
        return prisma.job.count({ where: { ...ws, apiKeyId, createdAt: { gte: new Date(since) }, type: { in: types } } });
      },
      async appendLog(jobId, at, line) {
        await prisma.jobEvent.create({ data: { ...ws, jobId, at: new Date(at), type: 'log', message: line } });
      },
      async logs(jobId, tail) {
        const rows = await prisma.jobEvent.findMany({
          where: { ...ws, jobId, type: 'log' },
          orderBy: { id: tail ? 'desc' : 'asc' },
          ...(tail ? { take: tail } : {}),
          select: { at: true, message: true },
        });
        if (tail) rows.reverse();
        return rows.map((r) => `${iso(r.at)} ${r.message}`);
      },
    },

    themes: {
      async list() {
        return (await replica.theme.findMany({ where: ws, orderBy: { id: 'asc' } })).map((t) => parse<Theme>(t.definition));
      },
      async get(id) {
        const t = await prisma.theme.findUnique({ where: { workspaceId_id: { workspaceId, id } } });
        return t ? parse<Theme>(t.definition) : null;
      },
      async insert(theme, at) {
        try {
          await prisma.theme.create({ data: { ...ws, id: theme.id, definition: json(theme), createdAt: new Date(at), updatedAt: new Date(at) } });
        } catch (e) {
          if (isUniqueViolation(e)) throw conflict(`theme "${theme.id}" already exists`);
          throw e;
        }
      },
      async put(theme, at) {
        await prisma.theme.upsert({
          where: { workspaceId_id: { workspaceId, id: theme.id } },
          create: { ...ws, id: theme.id, definition: json(theme), createdAt: new Date(at), updatedAt: new Date(at) },
          update: { definition: json(theme), updatedAt: new Date(at) },
        });
      },
      async delete(id) {
        return (await prisma.theme.deleteMany({ where: { ...ws, id } })).count > 0;
      },
    },

    providerSettings: {
      async values() {
        const rows = await prisma.providerSetting.findMany({ where: ws, orderBy: { name: 'asc' } });
        return Object.fromEntries(rows.map((r) => [r.name, { value: r.value, scheme: r.scheme }]));
      },
      async list() {
        const rows = await prisma.providerSetting.findMany({ where: ws, orderBy: { name: 'asc' }, select: { name: true, providerId: true, scheme: true, updatedAt: true } });
        return rows.map((r) => ({ name: r.name, scheme: r.scheme, updatedAt: iso(r.updatedAt), ...(r.providerId !== null ? { providerId: r.providerId } : {}) }));
      },
      async apply(changes, at, providerId) {
        const ops = Object.entries(changes).map(([name, v]) =>
          v === null
            ? prisma.providerSetting.deleteMany({ where: { ...ws, name } })
            : prisma.providerSetting.upsert({
                where: { workspaceId_name: { workspaceId, name } },
                create: { ...ws, name, value: v.value, scheme: v.scheme, providerId: providerId ?? null, updatedAt: new Date(at) },
                update: { value: v.value, scheme: v.scheme, ...(providerId ? { providerId } : {}), updatedAt: new Date(at) },
              })
        );
        if (ops.length) await prisma.$transaction(ops);
      },
    },

    settings: {
      async list() {
        const rows = await prisma.setting.findMany({ where: ws, orderBy: { key: 'asc' } });
        return rows.map((r) => ({ key: r.key, value: r.value, scheme: r.scheme, updatedAt: iso(r.updatedAt), ...(r.updatedBy !== null ? { updatedBy: r.updatedBy } : {}) }));
      },
      async apply(changes, at, updatedBy) {
        const ops = Object.entries(changes).map(([key, v]) =>
          v === null
            ? prisma.setting.deleteMany({ where: { ...ws, key } })
            : prisma.setting.upsert({
                where: { workspaceId_key: { workspaceId, key } },
                create: { ...ws, key, value: v.value, scheme: v.scheme, updatedAt: new Date(at), updatedBy: updatedBy ?? null },
                update: { value: v.value, scheme: v.scheme, updatedAt: new Date(at), updatedBy: updatedBy ?? null },
              })
        );
        if (ops.length) await prisma.$transaction(ops);
      },
    },

    licence: {
      async get() {
        const r = await prisma.licenceState.findUnique({ where: { workspaceId } });
        return r ? toLicence(r) : null;
      },
      async init(instanceId, at) {
        try {
          await prisma.licenceState.create({ data: { ...ws, instanceId, updatedAt: new Date(at) } });
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
        }
        return toLicence(await prisma.licenceState.findUniqueOrThrow({ where: { workspaceId } }));
      },
      async save(s, opts) {
        const date = (v?: string) => (v ? new Date(v) : null);
        const data = {
          keyHash: s.keyHash ?? null,
          answer: s.answer ? json(s.answer) : null,
          lastCheckedAt: date(s.lastCheckedAt),
          lastSuccessAt: date(s.lastSuccessAt),
          lastError: s.lastError ? json(s.lastError) : null,
          activatedAt: date(s.activatedAt),
          deactivatedAt: date(s.deactivatedAt),
          nextCheckAt: date(s.nextCheckAt),
          highWaterAt: date(s.highWaterAt),
          updatedAt: new Date(s.updatedAt),
        };
        if (opts?.ifUpdatedAt !== undefined) {
          // Compare-and-set: nobody (a licence check on another instance) wrote since this state was read.
          const r = await prisma.licenceState.updateMany({ where: { workspaceId, updatedAt: new Date(opts.ifUpdatedAt) }, data });
          return r.count === 1;
        }
        // The instance id is written once (init) and never changed here.
        await prisma.licenceState.upsert({ where: { workspaceId }, create: { ...ws, instanceId: s.instanceId, ...data }, update: data });
        return true;
      },
      async claimCheck({ now, leaseUntil, orLaterThan }) {
        // One UPDATE with the condition in its WHERE: the database row lock makes exactly one caller win.
        const r = await prisma.licenceState.updateMany({
          where: {
            workspaceId,
            OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date(now) } }, ...(orLaterThan ? [{ nextCheckAt: { gt: new Date(orLaterThan) } }] : [])],
          },
          data: { nextCheckAt: new Date(leaseUntil), updatedAt: new Date(now) },
        });
        return r.count === 1;
      },
    },

    assets: {
      async get(id) {
        const a = await prisma.asset.findUnique({ where: { workspaceId_id: { workspaceId, id } } });
        return a ? toAsset(a) : null;
      },
      async insertIfAbsent(a) {
        try {
          await prisma.asset.create({
            data: {
              ...ws,
              id: a.id,
              sha256: a.sha256,
              bytes: BigInt(a.bytes),
              contentType: a.contentType,
              mediaType: a.mediaType,
              storageKey: a.storageKey,
              source: a.source,
              originalName: a.originalName ?? null,
              license: a.license ? json(a.license) : null,
              durationSeconds: a.durationSeconds ?? null,
              metadata: a.metadata ? json(a.metadata) : null,
              createdAt: new Date(a.createdAt),
            },
          });
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
        }
        return toAsset(await prisma.asset.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id: a.id } } }));
      },
      async list() {
        return (await prisma.asset.findMany({ where: ws, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })).map(toAsset);
      },
      async page(req) {
        return (await replica.asset.findMany({ where: { ...ws, ...keyset(req) }, orderBy: NEWEST, take: req.limit })).map(toAsset);
      },
      async update(id, patch) {
        const data = {
          ...('durationSeconds' in patch ? { durationSeconds: patch.durationSeconds ?? null } : {}),
          ...('metadata' in patch ? { metadata: patch.metadata ? json(patch.metadata) : null } : {}),
          ...('license' in patch ? { license: patch.license ? json(patch.license) : null } : {}),
        };
        const r = await prisma.asset.updateMany({ where: { ...ws, id }, data });
        if (!r.count) return null;
        return toAsset(await prisma.asset.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id } } }));
      },
    },

    audit: {
      async write(entry) {
        const e: AuditEntry = { id: newSequentialId('aud'), at: new Date().toISOString(), ...entry, result: entry.result ?? 'success' };
        await prisma.auditLog.create({
          data: {
            ...ws,
            id: e.id,
            at: new Date(e.at),
            actorType: e.actorType,
            actorId: e.actorId ?? null,
            actorName: e.actorName ?? null,
            action: e.action,
            targetType: e.targetType ?? null,
            targetId: e.targetId ?? null,
            result: e.result,
            ip: e.ip ?? null,
            userAgent: e.userAgent ?? null,
            requestId: e.requestId ?? null,
            data: e.data ? json(e.data) : null,
          },
        });
        return e;
      },
      async list(f: AuditFilter = {}) {
        const at: Record<string, Date> = {};
        if (f.from) at.gte = new Date(f.from);
        if (f.to) at.lt = new Date(f.to);
        const where = {
          ...ws,
          ...(f.from || f.to ? { at } : {}),
          ...(f.actorId ? { actorId: f.actorId } : {}),
          ...(f.action ? { action: f.action.endsWith('*') ? { startsWith: f.action.slice(0, -1) } : f.action } : {}),
          ...(f.targetType ? { targetType: f.targetType } : {}),
          ...(f.targetId ? { targetId: f.targetId } : {}),
          ...(f.result ? { result: f.result } : {}),
          ...(f.before
            ? { OR: [{ at: { lt: new Date(f.before.at) } }, { at: new Date(f.before.at), id: { lt: f.before.id } }] }
            : {}),
        };
        const rows = await replica.auditLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: f.limit ?? 100 });
        return rows.map((r) => ({
          id: r.id,
          at: iso(r.at),
          actorType: r.actorType as AuditEntry['actorType'],
          ...(r.actorId !== null ? { actorId: r.actorId } : {}),
          ...(r.actorName !== null ? { actorName: r.actorName } : {}),
          action: r.action,
          ...(r.targetType !== null ? { targetType: r.targetType } : {}),
          ...(r.targetId !== null ? { targetId: r.targetId } : {}),
          result: r.result as AuditEntry['result'],
          ...(r.ip !== null ? { ip: r.ip } : {}),
          ...(r.userAgent !== null ? { userAgent: r.userAgent } : {}),
          ...(r.requestId !== null ? { requestId: r.requestId } : {}),
          ...(r.data !== null ? { data: parse<Record<string, unknown>>(r.data) } : {}),
        }));
      },
      async deleteOlderThan(cutoff) {
        return (await prisma.auditLog.deleteMany({ where: { ...ws, at: { lt: new Date(cutoff) } } })).count;
      },
    },

    idempotency: {
      async begin(r: IdempotencyRecord) {
        try {
          await prisma.idempotencyKey.create({
            data: {
              ...ws,
              actorId: r.actorId,
              key: r.key,
              operation: r.operation,
              requestHash: r.requestHash,
              status: r.status,
              response: r.response === undefined ? null : json(r.response),
              createdAt: new Date(r.createdAt),
              expiresAt: new Date(r.expiresAt),
            },
          });
          return true;
        } catch (e) {
          if (isUniqueViolation(e)) return false;
          throw e;
        }
      },
      async get(actorId, key) {
        const r = await prisma.idempotencyKey.findUnique({ where: { workspaceId_actorId_key: { workspaceId, actorId, key } } });
        if (!r) return null;
        return {
          actorId: r.actorId,
          key: r.key,
          operation: r.operation,
          requestHash: r.requestHash,
          status: r.status as IdempotencyRecord['status'],
          ...(r.response !== null ? { response: parse(r.response) } : {}),
          createdAt: iso(r.createdAt),
          expiresAt: iso(r.expiresAt),
        };
      },
      async complete(actorId, key, response) {
        await prisma.idempotencyKey.updateMany({ where: { ...ws, actorId, key }, data: { status: 'done', response: json(response) } });
      },
      async delete(actorId, key) {
        await prisma.idempotencyKey.deleteMany({ where: { ...ws, actorId, key } });
      },
      async deleteExpired(now) {
        return (await prisma.idempotencyKey.deleteMany({ where: { ...ws, expiresAt: { lt: new Date(now) } } })).count;
      },
    },

    rateLimits: {
      async hit(key, windowStart, by = 1) {
        // One round trip (#196; was UPDATE, then SELECT of the count): see hitSql.
        const at = new Date(windowStart);
        if (kind !== 'mysql') {
          const [row] = (await prisma.$queryRawUnsafe(hitSql, workspaceId, key, at, by)) as Array<{ count: number | bigint }>;
          return Number(row!.count);
        }
        if (opts.insertId) return Number(await opts.insertId(hitSql, [workspaceId, key, at, by, by]));
        return prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(hitSql, workspaceId, key, at, by, by);
          const [row] = (await tx.$queryRawUnsafe('SELECT LAST_INSERT_ID() AS n')) as Array<{ n: number | bigint }>;
          return Number(row!.n);
        }, TX);
      },
      async slide(key, windowStart, previousStart) {
        const at = new Date(windowStart);
        const prev = new Date(previousStart);
        if (kind !== 'mysql') {
          const args = kind === 'postgresql' ? [workspaceId, key, at, prev] : [workspaceId, key, at, workspaceId, key, prev];
          const [row] = (await prisma.$queryRawUnsafe(slideSql, ...args)) as Array<{ count: number | bigint; previous: number | bigint | null }>;
          return { count: Number(row!.count), previous: Number(row!.previous ?? 0) };
        }
        const args = [workspaceId, key, at, workspaceId, key, prev];
        const once = async () =>
          opts.insertId
            ? BigInt(await opts.insertId(slideSql, args))
            : prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(slideSql, ...args);
                const [row] = (await tx.$queryRawUnsafe('SELECT LAST_INSERT_ID() AS n')) as Array<{ n: number | bigint }>;
                return BigInt(row!.n);
              }, TX);
        // Under repeatable read, INSERT ... SELECT share-locks what it reads; when the previous window has no row
        // that is a gap lock, and concurrent first requests of a key can deadlock on it. InnoDB rolls the victim's
        // statement back whole, so it is retried (only then is a check more than one statement), after a short
        // random pause that grows per attempt: retried at once, a burst collides again in lockstep (#423).
        for (let attempt = 1; ; attempt++) {
          try {
            const packed = await once();
            return { count: Number(packed & 0xffffffffn), previous: Number(packed >> 32n) };
          } catch (e) {
            if (attempt >= SLIDE_ATTEMPTS || !isWriteConflict(e)) throw e;
            await new Promise((r) => setTimeout(r, Math.random() * 5 * attempt * attempt));
          }
        }
      },
      async windows(key, since) {
        const rows = await prisma.rateLimitWindow.findMany({ where: { ...ws, key, windowStart: { gte: new Date(since) } }, orderBy: { windowStart: 'asc' }, select: { windowStart: true, count: true } });
        return rows.map((r) => ({ windowStart: iso(r.windowStart), count: r.count }));
      },
      async deleteOlderThan(cutoff, opts = {}) {
        const usage = { key: { startsWith: USAGE_PREFIX } };
        const lock = { key: { startsWith: LOCK_PREFIX } };
        return (await prisma.rateLimitWindow.deleteMany({ where: { ...ws, windowStart: { lt: new Date(cutoff) }, ...(opts.usage ? usage : { NOT: [usage, lock] }) } })).count;
      },
      async reserve(counters) {
        // Make sure every row exists (outside the transaction: a unique violation would abort a PostgreSQL transaction).
        for (const c of counters) {
          try {
            await prisma.rateLimitWindow.create({ data: { ...ws, key: c.key, windowStart: new Date(c.windowStart), count: 0 } });
          } catch (e) {
            if (!isUniqueViolation(e)) throw e;
          }
        }
        const full = new Error('usage counter full');
        let refused: { ok: false; index: number; used: number } | undefined;
        try {
          await prisma.$transaction(async (tx) => {
            for (const [index, c] of counters.entries()) {
              const where = { ...ws, key: c.key, windowStart: new Date(c.windowStart) };
              // One conditional increment: the row lock makes the check and the add atomic across instances.
              const r = await tx.rateLimitWindow.updateMany({ where: { ...where, count: { lt: c.limit } }, data: { count: { increment: 1 } } });
              if (!r.count) {
                const row = await tx.rateLimitWindow.findFirst({ where, select: { count: true } });
                refused = { ok: false, index, used: row?.count ?? 0 };
                throw full; // roll back the counters already incremented
              }
            }
          }, lockingTx);
        } catch (e) {
          if (e === full && refused) return refused;
          throw e;
        }
        return { ok: true };
      },
      async usage(key, windowStart) {
        const row = await prisma.rateLimitWindow.findUnique({ where: { workspaceId_key_windowStart: { workspaceId, key, windowStart: new Date(windowStart) } }, select: { count: true } });
        return row?.count ?? 0;
      },
    },
  };
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/** A deadlock or write conflict the database resolved by rolling the statement back (MySQL 1213; Prisma P2034). */
/** MySQL sliding-window checks: attempts on a write conflict (deadlock) before the error reaches the caller (#423). */
const SLIDE_ATTEMPTS = 8;

function isWriteConflict(e: unknown): boolean {
  const x = e as { code?: unknown; message?: unknown; cause?: { kind?: unknown; originalCode?: unknown } } | null;
  return Boolean(
    x &&
      (x.code === 'P2034' ||
        x.cause?.kind === 'TransactionWriteConflict' ||
        x.cause?.originalCode === '1213' ||
        /TransactionWriteConflict|Deadlock found|write conflict/i.test(String(x.message ?? '')))
  );
}
