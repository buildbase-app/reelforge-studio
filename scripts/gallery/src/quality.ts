/**
 * `pnpm gallery check`: the automated half of the quality gate. For each
 * rendered reel it checks with ffprobe/ffmpeg that the master is exactly
 * 1080x1920 at 30 fps with the expected duration and frame count, has no
 * black or frozen stretches (blackdetect/freezedetect), and is not silent
 * when the reel has music; then it writes a contact sheet (12 frames, ffmpeg
 * tile) and a full-size poster frame for the transcoder.
 *
 * The other half is a person (or the agent) looking at every contact sheet
 * against the unslop signs list and the review notes in examples/gallery
 * REVIEW (see docs/GALLERY.md); reels that fail it get fixed or dropped.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GalleryEntry } from './catalog/build';
import type { Meta } from './render';

const run = promisify(execFile);

export interface Probe {
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationSeconds: number;
  videoCodec: string;
  audioCodec: string | null;
}

export async function probeFile(file: string, ffprobe = 'ffprobe'): Promise<Probe> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:format=duration', '-of', 'json', file], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const j = JSON.parse(stdout);
  const v = j.streams.find((x: any) => x.codec_type === 'video') ?? {};
  const a = j.streams.find((x: any) => x.codec_type === 'audio');
  const [num, den] = String(v.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    width: v.width,
    height: v.height,
    fps: den ? num! / den : 0,
    frames: Number(v.nb_read_frames ?? 0),
    durationSeconds: Number(j.format?.duration ?? 0),
    videoCodec: v.codec_name,
    audioCodec: a?.codec_name ?? null,
  };
}

export interface SignalReport {
  black: { start: number; end: number }[];
  frozen: { start: number; end: number }[];
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
}

/** Parses ffmpeg stderr from blackdetect, freezedetect and volumedetect. */
export function parseSignals(stderr: string): SignalReport {
  const black = [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
  const starts = [...stderr.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const frozen = starts.map((st, i) => ({ start: st, end: ends[i] ?? Number.POSITIVE_INFINITY }));
  const mean = /mean_volume: (-?[\d.]+|-inf) dB/.exec(stderr)?.[1];
  const max = /max_volume: (-?[\d.]+|-inf) dB/.exec(stderr)?.[1];
  const num = (x?: string) => (x === undefined ? null : x === '-inf' ? -Infinity : Number(x));
  return { black, frozen, meanVolumeDb: num(mean), maxVolumeDb: num(max) };
}

/**
 * One decode pass: black stretches of 0.5 s or more where 98% of pixels are
 * darker than 4% (a dark theme is not black), frozen stretches of 2.5 s or
 * more (a held title card with a slow camera push still moves), loudness.
 */
export async function signals(file: string, ffmpeg = 'ffmpeg'): Promise<SignalReport> {
  const r = await run(
    ffmpeg,
    ['-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.5:pic_th=0.98:pix_th=0.04,freezedetect=n=0.0008:d=2.5', '-af', 'volumedetect', '-f', 'null', '-'],
    { maxBuffer: 20 * 1024 * 1024 }
  ).catch((e) => e as { stderr: string });
  return parseSignals(r.stderr ?? '');
}

export interface QualityResult {
  slug: string;
  ok: boolean;
  problems: string[];
  probe?: Probe;
  signals?: SignalReport;
  contactSheet?: string;
  poster?: string;
}

/** Problems with a probed master, given what the gallery expected. */
export function judge(meta: Pick<Meta, 'durationSeconds' | 'music'>, p: Probe, sig: SignalReport): string[] {
  const out: string[] = [];
  if (p.width !== 1080 || p.height !== 1920) out.push(`size ${p.width}x${p.height}, expected 1080x1920`);
  if (Math.abs(p.fps - 30) > 0.01) out.push(`fps ${p.fps}, expected 30`);
  const want = Math.round(meta.durationSeconds * 30);
  if (Math.abs(p.frames - want) > 1) out.push(`${p.frames} frames, expected ${want}`);
  if (Math.abs(p.durationSeconds - meta.durationSeconds) > 0.1) out.push(`duration ${p.durationSeconds}s, expected ${meta.durationSeconds}s`);
  if (p.videoCodec !== 'h264') out.push(`video codec ${p.videoCodec}`);
  for (const b of sig.black) out.push(`black frames ${b.start.toFixed(2)}-${b.end.toFixed(2)} s`);
  for (const f of sig.frozen) out.push(`frozen ${f.start.toFixed(2)}-${Number.isFinite(f.end) ? f.end.toFixed(2) : 'end'} s`);
  if (meta.music && (sig.meanVolumeDb === null || sig.meanVolumeDb < -45)) out.push(`music expected but audio is silent (mean ${sig.meanVolumeDb} dB)`);
  return out;
}

/** The moment of the first scene with everything revealed: its end minus 0.8 s. */
export function posterTime(manifest: any): number {
  const first = manifest?.scenes?.[0];
  const dur = Number(first?.durationSeconds ?? (first?.durationFrames ?? 60) / 30);
  return Math.max(0.8, Math.min(dur - 0.8, 3.2));
}

export async function contactSheet(file: string, out: string, frames: number, ffmpeg = 'ffmpeg'): Promise<void> {
  const every = Math.max(1, Math.floor(frames / 12));
  await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', file, '-vf', `select='not(mod(n\\,${every}))',scale=270:480,tile=6x2:padding=8:color=0x18181b`, '-frames:v', '1', '-update', '1', out]);
}

export async function posterFrame(file: string, out: string, at: number, ffmpeg = 'ffmpeg'): Promise<void> {
  await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-update', '1', out]);
}

export async function checkOne(outDir: string, entry: GalleryEntry): Promise<QualityResult> {
  const slug = entry.gallery.slug;
  const dir = join(outDir, slug);
  const file = join(dir, 'final.mp4');
  if (!existsSync(file) || !existsSync(join(dir, 'meta.json'))) return { slug, ok: false, problems: ['not rendered'] };
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Meta;
  const p = await probeFile(file);
  const sig = await signals(file);
  const problems = judge(meta, p, sig);
  const sheet = join(dir, 'contact.png');
  await contactSheet(file, sheet, p.frames);
  const poster = join(dir, 'poster.png');
  await posterFrame(file, poster, posterTime(entry.manifest));
  return { slug, ok: problems.length === 0, problems, probe: p, signals: sig, contactSheet: sheet, poster };
}

export async function checkAll(outDir: string, entries: GalleryEntry[]): Promise<{ passed: string[]; failed: QualityResult[] }> {
  const results: QualityResult[] = [];
  for (const e of entries) {
    const r = await checkOne(outDir, e);
    results.push(r);
    console.log(`check ${r.ok ? 'ok  ' : 'FAIL'} ${r.slug}${r.problems.length ? ': ' + r.problems.join('; ') : ''}`);
  }
  const report = { at: new Date().toISOString(), results };
  writeFileSync(join(outDir, 'quality.json'), JSON.stringify(report, null, 2));
  return { passed: results.filter((r) => r.ok).map((r) => r.slug), failed: results.filter((r) => !r.ok) };
}
