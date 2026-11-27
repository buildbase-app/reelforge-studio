import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOTION_FLOOR, MOTION_GRID, analyseMotion, detectVideoIssues, resolveTools, run, type Tools } from '../src/index';

/** Motion energy, low-motion stretches and the loop seam (#294) on synthetic grids and on encoded test videos. */
let tools: Tools;
const dir = mkdtempSync(join(tmpdir(), 'renderweld-motion-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeAll(() => {
  tools = resolveTools();
});

const CELLS = MOTION_GRID * MOTION_GRID;
/** Raw gray frames: frame f has every cell at value(f, cell). */
const frames = (count: number, value: (f: number, c: number) => number) => {
  const g = new Uint8Array(count * CELLS);
  for (let f = 0; f < count; f++) for (let c = 0; c < CELLS; c++) g[f * CELLS + c] = value(f, c);
  return g;
};

async function make(name: string, size: string, filter: string, seconds: number) {
  const file = join(dir, `${name}.mp4`);
  const input = `color=c=0x223344:s=${size}:r=30`;
  await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', input, '-vf', filter, '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], 'fixture');
  return file;
}
/** A white square of `side` px moving with x(t), at mid height. */
const square = (side: number, x: string) => `color=white:s=${side}x${side}[b];[in][b]overlay=x='${x}':y=(H-h)/2:shortest=1`;
const measure = async (file: string, seconds: number, loop = false) =>
  (await detectVideoIssues({ ffmpeg: tools.ffmpeg, input: file, durationSeconds: seconds, freezeSeconds: 0, blackSeconds: 0, motion: { fps: 30, floor: MOTION_FLOOR, lowSeconds: 1.5, loop } })).motion!;

describe('motion analysis', () => {
  it('MOT-01 energy per second is the mean change a frame; a still stretch is reported with its exact frames', () => {
    // 0-1 s: every cell rises by 2 a frame; 1-3 s: still; 3-4 s: rises again.
    const g = frames(120, (f) => (f < 30 ? 2 * f : f < 90 ? 58 : 58 + 2 * (f - 89)));
    const r = analyseMotion(g, 30, { floor: 0.4, lowSeconds: 1.5 });
    expect(r.frames).toBe(120);
    expect(r.energyPerSecond).toEqual([2, 0, 0, 2]);
    // Frames 29..89 show the same picture: from 29/30 s until frame 90 replaces it.
    expect(r.lows).toEqual([{ startSeconds: 0.967, endSeconds: 3, durationSeconds: 2.033, peakMotion: 0 }]);
    expect(analyseMotion(g, 30, { floor: 0.4, lowSeconds: 2.5 }).lows).toEqual([]);
    expect(analyseMotion(g, 30, { floor: 0.4, lowSeconds: 0 }).lows).toEqual([]);
    expect(r.loop).toBeUndefined();
  });

  it('MOT-02 a still that runs to the end is closed at the end; a change just under the floor still counts as still', () => {
    // Moves until frame 15, then one cell in ten flickers by a level every seventh frame: a tenth of a level at most.
    const g = frames(90, (f, c) => (f < 15 ? 4 * f : 60 + (c % 10 === 0 && f % 7 === 0 ? 1 : 0)));
    const r = analyseMotion(g, 30, { floor: 0.4, lowSeconds: 1.5 });
    // Frame 45 is the first to match the picture a second before it (frame 15), so the still runs from 0.5 s.
    expect(r.lows).toEqual([{ startSeconds: 0.5, endSeconds: 3, durationSeconds: 2.5, peakMotion: 0.1 }]);
  });

  it('MOT-06 a slow fade is not low motion, though each frame changes less than the floor: the change builds up over a second', () => {
    // Every cell brightens by a third of a level a frame for three seconds: 10 levels a second.
    const g = frames(90, (f) => 50 + Math.round(f / 3));
    const r = analyseMotion(g, 30, { floor: 0.4, lowSeconds: 1.5 });
    expect(Math.max(...r.energyPerSecond)).toBeLessThan(0.4);
    expect(r.lows).toEqual([]);
    // Under a second asked for, the window shrinks with it: a half-second window still sees 5 levels.
    expect(analyseMotion(g, 30, { floor: 0.4, lowSeconds: 0.5 }).lows).toEqual([]);
  });

  it('MOT-03 the loop seam: a picture that comes back to its start joins; one that ends elsewhere jumps', () => {
    const cycle = frames(60, (f) => Math.round(100 + 40 * Math.sin((2 * Math.PI * f) / 60)));
    const joined = analyseMotion(cycle, 30, { floor: 0.4, lowSeconds: 0, loop: true }).loop!;
    expect(joined.jump).toBe(false);
    expect(joined.seamMotion).toBeLessThanOrEqual(joined.typicalMotion);
    const ramp = frames(60, (f) => 100 + f);
    expect(analyseMotion(ramp, 30, { floor: 0.4, lowSeconds: 0, loop: true }).loop).toEqual({ seamMotion: 59, typicalMotion: 1, jump: true });
    // A seam under half a level is not a visible jump, however still the rest is.
    const still = frames(60, (_f, c) => (c === 0 ? 100 : 50));
    still[59 * CELLS] = 101;
    expect(analyseMotion(still, 30, { floor: 0.4, lowSeconds: 0, loop: true }).loop!.jump).toBe(false);
  });
});

describe('motion on encoded video', () => {
  it('MOT-04 grain on a still picture is low motion; a shape sliding across is not', async () => {
    // Full size: the floor was calibrated there. Grain reads higher on smaller frames (about 0.5 at 540x960).
    const grain = await make('grain', '1080x1920', 'noise=alls=12:allf=t', 3);
    const g = await measure(grain, 3);
    expect(g.energyPerSecond.every((e) => e < MOTION_FLOOR)).toBe(true);
    expect(g.lows).toHaveLength(1);
    expect(g.lows[0]!.durationSeconds).toBeCloseTo(3, 1);
    const slide = await make('slide', '540x960', square(100, '20+t*120'), 3);
    const s = await measure(slide, 3);
    expect(s.lows).toEqual([]);
  }, 60_000);

  it('MOT-05 the loop seam on encoded video: a square that swings back joins, one that slides across jumps', async () => {
    const swing = await make('swing', '540x960', square(100, '220+150*sin(2*PI*t/3)'), 3);
    expect((await measure(swing, 3, true)).loop!.jump).toBe(false);
    const slide = await make('slide-off', '540x960', square(100, '20+t*120'), 3);
    const seam = (await measure(slide, 3, true)).loop!;
    expect(seam.jump).toBe(true);
    expect(seam.seamMotion).toBeGreaterThan(seam.typicalMotion * 2);
  }, 60_000);
});
