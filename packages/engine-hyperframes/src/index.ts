import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import {
  RENDER_ENV_ALLOWLIST,
  SceneMarkupError,
  browserVersion,
  chromiumSandbox,
  packageVersion,
  prepareSceneDocument,
  renderChildEnv,
  sceneAssetUses,
  sceneTimeoutCapMs,
  stageSceneAssets,
  type EnginePlugin,
  type ResolvedAsset,
  type StagedSceneAssets,
} from '@reelforge/core';
import { PipelineError, type Tools } from '@reelforge/media-pipeline';
import {
  BUILTIN_THEMES,
  FIT_TEXT_SCRIPT,
  fpsArg,
  fpsLabel,
  fpsValue,
  frameLayout,
  fontFaceCss,
  framesToSeconds,
  hyperframesTitleProps,
  layoutCssVars,
  MAX_SOURCE_BYTES,
  TEMPLATES,
  layoutSceneDom,
  layoutSceneProps,
  mediaKey,
  mediaLayersHtml,
  rewriteAssetRefs,
  type DomLogo,
  type DomMediaLayer,
  type HyperframesTitleProps,
  type PictureRequest,
  type OutputSettings,
  type RenderScene,
  type ThemeTokens,
  type FrameRate,
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
export function hyperframesTitle(props: HyperframesTitleProps, output: OutputSettings, seconds: number, platform?: string, media: { bg?: DomMediaLayer; logo?: DomLogo } = {}): string {
  const layers = mediaLayersHtml(media.bg, media.logo);
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
#hf-wrap>.rf-media,#hf-wrap>.rf-logo{flex-shrink:initial;max-width:none}
#hf-head,#hf-line,#hf-sub{position:relative;z-index:1}
${layers.css}
</style>
<div id="hf-wrap" class="clip" data-start="0" data-duration="${seconds}">
${layers.under}
<h1 id="hf-head" data-rf-fit data-rf-fit-min="${Math.floor(l.type.displayMin)}">${escapeHtml(props.headline)}</h1>
<div id="hf-line"></div>
${props.subline ? `<p id="hf-sub">${escapeHtml(props.subline)}</p>` : ''}
${layers.over}
</div>
<script>${FIT_TEXT_SCRIPT}</script>`;
}

/** A picture of a layout pane as the composition references it: a file in the scene folder. */
export interface CompositionMedia {
  kind: 'image' | 'video';
  /** Path relative to the composition (e.g. `media/clip.mp4`). */
  src: string;
}

/**
 * Built-in template "hyperframes-layout" (#287): the shared layout markup
 * (layoutSceneDom) with images as `<img>` and videos as timed, muted
 * `<video>` clips that the HyperFrames runtime seeks frame by frame
 * (`data-media-start` is the pane's start offset).
 */
export function hyperframesLayout(props: unknown, output: OutputSettings, seconds: number, media: (asset: string) => CompositionMedia, platform?: string): string {
  const p = layoutSceneProps.parse(props);
  const picture = (r: PictureRequest) => {
    const m = media(r.media.asset);
    const src = escapeHtml(m.src);
    if (m.kind === 'image') return `<img class="${r.className}" style="${r.style}" alt="" src="${src}">`;
    return (
      `<video id="rfl-v${r.pane}-${r.layer}" class="clip ${r.className}" style="${r.style}" src="${src}" muted playsinline ` +
      `data-start="0" data-duration="${seconds}" data-media-start="${r.media.startSeconds}" data-track-index="${r.pane * 2 + (r.layer === 'bg' ? 1 : 2)}"></video>`
    );
  };
  const dom = layoutSceneDom({ props: p, width: output.width, height: output.height, ...(platform ? { platform } : {}), durationSeconds: seconds, picture });
  return `<style>${dom.css}</style><div id="rfl-wrap" class="clip" data-start="0" data-duration="${seconds}" data-track-index="0" style="position:absolute;inset:0">${dom.html}</div><script>${FIT_TEXT_SCRIPT}</script>`;
}

/**
 * Frame rates HyperFrames' `--end` accepts ("a whole frame rate in 24, 25, 30,
 * 60"). At any other rate (48, 50 and the NTSC rates, #302) the render runs
 * without `--end` and its length comes from the root's `data-duration`, of
 * which HyperFrames renders ceil(duration x fps) frames.
 */
export const HF_END_RATES: readonly FrameRate[] = [24, 25, 30, 60];

/**
 * The root duration for an exact frame count without `--end`: half a frame
 * short of `frames / fps`, so ceil(duration x fps) is exactly `frames` whatever
 * the floating-point rounding (the last frame, at (frames - 1) / fps, is inside).
 */
export function rootSeconds(frames: number, fps: FrameRate): number {
  return HF_END_RATES.includes(fps) ? framesToSeconds(frames, fps) : framesToSeconds(frames - 0.5, fps);
}

/**
 * The composition document for a scene. Agent source can be a fragment
 * (wrapped in a root composition of the right size and duration) or a full
 * HyperFrames document (must declare data-composition-id with the output size).
 */
export function buildComposition(
  scene: RenderScene,
  output: OutputSettings,
  theme: ThemeTokens,
  platform?: string,
  /** Staged assets (#299), or, for hyperframes-layout, where the pictures of its panes are (#287). */
  media?: StagedSceneAssets | ((asset: string) => CompositionMedia),
  /** transparent (#302: output.alpha): the page paints no background. */
  opts: { transparent?: boolean } = {}
): string {
  const seconds = framesToSeconds(scene.durationFrames, output.fps);
  const staged = typeof media === 'function' ? undefined : media;
  const paneMedia = typeof media === 'function' ? media : undefined;
  const stage = `render:${scene.id}`;
  // Assets (#299) are files in the composition folder (assets/<name>), served by HyperFrames' own file server.
  const url = (key: string) => {
    const it = staged?.items.get(key);
    return it ? `assets/${it.name}` : undefined;
  };
  let body: string;
  let css = scene.css;
  if (scene.html !== undefined) {
    body = staged ? rewriteAssetRefs(scene.html, url) : scene.html;
    if (staged && css) css = rewriteAssetRefs(css, url);
    if (new TextEncoder().encode(body + (scene.css ?? '')).length > MAX_SOURCE_BYTES) {
      throw new PipelineError(stage, `composition is larger than ${MAX_SOURCE_BYTES} bytes`);
    }
    if (scene.css && /<\/style/i.test(scene.css)) throw new PipelineError(stage, 'css must not contain "</style"');
  } else if (scene.template === 'hyperframes-title') {
    const props = hyperframesTitleProps.parse(scene.props);
    const bgItem = props.media ? staged?.items.get(mediaKey(props.media.asset, props.media.start)) : undefined;
    const bg: DomMediaLayer | undefined =
      props.media && bgItem
        ? { url: `assets/${bgItem.name}`, fit: props.media.fit, ...(props.media.focus ? { focus: props.media.focus } : {}), dim: props.media.dim, tag: bgItem.mediaType === 'video' ? 'video' : 'img', ...(props.media.start ? { start: props.media.start } : {}) }
        : undefined;
    const logoItem = props.logo ? staged?.items.get(props.logo.asset) : undefined;
    const logo: DomLogo | undefined = props.logo && logoItem ? { url: `assets/${logoItem.name}`, corner: props.logo.corner, size: props.logo.size } : undefined;
    body = hyperframesTitle(props, output, seconds, platform, { ...(bg ? { bg } : {}), ...(logo ? { logo } : {}) });
  } else if (scene.template === 'hyperframes-layout') {
    const resolve =
      paneMedia ??
      ((asset: string): CompositionMedia => {
        throw new PipelineError(stage, `asset "${asset}" is not available to the renderer`);
      });
    body = hyperframesLayout(scene.props, output, seconds, resolve, platform);
  } else {
    throw new PipelineError(stage, `unknown hyperframes template "${scene.template}"`);
  }

  // Fonts (#303): @font-face for the staged faces, files in the composition folder ('self' in the policy).
  const fonts = staged?.fonts.length ? `<style>${fontFaceCss(staged.fontFaces('assets/')).replace(/<\/style/gi, '')}</style>` : '';
  const head =
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HF_CSP}">` +
    `<script>${HF_PAGE_GUARD}</script>` +
    fonts +
    `<style>${themeVars(theme, output, platform)}html,body{margin:0;width:${output.width}px;height:${output.height}px;overflow:hidden;background:${opts.transparent ? 'transparent' : 'var(--rf-bg)'};color:var(--rf-text);font-family:var(--rf-font)}*{box-sizing:border-box}</style>` +
    (css ? `<style>${css}</style>` : '');

  // A full document (agent's own <html>) or a fragment wrapped in a sized root composition.
  const isDocument = /<html[\s>]/i.test(body);
  const doc = isDocument
    ? body
    : '<!doctype html><html lang="en"><head></head><body>' +
      `<div id="root" data-composition-id="main" data-start="0" data-duration="${rootSeconds(scene.durationFrames, output.fps)}" data-width="${output.width}" data-height="${output.height}" style="position:relative;width:${output.width}px;height:${output.height}px;overflow:hidden">` +
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
    // Without --end (rates other than 24/25/30/60) the document's own duration sets the length.
    if (!HF_END_RATES.includes(output.fps)) {
      const d = Number(root['data-duration']);
      if (!(Math.ceil(d * fpsValue(output.fps) - 1e-6) >= scene.durationFrames)) {
        throw new PipelineError(
          stage,
          `at ${fpsLabel(output.fps)} fps the composition root's data-duration sets the length: it must be at least ${rootSeconds(scene.durationFrames, output.fps).toFixed(4)} s for ${scene.durationFrames} frames (got ${root['data-duration'] ?? 'none'})`
        );
      }
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
  /** Transparent background (#302): HyperFrames' MOV output (ProRes 4444 with alpha), `out` ends in .mov. */
  alpha?: boolean;
  /** The project's assets (EngineRenderContext.assets); the scene may use only these (#299), including hyperframes-layout panes. */
  assets?: ReadonlyMap<string, ResolvedAsset>;
  /** ffprobe/ffmpeg for checking assets before the render. */
  tools?: Tools;
}

/**
 * Put the assets a layout scene shows into the scene folder (`media/`), hard
 * linked where possible: the renderer serves only that folder
 * (--refuse-outside-files).
 */
async function stageMedia(scene: RenderScene, project: string, assets: ReadonlyMap<string, ResolvedAsset>, stage: string): Promise<(asset: string) => CompositionMedia> {
  const staged = new Map<string, CompositionMedia>();
  const lookup = (asset: string): CompositionMedia => {
    const m = staged.get(asset);
    if (!m) throw new PipelineError(stage, `asset "${asset}" is not available to the renderer`);
    return m;
  };
  if (scene.template !== 'hyperframes-layout' || scene.html !== undefined) return lookup;
  const props = layoutSceneProps.parse(scene.props);
  await mkdir(join(project, 'media'), { recursive: true });
  for (const pane of props.panes) {
    const id = pane.media?.asset;
    if (!id || staged.has(id)) continue;
    const a = assets.get(id);
    if (!a) throw new PipelineError(stage, `asset "${id}" is not available to the renderer`);
    if (a.mediaType !== 'image' && a.mediaType !== 'video') throw new PipelineError(stage, `asset "${id}" is ${a.mediaType}; panes show images or videos`);
    const ext = (extname(a.file).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) ?? [''])[0] || (a.mediaType === 'video' ? '.mp4' : '.img');
    const name = `media/${id}${ext}`;
    await link(a.file, join(project, name)).catch(() => copyFile(a.file, join(project, name)));
    staged.set(id, { kind: a.mediaType, src: name });
  }
  return lookup;
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
  const project = join(opts.workDir, 'hyperframes');
  await mkdir(project, { recursive: true });
  let doc: string;
  if (scene.html === undefined && scene.template === 'hyperframes-layout') {
    // Layout panes (#287): files linked into media/, video played as a timed <video> that HyperFrames seeks.
    doc = buildComposition(scene, output, theme, opts.platform, await stageMedia(scene, project, opts.assets ?? new Map(), stage), { transparent: opts.alpha === true });
  } else {
    let uses;
    try {
      uses = sceneAssetUses(scene, scene.template ? TEMPLATES[scene.template as keyof typeof TEMPLATES] : undefined);
    } catch (e) {
      throw new PipelineError(stage, (e as Error).message);
    }
    // Inside the composition folder, so --refuse-outside-files still holds; HyperFrames seeks video itself.
    const staged = await stageSceneAssets({
      uses,
      assets: opts.assets ?? new Map(),
      dir: join(project, 'assets'),
      tools: opts.tools ?? { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      output,
      frames: { first: 0, count: scene.durationFrames },
      video: 'file',
      // Fonts (#303): project font assets and bundled fonts of the families the theme and the scene name.
      fonts: { family: theme.fontFamily, markup: `${scene.html ?? ''}\n${scene.css ?? ''}` },
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
    doc = buildComposition(scene, output, theme, opts.platform, staged, { transparent: opts.alpha === true });
  }
  // One temp directory per render: the CLI and its browser inherit it, which is how
  // every process of this render is found and killed when it ends (processes.ts).
  const tmpDir = join(opts.cacheDir, 'hyperframes', 'tmp', `r-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  await writeFile(join(project, 'index.html'), doc);
  await mkdir(dirname(opts.out), { recursive: true });

  const seconds = framesToSeconds(scene.durationFrames, output.fps);
  const args = [
    hyperframesBin(),
    'render',
    project,
    '-o',
    opts.out,
    '--fps',
    // Exact: HyperFrames takes FFmpeg-style rationals (30000/1001), #302.
    fpsArg(output.fps),
    // --end only at whole rates and for MP4 (MOV, with alpha, renders the composition's whole data-duration);
    // otherwise the root's data-duration gives the frames (rootSeconds).
    ...(!opts.alpha && HF_END_RATES.includes(output.fps) ? ['--end', String(seconds)] : []),
    '--workers',
    '1',
    // MOV renders with transparency, as ProRes 4444 (its default profile keeps alpha).
    ...(opts.alpha ? ['--format', 'mov', '--prores-profile', '4444'] : []),
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
    // Transparent backgrounds (#302): HyperFrames captures with alpha for its MOV output.
    capabilities: () => ({ frameRanges: false, output: { alpha: true } }),
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
        ...(ctx.alpha ? { alpha: true } : {}),
        assets: ctx.assets,
        tools: ctx.tools,
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
