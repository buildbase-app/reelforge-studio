import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ResolvedAsset } from '@renderweld/core';
import { resolveTools } from '@renderweld/media-pipeline';
import { builtinTheme, type OutputSettings } from '@renderweld/project-schema';
import { renderRemotionScene } from '../src/index';
import { TEST_FONTS, inkRatio, readPicture } from '../../media-pipeline/test/media-fixtures';

/** #303: the theme's project font is loaded (FontFace API, before any frame) and used by kinetic-title. */
const hasBrowser = Boolean(process.env.RENDERWELD_CHROMIUM_PATH && existsSync(process.env.RENDERWELD_CHROMIUM_PATH));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-remotion-fonts-'));
const cacheDir = resolve(__dirname, '../../../.render-cache');
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const output: OutputSettings = { width: 320, height: 320, fps: 30, format: 'mp4' };
const base = builtinTheme('default')!.tokens;
const theme = (fontFamily: string) => ({ ...base, fontFamily, colors: { ...base.colors, background: '#000000', text: '#ffffff' } });
const tools = resolveTools();
const assets = new Map<string, ResolvedAsset>([['brand', { id: 'brand', file: join(TEST_FONTS, 'rf-block.woff2'), mediaType: 'font' }]]);

const render = async (name: string, fontFamily: string, a = assets) => {
  const out = join(dir, `${name}.mp4`);
  const log: string[] = [];
  await renderRemotionScene({ scene: { id: name, engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'HHHH HHHH' } }, output, theme: theme(fontFamily), out, cacheDir, concurrency: 2, assets: a, tools, workDir: join(dir, `w-${name}`), log: (l) => log.push(l) });
  return { log, ink: inkRatio(await readPicture(tools.ffmpeg, out, 30, output), [255, 255, 255]) };
};

describe.skipIf(!hasBrowser)('FONT-REM project and bundled fonts in Remotion (#303)', () => {
  it('the custom font is used on every frame (glyph shapes differ from the fallback); bundled Inter is loaded', async () => {
    const custom = await render('custom', '"RF Block", sans-serif');
    const fallback = await render('fallback', '"No Such Font", sans-serif');
    expect(custom.log.join('\n')).toMatch(/fonts RF Block \(project\)/);
    expect(custom.ink).toBeGreaterThan(fallback.ink * 2);
    const inter = await render('inter', 'Inter, sans-serif', new Map());
    expect(inter.log.join('\n')).toMatch(/fonts Inter \(bundled\)/);
  }, 300_000);

  it('a font the browser refuses cancels the render instead of falling back', async () => {
    await expect(render('refused', '"RF Broken", sans-serif', new Map([['b', { id: 'b', file: join(TEST_FONTS, 'rf-broken.ttf'), mediaType: 'font' as const }]]))).rejects.toThrow(/font\(s\) did not load: RF Broken/);
  }, 300_000);
});
