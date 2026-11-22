// ffmpeg wrappers: screenshots to WebP within a byte budget, walkthrough
// recordings to small H.264 MP4 + VP9 WebM with posters. Needs ffmpeg 6+ with
// libwebp, libx264 and libvpx-vp9 (docs/CAPTURE.md).

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BUDGETS, encodeLadder, sha256 } from './lib.mjs';

const run = promisify(execFile);
const ffmpeg = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });

/** Width and height of a PNG from its header. */
export function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Encodes a PNG screenshot to WebP: walks the ladder (size, then quality)
 * until the file fits the budget. Returns what was written; `overBudget` is
 * true when even the last step was too big (the smallest one is kept).
 */
export async function pngToWebp(png, outFile, { crop, maxBytes = BUDGETS[crop] ?? BUDGETS.fold }) {
  const { width, height } = pngSize(png);
  const dir = mkdtempSync(join(tmpdir(), 'rf-capture-'));
  try {
    const src = join(dir, 'in.png');
    writeFileSync(src, png);
    let last = null;
    for (const step of encodeLadder({ width, height, crop, maxBytes })) {
      const out = join(dir, `out-${step.width}-${step.quality}.webp`);
      await ffmpeg(['-i', src, '-vf', `scale=${step.width}:${step.height}:flags=lanczos`, '-c:v', 'libwebp', '-quality', String(step.quality), '-compression_level', '6', '-preset', 'picture', out]);
      const bytes = statSync(out).size;
      last = { out, bytes, ...step };
      if (bytes <= maxBytes) break;
    }
    renameSync(last.out, outFile);
    return { file: outFile, bytes: last.bytes, width: last.width, height: last.height, quality: last.quality, overBudget: last.bytes > maxBytes, sha256: sha256(readFileSync(outFile)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Duration in seconds, width and height of a media file (ffprobe). */
export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const v = (j.streams ?? []).find((s) => s.width) ?? {};
  return { duration: Number(j.format?.duration ?? 0), width: v.width, height: v.height, codec: v.codec_name };
}

/**
 * A raw Playwright recording (VP8 WebM) to the published files:
 *   <slug>.<hash8>.mp4   H.264 High, yuv420p, faststart, no audio
 *   <slug>.<hash8>.webm  VP9
 *   <slug>.<hash8>.jpg   poster (and a WebP poster for BuildBase assets)
 * `trimStart` drops the blank first frames Playwright records before the page
 * paints. Raises the CRF until each file fits `maxBytes`.
 */
export async function transcodeWalkthrough(raw, outDir, slug, { width = 1280, height = 720, posterAt = 2, trimStart = 0, maxBytes = 4_000_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rf-walk-'));
  try {
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=25`;
    const ss = trimStart > 0 ? ['-ss', String(trimStart)] : [];
    const mp4 = join(dir, 'w.mp4');
    for (const crf of [28, 31, 34, 37]) {
      await ffmpeg([...ss, '-i', raw, '-vf', vf, '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
      if (statSync(mp4).size <= maxBytes) break;
    }
    const hash8 = sha256(readFileSync(mp4)).slice(0, 8);
    const base = join(outDir, `${slug}.${hash8}`);
    renameSync(mp4, `${base}.mp4`);
    for (const crf of [40, 44, 48, 52]) {
      await ffmpeg([...ss, '-i', raw, '-vf', vf, '-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-an', `${base}.webm`]);
      if (statSync(`${base}.webm`).size <= maxBytes) break;
    }
    const info = await probe(`${base}.mp4`);
    const at = Math.min(posterAt, Math.max(0, info.duration - 0.5));
    await ffmpeg(['-ss', String(at), '-i', `${base}.mp4`, '-frames:v', '1', '-q:v', '4', `${base}.jpg`]);
    await ffmpeg(['-ss', String(at), '-i', `${base}.mp4`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '75', `${base}.poster.webp`]);
    return {
      slug,
      hash8,
      duration: Math.round(info.duration * 10) / 10,
      width: info.width,
      height: info.height,
      files: {
        mp4: { file: `${base}.mp4`, bytes: statSync(`${base}.mp4`).size },
        webm: { file: `${base}.webm`, bytes: statSync(`${base}.webm`).size },
        jpg: { file: `${base}.jpg`, bytes: statSync(`${base}.jpg`).size },
        posterWebp: { file: `${base}.poster.webp`, bytes: statSync(`${base}.poster.webp`).size },
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A VP9 WebM copy of a reel, for playback in Playwright's Chromium (no H.264 there). */
export async function toPlayableWebm(src, out, { height = 1280 } = {}) {
  await ffmpeg(['-i', src, '-vf', `scale=-2:${height}`, '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '5', '-an', out]);
  return out;
}

/**
 * A contact sheet of a rendered reel: `count` frames spread over the
 * duration, side by side, each `thumbHeight` px tall, as a PNG buffer.
 */
export async function contactSheet(video, { count = 6, thumbHeight = 480 } = {}) {
  const { duration } = await probe(video);
  const dir = mkdtempSync(join(tmpdir(), 'rf-sheet-'));
  try {
    const frames = [];
    for (let i = 0; i < count; i++) {
      const t = ((i + 0.5) * duration) / count;
      const f = join(dir, `f${i}.png`);
      await ffmpeg(['-ss', t.toFixed(2), '-i', video, '-frames:v', '1', '-vf', `scale=-2:${thumbHeight}`, f]);
      frames.push(f);
    }
    const out = join(dir, 'sheet.png');
    const inputs = frames.flatMap((f) => ['-i', f]);
    const pads = frames.map((_, i) => `[${i}:v]pad=iw+16:ih+16:8:8:color=0x111418[p${i}]`).join(';');
    const stack = `${frames.map((_, i) => `[p${i}]`).join('')}hstack=inputs=${frames.length}`;
    await ffmpeg([...inputs, '-filter_complex', `${pads};${stack}`, out]);
    return { png: readFileSync(out), times: frames.map((_, i) => Math.round((((i + 0.5) * duration) / count) * 10) / 10), duration };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
