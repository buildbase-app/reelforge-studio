import { rm, writeFile } from 'node:fs/promises';
import { mixGraph } from './audio';
import { filterThreadArgs, h264Args, inputThreadArgs, PipelineError, run } from './ffmpeg';
import type { MasterEncoding } from './formats';
import { probe } from './probe';
import { rateArg, rateValue, type Rate } from './rate';

/**
 * A duration for FFmpeg's -t and atrim, to the microsecond: NTSC timelines
 * (frames x 1001 / 30000) do not end on a millisecond, and rounding to one
 * made the audio up to half a millisecond longer than the video (#302).
 */
const exactSeconds = (s: number) => s.toFixed(6);

export interface ClipInput {
  sceneId: string;
  file: string;
  /** Exact number of frames this scene must occupy in the final video. */
  frames: number;
}

export interface AssembleOptions {
  ffmpeg: string;
  ffprobe: string;
  clips: ClipInput[];
  out: string;
  width: number;
  height: number;
  /** Frame rate: a number or an exact "num/den" (e.g. "30000/1001"). */
  fps: Rate;
  /** Optional music file the user has rights to use. Trimmed and faded to fit. */
  music?: { file: string; volume: number; fadeOutSeconds?: number } | null;
  /** Optional voice-over, mixed on top of the music, starting at `startSeconds`. */
  voice?: { file: string; volume: number; startSeconds?: number } | null;
  /** Optional sound effects, each starting at `atSeconds`. */
  sfx?: Array<{ file: string; volume: number; atSeconds: number }>;
  /**
   * A finished audio track (mixAudio + normaliseLoudness, the render
   * pipeline's path) of the timeline's length: encoded as is, and music,
   * voice and sfx are ignored. Unset: they are mixed here (mixGraph).
   */
  audioFile?: string | null;
  /** No audio stream at all (a muted render with render.audio.mutedTrack "none"). */
  noAudio?: boolean;
  /**
   * Another output format (#302, formatPlan().master): its video encoder,
   * pixel format, pad colour and audio encoder (null: the format has no
   * audio, as with noAudio). Omitted: H.264 (h264Args) + AAC.
   */
  encoding?: Pick<MasterEncoding, 'pixFmt' | 'padColor' | 'video' | 'audio'>;
  signal?: AbortSignal;
}

export interface AssembleResult {
  out: string;
  totalFrames: number;
  /** The exact FFmpeg arguments used, for the render manifest. */
  args: string[];
}

/**
 * Normalise every scene clip (size, frame rate, pixel format, exact frame
 * count) and join them in order: one FFmpeg pass for the video (H.264, or
 * the format's encoder with `encoding`, #302), then a second that muxes the
 * audio (the finished track, the mix, or silence) with the video copied. No
 * second pass with `noAudio` or a format without audio (GIF, PNG masters).
 *
 * A clip shorter than its scene is an error, not something to pad silently
 * (ARCHITECTURE §2, "Detect missing media and fail clearly").
 */
export async function assemble(opts: AssembleOptions): Promise<AssembleResult> {
  const { ffmpeg, ffprobe, clips, out, width, height, fps } = opts;
  if (clips.length === 0) throw new PipelineError('assemble', 'no clips to assemble');

  for (const clip of clips) {
    const info = await probe(ffprobe, clip.file);
    if (info.frames < clip.frames) {
      throw new PipelineError(
        'assemble',
        `scene "${clip.sceneId}" rendered ${info.frames} frames but needs ${clip.frames} (${clip.file})`
      );
    }
  }

  const totalFrames = clips.reduce((n, c) => n + c.frames, 0);
  const totalSeconds = totalFrames / rateValue(fps);
  const enc = opts.encoding;
  // Video first, without audio; the audio is muxed in a second pass. FFmpeg 5.1 (the release image's Debian build)
  // ends every stream of an output once one stream reaches its -frames limit, which cut the audio short by the
  // video encoder's delay (a 2 s video got 1.962 s of audio); FFmpeg 6 does not. A separate mux works on both,
  // and for every container (#302: MOV with PCM, WebM with Opus). GIF and PNG masters have no audio pass.
  const withAudio = !opts.noAudio && (!enc || enc.audio !== null);
  const videoOut = withAudio ? out.replace(/(\.[^./]+)?$/, '.video$1') : out;
  const args: string[] = ['-hide_banner', '-y', ...filterThreadArgs()];
  for (const clip of clips) args.push(...inputThreadArgs(), '-i', clip.file);

  const filters: string[] = clips.map(
    (clip, i) =>
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${enc?.padColor ?? 'black'},setsar=1,` +
      `fps=${rateArg(fps)},format=${enc?.pixFmt ?? 'yuv420p'},trim=end_frame=${clip.frames},setpts=PTS-STARTPTS[v${i}]`
  );
  filters.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[vout]`);

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    ...(enc ? enc.video : h264Args()),
    '-r',
    rateArg(fps),
    '-frames:v',
    String(totalFrames),
    '-an',
    '-t',
    exactSeconds(totalSeconds),
    videoOut
  );

  await run(ffmpeg, args, 'assemble', { signal: opts.signal });
  if (!withAudio) return { out, totalFrames, args };
  try {
    const muxArgs = await muxAudio({ ...opts, video: videoOut, totalSeconds, ...(enc?.audio ? { codec: enc.audio } : {}) });
    // Both commands, for the render manifest.
    return { out, totalFrames, args: [...args, '&&', ...muxArgs] };
  } finally {
    await rm(videoOut, { force: true });
  }
}

/**
 * Add the audio to a video-only file: the video stream copied, the audio (a
 * finished track or the mix graph) encoded to AAC, or to `codec` for another
 * container (#302: PCM in MOV, Opus in WebM). No frame limit, so the audio
 * keeps its full length on every FFmpeg version (`-t` only trims a longer
 * track to the video); both streams start at 0.
 */
async function muxAudio(o: AudioOptions & { ffmpeg: string; video: string; out: string; totalSeconds: number; codec?: string[]; signal?: AbortSignal }): Promise<string[]> {
  const audio = audioInputs(o, 1, o.totalSeconds);
  const args = [
    '-hide_banner',
    '-y',
    '-i',
    o.video,
    ...audio.inputs,
    ...(audio.filters.length ? ['-filter_complex', audio.filters.join(';')] : []),
    '-map',
    '0:v',
    ...audio.map,
    '-c:v',
    'copy',
    ...(o.codec ?? audio.codec),
    '-t',
    exactSeconds(o.totalSeconds),
    // movflags is an option of the MP4/MOV muxers only; the WebM muxer refuses it.
    ...(isMovFamily(o.out) ? ['-movflags', '+faststart'] : []),
    o.out,
  ];
  await run(o.ffmpeg, args, 'assemble:audio', { signal: o.signal });
  return args;
}

const isMovFamily = (file: string) => /\.(mp4|m4a|mov)$/i.test(file);

export interface NormaliseOptions {
  ffmpeg: string;
  ffprobe: string;
  /** An engine's clip (any size, rate or pixel format; at least `frames` frames). */
  input: string;
  out: string;
  width: number;
  height: number;
  fps: Rate;
  /** Exact frames the scene occupies. */
  frames: number;
  signal?: AbortSignal;
}

/**
 * Encode one scene clip to the final encoding of a render (render fan-out,
 * D-097): the same scaling, padding, frame rate, pixel format and exact frame
 * count as assemble() applies to each clip, h264Args() (libx264 high, yuv420p:
 * every run starts with an IDR frame and closes its last GOP), video only, and
 * the MP4 muxer's time base for that rate (the same as the single-worker
 * output). Clips encoded this way by the same FFmpeg build can be joined by
 * concatClips() without re-encoding.
 */
export async function normaliseClip(opts: NormaliseOptions): Promise<{ out: string; args: string[] }> {
  const { width, height, fps, frames } = opts;
  const info = await probe(opts.ffprobe, opts.input);
  if (info.frames < frames) throw new PipelineError('normalise', `clip has ${info.frames} frames, needs ${frames} (${opts.input})`);
  const args = [
    '-hide_banner',
    '-y',
    ...filterThreadArgs(),
    ...inputThreadArgs(),
    '-i',
    opts.input,
    '-vf',
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
      `fps=${rateArg(fps)},format=yuv420p,trim=end_frame=${frames},setpts=PTS-STARTPTS`,
    '-an',
    '-map_metadata',
    '-1',
    ...h264Args(),
    '-r',
    rateArg(fps),
    '-frames:v',
    String(frames),
    opts.out,
  ];
  await run(opts.ffmpeg, args, 'normalise', { signal: opts.signal });
  return { out: opts.out, args };
}

export interface ConcatOptions extends AudioOptions {
  ffmpeg: string;
  /** Normalised clips (normaliseClip) in timeline order, with their exact frame counts. */
  clips: Array<{ file: string; frames: number }>;
  out: string;
  fps: Rate;
  /** Where to write the concat demuxer's list. */
  listFile: string;
  signal?: AbortSignal;
}

/**
 * Join normalised clips with the concat demuxer and stream copy (`-c:v copy`:
 * the video is not encoded again), and mix the audio once over the whole
 * timeline (the same graph as assemble()). The demuxer needs "the same streams
 * (same codecs, same time base, etc.)" in every file (ffmpeg-formats); the
 * caller checks that with streamParams() first.
 */
export async function concatClips(opts: ConcatOptions): Promise<AssembleResult> {
  if (opts.clips.length === 0) throw new PipelineError('join', 'no clips to join');
  const totalFrames = opts.clips.reduce((n, c) => n + c.frames, 0);
  const totalSeconds = totalFrames / rateValue(opts.fps);
  await writeFile(opts.listFile, opts.clips.map((c) => `file '${c.file.replace(/'/g, "'\\''")}'\n`).join(''));
  const audio = audioInputs(opts, 1, totalSeconds);
  const args = [
    '-hide_banner',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    opts.listFile,
    ...audio.inputs,
    ...(audio.filters.length ? ['-filter_complex', audio.filters.join(';')] : []),
    '-map',
    '0:v',
    ...audio.map,
    '-c:v',
    'copy',
    ...audio.codec,
    '-t',
    exactSeconds(totalSeconds),
    '-movflags',
    '+faststart',
    opts.out,
  ];
  await run(opts.ffmpeg, args, 'join', { signal: opts.signal });
  return { out: opts.out, totalFrames, args };
}

type AudioOptions = Pick<AssembleOptions, 'music' | 'voice' | 'sfx' | 'audioFile' | 'noAudio'>;

export interface EncodeAudioOptions {
  ffmpeg: string;
  /** The finished track (the render's mixAudio + normaliseLoudness WAV). */
  input: string;
  out: string;
  /** Length of the timeline in seconds (the file is exactly this long). */
  seconds: number;
  /** Audio encoder arguments, e.g. ['-c:a', 'aac', '-b:a', '192k']. */
  codecArgs: string[];
  signal?: AbortSignal;
}

/**
 * Audio-only output (#302: m4a, wav): the render's finished track (the same
 * mix and loudness normalisation as a video's audio, D-116) encoded without
 * pictures. No video pass at all.
 */
export async function encodeAudioOnly(opts: EncodeAudioOptions): Promise<{ out: string; args: string[] }> {
  const args = [
    '-hide_banner',
    '-y',
    '-i',
    opts.input,
    '-map',
    '0:a:0',
    '-vn',
    ...opts.codecArgs,
    '-ar',
    '48000',
    '-t',
    exactSeconds(opts.seconds),
    ...(isMovFamily(opts.out) ? ['-movflags', '+faststart'] : []),
    opts.out,
  ];
  await run(opts.ffmpeg, args, 'assemble:audio', { signal: opts.signal });
  return { out: opts.out, args };
}

/**
 * The audio side of assemble() and the fan-out join (concatClips), inputs
 * numbered from `audioIndex`: a finished track mapped as is, no audio, or the
 * mix graph (music or silence, voice and sfx on top) ending in `[aout]` of
 * exactly `totalSeconds`. Both paths encode the same AAC.
 */
function audioInputs(opts: AudioOptions, audioIndex: number, totalSeconds: number): { inputs: string[]; filters: string[]; map: string[]; codec: string[] } {
  const codec = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
  if (opts.noAudio) return { inputs: [], filters: [], map: [], codec: ['-an'] };
  if (opts.audioFile) return { inputs: ['-i', opts.audioFile], filters: [], map: ['-map', `${audioIndex}:a:0`], codec };
  const graph = mixGraph({ totalSeconds, music: opts.music ?? null, voice: opts.voice ?? null, sfx: opts.sfx ?? [] }, audioIndex);
  return { ...graph, map: ['-map', '[aout]'], codec };
}

/**
 * Extract single frames (PNG) for visual review, e.g. around scene boundaries
 * to spot black frames, flashes or scaling errors (TEST_PLAN §2).
 */
export async function extractFrames(
  ffmpeg: string,
  file: string,
  frames: number[],
  outPattern: (frame: number) => string
): Promise<string[]> {
  const written: string[] = [];
  for (const frame of frames) {
    const target = outPattern(frame);
    await run(
      ffmpeg,
      [
        '-hide_banner',
        '-y',
        '-i',
        file,
        '-vf',
        `select=eq(n\\,${frame})`,
        '-vsync',
        '0',
        '-frames:v',
        '1',
        target,
      ],
      'frames'
    );
    written.push(target);
  }
  return written;
}
