import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PipelineError, checkExpectation, probe, resolveTools } from '@reelforge/media-pipeline';
import type { OutputSettings, RenderScene as Scene } from '@reelforge/project-schema';
import { renderMotionCanvasScene, resolveBrowser } from '../src/index';

function browserAvailable(): boolean {
  try {
    resolveBrowser();
    return true;
  } catch {
    return false;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'reelforge-mc-'));
const cacheDir = resolve(__dirname, '../../../.render-cache');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const output: OutputSettings = { width: 360, height: 640, fps: 30, format: 'mp4' };
const scene: Scene = {
  id: 'contract',
  engine: 'motion-canvas',
  template: 'animated-explainer',
  durationFrames: 60,
  props: { title: 'Contract test', points: ['One', 'Two'] },
  assets: [],
};

describe('resolveBrowser', () => {
  it('explains how to fix a missing browser', () => {
    expect(() =>
      resolveBrowser('/nonexistent/a', { REELFORGE_CHROMIUM_PATH: '/nonexistent/b' }, () => undefined)
    ).toThrow(/Set REELFORGE_CHROMIUM_PATH.*\/nonexistent\/a, \/nonexistent\/b/);
  });

  it('prefers an explicit path, then the environment variable', () => {
    const exe = process.execPath; // any file that exists
    expect(resolveBrowser(exe, { REELFORGE_CHROMIUM_PATH: '/nope' }, () => undefined)).toBe(exe);
    expect(resolveBrowser(undefined, { REELFORGE_CHROMIUM_PATH: exe }, () => undefined)).toBe(exe);
  });
});

describe.skipIf(!browserAvailable())('renderMotionCanvasScene (needs Chromium)', () => {
  it('renders the exact frame count at the requested size and frame rate', async () => {
    const tools = resolveTools();
    const out = join(dir, 'mc.mp4');
    let lastProgress = 0;
    const res = await renderMotionCanvasScene({
      scene,
      output,
      out,
      cacheDir,
      ffmpeg: tools.ffmpeg,
      onProgress: (d) => (lastProgress = d),
    });
    expect(res.frames).toBe(60);
    expect(lastProgress).toBe(60);
    const info = await probe(tools.ffprobe, out);
    expect(checkExpectation(info, { width: 360, height: 640, fps: 30, frames: 60, audio: false })).toEqual([]);
  }, 120_000);

  it('fails with a PipelineError naming the stage for an unknown template', async () => {
    const tools = resolveTools();
    const out = join(dir, 'never.mp4');
    const err = await renderMotionCanvasScene({
      scene: { ...scene, template: 'no-such-template' },
      output,
      out,
      cacheDir,
      ffmpeg: tools.ffmpeg,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as PipelineError).stage).toBe('render:contract');
    expect(String((err as PipelineError).log)).toMatch(/unknown Motion Canvas template/);
    expect(existsSync(out) && (await probe(tools.ffprobe, out).catch(() => null))).toBeFalsy();
  }, 120_000);

  it('can be cancelled', async () => {
    const tools = resolveTools();
    const controller = new AbortController();
    const err = await renderMotionCanvasScene({
      scene: { ...scene, durationFrames: 300 },
      output,
      out: join(dir, 'cancel.mp4'),
      cacheDir,
      ffmpeg: tools.ffmpeg,
      signal: controller.signal,
      onProgress: (d) => {
        if (d === 10) controller.abort();
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
  }, 120_000);
});
