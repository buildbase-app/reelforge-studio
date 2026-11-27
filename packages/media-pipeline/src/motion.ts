/**
 * Motion energy and loop seam (#294), from a coarse luma grid of every frame: MOTION_GRID x MOTION_GRID cells of
 * 8-bit luma per frame, as `scale=32:32:flags=area,format=gray` writes them. Area averaging removes encoder noise and
 * film grain and keeps what a viewer sees move: a pan, a zoom, text sliding in.
 *
 * - Motion of a frame: the mean absolute change of its cells from the frame before, in 8-bit luma levels (0 to 255).
 * - Motion energy: that value averaged over each second of the video.
 * - A low-motion stretch: at least a set time in which no frame differs from the picture a second before it by the
 *   floor or more. It catches pictures that are nearly still but not identical (grain, a blinking cursor, a crawl
 *   too slow to read as movement), which freezedetect lets through. Comparing across a second, not frame to frame,
 *   is what tells them apart from a slow fade or a slow move: real change builds up over the second, grain doesn't.
 * - Loop seam: for a video meant to loop, the change from its last frame back to its first, against how much the
 *   picture changes from one frame to the next inside the video. A seam well above both is a visible jump.
 *
 * Measured on 1080x1920 H.264 (FFmpeg 6.1.1, local sandbox, 2026-11-26), as the largest change from the picture a
 * second before: heavy grain on a still picture 0.31 (0.2 a frame, the same over a second: it doesn't build up); a
 * blinking cursor 0.14; text drifting at 20 px/s 0.63; text sliding at 300 px/s 3.7; a slow Ken Burns zoom (0.05 %
 * a frame) 13. MOTION_FLOOR sits just above the grain. Smaller frames average fewer pixels a cell: the same grain
 * reads 0.57 at 540x960, so a grainy still there is missed (a missed warning, never a false one).
 */
export const MOTION_GRID = 32;
const CELLS = MOTION_GRID * MOTION_GRID;

/** Default floor: a frame that differs from the picture a second before by less than this (8-bit luma levels on the grid) reads as still. */
export const MOTION_FLOOR = 0.4;
/** A loop seam is a jump when it is over this many levels (less is not visible) ... */
export const SEAM_MIN = 0.5;
/** ... and more than this many times the 95th percentile of the video's own frame-to-frame motion. */
export const SEAM_RATIO = 2;

export interface MotionStretch {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  /** The largest change from the picture a second before inside the stretch (8-bit luma levels). */
  peakMotion: number;
}

export interface LoopSeam {
  /** Mean absolute luma change from the last frame to the first (8-bit levels). */
  seamMotion: number;
  /** The 95th percentile of frame-to-frame motion inside the video: what a normal move or cut looks like. */
  typicalMotion: number;
  /** True when the seam is over SEAM_MIN and more than SEAM_RATIO times typicalMotion. */
  jump: boolean;
}

export interface MotionResult {
  frames: number;
  /** Mean motion in each second (the last second may be partial), rounded to 0.01. */
  energyPerSecond: number[];
  /** Stretches of at least `lowSeconds` that change less than `floor` across any second (empty when lowSeconds is 0). */
  lows: MotionStretch[];
  /** Only when `loop` was asked for. */
  loop?: LoopSeam;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function diff(grid: Uint8Array, a: number, b: number): number {
  let sum = 0;
  const oa = a * CELLS;
  const ob = b * CELLS;
  for (let c = 0; c < CELLS; c++) sum += Math.abs(grid[oa + c]! - grid[ob + c]!);
  return sum / CELLS;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))]!;
}

/** Motion energy, low-motion stretches and (with `loop`) the loop seam, from raw MOTION_GRID x MOTION_GRID gray frames. */
export function analyseMotion(grid: Uint8Array, fps: number, o: { floor: number; lowSeconds: number; loop?: boolean }): MotionResult {
  const frames = Math.floor(grid.length / CELLS);
  const motion = new Float64Array(frames); // motion[0] stays 0: the first frame has nothing before it
  for (let f = 1; f < frames; f++) motion[f] = diff(grid, f, f - 1);

  const perSecond = Math.max(1, Math.round(fps));
  const energyPerSecond: number[] = [];
  for (let s = 0; s * perSecond < frames; s++) {
    // From frame 1: frame 0 has no motion of its own and would pull the first second down.
    const from = Math.max(1, s * perSecond);
    const to = Math.min(frames, (s + 1) * perSecond);
    let sum = 0;
    for (let f = from; f < to; f++) sum += motion[f]!;
    energyPerSecond.push(to > from ? r2(sum / (to - from)) : 0);
  }

  const lows: MotionStretch[] = [];
  if (o.lowSeconds > 0 && frames > 1) {
    const minFrames = Math.ceil(o.lowSeconds * fps - 1e-9);
    // Compare each frame with the one a second before it (or the first frame, early on); a shorter window when the
    // stretch asked for is under a second.
    const window = Math.max(1, Math.round(fps * Math.min(1, o.lowSeconds)));
    let start = -1;
    let peak = 0;
    const close = (end: number) => {
      // Frames start..end-1 each match the picture `window` frames before, so the still pictures run from frame
      // start-window (or 0) to frame end-1, which shows until end / fps.
      const first = Math.max(0, start - window);
      if (end - first >= minFrames) lows.push({ startSeconds: r3(first / fps), endSeconds: r3(end / fps), durationSeconds: r3((end - first) / fps), peakMotion: r2(peak) });
      start = -1;
      peak = 0;
    };
    for (let f = 1; f < frames; f++) {
      const change = diff(grid, f, Math.max(0, f - window));
      if (change < o.floor) {
        if (start < 0) start = f;
        peak = Math.max(peak, change);
      } else if (start >= 0) close(f);
    }
    if (start >= 0) close(frames);
  }

  let loop: LoopSeam | undefined;
  if (o.loop && frames > 2) {
    const seamMotion = diff(grid, frames - 1, 0);
    const typicalMotion = percentile(Array.from(motion.subarray(1)), 0.95);
    loop = { seamMotion: r2(seamMotion), typicalMotion: r2(typicalMotion), jump: seamMotion > SEAM_MIN && seamMotion > SEAM_RATIO * typicalMotion };
  }
  return { frames, energyPerSecond, lows, ...(loop ? { loop } : {}) };
}
