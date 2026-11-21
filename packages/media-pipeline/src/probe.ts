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
