import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import motionCanvasModule from '@motion-canvas/vite-plugin';
import { PipelineError, startPngEncoder } from '@reelforge/media-pipeline';
import type { OutputSettings, Scene } from '@reelforge/project-schema';
import { chromium, type Browser } from 'playwright-core';
import { build, type Plugin } from 'vite';
import type {} from './protocol';

// The plugin ships as CommonJS; depending on the loader the factory is the
// default export or sits on `.default`.
const motionCanvas = ((motionCanvasModule as unknown as { default?: typeof motionCanvasModule })
  .default ?? motionCanvasModule) as typeof motionCanvasModule;

const here = dirname(fileURLToPath(import.meta.url));
const scenesDir = resolve(here, '../scenes');

export interface MotionCanvasRenderOptions {
  scene: Scene;
  output: OutputSettings;
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

/** Build scenes/runtime.ts with the Motion Canvas Vite plugin into cacheDir. */
export async function buildBundle(cacheDir: string, force = false): Promise<string> {
  cacheDir = resolve(cacheDir);
  const outDir = join(cacheDir, 'motion-canvas');
  const hash = sourceHash();
  const stamp = join(outDir, '.source-hash');
  if (!force && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash) return outDir;
  await build({
    root: scenesDir,
    configFile: false,
    logLevel: 'warn',
    // Keep Vite and Motion Canvas caches out of the source tree.
    cacheDir: join(cacheDir, 'vite'),
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
  writeFileSync(stamp, hash);
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
  const encoder = startPngEncoder(opts.ffmpeg, opts.out, output.fps, `render:${scene.id}`);
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
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio'],
    });
    const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
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
        template: scene.template,
        variables: { ...props, durationSeconds: scene.durationFrames / output.fps },
        width: output.width,
        height: output.height,
        fps: output.fps,
        frames: scene.durationFrames,
        background: (props.background as string | undefined) ?? null,
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

function motionCanvasVersion(): string {
  try {
    const pkg = resolve(here, '../node_modules/@motion-canvas/core/package.json');
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
