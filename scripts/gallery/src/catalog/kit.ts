/**
 * Building blocks for the agent-authored HTML and HyperFrames scenes of the
 * showcase gallery: palettes, backgrounds, text reveals, counters and scene
 * transitions. Everything is plain HTML/CSS (plus inline JS for HyperFrames),
 * deterministic, with no network and no external fonts: text uses the font
 * stacks below, which fall back to fonts the release image ships.
 *
 * Every scene is designed for 1080x1920 (the gallery output) and keeps its
 * key content between y=240 and y=1520, clear of the platform UI of Reels,
 * Shorts and TikTok.
 */

export const W = 1080;
export const H = 1920;

export const SANS = '"Inter Display", Inter, "Noto Sans", "DejaVu Sans", Arial, sans-serif';
export const MONO = '"JetBrains Mono", "DejaVu Sans Mono", "Liberation Mono", monospace';
export const SERIF = '"DejaVu Serif", "Noto Serif", Georgia, serif';

/** Expo-out: fast start, long soft landing. The one house easing (no overshoot). */
export const EASE = 'cubic-bezier(.16,1,.3,1)';
export const EASE_IN_OUT = 'cubic-bezier(.76,0,.24,1)';
/** Alias kept for readability: overshoot is not used (unslop: no bouncy springs). */
export const EASE_BACK = EASE;

export type Engine = 'remotion' | 'motion-canvas' | 'html' | 'hyperframes';

export interface Palette {
  id: string;
  name: string;
  /** Built-in theme the palette sits on. */
  base: 'default' | 'midnight';
  /** When true the reel uses the built-in theme as is (no inline tokens). */
  pure?: boolean;
  colors: { background: string; surface: string; text: string; mutedText: string; accent: string; accent2: string };
  /** A third colour only HTML/HyperFrames scenes use (charts, highlights). */
  accent3: string;
  fontFamily?: string;
  headingWeight?: number;
  /** Light background: text is dark. */
  light?: boolean;
}

export type Transition = 'none' | 'wipe' | 'push' | 'zoom' | 'fade' | 'iris';

export interface SceneCtx {
  engine: 'html' | 'hyperframes';
  /** Scene length in seconds. */
  dur: number;
  pal: Palette;
  /** Transition at the start of this scene (matches the previous scene's out). */
  tin: Transition;
  /** Transition at the end of this scene. */
  tout: Transition;
  /** Deterministic variety (background placement etc.). */
  seed: number;
}

export interface SceneSource {
  html: string;
  css: string;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Seconds with 3 decimals, for CSS. */
export function s(n: number): string {
  return `${Math.max(0, Math.round(n * 1000) / 1000)}s`;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Theme value for the manifest: the built-in id, or inline tokens on top of it. */
export function themeFor(p: Palette): string | { base: string; tokens: Record<string, unknown> } {
  if (p.pure) return p.base;
  return {
    base: p.base,
    tokens: {
      colors: p.colors,
      fontFamily: p.fontFamily ?? SANS,
      headingWeight: p.headingWeight ?? 800,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Backgrounds                                                          */
/* ------------------------------------------------------------------ */

export type Backdrop = 'plain' | 'grid' | 'split' | 'accent';

/**
 * Backdrops are quiet on purpose (unslop): a flat tinted neutral, a hairline
 * grid, a two-tone split or a flat accent field. No blobs, washes or glows;
 * the colour lives in the scene's one bright element.
 */
export function backdrop(kind: Backdrop, ctx: SceneCtx): SceneSource {
  const base = `.bd{position:absolute;inset:0;overflow:hidden;background:var(--rf-bg)}`;
  switch (kind) {
    case 'grid':
      return {
        html: `<div class="bd"><div class="bd-grid"></div></div>`,
        css:
          base +
          `.bd-grid{position:absolute;inset:0;background-image:linear-gradient(color-mix(in srgb,var(--rf-text) 6%,transparent) 2px,transparent 2px),linear-gradient(90deg,color-mix(in srgb,var(--rf-text) 6%,transparent) 2px,transparent 2px);background-size:108px 108px;background-position:-2px -2px}`,
      };
    case 'split':
      return {
        html: `<div class="bd"><div class="bd-split"></div></div>`,
        css: base + `.bd-split{position:absolute;left:0;right:0;bottom:0;height:${ctx.seed % 2 ? 38 : 44}%;background:var(--rf-surface)}`,
      };
    case 'accent':
      return { html: `<div class="bd bd-acc"></div>`, css: base + `.bd-acc{background:var(--rf-accent)}` };
    default:
      return { html: `<div class="bd"></div>`, css: base };
  }
}

/* ------------------------------------------------------------------ */
/* Text                                                                 */
/* ------------------------------------------------------------------ */

/**
 * A headline whose lines rise out of a mask, word by word. `lines` are already
 * broken by the author (short lines read better on a phone).
 */
export function maskLines(lines: string[], at: number, cls = 'mk', stagger = 0.075): string {
  let i = 0;
  return lines
    .map(
      (line) =>
        `<span class="${cls}-l">` +
        line
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => {
            const delay = at + i++ * stagger;
            return `<span class="${cls}-w"><span style="animation-delay:${s(delay)}">${esc(w)}</span></span>`;
          })
          .join(' ') +
        '</span>'
    )
    .join('');
}

export function maskCss(cls = 'mk', dur = 0.9): string {
  return `.${cls}-l{display:block}.${cls}-w{display:inline-block;overflow:hidden;vertical-align:top;padding:0 .02em .08em;margin-bottom:-.08em}
.${cls}-w>span{display:inline-block;animation:${cls}-up ${dur}s ${EASE} both}
@keyframes ${cls}-up{from{transform:translateY(105%)}to{transform:none}}`;
}

/** Letters that pop in one by one (kinetic type). */
export function letters(text: string, at: number, stagger = 0.03, cls = 'lt'): string {
  let i = 0;
  const words = text.split(' ').map((word) =>
    [...word]
      .map((ch) => `<span class="${cls}" style="animation-delay:${s(at + i++ * stagger)}">${esc(ch)}</span>`)
      .join('')
  );
  if (words.length === 1) return words[0]!;
  // Several words: keep each word's letters together so a line never breaks inside a word.
  return words.map((w) => `<span style="display:inline-block;white-space:nowrap">${w}</span>`).join(' ');
}

export function lettersCss(cls = 'lt', dur = 0.6): string {
  return `.${cls}{display:inline-block;animation:${cls}-pop ${dur}s ${EASE} both}
@keyframes ${cls}-pop{from{opacity:0;transform:translateY(.35em)}to{opacity:1;transform:none}}`;
}

/** Fade-and-rise for any element: add class "rise" and an inline animation-delay. */
export const riseCss = `.rise{animation:k-rise .8s ${EASE} both}@keyframes k-rise{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:none}}
.pop{animation:k-pop .7s ${EASE} both}@keyframes k-pop{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}
.slide-l{animation:k-sl .8s ${EASE} both}@keyframes k-sl{from{opacity:0;transform:translateX(-80px)}to{opacity:1;transform:none}}
.slide-r{animation:k-sr .8s ${EASE} both}@keyframes k-sr{from{opacity:0;transform:translateX(80px)}to{opacity:1;transform:none}}
.fade{animation:k-fade .8s ease-out both}@keyframes k-fade{from{opacity:0}to{opacity:1}}`;

export function d(at: number): string {
  return `style="animation-delay:${s(at)}"`;
}

/* ------------------------------------------------------------------ */
/* Counters                                                             */
/* ------------------------------------------------------------------ */

/** Counter ids are numbered across one catalog build (resetCounters() starts a build). */
let counterId = 0;
export function resetCounters(): void {
  counterId = 0;
}

/**
 * A number that counts up from `from` to `to` between `at` and `at + len`.
 * html engine: a registered CSS custom property drives a CSS counter (the
 * engine seeks every CSS animation per frame). hyperframes: the CSS property
 * trick is not seeked there, so a tiny inline script updates the text on each
 * seek (see hfCounterScript).
 */
export function counter(ctx: SceneCtx, to: number, at: number, len = 1.6, from = 0, pad = 0): { html: string; css: string } {
  const id = `n${counterId++ % 1000}`;
  if (ctx.engine === 'hyperframes') {
    return {
      html: `<span class="cnt" data-from="${from}" data-to="${to}" data-at="${at}" data-len="${len}" data-pad="${pad}">${String(from).padStart(pad, '0')}</span>`,
      css: '',
    };
  }
  const style = pad >= 2 ? 'decimal-leading-zero' : 'decimal';
  return {
    html: `<span class="cnt ${id}"></span>`,
    css: `@property --${id}{syntax:'<integer>';inherits:false;initial-value:${from}}
.${id}{counter-reset:${id} var(--${id});animation:${id}-c ${s(len)} ${EASE} ${s(at)} both}
.${id}::after{content:counter(${id},${style})}
@keyframes ${id}-c{from{--${id}:${from}}to{--${id}:${to}}}`,
  };
}

/** Inline script for hyperframes scenes: counters plus optional canvas drawing, both seeked by the runtime. */
export function hfScript(draw?: string): string {
  return `<script>(function(){
var E=function(x){return 1-Math.pow(2,-10*Math.min(1,Math.max(0,x)))};
var cnts=[].slice.call(document.querySelectorAll('.cnt'));
${draw ?? 'var draw=function(){};'}
function seek(t){cnts.forEach(function(c){var a=+c.dataset.at,l=+c.dataset.len,f=+c.dataset.from,o=+c.dataset.to,p=+c.dataset.pad;var v=Math.round(f+(o-f)*E((t-a)/l));c.textContent=String(v).padStart(p,'0')});draw(t)}
seek(0);
window.__hfAnime=(window.__hfAnime||[]).concat([{seek:function(ms){seek(ms/1000)},pause:function(){},play:function(){}}]);
})();</script>`;
}

/* ------------------------------------------------------------------ */
/* Transitions                                                          */
/* ------------------------------------------------------------------ */

const T_IN = 0.55;
const T_OUT = 0.5;

/**
 * Scene-level transitions. Scenes are cut back to back (manifest v0.2), so a
 * transition is two halves: the end of one scene and the start of the next
 * draw the same thing (an accent panel, a zoom through the background), and
 * the cut lands where both halves meet.
 */
export function transitions(ctx: SceneCtx): { html: string; css: string; stageAnim: string[] } {
  const out = ctx.dur - T_OUT;
  let html = '';
  let css = '';
  const stageAnim: string[] = [];
  if (ctx.tin === 'wipe') {
    html += '<div class="tx tx-in"></div>';
    css += `.tx-in{transform:translateY(0);animation:tx-in ${T_IN}s ${EASE_IN_OUT} both}@keyframes tx-in{to{transform:translateY(-101%)}}`;
    stageAnim.push(`st-rise ${s(0.8)} ${EASE} both`);
  } else if (ctx.tin === 'push') {
    stageAnim.push(`st-pushin ${T_IN}s ${EASE_IN_OUT} both`);
  } else if (ctx.tin === 'zoom') {
    stageAnim.push(`st-zoomin ${s(0.7)} ${EASE} both`);
  } else if (ctx.tin === 'fade') {
    stageAnim.push(`st-fadein ${s(0.5)} ease-out both`);
  } else if (ctx.tin === 'iris') {
    html += '<div class="tx tx-iris-in"></div>';
    css += `.tx.tx-iris-in{inset:auto;background:transparent;box-shadow:0 0 0 2400px var(--rf-surface);border-radius:50%;left:50%;top:50%;width:0;height:0;animation:tx-iris-in ${T_IN}s ${EASE_IN_OUT} both}@keyframes tx-iris-in{to{width:2400px;height:2400px;left:calc(50% - 1200px);top:calc(50% - 1200px)}}`;
  }
  if (ctx.tout === 'wipe') {
    html += '<div class="tx tx-out"></div>';
    css += `.tx-out{transform:translateY(101%);animation:tx-out ${T_OUT}s ${EASE_IN_OUT} ${s(out)} both}@keyframes tx-out{to{transform:translateY(0)}}`;
  } else if (ctx.tout === 'push') {
    stageAnim.push(`st-pushout ${T_OUT}s ${EASE_IN_OUT} ${s(out)} both`);
  } else if (ctx.tout === 'zoom') {
    stageAnim.push(`st-zoomout ${T_OUT}s cubic-bezier(.7,0,.84,0) ${s(out)} both`);
  } else if (ctx.tout === 'fade') {
    stageAnim.push(`st-fadeout ${T_OUT}s ease-in ${s(out)} both`);
  } else if (ctx.tout === 'iris') {
    html += '<div class="tx tx-iris-out"></div>';
    css += `.tx.tx-iris-out{inset:auto;background:transparent;box-shadow:0 0 0 2400px var(--rf-surface);border-radius:50%;width:2400px;height:2400px;left:calc(50% - 1200px);top:calc(50% - 1200px);animation:tx-iris-out ${T_OUT}s ${EASE_IN_OUT} ${s(out)} both;opacity:0}@keyframes tx-iris-out{from{opacity:1}to{opacity:1;width:0;height:0;left:50%;top:50%}}`;
  }
  // The base .tx rule comes first so the iris variants can override it.
  css = `.tx{position:absolute;inset:0;background:var(--rf-surface);z-index:50}` + css;
  css += `@keyframes st-rise{from{transform:translateY(120px)}to{transform:none}}
@keyframes st-pushin{from{transform:translateX(100%)}to{transform:none}}
@keyframes st-pushout{to{transform:translateX(-100%)}}
@keyframes st-zoomin{from{transform:scale(.92);opacity:0}to{transform:none;opacity:1}}
@keyframes st-zoomout{to{transform:scale(1.08);opacity:0}}
@keyframes st-fadein{from{opacity:0}to{opacity:1}}
@keyframes st-fadeout{to{opacity:0}}`;
  return { html, css, stageAnim };
}

/* ------------------------------------------------------------------ */
/* Scene shell                                                          */
/* ------------------------------------------------------------------ */

/**
 * Wraps a design in the backdrop, a slow camera push (so every frame moves),
 * the transitions and, for hyperframes, the clip element and seek script.
 */
export function shell(ctx: SceneCtx, design: SceneSource & { backdrop?: Backdrop; script?: string; push?: boolean }): SceneSource {
  const bd = backdrop(design.backdrop ?? 'plain', ctx);
  const tx = transitions(ctx);
  const camera = design.push === false ? [] : [`st-cam ${s(ctx.dur)} linear both`];
  // Two nested wrappers so the transition and camera transforms compose.
  const css =
    `#rf-root,.hf-root{--x3:${ctx.pal.accent3};font-family:var(--rf-font);color:var(--rf-text)}` +
    `.stage{position:absolute;inset:0;${tx.stageAnim.length ? `animation:${tx.stageAnim.join(',')};` : ''}}` +
    `.cam{position:absolute;inset:0;${camera.length ? `animation:${camera.join(',')};` : ''}}` +
    `@keyframes st-cam{from{transform:scale(1)}to{transform:scale(1.02)}}` +
    bd.css +
    tx.css +
    riseCss +
    design.css;
  const inner = `${bd.html}<div class="stage"><div class="cam">${design.html}</div></div>${tx.html}`;
  if (ctx.engine === 'hyperframes') {
    return {
      html:
        `<div class="clip hf-root" data-start="0" data-duration="${ctx.dur}" style="position:absolute;inset:0;overflow:hidden">` +
        `<style>${css}</style>${inner}${hfScript(design.script)}</div>`,
      css: '',
    };
  }
  return { html: inner, css };
}

/* ------------------------------------------------------------------ */
/* Shared UI atoms                                                      */
/* ------------------------------------------------------------------ */

export function eyebrow(text: string, at: number): string {
  return `<div class="eb rise" ${d(at)}>${esc(text)}</div>`;
}

export const eyebrowCss = `.eb{display:inline-block;font:500 32px/1.2 ${MONO};color:var(--rf-muted)}`;

/** Simple geometric icons drawn as SVG (no icon fonts, no external files). */
export function icon(name: string, size = 64, stroke = 'currentColor'): string {
  const p: Record<string, string> = {
    check: '<path d="M6 17l7 7L26 9"/>',
    cross: '<path d="M8 8l16 16M24 8L8 24"/>',
    bolt: '<path d="M18 3L6 18h9l-1 11 12-16h-9z"/>',
    clock: '<circle cx="16" cy="16" r="12"/><path d="M16 9v7l5 3"/>',
    star: '<path d="M16 4l3.6 7.6 8.4 1-6.2 5.8 1.6 8.3L16 22.6 8.6 26.7l1.6-8.3L4 12.6l8.4-1z"/>',
    heart: '<path d="M16 27S4 19.5 4 11.5A6.5 6.5 0 0116 8a6.5 6.5 0 0112 3.5C28 19.5 16 27 16 27z"/>',
    pin: '<path d="M16 29s9-8.5 9-15a9 9 0 00-18 0c0 6.5 9 15 9 15z"/><circle cx="16" cy="14" r="3.5"/>',
    bed: '<path d="M3 24V9M3 18h26v6M29 18v-3a4 4 0 00-4-4H14v7"/><circle cx="8.5" cy="14" r="2.5"/>',
    bath: '<path d="M4 16h24v3a7 7 0 01-7 7H11a7 7 0 01-7-7zM8 16V7a3 3 0 016 0"/>',
    area: '<path d="M5 5h22v22H5zM5 12h7v-7M27 20h-7v7"/>',
    play: '<path d="M10 6l16 10-16 10z"/>',
    code: '<path d="M11 9l-7 7 7 7M21 9l7 7-7 7"/>',
    chart: '<path d="M5 27V5M5 27h22M10 21l5-6 4 3 7-9"/>',
    lock: '<rect x="6" y="14" width="20" height="14" rx="3"/><path d="M10 14V10a6 6 0 0112 0v4"/>',
    globe: '<circle cx="16" cy="16" r="12"/><path d="M4 16h24M16 4c4 4 4 20 0 24M16 4c-4 4-4 20 0 24"/>',
    spark: '<path d="M16 3v8M16 21v8M3 16h8M21 16h8M7 7l5 5M20 20l5 5M25 7l-5 5M12 20l-5 5"/>',
    cal: '<rect x="4" y="6" width="24" height="22" rx="3"/><path d="M4 13h24M10 3v6M22 3v6"/>',
    user: '<circle cx="16" cy="11" r="6"/><path d="M5 28c1.5-6 6-9 11-9s9.5 3 11 9"/>',
    flame: '<path d="M16 29c6 0 10-4 10-10 0-7-7-9-6-16-5 3-8 7-8 12-2-1-3-3-3-5-3 3-3 6-3 9 0 6 4 10 10 10z"/>',
    leaf: '<path d="M6 26C6 12 14 5 27 5c0 13-7 21-21 21zM6 26l12-12"/>',
    cup: '<path d="M6 11h16v9a7 7 0 01-7 7h-2a7 7 0 01-7-7zM22 13h3a3 3 0 010 6h-3M10 3v4M14 3v4M18 3v4"/>',
    music: '<path d="M12 24V6l16-3v18"/><circle cx="8" cy="24" r="4"/><circle cx="24" cy="21" r="4"/>',
    mic: '<rect x="11" y="3" width="10" height="17" rx="5"/><path d="M6 15a10 10 0 0020 0M16 25v4"/>',
    rocket: '<path d="M16 3c6 4 8 10 7 17l-4 4h-6l-4-4C8 13 10 7 16 3z"/><circle cx="16" cy="13" r="2.5"/><path d="M9 20l-4 3 2 4 5-2M23 20l4 3-2 4-5-2"/>',
    shield: '<path d="M16 3l11 4v8c0 7-5 12-11 14C10 27 5 22 5 15V7z"/><path d="M11 16l4 4 7-8"/>',
    gift: '<rect x="4" y="11" width="24" height="7"/><path d="M6 18v10h20V18M16 11v17M16 11c-3-6-9-6-9-2s9 2 9 2zm0 0c3-6 9-6 9-2s-9 2-9 2z"/>',
    target: '<circle cx="16" cy="16" r="12"/><circle cx="16" cy="16" r="7"/><circle cx="16" cy="16" r="2"/>',
    layers: '<path d="M16 4l13 7-13 7L3 11z"/><path d="M3 17l13 7 13-7M3 23l13 7 13-7"/>',
    wave: '<path d="M3 16c3-8 6-8 9 0s6 8 9 0 5-8 8-2"/>',
    sun: '<circle cx="16" cy="16" r="6"/><path d="M16 2v4M16 26v4M2 16h4M26 16h4M6 6l3 3M23 23l3 3M26 6l-3 3M9 23l-3 3"/>',
    plane: '<path d="M29 4L3 14l9 4 4 9 13-23z"/><path d="M12 18l6-6"/>',
    trophy: '<path d="M10 4h12v8a6 6 0 01-12 0zM10 7H5a5 5 0 005 6M22 7h5a5 5 0 01-5 6M16 18v5M10 28h12M12 23h8v5h-8z"/>',
    book: '<path d="M4 6c4-2 8-2 12 1 4-3 8-3 12-1v20c-4-2-8-2-12 1-4-3-8-3-12-1zM16 7v20"/>',
    bulb: '<path d="M11 21c0-3-4-5-4-10a9 9 0 0118 0c0 5-4 7-4 10zM12 25h8M13 29h6"/>',
    cart: '<path d="M3 4h4l3 16h15l3-11H9"/><circle cx="12" cy="26" r="2"/><circle cx="23" cy="26" r="2"/>',
    home: '<path d="M4 15L16 4l12 11M7 13v15h18V13M13 28v-8h6v8"/>',
    dumbbell: '<path d="M3 13v6M7 9v14M25 9v14M29 13v6M7 16h18"/>',
    bell: '<path d="M8 22V14a8 8 0 0116 0v8l3 3H5zM13 28h6"/>',
    arrow: '<path d="M5 16h22M19 8l8 8-8 8"/>',
    up: '<path d="M16 27V5M7 14l9-9 9 9"/>',
    down: '<path d="M16 5v22M7 18l9 9 9-9"/>',
  };
  const body = p[name] ?? p.spark!;
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" stroke="${stroke}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/**
 * A fictional brand mark: a geometric glyph made from the brand name's hash.
 * No real logos are ever drawn.
 */
export function brandMark(name: string, size = 120): string {
  const h = hashSeed(name);
  const kind = h % 4;
  const shapes = [
    `<rect x="8" y="8" width="48" height="48" rx="14" fill="var(--rf-accent)"/><circle cx="32" cy="32" r="12" fill="var(--rf-bg)"/>`,
    `<path d="M32 8l24 44H8z" fill="var(--rf-accent)"/><path d="M32 28l10 18H22z" fill="var(--rf-bg)"/>`,
    `<circle cx="24" cy="32" r="16" fill="var(--rf-accent)"/><circle cx="42" cy="32" r="13" fill="none" stroke="var(--rf-accent)" stroke-width="6"/>`,
    `<rect x="8" y="8" width="22" height="22" rx="6" fill="var(--rf-accent)"/><rect x="34" y="8" width="22" height="22" rx="11" fill="var(--rf-accent)"/><rect x="8" y="34" width="22" height="22" rx="11" fill="var(--rf-accent)"/><rect x="34" y="34" width="22" height="22" rx="6" fill="var(--rf-accent)"/>`,
  ];
  return `<svg class="bm" width="${size}" height="${size}" viewBox="0 0 64 64">${shapes[kind]}</svg>`;
}
