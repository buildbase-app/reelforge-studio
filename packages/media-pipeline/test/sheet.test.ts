import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { framesImage, hasDrawtext, parseFrameRate, sheetColumns, resolveTools, type Tools } from '../src/index';

/**
 * Contact sheets for agents (#379). The fixture paints frame n with luma 16 + (n mod 40) x 5 at 30000/1001 fps
 * with a keyframe every 60 frames, so a still's pixels say which frame it really is, across keyframes.
 */
let tools: Tools;
const dir = mkdtempSync(join(tmpdir(), 'renderweld-sheet-'));
const video = join(dir, 'codes.mp4');

function lumaCode(file: string, x = 8, y = 8): number {
  const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-i', file, '-vf', `crop=16:16:${x}:${y},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`, '-f', 'null', '-'], { encoding: 'utf8' });
  return Math.round((Number(/YAVG=([\d.]+)/.exec(r.stdout)?.[1]) * 219) / 255 / 5);
}

function meanRgb(file: string, x: number, y: number): number[] {
  const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-vf', `crop=4:4:${x}:${y},scale=1:1,format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  return [...r.stdout.subarray(0, 3)];
}

beforeAll(() => {
  tools = resolveTools();
  const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', "nullsrc=s=320x568:r=30000/1001:d=6,format=yuv420p,geq=lum='16+mod(N\\,40)*5':cb=128:cr=128", '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', video]);
  if (r.status !== 0) throw new Error(String(r.stderr));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('framesImage', () => {
  it('SHEET-01 every separate still is exactly its frame, including right after and before a keyframe', async () => {
    const frames = [0, 1, 59, 60, 61, 119, 120, 178];
    const r = await framesImage({ ffmpeg: tools.ffmpeg, input: video, frameRate: '30000/1001', width: 320, height: 568, tiles: frames.map((f) => ({ frame: f, label: `f${f}` })), tileWidth: 160, layout: 'separate', out: join(dir, 'sep') });
    expect(r.files).toHaveLength(frames.length);
    expect(r).toMatchObject({ tileWidth: 160, tileHeight: 284, columns: 1, rows: 1 });
    frames.forEach((f, i) => expect(lumaCode(r.files[i]!), `frame ${f}`).toBe(f % 40));
  });

  it('SHEET-02 one sheet: tiles in order, a roughly square grid, the safe-area tint only outside the insets', async () => {
    const out = join(dir, 'sheet.jpg');
    const r = await framesImage({ ffmpeg: tools.ffmpeg, input: video, frameRate: '30000/1001', width: 320, height: 568, tiles: [10, 20, 30].map((f) => ({ frame: f, label: `f${f}` })), tileWidth: 320, overlay: { top: 80, right: 20, bottom: 200, left: 20 }, layout: 'sheet', out });
    expect(r.files).toEqual([out]);
    expect(r).toMatchObject({ columns: 2, rows: 2, labels: hasDrawtext(tools.ffmpeg) });
    expect(statSync(out).size).toBeGreaterThan(1000);
    // Inside the safe box of the first tile (frame 10, luma 66): grey; in the top zone: tinted red.
    const pad = Math.max(2, Math.round(320 / 90));
    const inside = meanRgb(out, pad + 160, pad + 284);
    expect(Math.abs(inside[0]! - inside[2]!)).toBeLessThan(12);
    const top = meanRgb(out, pad + 160, pad + 30);
    expect(top[0]! - top[2]!).toBeGreaterThan(30);
  });

  it('SHEET-03 helpers: frame rates, columns, and a frame past the end is an error', async () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('25')).toBe(25);
    expect(() => parseFrameRate('0/1')).toThrow('bad frame rate');
    expect(sheetColumns(9, 360, 640)).toBe(4);
    expect(sheetColumns(9, 640, 360)).toBe(2);
    expect(sheetColumns(1, 360, 640)).toBe(1);
    await expect(framesImage({ ffmpeg: tools.ffmpeg, input: video, frameRate: '30000/1001', width: 320, height: 568, tiles: [{ frame: 5000, label: 'x' }], tileWidth: 160, layout: 'sheet', out: join(dir, 'past.jpg') })).rejects.toThrow();
  });
});
