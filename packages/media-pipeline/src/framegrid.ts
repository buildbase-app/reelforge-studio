import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { run } from './ffmpeg';

/**
 * One frame of a video as a coarse luma grid, and the difference between two such grids: what the seek check (#294)
 * compares a frame rendered on its own ("cold") with the same frame of the full render by.
 *
 * Measured with Remotion's kinetic-title (FFmpeg 6.1.1, local sandbox, 2026-11-26): the same frame encoded in the
 * full render and alone differs by at most 3 levels on this grid at 1920x1080 and 1080x1920, 7 at 540x960 and 10 at
 * 320x568 (encoding noise); the frame before it, where the picture moves, by 16 to 71. SEEK_MAX_DIFF sits between.
 */
export const SEEK_GRID = 64;
/** The largest difference of one grid cell (8-bit luma levels) that still counts as the same picture. */
export const SEEK_MAX_DIFF = 24;

/** Frame `frame` (counted from 0 at `fps`) of `input` as SEEK_GRID x SEEK_GRID area-averaged 8-bit luma cells. */
export async function frameGrid(o: { ffmpeg: string; input: string; frame: number; fps: number; signal?: AbortSignal }): Promise<Uint8Array> {
  const file = join(dirname(o.input), `.seek-grid-${randomBytes(4).toString('hex')}.gray`);
  // An accurate seek to half a frame before the one wanted: the first frame decoded from there is that frame.
  const seek = o.frame > 0 ? ['-ss', ((o.frame - 0.5) / o.fps).toFixed(6)] : [];
  try {
    await run(o.ffmpeg, ['-hide_banner', '-v', 'error', ...seek, '-i', o.input, '-map', '0:v:0', '-vf', `scale=${SEEK_GRID}:${SEEK_GRID}:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-y', file], 'qa:seek', { signal: o.signal });
    const grid = await readFile(file);
    if (grid.length !== SEEK_GRID * SEEK_GRID) throw new Error(`frame ${o.frame} of ${o.input} could not be read (${grid.length} bytes)`);
    return grid;
  } finally {
    await rm(file, { force: true });
  }
}

/** Mean and largest absolute difference of two grids of the same size, in 8-bit levels (mean rounded to 0.01). */
export function gridDifference(a: Uint8Array, b: Uint8Array): { meanDiff: number; maxDiff: number } {
  if (a.length !== b.length || a.length === 0) throw new Error(`grids differ in size (${a.length} and ${b.length})`);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    sum += d;
    if (d > max) max = d;
  }
  return { meanDiff: Math.round((sum / a.length) * 100) / 100, maxDiff: max };
}
