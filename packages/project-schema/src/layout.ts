/**
 * Layout for any output size (#287): one unit, safe areas and fit-to-box text,
 * shared by every engine and built-in template.
 *
 * This module has no dependencies (no zod, no Node APIs) so the browser
 * bundles of the Remotion compositions and Motion Canvas scenes import it as
 * `@reelforge/project-schema/layout`. Engines hash this file into their bundle
 * cache key, so a change here rebuilds them.
 *
 * Units: `unit` is 1 % of the SHORTER side (`min(width, height) / 100`), so a
 * headline is the same size in pixels at 1080x1920, 1080x1080 and 1920x1080 and
 * never grows with the long side of a wide frame.
 *
 * Safe areas (all values are insets in pixels from each edge):
 * - action safe: 93 % of width and height (3.5 % per side),
 * - title safe: 90 % of width and height (5 % per side),
 *   both from EBU R 95 "Safe areas for 16:9 television production" and
 *   ITU-R BT.1848 (graphics/title safe 90 %, action safe 93 %);
 * - ui: the zone that social apps cover with their own buttons, captions and
 *   progress bars on tall video (height / width >= 1.6, e.g. 9:16): 14 % top,
 *   35 % bottom, 6 % each side. These are CONSERVATIVE values; platforms differ
 *   and change their UI, so they are a margin that clears the common overlays,
 *   not any platform's published specification;
 * - content: per side, the larger of title safe and ui. Built-in templates keep
 *   all text inside it.
 */

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SafeAreas {
  width: number;
  height: number;
  /** 93 % action safe (EBU R 95, ITU-R BT.1848). */
  action: Insets;
  /** 90 % title safe (EBU R 95, ITU-R BT.1848). */
  title: Insets;
  /** Social-app overlay zone for tall video, or null (conservative; platforms differ). */
  ui: Insets | null;
  /** Where templates keep text: per side, the larger of `title` and `ui`. */
  content: Insets;
}

/** Fractions behind the safe areas (documented in docs/FORMATS.md). */
export const SAFE_AREA_SPEC = {
  action: 0.035,
  title: 0.05,
  ui: { top: 0.14, bottom: 0.35, sides: 0.06, minHeightOverWidth: 1.6 },
} as const;

/** `platform` values that mean "no app UI on top of the video" (no ui zone even when tall). */
export const NO_UI_PLATFORMS = ['none', 'broadcast', 'web', 'presentation'] as const;

const insets = (w: number, h: number, x: number, top: number, bottom = top): Insets => ({
  top: Math.round(h * top),
  right: Math.round(w * x),
  bottom: Math.round(h * bottom),
  left: Math.round(w * x),
});

/**
 * Safe-area insets for a frame. `platform` is the manifest's `brief.platform`
 * (e.g. "tiktok", "instagram-reels", "youtube"): tall frames get the
 * conservative ui zone unless the platform is one of NO_UI_PLATFORMS.
 */
export function safeAreaInsets(width: number, height: number, platform?: string | null): SafeAreas {
  const s = SAFE_AREA_SPEC;
  const action = insets(width, height, s.action, s.action);
  const title = insets(width, height, s.title, s.title);
  const tall = height / width >= s.ui.minHeightOverWidth;
  const noUi = platform ? (NO_UI_PLATFORMS as readonly string[]).includes(platform.toLowerCase()) : false;
  const ui = tall && !noUi ? insets(width, height, s.ui.sides, s.ui.top, s.ui.bottom) : null;
  const content: Insets = ui
    ? {
        top: Math.max(title.top, ui.top),
        right: Math.max(title.right, ui.right),
        bottom: Math.max(title.bottom, ui.bottom),
        left: Math.max(title.left, ui.left),
      }
    : title;
  return { width, height, action, title, ui, content };
}

export type Orientation = 'portrait' | 'square' | 'landscape';

export interface FrameLayout {
  width: number;
  height: number;
  /** 1 % of the shorter side, in px. Every size in a template is a multiple of it. */
  unit: number;
  /** width / height. */
  aspect: number;
  /** portrait below 0.9, landscape above 1.1, square between. */
  orientation: Orientation;
  /** How a template arranges two groups (title + body): side by side from 1.3 (4:3 and wider), stacked below. */
  direction: 'row' | 'column';
  safe: SafeAreas;
  /** The content box (frame minus `safe.content`). */
  box: Rect;
  /** Type scale in px (multiples of `unit`). `display` is the largest headline size; `displayMin` the smallest fit-to-box may use. */
  type: { display: number; displayMin: number; title: number; body: number; caption: number; label: number };
}

/** The layout every built-in template starts from. */
export function frameLayout(width: number, height: number, platform?: string | null): FrameLayout {
  const unit = Math.min(width, height) / 100;
  const aspect = width / height;
  const safe = safeAreaInsets(width, height, platform);
  const c = safe.content;
  return {
    width,
    height,
    unit,
    aspect,
    orientation: aspect < 0.9 ? 'portrait' : aspect > 1.1 ? 'landscape' : 'square',
    direction: aspect >= 1.3 ? 'row' : 'column',
    safe,
    box: { x: c.left, y: c.top, width: width - c.left - c.right, height: height - c.top - c.bottom },
    type: {
      display: 10.5 * unit,
      displayMin: 4.5 * unit,
      title: 9.5 * unit,
      body: 5.6 * unit,
      caption: 4.8 * unit,
      label: 4 * unit,
    },
  };
}

/**
 * The layout as CSS custom properties for DOM engines (html, hyperframes):
 * --rf-unit (1 % of the shorter side), --rf-unit-w / --rf-unit-h (1 % of the
 * width / height), --rf-safe-{top,right,bottom,left} (content insets),
 * --rf-title-safe-* and --rf-action-safe-*, --rf-content-w / --rf-content-h.
 */
export function layoutCssVars(width: number, height: number, platform?: string | null): string {
  const l = frameLayout(width, height, platform);
  const px = (n: number) => `${Math.round(n * 100) / 100}px`;
  const sides = (name: string, i: Insets) =>
    `--rf-${name}-top:${px(i.top)};--rf-${name}-right:${px(i.right)};--rf-${name}-bottom:${px(i.bottom)};--rf-${name}-left:${px(i.left)};`;
  return (
    `--rf-unit:${px(l.unit)};--rf-unit-w:${px(width / 100)};--rf-unit-h:${px(height / 100)};` +
    sides('safe', l.safe.content) +
    sides('title-safe', l.safe.title) +
    sides('action-safe', l.safe.action) +
    `--rf-content-w:${px(l.box.width)};--rf-content-h:${px(l.box.height)}`
  );
}

export interface FitTextOptions {
  text: string;
  /** Width of a string at font size 1 px (measure at 100 px and divide). */
  measure: (s: string) => number;
  maxWidth: number;
  maxHeight: number;
  min: number;
  max: number;
  /** Line height in em. */
  lineHeight: number;
  /** Extra space between words in em (0 for a normal space measured by `measure(' ')`). */
  wordGapEm?: number;
}

export interface FitTextResult {
  fontSize: number;
  lines: string[];
  /** False when even `min` does not fit (the text then overflows; tests fail on it). */
  fits: boolean;
}

/** Greedy word wrap at a font size. Returns null when a single word is wider than maxWidth. */
export function wrapWords(words: string[], size: number, o: Pick<FitTextOptions, 'measure' | 'maxWidth' | 'wordGapEm'>): string[] | null {
  const gap = o.wordGapEm === undefined ? o.measure(' ') * size : o.wordGapEm * size;
  const lines: string[] = [];
  let line = '';
  let lineWidth = 0;
  for (const word of words) {
    const w = o.measure(word) * size;
    if (w > o.maxWidth) return null;
    if (line && lineWidth + gap + w <= o.maxWidth) {
      line += ' ' + word;
      lineWidth += gap + w;
    } else {
      if (line) lines.push(line);
      line = word;
      lineWidth = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** The largest font size in [min, max] at which `text` fits the box (whole px, binary search). */
export function fitText(o: FitTextOptions): FitTextResult {
  const words = o.text.split(/\s+/).filter(Boolean);
  const attempt = (size: number) => {
    const lines = wrapWords(words, size, o);
    return lines && lines.length * size * o.lineHeight <= o.maxHeight ? lines : null;
  };
  const max = Math.max(1, Math.floor(o.max));
  const min = Math.max(1, Math.min(max, Math.floor(o.min)));
  const best = attempt(max);
  if (best) return { fontSize: max, lines: best, fits: true };
  let lo = min;
  let hi = max;
  let lines = attempt(min);
  if (!lines) return { fontSize: min, lines: wrapWords(words, min, { ...o, maxWidth: Infinity }) ?? [o.text], fits: false };
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const l = attempt(mid);
    if (l) {
      lo = mid;
      lines = l;
    } else hi = mid;
  }
  return { fontSize: lo, lines, fits: true };
}

/**
 * Fit-to-box for DOM engines (html, hyperframes): shrinks the font size of
 * every element with `data-rf-fit` until its content fits its own box (width,
 * and `max-height` when set), never below `data-rf-fit-min` (px, default 40 %
 * of the CSS size). Height overflow counts from a quarter of a line (glyphs of
 * tight line heights stick out a little; a line that does not fit is a whole
 * line). Animations are switched off while measuring. Runs as an
 * inline script (hyperframes) or through the renderer (html); returns how many
 * elements it shrank.
 */
export const FIT_TEXT_SCRIPT = `(()=>{const els=[...document.querySelectorAll('[data-rf-fit]')];if(!els.length)return 0;const st=document.createElement('style');st.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.appendChild(st);let n=0;for(const el of els){const max=parseFloat(getComputedStyle(el).fontSize);const min=Math.min(max,parseFloat(el.getAttribute('data-rf-fit-min')||'')||max*.4);const fits=()=>el.scrollHeight<=el.clientHeight+Math.max(1,parseFloat(el.style.fontSize||String(max))*.25)&&el.scrollWidth<=el.clientWidth+1;if(fits())continue;let lo=min,hi=max;for(let i=0;i<14;i++){const mid=(lo+hi)/2;el.style.fontSize=mid+'px';if(fits())lo=mid;else hi=mid}el.style.fontSize=(Math.floor(lo*10)/10)+'px';n++}st.remove();return n})()`;
