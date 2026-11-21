import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PipelineError, checkExpectation, probe, resolveTools } from '@reelforge/media-pipeline';
import type { OutputSettings, Scene } from '@reelforge/project-schema';
import { renderRemotionScene } from '../src/index';

// Remotion downloads its own browser when none is configured; in CI we point
// it at a preinstalled one so the test does not depend on network access.
const hasBrowser = Boolean(process.env.REELFORGE_CHROMIUM_PATH && existsSync(process.env.REELFORGE_CHROMIUM_PATH));

const dir = mkdtempSync(join(tmpdir(), 'reelforge-remotion-'));
const cacheDir = resolve(__dirname, '../../../.render-cache');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
