/**
 * Media fit (#299): where an image or video lands in its box. No
 * dependencies, so the Remotion and Motion Canvas browser bundles import it
 * (`@reelforge/project-schema/media`, hashed into their cache keys).
 *
 * The layouts work (#287) adds the same `FitMode` / `fitMedia` to layout.ts.
 * This file is the minimal version for asset rendering; when #287 lands, its
 * definitions replace these (same names and signature) and this file goes.
 */

export interface MediaBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How media fills its box: `contain` letterboxes, `cover` crops, `blur-fill` letterboxes over a blurred, cropped copy of itself. */
export type FitMode = 'contain' | 'cover' | 'blur-fill';
export const FIT_MODES = ['contain', 'cover', 'blur-fill'] as const satisfies readonly FitMode[];

export interface FitResult {
  /** Where the picture is drawn (may extend past the box for `cover`; clip to the box). */
  fg: MediaBox;
  /** `blur-fill` only: the blurred copy, covering the box. */
  bg: MediaBox | null;
}

/**
 * Where media of `mediaWidth` x `mediaHeight` lands in `box` for a fit mode.
 * `focus` (0-100 per axis, default centre) is the point kept in view when
 * `cover` crops, the same as CSS `object-position` in percent.
 */
export function fitMedia(box: MediaBox, mediaWidth: number, mediaHeight: number, mode: FitMode, focus: { x: number; y: number } = { x: 50, y: 50 }): FitResult {
  const place = (scale: number): MediaBox => {
    const w = mediaWidth * scale;
    const h = mediaHeight * scale;
    return { x: box.x + (box.width - w) * (focus.x / 100), y: box.y + (box.height - h) * (focus.y / 100), width: w, height: h };
  };
  const contain = Math.min(box.width / mediaWidth, box.height / mediaHeight);
  const cover = Math.max(box.width / mediaWidth, box.height / mediaHeight);
  if (mode === 'cover') return { fg: place(cover), bg: null };
  return { fg: place(contain), bg: mode === 'blur-fill' ? place(cover) : null };
}

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
