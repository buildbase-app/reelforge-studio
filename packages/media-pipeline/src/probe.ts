import { PipelineError, run } from './ffmpeg';

export interface MediaInfo {
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationSeconds: number;
  videoCodec: string;
  pixelFormat: string;
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
      'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,pix_fmt,sample_rate,channels:format=duration',
      '-of',
      'json',
      file,
    ],
    'probe'
  );
  const data = JSON.parse(stdout) as {
    streams: Array<Record<string, string | number | undefined>>;
    format?: { duration?: string };
  };
  const video = data.streams.find((s) => s.codec_type === 'video');
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new PipelineError('probe', `${file} has no video stream`);
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps: parseRate(String(video.avg_frame_rate ?? video.r_frame_rate)),
    frames: Number(video.nb_read_frames),
    durationSeconds: Number(data.format?.duration ?? 0),
    videoCodec: String(video.codec_name),
    pixelFormat: String(video.pix_fmt),
    hasAudio: Boolean(audio),
    audioCodec: audio ? String(audio.codec_name) : null,
    audioSampleRate: audio ? Number(audio.sample_rate) : null,
    audioChannels: audio ? Number(audio.channels) : null,
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
  fps: number;
  frames: number;
  audio?: boolean;
}

/** Compare probed metadata with what the manifest asked for. Returns problems. */
export function checkExpectation(info: MediaInfo, want: Expectation): string[] {
  const problems: string[] = [];
  if (info.width !== want.width || info.height !== want.height) {
    problems.push(`size is ${info.width}x${info.height}, expected ${want.width}x${want.height}`);
  }
  if (Math.abs(info.fps - want.fps) > 0.01) problems.push(`fps is ${info.fps}, expected ${want.fps}`);
  if (info.frames !== want.frames) problems.push(`frame count is ${info.frames}, expected ${want.frames}`);
  if (info.videoCodec !== 'h264') problems.push(`video codec is ${info.videoCodec}, expected h264`);
  if (info.pixelFormat !== 'yuv420p') problems.push(`pixel format is ${info.pixelFormat}, expected yuv420p`);
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
export async function checkTimestamps(ffprobe: string, file: string, frames: number, fps: number): Promise<string[]> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base:packet=pts,flags', '-of', 'json', file], 'probe');
  const data = JSON.parse(stdout) as { packets?: Array<{ pts?: number; flags?: string }>; streams?: Array<{ time_base?: string }> };
  const packets = data.packets ?? [];
  const [num, den] = String(data.streams?.[0]?.time_base ?? '1/1').split('/').map(Number);
  const step = den! / (num! * fps);
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
