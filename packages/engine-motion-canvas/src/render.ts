import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineError, startPngEncoder } from '@reelforge/media-pipeline';
import { chromiumSandbox, packageVersion, publishDirAtomically, renderChildEnv, stampMatches } from '@reelforge/core';
import {
  fpsArg,
  fpsValue,
  framesToSeconds,
  type OutputSettings,
  type RenderScene,
  type ThemeTokens,
} from '@reelforge/project-schema';
import { chromium, type Browser } from 'playwright-core';
import type { Plugin } from 'vite';
import type {} from './protocol';

const here = dirname(fileURLToPath(import.meta.url));
const scenesDir = resolve(here, '../scenes');
/**
 * Bundle built at image build time (`apps/server/src/prebuild.ts`). Used when its
 * source hash matches, so a production container never runs Vite and needs no
 * writable bundle directory.
 */
export const PREBUILT_MOTION_CANVAS_DIR = resolve(here, '../.prebuilt/motion-canvas');

export interface MotionCanvasRenderOptions {
  scene: RenderScene;
  output: OutputSettings;
  /** Theme tokens; templates read colours and fonts from them (props override). */
  theme?: ThemeTokens;
  /** brief.platform (ui safe zone on tall frames, #287). */
  platform?: string;
  /** Where to write the clip (H.264 MP4, no audio). */
  out: string;
  /** Directory for the built browser bundle. Reused between renders. */
  cacheDir: string;
  ffmpeg: string;
  /** Chromium/Chrome binary. Falls back to REELFORGE_CHROMIUM_PATH, then Playwright's default. */
  browserExecutable?: string;
  signal?: AbortSignal;
  onProgress?: (framesDone: number, framesTotal: number) => void;
  /** Rebuild the browser bundle even if one exists. */
  rebuild?: boolean;
}

export interface MotionCanvasRenderResult {
  out: string;
  frames: number;
  engine: 'motion-canvas';
  engineVersion: string;
  browser: string;
  millis: number;
}

export function resolveBrowser(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  fallback: () => string | undefined = safeDefaultPath
): string {
  const candidates = [explicit, env.REELFORGE_CHROMIUM_PATH, fallback()].filter(
    (p): p is string => Boolean(p)
  );
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new PipelineError(
      'setup',
      'No Chromium found for Motion Canvas rendering. Set REELFORGE_CHROMIUM_PATH to a Chrome or ' +
        `Chromium binary. Tried: ${candidates.join(', ') || '(nothing)'}`
    );
  }
  return found;
}

function safeDefaultPath(): string | undefined {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}


/**
 * The browser bundle of scenes/runtime.ts: the pre-built one when it matches
 * the sources, otherwise one built with the Motion Canvas Vite plugin into
 * cacheDir. Vite is loaded only to build.
 */
export async function buildBundle(cacheDir: string, force = false): Promise<string> {
  cacheDir = resolve(cacheDir);
  const hash = sourceHash();
  if (!force && stampMatches(PREBUILT_MOTION_CANVAS_DIR, hash)) return PREBUILT_MOTION_CANVAS_DIR;
  const outDir = join(cacheDir, 'motion-canvas');
  if (!force && stampMatches(outDir, hash)) return outDir;
  // Built next to outDir and renamed into place: another server process may be rendering from outDir right now.
  return publishDirAtomically(
    outDir,
    hash,
    async (dir) => {
      try {
        await viteBuild(dir, `${dir}-vite`, hash);
      } finally {
        rmSync(`${dir}-vite`, { recursive: true, force: true });
      }
    },
    { force }
  );
}

/** Pre-build the bundle next to the package (image build time). `viteCacheDir` is a scratch directory. */
export async function prebuildMotionCanvas(viteCacheDir: string): Promise<string> {
  return viteBuild(PREBUILT_MOTION_CANVAS_DIR, resolve(viteCacheDir), sourceHash());
}

async function viteBuild(outDir: string, viteCacheDir: string, hash: string): Promise<string> {
  const { build } = await import('vite');
  const motionCanvasModule = (await import('@motion-canvas/vite-plugin')).default;
  // The plugin ships as CommonJS; depending on the loader the factory is the
  // default export or sits on `.default`.
  const motionCanvas = ((motionCanvasModule as unknown as { default?: typeof motionCanvasModule }).default ??
    motionCanvasModule) as typeof motionCanvasModule;
  await build({
    root: scenesDir,
    configFile: false,
    logLevel: 'warn',
    // Keep Vite and Motion Canvas caches out of the source tree.
    cacheDir: viteCacheDir,
    plugins: [
      motionCanvas({ project: join(scenesDir, 'animated-explainer/project.ts'), buildForEditor: false }),
      {
        // Runtime plugin that provides the "reelforge-capture" exporter.
        name: 'reelforge:capture',
        [Symbol.for('@motion-canvas/vite-plugin/PLUGIN_OPTIONS')]: {
          entryPoint: join(scenesDir, 'capture-plugin.ts'),
        },
      } as Plugin,
      {
        // The Motion Canvas plugin adds every project as a build entry. We only
        // want our runtime entry, which imports the projects itself.
        name: 'reelforge:single-entry',
        enforce: 'post',
        config(config) {
          config.build ??= {};
          config.build.rollupOptions ??= {};
          config.build.rollupOptions.input = { runtime: join(scenesDir, 'runtime.ts') };
        },
      },
    ],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      target: 'es2022',
      rollupOptions: {
        output: { entryFileNames: '[name].js', chunkFileNames: 'chunk-[hash].js' },
      },
    },
  });
  writeFileSync(
    join(outDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head>' +
      '<body style="margin:0;background:#000"><script type="module" src="./runtime.js"></script></body></html>'
  );
  writeFileSync(join(outDir, '.source-hash'), hash);
  return outDir;
}

/** Hash of the scene sources and engine version, so edits invalidate the bundle. */
function sourceHash(): string {
  const h = createHash('sha256');
  h.update(motionCanvasVersion());
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|json|glsl)$/.test(entry.name)) {
        h.update(full.slice(scenesDir.length));
        h.update(readFileSync(full));
      }
    }
  };
  walk(scenesDir);
  // The scenes import the shared layout module (#287); a change to it must rebuild the bundle.
  h.update(readFileSync(createRequire(import.meta.url).resolve('@reelforge/project-schema/layout')));
  return h.digest('hex');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

/** Serve the bundle on 127.0.0.1 only; module scripts cannot load from file://. */
function serve(root: string): Promise<Server> {
  const base = resolve(root) + sep;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const target = normalize(join(base, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!target.startsWith(base) || !existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
    createReadStream(target).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/**
 * Render one Motion Canvas scene to an MP4 clip, headless:
 * build bundle → local server → headless Chromium → Renderer + capture
 * exporter → PNG frames over a Playwright binding → FFmpeg.
 */
export async function renderMotionCanvasScene(
  opts: MotionCanvasRenderOptions
): Promise<MotionCanvasRenderResult> {
  const started = Date.now();
  const { scene, output } = opts;
  const executable = resolveBrowser(opts.browserExecutable);
  const bundle = await buildBundle(opts.cacheDir, opts.rebuild);
  mkdirSync(dirname(opts.out), { recursive: true });

  const server = await serve(bundle);
  const port = (server.address() as AddressInfo).port;
  let browser: Browser | undefined;
  const encoder = startPngEncoder(opts.ffmpeg, opts.out, fpsArg(output.fps), `render:${scene.id}`);
  const consoleErrors: string[] = [];
  let nextFrame = 0;

  const abort = () => {
    encoder.kill();
    void browser?.close();
  };
  opts.signal?.addEventListener('abort', abort, { once: true });

  try {
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
      // Chromium's own sandbox unless REELFORGE_CHROMIUM_NO_SANDBOX=1 or root (same rule as every engine).
      chromiumSandbox: chromiumSandbox(),
      env: renderChildEnv(), // no server secrets in the browser's environment (D-086)
      args: ['--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      // The server owns shutdown (a worker hands running jobs back on SIGTERM); the job's abort signal closes the browser.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
    // Only the local bundle server (and data:/blob: URLs) is reachable (D-085).
    const origin = `http://127.0.0.1:${port}/`;
    await page.route('**/*', (route) => {
      const url = route.request().url();
      return url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:') ? route.continue() : route.abort('blockedbyclient');
    });
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    await page.exposeBinding('__reelforgeFrame', async (_src, frame: number, png: string) => {
      if (frame !== nextFrame) {
        throw new Error(`frame ${frame} arrived out of order (expected ${nextFrame})`);
      }
      nextFrame++;
      await encoder.write(Buffer.from(png, 'base64'));
      opts.onProgress?.(nextFrame, scene.durationFrames);
    });

    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => window.__reelforgeReady === true, null, { timeout: 30_000 });

    const props = scene.props as Record<string, unknown>;
    const response = await page.evaluate(
      (req) => window.__reelforgeRender!(req),
      {
        template: scene.template ?? '',
        variables: {
          ...props,
          durationSeconds: framesToSeconds(scene.durationFrames, output.fps),
          ...(opts.theme ? { theme: opts.theme } : {}),
          ...(opts.platform ? { platform: opts.platform } : {}),
        },
        width: output.width,
        height: output.height,
        fps: fpsValue(output.fps),
        frames: scene.durationFrames,
        background: (props.background as string | undefined) ?? opts.theme?.colors.background ?? null,
      }
    );

    if (opts.signal?.aborted) throw new PipelineError(`render:${scene.id}`, 'cancelled');
    if (!response.ok) {
      throw new PipelineError(
        `render:${scene.id}`,
        `Motion Canvas render ${response.result}`,
        [...response.errors, ...consoleErrors].join('\n')
      );
    }
    if (nextFrame !== scene.durationFrames) {
      throw new PipelineError(
        `render:${scene.id}`,
        `Motion Canvas produced ${nextFrame} frames, expected ${scene.durationFrames}. ` +
          'The scene code is probably shorter than the duration in the manifest.',
        consoleErrors.join('\n')
      );
    }
    await encoder.finish();
    const browserVersion = browser.version();
    return {
      out: opts.out,
      frames: nextFrame,
      engine: 'motion-canvas',
      engineVersion: motionCanvasVersion(),
      browser: browserVersion,
      millis: Date.now() - started,
    };
  } catch (e) {
    encoder.kill();
    if (e instanceof PipelineError) throw e;
    throw new PipelineError(`render:${scene.id}`, (e as Error).message, consoleErrors.join('\n'));
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    await browser?.close().catch(() => undefined);
    server.close();
  }
}

export function motionCanvasVersion(): string {
  return packageVersion('@motion-canvas/core', import.meta.url);
}
