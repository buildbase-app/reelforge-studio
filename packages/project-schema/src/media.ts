/**
 * Media for templates (#299): staged-asset descriptions, logo boxes and the
 * background layers of DOM templates. No dependencies, so the Remotion and
 * Motion Canvas browser bundles import it (`@renderweld/project-schema/media`,
 * hashed into their cache keys). Fit modes and `fitMedia` live in layout.ts
 * (#287) and are re-exported here so existing imports keep working.
 */

import { FIT_MODES, fitMedia, type FitMode, type FitResult, type Rect } from './layout';

export { FIT_MODES, fitMedia, type FitMode, type FitResult };

export type MediaBox = Rect;

/** Blur radius of the `blur-fill` background as a share of the shorter frame side (3 layout units). */
export const BLUR_FILL_RADIUS = 0.03;

/** What a template is told about one staged asset (no file paths: a URL on the render's own origin). */
export interface SceneMedia {
  url: string;
  mediaType: 'image' | 'video' | 'font';
  /** Pixel size as displayed (rotation applied); 0 for fonts. */
  width: number;
  height: number;
  /**
   * Video: the pictures of the clip for this scene, one per frame. Picture i
   * is for scene frame `first + i`; `url` is the first one.
   */
  frames?: { urls: string[]; first: number };
}

/** The key a staged asset use goes by: the asset id, plus `@<start>` for a video with an in-point. */
export function mediaKey(asset: string, start?: number): string {
  return start ? `${asset}@${start}` : asset;
}

/** The picture a video shows at scene frame `frame` (clamped to the pictures there are), or the image's URL. */
export function mediaUrlAt(m: SceneMedia, frame: number): string {
  if (!m.frames) return m.url;
  const i = Math.min(m.frames.urls.length - 1, Math.max(0, Math.round(frame) - m.frames.first));
  return m.frames.urls[i]!;
}

/** Corner of the content safe area a logo sits in. */
export type LogoCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** The square box a logo is fitted into (`contain`): `size` units wide, in a corner of `safe`. */
export function logoBox(safe: MediaBox, unit: number, corner: LogoCorner, size: number): MediaBox {
  const s = size * unit;
  const x = corner.endsWith('left') ? safe.x : safe.x + safe.width - s;
  const y = corner.startsWith('top') ? safe.y : safe.y + safe.height - s;
  return { x, y, width: s, height: s };
}

/** A background layer for DOM templates (html, hyperframes). */
export interface DomMediaLayer {
  url: string;
  fit: FitMode;
  focus?: { x: number; y: number };
  dim: number;
  /** `img` (pictures; the html engine swaps them per frame for video), or `video` (HyperFrames seeks it). */
  tag: 'img' | 'video';
  /** html engine: the staged video's key, set as data-rf-video. */
  videoKey?: string;
  /** HyperFrames video: the in-point, seconds. */
  start?: number;
}

export interface DomLogo {
  url: string;
  corner: LogoCorner;
  size: number;
}

const attr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Background media (fit mode, dimmed by the theme background) and a logo in a
 * corner of the content safe area, as html + css for DOM templates. `under`
 * goes first inside the template's full-frame wrapper, `over` last. Sizes use
 * the layout CSS variables (--rf-unit, --rf-safe-*).
 */
export function mediaLayersHtml(bg: DomMediaLayer | undefined, logo: DomLogo | undefined): { under: string; over: string; css: string } {
  let under = '';
  let over = '';
  let css = '';
  if (bg) {
    const pos = `${bg.focus?.x ?? 50}% ${bg.focus?.y ?? 50}%`;
    const el = (cls: string, fit: 'cover' | 'contain') =>
      bg.tag === 'video'
        ? `<video class="${cls}" src="${attr(bg.url)}" muted playsinline data-start="0"${bg.start ? ` data-media-start="${bg.start}"` : ''} style="object-fit:${fit};object-position:${pos}"></video>`
        : `<img class="${cls}" src="${attr(bg.url)}" alt=""${bg.videoKey ? ` data-rf-video="${attr(bg.videoKey)}"` : ''} style="object-fit:${fit};object-position:${pos}">`;
    under =
      '<div class="rf-media">' +
      (bg.fit === 'blur-fill' ? el('rf-media-bg', 'cover') + el('rf-media-fg', 'contain') : el('rf-media-fg', bg.fit)) +
      (bg.dim > 0 ? `<div class="rf-dim" style="opacity:${bg.dim}"></div>` : '') +
      '</div>';
    css +=
      '.rf-media{position:absolute;inset:0;overflow:hidden;z-index:0}' +
      '.rf-media>img,.rf-media>video{position:absolute;inset:0;width:100%;height:100%;display:block}' +
      '.rf-media-bg{filter:blur(calc(var(--rf-unit)*3));transform:scale(1.08)}' +
      '.rf-dim{position:absolute;inset:0;background:var(--rf-bg)}';
  }
  if (logo) {
    const [v, h] = logo.corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
    over = `<img class="rf-logo" src="${attr(logo.url)}" alt="" style="${v}:var(--rf-safe-${v});${h}:var(--rf-safe-${h});width:calc(var(--rf-unit)*${logo.size});height:calc(var(--rf-unit)*${logo.size});object-position:${h} ${v}">`;
    css += '.rf-logo{position:absolute;object-fit:contain;z-index:2}';
  }
  return { under, over, css };
}

/** One @font-face (#303): a project font asset or a bundled font, on the render's asset origin. */
export interface FontFaceSpec {
  family: string;
  url: string;
  format: 'woff2' | 'woff' | 'truetype' | 'opentype';
  /** A weight or a range ("100 900" for a variable font). */
  weight: string;
  style: 'normal' | 'italic';
  /** Width range of a variable font ("75% 125%"). */
  stretch?: string;
  unicodeRange?: string;
}

/** Longest a render waits for its fonts before failing (shorter than any scene timeout). */
export const FONT_LOAD_TIMEOUT_MS = 15_000;

/** The family names in a CSS font-family list, unquoted ("Brand Sans", Inter, sans-serif -> [Brand Sans, Inter, sans-serif]). */
export function fontFamilies(list: string): string[] {
  return list
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

const cssString = (s: string) => `"${s.replace(/["\\\n]/g, '')}"`;

/** @font-face rules for DOM engines. */
export function fontFaceCss(faces: readonly FontFaceSpec[]): string {
  return faces
    .map(
      (f) =>
        `@font-face{font-family:${cssString(f.family)};src:url(${cssString(f.url)}) format("${f.format}");font-weight:${f.weight};font-style:${f.style};` +
        `${f.stretch ? `font-stretch:${f.stretch};` : ''}${f.unicodeRange ? `unicode-range:${f.unicodeRange};` : ''}font-display:block}`
    )
    .join('');
}

/**
 * Canvas engines (Remotion measures text with canvas, Motion Canvas draws
 * with it): add every face with the FontFace API and wait until all have
 * loaded, or fail naming the ones that did not, at most `timeoutMs`. Browser
 * only.
 */
export async function loadFontFaces(faces: readonly FontFaceSpec[], timeoutMs = FONT_LOAD_TIMEOUT_MS): Promise<void> {
  if (!faces.length) return;
  const g = globalThis as unknown as {
    FontFace: new (family: string, source: string, d: Record<string, string>) => { load(): Promise<unknown>; family: string };
    document: { fonts: { add(f: unknown): void } };
  };
  const failed: string[] = [];
  const loads = faces.map((f) => {
    const face = new g.FontFace(f.family, `url(${cssString(f.url)}) format("${f.format}")`, {
      weight: f.weight,
      style: f.style,
      ...(f.stretch ? { stretch: f.stretch } : {}),
      ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
    });
    g.document.fonts.add(face);
    return face.load().catch(() => failed.push(`${f.family} (${f.url.slice(f.url.lastIndexOf('/') + 1)})`));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs)));
  const r = await Promise.race([Promise.all(loads), timeout]);
  clearTimeout(timer);
  if (r === 'timeout') throw new Error(`fonts did not load within ${timeoutMs} ms`);
  if (failed.length) throw new Error(`font(s) did not load: ${failed.join(', ')}`);
}
