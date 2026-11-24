/**
 * Layout primitives on Remotion and Motion Canvas (#287): the same props as
 * html-layout and hyperframes-layout, the same geometry, the same pixels.
 *
 * - Cross-engine geometry at 16:9, 1:1, 9:16 and 4K, at full size: every
 *   layout sample (split 2 and 3, picture-in-picture, lower third, grid, fit,
 *   and the longest text the schema allows) with flat pane colours, rendered
 *   by the html engine, Remotion and Motion Canvas. Each pane is found by its
 *   colour and must be within 1 layout unit of `layoutPanes` and of the html
 *   engine's; the lower third likewise, inside the content safe area; and all
 *   pane text inside its pane's text box (which `layoutPanes` keeps in the
 *   safe area): no overflow, nothing clipped.
 * - Media in panes is frame-exact: #299's numbered clip (each frame shows its
 *   number in bars) in a pane from an in-point, on a whole render and on a
 *   frame-range chunk.
 *
 * Fit modes and the red/green video pane are covered for all four engines in
 * formats.test.ts (LAYOUT_ENGINES).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedAsset } from '@reelforge/core';
import { renderMotionCanvasScene } from '@reelforge/engine-motion-canvas';
import { renderRemotionScene } from '@reelforge/engine-remotion';
import { resolveTools, type Tools } from '@reelforge/media-pipeline';
import { layoutPanes, frameLayout, type OutputSettings, type RenderScene } from '@reelforge/project-schema';
import { makeNumberedClip, readBars, readPicture } from '../../../packages/media-pipeline/test/media-fixtures';
import { LAYOUT_FORMATS, LAYOUT_SAMPLES, LAYOUT_STRESS_SAMPLES, checkGeometry, renderGeometryFrame } from './formats/layouts';
import { THEME } from './formats/matrix';

const browser = process.env.REELFORGE_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-layouts-engines-'));
const cacheDir = resolve(import.meta.dirname, '../../../.render-cache');
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

describe('browser requirement', () => {
  it.runIf(process.env.REELFORGE_REQUIRE_BROWSER === '1')('has a browser when REELFORGE_REQUIRE_BROWSER=1', () => {
    expect(hasBrowser, 'set REELFORGE_CHROMIUM_PATH to a Chrome Headless Shell binary').toBe(true);
  });
});

describe.skipIf(!hasBrowser)('layout primitives on Remotion and Motion Canvas: geometry within 1 unit of the html engine (#287)', () => {
  const samples = [...LAYOUT_SAMPLES, ...LAYOUT_STRESS_SAMPLES];
  for (const f of LAYOUT_FORMATS) {
    it(`every layout sample at ${f.width}x${f.height}`, async () => {
      const problems: string[] = [];
      const worst = { remotion: 0, 'motion-canvas': 0 };
      for (const sample of samples) {
        const html = await renderGeometryFrame('html', sample, f, dir, cacheDir);
        const ref = checkGeometry(sample, f, 'html', html, null);
        problems.push(...ref.problems.map((p) => `html ${sample.id} ${f.id}: ${p}`));
        for (const engine of ['remotion', 'motion-canvas'] as const) {
          const rgb = await renderGeometryFrame(engine, sample, f, dir, cacheDir);
          const c = checkGeometry(sample, f, engine, rgb, html);
          problems.push(...c.problems.map((p) => `${engine} ${sample.id} ${f.id}: ${p}`));
          worst[engine] = Math.max(worst[engine], ...c.panes.map((p) => p.vsHtml), c.lowerThird?.vsHtml ?? 0);
        }
      }
      console.log(`layout geometry ${f.id}: largest pane or lower-third edge difference from html: remotion ${worst.remotion}px, motion-canvas ${worst['motion-canvas']}px (1 unit = ${frameLayout(f.width, f.height).unit}px)`);
      expect(problems).toEqual([]);
    }, 900_000);
  }
});

describe.skipIf(!hasBrowser)('layout panes show video frame-exactly on Remotion and Motion Canvas (#287, #299)', () => {
  let tools: Tools;
  let assets: Map<string, ResolvedAsset>;
  const output: OutputSettings = { width: 480, height: 270, fps: 30, format: 'mp4' };
  beforeAll(async () => {
    tools = resolveTools();
    assets = new Map<string, ResolvedAsset>([['clip', { id: 'clip', file: await makeNumberedClip(tools.ffmpeg, join(dir, 'clip.mp4'), { fps: 30, frames: 150 }), mediaType: 'video' }]]);
  }, 60_000);

  // Two panes side by side, the clip from 1 s and from 2 s, contained (letterboxed) so all its bars show.
  const props = {
    layout: { type: 'split', direction: 'horizontal', gap: 0 },
    panes: [
      { media: { asset: 'clip', fit: 'contain', startSeconds: 1 }, color: '#000000' },
      { media: { asset: 'clip', fit: 'contain', startSeconds: 2 }, color: '#000000' },
    ],
  };
  const scene = (engine: string, template: string): RenderScene => ({ id: `vid-${engine}`, engine, template, durationFrames: 45, props });
  const panes = layoutPanes(frameLayout(output.width, output.height), { type: 'split', direction: 'horizontal', gap: 0 }, 2).panes;
  /** Where the 16:9 clip lands in a pane (contain): the pane's width, centred vertically. */
  const clipIn = (pane: (typeof panes)[number]) => {
    const h = pane.width * (9 / 16);
    return { x: pane.x, y: pane.y + (pane.height - h) / 2, width: pane.width, height: h };
  };

  const check = async (file: string, frames: number[], offset: number, where: string) => {
    for (const k of frames) {
      const p = await readPicture(tools.ffmpeg, file, k, output);
      const n = offset + k;
      expect(readBars(p, clipIn(panes[0]!)), `${where} frame ${n}, pane 0 (from 1 s)`).toBe(30 + n);
      expect(readBars(p, clipIn(panes[1]!)), `${where} frame ${n}, pane 1 (from 2 s)`).toBe(60 + n);
    }
  };

  it('remotion-layout: picture k at frame k from each pane\'s in-point; a frame-range chunk matches', async () => {
    const whole = join(dir, 'rem-whole.mp4');
    await renderRemotionScene({ scene: scene('remotion', 'remotion-layout'), output, theme: THEME, out: whole, cacheDir, concurrency: 2, assets, tools, workDir: join(dir, 'rw1') });
    await check(whole, [0, 1, 17, 44], 0, 'remotion whole');
    const chunk = join(dir, 'rem-chunk.mp4');
    await renderRemotionScene({ scene: scene('remotion', 'remotion-layout'), output, theme: THEME, out: chunk, cacheDir, concurrency: 2, assets, tools, workDir: join(dir, 'rw2'), frameRange: [20, 29] });
    await check(chunk, [0, 9], 20, 'remotion chunk');
  }, 300_000);

  it('motion-canvas-layout: picture k at frame k from each pane\'s in-point; a frame range matches', async () => {
    const whole = join(dir, 'mc-whole.mp4');
    await renderMotionCanvasScene({ scene: scene('motion-canvas', 'motion-canvas-layout'), output, theme: THEME, out: whole, cacheDir, ffmpeg: tools.ffmpeg, assets, tools, workDir: join(dir, 'mw1') });
    await check(whole, [0, 1, 17, 44], 0, 'motion-canvas whole');
    const chunk = join(dir, 'mc-chunk.mp4');
    await renderMotionCanvasScene({ scene: scene('motion-canvas', 'motion-canvas-layout'), output, theme: THEME, out: chunk, cacheDir, ffmpeg: tools.ffmpeg, assets, tools, workDir: join(dir, 'mw2'), frameRange: [20, 29] });
    await check(chunk, [0, 9], 20, 'motion-canvas chunk');
  }, 300_000);
});
