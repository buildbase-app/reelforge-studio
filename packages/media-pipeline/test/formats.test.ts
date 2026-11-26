import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatSpec, type OutputCodec, type OutputFormat } from '@renderweld/project-schema';
import {
  ALPHA_CLIP_ARGS,
  alphaStats,
  assemble,
  assHasAlpha,
  av1EncoderFrom,
  burnSubtitles,
  checkAvSync,
  encodeAudioOnly,
  encodeGif,
  encodePngZip,
  encodersOf,
  formatPlan,
  gifFrames,
  gifGeometry,
  measureEbur128,
  measureLoudness,
  missingEncoders,
  mixAudio,
  normaliseLoudness,
  probe,
  probeAudio,
  resolveTools,
  run,
  setEncoderSettings,
  setFormatSettings,
  tagSeconds,
  DEFAULT_ENCODER_SETTINGS,
  DEFAULT_FORMAT_SETTINGS,
  writeStoredZip,
  zipEntries,
  zipPngHeader,
  type Tools,
} from '../src/index';

/** Output formats (#302) in the media pipeline: each format's master encode, GIF, PNG zip, audio only, alpha. */

let dir: string;
let tools: Tools;
let encoders: Set<string>;

const W = 160;
const H = 90;
const FPS = 30;

/** An opaque H.264 clip, or (alpha) a ProRes 4444 clip with a transparent background and an opaque box. */
async function clip(name: string, frames: number, alpha = false) {
  const file = join(dir, name);
  const src = alpha
    ? ['-f', 'lavfi', '-i', `color=c=black@0:s=${W}x${H}:r=${FPS},format=rgba`, '-f', 'lavfi', '-i', `color=c=0x3366cc:s=40x40:r=${FPS},format=rgba`, '-filter_complex', '[0][1]overlay=20:20:format=auto,format=rgba']
    : ['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${FPS}`];
  await run(tools.ffmpeg, ['-hide_banner', '-y', ...src, '-frames:v', String(frames), ...(alpha ? ALPHA_CLIP_ARGS : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']), file], 'fixture');
  return file;
}

const SOCIAL = { integrated: -14, truePeak: -2, lra: 11 };

const spec = (format: OutputFormat, codec?: OutputCodec, alpha = false) => formatSpec({ format, ...(codec ? { codec } : {}), alpha });

beforeAll(async () => {
  tools = resolveTools();
  dir = mkdtempSync(join(tmpdir(), 'reelforge-formats-'));
  encoders = await encodersOf(tools.ffmpeg);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('format masters (assemble with the format encoder)', () => {
  const cases: Array<{ name: string; s: ReturnType<typeof spec>; codec: string; pix: string[]; profile?: string; audio: string | null; alphaMode?: boolean }> = [
    { name: 'mov ProRes 422 HQ', s: spec('mov'), codec: 'prores', pix: ['yuv422p10le'], profile: 'HQ', audio: 'pcm_s24le' },
    { name: 'mov ProRes 4444 alpha', s: spec('mov', 'prores-4444', true), codec: 'prores', pix: ['yuva444p12le', 'yuva444p10le'], profile: '4444', audio: 'pcm_s24le' },
    { name: 'webm VP9', s: spec('webm'), codec: 'vp9', pix: ['yuv420p'], audio: 'opus' },
    { name: 'webm VP9 alpha', s: spec('webm', 'vp9', true), codec: 'vp9', pix: ['yuv420p'], audio: 'opus', alphaMode: true },
    { name: 'webm AV1', s: spec('webm', 'av1'), codec: 'av1', pix: ['yuv420p'], audio: 'opus' },
    { name: 'gif master (FFV1)', s: spec('gif'), codec: 'ffv1', pix: ['yuv444p'], audio: null },
    { name: 'png-sequence alpha master (FFV1)', s: spec('png-sequence', 'png', true), codec: 'ffv1', pix: ['yuva444p'], audio: null },
  ];
  for (const c of cases) {
    it(`${c.name}: codec, profile, pixel format, alpha, frames, duration, audio`, async () => {
      const av1 = av1EncoderFrom(encoders);
      if (c.s.codec === 'av1' && !av1) return; // reported by missingEncoders instead (checked below)
      const plan = formatPlan(c.s, { av1Encoder: av1 ?? undefined });
      expect(missingEncoders(plan, encoders)).toEqual([]);
      const a = await clip(`a-${c.s.codec}-${c.s.alpha}.${c.s.alpha ? 'mov' : 'mp4'}`, 20, c.s.alpha);
      const b = await clip(`b-${c.s.codec}-${c.s.alpha}.${c.s.alpha ? 'mov' : 'mp4'}`, 12, c.s.alpha);
      const out = join(dir, `out-${c.s.format}-${c.s.codec}-${c.s.alpha}-${plan.master!.file}`);
      await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 'a', file: a, frames: 15 }, { sceneId: 'b', file: b, frames: 10 }], out, width: W, height: H, fps: FPS, encoding: plan.master! });
      const info = await probe(tools.ffprobe, out);
      expect(info.videoCodec).toBe(c.codec);
      expect(c.pix).toContain(info.pixelFormat);
      if (c.profile) expect(info.videoProfile).toBe(c.profile);
      expect(info.frames).toBe(25);
      expect(Math.abs(info.durationSeconds - 25 / FPS)).toBeLessThan(0.035);
      expect(info.hasAudio).toBe(c.audio !== null);
      expect(info.audioCodec).toBe(c.audio);
      if (c.alphaMode !== undefined) expect(info.alphaMode).toBe(c.alphaMode);
      if (c.s.alpha) {
        // The alpha plane survives: transparent background (0) and an opaque box (255).
        const alpha = await alphaStats(tools.ffmpeg, out, 3, { vp9: c.s.codec === 'vp9' });
        expect(alpha).not.toBeNull();
        expect(alpha!.min).toBeLessThan(5);
        expect(alpha!.max).toBeGreaterThan(250);
      } else {
        expect(await alphaStats(tools.ffmpeg, out, 3, { vp9: c.s.codec === 'vp9' })).toBeNull();
      }
    }, 120_000);
  }

  it('reports encoders an FFmpeg lacks', () => {
    expect(missingEncoders(formatPlan(spec('webm', 'av1')), new Set(['libopus']))).toEqual(['libsvtav1 or libaom-av1']);
    expect(missingEncoders(formatPlan(spec('mov')), new Set())).toEqual(['prores_ks', 'pcm_s24le']);
  });
});

describe('GIF', () => {
  it('a palette GIF at the GIF frame rate and size: frame count, size, no audio', async () => {
    const master = join(dir, 'gif-master.mkv');
    const plan = formatPlan(spec('gif'));
    const a = await clip('gif-src.mp4', 60);
    await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 'a', file: a, frames: 60 }], out: master, width: 1280, height: 720, fps: FPS, encoding: plan.master! });
    const out = join(dir, 'final.gif');
    const r = await encodeGif({ ffmpeg: tools.ffmpeg, master, out, width: 1280, height: 720, fps: FPS, frames: 60, seconds: 2 });
    const g = gifGeometry(1280, 720, FPS);
    expect(g).toEqual({ width: 480, height: 270, fps: 15, rate: '15' });
    const info = await probe(tools.ffprobe, out);
    expect(info.videoCodec).toBe('gif');
    expect([info.width, info.height]).toEqual([480, 270]);
    expect(info.frames).toBe(r.frames);
    expect(r.frames).toBe(30);
    expect(Math.abs(info.durationSeconds - 2)).toBeLessThan(1 / 15 + 0.02);
    expect(info.hasAudio).toBe(false);
    expect(readFileSync(out).length).toBeLessThan(2_000_000);
  }, 60_000);
});

describe('PNG sequence zip', () => {
  it('writes one RGBA PNG per frame into a stored zip that unpacks with valid CRCs', async () => {
    const plan = formatPlan(spec('png-sequence', 'png', true));
    const master = join(dir, 'png-master.mkv');
    const a = await clip('png-src.mov', 12, true);
    await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 'a', file: a, frames: 12 }], out: master, width: W, height: H, fps: FPS, encoding: plan.master! });
    const out = join(dir, 'frames.zip');
    const r = await encodePngZip({ ffmpeg: tools.ffmpeg, master, out, workDir: join(dir, 'png-work'), alpha: true, frames: 12 });
    expect(r.entries).toBe(12);
    const entries = await zipEntries(out);
    expect(entries.map((e) => e.name)).toEqual(Array.from({ length: 12 }, (_, i) => `frame_${String(i + 1).padStart(6, '0')}.png`));
    expect(await zipPngHeader(out, entries[0]!)).toEqual({ width: W, height: H, colorType: 6, bitDepth: 8 });
    // Every entry's stored CRC matches its bytes (what unzip checks).
    const zip = readFileSync(out);
    for (const e of entries) {
      const data = zip.subarray(e.dataOffset, e.dataOffset + e.bytes);
      const localCrc = zip.readUInt32LE(e.dataOffset - 30 - e.name.length + 14);
      expect(crc32(data) >>> 0).toBe(localCrc);
    }
  }, 60_000);

  it('writeStoredZip keeps names and bytes', async () => {
    const src = join(dir, 'zsrc');
    rmSync(src, { recursive: true, force: true });
    (await import('node:fs')).mkdirSync(src);
    writeFileSync(join(src, 'a.txt'), 'hello');
    writeFileSync(join(src, 'b.bin'), Buffer.alloc(1000, 7));
    await writeStoredZip(join(dir, 't.zip'), src, ['a.txt', 'b.bin']);
    const e = await zipEntries(join(dir, 't.zip'));
    expect(e.map((x) => [x.name, x.bytes])).toEqual([['a.txt', 5], ['b.bin', 1000]]);
    expect(readFileSync(join(dir, 't.zip')).subarray(e[0]!.dataOffset, e[0]!.dataOffset + 5).toString()).toBe('hello');
  });
});

describe('audio only', () => {
  it('m4a (AAC) and wav (PCM) of the normalised mix, exact length, no video, on the social preset', async () => {
    const music = join(dir, 'tone.wav');
    await run(tools.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.6*sin(2*PI*220*t)+0.3*sin(2*PI*330*t):s=48000:d=5', music], 'fixture');
    // The render's audio path (D-116): one mix, two-pass loudnorm, then (#302) encoded without a video pass.
    const mix = join(dir, 'ao-mix.wav');
    await mixAudio({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, out: mix, totalSeconds: 2.5, music: { file: music, volume: 1 } });
    const measured = await measureLoudness(tools.ffmpeg, mix, SOCIAL);
    expect(measured.integrated!).toBeGreaterThan(-12); // far above the target before normalisation
    const norm = await normaliseLoudness({ ffmpeg: tools.ffmpeg, input: mix, out: join(dir, 'ao-norm.wav'), target: SOCIAL, measured });
    for (const [name, args, codec] of [['a.m4a', ['-c:a', 'aac', '-b:a', '192k'], 'aac'], ['a.wav', ['-c:a', 'pcm_s16le'], 'pcm_s16le']] as const) {
      const out = join(dir, name);
      const r = await encodeAudioOnly({ ffmpeg: tools.ffmpeg, input: norm.out, out, seconds: 2.5, codecArgs: [...args] });
      expect(r.args).not.toContain('-frames:v');
      expect(r.args.includes('-movflags')).toBe(name.endsWith('.m4a'));
      const a = await probeAudio(tools.ffprobe, out);
      expect(a).toMatchObject({ hasVideo: false, audioCodec: codec, sampleRate: 48000, channels: 2 });
      expect(Math.abs(a.durationSeconds - 2.5)).toBeLessThan(0.05);
      const got = await measureEbur128(tools.ffmpeg, out);
      expect(Math.abs(got.integrated! - SOCIAL.integrated), `${name}: ${got.integrated} LUFS`).toBeLessThanOrEqual(1);
      expect(got.truePeak!).toBeLessThanOrEqual(SOCIAL.truePeak);
    }
  }, 60_000);
});

describe('formats in the two-pass assemble with the render audio (#302 with #346, #349, #376)', () => {
  const NTSC = '30000/1001';

  it('a 29.97 WebM (VP9 + Opus) with audio: exact rate, A/V in sync within one frame, loudness on target', async () => {
    const plan = formatPlan(spec('webm'));
    const a = await clip('ntsc-a.mp4', 40);
    const b = await clip('ntsc-b.mp4', 40);
    const tone = join(dir, 'ntsc-tone.wav');
    await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.7*sin(2*PI*440*t)+0.2*sin(2*PI*660*t):s=48000:d=3', '-ac', '2', '-c:a', 'pcm_f32le', tone], 'fixture');
    const frames = 31 + 29; // 60 frames at 29.97 = 2.002 s
    const seconds = (frames * 1001) / 30000;
    const mix = join(dir, 'ntsc-mix.wav');
    await mixAudio({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, out: mix, totalSeconds: seconds, music: { file: tone, volume: 1 } });
    const norm = await normaliseLoudness({ ffmpeg: tools.ffmpeg, input: mix, out: join(dir, 'ntsc-norm.wav'), target: SOCIAL, measured: await measureLoudness(tools.ffmpeg, mix, SOCIAL) });
    const out = join(dir, 'ntsc.webm');
    const r = await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 'a', file: a, frames: 31 }, { sceneId: 'b', file: b, frames: 29 }], out, width: W, height: H, fps: NTSC, audioFile: norm.out, encoding: plan.master! });
    // Two passes: video only (VP9, frame-limited), then Opus muxed with the video copied; no MP4-only muxer flag.
    const split = r.args.indexOf('&&');
    expect(split).toBeGreaterThan(0);
    const [video, mux] = [r.args.slice(0, split), r.args.slice(split + 1)];
    expect(video).toContain('libvpx-vp9');
    expect(video).toContain('-an');
    expect(mux.join(' ')).toContain('-c:v copy');
    expect(mux).toContain('libopus');
    expect(mux).not.toContain('-movflags');
    const info = await probe(tools.ffprobe, out);
    expect(info.frameRate).toBe(NTSC);
    expect(info.frames).toBe(frames);
    expect(info.audioCodec).toBe('opus');
    const sync = await checkAvSync(tools.ffprobe, out, 30000 / 1001);
    expect(sync.problems).toEqual([]);
    expect(Math.abs(sync.audioDuration! - sync.videoDuration)).toBeLessThanOrEqual(1001 / 30000);
    // Opus' pre-skip (312 samples) is priming, not an offset: the first sample heard is at 0.
    expect(Math.abs(sync.audioStart!)).toBeLessThanOrEqual(0.001);
    expect(sync.videoDuration).toBeCloseTo(seconds, 3);
    const got = await measureEbur128(tools.ffmpeg, out);
    expect(Math.abs(got.integrated! - SOCIAL.integrated), `${got.integrated} LUFS`).toBeLessThanOrEqual(1);
    expect(got.truePeak!).toBeLessThanOrEqual(SOCIAL.truePeak);
    // A real offset in WebM is still reported.
    const late = join(dir, 'ntsc-late.webm');
    await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', out, '-itsoffset', '0.1', '-i', out, '-map', '0:v', '-map', '1:a', '-c', 'copy', late], 'fixture');
    expect((await checkAvSync(tools.ffprobe, late, 30000 / 1001)).problems.join(' ')).toMatch(/audio starts \d+\.\d ms after the video/);
  }, 120_000);

  it('reads Matroska DURATION tags with a linear scan', () => {
    expect(tagSeconds('00:00:02.002000000')).toBeCloseTo(2.002, 9);
    expect(tagSeconds('01:02:03.5')).toBe(3723.5);
    for (const bad of [undefined, '', '2.0', '00:00', 'aa:00:01', '00:00:01:00', '00:0.1:01', `${'0'.repeat(40)}:00:01`]) expect(tagSeconds(bad)).toBeNull();
  });

  it('a muted ProRes MOV: no audio stream with mutedTrack "none", a silent PCM track otherwise', async () => {
    const plan = formatPlan(spec('mov'));
    const a = await clip('mute-a.mp4', 30);
    const none = join(dir, 'muted-none.mov');
    const r = await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 'a', file: a, frames: 30 }], out: none, width: W, height: H, fps: FPS, noAudio: true, encoding: plan.master! });
    expect(r.args).not.toContain('&&'); // one pass: nothing to mux
    const i1 = await probe(tools.ffprobe, none);
    expect([i1.videoCodec, i1.videoProfile, i1.hasAudio, i1.frames]).toEqual(['prores', 'HQ', false, 30]);
    // A silent track (mutedTrack "silent"): the render's silent mix, in PCM, as long as the video.
    const silent = join(dir, 'muted-silent.wav');
    await mixAudio({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, out: silent, totalSeconds: 1 });
    const withTrack = join(dir, 'muted-silent.mov');
    await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 'a', file: a, frames: 30 }], out: withTrack, width: W, height: H, fps: FPS, audioFile: silent, encoding: plan.master! });
    const i2 = await probe(tools.ffprobe, withTrack);
    expect(i2.audioCodec).toBe('pcm_s24le');
    expect((await checkAvSync(tools.ffprobe, withTrack, FPS)).problems).toEqual([]);
    expect((await measureEbur128(tools.ffmpeg, withTrack)).integrated).toBeNull();
  }, 60_000);

  it('GIF and PNG masters have no audio pass, whatever audio is given', async () => {
    for (const s of [spec('gif'), spec('png-sequence')]) {
      const plan = formatPlan(s);
      expect(plan.audio).toBe(false);
      const a = await clip(`noaudio-${s.format}.mp4`, 10);
      const out = join(dir, `noaudio-${s.format}.mkv`);
      const r = await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 'a', file: a, frames: 10 }], out, width: W, height: H, fps: FPS, encoding: plan.master! });
      expect(r.args).not.toContain('&&');
      expect((await probe(tools.ffprobe, out)).hasAudio).toBe(false);
    }
  }, 60_000);

  it('a GIF keeps the exact 29.97 rate up to gifFps, and counts frames from exact rates above it', async () => {
    setFormatSettings({ gifFps: 30 });
    try {
      expect(gifGeometry(W, H, NTSC)).toMatchObject({ rate: NTSC });
      expect(gifFrames(300, NTSC, NTSC)).toBe(300);
      const plan = formatPlan(spec('gif'));
      const master = join(dir, 'gif-ntsc.mkv');
      const a = await clip('gif-ntsc.mp4', 45);
      await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: [{ sceneId: 'a', file: a, frames: 45 }], out: master, width: W, height: H, fps: NTSC, encoding: plan.master! });
      const out = join(dir, 'gif-ntsc.gif');
      const r = await encodeGif({ ffmpeg: tools.ffmpeg, master, out, width: W, height: H, fps: NTSC, frames: 45, seconds: (45 * 1001) / 30000 });
      expect(r.args.join(' ')).toContain(`fps=${NTSC}`);
      expect(r.frames).toBe(45);
      expect((await probe(tools.ffprobe, out)).frames).toBe(45);
    } finally {
      setFormatSettings({ gifFps: DEFAULT_FORMAT_SETTINGS.gifFps });
    }
    // At 15 fps from 29.97: 300 frames (10.01 s) give 150 GIF frames, not 150.15 rounded from a decimal rate.
    expect(gifGeometry(W, H, NTSC)).toMatchObject({ fps: 15, rate: '15' });
    expect(gifFrames(300, NTSC, 15)).toBe(150);
    expect(gifFrames(1001, NTSC, 15)).toBe(501);
  }, 60_000);

  it('every video encoder gets the encoder memory caps (render.encoderThreads, render.encoderLookahead)', () => {
    setEncoderSettings({ threads: 3, lookahead: 40 });
    try {
      const v = (s: ReturnType<typeof spec>, av1Encoder?: string) => formatPlan(s, av1Encoder ? { av1Encoder } : {}).master!.video.join(' ');
      for (const s of [spec('mov'), spec('mov', 'prores-4444', true), spec('webm'), spec('webm', 'vp9', true), spec('gif'), spec('png-sequence')]) expect(v(s)).toContain('-threads 3');
      expect(v(spec('webm', 'av1'), 'libsvtav1')).toContain('-threads 3');
      expect(v(spec('webm', 'av1'), 'libaom-av1')).toContain('-threads 3');
      // libvpx holds at most 25 frames of look-ahead; libaom gets the same cap.
      expect(v(spec('webm'))).toContain('-lag-in-frames 25');
      expect(v(spec('webm', 'av1'), 'libaom-av1')).toContain('-lag-in-frames 25');
      setEncoderSettings({ threads: 0, lookahead: 10 });
      expect(v(spec('mov'))).not.toContain('-threads');
      expect(v(spec('webm'))).toContain('-lag-in-frames 10');
      setEncoderSettings({ lookahead: 0 });
      expect(v(spec('webm'))).not.toContain('-lag-in-frames');
    } finally {
      setEncoderSettings({ ...DEFAULT_ENCODER_SETTINGS });
    }
  });
});

describe('captions burned into alpha', () => {
  it('libass draws into the alpha channel, so captions show over a transparent background', async () => {
    if (!(await assHasAlpha(tools.ffmpeg))) return;
    const a = await clip('cap-src.mov', 10, true);
    const assFile = join(dir, 'cap.ass');
    writeFileSync(
      assFile,
      `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
        `Style: Default,DejaVu Sans,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,3,4,0,2,4,4,4,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,HELLO\n`
    );
    const plan = formatPlan(spec('mov', 'prores-4444', true));
    const out = join(dir, 'cap-out.mov');
    await burnSubtitles({ ffmpeg: tools.ffmpeg, input: a, assFile, out, video: plan.master!.video, alpha: true });
    // The bottom band (where the caption box is) was fully transparent in the clip.
    const { stdout } = await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-i', out, '-vf', `crop=${W}:30:0:${H - 30},alphaextract,format=gray,signalstats,metadata=print:file=-`, '-frames:v', '1', '-f', 'null', '-'], 'probe');
    expect(Number(/YMAX=([0-9.]+)/.exec(stdout)?.[1])).toBeGreaterThan(200);
  }, 60_000);
});
