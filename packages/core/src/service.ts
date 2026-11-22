import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { resolveTools, toolVersion, type Tools } from '@reelforge/media-pipeline';
import {
  DEFAULT_OUTPUT,
  MAX_PROJECT_SECONDS,
  MAX_SOURCE_BYTES,
  SCHEMA_VERSION,
  SUPPORTED_FPS,
  SUPPORTED_SCHEMA_VERSIONS,
  isSafeRelativePath,
  parseProject,
  projectJsonSchema,
  sceneFrames,
  totalFrames,
  type Project,
  type ValidationIssue,
  type ValidationWarning,
} from '@reelforge/project-schema';
import { AssetStore } from './assets';
import { LocalBackend } from './backends/local';
import { ApiError, badRequest, invalidManifest, notFound } from './errors';
import { newId, readJson, writeJsonAtomic } from './fsutil';
import { JobRunner, type JobContext, type JobRecord } from './jobs';

/** Longest a single get_job call may block; below common MCP client request timeouts (60 s). */
export const MAX_JOB_WAIT_SECONDS = 50;
import { KeyStore, quotaWindows, type KeyOptions, type PublicKey, type Scope } from './keys';
import type { AuditEntryInput, AuditFilter, Repositories } from './repositories';
import {
  AuditLog,
  MAX_AUDIT_EXPORT,
  OtlpLogsAuditSink,
  StdoutAuditSink,
  auditToCsv,
  auditToJsonl,
  currentRequest,
  parseAuditQuery,
  type AuditSink,
} from './audit';
import { withIdempotency, type IdempotentOperation } from './idempotency';
import { applyMergePatch, isPlainObject } from './mergePatch';
import type { BackendContext, RenderOutcome, RenderRequest, ResolvedAsset, StoredAsset } from './plugins';
import { PluginRegistry } from './registry';
import { runRenderPipeline } from './render';
import { UrlSigner } from './secrets';
import { RuntimeConfig, type ConfigSources } from './config/runtime';
import { createLicenceManager, type LicenceApi, type LicenceManager } from './licence';
import type { ResolvedConfig } from './config/load';
import { ProjectStore } from './store';
import { createStorageDriver, type StorageFactory } from './storage/factory';
import { contentTypeFor, PROJECTS_PREFIX, RENDER_MANIFEST, renderPrefix } from './storage/keys';
import { StorageManager, type CleanupReport, type RetentionPolicy } from './storage/manager';
import { ThemeStore } from './themes';
import { NOOP_TELEMETRY, coreInstruments, withSpan, type Telemetry } from './telemetry';
import { WebhookService, jobPayload, renderSummary, type NotificationProvider } from './webhooks/index';
import type { AuditEntry } from './repositories';
import type { JobEvent } from './jobs';

export interface ServiceConfig {
  /**
   * Where state is persisted (projects, keys, jobs, themes, settings, asset
   * metadata, audit). @reelforge/db opens SQLite/PostgreSQL/MySQL ones;
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
}

/** Audit actions that are also outbound events (#66, D-070). */
const AUDIT_EVENTS: Record<string, string> = { 'key.create': 'key.created', 'key.revoke': 'key.revoked', 'config.update': 'config.changed' };
const JOB_EVENTS: Record<string, string> = { queued: 'job.queued', running: 'job.started', succeeded: 'job.succeeded', failed: 'job.failed', cancelled: 'job.cancelled' };

/** Most audit entries one MCP export returns (REST streams up to MAX_AUDIT_EXPORT). */
export const MAX_MCP_EXPORT = 10_000;

/** Render and preview jobs count towards a key's render quota. */
const QUOTA_JOB_TYPES = ['render', 'preview'];
const SWEEP_INTERVAL_MS = 3_600_000;

/** Who made a change (audit log). */
export interface Actor {
  actorType: 'api_key' | 'cli' | 'system';
  actorId?: string;
}

export interface ProviderSetting {
  name: string;
  set: boolean;
  /** Where the value comes from; the value itself is never returned. */
  source: 'api' | 'env' | 'file' | 'build' | 'unset';
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
    fps: number;
    engines: string[];
  };
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
  fps: number;
  files: string[];
  /** Needs `Authorization: Bearer <key>`. */
  outputUrl: string;
  posterUrl: string;
  manifestUrl: string;
  /** Works without a key until downloadUrlExpiresAt (signed, read-only, this file only). */
  downloadUrl: string;
  downloadUrlExpiresAt: string;
  /** "bucket": signed by the storage bucket (D-067); "server": a signed link to this server. */
  downloadVia: 'bucket' | 'server';
}

const DEFAULT_MAX_UPLOAD = 200 * 1024 * 1024;

/**
 * Every capability of the product as plain async methods. REST routes and
 * MCP tools are thin wrappers over this class, so both always behave the same.
 */
export class ReelforgeService {
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly projects: ProjectStore;
  readonly themes: ThemeStore;
  readonly assets: AssetStore;
  readonly keys: KeyStore;
  readonly jobs: JobRunner;
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
  private progressBuckets = new Map<string, number>();
  private licenceSeen: { status: string; reason: string | null } | null = null;
  private licenceTimer: NodeJS.Timeout | null = null;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private sweepTimer: NodeJS.Timeout | null = null;
  private quotaLocks = new Map<string, Promise<unknown>>();
  private builtinSinks = new Map<string, AuditSink>();
  /** The clock (ServiceConfig.now). */
  readonly now: () => number;
  private toolsCache: Tools | null = null;
  private activatingLicence = false;
  private renderIndex = new Map<string, string>();
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
    });
    this.now = config.now ?? Date.now;
    this.auditLog = new AuditLog(this.repos.audit, { log: config.log });
    this.keys = new KeyStore(this.repos.keys, {
      now: this.now,
      audit: (e) => this.audit(e),
      rotationGraceHours: () => this.settings.current.config.keys.rotationGraceHours,
    });
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
    this.signer = new UrlSigner(this.dataDir);
    this.licence = createLicenceManager(this.settings, this.repos, {
      api: config.licence?.api,
      fetch: config.licence?.fetch,
      now: config.licence?.now,
      checkIntervalMs: config.licence?.checkIntervalMs,
      log: config.log,
    });
    this.jobs = new JobRunner({
      repo: this.repos.jobs,
      concurrency: config.renderConcurrency ?? 1,
      handlers: { render: (ctx) => this.runRenderJob(ctx), preview: (ctx) => this.runRenderJob(ctx) },
      telemetry: this.telemetry,
    });
    if (!registry.listBackends().some((b) => b.id === 'local')) {
      registry.registerBackend(new LocalBackend((req, ctx) => this.renderLocally(req, ctx)));
    }
  }

  static async create(registry: PluginRegistry, config: ServiceConfig): Promise<ReelforgeService> {
    const s = new ReelforgeService(registry, config);
    await mkdir(s.dataDir, { recursive: true });
    await s.jobs.init();
    await s.signer.init();
    await s.settings.load();
    const encrypted = await s.settings.encryptPlaintext();
    if (encrypted.length) {
      config.log?.('info', `encrypted ${encrypted.length} stored secret(s) with REELFORGE_SECRET_KEY: ${encrypted.join(', ')}`);
      await s.audit({ actorType: 'system', action: 'config.secrets.encrypt', data: { names: encrypted } });
    }
    for (const w of s.settings.warnings()) config.log?.('warn', w);
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
    if (config.maintenance !== false) {
      // First sweep shortly after start (never delays it), then hourly.
      const run = () => void s.sweep().catch((e) => config.log?.('warn', `maintenance sweep failed: ${(e as Error).message}`));
      setTimeout(run, 5_000).unref();
      s.sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
      s.sweepTimer.unref();
    }
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
    const webhookDeliveriesDeleted = await this.webhooks.sweep(now);
    if (auditDeleted) {
      await this.audit({ actorType: 'system', action: 'audit.sweep', data: { deleted: auditDeleted, retentionDays: this.settings.current.config.audit.retentionDays } });
    }
    return { auditDeleted, idempotencyDeleted, webhookDeliveriesDeleted };
  }

  /** Stop timers and flush the audit sinks (server shutdown). */
  async stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.licence.stop();
    if (this.licenceTimer) clearInterval(this.licenceTimer);
    this.licenceTimer = null;
    this.storage.stopSweeper();
    // In-flight deliveries get a few seconds; the rest stay pending for the next start (#66).
    await this.webhooks.stop();
    await this.auditLog.close();
  }

  /** Job state changes as outbound events; progress at most once per 10 % (#66). */
  private onJobEvent(e: JobEvent) {
    if (e.type === 'log') return;
    const job = e.job;
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
    if (job.status === 'succeeded' && (job.type === 'render' || job.type === 'preview') && job.result) {
      this.webhooks.emit('render.ready', { ...renderSummary(job.result), jobId: job.id, kind: job.type });
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
    if (use('limits.renderConcurrency')) this.jobs.setConcurrency(resolved.config.limits.renderConcurrency);
    if (use('limits.maxUploadBytes')) this.assets.limits.maxBytes = resolved.config.limits.maxUploadBytes;
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

  private toolsOrNull(): Tools | null {
    try {
      return this.tools();
    } catch {
      return null;
    }
  }

  // ---- discovery ------------------------------------------------------------

  capabilities() {
    const tools = this.toolsOrNull();
    const engines = this.registry.listEngines();
    const sandboxOff = engines.filter((e) => e.browserSandbox?.() === false).map((e) => e.id);
    return {
      server: { name: 'reelforge-studio', version: this.serverVersion, edition: this.settings.current.build.edition, mcpToolsStatus: 'experimental' },
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
          templates: e.templates().map((t) => t.id),
        };
      }),
      templates: this.registry.templateInfos().map(({ propsSchema: _p, ...t }) => t),
      providers: this.listProviders(),
      backends: this.registry.listBackends().map((b) => ({
        id: b.id,
        displayName: b.displayName,
        configured: b.configured(),
        implemented: b.implemented,
        default: b.id === 'local',
        env: b.env,
      })),
      storage: [{ id: this.storage.driver.id, active: true, downloads: this.storage.downloads }],
      limits: {
        maxProjectSeconds: MAX_PROJECT_SECONDS,
        maxScenes: 50,
        supportedFps: SUPPORTED_FPS,
        defaultOutput: DEFAULT_OUTPUT,
        maxUploadBytes: this.assets.limits.maxBytes,
        maxHtmlBytes: MAX_SOURCE_BYTES,
        renderConcurrency: this.jobs.concurrency,
      },
      licence: this.licence.summary(),
      security: {
        chromiumSandbox: Object.fromEntries(engines.filter((e) => e.browserSandbox).map((e) => [e.id, e.browserSandbox!()])),
        ...(sandboxOff.length
          ? {
              warning:
                `Chromium runs without its own sandbox for: ${sandboxOff.join(', ')}. The container (non-root, read-only, no capabilities) is the isolation boundary.` +
                (sandboxOff.includes('remotion') ? ' Remotion always passes --no-sandbox.' : '') +
                (sandboxOff.some((id) => id !== 'remotion')
                  ? ' To sandbox html, hyperframes and motion-canvas, run the container with the seccomp profile deployment/seccomp/chrome.json and REELFORGE_CHROMIUM_NO_SANDBOX=0 (docs/DEPLOY.md).'
                  : ''),
            }
          : {}),
      },
      versions: {
        node: process.version,
        ffmpeg: tools ? toolVersion(tools.ffmpeg) : null,
        ffprobe: tools ? toolVersion(tools.ffprobe) : null,
      },
      workflow: [
        'list_templates and list_themes to see what exists',
        'create_project with a manifest (schemaVersion "0.2"; "0.1" is migrated)',
        'edit with add_scene / update_scene / set_theme / set_audio; validate_project after edits',
        'render_project, then get_job with waitSeconds: 45 until succeeded, then get_render_output',
        'renders need a valid licence: if licence.renderAllowed is false, get_licence says what the user must do',
      ],
    };
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
    const r = parseProject(input, { catalog: this.registry.catalog() });
    if (!r.ok) throw invalidManifest(r.issues);
    return r;
  }

  async listProjects() {
    return (await this.projects.listWithManifests()).map(({ meta, manifest }) => ({
      ...meta,
      title: manifest.title,
      scenes: manifest.scenes.length,
      durationSeconds: totalFrames(manifest) / manifest.output.fps,
    }));
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
    await this.projects.delete(id);
    for (const [run, pid] of this.renderIndex) if (pid === id) this.renderIndex.delete(run);
    if (!this.storage.isLocal) {
      // The local folder is gone; remove the project's renders from the bucket too (manifests first).
      const objects = await this.storage.driver.list(`${PROJECTS_PREFIX}${id}/`);
      const order = [...objects.filter((o) => o.key.endsWith(`/${RENDER_MANIFEST}`)), ...objects.filter((o) => !o.key.endsWith(`/${RENDER_MANIFEST}`))];
      for (const o of order) await this.storage.driver.delete(o.key);
    }
  }

  async listProjectVersions(id: string) {
    await this.projects.get(id);
    return this.projects.listVersions(id);
  }

  /** Validate an arbitrary manifest without storing it. */
  async validateManifest(input: unknown, projectId: string | null = null): Promise<ValidationReport> {
    const r = parseProject(input, { catalog: this.registry.catalog() });
    if (!r.ok) return { ok: false, errors: r.issues, warnings: [], migratedFrom: null };
    const deep = await this.deepChecks(r.project, projectId);
    const errors = deep.errors;
    return {
      ok: errors.length === 0,
      errors,
      warnings: [...r.warnings, ...deep.warnings],
      migratedFrom: r.migratedFrom,
      summary: {
        scenes: r.project.scenes.length,
        totalFrames: totalFrames(r.project),
        durationSeconds: totalFrames(r.project) / r.project.output.fps,
        width: r.project.output.width,
        height: r.project.output.height,
        fps: r.project.output.fps,
        engines: [...new Set(r.project.scenes.map((s) => s.engine))],
      },
    };
  }

  async validateProject(id: string): Promise<ValidationReport> {
    const { manifest } = await this.projects.get(id);
    return this.validateManifest(manifest, id);
  }

  /** Checks that need the server: theme exists, backend usable, engines available, asset files present. */
  private async deepChecks(p: Project, projectId: string | null): Promise<{ errors: ValidationIssue[]; warnings: ValidationWarning[] }> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationWarning[] = [];
    try {
      await this.themes.resolve(p.theme);
    } catch (e) {
      errors.push({ path: 'theme', message: (e as Error).message + `; available: ${(await this.themes.list()).map((t) => t.id).join(', ')}` });
    }
    try {
      const b = this.registry.backend(p.render.backend);
      if (!b.configured()) errors.push({ path: 'render.backend', message: `backend "${b.id}" is not configured on this server (set ${b.env.join(', ')})` });
      else if (!b.implemented) errors.push({ path: 'render.backend', message: `backend "${b.id}" is not implemented in this version; use "local"` });
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
    for (const [i, a] of p.assets.entries()) {
      if (a.uri.startsWith('https://')) {
        errors.push({ path: `assets.${i}.uri`, message: `asset "${a.id}" has not been imported; call add_asset_from_url with this URL` });
      } else if (a.uri.startsWith('asset://')) {
        if (!(await this.assets.find(a.uri.slice('asset://'.length)))) {
          errors.push({ path: `assets.${i}.uri`, message: `asset "${a.id}" (${a.uri}) is not in the asset store` });
        }
      } else if (a.uri.startsWith('project://')) {
        if (projectId === null) {
          warnings.push({ path: `assets.${i}.uri`, message: `project:// asset "${a.id}" is checked when the project is saved` });
        } else if (!existsSync(this.projectFile(projectId, a.uri))) {
          errors.push({ path: `assets.${i}.uri`, message: `file for asset "${a.id}" not found in the project's assets/ folder` });
        }
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
      (current) => this.parseOrThrow({ ...current, audio: applyMergePatch(current.audio, audioPatch) }).project,
      expectedVersion
    );
  }

  // ---- renders --------------------------------------------------------------

  async startRender(id: string, opts: { backend?: string } = {}): Promise<JobRecord> {
    return this.enqueueRender(id, 'render', opts.backend);
  }

  async preview(id: string, opts: { sceneId?: string; scale?: number } = {}): Promise<JobRecord> {
    const scale = opts.scale ?? 1 / 3;
    if (!(scale > 0 && scale <= 1)) throw badRequest('scale must be > 0 and <= 1');
    return this.enqueueRender(id, 'preview', undefined, opts.sceneId ? [opts.sceneId] : undefined, scale);
  }

  private async enqueueRender(id: string, kind: 'render' | 'preview', backendOverride?: string, sceneIds?: string[], scale?: number) {
    await this.licence.assertRenderAllowed();
    const { manifest, meta } = await this.projects.get(id);
    if (sceneIds) {
      for (const s of sceneIds) {
        if (!manifest.scenes.some((x) => x.id === s)) throw notFound('scene', s, { scenes: manifest.scenes.map((x) => x.id) });
      }
    }
    const report = await this.validateProject(id);
    const backendId = backendOverride ?? manifest.render.backend;
    const backend = this.registry.backend(backendId);
    if (!backend.configured()) {
      throw new ApiError('backend_not_configured', 409, `render backend "${backendId}" is not configured; set ${backend.env.join(', ')}`);
    }
    if (!backend.implemented) {
      throw new ApiError('not_implemented', 501, `render backend "${backendId}" is not implemented in v0.1; use backend "local"`);
    }
    const blocking = report.errors.filter((e) => !(backendOverride && e.path === 'render.backend'));
    if (blocking.length) throw new ApiError('validation_failed', 422, 'fix these problems before rendering (see details.errors)', { errors: blocking, warnings: report.warnings });
    const runId = newId(kind === 'preview' ? 'prv' : 'run');
    return this.withRenderQuota((apiKeyId) =>
      this.jobs.submit(
        kind,
        { projectId: id, version: meta.version, backend: backendId, runId, ...(sceneIds ? { sceneIds } : {}), ...(scale ? { scale } : {}) },
        { projectId: id, ...(apiKeyId ? { apiKeyId } : {}) }
      )
    );
  }

  /**
   * Start a render or preview job under the calling key's render quota
   * (rendersPerDay / rendersPerMonth, UTC). The check and the insert are
   * serialised per key in this process, so parallel calls cannot overshoot.
   */
  private async withRenderQuota<T>(submit: (apiKeyId?: string) => Promise<T>): Promise<T> {
    const auth = currentRequest()?.auth;
    if (!auth || auth.keyId === 'signed-url') return submit();
    if (auth.rendersPerDay === undefined && auth.rendersPerMonth === undefined) return submit(auth.keyId);
    const previous = this.quotaLocks.get(auth.keyId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const w = quotaWindows(this.now());
      for (const [period, limit, since, resetsAt] of [
        ['day', auth.rendersPerDay, w.dayStart, w.dayEnd],
        ['month', auth.rendersPerMonth, w.monthStart, w.monthEnd],
      ] as const) {
        if (limit === undefined) continue;
        const used = await this.repos.jobs.countByApiKey(auth.keyId, since, QUOTA_JOB_TYPES);
        if (used >= limit) {
          throw new ApiError('quota_exceeded', 429, `this API key may start ${limit} render${limit === 1 ? '' : 's'} per ${period} (renders and previews, UTC); ${used} used. The quota resets at ${resetsAt}.`, {
            period,
            limit,
            used,
            resetsAt,
          });
        }
      }
      return submit(auth.keyId);
    });
    this.quotaLocks.set(auth.keyId, run);
    try {
      return await run;
    } finally {
      if (this.quotaLocks.get(auth.keyId) === run) this.quotaLocks.delete(auth.keyId);
    }
  }

  private async runRenderJob(ctx: JobContext): Promise<Record<string, unknown>> {
    const p = ctx.job.params as { projectId: string; version: number; backend: string; runId: string; sceneIds?: string[]; scale?: number };
    const project = await this.projects.getVersion(p.projectId, p.version);
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
      },
      { signal: ctx.signal, log: ctx.log, progress: ctx.progress }
    );
    this.renderIndex.set(outcome.runId, p.projectId);
    const summary = await this.getRender(outcome.runId);
    return { ...summary };
  }

  /** Assets of a project as local files. */
  async resolveAssets(project: Project, projectId: string): Promise<Map<string, ResolvedAsset>> {
    const map = new Map<string, ResolvedAsset>();
    for (const a of project.assets) {
      let file: string;
      if (a.uri.startsWith('asset://')) file = await this.assets.file(a.uri.slice('asset://'.length));
      else if (a.uri.startsWith('project://')) file = this.projectFile(projectId, a.uri);
      else throw new ApiError('asset_not_imported', 422, `asset "${a.id}" is a remote URL; import it with add_asset_from_url first`);
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
    const pos = this.jobs.queuePosition(id);
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
  async listJobs(filter: { projectId?: string } = {}) {
    return this.jobs.list(filter);
  }
  cancelJob(id: string) {
    return this.jobs.cancel(id);
  }
  async retryJob(id: string) {
    const job = await this.getJob(id);
    if (job.type === 'render' || job.type === 'preview') {
      await this.licence.assertRenderAllowed();
      return this.withRenderQuota((apiKeyId) => this.jobs.retry(id, apiKeyId ? { apiKeyId } : {}));
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

  private async findRender(runId: string): Promise<{ projectId: string }> {
    if (!/^(run|prv)_[a-z0-9]+$/.test(runId)) throw notFound('render', runId);
    const known = this.renderIndex.get(runId);
    const candidates = known ? [known] : (await this.projects.list()).map((m) => m.id);
    for (const pid of candidates) {
      if (await this.storage.renders.exists(pid, runId)) {
        this.renderIndex.set(runId, pid);
        return { projectId: pid };
      }
    }
    throw notFound('render', runId);
  }

  async getRender(runId: string): Promise<RenderSummary> {
    const { projectId } = await this.findRender(runId);
    const m = await this.storage.renders.readManifest<{
      kind: string;
      createdAt: string;
      output: { durationSeconds: number; frames: number; width: number; height: number; fps: number };
      scenes: Array<{ file: string }>;
    }>(projectId, runId);
    if (!m) throw notFound('render', runId);
    const base = `/v1/renders/${runId}/output`;
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
      files: ['final.mp4', 'poster.png', 'render-manifest.json', ...m.scenes.map((s) => s.file)],
      outputUrl: this.url(base),
      posterUrl: this.url(`${base}?file=poster.png`),
      manifestUrl: this.url(`${base}?file=render-manifest.json`),
      ...(await this.downloadLink(projectId, runId)),
    };
  }

  /**
   * downloadUrl for a render file: signed by the bucket when the driver can
   * and storage.downloads allows it, else a signed link to this server (D-067).
   */
  private async downloadLink(projectId: string, runId: string, file = 'final.mp4') {
    const ttl = this.config.signedUrlTtlSeconds ?? 3600;
    const url = await this.storage.bucketUrl(renderPrefix(projectId, runId) + file, ttl, { filename: file.split('/').pop(), contentType: contentTypeFor(file) });
    if (url) return { downloadUrl: url, downloadUrlExpiresAt: new Date(Date.now() + Math.min(ttl, 7 * 24 * 3600) * 1000).toISOString(), downloadVia: 'bucket' as const };
    return { ...this.signedDownload(runId, file, ttl), downloadVia: 'server' as const };
  }

  /** A time-limited link to one render file on this server that needs no API key. */
  signedDownload(runId: string, file = 'final.mp4', ttlSeconds = this.config.signedUrlTtlSeconds ?? 3600) {
    const { expires, sig } = this.signer.sign([runId, file], ttlSeconds);
    const q = new URLSearchParams({ ...(file !== 'final.mp4' ? { file } : {}), expires: String(expires), sig });
    return { downloadUrl: this.url(`/v1/renders/${runId}/output?${q}`), downloadUrlExpiresAt: new Date(expires * 1000).toISOString() };
  }

  verifySignedDownload(runId: string, file: string, expires: number, sig: string): boolean {
    return this.signer.verify([runId, file], expires, sig);
  }

  async getRenderManifest(runId: string): Promise<unknown> {
    const { projectId } = await this.findRender(runId);
    return this.storage.renders.readManifest(projectId, runId);
  }

  async listRenders(projectId: string): Promise<RenderSummary[]> {
    await this.projects.get(projectId);
    const out: RenderSummary[] = [];
    for (const run of (await this.storage.renders.listRuns(projectId)).filter((r) => r.complete)) {
      this.renderIndex.set(run.runId, projectId);
      try {
        out.push(await this.getRender(run.runId));
      } catch {
        // incomplete or foreign directory
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** A file of a render in storage (final.mp4 by default): its key, type and size, for streaming. */
  async renderObject(runId: string, file = 'final.mp4'): Promise<{ key: string; contentType: string; bytes: number }> {
    if (!isSafeRelativePath(file) || !/^(final\.mp4|poster\.png|render-manifest\.json|clips\/[\w.-]+\.mp4)$/.test(file)) {
      throw badRequest('file must be final.mp4, poster.png, render-manifest.json or clips/<name>.mp4');
    }
    const { projectId } = await this.findRender(runId);
    const key = renderPrefix(projectId, runId) + file;
    const s = await this.storage.driver.stat(key);
    if (!s) throw notFound('render file', `${runId}/${file}`);
    return { key, contentType: contentTypeFor(file), bytes: s.bytes };
  }

  /** A local file with a render file's bytes (remote storage: a cached copy). */
  async renderFile(runId: string, file = 'final.mp4'): Promise<{ path: string; contentType: string }> {
    const o = await this.renderObject(runId, file);
    return { path: await this.storage.localFile(o.key, o.bytes), contentType: o.contentType };
  }

  // ---- storage --------------------------------------------------------------

  /** Driver, where the bytes go (no secrets), health, usage, retention policy and the last sweep. */
  getStorage() {
    return this.storage.status();
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
    for (const r of report.renders) if (!report.dryRun) this.renderIndex.delete(r.renderId);
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
    await this.projects.update(projectId, (current) => {
      const assets = current.assets.filter((a) => a.id !== id);
      return this.parseOrThrow({ ...current, assets: [...assets, entry] }).project;
    });
    return id;
  }

  async uploadAsset(data: Buffer, opts: { filename?: string; contentType?: string; projectId?: string; assetId?: string; license?: StoredAsset['license'] } = {}) {
    if (opts.projectId) await this.projects.get(opts.projectId);
    const asset = await this.assets.put({ data, source: 'upload', originalName: opts.filename, declaredContentType: opts.contentType, license: opts.license });
    const projectAssetId = opts.projectId ? await this.attachToProject(opts.projectId, asset, opts.assetId, opts.license) : undefined;
    return { asset, uri: `asset://${asset.id}`, projectAssetId };
  }

  async addAssetFromUrl(url: string, opts: { projectId?: string; assetId?: string; license?: StoredAsset['license'] } = {}) {
    if (typeof url !== 'string' || !url) throw badRequest('url is required');
    if (opts.projectId) await this.projects.get(opts.projectId);
    const asset = await this.assets.fromUrl(url, { license: opts.license });
    const projectAssetId = opts.projectId ? await this.attachToProject(opts.projectId, asset, opts.assetId, opts.license) : undefined;
    return { asset, uri: `asset://${asset.id}`, projectAssetId };
  }

  getAsset(id: string) {
    return this.assets.get(id);
  }

  async listAssets(opts: { projectId?: string } = {}) {
    if (!opts.projectId) return this.assets.list();
    const { manifest } = await this.projects.get(opts.projectId);
    return manifest.assets;
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
    const cacheFile = cacheKey ? join(this.cacheDir, 'providers', `${cacheKey}.json`) : null;
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
      if (!provider.configured()) {
        throw new ApiError('provider_not_configured', 409, `provider "${providerId}" is not configured on this server; the operator must set ${provider.env.join(', ')}`);
      }
      if (!opts.acknowledgeCost) {
        throw new ApiError('cost_acknowledgement_required', 402, `this call may cost money: ${provider.costNote} Ask the user, then call again with acknowledgeCost: true.`, {
          costNote: provider.costNote,
        });
      }
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

  /** Providers, whether they are configured, and which settings are set (never their values). */
  listProviders() {
    return this.registry.listProviders().map((p) => ({
      id: p.id,
      kind: p.kind,
      displayName: p.displayName,
      configured: p.configured(),
      costNote: p.costNote,
      env: p.env,
      settings: p.env.map((name): ProviderSetting => {
        const error = this.settings.providerError(name);
        const def = RuntimeConfig.settingForProviderEnv(name);
        const r = def ? this.settings.current.settings.get(def.key) : undefined;
        if (r && r.value !== undefined && r.source !== 'default') return { name, set: true, source: r.source === 'runtime' ? 'api' : r.source };
        if (this.settings.hasProviderValue(name)) return { name, set: true, source: 'api' };
        if (this.baseEnv[name]) return { name, set: true, source: 'env' };
        return { name, set: false, source: 'unset', ...(error ? { error } : {}) };
      }),
    }));
  }

  /**
   * Set or clear provider settings (admin). Only the names the provider
   * declares are accepted. Values are stored encrypted (REELFORGE_SECRET_KEY
   * is required) and override the file and environment; clearing one falls
   * back to them.
   */
  async configureProvider(providerId: string, values: unknown, actor?: Actor) {
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
    await this.settings.setProviderValues(changes, providerId);
    await this.audit({
      actorType: actor?.actorType ?? 'system',
      ...(actor?.actorId ? { actorId: actor.actorId } : {}),
      action: 'provider.configure',
      targetType: 'provider',
      targetId: providerId,
      data: { settings: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v === null ? 'cleared' : 'set'])) },
    });
    return this.listProviders().find((p) => p.id === providerId)!;
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

  /** A page of audit entries, newest first, filtered (list_audit_events / GET /v1/audit). */
  async listAuditEvents(query: Record<string, unknown> = {}) {
    const filter = parseAuditQuery(query);
    const r = await this.auditLog.list(filter);
    return { ...r, retentionDays: this.settings.current.config.audit.retentionDays, sinks: this.auditLog.activeSinks() };
  }

  /**
   * Matching entries as JSON lines or CSV, streamed one database page (1000
   * entries) at a time, newest first, up to `limit` (default and maximum
   * 100 000 per export; narrow the time range for more).
   */
  streamAuditEvents(query: Record<string, unknown> = {}, format: unknown = 'jsonl'): { format: 'jsonl' | 'csv'; contentType: string; filename: string; chunks: AsyncGenerator<string> } {
    if (format !== 'jsonl' && format !== 'csv') throw badRequest('format must be jsonl or csv');
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

  /** A key with its render usage today and this month (UTC). */
  async getKey(id: string): Promise<PublicKey & { usage: { rendersToday: number; rendersThisMonth: number } }> {
    const k = await this.keys.get(id);
    const w = quotaWindows(this.now());
    const [rendersToday, rendersThisMonth] = await Promise.all([
      this.repos.jobs.countByApiKey(id, w.dayStart, QUOTA_JOB_TYPES),
      this.repos.jobs.countByApiKey(id, w.monthStart, QUOTA_JOB_TYPES),
    ]);
    return { ...k, usage: { rendersToday, rendersThisMonth } };
  }
  createKey(name: string, scopes: Scope[], opts: KeyOptions = {}, actor?: Actor) {
    return this.keys.create(name, scopes, opts, actor);
  }
  updateKey(id: string, patch: KeyOptions & { name?: string }, actor?: Actor) {
    return this.keys.update(id, patch, actor);
  }
  rotateKey(id: string, opts: { graceHours?: number } = {}, actor?: Actor) {
    return this.keys.rotate(id, opts, actor);
  }
  revokeKey(id: string, actor?: Actor) {
    if (actor?.actorId === id) throw new ApiError('conflict', 409, 'refusing to revoke the key used for this request; use another admin key');
    return this.keys.revoke(id, actor);
  }
  deleteKey(id: string, actor?: Actor) {
    if (actor?.actorId === id) throw new ApiError('conflict', 409, 'refusing to delete the key used for this request');
    return this.keys.delete(id, actor);
  }

  /** Frames of every scene, for agents planning exact timing. */
  static sceneTiming(p: Project) {
    let cursor = 0;
    return p.scenes.map((s) => {
      const frames = sceneFrames(s, p.output.fps);
      const t = { id: s.id, startFrame: cursor, durationFrames: frames, startSeconds: cursor / p.output.fps, durationSeconds: frames / p.output.fps };
      cursor += frames;
      return t;
    });
  }
}
