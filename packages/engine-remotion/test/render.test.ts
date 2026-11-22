import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PipelineError, checkExpectation, framePsnr, frameStats, probe, resolveTools } from '@reelforge/media-pipeline';
import { builtinTheme } from '@reelforge/project-schema';
import type { OutputSettings, RenderScene as Scene } from '@reelforge/project-schema';
import { remotionEngine, renderRemotionScene } from '../src/index';

// Remotion downloads its own browser when none is configured; in CI we point
// it at a preinstalled one so the test does not depend on network access.
const hasBrowser = Boolean(process.env.REELFORGE_CHROMIUM_PATH && existsSync(process.env.REELFORGE_CHROMIUM_PATH));

// In CI REELFORGE_REQUIRE_BROWSER=1 turns a missing browser into a failure instead of a skip.
describe('browser requirement', () => {
  it.runIf(process.env.REELFORGE_REQUIRE_BROWSER === '1')('a browser must be configured', () => {
    expect(hasBrowser).toBe(true);
  });
});

const dir = mkdtempSync(join(tmpdir(), 'reelforge-remotion-'));
const cacheDir = resolve(__dirname, '../../../.render-cache');
// Chrome can still be flushing its profile when the suite ends; retry ENOTEMPTY/EBUSY.
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const output: OutputSettings = { width: 360, height: 640, fps: 30, format: 'mp4' };
const scene: Scene = {
  id: 'contract',
  engine: 'remotion',
  template: 'kinetic-title',
  durationFrames: 60,
  props: { headline: 'Contract test', subline: 'Remotion adapter' },
  assets: [],
};

describe.skipIf(!hasBrowser)('renderRemotionScene (needs REELFORGE_CHROMIUM_PATH)', () => {
  it('renders the exact frame count at the requested size and frame rate', async () => {
    const tools = resolveTools();
    const out = join(dir, 'rm.mp4');
    const res = await renderRemotionScene({ scene, output, out, cacheDir, concurrency: 2 });
    expect(res.frames).toBe(60);
    const info = await probe(tools.ffprobe, out);
    // Remotion encodes full-range yuvj420p; assembly converts it, so ignore it here.
    const problems = checkExpectation(info, { width: 360, height: 640, fps: 30, frames: 60, audio: false }).filter(
      (p) => !p.startsWith('pixel format')
    );
    expect(problems).toEqual([]);
  }, 180_000);

  it('reads the theme and never starts with a blank frame', async () => {
    const tools = resolveTools();
    const out = join(dir, 'themed.mp4');
    await renderRemotionScene({ scene, output, theme: builtinTheme('midnight')!.tokens, out, cacheDir, concurrency: 2 });
    const first = await frameStats(tools.ffmpeg, out, 0);
    expect(first.yMax - first.yMin).toBeGreaterThan(40);
    // Midnight's background is darker than the default theme's.
    expect(first.yMin).toBeLessThan(30);
  }, 180_000);

  it('ENG-REM-FR a frame range renders exactly those frames, the same pictures as the whole render (frame-pure, #156)', async () => {
    expect(remotionEngine().capabilities?.()).toEqual({ frameRanges: true });
    const tools = resolveTools();
    const whole = join(dir, 'whole.mp4');
    await renderRemotionScene({ scene, output, out: whole, cacheDir, concurrency: 2 });
    // Frames 20-39: the words are still springing in and the whole title is pushing in (every frame differs from the last).
    const part = join(dir, 'range.mp4');
    const progress: Array<[number, number]> = [];
    const res = await renderRemotionScene({ scene, output, out: part, cacheDir, concurrency: 2, frameRange: [20, 39], onProgress: (d, t) => progress.push([d, t]) });
    expect(res.frames).toBe(20);
    expect((await probe(tools.ffprobe, part)).frames).toBe(20);
    expect(progress.at(-1)).toEqual([20, 20]);
    const same = await framePsnr(tools.ffmpeg, whole, part, 20);
    const shifted = await framePsnr(tools.ffmpeg, whole, part, 21);
    expect(same).toHaveLength(20);
    // Both are Remotion's own encodes (crf 18) of the same pictures; one frame off is clearly worse.
    expect(Math.min(...same)).toBeGreaterThan(40);
    expect(Math.min(...same)).toBeGreaterThan(Math.min(...shifted) + 3);
    const err = await renderRemotionScene({ scene, output, out: join(dir, 'bad.mp4'), cacheDir, frameRange: [50, 60] }).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toMatch(/not inside the scene's 60 frames/);
  }, 240_000);

  it('fails with a PipelineError naming the stage for an unknown composition', async () => {
    const err = await renderRemotionScene({
      scene: { ...scene, template: 'no-such-template' },
      output,
      out: join(dir, 'never.mp4'),
      cacheDir,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as PipelineError).stage).toBe('render:contract');
    expect((err as PipelineError).message).toMatch(/no-such-template/);
  }, 180_000);
});
