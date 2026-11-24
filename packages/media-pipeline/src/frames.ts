import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PipelineError, run } from './ffmpeg';
import { rateArg } from './rate';

export interface VideoFramesOptions {
  ffmpeg: string;
  /** Any video FFmpeg can decode. */
  input: string;
  /** Directory for the frames (created): 000001.jpg, 000002.jpg, ... */
  dir: string;
  /** Output frame rate, as FFmpeg reads it (`30`, `30000/1001`). */
  fps: number | string;
  /** Exactly this many frames are written. */
  frames: number;
  /** Where in the video frame 1 is taken from. */
  startSeconds?: number;
  /** Frames are scaled down (never up) to fit a square of this many pixels. */
  maxSide?: number;
  signal?: AbortSignal;
}

/**
 * The frames of a video at a scene's frame rate, for engines that place video
 * as pictures (layout panes, #287): resampled to `fps` from `startSeconds`, and
 * a video shorter than the scene holds its last frame (`tpad` clone), so frame
 * k is always the picture at `startSeconds + k / fps`. Returns the files in
 * order.
 */
export async function extractVideoFrames(o: VideoFramesOptions): Promise<string[]> {
  await mkdir(o.dir, { recursive: true });
  const max = o.maxSide ?? 4096;
  const args = [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    ...(o.startSeconds ? ['-ss', String(o.startSeconds)] : []),
    '-i',
    o.input,
    '-an',
    '-vf',
    `fps=${rateArg(o.fps)},tpad=stop_mode=clone:stop=-1,scale='min(iw,${max})':'min(ih,${max})':force_original_aspect_ratio=decrease`,
    '-frames:v',
    String(o.frames),
    '-q:v',
    '3',
    join(o.dir, '%06d.jpg'),
  ];
  await run(o.ffmpeg, args, 'video-frames', { signal: o.signal });
  const files = (await readdir(o.dir)).filter((f) => f.endsWith('.jpg')).sort();
  if (files.length !== o.frames) {
    throw new PipelineError('video-frames', `expected ${o.frames} frames from ${o.input}, got ${files.length} (does the video start before ${o.startSeconds ?? 0}s?)`);
  }
  return files.map((f) => join(o.dir, f));
}
