import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SEEK_GRID, frameGrid, gridDifference, resolveTools, run } from '../src/index';

/** Reading one frame as a luma grid and comparing two grids: the seek check (#294). */
const dir = mkdtempSync(join(tmpdir(), 'renderweld-framegrid-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('frameGrid', () => {
  it('FG-01 reads exactly the frame asked for, at a whole and at an NTSC rate', async () => {
    const tools = resolveTools();
    for (const [rate, fps] of [['30', 30], ['30000/1001', 30000 / 1001]] as const) {
      // Every frame one flat grey, 6 video-range levels brighter than the one before: frame n reads as its own grey.
      const file = join(dir, `ramp-${rate.replace('/', '-')}.mp4`);
      await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `nullsrc=s=320x240:r=${rate},format=yuv420p,geq=lum='16+N*6':cb=128:cr=128`, '-frames:v', '36', '-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p', file], 'fixture');
      const levels: number[] = [];
      for (const frame of [0, 1, 11, 12, 13, 35]) {
        const g = await frameGrid({ ffmpeg: tools.ffmpeg, input: file, frame, fps });
        expect(g).toHaveLength(SEEK_GRID * SEEK_GRID);
        levels.push(g[0]!);
      }
      // Full-range grey of video-range level 16 + 6n: about 7n. Neighbouring frames must not be mistaken.
      expect(levels.map((v, i) => Math.round(v / 7))).toEqual([0, 1, 11, 12, 13, 35]);
    }
  }, 60_000);

  it('FG-02 the difference of two grids is their mean and largest cell difference; grids of other sizes are refused', () => {
    const a = new Uint8Array(4).fill(10);
    const b = Uint8Array.from([10, 12, 10, 40]);
    expect(gridDifference(a, b)).toEqual({ meanDiff: 8, maxDiff: 30 });
    expect(gridDifference(a, a)).toEqual({ meanDiff: 0, maxDiff: 0 });
    expect(() => gridDifference(a, new Uint8Array(3))).toThrow('grids differ in size');
  });
});
