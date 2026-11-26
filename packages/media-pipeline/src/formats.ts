import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { OUTPUT_FILES, type FormatSpec } from '@renderweld/project-schema';
import { encoderSettings, encoderThreadArgs, PipelineError, run } from './ffmpeg';
import { rateArg, rateFraction, rateValue, type Rate } from './rate';

/**
 * Output formats beyond H.264 MP4 (#302, D-123): the encoder of each format,
 * what its file must probe as, and the packaging steps of GIF and PNG
 * sequences. H.264 MP4 keeps its own path (h264Args(), #349's settings) and
 * is not described here.
 *
 * A render assembles its clips once with the format's encoder ("the master"):
 * the final file for MOV and WebM, a lossless FFV1 master for GIF and PNG
 * sequences, which are then made from it (palette GIF; PNG frames in a zip).
 * Captions are burned into the master, so every format gets them.
 *
 * Audio (#301, D-116): MOV and WebM get the render's one normalised PCM mix in
 * assemble()'s second pass (video stream copied): 24-bit PCM in MOV, Opus in
 * WebM. GIF and PNG sequences have no audio (no mix, no A/V or loudness
 * check); audio-only formats encode the mix with no video pass.
 *
 * Memory (#349, D-117): every video encoder gets render.encoderThreads
 * (`-threads`), and libvpx and libaom also the look-ahead cap
 * (render.encoderLookahead as `-lag-in-frames`, at most 25); SVT-AV1 keeps
 * its own look-ahead (no option for it that works on FFmpeg 5.1 to 7).
 */

/** Quality settings per format (runtime config `render.formats.*`; process-wide like setEncoderSettings, #349). */
export interface FormatSettings {
  /** libvpx-vp9 constant quality (0-63, lower is better). */
  vp9Crf: number;
  /** libvpx-vp9 -cpu-used with -deadline good (0-8, higher is faster). */
  vp9CpuUsed: number;
  /** AV1 constant quality (SVT-AV1 / libaom, 0-63). */
  av1Crf: number;
  /** SVT-AV1 preset (0-13, higher is faster); libaom gets cpu-used min(preset, 8). */
  av1Preset: number;
  /** GIF frame rate (at most the project's). */
  gifFps: number;
  /** Longest GIF side in pixels (scaled down, never up). */
  gifMaxSide: number;
  /** paletteuse dither. */
  gifDither: 'sierra2_4a' | 'floyd_steinberg' | 'bayer' | 'none';
  /** AAC bitrate of m4a output, kbit/s. */
  aacKbps: number;
  /** Opus bitrate of WebM audio, kbit/s. */
  opusKbps: number;
}

export const DEFAULT_FORMAT_SETTINGS: Readonly<FormatSettings> = Object.freeze({
  vp9Crf: 31,
  vp9CpuUsed: 4,
  av1Crf: 35,
  av1Preset: 8,
  gifFps: 15,
  gifMaxSide: 480,
  gifDither: 'sierra2_4a',
  aacKbps: 192,
  opusKbps: 128,
});
let settings: FormatSettings = { ...DEFAULT_FORMAT_SETTINGS };

export function setFormatSettings(s: Partial<FormatSettings>): void {
  settings = { ...settings, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) };
}
export function formatSettings(): Readonly<FormatSettings> {
  return { ...settings };
}

/** How the assembled file (the master) of a non-MP4 format is encoded. */
export interface MasterEncoding {
  /** File name of the master in the render directory. */
  file: string;
  /** Pixel format of the assembly filter graph's output. */
  pixFmt: string;
  /** Pad colour around a clip of another aspect ratio (transparent with alpha). */
  padColor: string;
  video: string[];
  /** null: no audio stream. */
  audio: string[] | null;
  /** The master is the final file (MOV, WebM). */
  final: boolean;
}

export interface FormatPlan {
  spec: FormatSpec;
  /** The file the render delivers (final.webm, frames.zip, ...). */
  file: string;
  contentType: string;
  kind: 'video' | 'animation' | 'image-sequence' | 'audio';
  /** Whether the delivered file has an audio stream. */
  audio: boolean;
  /** null for audio-only formats. */
  master: MasterEncoding | null;
  /** FFmpeg encoders it needs (any of each inner list). */
  encoders: string[][];
  /** What ffprobe must report for the delivered file. */
  expect: { videoCodec: string | null; pixelFormats: string[]; profile?: string; audioCodec: string | null };
}

export const OUTPUT_CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.gif': 'image/gif',
  '.zip': 'application/zip',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

const AV1_ENCODERS = ['libsvtav1', 'libaom-av1'];
const ffv1 = (alpha: boolean): Pick<MasterEncoding, 'pixFmt' | 'video'> => {
  const pixFmt = alpha ? 'yuva444p' : 'yuv444p';
  return { pixFmt, video: ['-c:v', 'ffv1', '-level', '3', '-g', '1', '-pix_fmt', pixFmt, ...encoderThreadArgs()] };
};

/** libvpx keeps at most 25 frames of look-ahead (MAX_LAG_BUFFERS); libaom's default is 35 (19 in realtime). */
const LIBVPX_MAX_LAG = 25;
/**
 * render.encoderLookahead as `-lag-in-frames` (libvpx-vp9, libaom-av1; both
 * FFmpeg 4+): the frames the encoder holds for its alt-ref and rate control.
 * 0 keeps the encoder's own.
 */
function lagArgs(): string[] {
  const l = encoderSettings().lookahead;
  return l > 0 ? ['-lag-in-frames', String(Math.min(l, LIBVPX_MAX_LAG))] : [];
}

/**
 * The encoding plan of a format. `av1Encoder` picks the AV1 encoder this
 * FFmpeg has (encodersOf()); default libsvtav1.
 */
export function formatPlan(spec: FormatSpec, opts: { av1Encoder?: string } = {}): FormatPlan {
  const s = settings;
  const file = OUTPUT_FILES[spec.format];
  const contentType = OUTPUT_CONTENT_TYPES[file.slice(file.lastIndexOf('.'))]!;
  const pad = spec.alpha ? 'black@0' : 'black';
  switch (spec.codec) {
    case 'prores-422-hq':
    case 'prores-4444': {
      const hq = spec.codec === 'prores-422-hq';
      const pixFmt = hq ? 'yuv422p10le' : spec.alpha ? 'yuva444p10le' : 'yuv444p10le';
      const video = ['-c:v', 'prores_ks', '-profile:v', hq ? '3' : '4', '-vendor', 'apl0', '-pix_fmt', pixFmt, ...(spec.alpha ? ['-alpha_bits', '16'] : []), ...encoderThreadArgs()];
      return {
        spec, file, contentType, kind: 'video', audio: true,
        master: { file, pixFmt, padColor: pad, video, audio: ['-c:a', 'pcm_s24le', '-ar', '48000'], final: true },
        encoders: [['prores_ks'], ['pcm_s24le']],
        // FFmpeg decodes ProRes 4444 at 12 bits (yuva444p12le / yuv444p12le).
        expect: { videoCodec: 'prores', pixelFormats: hq ? ['yuv422p10le'] : spec.alpha ? ['yuva444p12le', 'yuva444p10le'] : ['yuv444p12le', 'yuv444p10le'], profile: hq ? 'HQ' : '4444', audioCodec: 'pcm_s24le' },
      };
    }
    case 'vp9': {
      const pixFmt = spec.alpha ? 'yuva420p' : 'yuv420p';
      const video = ['-c:v', 'libvpx-vp9', '-pix_fmt', pixFmt, '-crf', String(s.vp9Crf), '-b:v', '0', '-deadline', 'good', '-cpu-used', String(s.vp9CpuUsed), '-row-mt', '1', ...(spec.alpha ? ['-auto-alt-ref', '0'] : []), ...encoderThreadArgs(), ...lagArgs()];
      return {
        spec, file, contentType, kind: 'video', audio: true,
        master: { file, pixFmt, padColor: pad, video, audio: ['-c:a', 'libopus', '-b:a', `${s.opusKbps}k`, '-ar', '48000'], final: true },
        encoders: [['libvpx-vp9'], ['libopus']],
        // VP9 alpha is a second stream in BlockAdditional: ffprobe reports yuv420p and the tag alpha_mode=1.
        expect: { videoCodec: 'vp9', pixelFormats: ['yuv420p'], audioCodec: 'opus' },
      };
    }
    case 'av1': {
      const enc = opts.av1Encoder ?? 'libsvtav1';
      const video =
        enc === 'libaom-av1'
          ? ['-c:v', 'libaom-av1', '-pix_fmt', 'yuv420p', '-crf', String(s.av1Crf), '-b:v', '0', '-cpu-used', String(Math.min(s.av1Preset, 8)), '-row-mt', '1', ...encoderThreadArgs(), ...lagArgs()]
          : // SVT-AV1: the thread cap only. Its look-ahead option is `la_depth` on FFmpeg 5.1 (deprecated in 6, gone
            // in 7) or `svtav1-params lookahead=` (depends on the SVT-AV1 version linked), so it is left to SVT. VERIFY
            // that 5.1's wrapper passes -threads on (6.1 declares the threads capability; an encoder without it ignores it).
            ['-c:v', 'libsvtav1', '-pix_fmt', 'yuv420p', '-crf', String(s.av1Crf), '-preset', String(s.av1Preset), ...encoderThreadArgs()];
      return {
        spec, file, contentType, kind: 'video', audio: true,
        master: { file, pixFmt: 'yuv420p', padColor: pad, video, audio: ['-c:a', 'libopus', '-b:a', `${s.opusKbps}k`, '-ar', '48000'], final: true },
        encoders: [AV1_ENCODERS, ['libopus']],
        expect: { videoCodec: 'av1', pixelFormats: ['yuv420p'], audioCodec: 'opus' },
      };
    }
    case 'gif':
      return {
        spec, file, contentType, kind: 'animation', audio: false,
        master: { file: 'master.mkv', padColor: pad, audio: null, final: false, ...ffv1(false) },
        encoders: [['ffv1'], ['gif']],
        expect: { videoCodec: 'gif', pixelFormats: ['bgra', 'pal8', 'bgr8'], audioCodec: null },
      };
    case 'png':
      return {
        spec, file, contentType, kind: 'image-sequence', audio: false,
        master: { file: 'master.mkv', padColor: pad, audio: null, final: false, ...ffv1(spec.alpha) },
        encoders: [['ffv1'], ['png']],
        expect: { videoCodec: 'png', pixelFormats: [spec.alpha ? 'rgba' : 'rgb24'], audioCodec: null },
      };
    case 'aac':
      return { spec, file, contentType, kind: 'audio', audio: true, master: null, encoders: [['aac']], expect: { videoCodec: null, pixelFormats: [], audioCodec: 'aac' } };
    case 'pcm-s16le':
      return { spec, file, contentType, kind: 'audio', audio: true, master: null, encoders: [['pcm_s16le']], expect: { videoCodec: null, pixelFormats: [], audioCodec: 'pcm_s16le' } };
    case 'h264':
      throw new PipelineError('setup', 'H.264 MP4 uses the default encode (h264Args()), not a format plan');
  }
}

/** The file extension's content type (render outputs). */
export function outputContentType(file: string): string | null {
  const dot = file.lastIndexOf('.');
  return dot < 0 ? null : (OUTPUT_CONTENT_TYPES[file.slice(dot)] ?? null);
}

const encoderCache = new Map<string, Promise<Set<string>>>();

/** The encoders an FFmpeg has (`ffmpeg -encoders`), asked once per binary without blocking. */
export function encodersOf(ffmpeg: string): Promise<Set<string>> {
  let p = encoderCache.get(ffmpeg);
  if (!p) {
    p = new Promise((resolve) => {
      execFile(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        const set = new Set<string>();
        if (!err) for (const m of stdout.matchAll(/^\s*[VAS][A-Z.]{5}\s+(\S+)/gm)) set.add(m[1]!);
        if (err) encoderCache.delete(ffmpeg);
        resolve(set);
      });
    });
    encoderCache.set(ffmpeg, p);
  }
  return p;
}

const assAlphaCache = new Map<string, Promise<boolean>>();

/** Whether this FFmpeg's libass filter can draw into an alpha channel (`ass=...:alpha=1`, FFmpeg 5+). */
export function assHasAlpha(ffmpeg: string): Promise<boolean> {
  let p = assAlphaCache.get(ffmpeg);
  if (!p) {
    p = new Promise((resolve) => {
      execFile(ffmpeg, ['-hide_banner', '-h', 'filter=ass'], { encoding: 'utf8', timeout: 10_000 }, (err, stdout) => resolve(!err && /^\s+alpha\s/m.test(stdout)));
    });
    assAlphaCache.set(ffmpeg, p);
  }
  return p;
}

/** The AV1 encoder to use, or null when this FFmpeg has none. */
export function av1EncoderFrom(encoders: Set<string>): string | null {
  return AV1_ENCODERS.find((e) => encoders.has(e)) ?? null;
}

/** Encoders the plan needs that this FFmpeg lacks (one name per missing group). */
export function missingEncoders(plan: FormatPlan, encoders: Set<string>): string[] {
  return plan.encoders.filter((group) => !group.some((e) => encoders.has(e))).map((g) => g.join(' or '));
}

/**
 * GIF output size and frame rate for a master of `width`x`height` at `fps`:
 * the project's exact rate (e.g. "30000/1001") when it is not above
 * render.formats.gifFps, else gifFps. `fps` is the rate as a number, `rate`
 * the exact FFmpeg argument.
 */
export function gifGeometry(width: number, height: number, fps: Rate, s: FormatSettings = settings): { width: number; height: number; fps: number; rate: string } {
  const scale = Math.min(1, s.gifMaxSide / Math.max(width, height));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  const keep = rateValue(fps) <= s.gifFps;
  return { width: even(width), height: even(height), fps: keep ? rateValue(fps) : s.gifFps, rate: keep ? rateFraction(fps) : String(s.gifFps) };
}

/**
 * Frames a GIF of `frames` master frames at `fps` has at `gifRate`: the same
 * frames when the rate is kept, else FFmpeg's fps filter's count (it rounds
 * to the nearest output frame), from the exact rates, so 29.97 has no drift.
 */
export function gifFrames(frames: number, fps: Rate, gifRate: Rate): number {
  if (rateFraction(gifRate) === rateFraction(fps)) return frames;
  return Math.round((frames * rateValue(gifRate)) / rateValue(fps));
}

/**
 * GIF from the master: two-pass palette (palettegen with stats_mode=diff,
 * then paletteuse), at the GIF frame rate and size, looping forever.
 */
export async function encodeGif(o: { ffmpeg: string; master: string; out: string; width: number; height: number; fps: Rate; frames: number; seconds: number; signal?: AbortSignal }): Promise<{ args: string[]; frames: number }> {
  const s = settings;
  const g = gifGeometry(o.width, o.height, o.fps, s);
  const dither = s.gifDither === 'bayer' ? 'bayer:bayer_scale=3' : s.gifDither;
  const args = [
    '-hide_banner', '-v', 'error', '-y', '-i', o.master,
    '-filter_complex',
    `[0:v]fps=${rateArg(g.rate)},scale=${g.width}:${g.height}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`,
    '-loop', '0', '-t', o.seconds.toFixed(6), o.out,
  ];
  await run(o.ffmpeg, args, 'format:gif', { signal: o.signal });
  return { args, frames: gifFrames(o.frames, o.fps, g.rate) };
}

/** Most entries a zip without ZIP64 holds. */
export const MAX_ZIP_ENTRIES = 65_535;

/**
 * PNG sequence: every frame of the master as `frame_000001.png` (RGBA with
 * alpha, else RGB), stored in a zip (PNG is already compressed, so the zip
 * stores without deflate). Frames are written to `workDir` and removed as
 * they go into the zip.
 */
export async function encodePngZip(o: { ffmpeg: string; master: string; out: string; workDir: string; alpha: boolean; frames: number; signal?: AbortSignal }): Promise<{ args: string[]; entries: number }> {
  if (o.frames > MAX_ZIP_ENTRIES) throw new PipelineError('format:png-sequence', `${o.frames} frames is more than a zip holds (${MAX_ZIP_ENTRIES})`);
  await mkdir(o.workDir, { recursive: true });
  const args = ['-hide_banner', '-v', 'error', '-y', '-i', o.master, '-map', '0:v:0', '-c:v', 'png', '-pix_fmt', o.alpha ? 'rgba' : 'rgb24', '-start_number', '1', join(o.workDir, 'frame_%06d.png')];
  await run(o.ffmpeg, args, 'format:png-sequence', { signal: o.signal });
  const names = (await readdir(o.workDir)).filter((n) => /^frame_\d{6}\.png$/.test(n)).sort();
  await writeStoredZip(o.out, o.workDir, names, true);
  await rm(o.workDir, { recursive: true, force: true });
  return { args, entries: names.length };
}

/**
 * A zip (stored, no compression) of `names` from `dir`, in order. Fails past
 * 4 GiB or 65,535 entries (no ZIP64).
 */
export async function writeStoredZip(out: string, dir: string, names: string[], removeEach = false): Promise<void> {
  if (names.length > MAX_ZIP_ENTRIES) throw new PipelineError('zip', `${names.length} files is more than a zip holds (${MAX_ZIP_ENTRIES})`);
  const ws = createWriteStream(out);
  const write = (b: Buffer) => new Promise<void>((resolve, reject) => ws.write(b, (e) => (e ? reject(e) : resolve())));
  const central: Buffer[] = [];
  let offset = 0;
  const LIMIT = 0xffffffff;
  // MS-DOS time of 1980-01-01 00:00 (fixed: the same frames give the same zip).
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  try {
    for (const name of names) {
      const file = join(dir, name);
      const { size } = await stat(file);
      let crc = 0;
      for await (const chunk of createReadStream(file)) crc = crc32(chunk as Buffer, crc);
      const nameBuf = Buffer.from(name, 'utf8');
      if (offset + 30 + nameBuf.length + size > LIMIT) throw new PipelineError('zip', 'the zip would be larger than 4 GiB (no ZIP64)');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(crc >>> 0, 14);
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      await write(local);
      await write(nameBuf);
      for await (const chunk of createReadStream(file)) await write(chunk as Buffer);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(dosTime, 12);
      c.writeUInt16LE(dosDate, 14);
      c.writeUInt32LE(crc >>> 0, 16);
      c.writeUInt32LE(size, 20);
      c.writeUInt32LE(size, 24);
      c.writeUInt16LE(nameBuf.length, 28);
      c.writeUInt32LE(offset, 42);
      central.push(c, nameBuf);
      offset += 30 + nameBuf.length + size;
      if (removeEach) await rm(file, { force: true });
    }
    const cd = Buffer.concat(central);
    if (offset + cd.length > LIMIT) throw new PipelineError('zip', 'the zip would be larger than 4 GiB (no ZIP64)');
    await write(cd);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(names.length, 8);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    await write(end);
  } finally {
    await new Promise<void>((resolve) => ws.end(() => resolve()));
  }
}

export interface ZipEntry {
  name: string;
  bytes: number;
  /** Offset of the entry's data in the zip. */
  dataOffset: number;
}

/** The entries of a stored zip (read from its central directory). */
export async function zipEntries(file: string): Promise<ZipEntry[]> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new PipelineError('zip', `${file} is not a zip`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new PipelineError('zip', `${file}: bad central directory entry ${i}`);
      const bytes = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, local);
      out.push({ name, bytes, dataOffset: local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Width, height and colour type of a PNG entry (IHDR): 6 = RGBA, 2 = RGB. */
export async function zipPngHeader(file: string, entry: ZipEntry): Promise<{ width: number; height: number; colorType: number; bitDepth: number }> {
  const fh = await open(file, 'r');
  try {
    const b = Buffer.alloc(33);
    await fh.read(b, 0, 33, entry.dataOffset);
    if (b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') throw new PipelineError('zip', `${entry.name} is not a PNG`);
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bitDepth: b[24]!, colorType: b[25]! };
  } finally {
    await fh.close();
  }
}

/** Alpha plane of one frame: whether the decoded stream has one, and its 8-bit min and max (null without alpha). */
export async function alphaStats(ffmpeg: string, file: string, frame = 0, opts: { vp9?: boolean } = {}): Promise<{ min: number; max: number } | null> {
  try {
    const { stdout } = await run(
      ffmpeg,
      ['-hide_banner', '-v', 'error', ...(opts.vp9 ? ['-c:v', 'libvpx-vp9'] : []), '-i', file, '-vf', `select=eq(n\\,${frame}),alphaextract,format=gray,signalstats,metadata=print:file=-`, '-frames:v', '1', '-f', 'null', '-'],
      'probe:alpha'
    );
    const get = (k: string) => Number(new RegExp(`lavfi\\.signalstats\\.${k}=([0-9.]+)`).exec(stdout)?.[1] ?? NaN);
    const min = get('YMIN');
    const max = get('YMAX');
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
  } catch {
    return null; // "Requested planes not available": no alpha
  }
}
