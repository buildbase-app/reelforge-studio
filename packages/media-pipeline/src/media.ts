import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PipelineError, run } from './ffmpeg';
import { rateArg, type Rate } from './rate';

/**
 * Untrusted media for engines (#299): probe a user's image or video, and turn
 * a video into the exact pictures a scene shows, one per output frame.
 *
 * Both run FFmpeg/ffprobe as child processes with the environment the caller
 * gives (render processes get one without server secrets, D-086) and a time
 * limit, never inside the server process.
 */

/** A frame rate as a number (30, 29.97) or as FFmpeg writes it ("30000/1001"): the pipeline's `Rate` (rate.ts, #302). */
export type FrameRate = Rate;

const NTSC: Record<string, [number, number]> = {
  '23.976': [24000, 1001],
  '29.97': [30000, 1001],
  '47.952': [48000, 1001],
  '59.94': [60000, 1001],
  '119.88': [120000, 1001],
};

/**
 * A frame rate as an exact fraction. Whole numbers stay whole; the supported
 * rates, as labels (29.97) or as fpsValue() decimals, become the fraction
 * rateArg() gives FFmpeg (30000/1001), and other NTSC rates n*1000/1001, so
 * frame times do not drift over a long clip; "n/d" strings are taken as written.
 */
export function frameRateFraction(fps: FrameRate): { num: number; den: number } {
  if (typeof fps === 'string') {
    const m = /^\s*(\d+)(?:\s*\/\s*(\d+))?\s*$/.exec(fps);
    if (!m || Number(m[1]) <= 0 || (m[2] !== undefined && Number(m[2]) <= 0)) throw new PipelineError('fps', `not a frame rate: ${fps}`);
    return { num: Number(m[1]), den: m[2] === undefined ? 1 : Number(m[2]) };
  }
  if (!Number.isFinite(fps) || fps <= 0) throw new PipelineError('fps', `not a frame rate: ${fps}`);
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  // A supported rate, also as the decimal fpsValue() gives (29.97002997...): its exact fraction (rateArg, D-119).
  const exact = /^(\d+)\/(\d+)$/.exec(rateArg(fps));
  if (exact) return { num: Number(exact[1]), den: Number(exact[2]) };
  const ntsc = NTSC[(Math.round(fps * 1000) / 1000).toString()];
  if (ntsc) return { num: ntsc[0], den: ntsc[1] };
  return { num: Math.round(fps * 1000), den: 1000 };
}

/** Seconds at which frame `k` starts. */
export function frameSeconds(k: number, fps: FrameRate): number {
  const { num, den } = frameRateFraction(fps);
  return (k * den) / num;
}

export interface MediaProbe {
  width: number;
  height: number;
  codec: string;
  /** Container format name(s) as ffprobe reports them, e.g. "mov,mp4,m4a,3gp,3g2,mj2" or "png_pipe". */
  format: string;
  /** Video only: seconds, and the presentation time of the first frame (not always 0). */
  durationSeconds: number | null;
  startSeconds: number;
  /** Average frame rate of a video (0 for still images). */
  fps: number;
  /** Display rotation in degrees (phones store portrait video as rotated landscape). Width/height are as displayed. */
  rotation: number;
}

function rate(r: unknown): number {
  const [n, d] = String(r ?? '0').split('/').map(Number);
  return d ? (n ?? 0) / d : (n ?? 0);
}

/** Size, codec, duration and rotation of the first video (or picture) stream. */
export async function probeMedia(ffprobe: string, file: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<MediaProbe> {
  const { stdout } = await run(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,avg_frame_rate,r_frame_rate,start_time,duration:stream_side_data=rotation:stream_tags=rotate:format=duration,format_name',
      '-of',
      'json',
      file,
    ],
    'probe-media',
    { timeoutMs: opts.timeoutMs ?? 30_000, ...(opts.env ? { env: opts.env } : {}), ...(opts.signal ? { signal: opts.signal } : {}) }
  );
  const data = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown> & { side_data_list?: Array<{ rotation?: number }>; tags?: { rotate?: string } }>;
    format?: { duration?: string; format_name?: string };
  };
  const s = data.streams?.[0];
  if (!s || !Number(s.width) || !Number(s.height)) throw new PipelineError('probe-media', 'no picture or video stream found');
  const rotation = Number(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? s.tags?.rotate ?? 0) || 0;
  const turned = Math.abs(rotation) % 180 === 90;
  const duration = Number(s.duration ?? data.format?.duration);
  return {
    width: turned ? Number(s.height) : Number(s.width),
    height: turned ? Number(s.width) : Number(s.height),
    codec: String(s.codec_name ?? 'unknown'),
    format: String(data.format?.format_name ?? 'unknown'),
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    startSeconds: Number(s.start_time) || 0,
    fps: rate(s.avg_frame_rate) || rate(s.r_frame_rate),
    rotation,
  };
}

export interface VideoFramesAtOptions {
  ffmpeg: string;
  input: string;
  /** Directory for the frames (created): 000001.jpg, 000002.jpg, ... */
  dir: string;
  /** The scene's frame rate. */
  fps: FrameRate;
  /** Scene frame that the first picture is for (a frame range's first frame; 0 for a whole scene). */
  first?: number;
  /** How many pictures. */
  count: number;
  /** Seconds into the clip that scene frame 0 shows (the clip's in-point). */
  mediaStart?: number;
  /** The clip's first presentation time (probeMedia().startSeconds): in-points count from the first frame. */
  sourceStart?: number;
  /** Pictures are scaled down (never up) to fit this box. */
  maxWidth?: number;
  maxHeight?: number;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * The pictures a scene shows of a video clip, one per output frame, so every
 * engine places video as a plain image and needs no codec in its browser.
 *
 * Picture k is the clip at `mediaStart + (first + k) / fps` seconds (from its
 * first frame), taken by FFmpeg's `fps` filter on an exact grid that starts
 * there: the source frame within half an output frame of that time, so a clip
 * at 23.976 or 29.97 fps never drifts against the scene, whatever the scene's
 * rate. Variable frame rate clips are resampled onto the same grid, rotation
 * is applied, and a clip shorter than the scene holds its last frame.
 */
export async function videoFramesAt(o: VideoFramesAtOptions): Promise<string[]> {
  if (!Number.isInteger(o.count) || o.count < 1) throw new PipelineError('video-frames', `count must be a positive integer (got ${o.count})`);
  const { num, den } = frameRateFraction(o.fps);
  const t0 = (o.sourceStart ?? 0) + (o.mediaStart ?? 0) + ((o.first ?? 0) * den) / num;
  await mkdir(o.dir, { recursive: true });
  // A fast input seek to shortly before the in-point, original timestamps kept (-copyts), and the
  // output grid anchored at the exact in-point (fps start_time), so the seek never moves a frame.
  const pre = Math.max(0, t0 - 2);
  const w = Math.max(2, Math.floor(o.maxWidth ?? 4096));
  const h = Math.max(2, Math.floor(o.maxHeight ?? 4096));
  const args = [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-y',
    ...(pre > 0 ? ['-ss', pre.toFixed(6)] : []),
    '-copyts',
    '-i',
    o.input,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `fps=${num}/${den}:start_time=${t0.toFixed(6)},tpad=stop_mode=clone:stop=-1,scale=w='min(iw,${w})':h='min(ih,${h})':force_original_aspect_ratio=decrease`,
    '-frames:v',
    String(o.count),
    '-q:v',
    '2',
    join(o.dir, '%06d.jpg'),
  ];
  await run(o.ffmpeg, args, 'video-frames', {
    timeoutMs: o.timeoutMs ?? 60_000 + o.count * 200,
    ...(o.env ? { env: o.env } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const files = (await readdir(o.dir)).filter((f) => /^\d{6}\.jpg$/.test(f)).sort();
  if (files.length !== o.count) {
    throw new PipelineError('video-frames', `expected ${o.count} pictures from the clip, got ${files.length} (does the clip start before ${(t0 - (o.sourceStart ?? 0)).toFixed(3)} s?)`);
  }
  return files.map((f) => join(o.dir, f));
}
