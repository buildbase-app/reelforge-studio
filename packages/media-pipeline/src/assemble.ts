import { writeFile } from 'node:fs/promises';
import { mixGraph } from './audio';
import { H264_ARGS, PipelineError, run } from './ffmpeg';
import { probe } from './probe';

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
  fps: number;
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
 * count) and join them in order in a single FFmpeg pass, adding an AAC track:
 * the music if given, otherwise silence, so every export has audio.
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
  const totalSeconds = totalFrames / fps;
  const args: string[] = ['-hide_banner', '-y'];
  for (const clip of clips) args.push('-i', clip.file);

  const audio = audioInputs(opts, clips.length, totalSeconds);
  args.push(...audio.inputs);

  const filters: string[] = clips.map(
    (clip, i) =>
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
      `fps=${fps},format=yuv420p,trim=end_frame=${clip.frames},setpts=PTS-STARTPTS[v${i}]`
  );
  filters.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[vout]`);
  filters.push(...audio.filters);

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    ...audio.map,
    ...H264_ARGS,
    '-r',
    String(fps),
    '-frames:v',
    String(totalFrames),
    ...audio.codec,
    '-t',
    totalSeconds.toFixed(3),
    out
  );

  await run(ffmpeg, args, 'assemble', { signal: opts.signal });
  return { out, totalFrames, args };
}

export interface NormaliseOptions {
  ffmpeg: string;
  ffprobe: string;
  /** An engine's clip (any size, rate or pixel format; at least `frames` frames). */
  input: string;
  out: string;
  width: number;
  height: number;
  fps: number;
  /** Exact frames the scene occupies. */
  frames: number;
  signal?: AbortSignal;
}

/**
 * Encode one scene clip to the final encoding of a render (render fan-out,
 * D-097): the same scaling, padding, frame rate, pixel format and exact frame
 * count as assemble() applies to each clip, H264_ARGS (libx264 high, yuv420p:
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
    '-i',
    opts.input,
    '-vf',
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
      `fps=${fps},format=yuv420p,trim=end_frame=${frames},setpts=PTS-STARTPTS`,
    '-an',
    '-map_metadata',
    '-1',
    ...H264_ARGS,
    '-r',
    String(fps),
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
  fps: number;
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
  const totalSeconds = totalFrames / opts.fps;
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
    totalSeconds.toFixed(3),
    '-movflags',
    '+faststart',
    opts.out,
  ];
  await run(opts.ffmpeg, args, 'join', { signal: opts.signal });
  return { out: opts.out, totalFrames, args };
}

type AudioOptions = Pick<AssembleOptions, 'music' | 'voice' | 'sfx' | 'audioFile' | 'noAudio'>;

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
