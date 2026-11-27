import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, resolve, sep } from 'node:path';
import { MAX_ZIP_ENTRIES, assHasAlpha, encodersOf, missingEncoders, resolveTools, setEncoderSettings, setFormatSettings, toolPaths, toolVersionAsync, type Tools } from '@renderweld/media-pipeline';
import {
  CAPTION_MODES,
  captionMode,
  CaptionParseError,
  DEFAULT_OUTPUT,
  fpsValue,
  framesToSeconds,
  isSafeRelativePath,
  MAX_PROJECT_SECONDS,
  MAX_SOURCE_BYTES,
  MIN_SCENE_FRAMES,
  SHORT_SCENE_WARN_SECONDS,
  parseCaptions,
  parseProject,
  projectJsonSchema,
  sceneFrames,
  SCHEMA_VERSION,
  SUPPORTED_FPS,
  type FrameRate,
  SUPPORTED_SCHEMA_VERSIONS,
  totalFrames,
  withVariant,
  renderAudioOptions,
  type RenderAudioOptions,
  resolveCaptions,
  isLanguageTag,
  MAX_CAPTION_LANGUAGES,
  splitCueKinds,
  type CaptionCue,
  type CaptionMode,
  ALPHA_CODECS,
  FORMAT_CODECS,
  OUTPUT_FILES,
  OUTPUT_FORMATS,
  type FormatSpec,
  formatSpec,
  type Project,
  type ValidationIssue,
  type ValidationWarning,
  type ThemeTokens,
  safeAreaInsets,
} from '@renderweld/project-schema';
import { BUNDLED_FONTS } from './fonts';
import { CONTACT_SHEET_FILE, FRAMES_DEFAULT_WIDTH, FRAMES_MAX_WIDTH, FRAMES_MIN_WIDTH, framesCacheDir, framesImageWithinBudget, planFrames, sceneSpans, type ContactSheetManifest, type FramesRequest, type PlannedTile } from './frames';
import type { VideoQaManifest } from './videoqa';
import { audioChecks, type AudioManifest } from './audio';
import { OLD_SERVER_NAMES, PRODUCT_NAME, SERVER_NAME } from './product';
import { AssetStore, assetUsableBy, stageStream } from './assets';
import { CAPTION_FILE_PATTERN, captionFileNames, captionFontChoice, captionFontList, captionsEtag, type CaptionManifest } from './captions';
import { applyCaptionUpdate, getCaptionsInput, parseInput, projectCaptionsView, renderCaptionsView, transcribeInput, updateCaptionsInput, type ProjectCaptionsView, type RenderCaptionsView } from './captions-edit';
import { LocalBackend } from './backends/local';
import { ApiError, badRequest, invalidManifest, notFound } from './errors';
import { OUTPUT_FILE_PATTERN, outputFormatIssues, planFor, type OutputFormatIssue } from './output-formats';
import { newId, readJson, writeJsonAtomic } from './fsutil';
import { JobCapReached, JobRunner, QuotaExceeded, defaultWorkerId, type DatabaseQueueOptions, type JobContext, type JobRecord, type QueueMode } from './jobs';
import { JOB_CAP_RETRY_SECONDS, renderLimitViolations, usageDay, usageKeys, type LimitReason, type RenderLimitViolation } from './limits';
import { outputSupportIssues } from './output-support';

/** Longest a single get_job call may block; below common MCP client request timeouts (60 s). */
export const MAX_JOB_WAIT_SECONDS = 50;
import { KeyStore, hasScope, quotaWindows, type AuthContext, type KeyOptions, type PublicKey, type Scope } from './keys';
import { DEFAULT_WORKSPACE_ID, type JobStatus, type AuditEntryInput, type AuditFilter, type JobCaps, type QuotaWindow, type Repositories, type WorkspaceStatus } from './repositories';
import { WORKSPACE_ID, currentWorkspaceId, isWorkspaceRouter, mergeAuditPages, runInWorkspace, workspaceKeyPrefix, type WorkspaceRouter } from './workspace';
import { WorkspaceAdmin } from './workspace-admin';
import {
  AuditLog,
  MAX_AUDIT_EXPORT,
  OtlpLogsAuditSink,
  StdoutAuditSink,
  auditToCsv,
  auditCursor,
  auditToJsonl,
  currentRequest,
  parseAuditQuery,
  type AuditSink,
} from './audit';
import { withIdempotency, type IdempotentOperation } from './idempotency';
import { applyMergePatch, isPlainObject } from './mergePatch';
import type { BackendContext, BackendEstimate, EstimateRequest, ProviderPlugin, RenderOutcome, RenderRequest, ResolvedAsset, SttSettings, StoredAsset } from './plugins';
import { PluginRegistry } from './registry';
import { runRenderPipeline } from './render';
import { JOIN_JOB_TYPE, UNIT_JOB_TYPE, joinUnits, planChunks, renderUnit, unitSpecs, type ChunkPolicy, type FanOutDeps, type RenderJobParams } from './render-fanout';
import { UrlSigner } from './secrets';
import { RuntimeConfig, type ConfigSources } from './config/runtime';
import { createLicenceManager, type LicenceApi, type LicenceManager } from './licence';
import type { ResolvedConfig } from './config/load';
import { ProjectStore, isProjectId } from './store';
import { isRowId, parsePageQuery, readPage } from './paging';
import { createStorageDriver, type StorageFactory } from './storage/factory';
import { contentTypeFor, PROJECTS_PREFIX, RENDER_MANIFEST, renderPrefix } from './storage/keys';
import { StorageManager, renderDeletesAt, workspacePolicy, type CleanupReport, type RetentionPolicy, type WorkspaceRetention } from './storage/manager';
import { ThemeStore } from './themes';
import { NOOP_TELEMETRY, coreInstruments, withSpan, type Telemetry } from './telemetry';
import { ClaimRate, DEFAULT_PRIORITY, PRIORITIES, defaultPriority, isPriority, lowerPriority, priorityRank, type JobPriority } from './priority';
import { WebhookService, jobPayload, renderDedupeKey, renderOutcome, renderSummary, type NotificationProvider } from './webhooks/index';
import type { AuditEntry } from './repositories';
import type { JobEvent, JobUsage } from './jobs';
import { Analytics, type AnalyticsSummary } from './analytics';

export interface ServiceConfig {
  /**
   * Where state is persisted (projects, keys, jobs, themes, settings, asset
   * metadata, audit). @renderweld/db opens SQLite/PostgreSQL/MySQL ones;
   * createMemoryRepositories() keeps everything in memory (tests).
   */
  repositories: Repositories;
  /** Binary files: assets, renders, caches, the URL signing key. */
  dataDir: string;
  /** Engine bundle cache. Default <dataDir>/cache. */
  cacheDir?: string;
  renderConcurrency?: number;
  serverVersion?: string;
  /** Public base URL (e.g. https://studio.example.com) used in output links. */
  publicUrl?: string;
  maxUploadBytes?: number;
  fetchTimeoutMs?: number;
  /** Tests only: let add_asset_from_url reach http:// and private addresses. */
  allowInsecureFetchForTests?: boolean;
  /** fetch used by providers (injectable for tests). */
  fetch?: typeof fetch;
  /**
   * The environment object the providers were constructed with. Settings
   * stored through configure_provider are written into it, so providers see
   * them immediately. Defaults to a copy of process.env (then API-set keys
   * only reach providers that read this object).
   */
  providerEnv?: NodeJS.ProcessEnv;
  /** Lifetime of signed download links, seconds. Default 3600. */
  signedUrlTtlSeconds?: number;
  /**
   * Configuration file and environment (get_config / update_config and the
   * runtime layer stored in the database). Default: { env: providerEnv }.
   */
  configSources?: ConfigSources;
  /** Configuration warnings the caller already logged at start (the server does): not logged again, so each appears once (#412). */
  loggedConfigWarnings?: readonly string[];
  /**
   * Licence checks (D-028). The licence server URL, org id, mode and grace
   * period come from the configuration (licence.*); tests inject the API and
   * the clock here.
   */
  licence?: {
    /** Default: BuildBaseLicenceClient for licence.serverUrl / licence.orgId. */
    api?: LicenceApi;
    /** fetch for the default client. */
    fetch?: typeof fetch;
    now?: () => number;
    checkIntervalMs?: number;
    /** How often the stored licence state is re-read (default 60 s; tests shorten it). */
    refreshMs?: number;
    /** Run the first check and the daily schedule (default true). */
    start?: boolean;
  };
  /**
   * Storage driver (D-065): built from storage.* by `factory` (default
   * createStorageDriver; tests pass fakes). `sweep: false` turns the
   * scheduled retention sweep off.
   */
  storage?: { factory?: StorageFactory; sweep?: boolean };
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
  /** Where traces and metrics go (the server's observability settings, D-050). Default: nowhere. */
  telemetry?: Telemetry;
  /**
   * Audit sink plugins (a signed webhook, S3 export, ...). Built in: stdout and
   * otlp. `audit.sinks` selects which ones run; the database always does.
   */
  auditSinks?: AuditSink[];
  /** Run the hourly sweep (audit retention, expired idempotency keys). Default true. */
  maintenance?: boolean;
  /** Clock for key expiry, rotation grace, quotas and idempotency (tests inject one). Default Date.now. */
  now?: () => number;
  /** Outbound events (#66): notification provider plugins, and whether this process runs the delivery worker (default true; the CLI does not). */
  webhooks?: { providers?: NotificationProvider[]; worker?: boolean; pollMs?: number };
  /**
   * Job queue (D-075). Default: from server.role and queue.* (`database` for
   * the api and worker roles). Tests override single values (short leases).
   */
  queue?: { mode?: QueueMode } & DatabaseQueueOptions;
}

/** The queue mode for a role and queue.driver (D-075). */
export function effectiveQueueMode(role: 'all' | 'api' | 'worker', driver: 'auto' | 'inprocess' | 'database'): QueueMode {
  if (driver !== 'auto') return driver;
  return role === 'all' ? 'inprocess' : 'database';
}

/** Audit actions that are also outbound events (#66, D-070). */
const AUDIT_EVENTS: Record<string, string> = { 'key.create': 'key.created', 'key.revoke': 'key.revoked', 'config.update': 'config.changed' };
const JOB_EVENTS: Record<string, string> = { queued: 'job.queued', running: 'job.started', succeeded: 'job.succeeded', failed: 'job.failed', cancelled: 'job.cancelled' };

/** Most audit entries one MCP export returns (REST streams up to MAX_AUDIT_EXPORT). */
export const MAX_MCP_EXPORT = 10_000;

/** list_jobs filters (GET /v1/jobs?status=&type=). */
export const LIST_JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const LIST_JOB_TYPES = ['render', 'preview', 'render_unit', 'render_join'] as const;
/** Render and preview jobs count towards a key's render quota. */
const QUOTA_JOB_TYPES = ['render', 'preview'];
/** Validation errors for exceeded render limits start with this (a preview of some scenes is checked on its own). */
const RENDER_LIMIT_PREFIX = 'render limit: ';
/** validate_project errors about the output format (#302); a render checks its own target with unsupported_output instead. */
const OUTPUT_FORMAT_PREFIX = 'output format: ';
/** Prefix of validation errors about sizes and frame rates an engine cannot render (#287, #302). */
const UNSUPPORTED_OUTPUT_PREFIX = 'unsupported output: ';
const SWEEP_INTERVAL_MS = 3_600_000;
/** FFmpeg/ffprobe versions in get_capabilities are probed again this often (#319). */
const TOOL_VERSIONS_REFRESH_MS = 600_000;
const SETTINGS_REFRESH_MS = 15_000;

/** Who made a change (audit log). */
export interface Actor {
  actorType: 'api_key' | 'cli' | 'system';
  actorId?: string;
}

export interface ProviderSetting {
  name: string;
  set: boolean;
  /** Where the value comes from; the value itself is never returned. `workspace`: the calling workspace's own (#480). */
  source: 'api' | 'env' | 'file' | 'build' | 'workspace' | 'unset';
  /** A stored value that cannot be used (e.g. it cannot be decrypted with the current REELFORGE_SECRET_KEY). */
  error?: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationWarning[];
  migratedFrom: string | null;
  summary?: {
    scenes: number;
    totalFrames: number;
    durationSeconds: number;
    width: number;
    height: number;
    /** The manifest's rate: a number, or "30000/1001" style for NTSC rates (#302). */
    fps: FrameRate;
    engines: string[];
    /** Output variants (#287): one render each from render_project. */
    variants?: Array<{ id: string; width: number; height: number }>;
  };
  /** What the render would take on the manifest's backend (BackendEstimate), when that backend is installed. */
  estimate?: BackendEstimate;
}

export interface RenderSummary {
  renderId: string;
  projectId: string;
  kind: string;
  createdAt: string;
  durationSeconds: number;
  frames: number;
  width: number;
  height: number;
  /** Frames per second as a number (29.97002997 for 30000/1001). */
  fps: number;
  /** Output format (#302): container, codec, alpha, the delivered file and its content type. */
  format: string;
  codec: string;
  alpha: boolean;
  file: string;
  contentType: string;
  /** The exact rate of the output (ffprobe r_frame_rate), e.g. "30000/1001". Absent for renders made before #302. */
  frameRate?: string;
  files: string[];
  /** Needs `Authorization: Bearer <key>`. */
  outputUrl: string;
  /** Absent for audio-only renders (no pictures). */
  posterUrl?: string;
  manifestUrl: string;
  /** Works without a key until downloadUrlExpiresAt (signed, read-only, this file only). */
  downloadUrl: string;
  downloadUrlExpiresAt: string;
  /** "bucket": signed by the storage bucket (D-067); "server": a signed link to this server. */
  downloadVia: 'bucket' | 'server';
  /** When the files go under the workspace's retention (#487). */
  retention: RenderRetention;
  /** Present when the render had captions on (#300): whether they were burned in, the sidecar files and the quality check. */
  captions?: RenderCaptions;
  /** Where the files are: the storage driver and the render's key prefix in it (bucket and root: get_storage, admin). */
  storage: { driver: string; prefix: string };
  /** The render's audio (#301): what the file carries, the loudness preset, what was measured after the final encode, QA. */
  audio?: RenderAudio;
  /** Picture checks (#294, render.qa.*): frozen and black stretches, with the scenes they touch. Absent when off or audio-only. */
  videoQa?: VideoQaManifest;
  /**
   * The labelled contact sheet stored with the render (#379, render.contactSheet.*): its links and the frame of each
   * tile, in reading order. Absent when off, for audio-only output, when it could not be made and before #379.
   */
  contactSheet?: Omit<ContactSheetManifest, 'file'> & { file: typeof CONTACT_SHEET_FILE; url: string; downloadUrl: string; downloadUrlExpiresAt: string; downloadVia: 'bucket' | 'server' };
}

export interface RenderAudio {
  track: 'mixed' | 'silent' | 'none';
  /** Why there is no loudness normalisation or no audio at all, e.g. "muted", "gif has no audio" (#302). */
  reason?: string;
  /**
   * Which audio checks ran on the delivered file: A/V sync is skipped without
   * an audio stream (muted with mutedTrack "none", GIF, PNG sequence) and for
   * audio-only files (no video); loudness is skipped when nothing was normalised;
   * sfx (#459) is skipped when no sound effect plays over music or a voice.
   */
  checks: { avSync: 'pass' | 'skipped'; loudness: 'pass' | 'warn' | 'skipped'; sfx: 'pass' | 'warn' | 'skipped' };
  preset: string;
  target: { integrated: number; truePeak: number } | null;
  normalisation: 'linear' | 'limited' | 'dynamic' | 'none';
  measured: { integrated: number | null; truePeak: number | null; lra: number | null } | null;
  qa: { ok: boolean; issues: Array<{ rule: string; severity: 'warn' | 'fail'; message: string }> };
}

export interface RenderCaptions {
  mode: CaptionMode;
  burned: boolean;
  /** The language burned in (null: none, or a primary language without a tag). */
  burnLanguage: string | null;
  /** Primary language: cue count, source and tag. */
  cues: number;
  source: string;
  language: string | null;
  /** Every language rendered, the primary one first. */
  languages: Array<{ language: string | null; primary: boolean; burned: boolean; cues: number; descriptions: number; qaOk: boolean }>;
  /** Whether the captions were approved (update_captions approve: true) in the state they were rendered. */
  approved: boolean;
  /**
   * Sidecar files next to final.mp4: kind "captions" (SRT, WebVTT, ASS per language; modes sidecar and both) and
   * kind "descriptions" (WebVTT for <track kind="descriptions">; every mode but off).
   */
  files: Array<{ format: 'srt' | 'vtt' | 'ass'; kind: 'captions' | 'descriptions'; language: string | null; file: string; url: string; downloadUrl: string; downloadUrlExpiresAt: string }>;
  /** Quality rules of the primary language (docs/CAPTIONS.md#quality-rules): ok, and the problems found. */
  qa: { ok: boolean; maxCps: number; issues: Array<{ cue: number; rule: string; message: string }> };
}

/** get_render_output's `audio` from the render manifest's (renders made before #301 have none). */
function renderAudio(a: AudioManifest): RenderAudio {
  const t = a.loudness.target;
  return {
    track: a.track,
    ...(a.loudness.reason ? { reason: a.loudness.reason } : {}),
    checks: { avSync: a.avSync ? 'pass' : 'skipped', ...audioChecks(a) },
    preset: a.loudness.preset,
    target: t ? { integrated: t.integrated, truePeak: t.truePeakCeiling } : null,
    normalisation: a.loudness.normalisation,
    measured: a.loudness.measured ?? null,
    qa: { ok: a.qa?.ok ?? true, issues: a.qa?.issues ?? [] },
  };
}

const DEFAULT_MAX_UPLOAD = 200 * 1024 * 1024;

const ASSET_OF_OTHER_PROJECT = (id: string) =>
  `asset "${id}" belongs to another project: upload or import it with this projectId (the same bytes are stored once), or upload it without a projectId to share it with every project`;

/** Where an uploaded file goes (upload_asset, REST POST /v1/assets). */
export interface UploadOptions {
  filename?: string;
  contentType?: string;
  projectId?: string;
  assetId?: string;
  license?: StoredAsset['license'];
}

/**
 * Every capability of the product as plain async methods. REST routes and
 * MCP tools are thin wrappers over this class, so both always behave the same.
 */
/** How long deleting a project waits for its cancelled renders to stop before removing its files (#419). */
const DELETE_WAIT_MS = 15_000;

export class ReelforgeService {
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly projects: ProjectStore;
  readonly themes: ThemeStore;
  readonly assets: AssetStore;
  readonly keys: KeyStore;
  readonly jobs: JobRunner;
  /** Claims per second across the deployment, shared through the database (admission by estimated wait, D-103). */
  readonly claimRate: ClaimRate;
  readonly serverVersion: string;
  readonly publicUrl: string;
  /** Effective configuration: defaults < file < env < runtime settings in the database. */
  readonly settings: RuntimeConfig;
  readonly signer: UrlSigner;
  /** Licence activation state; renders are refused when it says so (D-028). */
  readonly licence: LicenceManager;
  readonly providerEnv: NodeJS.ProcessEnv;
  readonly repos: Repositories;
  /** The storage driver, local copies, retention and the sweep (D-065..D-068). */
  readonly storage: StorageManager;
  /** Append-only audit log: database plus the sinks selected by audit.sinks (D-055). */
  readonly auditLog: AuditLog;
  /** Outbound events: signed webhooks, chat and email channels, the outbox and its worker (#66). */
  readonly webhooks: WebhookService;
  /** Workspace management and per-workspace limits (#304); null when the repositories are bound to one workspace. */
  readonly workspaceAdmin: WorkspaceAdmin | null;
  private readonly workspaceStatusOf: (id: string) => Promise<WorkspaceStatus | null>;

  /** A workspace's status (active, suspended, deleted), or null when there is none by that id. Without workspace routing only the default exists. */
  workspaceStatus(id: string): Promise<WorkspaceStatus | null> {
    return this.workspaceStatusOf(id);
  }
  private progressBuckets = new Map<string, number>();
  private licenceSeen: { status: string; reason: string | null } | null = null;
  private licenceTimer: NodeJS.Timeout | null = null;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private sweepTimer: NodeJS.Timeout | null = null;
  private storageHealthCache: { at: number; value: { ok: boolean; reason?: string } } | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private builtinSinks = new Map<string, AuditSink>();
  /** The clock (ServiceConfig.now). */
  readonly now: () => number;
  private toolsCache: Tools | null = null;
  /** FFmpeg/ffprobe versions for capabilities(), probed off the request path (#319); null: not found (or not probed yet). */
  private toolVersions: { ffmpeg: string | null; ffprobe: string | null } = { ffmpeg: null, ffprobe: null };
  private toolVersionsProbe: Promise<{ ffmpeg: string | null; ffprobe: string | null }> | null = null;
  private toolVersionsTimer: NodeJS.Timeout | null = null;
  /** FFmpeg's encoders, asked with the tool versions (get_capabilities' outputFormats, #302); null until then. */
  private encoderSet: Set<string> | null = null;
  private activatingLicence = false;
  /** "<workspace>:<runId>" -> projectId (run ids are unique, the workspace keeps lookups inside the caller's, #304). */
  private renderIndex = new Map<string, string>();
  private rk(runId: string): string {
    return `${currentWorkspaceId()}:${runId}`;
  }
  private readonly fetchImpl: typeof fetch;
  readonly telemetry: Telemetry;

  private constructor(
    readonly registry: PluginRegistry,
    readonly config: ServiceConfig
  ) {
    this.dataDir = resolve(config.dataDir);
    this.cacheDir = resolve(config.cacheDir ?? join(this.dataDir, 'cache'));
    this.repos = config.repositories;
    this.telemetry = config.telemetry ?? NOOP_TELEMETRY;
    this.providerEnv = config.providerEnv ?? { ...process.env };
    this.baseEnv = { ...this.providerEnv };
    this.settings = new RuntimeConfig(this.repos, config.configSources ?? { env: { ...this.providerEnv } }, config.log);
    this.storage = new StorageManager({
      factory: config.storage?.factory ?? createStorageDriver,
      settings: this.settings,
      dataDir: this.dataDir,
      cacheDir: this.cacheDir,
      activeRunIds: () => this.activeRunIds(),
      ...(isWorkspaceRouter(config.repositories)
        ? {
            workspaces: () => (config.repositories as WorkspaceRouter).workspaceIds(),
            workspaceRetention: (ws: string) => this.workspaceRetention(ws),
          }
        : {}),
      onSweep: (r) => this.auditCleanup(r, { actorType: 'system' }).then(() => undefined),
      log: config.log,
    });
    this.projects = new ProjectStore(this.repos.projects, this.dataDir);
    this.themes = new ThemeStore(this.repos.themes);
    this.assets = new AssetStore(this.repos.assets, this.storage, {
      maxBytes: config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD,
      timeoutMs: config.fetchTimeoutMs ?? 30_000,
      maxRedirects: 3,
      allowInsecureForTests: config.allowInsecureFetchForTests,
      stagingDir: join(this.cacheDir, 'upload-staging'),
    });
    this.now = config.now ?? Date.now;
    this.auditLog = new AuditLog(this.repos.audit, { log: config.log });
    const router = isWorkspaceRouter(this.repos) ? this.repos : null;
    this.keys = new KeyStore(this.repos.keys, {
      now: this.now,
      ...(router ? { workspaceStatus: async (id: string) => (await router.workspace(id))?.status ?? null } : {}),
      audit: (e) => this.audit(e),
      rotationGraceHours: () => this.settings.current.config.keys.rotationGraceHours,
    });
    this.workspaceStatusOf = router ? async (id: string) => (await router.workspace(id))?.status ?? null : async (id: string) => (id === DEFAULT_WORKSPACE_ID ? 'active' : null);
    this.workspaceAdmin = router
      ? new WorkspaceAdmin({ repos: router, keys: this.keys, settings: this.settings, storage: this.storage, dataDir: this.dataDir, audit: (e) => this.audit(e), now: this.now, log: config.log })
      : null;
    this.serverVersion = config.serverVersion ?? '0.1.0';
    this.publicUrl = (config.publicUrl ?? '').replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? fetch;
    this.webhooks = new WebhookService({
      repo: this.repos.webhooks,
      settings: this.settings,
      providers: config.webhooks?.providers,
      fetch: this.fetchImpl,
      log: config.log,
      telemetry: this.telemetry,
      now: this.now,
      publicUrl: this.publicUrl || undefined,
      audit: (e) => this.audit(e),
      pollMs: config.webhooks?.pollMs,
    });
    const cfg = this.settings.current.config;
    const queueMode = config.queue?.mode ?? effectiveQueueMode(cfg.server.role, cfg.queue.driver);
    // Several instances must verify each other's signed links: derive the key from REELFORGE_SECRET_KEY when it is set.
    this.signer = new UrlSigner(this.dataDir, queueMode === 'database' ? cfg.security.secretKey : undefined);
    const workerId = config.queue?.workerId ?? defaultWorkerId();
    this.licence = createLicenceManager(this.settings, this.repos, {
      api: config.licence?.api,
      fetch: config.licence?.fetch,
      now: config.licence?.now,
      checkIntervalMs: config.licence?.checkIntervalMs,
      refreshMs: config.licence?.refreshMs,
      log: config.log,
      // D-098: only api/all instances call the licence server (single flight per deployment); a worker reads the stored state.
      readOnly: cfg.server.role === 'worker',
      instanceName: workerId,
      dataDir: this.dataDir,
    });
    this.claimRate = new ClaimRate(this.repos.rateLimits, { now: this.now, log: (line) => config.log?.('warn', line) });
    this.jobs = new JobRunner({
      repo: this.repos.jobs,
      concurrency: cfg.server.workerConcurrency ?? config.renderConcurrency ?? 1,
      handlers: {
        render: (ctx) => this.runRenderJob(ctx),
        preview: (ctx) => this.runRenderJob(ctx),
        // Render fan-out (D-097): only ever queued by a fanned-out render on the database queue.
        [UNIT_JOB_TYPE]: (ctx) => renderUnit(this.fanOutDeps(), ctx),
        [JOIN_JOB_TYPE]: (ctx) => this.runRenderJoin(ctx),
      },
      telemetry: this.telemetry,
      mode: queueMode,
      database: {
        runJobs: cfg.server.role !== 'api',
        leaseMs: cfg.queue.leaseSeconds * 1000,
        maxAttempts: cfg.queue.maxAttempts,
        pollMs: cfg.queue.pollIntervalMs,
        pollMaxMs: cfg.queue.pollMaxIntervalMs,
        // Renders would only fail while the bucket is down: wait instead of burning attempts.
        // A worker also claims nothing while the stored licence state disallows renders (D-098; the enqueue gate stays).
        canClaim: async () => {
          const lic = this.licence.report();
          if (!lic.renderAllowed) return { ok: false, reason: `the licence does not allow renders (${lic.status}${lic.reason ? `, ${lic.reason}` : ''}): ${lic.message}` };
          return this.storageReady();
        },
        ...config.queue,
        // Queue dispatch (D-105): the listener (claiming roles with `notify`) comes from the server, which owns the database.
        dispatch: {
          driver: cfg.queue.dispatch,
          fallbackMs: cfg.queue.dispatchFallbackSeconds * 1000,
          // A broker message goes to one worker: no herd to spread, so no wait before its claim.
          jitterMs: cfg.queue.dispatch === 'notify' ? cfg.queue.notifyJitterMs : 0,
          ...config.queue?.dispatch,
        },
        workerId,
      },
      log: (level, line) => config.log?.(level, line),
      maxRunningPerKey: () => this.settings.current.config.limits.maxRunningJobsPerKey,
      priorityAgingSeconds: () => this.settings.current.config.queue.priorityAgingSeconds,
      onClaim: () => this.claimRate.record(),
      timeoutSeconds: () => this.settings.current.config.render.timeoutSeconds,
    });
    if (!registry.listBackends().some((b) => b.id === 'local')) {
      registry.registerBackend(
        new LocalBackend(
          (req, ctx) => this.renderLocally(req, ctx),
          () => registry.listEngines().map((e) => e.id),
          () => registry.listEngines().filter((e) => e.capabilities?.().frameRanges).map((e) => e.id)
        )
      );
    }
  }

  static async create(registry: PluginRegistry, config: ServiceConfig): Promise<ReelforgeService> {
    const s = new ReelforgeService(registry, config);
    await mkdir(s.dataDir, { recursive: true });
    if (s.jobs.mode === 'inprocess') await s.jobs.init();
    await s.signer.init();
    await s.settings.load();
    const encrypted = await s.settings.encryptPlaintext();
    if (encrypted.length) {
      config.log?.('info', `encrypted ${encrypted.length} stored secret(s) with REELFORGE_SECRET_KEY: ${encrypted.join(', ')}`);
      await s.audit({ actorType: 'system', action: 'config.secrets.encrypt', data: { names: encrypted } });
    }
    const logged = new Set(config.loggedConfigWarnings ?? []);
    for (const w of s.settings.warnings()) if (!logged.has(w)) config.log?.('warn', w);
    // Storage needs the runtime layer: credentials may be encrypted settings in the database (D-066).
    await s.storage.init();
    s.settings.onChange((_r, keys) => {
      if (keys.some((k) => /^storage\.(s3|azure|gcs)\./.test(k))) {
        s.storage.reload().catch((e) => config.log?.('error', `storage: could not apply the new credentials: ${(e as Error).message}`));
      }
      if (keys.includes('storage.retention.sweepIntervalMinutes') && config.storage?.sweep !== false) s.storage.startSweeper();
    });
    if (config.storage?.sweep !== false) s.storage.startSweeper();
    s.applySettings(s.settings.current, null);
    s.settings.onChange((resolved, keys) => s.applySettings(resolved, keys));
    // The licence state is read now; the network check runs in the background (start-up never waits for it).
    await s.licence.init();
    s.settings.onChange((_r, keys) => {
      if (keys.includes('licence.key') && !s.activatingLicence) s.licence.keyChanged();
    });
    if (config.licence?.start !== false) s.licence.start();
    // Outbound events (#66): job state changes, licence state, and the outbox worker (pending deliveries resume).
    s.jobs.onEvent((e) => s.onJobEvent(e));
    s.watchLicence();
    s.licenceTimer = setInterval(() => s.watchLicence(), 30_000);
    s.licenceTimer.unref();
    if (config.webhooks?.worker !== false) s.webhooks.start();
    s.applyAuditSinks();
    s.settings.onChange((_r, keys) => {
      if (keys.some((k) => k.startsWith('audit.'))) s.applyAuditSinks();
    });
    if (s.jobs.mode === 'database') {
      // Several instances: a runtime setting changed on one (update_config) reaches the others within 15 s.
      s.refreshTimer = setInterval(() => {
        void s.settings.refresh().catch((e) => config.log?.('warn', `could not re-read runtime settings: ${(e as Error).message}`));
      }, SETTINGS_REFRESH_MS);
      s.refreshTimer.unref();
    }
    // Tool versions for get_capabilities: probed now with async processes (start-up waits for the
    // answer, the event loop does not), then every 10 minutes (#319).
    await s.refreshToolVersions();
    s.toolVersionsTimer = setInterval(() => void s.refreshToolVersions(), TOOL_VERSIONS_REFRESH_MS);
    s.toolVersionsTimer.unref();
    if (config.maintenance !== false) {
      // First sweep shortly after start (never delays it), then hourly.
      const run = () => void s.sweep().catch((e) => config.log?.('warn', `maintenance sweep failed: ${(e as Error).message}`));
      setTimeout(run, 5_000).unref();
      s.sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
      s.sweepTimer.unref();
    }
    // Database queue: claiming starts once storage and settings are ready.
    if (s.jobs.mode === 'database') await s.jobs.init();
    return s;
  }

  /** Select the audit sinks named in audit.sinks (built-in stdout/otlp or plugins). */
  private applyAuditSinks() {
    const cfg = this.settings.current.config.audit;
    const plugins = new Map((this.config.auditSinks ?? []).map((p) => [p.id, p]));
    const sinks: AuditSink[] = [];
    for (const id of new Set(cfg.sinks)) {
      if (id === 'database') continue;
      let sink = plugins.get(id) ?? this.builtinSinks.get(id);
      if (!sink && id === 'stdout') sink = new StdoutAuditSink();
      // Every audit entry as an `audit.entry` event to the endpoints that ask for it (signed webhook sink, #66).
      if (!sink && id === 'webhooks') sink = { id: 'webhooks', write: (entry) => this.webhooks.emit('audit.entry', { entry }) };
      if (!sink && id === 'otlp') {
        if (!cfg.otlpEndpoint) {
          this.config.log?.('warn', 'audit sink "otlp" is selected but audit.otlpEndpoint is not set; it is skipped');
          continue;
        }
        sink = new OtlpLogsAuditSink({ endpoint: cfg.otlpEndpoint, serviceVersion: this.serverVersion, fetch: this.fetchImpl, log: this.config.log });
      }
      if (!sink) {
        this.config.log?.('warn', `audit sink "${id}" is not installed (built in: stdout, otlp, webhooks); it is skipped`);
        continue;
      }
      // A changed OTLP endpoint needs a new sink.
      if (sink instanceof OtlpLogsAuditSink && (sink as unknown as { opts: { endpoint: string } }).opts.endpoint !== cfg.otlpEndpoint) {
        sink = new OtlpLogsAuditSink({ endpoint: cfg.otlpEndpoint!, serviceVersion: this.serverVersion, fetch: this.fetchImpl, log: this.config.log });
      }
      if (!plugins.has(id)) this.builtinSinks.set(id, sink);
      sinks.push(sink);
    }
    this.auditLog.setSinks(sinks);
  }

  /**
   * Maintenance: delete audit entries past audit.retentionDays and expired
   * idempotency keys. Runs hourly; `reelforge audit sweep` runs it on demand.
   */
  async sweep(now = this.now()) {
    const auditDeleted = await this.auditLog.sweep(this.settings.current.config.audit.retentionDays, now);
    const idempotencyDeleted = await this.repos.idempotency.deleteExpired(new Date(now).toISOString());
    await this.repos.rateLimits.deleteOlderThan(new Date(now - 3_600_000).toISOString());
    await this.repos.rateLimits.deleteOlderThan(new Date(now - 2 * 86_400_000).toISOString(), { usage: true });
    // Uploads left half-written by a crash (normally each is deleted when its request ends).
    for (const f of await readdir(this.assets.stagingDir).catch(() => [] as string[])) {
      const p = join(this.assets.stagingDir, f);
      const st = await stat(p).catch(() => null);
      if (st && st.mtimeMs < now - 86_400_000) await rm(p, { force: true });
    }
    const webhookDeliveriesDeleted = await this.webhooks.sweep(now);
    // Deleted workspaces whose grace period is over (#304).
    const workspacesPurged = (await this.workspaceAdmin?.purgeExpired()) ?? [];
    if (auditDeleted) {
      await this.audit({ actorType: 'system', action: 'audit.sweep', data: { deleted: auditDeleted, retentionDays: this.settings.current.config.audit.retentionDays } });
    }
    return { auditDeleted, idempotencyDeleted, webhookDeliveriesDeleted, workspacesPurged };
  }

  /** Stop timers and flush the audit sinks (server shutdown). */
  async stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.toolVersionsTimer) clearInterval(this.toolVersionsTimer);
    this.toolVersionsTimer = null;
    this.licence.stop();
    if (this.licenceTimer) clearInterval(this.licenceTimer);
    this.licenceTimer = null;
    this.storage.stopSweeper();
    // In-flight deliveries get a few seconds; the rest stay pending for the next start (#66).
    await this.webhooks.stop();
    await this.claimRate.flush();
    await this.auditLog.close();
  }

  /** Job state changes as outbound events; progress at most once per 10 % (#66). */
  private onJobEvent(e: JobEvent) {
    if (e.type === 'log') return;
    const job = e.job;
    // Fan-out units and joins are internal steps: subscribers hear about the render job (D-097).
    if (job.parentId) return;
    if (e.type === 'progress') {
      const bucket = Math.floor(job.progress.fraction * 10);
      if (bucket >= 10 || bucket <= (this.progressBuckets.get(job.id) ?? 0)) return;
      this.progressBuckets.set(job.id, bucket);
      this.webhooks.emit('job.progress', { job: jobPayload(job) });
      return;
    }
    const type = JOB_EVENTS[job.status];
    if (!type) return;
    this.webhooks.emit(type, { job: jobPayload(job) });
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') this.progressBuckets.delete(job.id);
    // One terminal render.* event per render or preview job, whatever the outcome (#306).
    const outcome = job.type === 'render' || job.type === 'preview' ? renderOutcome(job) : null;
    if (outcome) this.webhooks.emit(outcome, () => this.terminalPayload(job, e.usage), { dedupeKey: renderDedupeKey(job.id) });
  }

  /**
   * The payload of a terminal render event (#306): the render summary (ready) or the typed error and the last lines
   * of the job log (failed, timeout, qa_failed, blocked), timing, costs and links. Built only when an endpoint
   * listens; a read that fails leaves its field out rather than the event.
   */
  private async terminalPayload(job: JobRecord, usage?: JobUsage): Promise<Record<string, unknown>> {
    const seconds = (a?: string, b?: string) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 10) / 100) : undefined);
    const runId = (job.result?.renderId as string | undefined) ?? ((job.params as { runId?: unknown } | undefined)?.runId as string | undefined);
    const costs: Record<string, unknown> = {};
    if (usage?.cpuSeconds !== undefined) costs.cpuSeconds = usage.cpuSeconds;
    else costs.cpuUnavailable = usage?.cpuUnavailable ?? (job.pendingChildren !== undefined ? 'the render was split into units that ran on several workers (render.fanOut)' : 'the job did not run on a worker');
    if (job.status === 'succeeded' && job.projectId && runId) {
      try {
        const files = await this.storage.driver.list(renderPrefix(job.projectId, runId));
        costs.storageBytes = files.reduce((n, f) => n + f.bytes, 0);
        const out = files.find((f) => OUTPUT_FILE_PATTERN.test(f.key.slice(f.key.lastIndexOf('/') + 1)));
        if (out) costs.outputBytes = out.bytes;
      } catch (err) {
        this.config.log?.('warn', `render event of job ${job.id}: could not read the output size (${(err as Error).message})`);
      }
    }
    let logExcerpt: string[] | undefined;
    if (job.status === 'failed') {
      logExcerpt = await this.jobs
        .logs(job.id, 20)
        .then((lines) => lines.map((l) => (l.length > 300 ? `${l.slice(0, 297)}...` : l)))
        .catch(() => undefined);
    }
    const links = {
      job: this.url(`/v1/jobs/${job.id}`),
      logs: this.url(`/v1/jobs/${job.id}/logs`),
      ...(job.status === 'succeeded' && job.result ? { output: job.result.outputUrl, poster: job.result.posterUrl, manifest: job.result.manifestUrl } : {}),
    };
    return {
      ...(job.status === 'succeeded' ? renderSummary(job.result) : {}),
      jobId: job.id,
      kind: job.type,
      ...(job.projectId ? { projectId: job.projectId } : {}),
      ...(runId ? { renderId: runId } : {}),
      status: job.status,
      ...(job.error ? { error: job.error } : {}),
      ...(logExcerpt?.length ? { logExcerpt } : {}),
      timing: {
        queuedAt: job.createdAt,
        ...(job.startedAt ? { startedAt: job.startedAt } : {}),
        ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
        ...(seconds(job.createdAt, job.startedAt) !== undefined ? { queueSeconds: seconds(job.createdAt, job.startedAt) } : {}),
        ...(seconds(job.startedAt, job.finishedAt) !== undefined ? { renderSeconds: seconds(job.startedAt, job.finishedAt) } : {}),
      },
      costs,
      links,
    };
  }

  /** render.blocked for a render refused before it was queued (licence; moderation later), then the refusal is thrown on (#306). */
  private async renderGate(kind: string, projectId?: string, jobId?: string): Promise<void> {
    try {
      await this.licence.assertRenderAllowed();
    } catch (err) {
      if (err instanceof ApiError) {
        const lic = (err.details as { licence?: { status?: string; reason?: string } } | undefined)?.licence;
        this.webhooks.emit('render.blocked', {
          kind,
          ...(projectId ? { projectId } : {}),
          ...(jobId ? { retryOf: jobId } : {}),
          status: 'blocked',
          error: { code: err.code, message: err.message },
          ...(lic ? { licence: { status: lic.status, ...(lic.reason ? { reason: lic.reason } : {}) } } : {}),
          links: { licence: this.url('/v1/licence') },
        });
      }
      throw err;
    }
  }

  /** licence.state_changed when the status or reason changed (checked every 30 s and after activate/deactivate). */
  private watchLicence() {
    const r = this.licence.report();
    if (r.status === 'checking') return;
    const now = { status: r.status, reason: r.reason ?? null };
    const prev = this.licenceSeen;
    this.licenceSeen = now;
    if (!prev || (prev.status === now.status && prev.reason === now.reason)) return;
    this.webhooks.emit('licence.state_changed', { status: r.status, reason: now.reason, renderAllowed: r.renderAllowed, message: r.message, ...(r.fix ? { fix: r.fix } : {}), previous: prev });
  }

  /**
   * Run a create or render call at most once per idempotency key (D-057).
   * `request` is the operation's normalised arguments; REST and MCP pass the
   * same object, so they share keys. Without a key the call just runs.
   */
  async idempotent<T>(key: string | undefined, operation: IdempotentOperation, request: unknown, fn: () => Promise<T>): Promise<T> {
    if (key === undefined || key === null || key === '') return fn();
    const req = currentRequest();
    const { result, replayed } = await withIdempotency(
      this.repos.idempotency,
      { key, actorId: req?.auth?.keyId ?? 'anonymous', operation, request, ttlHours: this.settings.current.config.idempotency.ttlHours, now: this.now },
      fn
    );
    if (replayed && req) req.idempotentReplay = true;
    return result;
  }

  /**
   * Apply runtime-changeable settings to the running service. At start
   * (`keys` null) only values set at runtime are applied, so explicit
   * ServiceConfig values keep working; after a change, the new effective value.
   */
  private applySettings(resolved: ResolvedConfig, keys: string[] | null) {
    const use = (key: string) => (keys === null ? resolved.settings.get(key)?.source === 'runtime' : keys.includes(key));
    if (use('limits.renderConcurrency') && resolved.config.server.workerConcurrency === undefined) this.jobs.setConcurrency(resolved.config.limits.renderConcurrency);
    if (use('limits.maxUploadBytes')) this.assets.limits.maxBytes = resolved.config.limits.maxUploadBytes;
    if (keys?.includes('limits.maxRunningJobsPerKey')) this.jobs.wake();
    // Output format quality (#302): process-wide in the media pipeline, from every source at start and on each change.
    if (keys === null || keys.some((k) => k.startsWith('render.formats.'))) {
      const { gifMaxSeconds: _s, gifMaxBytes: _b, ...quality } = resolved.config.render.formats;
      setFormatSettings(quality);
    }
    // Encoder memory bounds (#307): process-wide in the media pipeline; from every source at start, so a file or
    // environment value applies too, and each change at once (the next encode uses it).
    if (keys === null || keys.includes('render.encoderThreads') || keys.includes('render.encoderLookahead'))
      setEncoderSettings({ threads: resolved.config.render.encoderThreads, lookahead: resolved.config.render.encoderLookahead });
    for (const [name, v] of Object.entries(this.settings.providerEnvOverlay())) {
      if (v !== undefined) this.providerEnv[name] = v;
      else if (this.baseEnv[name] !== undefined) this.providerEnv[name] = this.baseEnv[name];
      else delete this.providerEnv[name];
    }
  }

  tools(): Tools {
    if (!this.toolsCache) this.toolsCache = resolveTools();
    return this.toolsCache;
  }

  /**
   * Probe the FFmpeg and ffprobe versions with async child processes and keep
   * them for capabilities() (#319): at start-up, every 10 minutes, or on
   * demand. Concurrent calls share one probe. A request never starts a
   * process: get_capabilities used to run two synchronous ones per call,
   * which blocked the event loop for every client.
   */
  refreshToolVersions(): Promise<{ ffmpeg: string | null; ffprobe: string | null }> {
    this.toolVersionsProbe ??= (async () => {
      const tools = this.toolsCache ?? toolPaths();
      const [ffmpeg, ffprobe, encoders] = await Promise.all([toolVersionAsync(tools.ffmpeg), toolVersionAsync(tools.ffprobe), encodersOf(tools.ffmpeg)]);
      if (encoders.size) this.encoderSet = encoders;
      this.toolVersions = { ffmpeg, ffprobe };
      return this.toolVersions;
    })().finally(() => {
      this.toolVersionsProbe = null;
    });
    return this.toolVersionsProbe;
  }

  // ---- discovery ------------------------------------------------------------

  /** capabilities() with the providers as the calling workspace sees them (configured with its own or the shared settings, #480). */
  async capabilitiesFor(workspaceId = currentWorkspaceId()) {
    return { ...this.capabilities(), providers: await this.listProviders(workspaceId) };
  }

  /** What this server can do; `providers` as the instance sees them (capabilitiesFor gives a workspace's view). */
  capabilities() {
    const providers = this.registry.listProviders().map((p) => ({
      id: p.id,
      kind: p.kind,
      displayName: p.displayName,
      configured: p.configured(),
      settingsFrom: 'instance' as 'workspace' | 'instance' | 'none',
      perWorkspace: Boolean(p.scopedSettings),
      costNote: p.costNote,
      env: p.env,
      settings: p.env.map((name) => this.instanceProviderSetting(name)),
    }));
    const engines = this.registry.listEngines();
    const sandboxOff = engines.filter((e) => e.browserSandbox?.() === false).map((e) => e.id);
    return {
      // `name` is the RenderWeld server name; `aliases` keeps the old one findable until phase 7 (#413, docs/RENAMED.md).
      server: { name: SERVER_NAME, title: PRODUCT_NAME, aliases: [...OLD_SERVER_NAMES], version: this.serverVersion, edition: this.settings.current.build.edition, mcpToolsStatus: 'experimental' },
      schemaVersion: SCHEMA_VERSION,
      supportedSchemaVersions: SUPPORTED_SCHEMA_VERSIONS,
      engines: engines.map((e) => {
        const a = e.availability();
        return {
          id: e.id,
          displayName: e.displayName,
          version: e.version(),
          available: a.ok,
          ...(a.reason ? { reason: a.reason } : {}),
          ...(e.browserSandbox ? { browserSandbox: e.browserSandbox() } : {}),
          acceptsSource: e.acceptsSource,
          // Whether a long scene of this engine can be split into frame ranges (render.fanOut: scenes+chunks).
          frameRanges: e.capabilities?.().frameRanges ?? false,
          // Whether it renders a transparent background (output.alpha, #302).
          alpha: e.capabilities?.().output?.alpha ?? false,
          // Frame rates it renders (#302): numbers, or "30000/1001" style for NTSC rates.
          frameRates: e.capabilities?.().output?.frameRates ?? SUPPORTED_FPS,
          templates: e.templates().map((t) => t.id),
        };
      }),
      templates: this.registry.templateInfos().map(({ propsSchema: _p, ...t }) => t),
      providers,
      backends: this.registry.listBackends().map((b) => ({
        id: b.id,
        displayName: b.displayName,
        kind: b.kind,
        configured: b.configured(),
        implemented: b.implemented,
        default: b.id === 'local',
        env: b.env,
        capabilities: b.capabilities(),
      })),
      captions: this.captionCapabilities(),
      outputFormats: this.outputFormatCapabilities(),
      storage: [{ id: this.storage.driver.id, active: true, downloads: this.storage.downloads }],
      limits: this.limitsSummary(),
      licence: this.licence.summary(),
      security: {
        chromiumSandbox: Object.fromEntries(engines.filter((e) => e.browserSandbox).map((e) => [e.id, e.browserSandbox!()])),
        ...(sandboxOff.length
          ? {
              warning:
                `Chromium runs without its own sandbox for: ${sandboxOff.join(', ')}. The container (non-root, read-only, no capabilities) is the isolation boundary.` +
                (sandboxOff.includes('remotion') ? ' Remotion always passes --no-sandbox.' : '') +
                (sandboxOff.some((id) => id !== 'remotion')
                  ? ' REELFORGE_CHROMIUM_NO_SANDBOX=1 is an explicit opt-out: to sandbox html, hyperframes and motion-canvas, unset it and run the container with the seccomp profile deployment/seccomp/chrome.json (docs/security/HARDENING.md).'
                  : ''),
            }
          : {}),
      },
      versions: {
        node: process.version,
        // Probed at start-up and every 10 minutes, never on this request path (#319).
        ...this.toolVersions,
      },
      workflow: [
        'list_templates and list_themes to see what exists',
        'create_project with a manifest (schemaVersion "0.2"; "0.1" is migrated)',
        'edit with add_scene / update_scene / set_theme / set_audio; validate_project after edits',
        'captions (optional): transcribe_captions or generate_voice for timings, then get_captions, show the user, update_captions (approve: true) before render_project',
        'render_project, then get_job with waitSeconds: 45 until succeeded, then get_render_output',
        'renders need a valid licence: if licence.renderAllowed is false, get_licence says what the user must do',
      ],
    };
  }

  /**
   * Output formats (#302): each format's codecs, whether this server's FFmpeg can encode them (null until the
   * encoders have been probed, at start-up), which keep alpha, and the formats' limits.
   */
  outputFormatCapabilities() {
    const enc = this.encoderSet;
    const f = this.settings.current.config.render.formats;
    return {
      formats: OUTPUT_FORMATS.map((format) => ({
        format,
        file: OUTPUT_FILES[format],
        codecs: FORMAT_CODECS[format].map((codec) => {
          const spec = { format, codec, alpha: false } as FormatSpec;
          const missing = enc && format !== 'mp4' ? missingEncoders(planFor(spec, enc), enc) : [];
          return { codec, alpha: ALPHA_CODECS.includes(codec), available: format === 'mp4' ? true : enc ? missing.length === 0 : null, ...(missing.length ? { missing } : {}) };
        }),
      })),
      notOffered: { hevc: 'HEVC/H.265 is not offered: its patent pools license encoders in products that are sold (D-123)' },
      limits: { gifMaxSeconds: f.gifMaxSeconds, gifMaxBytes: f.gifMaxBytes, gifMaxSide: f.gifMaxSide, gifFps: f.gifFps, pngSequenceMaxFrames: MAX_ZIP_ENTRIES },
      previews: 'previews are always H.264 MP4',
    };
  }

  /** Every limit an agent may run into, with the effective values (get_capabilities; D-090, D-091). */
  limitsSummary() {
    const l = this.settings.current.config.limits;
    const off = (n: number) => (n > 0 ? n : null);
    return {
      maxProjectSeconds: Math.min(MAX_PROJECT_SECONDS, l.maxRenderSeconds),
      maxScenes: l.maxScenes,
      /** Shortest scene (html source and layout templates; other templates have their own minSeconds), and the length under which validation warns (#450). */
      minSceneFrames: MIN_SCENE_FRAMES,
      shortSceneWarnSeconds: SHORT_SCENE_WARN_SECONDS,
      maxRenderFrames: l.maxRenderFrames,
      maxRenderDimension: l.maxRenderDimension,
      maxRenderFps: l.maxRenderFps,
      supportedFps: SUPPORTED_FPS.filter((f) => fpsValue(f) <= l.maxRenderFps),
      defaultOutput: DEFAULT_OUTPUT,
      maxUploadBytes: this.assets.limits.maxBytes,
      maxHtmlBytes: MAX_SOURCE_BYTES,
      renderConcurrency: this.jobs.concurrency,
      sceneTimeoutSeconds: this.settings.current.config.render.sceneTimeoutSeconds,
      /** null: no limit. */
      jobs: {
        maxQueuedJobsPerKey: off(l.maxQueuedJobsPerKey),
        maxQueuedJobs: off(l.maxQueuedJobs),
        maxRunningJobsPerKey: off(l.maxRunningJobsPerKey),
        /** Admission control (D-103): starts are refused with 429 queue_full when the estimated queue wait is longer. */
        maxEstimatedWaitSeconds: off(l.maxEstimatedWaitSeconds),
      },
      /** Job priorities (D-103): claimed in this order; `priority` on render_project / preview_scene, up to the key's maximum. */
      priority: {
        classes: [...PRIORITIES],
        defaults: { ...DEFAULT_PRIORITY },
        maxForThisKey: { render: this.maxPriorityFor('render'), preview: this.maxPriorityFor('preview') },
        batchAgingSeconds: off(this.settings.current.config.queue.priorityAgingSeconds),
      },
      providers: { runsPerKeyPerDay: off(l.providerRunsPerKeyPerDay), runsPerDay: off(l.providerRunsPerDay) },
      rateLimitPerMinute: off(l.rateLimitPerMinute),
    };
  }

  /**
   * A request refused by a resource limit: count it (bounded `reason` label)
   * and write one audit entry for the call (result "denied"). Never throws.
   */
  async recordLimitRejection(reason: LimitReason, data: Record<string, unknown> = {}) {
    coreInstruments(this.telemetry.meter).limitRejections.add(1, { 'reelforge.limit.reason': reason });
    const auth = currentRequest()?.auth;
    try {
      await this.audit({
        actorType: auth ? 'api_key' : 'system',
        ...(auth ? { actorId: auth.keyId } : {}),
        action: 'limit.rejected',
        result: 'denied',
        data: { reason, ...data },
      });
    } catch (e) {
      this.config.log?.('warn', `audit write for a limit rejection failed: ${(e as Error).message}`);
    }
  }

  projectSchema() {
    return projectJsonSchema();
  }

  listTemplates(engine?: string) {
    return this.registry.templateInfos(engine);
  }

  // ---- themes ---------------------------------------------------------------

  listThemes() {
    return this.themes.list();
  }
  getTheme(id: string) {
    return this.themes.get(id);
  }
  createTheme(input: unknown) {
    return this.themes.create(input);
  }
  putTheme(id: string, input: unknown) {
    return this.themes.put(id, input);
  }
  deleteTheme(id: string) {
    return this.themes.delete(id);
  }

  // ---- projects -------------------------------------------------------------

  /** Schema validation with the installed engines; throws invalid_manifest. */
  private parseOrThrow(input: unknown): { project: Project; warnings: ValidationWarning[]; migratedFrom: string | null } {
    const r = parseProject(input, { catalog: this.registry.catalog(), captionsDefaultMode: this.settings.current.config.captions.defaultMode });
    if (!r.ok) throw invalidManifest(r.issues);
    return r;
  }

  /**
   * One page of project summaries, newest created first (D-102): `limit`
   * (default 50, max 200) and `cursor` (nextCursor of the previous page).
   * nextCursor is null on the last page.
   */
  async listProjects(q: { limit?: unknown; cursor?: unknown } = {}) {
    const req = parsePageQuery('projects', '', q);
    const { items, nextCursor } = await readPage('projects', '', req, (r) => this.projects.page(r));
    return { projects: items, nextCursor };
  }

  async createProject(input: unknown) {
    const { project, warnings, migratedFrom } = this.parseOrThrow(input);
    const stored = await this.projects.create(project);
    return { ...stored, warnings, migratedFrom };
  }

  async getProject(id: string) {
    return this.projects.get(id);
  }

  /**
   * Update with a full manifest (body has `schemaVersion`) or a JSON merge
   * patch (anything else). Arrays are replaced by a merge patch; use the scene
   * methods to edit single scenes.
   */
  async updateProject(id: string, body: unknown, expectedVersion?: number) {
    if (!isPlainObject(body)) throw badRequest('body must be a JSON object: a full manifest or a JSON merge patch');
    let warnings: ValidationWarning[] = [];
    const stored = await this.projects.update(
      id,
      (current) => {
        const next = 'schemaVersion' in body ? body : applyMergePatch(current, body);
        const r = this.parseOrThrow(next);
        warnings = r.warnings;
        return r.project;
      },
      expectedVersion
    );
    return { ...stored, warnings };
  }

  async deleteProject(id: string) {
    // Listed before the delete: get_frames' cached stills of these renders go too.
    const runs = await this.storage.renders.listRuns(id).catch(() => []);
    await this.projects.delete(id);
    for (const [run, pid] of this.renderIndex) if (pid === id && run.startsWith(this.rk(''))) this.renderIndex.delete(run);
    // Its queued and running renders and previews stop (#419): a render that finished after the delete would
    // otherwise write its files back into the deleted project. One that finishes anyway removes them again.
    const stopping: string[] = [];
    for (const status of ['queued', 'running'] as const) {
      for (const job of await this.jobs.list({ projectId: id, status })) {
        await this.jobs.cancel(job.id).then(() => stopping.push(job.id), () => undefined);
      }
    }
    // A cancelled render stops within a moment here (a heartbeat on another worker); then its folder goes too.
    await Promise.all(stopping.map((jobId) => this.jobs.waitFor(jobId, DELETE_WAIT_MS).catch(() => undefined)));
    await this.removeProjectFiles(id);
    for (const run of runs) await rm(framesCacheDir(this.cacheDir, run.runId), { recursive: true, force: true });
  }

  /** What is left of a deleted project: its local folder, or its renders in remote storage (manifests first). */
  private async removeProjectFiles(id: string) {
    await rm(this.projects.dir(id), { recursive: true, force: true, maxRetries: 3 });
    if (this.storage.isLocal) return;
    const objects = await this.storage.driver.list(`${PROJECTS_PREFIX}${id}/`);
    const order = [...objects.filter((o) => o.key.endsWith(`/${RENDER_MANIFEST}`)), ...objects.filter((o) => !o.key.endsWith(`/${RENDER_MANIFEST}`))];
    for (const o of order) await this.storage.driver.delete(o.key);
  }

  /**
   * A render or preview that finished after its project was deleted (#419): its files are removed again and the
   * job fails with not_found, so a deleted project never comes back on disk or in the bucket.
   */
  private async failIfProjectDeleted(projectId: string, runId: string, log: (line: string) => void) {
    const deleted = await this.projects.get(projectId).then(
      () => false,
      (e: unknown) => e instanceof ApiError && e.status === 404
    );
    if (!deleted) return;
    this.renderIndex.delete(this.rk(runId));
    await this.removeProjectFiles(projectId);
    log(`project "${projectId}" was deleted while this job ran; its output was removed`);
    throw notFound('project', projectId);
  }

  async listProjectVersions(id: string) {
    await this.projects.get(id);
    return this.projects.listVersions(id);
  }

  /** Validate an arbitrary manifest without storing it. */
  async validateManifest(input: unknown, projectId: string | null = null): Promise<ValidationReport> {
    const r = parseProject(input, { catalog: this.registry.catalog(), captionsDefaultMode: this.settings.current.config.captions.defaultMode });
    if (!r.ok) return { ok: false, errors: r.issues, warnings: [], migratedFrom: null };
    const deep = await this.deepChecks(r.project, projectId);
    const errors = deep.errors;
    for (const v of renderLimitViolations(r.project, this.settings.current.config.limits)) {
      errors.push({ path: v.limit.endsWith('Dimension') || v.limit.endsWith('Fps') ? 'output' : 'scenes', message: RENDER_LIMIT_PREFIX + v.message });
    }
    r.project.variants?.forEach((variant, i) => {
      for (const v of renderLimitViolations(withVariant(r.project, variant.id), this.settings.current.config.limits)) {
        if (v.limit.endsWith('Dimension')) errors.push({ path: `variants.${i}`, message: RENDER_LIMIT_PREFIX + v.message });
      }
    });
    // Output formats this server cannot render (#302): engines without alpha, missing encoders, audio-only without audio, ...
    for (const issue of await this.formatIssues(r.project)) errors.push({ path: issue.path, message: OUTPUT_FORMAT_PREFIX + issue.message });
    // Sizes and frame rates the engines cannot render (codec rules, engine limits; #287, #302).
    for (const o of outputSupportIssues(r.project, this.registry)) errors.push({ path: o.path, message: UNSUPPORTED_OUTPUT_PREFIX + o.message });
    const estimate = this.estimateOn(r.project.render.backend, { kind: 'render', project: r.project });
    return {
      ok: errors.length === 0,
      errors,
      warnings: [...r.warnings, ...deep.warnings],
      migratedFrom: r.migratedFrom,
      summary: {
        scenes: r.project.scenes.length,
        totalFrames: totalFrames(r.project),
        durationSeconds: framesToSeconds(totalFrames(r.project), r.project.output.fps),
        width: r.project.output.width,
        height: r.project.output.height,
        fps: r.project.output.fps,
        ...formatSpec(r.project.output),
        engines: [...new Set(r.project.scenes.map((s) => s.engine))],
        ...(r.project.variants ? { variants: r.project.variants.map((v) => ({ id: v.id, width: v.width, height: v.height, ...formatSpec(withVariant(r.project, v.id).output) })) } : {}),
      },
      ...(estimate ? { estimate } : {}),
    };
  }

  /** The backend's estimate for a render, or undefined for an unknown backend (reported by validation) or a failing plugin. */
  private estimateOn(backendId: string, req: EstimateRequest): BackendEstimate | undefined {
    try {
      return this.registry.backend(backendId).estimate(req);
    } catch {
      return undefined;
    }
  }

  async validateProject(id: string): Promise<ValidationReport> {
    const { manifest } = await this.projects.get(id);
    return this.validateManifest(manifest, id);
  }

  /** Checks that need the server: theme exists, backend usable, engines available, asset files present. */
  private async deepChecks(p: Project, projectId: string | null): Promise<{ errors: ValidationIssue[]; warnings: ValidationWarning[] }> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationWarning[] = [];
    let theme: ThemeTokens | null = null;
    try {
      theme = await this.themes.resolve(p.theme);
    } catch (e) {
      // The list is only a hint (it may come from a lagging or unreachable read replica, D-104): never let it replace the real error.
      const available = await this.themes.list().then((l) => l.map((t) => t.id).join(', '), () => 'unknown (list_themes failed)');
      errors.push({ path: 'theme', message: (e as Error).message + `; available: ${available}` });
    }
    try {
      const b = this.registry.backend(p.render.backend);
      if (!b.configured()) errors.push({ path: 'render.backend', message: `backend "${b.id}" is not configured on this server (set ${b.env.join(', ')})` });
      else if (!b.implemented) errors.push({ path: 'render.backend', message: `backend "${b.id}" is not implemented in this version; use "local"` });
      else {
        // What the backend can render (D-100): its engines, and its longest unit when it cannot split a scene.
        const cap = b.capabilities();
        p.scenes.forEach((s, i) => {
          if (!cap.engines.includes(s.engine)) errors.push({ path: `scenes.${i}.engine`, message: `backend "${b.id}" cannot render engine "${s.engine}" (it renders: ${cap.engines.join(', ') || 'none'})` });
          const seconds = framesToSeconds(sceneFrames(s, p.output.fps), p.output.fps);
          if (cap.maxUnitSeconds !== null && !cap.frameRanges && seconds > cap.maxUnitSeconds) {
            errors.push({ path: `scenes.${i}`, message: `scene "${s.id}" is ${seconds} s; backend "${b.id}" renders at most ${cap.maxUnitSeconds} s per scene` });
          }
        });
      }
    } catch (e) {
      errors.push({ path: 'render.backend', message: (e as Error).message });
    }
    const seen = new Set<string>();
    p.scenes.forEach((s, i) => {
      if (seen.has(s.engine)) return;
      seen.add(s.engine);
      try {
        const a = this.registry.engine(s.engine).availability();
        if (!a.ok) errors.push({ path: `scenes.${i}.engine`, message: `engine "${s.engine}" cannot render on this server: ${a.reason}` });
      } catch {
        // unknown engines are already reported by schema validation
      }
    });
    // The burned caption font (#447): a project font asset, a bundled font or an installed family; else say what libass draws instead.
    const fontFamiliesInProject: string[] = [];
    for (const [i, a] of p.assets.entries()) {
      if (a.mediaType === 'font' && a.uri.startsWith('asset://')) {
        const family = ((await this.assets.find(a.uri.slice('asset://'.length)))?.metadata as { font?: { family?: string } } | undefined)?.font?.family;
        if (family) fontFamiliesInProject.push(family);
      }
      if (a.uri.startsWith('https://')) {
        errors.push({ path: `assets.${i}.uri`, message: `asset "${a.id}" has not been imported; call add_asset_from_url with this URL` });
      } else if (a.uri.startsWith('asset://')) {
        const stored = await this.assets.find(a.uri.slice('asset://'.length));
        if (!stored) {
          errors.push({ path: `assets.${i}.uri`, message: `asset "${a.id}" (${a.uri}) is not in the asset store` });
        } else if (projectId !== null && !assetUsableBy(stored, projectId)) {
          errors.push({ path: `assets.${i}.uri`, message: ASSET_OF_OTHER_PROJECT(a.id) });
        }
      } else if (a.uri.startsWith('project://')) {
        if (projectId === null) {
          warnings.push({ path: `assets.${i}.uri`, message: `project:// asset "${a.id}" is checked when the project is saved` });
        } else if (!existsSync(this.projectFile(projectId, a.uri))) {
          errors.push({ path: `assets.${i}.uri`, message: `file for asset "${a.id}" not found in the project's assets/ folder` });
        }
      }
    }
    const captionMode = resolveCaptions(p, { defaultMode: this.settings.current.config.captions.defaultMode }).mode;
    if (theme && (captionMode === 'burned' || captionMode === 'both')) {
      const choice = captionFontChoice(captionFontList(p, theme), fontFamiliesInProject);
      if (choice.source === 'fallback' || choice.family.toLowerCase() !== choice.requested.toLowerCase()) {
        warnings.push({
          path: p.captions.style?.fontFamily ? 'captions.style.fontFamily' : 'theme',
          message: `burned captions: font "${choice.requested}" is not a font asset of this project, a bundled font (${BUNDLED_FONTS.map((f) => f.family).join(', ')}) or installed; they use "${choice.family}" instead. Upload the font with upload_asset (projectId) and add it to the manifest's assets`,
        });
      }
    }
    return { errors, warnings };
  }

  private projectFile(projectId: string, uri: string): string {
    const relPath = uri.slice('project://'.length);
    if (!isSafeRelativePath(relPath)) throw badRequest(`unsafe project path ${uri}`);
    const base = this.projects.assetsDir(projectId);
    const p = resolve(base, relPath);
    if (!p.startsWith(base + sep)) throw badRequest(`unsafe project path ${uri}`);
    return p;
  }

  // ---- scenes ---------------------------------------------------------------

  private static stripStartFrames(p: Record<string, unknown>) {
    const scenes = p.scenes as Array<Record<string, unknown>>;
    for (const s of scenes) delete s.startFrame;
  }

  async addScene(id: string, scene: unknown, opts: { index?: number; expectedVersion?: number } = {}) {
    if (!isPlainObject(scene)) throw badRequest('scene must be an object');
    let warnings: ValidationWarning[] = [];
    const stored = await this.projects.update(
      id,
      (current) => {
        const next = structuredClone(current) as unknown as Record<string, unknown>;
        const scenes = next.scenes as unknown[];
        const index = opts.index === undefined ? scenes.length : Math.max(0, Math.min(scenes.length, opts.index));
        scenes.splice(index, 0, structuredClone(scene));
        ReelforgeService.stripStartFrames(next);
        const r = this.parseOrThrow(next);
        warnings = r.warnings;
        return r.project;
      },
      opts.expectedVersion
    );
    return { ...stored, warnings };
  }

  async updateScene(id: string, sceneId: string, patch: unknown, expectedVersion?: number) {
    if (!isPlainObject(patch)) throw badRequest('patch must be an object (JSON merge patch of the scene)');
    let warnings: ValidationWarning[] = [];
    const stored = await this.projects.update(
      id,
      (current) => {
        const next = structuredClone(current) as unknown as Record<string, unknown>;
        const scenes = next.scenes as Array<Record<string, unknown>>;
        const i = scenes.findIndex((s) => s.id === sceneId);
        if (i < 0) throw notFound('scene', sceneId, { scenes: scenes.map((s) => s.id) });
        const p = { ...patch };
        // Switching duration units: drop the other one so exactly one remains.
        if (p.durationSeconds !== undefined && p.durationSeconds !== null && p.durationFrames === undefined) p.durationFrames = null;
        if (p.durationFrames !== undefined && p.durationFrames !== null && p.durationSeconds === undefined) p.durationSeconds = null;
        if (p.html !== undefined && p.html !== null && p.template === undefined) p.template = null;
        if (p.template !== undefined && p.template !== null && p.html === undefined) {
          p.html = null;
          p.css = null;
        }
        // An engine change usually means new props.
        scenes[i] = applyMergePatch(scenes[i], p) as Record<string, unknown>;
        ReelforgeService.stripStartFrames(next);
        const r = this.parseOrThrow(next);
        warnings = r.warnings;
        return r.project;
      },
      expectedVersion
    );
    return { ...stored, warnings };
  }

  async removeScene(id: string, sceneId: string, expectedVersion?: number) {
    return this.projects.update(
      id,
      (current) => {
        const next = structuredClone(current) as unknown as Record<string, unknown>;
        const scenes = next.scenes as Array<Record<string, unknown>>;
        const i = scenes.findIndex((s) => s.id === sceneId);
        if (i < 0) throw notFound('scene', sceneId, { scenes: scenes.map((s) => s.id) });
        if (scenes.length === 1) throw badRequest('a project needs at least one scene; add another before removing this one');
        scenes.splice(i, 1);
        ReelforgeService.stripStartFrames(next);
        return this.parseOrThrow(next).project;
      },
      expectedVersion
    );
  }

  async reorderScenes(id: string, order: unknown, expectedVersion?: number) {
    if (!Array.isArray(order) || !order.every((x) => typeof x === 'string')) throw badRequest('order must be an array of scene ids');
    return this.projects.update(
      id,
      (current) => {
        const ids = current.scenes.map((s) => s.id);
        if (order.length !== ids.length || new Set(order).size !== order.length || !order.every((o) => ids.includes(o))) {
          throw badRequest('order must list every scene id exactly once', { scenes: ids });
        }
        const next = structuredClone(current) as unknown as Record<string, unknown>;
        const byId = new Map((next.scenes as Array<Record<string, unknown>>).map((s) => [s.id as string, s]));
        next.scenes = order.map((o) => byId.get(o)!);
        ReelforgeService.stripStartFrames(next);
        return this.parseOrThrow(next).project;
      },
      expectedVersion
    );
  }

  async setTheme(id: string, theme: unknown, expectedVersion?: number) {
    if (typeof theme === 'string') await this.themes.get(theme);
    else if (isPlainObject(theme)) await this.themes.get(typeof theme.base === 'string' ? theme.base : 'default');
    else throw badRequest('theme must be a theme id or { base, tokens }');
    return this.projects.update(id, (current) => this.parseOrThrow({ ...current, theme }).project, expectedVersion);
  }

  async setAudio(id: string, audioPatch: unknown, expectedVersion?: number) {
    if (!isPlainObject(audioPatch)) throw badRequest('audio must be an object');
    return this.projects.update(
      id,
      (current) => {
        const audio = applyMergePatch(current.audio, audioPatch) as Record<string, unknown>;
        // A different voice asset makes the old word timestamps wrong: drop them unless the patch brings new ones.
        const v = isPlainObject(audioPatch.voice) ? audioPatch.voice : undefined;
        if (v && 'asset' in v && !('words' in v) && v.asset !== current.audio.voice?.asset && isPlainObject(audio.voice)) delete audio.voice.words;
        return this.parseOrThrow({ ...current, audio }).project;
      },
      expectedVersion
    );
  }

  /**
   * Import SubRip or WebVTT captions (#300): parse them into cues and store them
   * as the project's `captions.cues` (replacing any). Optionally set the mode
   * and language. Unknown format, a bad timestamp or a cue that ends before it
   * starts is a 422 with the line number.
   */
  async importCaptions(id: string, input: { content?: unknown; format?: unknown; mode?: unknown; language?: unknown }, expectedVersion?: number) {
    if (typeof input.content !== 'string' || !input.content.trim()) throw badRequest('content must be the text of an SRT or WebVTT file');
    if (input.content.length > 1_000_000) throw badRequest('content is larger than 1 MB');
    if (input.format !== undefined && input.format !== 'srt' && input.format !== 'vtt') throw badRequest('format must be "srt" or "vtt" (or omitted to detect it)');
    let cues: CaptionCue[];
    try {
      cues = parseCaptions(input.content, input.format as 'srt' | 'vtt' | undefined);
    } catch (e) {
      if (e instanceof CaptionParseError) throw new ApiError('invalid_captions', 422, `the captions could not be parsed: ${e.message}`, { line: e.line });
      throw e;
    }
    if (!cues.length) throw new ApiError('invalid_captions', 422, 'the file has no cues');
    const patch: Record<string, unknown> = { cues };
    if (input.mode !== undefined) patch.mode = input.mode;
    if (input.language !== undefined) patch.language = input.language;
    const r = await this.projects.update(id, (current) => this.parseOrThrow({ ...current, captions: { ...current.captions, ...patch } }).project, expectedVersion);
    return { ...r, imported: cues.length };
  }

  // ---- caption approval and speech-to-text (#300, D-114) --------------------

  /** The effective speech-to-text settings (captions.stt.*). */
  sttSettings(): SttSettings & { provider: string } {
    const s = this.settings.current.config.captions.stt;
    return { provider: s.provider, command: s.command, model: s.model, ...(s.modelDir ? { modelDir: s.modelDir } : {}), language: s.language, computeType: s.computeType, device: s.device, timeoutSeconds: s.timeoutSeconds };
  }

  /** What get_capabilities says about captions: modes, the server default, languages, and whether speech-to-text can run here. */
  captionCapabilities() {
    const s = this.sttSettings();
    const providers = this.registry.listStt().map((p) => {
      const a = p.availability(s);
      return { id: p.id, displayName: p.displayName, available: a.ok, ...(a.reason ? { reason: a.reason } : {}) };
    });
    const selected = providers.find((p) => p.id === s.provider);
    return {
      modes: [...CAPTION_MODES],
      defaultMode: this.settings.current.config.captions.defaultMode,
      maxLanguages: MAX_CAPTION_LANGUAGES,
      languages: 'BCP 47 tags: the primary language (captions.cues) plus captions.tracks; one is burned (captions.burnLanguage), each gets sidecars',
      descriptions: 'cues with kind "description": a WebVTT sidecar for <track kind="descriptions">, never burned',
      stt: {
        available: selected?.available ?? false,
        provider: s.provider,
        ...(selected ? (selected.available ? {} : { reason: selected.reason }) : { reason: `speech-to-text provider "${s.provider}" is not installed; installed: ${providers.map((p) => p.id).join(', ') || '(none)'}` }),
        model: s.model,
        language: s.language,
        computeType: s.computeType,
        device: s.device,
        providers,
      },
    };
  }

  /**
   * get_captions: the cues of every language (or one), their quality check,
   * the etag update_captions needs and the approval state, for a project; for
   * a render (renderId), the cues as they were rendered.
   */
  async getCaptions(input: { projectId: string; language?: string }): Promise<ProjectCaptionsView>;
  async getCaptions(input: { renderId: string; language?: string }): Promise<RenderCaptionsView>;
  async getCaptions(input: unknown): Promise<ProjectCaptionsView | RenderCaptionsView>;
  async getCaptions(input: unknown): Promise<ProjectCaptionsView | RenderCaptionsView> {
    const q = parseInput(getCaptionsInput, input, 'get_captions arguments');
    if (q.renderId) {
      const { projectId } = await this.findRender(q.renderId);
      const m = await this.storage.renders.readManifest<{ captions?: CaptionManifest; project?: Project }>(projectId, q.renderId);
      if (!m) throw notFound('render', q.renderId);
      return renderCaptionsView(q.renderId, projectId, m, q.language);
    }
    const { manifest, meta } = await this.projects.get(q.projectId!);
    return projectCaptionsView(manifest, meta.version, this.settings.current.config.captions.defaultMode, q.language);
  }

  /**
   * update_captions: edit or replace the cues of one language, set the mode,
   * burn language and highlight, and approve, refused with captions_conflict
   * when the captions changed since get_captions (etag). The quality rules run
   * again (returned), and the change is written to the audit log.
   */
  async updateCaptions(id: string, input: unknown, expectedVersion?: number) {
    const u = parseInput(updateCaptionsInput, input, 'update_captions arguments');
    const defaultMode = this.settings.current.config.captions.defaultMode;
    let change: ReturnType<typeof applyCaptionUpdate> | undefined;
    const stored = await this.projects.update(
      id,
      (current) => {
        change = applyCaptionUpdate(current, u, defaultMode);
        let next = this.parseOrThrow({ ...current, captions: change.captions }).project;
        if (u.approve) {
          const etag = captionsEtag(next, resolveCaptions(next, { defaultMode }));
          next = this.parseOrThrow({ ...next, captions: { ...next.captions, approval: { etag, approvedAt: new Date(this.now()).toISOString() } } }).project;
        }
        return next;
      },
      expectedVersion
    );
    const view = projectCaptionsView(stored.manifest, stored.meta.version, defaultMode);
    const auth = currentRequest()?.auth;
    await this.audit({
      actorType: auth ? 'api_key' : 'system',
      ...(auth ? { actorId: auth.keyId } : {}),
      action: u.approve ? 'captions.approve' : 'captions.update',
      targetType: 'project',
      targetId: id,
      data: {
        language: change!.language,
        ...(change!.cues !== undefined ? { cues: change!.cues } : {}),
        ...(u.edits?.length ? { edits: u.edits.length } : {}),
        ...(u.mode ? { mode: u.mode } : {}),
        ...(u.approve !== undefined ? { approved: u.approve } : {}),
        etagBefore: change!.etagBefore,
        etag: view.etag,
        version: stored.meta.version,
      },
    });
    return view;
  }

  private sttRunning = 0;

  /**
   * transcribe_captions: speech-to-text of the project's voice track with the
   * configured local provider (captions.stt.*). The words are stored on
   * audio.voice.words (relative to the voice start, like TTS timestamps), so
   * the primary language's cues are built from them by buildCuesFromWords
   * unless manual caption cues exist (replaceCues removes those). One
   * transcription at a time per server process; results are cached by file
   * content and settings.
   */
  async transcribeCaptions(id: string, input: unknown, expectedVersion?: number) {
    const t = parseInput(transcribeInput, input, 'transcribe_captions arguments');
    // The project first (#304): a project of another workspace is not found, whatever this server's speech-to-text.
    const { manifest } = await this.projects.get(id);
    const s = this.sttSettings();
    const plugin = this.registry.stt(t.provider ?? s.provider);
    const available = plugin.availability(s);
    if (!available.ok) throw new ApiError('stt_unavailable', 409, `speech-to-text is not available on this server: ${available.reason}`);
    const voice = manifest.audio.voice;
    if (!voice?.asset) {
      throw new ApiError('no_voice_track', 409, 'the project has no voice track to transcribe: upload the voice-over (upload_asset with projectId and assetId "voice"), set_audio { voice: { asset: "voice" } }, then call again');
    }
    const asset = manifest.assets.find((a) => a.id === voice.asset);
    // Only files of the asset store or the project's own folder, resolved the same way as for a render.
    const file = (await this.resolveAssets({ ...manifest, assets: asset ? [asset] : [] }, id)).get(voice.asset)?.file;
    if (!file) throw new ApiError('asset_missing', 422, `voice asset "${voice.asset}" is not in the project's assets`);
    const language = t.language ?? s.language;
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    const key = createHash('sha256').update(JSON.stringify([plugin.id, hash.digest('hex'), s.model, s.computeType, s.device, language])).digest('hex');
    const cacheFile = join(this.cacheDir, 'stt', `${key}.json`);
    type Cached = { language: string | null; words: Array<{ text: string; start: number; end: number }>; durationSeconds?: number; engine: Record<string, string> };
    let result = existsSync(cacheFile) ? await readJson<Cached>(cacheFile).catch(() => null) : null;
    const cached = result !== null;
    if (!result) {
      if (this.sttRunning >= 1) throw new ApiError('stt_busy', 429, 'another transcription is running on this server; retry in a minute', { retryAfterSeconds: 30 });
      this.sttRunning++;
      try {
        const logs: string[] = [];
        result = await withSpan(this.telemetry.tracer, `stt.transcribe ${plugin.id}`, { 'reelforge.stt.provider': plugin.id }, () =>
          plugin.transcribe({ file, language, settings: s }, { signal: AbortSignal.timeout((s.timeoutSeconds + 5) * 1000), log: (l) => logs.push(l) })
        );
        await writeJsonAtomic(cacheFile, result);
      } finally {
        this.sttRunning--;
      }
    }
    const words = voiceWords(result.words);
    const detected = result.language && isLanguageTag(result.language) ? result.language : null;
    let manualCues = 0;
    const stored = await this.projects.update(
      id,
      (current) => {
        if (current.audio.voice?.asset !== voice.asset) throw new ApiError('conflict', 409, 'the voice track changed while it was transcribed; call transcribe_captions again');
        const captions: Record<string, unknown> = { ...current.captions };
        const own = splitCueKinds(current.captions.cues ?? []);
        if (t.replaceCues) {
          if (own.descriptions.length) captions.cues = own.descriptions;
          else delete captions.cues;
        } else manualCues = own.captions.length;
        if (!current.captions.language && (t.language && t.language !== 'auto' ? t.language : detected)) captions.language = t.language && t.language !== 'auto' ? t.language : detected;
        const voiceTrack: Record<string, unknown> = { ...current.audio.voice };
        if (words.length) voiceTrack.words = words;
        else delete voiceTrack.words;
        return this.parseOrThrow({ ...current, audio: { ...current.audio, voice: voiceTrack }, captions }).project;
      },
      expectedVersion
    );
    const view = projectCaptionsView(stored.manifest, stored.meta.version, this.settings.current.config.captions.defaultMode);
    return {
      provider: plugin.id,
      engine: result.engine,
      detectedLanguage: result.language,
      words: words.length,
      ...(result.durationSeconds !== undefined ? { durationSeconds: result.durationSeconds } : {}),
      cached,
      ...(manualCues ? { note: `captions.cues has ${manualCues} manual caption cue(s), which take precedence over the voice; call again with replaceCues: true to show the transcription` } : {}),
      ...(words.length ? {} : { note: 'no speech was recognised in the voice track' }),
      captions: view,
    };
  }

  // ---- renders --------------------------------------------------------------

  /** One render at `output`, or (with `variant`) at one of the project's output variants. */
  async startRender(id: string, opts: { backend?: string; priority?: unknown; captions?: unknown; audio?: unknown; variant?: string } = {}): Promise<JobRecord> {
    const captions = this.parseCaptionOverride(opts.captions);
    const audio = this.parseAudioOverride(opts.audio);
    return this.enqueueRender(id, 'render', opts.priority, opts.backend, undefined, undefined, { captions, audio, variant: opts.variant });
  }

  /** render_project's `audio` override (#298, #301): { mute, voice, music, sfx, loudness }, validated before anything is queued. */
  private parseAudioOverride(value: unknown): RenderAudioOptions | undefined {
    if (value === undefined || value === null) return undefined;
    const r = renderAudioOptions.safeParse(value);
    if (!r.success) throw badRequest(`audio: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
    return Object.keys(r.data).length ? r.data : undefined;
  }

  /** render_project's `captions` override, validated before anything is queued. */
  private parseCaptionOverride(value: unknown): CaptionMode | undefined {
    if (value === undefined || value === null) return undefined;
    const m = captionMode.safeParse(value);
    if (!m.success) throw badRequest(`captions must be one of ${CAPTION_MODES.join(', ')}`);
    return m.data;
  }

  /**
   * render_project (#287): a project without `variants`, or a call naming one
   * `variant`, starts one render (`{ job }`). A project with variants starts
   * one render per variant, each its own job and run id, grouped by a batch id
   * (`{ job, jobs, batchId }`, `job` being the first). Every variant is checked
   * against the render limits before any job is queued; if the queue refuses
   * one of them (quota, queue caps), the jobs already queued for the batch are
   * cancelled and the refusal is returned.
   */
  async renderProject(id: string, opts: { backend?: string; priority?: unknown; variant?: unknown; captions?: unknown; audio?: unknown } = {}): Promise<{ job: JobRecord; jobs?: JobRecord[]; batchId?: string }> {
    if (opts.variant !== undefined && typeof opts.variant !== 'string') throw badRequest('variant must be the id of one of the project\'s variants');
    const { manifest } = await this.projects.get(id);
    const variants = manifest.variants ?? [];
    if (opts.variant !== undefined || variants.length === 0) {
      return { job: await this.startRender(id, { backend: opts.backend, priority: opts.priority, captions: opts.captions, audio: opts.audio, ...(opts.variant ? { variant: opts.variant } : {}) }) };
    }
    // The same refusals as one render, before anything is queued: priority, licence, then every variant's limits.
    const captions = this.parseCaptionOverride(opts.captions);
    const audio = this.parseAudioOverride(opts.audio);
    this.resolvePriority('render', opts.priority);
    await this.renderGate('render', id);
    this.refuseUnsupportedOutput(manifest);
    const violations = variants.flatMap((v) =>
      renderLimitViolations(withVariant(manifest, v.id), this.settings.current.config.limits).map((x) => ({ ...x, message: `variant "${v.id}": ${x.message}` }))
    );
    if (violations.length) await this.refuseRenderLimits(violations, id);
    // Every variant's output format (#302), before any job is queued.
    const formatProblems = (await this.formatIssues(manifest, { captions })).filter((i) => i.variant !== null);
    if (formatProblems.length) this.refuseOutputFormat(formatProblems);
    const batchId = newId('bat');
    const jobs: JobRecord[] = [];
    try {
      for (const v of variants) jobs.push(await this.enqueueRender(id, 'render', opts.priority, opts.backend, undefined, undefined, { captions, audio, variant: v.id, batchId }));
    } catch (e) {
      for (const j of jobs) await this.jobs.cancel(j.id).catch(() => undefined);
      throw e;
    }
    return { job: jobs[0]!, jobs, batchId };
  }

  /**
   * Why this server cannot render the project's output format (#302): engines without alpha, encoders its FFmpeg
   * lacks, audio-only without audio or with burned captions, GIF and zip limits. Asks FFmpeg (once, cached) only
   * when an output or variant is not MP4.
   */
  private async formatIssues(p: Project, opts: { variant?: string | null; captions?: CaptionMode } = {}): Promise<OutputFormatIssue[]> {
    const outputs = [p.output.format, ...(p.variants ?? []).map((v) => v.format ?? p.output.format)];
    if (outputs.every((f) => f === 'mp4')) return [];
    const ffmpeg = (this.toolsCache ?? toolPaths()).ffmpeg;
    const [encoders, assAlpha] = await Promise.all([encodersOf(ffmpeg), assHasAlpha(ffmpeg)]);
    const c = this.settings.current.config;
    return outputFormatIssues(
      p,
      this.registry,
      { encoders, assAlpha, gifMaxSeconds: c.render.formats.gifMaxSeconds, ...(opts.captions ? { captionsMode: opts.captions } : {}), captionsDefault: c.captions.defaultMode },
      opts.variant === undefined ? {} : { variant: opts.variant }
    );
  }

  /** `422 unsupported_output`: the output format cannot be rendered here (details.issues: path, variant, engine, message). */
  private refuseOutputFormat(issues: OutputFormatIssue[]): never {
    throw new ApiError('unsupported_output', 422, `this output cannot be rendered on this server: ${issues.map((i) => i.message).join('; ')}`, { issues });
  }

  /** A stored project version as a render sees it: at a variant's size when `variant` is set. */
  private async projectAsRendered(projectId: string, version: number, variant?: string): Promise<Project> {
    const project = await this.projects.getVersion(projectId, version);
    return variant ? withVariant(project, variant) : project;
  }

  /** A low-resolution preview of one scene (or all), at `output` or (with `variant`, #287) at one of the output variants. */
  async preview(id: string, opts: { sceneId?: string; scale?: number; priority?: unknown; variant?: unknown } = {}): Promise<JobRecord> {
    const scale = opts.scale ?? 1 / 3;
    if (!(scale > 0 && scale <= 1)) throw badRequest('scale must be > 0 and <= 1');
    if (opts.variant !== undefined && typeof opts.variant !== 'string') throw badRequest('variant must be the id of one of the project\'s variants');
    return this.enqueueRender(id, 'preview', opts.priority, undefined, opts.sceneId ? [opts.sceneId] : undefined, scale, opts.variant ? { variant: opts.variant } : {});
  }

  /** The highest class the calling key may use for a job type: its maxPriority, else the type's default (D-103). */
  private maxPriorityFor(type: string): JobPriority {
    const auth = currentRequest()?.auth;
    return auth?.maxPriority ?? defaultPriority(type);
  }

  /**
   * The class of a new render or preview (D-103): the requested one, which may not be higher than the key allows
   * (`403 priority_not_allowed`), or the type's default lowered to the key's maximum. Checked before any job exists.
   */
  private resolvePriority(type: string, requested: unknown): JobPriority {
    const max = this.maxPriorityFor(type);
    if (requested === undefined || requested === null) return lowerPriority(defaultPriority(type), max);
    if (!isPriority(requested)) throw badRequest(`priority must be one of ${PRIORITIES.join(', ')}`);
    if (priorityRank(requested) < priorityRank(max)) {
      throw new ApiError(
        'priority_not_allowed',
        403,
        `this API key may start ${type} jobs at priority "${max}" or lower, not "${requested}". Omit priority (the default is "${lowerPriority(defaultPriority(type), max)}"), or ask an admin to raise the key's maxPriority (update_key).`,
        { requested, maxPriority: max, setting: 'key.maxPriority' }
      );
    }
    return requested;
  }

  private async enqueueRender(id: string, kind: 'render' | 'preview', requestedPriority: unknown, backendOverride?: string, sceneIds?: string[], scale?: number, extra: { captions?: CaptionMode; audio?: RenderAudioOptions; variant?: string; batchId?: string } = {}) {
    const { captions, audio, variant, batchId } = extra;
    const priority = this.resolvePriority(kind, requestedPriority);
    await this.renderGate(kind, id);
    const { manifest: stored, meta } = await this.projects.get(id);
    if (variant !== undefined && !stored.variants?.some((v) => v.id === variant)) {
      throw notFound('variant', variant, { variants: (stored.variants ?? []).map((v) => v.id) });
    }
    const manifest = variant ? withVariant(stored, variant) : stored;
    if (sceneIds) {
      for (const s of sceneIds) {
        if (!manifest.scenes.some((x) => x.id === s)) throw notFound('scene', s, { scenes: manifest.scenes.map((x) => x.id) });
      }
    }
    this.refuseUnsupportedOutput(stored, variant ?? null);
    const violations = renderLimitViolations(manifest, this.settings.current.config.limits, { sceneIds, scale });
    if (violations.length) await this.refuseRenderLimits(violations, id);
    const report = await this.validateProject(id);
    const backendId = backendOverride ?? manifest.render.backend;
    const backend = this.registry.backend(backendId);
    if (!backend.configured()) {
      throw new ApiError('backend_not_configured', 409, `render backend "${backendId}" is not configured; set ${backend.env.join(', ')}`);
    }
    if (!backend.implemented) {
      throw new ApiError('not_implemented', 501, `render backend "${backendId}" is not implemented in v0.1; use backend "local"`);
    }
    // Limits, output support and the output format were checked above for what this job renders (one variant may be fine while another is not).
    const blocking = report.errors.filter(
      (e) => !(backendOverride && e.path === 'render.backend') && !e.message.startsWith(RENDER_LIMIT_PREFIX) && !e.message.startsWith(UNSUPPORTED_OUTPUT_PREFIX) && !e.message.startsWith(OUTPUT_FORMAT_PREFIX)
    );
    if (blocking.length) throw new ApiError('validation_failed', 422, 'fix these problems before rendering (see details.errors)', { errors: blocking, warnings: report.warnings });
    // The output format of this render (#302): output, or the one variant. Previews are always H.264 MP4.
    if (kind === 'render') {
      const formatProblems = await this.formatIssues(stored, { variant: variant ?? null, ...(captions ? { captions } : {}) });
      if (formatProblems.length) this.refuseOutputFormat(formatProblems);
    }
    const runId = newId(kind === 'preview' ? 'prv' : 'run');
    const captionsDefault = this.settings.current.config.captions.defaultMode;
    return this.withRenderQuota((apiKeyId, quota) =>
      this.jobs.submit(
        kind,
        {
          projectId: id,
          version: meta.version,
          backend: backendId,
          runId,
          ...(sceneIds ? { sceneIds } : {}),
          ...(scale ? { scale } : {}),
          ...(captions ? { captions } : {}),
          // The server default as it is now (captions.defaultMode), for projects without captions.mode.
          ...(captionsDefault !== 'off' ? { captionsDefault } : {}),
          ...(variant ? { variant } : {}),
          ...(batchId ? { batchId } : {}),
          ...(audio ? { audio } : {}),
        },
        { projectId: id, priority, ...(apiKeyId ? { apiKeyId } : {}) },
        quota
      ), priority
    );
  }

  /**
   * Start a render or preview job under the calling key's render quota
   * (rendersPerDay / rendersPerMonth, UTC). The count and the insert are one
   * database transaction that locks the key's row, so parallel calls on any
   * number of instances cannot overshoot (D-078).
   */
  private async withRenderQuota(
    submit: (apiKeyId?: string, quota?: { types: string[]; windows: QuotaWindow[] } & JobCaps) => Promise<JobRecord>,
    priority: JobPriority
  ): Promise<JobRecord> {
    // Workspace limits (#304, optional, unlimited by default): storage, then renders per day / month.
    const admin = this.workspaceAdmin;
    if (!admin) return this.withKeyRenderQuota(submit, priority);
    await admin.checkStorage();
    return admin.withRenderLimit(() => this.withKeyRenderQuota(submit, priority));
  }

  private async withKeyRenderQuota(
    submit: (apiKeyId?: string, quota?: { types: string[]; windows: QuotaWindow[] } & JobCaps) => Promise<JobRecord>,
    priority: JobPriority
  ): Promise<JobRecord> {
    const auth = currentRequest()?.auth;
    const l = this.settings.current.config.limits;
    // Admission by estimated wait (D-103): the measured claim throughput is read before the transaction (a cached
    // read of the shared counter); the queue ahead is counted in the cap statement itself.
    const maxWait = l.maxEstimatedWaitSeconds > 0 ? { seconds: l.maxEstimatedWaitSeconds, claimsPerSecond: await this.claimRate.perSecond(), now: new Date(this.now()).toISOString() } : undefined;
    const caps: JobCaps = {
      ...(l.maxQueuedJobsPerKey > 0 ? { maxActivePerKey: l.maxQueuedJobsPerKey } : {}),
      ...(l.maxQueuedJobs > 0 ? { maxQueuedTotal: l.maxQueuedJobs } : {}),
    };
    const keyId = auth && auth.keyId !== 'signed-url' ? auth.keyId : undefined;
    const capped = async (windows: QuotaWindow[]) => {
      try {
        const keyCaps = keyId ? caps : { ...(caps.maxQueuedTotal ? { maxQueuedTotal: caps.maxQueuedTotal } : {}) };
        return await submit(keyId, { types: QUOTA_JOB_TYPES, windows, ...keyCaps, ...(maxWait ? { maxEstimatedWait: maxWait } : {}) });
      } catch (e) {
        if (!(e instanceof JobCapReached)) throw e;
        if (e.cap === 'estimated_wait' && maxWait && e.wait) {
          const est = Math.ceil(e.wait.estimatedWaitSeconds);
          const oldest = Math.max(0, Math.round((Date.parse(maxWait.now) - Date.parse(e.wait.oldestQueuedAt)) / 1000));
          const claimsPerMinute = Math.round(maxWait.claimsPerSecond * 60 * 100) / 100;
          // Wait about as long as the estimate exceeds the limit: by then the jobs ahead that cause the excess have drained.
          const retryAfterSeconds = Math.min(3600, Math.max(JOB_CAP_RETRY_SECONDS, est - l.maxEstimatedWaitSeconds));
          await this.recordLimitRejection('queue_wait', { limit: 'limits.maxEstimatedWaitSeconds', max: l.maxEstimatedWaitSeconds, estimatedWaitSeconds: est, queuedAhead: e.used, priority });
          throw new ApiError(
            'queue_full',
            429,
            `the render queue is too long: a new ${priority} job would wait about ${est} s (limits.maxEstimatedWaitSeconds is ${l.maxEstimatedWaitSeconds}); ${e.used} job(s) of this priority or higher are waiting. Try again in ${retryAfterSeconds} s${priority === 'interactive' ? '' : ', or use a quick preview_scene meanwhile'}.`,
            {
              limit: 'limits.maxEstimatedWaitSeconds',
              max: l.maxEstimatedWaitSeconds,
              estimatedWaitSeconds: est,
              priority,
              queued: { ahead: e.used, oldestWaitingSeconds: oldest },
              claimsPerMinute,
              retryAfterSeconds,
            }
          );
        }
        if (e.cap === 'queued_total') {
          await this.recordLimitRejection('queue_full', { limit: 'limits.maxQueuedJobs', max: l.maxQueuedJobs, used: e.used });
          throw new ApiError('queue_full', 429, `the render queue is full: ${e.used} jobs are waiting (limits.maxQueuedJobs is ${l.maxQueuedJobs}). Try again in a minute.`, {
            limit: 'limits.maxQueuedJobs',
            max: l.maxQueuedJobs,
            used: e.used,
            retryAfterSeconds: JOB_CAP_RETRY_SECONDS,
          });
        }
        await this.recordLimitRejection('jobs_per_key', { limit: 'limits.maxQueuedJobsPerKey', max: l.maxQueuedJobsPerKey, used: e.used });
        throw new ApiError(
          'too_many_jobs',
          429,
          `this API key already has ${e.used} unfinished render or preview jobs (limits.maxQueuedJobsPerKey is ${l.maxQueuedJobsPerKey}). Wait for one to finish (get_job with waitSeconds) or cancel one, then start again.`,
          { limit: 'limits.maxQueuedJobsPerKey', max: l.maxQueuedJobsPerKey, used: e.used, retryAfterSeconds: JOB_CAP_RETRY_SECONDS }
        );
      }
    };
    if (!auth || !keyId) return capped([]);
    if (auth.rendersPerDay === undefined && auth.rendersPerMonth === undefined) return capped([]);
    const w = quotaWindows(this.now());
    const windows = (
      [
        ['day', auth.rendersPerDay, w.dayStart, w.dayEnd],
        ['month', auth.rendersPerMonth, w.monthStart, w.monthEnd],
      ] as const
    ).filter((x): x is readonly ['day' | 'month', number, string, string] => x[1] !== undefined);
    try {
      return await capped(windows.map(([, limit, since]) => ({ since, limit })));
    } catch (e) {
      if (!(e instanceof QuotaExceeded)) throw e;
      const [period, limit, , resetsAt] = windows[e.window]!;
      const used = e.used;
      await this.recordLimitRejection('render_quota', { period, max: limit, used });
      throw new ApiError('quota_exceeded', 429, `this API key may start ${limit} render${limit === 1 ? '' : 's'} per ${period} (renders and previews, UTC); ${used} used. The quota resets at ${resetsAt}.`, {
        period,
        limit,
        used,
        resetsAt,
        retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(resetsAt) - this.now()) / 1000)),
      });
    }
  }

  /** Refuse a render or preview that exceeds render limits (422, every exceeded limit named). */
  /**
   * Refuse, before anything is queued, a render whose size or frame rate an
   * engine of the project cannot render (#287, #302): `422 unsupported_output`
   * with each problem. `variant` checks only that variant (null: output);
   * omitted: output and every variant.
   */
  private refuseUnsupportedOutput(project: Project, variant?: string | null): void {
    const issues = outputSupportIssues(project, this.registry, variant === undefined ? {} : { variant });
    if (!issues.length) return;
    throw new ApiError('unsupported_output', 422, `this output cannot be rendered: ${issues.map((i) => i.message).join('; ')}. Choose another size or frame rate, or move the scenes to an engine that supports it.`, {
      issues: issues.map(({ path, engine, variant: v, message }) => ({ path, engine, variant: v, message })),
    });
  }

  private async refuseRenderLimits(violations: RenderLimitViolation[], projectId: string): Promise<never> {
    await this.recordLimitRejection('render_limit', { projectId, limits: violations.map((v) => ({ limit: v.limit, max: v.max, actual: v.actual })) });
    throw new ApiError('render_limit_exceeded', 422, `this render exceeds the server's limits: ${violations.map((v) => v.message).join('; ')}. Shorten the project, use fewer scenes or a smaller output, or ask the operator to raise the limit.`, {
      limits: violations.map(({ limit, max, actual }) => ({ limit, max, actual })),
    });
  }

  /** Whether renders can be stored now (remote storage health, cached 10 s); a worker does not claim jobs while not. */
  private async storageReady(): Promise<{ ok: boolean; reason?: string }> {
    if (this.storage.isLocal) return { ok: true };
    const c = this.storageHealthCache;
    if (c && Date.now() - c.at < 10_000) return c.value;
    const h = await this.storage.driver.health().catch((e: Error) => ({ ok: false, message: e.message }));
    const value = h.ok ? { ok: true } : { ok: false, reason: `storage (${this.storage.driver.id}) is unavailable: ${h.message ?? 'unknown error'}` };
    this.storageHealthCache = { at: Date.now(), value };
    return value;
  }

  /** What the fan-out unit and join steps need from the service (D-097). */
  private fanOutDeps(): FanOutDeps {
    return {
      storage: this.storage,
      registry: this.registry,
      tools: () => this.tools(),
      cacheDir: this.cacheDir,
      serverVersion: this.serverVersion,
      telemetry: this.telemetry,
      rendersDir: (pid) => this.projects.rendersDir(pid),
      project: (pid, version, variant) => this.projectAsRendered(pid, version, variant),
      theme: (project) => this.themes.resolve(project.theme),
      assets: (project, pid) => this.resolveAssets(project, pid),
      audioDefaults: () => this.settings.current.config.render.audio,
      videoQa: () => this.settings.current.config.render.qa,
      contactSheet: () => this.settings.current.config.render.contactSheet,
    };
  }

  /** How scenes+chunks splits long scenes on a backend: render.chunk* settings, frame-range engines only. */
  private chunkPolicy(backendId: string, fps: number): ChunkPolicy | null {
    const backend = this.registry.backend(backendId);
    if (!backend.capabilities().frameRanges) return null;
    const r = this.settings.current.config.render;
    return {
      chunkFrames: Math.max(1, Math.round(r.chunkSeconds * fps)),
      minSceneFrames: Math.max(2, Math.round(r.chunkMinSceneSeconds * fps)),
      canSplit: (scene) => {
        try {
          return this.registry.engine(scene.engine).capabilities?.().frameRanges === true;
        } catch {
          return false;
        }
      },
    };
  }

  /** `render_join`: stitch the units and commit the render; its result becomes the parent render job's. */
  private async runRenderJoin(ctx: JobContext): Promise<Record<string, unknown>> {
    const p = ctx.job.params as unknown as RenderJobParams;
    if (await this.storage.renders.exists(p.projectId, p.runId).catch(() => false)) {
      // Committed by an earlier attempt of this join (its worker died before recording it): finish with it.
      ctx.log(`render ${p.runId} was already committed by an earlier attempt; using it`);
    } else {
      await joinUnits(this.fanOutDeps(), ctx);
    }
    await this.failIfProjectDeleted(p.projectId, p.runId, ctx.log);
    this.renderIndex.set(this.rk(p.runId), p.projectId);
    return { ...(await this.getRender(p.runId)) };
  }

  private async runRenderJob(ctx: JobContext): Promise<Record<string, unknown>> {
    const p = ctx.job.params as unknown as RenderJobParams;
    if ((ctx.job.attempts ?? 1) > 1 && (await this.storage.renders.exists(p.projectId, p.runId).catch(() => false))) {
      // An earlier attempt committed the render, then its worker died before recording it: finish with that render.
      ctx.log(`render ${p.runId} was already committed by an earlier attempt; using it`);
      this.renderIndex.set(this.rk(p.runId), p.projectId);
      return { ...(await this.getRender(p.runId)) };
    }
    const project = await this.projectAsRendered(p.projectId, p.version, p.variant);
    // Fan-out (D-097, render.fanOut): one unit per scene (scenes+chunks: per chunk of a long scene whose engine renders
    // frame ranges) on any worker, then one join. Database queue, local backend, full renders of two or more units
    // only; everything else renders on this worker as before.
    const fanOut = this.settings.current.config.render.fanOut;
    // Other output formats (#302) render on one worker: the units' stream-copy join is H.264 MP4 only.
    if (ctx.fanOut && ctx.job.type === 'render' && p.backend === 'local' && !p.sceneIds?.length && fanOut !== 'off' && formatSpec(project.output).format === 'mp4') {
      const chunks = planChunks(project, fanOut === 'scenes+chunks' ? this.chunkPolicy(p.backend, fpsValue(project.output.fps)) : null);
      const specs = unitSpecs(p, project, chunks);
      if (specs.length > 1) {
        // The plan goes onto the render job (and so to its join) in the same write as the units.
        const units = await ctx.fanOut(specs, { chunks });
        const split = Object.keys(chunks).length;
        ctx.log(
          `render.fanOut = ${fanOut}: ${units.length} units queued (${split ? `${split} long scene(s) split into chunks of up to ${this.settings.current.config.render.chunkSeconds} s, the other scenes whole` : 'one per scene'}, longest first); the last one to finish queues the join`
        );
        return {};
      }
    }
    const backend = this.registry.backend(p.backend);
    const outcome = await backend.submit(
      {
        jobId: ctx.job.id,
        runId: p.runId,
        kind: ctx.job.type as 'render' | 'preview',
        project,
        projectVersion: p.version,
        sceneIds: p.sceneIds,
        scale: p.scale,
        ...(p.captions ? { captionsMode: p.captions } : {}),
        ...(p.audio ? { audio: p.audio } : {}),
        ...(p.captionsDefault ? { captionsDefault: p.captionsDefault } : {}),
      },
      { signal: ctx.signal, log: ctx.log, progress: ctx.progress }
    );
    await this.failIfProjectDeleted(p.projectId, outcome.runId, ctx.log);
    this.renderIndex.set(this.rk(outcome.runId), p.projectId);
    const summary = await this.getRender(outcome.runId);
    return { ...summary };
  }

  /** Assets of a project as local files. */
  async resolveAssets(project: Project, projectId: string): Promise<Map<string, ResolvedAsset>> {
    const map = new Map<string, ResolvedAsset>();
    for (const a of project.assets) {
      let file: string;
      if (a.uri.startsWith('asset://')) {
        const storeId = a.uri.slice('asset://'.length);
        // A project renders only its own assets and the workspace's shared ones (#299).
        if (!assetUsableBy(await this.assets.get(storeId), projectId)) throw new ApiError('asset_not_in_project', 422, ASSET_OF_OTHER_PROJECT(a.id));
        file = await this.assets.file(storeId);
      }
      else if (a.uri.startsWith('project://')) {
        file = this.projectFile(projectId, a.uri);
        // A symlink in the project's assets/ folder must not lead outside it (#299).
        const base = await realpath(this.projects.assetsDir(projectId)).catch(() => null);
        const real = await realpath(file).catch(() => null);
        if (base && real && !real.startsWith(base + sep)) throw new ApiError('asset_outside_project', 422, `file for asset "${a.id}" is outside the project's assets/ folder`);
      } else throw new ApiError('asset_not_imported', 422, `asset "${a.id}" is a remote URL; import it with add_asset_from_url first`);
      if (!existsSync(file)) throw new ApiError('asset_missing', 422, `file for asset "${a.id}" is missing`);
      map.set(a.id, { id: a.id, file, mediaType: a.mediaType, ...(a.contentType ? { contentType: a.contentType } : {}) });
    }
    return map;
  }

  private async renderLocally(req: RenderRequest, ctx: BackendContext): Promise<RenderOutcome> {
    const theme = await this.themes.resolve(req.project.theme);
    const assets = await this.resolveAssets(req.project, req.project.projectId);
    const pid = req.project.projectId;
    // Local storage: rendered in place and renamed (atomic). Remote: rendered in a staging
    // directory, then committed to the bucket through temporary keys (D-067).
    const local = this.storage.isLocal;
    const rendersDir = local ? this.projects.rendersDir(pid) : join(this.storage.stagingRoot, pid);
    const res = await runRenderPipeline({
      runId: req.runId,
      kind: req.kind,
      project: req.project,
      projectVersion: req.projectVersion,
      theme,
      assets,
      registry: this.registry,
      tools: this.tools(),
      rendersDir,
      cacheDir: this.cacheDir,
      sceneIds: req.sceneIds,
      scale: req.scale,
      serverVersion: this.serverVersion,
      signal: ctx.signal,
      log: ctx.log,
      progress: ctx.progress,
      telemetry: this.telemetry,
      ...(req.captionsMode ? { captionsMode: req.captionsMode } : {}),
      ...(req.audio ? { audio: req.audio } : {}),
      audioDefaults: this.settings.current.config.render.audio,
      videoQa: this.settings.current.config.render.qa,
      contactSheet: this.settings.current.config.render.contactSheet,
      ...(req.captionsDefault ? { captionsDefault: req.captionsDefault } : {}),
      gifMaxBytes: this.settings.current.config.render.formats.gifMaxBytes,
    });
    if (!local) {
      try {
        const up = await this.storage.renders.commit(res.dir, pid, res.runId);
        ctx.log(`stored: ${up.objects} files, ${up.bytes} bytes in ${this.storage.driver.id} storage`);
      } finally {
        await rm(res.dir, { recursive: true, force: true });
      }
    }
    return { runId: res.runId, dir: local ? res.dir : renderPrefix(pid, res.runId), outputFile: res.outputFile, manifestFile: res.manifestFile };
  }

  /** Run ids of queued and running renders (the retention sweep never touches them). */
  private async activeRunIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const status of ['queued', 'running'] as const) {
      for (const j of await this.jobs.list({ status })) {
        const runId = (j.params as { runId?: unknown } | undefined)?.runId;
        if (typeof runId === 'string') ids.add(runId);
      }
    }
    return ids;
  }

  async getJob(id: string) {
    const job = await this.jobs.get(id);
    const pos = await this.jobs.positionOf(job);
    return { ...job, ...(pos !== null ? { queuePosition: pos } : {}) };
  }
  /**
   * Like getJob, but waits up to `waitSeconds` (capped at MAX_JOB_WAIT_SECONDS)
   * for the job to finish. Returns the current state either way, so agents can
   * long-poll instead of calling get_job in a tight loop.
   */
  async waitForJob(id: string, waitSeconds = 0) {
    const secs = Math.min(Math.max(0, waitSeconds), MAX_JOB_WAIT_SECONDS);
    if (secs > 0) await this.jobs.waitFor(id, secs * 1000).catch(() => undefined);
    return this.getJob(id);
  }
  /**
   * One page of jobs, newest first (D-102; paged like listProjects), optionally of one project and/or the children
   * of one job (`parentId`: the units and the join of a fanned-out render, D-097). The cursor carries both filters.
   */
  async listJobs(filter: { projectId?: string; parentId?: string; status?: string; type?: string } = {}, q: { limit?: unknown; cursor?: unknown } = {}) {
    const projectId = filter.projectId || undefined;
    const parentId = filter.parentId || undefined;
    const status = filter.status || undefined;
    const type = filter.type || undefined;
    if (status !== undefined && !(LIST_JOB_STATUSES as readonly string[]).includes(status)) throw badRequest(`status must be one of ${LIST_JOB_STATUSES.join(', ')}`);
    if (type !== undefined && !(LIST_JOB_TYPES as readonly string[]).includes(type)) throw badRequest(`type must be one of ${LIST_JOB_TYPES.join(', ')}`);
    // The cursor's filter: the projectId alone as before (cursors of #182 stay valid); with parentId, both; a
    // status or type filter is added the same way ("|" cannot occur in a project id, so two filters never share a string).
    const key =
      (parentId === undefined ? (projectId ?? '') : `${projectId ?? ''}|parent:${parentId}`) + (status ? `|status:${status}` : '') + (type ? `|type:${type}` : '');
    const req = parsePageQuery('jobs', key, q);
    // No job can have an impossible id: answered without a query.
    if ((projectId !== undefined && !isProjectId(projectId)) || (parentId !== undefined && !isRowId(parentId))) return { jobs: [], nextCursor: null };
    const where = { ...(projectId ? { projectId } : {}), ...(parentId ? { parentId } : {}), ...(status ? { status: status as JobStatus } : {}), ...(type ? { type } : {}) };
    const { items, nextCursor } = await readPage('jobs', key, req, (r) => this.jobs.page(where, r));
    return { jobs: items, nextCursor };
  }
  cancelJob(id: string) {
    return this.jobs.cancel(id);
  }
  async retryJob(id: string) {
    const job = await this.getJob(id);
    if (job.type === 'render' || job.type === 'preview') {
      await this.renderGate(job.type, job.projectId, job.id);
      // The retry keeps the job's class, lowered to what the retrying key may use (D-103).
      const priority = lowerPriority(job.priority ?? defaultPriority(job.type), this.maxPriorityFor(job.type));
      return this.withRenderQuota((apiKeyId, quota) => this.jobs.retry(id, { priority, ...(apiKeyId ? { apiKeyId } : {}) }, quota), priority);
    }
    const apiKeyId = currentRequest()?.auth?.keyId;
    return this.jobs.retry(id, apiKeyId ? { apiKeyId } : {});
  }
  jobLogs(id: string, tail?: number) {
    return this.jobs.logs(id, tail);
  }

  private url(path: string) {
    return `${this.publicUrl}${path}`;
  }

  /**
   * The project of a render. The in-process index answers renders this instance has seen; otherwise (after a
   * restart, or a render made on another instance) the job that produced it names its project, read by run id from
   * this workspace's jobs (one indexed read, #184), and storage confirms the render is there. Never a scan of the
   * projects or of storage.
   */
  private async findRender(runId: string): Promise<{ projectId: string }> {
    if (!/^(run|prv)_[a-z0-9]+$/.test(runId)) throw notFound('render', runId);
    const pid = this.renderIndex.get(this.rk(runId)) ?? (await this.repos.jobs.projectOfRun(runId));
    if (pid && (await this.storage.renders.exists(pid, runId))) {
      this.renderIndex.set(this.rk(runId), pid);
      return { projectId: pid };
    }
    throw notFound('render', runId);
  }

  async getRender(runId: string): Promise<RenderSummary> {
    const { projectId } = await this.findRender(runId);
    const m = await this.storage.renders.readManifest<{
      kind: string;
      createdAt: string;
      output: { durationSeconds: number; frames: number; width: number; height: number; fps: number; frameRate?: string; file?: string; poster?: string; format?: string; codec?: string; alpha?: boolean };
      scenes: Array<{ file: string }>;
      captions?: CaptionManifest;
      audio?: Partial<AudioManifest>;
      videoQa?: VideoQaManifest;
      contactSheet?: ContactSheetManifest;
    }>(projectId, runId);
    if (!m) throw notFound('render', runId);
    const base = `/v1/renders/${runId}/output`;
    // The delivered file (#302); only names this server writes (the manifest is data, not a list of paths to serve).
    const outFile = m.output.file && OUTPUT_FILE_PATTERN.test(m.output.file) ? m.output.file : 'final.mp4';
    const poster = m.output.poster === undefined && outFile === 'final.mp4' ? 'poster.png' : m.output.poster === 'poster.png' ? 'poster.png' : null;
    let captions: RenderCaptions | undefined;
    if (m.captions) {
      const c = m.captions;
      // Renders before languages (#316) have only the primary language's files.
      const tracks = c.tracks ?? [{ language: c.language, primary: true, burned: c.burned, source: c.source, cues: [], descriptions: [], files: c.files, qa: c.qa }];
      const files: RenderCaptions['files'] = [];
      for (const t of tracks) {
        const names = captionFileNames(t.language, t.primary);
        const wanted = [
          ['srt', 'captions', t.files.srt, names.srt],
          ['vtt', 'captions', t.files.vtt, names.vtt],
          ['ass', 'captions', t.files.ass, names.ass],
          ['vtt', 'descriptions', t.files.descriptions, names.descriptions],
        ] as const;
        for (const [format, kind, file, expected] of wanted) {
          // Only the names this server writes: the manifest is data, not a list of paths to serve.
          if (!file || file !== expected || !CAPTION_FILE_PATTERN.test(file)) continue;
          const { downloadUrl, downloadUrlExpiresAt } = await this.downloadLink(projectId, runId, file);
          files.push({ format, kind, language: t.language, file, url: this.url(`${base}?file=${file}`), downloadUrl, downloadUrlExpiresAt });
        }
      }
      const { mode, burned, cues, source, language, qa } = c;
      captions = {
        mode,
        burned,
        burnLanguage: c.burnLanguage ?? (burned ? language : null),
        cues,
        source,
        language,
        languages: tracks.map((t) => ({ language: t.language, primary: t.primary, burned: t.burned, cues: c.tracks ? t.cues.length : cues, descriptions: t.descriptions.length, qaOk: t.qa.ok })),
        approved: c.approved ?? false,
        files,
        qa: { ok: qa.ok, maxCps: qa.maxCps, issues: qa.issues },
      };
    }
    // The stored contact sheet (#379): only the name this server writes.
    let contactSheet: RenderSummary['contactSheet'];
    if (m.contactSheet?.file === CONTACT_SHEET_FILE) {
      contactSheet = { ...m.contactSheet, file: CONTACT_SHEET_FILE, url: this.url(`${base}?file=${CONTACT_SHEET_FILE}`), ...(await this.downloadLink(projectId, runId, CONTACT_SHEET_FILE)) };
    }
    return {
      renderId: runId,
      projectId,
      kind: m.kind,
      createdAt: m.createdAt,
      durationSeconds: m.output.durationSeconds,
      frames: m.output.frames,
      width: m.output.width,
      height: m.output.height,
      fps: m.output.fps,
      format: m.output.format ?? 'mp4',
      codec: m.output.codec ?? 'h264',
      alpha: m.output.alpha ?? false,
      file: outFile,
      contentType: contentTypeFor(outFile),
      ...(m.output.frameRate ? { frameRate: m.output.frameRate } : {}),
      files: [outFile, ...(poster ? [poster] : []), ...(contactSheet ? [CONTACT_SHEET_FILE] : []), 'render-manifest.json', ...(captions?.files.map((f) => f.file) ?? []), ...m.scenes.map((s) => s.file)],
      outputUrl: this.url(outFile === 'final.mp4' ? base : `${base}?file=${outFile}`),
      ...(poster ? { posterUrl: this.url(`${base}?file=poster.png`) } : {}),
      manifestUrl: this.url(`${base}?file=render-manifest.json`),
      ...(await this.downloadLink(projectId, runId, outFile)),
      retention: await this.renderRetention(projectId, runId, m.createdAt),
      ...(captions ? { captions } : {}),
      ...(m.audio?.loudness && m.audio.track ? { audio: renderAudio(m.audio as AudioManifest) } : {}),
      ...(m.videoQa ? { videoQa: m.videoQa } : {}),
      ...(contactSheet ? { contactSheet } : {}),
      storage: { driver: this.storage.driver.id, prefix: renderPrefix(projectId, runId) },
    };
  }

  /** A workspace's own retention, from its limits (#487); undefined when it has none. */
  private async workspaceRetention(ws: string): Promise<WorkspaceRetention | undefined> {
    if (!isWorkspaceRouter(this.config.repositories)) return undefined;
    const l = (await this.config.repositories.workspace(ws))?.limits;
    if (!l || !(l.retentionMaxAgeHours || l.retentionKeepLast || l.retentionDeleteAfterDownloadMinutes)) return undefined;
    return {
      ...(l.retentionMaxAgeHours ? { maxAgeHours: l.retentionMaxAgeHours } : {}),
      ...(l.retentionKeepLast ? { keepLast: l.retentionKeepLast } : {}),
      ...(l.retentionDeleteAfterDownloadMinutes ? { deleteAfterDownloadMinutes: l.retentionDeleteAfterDownloadMinutes } : {}),
    };
  }

  /**
   * Record the first download of a render's output (#487), for delete-after-download and for get_render_output's
   * `retention.downloadedAt`. Called by the download route once the output is being sent; posters, manifests and
   * caption files do not count. Remembered per process so range requests do not stat storage each time.
   */
  async markDownloaded(runId: string, file: string): Promise<void> {
    if (!OUTPUT_FILE_PATTERN.test(file)) return;
    const memo = `${currentWorkspaceId()}:${runId}`;
    if (this.downloaded.has(memo)) return;
    const { projectId } = await this.findRender(runId);
    const at = await this.storage.renders.markDownloaded(projectId, runId, file, new Date(this.now()).toISOString());
    if (!at) return;
    if (this.downloaded.size > 10_000) this.downloaded.clear();
    this.downloaded.add(memo);
  }
  private readonly downloaded = new Set<string>();

  /** When the sweep will delete this render under its workspace's policy (#487), and when it was first downloaded. */
  private async renderRetention(projectId: string, runId: string, createdAt: string): Promise<RenderRetention> {
    const own = await this.workspaceRetention(currentWorkspaceId());
    const policy = workspacePolicy(this.storage.policy(), own);
    const downloadedAt = await this.storage.renders.downloadedAt(projectId, runId);
    const due = renderDeletesAt(policy, { createdAt, downloadedAt });
    return {
      downloadedAt,
      deletesAt: due?.at ?? null,
      ...(due ? { deleteReason: due.reason } : {}),
      ...(policy.deleteAfterDownloadMinutes ? { deleteAfterDownloadMinutes: policy.deleteAfterDownloadMinutes } : {}),
      ...(policy.keepLastRendersPerProject > 0 ? { keepLast: policy.keepLastRendersPerProject } : {}),
    };
  }

  /**
   * downloadUrl for a render file: signed by the bucket when the driver can
   * and storage.downloads allows it, else a signed link to this server (D-067).
   * A workspace that deletes renders after their first download gets server links (#487): only this server sees a
   * download, so a bucket link would never start the grace.
   */
  private async downloadLink(projectId: string, runId: string, file = 'final.mp4') {
    const ttl = this.config.signedUrlTtlSeconds ?? 3600;
    const tracked = Boolean((await this.workspaceRetention(currentWorkspaceId()))?.deleteAfterDownloadMinutes);
    const url = tracked ? null : await this.storage.bucketUrl(renderPrefix(projectId, runId) + file, ttl, { filename: file.split('/').pop(), contentType: contentTypeFor(file) });
    if (url) return { downloadUrl: url, downloadUrlExpiresAt: new Date(Date.now() + Math.min(ttl, 7 * 24 * 3600) * 1000).toISOString(), downloadVia: 'bucket' as const };
    return { ...this.signedDownload(runId, file, ttl), downloadVia: 'server' as const };
  }

  /** A time-limited link to one render file on this server that needs no API key. */
  signedDownload(runId: string, file = 'final.mp4', ttlSeconds = this.config.signedUrlTtlSeconds ?? 3600) {
    // The workspace is part of what is signed (#304): the link opens this render of this workspace and nothing else.
    const ws = currentWorkspaceId();
    const { expires, sig } = this.signer.sign(signedParts(ws, runId, file), ttlSeconds);
    const q = new URLSearchParams({ ...(file !== 'final.mp4' ? { file } : {}), ...(ws !== DEFAULT_WORKSPACE_ID ? { ws } : {}), expires: String(expires), sig });
    return { downloadUrl: this.url(`/v1/renders/${runId}/output?${q}`), downloadUrlExpiresAt: new Date(expires * 1000).toISOString() };
  }

  /** Check a signed link; `workspaceId` is its `ws` parameter (absent: the default workspace). */
  verifySignedDownload(runId: string, file: string, expires: number, sig: string, workspaceId: string = DEFAULT_WORKSPACE_ID): boolean {
    if (!WORKSPACE_ID.test(workspaceId)) return false;
    return this.signer.verify(signedParts(workspaceId, runId, file), expires, sig);
  }

  async getRenderManifest(runId: string): Promise<unknown> {
    const { projectId } = await this.findRender(runId);
    return this.storage.renders.readManifest(projectId, runId);
  }

  async listRenders(projectId: string): Promise<RenderSummary[]> {
    await this.projects.get(projectId);
    const out: RenderSummary[] = [];
    for (const run of (await this.storage.renders.listRuns(projectId)).filter((r) => r.complete)) {
      this.renderIndex.set(this.rk(run.runId), projectId);
      try {
        out.push(await this.getRender(run.runId));
      } catch {
        // incomplete or foreign directory
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * delete_render (DELETE /v1/renders/:id, write, #312): removes one finished render or preview with every file
   * (output, poster, captions, clips, manifest) from storage and from this instance's caches. Its job keeps its
   * history; get_render_output then answers not_found. Cannot be undone.
   */
  async deleteRender(runId: string): Promise<{ deleted: string; projectId: string; files: number }> {
    const { projectId } = await this.findRender(runId);
    const run = (await this.storage.renders.listRuns(projectId)).find((r) => r.runId === runId);
    if (!run) throw notFound('render', runId);
    await this.storage.deleteRender(run);
    this.renderIndex.delete(this.rk(runId));
    return { deleted: runId, projectId, files: run.keys.length };
  }

  /** A file of a render in storage (default: its output, final.mp4 or another format's file, #302): its key, type and size, for streaming. */
  async renderObject(runId: string, fileArg?: string): Promise<{ key: string; contentType: string; bytes: number; file: string }> {
    const file = fileArg ?? (await this.getRender(runId)).file;
    if (!isSafeRelativePath(file) || !(/^(poster\.png|contact-sheet\.jpg|render-manifest\.json|clips\/[\w.-]+\.(mp4|mov))$/.test(file) || OUTPUT_FILE_PATTERN.test(file) || CAPTION_FILE_PATTERN.test(file))) {
      throw badRequest('file must be the output (final.mp4|mov|webm|gif|m4a|wav or frames.zip), poster.png, contact-sheet.jpg, render-manifest.json, captions[.<language>].srt|vtt|ass, descriptions[.<language>].vtt or clips/<name>.mp4|mov');
    }
    const { projectId } = await this.findRender(runId);
    const key = renderPrefix(projectId, runId) + file;
    const s = await this.storage.driver.stat(key);
    if (!s) throw notFound('render file', `${runId}/${file}`);
    return { key, contentType: contentTypeFor(file), bytes: s.bytes, file };
  }

  /** A local file with a render file's bytes (remote storage: a cached copy). */
  async renderFile(runId: string, file?: string): Promise<{ path: string; contentType: string }> {
    const o = await this.renderObject(runId, file);
    return { path: await this.storage.localFile(o.key, o.bytes), contentType: o.contentType };
  }

  /** get_frames runs FFmpeg; at most this many at once per instance, the rest wait their turn. */
  private framesSlots = 2;
  private framesQueue: Array<() => void> = [];

  /**
   * get_frames (GET /v1/renders/:id/frames, read, #379): stills of exact frames of a finished render or preview,
   * as one labelled contact sheet (default) or one JPEG per frame, from the stored output (no re-render). See
   * frames.ts for the selection. `overlay: "safe"` tints what lies outside the content safe area of the render's
   * size and platform. Images stay under FRAMES_MAX_BYTES (tiles shrink if needed) and are cached per render.
   */
  async getFrames(runId: string, req: FramesRequest = {}): Promise<FramesResult> {
    const { projectId } = await this.findRender(runId);
    const m = await this.storage.renders.readManifest<{
      kind: string;
      output: { file?: string; format?: string; width: number; height: number; fps: number; frameRate?: string; frames: number };
      scenes: Array<{ sceneId: string; startFrame: number; frames: number }>;
      project?: { brief?: { platform?: string } };
    }>(projectId, runId);
    if (!m) throw notFound('render', runId);
    const file = m.output.file ?? 'final.mp4';
    if (!/^final\.(mp4|mov|webm|gif)$/.test(file)) throw badRequest(`render ${runId} is ${file}, not a video; get_frames needs an mp4, mov, webm or gif output`);
    const width = req.width ?? FRAMES_DEFAULT_WIDTH;
    if (!Number.isInteger(width) || width < FRAMES_MIN_WIDTH || width > FRAMES_MAX_WIDTH) throw badRequest(`width must be a whole number from ${FRAMES_MIN_WIDTH} to ${FRAMES_MAX_WIDTH}`);
    const layout = req.layout ?? 'sheet';
    const overlayKind = req.overlay ?? 'none';
    const frameRate = m.output.frameRate ?? String(m.output.fps);
    const plan = planFrames(req, { frames: m.output.frames, fps: m.output.fps, scenes: sceneSpans(m.scenes ?? []) });
    const overlay = overlayKind === 'safe' ? safeAreaInsets(m.output.width, m.output.height, m.project?.brief?.platform).content : undefined;

    const key = createHash('sha256')
      .update(JSON.stringify({ v: 1, frames: plan.tiles.map((t) => [t.frame, t.label]), width, layout, overlay }))
      .digest('hex')
      .slice(0, 32);
    const dir = framesCacheDir(this.cacheDir, runId);
    const out = join(dir, layout === 'sheet' ? `${key}.jpg` : key);
    const meta = join(dir, `${key}.json`);
    let shape = await readJson<FramesShape>(meta).catch(() => undefined);
    // A cache entry whose images were cleared is made again.
    if (shape && !shape.images.every((i) => existsSync(join(dir, i.file)))) shape = undefined;
    if (!shape) {
      await new Promise<void>((go) => (this.framesSlots > 0 ? (this.framesSlots--, go()) : this.framesQueue.push(go)));
      try {
        const input = (await this.renderFile(runId, file)).path;
        await mkdir(dir, { recursive: true });
        const r = await framesImageWithinBudget({ ffmpeg: this.tools().ffmpeg, input, frameRate, width: m.output.width, height: m.output.height, tiles: plan.tiles, tileWidth: width, overlay, layout, out });
        shape = { tileWidth: r.tileWidth, tileHeight: r.tileHeight, columns: r.columns, rows: r.rows, labels: r.labels, images: r.files.map((f, i) => ({ file: f.slice(dir.length + 1), bytes: r.bytes[i]! })) };
        await writeJsonAtomic(meta, shape);
      } finally {
        const next = this.framesQueue.shift();
        if (next) next();
        else this.framesSlots++;
      }
    }
    return {
      renderId: runId,
      kind: m.kind,
      mode: plan.mode,
      layout,
      overlay: overlayKind,
      video: { width: m.output.width, height: m.output.height, fps: m.output.fps, frameRate, frames: m.output.frames, durationSeconds: Math.round((m.output.frames / m.output.fps) * 1000) / 1000 },
      tileWidth: shape.tileWidth,
      tileHeight: shape.tileHeight,
      ...(layout === 'sheet' ? { columns: shape.columns, rows: shape.rows } : {}),
      labels: shape.labels,
      tiles: plan.tiles.map((t, index) => ({ index, ...t })),
      ...(plan.omitted.length ? { omitted: plan.omitted } : {}),
      images: shape.images.map((i) => ({ path: join(dir, i.file), mimeType: 'image/jpeg' as const, bytes: i.bytes })),
    };
  }

  // ---- storage --------------------------------------------------------------

  /** Driver, where the bytes go (no secrets), health, usage, retention policy and the last sweep. */
  getStorage() {
    return this.storage.status();
  }

  // ---- analytics (#292) ---------------------------------------------------------

  /** One per workspace (#304): its caches (storage usage, render manifests) never serve another workspace. */
  private analytics = new Map<string, Analytics>();

  /**
   * get_analytics_summary (GET /v1/analytics/summary, read): renders per day by status, success and failure rates,
   * render time (per engine from the manifests), queue wait, minutes rendered, storage used, top error codes and
   * webhook delivery health, for a bounded range (at most 90 days by day, 7 by hour). See analytics.ts.
   */
  analyticsSummary(query: Record<string, unknown> = {}): Promise<AnalyticsSummary> {
    const ws = currentWorkspaceId();
    let analytics = this.analytics.get(ws);
    if (!analytics) {
      analytics = new Analytics({
        jobs: this.jobs, // the runner's page: live state of jobs running in this process, like list_jobs
        webhooks: this.repos.webhooks,
        // The caller's workspace only: storage.usage() adds up every workspace of the install (get_storage, owner).
        storageUsage: () => this.storage.workspaceUsage(),
        readManifest: async (projectId, runId) => (await this.storage.renders.readManifest<{ scenes?: Array<{ engine?: unknown; millis?: unknown }> }>(projectId, runId)) ?? null,
        now: () => this.now(),
      });
      this.analytics.set(ws, analytics);
    }
    return analytics.summary(query);
  }

  /**
   * Apply the retention policy now (admin). `dryRun` lists what would be
   * deleted; overrides try another policy for this run only. A real run is
   * audit-logged.
   */
  async runStorageCleanup(opts: { dryRun?: unknown; renderDays?: unknown; keepLastRendersPerProject?: unknown } = {}, actor?: Actor): Promise<CleanupReport> {
    if (opts.dryRun !== undefined && typeof opts.dryRun !== 'boolean') throw badRequest('dryRun must be true or false');
    const overrides: Partial<RetentionPolicy> = {};
    for (const k of ['renderDays', 'keepLastRendersPerProject'] as const) {
      const v = opts[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 36500) throw badRequest(`${k} must be a whole number from 0 to 36500`);
      overrides[k] = v;
    }
    const report = await this.storage.cleanup({ dryRun: opts.dryRun === true, overrides });
    if (!report.dryRun) await this.auditCleanup(report, actor ?? { actorType: 'system' });
    for (const r of report.renders) if (!report.dryRun) this.renderIndex.delete(`${r.workspaceId ?? DEFAULT_WORKSPACE_ID}:${r.renderId}`);
    return report;
  }

  private auditCleanup(r: CleanupReport, actor: Actor) {
    return this.audit({
      actorType: actor.actorType,
      ...(actor.actorId ? { actorId: actor.actorId } : {}),
      action: 'storage.cleanup',
      targetType: 'storage',
      targetId: this.storage.driver.id,
      data: {
        policy: r.policy,
        totals: r.totals,
        renders: r.renders.slice(0, 100).map((x) => `${x.projectId}/${x.renderId}`),
        temp: r.temp.length,
        staging: r.staging.length,
        cache: r.cache,
        errors: r.errors.length,
      },
    });
  }

  // ---- assets ---------------------------------------------------------------

  private async attachToProject(projectId: string, asset: StoredAsset, manifestId?: string, license?: StoredAsset['license']) {
    const id = manifestId ?? asset.id.replace(/^ast-/, 'a-');
    const entry = {
      id,
      uri: `asset://${asset.id}`,
      mediaType: asset.mediaType,
      sha256: asset.sha256,
      contentType: asset.contentType,
      bytes: asset.bytes,
      source: asset.source.slice(0, 2048),
      ...((license ?? asset.license) ? { license: license ?? asset.license } : {}),
    };
    await this.assets.addProject(asset.id, projectId);
    await this.projects.update(projectId, (current) => {
      const assets = current.assets.filter((a) => a.id !== id);
      return this.parseOrThrow({ ...current, assets: [...assets, entry] }).project;
    });
    return id;
  }

  async uploadAsset(data: Buffer, opts: { filename?: string; contentType?: string; projectId?: string; assetId?: string; license?: StoredAsset['license'] } = {}) {
    if (opts.projectId) await this.projects.get(opts.projectId);
    const asset = await this.limitedUpload(() => this.assets.put({ data, source: 'upload', originalName: opts.filename, declaredContentType: opts.contentType, license: opts.license }));
    const projectAssetId = opts.projectId ? await this.attachToProject(opts.projectId, asset, opts.assetId, opts.license) : undefined;
    return { asset, uri: `asset://${asset.id}`, projectAssetId };
  }

  /**
   * Upload from a stream (REST multipart): written to a temporary file while it
   * arrives and stopped as soon as it passes limits.maxUploadBytes (D-090).
   * `opts` may be a function, for form fields that arrive with the stream.
   */
  async uploadAssetStream(
    source: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
    opts: UploadOptions | (() => UploadOptions | Promise<UploadOptions>) = {}
  ) {
    const staged = await this.limitedUpload(() => stageStream(source as AsyncIterable<Uint8Array>, this.assets.stagingDir, this.assets.limits.maxBytes, 'the upload'));
    try {
      const o = typeof opts === 'function' ? await opts() : opts;
      if (o.projectId) await this.projects.get(o.projectId);
      const asset = await this.assets.putStaged(staged, { source: 'upload', originalName: o.filename, declaredContentType: o.contentType, license: o.license });
      const projectAssetId = o.projectId ? await this.attachToProject(o.projectId, asset, o.assetId, o.license) : undefined;
      return { asset, uri: `asset://${asset.id}`, projectAssetId };
    } finally {
      await rm(staged.path, { force: true });
    }
  }

  /** Count and audit an upload or import refused for its size. */
  private async limitedUpload<T>(fn: () => Promise<T>): Promise<T> {
    await this.workspaceAdmin?.checkStorage();
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'too_large') await this.recordLimitRejection('upload_too_large', { limit: 'limits.maxUploadBytes', max: this.assets.limits.maxBytes });
      throw e;
    }
  }

  async addAssetFromUrl(url: string, opts: { projectId?: string; assetId?: string; license?: StoredAsset['license'] } = {}) {
    if (typeof url !== 'string' || !url) throw badRequest('url is required');
    if (opts.projectId) await this.projects.get(opts.projectId);
    const asset = await this.limitedUpload(() => this.assets.fromUrl(url, { license: opts.license }));
    const projectAssetId = opts.projectId ? await this.attachToProject(opts.projectId, asset, opts.assetId, opts.license) : undefined;
    return { asset, uri: `asset://${asset.id}`, projectAssetId };
  }

  getAsset(id: string) {
    return this.assets.get(id);
  }

  /**
   * With projectId: the project's manifest entries (bounded by the manifest,
   * one page, nextCursor null). Otherwise one page of the server asset store,
   * newest first (D-102; paged like listProjects).
   */
  async listAssets(opts: { projectId?: string } = {}, q: { limit?: unknown; cursor?: unknown } = {}) {
    if (opts.projectId) {
      const { manifest } = await this.projects.get(opts.projectId);
      return { assets: manifest.assets as unknown[], nextCursor: null };
    }
    const req = parsePageQuery('assets', '', q);
    const { items, nextCursor } = await readPage('assets', '', req, (r) => this.assets.page(r));
    return { assets: items as unknown[], nextCursor };
  }

  // ---- providers ------------------------------------------------------------

  async runProvider(
    providerId: string,
    params: unknown,
    opts: { projectId?: string; acknowledgeCost?: boolean; attachAs?: 'voice' | 'none'; assetId?: string } = {}
  ) {
    const provider = this.registry.provider(providerId);
    const parsed = provider.params.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('invalid_params', 422, `invalid parameters for provider "${providerId}"`, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      });
    }
    if (opts.projectId) await this.projects.get(opts.projectId);
    const cacheKey = provider.cacheKey?.(parsed.data);
    // Per workspace (#304): a hit points at an asset of the caller's workspace.
    const cacheFile = cacheKey ? join(this.cacheDir, 'providers', workspaceKeyPrefix(currentWorkspaceId()), `${cacheKey}.json`) : null;
    let result: { asset: StoredAsset; data?: Record<string, unknown>; cached?: boolean } | undefined;
    if (cacheFile) {
      const hit = await readJson<{ assetId: string; data?: Record<string, unknown> }>(cacheFile);
      const asset = hit ? await this.assets.find(hit.assetId) : undefined;
      if (hit && asset) {
        result = { asset, data: hit.data, cached: true };
        coreInstruments(this.telemetry.meter).providerCalls.add(1, { 'reelforge.provider': providerId, 'reelforge.provider.kind': provider.kind, 'reelforge.outcome': 'cached' });
      }
    }
    if (!result) {
      const creds = await this.providerSettingsFor(provider);
      if (!creds.configured) {
        if (creds.source === 'none') {
          throw new ApiError('provider_not_configured', 409, `provider "${providerId}" is not configured for this workspace: an admin of the workspace sets its own ${provider.env.join(', ')} with configure_workspace_provider (the instance's settings are not shared with workspaces: providers.shareWithWorkspaces)`);
        }
        throw new ApiError('provider_not_configured', 409, `provider "${providerId}" is not configured on this server; the operator must set ${provider.env.join(', ')}`);
      }
      if (!opts.acknowledgeCost) {
        throw new ApiError('cost_acknowledgement_required', 402, `this call may cost money: ${provider.costNote} Ask the user, then call again with acknowledgeCost: true.`, {
          costNote: provider.costNote,
        });
      }
      await this.reserveProviderRun(providerId);
      const controller = new AbortController();
      const calls = coreInstruments(this.telemetry.meter).providerCalls;
      const attrs = { 'reelforge.provider': providerId, 'reelforge.provider.kind': provider.kind };
      try {
        result = await withSpan(this.telemetry.tracer, `provider.run ${providerId}`, attrs, () =>
          provider.run(parsed.data, {
            signal: controller.signal,
            log: () => undefined,
            putAsset: (input) => this.assets.put(input),
            fetch: this.fetchImpl,
            env: creds.env,
          })
        );
      } catch (e) {
        calls.add(1, { ...attrs, 'reelforge.outcome': 'error' });
        throw e;
      }
      calls.add(1, { ...attrs, 'reelforge.outcome': 'ok' });
      if (cacheFile) await writeJsonAtomic(cacheFile, { assetId: result.asset.id, data: result.data });
    }
    let projectAssetId: string | undefined;
    if (opts.projectId && opts.attachAs !== 'none') {
      projectAssetId = await this.attachToProject(opts.projectId, result.asset, opts.assetId ?? (provider.kind === 'tts' ? 'voice' : undefined));
      if (provider.kind === 'tts' && (opts.attachAs ?? 'voice') === 'voice') {
        const p = parsed.data as { text?: string; voiceId?: string };
        // Word timestamps (ElevenLabs "with-timestamps") are kept on the voice track: captions are built from them (#300).
        const words = voiceWords(result.data?.words);
        await this.projects.update(opts.projectId, (current) =>
          this.parseOrThrow({
            ...current,
            audio: {
              ...current.audio,
              voice: {
                asset: projectAssetId,
                provider: providerId,
                ...(p.text ? { text: p.text } : {}),
                ...(p.voiceId ? { voiceId: p.voiceId } : {}),
                volume: current.audio.voice?.volume ?? 1,
                startFrame: current.audio.voice?.startFrame ?? 0,
                ...(words.length ? { words } : {}),
              },
            },
          }).project
        );
      }
    }
    return {
      asset: result.asset,
      uri: `asset://${result.asset.id}`,
      data: result.data ?? {},
      cached: Boolean(result.cached),
      costNote: provider.costNote,
      ...(projectAssetId ? { projectAssetId } : {}),
    };
  }

  /**
   * Count one provider call against the calling key's daily cap and the
   * server's daily budget (limits.providerRunsPerKeyPerDay / providerRunsPerDay,
   * UTC days), atomically across instances (D-091). Refuses with 429 when one is used up.
   */
  private async reserveProviderRun(providerId: string) {
    const l = this.settings.current.config.limits;
    const auth = currentRequest()?.auth;
    const keyId = auth && auth.keyId !== 'signed-url' ? auth.keyId : undefined;
    const day = usageDay(this.now());
    const counters: Array<{ key: string; windowStart: string; limit: number; which: 'key' | 'all' }> = [];
    if (keyId && l.providerRunsPerKeyPerDay > 0) counters.push({ key: usageKeys.providerRunsOfKey(keyId), windowStart: day.start, limit: l.providerRunsPerKeyPerDay, which: 'key' });
    if (l.providerRunsPerDay > 0) counters.push({ key: usageKeys.providerRunsTotal, windowStart: day.start, limit: l.providerRunsPerDay, which: 'all' });
    if (!counters.length) return;
    const r = await this.repos.rateLimits.reserve(counters.map(({ which: _w, ...c }) => c));
    if (r.ok) return;
    const c = counters[r.index]!;
    const details = { limit: c.which === 'key' ? 'limits.providerRunsPerKeyPerDay' : 'limits.providerRunsPerDay', max: c.limit, used: r.used, resetsAt: day.resetsAt, retryAfterSeconds: day.retryAfterSeconds };
    await this.recordLimitRejection(c.which === 'key' ? 'provider_runs_per_key' : 'provider_budget', { provider: providerId, ...details });
    if (c.which === 'key') {
      throw new ApiError('provider_limit_exceeded', 429, `this API key may make ${c.limit} provider calls per UTC day (limits.providerRunsPerKeyPerDay); ${r.used} used. It resets at ${day.resetsAt}. Cached results (the same parameters again) do not count.`, details);
    }
    throw new ApiError('provider_budget_exhausted', 429, `the server's daily budget of ${c.limit} provider calls is used up (limits.providerRunsPerDay). It resets at ${day.resetsAt}; the operator can raise it.`, details);
  }

  /** Whether workspaces other than the default may use the instance's settings of a provider (providers.shareWithWorkspaces). */
  private sharesInstanceProvider(providerId: string): boolean {
    const shared = this.settings.current.config.providers.shareWithWorkspaces;
    return shared.includes('*') || shared.includes(providerId);
  }

  /** A workspace's own provider settings (its rows of the provider settings table), or null for the default workspace. */
  private workspaceProviderRepo(workspaceId: string) {
    if (workspaceId === DEFAULT_WORKSPACE_ID || !isWorkspaceRouter(this.repos)) return null;
    return this.repos.forWorkspace(workspaceId).providerSettings;
  }

  /**
   * The settings a provider runs with for a workspace (#480): the workspace's own when it set any (never mixed
   * with the instance's), else the instance's when `providers.shareWithWorkspaces` allows it, else none. The
   * default workspace always uses the instance's. A provider without `scopedSettings` only ever sees the
   * instance's, so it counts as not configured for a workspace that may not share them.
   */
  async providerSettingsFor(provider: ProviderPlugin, workspaceId = currentWorkspaceId(), preloaded?: { values: Record<string, string>; errors: Record<string, string> }) {
    const repo = this.workspaceProviderRepo(workspaceId);
    const own = preloaded ?? (repo ? await this.settings.workspaceProviderValues(repo) : { values: {}, errors: {} });
    const ownNames = provider.env.filter((n) => own.values[n] !== undefined || own.errors[n] !== undefined);
    if (repo && ownNames.length && provider.scopedSettings) {
      const env = Object.fromEntries(provider.env.map((n) => [n, own.values[n]])) as Record<string, string | undefined>;
      return { source: 'workspace' as const, env, configured: provider.configured(env), errors: own.errors };
    }
    if (!repo || this.sharesInstanceProvider(provider.id)) {
      // The instance's: no ctx.env, so the plugin reads the environment it was built with, exactly as before #480.
      return { source: 'instance' as const, env: undefined, configured: provider.configured(), errors: {} };
    }
    return { source: 'none' as const, env: Object.fromEntries(provider.env.map((n) => [n, undefined])) as Record<string, string | undefined>, configured: false, errors: {} };
  }

  /**
   * Providers, whether they are configured for the calling workspace and where its settings come from
   * (`settingsFrom`: `workspace`, `instance` or `none`, #480), and which settings are set (never their values).
   */
  async listProviders(workspaceId = currentWorkspaceId()) {
    const repo = this.workspaceProviderRepo(workspaceId);
    const own = repo ? await this.settings.workspaceProviderValues(repo) : undefined;
    return Promise.all(
      this.registry.listProviders().map(async (p) => {
        const creds = await this.providerSettingsFor(p, workspaceId, own);
        return {
          id: p.id,
          kind: p.kind,
          displayName: p.displayName,
          configured: creds.configured,
          settingsFrom: creds.source,
          perWorkspace: Boolean(p.scopedSettings),
          costNote: p.costNote,
          env: p.env,
          settings: p.env.map((name): ProviderSetting => {
            if (creds.source === 'workspace') {
              const error = creds.errors[name];
              return creds.env[name] ? { name, set: true, source: 'workspace' } : { name, set: false, source: 'unset', ...(error ? { error } : {}) };
            }
            if (creds.source === 'none') return { name, set: false, source: 'unset' };
            return this.instanceProviderSetting(name);
          }),
        };
      })
    );
  }

  /** Whether one instance-level provider setting is set and where from (never its value). */
  private instanceProviderSetting(name: string): ProviderSetting {
    const error = this.settings.providerError(name);
    const def = RuntimeConfig.settingForProviderEnv(name);
    const r = def ? this.settings.current.settings.get(def.key) : undefined;
    if (r && r.value !== undefined && r.source !== 'default') return { name, set: true, source: r.source === 'runtime' ? 'api' : r.source };
    if (this.settings.hasProviderValue(name)) return { name, set: true, source: 'api' };
    if (this.baseEnv[name]) return { name, set: true, source: 'env' };
    return { name, set: false, source: 'unset', ...(error ? { error } : {}) };
  }

  /** Checks configure_provider values: only the names the provider declares, each a single-line string or null. */
  private providerChanges(providerId: string, values: unknown): Record<string, string | null> {
    const provider = this.registry.provider(providerId);
    if (!isPlainObject(values) || Object.keys(values).length === 0) {
      throw badRequest(`values must be an object of settings, e.g. { "${provider.env[0] ?? 'NAME'}": "..." } (null clears one)`);
    }
    const changes: Record<string, string | null> = {};
    for (const [name, v] of Object.entries(values)) {
      if (!provider.env.includes(name)) throw badRequest(`provider "${providerId}" has no setting "${name}"; settings: ${provider.env.join(', ')}`);
      if (v === null) changes[name] = null;
      else if (typeof v === 'string' && v.length > 0 && v.length <= 1000 && !/[\r\n]/.test(v)) changes[name] = v;
      else throw badRequest(`${name} must be a non-empty single-line string (max 1000 characters) or null`);
    }
    return changes;
  }

  /**
   * Set or clear provider settings (owner). Only the names the provider declares are accepted. Values are
   * stored encrypted (REELFORGE_SECRET_KEY is required) and override the file and environment; clearing one
   * falls back to them. With `workspaceId` (not the default workspace), they are that workspace's own (#480),
   * as configure_workspace_provider sets them.
   */
  async configureProvider(providerId: string, values: unknown, actor?: Actor, workspaceId?: string) {
    if (workspaceId !== undefined && workspaceId !== DEFAULT_WORKSPACE_ID) return this.setWorkspaceProvider(workspaceId, providerId, values, actor);
    const changes = this.providerChanges(providerId, values);
    await this.settings.setProviderValues(changes, providerId);
    await this.audit({
      actorType: actor?.actorType ?? 'system',
      ...(actor?.actorId ? { actorId: actor.actorId } : {}),
      action: 'provider.configure',
      targetType: 'provider',
      targetId: providerId,
      data: { settings: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v === null ? 'cleared' : 'set'])) },
    });
    return (await this.listProviders(DEFAULT_WORKSPACE_ID)).find((p) => p.id === providerId)!;
  }

  /**
   * Set or clear the calling workspace's own provider settings (admin of that workspace, #480): its calls then
   * use its own account, and no other workspace ever sees or uses them. The default workspace's settings are
   * the instance's: the owner sets them with configure_provider.
   */
  async configureWorkspaceProvider(providerId: string, values: unknown, actor?: Actor) {
    const ws = currentWorkspaceId();
    if (ws === DEFAULT_WORKSPACE_ID) {
      throw new ApiError('forbidden', 403, "the default workspace uses the instance's provider settings: the owner sets them with configure_provider (PUT /v1/providers/:id/config)");
    }
    return this.setWorkspaceProvider(ws, providerId, values, actor);
  }

  private async setWorkspaceProvider(workspaceId: string, providerId: string, values: unknown, actor?: Actor) {
    const provider = this.registry.provider(providerId);
    if (!provider.scopedSettings) {
      throw new ApiError('provider_not_per_workspace', 400, `provider "${providerId}" reads only the instance's settings, so a workspace cannot bring its own; the owner configures it with configure_provider`);
    }
    const repo = this.workspaceProviderRepo(workspaceId);
    const record = isWorkspaceRouter(this.repos) ? await this.repos.workspace(workspaceId) : null;
    if (!repo || !record || record.status === 'deleted') throw new ApiError('not_found', 404, `workspace "${workspaceId}" not found`);
    const changes = this.providerChanges(providerId, values);
    await this.settings.setWorkspaceProviderValues(repo, changes, providerId);
    await runInWorkspace(workspaceId, () =>
      this.audit({
        actorType: actor?.actorType ?? 'system',
        ...(actor?.actorId ? { actorId: actor.actorId } : {}),
        action: 'provider.configure',
        targetType: 'provider',
        targetId: providerId,
        data: { workspace: workspaceId, settings: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v === null ? 'cleared' : 'set'])) },
      })
    );
    return (await this.listProviders(workspaceId)).find((p) => p.id === providerId)!;
  }

  // ---- configuration ----------------------------------------------------------

  /** Every setting with its effective value and source (defaults < file < env < runtime); secrets only as set / not set. */
  getConfig(opts: { prefix?: string } = {}) {
    return this.settings.report(opts);
  }

  /**
   * Change runtime settings (admin), all or nothing; null clears a runtime
   * value. Start-up-only keys are refused with where to set them. Every change
   * is written to the audit log (secrets as set / cleared).
   */
  async updateConfig(patch: unknown, actor?: Actor) {
    const r = await this.settings.update(patch, actor?.actorId);
    await this.audit({
      actorType: actor?.actorType ?? 'system',
      ...(actor?.actorId ? { actorId: actor.actorId } : {}),
      action: 'config.update',
      targetType: 'config',
      data: { changes: r.changes },
    });
    return r;
  }

  // ---- licence ----------------------------------------------------------------

  /** Licence status: valid / grace / invalid / unlicensed, why, and how to fix it. The key only masked. */
  getLicence() {
    return this.licence.report();
  }

  /**
   * Set the licence key (optional: without one the configured key is checked
   * again) and activate it now. The key is stored as the encrypted runtime
   * setting licence.key (needs REELFORGE_SECRET_KEY); audit-logged without it.
   */
  async activateLicence(key: unknown, actor?: Actor) {
    if (key !== undefined && key !== null) {
      if (typeof key !== 'string' || !key.trim()) throw badRequest('key must be the licence key as a string, e.g. "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2"');
      this.activatingLicence = true;
      try {
        await this.updateConfig({ 'licence.key': key.trim() }, actor);
      } finally {
        this.activatingLicence = false;
      }
    } else if (!this.licence.report().key) {
      throw new ApiError('licence_key_missing', 400, 'No licence key is set: send {"key": "<your licence key>"}.');
    }
    const r = await this.licence.activateNow();
    this.watchLicence();
    await this.audit({
      actorType: actor?.actorType ?? 'system',
      ...(actor?.actorId ? { actorId: actor.actorId } : {}),
      action: 'licence.activate',
      targetType: 'licence',
      targetId: r.instanceId,
      data: { key: r.key, status: r.status, reason: r.reason },
    });
    return r;
  }

  /** Give this server's activation back (to move the licence to another server). */
  async deactivateLicence(actor?: Actor) {
    const r = await this.licence.deactivate();
    this.watchLicence();
    await this.audit({
      actorType: actor?.actorType ?? 'system',
      ...(actor?.actorId ? { actorId: actor.actorId } : {}),
      action: 'licence.deactivate',
      targetType: 'licence',
      targetId: r.instanceId,
      data: { key: r.key },
    });
    return r;
  }

  // ---- audit ----------------------------------------------------------------

  /** Append to the audit log (never pass secrets in `data`; the request context is added). Key and config changes are also outbound events. */
  async audit(entry: AuditEntryInput): Promise<AuditEntry> {
    const e = await this.auditLog.write(entry);
    const type = AUDIT_EVENTS[e.action];
    if (type && e.result === 'success') {
      const d = (e.data ?? {}) as Record<string, any>;
      const actor = { type: e.actorType, ...(e.actorId ? { id: e.actorId } : {}), ...(e.actorName ? { name: e.actorName } : {}) };
      if (type === 'config.changed') this.webhooks.emit(type, { keys: Array.isArray(d.changes) ? d.changes.map((c: { key: string }) => c.key) : [], actor });
      else this.webhooks.emit(type, { keyId: e.targetId, ...(d.name ? { name: d.name } : {}), ...(d.scopes ? { scopes: d.scopes } : {}), ...(d.expiresAt ? { expiresAt: d.expiresAt } : {}), actor });
    }
    return e;
  }

  // ---- outbound events (#66) ----------------------------------------------------

  listWebhooks() {
    return this.webhooks.list();
  }
  getWebhook(id: string) {
    return this.webhooks.get(id);
  }
  createWebhook(input: unknown, actor?: Actor) {
    return this.webhooks.create(input, actor);
  }
  updateWebhook(id: string, input: unknown, actor?: Actor) {
    return this.webhooks.update(id, input, actor);
  }
  deleteWebhook(id: string, actor?: Actor) {
    return this.webhooks.delete(id, actor);
  }
  testWebhook(id: string, opts: { waitSeconds?: number } = {}, actor?: Actor) {
    return this.webhooks.test(id, opts, actor);
  }
  listWebhookDeliveries(id: string, query: Record<string, unknown> = {}) {
    return this.webhooks.listDeliveries(id, query);
  }
  replayWebhookDelivery(id: string, deliveryId: string, actor?: Actor) {
    return this.webhooks.replay(id, deliveryId, actor);
  }
  /** resend_webhook (#306): an event again, by deliveryId, eventId or dedupeKey. */
  resendWebhook(id: string, input: unknown, actor?: Actor) {
    return this.webhooks.resend(id, input, actor);
  }
  /** get_webhook_log (#306, read scope): status, latency and attempts per delivery, without payloads or targets. */
  getWebhookLog(id: string, query: Record<string, unknown> = {}) {
    return this.webhooks.log(id, query);
  }
  /** rotate_webhook_secret (#306): a new secret with an overlap window, or end the overlap. */
  rotateWebhookSecret(id: string, input: unknown, actor?: Actor) {
    return this.webhooks.rotateSecret(id, input, actor);
  }

  /** A page of audit entries, newest first, filtered (list_audit_events / GET /v1/audit). */
  async listAuditEvents(query: Record<string, unknown> = {}) {
    const { workspaceId, ...rest } = query;
    const filter = parseAuditQuery(rest);
    const extra = { retentionDays: this.settings.current.config.audit.retentionDays, sinks: this.auditLog.activeSinks() };
    if (workspaceId === undefined || workspaceId === '' || workspaceId === currentWorkspaceId()) return { ...(await this.auditLog.list(filter)), ...extra };
    // Another workspace's trail, or every workspace's ("*"): the instance owner only (#304).
    const auth = currentRequest()?.auth;
    if (auth && !hasScope(auth, 'owner')) throw new ApiError('forbidden', 403, 'workspaceId needs the owner scope; an admin key reads its own workspace\'s audit log');
    const router = isWorkspaceRouter(this.repos) ? this.repos : null;
    if (!router) throw badRequest('this server has one workspace');
    if (typeof workspaceId !== 'string') throw badRequest('workspaceId must be a workspace id or "*"');
    const ids = workspaceId === '*' ? await router.workspaceIds() : [workspaceId];
    if (workspaceId !== '*' && !(await router.workspaces.get(workspaceId))) throw notFound('workspace', workspaceId);
    const limit = filter.limit ?? 100;
    const pages = [];
    for (const ws of ids) pages.push({ workspaceId: ws, entries: (await runInWorkspace(ws, () => this.auditLog.list({ ...filter, limit }))).events });
    const events = mergeAuditPages(pages, limit);
    return { events, nextCursor: events.length === limit ? auditCursor(events[events.length - 1]!) : null, ...extra };
  }

  // ---- workspaces (#304) ------------------------------------------------------

  private admin(): WorkspaceAdmin {
    if (!this.workspaceAdmin) throw new ApiError('not_supported', 501, 'this server runs with repositories bound to one workspace');
    return this.workspaceAdmin;
  }
  /** The caller's workspace: limits in force and usage (any key). */
  getWorkspace() {
    return this.admin().current();
  }
  listWorkspaces() {
    return this.admin().list();
  }
  createWorkspace(input: Record<string, unknown>, actor?: Actor) {
    return this.admin().create(input, actor);
  }
  updateWorkspace(id: string, input: Record<string, unknown>, actor?: Actor) {
    return this.admin().update(id, input, actor);
  }
  deleteWorkspace(id: string, actor?: Actor) {
    return this.admin().delete(id, actor);
  }
  restoreWorkspace(id: string, actor?: Actor) {
    return this.admin().restore(id, actor);
  }
  /** set_workspace_retention (#487): the caller's workspace, tighter only. */
  setWorkspaceRetention(input: Record<string, unknown>, actor?: Actor) {
    return this.admin().tightenRetention(input, actor);
  }

  /**
   * Matching entries as JSON lines or CSV, streamed one database page (1000
   * entries) at a time, newest first, up to `limit` (default and maximum
   * 100 000 per export; narrow the time range for more).
   */
  streamAuditEvents(query: Record<string, unknown> = {}, format: unknown = 'jsonl'): { format: 'jsonl' | 'csv'; contentType: string; filename: string; chunks: AsyncGenerator<string> } {
    if (format !== 'jsonl' && format !== 'csv') throw badRequest('format must be jsonl or csv');
    if (query.workspaceId !== undefined && query.workspaceId !== '' && query.workspaceId !== currentWorkspaceId()) throw badRequest('exports cover the key\'s own workspace; for another workspace use the json pages with workspaceId (owner)');
    const { cursor: _c, limit, format: _f, ...rest } = query;
    const filter: AuditFilter = parseAuditQuery(rest);
    const max = limit === undefined || limit === null || limit === '' ? MAX_AUDIT_EXPORT : Number(limit);
    if (!Number.isInteger(max) || max < 1 || max > MAX_AUDIT_EXPORT) throw badRequest(`limit must be an integer from 1 to ${MAX_AUDIT_EXPORT}`);
    const pages = this.auditLog.pages(filter, max);
    async function* chunks() {
      if (format === 'csv') yield auditToCsv([]);
      for await (const page of pages) yield format === 'csv' ? auditToCsv(page, false) : auditToJsonl(page);
    }
    const stamp = new Date(this.now()).toISOString().slice(0, 19).replace(/[-:]/g, '');
    return {
      format,
      contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      filename: `reelforge-audit-${stamp}Z.${format}`,
      chunks: chunks(),
    };
  }

  /** The same export in one string (MCP results are one message): at most MAX_MCP_EXPORT entries. */
  async exportAuditEvents(query: Record<string, unknown> = {}, format: unknown = 'jsonl') {
    const { limit, ...rest } = query;
    const max = limit === undefined || limit === null || limit === '' ? MAX_MCP_EXPORT : Number(limit);
    if (!Number.isInteger(max) || max < 1 || max > MAX_MCP_EXPORT) throw badRequest(`limit must be an integer from 1 to ${MAX_MCP_EXPORT} (REST GET /v1/audit?format= streams up to ${MAX_AUDIT_EXPORT})`);
    const s = this.streamAuditEvents({ ...rest, limit: max + 1 }, format);
    let content = '';
    let count = 0;
    for await (const chunk of s.chunks) content += chunk;
    const lines = content.split(/\r?\n/).filter(Boolean);
    count = s.format === 'csv' ? lines.length - 1 : lines.length;
    const truncated = count > max;
    if (truncated) {
      const keep = s.format === 'csv' ? lines.slice(0, max + 1) : lines.slice(0, max);
      content = keep.join(s.format === 'csv' ? '\r\n' : '\n') + (s.format === 'csv' ? '\r\n' : '\n');
      count = max;
    }
    return { format: s.format, contentType: s.contentType, count, truncated, content };
  }

  // ---- keys -----------------------------------------------------------------

  listKeys() {
    return this.keys.list();
  }

  /**
   * The key making the call (get_me, GET /v1/me; any scope): id, name, scopes, limits and usage, never the
   * secret. Clients such as the dashboard use it to check a key at sign-in and to offer only what its scopes allow.
   */
  async getMe(auth: AuthContext) {
    const key = await this.getKey(auth.keyId);
    return { ...key, ...(auth.previousSecret ? { usingPreviousSecret: true } : {}) };
  }

  /** A key with its render usage today and this month (UTC). */
  async getKey(id: string): Promise<PublicKey & { usage: { rendersToday: number; rendersThisMonth: number; providerRunsToday: number } }> {
    const k = await this.keys.get(id);
    const w = quotaWindows(this.now());
    const [rendersToday, rendersThisMonth, providerRunsToday] = await Promise.all([
      this.repos.jobs.countByApiKey(id, w.dayStart, QUOTA_JOB_TYPES),
      this.repos.jobs.countByApiKey(id, w.monthStart, QUOTA_JOB_TYPES),
      this.repos.rateLimits.usage(usageKeys.providerRunsOfKey(id), usageDay(this.now()).start),
    ]);
    return { ...k, usage: { rendersToday, rendersThisMonth, providerRunsToday } };
  }
  /**
   * Only an owner key gives out or changes an owner key (#304): a workspace admin cannot raise a key above itself.
   * Calls without an API key (the CLI, start-up) are the operator's and may.
   */
  private async guardOwnerKey(scopes: Scope[] | null, targetId?: string): Promise<void> {
    const auth = currentRequest()?.auth;
    if (!auth || hasScope(auth, 'owner')) return;
    const target = targetId ? await this.keys.get(targetId) : null;
    if ((scopes ?? []).includes('owner') || target?.scopes.includes('owner')) {
      throw new ApiError('forbidden', 403, 'only an owner key can create or change a key with the "owner" scope');
    }
  }
  async createKey(name: string, scopes: Scope[], opts: KeyOptions = {}, actor?: Actor) {
    await this.guardOwnerKey(Array.isArray(scopes) ? scopes : null);
    return this.keys.create(name, scopes, opts, actor);
  }
  async updateKey(id: string, patch: KeyOptions & { name?: string }, actor?: Actor) {
    await this.guardOwnerKey(null, id);
    return this.keys.update(id, patch, actor);
  }
  async rotateKey(id: string, opts: { graceHours?: number } = {}, actor?: Actor) {
    await this.guardOwnerKey(null, id);
    return this.keys.rotate(id, opts, actor);
  }
  async revokeKey(id: string, actor?: Actor) {
    if (actor?.actorId === id) throw new ApiError('conflict', 409, 'refusing to revoke the key used for this request; use another admin key');
    await this.guardOwnerKey(null, id);
    return this.keys.revoke(id, actor);
  }
  async deleteKey(id: string, actor?: Actor) {
    if (actor?.actorId === id) throw new ApiError('conflict', 409, 'refusing to delete the key used for this request');
    await this.guardOwnerKey(null, id);
    return this.keys.delete(id, actor);
  }

  /** Frames of every scene, for agents planning exact timing. */
  static sceneTiming(p: Project) {
    let cursor = 0;
    return p.scenes.map((s) => {
      const frames = sceneFrames(s, p.output.fps);
      const t = { id: s.id, startFrame: cursor, durationFrames: frames, startSeconds: framesToSeconds(cursor, p.output.fps), durationSeconds: framesToSeconds(frames, p.output.fps) };
      cursor += frames;
      return t;
    });
  }
}

/** Provider word timestamps ({ word | text, start, end } in seconds) as manifest caption words; anything malformed is dropped. */
/** What a signed download link signs: the default workspace keeps the parts of earlier versions (old links stay valid). */
function signedParts(workspaceId: string, runId: string, file: string): string[] {
  return workspaceId === DEFAULT_WORKSPACE_ID ? [runId, file] : [`ws:${workspaceId}`, runId, file];
}

export function voiceWords(raw: unknown): Array<{ text: string; start: number; end: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ text: string; start: number; end: number }> = [];
  for (const w of raw.slice(0, 5000)) {
    if (!isPlainObject(w)) continue;
    const text = typeof w.text === 'string' ? w.text : typeof w.word === 'string' ? w.word : '';
    const start = Number(w.start);
    const end = Number(w.end);
    if (!text.trim() || text.length > 100 || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > MAX_PROJECT_SECONDS) continue;
    out.push({ text: text.trim(), start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 });
  }
  return out;
}

/** What getFrames caches beside the images. */
interface FramesShape {
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  labels: boolean;
  images: Array<{ file: string; bytes: number }>;
}

/** getFrames' answer; `images[].path` is a local file the REST and MCP layers read and never return. */
export interface FramesResult {
  renderId: string;
  kind: string;
  mode: 'auto' | 'at' | 'every';
  layout: 'sheet' | 'separate';
  overlay: 'none' | 'safe';
  video: { width: number; height: number; fps: number; frameRate: string; frames: number; durationSeconds: number };
  tileWidth: number;
  tileHeight: number;
  columns?: number;
  rows?: number;
  labels: boolean;
  tiles: Array<PlannedTile & { index: number }>;
  omitted?: PlannedTile[];
  images: Array<{ path: string; mimeType: 'image/jpeg'; bytes: number }>;
}

/** get_render_output's `retention` (#487): when the render was first downloaded and when the sweep may delete it. */
export interface RenderRetention {
  /** The first download of its output through this server; null: not downloaded yet. */
  downloadedAt: string | null;
  /** The earliest time the sweep may delete it (it runs every storage.retention.sweepIntervalMinutes); null: kept until deleted by hand. A keep-last can keep it longer. */
  deletesAt: string | null;
  deleteReason?: 'deleted_after_download' | 'older_than_workspace_retention' | 'older_than_renderDays';
  deleteAfterDownloadMinutes?: number;
  keepLast?: number;
}
