import { writeFile } from 'node:fs/promises';
import { H264_ARGS, PipelineError, run } from './ffmpeg';
import type { MasterEncoding } from './formats';
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
  /** Another output format (#302, formatPlan().master): its encoder, pixel format and audio. Omitted: H.264 + AAC. */
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

  const audioIndex = clips.length;
  const enc = opts.encoding;
  const withAudio = !enc || enc.audio !== null;
  const audio = withAudio ? audioGraph(opts, audioIndex, totalSeconds) : { inputs: [], filters: [] };
  args.push(...audio.inputs);

  const filters: string[] = clips.map(
    (clip, i) =>
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${enc?.padColor ?? 'black'},setsar=1,` +
      `fps=${fps},format=${enc?.pixFmt ?? 'yuv420p'},trim=end_frame=${clip.frames},setpts=PTS-STARTPTS[v${i}]`
  );
  filters.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[vout]`);
  filters.push(...audio.filters);

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    ...(withAudio ? ['-map', '[aout]'] : []),
    ...(enc ? enc.video : H264_ARGS),
    '-r',
    String(fps),
    '-frames:v',
    String(totalFrames),
    ...(enc ? (enc.audio ?? ['-an']) : ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']),
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
  const audio = audioGraph(opts, 1, totalSeconds);
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
    '-filter_complex',
    audio.filters.join(';'),
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-t',
    totalSeconds.toFixed(3),
    '-movflags',
    '+faststart',
    opts.out,
  ];
  await run(opts.ffmpeg, args, 'join', { signal: opts.signal });
  return { out: opts.out, totalFrames, args };
}

type AudioOptions = Pick<AssembleOptions, 'music' | 'voice' | 'sfx'>;

export interface MixAudioOptions extends AudioOptions {
  ffmpeg: string;
  out: string;
  /** Length of the timeline in seconds (the audio is exactly this long). */
  seconds: number;
  /** Audio encoder arguments, e.g. ['-c:a', 'aac', '-b:a', '192k']. */
  codecArgs: string[];
  signal?: AbortSignal;
}

/**
 * Audio-only output (#302: m4a, wav): the same mix as a video's audio track
 * (audioGraph: music trimmed and faded, voice and sound effects on top, or
 * silence) over the whole timeline, without pictures.
 */
export async function mixAudio(opts: MixAudioOptions): Promise<{ out: string; args: string[] }> {
  const audio = audioGraph(opts, 0, opts.seconds);
  const args = ['-hide_banner', '-y', ...audio.inputs, '-filter_complex', audio.filters.join(';'), '-map', '[aout]', '-vn', ...opts.codecArgs, '-ar', '48000', '-t', opts.seconds.toFixed(3), opts.out];
  await run(opts.ffmpeg, args, 'assemble:audio', { signal: opts.signal });
  return { out: opts.out, args };
}

/**
 * The audio inputs and filter graph of a render: the music (trimmed, padded
 * and faded to the timeline) or silence, with voice and sound effects mixed on
 * top, ending in `[aout]` of exactly `totalSeconds`. Inputs are numbered from
 * `audioIndex`. Shared by assemble() and the fan-out join (concatClips), so
 * both mix the same audio.
 */
function audioGraph(opts: AudioOptions, audioIndex: number, totalSeconds: number): { inputs: string[]; filters: string[] } {
  const inputs: string[] = [];
  const filters: string[] = [];
  if (opts.music) {
    inputs.push('-i', opts.music.file);
  } else {
    inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }
  const overlays: Array<{ file: string; volume: number; at: number }> = [];
  if (opts.voice) overlays.push({ file: opts.voice.file, volume: opts.voice.volume, at: opts.voice.startSeconds ?? 0 });
  for (const s of opts.sfx ?? []) overlays.push({ file: s.file, volume: s.volume, at: s.atSeconds });
  for (const o of overlays) inputs.push('-i', o.file);

  const T = totalSeconds.toFixed(3);
  const base = overlays.length ? 'abase' : 'aout';
  if (opts.music) {
    const fade = Math.min(opts.music.fadeOutSeconds ?? 1, totalSeconds);
    const fadeStart = Math.max(totalSeconds - fade, 0).toFixed(3);
    filters.push(
      `[${audioIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
        `volume=${opts.music.volume},atrim=end=${T},asetpts=PTS-STARTPTS,` +
        `apad=whole_dur=${T}` +
        (fade > 0 ? `,afade=t=out:st=${fadeStart}:d=${fade.toFixed(3)}` : '') +
        `[${base}]`
    );
  } else {
    filters.push(`[${audioIndex}:a]atrim=end=${T},asetpts=PTS-STARTPTS[${base}]`);
  }
  if (overlays.length) {
    overlays.forEach((o, k) => {
      const delayMs = Math.max(0, Math.round(o.at * 1000));
      filters.push(
        `[${audioIndex + 1 + k}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${o.volume},` +
          `asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[o${k}]`
      );
    });
    // duration=first: the (padded) base track sets the length; normalize=0 keeps levels as given.
    filters.push(
      `[abase]${overlays.map((_, k) => `[o${k}]`).join('')}amix=inputs=${overlays.length + 1}:duration=first:dropout_transition=0:normalize=0,` +
        `atrim=end=${T},asetpts=PTS-STARTPTS[aout]`
    );
  }
  return { inputs, filters };
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
