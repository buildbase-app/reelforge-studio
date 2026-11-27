import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open as openFile, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PipelineError, probeMedia, videoFramesAt, type FrameRate, type Tools } from '@renderweld/media-pipeline';
import {
  assetRefsInMarkup,
  mediaKey,
  rewriteAssetRefs,
  fontFamilies,
  type AssetMediaType,
  type FontFaceSpec,
  type RenderScene,
  type SceneMedia,
  type TemplateDefinition,
} from '@renderweld/project-schema';
import { defaultTreeAdapter as ta, parse, parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { sniffContentType } from './assets';
import { FontError, bundledFontFaces, fontFaceDescriptors, readFontInfo } from './fonts';
import { renderChildEnv } from './childEnv';
import type { Logger, ResolvedAsset } from './plugins';
import { SceneMarkupError } from './sceneMarkup';
import { looksLikeSvg, sanitizeSvg, svgSize, SvgError } from './svg';

/**
 * Assets in renders (#299, D-120). Every engine gets the project's assets as
 * local files (`EngineRenderContext.assets`, resolved by the service from the
 * project's own manifest only). Before a scene renders, its engine calls
 * `stageSceneAssets` with the assets the scene uses (template props, `asset:`
 * references in its html/css, `scene.assets`), which:
 *
 *   - refuses any id that is not in that map (another project's asset, a
 *     typo), a media type the place does not allow, and files whose bytes are
 *     not what the manifest says (sniffed again, as on upload);
 *   - copies each file into the scene's work directory under a name it makes
 *     up (`<id>.<ext>`), so nothing outside it is ever served, and rewrites
 *     SVG from the allowlist (svg.ts);
 *   - probes images and videos with ffprobe and limits their size, and turns
 *     each video into the pictures the scene shows, one per output frame
 *     (media-pipeline videoFramesAt: frame-exact at any frame rate), or, for
 *     HyperFrames, which seeks video itself, copies the clip;
 *   - decodes nothing in the server process: FFmpeg and ffprobe run as
 *     children without server secrets (D-086) and with time limits, and
 *     pictures are decoded by the engine's Chromium.
 *
 * The staged files are then served to the engine's browser from a per-render
 * origin: request interception for the html engine (no socket at all), a
 * random-token path on the Motion Canvas bundle server or on a loopback
 * server for Remotion, the composition folder for HyperFrames. Lookups are by
 * exact name in a map of the staged files, never by joining a request path.
 */

/** One use of an asset by a scene. */
export interface SceneAssetUse {
  asset: string;
  /** Video in-point in seconds. */
  start?: number;
  /** Media types allowed where it is used. Default: image or video. */
  mediaTypes?: readonly AssetMediaType[];
  /** For messages: where in the scene. */
  where: string;
}


type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];

/** Elements that would open an asset as a document (and run an SVG's scripts): no asset references there. */
const DOCUMENT_ELEMENTS = new Set(['iframe', 'frame', 'object', 'embed', 'link', 'script', 'portal', 'a', 'area', 'form', 'base', 'meta']);

function walk(n: Node, fn: (el: Element) => void): void {
  if (ta.isElementNode(n)) fn(n);
  for (const c of (n as DefaultTreeAdapterMap['parentNode']).childNodes ?? []) walk(c, fn);
  if (ta.isElementNode(n) && n.tagName === 'template') walk(ta.getTemplateContent(n as DefaultTreeAdapterMap['template']), fn);
}

function mediaStartOf(el: Element): number | undefined {
  const v = el.attrs.find((a) => a.name === 'data-media-start')?.value;
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseMarkup(html: string) {
  return /<html[\s>]/i.test(html) ? parse(html) : parseFragment(html);
}

/**
 * The `asset:` references in scene html/css, with the in-point of a video
 * element (`data-media-start`). Throws SceneMarkupError for references inside
 * elements that open documents (`<iframe>`, `<object>`, `<embed>`, `<a>`, ...)
 * and for malformed references.
 */
export function markupAssetUses(html: string | undefined, css: string | undefined): SceneAssetUse[] {
  const { refs, bad } = assetRefsInMarkup(html, css);
  if (bad.length) throw new SceneMarkupError(`"${bad[0]}" is not an asset reference: write asset:<id> with an id from the manifest's assets`);
  if (!refs.length) return [];
  const uses: SceneAssetUse[] = [];
  if (html) {
    walk(parseMarkup(html), (el) => {
      for (const a of el.attrs) {
        const found = assetRefsInMarkup(a.value, undefined).refs;
        if (!found.length) continue;
        if (DOCUMENT_ELEMENTS.has(el.tagName)) {
          throw new SceneMarkupError(`asset:${found[0]!.asset} in <${el.tagName}> is not allowed: show assets with <img>, <video>, <picture>/<source> or CSS url()`);
        }
        const start = el.tagName === 'video' || el.tagName === 'source' ? mediaStartOf(el.tagName === 'source' && el.parentNode && ta.isElementNode(el.parentNode) ? el.parentNode : el) : undefined;
        for (const r of found) uses.push({ asset: r.asset, ...(start ? { start } : {}), mediaTypes: ['image', 'video', 'font'], where: `html <${el.tagName} ${a.name}>` });
      }
      if (el.tagName === 'style') {
        const text = el.childNodes.filter(ta.isTextNode).map((t) => t.value).join('');
        for (const r of assetRefsInMarkup(undefined, text).refs) uses.push({ asset: r.asset, mediaTypes: ['image', 'video', 'font'], where: 'html <style>' });
      }
    });
  }
  for (const r of assetRefsInMarkup(undefined, css).refs) uses.push({ asset: r.asset, mediaTypes: ['image', 'video', 'font'], where: 'css' });
  return uses;
}

/** Every asset a scene uses: its template's media props, `asset:` references in its html/css, and `scene.assets`. */
export function sceneAssetUses(scene: RenderScene, template?: Pick<TemplateDefinition, 'mediaAssets'>): SceneAssetUse[] {
  const uses: SceneAssetUse[] = [];
  if (scene.template && template?.mediaAssets) {
    for (const r of template.mediaAssets(scene.props)) {
      uses.push({ asset: r.asset, ...(r.start ? { start: r.start } : {}), ...(r.mediaTypes ? { mediaTypes: r.mediaTypes } : {}), where: `props.${r.path.join('.')}` });
    }
  }
  uses.push(...markupAssetUses(scene.html, scene.css));
  for (const id of scene.assets ?? []) uses.push({ asset: id, mediaTypes: ['image', 'video', 'font', 'audio'], where: 'scene.assets' });
  return uses;
}

/** A file the asset origin may serve. */
export interface ServedFile {
  file: string;
  contentType: string;
}

export interface StagedAsset {
  key: string;
  id: string;
  mediaType: 'image' | 'video' | 'font';
  contentType: string;
  /** Served name (relative to the asset base URL). */
  name: string;
  file: string;
  width: number;
  height: number;
  /** Video staged as pictures: their names, for scene frames first, first+1, ... */
  frames?: { names: string[]; first: number };
}

/** A font face staged for a scene: `name` is its served name. */
export type StagedFontFace = Omit<FontFaceSpec, 'url'> & { name: string; source: 'project' | 'bundled'; asset?: string };

export interface StagedSceneAssets {
  dir: string;
  items: Map<string, StagedAsset>;
  /** Font faces of the families the scene names (#303): project font assets first, then the bundled set. */
  fonts: StagedFontFace[];
  /** The font faces with URLs under `base`. */
  fontFaces(base: string): FontFaceSpec[];
  /** Everything the asset origin serves, by exact name. */
  files: Map<string, ServedFile>;
  /** What templates get (`SceneMedia` by key), with URLs under `base`. */
  media(base: string): Record<string, SceneMedia>;
}

export interface StageOptions {
  uses: SceneAssetUse[];
  /** The project's assets (EngineRenderContext.assets). Nothing else can be staged. */
  assets: ReadonlyMap<string, ResolvedAsset>;
  /** Scratch directory for the staged copies (inside the scene's work directory). */
  dir: string;
  tools: Tools;
  output: { width: number; height: number; fps: FrameRate };
  /** Scene frames the render covers: a frame range's first frame and its length (whole scene: 0 and durationFrames). */
  frames: { first: number; count: number };
  /** `frames`: videos become one picture per output frame (default); `file`: the clip is copied (HyperFrames seeks it itself). */
  video?: 'frames' | 'file';
  /** Largest file accepted. Default 2 GiB. */
  maxBytes?: number;
  /**
   * Fonts (#303): the theme's font-family list and the scene's own html/css.
   * Every family named there that is a project font asset (by the family
   * name inside the file) or a bundled font is staged as @font-face faces.
   */
  fonts?: { family: string; markup?: string };
  signal?: AbortSignal;
  log?: Logger;
}

export const MEDIA_LIMITS = {
  /** Longest side of an image or video, px. */
  maxSide: 16384,
  /** Pixels of a still image (a decompression bomb guard), 100 MP. */
  maxPixels: 100_000_000,
  /** Longest side of a video, px. */
  maxVideoSide: 8192,
  /** Longest video, seconds. */
  maxVideoSeconds: 3 * 3600,
} as const;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

async function head(file: string, n = 512): Promise<Buffer> {
  const fh = await openFile(file, 'r');
  try {
    const b = Buffer.alloc(n);
    const { bytesRead } = await fh.read(b, 0, n, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Stage the assets a scene uses (see the module comment). Throws PipelineError naming the asset and where it is used. */
export async function stageSceneAssets(o: StageOptions): Promise<StagedSceneAssets> {
  const stage = 'assets';
  const items = new Map<string, StagedAsset>();
  const files = new Map<string, ServedFile>();
  const env = renderChildEnv();
  const maxBytes = o.maxBytes ?? 2 * 1024 ** 3;
  await mkdir(o.dir, { recursive: true });
  const vetted = new Map<string, { file: string; kind: 'image' | 'video' | 'font' | 'audio'; contentType: string }>();

  for (const use of o.uses) {
    const fail = (msg: string) => new PipelineError(stage, `asset "${use.asset}" (${use.where}): ${msg}`);
    const a = o.assets.get(use.asset);
    if (!a) throw fail("not one of this project's assets; a scene can only use assets listed in its own manifest");
    const allowed = use.mediaTypes ?? ['image', 'video'];
    if (!allowed.includes(a.mediaType)) throw fail(`is ${a.mediaType}; expected ${allowed.join(' or ')}`);
    if (a.mediaType === 'audio') continue; // sound is mixed by the media pipeline (audio.*), not drawn
    let v = vetted.get(a.id);
    if (!v) {
      const real = await realpath(a.file).catch(() => null);
      const st = real ? await stat(real) : null;
      if (!real || !st?.isFile()) throw fail('its file is missing');
      if (st.size === 0 || st.size > maxBytes) throw fail(`its file is ${st.size} bytes (allowed: 1 to ${maxBytes})`);
      const h = await head(real);
      const sniffed = sniffContentType(h);
      const contentType = sniffed?.contentType ?? (looksLikeSvg(h) ? 'image/svg+xml' : null);
      const kind = sniffed?.mediaType ?? (contentType ? 'image' : null);
      if (!contentType || !kind) throw fail('its bytes are not a supported image, video or font');
      if (kind !== a.mediaType) throw fail(`its bytes are ${kind} (${contentType}), but the manifest says ${a.mediaType}`);
      v = { file: real, kind, contentType };
      vetted.set(a.id, v);
    }
    const key = v.kind === 'video' ? mediaKey(a.id, use.start) : a.id;
    if (items.has(key)) continue;
    const ext = EXT[v.contentType] ?? v.contentType.split('/')[1] ?? 'bin';

    if (v.kind === 'font') {
      const name = `${a.id}.${ext}`;
      const file = join(o.dir, name);
      await copyFile(v.file, file);
      files.set(name, { file, contentType: v.contentType });
      items.set(key, { key, id: a.id, mediaType: 'font', contentType: v.contentType, name, file, width: 0, height: 0 });
      continue;
    }

    if (v.kind === 'image') {
      const name = `${a.id}.${ext}`;
      const file = join(o.dir, name);
      let size: { width: number; height: number };
      if (v.contentType === 'image/svg+xml') {
        let clean: Buffer;
        try {
          clean = sanitizeSvg(await readFile(v.file));
        } catch (e) {
          throw fail(e instanceof SvgError ? e.message : String(e));
        }
        await writeFile(file, clean);
        size = svgSize(clean);
      } else {
        await copyFile(v.file, file);
        const p = await probeMedia(o.tools.ffprobe, file, { env, ...(o.signal ? { signal: o.signal } : {}) }).catch((e: Error) => {
          throw fail(`could not be read as an image: ${e.message}`);
        });
        if (p.width > MEDIA_LIMITS.maxSide || p.height > MEDIA_LIMITS.maxSide || p.width * p.height > MEDIA_LIMITS.maxPixels) {
          throw fail(`is ${p.width}x${p.height}; images may be at most ${MEDIA_LIMITS.maxSide} px a side and ${MEDIA_LIMITS.maxPixels / 1e6} MP`);
        }
        size = { width: p.width, height: p.height };
      }
      files.set(name, { file, contentType: v.contentType });
      items.set(key, { key, id: a.id, mediaType: 'image', contentType: v.contentType, name, file, ...size });
      continue;
    }

    // Video.
    const p = await probeMedia(o.tools.ffprobe, v.file, { env, ...(o.signal ? { signal: o.signal } : {}) }).catch((e: Error) => {
      throw fail(`could not be read as a video: ${e.message}`);
    });
    if (p.width > MEDIA_LIMITS.maxVideoSide || p.height > MEDIA_LIMITS.maxVideoSide) throw fail(`is ${p.width}x${p.height}; videos may be at most ${MEDIA_LIMITS.maxVideoSide} px a side`);
    if (p.durationSeconds !== null && p.durationSeconds > MEDIA_LIMITS.maxVideoSeconds) throw fail(`is ${Math.round(p.durationSeconds)} s long; videos may be at most ${MEDIA_LIMITS.maxVideoSeconds} s`);
    if (use.start && p.durationSeconds !== null && use.start >= p.durationSeconds) throw fail(`starts at ${use.start} s, after the end of the clip (${p.durationSeconds.toFixed(2)} s)`);
    if (o.video === 'file') {
      const name = `${a.id}.${ext}`;
      const file = join(o.dir, name);
      if (!files.has(name)) await copyFile(v.file, file);
      files.set(name, { file, contentType: v.contentType });
      items.set(key, { key, id: a.id, mediaType: 'video', contentType: v.contentType, name, file, width: p.width, height: p.height });
      continue;
    }
    const sub = `v-${a.id}-${Math.round((use.start ?? 0) * 1000)}`;
    // Pictures as large as the frame's longer side times 1.5 (room to crop for `cover`), never larger than the clip.
    const side = Math.ceil(Math.max(o.output.width, o.output.height) * 1.5);
    const pics = await videoFramesAt({
      ffmpeg: o.tools.ffmpeg,
      input: v.file,
      dir: join(o.dir, sub),
      fps: o.output.fps,
      first: o.frames.first,
      count: o.frames.count,
      mediaStart: use.start ?? 0,
      sourceStart: p.startSeconds,
      maxWidth: side,
      maxHeight: side,
      env,
      ...(o.signal ? { signal: o.signal } : {}),
    }).catch((e: Error) => {
      throw fail(`could not be decoded: ${e.message}`);
    });
    const names = pics.map((f) => `${sub}/${f.slice(f.lastIndexOf('/') + 1)}`);
    names.forEach((n, i) => files.set(n, { file: pics[i]!, contentType: 'image/jpeg' }));
    const shown = await probeMedia(o.tools.ffprobe, pics[0]!, { env });
    items.set(key, { key, id: a.id, mediaType: 'video', contentType: 'image/jpeg', name: names[0]!, file: pics[0]!, width: shown.width, height: shown.height, frames: { names, first: o.frames.first } });
    o.log?.(`assets: ${a.id}${use.start ? ` from ${use.start}s` : ''}: ${pics.length} pictures of ${p.width}x${p.height} ${p.codec} at ${p.fps.toFixed(3)} fps`);
  }

  const fonts = o.fonts ? await stageFonts(o, files) : [];

  return {
    dir: o.dir,
    items,
    files,
    fonts,
    fontFaces: (base) => fonts.map(({ name, source: _s, asset: _a, ...f }) => ({ ...f, url: base + name })),
    media(base) {
      const out: Record<string, SceneMedia> = {};
      for (const [k, it] of items) {
        out[k] = {
          url: base + it.name,
          mediaType: it.mediaType,
          width: it.width,
          height: it.height,
          ...(it.frames ? { frames: { urls: it.frames.names.map((n) => base + n), first: it.frames.first } } : {}),
        };
      }
      return out;
    },
  };
}

const FONT_FORMAT: Record<string, FontFaceSpec['format']> = { 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'truetype', 'font/otf': 'opentype' };
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);

/** Stage the font faces of the families a scene names (see StageOptions.fonts). */
async function stageFonts(o: StageOptions, files: Map<string, ServedFile>): Promise<StagedFontFace[]> {
  const named = new Set(fontFamilies(o.fonts!.family).filter((f) => !GENERIC.has(f.toLowerCase())).map((f) => f.toLowerCase()));
  const markup = (o.fonts!.markup ?? '').toLowerCase();
  const wanted = (family: string) => named.has(family.toLowerCase()) || (markup !== '' && markup.includes(family.toLowerCase()));
  const out: StagedFontFace[] = [];
  const projectFamilies = new Set<string>();
  // Project fonts: every font asset of the project, registered under the family name inside the file.
  for (const a of o.assets.values()) {
    if (a.mediaType !== 'font') continue;
    const fail = (msg: string) => new PipelineError('assets', `font asset "${a.id}": ${msg}`);
    const real = await realpath(a.file).catch(() => null);
    const st = real ? await stat(real) : null;
    if (!real || !st?.isFile()) throw fail('its file is missing');
    const bytes = await readFile(real);
    const sniffed = sniffContentType(bytes);
    if (sniffed?.mediaType !== 'font') throw fail('its bytes are not a TTF, OTF, WOFF or WOFF2 font');
    let info;
    try {
      info = readFontInfo(bytes);
    } catch (e) {
      throw fail(e instanceof FontError ? e.message : String(e));
    }
    if (!wanted(info.family)) continue;
    projectFamilies.add(info.family.toLowerCase());
    const name = `fonts/${a.id}.${sniffed.ext}`;
    const file = join(o.dir, name);
    await mkdir(join(o.dir, 'fonts'), { recursive: true });
    await writeFile(file, bytes);
    files.set(name, { file, contentType: sniffed.contentType });
    out.push({ family: info.family, name, format: FONT_FORMAT[sniffed.contentType]!, ...fontFaceDescriptors(info), source: 'project', asset: a.id });
  }
  // Bundled fonts (a project font of the same family replaces them).
  for (const f of bundledFontFaces()) {
    if (!wanted(f.family) || projectFamilies.has(f.family.toLowerCase())) continue;
    const name = `fonts/bundled/${f.file.slice(f.file.lastIndexOf('/') + 1)}`;
    const file = join(o.dir, name);
    await mkdir(join(o.dir, 'fonts', 'bundled'), { recursive: true });
    await copyFile(f.file, file);
    files.set(name, { file, contentType: 'font/woff2' });
    out.push({ family: f.family, name, format: 'woff2', weight: f.weight, style: f.style, ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}), source: 'bundled' });
  }
  if (out.length) o.log?.(`assets: fonts ${[...new Set(out.map((f) => `${f.family} (${f.source})`))].join(', ')}: ${out.length} face(s)`);
  return out;
}

/** Headers for every asset response: exact type, no sniffing, no scripts (an SVG opened directly runs none), readable cross-origin (fonts). */
export function assetHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'",
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  };
}

/** A random path segment for one render's asset URLs. */
export function assetToken(): string {
  return randomBytes(16).toString('hex');
}

/** The staged file for a request path `/<token>/<name>`, or undefined. Exact lookup: no path is ever joined. */
export function lookupAsset(staged: Pick<StagedSceneAssets, 'files'>, token: string, pathname: string): ServedFile | undefined {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const prefix = `/${token}/`;
  if (!p.startsWith(prefix)) return undefined;
  return staged.files.get(p.slice(prefix.length));
}

export interface AssetServer {
  /** Base URL ending in "/": `http://127.0.0.1:<port>/<token>/`. */
  base: string;
  origin: string;
  /** Requests answered and refused (for logs and tests). */
  served: string[];
  refused: string[];
  close(): Promise<void>;
}

/** Serve staged files on 127.0.0.1 under a random token (engines whose browser this process does not control: Remotion). */
export async function startAssetServer(staged: Pick<StagedSceneAssets, 'files'>): Promise<AssetServer> {
  const token = assetToken();
  const served: string[] = [];
  const refused: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const hit = req.method === 'GET' || req.method === 'HEAD' ? lookupAsset(staged, token, path) : undefined;
    if (!hit) {
      if (refused.length < 50) refused.push(`${req.method} ${path.replace(token, '<token>').slice(0, 120)}`);
      res.writeHead(404, { 'Content-Length': '0', Connection: 'close' }).end();
      return;
    }
    if (served.length < 10_000) served.push(path.slice(token.length + 2));
    res.writeHead(200, assetHeaders(hit.contentType));
    if (req.method === 'HEAD') return void res.end();
    createReadStream(hit.file).on('error', () => res.destroy()).pipe(res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    base: `${origin}/${token}/`,
    origin,
    served,
    refused,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** What a `video` type selector also has to match once clips are pictures: same specificity as `video` (`:where` adds none). */
const VIDEO_AS_IMAGE = 'img:where([data-rf-video])';
/** `video` as a type selector: at the start or after a combinator, a comma or an opening parenthesis, not part of a longer name. */
const VIDEO_TYPE = /(^|[\s>+~(,|])video(?![\w-])/gi;

/**
 * CSS whose `video` type selectors also select the `<img data-rf-video>` a
 * clip becomes in the html engine (#448), so `video { object-fit: cover }`
 * keeps working: each selector that uses `video` as a type gets a copy with
 * `img:where([data-rf-video])` in its place, at the same specificity, and the
 * original stays for any real `<video>`. Only rule selectors change, in nested
 * blocks too (`@media`); at-rule preludes, declarations, comments and strings
 * are left as they are.
 */
export function videoSelectorsAsImages(css: string): string {
  let out = '';
  let segStart = 0;
  let i = 0;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
      out += css.slice(segStart, i);
      segStart = i;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    if (ch === '{') {
      const prelude = css.slice(segStart, i);
      out += prelude.trim().startsWith('@') ? prelude : videoSelectorList(prelude);
      out += '{';
      segStart = ++i;
      continue;
    }
    if (ch === '}' || ch === ';') {
      out += css.slice(segStart, i + 1);
      segStart = ++i;
      continue;
    }
    i++;
  }
  return out + css.slice(segStart);
}

/** Index just past the string that starts at `i` (backslash escapes kept). */
function skipString(s: string, i: number): number {
  const q = s[i];
  for (let k = i + 1; k < s.length; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === q) return k + 1;
  }
  return s.length;
}

function videoSelectorList(list: string): string {
  // Split at top-level commas (not inside parentheses, brackets or strings).
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < list.length; k++) {
    const c = list[k]!;
    if (c === '"' || c === "'") k = skipString(list, k) - 1;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(list.slice(from, k));
      from = k + 1;
    }
  }
  parts.push(list.slice(from));
  return parts
    .map((part) => {
      // Strings and attribute selectors never hold a type selector: mask them while matching.
      const kept: string[] = [];
      const masked = part.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[^\]]*\]/g, (m) => `\u0000${kept.push(m) - 1}\u0000`);
      const swapped = masked.replace(VIDEO_TYPE, (_, before: string) => `${before}${VIDEO_AS_IMAGE}`);
      if (swapped === masked) return part;
      const restore = (s: string) => s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => kept[Number(n)]!);
      const trailing = /\s*$/.exec(part)![0];
      return `${part.slice(0, part.length - trailing.length)}, ${restore(swapped).trim()}${trailing}`;
    })
    .join(',');
}

/**
 * Scene html with its `asset:` references replaced (html engine). With
 * `videoAsImage`, a `<video>` that shows a staged clip becomes an `<img>`
 * marked `data-rf-video="<key>"` (its other attributes kept), whose picture
 * the renderer sets for every frame; the scene's `<style>` rules for `video`
 * then select that `<img>` too (#448).
 */
export function rewriteSceneHtml(html: string, url: (key: string) => string | undefined, opts: { videoAsImage?: boolean; isVideo?: (key: string) => boolean } = {}): string {
  if (!assetRefsInMarkup(html, undefined).refs.length) return html;
  const doc = parseMarkup(html);
  const isVideo = opts.isVideo ?? (() => false);
  const styles: Array<{ value: string }> = [];
  let swapped = false;
  walk(doc, (el) => {
    const start = el.tagName === 'video' ? mediaStartOf(el) : undefined;
    let videoKey: string | undefined;
    for (const a of el.attrs) {
      a.value = rewriteAssetRefs(a.value, (id) => {
        const key = isVideo(mediaKey(id, start)) ? mediaKey(id, start) : id;
        if (a.name === 'src' && isVideo(key)) videoKey = key;
        return url(key);
      });
    }
    if (el.tagName === 'style') {
      for (const t of el.childNodes.filter(ta.isTextNode)) {
        t.value = rewriteAssetRefs(t.value, (id) => url(id));
        styles.push(t);
      }
    }
    if (videoKey && opts.videoAsImage) {
      swapped = true;
      el.tagName = 'img';
      el.nodeName = 'img';
      el.childNodes = [];
      el.attrs = [...el.attrs.filter((a) => !['autoplay', 'loop', 'muted', 'controls', 'playsinline', 'preload', 'poster', 'data-media-start', 'data-rf-video'].includes(a.name)), { name: 'data-rf-video', value: videoKey }];
    }
  });
  // A <style> may come before the clip it styles, so its rules change once the walk knows a clip was swapped.
  if (swapped) for (const t of styles) t.value = videoSelectorsAsImages(t.value);
  return serialize(doc);
}
