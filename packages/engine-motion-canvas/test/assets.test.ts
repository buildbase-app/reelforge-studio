import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedAsset } from '@reelforge/core';
import { resolveTools, type Tools } from '@reelforge/media-pipeline';
import { builtinTheme, frameLayout, type OutputSettings, type RenderScene } from '@reelforge/project-schema';
import { renderMotionCanvasScene } from '../src/index';
import { QUAD, colorDistance, makeNumberedClip, makeQuadImage, meanColor, readBars, readPicture } from '../../media-pipeline/test/media-fixtures';
import { envValue } from '@reelforge/core';

/**
 * #299: animated-explainer shows a background video and a logo from the
 * project's assets (Motion Canvas Img nodes, pictures from the bundle
 * server's per-render token path).
 */

const browser = envValue('REELFORGE_CHROMIUM_PATH');
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-mc-assets-'));
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

const scene = (props: Record<string, unknown>): RenderScene => ({ id: 'mc', engine: 'motion-canvas', template: 'animated-explainer', durationFrames: 60, props: { title: 'Hi', points: ['One'], ...props } });

describe.skipIf(!hasBrowser)('ASSET-MC Motion Canvas renders the project\'s images and videos (#299)', () => {
  it('background video (contain, kept at the top) frame-exact from an in-point; logo in the safe corner', async () => {
    const out = join(dir, 'mc.mp4');
    await renderMotionCanvasScene({
      scene: scene({ media: { asset: 'clip', fit: 'contain', focus: { x: 50, y: 0 }, dim: 0, start: 1 }, logo: { asset: 'quad', corner: 'bottom-right', size: 14 } }),
      output,
      theme,
      out,
      cacheDir,
      ffmpeg: tools.ffmpeg,
      tools,
      assets,
      workDir: join(dir, 'w1'),
    });
    const l = frameLayout(320, 320);
    const s = 14 * l.unit;
    const right = l.box.x + l.box.width;
    const bottom = l.box.y + l.box.height;
    for (const f of [0, 1, 30, 59]) {
      const p = await readPicture(tools.ffmpeg, out, f, output);
      // 320x180 contained with focus at the top: y 0..180; the top band is clear of the text.
      expect(readBars(p, { x: 0, y: 2, width: 320, height: 12 }), `frame ${f}`).toBe(30 + f);
      // 2:1 logo contained at the bottom right of its square.
      expect(colorDistance(meanColor(p, right - s * 0.25, bottom - s * 0.125, 1), QUAD.br), `frame ${f} logo`).toBeLessThan(30);
      expect(colorDistance(meanColor(p, right - s * 0.75, bottom - s * 0.375, 1), QUAD.tl)).toBeLessThan(30);
    }
  }, 300_000);

  it('cover fills the frame with the picture, cropped around the focus', async () => {
    const out = join(dir, 'cover.mp4');
    await renderMotionCanvasScene({ scene: scene({ media: { asset: 'quad', fit: 'cover', dim: 0 } }), output, theme, out, cacheDir, ffmpeg: tools.ffmpeg, tools, assets, workDir: join(dir, 'w2') });
    const p = await readPicture(tools.ffmpeg, out, 0, output);
    expect(colorDistance(meanColor(p, 8, 8), QUAD.tl)).toBeLessThan(30);
    expect(colorDistance(meanColor(p, 312, 312), QUAD.br)).toBeLessThan(30);
  }, 300_000);

  it('refuses an asset that is not the project\'s', async () => {
    await expect(
      renderMotionCanvasScene({ scene: scene({ logo: { asset: 'nope', corner: 'top-left', size: 10 } }), output, out: join(dir, 'x.mp4'), cacheDir, ffmpeg: tools.ffmpeg, tools, assets, workDir: join(dir, 'w3') })
    ).rejects.toThrow(/not one of this project's assets/);
  });
});
