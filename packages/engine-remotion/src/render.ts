import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineError } from '@renderweld/media-pipeline';
import { publishDirAtomically, sceneAssetUses, stageSceneAssets, stampMatches, startAssetServer, type AssetServer, type ResolvedAsset } from '@renderweld/core';
import type { Tools } from '@renderweld/media-pipeline';
import { findRemotion, loadBundler, loadRenderer, type RemotionInstall } from './load';
import { BUILTIN_THEMES, TEMPLATES, domThemeCss, fpsRational, fpsValue, framesToSeconds, layoutSceneDom, layoutSceneProps, mediaKey, mediaUrlAt, type OutputSettings, type RenderScene, type SceneMedia, type ThemeTokens } from '@renderweld/project-schema';

const here = dirname(fileURLToPath(import.meta.url));
const compositionsDir = resolve(here, '../compositions');
const entryPoint = join(compositionsDir, 'Root.tsx');
/**
 * Bundle built by `apps/server/src/prebuild.ts remotion`: in the customer's Remotion add-on image
 * (deployment/remotion/Dockerfile), or locally. Used when its source hash matches, so a production
 * container never runs Webpack and needs no writable bundle directory. The official image has none (#783).
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
   * RENDERWELD_CHROMIUM_PATH, then lets Remotion download its pinned browser.
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
  /** Where Remotion is installed (load.ts); default: the development checkout. */
  install?: RemotionInstall;
  /** The customer's Remotion licence key (engines.remotion.licenseKey), passed to renderMedia. */
  licenseKey?: string;
}

export interface RemotionRenderResult {
  out: string;
  frames: number;
  engine: 'remotion';
  engineVersion: string;
  millis: number;
}

/** The installed Remotion version: the customer's install at RENDERWELD_REMOTION_HOME, else the development checkout. */
export function remotionVersion(install: RemotionInstall | null = findRemotion(process.env.RENDERWELD_REMOTION_HOME, true)): string {
  return install?.version ?? 'not installed';
}

function requireInstall(install: RemotionInstall | undefined): RemotionInstall {
  const found = install ?? findRemotion(process.env.RENDERWELD_REMOTION_HOME, true);
  if (!found) throw new Error('Remotion is not installed (see docs/public/install/remotion.md)');
  return found;
}

function sourceHash(install: RemotionInstall): string {
  const h = createHash('sha256');
  h.update(install.version);
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
  h.update(readFileSync(createRequire(import.meta.url).resolve('@renderweld/project-schema/layout')));
  h.update(readFileSync(createRequire(import.meta.url).resolve('@renderweld/project-schema/media')));
  return h.digest('hex');
}


/**
 * The compositions bundled with Remotion's Webpack setup: the pre-built bundle
 * when it matches the sources, otherwise one built into cacheDir (cached by
 * source hash). `@remotion/bundler` (Webpack) is loaded from the same Remotion
 * install, and only to build; it resolves `react` and `remotion` from there too.
 */
export async function bundleCompositions(cacheDir: string, install: RemotionInstall = requireInstall(undefined), force = false): Promise<string> {
  const hash = sourceHash(install);
  if (!force && stampMatches(PREBUILT_REMOTION_DIR, hash)) return PREBUILT_REMOTION_DIR;
  const outDir = join(resolve(cacheDir), 'remotion');
  if (!force && stampMatches(outDir, hash)) return outDir;
  // Built next to outDir and renamed into place: another server process may be rendering from outDir right now.
  return publishDirAtomically(outDir, hash, async (dir) => void (await buildCompositions(install, dir, hash)), { force });
}

/** Pre-build the bundle next to the package (the Remotion add-on image, or locally). Returns its directory. */
export async function prebuildCompositions(install: RemotionInstall = requireInstall(undefined)): Promise<string> {
  return buildCompositions(install, PREBUILT_REMOTION_DIR, sourceHash(install), { sourceMaps: false });
}

async function buildCompositions(install: RemotionInstall, outDir: string, hash: string, opts: { sourceMaps?: boolean } = {}): Promise<string> {
  const { bundle } = await loadBundler(install);
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
): { html: string; css: string; rootCss: string; rate: { num: number; den: number } } {
  const props = layoutSceneProps.parse(scene.props);
  const seconds = framesToSeconds(scene.durationFrames, output.fps);
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
  // The exact rate (D-119), so frame k's animation time is k * den / num seconds, not k / a rounded decimal.
  return { html: dom.html, css: dom.css, rootCss: domThemeCss(theme ?? BUILTIN_THEMES[0]!.tokens, output, seconds, platform), rate: fpsRational(output.fps) };
}

/** Render one Remotion scene to an MP4 clip. */
export async function renderRemotionScene(opts: RemotionRenderOptions): Promise<RemotionRenderResult> {
  const started = Date.now();
  const { scene, output } = opts;
  const stage = `render:${scene.id}`;
  const browserExecutable = opts.browserExecutable ?? process.env.RENDERWELD_CHROMIUM_PATH ?? null;
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
  let fonts: unknown[] | undefined;
  {
    const staged = await stageSceneAssets({
      uses,
      assets: opts.assets ?? new Map(),
      dir: join(opts.workDir ?? `${opts.out}.work`, 'assets'),
      tools: opts.tools ?? { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      output,
      frames: { first: range ? range[0] : 0, count: frames },
      video: 'frames',
      // Fonts (#303): the theme's families that are project font assets or bundled fonts, loaded before any frame.
      ...(opts.theme ? { fonts: { family: opts.theme.fontFamily } } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
    if (staged.items.size || staged.fonts.length) {
      assetServer = await startAssetServer(staged);
      media = staged.media(assetServer.base);
      if (staged.fonts.length) fonts = staged.fontFaces(assetServer.base);
    }
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
    ...(fonts ? { __fonts: fonts } : {}),
    __output: {
      width: output.width,
      height: output.height,
      // Remotion takes a number; 29.97002997 for 30000/1001 (the final file is normalised to the exact rate, #302).
      fps: fpsValue(output.fps),
      durationInFrames: scene.durationFrames,
    },
  };

  let install: RemotionInstall;
  let remotion: Awaited<ReturnType<typeof loadRenderer>>;
  try {
    install = requireInstall(opts.install);
    remotion = await loadRenderer(install);
  } catch (e) {
    throw new PipelineError(stage, (e as Error).message);
  }
  const { cancelSignal, cancel } = remotion.makeCancelSignal();
  const onAbort = () => cancel();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const serveUrl = await bundleCompositions(opts.cacheDir, install, opts.rebuild);
    const composition = await remotion.selectComposition({
      serveUrl,
      id: scene.template!,
      inputProps,
      browserExecutable,
      logLevel: 'error',
    });
    if (
      composition.width !== output.width ||
      composition.height !== output.height ||
      Math.abs(composition.fps - fpsValue(output.fps)) > 1e-9 ||
      composition.durationInFrames !== scene.durationFrames
    ) {
      throw new PipelineError(stage, 'composition metadata does not match the manifest');
    }

    await remotion.renderMedia({
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
      ...(opts.licenseKey ? { licenseKey: opts.licenseKey } : {}),
      ...(range ? { frameRange: [range[0], range[1]] as [number, number] } : {}),
      onProgress: ({ renderedFrames }) => opts.onProgress?.(renderedFrames, frames),
    });

    return {
      out: opts.out,
      frames,
      engine: 'remotion',
      engineVersion: install.version,
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
