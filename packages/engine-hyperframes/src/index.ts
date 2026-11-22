import { spawn } from 'node:child_process';
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
  MAX_SOURCE_BYTES,
  TEMPLATES,
  hyperframesTitleProps,
  type HyperframesTitleProps,
  type OutputSettings,
  type RenderScene,
  type ThemeTokens,
} from '@reelforge/project-schema';
import { REFUSED_LINE, startNetworkSink } from './network';

export { startNetworkSink } from './network';

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

function themeVars(theme: ThemeTokens): string {
  const c = theme.colors;
  return `:root{--rf-bg:${c.background};--rf-surface:${c.surface};--rf-text:${c.text};--rf-muted:${c.mutedText};--rf-accent:${c.accent};--rf-accent2:${c.accent2};--rf-font:${theme.fontFamily};--rf-heading-weight:${theme.headingWeight}}`;
}

/** Built-in template "hyperframes-title": CSS keyframes seeked by the HyperFrames runtime (no GSAP, no CDN). */
export function hyperframesTitle(props: HyperframesTitleProps, output: OutputSettings, seconds: number): string {
  const u = output.width / 100;
  const accent = props.accent ? `--rf-accent:${props.accent};` : '';
  const bg = props.background ? `--rf-bg:${props.background};` : '';
  const exitAt = (seconds * 0.88).toFixed(3);
  const exitLen = Math.max(0.15, seconds * 0.12 - 0.02).toFixed(3);
  return `<style>
#hf-wrap{${accent}${bg}position:absolute;inset:0;background:var(--rf-bg);display:flex;flex-direction:column;justify-content:center;padding:${9 * u}px;font-family:var(--rf-font)}
#hf-ring{position:absolute;width:${70 * u}px;height:${70 * u}px;border-radius:50%;border:${3 * u}px solid var(--rf-accent);right:${-20 * u}px;top:${12 * u}px;opacity:.5;animation:hf-spin ${seconds}s linear both}
#hf-head{color:var(--rf-text);font-size:${10.5 * u}px;font-weight:var(--rf-heading-weight);line-height:1.05;margin:0;animation:hf-in .8s cubic-bezier(.2,.8,.2,1) both, hf-out ${exitLen}s ease-in ${exitAt}s both}
#hf-line{height:${1.4 * u}px;width:45%;background:var(--rf-accent);border-radius:999px;margin-top:${3.5 * u}px;transform-origin:left;animation:hf-grow .9s cubic-bezier(.3,.8,.2,1) .2s both, hf-out ${exitLen}s ease-in ${exitAt}s both}
#hf-sub{color:var(--rf-muted);font-size:${4.8 * u}px;margin:${4 * u}px 0 0;animation:hf-fade .6s ease-out .45s both, hf-out ${exitLen}s ease-in ${exitAt}s both}
@keyframes hf-in{from{opacity:.35;transform:translateX(${-6 * u}px)}to{opacity:1;transform:none}}
@keyframes hf-grow{from{transform:scaleX(.15)}to{transform:scaleX(1)}}
@keyframes hf-fade{from{opacity:0}to{opacity:1}}
@keyframes hf-spin{from{transform:rotate(0) scale(.9)}to{transform:rotate(40deg) scale(1.1)}}
@keyframes hf-out{to{opacity:0}}
</style>
<div id="hf-wrap" class="clip" data-start="0" data-duration="${seconds}">
<div id="hf-ring"></div>
<h1 id="hf-head">${escapeHtml(props.headline)}</h1>
<div id="hf-line"></div>
${props.subline ? `<p id="hf-sub">${escapeHtml(props.subline)}</p>` : ''}
</div>`;
}

/**
 * The composition document for a scene. Agent source can be a fragment
 * (wrapped in a root composition of the right size and duration) or a full
 * HyperFrames document (must declare data-composition-id with the output size).
 */
export function buildComposition(scene: RenderScene, output: OutputSettings, theme: ThemeTokens): string {
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
    body = hyperframesTitle(hyperframesTitleProps.parse(scene.props), output, seconds);
  } else {
    throw new PipelineError(stage, `unknown hyperframes template "${scene.template}"`);
  }

  const head =
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HF_CSP}">` +
    `<script>${HF_PAGE_GUARD}</script>` +
    `<style>${themeVars(theme)}html,body{margin:0;width:${output.width}px;height:${output.height}px;overflow:hidden;background:var(--rf-bg);color:var(--rf-text);font-family:var(--rf-font)}*{box-sizing:border-box}</style>` +
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
export function hyperframesEnv(browser: string, cacheDir: string, base: NodeJS.ProcessEnv = process.env, egressProxy?: string): NodeJS.ProcessEnv {
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
    // Its temp files go to the cache directory (the data volume), not /tmp: in the
    // hardened container /tmp is a small tmpfs, and HyperFrames refuses to render
    // with less than 1 GB free in its temp directory.
    TMPDIR: join(cacheDir, 'hyperframes', 'tmp'),
    CI: '1',
    // Outbound network (D-085): HyperFrames' capture proxy in front of the browser and
    // its own downloads, every address treated as non-public, upstream = deny-all sink.
    ...(egressProxy
      ? { PRODUCER_RESTRICT_PAGE_NETWORK: 'true', PRODUCER_NON_PUBLIC_CIDRS: '0.0.0.0/0,::/0', HYPERFRAMES_CAPTURE_PROXY: egressProxy }
      : {}),
  };
}

export async function renderHyperframesScene(opts: HyperframesRenderOptions): Promise<{ out: string; millis: number }> {
  const started = Date.now();
  const { scene, output } = opts;
  const stage = `render:${scene.id}`;
  const browser = opts.browserExecutable ?? process.env.REELFORGE_CHROMIUM_PATH;
  if (!browser || !existsSync(browser)) throw new PipelineError('setup', 'no browser for HyperFrames: set REELFORGE_CHROMIUM_PATH');
  const theme = opts.theme ?? BUILTIN_THEMES[0]!.tokens;
  const doc = buildComposition(scene, output, theme);
  const project = join(opts.workDir, 'hyperframes');
  await mkdir(project, { recursive: true });
  await mkdir(join(opts.cacheDir, 'hyperframes', 'tmp'), { recursive: true });
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
    env: hyperframesEnv(browser, opts.cacheDir, process.env, sink.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so Chrome children die with it
  });
  let output_ = '';
  const collect = (d: Buffer) => {
    const text = d.toString();
    const refused = REFUSED_LINE.exec(text);
    if (refused) onNetwork(`a ${refused[1]} address`);
    output_ += text;
    if (output_.length > 200_000) output_ = output_.slice(-100_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  killTree = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
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
    opts.log?.(`hyperframes ${hyperframesVersion()}: rendered ${scene.durationFrames} frames`);
    return { out: opts.out, millis: Date.now() - started };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    await sink.close();
    await rm(project, { recursive: true, force: true }).catch(() => undefined);
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
