import { run } from './ffmpeg';

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
  signal?: AbortSignal;
}

export interface VideoQaResult {
  freezes: VideoInterval[];
  blacks: VideoInterval[];
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
  if (!filters.length) return { freezes: [], blacks: [], args: [] };
  const args = ['-hide_banner', '-nostats', '-v', 'info', '-i', o.input, '-map', '0:v:0', '-an', '-sn', '-vf', filters.join(','), '-f', 'null', '-'];
  const { stderr } = await run(o.ffmpeg, args, 'qa:video', { signal: o.signal });
  return { ...parseVideoQa(stderr, o.durationSeconds), args };
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
