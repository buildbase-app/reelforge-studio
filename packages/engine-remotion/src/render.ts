import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, renderMedia, selectComposition } from '@remotion/renderer';
import { PipelineError } from '@reelforge/media-pipeline';
import type { OutputSettings, Scene } from '@reelforge/project-schema';

const here = dirname(fileURLToPath(import.meta.url));
const compositionsDir = resolve(here, '../compositions');
const entryPoint = join(compositionsDir, 'Root.tsx');

export interface RemotionRenderOptions {
  scene: Scene;
  output: OutputSettings;
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
}

export interface RemotionRenderResult {
  out: string;
  frames: number;
  engine: 'remotion';
  engineVersion: string;
  millis: number;
}

export function remotionVersion(): string {
  try {
    const pkg = resolve(here, '../node_modules/remotion/package.json');
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
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
  return h.digest('hex');
}

/** Bundle the compositions with Remotion's Webpack setup, cached by source hash. */
export async function bundleCompositions(cacheDir: string, force = false): Promise<string> {
  const outDir = join(resolve(cacheDir), 'remotion');
  const stamp = join(outDir, '.source-hash');
  const hash = sourceHash();
  if (!force && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash) return outDir;
  await bundle({ entryPoint, outDir, enableCaching: true });
  writeFileSync(stamp, hash);
  return outDir;
}

/** Render one Remotion scene to an MP4 clip. */
export async function renderRemotionScene(opts: RemotionRenderOptions): Promise<RemotionRenderResult> {
  const started = Date.now();
  const { scene, output } = opts;
  const stage = `render:${scene.id}`;
  const browserExecutable = opts.browserExecutable ?? process.env.REELFORGE_CHROMIUM_PATH ?? null;
  mkdirSync(dirname(opts.out), { recursive: true });

  const inputProps = {
    ...(scene.props as Record<string, unknown>),
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
      id: scene.template,
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
      onProgress: ({ renderedFrames }) => opts.onProgress?.(renderedFrames, scene.durationFrames),
    });

    return {
      out: opts.out,
      frames: scene.durationFrames,
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
  }
}
