import { AsyncLocalStorage } from 'node:async_hooks';
import { currentRequest } from './audit';
import {
  DEFAULT_WORKSPACE_ID,
  type ApiKeyRecord,
  type AuditEntry,
  type AuditRepository,
  type ChildSettlement,
  type DispatchOutboxRepository,
  type IdempotencyRepository,
  type JobRecord,
  type JobRepository,
  type Repositories,
  type WorkspaceRecord,
} from './repositories';
import type { WebhookDeliveryRecord, WebhookRepository } from './webhooks/types';

/**
 * Workspaces (#304, D-124): every project, version, render, asset, theme, job, key, webhook, audit entry and
 * idempotency key belongs to one workspace, and a caller only ever sees its own.
 *
 * Which workspace a call is in comes from the call itself, never from its arguments:
 *   1. `runInWorkspace(id, fn)`: background work done for a workspace (a job, a webhook delivery, a sweep);
 *   2. otherwise the authenticated API key of the request (`currentRequest().auth.workspaceId`);
 *   3. otherwise none ("system"): the CLI, start-up and instance-level work, which use the default workspace.
 *
 * The service gets a routing `Repositories` (createWorkspaceRouter) that resolves the bound bundle of that
 * workspace on every call. Instance-level state (runtime settings, provider settings, the licence, rate-limit
 * windows, instance leases) always lives in the default workspace. Cross-workspace work (the job queue claim,
 * heartbeats, lease recovery, the webhook and dispatch outboxes, retention sweeps, key lookup) is explicit here.
 */

const SYSTEM = Symbol('system');
const scope = new AsyncLocalStorage<string | typeof SYSTEM>();

/** Run `fn` in workspace `id` (background work done for that workspace). */
export function runInWorkspace<T>(id: string | undefined, fn: () => T): T {
  return scope.run(id ?? DEFAULT_WORKSPACE_ID, fn);
}

/**
 * Run `fn` outside any workspace, even when called from a request: loops and timers started here must not
 * inherit the workspace of the request that happened to wake them.
 */
export function runAsSystem<T>(fn: () => T): T {
  return scope.run(SYSTEM, fn);
}

/** The workspace of this call, or undefined in system context. */
export function contextWorkspaceId(): string | undefined {
  const s = scope.getStore();
  if (s === SYSTEM) return undefined;
  if (typeof s === 'string') return s;
  return currentRequest()?.auth?.workspaceId;
}

/** The workspace of this call; the default workspace in system context. */
export function currentWorkspaceId(): string {
  return contextWorkspaceId() ?? DEFAULT_WORKSPACE_ID;
}

/** Workspace ids: lowercase letters, digits and hyphens, 1-40 characters, starting and ending with a letter or digit. */
export const WORKSPACE_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Where a workspace's files live in the storage driver (and under the data directory): the default workspace keeps
 * the layout of earlier versions (`assets/`, `projects/`), every other one is under `workspaces/<id>/`.
 */
export function workspaceKeyPrefix(id: string): string {
  return id === DEFAULT_WORKSPACE_ID ? '' : `${WORKSPACES_PREFIX}${id}/`;
}
export const WORKSPACES_PREFIX = 'workspaces/';

export interface WorkspaceRouterOptions {
  /** The bundle bound to one workspace (Database.repositories, createMemoryRepositories). Called often: cache it. */
  bind: (workspaceId: string) => Repositories;
  /** How long the list of workspaces is reused by cross-workspace work. Default 5 s. */
  listTtlMs?: number;
  now?: () => number;
}

/** A routing bundle (createWorkspaceRouter) plus what the service needs for cross-workspace work. */
export interface WorkspaceRouter extends Repositories {
  readonly routing: true;
  /** The bundle bound to one workspace, whatever the context. */
  forWorkspace(id: string): Repositories;
  /** Ids of the workspaces that exist (not purged); `active` leaves out suspended and deleted ones. */
  workspaceIds(opts?: { active?: boolean }): Promise<string[]>;
  /** The workspace's record (cached like workspaceIds). */
  workspace(id: string): Promise<WorkspaceRecord | null>;
  /** Forget the cached list (a workspace was created, suspended or deleted on this instance). */
  invalidateWorkspaces(): void;
}

export function isWorkspaceRouter(r: Repositories): r is WorkspaceRouter {
  return (r as Partial<WorkspaceRouter>).routing === true;
}

/** Most entries the job -> workspace memo keeps (jobs this instance claimed, inserted or read in system context). */
const JOB_MEMO_MAX = 10_000;

/**
 * A `Repositories` whose every call goes to the bundle of the caller's workspace (see the module comment), with the
 * instance-level repositories on the default workspace and the cross-workspace operations spelled out.
 */
export function createWorkspaceRouter(opts: WorkspaceRouterOptions): WorkspaceRouter {
  const bind = opts.bind;
  const now = opts.now ?? Date.now;
  const ttl = opts.listTtlMs ?? 5000;
  const instance = () => bind(DEFAULT_WORKSPACE_ID);
  const here = () => bind(currentWorkspaceId());

  let cache: { at: number; list: WorkspaceRecord[] } | null = null;
  const records = async (): Promise<WorkspaceRecord[]> => {
    if (cache && now() - cache.at < ttl) return cache.list;
    const list = await instance().workspaces.list();
    if (!list.some((w) => w.id === DEFAULT_WORKSPACE_ID)) list.unshift({ id: DEFAULT_WORKSPACE_ID, name: 'Default', status: 'active', createdAt: new Date(0).toISOString() });
    cache = { at: now(), list };
    return list;
  };
  const workspaceIds = async (o: { active?: boolean } = {}) => (await records()).filter((w) => !o.active || w.status === 'active').map((w) => w.id);

  // ---- jobs --------------------------------------------------------------------------------------------------
  const jobWs = new Map<string, string>();
  const remember = (id: string, ws: string) => {
    if (jobWs.size >= JOB_MEMO_MAX && !jobWs.has(id)) jobWs.delete(jobWs.keys().next().value!);
    jobWs.set(id, ws);
  };
  const tagJob = <T extends JobRecord | null | undefined>(ws: string, j: T): T => {
    if (j) {
      j.workspaceId = ws;
      remember(j.id, ws);
    }
    return j;
  };
  const tagJobs = (ws: string, js: JobRecord[]) => {
    for (const j of js) tagJob(ws, j);
    return js;
  };
  /** The workspace a job call goes to: the job's own, else the caller's, else (system context) where the id lives. */
  const jobWorkspace = async (id: string | undefined, job?: JobRecord): Promise<string> => {
    const ws = job?.workspaceId ?? contextWorkspaceId();
    if (ws) return ws;
    if (id === undefined) return DEFAULT_WORKSPACE_ID;
    const known = jobWs.get(id);
    if (known) return known;
    for (const w of await workspaceIds()) {
      if (await bind(w).jobs.get(id)) {
        remember(id, w);
        return w;
      }
    }
    return DEFAULT_WORKSPACE_ID;
  };
  const byId =
    <A extends [string, ...unknown[]], R>(call: (r: JobRepository, ...a: A) => Promise<R>, tag?: (ws: string, r: R) => R) =>
    async (...a: A): Promise<R> => {
      const ws = await jobWorkspace(a[0]);
      const r = await call(bind(ws).jobs, ...a);
      return tag ? tag(ws, r) : r;
    };
  const byJob =
    <A extends unknown[], R>(call: (r: JobRepository, job: JobRecord, ...a: A) => Promise<R>) =>
    async (job: JobRecord, ...rest: A): Promise<R> => {
      const ws = await jobWorkspace(job.id, job);
      job.workspaceId = ws;
      remember(job.id, ws);
      return call(bind(ws).jobs, job, ...rest);
    };
  const tagSettlement = (ws: string, s: ChildSettlement | null): ChildSettlement | null => {
    if (!s) return s;
    tagJob(ws, s.parent);
    tagJob(ws, s.join);
    tagJobs(ws, s.cancelled);
    return s;
  };
  /** Claims take turns between workspaces (fairness per workspace); priority and per-key fairness apply inside one. */
  let lastServed: string | undefined;
  const jobs: JobRepository = {
    insert: byJob((r, job, at: string) => r.insert(job, at)),
    insertWithQuota: byJob((r, job, at: string, quota: Parameters<JobRepository['insertWithQuota']>[2]) => r.insertWithQuota(job, at, quota)),
    update: byJob((r, job, fence?: Parameters<JobRepository['update']>[1]) => r.update(job, fence)),
    transition: byJob((r, job, at: string, fence?: Parameters<JobRepository['transition']>[2]) => r.transition(job, at, fence)),
    finishChild: async (job, at, fence) => {
      const ws = await jobWorkspace(job.id, job);
      return tagSettlement(ws, await bind(ws).jobs.finishChild(job, at, fence));
    },
    fanOut: async (parent, children, at, fence) => {
      const ws = await jobWorkspace(parent.id, parent);
      for (const c of children) tagJob(ws, c);
      return bind(ws).jobs.fanOut(parent, children, at, fence);
    },
    cancelTree: byId((r, id: string, at: string) => r.cancelTree(id, at), (ws, js) => (js ? tagJobs(ws, js) : js)),
    get: byId((r, id: string) => r.get(id), tagJob),
    list: async (filter) => tagJobs(currentWorkspaceId(), await here().jobs.list(filter)),
    page: async (filter, req) => tagJobs(currentWorkspaceId(), await here().jobs.page(filter, req)),
    projectOfRun: (runId) => here().jobs.projectOfRun(runId),
    listUnfinished: async () => (await Promise.all((await workspaceIds()).map(async (ws) => tagJobs(ws, await bind(ws).jobs.listUnfinished())))).flat(),
    claim: async (o) => {
      const candidates = o.id !== undefined ? [await jobWorkspace(o.id)] : await workspaceIds({ active: true });
      const active = new Set(await workspaceIds({ active: true }));
      const ids = candidates.filter((w) => active.has(w));
      if (!ids.length) return null;
      // Start after the workspace served last, so every workspace with queued work gets its turn.
      const start = (ids.indexOf(lastServed ?? '') + 1) % ids.length;
      for (let i = 0; i < ids.length; i++) {
        const ws = ids[(start + i) % ids.length]!;
        const job = await bind(ws).jobs.claim(o);
        if (job) {
          if (o.id === undefined) lastServed = ws;
          return tagJob(ws, job);
        }
      }
      return null;
    },
    heartbeat: async (workerId, ids, leaseUntil) => {
      const groups = new Map<string, string[]>();
      const unknown: string[] = [];
      for (const id of ids) {
        const ws = jobWs.get(id);
        if (ws) groups.set(ws, [...(groups.get(ws) ?? []), id]);
        else unknown.push(id);
      }
      if (unknown.length) for (const ws of await workspaceIds()) groups.set(ws, [...(groups.get(ws) ?? []), ...unknown]);
      const out = { held: [] as string[], cancelRequested: [] as string[] };
      for (const [ws, list] of groups) {
        const r = await bind(ws).jobs.heartbeat(workerId, list, leaseUntil);
        for (const id of r.held) remember(id, ws);
        out.held.push(...r.held);
        out.cancelRequested.push(...r.cancelRequested);
      }
      return out;
    },
    recoverExpired: async (at, maxAttempts) => {
      const out: Awaited<ReturnType<JobRepository['recoverExpired']>> = { requeued: [], failed: [], settled: [] };
      for (const ws of await workspaceIds()) {
        const r = await bind(ws).jobs.recoverExpired(at, maxAttempts);
        out.requeued.push(...tagJobs(ws, r.requeued));
        out.failed.push(...tagJobs(ws, r.failed));
        out.settled!.push(...tagJobs(ws, r.settled ?? []));
      }
      return out;
    },
    release: byId((r, id: string, fence: Parameters<JobRepository['release']>[1], at: string) => r.release(id, fence, at)),
    // The housekeeping lease and its published count are instance-level.
    takeLease: (...a) => instance().jobs.takeLease(...a),
    readLease: (...a) => instance().jobs.readLease(...a),
    releaseLease: (...a) => instance().jobs.releaseLease(...a),
    cancelQueued: byId((r, id: string, at: string, error: { code: string; message: string }) => r.cancelQueued(id, at, error), tagJob),
    requestCancel: byId((r, id: string, at: string) => r.requestCancel(id, at)),
    countQueued: async (before) => {
      // A job's place in its own workspace's queue; without `before`, every queued job of the install.
      if (before) return here().jobs.countQueued(before);
      const counts = await Promise.all((await workspaceIds()).map((ws) => bind(ws).jobs.countQueued()));
      return counts.reduce((a, b) => a + b, 0);
    },
    countByApiKey: (...a) => here().jobs.countByApiKey(...a),
    countSince: (...a) => here().jobs.countSince(...a),
    appendLog: byId((r, id: string, at: string, line: string) => r.appendLog(id, at, line)),
    logs: byId((r, id: string, tail?: number) => r.logs(id, tail)),
  };

  // ---- keys: found across workspaces by prefix (authentication), everything else in the caller's workspace ----
  const keys = route((r) => r.keys, here, {
    findByPrefix: async (prefix: string): Promise<ApiKeyRecord[]> => {
      const out: ApiKeyRecord[] = [];
      for (const ws of await workspaceIds()) for (const k of await bind(ws).keys.findByPrefix(prefix)) out.push({ ...k, workspaceId: ws });
      return out;
    },
  });

  // ---- audit and idempotency: retention sweeps cover every workspace ----------------------------------------
  const audit = route<AuditRepository>((r) => r.audit, here, {
    deleteOlderThan: async (cutoff) => sum(await workspaceIds(), (ws) => bind(ws).audit.deleteOlderThan(cutoff)),
  });
  const idempotency = route<IdempotencyRepository>((r) => r.idempotency, here, {
    deleteExpired: async (at) => sum(await workspaceIds(), (ws) => bind(ws).idempotency.deleteExpired(at)),
  });

  // ---- webhooks: the outbox worker claims across workspaces and sends each delivery in its own --------------
  const tagDeliveries = (ws: string, ds: WebhookDeliveryRecord[]) => ds.map((d) => ({ ...d, workspaceId: ws }));
  const webhooks = route<WebhookRepository>((r) => r.webhooks, here, {
    claim: async (at, leaseUntil, limit) => {
      const out: WebhookDeliveryRecord[] = [];
      for (const ws of await workspaceIds()) {
        if (out.length >= limit) break;
        out.push(...tagDeliveries(ws, await bind(ws).webhooks.claim(at, leaseUntil, limit - out.length)));
      }
      return out;
    },
    release: async (ids, at) => {
      for (const ws of await workspaceIds()) await bind(ws).webhooks.release(ids, at);
    },
    deleteFinishedBefore: async (cutoff) => sum(await workspaceIds(), (ws) => bind(ws).webhooks.deleteFinishedBefore(cutoff)),
  });

  // ---- queue dispatch outbox: one relay for the install --------------------------------------------------------
  const outboxWs = new Map<string, string>();
  const dispatchOutbox: DispatchOutboxRepository = {
    claim: async (at, leaseUntil, limit) => {
      const out: Awaited<ReturnType<DispatchOutboxRepository['claim']>> = [];
      for (const ws of await workspaceIds()) {
        if (out.length >= limit) break;
        for (const row of await bind(ws).dispatchOutbox.claim(at, leaseUntil, limit - out.length)) {
          outboxWs.set(row.id, ws);
          out.push({ ...row, workspaceId: ws });
        }
      }
      return out;
    },
    remove: async (ids) => {
      const groups = new Map<string, string[]>();
      for (const id of ids) {
        const ws = outboxWs.get(id) ?? DEFAULT_WORKSPACE_ID;
        groups.set(ws, [...(groups.get(ws) ?? []), id]);
        outboxWs.delete(id);
      }
      for (const [ws, list] of groups) await bind(ws).dispatchOutbox.remove(list);
    },
    retry: async (id, attempts, nextAttemptAt, error) => {
      const ws = outboxWs.get(id) ?? DEFAULT_WORKSPACE_ID;
      outboxWs.delete(id);
      await bind(ws).dispatchOutbox.retry(id, attempts, nextAttemptAt, error);
    },
    count: async () => sum(await workspaceIds(), (ws) => bind(ws).dispatchOutbox.count()),
  };

  const router: WorkspaceRouter = {
    routing: true,
    get workspaceId() {
      return currentWorkspaceId();
    },
    get workspaces() {
      return instance().workspaces;
    },
    projects: route((r) => r.projects, here, {}),
    keys,
    jobs,
    themes: route((r) => r.themes, here, {}),
    // Instance-level: one set for the install.
    get providerSettings() {
      return instance().providerSettings;
    },
    get settings() {
      return instance().settings;
    },
    get licence() {
      return instance().licence;
    },
    get rateLimits() {
      return instance().rateLimits;
    },
    assets: route((r) => r.assets, here, {}),
    audit,
    idempotency,
    webhooks,
    dispatchOutbox,
    forWorkspace: bind,
    workspaceIds,
    workspace: async (id) => (await records()).find((w) => w.id === id) ?? null,
    invalidateWorkspaces: () => {
      cache = null;
    },
  };
  return router;
}

async function sum(ids: string[], fn: (ws: string) => Promise<number>): Promise<number> {
  let n = 0;
  for (const ws of ids) n += await fn(ws);
  return n;
}

/**
 * A repository whose methods resolve their target on every call; `overrides` replace single methods. Plain own
 * properties (not a Proxy), so tests can spy on them like on the bound repositories.
 */
function route<T extends object>(pick: (r: Repositories) => T, resolve: () => Repositories, overrides: Partial<T>): T {
  const sample = pick(resolve()) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(sample)) {
    if (typeof sample[key] !== 'function') continue;
    out[key] = (...a: unknown[]) => {
      const target = pick(resolve()) as Record<string, (...x: unknown[]) => unknown>;
      return target[key]!(...a);
    };
  }
  return Object.assign(out, overrides) as T;
}

/** Merge newest-first audit pages of several workspaces into one page (keyset on at, id). */
export function mergeAuditPages(pages: Array<{ workspaceId: string; entries: AuditEntry[] }>, limit: number): AuditEntry[] {
  const all = pages.flatMap((p) => p.entries.map((e) => ({ ...e, workspaceId: p.workspaceId })));
  all.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1));
  return all.slice(0, limit);
}
