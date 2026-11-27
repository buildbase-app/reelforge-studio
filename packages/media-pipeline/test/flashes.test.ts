import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLASH_GRID, analyseFlashes, detectVideoIssues, resolveTools, run, type Tools } from '../src/index';

/** Photosensitive flash analysis (WCAG 2.2 SC 2.3.1, #294) on synthetic videos with known flash rates. */
let tools: Tools;
const dir = mkdtempSync(join(tmpdir(), 'renderweld-flashes-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function make(name: string, input: string, filter: string) {
  const file = join(dir, `${name}.mp4`);
  await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', input, '-vf', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], 'fixture');
  return file;
}
const flashes = async (file: string) => (await detectVideoIssues({ ffmpeg: tools.ffmpeg, input: file, durationSeconds: 3, freezeSeconds: 0, blackSeconds: 0, flashFps: 30 })).flashes;

beforeAll(() => {
  tools = resolveTools();
});

describe('flash analysis', () => {
  it('FLASH-01 a full-frame black/white strobe at 5 a second fails; once a second passes', async () => {
    const strobe = await make('strobe', 'color=c=black:s=320x240:r=30:d=3', "geq=lum='if(lt(mod(N\\,6)\\,3)\\,16\\,235)':cb=128:cr=128");
    const [w] = await flashes(strobe);
    expect(w).toMatchObject({ kind: 'general', transitionsPerSecond: 10 });
    expect(w!.startSeconds).toBeLessThan(0.2);
    expect(w!.endSeconds).toBeGreaterThan(2.8);
    const slow = await make('slow', 'color=c=black:s=320x240:r=30:d=3', "geq=lum='if(lt(mod(N\\,30)\\,15)\\,16\\,235)':cb=128:cr=128");
    expect(await flashes(slow)).toEqual([]);
  });

  it('FLASH-02 a small flashing element (under a quarter of the picture) passes; saturated red is reported as red', async () => {
    const box = await make('box', 'color=c=gray:s=320x240:r=30:d=3', "drawbox=x=20:y=20:w=80:h=80:color=white:t=fill:enable='lt(mod(n\\,4)\\,2)'");
    expect(await flashes(box)).toEqual([]);
    const red = await make('red', 'color=c=black:s=320x240:r=30:d=3', "drawbox=x=0:y=0:w=320:h=240:color=red:t=fill:enable='lt(mod(n\\,6)\\,3)'");
    expect((await flashes(red)).map((w) => w.kind).sort()).toEqual(['general', 'red']);
  });

  it('FLASH-03 a gentle dark-grey pulse (changes under 0.1 relative luminance) passes; exactly three flashes a second passes', () => {
    const frames = 90;
    const grid = (level: (f: number) => number) => {
      const b = new Uint8Array(frames * FLASH_GRID * FLASH_GRID * 3);
      for (let f = 0; f < frames; f++) b.fill(level(f), f * FLASH_GRID * FLASH_GRID * 3, (f + 1) * FLASH_GRID * FLASH_GRID * 3);
      return b;
    };
    // sRGB 20 <-> 60 is a relative-luminance change of about 0.04.
    expect(analyseFlashes(grid((f) => (f % 6 < 3 ? 20 : 60)), 30)).toEqual([]);
    // Black/white every 5 frames at 30 fps: three flashes (six transitions) a second, not more.
    expect(analyseFlashes(grid((f) => (Math.floor(f / 5) % 2 ? 255 : 0)), 30)).toEqual([]);
    // Every 4 frames: 3.75 flashes a second.
    expect(analyseFlashes(grid((f) => (Math.floor(f / 4) % 2 ? 255 : 0)), 30)).toHaveLength(1);
  });
});
