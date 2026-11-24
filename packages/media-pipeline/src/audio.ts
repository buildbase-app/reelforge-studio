import { PipelineError, run } from './ffmpeg';

/**
 * The audio half of a render (#301, D-116): one mix over the whole timeline
 * into 48 kHz stereo PCM (never per scene or chunk, so scene joins and fan-out
 * seams cannot click), then a two-pass EBU R128 normalisation with FFmpeg's
 * loudnorm, then (after the AAC encode) a measurement of the finished file.
 */

export const SAMPLE_RATE = 48000;
/** Edge fades that keep a track starting or stopping on a non-zero sample from clicking. */
const EDGE_FADE = { voice: 0.01, sfx: 0.005, master: 0.01 } as const;

export interface LoudnessTarget {
  integrated: number;
  truePeak: number;
  lra: number;
}

/** BS.1770 measurement (FFmpeg loudnorm, true peak at 4x oversampling). null: silence (-inf). */
export interface LoudnessMeasurement {
  integrated: number | null;
  truePeak: number | null;
  lra: number | null;
  threshold: number | null;
  targetOffset: number | null;
}

export interface MixTrack {
  file: string;
  /** Linear gain of the track (the manifest's `volume`). */
  volume: number;
}

export interface MixOptions {
  ffmpeg: string;
  ffprobe: string;
  /** Output WAV (32-bit float, 48 kHz stereo) of exactly `totalSeconds`. */
  out: string;
  totalSeconds: number;
  music?: (MixTrack & { fadeInSeconds?: number; fadeOutSeconds?: number }) | null;
  voice?: (MixTrack & { startSeconds?: number }) | null;
  sfx?: Array<MixTrack & { atSeconds: number }>;
  /** Bus gains in dB after each track's volume (default 0). */
  gainDb?: { voice?: number; music?: number; sfx?: number };
  /** Lower the music by `depthDb` over these windows (video seconds), ramping over attack/release. */
  ducking?: { depthDb: number; attackMs: number; releaseMs: number; windows: Array<[number, number]> } | null;
  signal?: AbortSignal;
}

export interface MixResult {
  out: string;
  args: string[];
}

const db = (x: number) => Math.pow(10, x / 20);
const f = (x: number) => Number(x.toFixed(6)).toString();

/** Duration of the first audio stream of a file, seconds. */
export async function audioDuration(ffprobe: string, file: string): Promise<number> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration:format=duration', '-of', 'json', file], 'probe');
  const d = JSON.parse(stdout) as { streams?: Array<{ duration?: string }>; format?: { duration?: string } };
  const s = Number(d.streams?.[0]?.duration ?? d.format?.duration);
  if (!Number.isFinite(s) || s <= 0) throw new PipelineError('probe', `${file} has no audio duration`);
  return s;
}

/**
 * The audio inputs and filter graph of a render, inputs numbered from
 * `firstInput`, ending in `[aout]` of exactly `totalSeconds`: music (or
 * silence) as the base, padded, faded in and out and ducked; the voice and the
 * sound effects with short edge fades and bus gains on top (amix, normalize=0:
 * levels as given); a 10 ms master fade at both ends so a looping player or a
 * cut-off voice does not click. Durations of the voice and sfx files are
 * needed for their fade-outs.
 */
export function mixGraph(
  opts: Omit<MixOptions, 'ffmpeg' | 'ffprobe' | 'out' | 'signal'> & { durations?: { voice?: number; sfx?: number[] } },
  firstInput: number
): { inputs: string[]; filters: string[] } {
  const T = opts.totalSeconds;
  const t = T.toFixed(6);
  const g = opts.gainDb ?? {};
  const inputs: string[] = [];
  const filters: string[] = [];
  const fmt = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;
  if (opts.music) inputs.push('-i', opts.music.file);
  else inputs.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}`);
  const overlays: Array<{ file: string; gain: number; at: number; fade: number; dur?: number; label: string }> = [];
  if (opts.voice) {
    overlays.push({ file: opts.voice.file, gain: opts.voice.volume * db(g.voice ?? 0), at: opts.voice.startSeconds ?? 0, fade: EDGE_FADE.voice, ...(opts.durations?.voice ? { dur: opts.durations.voice } : {}), label: 'voice' });
  }
  (opts.sfx ?? []).forEach((s, k) => {
    const dur = opts.durations?.sfx?.[k];
    overlays.push({ file: s.file, gain: s.volume * db(g.sfx ?? 0), at: s.atSeconds, fade: EDGE_FADE.sfx, ...(dur ? { dur } : {}), label: `sfx${k}` });
  });
  for (const o of overlays) inputs.push('-i', o.file);

  const base = `[${firstInput}:a]`;
  if (opts.music) {
    const fadeIn = Math.min(opts.music.fadeInSeconds ?? 0.25, T);
    const fadeOut = Math.min(opts.music.fadeOutSeconds ?? 1, T);
    const chain = [
      fmt,
      `volume=${f(opts.music.volume * db(g.music ?? 0))}`,
      `atrim=end=${t}`,
      'asetpts=PTS-STARTPTS',
      `apad=whole_dur=${t}`,
      ...(fadeIn > 0 ? [`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`] : []),
      ...(fadeOut > 0 ? [`afade=t=out:st=${Math.max(T - fadeOut, 0).toFixed(3)}:d=${fadeOut.toFixed(3)}`] : []),
    ];
    const d = opts.ducking;
    if (d && d.windows.length && d.depthDb > 0) chain.push('asetnsamples=n=32:p=0', `volume='${duckingGain(d)}':eval=frame`);
    filters.push(`${base}${chain.join(',')}[abase]`);
  } else {
    filters.push(`${base}${fmt},atrim=end=${t},asetpts=PTS-STARTPTS[abase]`);
  }
  overlays.forEach((o, k) => {
    const ms = Math.max(0, Math.round(o.at * 1000));
    const chain = [fmt, `volume=${f(o.gain)}`, 'asetpts=PTS-STARTPTS', `afade=t=in:st=0:d=${o.fade}`];
    if (o.dur && o.dur > 2 * o.fade) chain.push(`afade=t=out:st=${(o.dur - o.fade).toFixed(4)}:d=${o.fade}`);
    chain.push(`adelay=${ms}|${ms}`);
    filters.push(`[${firstInput + 1 + k}:a]${chain.join(',')}[o${k}]`);
  });
  const master = `atrim=end=${t},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${EDGE_FADE.master},afade=t=out:st=${Math.max(T - EDGE_FADE.master, 0).toFixed(4)}:d=${EDGE_FADE.master}`;
  if (overlays.length) {
    // duration=first: the padded base sets the length; normalize=0 keeps levels as given.
    filters.push(`[abase]${overlays.map((_, k) => `[o${k}]`).join('')}amix=inputs=${overlays.length + 1}:duration=first:dropout_transition=0:normalize=0,${master}[aout]`);
  } else {
    filters.push(`[abase]${master}[aout]`);
  }
  return { inputs, filters };
}

/**
 * Gain expression (FFmpeg `volume`, evaluated per 32-sample frame) that lowers
 * the music by `depthDb` over each window: a ramp of `attackMs` that ends where
 * the speech starts (the voice is known in advance, so the first syllable is
 * never masked) and one of `releaseMs` after it ends. Windows closer than
 * attack + release are merged, so the ramps never overlap and the sum of the
 * trapezoids is their maximum.
 */
export function duckingGain(d: { depthDb: number; attackMs: number; releaseMs: number; windows: Array<[number, number]> }): string {
  const a = Math.max(d.attackMs, 1) / 1000;
  const r = Math.max(d.releaseMs, 1) / 1000;
  const terms = mergeWindows(d.windows, a + r).map(([s, e]) => `clip(min((t-(${f(s - a)}))/${f(a)},(${f(e + r)}-t)/${f(r)}),0,1)`);
  return `pow(10,-${f(d.depthDb)}*min(1,${terms.join('+')})/20)`;
}

/** Sort windows and merge those closer than `gap` seconds. */
export function mergeWindows(windows: Array<[number, number]>, gap: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [s, e] of [...windows].filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && s - last[1] < gap) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Where a voice file has speech: FFmpeg silencedetect (pauses of at least
 * `minPauseSeconds` below `thresholdDb`), inverted. Seconds from the file start.
 */
export async function speechSegments(ffmpeg: string, file: string, opts: { thresholdDb: number; minPauseSeconds?: number; signal?: AbortSignal }): Promise<Array<[number, number]>> {
  const { stderr } = await run(
    ffmpeg,
    ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', `aformat=channel_layouts=mono,silencedetect=n=${opts.thresholdDb}dB:d=${opts.minPauseSeconds ?? 0.2}`, '-f', 'null', '-'],
    'audio:speech',
    { signal: opts.signal }
  );
  const end = Number(/time=(\d+):(\d+):([\d.]+)/.exec(stderr.split('\n').reverse().find((l) => /time=\d/.test(l)) ?? '')?.slice(1).reduce((n, x, i) => n + Number(x) * [3600, 60, 1][i]!, 0) ?? NaN);
  const starts = [...stderr.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Math.max(0, Number(m[1])));
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const segments: Array<[number, number]> = [];
  let cursor = 0;
  starts.forEach((s, i) => {
    if (s > cursor) segments.push([cursor, s]);
    cursor = ends[i] ?? Infinity;
  });
  const total = Number.isFinite(end) ? end : cursor;
  if (Number.isFinite(cursor) && total > cursor) segments.push([cursor, total]);
  return segments.filter(([s, e]) => e - s > 0.02);
}

/** Mix the render's audio once over the whole timeline into a 48 kHz stereo float WAV. */
export async function mixAudio(opts: MixOptions): Promise<MixResult> {
  const durations = {
    ...(opts.voice ? { voice: await audioDuration(opts.ffprobe, opts.voice.file) } : {}),
    sfx: await Promise.all((opts.sfx ?? []).map((s) => audioDuration(opts.ffprobe, s.file))),
  };
  const graph = mixGraph({ ...opts, durations }, 0);
  const args = ['-hide_banner', '-v', 'error', '-y', ...graph.inputs, '-filter_complex', graph.filters.join(';'), '-map', '[aout]', '-c:a', 'pcm_f32le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-t', opts.totalSeconds.toFixed(6), opts.out];
  await run(opts.ffmpeg, args, 'audio:mix', { signal: opts.signal });
  return { out: opts.out, args };
}

function loudnormStats(stderr: string, stage: string): Record<string, string> {
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr);
  if (!m) throw new PipelineError(stage, 'loudnorm printed no statistics', stderr.split('\n').slice(-20).join('\n'));
  return JSON.parse(m[0]) as Record<string, string>;
}
const num = (v: string | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : null;
};

/** Measure a file's first audio stream (loudnorm pass 1; any target, the input figures do not depend on it). */
export async function measureLoudness(ffmpeg: string, file: string, target: LoudnessTarget = { integrated: -24, truePeak: -2, lra: 7 }, signal?: AbortSignal): Promise<LoudnessMeasurement> {
  const { stderr } = await run(
    ffmpeg,
    ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', `loudnorm=I=${target.integrated}:TP=${target.truePeak}:LRA=${clampLra(target.lra)}:print_format=json`, '-f', 'null', '-'],
    'audio:measure',
    { ...(signal ? { signal } : {}) }
  );
  const s = loudnormStats(stderr, 'audio:measure');
  return { integrated: num(s.input_i), truePeak: num(s.input_tp), lra: num(s.input_lra), threshold: num(s.input_thresh), targetOffset: num(s.target_offset) };
}

const clampLra = (x: number) => Math.min(50, Math.max(1, x));

/**
 * Measure a finished file with FFmpeg's ebur128 filter (EBU Tech 3341/3342,
 * true peak with 4x oversampling): the check after the final encode. Figures
 * have 0.1 precision; integrated loudness of silence (-70 LUFS, the absolute
 * gate) and a -inf peak are null.
 */
export async function measureEbur128(ffmpeg: string, file: string, signal?: AbortSignal): Promise<{ integrated: number | null; truePeak: number | null; lra: number | null }> {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], 'audio:measure', { ...(signal ? { signal } : {}) });
  const sum = stderr.slice(stderr.lastIndexOf('Summary:'));
  const get = (re: RegExp) => num(re.exec(sum)?.[1]);
  const integrated = get(/I:\s+(-?[\d.]+) LUFS/);
  return { integrated: integrated !== null && integrated > -70 ? integrated : null, truePeak: get(/Peak:\s+(-?[\d.]+) dBFS/), lra: get(/LRA:\s+(-?[\d.]+) LU/) };
}

export interface NormaliseResult {
  out: string;
  /** "linear": one gain for the whole mix; "dynamic": loudnorm's limiter/AGC had to act to meet the true peak. */
  type: 'linear' | 'dynamic';
  gainDb: number;
  args: string[];
}

/**
 * loudnorm pass 2 with the pass-1 measurements, linear=true: a single gain
 * when the true peak allows it (else FFmpeg falls back to its dynamic mode,
 * reported as `type`). The true-peak target keeps `headroomDb` below the
 * ceiling for the AAC encode's overshoot. The LRA target is never below the
 * measured range, so the range is not compressed to meet a guideline.
 */
export async function normaliseLoudness(o: {
  ffmpeg: string;
  input: string;
  out: string;
  target: LoudnessTarget;
  measured: LoudnessMeasurement;
  headroomDb?: number;
  signal?: AbortSignal;
}): Promise<NormaliseResult> {
  const m = o.measured;
  if (m.integrated === null || m.truePeak === null || m.lra === null || m.threshold === null) throw new PipelineError('audio:normalise', 'cannot normalise silence');
  const tp = Math.max(-9, o.target.truePeak - (o.headroomDb ?? 0.5));
  const lra = clampLra(Math.max(o.target.lra, m.lra + 0.1));
  // loudnorm treats measured_LRA=0 (a steady tone) as "not given" and refuses linear mode; 0.01 LU changes nothing else.
  const filter =
    `loudnorm=I=${o.target.integrated}:TP=${f(tp)}:LRA=${f(lra)}:measured_I=${m.integrated}:measured_TP=${m.truePeak}:measured_LRA=${Math.max(m.lra, 0.01)}` +
    `:measured_thresh=${m.threshold}:offset=${m.targetOffset ?? 0}:linear=true:print_format=json,aresample=${SAMPLE_RATE}`;
  const args = ['-hide_banner', '-nostats', '-y', '-i', o.input, '-map', '0:a:0', '-af', filter, '-c:a', 'pcm_f32le', '-ar', String(SAMPLE_RATE), '-ac', '2', o.out];
  const { stderr } = await run(o.ffmpeg, args, 'audio:normalise', { ...(o.signal ? { signal: o.signal } : {}) });
  const s = loudnormStats(stderr, 'audio:normalise');
  return { out: o.out, type: s.normalization_type === 'linear' ? 'linear' : 'dynamic', gainDb: Number((o.target.integrated - m.integrated).toFixed(2)), args };
}

export interface AvSync {
  videoStart: number;
  audioStart: number | null;
  videoDuration: number;
  audioDuration: number | null;
  problems: string[];
}

/**
 * A/V sync of a finished file: audio starts at 0 like the video (no edit-list
 * or start offset; ITU-R BT.1359 detectability is about +45 ms lead / -125 ms
 * lag, we allow one frame) and both streams are as long within one frame.
 *
 * Codec priming the decoder drops is not an offset (#302): Opus in WebM
 * starts its first packet `initial_padding` samples (the pre-skip, 312) before
 * 0, which ffprobe reports as a start of -7 ms, and the first sample heard is
 * at 0. Matroska has no per-stream duration, so its `DURATION` tag is used.
 */
export async function checkAvSync(ffprobe: string, file: string, fps: number): Promise<AvSync> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time,duration,initial_padding,sample_rate:stream_tags=DURATION', '-of', 'json', file], 'probe');
  type S = { codec_type?: string; start_time?: string; duration?: string; initial_padding?: number; sample_rate?: string; tags?: { DURATION?: string } };
  const streams = (JSON.parse(stdout) as { streams: S[] }).streams;
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const frame = 1 / fps;
  const duration = (s: S | undefined) => {
    const d = Number(s?.duration);
    return Number.isFinite(d) ? d : tagSeconds(s?.tags?.DURATION) ?? 0;
  };
  const start = (s: S | undefined) => Number(s?.start_time ?? 0) || 0;
  let audioStart: number | null = null;
  let audioDuration: number | null = null;
  if (a) {
    const raw = start(a);
    const rate = Number(a.sample_rate);
    // The priming only explains a start before 0 (MP4 hides AAC's in an edit list and reports 0 and no padding).
    const priming = raw < 0 && a.initial_padding && rate > 0 ? a.initial_padding / rate : 0;
    audioStart = Number((raw + priming).toFixed(6));
    audioDuration = Number((raw + duration(a) - audioStart).toFixed(6));
  }
  const r = { videoStart: start(v), audioStart, videoDuration: duration(v), audioDuration, problems: [] as string[] };
  if (r.audioStart === null || r.audioDuration === null) return r;
  const offset = r.audioStart - r.videoStart;
  if (Math.abs(offset) > 0.001) r.problems.push(`audio starts ${(Math.abs(offset) * 1000).toFixed(1)} ms ${offset > 0 ? 'after' : 'before'} the video (expected 0)`);
  const diff = r.audioDuration - r.videoDuration;
  if (Math.abs(diff) > frame + 1e-6) r.problems.push(`audio is ${(diff * 1000).toFixed(1)} ms ${diff > 0 ? 'longer' : 'shorter'} than the video (allowed: one frame, ${(frame * 1000).toFixed(1)} ms)`);
  return r;
}

/**
 * A Matroska `DURATION` tag ("00:00:02.002000000") in seconds; null when
 * absent or malformed. A linear scan of fixed fields, no regular expression.
 */
export function tagSeconds(tag: string | undefined): number | null {
  if (!tag || tag.length > 32) return null;
  const parts = tag.split(':');
  if (parts.length !== 3) return null;
  let total = 0;
  for (const [i, p] of parts.entries()) {
    if (p === '' || ![...p].every((c) => (c >= '0' && c <= '9') || (i === 2 && c === '.'))) return null;
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    total = total * 60 + n;
  }
  return total;
}

/**
 * The FFmpeg audio features renders use, each tried on 0.1 s of silence with
 * the exact options the pipeline passes (filter options differ between
 * versions: `ebur128 framelog=quiet`, for one, is FFmpeg 6+; this pipeline
 * uses `verbose`, which 5.1 has too).
 */
const AUDIO_PROBES: Array<{ what: string; graph: string; inputs?: number }> = [
  { what: 'mix chain (aformat, atrim, apad whole_dur, afade, asetnsamples, volume eval=frame, adelay)', graph: "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=end=0.1,asetpts=PTS-STARTPTS,apad=whole_dur=0.2,afade=t=in:st=0:d=0.01,afade=t=out:st=0.19:d=0.01,asetnsamples=n=32:p=0,volume='pow(10,-6*min(1,clip(t,0,1))/20)':eval=frame,adelay=10|10" },
  { what: 'amix normalize=0', graph: '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0', inputs: 2 },
  { what: 'silencedetect', graph: 'aformat=channel_layouts=mono,silencedetect=n=-40dB:d=0.2' },
  { what: 'loudnorm (measure)', graph: 'loudnorm=I=-14:TP=-2:LRA=11:print_format=json' },
  { what: 'loudnorm (linear, with measured values)', graph: 'loudnorm=I=-14:TP=-2.5:LRA=11:measured_I=-20:measured_TP=-6:measured_LRA=3:measured_thresh=-30:offset=0:linear=true:print_format=json,aresample=48000' },
  { what: 'ebur128 true peak', graph: 'ebur128=peak=true:framelog=verbose' },
];
const audioSupport = new Map<string, Promise<void>>();

/**
 * Fail fast, with the missing feature named, when this FFmpeg cannot run the
 * audio pipeline (checked once per binary). FFmpeg 5.1 (Debian bookworm, the
 * release image) and 6.1 pass.
 */
export function assertAudioSupport(ffmpeg: string): Promise<void> {
  let p = audioSupport.get(ffmpeg);
  if (!p) {
    p = (async () => {
      const missing: string[] = [];
      for (const probe of AUDIO_PROBES) {
        const inputs = Array.from({ length: probe.inputs ?? 1 }, () => ['-f', 'lavfi', '-t', '0.1', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']).flat();
        const filter = probe.inputs ? ['-filter_complex', probe.graph] : ['-af', probe.graph];
        try {
          // Output as the pipeline writes it (stereo float PCM): FFmpeg 5.1 cannot pick a layout for aresample into a bare null output.
          await run(ffmpeg, ['-hide_banner', '-nostats', '-v', 'error', ...inputs, ...filter, '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'null', '-'], 'audio:setup');
        } catch (e) {
          const log = e instanceof PipelineError ? e.log.trim().split('\n').slice(-3).join(' ') : String(e);
          missing.push(`${probe.what}${log ? ` (${log})` : ''}`);
        }
      }
      if (missing.length) {
        throw new PipelineError('audio:setup', `${ffmpeg} cannot run the audio pipeline: ${missing.join('; ')}. Install FFmpeg 5.1 or newer with these filters (e.g. the Debian/Ubuntu ffmpeg package), or set FFMPEG_PATH to one`);
      }
    })();
    audioSupport.set(ffmpeg, p);
    p.catch(() => audioSupport.delete(ffmpeg));
  }
  return p;
}
