import { PipelineError, run } from './ffmpeg';
import { rateFraction, rateValue, type Rate } from './rate';

export interface MediaInfo {
  width: number;
  height: number;
  /** Average frame rate as a number. */
  fps: number;
  /** The stream's r_frame_rate exactly as ffprobe reports it, e.g. "30000/1001". */
  frameRate: string;
  frames: number;
  durationSeconds: number;
  videoCodec: string;
  pixelFormat: string;
  /** Codec profile as ffprobe names it (ProRes: "HQ", "4444"). */
  videoProfile?: string;
  /** WebM VP9 with an alpha stream carries the tag alpha_mode=1. */
  alphaMode?: boolean;
  hasAudio: boolean;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  return d ? (n ?? 0) / d : (n ?? 0);
}

/**
 * Read stream metadata with ffprobe. `-count_frames` decodes the whole video
 * stream, so the frame count is exact rather than estimated from the header.
 */
export async function probe(ffprobe: string, file: string): Promise<MediaInfo> {
  const { stdout } = await run(
    ffprobe,
    [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=codec_type,codec_name,profile,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,pix_fmt,sample_rate,channels:stream_tags=alpha_mode:format=duration',
      '-of',
      'json',
      file,
    ],
    'probe'
  );
  const data = JSON.parse(stdout) as {
    streams: Array<Record<string, string | number | undefined> & { tags?: Record<string, string> }>;
    format?: { duration?: string };
  };
  const video = data.streams.find((s) => s.codec_type === 'video');
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new PipelineError('probe', `${file} has no video stream`);
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps: parseRate(String(video.avg_frame_rate ?? video.r_frame_rate)),
    frameRate: String(video.r_frame_rate ?? video.avg_frame_rate ?? ''),
    frames: Number(video.nb_read_frames),
    durationSeconds: Number(data.format?.duration ?? 0),
    videoCodec: String(video.codec_name),
    pixelFormat: String(video.pix_fmt),
    ...(video.profile !== undefined ? { videoProfile: String(video.profile) } : {}),
    ...(video.tags?.alpha_mode !== undefined || video.tags?.ALPHA_MODE !== undefined ? { alphaMode: (video.tags.alpha_mode ?? video.tags.ALPHA_MODE) === '1' } : {}),
    hasAudio: Boolean(audio),
    audioCodec: audio ? String(audio.codec_name) : null,
    audioSampleRate: audio ? Number(audio.sample_rate) : null,
    audioChannels: audio ? Number(audio.channels) : null,
  };
}

/** An audio-only file (m4a, wav): its first audio stream and duration. */
export async function probeAudio(ffprobe: string, file: string): Promise<{ hasVideo: boolean; audioCodec: string | null; sampleRate: number | null; channels: number | null; durationSeconds: number }> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels:format=duration', '-of', 'json', file], 'probe');
  const data = JSON.parse(stdout) as { streams: Array<Record<string, string | number | undefined>>; format?: { duration?: string } };
  const a = data.streams.find((s) => s.codec_type === 'audio');
  return {
    hasVideo: data.streams.some((s) => s.codec_type === 'video'),
    audioCodec: a ? String(a.codec_name) : null,
    sampleRate: a ? Number(a.sample_rate) : null,
    channels: a ? Number(a.channels) : null,
    durationSeconds: Number(data.format?.duration ?? 0),
  };
}

/**
 * Fully decode a file and fail on any decoder error. Catches truncated or
 * corrupt output that metadata alone would not reveal (TEST_PLAN §2).
 */
export async function assertDecodable(ffmpeg: string, file: string): Promise<void> {
  const { stderr } = await run(
    ffmpeg,
    ['-hide_banner', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'],
    'decode'
  );
  if (stderr.trim()) throw new PipelineError('decode', `decoder reported errors for ${file}`, stderr);
}

export interface Expectation {
  width: number;
  height: number;
  /** A number or an exact "num/den" (e.g. "30000/1001"). */
  fps: Rate;
  frames: number;
  audio?: boolean;
  /** Expected video codec (default h264) and pixel formats (default yuv420p), for other output formats (#302). */
  videoCodec?: string;
  pixelFormats?: readonly string[];
  /** Also require r_frame_rate to be exactly this rate (the final output; engine clips are normalised later). */
  exactRate?: boolean;
}

/** Compare probed metadata with what the manifest asked for. Returns problems. */
export function checkExpectation(info: MediaInfo, want: Expectation): string[] {
  const problems: string[] = [];
  if (info.width !== want.width || info.height !== want.height) {
    problems.push(`size is ${info.width}x${info.height}, expected ${want.width}x${want.height}`);
  }
  if (Math.abs(info.fps - rateValue(want.fps)) > 0.01) problems.push(`fps is ${info.fps}, expected ${want.fps}`);
  if (want.exactRate && info.frameRate !== rateFraction(want.fps)) problems.push(`r_frame_rate is ${info.frameRate}, expected ${rateFraction(want.fps)}`);
  if (info.frames !== want.frames) problems.push(`frame count is ${info.frames}, expected ${want.frames}`);
  const codec = want.videoCodec ?? 'h264';
  const pixFmts = want.pixelFormats ?? ['yuv420p'];
  if (info.videoCodec !== codec) problems.push(`video codec is ${info.videoCodec}, expected ${codec}`);
  if (!pixFmts.includes(info.pixelFormat)) problems.push(`pixel format is ${info.pixelFormat}, expected ${pixFmts.join(' or ')}`);
  if (want.audio === true && !info.hasAudio) problems.push('expected an audio stream, found none');
  if (want.audio === false && info.hasAudio) problems.push('expected no audio stream, found one');
  return problems;
}

export interface FrameStats {
  yMin: number;
  yMax: number;
  yAvg: number;
}

/**
 * Luma statistics of one frame (FFmpeg signalstats). A frame whose yMax and
 * yMin are close is visually empty (a flat colour), e.g. a blank first frame.
 */
export async function frameStats(ffmpeg: string, file: string, frame: number): Promise<FrameStats> {
  const { stdout } = await run(
    ffmpeg,
    [
      '-hide_banner',
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${frame}),signalstats,metadata=print:file=-`,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ],
    'frame-stats'
  );
  const get = (k: string) => {
    const m = new RegExp(`lavfi\\.signalstats\\.${k}=([0-9.]+)`).exec(stdout);
    if (!m) throw new PipelineError('frame-stats', `no ${k} for frame ${frame} of ${file}`);
    return Number(m[1]);
  };
  return { yMin: get('YMIN'), yMax: get('YMAX'), yAvg: get('YAVG') };
}

/** Video stream parameters that must match for a stream-copy join (concat demuxer). */
export interface StreamParams {
  codec: string;
  profile: string;
  pixelFormat: string;
  width: number;
  height: number;
  sampleAspectRatio: string;
  frameRate: string;
  timeBase: string;
  /** Other streams in the file (a normalised clip has none). */
  otherStreams: number;
}

export async function streamParams(ffprobe: string, file: string): Promise<StreamParams> {
  const { stdout } = await run(
    ffprobe,
    ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,profile,pix_fmt,width,height,sample_aspect_ratio,r_frame_rate,time_base', '-of', 'json', file],
    'probe'
  );
  const streams = (JSON.parse(stdout) as { streams: Array<Record<string, string | number | undefined>> }).streams;
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) throw new PipelineError('probe', `${file} has no video stream`);
  return {
    codec: String(v.codec_name),
    profile: String(v.profile),
    pixelFormat: String(v.pix_fmt),
    width: Number(v.width),
    height: Number(v.height),
    sampleAspectRatio: String(v.sample_aspect_ratio ?? '1:1'),
    frameRate: String(v.r_frame_rate),
    timeBase: String(v.time_base),
    otherStreams: streams.length - 1,
  };
}

/**
 * Check a video's timestamps without decoding: `frames` packets whose sorted
 * presentation times step by exactly one frame (no duplicated or missing
 * frame, e.g. at a joined clip's boundary), the first at 0, and a key frame
 * first. Returns problems (empty: fine).
 */
export async function checkTimestamps(ffprobe: string, file: string, frames: number, fps: Rate): Promise<string[]> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base:packet=pts,flags', '-of', 'json', file], 'probe');
  const data = JSON.parse(stdout) as { packets?: Array<{ pts?: number; flags?: string }>; streams?: Array<{ time_base?: string }> };
  const packets = data.packets ?? [];
  const [num, den] = String(data.streams?.[0]?.time_base ?? '1/1').split('/').map(Number);
  const step = den! / (num! * rateValue(fps));
  const problems: string[] = [];
  if (packets.length !== frames) problems.push(`${packets.length} video packets, expected ${frames}`);
  if (packets[0] && !String(packets[0].flags ?? '').startsWith('K')) problems.push('the first video packet is not a key frame');
  const pts = packets.map((p) => Number(p.pts)).sort((a, b) => a - b);
  if (pts.length && pts[0] !== 0) problems.push(`the first frame is at pts ${pts[0]}, expected 0`);
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i]! - pts[i - 1]!;
    if (Math.abs(d - step) > 0.5) {
      problems.push(`frame ${i} is ${d} ticks after frame ${i - 1}, expected ${step} (a duplicated or missing frame)`);
      break;
    }
  }
  return problems;
}

/** Durations of the first video and audio streams (seconds; audio null when there is none). */
export async function avDurations(ffprobe: string, file: string): Promise<{ video: number; audio: number | null }> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', file], 'probe');
  const streams = (JSON.parse(stdout) as { streams: Array<{ codec_type?: string; duration?: string }> }).streams;
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  return { video: Number(v?.duration ?? 0), audio: a ? Number(a.duration ?? 0) : null };
}

/**
 * Per-frame luma PSNR (dB) of every frame of `file` against the frames of
 * `reference` starting at frame `from` (FFmpeg psnr): frame k of `file` is
 * compared with frame `from + k` of `reference`. Shows that a frame-range
 * render has the same pictures as the whole render, frame for frame (a
 * duplicated, missing or shifted frame drops it). Identical frames: Infinity.
 */
export async function framePsnr(ffmpeg: string, reference: string, file: string, from = 0): Promise<number[]> {
  const { stdout } = await run(
    ffmpeg,
    [
      '-hide_banner',
      '-v',
      'error',
      '-i',
      file,
      '-i',
      reference,
      '-filter_complex',
      `[1:v]trim=start_frame=${from},setpts=PTS-STARTPTS,format=yuv420p[ref];[0:v]setpts=PTS-STARTPTS,format=yuv420p[x];[x][ref]psnr=stats_file=-:shortest=1`,
      '-f',
      'null',
      '-',
    ],
    'psnr'
  );
  return [...stdout.matchAll(/psnr_y:(\S+)/g)].map((m) => (m[1] === 'inf' ? Infinity : Number(m[1])));
}

/** Indexes (in presentation order) of the key frames of the first video stream. */
export async function keyFrames(ffprobe: string, file: string): Promise<number[]> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts,flags', '-of', 'json', file], 'probe');
  const packets = ((JSON.parse(stdout) as { packets?: Array<{ pts?: number; flags?: string }> }).packets ?? []).map((p) => ({ pts: Number(p.pts), key: String(p.flags ?? '').startsWith('K') }));
  const order = [...packets].sort((a, b) => a.pts - b.pts);
  return order.flatMap((p, i) => (p.key ? [i] : []));
}
