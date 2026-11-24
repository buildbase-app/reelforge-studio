import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, badRequest, notFound } from './errors';
import { KeyedMutex } from './fsutil';
import { quotaWindows, type KeyStore, type PublicKey } from './keys';
import { DEFAULT_WORKSPACE_ID, SCOPES, type AuditEntryInput, type Scope, type WorkspaceLimits, type WorkspaceRecord } from './repositories';
import type { RuntimeConfig } from './config/runtime';
import type { StorageManager } from './storage/manager';
import { WORKSPACE_ID, currentWorkspaceId, runInWorkspace, workspaceKeyPrefix, type WorkspaceRouter } from './workspace';

/** Who did it (audit log). */
interface Actor {
  actorType: 'api_key' | 'cli' | 'system';
  actorId?: string;
}

const LIMIT_KEYS = ['rendersPerDay', 'rendersPerMonth', 'rateLimitPerMinute', 'storageBytes'] as const;
const LIMIT_MAX: Record<(typeof LIMIT_KEYS)[number], number> = { rendersPerDay: 1_000_000, rendersPerMonth: 10_000_000, rateLimitPerMinute: 1_000_000, storageBytes: 1e15 };
/** Job types that count against render limits (the same as the per-key render quotas). */
export const WORKSPACE_RENDER_TYPES = ['render', 'preview'];
const USAGE_TTL_MS = 60_000;

/** Validate `limits` (create/update_workspace): whole numbers; null (or 0) clears one; null for all clears them. */
export function parseWorkspaceLimits(v: unknown): WorkspaceLimits | null {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest(`limits must be an object with ${LIMIT_KEYS.join(', ')} (whole numbers; 0 or null: unlimited), or null`);
  const out: WorkspaceLimits = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(k)) throw badRequest(`unknown limit "${k}"; use ${LIMIT_KEYS.join(', ')}`);
    if (n === null || n === 0) continue;
    const max = LIMIT_MAX[k as (typeof LIMIT_KEYS)[number]];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) throw badRequest(`limits.${k} must be a whole number from 0 to ${max}, or null`);
    out[k as (typeof LIMIT_KEYS)[number]] = n;
  }
  return out;
}

export interface WorkspaceAdminDeps {
  repos: WorkspaceRouter;
  keys: KeyStore;
  settings: RuntimeConfig;
  storage: StorageManager;
  dataDir: string;
  audit: (entry: AuditEntryInput) => Promise<unknown>;
  now: () => number;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
}

/** The public view of a workspace: its record, the limits in force and where each comes from. */
export interface WorkspaceView extends WorkspaceRecord {
  /** The limits in force: the workspace's own, else workspaces.* defaults; absent: unlimited. */
  effectiveLimits: WorkspaceLimits;
}

/**
 * Workspace management (#304, D-1XX): what the owner tools do (create, list, rename, change limits, suspend,
 * delete with a grace period, restore) plus the per-workspace limits the service enforces. Every action is audited
 * in the owner's workspace and in the workspace it changed.
 */
export class WorkspaceAdmin {
  private readonly usage = new Map<string, { at: number; bytes: number }>();
  private readonly mutex = new KeyedMutex();

  constructor(private readonly d: WorkspaceAdminDeps) {}

  private nowIso() {
    return new Date(this.d.now()).toISOString();
  }

  /** The limits in force for a workspace: its own, else the workspaces.* defaults (0: unlimited). */
  effectiveLimits(w: Pick<WorkspaceRecord, 'limits'> | null): WorkspaceLimits {
    const def = this.d.settings.current.config.workspaces;
    const out: WorkspaceLimits = {};
    for (const k of LIMIT_KEYS) {
      const v = w?.limits?.[k] ?? def[k];
      if (v && v > 0) out[k] = v;
    }
    return out;
  }

  view(w: WorkspaceRecord): WorkspaceView {
    return { ...w, effectiveLimits: this.effectiveLimits(w) };
  }

  private async record(id: string): Promise<WorkspaceRecord> {
    const w = await this.d.repos.workspaces.get(id);
    if (!w) throw notFound('workspace', id);
    return w;
  }

  /** Audit in the owner's workspace and, when it is another one, in the workspace changed. */
  private async audit(actor: Actor | undefined, action: string, id: string, data: Record<string, unknown>) {
    const entry: AuditEntryInput = { actorType: actor?.actorType ?? 'system', ...(actor?.actorId ? { actorId: actor.actorId } : {}), action, targetType: 'workspace', targetId: id, data };
    await this.d.audit(entry);
    if (id !== currentWorkspaceId() && (await this.d.repos.workspaces.get(id))) await runInWorkspace(id, () => this.d.audit(entry));
  }

  async list(): Promise<{ workspaces: WorkspaceView[] }> {
    return { workspaces: (await this.d.repos.workspaces.list()).map((w) => this.view(w)) };
  }

  /** The caller's own workspace with its limits and usage (get_workspace, any key). */
  async current(): Promise<WorkspaceView & { usage: { rendersToday: number; rendersThisMonth: number; storageBytes: number | null } }> {
    const id = currentWorkspaceId();
    const w = (await this.d.repos.workspaces.get(id)) ?? { id, name: 'Default', status: 'active' as const, createdAt: new Date(0).toISOString() };
    const q = quotaWindows(this.d.now());
    const [rendersToday, rendersThisMonth] = await Promise.all([
      this.d.repos.jobs.countSince(q.dayStart, WORKSPACE_RENDER_TYPES),
      this.d.repos.jobs.countSince(q.monthStart, WORKSPACE_RENDER_TYPES),
    ]);
    const storageBytes = await this.storageBytes(true).catch(() => null);
    return { ...this.view(w), usage: { rendersToday, rendersThisMonth, storageBytes } };
  }

  async create(
    input: { id?: unknown; name?: unknown; limits?: unknown; adminKey?: unknown },
    actor?: Actor
  ): Promise<{ workspace: WorkspaceView; key?: string; keyRecord?: PublicKey }> {
    const id = input.id;
    if (typeof id !== 'string' || !WORKSPACE_ID.test(id)) throw badRequest('id must be 1-40 lowercase letters, digits and hyphens, starting and ending with a letter or digit (e.g. "acme" or "team-video")');
    const name = input.name === undefined ? id : input.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw badRequest('name must be 1-120 characters');
    const limits = input.limits === undefined ? null : parseWorkspaceLimits(input.limits);
    // The optional first admin key, checked before anything is created.
    let keySpec: { name: string; scopes: Scope[] } | null = null;
    if (input.adminKey !== undefined && input.adminKey !== false) {
      const spec = (input.adminKey === true ? {} : input.adminKey) as { name?: unknown; scopes?: unknown };
      if (typeof spec !== 'object' || spec === null) throw badRequest('adminKey must be true or { name, scopes? }');
      const scopes = (Array.isArray(spec.scopes) ? spec.scopes : ['admin']) as Scope[];
      if (!scopes.length || scopes.includes('owner') || scopes.some((x) => !SCOPES.includes(x))) throw badRequest('adminKey.scopes: read, write, render and admin (owner keys live in the default workspace)');
      if (spec.name !== undefined && (typeof spec.name !== 'string' || !spec.name || spec.name.length > 80)) throw badRequest('adminKey.name must be 1-80 characters');
      keySpec = { name: typeof spec.name === 'string' ? spec.name : `${id} admin`.slice(0, 80), scopes };
    }
    const at = this.nowIso();
    const record: WorkspaceRecord = { id, name: name.trim(), status: 'active', createdAt: at, updatedAt: at, ...(limits && Object.keys(limits).length ? { limits } : {}) };
    if (!(await this.d.repos.workspaces.create(record))) {
      const existing = await this.d.repos.workspaces.get(id);
      throw new ApiError('conflict', 409, `workspace "${id}" exists${existing?.status === 'deleted' ? ' (deleted; restore_workspace brings it back, or wait for the purge)' : ''}`);
    }
    this.d.repos.invalidateWorkspaces();
    await this.audit(actor, 'workspace.create', id, { name: record.name, ...(record.limits ? { limits: record.limits } : {}) });
    if (!keySpec) return { workspace: this.view(record) };
    const created = await runInWorkspace(id, () => this.d.keys.create(keySpec!.name, keySpec!.scopes, {}, actor));
    return { workspace: this.view(record), key: created.key, keyRecord: created.record };
  }

  /** Rename, change limits, suspend or resume. */
  async update(id: string, input: { name?: unknown; limits?: unknown; suspended?: unknown }, actor?: Actor): Promise<WorkspaceView> {
    const current = await this.record(id);
    if (current.status === 'deleted') throw new ApiError('conflict', 409, `workspace "${id}" is deleted; restore_workspace first`);
    const at = this.nowIso();
    const patch: Parameters<WorkspaceRouter['workspaces']['update']>[1] = { updatedAt: at };
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw badRequest('name must be 1-120 characters');
      patch.name = input.name.trim();
    }
    if (input.limits !== undefined) {
      const l = parseWorkspaceLimits(input.limits);
      patch.limits = l && Object.keys(l).length ? l : null;
    }
    if (input.suspended !== undefined) {
      if (typeof input.suspended !== 'boolean') throw badRequest('suspended must be true or false');
      if (input.suspended && id === DEFAULT_WORKSPACE_ID) throw new ApiError('conflict', 409, 'the default workspace holds the owner keys and cannot be suspended');
      patch.status = input.suspended ? 'suspended' : 'active';
      patch.suspendedAt = input.suspended ? at : null;
    }
    if (Object.keys(patch).length === 1) throw badRequest('nothing to change: send name, limits or suspended');
    const updated = await this.d.repos.workspaces.update(id, patch);
    if (!updated) throw notFound('workspace', id);
    this.d.repos.invalidateWorkspaces();
    const { updatedAt: _u, ...changed } = patch;
    await this.audit(actor, input.suspended === true ? 'workspace.suspend' : input.suspended === false ? 'workspace.resume' : 'workspace.update', id, { changed });
    return this.view(updated);
  }

  /** Soft delete: keys stop working and jobs stop being claimed at once; rows and files go after the grace period. */
  async delete(id: string, actor?: Actor): Promise<WorkspaceView> {
    if (id === DEFAULT_WORKSPACE_ID) throw new ApiError('conflict', 409, 'the default workspace cannot be deleted');
    const current = await this.record(id);
    if (current.status === 'deleted') return this.view(current);
    const days = this.d.settings.current.config.workspaces.deleteGraceDays;
    const at = this.d.now();
    const updated = await this.d.repos.workspaces.update(id, { status: 'deleted', deletedAt: new Date(at).toISOString(), purgeAfter: new Date(at + days * 86_400_000).toISOString(), updatedAt: new Date(at).toISOString() });
    this.d.repos.invalidateWorkspaces();
    await this.audit(actor, 'workspace.delete', id, { graceDays: days, purgeAfter: updated?.purgeAfter });
    return this.view(updated!);
  }

  async restore(id: string, actor?: Actor): Promise<WorkspaceView> {
    const current = await this.record(id);
    if (current.status !== 'deleted') throw new ApiError('conflict', 409, `workspace "${id}" is not deleted (status ${current.status})`);
    const updated = await this.d.repos.workspaces.update(id, { status: 'active', deletedAt: null, purgeAfter: null, suspendedAt: null, updatedAt: this.nowIso() });
    this.d.repos.invalidateWorkspaces();
    await this.audit(actor, 'workspace.restore', id, {});
    return this.view(updated!);
  }

  /** Hourly sweep: purge deleted workspaces whose grace period is over (rows by cascade, then files). */
  async purgeExpired(): Promise<string[]> {
    const now = this.d.now();
    const due = (await this.d.repos.workspaces.list()).filter((w) => w.status === 'deleted' && w.id !== DEFAULT_WORKSPACE_ID && w.purgeAfter && Date.parse(w.purgeAfter) <= now);
    const purged: string[] = [];
    for (const w of due) {
      try {
        const objects = await this.d.storage.purgeWorkspace(w.id);
        await rm(join(this.d.dataDir, workspaceKeyPrefix(w.id)), { recursive: true, force: true });
        await this.d.repos.workspaces.purge(w.id);
        this.d.repos.invalidateWorkspaces();
        purged.push(w.id);
        await runInWorkspace(DEFAULT_WORKSPACE_ID, () => this.d.audit({ actorType: 'system', action: 'workspace.purge', targetType: 'workspace', targetId: w.id, data: { name: w.name, deletedAt: w.deletedAt, objects } }));
      } catch (e) {
        this.d.log?.('warn', `workspace purge of ${w.id} failed (it is tried again at the next sweep): ${(e as Error).message}`);
      }
    }
    return purged;
  }

  // ---- limits ------------------------------------------------------------------------------------------------

  private async limitsHere(): Promise<WorkspaceLimits> {
    return this.effectiveLimits(await this.d.repos.workspace(currentWorkspaceId()));
  }

  /** The workspace's request limit per minute, if any (the server checks it after the key's own). */
  async rateLimitOf(id: string): Promise<number | undefined> {
    return this.effectiveLimits(await this.d.repos.workspace(id)).rateLimitPerMinute;
  }

  /**
   * Start a render or preview within the workspace's renders per day / month. Checked under a lock per workspace on
   * this instance, so parallel calls here cannot overshoot; several api instances may pass it by a few at once.
   */
  async withRenderLimit<T>(start: () => Promise<T>): Promise<T> {
    const l = await this.limitsHere();
    if (!l.rendersPerDay && !l.rendersPerMonth) return start();
    const ws = currentWorkspaceId();
    return this.mutex.run(`renders:${ws}`, async () => {
      const q = quotaWindows(this.d.now());
      for (const [limit, since, until, name] of [
        [l.rendersPerDay, q.dayStart, q.dayEnd, 'rendersPerDay'],
        [l.rendersPerMonth, q.monthStart, q.monthEnd, 'rendersPerMonth'],
      ] as const) {
        if (!limit) continue;
        const used = await this.d.repos.jobs.countSince(since, WORKSPACE_RENDER_TYPES);
        if (used >= limit) {
          const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(until) - this.d.now()) / 1000));
          throw new ApiError('workspace_quota_exceeded', 429, `this workspace may start ${limit} renders and previews per ${name === 'rendersPerDay' ? 'UTC day' : 'month (UTC)'}; ${used} used. It resets at ${until}; the instance owner can raise limits.${name}.`, {
            limit: `workspace.limits.${name}`,
            max: limit,
            used,
            resetsAt: until,
            retryAfterSeconds,
          });
        }
      }
      return start();
    });
  }

  /** Bytes the caller's workspace stores, measured at most a minute ago (`fresh`: now). */
  async storageBytes(fresh = false): Promise<number> {
    const ws = currentWorkspaceId();
    const hit = this.usage.get(ws);
    if (!fresh && hit && this.d.now() - hit.at < USAGE_TTL_MS) return hit.bytes;
    const bytes = await this.d.storage.workspaceBytes();
    this.usage.set(ws, { at: this.d.now(), bytes });
    return bytes;
  }

  /** Refuse an upload or a render (507 storage_limit_exceeded) when the workspace is at its storage limit. */
  async checkStorage(adding = 0): Promise<void> {
    const max = (await this.limitsHere()).storageBytes;
    if (!max) return;
    const used = await this.storageBytes();
    if (used + adding >= max) {
      throw new ApiError('storage_limit_exceeded', 507, `this workspace stores ${used} bytes of its ${max} (limits.storageBytes); delete projects or renders, or ask the instance owner to raise the limit`, {
        limit: 'workspace.limits.storageBytes',
        max,
        used,
      });
    }
  }
}
