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
import type { EnginePlugin, ResolvedAsset } from '@reelforge/core';
import { resolveTools } from '@reelforge/media-pipeline';
import { frameLayout, type LayoutSceneProps, type OutputSettings, type RenderScene } from '@reelforge/project-schema';
import { THEME, type Format } from './matrix';

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
    filters.push(`${padded.join('')}hstack=inputs=${row.length}[r${ri}]`);
    rowLabels.push(`[r${ri}]`);
  });
  const stacked = rows.length > 1 ? `${rowLabels.join('')}vstack=inputs=${rows.length},` : `${rowLabels[0]}`;
  filters.push(`${stacked}pad=iw+12:ih+12:6:6:color=0x17171c[out]`);
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-q:v', '4', '-update', '1', out]);
}
