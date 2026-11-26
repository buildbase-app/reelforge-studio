import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { run } from './ffmpeg';
import { FLASH_GRID, analyseFlashes, type FlashWindow } from './flashes';

/** A stretch of the video, in seconds from its start. */
export interface VideoInterval {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

/** freezedetect's noise tolerance: only truly unchanged pictures count (FFmpeg's default; docs/QA.md#picture). */
export const FREEZE_NOISE_DB = -60;
/** blackdetect: a pixel at or under 10 % luma is black, a picture when 98 % of it is (FFmpeg's defaults, stated). */
export const BLACK_DETECT = { pixelLuma: 0.1, pictureShare: 0.98 } as const;

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
  signal?: AbortSignal;
}

export interface VideoQaResult {
  freezes: VideoInterval[];
  blacks: VideoInterval[];
  /** Stretches with more than three general or red flashes in a second (empty when not checked). */
  flashes: FlashWindow[];
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
  if (o.freezeSeconds > 0) filters.push(`freezedetect=n=${o.freezeNoiseDb ?? FREEZE_NOISE_DB}dB:d=${o.freezeSeconds}`);
  if (o.blackSeconds > 0) filters.push(`blackdetect=d=${o.blackSeconds}:pix_th=${BLACK_DETECT.pixelLuma.toFixed(2)}:pic_th=${BLACK_DETECT.pictureShare}`);
  const flash = o.flashFps !== undefined && o.flashFps > 0;
  if (!filters.length && !flash) return { freezes: [], blacks: [], flashes: [], args: [] };
  // One decode: the detectors on one branch, an area-averaged 8x8 grid per frame for the flash analysis on the other.
  const grid = join(dirname(o.input), `.qa-grid-${randomBytes(4).toString('hex')}.rgb`);
  const detect = filters.length ? filters.join(',') : 'null';
  const args = flash
    ? ['-hide_banner', '-nostats', '-v', 'info', '-i', o.input, '-filter_complex', `[0:v:0]split=2[d][g];[d]${detect}[n];[g]scale=${FLASH_GRID}:${FLASH_GRID}:flags=area,format=rgb24[c]`, '-map', '[n]', '-f', 'null', '-', '-map', '[c]', '-f', 'rawvideo', '-y', grid]
    : ['-hide_banner', '-nostats', '-v', 'info', '-i', o.input, '-map', '0:v:0', '-an', '-sn', '-vf', detect, '-f', 'null', '-'];
  try {
    const { stderr } = await run(o.ffmpeg, args, 'qa:video', { signal: o.signal });
    const parsed = parseVideoQa(stderr, o.durationSeconds);
    return {
      freezes: o.freezeSeconds > 0 ? parsed.freezes : [],
      blacks: o.blackSeconds > 0 ? parsed.blacks : [],
      flashes: flash ? analyseFlashes(await readFile(grid), o.flashFps!) : [],
      args: args.map((a) => (a === grid ? '<grid>' : a)),
    };
  } finally {
    if (flash) await rm(grid, { force: true });
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
