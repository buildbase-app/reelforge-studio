import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedAsset } from '@reelforge/core';
import { resolveTools, type Tools } from '@reelforge/media-pipeline';
import { builtinTheme, frameLayout, type OutputSettings } from '@reelforge/project-schema';
import { renderHyperframesScene } from '../src/index';
import { QUAD, colorDistance, makeNumberedClip, makeQuadImage, meanColor, readBars, readPicture } from '../../media-pipeline/test/media-fixtures';

/**
 * #299: HyperFrames compositions use the project's images and videos. The
 * files are staged inside the composition folder (so --refuse-outside-files
 * still holds) and HyperFrames seeks the clips itself; the deny-all network
 * sink stays in place (any request outside would fail the render).
 */

const browser = process.env.REELFORGE_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-hf-assets-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // best effort
  }
});
const output: OutputSettings = { width: 320, height: 320, fps: 30, format: 'mp4' };
const theme = { ...builtinTheme('default')!.tokens, colors: { ...builtinTheme('default')!.tokens.colors, background: '#000000' } };
let tools: Tools;
let assets: Map<string, ResolvedAsset>;

beforeAll(async () => {
  tools = resolveTools();
  assets = new Map<string, ResolvedAsset>([
    ['quad', { id: 'quad', file: await makeQuadImage(tools.ffmpeg, join(dir, 'quad.png')), mediaType: 'image' }],
    ['clip', { id: 'clip', file: await makeNumberedClip(tools.ffmpeg, join(dir, 'clip.mp4'), { fps: 30, frames: 120 }), mediaType: 'video' }],
    ['ntsc', { id: 'ntsc', file: await makeNumberedClip(tools.ffmpeg, join(dir, 'ntsc.mp4'), { fps: '30000/1001', frames: 120 }), mediaType: 'video' }],
  ]);
}, 60_000);

const render = (name: string, scene: Record<string, unknown>) => {
  const log: string[] = [];
  return renderHyperframesScene({
    scene: { id: name, engine: 'hyperframes', durationFrames: 30, props: {}, ...scene } as never,
    output,
    theme,
    out: join(dir, `${name}.mp4`),
    workDir: join(dir, `w-${name}`),
    cacheDir: join(dir, 'cache'),
    tools,
    assets,
    log: (l) => log.push(l),
  }).then((r) => ({ ...r, log }));
};

describe.skipIf(!hasBrowser)('ASSET-HF hyperframes engine renders the project\'s images and videos (#299)', () => {
  it('an image at its place and videos frame-exact: 30 fps, 29.97 fps in a 30 fps scene, and from an in-point', async () => {
    const res = await render('src', {
      html:
        '<img src="asset:quad" style="position:absolute;left:0;top:0;width:200px;height:100px">' +
        '<video src="asset:clip" muted playsinline data-start="0" style="position:absolute;left:0;top:110px;width:320px;height:60px;object-fit:fill"></video>' +
        '<video src="asset:ntsc" muted playsinline data-start="0" style="position:absolute;left:0;top:180px;width:320px;height:60px;object-fit:fill"></video>' +
        '<video src="asset:clip" muted playsinline data-start="0" data-media-start="2" style="position:absolute;left:0;top:250px;width:320px;height:60px;object-fit:fill"></video>',
      css: '#root{background:#000}',
    });
    for (const f of [0, 7, 29]) {
      const p = await readPicture(tools.ffmpeg, res.out, f, output);
      expect(colorDistance(meanColor(p, 50, 25), QUAD.tl), `frame ${f}`).toBeLessThan(25);
      expect(colorDistance(meanColor(p, 150, 75), QUAD.br)).toBeLessThan(25);
      expect(readBars(p, { x: 0, y: 110, width: 320, height: 60 }), `frame ${f}`).toBe(f);
      // 29.97 in a 30 fps scene: the source frame nearest to f/30 s (no drift: at most one frame behind at the end).
      const ntsc = readBars(p, { x: 0, y: 180, width: 320, height: 60 });
      expect(Math.abs(ntsc / (30000 / 1001) - f / 30), `frame ${f}: ntsc ${ntsc}`).toBeLessThanOrEqual(0.5 / 30 + 0.5 / 29.97 + 1e-9);
      expect(readBars(p, { x: 0, y: 250, width: 320, height: 60 }), `frame ${f} from 2 s`).toBe(60 + f);
    }
  }, 300_000);

  it('the hyperframes-title template shows a background image (cover) and a logo in the safe corner', async () => {
    const res = await render('tpl', {
      template: 'hyperframes-title',
      props: { headline: 'Hi', media: { asset: 'quad', fit: 'cover', dim: 0 }, logo: { asset: 'quad', corner: 'bottom-left', size: 14 } },
    });
    const p = await readPicture(tools.ffmpeg, res.out, 5, output);
    // 2:1 picture covering a square: the middle half of it; the top-left corner of the frame is the top-left quadrant.
    expect(colorDistance(meanColor(p, 8, 8), QUAD.tl)).toBeLessThan(30);
    expect(colorDistance(meanColor(p, 312, 312), QUAD.br)).toBeLessThan(30);
    const l = frameLayout(320, 320);
    const s = 14 * l.unit;
    const bottom = l.box.y + l.box.height;
    expect(colorDistance(meanColor(p, l.box.x + s * 0.75, bottom - s * 0.125, 1), QUAD.br)).toBeLessThan(30);
  }, 300_000);

  it('refuses another project\'s asset and store ids before starting HyperFrames', async () => {
    await expect(render('x1', { html: '<img src="asset:not-mine">' })).rejects.toThrow(/not one of this project's assets/);
    await expect(render('x2', { html: '<img src="asset://ast-0123456789abcdef">' })).rejects.toThrow(/not an asset reference/);
    await expect(render('x3', { html: '<object data="asset:quad"></object>' })).rejects.toThrow(/<object> is not allowed/);
  });
});
