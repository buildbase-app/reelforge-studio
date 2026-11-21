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
  if (opts.music) {
    args.push('-i', opts.music.file);
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }
  const overlays: Array<{ file: string; volume: number; at: number }> = [];
  if (opts.voice) overlays.push({ file: opts.voice.file, volume: opts.voice.volume, at: opts.voice.startSeconds ?? 0 });
  for (const s of opts.sfx ?? []) overlays.push({ file: s.file, volume: s.volume, at: s.atSeconds });
  for (const o of overlays) args.push('-i', o.file);

  const filters: string[] = clips.map(
    (clip, i) =>
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
      `fps=${fps},format=yuv420p,trim=end_frame=${clip.frames},setpts=PTS-STARTPTS[v${i}]`
  );
  filters.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[vout]`);

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

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...H264_ARGS,
    '-r',
    String(fps),
    '-frames:v',
    String(totalFrames),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-t',
    totalSeconds.toFixed(3),
    out
  );

  await run(ffmpeg, args, 'assemble', { signal: opts.signal });
  return { out, totalFrames, args };
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
