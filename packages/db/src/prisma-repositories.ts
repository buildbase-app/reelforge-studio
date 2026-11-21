import type { Project, Theme } from '@reelforge/project-schema';
import {
  conflict,
  newId,
  newSequentialId,
  type ApiKeyPatch,
  type ApiKeyRecord,
  type AssetRecord,
  type AuditEntry,
  type AuditFilter,
  type IdempotencyRecord,
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

export type AnyPrismaClient = PrismaClient;
type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

const iso = (d: Date) => d.toISOString();
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(s: string): T => JSON.parse(s) as T;
const TX = { maxWait: 10_000, timeout: 30_000 };

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
export function createPrismaRepositories(prisma: PrismaClient, workspaceId: string): Repositories {
  const ws = { workspaceId };

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
  });
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
  });

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
      async update(job) {
        await prisma.job.updateMany({ where: { ...ws, id: job.id }, data: jobData(job) });
      },
      async transition(job, at) {
        await prisma.$transaction([
          prisma.job.updateMany({ where: { ...ws, id: job.id }, data: jobData(job) }),
          prisma.jobEvent.create({ data: { ...ws, jobId: job.id, at: new Date(at), type: 'status', message: job.status } }),
        ]);
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
  };
}
