/**
 * `pnpm gallery transcode`: web versions of every reel that passed the gate.
 *
 *   <slug>.<hash>.mp4    H.264 High, 720x1280, no audio, +faststart (CRF raised until it fits the budget)
 *   <slug>.<hash>.webm   VP9, 720x1280, no audio (same budget)
 *   poster.<hash>.avif / .jpg        720x1280
 *   poster-360.<hash>.avif / .jpg    360x640 for grid cards
 *
 * Names carry the first 12 hex digits of each file's sha256, so they can be
 * cached forever (`Cache-Control: public, max-age=31536000, immutable`).
 * <out>/web/media.json lists every file with its R2 key, size and hash.
 * Budgets (docs/research/SITE_PLAN.md B.6): 800 KB for a card clip up to 15 s,
 * scaled with length above that (capped at 1.2 MB), 1.5 MB for featured
 * (hero) reels.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GalleryEntry } from './catalog/build';
import { pool, type Meta } from './render';

const run = promisify(execFile);
const KB = 1024;

export function budgetBytes(durationSeconds: number, featured: boolean): number {
  if (featured) return 1500 * KB;
  if (durationSeconds <= 15) return 800 * KB;
  return Math.min(1200 * KB, Math.round(((800 * durationSeconds) / 15) * KB));
}

export function hashName(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
}

export interface MediaFile {
  key: string;
  file: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export interface MediaEntry {
  slug: string;
  mp4: MediaFile;
  webm: MediaFile;
  poster: { avif: MediaFile; jpg: MediaFile; avif360: MediaFile; jpg360: MediaFile };
  crf: { mp4: number; webm: number };
  budgetBytes: number;
}

async function encodeUnderBudget(build: (crf: number) => string[], out: string, start: number, step: number, max: number, budget: number): Promise<number> {
  let crf = start;
  for (;;) {
    await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...build(crf), out], { maxBuffer: 10 * 1024 * 1024 });
    if (statSync(out).size <= budget || crf >= max) return crf;
    crf = Math.min(max, crf + step);
  }
}

function media(dir: string, slug: string, name: string, ext: string, src: string, contentType: string): MediaFile {
  const hash = hashName(src);
  const fileName = `${name}.${hash}.${ext}`;
  const dest = join(dir, fileName);
  renameSync(src, dest);
  return { key: `gallery/${slug}/${fileName}`, file: dest, bytes: statSync(dest).size, sha256: createHash('sha256').update(readFileSync(dest)).digest('hex'), contentType };
}

export async function transcodeOne(outDir: string, entry: GalleryEntry): Promise<MediaEntry> {
  const slug = entry.gallery.slug;
  const src = join(outDir, slug, 'final.mp4');
  const meta = JSON.parse(readFileSync(join(outDir, slug, 'meta.json'), 'utf8')) as Meta;
  const posterPng = join(outDir, slug, 'poster.png');
  if (!existsSync(posterPng)) throw new Error(`${slug}: run "gallery check" first (no poster.png)`);
  const dir = join(outDir, 'web', slug);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const budget = budgetBytes(meta.durationSeconds, meta.featured);
  const scale = 'scale=720:1280:flags=lanczos';
  const mp4Tmp = join(dir, 'tmp.mp4');
  const mp4Crf = await encodeUnderBudget(
    (crf) => ['-i', src, '-vf', scale, '-an', '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-g', '60'],
    mp4Tmp,
    23,
    2,
    35,
    budget
  );
  const webmTmp = join(dir, 'tmp.webm');
  const webmCrf = await encodeUnderBudget(
    (crf) => ['-i', src, '-vf', scale, '-an', '-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '3', '-g', '60'],
    webmTmp,
    34,
    3,
    48,
    budget
  );
  const jpg = join(dir, 'tmp.jpg');
  const jpg360 = join(dir, 'tmp360.jpg');
  const avif = join(dir, 'tmp.avif');
  const avif360 = join(dir, 'tmp360.avif');
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', posterPng, '-vf', scale, '-q:v', '3', jpg]);
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', posterPng, '-vf', 'scale=360:640:flags=lanczos', '-q:v', '4', jpg360]);
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', posterPng, '-vf', `${scale},format=yuv420p`, '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', '32', '-b:v', '0', '-cpu-used', '6', avif]);
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', posterPng, '-vf', 'scale=360:640:flags=lanczos,format=yuv420p', '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', '34', '-b:v', '0', '-cpu-used', '6', avif360]);
  const entryOut: MediaEntry = {
    slug,
    mp4: media(dir, slug, slug, 'mp4', mp4Tmp, 'video/mp4'),
    webm: media(dir, slug, slug, 'webm', webmTmp, 'video/webm'),
    poster: {
      avif: media(dir, slug, 'poster', 'avif', avif, 'image/avif'),
      jpg: media(dir, slug, 'poster', 'jpg', jpg, 'image/jpeg'),
      avif360: media(dir, slug, 'poster-360', 'avif', avif360, 'image/avif'),
      jpg360: media(dir, slug, 'poster-360', 'jpg', jpg360, 'image/jpeg'),
    },
    crf: { mp4: mp4Crf, webm: webmCrf },
    budgetBytes: budget,
  };
  // The full-size PNG poster was an intermediate.
  rmSync(posterPng, { force: true });
  return entryOut;
}

export function readMedia(outDir: string): Record<string, MediaEntry> {
  const f = join(outDir, 'web', 'media.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).entries as Record<string, MediaEntry>) : {};
}

export async function transcodeAll(outDir: string, entries: GalleryEntry[], opts: { concurrency: number; force?: boolean }): Promise<{ done: number; skipped: number }> {
  const all = readMedia(outDir);
  const quality = existsSync(join(outDir, 'quality.json')) ? JSON.parse(readFileSync(join(outDir, 'quality.json'), 'utf8')) : { results: [] };
  const passed = new Set<string>((quality.results as any[]).filter((r) => r.ok).map((r) => r.slug));
  const rejected = existsSync(join(outDir, 'rejected.json')) ? new Set<string>(Object.keys(JSON.parse(readFileSync(join(outDir, 'rejected.json'), 'utf8')))) : new Set<string>();
  let done = 0;
  let skipped = 0;
  const todo = entries.filter((e) => {
    const s = e.gallery.slug;
    if (!passed.has(s) || rejected.has(s)) {
      skipped++;
      return false;
    }
    if (!opts.force && all[s] && existsSync(all[s]!.mp4.file)) {
      skipped++;
      return false;
    }
    return true;
  });
  await pool(todo, opts.concurrency, async (e) => {
    all[e.gallery.slug] = await transcodeOne(outDir, e);
    done++;
    const m = all[e.gallery.slug]!;
    console.log(`transcode ${e.gallery.slug}: mp4 ${(m.mp4.bytes / KB).toFixed(0)} KB (crf ${m.crf.mp4}), webm ${(m.webm.bytes / KB).toFixed(0)} KB, poster ${(m.poster.avif.bytes / KB).toFixed(0)} KB avif, budget ${(m.budgetBytes / KB).toFixed(0)} KB`);
    writeFileSync(join(outDir, 'web', 'media.json'), JSON.stringify({ updatedAt: new Date().toISOString(), entries: all }, null, 2));
  });
  // Drop web folders of reels that were rejected since.
  if (existsSync(join(outDir, 'web'))) {
    for (const d of readdirSync(join(outDir, 'web'))) {
      if (d !== 'media.json' && rejected.has(d)) {
        rmSync(join(outDir, 'web', d), { recursive: true, force: true });
        delete all[d];
      }
    }
    writeFileSync(join(outDir, 'web', 'media.json'), JSON.stringify({ updatedAt: new Date().toISOString(), entries: all }, null, 2));
  }
  return { done, skipped };
}
