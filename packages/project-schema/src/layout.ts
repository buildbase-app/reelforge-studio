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
 * line), or from `data-rf-fit-tol` (a fraction of the font size) for blocks
 * of several lines, such as a layout pane's text card. Animations are switched off while measuring. Runs as an
 * inline script (hyperframes) or through the renderer (html); returns how many
 * elements it shrank.
 */
export const FIT_TEXT_SCRIPT = `(()=>{const els=[...document.querySelectorAll('[data-rf-fit]')];if(!els.length)return 0;const st=document.createElement('style');st.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.appendChild(st);let n=0;for(const el of els){const max=parseFloat(getComputedStyle(el).fontSize);const min=Math.min(max,parseFloat(el.getAttribute('data-rf-fit-min')||'')||max*.4);const tol=parseFloat(el.getAttribute('data-rf-fit-tol')||'.25');const fits=()=>el.scrollHeight<=el.clientHeight+Math.max(1,parseFloat(el.style.fontSize||String(max))*tol)&&el.scrollWidth<=el.clientWidth+1;if(fits())continue;let lo=min,hi=max;for(let i=0;i<14;i++){const mid=(lo+hi)/2;el.style.fontSize=mid+'px';if(fits())lo=mid;else hi=mid}el.style.fontSize=(Math.floor(lo*10)/10)+'px';n++}st.remove();return n})()`;

/* ------------------------------------------------------------------------- *
 * Layout primitives (#287): split screen, picture-in-picture, grid, lower
 * thirds and media fit modes. Every size and position is in layout units
 * (`unit`, 1 % of the shorter side) or relative to the safe areas above, so a
 * layout reflows for each output size and variant instead of being cropped.
 * Pure geometry, the same numbers in every engine; the manifest schema for
 * these props is in layouts.ts.
 * ------------------------------------------------------------------------- */

/** How media fills its box: `contain` letterboxes, `cover` crops, `blur-fill` letterboxes over a blurred, cropped copy of itself. */
export type FitMode = 'contain' | 'cover' | 'blur-fill';
export const FIT_MODES = ['contain', 'cover', 'blur-fill'] as const satisfies readonly FitMode[];

/** Which safe area a layout keeps inside: `none` is the whole frame (media full bleed). */
export type LayoutInset = 'none' | 'action' | 'title' | 'content';
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
/** `horizontal`: panes side by side; `vertical`: stacked; `auto`: side by side on 4:3 and wider, stacked otherwise. */
export type SplitDirection = 'auto' | 'horizontal' | 'vertical';

export type LayoutSpec =
  | { type: 'full'; inset?: LayoutInset }
  | { type: 'split'; direction?: SplitDirection; ratios?: readonly number[]; gap?: number; inset?: LayoutInset }
  | { type: 'grid'; columns?: number; rows?: number; gap?: number; inset?: LayoutInset }
  | { type: 'pip'; corner?: Corner; width?: number; aspect?: number; margin?: number; inset?: LayoutInset };

/** Defaults of the layout primitives, in units unless said otherwise. */
export const LAYOUT_DEFAULTS = {
  splitGap: 0.6,
  gridGap: 1,
  /** Picture-in-picture: width of the inset in units, its margin from the content safe area in units. */
  pipWidth: 36,
  pipMargin: 2,
  /** At the default width, an inset is no taller than this share of the safe box. */
  pipMaxShare: 0.45,
  /** Padding between a pane's edge and its text. */
  panePadding: 3,
  /** Blur radius of the `blur-fill` background, in units. */
  blur: 3,
  maxPanes: 16,
  maxSplitPanes: 4,
  maxGridSide: 4,
} as const;

export interface PaneBox extends Rect {
  index: number;
  /** `inset` is the picture-in-picture window; `main` the picture behind it. */
  role: 'pane' | 'main' | 'inset';
  /**
   * Where text in this pane may go: the pane, less its padding, inside the
   * content safe area. When a pane lies wholly in a tall frame's app-overlay
   * zone (a bottom grid row on 9:16), the title-safe area is used instead and
   * `textSafe` says so.
   */
  text: Rect;
  textSafe: 'content' | 'title';
}

export interface LayoutResult {
  frame: FrameLayout;
  /** The area the panes share (the frame, or a safe area). */
  area: Rect;
  panes: PaneBox[];
  /** Gap between panes in px. */
  gap: number;
}

const insetsOf = (l: FrameLayout, inset: LayoutInset): Insets =>
  inset === 'none' ? { top: 0, right: 0, bottom: 0, left: 0 } : inset === 'action' ? l.safe.action : inset === 'title' ? l.safe.title : l.safe.content;

function areaOf(l: FrameLayout, inset: LayoutInset): Rect {
  const i = insetsOf(l, inset);
  return { x: i.left, y: i.top, width: l.width - i.left - i.right, height: l.height - i.top - i.bottom };
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

const shrink = (r: Rect, by: number): Rect => ({ x: r.x + by, y: r.y + by, width: Math.max(0, r.width - 2 * by), height: Math.max(0, r.height - 2 * by) });

/** Split a length into parts by weight, with gaps, on whole pixels (neighbours share edges exactly). */
function partition(start: number, length: number, weights: readonly number[], gap: number): Array<[number, number]> {
  const n = weights.length;
  const usable = Math.max(0, length - gap * (n - 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const out: Array<[number, number]> = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const from = Math.round(start + acc + gap * i);
    acc += (usable * weights[i]!) / total;
    const to = Math.round(start + acc + gap * i);
    out.push([from, to - from]);
  }
  return out;
}

/** Columns and rows for `n` grid cells when not given: the split whose cells are closest to square. */
export function autoGrid(n: number, aspect: number): { columns: number; rows: number } {
  let best = { columns: n, rows: 1, score: Infinity };
  for (let columns = 1; columns <= Math.min(n, LAYOUT_DEFAULTS.maxGridSide); columns++) {
    const rows = Math.ceil(n / columns);
    if (rows > LAYOUT_DEFAULTS.maxGridSide) continue;
    const cell = (aspect * rows) / columns;
    // Closest to square, then the fewest empty cells.
    const score = Math.abs(Math.log(cell)) + (columns * rows - n) * 0.5;
    if (score < best.score) best = { columns, rows, score };
  }
  return { columns: best.columns, rows: best.rows };
}

function paneText(l: FrameLayout, r: Rect): Pick<PaneBox, 'text' | 'textSafe'> {
  const padded = shrink(r, LAYOUT_DEFAULTS.panePadding * l.unit);
  const minSide = 12 * l.unit;
  const inContent = intersect(padded, l.box);
  if (inContent && inContent.width >= minSide && inContent.height >= minSide * 0.6) return { text: inContent, textSafe: 'content' };
  const title = areaOf(l, 'title');
  return { text: intersect(padded, title) ?? padded, textSafe: 'title' };
}

/** Width / height of the picture-in-picture inset from its `aspect`, defaulting to the frame's. */
export function pipInset(l: FrameLayout, spec: Extract<LayoutSpec, { type: 'pip' }>): Rect {
  const d = LAYOUT_DEFAULTS;
  const safe = areaOf(l, spec.inset ?? 'content');
  const margin = (spec.margin ?? d.pipMargin) * l.unit;
  const aspect = spec.aspect ?? l.aspect;
  let w = (spec.width ?? d.pipWidth) * l.unit;
  let h = w / aspect;
  // Always inside the safe box; at the default width also no taller than a share of it (a tall inset on a tall frame).
  const maxW = Math.max(1, safe.width - 2 * margin);
  const maxH = Math.max(1, (safe.height - 2 * margin) * (spec.width === undefined ? d.pipMaxShare : 1));
  const k = Math.min(1, maxW / w, maxH / h);
  w *= k;
  h *= k;
  const corner = spec.corner ?? 'bottom-right';
  const x0 = corner.endsWith('left') ? safe.x + margin : safe.x + safe.width - margin - w;
  const y0 = corner.startsWith('top') ? safe.y + margin : safe.y + safe.height - margin - h;
  // Round the edges, not the size, so the inset keeps its exact distance from the safe area.
  const x = Math.round(x0);
  const y = Math.round(y0);
  return { x, y, width: Math.round(x0 + w) - x, height: Math.round(y0 + h) - y };
}

/**
 * Pane rectangles (px) of a layout at a frame size. `paneCount` is how many
 * panes the scene has: 1 for `full`, 2 to 4 for `split`, 2 for `pip`
 * (main, then inset), up to 16 for `grid`. Throws on a count the layout
 * cannot hold (the manifest schema rejects those first).
 */
export function layoutPanes(l: FrameLayout, spec: LayoutSpec, paneCount: number): LayoutResult {
  const d = LAYOUT_DEFAULTS;
  const area = areaOf(l, spec.type === 'pip' ? 'none' : (spec.inset ?? 'none'));
  const make = (r: Rect, index: number, role: PaneBox['role']): PaneBox => ({ ...r, index, role, ...paneText(l, r) });
  switch (spec.type) {
    case 'full': {
      if (paneCount !== 1) throw new Error(`a full layout has 1 pane, got ${paneCount}`);
      return { frame: l, area, gap: 0, panes: [make(area, 0, 'pane')] };
    }
    case 'split': {
      if (paneCount < 2 || paneCount > d.maxSplitPanes) throw new Error(`a split has 2 to ${d.maxSplitPanes} panes, got ${paneCount}`);
      const ratios = spec.ratios ?? Array.from({ length: paneCount }, () => 1);
      if (ratios.length !== paneCount) throw new Error(`a split with ${paneCount} panes needs ${paneCount} ratios, got ${ratios.length}`);
      const gap = (spec.gap ?? d.splitGap) * l.unit;
      const dir = spec.direction ?? 'auto';
      const side = dir === 'horizontal' || (dir === 'auto' && l.direction === 'row');
      const parts = partition(side ? area.x : area.y, side ? area.width : area.height, ratios, gap);
      return {
        frame: l,
        area,
        gap,
        panes: parts.map(([from, len], i) =>
          make(side ? { x: from, y: area.y, width: len, height: area.height } : { x: area.x, y: from, width: area.width, height: len }, i, 'pane')
        ),
      };
    }
    case 'grid': {
      if (paneCount < 1 || paneCount > d.maxPanes) throw new Error(`a grid has 1 to ${d.maxPanes} panes, got ${paneCount}`);
      const auto = autoGrid(paneCount, area.width / area.height);
      const columns = spec.columns ?? (spec.rows ? Math.ceil(paneCount / spec.rows) : auto.columns);
      const rows = spec.rows ?? Math.ceil(paneCount / columns);
      if (columns * rows < paneCount) throw new Error(`a ${columns}x${rows} grid holds ${columns * rows} panes, got ${paneCount}`);
      const gap = (spec.gap ?? d.gridGap) * l.unit;
      const cols = partition(area.x, area.width, Array.from({ length: columns }, () => 1), gap);
      const rws = partition(area.y, area.height, Array.from({ length: rows }, () => 1), gap);
      const panes: PaneBox[] = [];
      for (let i = 0; i < paneCount; i++) {
        const [x, width] = cols[i % columns]!;
        const [y, height] = rws[Math.floor(i / columns)]!;
        panes.push(make({ x, y, width, height }, i, 'pane'));
      }
      return { frame: l, area, gap, panes };
    }
    case 'pip': {
      if (paneCount !== 2) throw new Error(`picture-in-picture has 2 panes (main, inset), got ${paneCount}`);
      return { frame: l, area, gap: 0, panes: [make(area, 0, 'main'), make(pipInset(l, spec), 1, 'inset')] };
    }
  }
}

/**
 * Keep pane text clear of a lower third: every text box that shares columns
 * with the lower third's band (its maximum width, `lowerThirdBox().height`
 * tall, plus a gap of 2 units) ends above that band. When less than 8 units
 * would be left above it (the bottom pane of a stacked split on 9:16), the
 * text goes below the band instead, inside the pane and the title-safe area
 * (`textSafe: 'title'`). If neither fits, the box keeps its size (more text
 * than the frame can hold; the overflow tests show it).
 */
export function clearOfLowerThird(r: LayoutResult, lt: LowerThirdBox): LayoutResult {
  const l = r.frame;
  const u = l.unit;
  const x0 = lt.align === 'left' ? lt.x : lt.x - lt.maxWidth;
  const x1 = x0 + lt.maxWidth;
  const top = lt.bottom - lt.height - 2 * u;
  const below = lt.bottom + 2 * u;
  const titleBottom = l.height - l.safe.title.bottom;
  const panes = r.panes.map((p): PaneBox => {
    const t = p.text;
    if (t.x >= x1 || t.x + t.width <= x0 || t.y + t.height <= top || t.y >= lt.bottom + 2 * u) return p;
    if (top - t.y >= 8 * u) return { ...p, text: { ...t, height: top - t.y } };
    const end = Math.min(p.y + p.height - LAYOUT_DEFAULTS.panePadding * u, titleBottom);
    const y = Math.max(below, t.y);
    if (end - y >= 8 * u) return { ...p, text: { ...t, y, height: end - y }, textSafe: 'title' };
    return p;
  });
  return { ...r, panes };
}

export interface LowerThirdBox {
  /** Left (align left) or right (align right) edge, and the bottom edge, in px. */
  x: number;
  bottom: number;
  align: 'left' | 'right';
  /** Widest and tallest the block may be (its text shrinks to fit). */
  maxWidth: number;
  height: number;
  /** Font sizes, padding and accent bar width in px. */
  nameSize: number;
  titleSize: number;
  padding: number;
  bar: number;
}

/** Where a lower third sits: the bottom corner of the content safe area, sized in units. */
export function lowerThirdBox(l: FrameLayout, align: 'left' | 'right' = 'left'): LowerThirdBox {
  const u = l.unit;
  return {
    x: align === 'left' ? l.box.x : l.box.x + l.box.width,
    bottom: l.box.y + l.box.height,
    align,
    maxWidth: Math.min(l.box.width, 110 * u),
    // One line of name and two of title at full size.
    height: 22 * u,
    nameSize: 6 * u,
    titleSize: 4.2 * u,
    padding: 2.4 * u,
    bar: 1 * u,
  };
}

export interface FitResult {
  /** Where the picture is drawn (may extend past the box for `cover`; clip to the box). */
  fg: Rect;
  /** `blur-fill` only: the blurred copy, covering the box. */
  bg: Rect | null;
}

/**
 * Where media of `mediaWidth` x `mediaHeight` lands in `box` for a fit mode.
 * `focus` (0-100 per axis, default centre) is the point kept in view when
 * `cover` crops, the same as CSS `object-position` in percent.
 */
export function fitMedia(box: Rect, mediaWidth: number, mediaHeight: number, mode: FitMode, focus: { x: number; y: number } = { x: 50, y: 50 }): FitResult {
  const place = (scale: number): Rect => {
    const w = mediaWidth * scale;
    const h = mediaHeight * scale;
    return { x: box.x + (box.width - w) * (focus.x / 100), y: box.y + (box.height - h) * (focus.y / 100), width: w, height: h };
  };
  const contain = Math.min(box.width / mediaWidth, box.height / mediaHeight);
  const cover = Math.max(box.width / mediaWidth, box.height / mediaHeight);
  if (mode === 'cover') return { fg: place(cover), bg: null };
  return { fg: place(contain), bg: mode === 'blur-fill' ? place(cover) : null };
}

/**
 * Type, spacing and motion of the layout templates, shared by the DOM builder
 * (layout-dom.ts: html, HyperFrames, Remotion) and the Motion Canvas layout
 * scene, so every engine draws the same cards, labels and lower third with the
 * same timing. Sizes are in layout units unless they say `Em` (a share of the
 * element's own font size); times are seconds; easings are CSS cubic-bezier
 * control points.
 */
export const LAYOUT_STYLE = {
  /**
   * Fit-to-box tolerance of a pane's text card, in em. The card has no
   * padding of its own on a plain pane, so glyphs that stick out of its tight
   * line boxes (line height 1.08, about 0.07 em) count as overflow in the DOM
   * and the card would shrink to its minimum even when it has room. A hidden
   * line is at least 0.75 em, so it still counts. (The lower third's text has
   * padding around it and keeps a tolerance of 0.)
   */
  fitInk: 0.1,
  /** Gap between a pane's label and its text card. */
  textGap: 1.6,
  label: { size: 3.4, weight: 600, lineHeight: 1.2, padYEm: 0.2, padXEm: 0.42, radiusEm: 0.18 },
  /** The card's font size is its headline's; the body is `bodyEm` of it. The card shrinks to fit, to `minShare` of `size` at least. */
  card: { size: 7.2, minShare: 0.36, maxWidth: 95, headlineLineHeight: 1.08, letterSpacingEm: -0.01, bodyEm: 0.58, bodyLineHeight: 1.32, bodyGapEm: 0.34, padYEm: 0.28, padXEm: 0.36, radiusEm: 0.11 },
  inset: { radius: 1.4, outline: 0.4 },
  /** `blur-fill`: the blurred copy is darkened and enlarged so its soft edge stays outside the pane. */
  blurFill: { brightness: 0.62, scale: 1.12 },
  lowerThird: { radius: 0.8, nameLineHeight: 1.12, titleLineHeight: 1.3, titleOpacity: 0.78, titleGapEm: 0.1, padYShare: 0.8, minShare: 0.45 },
  motion: {
    /** Pane text rises `rise` units and fades in. */
    label: { delay: 0, duration: 0.5, ease: [0, 0, 0.58, 1], rise: 2.5 },
    card: { delay: 0.1, duration: 0.6, ease: [0.2, 0.8, 0.2, 1], rise: 2.5 },
    /** The picture-in-picture inset scales up from `from` and fades in. */
    inset: { delay: 0.15, duration: 0.55, ease: [0.2, 0.8, 0.2, 1], from: 0.94 },
    /** The lower third slides `slide` units in from its side, and fades out `lead` seconds before the end. */
    lowerThirdIn: { delay: 0.25, duration: 0.5, ease: [0.2, 0.8, 0.2, 1], slide: 4 },
    lowerThirdOut: { lead: 0.45, duration: 0.4, ease: [0.42, 0, 1, 1] },
  },
} as const;

/** A CSS `cubic-bezier(x1, y1, x2, y2)` timing function (for engines that animate without CSS). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const a = (p1: number, p2: number) => 1 - 3 * p2 + 3 * p1;
  const b = (p1: number, p2: number) => 3 * p2 - 6 * p1;
  const c = (p1: number) => 3 * p1;
  const at = (t: number, p1: number, p2: number) => ((a(p1, p2) * t + b(p1, p2)) * t + c(p1)) * t;
  const slope = (t: number, p1: number, p2: number) => 3 * a(p1, p2) * t * t + 2 * b(p1, p2) * t + c(p1);
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton steps, then bisection if the slope is too flat.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = at(t, x1, x2) - x;
      if (Math.abs(d) < 1e-7) return at(t, y1, y2);
      const s = slope(t, x1, x2);
      if (Math.abs(s) < 1e-6) break;
      t -= d / s;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = at(t, x1, x2);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return at(t, y1, y2);
  };
}

/** Progress (0-1) of a CSS-style animation with fill `both` at time `t`. */
export function animationProgress(t: number, a: { delay: number; duration: number; ease: readonly number[] }): number {
  const [x1, y1, x2, y2] = a.ease as readonly [number, number, number, number];
  return cubicBezier(x1, y1, x2, y2)((t - a.delay) / a.duration);
}
