/**
 * Encoder memory settings (#307, D-117): render.encoderThreads and render.encoderLookahead reach every H.264
 * encode, and they never change the format of the video, so clips encoded with different values (workers of
 * one render fan-out with different settings, or a change at runtime mid-render) still join by stream copy.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MIN_SCENE_FRAMES } from '@renderweld/project-schema';
import {
  DEFAULT_ENCODER_SETTINGS,
  H264_ARGS,
  concatClips,
  encoderSettings,
  h264Args,
  inputThreadArgs,
  filterThreadArgs,
  checkTimestamps,
  normaliseClip,
  probe,
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

  it('ENC-03 beat-length clips (#450): from MIN_SCENE_FRAMES frames every clip has the same B-frame delay and joins frame-exact; a 2-frame clip does not', async () => {
    const src = join(dir, 'beats.mp4');
    await run(tools.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=30', '-frames:v', '30', '-pix_fmt', 'yuv420p', src], 'test');
    const clip = async (frames: number) => {
      const out = join(dir, `beat-${frames}.mp4`);
      await normaliseClip({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, input: src, out, width: 180, height: 320, fps: 30, frames });
      const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=dts', '-of', 'csv=p=0', out], 'probe');
      return { file: out, frames, firstDts: Number(stdout.split('\n')[0]) };
    };
    const join_ = async (clips: Array<{ file: string; frames: number }>, name: string) => {
      const out = join(dir, `${name}.mp4`);
      await concatClips({ ffmpeg: tools.ffmpeg, clips, out, fps: 30, listFile: join(dir, `${name}.txt`), noAudio: true });
      const frames = clips.reduce((n, c) => n + c.frames, 0);
      return { frames, info: await probe(tools.ffprobe, out), timestamps: await checkTimestamps(tools.ffprobe, out, frames, 30) };
    };
    const floor = await clip(MIN_SCENE_FRAMES);
    const six = await clip(6);
    const long = await clip(30);
    // x264 (medium, B-pyramid): 2 frames of decode delay from 3 frames on, whatever the length.
    expect(MIN_SCENE_FRAMES).toBe(3);
    expect(floor.firstDts).toBeLessThan(0);
    expect(new Set([floor.firstDts, six.firstDts, long.firstDts]).size).toBe(1);
    const ok = await join_([long, floor, six, floor, floor, long], 'beats-ok');
    expect(ok.info.frames).toBe(ok.frames);
    expect(Math.abs(ok.info.durationSeconds - ok.frames / 30)).toBeLessThan(0.002);
    expect(ok.timestamps).toEqual([]);
    // Why the floor is not 2: a 2-frame clip has no delay, and the join after it comes out short.
    const two = await clip(MIN_SCENE_FRAMES - 1);
    expect(two.firstDts).toBe(0);
    const short = await join_([two, six], 'beats-short');
    expect(short.frames / 30 - short.info.durationSeconds).toBeGreaterThan(1 / 30);
  }, 60_000);
});
