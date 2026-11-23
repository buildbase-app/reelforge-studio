import { describe, expect, it } from 'vitest';
import { expectationFor, promptFor, projectIdFor, AGENTS, CELL_ENGINES, ENGINE_INFO } from '../cells';
import { checkEngines, checkReel, parseProbe, parseRate, sceneEngines, type ReelProbe } from '../lib/probe';

const ffprobeJson = JSON.stringify({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, r_frame_rate: '30/1', nb_read_frames: '240' },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '8.000000', size: '536891' },
});

const good: ReelProbe = { width: 1080, height: 1920, fps: 30, frames: 240, durationSeconds: 8, videoCodec: 'h264', audioCodec: 'aac', sizeBytes: 1 };

describe('parseProbe', () => {
  it('reads size, rate, decoded frames, duration and codecs', () => {
    expect(parseProbe(ffprobeJson)).toEqual({ ...good, sizeBytes: 536891 });
  });
  it('parses fractional rates', () => {
    expect(parseRate('30000/1001')).toBe(29.97);
    expect(parseRate('25')).toBe(25);
    expect(parseRate('1/0')).toBeNaN();
    expect(parseRate(undefined)).toBeNaN();
  });
  it('fails without a video stream', () => {
    expect(() => parseProbe({ streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: { duration: '1' } })).toThrow(/no video stream/);
  });
  it('reports a missing audio stream as null', () => {
    expect(parseProbe({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1, height: 1, r_frame_rate: '30/1', nb_read_frames: '30' }], format: { duration: '1' } }).audioCodec).toBeNull();
  });
});

describe('checkReel', () => {
  const exact = expectationFor('rest', 'html');
  const loose = expectationFor('claude-code', 'html');

  it('passes a reel that matches', () => {
    expect(checkReel(good, exact)).toEqual([]);
    expect(checkReel(good, loose)).toEqual([]);
  });
  it('lists every problem at once', () => {
    const bad = { ...good, width: 720, height: 1280, fps: 25, frames: 100, durationSeconds: 4, videoCodec: 'vp9', audioCodec: null };
    const problems = checkReel(bad, exact);
    expect(problems.join('\n')).toMatch(/size 720x1280/);
    expect(problems.join('\n')).toMatch(/fps 25/);
    expect(problems.join('\n')).toMatch(/video codec vp9/);
    expect(problems.join('\n')).toMatch(/audio codec none/);
    expect(problems.join('\n')).toMatch(/frames 100, expected 240/);
    expect(problems.join('\n')).toMatch(/duration 4s outside/);
  });
  it('catches frames that do not fill the duration (a truncated decode)', () => {
    expect(checkReel({ ...good, frames: 200 }, loose).join('\n')).toMatch(/do not match duration/);
  });
  it('lets LLM rows choose their timing inside 6..12 s, but no further', () => {
    expect(checkReel({ ...good, frames: 300, durationSeconds: 10 }, loose)).toEqual([]);
    expect(checkReel({ ...good, frames: 450, durationSeconds: 15 }, loose).join('\n')).toMatch(/outside 6..12s/);
    expect(checkReel({ ...good, frames: 0 }, loose).join('\n')).toMatch(/no decodable frames/);
  });
});

describe('engine checks', () => {
  it('a single-engine cell allows only its engine', () => {
    expect(checkEngines(['html', 'html'], ['html'])).toEqual([]);
    expect(checkEngines(['html', 'remotion'], ['html']).join()).toMatch(/scenes use remotion/);
    expect(checkEngines([], ['html'])).toEqual(['the project has no scenes']);
  });
  it('the multi-engine cell needs every engine', () => {
    const all = ENGINE_INFO['multi-engine'].engines;
    expect(checkEngines(['remotion', 'motion-canvas', 'html', 'hyperframes'], all)).toEqual([]);
    expect(checkEngines(['remotion', 'html'], all).join()).toMatch(/no scene uses motion-canvas, hyperframes/);
  });
  it('reads scene engines from a manifest', () => {
    expect(sceneEngines({ scenes: [{ engine: 'html' }, { engine: 'remotion' }] })).toEqual(['html', 'remotion']);
    expect(sceneEngines({})).toEqual([]);
  });
});

describe('cells', () => {
  it('every LLM prompt names its project id and engine', () => {
    for (const a of AGENTS)
      for (const e of CELL_ENGINES) {
        const p = promptFor(a, e);
        expect(p).toContain(`"${projectIdFor(a, e)}"`);
        for (const engine of ENGINE_INFO[e].engines) expect(p).toContain(engine);
      }
  });
  it('the deterministic rows expect the exact frame count of the example manifest', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const e of CELL_ENGINES) {
      const m = JSON.parse(readFileSync(join(import.meta.dirname, '../../..', ENGINE_INFO[e].manifest), 'utf8'));
      const frames = m.scenes.reduce((n: number, s: { durationSeconds: number }) => n + s.durationSeconds * m.output.fps, 0);
      expect(frames).toBe(ENGINE_INFO[e].frames);
      expect(expectationFor('rest', e).frames).toBe(frames);
      expect([...new Set(sceneEngines(m))].sort()).toEqual([...ENGINE_INFO[e].engines].sort());
    }
  });
});
