import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  assetHeaders,
  assetToken,
  browserVersion,
  chromiumSandbox as coreChromiumSandbox,
  lookupAsset,
  packageVersion,
  renderChildEnv,
  rewriteSceneHtml,
  sceneAssetUses,
  sceneTimeoutCapMs,
  stageSceneAssets,
  type EnginePlugin,
  type ResolvedAsset,
  type StagedSceneAssets,
} from '@reelforge/core';
import { PipelineError, startPngEncoder, type Tools } from '@reelforge/media-pipeline';
import {
  BUILTIN_THEMES,
  FIT_TEXT_SCRIPT,
  MAX_SOURCE_BYTES,
  TEMPLATES,
  htmlTitleProps,
  mediaKey,
  rewriteAssetRefs,
  type DomLogo,
  type DomMediaLayer,
  type OutputSettings,
  type RenderScene,
  type ThemeTokens,
} from '@reelforge/project-schema';
import { chromium, type Browser } from 'playwright-core';
import { frameDataUrl, layoutSource } from './media';
import { buildDocument, htmlTitle } from './page';

export interface HtmlRenderOptions {
  scene: RenderScene;
  output: OutputSettings;
  theme?: ThemeTokens;
  /** brief.platform (ui safe zone on tall frames). */
  platform?: string;
  out: string;
  ffmpeg: string;
  browserExecutable?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Whole-render timeout. Default: 30 s + 1 s per frame (per 1920x1080 worth of pixels), at most render.sceneTimeoutSeconds. */
  timeoutMs?: number;
  /** The project's assets (EngineRenderContext.assets); the scene may use only these (#299). html-layout panes read them directly. */
  assets?: ReadonlyMap<string, ResolvedAsset>;
  /** FFmpeg/ffprobe for staging assets (default: `ffmpeg` and `ffprobe` next to opts.ffmpeg). */
  tools?: Tools;
  /** Scratch directory (staged assets, video frames of html-layout panes). Default: next to `out`. */
  workDir?: string;
  log?: (line: string) => void;
}

/** The origin html scenes load assets from: answered by request interception only (`.invalid` never resolves). */
export const ASSET_ORIGIN = 'http://rf-assets.invalid';

export interface HtmlRenderResult {
  out: string;
  frames: number;
  millis: number;
  browser: string;
  /** Requests the sandbox blocked (for logs). */
  blockedRequests: string[];
  /** Asset files the page loaded (names under the asset base). */
  assetRequests: string[];
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

/** The html + css to render for a scene: agent source, or a built-in template; `asset:` references point at `assetBase`. */
export function sceneSource(scene: RenderScene, durationSeconds: number, staged?: StagedSceneAssets, assetBase = ''): { html: string; css: string } {
  const url = (key: string) => {
    const it = staged?.items.get(key);
    return it ? assetBase + it.name : undefined;
  };
  if (scene.html !== undefined) {
    if (!staged) return { html: scene.html, css: scene.css ?? '' };
    const isVideo = (key: string) => staged.items.get(key)?.frames !== undefined;
    return { html: rewriteSceneHtml(scene.html, url, { videoAsImage: true, isVideo }), css: rewriteAssetRefs(scene.css ?? '', url) };
  }
  if (scene.template === 'html-title') {
    const props = htmlTitleProps.parse(scene.props);
    const bgKey = props.media ? mediaKey(props.media.asset, props.media.start) : undefined;
    const bgItem = bgKey ? staged?.items.get(bgKey) : undefined;
    const bg: DomMediaLayer | undefined =
      props.media && bgItem
        ? { url: assetBase + bgItem.name, fit: props.media.fit, ...(props.media.focus ? { focus: props.media.focus } : {}), dim: props.media.dim, tag: 'img', ...(bgItem.frames ? { videoKey: bgItem.key } : {}) }
        : undefined;
    const logoItem = props.logo ? staged?.items.get(props.logo.asset) : undefined;
    const logo: DomLogo | undefined = props.logo && logoItem ? { url: assetBase + logoItem.name, corner: props.logo.corner, size: props.logo.size } : undefined;
    return htmlTitle(props, durationSeconds, { ...(bg ? { bg } : {}), ...(logo ? { logo } : {}) });
  }
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

  let source: { html: string; css: string };
  // html-layout panes (#287): pictures inlined as data: URLs, video as one JPEG per frame swapped in per screenshot.
  let layoutVideos = new Map<string, string[]>();
  const framesDir = join(opts.workDir ?? join(dirname(opts.out), `.work-${scene.id}`), 'frames');
  // Other scenes (#299): stage the files this scene uses (only the project's own), served under a per-render base.
  let staged: StagedSceneAssets | undefined;
  const token = assetToken();
  const assetBase = `${ASSET_ORIGIN}/${token}/`;
  const videos: Record<string, string[]> = {};
  if (scene.html === undefined && scene.template === 'html-layout') {
    try {
      const l = await layoutSource({
        props: scene.props,
        output,
        ...(opts.platform ? { platform: opts.platform } : {}),
        durationSeconds,
        frames,
        assets: opts.assets ?? new Map(),
        ffmpeg: opts.ffmpeg,
        framesDir,
        stage,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      source = { html: l.dom.html, css: l.dom.css };
      layoutVideos = l.videos;
    } catch (e) {
      if (e instanceof PipelineError) throw e;
      throw new PipelineError(stage, (e as Error).message);
    }
  } else {
    let uses;
    try {
      uses = sceneAssetUses(scene, scene.template ? TEMPLATES[scene.template as keyof typeof TEMPLATES] : undefined);
    } catch (e) {
      throw new PipelineError(stage, (e as Error).message);
    }
    if (uses.length) {
      const tools = opts.tools ?? { ffmpeg: opts.ffmpeg, ffprobe: opts.ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1') };
      staged = await stageSceneAssets({
        uses,
        assets: opts.assets ?? new Map(),
        dir: join(opts.workDir ?? `${opts.out}.work`, 'assets'),
        tools,
        output,
        frames: { first: 0, count: frames },
        video: 'frames',
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.log ? { log: opts.log } : {}),
      });
    }
    for (const [k, it] of staged?.items ?? []) if (it.frames) videos[k] = it.frames.names.map((n) => assetBase + n);
    source = sceneSource(scene, durationSeconds, staged, assetBase);
  }
  // Inlined pictures (html-layout) are not scene source; only agent and template markup counts.
  if (scene.template !== 'html-layout' && Buffer.byteLength(source.html) + Buffer.byteLength(source.css) > MAX_SOURCE_BYTES * 2) {
    throw new PipelineError(stage, `html scene is larger than ${MAX_SOURCE_BYTES * 2} bytes`);
  }
  let doc: string;
  try {
    doc = buildDocument({ html: source.html, css: source.css, theme, output, durationSeconds, ...(opts.platform ? { platform: opts.platform } : {}), ...(staged ? { assetBase } : {}) });
  } catch (e) {
    throw new PipelineError(stage, (e as Error).message);
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  // 1 s per frame at 1080p and less, more for larger frames (a 4K screenshot is four times the pixels).
  const perFrameMs = 1000 * Math.max(1, (output.width * output.height) / (1920 * 1080));
  const timeoutMs = Math.min(opts.timeoutMs ?? 30_000 + frames * perFrameMs, sceneTimeoutCapMs());
  const timeout = AbortSignal.timeout(timeoutMs);
  // The page leaving its document (meta refresh, a link) fails the render (D-085).
  const navigation = new AbortController();
  let navigatedTo = '';
  const signal = AbortSignal.any([timeout, navigation.signal, ...(opts.signal ? [opts.signal] : [])]);
  const navigationError = () =>
    new PipelineError(stage, `the scene tried to navigate away from its document (${navigatedTo.slice(0, 120)}): scenes render without network access and must not navigate`);
  const encoder = startPngEncoder(opts.ffmpeg, opts.out, output.fps, stage);
  const blocked: string[] = [];
  const assetRequests: string[] = [];
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
      // No server secrets in the browser's environment (D-086).
      env: renderChildEnv(),
      args: [
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-gpu',
        '--font-render-hinting=none',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
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
      // This render's assets: answered from the staged files (exact name lookup), never from the network.
      if (staged && url.startsWith(assetBase) && route.request().method() === 'GET') {
        const hit = lookupAsset(staged, token, new URL(url).pathname);
        if (hit) {
          if (assetRequests.length < 10_000) assetRequests.push(url.slice(assetBase.length));
          return route.fulfill({ status: 200, path: hit.file, headers: assetHeaders(hit.contentType) });
        }
      }
      if (blocked.length < 50) blocked.push(url.slice(0, 200));
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('popup', (p) => void p.close());
    await page.setContent(doc, { waitUntil: 'load', timeout: 20_000 });
    const home = page.url();
    const onNavigated = (frame: import('playwright-core').Frame) => {
      if (frame === page.mainFrame() && frame.url() !== home && !navigation.signal.aborted) {
        navigatedTo = frame.url();
        navigation.abort();
      }
    };
    page.on('framenavigated', onNavigated);
    if (page.url() !== home) onNavigated(page.mainFrame());
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (staged) {
      // Every asset picture must have loaded before the first frame (a missing one fails the render, not a blank frame).
      const broken = await page.evaluate(async (base) => {
        const imgs = [...document.images].filter((i) => i.src.startsWith(base));
        await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
        return imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src.slice(base.length));
      }, assetBase);
      if (broken.length) throw new PipelineError(stage, `asset picture(s) did not load: ${broken.slice(0, 5).join(', ')}`);
    }
    // Fit-to-box (#287): elements marked data-rf-fit shrink until they fit their box.
    await page.evaluate(FIT_TEXT_SCRIPT);
    const hasVideo = Object.keys(videos).length > 0;
    if (hasVideo) await page.evaluate((v) => void ((window as unknown as { __rfVideos: unknown }).__rfVideos = v), videos);

    for (let f = 0; f < frames; f++) {
      if (signal.aborted) break;
      const t = (f * 1000) / output.fps;
      // Video in layout panes: this frame's picture of each video, decoded before the screenshot.
      const pictures: Array<[string, string]> = [];
      for (const [key, files] of layoutVideos) pictures.push([key, await frameDataUrl(files[f]!)]);
      await page.evaluate(
        async ({ ms, pictures }) => {
          for (const a of document.getAnimations()) {
            a.pause();
            a.currentTime = ms;
          }
          const loads: Array<Promise<void>> = [];
          for (const [key, src] of pictures) {
            for (const img of document.querySelectorAll<HTMLImageElement>(`img[data-rf-video="${CSS.escape(key)}"]`)) {
              img.src = src;
              loads.push(img.decode().catch(() => undefined));
            }
          }
          await Promise.all(loads);
        },
        { ms: t, pictures }
      );
      if (hasVideo) {
        // Video (#299): picture f of each clip, decoded before the screenshot (frame-exact, no codec in the browser).
        const missing = await page.evaluate(async (frame) => {
          const v = (window as unknown as { __rfVideos: Record<string, string[]> }).__rfVideos;
          const els = [...document.querySelectorAll<HTMLImageElement>('img[data-rf-video]')];
          await Promise.all(
            els.map((el) => {
              const urls = v[el.dataset.rfVideo ?? ''];
              if (!urls) return undefined;
              const next = urls[Math.min(frame, urls.length - 1)]!;
              if (el.src === next) return undefined;
              el.src = next;
              return el.decode().catch(() => undefined);
            })
          );
          return els.filter((el) => !el.complete || el.naturalWidth === 0).length;
        }, f);
        if (missing) throw new PipelineError(stage, `video picture for frame ${f} did not load`);
      }
      const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: output.width, height: output.height }, caret: 'hide', animations: 'allow' });
      await encoder.write(png);
      opts.onProgress?.(f + 1, frames);
    }
    if (navigation.signal.aborted) throw navigationError();
    if (timeout.aborted) throw new PipelineError(stage, `html render timed out after ${timeoutMs} ms`);
    if (signal.aborted) throw new PipelineError(stage, 'cancelled');
    await encoder.finish();
    const version = browser.version();
    return { out: opts.out, frames, millis: Date.now() - started, browser: version, blockedRequests: blocked, assetRequests };
  } catch (e) {
    encoder.kill();
    if (navigation.signal.aborted) throw navigationError();
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
    if (layoutVideos.size) await rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
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
        ...(ctx.platform ? { platform: ctx.platform } : {}),
        out: ctx.out,
        ffmpeg: ctx.tools.ffmpeg,
        browserExecutable: opts.browserExecutable,
        signal: ctx.signal,
        onProgress: ctx.progress,
        timeoutMs: opts.timeoutMs,
        assets: ctx.assets,
        tools: ctx.tools,
        workDir: ctx.workDir,
        log: ctx.log,
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
