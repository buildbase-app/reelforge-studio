/**
 * The layout matrix (#287): every layout primitive (split screen,
 * picture-in-picture, lower third, grid, fit modes) on the DOM engines (html,
 * hyperframes) at 16:9, 1:1, 9:16 and 4K. Used by test/formats.test.ts and by
 * `pnpm formats:prove-layouts` (scripts/formats/prove-layouts.ts), which
 * writes the contact sheets to docs/proofs/layouts/.
 *
 * Media are made with FFmpeg's sources here, so the proofs carry no
 * third-party pictures: a toned Mandelbrot still (4:3), a Game of Life clip (16:9)
 * and a second Game of Life clip in portrait (9:16).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EnginePlugin, ResolvedAsset } from '@renderweld/core';
import { renderHtmlScene } from '@renderweld/engine-html';
import { renderMotionCanvasScene } from '@renderweld/engine-motion-canvas';
import { renderRemotionScene } from '@renderweld/engine-remotion';
import { resolveTools } from '@renderweld/media-pipeline';
import { clearOfLowerThird, frameLayout, layoutPanes, layoutSceneProps, lowerThirdBox, toLayoutSpec, type LayoutSceneProps, type OutputSettings, type RenderScene } from '@renderweld/project-schema';
import { THEME, frameRgb, type Format } from './matrix';

const run = promisify(execFile);

export const LAYOUT_FORMATS: Format[] = [
  { id: '16x9', label: '16:9 (1920x1080)', width: 1920, height: 1080 },
  { id: '1x1', label: '1:1 (1080x1080)', width: 1080, height: 1080 },
  { id: '9x16', label: '9:16 (1080x1920)', width: 1080, height: 1920 },
  { id: '4k', label: '4K UHD 16:9 (3840x2160)', width: 3840, height: 2160 },
];

export const LAYOUT_ENGINES = [
  { engine: 'html', template: 'html-layout' },
  { engine: 'hyperframes', template: 'hyperframes-layout' },
  { engine: 'remotion', template: 'remotion-layout' },
  { engine: 'motion-canvas', template: 'motion-canvas-layout' },
] as const;

export interface LayoutSample {
  id: string;
  title: string;
  seconds: number;
  /** When everything is on screen (fraction of the scene). */
  settled: number;
  props: LayoutSceneProps | Record<string, unknown>;
}

export const LAYOUT_SAMPLES: LayoutSample[] = [
  {
    id: 'split',
    title: 'Split screen: 2 panes, side by side on wide frames, stacked on square and tall ones',
    seconds: 2,
    settled: 0.8,
    props: {
      layout: { type: 'split' },
      panes: [
        { media: { asset: 'wide', fit: 'cover' }, label: 'Screen', headline: 'Two sources, one frame', body: 'Panes reflow per output size' },
        { media: { asset: 'tall', fit: 'blur-fill' }, label: 'Camera' },
      ],
    },
  },
  {
    id: 'split-3',
    title: 'Split screen: 3 panes with ratios 2:1:1',
    seconds: 2,
    settled: 0.8,
    props: {
      layout: { type: 'split', ratios: [2, 1, 1], gap: 1 },
      panes: [
        { media: { asset: 'wide', fit: 'cover' }, label: 'Main' },
        { media: { asset: 'still', fit: 'cover', focus: { x: 30, y: 50 } }, label: 'Detail' },
        { color: '#24303d', headline: 'Ratios 2:1:1', body: 'Sizes in layout units' },
      ],
    },
  },
  {
    id: 'pip',
    title: 'Picture-in-picture: inset in the bottom-right corner, 2 units from the safe area',
    seconds: 2,
    settled: 0.8,
    props: {
      layout: { type: 'pip', corner: 'bottom-right' },
      panes: [{ media: { asset: 'wide', fit: 'blur-fill' } }, { media: { asset: 'tall', fit: 'cover' } }],
    },
  },
  {
    id: 'lower-third',
    title: 'Lower third: name and title in brand colours, in the safe area',
    seconds: 2,
    settled: 0.8,
    props: {
      layout: { type: 'full' },
      panes: [{ media: { asset: 'wide', fit: 'blur-fill' } }],
      lowerThird: { name: 'Sam Rivera', title: 'Product designer, sample lower third', accent: '#e8b04a', background: '#14181f', text: '#f4f1ea' },
    },
  },
  {
    id: 'grid',
    title: 'Grid: 6 panes, 3x2 on wide frames and 2x3 on tall ones (columns and rows chosen per frame)',
    seconds: 2,
    settled: 0.8,
    props: {
      layout: { type: 'grid' },
      panes: [
        { media: { asset: 'wide', fit: 'cover' }, label: 'One' },
        { media: { asset: 'still', fit: 'cover' }, label: 'Two' },
        { media: { asset: 'tall', fit: 'blur-fill' }, label: 'Three' },
        { color: '#24303d', headline: 'Grid', body: 'n x m, or chosen per frame' },
        { media: { asset: 'still', fit: 'contain' }, label: 'Five' },
        { media: { asset: 'wide', fit: 'contain' }, label: 'Six' },
      ],
    },
  },
  {
    id: 'fit',
    title: 'Fit modes: the same 4:3 picture as contain, cover and blur-fill',
    seconds: 2,
    settled: 0.8,
    props: {
      layout: { type: 'split', gap: 1 },
      panes: [
        { media: { asset: 'still', fit: 'contain' }, label: 'contain' },
        { media: { asset: 'still', fit: 'cover' }, label: 'cover' },
        { media: { asset: 'still', fit: 'blur-fill' }, label: 'blur-fill' },
      ],
    },
  },
];

/** The longest text the schema allows in every pane of a 6-pane grid, and a lower third at its limits over a split. */
export const LAYOUT_STRESS_SAMPLES: LayoutSample[] = [
  {
    id: 'stress-grid',
    title: 'longest text',
    seconds: 2,
    settled: 0.8,
    props: {
      layout: { type: 'grid' },
      panes: Array.from({ length: 6 }, (_, i) => ({
        media: { asset: i % 2 ? 'wide' : 'tall', fit: 'cover' },
        label: 'A label of forty characters, at the cap',
        headline: 'WWWW A headline at the eighty character limit that must shrink to fit its pane',
        body: 'Body text of a realistic length that wraps onto two or three lines in a narrow pane and must stay inside the pane and the safe area too.',
      })),
    },
  },
  {
    id: 'stress-lower-third',
    title: 'longest lower third',
    seconds: 2,
    settled: 0.8,
    props: {
      layout: { type: 'split' },
      panes: [
        { media: { asset: 'wide', fit: 'cover' }, label: 'A label of forty characters, at the cap', headline: 'WWWW A headline at the eighty character limit that must shrink to fit its pane' },
        { media: { asset: 'tall', fit: 'blur-fill' }, body: 'Body text of a realistic length that wraps onto two or three lines in a narrow pane and must stay inside the pane and the safe area too.' },
      ],
      lowerThird: { name: 'A name at the sixty character limit for lower third names ok', title: 'And a title of eighty characters that wraps onto a second line in narrow frames.' },
    },
  },
];

/** Make the sample media (FFmpeg sources). Videos last `seconds`. */
export async function makeLayoutMedia(dir: string, seconds = 4): Promise<Map<string, ResolvedAsset>> {
  mkdirSync(dir, { recursive: true });
  const ff = (args: string[]) => run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
  const still = join(dir, 'still.png');
  const wide = join(dir, 'wide.mp4');
  const tall = join(dir, 'tall.mp4');
  // Toned to the sample palette (sand on slate) so the sheets show layout, not colour.
  await ff([
    '-f', 'lavfi', '-i', 'mandelbrot=s=1200x900:end_pts=1:outer=normalized_iteration_count',
    '-vf', 'format=gray,format=rgb24,curves=r=0/0.10 1/0.93:g=0/0.14 1/0.80:b=0/0.19 1/0.62', '-frames:v', '1', still,
  ]);
  await ff([
    '-f', 'lavfi', '-i', `life=s=480x270:mold=10:r=30:ratio=0.12:death_color=#1b2430:life_color=#e8b04a,scale=1920:1080:flags=neighbor`,
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', wide,
  ]);
  await ff([
    '-f', 'lavfi', '-i', `life=s=180x320:mold=6:r=30:ratio=0.18:death_color=#2c4a5a:life_color=#9fe3d6,scale=720:1280:flags=neighbor`,
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', tall,
  ]);
  return new Map<string, ResolvedAsset>([
    ['still', { id: 'still', file: still, mediaType: 'image', contentType: 'image/png' }],
    ['wide', { id: 'wide', file: wide, mediaType: 'video', contentType: 'video/mp4' }],
    ['tall', { id: 'tall', file: tall, mediaType: 'video', contentType: 'video/mp4' }],
  ]);
}

export interface LayoutRendered {
  file: string;
  frames: number;
  output: OutputSettings;
}

/** Render one layout sample on an engine at a size, the way the render pipeline calls the plugin. */
export async function renderLayout(
  engine: EnginePlugin,
  template: string,
  sample: LayoutSample,
  f: Format,
  assets: ReadonlyMap<string, ResolvedAsset>,
  dir: string,
  cacheDir: string,
  fps = 30,
  platform?: string
): Promise<LayoutRendered> {
  const output: OutputSettings = { width: f.width, height: f.height, fps: fps as 30, format: 'mp4' };
  const frames = Math.round(sample.seconds * fps);
  const scene: RenderScene = { id: `${sample.id}-${engine.id}-${f.id}`, engine: engine.id, template, durationFrames: frames, props: sample.props as Record<string, unknown>, assets: [...assets.keys()] };
  const workDir = join(dir, 'work', scene.id);
  mkdirSync(workDir, { recursive: true });
  const out = join(dir, `${scene.id}-${f.width}x${f.height}.mp4`);
  await engine.render(scene, {
    output,
    theme: THEME,
    ...(platform ? { platform } : {}),
    out,
    workDir,
    cacheDir,
    tools: resolveTools(),
    assets,
    signal: new AbortController().signal,
    progress: () => undefined,
    log: () => undefined,
  });
  rmSync(workDir, { recursive: true, force: true });
  return { file: out, frames, output };
}

/** One frame of a clip as a PNG thumbnail of the given height, with the content safe area outlined. */
export async function layoutThumb(r: LayoutRendered, at: number, height: number, out: string): Promise<void> {
  const { width: w, height: h } = r.output;
  const tw = Math.round((height * w) / h / 2) * 2;
  const k = height / h;
  const l = frameLayout(w, h);
  const n = Math.min(r.frames - 1, Math.round(r.frames * at));
  const guide = `drawbox=x=${Math.round(l.box.x * k)}:y=${Math.round(l.box.y * k)}:w=${Math.round(l.box.width * k)}:h=${Math.round(l.box.height * k)}:color=0x9aa0a6@0.6:t=1`;
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', r.file, '-vf', `select=eq(n\\,${n}),scale=${tw}:${height}:flags=lanczos,${guide}`, '-fps_mode', 'passthrough', '-frames:v', '1', '-update', '1', out]);
}

/** Lay thumbnails out in rows (one row per engine), on the sheet colour, with 12 px gutters. */
export async function layoutSheet(rows: string[][], out: string): Promise<void> {
  const inputs = rows.flat().flatMap((f) => ['-i', f]);
  const filters: string[] = [];
  let k = 0;
  const rowLabels: string[] = [];
  rows.forEach((row, ri) => {
    const labels = row.map(() => `[${k++}:v]`);
    const padded = labels.map((lab, i) => {
      const o = `p${ri}_${i}`;
      filters.push(`${lab}pad=iw+12:ih+12:6:6:color=0x17171c[${o}]`);
      return `[${o}]`;
    });
    filters.push(row.length > 1 ? `${padded.join('')}hstack=inputs=${row.length}[r${ri}]` : `${padded[0]}null[r${ri}]`);
    rowLabels.push(`[r${ri}]`);
  });
  const stacked = rows.length > 1 ? `${rowLabels.join('')}vstack=inputs=${rows.length},` : `${rowLabels[0]}`;
  filters.push(`${stacked}pad=iw+12:ih+12:6:6:color=0x17171c[out]`);
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-q:v', '4', '-update', '1', out]);
}

/* ---------------------------------------------------------------------------
 * Cross-engine geometry on rendered pixels: every layout sample with its media
 * swapped for flat pane colours (geometry does not depend on the pictures),
 * rendered on an engine, then each pane found by its colour. Used by
 * test/layouts-engines.test.ts and `pnpm formats:prove-layouts --geometry`.
 * ------------------------------------------------------------------------- */

/** Flat pane colours, at least 64 apart in some channel from each other, the theme's text and background, and LOWER_THIRD_PROBE (H.264 shifts colours near edges by up to about 20). */
export const PANE_COLORS = ['#b03a48', '#2f5fb0', '#3f8f2f', '#b08a1f', '#7a3fb0', '#1fa0a0'] as const;
/** The lower third's background in geometry samples, so it can be found by colour. */
export const LOWER_THIRD_PROBE = '#d04a90';
/** Geometry samples last 1.5 s; frame 30 (1 s) is after every entry and before the lower third's exit (1.05 s). */
export const GEOMETRY_SECONDS = 1.5;
export const GEOMETRY_FRAME = 30;

/** A sample's props with media replaced by flat colours (text and lower third kept). */
export function geometryProps(sample: LayoutSample): Record<string, unknown> {
  const p = sample.props as { panes: Array<Record<string, unknown>>; lowerThird?: Record<string, unknown> } & Record<string, unknown>;
  return {
    ...p,
    panes: p.panes.map(({ media: _media, ...pane }, i) => ({ ...pane, color: PANE_COLORS[i % PANE_COLORS.length] })),
    ...(p.lowerThird ? { lowerThird: { ...p.lowerThird, background: LOWER_THIRD_PROBE } } : {}),
  };
}

const rgbOf = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const near = (rgb: Buffer, i: number, c: readonly number[], tol: number) =>
  Math.abs(rgb[i]! - c[0]!) <= tol && Math.abs(rgb[i + 1]! - c[1]!) <= tol && Math.abs(rgb[i + 2]! - c[2]!) <= tol;

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** How many pixels had the colour. */
  pixels: number;
}

/**
 * The rectangle a flat colour fills: the rows and columns where at least
 * `share` of the busiest row or column has the colour (within `tol`). Robust
 * to stray pixels of a similar colour (antialiased text, chroma subsampling
 * at edges) and to text drawn over part of the rectangle. Null when the
 * colour is not there.
 */
export function colorRect(rgb: Buffer, width: number, height: number, hex: string, tol = 20, share = 0.25): PixelRect | null {
  const c = rgbOf(hex);
  const cols = new Uint32Array(width);
  const rows = new Uint32Array(height);
  let pixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!near(rgb, (y * width + x) * 3, c, tol)) continue;
      pixels++;
      cols[x]!++;
      rows[y]!++;
    }
  }
  if (!pixels) return null;
  const span = (counts: Uint32Array) => {
    const min = Math.max(1, Math.max(...counts) * share);
    let a = -1;
    let b = -1;
    counts.forEach((n, i) => {
      if (n < min) return;
      if (a < 0) a = i;
      b = i;
    });
    return [a, b] as const;
  };
  const [x0, x1] = span(cols);
  const [y0, y1] = span(rows);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels };
}

export interface InkReport {
  /** Per pane: pixels that are not its colour, inside the pane (eroded), outside the inset and the lower third. */
  panes: Array<{ index: number; ink: number; stray: number; strayBox: Box | null }>;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Text and labels inside their boxes, measured on pixels: in each pane, every
 * pixel far from the pane's colour (text, a label's card) must lie in that
 * pane's text box (`text`, grown by `tol`). Pixels under the inset or the
 * lower third (`skip`) and within 3 px of the pane's edge (antialiasing,
 * chroma subsampling) are not counted.
 */
export function inkOutsideText(
  rgb: Buffer,
  width: number,
  panes: Array<{ index: number; rect: { x: number; y: number; width: number; height: number }; text: { x: number; y: number; width: number; height: number }; color: string }>,
  skip: Array<{ x: number; y: number; width: number; height: number }>,
  tol: number
): InkReport {
  const out: InkReport['panes'] = [];
  for (const p of panes) {
    const c = rgbOf(p.color);
    let ink = 0;
    let stray = 0;
    const b: Box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
    const inside = (r: { x: number; y: number; width: number; height: number }, x: number, y: number, by: number) => x >= r.x - by && x < r.x + r.width + by && y >= r.y - by && y < r.y + r.height + by;
    for (let y = Math.ceil(p.rect.y + 3); y < p.rect.y + p.rect.height - 3; y++) {
      for (let x = Math.ceil(p.rect.x + 3); x < p.rect.x + p.rect.width - 3; x++) {
        if (skip.some((s) => inside(s, x, y, 3))) continue;
        if (near(rgb, (y * width + x) * 3, c, 60)) continue;
        ink++;
        if (inside(p.text, x, y, tol)) continue;
        stray++;
        b.x0 = Math.min(b.x0, x);
        b.y0 = Math.min(b.y0, y);
        b.x1 = Math.max(b.x1, x);
        b.y1 = Math.max(b.y1, y);
      }
    }
    out.push({ index: p.index, ink, stray, strayBox: stray ? b : null });
  }
  return { panes: out };
}

/**
 * One frame of a geometry sample as RGB, rendered by an engine's own render
 * function: html renders the whole clip (it has no frame ranges); Remotion and
 * Motion Canvas render the one frame (`frameRange`).
 */
export async function renderGeometryFrame(
  engine: 'html' | 'remotion' | 'motion-canvas',
  sample: LayoutSample,
  f: Format,
  dir: string,
  cacheDir: string
): Promise<Buffer> {
  const output: OutputSettings = { width: f.width, height: f.height, fps: 30, format: 'mp4' };
  const durationFrames = Math.round(GEOMETRY_SECONDS * 30);
  const template = LAYOUT_ENGINES.find((e) => e.engine === engine)!.template;
  const scene: RenderScene = { id: `geo-${sample.id}-${engine}-${f.id}`, engine, template, durationFrames, props: geometryProps(sample) };
  const out = join(dir, `${scene.id}.mp4`);
  const workDir = join(dir, 'work', scene.id);
  mkdirSync(workDir, { recursive: true });
  const tools = resolveTools();
  const range = [GEOMETRY_FRAME, GEOMETRY_FRAME] as const;
  try {
    if (engine === 'html') {
      await renderHtmlScene({ scene, output, theme: THEME, out, ffmpeg: tools.ffmpeg, workDir, tools });
      return await frameRgb(out, GEOMETRY_FRAME, f.width, f.height);
    }
    if (engine === 'remotion') {
      await renderRemotionScene({ scene, output, theme: THEME, out, cacheDir, workDir, tools, frameRange: range });
    } else {
      await renderMotionCanvasScene({ scene, output, theme: THEME, out, cacheDir, ffmpeg: tools.ffmpeg, workDir, tools, frameRange: range });
    }
    return await frameRgb(out, 0, f.width, f.height);
  } finally {
    rmSync(out, { force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

export interface GeometryCheck {
  sample: string;
  format: string;
  engine: string;
  /** Per pane: the rectangle found by colour, and its largest edge difference from the geometry and from the html engine, in px. */
  panes: Array<{ index: number; found: PixelRect | null; vsGeometry: number; vsHtml: number }>;
  lowerThird: { found: PixelRect | null; vsHtml: number } | null;
  ink: InkReport['panes'];
  /** One layout unit in px (the tolerance). */
  unit: number;
  problems: string[];
}

const edgeDiff = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.x + a.width - (b.x + b.width)), Math.abs(a.y + a.height - (b.y + b.height)));

/**
 * Check one engine's frame of a geometry sample: each pane where
 * `layoutPanes` puts it and where the html engine drew it (within 1 unit),
 * the lower third where html drew it and inside the content safe area, and
 * all pane text inside its pane's text box (`inkOutsideText`).
 */
export function checkGeometry(sample: LayoutSample, f: Format, engine: string, rgb: Buffer, html: Buffer | null): GeometryCheck {
  const props = layoutSceneProps.parse(geometryProps(sample));
  const l = frameLayout(f.width, f.height);
  const u = l.unit;
  const lt = props.lowerThird ? lowerThirdBox(l, props.lowerThird.align) : null;
  const panesOnly = layoutPanes(l, toLayoutSpec(props.layout), props.panes.length);
  const geo = lt ? clearOfLowerThird(panesOnly, lt) : panesOnly;
  const problems: string[] = [];
  const panes = geo.panes.map((p) => {
    const color = PANE_COLORS[p.index % PANE_COLORS.length]!;
    const found = colorRect(rgb, f.width, f.height, color);
    const ref = html ? colorRect(html, f.width, f.height, color) : null;
    const vsGeometry = found ? edgeDiff(found, p) : Infinity;
    const vsHtml = found && ref ? edgeDiff(found, ref) : html ? Infinity : 0;
    if (vsGeometry > u) problems.push(`pane ${p.index} is ${vsGeometry}px from the geometry (${JSON.stringify(found)} vs ${JSON.stringify({ x: p.x, y: p.y, width: p.width, height: p.height })})`);
    if (vsHtml > u) problems.push(`pane ${p.index} is ${vsHtml}px from the html engine's`);
    return { index: p.index, found, vsGeometry, vsHtml };
  });
  let lowerThird: GeometryCheck['lowerThird'] = null;
  if (lt) {
    const found = colorRect(rgb, f.width, f.height, LOWER_THIRD_PROBE);
    const ref = html ? colorRect(html, f.width, f.height, LOWER_THIRD_PROBE) : null;
    const vsHtml = found && ref ? edgeDiff(found, ref) : html ? Infinity : 0;
    lowerThird = { found, vsHtml };
    if (!found) problems.push('the lower third is not drawn');
    else {
      const inside = found.x >= l.box.x - u && found.y >= l.box.y - u && found.x + found.width <= l.box.x + l.box.width + u && found.y + found.height <= l.box.y + l.box.height + u;
      if (!inside) problems.push(`the lower third ${JSON.stringify(found)} is outside the content safe area`);
      if (found.height > lt.height + u) problems.push(`the lower third is ${found.height}px tall, its band ${lt.height}px`);
    }
    if (vsHtml > u) problems.push(`the lower third is ${vsHtml}px from the html engine's`);
  }
  const inset = geo.panes.find((p) => p.role === 'inset');
  // Not ink of the pane under them: the picture-in-picture inset (with its outline) and the lower third.
  const skip = [
    ...(inset ? [{ x: inset.x - S_OUTLINE * u, y: inset.y - S_OUTLINE * u, width: inset.width + 2 * S_OUTLINE * u, height: inset.height + 2 * S_OUTLINE * u }] : []),
    // The lower third and its accent bar (1 unit, outside the probe colour).
    ...(lowerThird?.found ? [{ x: lowerThird.found.x - lt!.bar - 2, y: lowerThird.found.y, width: lowerThird.found.width + 2 * lt!.bar + 4, height: lowerThird.found.height }] : []),
  ];
  const ink = inkOutsideText(
    rgb,
    f.width,
    geo.panes.map((p) => ({ index: p.index, rect: p, text: p.text, color: PANE_COLORS[p.index % PANE_COLORS.length]! })),
    skip,
    u
  ).panes;
  for (const k of ink) {
    const pane = props.panes[k.index]!;
    if ((pane.label || pane.headline || pane.body) && k.ink === 0) problems.push(`pane ${k.index} shows no text`);
    if (k.stray > 0) problems.push(`pane ${k.index}: ${k.stray} text pixels outside its text box, in ${JSON.stringify(k.strayBox)}`);
  }
  return { sample: sample.id, format: f.id, engine, panes, lowerThird, ink, unit: u, problems };
}

/** The inset's outline in units (LAYOUT_STYLE.inset.outline), plus its antialiasing. */
const S_OUTLINE = 1;
