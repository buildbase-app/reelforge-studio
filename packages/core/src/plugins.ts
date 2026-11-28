import type { Readable } from 'node:stream';
import type { Tools } from '@renderweld/media-pipeline';
import type {
  CaptionMode,
  ClipTextCheck,
  RenderAudioOptions,
  OutputSettings,
  Project,
  RenderScene,
  TemplateDefinition,
  ThemeTokens,
} from '@renderweld/project-schema';
import type { z } from 'zod';
import type { RuntimeConfig } from './config/runtime';
import type { EngineOutputSupport } from './output-support';

/**
 * Plugin contracts (docs/AGENT_PLATFORM.md §4). Engines, providers, render
 * backends and storage are registered implementations of these interfaces;
 * adding one never needs a change to the core or the manifest format.
 */

export interface Logger {
  (line: string): void;
}

/** A template as an engine exposes it. Definitions live in @renderweld/project-schema. */
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
   * `frameLayout(width, height, platform)` (@renderweld/project-schema): tall
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
  /**
   * Cancellation (job cancel, render timeout). It may already be aborted when render() is called: check
   * `signal.aborted` first, then listen for 'abort'; pass it to child processes (spawn's `signal` option does both).
   */
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
  /**
   * The render keeps a transparent background (#302: output.alpha). Set only
   * for engines whose capabilities() declare `output.alpha`. The clip at `out`
   * (ending in .mov) is then ProRes 4444 with an alpha channel
   * (ALPHA_CLIP_ARGS), transparent wherever the scene paints nothing; the page
   * background itself is not painted.
   */
  alpha?: boolean;
  /**
   * Text overflow check (#294, #386): the engine samples the text on screen at
   * least TEXT_SAMPLES_PER_SECOND times a second while it renders (in a DOM
   * page, TEXT_SAMPLE_SCRIPT) and returns what it found in `ClipResult.text`.
   * Engines that cannot sample ignore it, and the check counts as skipped for
   * their scenes.
   */
  textCheck?: boolean;
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
   * Output support beyond an opaque H.264 clip (#302: alpha), and sizes and
   * frame rates the engine renders beyond the H.264 rules every engine shares
   * (output-support.ts). A render or preview outside them is refused before
   * it is queued (`422 unsupported_output`). Omitted: no alpha, every
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
  /** With `EngineRenderContext.textCheck`, from an engine that samples text: what it found. */
  text?: ClipTextCheck;
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
  /**
   * Called once by the service with its settings, before the first availability() or render(), so an engine can
   * read its own `engines.*` settings and the build edition (they can change at runtime, so read them when needed).
   */
  useSettings?(settings: RuntimeConfig): void;
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
  /**
   * The calling workspace's own provider settings for this call, by the names in `env` (#480,
   * configure_workspace_provider). A provider with `scopedSettings` reads its key from here when it is set, so
   * that workspace's calls go to its own account. Absent when the call uses the instance's settings (the default
   * workspace, or a workspace that may share them: `providers.shareWithWorkspaces`): the provider then reads the
   * environment it was built with, as before.
   */
  env?: Readonly<Record<string, string | undefined>>;
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
  /**
   * Is it configured (API key set)? With `env`, decide from those settings (one workspace's, see
   * ProviderRunContext.env); without, from the instance's.
   */
  configured(env?: Readonly<Record<string, string | undefined>>): boolean;
  /**
   * True when the provider reads its settings from `ctx.env` and `configured(env)`, so a workspace can bring
   * its own account (#480). Without it, only the instance's settings are used, and a workspace that may not
   * share them cannot use the provider.
   */
  scopedSettings?: boolean;
  /** Shown to agents before they call it. */
  costNote: string;
  /** Environment variables the operator sets to configure it. */
  env: string[];
  params: z.ZodType;
  /** Stable key for the content-hash cache; same key means same output. */
  cacheKey?(params: unknown): string;
  run(params: unknown, ctx: ProviderRunContext): Promise<ProviderResult>;
}

/** Settings a speech-to-text provider runs with (config `captions.stt.*`, docs/CAPTIONS.md#speech-to-text). */
export interface SttSettings {
  /** Program to start: a name on PATH or an absolute path. */
  command: string;
  model: string;
  modelDir?: string;
  /** "auto" or a BCP 47 tag. */
  language: string;
  computeType: string;
  device: string;
  timeoutSeconds: number;
}

export interface SttRequest {
  /** A local audio or video file from the asset store. */
  file: string;
  /** BCP 47 tag of the spoken language, or "auto" to detect it. */
  language: string;
  settings: SttSettings;
  /** Words to expect, such as the project glossary's terms (#486): faster-whisper's `initial_prompt`. */
  prompt?: string;
}

export interface SttResult {
  /** Detected or given language (BCP 47 / ISO 639-1), when the provider reports it. */
  language: string | null;
  /** Words with times in seconds from the start of the file. */
  words: Array<{ text: string; start: number; end: number }>;
  durationSeconds?: number;
  /** What produced it (name, version, model), for the response and the cache. */
  engine: Record<string, string>;
}

/**
 * Turns speech in an audio asset into timed words (#300). Runs locally: no
 * network at run time, no cost note. Words become caption cues through
 * buildCuesFromWords (the voice track's `words`).
 */
export interface SpeechToTextPlugin {
  id: string;
  displayName: string;
  /** Whether it can run here with these settings (program installed, ...), and how to fix it when not. Cheap: no transcription. */
  availability(settings: SttSettings): Availability;
  transcribe(req: SttRequest, ctx: { signal: AbortSignal; log: Logger }): Promise<SttResult>;
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
  /** Overrides the manifest's audio toggles and loudness preset for this render (render_project's `audio`). */
  audio?: RenderAudioOptions;
  /** The server's captions.defaultMode when the job was queued (projects without captions.mode). */
  captionsDefault?: CaptionMode;
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
 *   started container runs `renderweld worker --once --job <id>`;
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
