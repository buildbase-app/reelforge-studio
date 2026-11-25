/**
 * The format matrix (#287): every built-in template on its engine at every
 * standard aspect ratio, with an overflow check on the rendered pixels and a
 * contact sheet per format. Used by test/formats.test.ts (small, proportional
 * sizes) and by `pnpm formats:prove` (scripts/formats/prove.ts: real sizes,
 * writes docs/proofs/formats/).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EnginePlugin } from '@renderweld/core';
import { htmlEngine } from '@renderweld/engine-html';
import { hyperframesEngine } from '@renderweld/engine-hyperframes';
import { motionCanvasEngine } from '@renderweld/engine-motion-canvas';
import { remotionEngine } from '@renderweld/engine-remotion';
import { resolveTools } from '@renderweld/media-pipeline';
import { builtinTheme, frameLayout, type OutputSettings, type RenderScene, type ThemeTokens } from '@renderweld/project-schema';

const run = promisify(execFile);

export interface Format {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** The formats every built-in template must render (#287). */
export const FORMATS: Format[] = [
  { id: '16x9', label: '16:9 (1920x1080)', width: 1920, height: 1080 },
  { id: '1x1', label: '1:1 (1080x1080)', width: 1080, height: 1080 },
  { id: '4x5', label: '4:5 (1080x1350)', width: 1080, height: 1350 },
  { id: '9x16', label: '9:16 (1080x1920)', width: 1080, height: 1920 },
];
export const FORMAT_4K: Format = { id: '4k', label: '4K UHD 16:9 (3840x2160)', width: 3840, height: 2160 };

/** Scale a format down proportionally (even dimensions, as H.264 yuv420p needs). */
export function scaled(f: Format, divisor: number): Format {
  const even = (n: number) => Math.max(16, Math.round(n / divisor / 2) * 2);
  return { ...f, width: even(f.width), height: even(f.height) };
}

export interface Sample {
  template: string;
  engine: string;
  seconds: number;
  /** When everything is on screen (fraction of the scene): the frame the overflow check reads. */
  settled: number;
  props: Record<string, unknown>;
}

/** Each template with its longest realistic text (near the schema maximums), so overflow shows up. */
export const SAMPLES: Sample[] = [
  {
    template: 'kinetic-title',
    engine: 'remotion',
    seconds: 3,
    settled: 0.75,
    props: { headline: 'Render every format from one project, no overflow', subline: 'Wide, square, portrait and tall from the same manifest' },
  },
  {
    template: 'animated-explainer',
    engine: 'motion-canvas',
    seconds: 4,
    settled: 0.95,
    props: {
      title: 'One manifest, every screen',
      points: [
        'Text scales from the shorter side of the frame',
        'Everything stays inside the title-safe area',
        'Wide frames put the title next to the points',
        'Tall frames keep clear of the app buttons',
      ],
    },
  },
  {
    template: 'html-title',
    engine: 'html',
    seconds: 3,
    settled: 0.8,
    props: {
      kicker: 'Any format',
      headline: 'Headlines shrink to fit their box instead of running off the edge of the frame',
      subline: 'The same scene at 16:9, 1:1, 4:5, 9:16 and 4K, laid out for each one',
    },
  },
  {
    template: 'hyperframes-title',
    engine: 'hyperframes',
    seconds: 3,
    settled: 0.8,
    props: {
      headline: 'Headlines shrink to fit their box instead of running off the edge of the frame',
      subline: 'The same scene at 16:9, 1:1, 4:5, 9:16 and 4K, laid out for each one',
    },
  },
];

export const THEME: ThemeTokens = builtinTheme('midnight')!.tokens;

export function engines(): Record<string, EnginePlugin> {
  return { remotion: remotionEngine(), 'motion-canvas': motionCanvasEngine(), html: htmlEngine(), hyperframes: hyperframesEngine() };
}

export interface Rendered {
  file: string;
  frames: number;
  output: OutputSettings;
}

/** Render one sample at a size with the engine plugin, the way the render pipeline calls it. */
export async function renderSample(engine: EnginePlugin, sample: Sample, f: Format, dir: string, cacheDir: string, fps: 24 | 30 = 30): Promise<Rendered> {
  const output: OutputSettings = { width: f.width, height: f.height, fps, format: 'mp4' };
  const frames = Math.round(sample.seconds * fps);
  const scene: RenderScene = { id: `${sample.template}-${f.id}`, engine: sample.engine, template: sample.template, durationFrames: frames, props: sample.props, assets: [] };
  const workDir = join(dir, 'work', scene.id);
  mkdirSync(workDir, { recursive: true });
  const out = join(dir, `${scene.id}-${f.width}x${f.height}.mp4`);
  const tools = resolveTools();
  await engine.render(scene, {
    output,
    theme: THEME,
    out,
    workDir,
    cacheDir,
    tools,
    assets: new Map(),
    signal: new AbortController().signal,
    progress: () => undefined,
    log: () => undefined,
  });
  rmSync(workDir, { recursive: true, force: true });
  return { file: out, frames, output };
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** One decoded frame as RGB bytes. */
export async function frameRgb(file: string, frame: number, width: number, height: number): Promise<Buffer> {
  const { stdout } = await run(
    'ffmpeg',
    ['-hide_banner', '-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: width * height * 3 + 1024 }
  );
  return stdout as unknown as Buffer;
}

/**
 * Bounding box of everything that is not background: pixels whose colour is
 * more than `threshold` away from the theme background in any channel. Null
 * when the frame is empty.
 */
export function inkBox(rgb: Buffer, width: number, height: number, background: string, threshold = 48): Box | null {
  const [r, g, b] = hexRgb(background);
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (Math.abs(rgb[i]! - r) > threshold || Math.abs(rgb[i + 1]! - g) > threshold || Math.abs(rgb[i + 2]! - b) > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export interface OverflowReport {
  ok: boolean;
  frame: number;
  ink: Box | null;
  /** The content safe area, grown by the tolerance. */
  allowed: Box;
  problems: string[];
}

/**
 * The overflow check on a rendered clip: at the settled frame, everything that
 * is not background must lie inside the content safe area (title safe, plus
 * the ui zone on tall frames), with a tolerance of 1.5 % of the shorter side
 * for antialiasing and compression; the text must also be readable (its box
 * at least a quarter of the safe area's width).
 */
export async function checkOverflow(r: Rendered, sample: Sample): Promise<OverflowReport> {
  const { width, height } = r.output;
  const frame = Math.min(r.frames - 1, Math.round(r.frames * sample.settled));
  const rgb = await frameRgb(r.file, frame, width, height);
  const l = frameLayout(width, height);
  const tol = Math.max(2, Math.ceil(l.unit * 1.5));
  const allowed: Box = { x0: l.box.x - tol, y0: l.box.y - tol, x1: l.box.x + l.box.width + tol, y1: l.box.y + l.box.height + tol };
  const ink = inkBox(rgb, width, height, (sample.props.background as string | undefined) ?? THEME.colors.background);
  const problems: string[] = [];
  if (!ink) problems.push('the settled frame is empty');
  else {
    if (ink.x0 < allowed.x0) problems.push(`text starts ${allowed.x0 - ink.x0}px left of the safe area`);
    if (ink.y0 < allowed.y0) problems.push(`text starts ${allowed.y0 - ink.y0}px above the safe area`);
    if (ink.x1 > allowed.x1) problems.push(`text ends ${ink.x1 - allowed.x1}px right of the safe area`);
    if (ink.y1 > allowed.y1) problems.push(`text ends ${ink.y1 - allowed.y1}px below the safe area`);
    if (ink.x0 <= 0 || ink.y0 <= 0 || ink.x1 >= width - 1 || ink.y1 >= height - 1) problems.push('text touches the frame edge (clipped)');
    if (ink.x1 - ink.x0 < l.box.width * 0.25) problems.push(`text block is only ${ink.x1 - ink.x0}px wide (box ${l.box.width}px): shrunk too far`);
  }
  return { ok: problems.length === 0, frame, ink, allowed, problems };
}

/**
 * One contact-sheet row: four frames of a clip (entry, middle, settled, end),
 * each with the content safe area drawn as a thin outline.
 */
export async function contactRow(r: Rendered, sample: Sample, thumbWidth: number, out: string): Promise<void> {
  const { width, height } = r.output;
  const thumbHeight = Math.round((thumbWidth * height) / width / 2) * 2;
  const k = thumbWidth / width;
  const l = frameLayout(width, height);
  const picks = [0.1, 0.4, sample.settled, 0.99].map((t) => Math.min(r.frames - 1, Math.round(r.frames * t)));
  const select = picks.map((n) => `eq(n\\,${n})`).join('+');
  const guide = `drawbox=x=${Math.round(l.box.x * k)}:y=${Math.round(l.box.y * k)}:w=${Math.round(l.box.width * k)}:h=${Math.round(l.box.height * k)}:color=0x9aa0a6@0.55:t=1`;
  await run('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y', '-i', r.file,
    '-vf', `select='${select}',scale=${thumbWidth}:${thumbHeight}:flags=lanczos,${guide},tile=4x1:padding=12:margin=12:color=0x17171c`,
    '-fps_mode', 'passthrough', '-frames:v', '1', '-update', '1', out,
  ]);
}

/** Stack contact-sheet rows into one PNG. */
export async function stackRows(rows: string[], out: string): Promise<void> {
  const inputs = rows.flatMap((r) => ['-i', r]);
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...inputs, '-filter_complex', `vstack=inputs=${rows.length}`, '-frames:v', '1', '-update', '1', out]);
}
