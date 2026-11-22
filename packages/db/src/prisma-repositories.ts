import type { Project, Theme } from '@reelforge/project-schema';
import {
  conflict,
  expiredUpdate,
  newId,
  newSequentialId,
  type ApiKeyPatch,
  type ApiKeyRecord,
  type AssetRecord,
  type AuditEntry,
  type AuditFilter,
  type IdempotencyRecord,
  type JobLeaseFence,
  type JobRecord,
  type LicenceStateRecord,
  type ProjectMeta,
  type Repositories,
  type Scope,
  type StoredProject,
} from '@reelforge/core';
// One client type for all three databases: the generated clients share the
// same model API (only the SQL dialect differs), so the repositories are
// written once against the SQLite client's types.
import type { PrismaClient } from './generated/sqlite/client';
import type { DatabaseKind } from './url';
import { createPrismaWebhookRepository } from './webhook-repository';

export type AnyPrismaClient = PrismaClient;
type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

const iso = (d: Date) => d.toISOString();
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(s: string): T => JSON.parse(s) as T;
const TX = { maxWait: 10_000, timeout: 30_000 };
/** Usage counters (D-091) share RateLimitWindow with the request windows; their keys start with this. */
const USAGE_PREFIX = 'usage:';

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

/** Repositories for one workspace on any of the Prisma-supported databases. */
export function createPrismaRepositories(prisma: PrismaClient, workspaceId: string, kind: DatabaseKind = 'sqlite'): Repositories {
  const ws = { workspaceId };
  // Raw SQL (the queue's row locks): identifier quoting and placeholders differ per database.
  const qi = (n: string) => (kind === 'mysql' ? `\`${n}\`` : `"${n}"`);
  const ph = (i: number) => (kind === 'postgresql' ? `$${i}` : '?');
  // Read committed: a statement after a row lock sees what the previous holder committed (PostgreSQL's default; MySQL's is repeatable read).
  // (Typed against the SQLite client, which only knows Serializable; the PostgreSQL/MySQL clients take ReadCommitted.)
  const lockingTx = (kind === 'sqlite' ? TX : { ...TX, isolationLevel: 'ReadCommitted' }) as typeof TX;
  const fenceWhere = (f: JobLeaseFence) => ({ workerId: f.workerId, attempts: f.attempts, status: 'running' });

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
  });
  const statusEvent = (jobId: string, at: string, status: string) => ({ ...ws, jobId, at: new Date(at), type: 'status', message: status });
  const logEvent = (jobId: string, at: string, line: string) => ({ ...ws, jobId, at: new Date(at), type: 'log', message: line });

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
          ? ` AND ("apiKeyId" IS NULL OR (SELECT COUNT(*) FROM "Job" "r" WHERE "r"."workspaceId" = "Job"."workspaceId" AND "r"."queue" = 'database' AND "r"."status" = 'running' AND "r"."apiKeyId" = "Job"."apiKeyId") < ?)`
          : '';
        const rows: Array<{ id: string }> = await tx.$queryRawUnsafe(
          `UPDATE "Job" SET "status" = 'running', "workerId" = ? WHERE ${where}${cap} RETURNING "id"`,
          o.workerId,
          ...args,
          ...(capped ? [o.maxRunningPerKey] : [])
        );
        id = rows[0]?.id;
      } else {
        const rows: Array<{ id: string; k: string | null }> = await tx.$queryRawUnsafe(
          `SELECT ${qi('id')}, ${qi('apiKeyId')} AS ${qi('k')} FROM ${qi('Job')} WHERE ${where} FOR UPDATE SKIP LOCKED`,
          ...args
        );
        const one = rows[0];
        if (one && one.k && capped && (await tx.job.count({ where: { ...ws, queue: 'database', status: 'running', apiKeyId: one.k } })) >= o.maxRunningPerKey!) return null;
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
      return toJob(row);
    }, lockingTx);

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
  const latest = { versions: { orderBy: { version: 'desc' as const }, take: 1, select: { manifest: true } } };

  return {
    webhooks: createPrismaWebhookRepository(prisma, workspaceId),
    workspaceId,

    projects: {
      async create({ meta, manifest }) {
        try {
          await prisma.$transaction([
            prisma.project.create({
              data: { ...ws, id: meta.id, version: meta.version, title: manifest.title, createdAt: new Date(meta.createdAt), updatedAt: new Date(meta.updatedAt) },
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
        const rows = await prisma.projectVersion.findMany({ where: { ...ws, projectId: id }, select: { version: true }, orderBy: { version: 'asc' } });
        return rows.map((r) => r.version);
      },
      async list() {
        const rows = await prisma.project.findMany({ where: ws, include: latest, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] });
        return rows.filter((p) => p.versions.length).map(toProject);
      },
      async saveVersion(id, expectedVersion, manifest, updatedAt): Promise<ProjectMeta | null> {
        const at = new Date(updatedAt);
        return prisma.$transaction(async (tx: Tx) => {
          const r = await tx.project.updateMany({
            where: { ...ws, id, version: expectedVersion },
            data: { version: expectedVersion + 1, title: manifest.title, updatedAt: at },
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
          ]);
        } catch (e) {
          if (isUniqueViolation(e)) throw conflict(`job "${job.id}" already exists`);
          throw e;
        }
      },
      async insertWithQuota(job, at, quota) {
        return prisma.$transaction(async (tx) => {
          // Lock first (a no-op update): PostgreSQL/MySQL row lock, SQLite write lock. With a total
          // queue cap the workspace row (every start waits here), else only the key's row (starts
          // for this key wait). Either way the counts below are final (D-078, D-090).
          if (quota.maxQueuedTotal !== undefined) {
            await tx.$executeRawUnsafe(`UPDATE ${qi('Workspace')} SET ${qi('id')} = ${qi('id')} WHERE ${qi('id')} = ${ph(1)}`, workspaceId);
          } else if (quota.apiKeyId) {
            await tx.$executeRawUnsafe(`UPDATE ${qi('ApiKey')} SET ${qi('id')} = ${qi('id')} WHERE ${qi('id')} = ${ph(1)}`, quota.apiKeyId);
          }
          if (quota.apiKeyId) {
            for (const [i, w] of quota.windows.entries()) {
              const used = await tx.job.count({ where: { ...ws, apiKeyId: quota.apiKeyId, createdAt: { gte: new Date(w.since) }, type: { in: quota.types } } });
              if (used >= w.limit) return { ok: false as const, window: i, used };
            }
            if (quota.maxActivePerKey !== undefined) {
              const used = await tx.job.count({ where: { ...ws, apiKeyId: quota.apiKeyId, status: { in: ['queued', 'running'] }, type: { in: quota.types } } });
              if (used >= quota.maxActivePerKey) return { ok: false as const, cap: 'active_per_key' as const, used };
            }
          }
          if (quota.maxQueuedTotal !== undefined) {
            const used = await tx.job.count({ where: { ...ws, status: 'queued', type: { in: quota.types } } });
            if (used >= quota.maxQueuedTotal) return { ok: false as const, cap: 'queued_total' as const, used };
          }
          try {
            await tx.job.create({ data: { ...ws, id: job.id, ...jobData(job) } });
          } catch (e) {
            if (isUniqueViolation(e)) throw conflict(`job "${job.id}" already exists`);
            throw e;
          }
          await tx.jobEvent.create({ data: statusEvent(job.id, at, job.status) });
          return { ok: true as const };
        }, lockingTx);
      },
      async update(job, fence) {
        if (!fence) return (await prisma.job.updateMany({ where: { ...ws, id: job.id }, data: jobData(job) })).count > 0;
        return (await prisma.job.updateMany({ where: { ...ws, id: job.id, ...fenceWhere(fence) }, data: workerJobData(job) })).count > 0;
      },
      async transition(job, at, fence) {
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
      async claim({ workerId, types, now, leaseUntil, maxRunningPerKey, id: only }) {
        if (!types.length) return null;
        if (only !== undefined) return claimOne({ workerId, types, now, leaseUntil, maxRunningPerKey, id: only });
        return prisma.$transaction(async (tx) => {
          // Fair across API keys (D-090): the queued job whose key has the fewest running database-queue jobs,
          // oldest first among equals (jobs without a key count as a key with none running). Optionally only
          // keys below a running cap. Placeholders start at `first`: workspace id (running counts), workspace id,
          // the types, then the cap.
          const capped = maxRunningPerKey !== undefined;
          const j = qi('j');
          const running =
            `LEFT JOIN (SELECT ${qi('apiKeyId')}, COUNT(*) AS ${qi('n')} FROM ${qi('Job')} WHERE ${qi('workspaceId')} = PH0` +
            ` AND ${qi('queue')} = 'database' AND ${qi('status')} = 'running' AND ${qi('apiKeyId')} IS NOT NULL GROUP BY ${qi('apiKeyId')}) ${qi('r')}` +
            ` ON ${qi('r')}.${qi('apiKeyId')} = ${j}.${qi('apiKeyId')}`;
          const pick = (first: number) =>
            (`SELECT ${j}.${qi('id')} FROM ${qi('Job')} ${j} ${running}` +
              ` WHERE ${j}.${qi('workspaceId')} = ${ph(first + 1)} AND ${j}.${qi('queue')} = 'database' AND ${j}.${qi('status')} = 'queued'` +
              ` AND ${j}.${qi('type')} IN (${types.map((_, i) => ph(first + 2 + i)).join(', ')})` +
              (capped ? ` AND COALESCE(${qi('r')}.${qi('n')}, 0) < ${ph(first + 2 + types.length)}` : '') +
              ` ORDER BY COALESCE(${qi('r')}.${qi('n')}, 0), ${j}.${qi('createdAt')}, ${j}.${qi('id')} LIMIT 1`).replace('PH0', ph(first));
          const args = [workspaceId, workspaceId, ...types, ...(capped ? [maxRunningPerKey] : [])];
          let rows: Array<{ id: string }> = [];
          if (kind === 'sqlite') {
            // One statement under the write lock (the first write of the transaction waits for it): atomic, no lost claims.
            rows = await tx.$queryRawUnsafe(`UPDATE "Job" SET "status" = 'running', "workerId" = ? WHERE "id" = (${pick(2)}) AND "status" = 'queued' RETURNING "id"`, workerId, ...args);
          } else {
            // Row locks: a locking read with a sort over every queued row would lock all of them on MySQL, so
            // decide the key order with plain reads first, then lock one job of the best key with an
            // index-ordered SELECT ... FOR UPDATE SKIP LOCKED (a job another worker is claiming is skipped).
            const typeIn = (first: number) => `${qi('type')} IN (${types.map((_, i) => ph(first + i)).join(', ')})`;
            const runningRows: Array<{ k: string; n: unknown }> = await tx.$queryRawUnsafe(
              `SELECT ${qi('apiKeyId')} AS ${qi('k')}, COUNT(*) AS ${qi('n')} FROM ${qi('Job')} WHERE ${qi('workspaceId')} = ${ph(1)} AND ${qi('queue')} = 'database' AND ${qi('status')} = 'running' AND ${qi('apiKeyId')} IS NOT NULL GROUP BY ${qi('apiKeyId')}`,
              workspaceId
            );
            const busy = new Map(runningRows.map((r) => [r.k, Number(r.n)]));
            const queuedRows: Array<{ k: string | null; t: unknown }> = await tx.$queryRawUnsafe(
              `SELECT ${qi('apiKeyId')} AS ${qi('k')}, MIN(${qi('createdAt')}) AS ${qi('t')} FROM ${qi('Job')} WHERE ${qi('workspaceId')} = ${ph(1)} AND ${qi('queue')} = 'database' AND ${qi('status')} = 'queued' AND ${typeIn(2)} GROUP BY ${qi('apiKeyId')}`,
              workspaceId,
              ...types
            );
            const order = queuedRows
              .map((r) => ({ k: r.k, n: r.k ? (busy.get(r.k) ?? 0) : 0, t: new Date(r.t as string).getTime() }))
              .filter((r) => !capped || r.k === null || r.n < maxRunningPerKey!)
              .sort((a, b) => a.n - b.n || a.t - b.t);
            for (const c of order) {
              const keyWhere = c.k === null ? `${qi('apiKeyId')} IS NULL` : `${qi('apiKeyId')} = ${ph(2 + types.length)}`;
              rows = await tx.$queryRawUnsafe(
                `SELECT ${qi('id')} FROM ${qi('Job')} WHERE ${qi('workspaceId')} = ${ph(1)} AND ${qi('queue')} = 'database' AND ${qi('status')} = 'queued' AND ${typeIn(2)} AND ${keyWhere}` +
                  ` ORDER BY ${qi('createdAt')}, ${qi('id')} LIMIT 1 FOR UPDATE SKIP LOCKED`,
                workspaceId,
                ...types,
                ...(c.k === null ? [] : [c.k])
              );
              if (rows.length) break;
            }
          }
          const id = rows[0]?.id;
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
          return toJob(row);
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
        const rows = await prisma.job.findMany({ where: { ...ws, queue: 'database', status: 'running', leaseExpiresAt: { lt: new Date(now) } }, orderBy: { leaseExpiresAt: 'asc' }, take: 100 });
        for (const r of rows) {
          const job = toJob(r);
          const u = expiredUpdate(job, now, maxAttempts);
          const next: JobRecord = { ...job, ...u.patch };
          for (const k of u.unset) delete (next as unknown as Record<string, unknown>)[k];
          const done = await prisma.$transaction(async (tx) => {
            // Only if nobody renewed or recovered it since we read it.
            const res = await tx.job.updateMany({ where: { ...ws, id: r.id, status: 'running', leaseExpiresAt: r.leaseExpiresAt }, data: jobData(next) });
            if (!res.count) return false;
            await tx.jobEvent.create({ data: logEvent(r.id, now, u.line) });
            await tx.jobEvent.create({ data: statusEvent(r.id, now, next.status) });
            return true;
          }, TX);
          if (done) (next.status === 'queued' ? requeued : failed).push(next);
        }
        return { requeued, failed };
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
          return true;
        }, TX);
      },
      async cancelQueued(id, at, error) {
        return prisma.$transaction(async (tx) => {
          const r = await tx.job.updateMany({ where: { ...ws, id, status: 'queued' }, data: { status: 'cancelled', finishedAt: new Date(at), error: json(error) } });
          if (!r.count) return null;
          await tx.jobEvent.create({ data: statusEvent(id, at, 'cancelled') });
          const row = await tx.job.findFirst({ where: { ...ws, id } });
          return row ? toJob(row) : null;
        }, TX);
      },
      async requestCancel(id, at) {
        const r = await prisma.job.updateMany({ where: { ...ws, id, status: 'running', cancelRequestedAt: null }, data: { cancelRequestedAt: new Date(at) } });
        if (r.count) return true;
        return (await prisma.job.count({ where: { ...ws, id, status: 'running' } })) > 0;
      },
      async countQueued(before) {
        const ahead = before ? { OR: [{ createdAt: { lt: new Date(before.createdAt) } }, { createdAt: new Date(before.createdAt), id: { lt: before.id } }] } : {};
        return prisma.job.count({ where: { ...ws, queue: 'database', status: 'queued', ...ahead } });
      },
      async get(id) {
        const r = await prisma.job.findFirst({ where: { ...ws, id } });
        return r ? toJob(r) : null;
      },
      async list(filter = {}) {
        const rows = await prisma.job.findMany({
          where: { ...ws, ...(filter.projectId ? { projectId: filter.projectId } : {}), ...(filter.status ? { status: filter.status } : {}), ...(filter.type ? { type: filter.type } : {}) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        return rows.map(toJob);
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
        return (await prisma.theme.findMany({ where: ws, orderBy: { id: 'asc' } })).map((t) => parse<Theme>(t.definition));
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
      async save(s) {
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
        // The instance id is written once (init) and never changed here.
        await prisma.licenceState.upsert({ where: { workspaceId }, create: { ...ws, instanceId: s.instanceId, ...data }, update: data });
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
        const rows = await prisma.auditLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: f.limit ?? 100 });
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
      async hit(key, windowStart) {
        const at = new Date(windowStart);
        for (let i = 0; ; i++) {
          // Atomic increment of an existing window; the first request of a window creates it.
          const r = await prisma.rateLimitWindow.updateMany({ where: { ...ws, key, windowStart: at }, data: { count: { increment: 1 } } });
          if (!r.count) {
            try {
              await prisma.rateLimitWindow.create({ data: { ...ws, key, windowStart: at, count: 1 } });
              return 1;
            } catch (e) {
              if (!isUniqueViolation(e) || i >= 3) throw e; // another instance created it first: increment that row
              continue;
            }
          }
          const row = await prisma.rateLimitWindow.findUnique({ where: { workspaceId_key_windowStart: { workspaceId, key, windowStart: at } }, select: { count: true } });
          return row?.count ?? 1;
        }
      },
      async deleteOlderThan(cutoff, opts = {}) {
        const usage = { key: { startsWith: USAGE_PREFIX } };
        return (await prisma.rateLimitWindow.deleteMany({ where: { ...ws, windowStart: { lt: new Date(cutoff) }, ...(opts.usage ? usage : { NOT: usage }) } })).count;
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
