import type { Project, Theme } from '@reelforge/project-schema';
import { conflict } from './errors';
import { newId, newSequentialId } from './fsutil';
import { createMemoryWebhookRepository } from './webhooks/memory';
import { pageOf } from './paging';
import { summarizeProject } from './store';
import { isFannedOut, isTerminal, settleChild, stopTree, type SettlementPlan } from './fanout';
import { effectiveRank, estimateWaitSeconds, priorityRank } from './priority';
import { announceClaim, newOutboxId, type ReadySignal } from './dispatch';
import {
  DEFAULT_WORKSPACE_ID,
  runIdOf,
  type ApiKeyPatch,
  type ApiKeyRecord,
  type AssetRecord,
  type AuditEntry,
  type AuditFilter,
  type ChildSettlement,
  type IdempotencyRecord,
  type JobFilter,
  type JobRecord,
  type ProjectMeta,
  type LicenceStateRecord,
  type ProviderSettingInfo,
  type StoredSetting,
  type StoredValue,
  type Repositories,
  type StoredProject,
  type DispatchOutboxRow,
} from './repositories';

const clone = <T>(v: T): T => structuredClone(v);
/** A job row as stored: like a database, the class is always set (unset reads as standard; D-103). */
const asStored = (j: JobRecord): JobRecord => ({ ...clone(j), priority: j.priority ?? 'standard' });

/** Apply an ApiKeyPatch to a record (null clears an optional field). */
export function applyKeyPatch(k: ApiKeyRecord, patch: ApiKeyPatch): ApiKeyRecord {
  const next: ApiKeyRecord = { ...k };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.secret) Object.assign(next, patch.secret);
  if (patch.rotatedAt !== undefined) next.rotatedAt = patch.rotatedAt;
  if (patch.revokedAt !== undefined) next.revokedAt = patch.revokedAt;
  const opt = <K extends 'prev' | 'expiresAt' | 'rateLimitPerMinute' | 'rendersPerDay' | 'rendersPerMonth' | 'ipAllowlist' | 'maxPriority'>(f: K) => {
    const v = patch[f];
    if (v === undefined) return;
    if (v === null) delete next[f];
    else next[f] = v as ApiKeyRecord[K];
  };
  opt('prev');
  opt('expiresAt');
  opt('rateLimitPerMinute');
  opt('rendersPerDay');
  opt('rendersPerMonth');
  opt('ipAllowlist');
  opt('maxPriority');
  return next;
}

/** Whether an audit entry passes a filter (cursor excluded). */
export function auditMatches(e: AuditEntry, f: AuditFilter): boolean {
  if (f.from && e.at < f.from) return false;
  if (f.to && e.at >= f.to) return false;
  if (f.actorId && e.actorId !== f.actorId) return false;
  if (f.action) {
    if (f.action.endsWith('*') ? !e.action.startsWith(f.action.slice(0, -1)) : e.action !== f.action) return false;
  }
  if (f.targetType && e.targetType !== f.targetType) return false;
  if (f.targetId && e.targetId !== f.targetId) return false;
  if (f.result && e.result !== f.result) return false;
  return true;
}
const byNewest = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/**
 * In-memory repositories: same contract as the database ones, nothing on disk.
 * For unit tests and throwaway instances; data is lost when the process ends.
 */
export interface MemoryRepositoryOptions {
  /** Queue dispatch (D-105): tell workers when jobs become claimable (an in-memory bus, or rows in the outbox). */
  readySignal?: ReadySignal;
}

export function createMemoryRepositories(workspaceId = DEFAULT_WORKSPACE_ID, opts: MemoryRepositoryOptions = {}): Repositories {
  const outbox = new Map<string, DispatchOutboxRow>();
  /** Jobs that became claimable: like the database repositories' in-transaction signal, right after the write. */
  const ready = (ids: string[]) => {
    const sig = opts.readySignal;
    if (!sig || !ids.length) return;
    if (sig.kind === 'bus') sig.bus.publish('ready', ids);
    else if (sig.kind === 'outbox') {
      const at = new Date().toISOString();
      for (const jobId of ids) {
        const id = newOutboxId();
        outbox.set(id, { id, jobId, attempts: 0, nextAttemptAt: at, createdAt: at });
      }
    }
  };
  const claimed = (job: JobRecord, now: string) => {
    if (opts.readySignal?.kind === 'bus' && announceClaim(opts.readySignal, job.createdAt, now)) opts.readySignal.bus.publish('claimed', [job.id]);
  };
  const projects = new Map<string, { meta: ProjectMeta; versions: Map<number, Project> }>();
  const keys = new Map<string, ApiKeyRecord>();
  const jobs = new Map<string, JobRecord>();
  const rateWindows = new Map<string, { windowStart: string; count: number }>();
  const holds = (id: string, fence?: { workerId: string; attempts: number }) => {
    const j = jobs.get(id);
    if (!j) return false;
    return !fence || (j.status === 'running' && j.workerId === fence.workerId && (j.attempts ?? 0) === fence.attempts);
  };
  /** A fenced (worker) write keeps the lease, attempts and cancel request: they belong to the heartbeat and other instances. */
  const workerWrite = (job: JobRecord, fence?: { workerId: string; attempts: number }): JobRecord => {
    const next = clone(job);
    // As a database column: a record without a class keeps the stored one.
    next.priority ??= jobs.get(job.id)?.priority ?? 'standard';
    if (!fence) return next;
    const stored = jobs.get(job.id)!;
    for (const k of ['leaseExpiresAt', 'cancelRequestedAt', 'attempts'] as const) {
      if (stored[k] === undefined) delete next[k];
      else (next as unknown as Record<string, unknown>)[k] = stored[k];
    }
    if (next.status !== 'running') delete next.leaseExpiresAt;
    return next;
  };
  const appendLine = (jobId: string, at: string, line: string) => {
    if (!jobs.has(jobId)) return;
    const lines = jobLogs.get(jobId) ?? [];
    lines.push(`${at} ${line}`);
    jobLogs.set(jobId, lines);
  };
  const jobLogs = new Map<string, string[]>();
  /** Apply a fan-out settlement (D-097); synchronous, so atomic like the database transactions. */
  const applyPlan = (plan: SettlementPlan, at: string): ChildSettlement => {
    if (plan.parent) jobs.set(plan.parent.id, clone(plan.parent));
    if (plan.join) {
      jobs.set(plan.join.id, asStored(plan.join));
      ready([plan.join.id]);
    }
    const cancelled: JobRecord[] = [];
    const stop = [...plan.stop];
    for (const c of plan.cancel) {
      if (jobs.get(c.id)?.status === 'queued') {
        jobs.set(c.id, clone(c));
        cancelled.push(clone(c));
      } else stop.push(c.id);
    }
    for (const id of stop) {
      const j = jobs.get(id);
      if (j?.status === 'running') j.cancelRequestedAt ??= at;
    }
    return { parent: plan.parent ? clone(plan.parent) : null, parentFinished: plan.parentFinished, cancelled, join: plan.join ? clone(plan.join) : null };
  };
  const settle = (child: JobRecord, at: string): ChildSettlement => {
    const parent = child.parentId ? (jobs.get(child.parentId) ?? null) : null;
    const siblings = parent ? [...jobs.values()].filter((j) => j.parentId === parent.id) : [];
    return applyPlan(settleChild(child, parent, siblings, at), at);
  };
  const themes = new Map<string, Theme>();
  const settings = new Map<string, { value: StoredValue; info: ProviderSettingInfo }>();
  const runtimeSettings = new Map<string, StoredSetting>();
  const assets = new Map<string, AssetRecord>();
  const audit: AuditEntry[] = [];
  const idempotency = new Map<string, IdempotencyRecord>();
  const idem = (actorId: string, key: string) => `${actorId}\u0000${key}`;
  let licence: LicenceStateRecord | null = null;
  const matchingJobs = (filter: JobFilter) =>
    [...jobs.values()]
      .filter((j) => (!filter.projectId || j.projectId === filter.projectId) && (!filter.parentId || j.parentId === filter.parentId) && (!filter.status || j.status === filter.status) && (!filter.type || j.type === filter.type))
      .sort(byNewest);

  return {
    workspaceId,
    webhooks: createMemoryWebhookRepository(),
    dispatchOutbox: {
      async claim(now, leaseUntil, limit) {
        const due = [...outbox.values()]
          .filter((r) => r.nextAttemptAt <= now && (!r.lockedUntil || r.lockedUntil < now))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit);
        for (const r of due) r.lockedUntil = leaseUntil;
        return due.map((r) => clone(r));
      },
      async remove(ids) {
        for (const id of ids) outbox.delete(id);
      },
      async retry(id, attempts, nextAttemptAt, error) {
        const r = outbox.get(id);
        if (!r) return;
        Object.assign(r, { attempts, nextAttemptAt, lastError: error });
        delete r.lockedUntil;
      },
      async count() {
        return outbox.size;
      },
    },
    projects: {
      async create(p: StoredProject) {
        if (projects.has(p.meta.id)) throw conflict(`project "${p.meta.id}" already exists; use update_project or pick another projectId`);
        projects.set(p.meta.id, { meta: clone(p.meta), versions: new Map([[p.meta.version, clone(p.manifest)]]) });
      },
      async get(id) {
        const p = projects.get(id);
        return p ? { meta: clone(p.meta), manifest: clone(p.versions.get(p.meta.version)!) } : null;
      },
      async getVersion(id, version) {
        const m = projects.get(id)?.versions.get(version);
        return m ? clone(m) : null;
      },
      async listVersions(id) {
        return [...(projects.get(id)?.versions.keys() ?? [])].sort((a, b) => a - b);
      },
      async list() {
        return [...projects.values()]
          .map((p) => ({ meta: clone(p.meta), manifest: clone(p.versions.get(p.meta.version)!) }))
          .sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt) || a.meta.id.localeCompare(b.meta.id));
      },
      async page(req) {
        const all = [...projects.values()].map((p) => summarizeProject(clone(p.meta), p.versions.get(p.meta.version)!)).sort(byNewest);
        return pageOf(all, req);
      },
      async saveVersion(id, expectedVersion, manifest, updatedAt) {
        const p = projects.get(id);
        if (!p || p.meta.version !== expectedVersion) return null;
        p.meta = { ...p.meta, version: expectedVersion + 1, updatedAt };
        p.versions.set(p.meta.version, clone(manifest));
        return clone(p.meta);
      },
      async delete(id) {
        return projects.delete(id);
      },
    },
    keys: {
      async list() {
        return [...keys.values()].map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      },
      async get(id) {
        const k = keys.get(id);
        return k ? clone(k) : null;
      },
      async count() {
        return keys.size;
      },
      async insert(record) {
        if (keys.has(record.id)) throw conflict(`key "${record.id}" already exists`);
        keys.set(record.id, clone(record));
      },
      async update(id, patch) {
        const k = keys.get(id);
        if (!k) return null;
        const next = applyKeyPatch(k, clone(patch));
        keys.set(id, next);
        return clone(next);
      },
      async delete(id) {
        return keys.delete(id);
      },
      async findByPrefix(prefix) {
        return [...keys.values()].filter((k) => k.prefix === prefix || k.prev?.prefix === prefix).map(clone);
      },
      async touch(id, lastUsedAt) {
        const k = keys.get(id);
        if (k) k.lastUsedAt = lastUsedAt;
      },
    },
    jobs: {
      async insert(job) {
        if (jobs.has(job.id)) throw conflict(`job "${job.id}" already exists`);
        jobs.set(job.id, asStored(job));
        if (job.status === 'queued' && job.queue === 'database') ready([job.id]);
      },
      async insertWithQuota(job, _at, quota) {
        const all = [...jobs.values()].filter((j) => quota.types.includes(j.type));
        if (quota.apiKeyId) {
          for (const [i, w] of quota.windows.entries()) {
            const used = all.filter((j) => j.apiKeyId === quota.apiKeyId && j.createdAt >= w.since).length;
            if (used >= w.limit) return { ok: false, window: i, used };
          }
          if (quota.maxActivePerKey !== undefined) {
            const used = all.filter((j) => j.apiKeyId === quota.apiKeyId && (j.status === 'queued' || j.status === 'running')).length;
            if (used >= quota.maxActivePerKey) return { ok: false, cap: 'active_per_key', used };
          }
        }
        if (quota.maxQueuedTotal !== undefined) {
          const used = all.filter((j) => j.status === 'queued').length;
          if (used >= quota.maxQueuedTotal) return { ok: false, cap: 'queued_total', used };
        }
        if (quota.maxEstimatedWait) {
          // Every queued job of the same queue and of this class or higher, whatever its type (units take slots too).
          const rank = priorityRank(job.priority);
          const ahead = [...jobs.values()].filter((j) => j.status === 'queued' && j.queue === job.queue && j.id !== job.id && priorityRank(j.priority) <= rank);
          const oldest = ahead.reduce<string | undefined>((m, j) => (m === undefined || j.createdAt < m ? j.createdAt : m), undefined);
          const w = quota.maxEstimatedWait;
          const est = estimateWaitSeconds({ ahead: ahead.length, oldestQueuedAt: oldest, claimsPerSecond: w.claimsPerSecond, nowMs: Date.parse(w.now) });
          if (est > w.seconds && oldest) return { ok: false, cap: 'estimated_wait', used: ahead.length, oldestQueuedAt: oldest, estimatedWaitSeconds: est };
        }
        if (jobs.has(job.id)) throw conflict(`job "${job.id}" already exists`);
        jobs.set(job.id, asStored(job));
        if (job.status === 'queued' && job.queue === 'database') ready([job.id]);
        return { ok: true };
      },
      async update(job, fence) {
        if (!holds(job.id, fence)) return false;
        jobs.set(job.id, workerWrite(job, fence));
        return true;
      },
      async transition(job, at, fence) {
        if (!holds(job.id, fence)) return false;
        jobs.set(job.id, workerWrite(job, fence));
        if (job.parentId && isTerminal(job.status)) settle(jobs.get(job.id)!, at);
        return true;
      },
      async finishChild(job, at, fence) {
        if (!holds(job.id, fence)) return null;
        jobs.set(job.id, workerWrite(job, fence));
        return settle(jobs.get(job.id)!, at);
      },
      async fanOut(parent, children, _at, fence) {
        const stored = jobs.get(parent.id);
        if (!stored || !holds(parent.id, fence)) return 'lost';
        if (stored.cancelRequestedAt) return 'cancelled';
        const next = workerWrite({ ...parent, status: 'running', pendingChildren: children.length }, fence);
        delete next.workerId;
        delete next.leaseExpiresAt;
        jobs.set(parent.id, next);
        for (const c of children) {
          if (jobs.has(c.id)) throw conflict(`job "${c.id}" already exists`);
          jobs.set(c.id, asStored(c));
        }
        ready(children.filter((c) => c.status === 'queued').map((c) => c.id));
        return 'ok';
      },
      async cancelTree(id, at) {
        const parent = jobs.get(id);
        if (!parent || !isFannedOut(parent)) return null;
        const children = [...jobs.values()].filter((j) => j.parentId === id);
        const r = applyPlan(stopTree(parent, children, 'cancelled', { code: 'cancelled', message: 'cancelled while running' }, at), at);
        return [r.parent!, ...r.cancelled];
      },
      async claim({ workerId, types, now, leaseUntil, maxRunningPerKey, id, priorityAgingSeconds }) {
        const running = new Map<string, number>();
        for (const j of jobs.values()) if (j.status === 'running' && j.queue === 'database' && j.leaseExpiresAt && j.apiKeyId) running.set(j.apiKeyId, (running.get(j.apiKeyId) ?? 0) + 1);
        const next = [...jobs.values()]
          .filter((j) => j.status === 'queued' && j.queue === 'database' && types.includes(j.type) && (id === undefined || j.id === id))
          .filter((j) => maxRunningPerKey === undefined || !j.apiKeyId || (running.get(j.apiKeyId) ?? 0) < maxRunningPerKey)
          // Priority (D-103, batch aged into standard), then fair across keys (D-090): the key with the fewest running
          // jobs first, then the oldest job.
          .map((j) => ({ j, r: effectiveRank(priorityRank(j.priority), Date.parse(j.createdAt), Date.parse(now), priorityAgingSeconds) }))
          .sort(
            (a, b) =>
              a.r - b.r ||
              (running.get(a.j.apiKeyId ?? '') ?? 0) - (running.get(b.j.apiKeyId ?? '') ?? 0) ||
              a.j.createdAt.localeCompare(b.j.createdAt) ||
              a.j.id.localeCompare(b.j.id)
          )[0]?.j;
        if (!next) return null;
        Object.assign(next, { status: 'running', workerId, leaseExpiresAt: leaseUntil, startedAt: now, attempts: (next.attempts ?? 0) + 1, progress: { stage: 'starting', fraction: 0 } });
        claimed(next, now);
        return clone(next);
      },
      async heartbeat(workerId, ids, leaseUntil) {
        const held: string[] = [];
        const cancelRequested: string[] = [];
        for (const id of ids) {
          const j = jobs.get(id);
          if (!j || j.status !== 'running' || j.workerId !== workerId) continue;
          j.leaseExpiresAt = leaseUntil;
          held.push(id);
          if (j.cancelRequestedAt) cancelRequested.push(id);
        }
        return { held, cancelRequested };
      },
      async recoverExpired(now, maxAttempts) {
        const requeued: JobRecord[] = [];
        const failed: JobRecord[] = [];
        const settled: JobRecord[] = [];
        for (const j of [...jobs.values()]) {
          if (j.status !== 'running' || j.queue !== 'database' || !j.leaseExpiresAt || j.leaseExpiresAt >= now) continue;
          const lost = expiredUpdate(j, now, maxAttempts);
          Object.assign(j, lost.patch);
          for (const k of lost.unset) delete (j as unknown as Record<string, unknown>)[k];
          appendLine(j.id, now, lost.line);
          (lost.patch.status === 'queued' ? requeued : failed).push(clone(j));
          if (j.parentId && isTerminal(j.status)) {
            const r = settle(j, now);
            if (r.parentFinished && r.parent) settled.push(r.parent);
            settled.push(...r.cancelled);
          }
        }
        ready(requeued.map((j) => j.id));
        return { requeued, failed, settled };
      },
      async release(id, fence, at) {
        const j = jobs.get(id);
        if (!j || !holds(id, fence)) return false;
        Object.assign(j, { status: 'queued', attempts: Math.max(0, (j.attempts ?? 1) - 1), progress: { stage: 'queued', fraction: 0 } });
        delete j.workerId;
        delete j.leaseExpiresAt;
        delete j.startedAt;
        appendLine(id, at, `released by worker ${fence.workerId} (shutting down); queued again`);
        ready([id]);
        return true;
      },
      async cancelQueued(id, at, error) {
        const j = jobs.get(id);
        if (!j || j.status !== 'queued') return null;
        Object.assign(j, { status: 'cancelled', finishedAt: at, error });
        if (j.parentId) settle(j, at);
        return clone(j);
      },
      async requestCancel(id, at) {
        const j = jobs.get(id);
        if (!j || j.status !== 'running') return false;
        j.cancelRequestedAt ??= at;
        return true;
      },
      async countQueued(before) {
        const rank = priorityRank(before?.priority);
        return [...jobs.values()].filter((j) => {
          if (j.status !== 'queued' || j.queue !== 'database') return false;
          if (!before) return true;
          const r = priorityRank(j.priority);
          return r < rank || (r === rank && (j.createdAt < before.createdAt || (j.createdAt === before.createdAt && j.id < before.id)));
        }).length;
      },
      async get(id) {
        const j = jobs.get(id);
        return j ? clone(j) : null;
      },
      async list(filter = {}) {
        return matchingJobs(filter).map(clone);
      },
      async page(filter, req) {
        return pageOf(matchingJobs(filter), req).map(clone);
      },
      async projectOfRun(runId) {
        for (const j of jobs.values()) if (runIdOf(j) === runId && j.projectId) return j.projectId;
        return null;
      },
      async listUnfinished() {
        return [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').map(clone);
      },
      async countByApiKey(apiKeyId, since, types) {
        return [...jobs.values()].filter((j) => j.apiKeyId === apiKeyId && j.createdAt >= since && types.includes(j.type)).length;
      },
      async appendLog(jobId, at, line) {
        appendLine(jobId, at, line);
      },
      async logs(jobId, tail) {
        const lines = jobLogs.get(jobId) ?? [];
        return tail ? lines.slice(-tail) : [...lines];
      },
    },
    themes: {
      async list() {
        return [...themes.values()].map(clone).sort((a, b) => a.id.localeCompare(b.id));
      },
      async get(id) {
        const t = themes.get(id);
        return t ? clone(t) : null;
      },
      async insert(theme) {
        if (themes.has(theme.id)) throw conflict(`theme "${theme.id}" already exists`);
        themes.set(theme.id, clone(theme));
      },
      async put(theme) {
        themes.set(theme.id, clone(theme));
      },
      async delete(id) {
        return themes.delete(id);
      },
    },
    providerSettings: {
      async values() {
        return Object.fromEntries([...settings].map(([k, v]) => [k, clone(v.value)]));
      },
      async list() {
        return [...settings.values()].map((s) => clone(s.info)).sort((a, b) => a.name.localeCompare(b.name));
      },
      async apply(changes, at, providerId) {
        for (const [name, value] of Object.entries(changes)) {
          if (value === null) settings.delete(name);
          else {
            const keep = providerId ?? settings.get(name)?.info.providerId;
            settings.set(name, { value: clone(value), info: { name, scheme: value.scheme, updatedAt: at, ...(keep ? { providerId: keep } : {}) } });
          }
        }
      },
    },
    settings: {
      async list() {
        return [...runtimeSettings.values()].map(clone).sort((a, b) => a.key.localeCompare(b.key));
      },
      async apply(changes, at, updatedBy) {
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) runtimeSettings.delete(key);
          else runtimeSettings.set(key, { key, value: value.value, scheme: value.scheme, updatedAt: at, ...(updatedBy ? { updatedBy } : {}) });
        }
      },
    },
    licence: {
      async get() {
        return licence ? clone(licence) : null;
      },
      async init(instanceId, at) {
        if (!licence) licence = { instanceId, updatedAt: at };
        return clone(licence);
      },
      async save(state, opts) {
        if (opts?.ifUpdatedAt !== undefined && (!licence || Date.parse(licence.updatedAt) !== Date.parse(opts.ifUpdatedAt))) return false;
        licence = { ...clone(state), instanceId: licence?.instanceId ?? state.instanceId };
        return true;
      },
      async claimCheck({ now, leaseUntil, orLaterThan }) {
        if (!licence) return false;
        const next = licence.nextCheckAt ? Date.parse(licence.nextCheckAt) : undefined;
        if (next !== undefined && next > Date.parse(now) && !(orLaterThan && next > Date.parse(orLaterThan))) return false;
        licence = { ...licence, nextCheckAt: leaseUntil, updatedAt: now };
        return true;
      },
    },
    assets: {
      async get(id) {
        const a = assets.get(id);
        return a ? clone(a) : null;
      },
      async insertIfAbsent(asset) {
        if (!assets.has(asset.id)) assets.set(asset.id, clone(asset));
        return clone(assets.get(asset.id)!);
      },
      async list() {
        return [...assets.values()].sort(byNewest).map(clone);
      },
      async page(req) {
        return pageOf([...assets.values()].sort(byNewest), req).map(clone);
      },
      async update(id, patch) {
        const a = assets.get(id);
        if (!a) return null;
        const next = { ...a, ...clone(patch) };
        assets.set(id, next);
        return clone(next);
      },
    },
    audit: {
      async write(entry) {
        const e: AuditEntry = { id: newSequentialId('aud'), at: new Date().toISOString(), ...clone(entry), result: entry.result ?? 'success' };
        audit.push(e);
        return clone(e);
      },
      async list(f = {}) {
        return audit
          .filter((e) => auditMatches(e, f) && (!f.before || e.at < f.before.at || (e.at === f.before.at && e.id < f.before.id)))
          .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
          .slice(0, f.limit ?? 100)
          .map(clone);
      },
      async deleteOlderThan(cutoff) {
        const keep = audit.filter((e) => e.at >= cutoff);
        const n = audit.length - keep.length;
        audit.splice(0, audit.length, ...keep);
        return n;
      },
    },
    idempotency: {
      async begin(r) {
        if (idempotency.has(idem(r.actorId, r.key))) return false;
        idempotency.set(idem(r.actorId, r.key), clone(r));
        return true;
      },
      async get(actorId, key) {
        const r = idempotency.get(idem(actorId, key));
        return r ? clone(r) : null;
      },
      async complete(actorId, key, response) {
        const r = idempotency.get(idem(actorId, key));
        if (r) idempotency.set(idem(actorId, key), { ...r, status: 'done', response: clone(response) });
      },
      async delete(actorId, key) {
        idempotency.delete(idem(actorId, key));
      },
      async deleteExpired(now) {
        let n = 0;
        for (const [k, r] of idempotency) {
          if (r.expiresAt < now) {
            idempotency.delete(k);
            n++;
          }
        }
        return n;
      },
    },
    rateLimits: {
      async hit(key, windowStart, by = 1) {
        const k = `${key}\n${windowStart}`;
        const n = (rateWindows.get(k)?.count ?? 0) + by;
        rateWindows.set(k, { windowStart, count: n });
        return n;
      },
      async windows(key, since) {
        return [...rateWindows.entries()]
          .filter(([k, w]) => k === `${key}\n${w.windowStart}` && w.windowStart >= since)
          .map(([, w]) => ({ windowStart: w.windowStart, count: w.count }))
          .sort((a, b) => a.windowStart.localeCompare(b.windowStart));
      },
      async deleteOlderThan(cutoff, opts = {}) {
        let n = 0;
        for (const [k, w] of rateWindows) {
          if (w.windowStart < cutoff && k.startsWith('usage:') === Boolean(opts.usage)) {
            rateWindows.delete(k);
            n++;
          }
        }
        return n;
      },
      async reserve(counters) {
        for (const [index, c] of counters.entries()) {
          const used = rateWindows.get(`${c.key}\n${c.windowStart}`)?.count ?? 0;
          if (used >= c.limit) return { ok: false, index, used };
        }
        for (const c of counters) {
          const k = `${c.key}\n${c.windowStart}`;
          rateWindows.set(k, { windowStart: c.windowStart, count: (rateWindows.get(k)?.count ?? 0) + 1 });
        }
        return { ok: true };
      },
      async usage(key, windowStart) {
        return rateWindows.get(`${key}\n${windowStart}`)?.count ?? 0;
      },
    },
  };
}

/**
 * What happens to a running database-queue job whose lease ended: queued
 * again, or failed after `maxAttempts` claims. Shared by every repository.
 */
export function expiredUpdate(j: JobRecord, now: string, maxAttempts: number): { patch: Partial<JobRecord>; unset: Array<keyof JobRecord>; line: string } {
  const attempts = j.attempts ?? 1;
  const who = j.workerId ? `worker ${j.workerId}` : 'its worker';
  if (attempts < maxAttempts) {
    return {
      patch: { status: 'queued', progress: { stage: 'queued', fraction: 0 } },
      unset: ['workerId', 'leaseExpiresAt', 'startedAt', 'cancelRequestedAt'],
      line: `lease expired: ${who} stopped renewing it (crashed, killed or lost the database); queued again (attempt ${attempts} of ${maxAttempts} used)`,
    };
  }
  return {
    patch: {
      status: 'failed',
      finishedAt: now,
      error: {
        code: 'lease_expired',
        message: `the worker running this job stopped renewing its lease ${attempts} time(s) (crashed, killed, out of memory or lost the database); giving up after queue.maxAttempts = ${maxAttempts}. Check the workers' logs and memory limits, then retry_job`,
      },
    },
    unset: ['leaseExpiresAt'],
    line: `lease expired: ${who} stopped renewing it; failed after ${attempts} attempt(s) (queue.maxAttempts = ${maxAttempts})`,
  };
}
