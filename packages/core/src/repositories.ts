import type { Project, Theme } from '@renderweld/project-schema';
import type { PageRequest } from './paging';
import type { JobPriority } from './priority';
import type { StoredAsset } from './plugins';
import type { WebhookRepository } from './webhooks/types';

/**
 * Persistence contracts. ReelforgeService and the stores in this package
 * depend only on these interfaces; implementations live elsewhere:
 *
 *   - @renderweld/db       Prisma 7: SQLite (default), PostgreSQL, MySQL/MariaDB
 *   - createMemoryRepositories() in this package (tests, ephemeral use)
 *
 * A `Repositories` object is bound to one workspace: every row it reads or
 * writes carries that workspaceId (#304). The service gets a routing bundle
 * (createWorkspaceRouter in ./workspace) that picks the bound bundle of the
 * caller's workspace on every call, so no route can forget the filter.
 * Binary files (assets, renders) are never stored here: they stay in the
 * storage driver, and the asset row only records where (`storageKey`).
 *
 * Contract notes every implementation must honour (checked by the shared
 * contract suite in packages/db/test/contract.ts):
 *   - Timestamps are ISO-8601 strings with millisecond precision.
 *   - JSON payloads round-trip exactly (key order included).
 *   - Lists are newest first unless stated otherwise.
 *   - Methods that change more than one row are atomic (one transaction).
 */

export const DEFAULT_WORKSPACE_ID = 'default';

/**
 * The render a job produces, when it is a render or preview job: its `params.runId`; else null. Stored with the job
 * (Job.runId) so get_render finds the render's project by id (#184). Units and joins carry their render's run id too,
 * but the render job owns it.
 */
export function runIdOf(job: Pick<JobRecord, 'type' | 'params'>): string | null {
  const runId = (job.params as { runId?: unknown } | undefined)?.runId;
  return (job.type === 'render' || job.type === 'preview') && typeof runId === 'string' ? runId : null;
}

// ---- projects ---------------------------------------------------------------

export interface ProjectMeta {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredProject {
  meta: ProjectMeta;
  manifest: Project;
}

/** A project in a list: its meta and summary, without the manifest (list_projects). */
export interface ProjectSummary extends ProjectMeta {
  title: string;
  scenes: number;
  durationSeconds: number;
}

export interface ProjectRepository {
  /** Insert a project at version 1 with its first version row. Throws ApiError `conflict` if the id exists. */
  create(project: StoredProject): Promise<void>;
  get(id: string): Promise<StoredProject | null>;
  getVersion(id: string, version: number): Promise<Project | null>;
  /** Version numbers, ascending. Empty if the project does not exist. */
  listVersions(id: string): Promise<number[]>;
  /** Every project with its current manifest, most recently updated first. */
  list(): Promise<StoredProject[]>;
  /**
   * One keyset page of summaries, newest created first ((createdAt, id)
   * descending), strictly after `req.after`, at most `req.limit` rows. Never
   * loads more than the page (D-102).
   */
  page(req: PageRequest): Promise<ProjectSummary[]>;
  /**
   * Atomically bump the project from `expectedVersion` to `expectedVersion + 1`
   * and store `manifest` as that version. Returns the new meta, or null when
   * the project is no longer at `expectedVersion` (someone else saved first)
   * or does not exist. Nothing is written in that case.
   */
  saveVersion(id: string, expectedVersion: number, manifest: Project, updatedAt: string): Promise<ProjectMeta | null>;
  /** Delete the project and all its versions. Returns false if it did not exist. */
  delete(id: string): Promise<boolean>;
}

// ---- API keys ---------------------------------------------------------------

/**
 * `admin` manages its own workspace (keys, webhooks, audit). `owner` is instance-level (#304): workspaces, runtime
 * configuration, the licence, provider credentials and storage; it implies `admin` in its own workspace.
 */
/** `approve` (#485): approve render plans when `render.approval` asks for it; `admin` and `owner` imply it. */
export const SCOPES = ['read', 'write', 'render', 'approve', 'admin', 'owner'] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKeyRecord {
  id: string;
  /** The workspace the key belongs to; set on records read across workspaces (authentication). */
  workspaceId?: string;
  name: string;
  scopes: Scope[];
  /** First characters of the key, for recognising it in lists. Not secret on its own. */
  prefix: string;
  salt: string;
  /** sha256(salt + key), hex. The key itself is never stored. */
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
  /** The key stops working after this time. */
  expiresAt?: string;
  /** Set once revoked: the key never authenticates again (the row stays for the audit trail). */
  revokedAt?: string;
  /** The secret before the last rotation, valid until `prev.expiresAt` (D-056). */
  prev?: ApiKeySecret & { expiresAt: string };
  rotatedAt?: string;
  /** Requests per minute (unset: limits.rateLimitPerMinute). */
  rateLimitPerMinute?: number;
  /** Render and preview jobs per UTC day / calendar month (unset: unlimited). */
  rendersPerDay?: number;
  rendersPerMonth?: number;
  /** CIDR blocks the key may be used from (unset: anywhere). */
  ipAllowlist?: string[];
  /** Highest job priority the key may use (unset: each job type's default class; D-103). */
  maxPriority?: JobPriority;
}

/** A key's secret as stored: lookup prefix, salt and sha256(salt + key). */
export interface ApiKeySecret {
  prefix: string;
  salt: string;
  hash: string;
}

/** Fields of a key that can change after creation; null clears an optional one. */
export interface ApiKeyPatch {
  name?: string;
  /** A new current secret (rotation). */
  secret?: ApiKeySecret;
  prev?: (ApiKeySecret & { expiresAt: string }) | null;
  rotatedAt?: string;
  expiresAt?: string | null;
  revokedAt?: string;
  rateLimitPerMinute?: number | null;
  rendersPerDay?: number | null;
  rendersPerMonth?: number | null;
  ipAllowlist?: string[] | null;
  maxPriority?: JobPriority | null;
}

export interface ApiKeyRepository {
  /** Oldest first. */
  list(): Promise<ApiKeyRecord[]>;
  get(id: string): Promise<ApiKeyRecord | null>;
  count(): Promise<number>;
  insert(record: ApiKeyRecord): Promise<void>;
  /** Change a key atomically (one statement). Returns the updated key, or null if it does not exist. */
  update(id: string, patch: ApiKeyPatch): Promise<ApiKeyRecord | null>;
  /** Returns false if the key did not exist. */
  delete(id: string): Promise<boolean>;
  /** Candidates for verification: keys whose current or previous (rotated) prefix equals `prefix`. */
  findByPrefix(prefix: string): Promise<ApiKeyRecord[]>;
  touch(id: string, lastUsedAt: string): Promise<void>;
}

// ---- jobs -------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobProgress {
  stage: string;
  /** 0..1 for the whole job. */
  fraction: number;
  detail?: string;
}

export interface JobRecord {
  id: string;
  /** The workspace the job belongs to (#304); set by the routing repositories and on new jobs. */
  workspaceId?: string;
  type: string;
  status: JobStatus;
  projectId?: string;
  params: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress: JobProgress;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; stage?: string; /** Fan-out: the unit or join job whose failure failed this render (D-097). */ unit?: string };
  /** Job this one retries, if any. */
  retryOf?: string;
  /** The API key that started it (render quotas). */
  apiKeyId?: string;
  /** "database" for jobs of the database queue (claimed by any worker); unset for in-process jobs (D-075). */
  queue?: 'database';
  /** Database queue: how many times a worker claimed it (1 on the first run). */
  attempts?: number;
  /** Database queue: the worker instance that holds (or last held) the job. */
  workerId?: string;
  /** Database queue: the claim is the worker's until then; renewed by its heartbeat. */
  leaseExpiresAt?: string;
  /** Set by cancel_job on another instance; the worker holding the job stops it at its next heartbeat. */
  cancelRequestedAt?: string;
  /** Fan-out (D-097): the render this unit or join belongs to. */
  parentId?: string;
  /**
   * Fan-out (D-097), on the parent: units still to succeed. Set when the parent
   * fans out; the parent then stays `running` without a worker or lease until
   * its join finishes it.
   */
  pendingChildren?: number;
  /**
   * Claim class (D-103): `interactive` > `standard` > `batch`; unset reads as
   * `standard`. Fan-out units and the join inherit their render's class.
   */
  priority?: JobPriority;
}

/** What a child's final state did to its parent, in the same transaction (D-097). */
export interface ChildSettlement {
  /** The parent as written (null: no parent, or it had already finished). */
  parent: JobRecord | null;
  /** The parent reached a final state (succeeded with the join's result, failed or cancelled). */
  parentFinished: boolean;
  /** Queued siblings cancelled because the render failed or was cancelled. */
  cancelled: JobRecord[];
  /** The single join job, inserted by the transaction that took `pendingChildren` to 0. */
  join: JobRecord | null;
  /** A unit's success took the parent's stored progress past another 10 % (SettlementPlan.progressed). */
  progressed?: boolean;
}

/** A database-queue worker's claim on a job: writes only land while the job is still held by it. */
export interface JobLeaseFence {
  workerId: string;
  attempts: number;
}

/** One quota window for insertWithQuota (render quotas per UTC day / month). */
export interface QuotaWindow {
  since: string;
  limit: number;
}

/**
 * Limits checked by insertWithQuota besides the quota windows (D-090): how many
 * unfinished (queued or running) jobs of `types` the key may have, and how many
 * jobs of `types` may wait in the queue in total (every key, every instance).
 */
export interface JobCaps {
  maxActivePerKey?: number;
  maxQueuedTotal?: number;
  /**
   * Admission by estimated wait (limits.maxEstimatedWaitSeconds, D-103): refuse
   * when the estimated queue wait of the new job (estimateWaitSeconds, from the
   * queued jobs of its class or higher and `claimsPerSecond`) exceeds `seconds`.
   * Counted in the same statement as the other caps.
   */
  maxEstimatedWait?: { seconds: number; claimsPerSecond: number; now: string };
}

export type QuotaResult =
  | { ok: true }
  | { ok: false; window: number; used: number }
  | { ok: false; cap: 'active_per_key' | 'queued_total'; used: number }
  /** `used`: queued jobs ahead of the new one (its class or higher, any key); `oldestQueuedAt`: the oldest of them. */
  | { ok: false; cap: 'estimated_wait'; used: number; oldestQueuedAt: string; estimatedWaitSeconds: number };

export interface JobFilter {
  projectId?: string;
  /** Fan-out: only the units and join of this render. */
  parentId?: string;
  status?: JobStatus;
  type?: string;
}

/** A named lease one instance of the deployment holds at a time (InstanceLease, D-106). */
export interface InstanceLeaseRecord {
  holder: string;
  expiresAt: string;
  /** What the holder published with it (queue-housekeeping: queued jobs). */
  value?: number;
  updatedAt: string;
}

export interface JobRepository {
  /** Insert a new job and its first status event, atomically. */
  insert(job: JobRecord, at: string): Promise<void>;
  /**
   * Insert a new job (as `insert`) unless the API key already started `limit`
   * jobs of `types` since a window's `since`, or a cap (JobCaps) is reached.
   * The count and the insert are one transaction: it writes the job and its
   * event, then locks the key's row (PostgreSQL/MySQL row lock, SQLite write
   * lock), or one shared lock row when `maxQueuedTotal` is set, then counts
   * every window and cap in one statement and commits or rolls back, so
   * instances racing for the last slot cannot overshoot and only one
   * statement runs while the lock is held (D-078, D-090, #180). Returns which window or
   * cap was full, and its count, when refused. Without `apiKeyId` only
   * `maxQueuedTotal` applies.
   */
  insertWithQuota(job: JobRecord, at: string, quota: { apiKeyId?: string; types: string[]; windows: QuotaWindow[] } & JobCaps): Promise<QuotaResult>;
  /**
   * Overwrite the job's mutable fields (progress updates). No event. With a
   * fence, only while the job is running and still held by that claim;
   * returns false when nothing was written.
   */
  update(job: JobRecord, fence?: JobLeaseFence): Promise<boolean>;
  /**
   * A state change: overwrite the job and record a status event, atomically.
   * Fenced like `update`. A final state of a fan-out child settles its parent
   * in the same transaction (as `finishChild`).
   */
  transition(job: JobRecord, at: string, fence?: JobLeaseFence): Promise<boolean>;
  /**
   * The final state of a fan-out child (`parentId` set; D-097), fenced like
   * `transition`, and in the same transaction, after locking the parent row
   * first (parent before child, everywhere, so these never deadlock): a unit's
   * success decrements the parent's `pendingChildren` and the transaction that
   * reaches 0 inserts the one join job; the join's success finishes the parent
   * with its result; any failure or cancellation finishes the parent the same
   * way, cancels queued siblings and asks running ones to stop. Nothing happens
   * to a parent that already finished. Returns null when the fence did not hold.
   */
  finishChild(job: JobRecord, at: string, fence?: JobLeaseFence): Promise<ChildSettlement | null>;
  /**
   * Fan a running parent out (D-097), fenced by its claim: insert `children`
   * (queued) with status events, set `pendingChildren` to their number, and
   * release the parent's worker and lease (it stays `running`). Refused with
   * `cancelled` when a cancel was requested meanwhile, `lost` when the fence
   * does not hold.
   */
  fanOut(parent: JobRecord, children: JobRecord[], at: string, fence: JobLeaseFence): Promise<'ok' | 'lost' | 'cancelled'>;
  /**
   * Cancel a fanned-out parent (running, no lease): the parent and its queued
   * children become `cancelled`, running children get a cancel request. Parent
   * row first, then children. Returns what changed (parent first), or null when
   * the job is not a fanned-out running parent.
   */
  cancelTree(id: string, at: string): Promise<JobRecord[] | null>;
  get(id: string): Promise<JobRecord | null>;
  /** Newest first. Every matching row: for internal use; the API pages with `page`. */
  list(filter?: JobFilter): Promise<JobRecord[]>;
  /** One keyset page of matching jobs, (createdAt, id) descending, strictly after `req.after`, at most `req.limit` (D-102). */
  page(filter: JobFilter, req: PageRequest): Promise<JobRecord[]>;
  /**
   * The project of the render or preview job that produces render `runId` in this workspace, or null when there is
   * none (#184: get_render after a restart or on another instance). On a database one indexed read (Job.runId), never
   * a scan of projects or jobs.
   */
  projectOfRun(runId: string): Promise<string | null>;
  /** The render or preview job that produces render `runId` in this workspace (get_render_output's estimate, #485). */
  jobOfRun(runId: string): Promise<JobRecord | null>;
  /** Jobs whose status is queued or running. */
  listUnfinished(): Promise<JobRecord[]>;

  // -- database queue (D-075): every method is atomic, safe across processes --

  /**
   * Claim the oldest queued database-queue job of `types` for `workerId`:
   * status running, attempts + 1, lease until `leaseUntil`, plus a status
   * event. PostgreSQL/MySQL: `SELECT ... FOR UPDATE SKIP LOCKED`, so workers
   * never wait for each other; SQLite: one conditional UPDATE under the
   * database write lock. Returns the claimed job, or null when none is queued.
   * With `id`, only that job, and only while it is queued (`worker --once --job`).
   */
  claim(opts: {
    workerId: string;
    types: string[];
    now: string;
    leaseUntil: string;
    /**
     * Skip jobs of API keys that already have this many database-queue jobs
     * running on a worker (limits.maxRunningJobsPerKey, D-090; a fanned-out
     * parent holds no lease and is not counted). Exact on one worker; two
     * workers claiming at the same moment may each take one more.
     */
    maxRunningPerKey?: number;
    /** Only this job, and only while it is queued (`worker --once --job`, D-100); the per-key cap still applies. */
    id?: string;
    /** queue.priorityAgingSeconds (D-103): a `batch` job queued this long counts as `standard`. Unset or 0: strict classes. */
    priorityAgingSeconds?: number;
  }): Promise<JobRecord | null>;
  /**
   * Renew the lease of `ids` still running and held by `workerId`. Returns the
   * ids still held, and those of them whose cancellation was requested.
   */
  heartbeat(workerId: string, ids: string[], leaseUntil: string): Promise<{ held: string[]; cancelRequested: string[] }>;
  /**
   * Running database-queue jobs whose lease ended before `now`: queued again
   * (attempts < maxAttempts) or failed with `lease_expired`, each with a status
   * event and a log line. Concurrent callers never handle the same job twice.
   * A fanned-out parent holds no lease and is never touched; a failed child
   * settles its parent as `finishChild` does.
   */
  recoverExpired(now: string, maxAttempts: number): Promise<{ requeued: JobRecord[]; failed: JobRecord[]; /** Parents and siblings a failed fan-out child finished or cancelled (D-097). */ settled?: JobRecord[] }>;
  /** Hand a held job back to the queue (graceful shutdown): queued, no worker, the attempt not counted. */
  release(id: string, fence: JobLeaseFence, at: string): Promise<boolean>;
  /**
   * Take or renew the instance lease `name` for `holder` until `until` (D-106): only while nobody holds it, it
   * expired (`expiresAt <= now`) or `holder` already does. One compare-and-set UPDATE (the row is created on first
   * use), so of instances racing for a free lease exactly one gets it. `value` is stored with it for the others.
   */
  takeLease(name: string, holder: string, now: string, until: string, value?: number): Promise<boolean>;
  /** The instance lease `name` as stored, or null before anyone took it. */
  readLease(name: string): Promise<InstanceLeaseRecord | null>;
  /** Give the lease up while `holder` still has it (shutdown): it is expired at once, the next instance to look takes it. */
  releaseLease(name: string, holder: string, at: string): Promise<boolean>;
  /** Cancel a job that is still queued. Returns the cancelled job, or null when it is not queued (any more). */
  cancelQueued(id: string, at: string, error: { code: string; message: string }): Promise<JobRecord | null>;
  /** Ask the worker holding a running job to stop it. Returns false when the job is not running. */
  requestCancel(id: string, at: string): Promise<boolean>;
  /**
   * Queued database-queue jobs; with `before`, only those ahead of it (queue
   * position): a higher class, or the same class and older (D-103; fairness
   * across keys and aging are not predicted).
   */
  countQueued(before?: { createdAt: string; id: string; priority?: JobPriority }): Promise<number>;
  /** How many jobs of these types `apiKeyId` started at or after `since` (render quotas). */
  countByApiKey(apiKeyId: string, since: string, types: string[]): Promise<number>;
  /** How many jobs of these types the workspace started at or after `since` (workspace render limits, #304). */
  countSince(since: string, types: string[]): Promise<number>;
  appendLog(jobId: string, at: string, line: string): Promise<void>;
  /** Log lines as "<iso time> <line>", oldest first; the last `tail` if given. */
  logs(jobId: string, tail?: number): Promise<string[]>;
}

// ---- themes -----------------------------------------------------------------

export interface ThemeRepository {
  /** Custom themes, sorted by id. */
  list(): Promise<Theme[]>;
  get(id: string): Promise<Theme | null>;
  /** Throws ApiError `conflict` if the id exists. */
  insert(theme: Theme, at: string): Promise<void>;
  /** Insert or replace. */
  put(theme: Theme, at: string): Promise<void>;
  delete(id: string): Promise<boolean>;
}

// ---- provider settings ------------------------------------------------------

/**
 * A stored setting value. `scheme` says how `value` is stored: "plain", or
 * "aes-256-gcm" (SecretCipher in config/crypto.ts; REELFORGE_SECRET_KEY).
 * Repositories store both opaquely; encryption happens above them.
 */
export interface StoredValue {
  value: string;
  scheme: string;
}

export interface ProviderSettingInfo {
  name: string;
  providerId?: string;
  scheme: string;
  updatedAt: string;
}

export interface ProviderSettingRepository {
  /** Every stored value, by setting name (e.g. ELEVENLABS_API_KEY), as stored (possibly encrypted). */
  values(): Promise<Record<string, StoredValue>>;
  /** Names, schemes and timestamps only; never values. */
  list(): Promise<ProviderSettingInfo[]>;
  /** Set or clear (null) several settings atomically. A set without providerId keeps the stored one. */
  apply(changes: Record<string, StoredValue | null>, at: string, providerId?: string): Promise<void>;
}

// ---- runtime settings -------------------------------------------------------

/**
 * A runtime configuration value set over REST/MCP (update_config), by dotted
 * key (e.g. "limits.rateLimitPerMinute"). `value` is JSON text, or the
 * encrypted JSON text when `scheme` is not "plain" (secrets).
 */
export interface StoredSetting extends StoredValue {
  key: string;
  updatedAt: string;
  /** Who set it, e.g. an API key id. */
  updatedBy?: string;
}

export interface SettingRepository {
  /** Every stored runtime setting, sorted by key. */
  list(): Promise<StoredSetting[]>;
  /** Set or clear (null) several settings atomically. */
  apply(changes: Record<string, StoredValue | null>, at: string, updatedBy?: string): Promise<void>;
}

// ---- licence ----------------------------------------------------------------

/**
 * Licence activation state (D-028, D-035), one per workspace. Never holds the
 * licence key: `keyHash` (HMAC-SHA256 keyed with the instance id) only says
 * which key the stored answer belongs to. Timestamps are ISO-8601.
 */
export interface LicenceStateRecord {
  /** Random, created once; sent to BuildBase with the key (the only data sent). */
  instanceId: string;
  keyHash?: string;
  /** The last answer from the licence server, as received (no key string in it). */
  answer?: Record<string, unknown>;
  lastCheckedAt?: string;
  /** Last answer with valid: true; the offline grace period counts from here. */
  lastSuccessAt?: string;
  /** The last failed attempt (unreachable, rate limited, server error); cleared by an answer. `by`: the instance that tried. */
  lastError?: { kind: string; message: string; status?: number; code?: string; at: string; by?: string };
  activatedAt?: string;
  deactivatedAt?: string;
  nextCheckAt?: string;
  /** Latest clock time seen; a clock set back past it gets no grace. */
  highWaterAt?: string;
  updatedAt: string;
}

export interface LicenceRepository {
  get(): Promise<LicenceStateRecord | null>;
  /**
   * The stored state, or a new one with `instanceId` when there is none
   * (atomic: two processes starting together end up with the same instance id).
   */
  init(instanceId: string, at: string): Promise<LicenceStateRecord>;
  /**
   * Replace the stored state (the instance id never changes once stored).
   * With `ifUpdatedAt`, only when the stored `updatedAt` is still that value
   * (compare-and-set); returns whether the state was written.
   */
  save(state: LicenceStateRecord, opts?: { ifUpdatedAt?: string }): Promise<boolean>;
  /**
   * Take the next licence check for this deployment (single flight across
   * instances, D-098): one atomic update that sets `nextCheckAt` (and
   * `updatedAt`) to `leaseUntil` when `nextCheckAt` is unset, at or before
   * `now`, or later than `orLaterThan`. True for the one caller that won.
   */
  claimCheck(at: { now: string; leaseUntil: string; orLaterThan?: string }): Promise<boolean>;
}

// ---- assets -----------------------------------------------------------------

export interface AssetRecord extends StoredAsset {
  /** Where the bytes are in the storage driver, e.g. "ast-0123456789abcdef/file.png". */
  storageKey: string;
}

export interface AssetRepository {
  get(id: string): Promise<AssetRecord | null>;
  /** Insert unless the id exists; returns the stored row either way (content addressing). */
  insertIfAbsent(asset: AssetRecord): Promise<AssetRecord>;
  /** Newest first. */
  list(): Promise<AssetRecord[]>;
  /** One keyset page, (createdAt, id) descending, strictly after `req.after`, at most `req.limit` (D-102). */
  page(req: PageRequest): Promise<AssetRecord[]>;
  update(id: string, patch: Partial<Pick<StoredAsset, 'durationSeconds' | 'metadata' | 'license'>>): Promise<AssetRecord | null>;
}

// ---- audit log --------------------------------------------------------------

export type AuditResult = 'success' | 'failure' | 'denied';
export const AUDIT_RESULTS: readonly AuditResult[] = ['success', 'failure', 'denied'];

export interface AuditEntryInput {
  actorType: 'api_key' | 'cli' | 'system';
  actorId?: string;
  /** The key's name at the time of the action. */
  actorName?: string;
  /** Dotted verb, e.g. "key.create", "provider.configure". */
  action: string;
  targetType?: string;
  targetId?: string;
  /** Default "success". */
  result?: AuditResult;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  /** Never put secrets here (AuditLog redacts what looks like one, as a second line of defence). */
  data?: Record<string, unknown>;
}

export interface AuditEntry extends AuditEntryInput {
  id: string;
  at: string;
  result: AuditResult;
  /** Set when an owner lists the entries of every workspace (#304). */
  workspaceId?: string;
}

export interface AuditFilter {
  /** Inclusive lower bound (ISO). */
  from?: string;
  /** Exclusive upper bound (ISO). */
  to?: string;
  actorId?: string;
  /** Exact action, or a prefix ending in "*" ("key.*"). */
  action?: string;
  targetType?: string;
  targetId?: string;
  result?: AuditResult;
  /** Page cursor: entries strictly older than this one (same order as the list). */
  before?: { at: string; id: string };
  /** Default 100. */
  limit?: number;
}

/** Append-only: entries are inserted, listed and removed by the retention sweep only. */
export interface AuditRepository {
  write(entry: AuditEntryInput): Promise<AuditEntry>;
  /** Newest first (at, then id, descending). */
  list(filter?: AuditFilter): Promise<AuditEntry[]>;
  /** Retention: delete entries older than `cutoff`. Returns how many. */
  deleteOlderThan(cutoff: string): Promise<number>;
}

// ---- idempotency keys -------------------------------------------------------

export interface IdempotencyRecord {
  /** Who sent it (API key id): keys of different callers never collide. */
  actorId: string;
  key: string;
  operation: string;
  requestHash: string;
  status: 'pending' | 'done';
  response?: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface IdempotencyRepository {
  /** Insert a pending record. Returns false, changing nothing, when (actorId, key) exists. */
  begin(record: IdempotencyRecord): Promise<boolean>;
  get(actorId: string, key: string): Promise<IdempotencyRecord | null>;
  /** Store the response and mark the record done. */
  complete(actorId: string, key: string, response: unknown): Promise<void>;
  delete(actorId: string, key: string): Promise<void>;
  /** Delete records whose expiresAt is before `now`. Returns how many. */
  deleteExpired(now: string): Promise<number>;
}

// ---- rate limits ------------------------------------------------------------

/** Per-key request counters shared by every instance (limits.rateLimitStore "database", D-078). */
export interface RateLimitRepository {
  /** Count one request (or `by`) for `key` in the window starting at `windowStart`; returns the window's count including it (atomic increment). */
  hit(key: string, windowStart: string, by?: number): Promise<number>;
  /**
   * The per-key request limit's sliding window (#305): count one request for `key` in the window starting at
   * `windowStart` and read, in the same statement, the count of the window starting at `previousStart`
   * (0 when there is none). The caller weights `previous` by how much of it still overlaps the last minute.
   */
  slide(key: string, windowStart: string, previousStart: string): Promise<{ count: number; previous: number }>;
  /** The windows of one key that started at or after `since`, oldest first (shared statistics such as the claim counter, D-103). */
  windows(key: string, since: string): Promise<Array<{ windowStart: string; count: number }>>;
  /**
   * Delete windows that started before `cutoff`. Returns how many. Usage
   * counters (keys starting with `usage:`) are only deleted with `usage: true`,
   * request windows only without it.
   */
  deleteOlderThan(cutoff: string, opts?: { usage?: boolean }): Promise<number>;
  /**
   * Usage counters (D-091): add one to every counter, all or nothing, unless one
   * of them already reached its `limit`. Each increment is one conditional
   * UPDATE, so instances racing for the last unit cannot overshoot. Keys start
   * with `usage:`. Returns the index of the full counter and its count when refused.
   */
  reserve(counters: Array<{ key: string; windowStart: string; limit: number }>): Promise<{ ok: true } | { ok: false; index: number; used: number }>;
  /** A usage counter's value (0 when it does not exist). */
  usage(key: string, windowStart: string): Promise<number>;
}

// ---- queue dispatch outbox ------------------------------------------------------

/** One job id waiting to be published to an external dispatch broker (D-105). */
export interface DispatchOutboxRow {
  id: string;
  /** The job's workspace; set by the routing repositories (#304). */
  workspaceId?: string;
  jobId: string;
  /** Failed publishes so far. */
  attempts: number;
  nextAttemptAt: string;
  lockedUntil?: string;
  lastError?: string;
  createdAt: string;
}

/**
 * The dispatch outbox (D-105): rows are written by the job repository inside
 * the transaction that makes a job claimable (ReadySignal `outbox`); the
 * OutboxRelay publishes and removes them. Generic for every external driver.
 */
export interface DispatchOutboxRepository {
  /** Up to `limit` due rows (next attempt at or before `now`, no lease or an expired one), oldest first, leased until `leaseUntil`; each row to one caller. */
  claim(now: string, leaseUntil: string, limit: number): Promise<DispatchOutboxRow[]>;
  /** Published (or given up): delete the rows. */
  remove(ids: string[]): Promise<void>;
  /** A failed publish: drop the lease, store the attempt count and error, try again at `nextAttemptAt`. */
  retry(id: string, attempts: number, nextAttemptAt: string, error: string): Promise<void>;
  /** Rows waiting (metrics, tests). */
  count(): Promise<number>;
}

// ---- the bundle -------------------------------------------------------------

// ---- workspaces (#304) ------------------------------------------------------

/** "active"; "suspended": its keys are refused and its queued jobs wait; "deleted": soft-deleted until purgeAfter. */
export type WorkspaceStatus = 'active' | 'suspended' | 'deleted';
export const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = ['active', 'suspended', 'deleted'];

/** Optional per-workspace limits; unset means the workspaces.defaultLimits setting, which is unlimited by default. */
export interface WorkspaceLimits {
  /** Render and preview jobs per UTC day / calendar month, across every key of the workspace. */
  rendersPerDay?: number;
  rendersPerMonth?: number;
  /** Requests per minute across every key of the workspace (each key's own limit still applies). */
  rateLimitPerMinute?: number;
  /** Bytes of assets and renders the workspace may store; uploads and renders are refused above it. */
  storageBytes?: number;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt?: string;
  suspendedAt?: string;
  deletedAt?: string;
  /** Soft-deleted: rows and files are purged after this time. */
  purgeAfter?: string;
  limits?: WorkspaceLimits;
}

export interface WorkspacePatch {
  name?: string;
  status?: WorkspaceStatus;
  suspendedAt?: string | null;
  deletedAt?: string | null;
  purgeAfter?: string | null;
  limits?: WorkspaceLimits | null;
  updatedAt: string;
}

/** Instance-level: the same rows whichever workspace a bundle is bound to. */
export interface WorkspaceRepository {
  /** Every workspace that has not been purged, oldest first. */
  list(): Promise<WorkspaceRecord[]>;
  get(id: string): Promise<WorkspaceRecord | null>;
  /** Insert; false when the id is taken. */
  create(record: WorkspaceRecord): Promise<boolean>;
  update(id: string, patch: WorkspacePatch): Promise<WorkspaceRecord | null>;
  /** Hard delete: the workspace and every row in it (projects, jobs, keys, assets, audit, ...). */
  purge(id: string): Promise<boolean>;
}

export interface Repositories {
  readonly workspaceId: string;
  /** Workspaces of the install (instance-level, #304). */
  readonly workspaces: WorkspaceRepository;
  readonly projects: ProjectRepository;
  readonly keys: ApiKeyRepository;
  readonly jobs: JobRepository;
  readonly themes: ThemeRepository;
  readonly providerSettings: ProviderSettingRepository;
  readonly settings: SettingRepository;
  readonly licence: LicenceRepository;
  readonly assets: AssetRepository;
  readonly audit: AuditRepository;
  readonly idempotency: IdempotencyRepository;
  readonly rateLimits: RateLimitRepository;
  /** Outbound event endpoints, the outbox and the delivery log (#66). */
  readonly webhooks: WebhookRepository;
  /** Queue dispatch outbox (D-105): job ids for external brokers. */
  readonly dispatchOutbox: DispatchOutboxRepository;
}
