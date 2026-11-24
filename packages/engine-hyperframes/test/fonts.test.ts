import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ResolvedAsset } from '@reelforge/core';
import { resolveTools } from '@reelforge/media-pipeline';
import { builtinTheme, type OutputSettings } from '@reelforge/project-schema';
import { renderHyperframesScene } from '../src/index';
import { TEST_FONTS, inkRatio, readPicture } from '../../media-pipeline/test/media-fixtures';
import { envValue } from '@reelforge/core';

/** #303: the theme's project font is declared from the composition folder and used; no font is fetched from the network. */
const browser = envValue('REELFORGE_CHROMIUM_PATH');
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-hf-fonts-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // best effort
  }
});
const output: OutputSettings = { width: 320, height: 320, fps: 30, format: 'mp4' };
const base = builtinTheme('default')!.tokens;
const theme = (fontFamily: string) => ({ ...base, fontFamily, colors: { ...base.colors, background: '#000000', text: '#ffffff', mutedText: '#ffffff' } });
const tools = resolveTools();
const assets = new Map<string, ResolvedAsset>([['brand', { id: 'brand', file: join(TEST_FONTS, 'rf-block.woff'), mediaType: 'font' }]]);

const render = async (name: string, fontFamily: string, a = assets) => {
  const out = join(dir, `${name}.mp4`);
  const log: string[] = [];
  await renderHyperframesScene({ scene: { id: name, engine: 'hyperframes', template: 'hyperframes-title', durationFrames: 30, props: { headline: 'HHHH HHHH' } }, output, theme: theme(fontFamily), out, workDir: join(dir, `w-${name}`), cacheDir: join(dir, 'cache'), tools, assets: a, log: (l) => log.push(l) });
  return { log, ink: inkRatio(await readPicture(tools.ffmpeg, out, 20, output), [255, 255, 255]) };
};

describe.skipIf(!hasBrowser)('FONT-HF project and bundled fonts in HyperFrames (#303)', () => {
  it('the custom font is used (glyph shapes differ from the fallback); bundled Inter is declared', async () => {
    const custom = await render('custom', '"RF Block", sans-serif');
    const fallback = await render('fallback', '"No Such Font", sans-serif');
    expect(custom.log.join('\n')).toMatch(/fonts RF Block \(project\)/);
    expect(custom.ink).toBeGreaterThan(fallback.ink * 2);
    const inter = await render('inter', 'Inter, sans-serif', new Map());
    expect(inter.log.join('\n')).toMatch(/fonts Inter \(bundled\)/);
    expect(inter.log.join('\n')).not.toMatch(/not installed and was not downloaded/);
  }, 300_000);
});
