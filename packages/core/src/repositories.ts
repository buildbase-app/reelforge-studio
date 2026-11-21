import type { Project, Theme } from '@reelforge/project-schema';
import type { StoredAsset } from './plugins';

/**
 * Persistence contracts. ReelforgeService and the stores in this package
 * depend only on these interfaces; implementations live elsewhere:
 *
 *   - @reelforge/db       Prisma 7: SQLite (default), PostgreSQL, MySQL/MariaDB
 *   - createMemoryRepositories() in this package (tests, ephemeral use)
 *
 * A `Repositories` object is bound to one workspace: every row it reads or
 * writes carries that workspaceId. There is one workspace ("default") today.
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

export const SCOPES = ['read', 'write', 'render', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKeyRecord {
  id: string;
  name: string;
  scopes: Scope[];
  /** First characters of the key, for recognising it in lists. Not secret on its own. */
  prefix: string;
  salt: string;
  /** sha256(salt + key), hex. The key itself is never stored. */
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ApiKeyRepository {
  /** Oldest first. */
  list(): Promise<ApiKeyRecord[]>;
  count(): Promise<number>;
  insert(record: ApiKeyRecord): Promise<void>;
  /** Returns false if the key did not exist. */
  delete(id: string): Promise<boolean>;
  /** Candidates for verification: keys whose stored prefix equals `prefix`. */
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
  type: string;
  status: JobStatus;
  projectId?: string;
  params: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress: JobProgress;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; stage?: string };
  /** Job this one retries, if any. */
  retryOf?: string;
}

export interface JobFilter {
  projectId?: string;
  status?: JobStatus;
  type?: string;
}

export interface JobRepository {
  /** Insert a new job and its first status event, atomically. */
  insert(job: JobRecord, at: string): Promise<void>;
  /** Overwrite the job's mutable fields (progress updates). No event. */
  update(job: JobRecord): Promise<void>;
  /** A state change: overwrite the job and record a status event, atomically. */
  transition(job: JobRecord, at: string): Promise<void>;
  get(id: string): Promise<JobRecord | null>;
  /** Newest first. */
  list(filter?: JobFilter): Promise<JobRecord[]>;
  /** Jobs whose status is queued or running. */
  listUnfinished(): Promise<JobRecord[]>;
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

export interface ProviderSettingInfo {
  name: string;
  providerId?: string;
  updatedAt: string;
}

export interface ProviderSettingRepository {
  /** Every stored value, by setting name (e.g. ELEVENLABS_API_KEY). */
  values(): Promise<Record<string, string>>;
  /** Names and timestamps only; never values. */
  list(): Promise<ProviderSettingInfo[]>;
  /** Set (string) or clear (null) several settings atomically. */
  apply(changes: Record<string, string | null>, at: string, providerId?: string): Promise<void>;
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
  update(id: string, patch: Partial<Pick<StoredAsset, 'durationSeconds' | 'metadata' | 'license'>>): Promise<AssetRecord | null>;
}

// ---- audit log --------------------------------------------------------------

export interface AuditEntryInput {
  actorType: 'api_key' | 'cli' | 'system';
  actorId?: string;
  /** Dotted verb, e.g. "key.create", "provider.configure". */
  action: string;
  targetType?: string;
  targetId?: string;
  /** Never put secrets here. */
  data?: Record<string, unknown>;
}

export interface AuditEntry extends AuditEntryInput {
  id: string;
  at: string;
}

export interface AuditRepository {
  write(entry: AuditEntryInput): Promise<AuditEntry>;
  /** Newest first. */
  list(opts?: { limit?: number }): Promise<AuditEntry[]>;
}

// ---- the bundle -------------------------------------------------------------

export interface Repositories {
  readonly workspaceId: string;
  readonly projects: ProjectRepository;
  readonly keys: ApiKeyRepository;
  readonly jobs: JobRepository;
  readonly themes: ThemeRepository;
  readonly providerSettings: ProviderSettingRepository;
  readonly assets: AssetRepository;
  readonly audit: AuditRepository;
}
