import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ResolvedAsset } from '@reelforge/core';
import { resolveTools } from '@reelforge/media-pipeline';
import { builtinTheme, type OutputSettings } from '@reelforge/project-schema';
import { renderMotionCanvasScene } from '../src/index';
import { TEST_FONTS, inkRatio, readPicture } from '../../media-pipeline/test/media-fixtures';
import { envValue } from '@reelforge/core';

/** #303: the theme's project font is loaded before the first frame and drawn by Motion Canvas' Txt nodes. */
const browser = envValue('REELFORGE_CHROMIUM_PATH');
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-mc-fonts-'));
const cacheDir = resolve(__dirname, '../../../.render-cache');
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const output: OutputSettings = { width: 320, height: 320, fps: 30, format: 'mp4' };
const base = builtinTheme('default')!.tokens;
const theme = (fontFamily: string) => ({ ...base, fontFamily, colors: { ...base.colors, background: '#000000', text: '#ffffff', mutedText: '#ffffff' } });
const tools = resolveTools();
const assets = new Map<string, ResolvedAsset>([['brand', { id: 'brand', file: join(TEST_FONTS, 'rf-block.ttf'), mediaType: 'font' }]]);

const render = async (name: string, fontFamily: string, a = assets) => {
  const out = join(dir, `${name}.mp4`);
  const log: string[] = [];
  await renderMotionCanvasScene({ scene: { id: name, engine: 'motion-canvas', template: 'animated-explainer', durationFrames: 60, props: { title: 'HHHH', points: ['HHHH HHHH'] } }, output, theme: theme(fontFamily), out, cacheDir, ffmpeg: tools.ffmpeg, tools, assets: a, workDir: join(dir, `w-${name}`), log: (l) => log.push(l) });
  return { log, ink: inkRatio(await readPicture(tools.ffmpeg, out, 59, output), [255, 255, 255]) };
};

describe.skipIf(!hasBrowser)('FONT-MC project and bundled fonts in Motion Canvas (#303)', () => {
  it('the custom font is drawn (glyph shapes differ from the fallback); bundled Inter is loaded', async () => {
    const custom = await render('custom', '"RF Block", sans-serif');
    const fallback = await render('fallback', '"No Such Font", sans-serif');
    expect(custom.log.join('\n')).toMatch(/fonts RF Block \(project\)/);
    expect(custom.ink).toBeGreaterThan(fallback.ink * 2);
    const inter = await render('inter', 'Inter, sans-serif', new Map());
    expect(inter.log.join('\n')).toMatch(/fonts Inter \(bundled\)/);
  }, 300_000);

  it('a font the browser refuses stops the render instead of falling back', async () => {
    await expect(render('refused', '"RF Broken", sans-serif', new Map([['b', { id: 'b', file: join(TEST_FONTS, 'rf-broken.ttf'), mediaType: 'font' as const }]]))).rejects.toThrow(/font\(s\) did not load: RF Broken/);
  }, 300_000);
});
