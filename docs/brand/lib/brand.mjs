// Brand tokens, mark access, outlined wordmark and lockups, and the product cue.
// The hand-tuned mark geometry lives in src/*.svg; this module reads it from there.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const opentype = require('opentype.js');

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const SRC = path.join(ROOT, 'src');
export const FONT_DIR = path.join(ROOT, 'fonts');

export const C = {
  ink: '#141413',
  orange: '#FF4F00',
  light: '#F4F3EF',
  dark: '#191B1F',
  onDark: '#F1F2F4',
  // Tinted neutrals for secondary text and hairlines (derived, not new accents).
  mutedLight: '#6B6A64', // 4.89:1 on light
  mutedDark: '#9A9EA6', // 6.42:1 on dark
  ruleLight: '#DCDAD2',
  ruleDark: '#2E3138',
};

export const THEMES = {
  light: { bg: C.light, fg: C.ink, muted: C.mutedLight, rule: C.ruleLight, mark: 'mark-light.svg' },
  dark: { bg: C.dark, fg: C.onDark, muted: C.mutedDark, rule: C.ruleDark, mark: 'mark-dark.svg' },
};

export const TAGLINE = ['Agents write the manifest.', 'RenderWeld renders the video.'];
export const TAGLINE_ONE = TAGLINE.join(' ');
export const DOMAIN = 'renderweld.com';
export const EMAIL = 'hello@renderweld.com';

// ---------- mark geometry (read from src) ----------
export function readSvg(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8').trim();
}
/** Inner markup of a src SVG, without <title> and <style>. */
export function svgInner(name) {
  const s = readSvg(name);
  const inner = s.slice(s.indexOf('>') + 1, s.lastIndexOf('</svg>'));
  return inner.replace(/<title>.*?<\/title>/s, '').replace(/<style>.*?<\/style>/s, '');
}
/** Return a src SVG with explicit pixel size (for inlining into HTML). */
export function svgSized(name, w, h, extra = '') {
  return readSvg(name).replace(/<svg([^>]*?) width="[^"]*" height="[^"]*"/, `<svg$1 width="${w}" height="${h}" ${extra}`);
}

// The master mark's visual box inside its 32-unit viewBox (outer stroke edges).
export const MARK_BOX = { x: 0.75, y: 5.5, w: 30.5, h: 21 };
export const MARK_STROKE = 2.5;
export const MARK_DOT_D = 7;

/** The master mark cropped to its visual box, as an <svg> of given height. */
export function markSvg(theme, height, extra = '') {
  const name = typeof theme === 'string' && theme.endsWith('.svg') ? theme : THEMES[theme].mark;
  const w = (height * MARK_BOX.w) / MARK_BOX.h;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}" width="${r2(w)}" height="${r2(height)}" ${extra}>${svgInner(name)}</svg>`;
}

// ---------- fonts ----------
const FONTS = {
  400: 'Geist-Regular.ttf',
  500: 'Geist-Medium.ttf',
  600: 'Geist-SemiBold.ttf',
  mono: 'GeistMono-Medium.ttf',
};
const fontCache = {};
// Fonts are read from the kit's fonts/ folder, or from the npm package before the first build copies them.
function fontFile(f) {
  const local = path.join(FONT_DIR, f);
  if (fs.existsSync(local)) return local;
  const pkg = path.join(ROOT, 'node_modules/geist');
  return path.join(pkg, 'dist/fonts', f.startsWith('GeistMono') ? 'geist-mono' : 'geist-sans', f);
}
export function font(weight = 600) {
  if (!fontCache[weight]) fontCache[weight] = opentype.loadSync(fontFile(FONTS[weight]));
  return fontCache[weight];
}
/** Advance width of text in px, with letter spacing in em applied between glyphs (CSS semantics: after each glyph). */
export function measure(text, size, weight = 600, tracking = 0) {
  const f = font(weight);
  return f.getAdvanceWidth(text, size, { kerning: true }) + tracking * size * text.length;
}
export function fontFaceCss() {
  const b64 = (f) => fs.readFileSync(fontFile(f)).toString('base64');
  return [
    [400, FONTS[400], 'Geist'],
    [500, FONTS[500], 'Geist'],
    [600, FONTS[600], 'Geist'],
    [500, FONTS.mono, 'Geist Mono'],
  ]
    .map(([w, f, fam]) => `@font-face{font-family:'${fam}';font-weight:${w};src:url(data:font/ttf;base64,${b64(f)}) format('truetype')}`)
    .join('\n');
}

// ---------- wordmark (outlined) ----------
const WM_SIZE = 100; // design units: font size 100
const WM_TRACK = -0.02;
// Hand-tuned optical kern for the r-W pair, which Geist leaves open (kern value 0):
// without it the wordmark starts to read as two words.
export const WM_KERN_RW = -0.03; // em
export function wordmarkPath() {
  const f = font(600);
  const opts = { kerning: true, letterSpacing: WM_TRACK };
  const a = f.getPath('Render', 0, 0, WM_SIZE, opts);
  const xW = f.getAdvanceWidth('Render', WM_SIZE, opts) + WM_KERN_RW * WM_SIZE;
  const b = f.getPath('Weld', xW, 0, WM_SIZE, opts);
  const p = new opentype.Path();
  p.extend(a);
  p.extend(b);
  const bb = p.getBoundingBox();
  return { d: p.toPathData(2), bb };
}
const CAP = 71; // Geist cap height at size 100 is 71 units (sCapHeight 710/1000)

export function wordmarkSvg(fill) {
  const { d, bb } = wordmarkPath();
  const w = bb.x2 - bb.x1;
  const h = bb.y2 - bb.y1;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(bb.x1)} ${r2(bb.y1)} ${r2(w)} ${r2(h)}" width="${r2(w)}" height="${r2(h)}"><title>RenderWeld</title><path fill="${fill}" d="${d}"/></svg>`;
}

/**
 * Horizontal lockup. Mark's frame height = 1.35 x cap height, centred on the cap height;
 * gap between mark and wordmark = one dot diameter.
 */
export function lockupH(theme) {
  const t = THEMES[theme];
  const { d, bb } = wordmarkPath();
  const s = (1.35 * CAP) / MARK_BOX.h; // mark scale
  const mw = MARK_BOX.w * s;
  const mh = MARK_BOX.h * s;
  const gap = MARK_DOT_D * s;
  const capMid = -CAP / 2;
  const my = capMid - mh / 2;
  const tx = mw + gap - bb.x1;
  const top = Math.min(my, bb.y1);
  const bottom = Math.max(my + mh, bb.y2);
  const W = tx + bb.x2;
  const H = bottom - top;
  const markG = `<g transform="translate(${r2(-MARK_BOX.x * s)} ${r2(my - MARK_BOX.y * s)}) scale(${r4(s)})">${svgInner(t.mark)}</g>`;
  const body = `${markG}<path fill="${t.fg}" transform="translate(${r2(tx)} 0)" d="${d}"/>`;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${r2(top)} ${r2(W)} ${r2(H)}" width="${r2(W)}" height="${r2(H)}"><title>RenderWeld</title>${body}</svg>`, w: W, h: H, markH: mh };
}

/** Stacked lockup: mark above, centred; gap = 1.5 dot diameters. */
export function lockupV(theme) {
  const t = THEMES[theme];
  const { d, bb } = wordmarkPath();
  const ww = bb.x2 - bb.x1;
  const s = (0.42 * ww) / MARK_BOX.w;
  const mw = MARK_BOX.w * s;
  const mh = MARK_BOX.h * s;
  const gap = 1.5 * MARK_DOT_D * s;
  const W = ww;
  const markX = (W - mw) / 2;
  const textTop = mh + gap; // cap top of wordmark
  const ty = textTop - bb.y1;
  const H = ty + bb.y2;
  const markG = `<g transform="translate(${r2(markX - MARK_BOX.x * s)} ${r2(-MARK_BOX.y * s)}) scale(${r4(s)})">${svgInner(t.mark)}</g>`;
  const body = `${markG}<path fill="${t.fg}" transform="translate(${r2(-bb.x1)} ${r2(ty)})" d="${d}"/>`;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r2(W)} ${r2(H)}" width="${r2(W)}" height="${r2(H)}"><title>RenderWeld</title>${body}</svg>`, w: W, h: H };
}

/** Lockup <svg> sized to a given height (for HTML templates). */
export function lockupAt(theme, height, kind = 'h', extra = '') {
  const L = kind === 'h' ? lockupH(theme) : lockupV(theme);
  const w = (L.w * height) / L.h;
  return L.svg.replace(/width="[^"]*" height="[^"]*"/, `width="${r2(w)}" height="${r2(height)}" ${extra}`);
}
export function lockupWidth(height, kind = 'h') {
  const L = kind === 'h' ? lockupH('light') : lockupV('light');
  return (L.w * height) / L.h;
}

// ---------- product cue: three formats welded into one ----------
// Units k: 16:9 (16x9) | 9:16 (9x16) | 1:1 (9x9), bottom-aligned, sharing walls.
// The two joints carry orange weld dots, exactly as in the mark.
export const CUE = { w: 34, h: 16 };
export function cueSvg(theme, height, opts = {}) {
  const t = THEMES[theme];
  const k = height / (CUE.h + 1.2); // keep half-stroke + dot room
  const sw = Math.max(1.5, 0.42 * k);
  const pad = 0.6 * k;
  const W = CUE.w * k + 2 * pad;
  const H = height;
  const y0 = pad; // top of portrait
  const base = pad + 16 * k;
  const rx = 1.3 * k;
  const frames = [
    { x: pad, y: base - 9 * k, w: 16 * k, h: 9 * k, label: '16:9' },
    { x: pad + 16 * k, y: y0, w: 9 * k, h: 16 * k, label: '9:16' },
    { x: pad + 25 * k, y: base - 9 * k, w: 9 * k, h: 9 * k, label: '1:1' },
  ];
  const dotR = 1.05 * k;
  const labels = opts.labels !== false;
  const caption = opts.captions !== false;
  const fs = Math.max(9, 1.05 * k);
  let g = `<g fill="none" stroke="${t.fg}" stroke-width="${r2(sw)}">`;
  for (const f of frames) g += `<rect x="${r2(f.x)}" y="${r2(f.y)}" width="${r2(f.w)}" height="${r2(f.h)}" rx="${r2(rx)}"/>`;
  g += '</g>';
  let extra = '';
  for (const f of frames) {
    if (caption) {
      // caption bar: the burned-in subtitle of each finished version
      const cw = f.w * 0.56;
      const ch = 0.7 * k;
      extra += `<rect x="${r2(f.x + (f.w - cw) / 2)}" y="${r2(f.y + f.h - 2.2 * k)}" width="${r2(cw)}" height="${r2(ch)}" rx="${r2(ch / 2)}" fill="${t.muted}"/>`;
    }
    if (labels) {
      extra += `<text x="${r2(f.x + 1.5 * k)}" y="${r2(f.y + 1.5 * k + fs * 0.75)}" font-family="Geist Mono" font-weight="500" font-size="${r2(fs)}" fill="${t.muted}">${f.label}</text>`;
    }
  }
  const dots = [
    [pad + 16 * k, base - 9 * k],
    [pad + 25 * k, base - 9 * k],
  ]
    .map(([x, y]) => `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(dotR)}" fill="${C.orange}"/>`)
    .join('');
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r2(W)} ${r2(H)}" width="${r2(W)}" height="${r2(H)}">${g}${extra}${dots}</svg>`, w: W, h: H };
}

export function r2(n) {
  return Math.round(n * 100) / 100;
}
export function r4(n) {
  return Math.round(n * 10000) / 10000;
}
