import { execFileSync } from 'node:child_process';
import type { ReelExpectation } from '../cells';

/** What a proof records about the output file (from ffprobe with a full frame count). */
export interface ReelProbe {
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationSeconds: number;
  videoCodec: string;
  audioCodec: string | null;
  sizeBytes: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  nb_read_frames?: string;
}

/** "30/1" -> 30, "30000/1001" -> 29.97. */
export function parseRate(rate: string | undefined): number {
  if (!rate) return Number.NaN;
  const [n, d] = rate.split('/').map(Number);
  if (d === undefined) return Number(n);
  return d === 0 ? Number.NaN : Math.round((n! / d) * 1000) / 1000;
}

/** Turn `ffprobe -of json -count_frames` output into a ReelProbe. Throws when there is no video stream. */
export function parseProbe(json: string | { streams?: FfprobeStream[]; format?: { duration?: string; size?: string } }): ReelProbe {
  const p = typeof json === 'string' ? JSON.parse(json) : json;
  const streams: FfprobeStream[] = p.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('ffprobe: no video stream');
  const a = streams.find((s) => s.codec_type === 'audio');
  return {
    width: Number(v.width),
    height: Number(v.height),
    fps: parseRate(v.r_frame_rate),
    frames: Number(v.nb_read_frames),
    durationSeconds: Math.round(Number(p.format?.duration) * 1000) / 1000,
    videoCodec: String(v.codec_name),
    audioCodec: a?.codec_name ?? null,
    sizeBytes: Number(p.format?.size ?? 0),
  };
}

/** Every way the probe misses the expectation (empty: it passes). */
export function checkReel(p: ReelProbe, e: ReelExpectation): string[] {
  const out: string[] = [];
  if (p.width !== e.width || p.height !== e.height) out.push(`size ${p.width}x${p.height}, expected ${e.width}x${e.height}`);
  if (Math.abs(p.fps - e.fps) > 0.01) out.push(`fps ${p.fps}, expected ${e.fps}`);
  if (p.videoCodec !== 'h264') out.push(`video codec ${p.videoCodec}, expected h264`);
  if (e.audio && p.audioCodec !== 'aac') out.push(`audio codec ${p.audioCodec ?? 'none'}, expected aac`);
  if (!Number.isFinite(p.frames) || p.frames <= 0) out.push('no decodable frames');
  if (e.frames !== undefined && p.frames !== e.frames) out.push(`frames ${p.frames}, expected ${e.frames}`);
  // The video stream must hold whole frames for its duration (a full decode counted them).
  const expectedFrames = Math.round(p.durationSeconds * p.fps);
  if (Number.isFinite(p.frames) && Math.abs(p.frames - expectedFrames) > 2) out.push(`frames ${p.frames} do not match duration ${p.durationSeconds}s at ${p.fps} fps`);
  if (!(p.durationSeconds >= e.minSeconds && p.durationSeconds <= e.maxSeconds)) out.push(`duration ${p.durationSeconds}s outside ${e.minSeconds}..${e.maxSeconds}s`);
  return out;
}

/** Throws with every problem at once. */
export function assertReel(p: ReelProbe, e: ReelExpectation): void {
  const problems = checkReel(p, e);
  if (problems.length) throw new Error(`the reel failed its checks:\n  - ${problems.join('\n  - ')}`);
}

/** Run ffprobe with a full decode (`-count_frames`) on a file. */
export function probeFile(file: string): ReelProbe {
  const json = execFileSync(
    'ffprobe',
    ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:format=duration,size', '-of', 'json', file],
    { encoding: 'utf8' }
  );
  return parseProbe(json);
}

/** Scene engines a manifest uses, in order. */
export function sceneEngines(manifest: { scenes?: { engine?: string }[] }): string[] {
  return (manifest.scenes ?? []).map((s) => String(s.engine));
}

/** Problems with the engines an agent chose (empty: matches the cell). */
export function checkEngines(used: string[], expected: readonly string[]): string[] {
  if (!used.length) return ['the project has no scenes'];
  const out: string[] = [];
  const foreign = [...new Set(used.filter((e) => !expected.includes(e)))];
  if (foreign.length) out.push(`scenes use ${foreign.join(', ')}; the cell allows only ${expected.join(', ')}`);
  const missing = expected.filter((e) => !used.includes(e));
  if (missing.length) out.push(`no scene uses ${missing.join(', ')}`);
  return out;
}
