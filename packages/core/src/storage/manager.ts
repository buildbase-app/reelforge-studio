import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config/schema';
import type { RuntimeConfig } from '../config/runtime';
import type { StorageDriver } from '../plugins';
import type { StorageFactory } from './factory';
import { DEFAULT_WORKSPACE_ID } from '../repositories';
import { framesCacheDir } from '../frames';
import { currentWorkspaceId, runInWorkspace, workspaceKeyPrefix } from '../workspace';
import { ASSETS_PREFIX, RENDER_MANIFEST, checkKey, checkPrefix, mapLimit, renderPrefix } from './keys';
import { scopeDriver } from './scoped';
import { RenderStore, type StoredRun } from './renders';

export type RetentionPolicy = Pick<Config['storage']['retention'], 'renderDays' | 'keepLastRendersPerProject' | 'tempHours' | 'cacheDays'>;

export interface CleanupReport {
  dryRun: boolean;
  policy: RetentionPolicy;
  startedAt: string;
  durationMs: number;
  /** Renders deleted (or, in a dry run, that would be). `workspaceId` outside the default workspace (#304). */
  renders: Array<{ workspaceId?: string; projectId: string; renderId: string; createdAt: string; objects: number; bytes: number; reason: 'older_than_renderDays' | 'older_than_workspace_retention' | 'beyond_keepLastRendersPerProject' }>;
  /** Unfinished uploads (`.tmp-<runId>/`) and incomplete render directories older than tempHours. */
  temp: Array<{ workspaceId?: string; projectId: string; runId: string; createdAt: string; objects: number; bytes: number }>;
  /** Local staging directories of renders for remote storage, older than tempHours. */
  staging: Array<{ path: string; bytes: number }>;
  /** Local copies of remote files unused for cacheDays. */
  cache: { files: number; bytes: number };
  totals: { renders: number; objects: number; bytes: number };
  errors: string[];
}

export interface StorageManagerOptions {
  factory: StorageFactory;
  settings: RuntimeConfig;
  dataDir: string;
  cacheDir: string;
  /** Run ids of renders that are queued or running (never cleaned up). */
  activeRunIds: () => Promise<Set<string>>;
  /** A workspace's own, stricter retention (#487); the instance policy is the ceiling. */
  workspaceRetention?: (workspaceId: string) => Promise<{ maxAgeHours?: number; keepLast?: number } | undefined>;
  /**
   * Workspaces whose files the sweep, cleanup and usage cover (#304); unset: only the caller's. Each one's files
   * are under its own key prefix (workspaceKeyPrefix), which `driver` applies for the workspace of the call.
   */
  workspaces?: () => Promise<string[]>;
  /** Called after every scheduled sweep that removed something (audit log). */
  onSweep?: (report: CleanupReport) => Promise<void>;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
  now?: () => number;
}

const DAY = 24 * 3600 * 1000;

async function duFiles(dir: string, olderThan?: number): Promise<Array<{ path: string; bytes: number; mtimeMs: number }>> {
  const out: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await duFiles(full, olderThan)));
    else if (e.isFile()) {
      const s = await stat(full).catch(() => null);
      if (s && (olderThan === undefined || s.mtimeMs < olderThan)) out.push({ path: full, bytes: s.size, mtimeMs: s.mtimeMs });
    }
  }
  return out;
}

/**
 * The storage driver in use, local copies of remote files, usage, retention
 * and the scheduled sweep (D-065..D-068).
 */
export class StorageManager {
  readonly renders: RenderStore;
  /** Local copies of remote objects (engines and FFmpeg need files). */
  readonly cacheRoot: string;
  /** Where renders for remote storage are produced before the commit. */
  readonly stagingRoot: string;
  private current: StorageDriver | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<CleanupReport> | null = null;
  private lastSweep: { at: string; deletedObjects: number; freedBytes: number; error?: string } | null = null;

  constructor(private readonly opts: StorageManagerOptions) {
    this.renders = new RenderStore(() => this.driver);
    this.cacheRoot = join(opts.cacheDir, 'storage');
    this.stagingRoot = join(opts.cacheDir, 'render-staging');
  }

  /**
   * The driver, seen from the caller's workspace (#304): every key is under that workspace's prefix
   * (`workspaces/<id>/` outside the default workspace), so one workspace cannot name another's objects.
   */
  get driver(): StorageDriver {
    return scopeDriver(this.rootDriver, workspaceKeyPrefix(currentWorkspaceId()));
  }

  /** The driver without a workspace prefix (health, migration between drivers, purging a workspace). */
  get rootDriver(): StorageDriver {
    if (!this.current) throw new Error('storage is not initialised');
    return this.current;
  }

  /**
   * Delete one finished render or preview (delete_render, #312): its objects (manifest first, so it stops being a
   * render at once), the local copies this instance cached of them, and on local storage its empty folder.
   */
  async deleteRender(run: StoredRun): Promise<void> {
    const prefix = renderPrefix(run.projectId, run.runId);
    const dir = this.driver.localPath(prefix + RENDER_MANIFEST);
    await this.renders.deleteRun(run);
    if (dir) await rm(dirname(dir), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(this.cacheRoot, checkPrefix(workspaceKeyPrefix(currentWorkspaceId()) + prefix)), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Delete every object of a workspace (purge, #304). Never the default workspace. Returns how many. */
  async purgeWorkspace(id: string): Promise<number> {
    const prefix = workspaceKeyPrefix(id);
    if (!prefix) throw new Error('the default workspace is never purged');
    const objects = await this.rootDriver.list(prefix);
    await mapLimit(objects, 8, (o) => this.rootDriver.delete(o.key));
    await rm(join(this.cacheRoot, prefix), { recursive: true, force: true }).catch(() => undefined);
    return objects.length;
  }

  private async eachWorkspace<T>(fn: (ws: string) => Promise<T>): Promise<Array<{ ws: string; value: T }>> {
    const ids = (await this.opts.workspaces?.()) ?? [currentWorkspaceId()];
    const out: Array<{ ws: string; value: T }> = [];
    for (const ws of ids) out.push({ ws, value: await runInWorkspace(ws, () => fn(ws)) });
    return out;
  }

  /** True when files live on this machine (renders are renamed into place, no copies needed). */
  get isLocal(): boolean {
    return this.driver.localPath(ASSETS_PREFIX + 'x') !== null;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  async init(): Promise<void> {
    this.current = await this.opts.factory(this.opts.settings.config.storage, { dataDir: this.opts.dataDir });
  }

  /** Build the driver again (credentials changed at runtime); operations in flight finish on the old one. */
  async reload(): Promise<void> {
    this.current = await this.opts.factory(this.opts.settings.config.storage, { dataDir: this.opts.dataDir });
  }

  get downloads(): Config['storage']['downloads'] {
    return this.opts.settings.config.storage.downloads;
  }

  /** A signed URL from the bucket, when configured and possible; null means "serve through this server". */
  async bucketUrl(key: string, ttlSeconds: number, opts: { filename?: string; contentType?: string } = {}): Promise<string | null> {
    if (this.downloads === 'proxy') return null;
    try {
      return await this.driver.signedUrl(key, ttlSeconds, opts);
    } catch (e) {
      this.opts.log?.('warn', `storage: the ${this.driver.id} driver could not sign a download URL (${(e as Error).message}); serving through the server`);
      return null;
    }
  }

  /**
   * A local file with the object's bytes: the file itself on local storage,
   * else a cached copy under <cacheDir>/storage (downloaded once, refreshed
   * when the size differs, its mtime marks the last use for cleanup).
   */
  async localFile(key: string, expectedBytes?: number): Promise<string> {
    const direct = this.driver.localPath(key);
    if (direct) return direct;
    const file = join(this.cacheRoot, checkKey(workspaceKeyPrefix(currentWorkspaceId()) + key));
    const s = await stat(file).catch(() => null);
    if (s && (expectedBytes === undefined || s.size === expectedBytes)) {
      const t = new Date(this.now());
      await utimes(file, t, t).catch(() => undefined);
      return file;
    }
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.part`;
    try {
      await pipeline(await this.driver.get(key), createWriteStream(tmp));
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return file;
  }

  policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
    const r = this.opts.settings.config.storage.retention;
    return {
      renderDays: overrides.renderDays ?? r.renderDays,
      keepLastRendersPerProject: overrides.keepLastRendersPerProject ?? r.keepLastRendersPerProject,
      tempHours: overrides.tempHours ?? r.tempHours,
      cacheDays: overrides.cacheDays ?? r.cacheDays,
    };
  }

  /** Bytes of assets and renders of the caller's workspace (storage limits, #304). */
  async workspaceBytes(): Promise<number> {
    return (await this.workspaceUsage()).totalBytes;
  }

  /** Renders and assets of the caller's workspace only, under its own prefix (analytics, storage limits; #304). */
  async workspaceUsage(): Promise<{ totalBytes: number; renders: { count: number; bytes: number }; assets: { objects: number; bytes: number } }> {
    const [runs, assets] = await Promise.all([this.renders.listAllRuns(), this.driver.list(ASSETS_PREFIX)]);
    const sum = (xs: Array<{ bytes: number }>) => xs.reduce((n, x) => n + x.bytes, 0);
    const complete = runs.filter((r) => r.complete);
    return { totalBytes: sum(assets) + sum(runs), renders: { count: complete.length, bytes: sum(complete) }, assets: { objects: assets.length, bytes: sum(assets) } };
  }

  async usage() {
    const per = await this.eachWorkspace(async () => ({ runs: await this.renders.listAllRuns(), assets: await this.driver.list(ASSETS_PREFIX) }));
    const runs = per.flatMap((p) => p.value.runs);
    const assets = per.flatMap((p) => p.value.assets);
    const complete = runs.filter((r) => r.complete);
    const temp = runs.filter((r) => !r.complete);
    const cache = await duFiles(this.cacheRoot);
    const staging = await duFiles(this.stagingRoot);
    const sum = (xs: Array<{ bytes: number }>) => xs.reduce((n, x) => n + x.bytes, 0);
    return {
      assets: { objects: assets.length, bytes: sum(assets) },
      renders: { count: complete.length, objects: complete.reduce((n, r) => n + r.objects, 0), bytes: sum(complete) },
      temp: { objects: temp.reduce((n, r) => n + r.objects, 0), bytes: sum(temp) },
      localCache: { files: cache.length, bytes: sum(cache) },
      localStaging: { files: staging.length, bytes: sum(staging) },
      totalBytes: sum(assets) + sum(runs),
      ...(per.length > 1 ? { workspaces: Object.fromEntries(per.map((p) => [p.ws, { bytes: sum(p.value.assets) + sum(p.value.runs) }])) } : {}),
    };
  }

  /** get_storage: the driver, where the bytes go, health, usage, retention and the sweep. */
  async status() {
    const d = this.driver;
    const started = this.now();
    const health = await d.health();
    let usage: Awaited<ReturnType<StorageManager['usage']>> | null = null;
    let usageError: string | undefined;
    try {
      usage = await this.usage();
    } catch (e) {
      usageError = (e as Error).message;
    }
    const cfg = this.opts.settings.config.storage;
    return {
      driver: d.id,
      location: d.describe(),
      downloads: { mode: cfg.downloads, effective: cfg.downloads === 'proxy' || d.id === 'local' ? 'server' : 'bucket' },
      health: { ...health, checkedAt: new Date(started).toISOString(), latencyMs: this.now() - started },
      usage,
      ...(usageError ? { usageError } : {}),
      retention: { ...this.policy(), sweepIntervalMinutes: cfg.retention.sweepIntervalMinutes },
      lastSweep: this.lastSweep,
    };
  }

  /**
   * Apply the retention policy (D-068). A render is kept when it is among
   * the newest keepLastRendersPerProject of its project or belongs to a queued
   * or running job; otherwise it is deleted when it is older than renderDays,
   * or (renderDays 0, keepLast set) simply because it is beyond the newest N.
   * Also removes unfinished uploads, stale staging directories and unused
   * cached copies. dryRun reports without deleting.
   */
  async cleanup(opts: { dryRun?: boolean; overrides?: Partial<RetentionPolicy> } = {}): Promise<CleanupReport> {
    // One cleanup at a time; a second caller waits for the first.
    while (this.running) await this.running.catch(() => undefined);
    const p = this.doCleanup(opts.dryRun ?? false, this.policy(opts.overrides));
    this.running = p;
    try {
      return await p;
    } finally {
      this.running = null;
    }
  }

  private async doCleanup(dryRun: boolean, policy: RetentionPolicy): Promise<CleanupReport> {
    const startedMs = this.now();
    const report: CleanupReport = {
      dryRun,
      policy,
      startedAt: new Date(startedMs).toISOString(),
      durationMs: 0,
      renders: [],
      temp: [],
      staging: [],
      cache: { files: 0, bytes: 0 },
      totals: { renders: 0, objects: 0, bytes: 0 },
      errors: [],
    };
    const tempBefore = startedMs - policy.tempHours * 3600 * 1000;
    const active = new Set<string>();
    // Renders and unfinished uploads, one workspace at a time under its own prefix (#304).
    await this.eachWorkspace(async (ws) => {
      const own = await this.opts.activeRunIds();
      for (const id of own) active.add(id);
      const wsPolicy = workspacePolicy(policy, await this.opts.workspaceRetention?.(ws));
      await this.cleanupRenders(report, dryRun, wsPolicy, own, await this.renders.listAllRuns(), startedMs, tempBefore, ws === DEFAULT_WORKSPACE_ID ? {} : { workspaceId: ws });
    });
    return this.finishCleanup(report, dryRun, policy, active, startedMs, tempBefore);
  }

  private async cleanupRenders(
    report: CleanupReport,
    dryRun: boolean,
    policy: RetentionPolicy & { maxAgeHours?: number },
    active: Set<string>,
    runs: StoredRun[],
    startedMs: number,
    tempBefore: number,
    tag: { workspaceId?: string }
  ): Promise<void> {
    const remove = async (run: StoredRun) => {
      if (dryRun) return true;
      try {
        await this.renders.deleteRun(run);
        // get_frames' cached stills of this render go with it.
        await rm(framesCacheDir(this.opts.cacheDir, run.runId), { recursive: true, force: true });
        return true;
      } catch (e) {
        report.errors.push(`${run.projectId}/${run.runId}: ${(e as Error).message}`);
        return false;
      }
    };

    // Finished renders, newest first per project.
    const byProject = new Map<string, StoredRun[]>();
    for (const r of runs.filter((x) => x.complete)) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
    const { renderDays, keepLastRendersPerProject: keep } = policy;
    const maxAgeMs = policy.maxAgeHours ? policy.maxAgeHours * 3600 * 1000 : renderDays * DAY;
    if (maxAgeMs > 0 || keep > 0) {
      for (const list of byProject.values()) {
        list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.runId < b.runId ? 1 : -1));
        for (const [i, run] of list.entries()) {
          if (keep > 0 && i < keep) continue;
          if (active.has(run.runId)) continue;
          const age = startedMs - Date.parse(run.createdAt);
          const reason = maxAgeMs > 0 ? (age > maxAgeMs ? (policy.maxAgeHours ? 'older_than_workspace_retention' : 'older_than_renderDays') : null) : 'beyond_keepLastRendersPerProject';
          if (!reason) continue;
          if (await remove(run)) {
            report.renders.push({ ...tag, projectId: run.projectId, renderId: run.runId, createdAt: run.createdAt, objects: run.objects, bytes: run.bytes, reason });
            report.totals.renders++;
            report.totals.objects += run.objects;
            report.totals.bytes += run.bytes;
          }
        }
      }
    }

    // Unfinished uploads and incomplete directories (a crash, a kill, an interrupted migration).
    for (const run of runs.filter((x) => !x.complete)) {
      const runId = run.temp ? run.runId.slice('.tmp-'.length) : run.runId;
      if (active.has(runId) || Date.parse(run.createdAt) >= tempBefore) continue;
      if (await remove(run)) {
        report.temp.push({ ...tag, projectId: run.projectId, runId: run.runId, createdAt: run.createdAt, objects: run.objects, bytes: run.bytes });
        report.totals.objects += run.objects;
        report.totals.bytes += run.bytes;
      }
    }
  }

  private async finishCleanup(report: CleanupReport, dryRun: boolean, policy: RetentionPolicy, active: Set<string>, startedMs: number, tempBefore: number): Promise<CleanupReport> {
    // Local staging directories <cacheDir>/render-staging/<project>/<runId>.
    for (const pid of await readdir(this.stagingRoot).catch(() => [] as string[])) {
      for (const dir of await readdir(join(this.stagingRoot, pid)).catch(() => [] as string[])) {
        const full = join(this.stagingRoot, pid, dir);
        const runId = dir.replace(/^\.tmp-/, '');
        const s = await stat(full).catch(() => null);
        if (!s || active.has(runId) || s.mtimeMs >= tempBefore) continue;
        const files = await duFiles(full);
        if (files.some((f) => f.mtimeMs >= tempBefore)) continue;
        const bytes = files.reduce((n, f) => n + f.bytes, 0);
        if (!dryRun) await rm(full, { recursive: true, force: true }).catch((e) => report.errors.push(`${full}: ${(e as Error).message}`));
        report.staging.push({ path: relative(this.opts.cacheDir, full).split(sep).join('/'), bytes });
      }
    }

    // Cached copies of remote objects.
    if (policy.cacheDays > 0) {
      for (const f of await duFiles(this.cacheRoot, startedMs - policy.cacheDays * DAY)) {
        if (!dryRun) await rm(f.path, { force: true }).catch(() => undefined);
        report.cache.files++;
        report.cache.bytes += f.bytes;
      }
    }
    report.durationMs = this.now() - startedMs;
    return report;
  }

  /** Start (or restart, after a settings change) the scheduled sweep. */
  startSweeper(): void {
    this.stopSweeper();
    const minutes = this.opts.settings.config.storage.retention.sweepIntervalMinutes;
    if (minutes <= 0) return;
    this.timer = setInterval(() => void this.sweep(), minutes * 60_000);
    this.timer.unref();
  }

  stopSweeper(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scheduled run (also callable from tests). */
  async sweep(): Promise<CleanupReport | null> {
    try {
      const r = await this.cleanup({ dryRun: false });
      this.lastSweep = { at: r.startedAt, deletedObjects: r.totals.objects, freedBytes: r.totals.bytes + r.cache.bytes };
      if (r.totals.objects || r.staging.length || r.cache.files) {
        this.opts.log?.('info', `storage sweep: removed ${r.totals.renders} render(s), ${r.temp.length} unfinished upload(s), ${r.staging.length} staging dir(s), ${r.cache.files} cached file(s)`);
        await this.opts.onSweep?.(r);
      }
      for (const e of r.errors) this.opts.log?.('warn', `storage sweep: ${e}`);
      return r;
    } catch (e) {
      this.lastSweep = { at: new Date(this.now()).toISOString(), deletedObjects: 0, freedBytes: 0, error: (e as Error).message };
      this.opts.log?.('warn', `storage sweep failed: ${(e as Error).message}`);
      return null;
    }
  }
}

/**
 * The policy the sweep applies in one workspace (#487): the instance's, made stricter by the workspace's own
 * retention. A maximum age keeps the shorter of the two (hours), a keep-last the smaller; the instance's policy is
 * the ceiling, so a workspace can keep less than the instance, never more.
 */
export function workspacePolicy(policy: RetentionPolicy, own: { maxAgeHours?: number; keepLast?: number } | undefined): RetentionPolicy & { maxAgeHours?: number } {
  if (!own) return policy;
  const instanceHours = policy.renderDays > 0 ? policy.renderDays * 24 : Infinity;
  const hours = own.maxAgeHours && own.maxAgeHours > 0 ? Math.min(own.maxAgeHours, instanceHours) : undefined;
  const keep = own.keepLast && own.keepLast > 0 ? (policy.keepLastRendersPerProject > 0 ? Math.min(own.keepLast, policy.keepLastRendersPerProject) : own.keepLast) : policy.keepLastRendersPerProject;
  return { ...policy, keepLastRendersPerProject: keep, ...(hours !== undefined && hours !== instanceHours ? { maxAgeHours: hours } : {}) };
}
