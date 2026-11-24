/**
 * Encoder memory settings (#307, D-117): render.encoderThreads and render.encoderLookahead reach every H.264
 * encode, and they never change the format of the video, so clips encoded with different values (workers of
 * one render fan-out with different settings, or a change at runtime mid-render) still join by stream copy.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ENCODER_SETTINGS,
  H264_ARGS,
  concatClips,
  encoderSettings,
  h264Args,
  inputThreadArgs,
  filterThreadArgs,
  normaliseClip,
  resolveTools,
  run,
  setEncoderSettings,
  streamParams,
  type Tools,
} from '../src/index';

let dir: string;
let tools: Tools;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'reelforge-encoder-'));
  tools = resolveTools();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setEncoderSettings(DEFAULT_ENCODER_SETTINGS));

describe('encoder settings', () => {
  it('ENC-01 the defaults bound threads and lookahead; 0 leaves each to x264; the setter is partial', () => {
    expect(DEFAULT_ENCODER_SETTINGS).toEqual({ threads: 2, lookahead: 20 });
    const d = h264Args();
    expect(d.join(' ')).toContain('-threads 2');
    expect(d.join(' ')).toContain('-x264-params rc-lookahead=20');
    expect(d.slice(0, 4)).toEqual(['-c:v', 'libx264', '-preset', 'medium']);
    expect([...H264_ARGS]).toEqual(d);
    expect(inputThreadArgs()).toEqual(['-threads', '2']);
    expect(filterThreadArgs()).toEqual(['-filter_threads', '2', '-filter_complex_threads', '2']);
    const auto = h264Args({ threads: 0, lookahead: 0 });
    expect(auto).not.toContain('-threads');
    expect(auto).not.toContain('-x264-params');
    expect(inputThreadArgs({ threads: 0, lookahead: 0 })).toEqual([]);
    setEncoderSettings({ lookahead: 8 });
    expect(encoderSettings()).toEqual({ threads: 2, lookahead: 8 });
    expect(h264Args().join(' ')).toContain('rc-lookahead=8');
  });

  it('ENC-02 clips normalised with different settings have the same stream parameters and join by stream copy, frame-exact', async () => {
    const src = join(dir, 'src.mp4');
    await run(tools.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', '-frames:v', '60', '-pix_fmt', 'yuv420p', src], 'test');
    const clips = [];
    for (const [i, s] of [{ threads: 1, lookahead: 10 }, { threads: 0, lookahead: 0 }, DEFAULT_ENCODER_SETTINGS].entries()) {
      setEncoderSettings(s);
      const out = join(dir, `n${i}.mp4`);
      const r = await normaliseClip({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, input: src, out, width: 360, height: 640, fps: 30, frames: 30 });
      expect(r.args.includes('-threads')).toBe(s.threads > 0);
      clips.push(out);
    }
    const params = await Promise.all(clips.map((f) => streamParams(tools.ffprobe, f)));
    expect(new Set(params.map((p) => JSON.stringify(p))).size).toBe(1);
    const joined = join(dir, 'joined.mp4');
    const j = await concatClips({ ffmpeg: tools.ffmpeg, clips: clips.map((file) => ({ file, frames: 30 })), out: joined, fps: 30, listFile: join(dir, 'list.txt') });
    expect(j.args).toContain('copy');
    const md5 = async (f: string) =>
      (await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-i', f, '-map', '0:v', '-f', 'framemd5', '-'], 'md5')).stdout
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(',').pop()!.trim());
    expect(await md5(joined)).toEqual((await Promise.all(clips.map(md5))).flat());
  }, 60_000);
});
