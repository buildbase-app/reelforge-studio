import type { Readable } from 'node:stream';
import type { Tools } from '@reelforge/media-pipeline';
import type {
  CaptionMode,
  OutputSettings,
  Project,
  RenderScene,
  TemplateDefinition,
  ThemeTokens,
} from '@reelforge/project-schema';
import type { z } from 'zod';
import type { EngineOutputSupport } from './output-support';

/**
 * Plugin contracts (docs/AGENT_PLATFORM.md §4). Engines, providers, render
 * backends and storage are registered implementations of these interfaces;
 * adding one never needs a change to the core or the manifest format.
 */

export interface Logger {
  (line: string): void;
}

/** A template as an engine exposes it. Definitions live in @reelforge/project-schema. */
export interface EngineTemplate extends TemplateDefinition {
  id: string;
}

/** What the server reports about a template (JSON-friendly). */
export interface TemplateInfo {
  id: string;
  engine: string;
  description: string;
  minSeconds: number;
  maxSeconds: number;
  themeTokens: readonly string[];
  propsSchema: Record<string, unknown>;
}

export interface ResolvedAsset {
  id: string;
  file: string;
  mediaType: 'audio' | 'image' | 'video' | 'font';
  contentType?: string;
}

export interface EngineRenderContext {
  output: OutputSettings;
  theme: ThemeTokens;
  /**
   * The manifest's brief.platform, if any. Templates read safe areas from
   * `frameLayout(width, height, platform)` (@reelforge/project-schema): tall
   * frames keep text out of the social-app ui zone unless the platform is one
   * without app ui ("none", "broadcast", ...).
   */
  platform?: string;
  /** Where to write the clip: H.264 MP4, no audio, exactly scene.durationFrames frames. */
  out: string;
  /** Scratch directory for this scene. */
  workDir: string;
  /** Long-lived build cache (bundles). */
  cacheDir: string;
  tools: Tools;
  /** Assets referenced by the project, already on local disk. */
  assets: ReadonlyMap<string, ResolvedAsset>;
  signal: AbortSignal;
  progress(framesDone: number, framesTotal: number): void;
  log: Logger;
  /**
   * Render only these frames of the scene, first and last inclusive (render
   * fan-out chunks, D-097). Set only for engines whose capabilities() declare
   * `frameRanges`. The clip then holds exactly `last - first + 1` frames, and
   * its frame k is the scene's frame `first + k`, the same pixels the full
   * render has at that frame (the scene still lasts `durationFrames`).
   * Progress counts the range's frames.
   */
  frameRange?: readonly [number, number];
}

/** What an engine can do beyond rendering a whole scene. */
export interface EngineCapabilities {
  /**
   * The engine honours `EngineRenderContext.frameRange` and its frames are
   * frame-pure: frame n renders the same whether the render starts at 0 or at
   * n (no state accumulated from frame 0), so a long scene can be split into
   * chunks rendered by different workers.
   */
  frameRanges: boolean;
  /**
   * Sizes and frame rates the engine renders beyond the H.264 rules every
   * engine shares (output-support.ts). A render or preview outside them is
   * refused before it is queued (`422 unsupported_output`). Omitted: every
   * supported rate, no size limit of its own.
   */
  output?: EngineOutputSupport;
}

export interface ClipResult {
  file: string;
  frames: number;
  engineVersion: string;
  browserVersion?: string;
  millis: number;
}

export interface Availability {
  ok: boolean;
  /** Why the engine/backend/provider cannot be used, and how to fix it. */
  reason?: string;
}

/** Turns one scene into a video clip. */
export interface EnginePlugin {
  id: string;
  displayName: string;
  version(): string;
  templates(): EngineTemplate[];
  /** True if scenes may bring their own html/css instead of a template. */
  acceptsSource: boolean;
  /** Whether this engine can render on this machine right now (browser present, ...). */
  availability(): Availability;
  /** Whether this engine's Chromium runs with its own sandbox (omit for engines without a browser). */
  browserSandbox?(): boolean;
  /** What it can do beyond whole scenes; omitted: no frame ranges. */
  capabilities?(): EngineCapabilities;
  render(scene: RenderScene, ctx: EngineRenderContext): Promise<ClipResult>;
}

export interface StoredAsset {
  id: string;
  sha256: string;
  bytes: number;
  contentType: string;
  mediaType: 'audio' | 'image' | 'video' | 'font';
  createdAt: string;
  /** "upload", a provider id, or the original URL. */
  source: string;
  originalName?: string;
  license?: { name: string; source?: string; author?: string; attribution?: string; redistributable: boolean };
  durationSeconds?: number;
  /** Extra provider output, e.g. TTS word timestamps. */
  metadata?: Record<string, unknown>;
}

export interface PutAssetInput {
  data: Buffer;
  source: string;
  originalName?: string;
  declaredContentType?: string;
  license?: StoredAsset['license'];
  metadata?: Record<string, unknown>;
}

export interface ProviderRunContext {
  signal: AbortSignal;
  log: Logger;
  putAsset(input: PutAssetInput): Promise<StoredAsset>;
  /** fetch, injectable for tests. */
  fetch: typeof fetch;
}

export interface ProviderResult {
  asset: StoredAsset;
  /** Provider-specific output, e.g. `{ words: [{ word, start, end }] }`. */
  data?: Record<string, unknown>;
  /** True when the result came from the content-hash cache (no provider call, no cost). */
  cached?: boolean;
}

/** Produces an asset (audio, video, image) from parameters. */
export interface ProviderPlugin {
  id: string;
  kind: 'tts' | 'avatar' | 'music' | 'stock' | 'image';
  displayName: string;
  /** Has the operator configured it (API key set)? */
  configured(): boolean;
  /** Shown to agents before they call it. */
  costNote: string;
  /** Environment variables the operator sets to configure it. */
  env: string[];
  params: z.ZodType;
  /** Stable key for the content-hash cache; same key means same output. */
  cacheKey?(params: unknown): string;
  run(params: unknown, ctx: ProviderRunContext): Promise<ProviderResult>;
}

export interface RenderRequest {
  jobId: string;
  runId: string;
  kind: 'render' | 'preview';
  project: Project;
  projectVersion: number;
  /** Scenes to render (preview); all when omitted. */
  sceneIds?: string[];
  /** Output scale for previews (0 < scale <= 1). */
  scale?: number;
  /** Overrides the manifest's captions.mode for this render. */
  captionsMode?: CaptionMode;
}

export interface RenderOutcome {
  runId: string;
  dir: string;
  outputFile: string;
  manifestFile: string;
}

export interface BackendContext {
  signal: AbortSignal;
  log: Logger;
  progress(stage: string, fraction: number, detail?: string): void;
}

/**
 * How a backend gets compute (D-095, D-100; docs/providers/backends.md):
 * - `pool`: workers that are already running claim jobs from the queue (this
 *   server, N `worker` containers, or `worker --once` containers a job platform starts);
 * - `launcher`: calls a platform API ("run task", "execute job") per queued unit; the
 *   started container runs `reelforge worker --once --job <id>`;
 * - `managed`: a renderer someone else operates for one engine (Remotion Lambda),
 *   called by the worker that claimed the job.
 */
export type RenderBackendKind = 'pool' | 'launcher' | 'managed';
export const RENDER_BACKEND_KINDS: readonly RenderBackendKind[] = ['pool', 'launcher', 'managed'];

/** What a backend can render (reported by get_capabilities; checked by validate_project). */
export interface BackendCapabilities {
  /** Engine ids it can render. */
  engines: string[];
  /** Longest render unit (one scene, or one frame range) it accepts, in seconds; null: no limit of its own. */
  maxUnitSeconds: number | null;
  /**
   * Whether it can render part of a scene (a frame range), so a long scene can be split
   * (`render.fanOut: scenes+chunks`). Only scenes of engines whose own capabilities
   * declare `frameRanges` are split.
   */
  frameRanges: boolean;
  /** Whether it starts and stops compute per render by itself (nothing runs, nothing is billed, while idle). */
  scaleToZero: boolean;
}

/** What a render would take on a backend, shown before the job starts. */
export interface BackendEstimate {
  backend: string;
  /** Seconds of finished video. */
  videoSeconds: number;
  /** Render units (scenes) the job has. */
  units: number;
  /** Wall-clock estimate in seconds; null while it is not measured (#125). Never a guess. */
  seconds: number | null;
  /** Extra charge in USD by a third party (cloud, licence fee) for this render; 0 for own hardware; null when unknown. */
  costUsd: number | null;
  /** One or two sentences an agent can show the user. */
  note: string;
}

/** What estimate() is asked about: a render or preview before it is queued. */
export type EstimateRequest = Pick<RenderRequest, 'kind' | 'project' | 'sceneIds' | 'scale'>;

/** Where engine renders and assembly run. */
export interface RenderBackend {
  id: string;
  displayName: string;
  kind: RenderBackendKind;
  /** Configured by the operator (credentials, region, ...). */
  configured(): boolean;
  /** False for skeletons that exist so capabilities can report them honestly. */
  implemented: boolean;
  env: string[];
  capabilities(): BackendCapabilities;
  estimate(req: EstimateRequest): BackendEstimate;
  submit(req: RenderRequest, ctx: BackendContext): Promise<RenderOutcome>;
  cancel(jobId: string): Promise<void>;
}

/** One stored object, as listed by a storage driver. Keys are relative to the driver's root/prefix. */
export interface StorageObject {
  key: string;
  bytes: number;
  /** ISO time of the last write. */
  modifiedAt: string;
}

export interface StoragePutOptions {
  contentType?: string;
}

/** Inclusive byte range, as in an HTTP Range header. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Byte storage for assets and render outputs (docs/DECISIONS.md D-065).
 * Keys are safe relative paths with forward slashes, the same layout on every
 * driver: `assets/<assetId>/file.<ext>` and
 * `projects/<projectId>/renders/<runId>/<file>`. Prefixes passed to `list`
 * end with "/" (or are "" for everything).
 */
export interface StorageDriver {
  /** local | s3 | azure | gcs */
  id: string;
  /** Where the bytes go, for get_storage (bucket, endpoint, prefix, credential source). Never secrets. */
  describe(): Record<string, unknown>;
  put(key: string, data: Buffer, opts?: StoragePutOptions): Promise<{ bytes: number }>;
  /** Upload a local file (streamed). */
  putFile(key: string, file: string, opts?: StoragePutOptions): Promise<{ bytes: number }>;
  /** The object's bytes, or the inclusive `range` of them. Rejects when the key does not exist. */
  get(key: string, range?: ByteRange): Promise<Readable>;
  stat(key: string): Promise<{ bytes: number; modifiedAt: string } | null>;
  list(prefix: string): Promise<StorageObject[]>;
  /** Copy inside the store (server-side where the backend can). Overwrites `to`. */
  copy(from: string, to: string): Promise<void>;
  /** Delete one object; deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** A time-limited, read-only URL from the bucket itself; null when the driver cannot sign (local storage: serve through the API). */
  signedUrl(key: string, ttlSeconds: number, opts?: { filename?: string; contentType?: string }): Promise<string | null>;
  /** Local path for drivers that keep files on disk (engines need files); null for remote storage. */
  localPath(key: string): string | null;
  /** Can the store be reached and written with the configured credentials? */
  health(): Promise<{ ok: boolean; message?: string }>;
}
