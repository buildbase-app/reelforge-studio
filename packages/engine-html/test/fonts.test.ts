import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ResolvedAsset } from '@reelforge/core';
import { resolveTools } from '@reelforge/media-pipeline';
import { builtinTheme, type OutputSettings } from '@reelforge/project-schema';
import { renderHtmlScene } from '../src/index';
import { TEST_FONTS, inkRatio, readPicture } from '../../media-pipeline/test/media-fixtures';
import { envValue } from '@reelforge/core';

/**
 * #303: a project font asset is used by the theme in the html engine, and
 * text set in it differs from the fallback (every glyph of RF Block is a
 * solid box, so far more of the frame is text-coloured); a font that does
 * not load fails the render instead of falling back.
 */

const browser = envValue('REELFORGE_CHROMIUM_PATH');
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-html-fonts-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const output: OutputSettings = { width: 320, height: 320, fps: 30, format: 'mp4' };
const base = builtinTheme('default')!.tokens;
const theme = (fontFamily: string) => ({ ...base, fontFamily, colors: { ...base.colors, background: '#000000', text: '#ffffff', mutedText: '#ffffff' } });
const tools = resolveTools();

const render = async (name: string, fontFamily: string, assets: Map<string, ResolvedAsset>, html?: string) => {
  const log: string[] = [];
  const res = await renderHtmlScene({
    scene: { id: name, engine: 'html', durationFrames: 12, props: { headline: 'HHHH HHHH' }, ...(html ? { html } : { template: 'html-title' }) } as never,
    output,
    theme: theme(fontFamily),
    out: join(dir, `${name}.mp4`),
    workDir: join(dir, `w-${name}`),
    ffmpeg: tools.ffmpeg,
    tools,
    assets,
    log: (l) => log.push(l),
  });
  return { ...res, log, ink: inkRatio(await readPicture(tools.ffmpeg, res.out, 11, output), [255, 255, 255]) };
};

describe.skipIf(!hasBrowser)('FONT-HTML project fonts and bundled fonts in the html engine (#303)', () => {
  const fonts = new Map<string, ResolvedAsset>([['brand', { id: 'brand', file: join(TEST_FONTS, 'rf-block.woff2'), mediaType: 'font' }]]);

  it('the theme family that is a project font asset is used (glyph shapes differ from the fallback)', async () => {
    const custom = await render('custom', '"RF Block", sans-serif', fonts);
    const fallback = await render('fallback', '"No Such Font", sans-serif', fonts);
    expect(custom.assetRequests).toContain('fonts/brand.woff2');
    expect(fallback.assetRequests.some((r) => r.startsWith('fonts/'))).toBe(false); // not named: not even declared
    expect(custom.log.join('\n')).toMatch(/fonts RF Block \(project\)/);
    expect(custom.ink).toBeGreaterThan(fallback.ink * 2);
  }, 120_000);

  it('a family named only in the scene css is loaded too; ttf, otf and woff work', async () => {
    for (const file of ['rf-block.ttf', 'rf-block.woff']) {
      const r = await render(`css-${file}`, 'sans-serif', new Map([['f', { id: 'f', file: join(TEST_FONTS, file), mediaType: 'font' as const }]]), '<h1 style="font-family:\'RF Block\';font-size:60px;color:#fff;margin:40px">HHHH</h1>');
      expect(r.ink, file).toBeGreaterThan(0.08);
    }
    const otf = await render('otf', '"RF Block Serif", serif', new Map([['f', { id: 'f', file: join(TEST_FONTS, 'rf-block-bold-italic.otf'), mediaType: 'font' as const }]]));
    expect(otf.assetRequests).toContain('fonts/f.otf');
  }, 120_000);

  it('bundled Inter is served from the package files, not the system', async () => {
    const r = await render('inter', 'Inter, sans-serif', new Map());
    expect(r.log.join('\n')).toMatch(/fonts Inter \(bundled\)/);
    expect(r.assetRequests.some((x) => /^fonts\/bundled\/inter-latin-wght-normal\.woff2$/.test(x))).toBe(true);
  }, 120_000);

  it('a font the browser refuses fails the render instead of falling back', async () => {
    await expect(render('refused', '"RF Broken", sans-serif', new Map([['b', { id: 'b', file: join(TEST_FONTS, 'rf-broken.ttf'), mediaType: 'font' as const }]]))).rejects.toThrow(/font\(s\) did not load: RF Broken/);
  }, 60_000);

  it('a font file that does not parse fails the render, naming the asset', async () => {
    const broken = join(dir, 'broken.woff2');
    writeFileSync(broken, readFileSync(join(TEST_FONTS, 'rf-block.woff2')).subarray(0, 60));
    await expect(render('broken', '"RF Block", sans-serif', new Map([['bad', { id: 'bad', file: broken, mediaType: 'font' as const }]]))).rejects.toThrow(/font asset "bad"/);
  }, 60_000);
});
