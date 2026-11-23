import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PipelineError,
  assemble,
  assertDecodable,
  avDurations,
  checkExpectation,
  checkTimestamps,
  concatClips,
  frameStats,
  normaliseClip,
  streamParams,
  probe,
  resolveTools,
  run,
  startPngEncoder,
  type Tools,
} from '../src/index';

let dir: string;
let tools: Tools;

/** Make a synthetic clip with FFmpeg's test source (no browser needed). */
async function makeClip(
  name: string,
  opts: { w: number; h: number; fps: number; frames: number; pixFmt?: string }
) {
  const file = join(dir, name);
  await run(
    tools.ffmpeg,
    [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${opts.w}x${opts.h}:rate=${opts.fps}`,
      '-frames:v',
      String(opts.frames),
      '-c:v',
      'libx264',
      '-pix_fmt',
      opts.pixFmt ?? 'yuv420p',
      file,
    ],
    'fixture'
  );
  return file;
}

beforeAll(() => {
  tools = resolveTools();
  dir = mkdtempSync(join(tmpdir(), 'reelforge-media-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveTools', () => {
  it('fails with an actionable message when FFmpeg is missing', () => {
    expect(() => resolveTools({ FFMPEG_PATH: '/nonexistent/ffmpeg' })).toThrow(/FFMPEG_PATH/);
    try {
      resolveTools({ FFMPEG_PATH: '/nonexistent/ffmpeg' });
    } catch (e) {
      expect(e).toBeInstanceOf(PipelineError);
      expect((e as PipelineError).stage).toBe('setup');
    }
  });
});

describe('assemble', () => {
  it('normalises clips of different size, fps and range into one exact-length MP4 with audio', async () => {
    // Scene A: wrong aspect and frame rate, full-range like Remotion output.
    const a = await makeClip('a.mp4', { w: 640, h: 360, fps: 25, frames: 60, pixFmt: 'yuvj420p' });
    // Scene B: right size, more frames than needed (must be trimmed, not kept).
    const b = await makeClip('b.mp4', { w: 360, h: 640, fps: 30, frames: 50 });
    const out = join(dir, 'final.mp4');

    const result = await assemble({
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      clips: [
        { sceneId: 'a', file: a, frames: 45 },
        { sceneId: 'b', file: b, frames: 30 },
      ],
      out,
      width: 360,
      height: 640,
      fps: 30,
    });
    expect(result.totalFrames).toBe(75);

    const info = await probe(tools.ffprobe, out);
    expect(checkExpectation(info, { width: 360, height: 640, fps: 30, frames: 75, audio: true })).toEqual([]);
    expect(info.durationSeconds).toBeCloseTo(2.5, 1);
    expect(info.audioCodec).toBe('aac');
    expect(info.audioSampleRate).toBe(48000);
    await assertDecodable(tools.ffmpeg, out);
  });

  it('fails clearly when a clip is shorter than its scene', async () => {
    const short = await makeClip('short.mp4', { w: 360, h: 640, fps: 30, frames: 10 });
    await expect(
      assemble({
        ffmpeg: tools.ffmpeg,
        ffprobe: tools.ffprobe,
        clips: [{ sceneId: 'too-short', file: short, frames: 30 }],
        out: join(dir, 'never.mp4'),
        width: 360,
        height: 640,
        fps: 30,
      })
    ).rejects.toThrow(/too-short.*10 frames but needs 30/);
  });

  it('fails clearly when a clip file is missing', async () => {
    await expect(
      assemble({
        ffmpeg: tools.ffmpeg,
        ffprobe: tools.ffprobe,
        clips: [{ sceneId: 'gone', file: join(dir, 'missing.mp4'), frames: 30 }],
        out: join(dir, 'never.mp4'),
        width: 360,
        height: 640,
        fps: 30,
      })
    ).rejects.toBeInstanceOf(PipelineError);
  });

  it('mixes a music track, trimmed to the video length', async () => {
    const clip = await makeClip('m.mp4', { w: 360, h: 640, fps: 30, frames: 60 });
    const music = join(dir, 'tone.wav');
    await run(
      tools.ffmpeg,
      ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', music],
      'fixture'
    );
    const out = join(dir, 'music.mp4');
    await assemble({
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      clips: [{ sceneId: 'm', file: clip, frames: 60 }],
      out,
      width: 360,
      height: 640,
      fps: 30,
      music: { file: music, volume: 0.5 },
    });
    const info = await probe(tools.ffprobe, out);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSeconds).toBeCloseTo(2, 1);
  });

  it('mixes music, a delayed voice and sound effects into one exact-length track', async () => {
    const clip = await makeClip('mix.mp4', { w: 360, h: 640, fps: 30, frames: 90 });
    const tone = async (name: string, freq: number, seconds: number) => {
      const f = join(dir, name);
      await run(tools.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, f], 'fixture');
      return f;
    };
    const out = join(dir, 'mix-out.mp4');
    const res = await assemble({
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      clips: [{ sceneId: 'mix', file: clip, frames: 90 }],
      out,
      width: 360,
      height: 640,
      fps: 30,
      music: { file: await tone('bed.wav', 220, 10), volume: 0.3, fadeOutSeconds: 0.5 },
      voice: { file: await tone('vo.wav', 660, 1), volume: 1, startSeconds: 0.5 },
      sfx: [{ file: await tone('pop.wav', 1200, 0.2), volume: 0.8, atSeconds: 2 }],
    });
    expect(res.args.join(' ')).toContain('amix=inputs=3');
    expect(res.args.join(' ')).toContain('adelay=500|500');
    const info = await probe(tools.ffprobe, out);
    expect(checkExpectation(info, { width: 360, height: 640, fps: 30, frames: 90, audio: true })).toEqual([]);
    expect(info.durationSeconds).toBeCloseTo(3, 1);
    await assertDecodable(tools.ffmpeg, out);
  });
});

describe('frameStats', () => {
  it('tells a flat frame from a detailed one', async () => {
    const flat = join(dir, 'flat.mp4');
    await run(tools.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=black:size=64x64:rate=30', '-frames:v', '3', '-pix_fmt', 'yuv420p', flat], 'fixture');
    const busy = await makeClip('busy.mp4', { w: 64, h: 64, fps: 30, frames: 3 });
    const a = await frameStats(tools.ffmpeg, flat, 0);
    const b = await frameStats(tools.ffmpeg, busy, 0);
    expect(a.yMax - a.yMin).toBeLessThan(5);
    expect(b.yMax - b.yMin).toBeGreaterThan(50);
  });
});

describe('assertDecodable', () => {
  it('rejects a truncated file', async () => {
    const good = await makeClip('t.mp4', { w: 360, h: 640, fps: 30, frames: 30 });
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync(good);
    const bad = join(dir, 'truncated.mp4');
    writeFileSync(bad, bytes.subarray(0, Math.floor(bytes.length / 3)));
    await expect(assertDecodable(tools.ffmpeg, bad)).rejects.toBeInstanceOf(PipelineError);
  });
});

describe('startPngEncoder', () => {
  it('encodes a PNG stream to a constant-frame-rate H.264 clip', async () => {
    const pngFile = join(dir, 'frame.png');
    await run(
      tools.ffmpeg,
      ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=64x64', '-frames:v', '1', pngFile],
      'fixture'
    );
    const { readFileSync } = await import('node:fs');
    const png = readFileSync(pngFile);
    const out = join(dir, 'png.mp4');
    const enc = startPngEncoder(tools.ffmpeg, out, 30);
    for (let i = 0; i < 15; i++) await enc.write(png);
    await enc.finish();
    const info = await probe(tools.ffprobe, out);
    expect(info.frames).toBe(15);
    expect(info.fps).toBe(30);
    expect(info.pixelFormat).toBe('yuv420p');
  });

  it('writes in flight when the encoder is killed reject with PipelineError instead of an uncaught EPIPE', async () => {
    // A large, noisy frame so writes are still queued in the pipe when ffmpeg dies.
    const pngFile = join(dir, 'frame-kill.png');
    await run(
      tools.ffmpeg,
      ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=1080x1920,geq=random(1)*255:128:128', '-frames:v', '1', pngFile],
      'fixture'
    );
    const { readFileSync } = await import('node:fs');
    const png = readFileSync(pngFile);
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.prependListener('uncaughtException', onUncaught);
    try {
      for (let round = 0; round < 5; round++) {
        const enc = startPngEncoder(tools.ffmpeg, join(dir, `killed-${round}.mp4`), 30);
        // Queue writes without awaiting them, as a fast engine does, then cancel.
        const writes = Array.from({ length: 40 }, () => enc.write(png));
        await new Promise((r) => setTimeout(r, 20));
        enc.kill();
        const results = await Promise.allSettled([...writes, enc.write(png)]);
        for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(PipelineError);
        expect(results.some((r) => r.status === 'rejected')).toBe(true);
        await expect(enc.finish()).rejects.toBeInstanceOf(PipelineError);
      }
      await new Promise((r) => setTimeout(r, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});

describe('checkExpectation', () => {
  const ok = {
    width: 1080,
    height: 1920,
    fps: 30,
    frames: 90,
    durationSeconds: 3,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    hasAudio: true,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    audioChannels: 2,
  };
  it('passes matching media', () => {
    expect(checkExpectation(ok, { width: 1080, height: 1920, fps: 30, frames: 90, audio: true })).toEqual([]);
  });
  it('reports every mismatch', () => {
    const problems = checkExpectation(
      { ...ok, width: 1920, height: 1080, fps: 25, frames: 89, pixelFormat: 'yuvj420p', hasAudio: false },
      { width: 1080, height: 1920, fps: 30, frames: 90, audio: true }
    );
    expect(problems).toHaveLength(5);
  });
});

describe('normaliseClip + concatClips (render fan-out, D-097)', () => {
  const framemd5 = async (file: string) =>
    (await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], 'md5')).stdout
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(',').pop()!.trim());

  it('FAN-20 normalised clips join by stream copy: decoded frames identical to the clips, one frame apart, same streams as assemble(), A/V equal', async () => {
    // Clips as engines deliver them: other sizes, rates, pixel formats, and more frames than the scene needs.
    const raw = [
      await makeClip('fan-a.mp4', { w: 360, h: 640, fps: 30, frames: 50 }),
      await makeClip('fan-b.mp4', { w: 400, h: 600, fps: 25, frames: 70, pixFmt: 'yuv444p' }),
      await makeClip('fan-c.mp4', { w: 360, h: 640, fps: 60, frames: 130 }),
    ];
    const frames = [45, 48, 60];
    const norm = [];
    for (const [i, input] of raw.entries()) {
      const out = join(dir, `fan-n${i}.mp4`);
      await normaliseClip({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, input, out, width: 360, height: 640, fps: 30, frames: frames[i]! });
      expect(checkExpectation(await probe(tools.ffprobe, out), { width: 360, height: 640, fps: 30, frames: frames[i]!, audio: false })).toEqual([]);
      expect(await checkTimestamps(tools.ffprobe, out, frames[i]!, 30)).toEqual([]); // IDR first, from pts 0
      norm.push(out);
    }
    const params = await Promise.all(norm.map((f) => streamParams(tools.ffprobe, f)));
    expect(new Set(params.map((p) => JSON.stringify(p))).size).toBe(1);
    expect(params[0]).toMatchObject({ codec: 'h264', profile: 'High', pixelFormat: 'yuv420p', width: 360, height: 640, frameRate: '30/1', otherStreams: 0 });

    const joined = join(dir, 'fan-joined.mp4');
    const r = await concatClips({ ffmpeg: tools.ffmpeg, clips: norm.map((file, i) => ({ file, frames: frames[i]! })), out: joined, fps: 30, listFile: join(dir, 'fan-list.txt') });
    expect(r.totalFrames).toBe(153);
    expect(r.args).toContain('copy');
    // Stream copy: the decoded frames are exactly the clips' frames, in order (no duplicate or missing frame at a boundary).
    const expected = (await Promise.all(norm.map(framemd5))).flat();
    expect(await framemd5(joined)).toEqual(expected);
    expect(await checkTimestamps(tools.ffprobe, joined, 153, 30)).toEqual([]);
    const d = await avDurations(tools.ffprobe, joined);
    expect(d.video).toBeCloseTo(5.1, 3);
    expect(Math.abs(d.audio! - 5.1)).toBeLessThan(0.05);

    // The same clips through assemble() (one re-encode of the whole timeline): same frames, streams and durations.
    const single = join(dir, 'fan-single.mp4');
    await assemble({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, clips: raw.map((file, i) => ({ sceneId: `s${i}`, file, frames: frames[i]! })), out: single, width: 360, height: 640, fps: 30 });
    const [a, b] = [await probe(tools.ffprobe, joined), await probe(tools.ffprobe, single)];
    expect({ ...a }).toEqual({ ...b });
    const [pa, pb] = [await streamParams(tools.ffprobe, joined), await streamParams(tools.ffprobe, single)];
    expect({ ...pa, otherStreams: 1 }).toEqual({ ...pb, otherStreams: 1 });
    expect(await avDurations(tools.ffprobe, single)).toEqual(d);
    // Scene boundaries carry the right scene on each side (the frames around each cut look alike in both outputs).
    for (const f of [0, 44, 45, 92, 93, 152]) {
      const [x, y] = [await frameStats(tools.ffmpeg, joined, f), await frameStats(tools.ffmpeg, single, f)];
      expect(Math.abs(x.yAvg - y.yAvg)).toBeLessThan(2);
    }
  }, 60_000);

  it('FAN-21 checkTimestamps reports a duplicated or missing frame and a wrong count', async () => {
    const a = join(dir, 'fan-n0.mp4');
    expect(await checkTimestamps(tools.ffprobe, a, 46, 30)).toEqual(['45 video packets, expected 46']);
    // Joining a clip encoded at another rate breaks the one-frame step at the boundary.
    const odd = join(dir, 'fan-odd.mp4');
    await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=15', '-frames:v', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', odd], 'fixture');
    const bad = join(dir, 'fan-bad.mp4');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'fan-list2.txt'), `file '${a}'\nfile '${odd}'\n`);
    await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'fan-list2.txt'), '-c', 'copy', bad], 'fixture');
    const problems = await checkTimestamps(tools.ffprobe, bad, 55, 30);
    expect(problems.join('; ')).toMatch(/expected 512 \(a duplicated or missing frame\)/);
  }, 30_000);
});
