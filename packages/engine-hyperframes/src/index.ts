import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  RENDER_ENV_ALLOWLIST,
  SceneMarkupError,
  browserVersion,
  chromiumSandbox,
  packageVersion,
  prepareSceneDocument,
  renderChildEnv,
  sceneTimeoutCapMs,
  type EnginePlugin,
} from '@reelforge/core';
import { PipelineError } from '@reelforge/media-pipeline';
import {
  BUILTIN_THEMES,
  FIT_TEXT_SCRIPT,
  MAX_SOURCE_BYTES,
  frameLayout,
  layoutCssVars,
  TEMPLATES,
  hyperframesTitleProps,
  type HyperframesTitleProps,
  type OutputSettings,
  type RenderScene,
  type ThemeTokens,
} from '@reelforge/project-schema';
import { EGRESS_REFUSED_LINE, FONT_REFUSED_LINE, REFUSED_LINE, nodeEgressEnv, startNetworkSink } from './network';
import { killRenderNow, reapRender } from './processes';

export { startNetworkSink } from './network';
export { processesWithEnv, reapRender } from './processes';

/**
 * HyperFrames (HeyGen's Apache-2.0 HTML-to-video framework) as an engine.
 * Renders with the LOCAL renderer only (`hyperframes render`, which drives
 * our Chrome Headless Shell); no HeyGen account, cloud or credits.
 *
 * Sandboxing (D-085, D-086, D-087):
 *   - the composition is parsed (parse5) and ReelForge's head, with a
 *     Content-Security-Policy that allows only the renderer's own local file
 *     server ('self') and data:/blob: URLs, becomes the first child of the
 *     parsed <head>; documents that bring their own policy (<meta http-equiv>,
 *     <base>) or an external <script src> are refused up front;
 *   - outside the page, every outbound connection is refused (network.ts):
 *     HyperFrames' restricted network mode with a deny-all upstream, WebRTC
 *     limited to proxied connections, QUIC off; any attempt fails the render;
 *   - WebRTC constructors are also removed from the page;
 *   - files outside the scene's folder are refused (--refuse-outside-files);
 *     telemetry, update checks and auto-installs are disabled; the CLI gets an
 *     allowlisted environment without server secrets;
 *   - the render has a hard timeout (capped by render.sceneTimeoutSeconds) and
 *     is killed (process group) on cancel.
 */

export const HF_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline' data:; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; form-action 'none'";

/** Inline script that removes WebRTC from the page (defence in depth; the browser flags block it too). */
export const HF_PAGE_GUARD =
  "(()=>{for(const n of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCSessionDescription','RTCIceCandidate','RTCRtpSender','RTCRtpReceiver']){try{Object.defineProperty(window,n,{value:undefined,writable:false,configurable:false})}catch(e){}}})();";

export function hyperframesVersion(): string {
  return packageVersion('hyperframes', import.meta.url);
}

/** Path of the hyperframes CLI entry (bin/hyperframes.mjs). */
export function hyperframesBin(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('hyperframes/package.json')), 'bin', 'hyperframes.mjs');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Theme and layout (#287) as CSS custom properties, the same names as the html engine. */
function themeVars(theme: ThemeTokens, output: OutputSettings, platform?: string): string {
  const c = theme.colors;
  return `:root{--rf-bg:${c.background};--rf-surface:${c.surface};--rf-text:${c.text};--rf-muted:${c.mutedText};--rf-accent:${c.accent};--rf-accent2:${c.accent2};--rf-font:${theme.fontFamily};--rf-heading-weight:${theme.headingWeight};${layoutCssVars(output.width, output.height, platform)}}`;
}

/**
 * Built-in template "hyperframes-title": CSS keyframes seeked by the HyperFrames runtime (no GSAP, no CDN).
 *
 * Any size (#287): sizes are multiples of the layout unit (1 % of the shorter
 * side), the text stays inside the content safe area (`frameLayout`), the
 * headline shrinks to fit (an inline FIT_TEXT_SCRIPT, `data-rf-fit`), and on
 * landscape frames the line length is capped.
 */
export function hyperframesTitle(props: HyperframesTitleProps, output: OutputSettings, seconds: number, platform?: string): string {
  const l = frameLayout(output.width, output.height, platform);
  const u = l.unit;
  const c = l.safe.content;
  const px = (n: number) => `${Math.round(n * 100) / 100}px`;
  const side = (n: number) => px(Math.max(n, 9 * u));
  const accent = props.accent ? `--rf-accent:${props.accent};` : '';
  const bg = props.background ? `--rf-bg:${props.background};` : '';
  const exitAt = (seconds * 0.88).toFixed(3);
  const exitLen = Math.max(0.15, seconds * 0.12 - 0.02).toFixed(3);
  const measure = l.direction === 'row' ? `max-width:${px(150 * u)};` : '';
  return `<style>
#hf-wrap{${accent}${bg}position:absolute;inset:0;background:var(--rf-bg);display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:${px(c.top)} ${side(c.right)} ${px(c.bottom)} ${side(c.left)};font-family:var(--rf-font)}
#hf-wrap>*{flex-shrink:0;${measure}}
#hf-head{flex-shrink:1;min-height:0;width:100%;color:var(--rf-text);font-size:${px(l.type.display)};font-weight:var(--rf-heading-weight);line-height:1.05;margin:0;animation:hf-in .8s cubic-bezier(.2,.8,.2,1) both, hf-out ${exitLen}s ease-in ${exitAt}s both}
#hf-line{height:${px(1.4 * u)};width:45%;background:var(--rf-accent);border-radius:999px;margin-top:${px(3.5 * u)};transform-origin:left;animation:hf-grow .9s cubic-bezier(.3,.8,.2,1) .2s both, hf-out ${exitLen}s ease-in ${exitAt}s both}
#hf-sub{color:var(--rf-muted);text-wrap:pretty;font-size:${px(l.type.caption)};margin:${px(4 * u)} 0 0;animation:hf-fade .6s ease-out .45s both, hf-out ${exitLen}s ease-in ${exitAt}s both}
@keyframes hf-in{from{opacity:.35;transform:translateX(${px(-6 * u)})}to{opacity:1;transform:none}}
@keyframes hf-grow{from{transform:scaleX(.15)}to{transform:scaleX(1)}}
@keyframes hf-fade{from{opacity:0}to{opacity:1}}
@keyframes hf-out{to{opacity:0}}
</style>
<div id="hf-wrap" class="clip" data-start="0" data-duration="${seconds}">
<h1 id="hf-head" data-rf-fit data-rf-fit-min="${Math.floor(l.type.displayMin)}">${escapeHtml(props.headline)}</h1>
<div id="hf-line"></div>
${props.subline ? `<p id="hf-sub">${escapeHtml(props.subline)}</p>` : ''}
</div>
<script>${FIT_TEXT_SCRIPT}</script>`;
}

/**
 * The composition document for a scene. Agent source can be a fragment
 * (wrapped in a root composition of the right size and duration) or a full
 * HyperFrames document (must declare data-composition-id with the output size).
 */
export function buildComposition(scene: RenderScene, output: OutputSettings, theme: ThemeTokens, platform?: string): string {
  const seconds = scene.durationFrames / output.fps;
  const stage = `render:${scene.id}`;
  let body: string;
  if (scene.html !== undefined) {
    body = scene.html;
    if (new TextEncoder().encode(body + (scene.css ?? '')).length > MAX_SOURCE_BYTES) {
      throw new PipelineError(stage, `composition is larger than ${MAX_SOURCE_BYTES} bytes`);
    }
    if (scene.css && /<\/style/i.test(scene.css)) throw new PipelineError(stage, 'css must not contain "</style"');
  } else if (scene.template === 'hyperframes-title') {
    body = hyperframesTitle(hyperframesTitleProps.parse(scene.props), output, seconds, platform);
  } else {
    throw new PipelineError(stage, `unknown hyperframes template "${scene.template}"`);
  }

  const head =
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HF_CSP}">` +
    `<script>${HF_PAGE_GUARD}</script>` +
    `<style>${themeVars(theme, output, platform)}html,body{margin:0;width:${output.width}px;height:${output.height}px;overflow:hidden;background:var(--rf-bg);color:var(--rf-text);font-family:var(--rf-font)}*{box-sizing:border-box}</style>` +
    (scene.css ? `<style>${scene.css}</style>` : '');

  // A full document (agent's own <html>) or a fragment wrapped in a sized root composition.
  const isDocument = /<html[\s>]/i.test(body);
  const doc = isDocument
    ? body
    : '<!doctype html><html lang="en"><head></head><body>' +
      `<div id="root" data-composition-id="main" data-start="0" data-duration="${seconds}" data-width="${output.width}" data-height="${output.height}" style="position:relative;width:${output.width}px;height:${output.height}px;overflow:hidden">` +
      body +
      '</div></body></html>';
  let prepared;
  try {
    prepared = prepareSceneDocument(doc, head, HF_CSP, 'hyperframes composition');
  } catch (e) {
    if (e instanceof SceneMarkupError) throw new PipelineError(stage, e.message);
    throw e;
  }
  if (prepared.scriptSources.some((src) => /^\s*(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(src))) {
    throw new PipelineError(
      stage,
      'external <script src> is not allowed: compositions render without network access. Inline the code; CSS animations and the Web Animations API work without libraries.'
    );
  }
  if (isDocument) {
    const root = prepared.findElement((_tag, attrs) => 'data-composition-id' in attrs);
    if (!root) throw new PipelineError(stage, 'a full HyperFrames document needs a root element with data-composition-id');
    const w = /^\s*(\d+)/.exec(root['data-width'] ?? '')?.[1];
    const h = /^\s*(\d+)/.exec(root['data-height'] ?? '')?.[1];
    if (Number(w) !== output.width || Number(h) !== output.height) {
      throw new PipelineError(stage, `the composition root must declare data-width="${output.width}" data-height="${output.height}" (got ${w ?? '?'}x${h ?? '?'})`);
    }
  }
  return prepared.html;
}

export interface HyperframesRenderOptions {
  scene: RenderScene;
  output: OutputSettings;
  theme?: ThemeTokens;
  /** brief.platform (ui safe zone on tall frames). */
  platform?: string;
  out: string;
  workDir: string;
  cacheDir: string;
  browserExecutable?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Environment for the hyperframes CLI: our browser, no telemetry, no update
 * checks or installs, no server secrets (allowlist), and, with `egressProxy`,
 * every outbound connection routed to ReelForge's deny-all sink.
 */
export function hyperframesEnv(
  browser: string,
  cacheDir: string,
  base: NodeJS.ProcessEnv = process.env,
  egressProxy?: string,
  /** This render's own temp directory (also how its processes are found, processes.ts). */
  tmpDir: string = join(cacheDir, 'hyperframes', 'tmp')
): NodeJS.ProcessEnv {
  const env = renderChildEnv(base, {}, [...RENDER_ENV_ALLOWLIST, 'NODE_OPTIONS']);
  return {
    ...env,
    HYPERFRAMES_BROWSER_PATH: browser,
    PRODUCER_HEADLESS_SHELL_PATH: browser,
    HYPERFRAMES_NO_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    HYPERFRAMES_NO_UPDATE_CHECK: '1',
    HYPERFRAMES_NO_AUTO_INSTALL: '1',
    HYPERFRAMES_SKIP_SKILLS: '1',
    HYPERFRAMES_RENDER_LOCK: 'off', // ReelForge's job runner limits concurrency itself
    // Same sandbox rule as every engine. "1" makes a sandbox that cannot start an
    // error instead of HyperFrames' silent fallback to --no-sandbox.
    HYPERFRAMES_CHROME_SANDBOX: chromiumSandbox(base) ? '1' : '0',
    XDG_CACHE_HOME: join(cacheDir, 'hyperframes'),
    // Its web-font cache too (HyperFrames otherwise uses ~/.cache, outside the data
    // volume, where fonts downloaded by other tools would leak into renders, #318).
    HYPERFRAMES_FONT_CACHE_DIR: join(cacheDir, 'hyperframes', 'fonts'),
    // Its temp files go to the cache directory (the data volume), not /tmp: in the
    // hardened container /tmp is a small tmpfs, and HyperFrames refuses to render
    // with less than 1 GB free in its temp directory.
    TMPDIR: tmpDir,
    CI: '1',
    // Outbound network (D-085): HyperFrames' capture proxy in front of the browser and
    // its own downloads, every address treated as non-public, upstream = deny-all sink.
    ...(egressProxy
      ? { PRODUCER_RESTRICT_PAGE_NETWORK: 'true', PRODUCER_NON_PUBLIC_CIDRS: '0.0.0.0/0,::/0', HYPERFRAMES_CAPTURE_PROXY: egressProxy }
      : {}),
    // Its Node-side fetch (web fonts, #318) is refused before it leaves the machine.
    ...nodeEgressEnv(env.NODE_OPTIONS, egressProxy),
  };
}

export async function renderHyperframesScene(opts: HyperframesRenderOptions): Promise<{ out: string; millis: number }> {
  const started = Date.now();
  const { scene, output } = opts;
  const stage = `render:${scene.id}`;
  const browser = opts.browserExecutable ?? process.env.REELFORGE_CHROMIUM_PATH;
  if (!browser || !existsSync(browser)) throw new PipelineError('setup', 'no browser for HyperFrames: set REELFORGE_CHROMIUM_PATH');
  const theme = opts.theme ?? BUILTIN_THEMES[0]!.tokens;
  const doc = buildComposition(scene, output, theme, opts.platform);
  const project = join(opts.workDir, 'hyperframes');
  await mkdir(project, { recursive: true });
  // One temp directory per render: the CLI and its browser inherit it, which is how
  // every process of this render is found and killed when it ends (processes.ts).
  const tmpDir = join(opts.cacheDir, 'hyperframes', 'tmp', `r-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  await writeFile(join(project, 'index.html'), doc);
  await mkdir(dirname(opts.out), { recursive: true });

  const seconds = scene.durationFrames / output.fps;
  const args = [
    hyperframesBin(),
    'render',
    project,
    '-o',
    opts.out,
    '--fps',
    String(output.fps),
    '--end',
    String(seconds),
    '--workers',
    '1',
    '--refuse-outside-files',
    '--no-browser-gpu',
    '--quiet',
  ];
  // Hard limit (D-087): the per-frame estimate, never more than render.sceneTimeoutSeconds.
  const timeoutMs = Math.min(opts.timeoutMs ?? 60_000 + scene.durationFrames * 1500, sceneTimeoutCapMs());
  let reason: 'timeout' | 'cancelled' | 'network' | null = null;
  let blockedTarget = '';
  let killTree: () => void = () => undefined;
  const onNetwork = (target: string) => {
    if (reason) return;
    reason = 'network';
    blockedTarget = target;
    killTree();
  };
  const sink = await startNetworkSink(onNetwork);
  const child = spawn(process.execPath, args, {
    cwd: project,
    env: hyperframesEnv(browser, opts.cacheDir, process.env, sink.url, tmpDir),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group; the browser is found by its TMPDIR (processes.ts)
  });
  let output_ = '';
  let remoteFonts = false;
  const collect = (d: Buffer) => {
    const text = d.toString();
    const refused = REFUSED_LINE.exec(text);
    if (refused) onNetwork(`a ${refused[1]} address`);
    const egress = EGRESS_REFUSED_LINE.exec(text);
    if (egress) onNetwork(egress[1]!);
    if (FONT_REFUSED_LINE.test(text)) remoteFonts = true;
    output_ += text;
    if (output_.length > 200_000) output_ = output_.slice(-100_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  killTree = () => {
    killRenderNow(child.pid, tmpDir);
    if (!child.pid) child.kill('SIGKILL');
  };
  const timer = setTimeout(() => {
    reason = 'timeout';
    killTree();
  }, timeoutMs);
  const onAbort = () => {
    reason = 'cancelled';
    killTree();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (reason === 'network') {
      throw new PipelineError(
        stage,
        `the scene tried to reach the network (${blockedTarget}) and was stopped: scenes render without network access, and navigating away from the composition is not allowed. Put images, fonts and media in the project's assets and reference them locally, and inline scripts.`,
        tail(output_)
      );
    }
    if (reason === 'timeout') throw new PipelineError(stage, `HyperFrames render timed out after ${timeoutMs} ms`, tail(output_));
    if (reason === 'cancelled' || opts.signal?.aborted) throw new PipelineError(stage, 'cancelled');
    if (code !== 0 || !existsSync(opts.out)) {
      throw new PipelineError(stage, `hyperframes render exited with code ${code}`, tail(output_));
    }
    if (remoteFonts) {
      opts.log?.('hyperframes: a font the scene names is not installed and was not downloaded (renders have no network); the CSS fallback font was used. Put font files in the project\'s assets to use them.');
    }
    opts.log?.(`hyperframes ${hyperframesVersion()}: rendered ${scene.durationFrames} frames`);
    return { out: opts.out, millis: Date.now() - started };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    // Whatever the outcome, nothing of this render keeps running (or writing) after it returns.
    const left = await reapRender(child.pid, tmpDir);
    if (left.length) opts.log?.(`hyperframes: ${left.length} process(es) of the render did not exit after SIGKILL: ${left.join(', ')}`);
    await sink.close();
    await rm(project, { recursive: true, force: true }).catch(() => undefined);
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}

function tail(s: string): string {
  return s.split('\n').filter(Boolean).slice(-40).join('\n');
}

/** HyperFrames as a ReelForge engine plugin. */
export function hyperframesEngine(opts: { browserExecutable?: string; timeoutMs?: number } = {}): EnginePlugin {
  const browser = () => opts.browserExecutable ?? process.env.REELFORGE_CHROMIUM_PATH;
  return {
    id: 'hyperframes',
    displayName: 'HyperFrames (local renderer)',
    acceptsSource: true,
    version: () => `hyperframes ${hyperframesVersion()}`,
    templates: () =>
      Object.entries(TEMPLATES)
        .filter(([, t]) => t.engine === 'hyperframes')
        .map(([id, t]) => ({ ...t, id })),
    browserSandbox: () => chromiumSandbox(),
    availability() {
      const b = browser();
      if (!b || !existsSync(b)) return { ok: false, reason: 'no browser: set REELFORGE_CHROMIUM_PATH to a Chrome Headless Shell binary' };
      try {
        if (!existsSync(hyperframesBin())) return { ok: false, reason: 'the hyperframes package is not installed' };
      } catch {
        return { ok: false, reason: 'the hyperframes package is not installed' };
      }
      return { ok: true };
    },
    async render(scene, ctx) {
      const res = await renderHyperframesScene({
        scene,
        output: ctx.output,
        theme: ctx.theme,
        ...(ctx.platform ? { platform: ctx.platform } : {}),
        out: ctx.out,
        workDir: ctx.workDir,
        cacheDir: ctx.cacheDir,
        browserExecutable: browser(),
        signal: ctx.signal,
        timeoutMs: opts.timeoutMs,
        log: ctx.log,
      });
      ctx.progress(scene.durationFrames, scene.durationFrames);
      return {
        file: res.out,
        frames: scene.durationFrames,
        engineVersion: `hyperframes ${hyperframesVersion()}`,
        browserVersion: browserVersion(browser()),
        millis: res.millis,
      };
    },
  };
}
