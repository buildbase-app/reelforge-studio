import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedAsset } from '@reelforge/core';
import { resolveTools, type Tools } from '@reelforge/media-pipeline';
import { builtinTheme, frameLayout, type OutputSettings, type RenderScene } from '@reelforge/project-schema';
import { renderRemotionScene } from '../src/index';
import { QUAD, colorDistance, makeNumberedClip, makeQuadImage, meanColor, readBars, readPicture } from '../../media-pipeline/test/media-fixtures';
import { envValue } from '@reelforge/core';

/**
 * #299: kinetic-title shows a background video and a logo from the project's
 * assets, served on a loopback origin for the render; a frame-range chunk
 * shows the same pictures as the whole render.
 */

const hasBrowser = Boolean(envValue('REELFORGE_CHROMIUM_PATH') && existsSync(envValue('REELFORGE_CHROMIUM_PATH')));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-remotion-assets-'));
const cacheDir = resolve(__dirname, '../../../.render-cache');
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const output: OutputSettings = { width: 320, height: 320, fps: 30, format: 'mp4' };
const theme = { ...builtinTheme('default')!.tokens, colors: { ...builtinTheme('default')!.tokens.colors, background: '#000000' } };
let tools: Tools;
let assets: Map<string, ResolvedAsset>;

beforeAll(async () => {
  tools = resolveTools();
  assets = new Map<string, ResolvedAsset>([
    ['quad', { id: 'quad', file: await makeQuadImage(tools.ffmpeg, join(dir, 'quad.png')), mediaType: 'image' }],
    ['clip', { id: 'clip', file: await makeNumberedClip(tools.ffmpeg, join(dir, 'clip.mp4'), { fps: 30, frames: 120 }), mediaType: 'video' }],
  ]);
}, 60_000);

const scene = (props: Record<string, unknown>): RenderScene => ({ id: 'a', engine: 'remotion', template: 'kinetic-title', durationFrames: 30, props: { headline: 'Hi', ...props } });

describe.skipIf(!hasBrowser)('ASSET-REM Remotion renders the project\'s images and videos (#299)', () => {
  it('background video (contain) frame-exact from an in-point, logo in the safe corner; a frame-range chunk matches', async () => {
    const props = { media: { asset: 'clip', fit: 'contain', dim: 0, start: 1 }, logo: { asset: 'quad', corner: 'top-left', size: 14 } };
    const log: string[] = [];
    const out = join(dir, 'whole.mp4');
    await renderRemotionScene({ scene: scene(props), output, theme, out, cacheDir, concurrency: 2, assets, tools, workDir: join(dir, 'w1'), log: (l) => log.push(l) });
    expect(log.join('\n')).not.toMatch(/refused/);
    const l = frameLayout(320, 320);
    const s = 14 * l.unit;
    for (const f of [0, 13, 29]) {
      const p = await readPicture(tools.ffmpeg, out, f, output);
      // 320x180 contained in the square: y 70..250; the top band is clear of the headline.
      expect(readBars(p, { x: 0, y: 75, width: 320, height: 20 }), `frame ${f}`).toBe(30 + f);
      expect(colorDistance(meanColor(p, l.box.x + s * 0.25, l.box.y + s * 0.125, 1), QUAD.tl), `frame ${f} logo`).toBeLessThan(30);
      expect(colorDistance(meanColor(p, l.box.x + s * 0.75, l.box.y + s * 0.375, 1), QUAD.br)).toBeLessThan(30);
    }
    const chunk = join(dir, 'chunk.mp4');
    await renderRemotionScene({ scene: scene(props), output, theme, out: chunk, cacheDir, concurrency: 2, assets, tools, workDir: join(dir, 'w2'), frameRange: [10, 19] });
    for (const k of [0, 9]) {
      expect(readBars(await readPicture(tools.ffmpeg, chunk, k, output), { x: 0, y: 75, width: 320, height: 20 }), `chunk frame ${k}`).toBe(40 + k);
    }
  }, 300_000);

  it('blur-fill: the picture contained over a blurred copy; cover fills the frame', async () => {
    const out = join(dir, 'blur.mp4');
    await renderRemotionScene({ scene: scene({ media: { asset: 'quad', fit: 'blur-fill', dim: 0 } }), output, theme, out, cacheDir, assets, tools, workDir: join(dir, 'w3') });
    const p = await readPicture(tools.ffmpeg, out, 0, output);
    // Contained 2:1 picture spans y 80..240; above it the blurred copy, not the black background.
    expect(colorDistance(meanColor(p, 60, 100), QUAD.tl)).toBeLessThan(30);
    const above = meanColor(p, 60, 20);
    expect(Math.max(...above)).toBeGreaterThan(60);
  }, 300_000);

  it('refuses an asset that is not the project\'s', async () => {
    await expect(
      renderRemotionScene({ scene: scene({ media: { asset: 'other', fit: 'cover', dim: 0 } }), output, out: join(dir, 'x.mp4'), cacheDir, assets, tools, workDir: join(dir, 'w4') })
    ).rejects.toThrow(/not one of this project's assets/);
  });
});
