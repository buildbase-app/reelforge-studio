import type { Readable } from 'node:stream';
import type { Tools } from '@reelforge/media-pipeline';
import type {
  OutputSettings,
  Project,
  RenderScene,
  TemplateDefinition,
  ThemeTokens,
} from '@reelforge/project-schema';
import type { z } from 'zod';

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

/** Where engine renders and assembly run. */
export interface RenderBackend {
  id: string;
  displayName: string;
  /** Configured by the operator (credentials, region, ...). */
  configured(): boolean;
  /** False for skeletons that exist so capabilities can report them honestly. */
  implemented: boolean;
  env: string[];
  submit(req: RenderRequest, ctx: BackendContext): Promise<RenderOutcome>;
  cancel(jobId: string): Promise<void>;
}

/** Byte storage for assets and outputs. */
export interface StorageDriver {
  id: string;
  put(key: string, data: Buffer): Promise<{ bytes: number }>;
  get(key: string): Promise<Readable>;
  stat(key: string): Promise<{ bytes: number } | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
  /** A time-limited URL for remote storage; null for local storage (serve through the API). */
  signedUrl(key: string, ttlSeconds: number): Promise<string | null>;
  /** Local path for drivers that keep files on disk (engines need files). */
  localPath(key: string): string | null;
}
