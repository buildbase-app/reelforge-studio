import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameRateFraction, frameSeconds, probeMedia, resolveTools, videoFramesAt, type Tools } from '../src/index';
import { CLIP_BITS, makeNumberedClip, makeQuadImage, readBars, readPicture, readPictures } from './media-fixtures';

let dir: string;
let tools: Tools;
const clips: Record<string, string> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reelforge-media-'));
  tools = resolveTools();
  // 12 s at the two NTSC rates (360 / 288 frames) and a plain 25 fps clip.
  clips['30000/1001'] = await makeNumberedClip(tools.ffmpeg, join(dir, 'c2997.mp4'), { fps: '30000/1001', frames: 360, width: 160, height: 32 });
  clips['24000/1001'] = await makeNumberedClip(tools.ffmpeg, join(dir, 'c23976.mp4'), { fps: '24000/1001', frames: 288, width: 160, height: 32 });
  clips['25'] = await makeNumberedClip(tools.ffmpeg, join(dir, 'c25.mp4'), { fps: 25, frames: 50, width: 160, height: 32 });
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function shown(files: string[]): Promise<number[]> {
  const pictures = await readPictures(tools.ffmpeg, join(files[0]!, '..', '%06d.jpg'), { width: 160, height: 32 });
  expect(pictures).toHaveLength(files.length);
  return pictures.map((p) => readBars(p, { x: 0, y: 0, width: 160, height: 32 }));
}

describe('MEDIA-1 frame rates as exact fractions', () => {
  it('keeps whole rates whole, maps NTSC rates to n*1000/1001 and reads "n/d"', () => {
    expect(frameRateFraction(30)).toEqual({ num: 30, den: 1 });
    expect(frameRateFraction(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(frameRateFraction(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(frameRateFraction(59.94)).toEqual({ num: 60000, den: 1001 });
    expect(frameRateFraction('30000/1001')).toEqual({ num: 30000, den: 1001 });
    expect(frameRateFraction('24')).toEqual({ num: 24, den: 1 });
    expect(() => frameRateFraction('x')).toThrow(/not a frame rate/);
    expect(() => frameRateFraction(0)).toThrow(/not a frame rate/);
    // Frame 10 000 at 29.97 starts at exactly 10010/30 s (a float rate would be off by a frame within minutes).
    expect(frameSeconds(10_000, 29.97)).toBeCloseTo(333.6666667, 6);
  });
});

describe('MEDIA-2 probe', () => {
  it('reads a video and a still picture', async () => {
    const v = await probeMedia(tools.ffprobe, clips['30000/1001']!);
    expect(v).toMatchObject({ width: 160, height: 32, codec: 'h264', rotation: 0 });
    expect(v.fps).toBeCloseTo(29.97, 2);
    expect(v.durationSeconds).toBeCloseTo(12.012, 1);
    const img = await probeMedia(tools.ffprobe, await makeQuadImage(tools.ffmpeg, join(dir, 'q.png')));
    expect(img).toMatchObject({ width: 200, height: 100, codec: 'png' });
  });
});

describe('MEDIA-3 video frames are taken on an exact grid: no drift at 23.976 or 29.97 (#299)', () => {
  /** Source frame j is the right one for output frame k when it starts within half an output frame (plus rounding) of k's time. */
  const near = (j: number, src: number, t: number, out: number) => Math.abs(j / src - t) <= 0.5 / out + 0.5 / src + 1e-9;

  for (const [src, out] of [
    ['30000/1001', '30000/1001'],
    ['24000/1001', '24000/1001'],
  ] as const) {
    it(`a ${src} clip at a ${out} scene shows source frame k at frame k, all the way to the end`, async () => {
      const files = await videoFramesAt({ ffmpeg: tools.ffmpeg, input: clips[src]!, dir: join(dir, `id-${src.replace('/', '_')}`), fps: out, count: 280 });
      expect(await shown(files)).toEqual(Array.from({ length: 280 }, (_, k) => k));
    }, 120_000);
  }

  for (const [src, out, mediaStart, first] of [
    ['30000/1001', 30, 0, 0],
    ['30000/1001', 24, 1.5, 0],
    ['24000/1001', 30, 0, 0],
    ['24000/1001', 25, 2.25, 40],
    ['30000/1001', 60, 0.7, 100],
    ['30000/1001', 30, 0, 300], // a frame range deep into the clip (render fan-out chunk)
  ] as const) {
    it(`a ${src} clip at ${out} fps, in-point ${mediaStart} s, from scene frame ${first}: every frame within half a frame of its time, never drifting`, async () => {
      const count = 50;
      const s = frameRateFraction(src);
      const srcFps = s.num / s.den;
      const files = await videoFramesAt({ ffmpeg: tools.ffmpeg, input: clips[src]!, dir: join(dir, `g-${src.replace('/', '_')}-${out}-${mediaStart}-${first}`), fps: out, count, first, mediaStart });
      const got = await shown(files);
      got.forEach((j, k) => {
        const t = mediaStart + (first + k) / out;
        expect(near(j, srcFps, t, out), `frame ${first + k}: source frame ${j} (${(j / srcFps).toFixed(4)} s) for ${t.toFixed(4)} s`).toBe(true);
        if (k > 0) expect(j).toBeGreaterThanOrEqual(got[k - 1]!);
      });
    }, 120_000);
  }

  it('a clip shorter than the scene holds its last frame; frames are scaled down to fit, never up', async () => {
    const files = await videoFramesAt({ ffmpeg: tools.ffmpeg, input: clips['25']!, dir: join(dir, 'hold'), fps: 25, count: 60, maxWidth: 80, maxHeight: 80 });
    expect(files).toHaveLength(60);
    const last = await readPicture(tools.ffmpeg, files[59]!, 0, { width: 80, height: 16 });
    expect(readBars(last, { x: 0, y: 0, width: 80, height: 16 })).toBe(49);
    expect(2 ** CLIP_BITS).toBeGreaterThan(360);
  }, 60_000);

  it('refuses an in-point after the end of the clip', async () => {
    await expect(videoFramesAt({ ffmpeg: tools.ffmpeg, input: clips['25']!, dir: join(dir, 'late'), fps: 25, count: 5, mediaStart: 30 })).rejects.toThrow(/expected 5 pictures/);
  });
});
