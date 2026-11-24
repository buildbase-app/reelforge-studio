import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCancelSignal, renderMedia, selectComposition } from '@remotion/renderer';
import { PipelineError } from '@reelforge/media-pipeline';
import { packageVersion, publishDirAtomically, sceneAssetUses, stageSceneAssets, stampMatches, startAssetServer, type AssetServer, type ResolvedAsset } from '@reelforge/core';
import type { Tools } from '@reelforge/media-pipeline';
import { BUILTIN_THEMES, TEMPLATES, domThemeCss, layoutSceneDom, layoutSceneProps, mediaKey, mediaUrlAt, type OutputSettings, type RenderScene, type SceneMedia, type ThemeTokens } from '@reelforge/project-schema';

const here = dirname(fileURLToPath(import.meta.url));
const compositionsDir = resolve(here, '../compositions');
const entryPoint = join(compositionsDir, 'Root.tsx');
/**
 * Bundle built at image build time (`apps/server/src/prebuild.ts`). Used when its
 * source hash matches, so a production container never runs Webpack and needs
 * no writable bundle directory.
 */
export const PREBUILT_REMOTION_DIR = resolve(here, '../.prebuilt/remotion');

export interface RemotionRenderOptions {
  scene: RenderScene;
  output: OutputSettings;
  /** Theme tokens; templates read colours and fonts from them (props override). */
  theme?: ThemeTokens;
  /** brief.platform (ui safe zone on tall frames, #287). */
  platform?: string;
  /** Where to write the clip (H.264 MP4, no audio). */
  out: string;
  /** Directory for the Webpack bundle. Reused between renders. */
  cacheDir: string;
  /**
   * Chrome Headless Shell (or Chrome) binary. Falls back to
   * REELFORGE_CHROMIUM_PATH, then lets Remotion download its pinned browser.
   */
  browserExecutable?: string;
  /** Parallel browser tabs. Defaults to Remotion's choice (half the CPUs). */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (framesDone: number, framesTotal: number) => void;
  rebuild?: boolean;
  /**
   * Only these frames of the scene, first and last inclusive (render fan-out
   * chunks): renderMedia's `frameRange`. The composition keeps the scene's
   * full duration, so frame n looks the same as in a whole render.
   */
  frameRange?: readonly [number, number];
  /** The project's assets (EngineRenderContext.assets); the scene may use only these (#299). */
  assets?: ReadonlyMap<string, ResolvedAsset>;
  /** FFmpeg/ffprobe for staging assets. */
  tools?: Tools;
  /** Scratch directory (staged assets). Default: next to `out`. */
  workDir?: string;
  log?: (line: string) => void;
}

export interface RemotionRenderResult {
  out: string;
  frames: number;
  engine: 'remotion';
  engineVersion: string;
  millis: number;
}

export function remotionVersion(): string {
  return packageVersion('remotion', import.meta.url);
}

function sourceHash(): string {
  const h = createHash('sha256');
  h.update(remotionVersion());
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(tsx?|css|json)$/.test(e.name)) {
        h.update(full.slice(compositionsDir.length));
        h.update(readFileSync(full));
      }
    }
  };
  walk(compositionsDir);
  // The compositions import the shared layout and media modules (#287, #299); a change to them must rebuild the bundle.
  h.update(readFileSync(createRequire(import.meta.url).resolve('@reelforge/project-schema/layout')));
  h.update(readFileSync(createRequire(import.meta.url).resolve('@reelforge/project-schema/media')));
  return h.digest('hex');
}


/**
 * The compositions bundled with Remotion's Webpack setup: the pre-built bundle
 * when it matches the sources, otherwise one built into cacheDir (cached by
 * source hash). `@remotion/bundler` (Webpack) is loaded only to build.
 */
export async function bundleCompositions(cacheDir: string, force = false): Promise<string> {
  const hash = sourceHash();
  if (!force && stampMatches(PREBUILT_REMOTION_DIR, hash)) return PREBUILT_REMOTION_DIR;
  const outDir = join(resolve(cacheDir), 'remotion');
  if (!force && stampMatches(outDir, hash)) return outDir;
  // Built next to outDir and renamed into place: another server process may be rendering from outDir right now.
  return publishDirAtomically(outDir, hash, async (dir) => void (await buildCompositions(dir, hash)), { force });
}

/** Pre-build the bundle next to the package (image build time). Returns its directory. */
export async function prebuildCompositions(): Promise<string> {
  return buildCompositions(PREBUILT_REMOTION_DIR, sourceHash(), { sourceMaps: false });
}

async function buildCompositions(outDir: string, hash: string, opts: { sourceMaps?: boolean } = {}): Promise<string> {
  const { bundle } = await import('@remotion/bundler');
  await bundle({
    entryPoint,
    outDir,
    enableCaching: opts.sourceMaps !== false,
    ...(opts.sourceMaps === false ? { webpackOverride: (c) => ({ ...c, devtool: false }) } : {}),
  });
  writeFileSync(join(outDir, '.source-hash'), hash);
  return outDir;
}

const attr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The markup of a remotion-layout scene: `layoutSceneDom`, the html and
 * HyperFrames engines' builder, with pictures from the render's asset origin.
 * A video pane is an <img> with `data-rf-video` that LayoutScene.tsx points at
 * picture k on frame k (`firstFrame` is a frame-range chunk's first frame).
 */
export function remotionLayoutInput(
  scene: RenderScene,
  output: OutputSettings,
  theme: ThemeTokens | undefined,
  platform: string | undefined,
  media: Record<string, SceneMedia>,
  firstFrame = 0
): { html: string; css: string; rootCss: string } {
  const props = layoutSceneProps.parse(scene.props);
  const seconds = scene.durationFrames / output.fps;
  const dom = layoutSceneDom({
    props,
    width: output.width,
    height: output.height,
    ...(platform ? { platform } : {}),
    durationSeconds: seconds,
    picture: ({ media: m, className, style }) => {
      const key = mediaKey(m.asset, m.startSeconds || undefined);
      const staged = media[key];
      if (!staged) throw new Error(`asset "${m.asset}" is not available to the renderer`);
      const video = staged.frames ? ` data-rf-video="${attr(key)}"` : '';
      return `<img class="${className}" style="${style}" alt=""${video} src="${attr(mediaUrlAt(staged, firstFrame))}">`;
    },
  });
  return { html: dom.html, css: dom.css, rootCss: domThemeCss(theme ?? BUILTIN_THEMES[0]!.tokens, output, seconds, platform) };
}

/** Render one Remotion scene to an MP4 clip. */
export async function renderRemotionScene(opts: RemotionRenderOptions): Promise<RemotionRenderResult> {
  const started = Date.now();
  const { scene, output } = opts;
  const stage = `render:${scene.id}`;
  const browserExecutable = opts.browserExecutable ?? process.env.REELFORGE_CHROMIUM_PATH ?? null;
  mkdirSync(dirname(opts.out), { recursive: true });
  const range = opts.frameRange;
  if (range && (range[0] < 0 || range[1] < range[0] || range[1] >= scene.durationFrames)) {
    throw new PipelineError(stage, `frame range ${range[0]}-${range[1]} is not inside the scene's ${scene.durationFrames} frames`);
  }
  const frames = range ? range[1] - range[0] + 1 : scene.durationFrames;

  if (!scene.template) throw new PipelineError(stage, 'Remotion scenes need a template');
  // Assets (#299): the scene's files staged (video as one picture per frame of this range) and served on a
  // loopback origin under a random token for the length of this render.
  const uses = sceneAssetUses(scene, TEMPLATES[scene.template as keyof typeof TEMPLATES]);
  let assetServer: AssetServer | undefined;
  let media: Record<string, unknown> | undefined;
  if (uses.length) {
    const staged = await stageSceneAssets({
      uses,
      assets: opts.assets ?? new Map(),
      dir: join(opts.workDir ?? `${opts.out}.work`, 'assets'),
      tools: opts.tools ?? { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      output,
      frames: { first: range ? range[0] : 0, count: frames },
      video: 'frames',
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
    assetServer = await startAssetServer(staged);
    media = staged.media(assetServer.base);
  }
  // remotion-layout (#287): the html and HyperFrames layout markup, built here from the same geometry.
  let layout: Record<string, unknown> | undefined;
  if (scene.template === 'remotion-layout') {
    try {
      layout = { __layout: remotionLayoutInput(scene, output, opts.theme, opts.platform, (media ?? {}) as Record<string, SceneMedia>, range ? range[0] : 0) };
    } catch (e) {
      await assetServer?.close();
      throw new PipelineError(stage, (e as Error).message);
    }
  }
  const inputProps = {
    ...(layout ?? (scene.props as Record<string, unknown>)),
    ...(opts.theme ? { __theme: opts.theme } : {}),
    ...(opts.platform ? { __platform: opts.platform } : {}),
    ...(media ? { __assets: media } : {}),
    __output: {
      width: output.width,
      height: output.height,
      fps: output.fps,
      durationInFrames: scene.durationFrames,
    },
  };

  const { cancelSignal, cancel } = makeCancelSignal();
  const onAbort = () => cancel();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const serveUrl = await bundleCompositions(opts.cacheDir, opts.rebuild);
    const composition = await selectComposition({
      serveUrl,
      id: scene.template!,
      inputProps,
      browserExecutable,
      logLevel: 'error',
    });
    if (
      composition.width !== output.width ||
      composition.height !== output.height ||
      composition.fps !== output.fps ||
      composition.durationInFrames !== scene.durationFrames
    ) {
      throw new PipelineError(stage, 'composition metadata does not match the manifest');
    }

    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      crf: 18,
      muted: true,
      outputLocation: opts.out,
      overwrite: true,
      browserExecutable,
      concurrency: opts.concurrency ?? null,
      chromiumOptions: { gl: 'swangle' },
      cancelSignal,
      logLevel: 'error',
      ...(range ? { frameRange: [range[0], range[1]] as [number, number] } : {}),
      onProgress: ({ renderedFrames }) => opts.onProgress?.(renderedFrames, frames),
    });

    return {
      out: opts.out,
      frames,
      engine: 'remotion',
      engineVersion: remotionVersion(),
      millis: Date.now() - started,
    };
  } catch (e) {
    if (e instanceof PipelineError) throw e;
    const err = e as Error;
    throw new PipelineError(
      stage,
      opts.signal?.aborted ? 'cancelled' : `Remotion render failed: ${err.message}`,
      err.stack ?? ''
    );
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    if (assetServer?.refused.length) opts.log?.(`remotion: the asset origin refused ${assetServer.refused.length} request(s): ${assetServer.refused.slice(0, 5).join(', ')}`);
    await assetServer?.close();
  }
}
