import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PipelineError,
  checkAvSync,
  measureEbur128,
  measureLoudness,
  mixAudio,
  normaliseLoudness,
  speechSegments,
  type AvSync,
  type LoudnessMeasurement,
  type Tools,
} from '@reelforge/media-pipeline';
import {
  LOUDNESS_TARGETS,
  resolveDucking,
  type DuckingSettings,
  type LoudnessPreset,
  type LoudnessTarget,
  type OutputSettings,
  type Project,
  type RenderAudioOptions,
} from '@reelforge/project-schema';
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
}
export const AUDIO_DEFAULTS: AudioDefaults = { loudness: 'social', loudnessQa: 'warn', mutedTrack: 'silent' };

export interface AudioPlan {
  mute: boolean;
  voice: boolean;
  music: boolean;
  sfx: boolean;
  loudness: LoudnessPreset;
  qa: AudioDefaults['loudnessQa'];
  mutedTrack: AudioDefaults['mutedTrack'];
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
}

export interface AudioLoudness {
  preset: LoudnessPreset;
  target: (LoudnessTarget & { truePeakCeiling: number }) | null;
  /** The mix before normalisation. */
  input: LoudnessMeasurement | null;
  normalisation: 'linear' | 'dynamic' | 'none';
  reason?: string;
  gainDb?: number;
  /** Measured on the finished file, after the AAC encode (and caption burn-in). */
  measured?: { integrated: number | null; truePeak: number | null; lra: number | null };
}

export interface AudioQaIssue {
  rule: 'loudness.integrated' | 'loudness.truePeak' | 'loudness.lra';
  severity: 'warn' | 'fail';
  message: string;
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
    voice: voice ? { asset: voice.asset, volume: voice.volume, startSeconds: voice.startFrame / fps } : null,
    sfx,
    ...(i.fullTimeline ? {} : { note: 'preview of a scene subset: audio replaced by silence' }),
    track: 'mixed',
    toggles: { mute: plan.mute, voice: plan.voice, music: plan.music, sfx: plan.sfx },
    gainDb,
    ducking: null,
    loudness: { preset: plan.loudness, target: target ? { integrated: target.integrated, truePeak: target.truePeak, lra: target.lra, tolerance: target.tolerance, truePeakCeiling: target.truePeak } : null, input: null, normalisation: 'none' },
  };
  if (plan.mute && plan.mutedTrack === 'none') {
    log('audio: muted, no audio stream (render.audio.mutedTrack = none)');
    return { file: null, noAudio: true, manifest: { ...manifest, track: 'none', loudness: { ...manifest.loudness, reason: 'muted' } } };
  }
  await mkdir(i.workDir, { recursive: true });

  let ducking: AudioManifest['ducking'] = null;
  const duck = resolveDucking(music?.ducking);
  if (music && voice && duck && duck.depthDb > 0) {
    const offset = voice.startFrame / fps;
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
    voice: voice ? { file: file(voice.asset), volume: voice.volume, startSeconds: voice.startFrame / fps } : null,
    sfx: sfx.map((s) => ({ file: file(s.asset), volume: s.volume, atSeconds: s.atFrame / fps })),
    gainDb,
    ducking: ducking ? { depthDb: ducking.depthDb, attackMs: ducking.attackMs, releaseMs: ducking.releaseMs, windows: ducking.windows } : null,
    signal,
  });
  manifest.mixArgs = mixed.args.map((x) => (x.startsWith('/') ? '<file>' : x));
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
  log(`audio: ${input.integrated} LUFS / ${input.truePeak} dBTP -> ${plan.loudness} (${target.integrated} LUFS, <= ${target.truePeak} dBTP), ${norm.type}`);
  return { file: norm.out, noAudio: false, manifest };
}

/**
 * Measure the finished file and apply the audio QA rules: integrated loudness
 * within the preset's tolerance, true peak at or under the ceiling (each a
 * failure in `fail` mode, else a warning), loudness range over the guidance
 * (always a warning), and A/V sync (start at 0, durations within one frame;
 * always a failure, returned as `syncProblems`).
 */
export async function verifyAudio(tools: Tools, file: string, fps: number, m: AudioManifest, mode: AudioPlan['qa'], signal?: AbortSignal): Promise<{ manifest: AudioManifest; failures: string[]; syncProblems: string[] }> {
  const issues: AudioQaIssue[] = [];
  let syncProblems: string[] = [];
  if (m.track !== 'none') {
    const { problems, ...sync } = await checkAvSync(tools.ffprobe, file, fps);
    syncProblems = problems;
    m.avSync = sync;
    const t = m.loudness.target;
    if (m.track === 'mixed' && t && m.loudness.normalisation !== 'none') {
      const got = await measureEbur128(tools.ffmpeg, file, signal);
      m.loudness.measured = got;
      if (got.integrated === null || Math.abs(got.integrated - t.integrated) > t.tolerance) {
        issues.push({ rule: 'loudness.integrated', severity: mode, message: `integrated loudness is ${got.integrated ?? '-inf'} LUFS, target ${t.integrated} ± ${t.tolerance} LU (${m.loudness.preset})` });
      }
      if (got.truePeak !== null && got.truePeak > t.truePeakCeiling) {
        issues.push({ rule: 'loudness.truePeak', severity: mode, message: `true peak is ${got.truePeak} dBTP, ceiling ${t.truePeakCeiling} dBTP (${m.loudness.preset})` });
      }
      if (got.lra !== null && got.lra > t.lra) {
        issues.push({ rule: 'loudness.lra', severity: 'warn', message: `loudness range is ${got.lra} LU, guidance ${t.lra} LU (not enforced; EBU R 128 does not recommend LRA for programmes under a minute)` });
      }
    }
  }
  m.qa = { ok: issues.length === 0 && syncProblems.length === 0, mode, issues };
  return { manifest: m, failures: issues.filter((x) => x.severity === 'fail').map((x) => x.message), syncProblems };
}
