/**
 * Text overflow check for DOM engines (#294, #386): text must be fully in the frame or fully out of it, and fully
 * inside its own box. The renderer runs TEXT_SAMPLE_SCRIPT in the page at a few frames a second while it renders
 * (the page is already laid out at that frame, so a sample costs one DOM walk), and textRunTracker joins what the
 * samples find into runs: one element breaking one rule over consecutive samples. HyperFrames scenes get the same
 * samples from HyperFrames' own layout audit, run at the same times after the render (engine-hyperframes). The render pipeline reports the
 * runs that last long enough (render.qa.textSeconds) as `video.text`; an entrance or exit that slides text across the
 * frame edge is over in well under a second and never reported.
 */

/**
 * - `text.frame`: a word is partly inside and partly outside the frame (cut by the frame edge).
 * - `text.clip`: a word is partly hidden by a box that clips its content (`overflow: hidden`), so it shows cut.
 * - `text.box`: the text runs out of its own box (wider or taller than it), into whatever is next to it, or hidden.
 */
export type TextOverflowRule = 'text.frame' | 'text.clip' | 'text.box';

/** One element breaking one rule at one sampled frame, as TEXT_SAMPLE_SCRIPT returns it. */
export interface TextSample {
  rule: TextOverflowRule;
  /** The element, the same number at every sample of one page. */
  key: number;
  /** The element's text, whitespace collapsed, at most 80 characters. */
  text: string;
  /** The element's box in frame pixels, rounded: x, y, width, height. */
  box: [number, number, number, number];
}

/** One element breaking one rule over consecutive samples of a clip. Frames count from the clip's first frame. */
export interface TextOverflowRun {
  rule: TextOverflowRule;
  text: string;
  box: { x: number; y: number; width: number; height: number };
  /** The first sample that found it. */
  startFrame: number;
  /**
   * Exclusive: the last sample that found it plus one sample interval, at most the clip's frames. The run's real
   * length is known to within a sample interval (under 0.25 s), and this is the middle of what it can be.
   */
  endFrame: number;
}

/** What the check found in one clip: how many frames it sampled, and the runs. */
export interface ClipTextCheck {
  samples: number;
  /** Frames between samples. */
  step: number;
  runs: TextOverflowRun[];
}

/** At least this many samples a second (#386). */
export const TEXT_SAMPLES_PER_SECOND = 4;

/** Frames between text samples at `fps`: at least TEXT_SAMPLES_PER_SECOND a second. */
export function textSampleStep(fps: number): number {
  return Math.max(1, Math.floor(fps / TEXT_SAMPLES_PER_SECOND));
}

/**
 * The page side of the check: an expression that returns TextSample[] for the frame on screen. Words are measured
 * with Range client rects (transforms included); a word counts when its element is shown (no `visibility: hidden`,
 * opacity above 0.05 counting every ancestor). Tolerances are those of the fit-to-box script and the formats test:
 * 1 px across, a quarter of the font size down (glyphs of tight line heights stick out a little). Words wholly out of
 * the frame, or wholly hidden by a clipping box, are not text on screen and break no rule. Elements inside
 * `data-rf-decoration`, `data-layout-ignore` or `data-layout-allow-overflow` (HyperFrames' marks for text that is
 * meant to run off) are left out.
 */
export const TEXT_SAMPLE_SCRIPT = String.raw`(() => {
  const W = innerWidth, H = innerHeight;
  const ids = window.__rfTextIds || (window.__rfTextIds = new WeakMap());
  const keyOf = (el) => {
    let k = ids.get(el);
    if (k === undefined) { k = window.__rfTextNext = (window.__rfTextNext || 0) + 1; ids.set(el, k); }
    return k;
  };
  const styles = new Map();
  const style = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
  const opacities = new Map();
  const opacity = (el) => {
    if (!el || el.nodeType !== 1) return 1;
    let o = opacities.get(el);
    if (o === undefined) { o = parseFloat(style(el).opacity || '1') * opacity(el.parentElement); opacities.set(el, o); }
    return o;
  };
  const clips = new Map();
  const clipOf = (el) => {
    if (!el || el.nodeType !== 1 || el === document.documentElement || el === document.body) return null;
    if (clips.has(el)) return clips.get(el);
    const up = clipOf(el.parentElement);
    const s = style(el);
    let c = up;
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
      const r = el.getBoundingClientRect();
      const own = { l: s.overflowX !== 'visible' ? r.left : -Infinity, r: s.overflowX !== 'visible' ? r.right : Infinity, t: s.overflowY !== 'visible' ? r.top : -Infinity, b: s.overflowY !== 'visible' ? r.bottom : Infinity };
      c = up ? { l: Math.max(up.l, own.l), r: Math.min(up.r, own.r), t: Math.max(up.t, own.t), b: Math.min(up.b, own.b) } : own;
    }
    clips.set(el, c);
    return c;
  };
  const SKIP = '[data-rf-decoration],[data-layout-ignore],[data-layout-allow-overflow],script,style,noscript,template,title';
  const found = new Map();
  const add = (rule, el) => {
    const id = rule + ':' + keyOf(el);
    if (found.has(id)) return;
    const r = el.getBoundingClientRect();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    found.set(id, { rule, key: keyOf(el), text, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  };
  const boxes = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = node.data;
    if (!/\S/.test(data)) continue;
    const el = node.parentElement;
    if (!el || el.closest(SKIP)) continue;
    const s = style(el);
    if (s.visibility !== 'visible' || opacity(el) <= 0.05) continue;
    const fs = parseFloat(s.fontSize) || 16;
    const tx = 1, ty = fs * 0.25;
    const clip = clipOf(el);
    let shown = false;
    // What can show of the word: the frame, narrowed by every box above it that clips (#rf-root is the frame itself).
    const v = clip ? { l: Math.max(0, clip.l), r: Math.min(W, clip.r), t: Math.max(0, clip.t), b: Math.min(H, clip.b) } : { l: 0, r: W, t: 0, b: H };
    for (const m of data.matchAll(/\S+/g)) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const r = range.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right <= v.l + tx || r.left >= v.r - tx || r.bottom <= v.t + ty || r.top >= v.b - ty) continue;
      shown = true;
      const cut = { l: r.left < v.l - tx, r: r.right > v.r + tx, t: r.top < v.t - ty, b: r.bottom > v.b + ty };
      if (!cut.l && !cut.r && !cut.t && !cut.b) continue;
      // Cut where the frame's own edge is: the frame rule; anywhere else, a box that clips.
      const atFrame = (!cut.l || v.l <= 0.5) && (!cut.r || v.r >= W - 0.5) && (!cut.t || v.t <= 0.5) && (!cut.b || v.b >= H - 0.5);
      add(atFrame ? 'text.frame' : 'text.clip', el);
    }
    if (!shown) continue;
    let box = el;
    while (box && box !== document.body && (style(box).display === 'inline' || style(box).display === 'contents')) box = box.parentElement;
    if (!box || box === document.body || boxes.has(box) || box.closest(SKIP)) continue;
    boxes.add(box);
    if (!(box instanceof HTMLElement) || box.clientWidth === 0) continue;
    const bfs = parseFloat(style(box).fontSize) || fs;
    const tol = parseFloat(box.getAttribute('data-rf-fit-tol') || '.25');
    if (box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + Math.max(1, bfs * tol)) add('text.box', box);
  }
  return [...found.values()];
})()`;

/**
 * Joins samples into runs. `add` takes the samples of one frame, frames in increasing order; `finish` closes what is
 * still open and returns every run, in the order they started.
 */
export function textRunTracker(opts: { frames: number; step: number }) {
  const open = new Map<string, { run: TextOverflowRun; last: number }>();
  const done: TextOverflowRun[] = [];
  const close = (id: string) => {
    const o = open.get(id)!;
    o.run.endFrame = Math.min(opts.frames, o.last + opts.step);
    done.push(o.run);
    open.delete(id);
  };
  let samples = 0;
  return {
    add(frame: number, found: readonly TextSample[]): void {
      samples++;
      const seen = new Set<string>();
      for (const s of found) {
        const id = `${s.rule}:${s.key}`;
        seen.add(id);
        const o = open.get(id);
        if (o) o.last = frame;
        else open.set(id, { run: { rule: s.rule, text: s.text, box: { x: s.box[0], y: s.box[1], width: s.box[2], height: s.box[3] }, startFrame: frame, endFrame: frame }, last: frame });
      }
      for (const id of [...open.keys()]) if (!seen.has(id)) close(id);
    },
    finish(): ClipTextCheck {
      for (const id of [...open.keys()]) close(id);
      return { samples, step: opts.step, runs: done.sort((a, b) => a.startFrame - b.startFrame) };
    },
  };
}
