import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { browserVersion, chromiumSandbox as coreChromiumSandbox, packageVersion, type EnginePlugin } from '@reelforge/core';
import { PipelineError, startPngEncoder } from '@reelforge/media-pipeline';
import {
  BUILTIN_THEMES,
  MAX_SOURCE_BYTES,
  TEMPLATES,
  htmlTitleProps,
  type OutputSettings,
  type RenderScene,
  type ThemeTokens,
} from '@reelforge/project-schema';
import { chromium, type Browser } from 'playwright-core';
import { buildDocument, htmlTitle } from './page';

export interface HtmlRenderOptions {
  scene: RenderScene;
  output: OutputSettings;
  theme?: ThemeTokens;
  out: string;
  ffmpeg: string;
  browserExecutable?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Whole-render timeout. Default: 30 s + 1 s per frame. */
  timeoutMs?: number;
}

export interface HtmlRenderResult {
  out: string;
  frames: number;
  millis: number;
  browser: string;
  /** Requests the sandbox blocked (for logs). */
  blockedRequests: string[];
}

export function htmlEngineVersion(): string {
  return `reelforge-html/0.1.0 (playwright-core ${packageVersion('playwright-core', import.meta.url)})`;
}

/** Chromium's own sandbox (shared rule, @reelforge/core). Re-exported for compatibility. */
export const chromiumSandbox = coreChromiumSandbox;

export function resolveHtmlBrowser(explicit?: string): string {
  const p = explicit ?? process.env.REELFORGE_CHROMIUM_PATH;
  if (p && existsSync(p)) return p;
  throw new PipelineError('setup', `No Chromium for the html engine: set REELFORGE_CHROMIUM_PATH (tried ${p ?? '(unset)'})`);
}

/** The html + css to render for a scene: agent source, or a built-in template. */
export function sceneSource(scene: RenderScene, durationSeconds: number): { html: string; css: string } {
  if (scene.html !== undefined) return { html: scene.html, css: scene.css ?? '' };
  if (scene.template === 'html-title') return htmlTitle(htmlTitleProps.parse(scene.props), durationSeconds);
  throw new PipelineError(`render:${scene.id}`, `unknown html template "${scene.template}"`);
}

/**
 * Render an html scene: load it in headless Chromium with every network
 * request blocked, then for each frame pause every Web Animation
 * (document.getAnimations(): CSS animations, transitions and WAAPI) at
 * currentTime = frame / fps, take a PNG screenshot and pipe it to FFmpeg.
 * Deterministic: time never advances on its own.
 */
export async function renderHtmlScene(opts: HtmlRenderOptions): Promise<HtmlRenderResult> {
  const started = Date.now();
  const { scene, output } = opts;
  const stage = `render:${scene.id}`;
  const frames = scene.durationFrames;
  const durationSeconds = frames / output.fps;
  const theme = opts.theme ?? BUILTIN_THEMES[0]!.tokens;
  const executable = resolveHtmlBrowser(opts.browserExecutable);

  const source = sceneSource(scene, durationSeconds);
  if (Buffer.byteLength(source.html) + Buffer.byteLength(source.css) > MAX_SOURCE_BYTES * 2) {
    throw new PipelineError(stage, `html scene is larger than ${MAX_SOURCE_BYTES * 2} bytes`);
  }
  let doc: string;
  try {
    doc = buildDocument({ html: source.html, css: source.css, theme, output, durationSeconds });
  } catch (e) {
    throw new PipelineError(stage, (e as Error).message);
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  const timeoutMs = opts.timeoutMs ?? 30_000 + frames * 1000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const encoder = startPngEncoder(opts.ffmpeg, opts.out, output.fps, stage);
  const blocked: string[] = [];
  let browser: Browser | undefined;
  const onAbort = () => {
    encoder.kill();
    void browser?.close();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
      chromiumSandbox: chromiumSandbox(),
      args: ['--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio', '--disable-gpu', '--font-render-hinting=none'],
      // The server owns shutdown (a worker hands running jobs back on SIGTERM); the job's abort signal closes the browser.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    const context = await browser.newContext({
      viewport: { width: output.width, height: output.height },
      deviceScaleFactor: 1,
      offline: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
      javaScriptEnabled: true, // needed for our frame control; page scripts are blocked by CSP
    });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url === 'about:blank') return route.continue();
      if (blocked.length < 50) blocked.push(url.slice(0, 200));
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('popup', (p) => void p.close());
    await page.setContent(doc, { waitUntil: 'load', timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    for (let f = 0; f < frames; f++) {
      if (signal.aborted) break;
      const t = (f * 1000) / output.fps;
      await page.evaluate((ms) => {
        for (const a of document.getAnimations()) {
          a.pause();
          a.currentTime = ms;
        }
      }, t);
      const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: output.width, height: output.height }, caret: 'hide', animations: 'allow' });
      await encoder.write(png);
      opts.onProgress?.(f + 1, frames);
    }
    if (timeout.aborted) throw new PipelineError(stage, `html render timed out after ${timeoutMs} ms`);
    if (signal.aborted) throw new PipelineError(stage, 'cancelled');
    await encoder.finish();
    const version = browser.version();
    return { out: opts.out, frames, millis: Date.now() - started, browser: version, blockedRequests: blocked };
  } catch (e) {
    encoder.kill();
    if (timeout.aborted) throw new PipelineError(stage, `html render timed out after ${timeoutMs} ms`);
    if (signal.aborted) throw new PipelineError(stage, 'cancelled');
    if (e instanceof PipelineError) throw e;
    const msg = (e as Error).message;
    if (/No usable sandbox|sandboxing failed/i.test(msg)) {
      throw new PipelineError(
        stage,
        'Chromium could not start its sandbox on this machine (e.g. Ubuntu 23.10+ restricts unprivileged user namespaces). ' +
          'Enable user namespaces for Chrome (see Chromium docs/security/apparmor-userns-restrictions.md), or run ReelForge in a container ' +
          'and set REELFORGE_CHROMIUM_NO_SANDBOX=1.',
        msg.slice(0, 2000)
      );
    }
    throw new PipelineError(stage, `html render failed: ${msg}`);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => undefined);
  }
}

/** The html engine as a plugin: template html-title, or agent-supplied { html, css }. */
export function htmlEngine(opts: { browserExecutable?: string; timeoutMs?: number } = {}): EnginePlugin {
  return {
    id: 'html',
    displayName: 'HTML/CSS (headless Chromium, Web Animations)',
    acceptsSource: true,
    version: htmlEngineVersion,
    templates: () =>
      Object.entries(TEMPLATES)
        .filter(([, t]) => t.engine === 'html')
        .map(([id, t]) => ({ ...t, id })),
    browserSandbox: () => chromiumSandbox(),
    availability() {
      try {
        resolveHtmlBrowser(opts.browserExecutable);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
    async render(scene, ctx) {
      const res = await renderHtmlScene({
        scene,
        output: ctx.output,
        theme: ctx.theme,
        out: ctx.out,
        ffmpeg: ctx.tools.ffmpeg,
        browserExecutable: opts.browserExecutable,
        signal: ctx.signal,
        onProgress: ctx.progress,
        timeoutMs: opts.timeoutMs,
      });
      if (res.blockedRequests.length) ctx.log(`html sandbox blocked ${res.blockedRequests.length} request(s): ${res.blockedRequests.slice(0, 5).join(', ')}`);
      return {
        file: res.out,
        frames: res.frames,
        engineVersion: htmlEngineVersion(),
        browserVersion: browserVersion(opts.browserExecutable ?? process.env.REELFORGE_CHROMIUM_PATH) ?? res.browser,
        millis: res.millis,
      };
    },
  };
}
