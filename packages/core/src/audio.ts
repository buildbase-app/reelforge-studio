import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PipelineError,
  assertAudioSupport,
  audioDuration,
  checkAvSync,
  levelEnvelope,
  measureEbur128,
  measureLoudness,
  mixAudio,
  normaliseLoudness,
  speechSegments,
  windowLevelDb,
  type AvSync,
  type LevelEnvelope,
  type LoudnessMeasurement,
  type Tools,
} from '@renderweld/media-pipeline';
import {
  framesToSeconds,
  LOUDNESS_TARGETS,
  resolveDucking,
  type DuckingSettings,
  type LoudnessPreset,
  type LoudnessTarget,
  type OutputSettings,
  type Project,
  type RenderAudioOptions,
} from '@renderweld/project-schema';
import type { ResolvedAsset } from './plugins';

/**
 * The audio of a render (#301, #298, D-116): which buses play, the mix (bus
 * gains, ducking, fades) into one PCM track over the whole timeline, two-pass
 * loudness normalisation to a preset, and after the final encode the
 * measurement and QA of what the file really carries.
 */

/** Server defaults (`render.audio.*`). */
export interface AudioDefaults {
  loudness: LoudnessPreset;
  loudnessQa: 'warn' | 'fail';
  mutedTrack: 'silent' | 'none';
  /** Warn when a sound effect is less than this many dB over the music and voice under it (#459). */
  sfxMaskingDb?: number;
}
export const AUDIO_DEFAULTS: AudioDefaults = { loudness: 'social', loudnessQa: 'warn', mutedTrack: 'silent', sfxMaskingDb: 3 };

export interface AudioPlan {
  mute: boolean;
  voice: boolean;
  music: boolean;
  sfx: boolean;
  loudness: LoudnessPreset;
  qa: AudioDefaults['loudnessQa'];
  mutedTrack: AudioDefaults['mutedTrack'];
  sfxMaskingDb: number;
}

/** What one render plays: the render's `audio` option, else the manifest, else the server defaults. */
export function resolveAudioPlan(project: Project, overrides: RenderAudioOptions = {}, defaults: AudioDefaults = AUDIO_DEFAULTS): AudioPlan {
  const a = project.audio;
  return {
    mute: overrides.mute ?? a.mute ?? false,
    voice: overrides.voice ?? a.enabled?.voice ?? true,
    music: overrides.music ?? a.enabled?.music ?? true,
    sfx: overrides.sfx ?? a.enabled?.sfx ?? true,
    loudness: overrides.loudness ?? a.loudness ?? defaults.loudness,
    qa: defaults.loudnessQa,
    mutedTrack: defaults.mutedTrack,
    sfxMaskingDb: defaults.sfxMaskingDb ?? AUDIO_DEFAULTS.sfxMaskingDb!,
  };
}

export interface AudioPassInput {
  project: Project;
  output: OutputSettings;
  /** Every scene is rendered (a preview of a scene subset gets silence: its timing differs). */
  fullTimeline: boolean;
  totalSeconds: number;
  assets: ReadonlyMap<string, ResolvedAsset>;
  plan: AudioPlan;
  tools: Tools;
  workDir: string;
  signal: AbortSignal;
  log(line: string): void;
  /** The output format has no audio (#302: gif, png-sequence): no mix, no audio stream, nothing to check. */
  formatWithoutAudio?: string;
}

export interface AudioLoudness {
  preset: LoudnessPreset;
  target: (LoudnessTarget & { truePeakCeiling: number }) | null;
  /** The mix before normalisation. */
  input: LoudnessMeasurement | null;
  /** linear: one gain; limited: one gain and a true-peak limiter (#449); dynamic: loudnorm's dynamic mode (renders before #449). */
  normalisation: 'linear' | 'limited' | 'dynamic' | 'none';
  reason?: string;
  gainDb?: number;
  /** With normalisation "limited": the limiter's ceiling (dBTP, under the preset's ceiling for the AAC overshoot) and the gain passes it took. */
  limiter?: { ceilingDb: number; passes: number };
  /** Measured on the finished file, after the AAC encode (and caption burn-in). */
  measured?: { integrated: number | null; truePeak: number | null; lra: number | null };
}

export interface AudioQaIssue {
  rule: 'loudness.integrated' | 'loudness.truePeak' | 'loudness.lra' | 'sfx.masked';
  severity: 'warn' | 'fail';
  message: string;
  /** sfx.masked: the cue (index in audio.sfx), its asset and time, its margin over the bed and a volume that would clear it. */
  cue?: number;
  asset?: string;
  atSeconds?: number;
  marginDb?: number;
  suggestedVolume?: number;
}

/**
 * How far each sound effect stands out of the music and voice under it (#459):
 * the cue's own level (its file at its volume and the sfx bus gain) and the
 * level of the mix without sound effects, both RMS over the cue's first
 * `windowSeconds` (its length, 0.05 to 0.5 s). Measured on the stems before
 * normalisation, which changes every bus by the same gain.
 */
export interface SfxAudibility {
  cue: number;
  asset: string;
  atSeconds: number;
  windowSeconds: number;
  cueDb: number | null;
  /** null: nothing plays under the cue. */
  bedDb: number | null;
  /** cueDb - bedDb; null when either side is silent. */
  marginDb: number | null;
}

/** The render manifest's `audio` section (the track fields keep their earlier shape). */
export interface AudioManifest {
  music: { asset: string; volume: number } | null;
  voice: { asset: string; volume: number; startSeconds: number } | null;
  sfx: Project['audio']['sfx'];
  note?: string;
  /** What the file carries: the mix, a silent track, or no audio stream. */
  track: 'mixed' | 'silent' | 'none';
  toggles: { mute: boolean; voice: boolean; music: boolean; sfx: boolean };
  gainDb: { voice: number; music: number; sfx: number };
  ducking: (DuckingSettings & { windows: Array<[number, number]> }) | null;
  loudness: AudioLoudness;
  avSync?: Omit<AvSync, 'problems'>;
  /** Present when sound effects play over music or a voice (#459). */
  sfxAudibility?: { thresholdDb: number; cues: SfxAudibility[] };
  qa?: { ok: boolean; mode: AudioPlan['qa']; issues: AudioQaIssue[] };
  mixArgs?: string[];
}

export interface AudioPassResult {
  /** The finished WAV for assemble()/concatClips(); null with `noAudio`. */
  file: string | null;
  noAudio: boolean;
  manifest: AudioManifest;
}

const r2 = (x: number) => Math.round(x * 1000) / 1000;

/** Mix and normalise the render's audio into `workDir` (before assembly). */
export async function audioPass(i: AudioPassInput): Promise<AudioPassResult> {
  const { project, plan, tools, signal, log } = i;
  const a = project.audio;
  const fps = i.output.fps;
  const file = (id: string) => {
    const asset = i.assets.get(id);
    if (!asset) throw new PipelineError('assemble', `audio asset "${id}" is not available`);
    return asset.file;
  };
  const play = i.fullTimeline && !plan.mute;
  const music = play && plan.music && a.music ? a.music : null;
  const voice = play && plan.voice && a.voice?.asset ? { ...a.voice, asset: a.voice.asset } : null;
  const sfx = play && plan.sfx ? a.sfx : [];
  const gainDb = { voice: a.gainDb?.voice ?? 0, music: a.gainDb?.music ?? 0, sfx: a.gainDb?.sfx ?? 0 };
  const target = plan.loudness === 'off' ? null : LOUDNESS_TARGETS[plan.loudness];
  const manifest: AudioManifest = {
    music: music ? { asset: music.asset, volume: music.volume } : null,
    voice: voice ? { asset: voice.asset, volume: voice.volume, startSeconds: framesToSeconds(voice.startFrame, fps) } : null,
    sfx,
    ...(i.fullTimeline ? {} : { note: 'preview of a scene subset: audio replaced by silence' }),
    track: 'mixed',
    toggles: { mute: plan.mute, voice: plan.voice, music: plan.music, sfx: plan.sfx },
    gainDb,
    ducking: null,
    loudness: { preset: plan.loudness, target: target ? { integrated: target.integrated, truePeak: target.truePeak, lra: target.lra, tolerance: target.tolerance, truePeakCeiling: target.truePeak } : null, input: null, normalisation: 'none' },
  };
  if (i.formatWithoutAudio) {
    log(`audio: none (${i.formatWithoutAudio} has no audio)`);
    const reason = `${i.formatWithoutAudio} has no audio`;
    return { file: null, noAudio: true, manifest: { ...manifest, music: null, voice: null, sfx: [], ducking: null, track: 'none', note: reason, loudness: { ...manifest.loudness, reason } } };
  }
  if (plan.mute && plan.mutedTrack === 'none') {
    log('audio: muted, no audio stream (render.audio.mutedTrack = none)');
    return { file: null, noAudio: true, manifest: { ...manifest, track: 'none', loudness: { ...manifest.loudness, reason: 'muted' } } };
  }
  await mkdir(i.workDir, { recursive: true });
  await assertAudioSupport(tools.ffmpeg);

  let ducking: AudioManifest['ducking'] = null;
  const duck = resolveDucking(music?.ducking);
  if (music && voice && duck && duck.depthDb > 0) {
    const offset = framesToSeconds(voice.startFrame, fps);
    const speech = await speechSegments(tools.ffmpeg, file(voice.asset), { thresholdDb: duck.thresholdDb, signal });
    const windows = speech.map(([s, e]) => [r2(s + offset), r2(Math.min(e + offset, i.totalSeconds))] as [number, number]).filter(([s, e]) => e > s);
    ducking = { ...duck, windows };
    log(`audio: ducking the music ${duck.depthDb} dB under ${windows.length} speech segment(s) (attack ${duck.attackMs} ms, release ${duck.releaseMs} ms)`);
  }
  manifest.ducking = ducking;

  const mixFile = join(i.workDir, 'mix.wav');
  const mixed = await mixAudio({
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    out: mixFile,
    totalSeconds: i.totalSeconds,
    music: music ? { file: file(music.asset), volume: music.volume, ...(music.fadeInSeconds !== undefined ? { fadeInSeconds: music.fadeInSeconds } : {}), fadeOutSeconds: music.fadeOutSeconds } : null,
    voice: voice ? { file: file(voice.asset), volume: voice.volume, startSeconds: framesToSeconds(voice.startFrame, fps) } : null,
    sfx: sfx.map((s) => ({ file: file(s.asset), volume: s.volume, atSeconds: framesToSeconds(s.atFrame, fps) })),
    gainDb,
    ducking: ducking ? { depthDb: ducking.depthDb, attackMs: ducking.attackMs, releaseMs: ducking.releaseMs, windows: ducking.windows } : null,
    signal,
  });
  manifest.mixArgs = mixed.args.map((x) => (x.startsWith('/') ? '<file>' : x));
  if (sfx.length && (music || voice)) {
    manifest.sfxAudibility = await measureSfxAudibility({
      tools,
      signal,
      workDir: i.workDir,
      totalSeconds: i.totalSeconds,
      thresholdDb: plan.sfxMaskingDb,
      cues: sfx.map((s, k) => ({ cue: k, asset: s.asset, file: file(s.asset), volume: s.volume, atSeconds: framesToSeconds(s.atFrame, fps) })),
      sfxGainDb: gainDb.sfx,
      bed: {
        music: music ? { file: file(music.asset), volume: music.volume, ...(music.fadeInSeconds !== undefined ? { fadeInSeconds: music.fadeInSeconds } : {}), fadeOutSeconds: music.fadeOutSeconds } : null,
        voice: voice ? { file: file(voice.asset), volume: voice.volume, startSeconds: framesToSeconds(voice.startFrame, fps) } : null,
        gainDb,
        ducking: ducking ? { depthDb: ducking.depthDb, attackMs: ducking.attackMs, releaseMs: ducking.releaseMs, windows: ducking.windows } : null,
      },
    });
    const masked = manifest.sfxAudibility.cues.filter((c) => c.marginDb !== null && c.marginDb < plan.sfxMaskingDb).length;
    log(`audio: ${sfx.length} sound effect(s) measured against the bed, ${masked} under ${plan.sfxMaskingDb} dB over it`);
  }
  if (!music && !voice && !sfx.length) {
    manifest.track = 'silent';
    manifest.loudness.reason = plan.mute ? 'muted' : i.fullTimeline ? 'no audio tracks' : 'scene subset preview';
    return { file: mixFile, noAudio: false, manifest };
  }
  if (!target) {
    manifest.loudness.reason = 'loudness preset "off"';
    return { file: mixFile, noAudio: false, manifest };
  }
  const input = await measureLoudness(tools.ffmpeg, mixFile, target, signal);
  manifest.loudness.input = input;
  if (input.integrated === null || input.integrated < -70) {
    manifest.loudness.reason = 'the mix is silent';
    return { file: mixFile, noAudio: false, manifest };
  }
  const norm = await normaliseLoudness({ ffmpeg: tools.ffmpeg, input: mixFile, out: join(i.workDir, 'audio.wav'), target, measured: input, signal });
  manifest.loudness.normalisation = norm.type;
  manifest.loudness.gainDb = norm.gainDb;
  if (norm.limiter) manifest.loudness.limiter = { ceilingDb: norm.limiter.ceilingDb, passes: norm.limiter.passes };
  log(`audio: ${input.integrated} LUFS / ${input.truePeak} dBTP -> ${plan.loudness} (${target.integrated} LUFS, <= ${target.truePeak} dBTP), ${norm.type}${norm.limiter ? ` (${norm.gainDb} dB gain, true-peak limiter at ${norm.limiter.ceilingDb} dBTP, ${norm.limiter.passes} passes)` : ''}`);
  return { file: norm.out, noAudio: false, manifest };
}

/** The window a cue is judged on: its first half second, or all of it when shorter (never under 50 ms). */
const SFX_WINDOW = { min: 0.05, max: 0.5 } as const;
/** sfx volumes stop at 2 (+6 dB, packages/project-schema). */
const SFX_MAX_VOLUME = 2;

export interface SfxAudibilityInput {
  tools: Tools;
  signal?: AbortSignal;
  workDir: string;
  totalSeconds: number;
  thresholdDb: number;
  cues: Array<{ cue: number; asset: string; file: string; volume: number; atSeconds: number }>;
  sfxGainDb: number;
  /** The mix without sound effects, as mixAudio takes it. */
  bed: Pick<Parameters<typeof mixAudio>[0], 'music' | 'voice' | 'gainDb' | 'ducking'>;
}

/**
 * Measure each sound effect against what plays under it (#459): mix the bed
 * (music and voice, with their volumes, fades, bus gains and ducking) once
 * without the sound effects, read its level and each effect file's level per
 * 10 ms, and compare the two over the cue's first window. No model, no new
 * dependency: FFmpeg's astats on the stems the mixer already has.
 */
export async function measureSfxAudibility(i: SfxAudibilityInput): Promise<{ thresholdDb: number; cues: SfxAudibility[] }> {
  const bedFile = join(i.workDir, 'bed.wav');
  await mixAudio({ ffmpeg: i.tools.ffmpeg, ffprobe: i.tools.ffprobe, out: bedFile, totalSeconds: i.totalSeconds, ...i.bed, sfx: [], ...(i.signal ? { signal: i.signal } : {}) });
  const bed = await levelEnvelope(i.tools.ffmpeg, bedFile, { ...(i.signal ? { signal: i.signal } : {}) });
  const files = new Map<string, Promise<{ env: LevelEnvelope; seconds: number }>>();
  const effect = (f: string) => {
    if (!files.has(f)) {
      files.set(
        f,
        Promise.all([levelEnvelope(i.tools.ffmpeg, f, { ...(i.signal ? { signal: i.signal } : {}) }), audioDuration(i.tools.ffprobe, f)]).then(([env, seconds]) => ({ env, seconds }))
      );
    }
    return files.get(f)!;
  };
  const cues: SfxAudibility[] = [];
  for (const c of i.cues) {
    if (c.atSeconds >= i.totalSeconds) continue; // after the end: never heard, and not this check's business
    const { env, seconds } = await effect(c.file);
    const windowSeconds = r2(Math.min(Math.max(Math.min(seconds, SFX_WINDOW.max), SFX_WINDOW.min), i.totalSeconds - c.atSeconds));
    const own = windowLevelDb(env, 0, windowSeconds);
    const cueDb = own === null || c.volume <= 0 ? null : Number((own + 20 * Math.log10(c.volume) + i.sfxGainDb).toFixed(1));
    const under = windowLevelDb(bed, c.atSeconds, windowSeconds);
    const bedDb = under === null ? null : Number(under.toFixed(1));
    cues.push({ cue: c.cue, asset: c.asset, atSeconds: r2(c.atSeconds), windowSeconds, cueDb, bedDb, marginDb: cueDb === null || bedDb === null ? null : Number((cueDb - bedDb).toFixed(1)) });
  }
  return { thresholdDb: i.thresholdDb, cues };
}

/**
 * The audio checks of a render manifest and get_render_output: `loudness` from
 * the integrated-loudness and true-peak rules (the loudness range is guidance
 * only), `sfx` from the masking rule (#459).
 */
export function audioChecks(a: Pick<AudioManifest, 'loudness' | 'qa' | 'sfxAudibility'>): { loudness: 'pass' | 'warn' | 'skipped'; sfx: 'pass' | 'warn' | 'skipped' } {
  const issues = a.qa?.issues ?? [];
  return {
    loudness: a.loudness.measured ? (issues.some((x) => x.rule === 'loudness.integrated' || x.rule === 'loudness.truePeak') ? 'warn' : 'pass') : 'skipped',
    sfx: a.sfxAudibility ? (issues.some((x) => x.rule === 'sfx.masked') ? 'warn' : 'pass') : 'skipped',
  };
}

/** The sfx.masked warnings of a render: every cue less than the threshold over its bed, with a volume that would clear it. */
export function sfxMaskingIssues(m: Pick<AudioManifest, 'sfx' | 'sfxAudibility'>): AudioQaIssue[] {
  const a = m.sfxAudibility;
  if (!a) return [];
  return a.cues.flatMap((c) => {
    if (c.marginDb === null || c.marginDb >= a.thresholdDb) return [];
    const volume = m.sfx[c.cue]?.volume ?? 1;
    // Aim 3 dB past the threshold, so a small change in the mix does not bring the warning back.
    const needed = volume * Math.pow(10, (a.thresholdDb + 3 - c.marginDb) / 20);
    const suggestedVolume = Math.round(Math.min(needed, SFX_MAX_VOLUME) * 100) / 100;
    const level = c.marginDb < 0 ? `${Math.abs(c.marginDb)} dB under` : `only ${c.marginDb} dB over`;
    const fix =
      needed <= SFX_MAX_VOLUME
        ? `raise its volume to about ${suggestedVolume} (now ${volume}), or lower the music (audio.music.volume or audio.gainDb.music)`
        : `raise its volume to ${SFX_MAX_VOLUME} (now ${volume}) and lower the music by about ${Math.ceil(20 * Math.log10(needed / SFX_MAX_VOLUME))} dB (audio.music.volume or audio.gainDb.music), or raise audio.gainDb.sfx`;
    return [
      {
        rule: 'sfx.masked' as const,
        severity: 'warn' as const,
        message: `sound effect ${c.cue} ("${c.asset}" at ${c.atSeconds} s) is ${level} the music and voice under it (first ${c.windowSeconds} s; wanted at least ${a.thresholdDb} dB over), so it will barely be heard: ${fix}`,
        cue: c.cue,
        asset: c.asset,
        atSeconds: c.atSeconds,
        marginDb: c.marginDb,
        suggestedVolume,
      },
    ];
  });
}

/**
 * Measure the finished file and apply the audio QA rules: integrated loudness
 * within the preset's tolerance, true peak at or under the ceiling (each a
 * failure in `fail` mode, else a warning), loudness range over the guidance
 * (always a warning), sound effects masked by the bed (#459, always a
 * warning, from the measurement audioPass made), and A/V sync (start at 0,
 * durations within one frame; always a failure, returned as `syncProblems`).
 */
export async function verifyAudio(
  tools: Tools,
  file: string,
  fps: number,
  m: AudioManifest,
  mode: AudioPlan['qa'],
  signal?: AbortSignal,
  /** sync: false for audio-only files (#302: m4a, wav), which have no video to be in sync with; loudness is still checked. */
  opts: { sync?: boolean } = {}
): Promise<{ manifest: AudioManifest; failures: string[]; syncProblems: string[] }> {
  const issues: AudioQaIssue[] = [];
  let syncProblems: string[] = [];
  if (m.track !== 'none') {
    if (opts.sync !== false) {
      const { problems, ...sync } = await checkAvSync(tools.ffprobe, file, fps);
      syncProblems = problems;
      m.avSync = sync;
    }
    const t = m.loudness.target;
    if (m.track === 'mixed' && t && m.loudness.normalisation !== 'none') {
      const got = await measureEbur128(tools.ffmpeg, file, signal);
      m.loudness.measured = got;
      // A peak-limited mix that still misses: say why and what the agent can change (#449).
      const why =
        m.loudness.normalisation === 'limited'
          ? `; the mix is peak-limited (short loud sounds set the true peak, ${m.loudness.gainDb} dB of gain was needed): lower the sound effects (audio.gainDb.sfx or an sfx volume) or raise the bed, then render again`
          : '';
      if (got.integrated === null || Math.abs(got.integrated - t.integrated) > t.tolerance) {
        issues.push({ rule: 'loudness.integrated', severity: mode, message: `integrated loudness is ${got.integrated ?? '-inf'} LUFS, target ${t.integrated} ± ${t.tolerance} LU (${m.loudness.preset})${why}` });
      }
      if (got.truePeak !== null && got.truePeak > t.truePeakCeiling) {
        issues.push({ rule: 'loudness.truePeak', severity: mode, message: `true peak is ${got.truePeak} dBTP, ceiling ${t.truePeakCeiling} dBTP (${m.loudness.preset})${why}` });
      }
      if (got.lra !== null && got.lra > t.lra) {
        issues.push({ rule: 'loudness.lra', severity: 'warn', message: `loudness range is ${got.lra} LU, guidance ${t.lra} LU (not enforced; EBU R 128 does not recommend LRA for programmes under a minute)` });
      }
    }
  }
  if (m.track === 'mixed') issues.push(...sfxMaskingIssues(m));
  m.qa = { ok: issues.length === 0 && syncProblems.length === 0, mode, issues };
  return { manifest: m, failures: issues.filter((x) => x.severity === 'fail').map((x) => x.message), syncProblems };
}
