import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { run } from './ffmpeg';
import { FLASH_GRID, analyseFlashes, type FlashWindow } from './flashes';
import { MOTION_GRID, analyseMotion, type MotionResult } from './motion';

/** A stretch of the video, in seconds from its start. */
export interface VideoInterval {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

export interface VideoQaOptions {
  ffmpeg: string;
  input: string;
  /** The video's length, for a freeze or black stretch that runs to the end (FFmpeg reports no end for it). */
  durationSeconds: number;
  /** Report pictures that do not change for at least this long; 0: no freeze check. */
  freezeSeconds: number;
  /** Report black pictures lasting at least this long; 0: no black check (also for transparent video). */
  blackSeconds: number;
  /** freezedetect noise tolerance in dB (default -60: only truly unchanged pictures). */
  freezeNoiseDb?: number;
  /** Photosensitive flash analysis (WCAG 2.3.1) at this frame rate; unset: no flash check. */
  flashFps?: number;
  /** Motion energy, low-motion stretches and the loop seam (when `loop`), from a luma grid of every frame at `fps`; unset: not measured. */
  motion?: { fps: number; floor: number; lowSeconds: number; loop?: boolean };
  signal?: AbortSignal;
}

export interface VideoQaResult {
  freezes: VideoInterval[];
  blacks: VideoInterval[];
  /** Stretches with more than three general or red flashes in a second (empty when not checked). */
  flashes: FlashWindow[];
  /** Motion energy, low-motion stretches and the loop seam (absent when not measured). */
  motion?: MotionResult;
  args: string[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const interval = (start: number, end: number): VideoInterval => ({ startSeconds: r3(start), endSeconds: r3(end), durationSeconds: r3(end - start) });

/**
 * Pictures that freeze and pictures that are black, measured on a finished video in one decode pass with
 * FFmpeg's `freezedetect` and `blackdetect` (#294). A model that checks stills passes a frozen film; this
 * reads every frame. Thresholds are the caller's (render.qa.*); both are reported as intervals in seconds.
 */
export async function detectVideoIssues(o: VideoQaOptions): Promise<VideoQaResult> {
  const filters: string[] = [];
  if (o.freezeSeconds > 0) filters.push(`freezedetect=n=${o.freezeNoiseDb ?? -60}dB:d=${o.freezeSeconds}`);
  // pix_th: a pixel at or under 10 % luma is black; pic_th: 98 % of the picture must be (FFmpeg's defaults, stated).
  if (o.blackSeconds > 0) filters.push(`blackdetect=d=${o.blackSeconds}:pix_th=0.10:pic_th=0.98`);
  const flash = o.flashFps !== undefined && o.flashFps > 0;
  const motion = o.motion !== undefined && o.motion.fps > 0;
  if (!filters.length && !flash && !motion) return { freezes: [], blacks: [], flashes: [], args: [] };
  // One decode: the detectors on one branch; an area-averaged 8x8 colour grid per frame for the flash analysis and a
  // 32x32 luma grid for the motion analysis on others, each written raw to a temporary file next to the input.
  const tag = randomBytes(4).toString('hex');
  const grid = join(dirname(o.input), `.qa-grid-${tag}.rgb`);
  const lumaGrid = join(dirname(o.input), `.qa-motion-${tag}.gray`);
  const detect = filters.length ? filters.join(',') : 'null';
  const branches = [
    ...(flash ? [{ label: 'c', chain: `scale=${FLASH_GRID}:${FLASH_GRID}:flags=area,format=rgb24`, file: grid }] : []),
    ...(motion ? [{ label: 'm', chain: `scale=${MOTION_GRID}:${MOTION_GRID}:flags=area,format=gray`, file: lumaGrid }] : []),
  ];
  const graph = `[0:v:0]split=${branches.length + 1}[d]${branches.map((x) => `[g${x.label}]`).join('')};[d]${detect}[n]${branches.map((x) => `;[g${x.label}]${x.chain}[${x.label}]`).join('')}`;
  const args = branches.length
    ? ['-hide_banner', '-nostats', '-v', 'info', '-i', o.input, '-filter_complex', graph, '-map', '[n]', '-f', 'null', '-', ...branches.flatMap((x) => ['-map', `[${x.label}]`, '-f', 'rawvideo', '-y', x.file])]
    : ['-hide_banner', '-nostats', '-v', 'info', '-i', o.input, '-map', '0:v:0', '-an', '-sn', '-vf', detect, '-f', 'null', '-'];
  try {
    const { stderr } = await run(o.ffmpeg, args, 'qa:video', { signal: o.signal });
    const parsed = parseVideoQa(stderr, o.durationSeconds);
    return {
      freezes: o.freezeSeconds > 0 ? parsed.freezes : [],
      blacks: o.blackSeconds > 0 ? parsed.blacks : [],
      flashes: flash ? analyseFlashes(await readFile(grid), o.flashFps!) : [],
      ...(motion ? { motion: analyseMotion(await readFile(lumaGrid), o.motion!.fps, o.motion!) } : {}),
      args: args.map((a) => (a === grid ? '<grid>' : a === lumaGrid ? '<motion-grid>' : a)),
    };
  } finally {
    await Promise.all([flash ? rm(grid, { force: true }) : null, motion ? rm(lumaGrid, { force: true }) : null]);
  }
}

/** The intervals in FFmpeg's log (freezedetect metadata lines, blackdetect summary lines). */
export function parseVideoQa(log: string, durationSeconds: number): { freezes: VideoInterval[]; blacks: VideoInterval[] } {
  const freezes: VideoInterval[] = [];
  let open: number | null = null;
  for (const line of log.split('\n')) {
    const start = /lavfi\.freezedetect\.freeze_start: (-?[\d.]+)/.exec(line);
    if (start) {
      open = Number(start[1]);
      continue;
    }
    const end = /lavfi\.freezedetect\.freeze_end: (-?[\d.]+)/.exec(line);
    if (end && open !== null) {
      freezes.push(interval(open, Number(end[1])));
      open = null;
    }
  }
  if (open !== null) freezes.push(interval(open, Math.max(open, durationSeconds)));
  const blacks: VideoInterval[] = [];
  for (const m of log.matchAll(/black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/g)) blacks.push(interval(Number(m[1]), Number(m[2])));
  return { freezes, blacks };
}
