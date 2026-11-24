import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedAsset } from '@reelforge/core';
import { resolveTools, type Tools } from '@reelforge/media-pipeline';
import { builtinTheme, frameLayout, type OutputSettings } from '@reelforge/project-schema';
import { renderHtmlScene } from '../src/index';
import { QUAD, colorDistance, makeNumberedClip, makeQuadImage, meanColor, readBars, readPicture } from '../../media-pipeline/test/media-fixtures';

/**
 * #299: html scenes use the project's images and videos. Asset files are
 * answered by request interception from the staged copies (no socket, no
 * network); video becomes one picture per frame.
 */

const browser = process.env.REELFORGE_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-html-assets-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const output: OutputSettings = { width: 320, height: 320, fps: 30, format: 'mp4' };
const theme = { ...builtinTheme('default')!.tokens, colors: { ...builtinTheme('default')!.tokens.colors, background: '#000000' } };
let tools: Tools;
let assets: Map<string, ResolvedAsset>;

beforeAll(async () => {
  tools = resolveTools();
  const svg = join(dir, 'evil.svg');
  writeFileSync(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="fetch(\'http://evil.example/onload\')"><script>fetch("http://evil.example/script")</script>' +
      '<rect width="40" height="40" fill="#e61e1e"/><image href="http://evil.example/x.png" width="40" height="40"/><foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="http://evil.example/frame"></iframe></foreignObject></svg>'
  );
  assets = new Map<string, ResolvedAsset>([
    ['quad', { id: 'quad', file: await makeQuadImage(tools.ffmpeg, join(dir, 'quad.png')), mediaType: 'image' }],
    ['clip', { id: 'clip', file: await makeNumberedClip(tools.ffmpeg, join(dir, 'clip.mp4'), { fps: 30, frames: 120 }), mediaType: 'video' }],
    ['evil', { id: 'evil', file: svg, mediaType: 'image' }],
    ['bed', { id: 'bed', file: join(dir, 'missing.m4a'), mediaType: 'audio' }],
  ]);
}, 60_000);

const render = (name: string, scene: Record<string, unknown>, extra: Partial<Parameters<typeof renderHtmlScene>[0]> = {}) =>
  renderHtmlScene({
    scene: { id: name, engine: 'html', durationFrames: 30, props: {}, ...scene } as never,
    output,
    theme,
    out: join(dir, `${name}.mp4`),
    workDir: join(dir, `w-${name}`),
    ffmpeg: tools.ffmpeg,
    tools,
    assets,
    ...extra,
  });

describe.skipIf(!hasBrowser)('ASSET-HTML html engine renders the project\'s images and videos (#299)', () => {
  it('an image at its place, a video frame-exact (and from an in-point), an SVG with its scripts removed; only asset files are requested', async () => {
    const res = await render('src', {
      html:
        '<img src="asset:quad" style="position:absolute;left:0;top:0;width:200px;height:100px">' +
        '<img src="asset:evil" style="position:absolute;left:260px;top:0;width:40px;height:40px">' +
        '<video src="asset:clip" style="position:absolute;left:0;top:120px;width:320px;height:80px;object-fit:fill"></video>' +
        '<video src="asset:clip" data-media-start="2" style="position:absolute;left:0;top:220px;width:320px;height:80px;object-fit:fill"></video>',
      css: '#rf-root{background:#000}',
    });
    expect(res.blockedRequests).toEqual([]);
    expect(res.assetRequests).toContain('quad.png');
    expect(res.assetRequests).toContain('evil.svg');
    expect(res.assetRequests.filter((r) => r.startsWith('v-clip-0/'))).toHaveLength(30);
    expect(res.assetRequests.filter((r) => r.startsWith('v-clip-2000/'))).toHaveLength(30);
    expect(readFileSync(join(dir, 'w-src', 'assets', 'evil.svg'), 'utf8')).not.toMatch(/script|onload|foreignObject|evil\.example/);
    for (const f of [0, 7, 29]) {
      const p = await readPicture(tools.ffmpeg, res.out, f, output);
      expect(colorDistance(meanColor(p, 50, 25), QUAD.tl), `frame ${f} top-left`).toBeLessThan(25);
      expect(colorDistance(meanColor(p, 150, 25), QUAD.tr)).toBeLessThan(25);
      expect(colorDistance(meanColor(p, 150, 75), QUAD.br)).toBeLessThan(25);
      expect(colorDistance(meanColor(p, 50, 75), QUAD.bl)).toBeLessThan(25);
      expect(colorDistance(meanColor(p, 280, 20), [230, 30, 30])).toBeLessThan(25); // the SVG's rect
      expect(readBars(p, { x: 0, y: 120, width: 320, height: 80 }), `frame ${f}`).toBe(f);
      expect(readBars(p, { x: 0, y: 220, width: 320, height: 80 }), `frame ${f} from 2 s`).toBe(60 + f);
    }
  }, 180_000);

  it('the html-title template shows background video (contain) and a logo in the safe corner', async () => {
    const res = await render('tpl', {
      template: 'html-title',
      props: { headline: 'Hi', media: { asset: 'clip', fit: 'contain', dim: 0 }, logo: { asset: 'quad', corner: 'top-right', size: 14 } },
    });
    const l = frameLayout(320, 320);
    const s = 14 * l.unit;
    const x = l.box.x + l.box.width - s;
    const p = await readPicture(tools.ffmpeg, res.out, 12, output);
    // Logo: 2:1 picture contained at the right top of its square.
    expect(colorDistance(meanColor(p, x + s * 0.25, l.box.y + s * 0.125, 1), QUAD.tl)).toBeLessThan(30);
    expect(colorDistance(meanColor(p, x + s * 0.75, l.box.y + s * 0.375, 1), QUAD.br)).toBeLessThan(30);
    // Video: 320x180 contained in 320x320 sits at y 70..250; read its bars below the headline.
    expect(readBars(p, { x: 0, y: 200, width: 320, height: 40 })).toBe(12);
  }, 180_000);

  it('refuses another project\'s asset, store ids, paths, audio and document elements; file: URLs are blocked', async () => {
    await expect(render('x1', { html: '<img src="asset:not-mine">' })).rejects.toThrow(/not one of this project's assets/);
    await expect(render('x2', { html: '<img src="asset://ast-0123456789abcdef">' })).rejects.toThrow(/not an asset reference/);
    await expect(render('x3', { html: '<img src="asset:../../etc/passwd">' })).rejects.toThrow(/not an asset reference/);
    await expect(render('x4', { html: '<iframe src="asset:evil"></iframe>' })).rejects.toThrow(/<iframe> is not allowed/);
    await expect(render('x5', { html: '<img src="asset:bed">' })).rejects.toThrow(/is audio/);
    const res = await render('x6', { html: '<img src="file:///etc/hostname"><img src="http://127.0.0.1:9/x.png">', durationFrames: 2 });
    // The page policy refuses both before a request is made; nothing reached the asset origin either.
    expect(res.blockedRequests).toEqual([]);
    // Only the theme's bundled font (#303) came from the asset origin; neither blocked URL did.
    expect(res.assetRequests.filter((r) => !r.startsWith('fonts/bundled/'))).toEqual([]);
  }, 120_000);
});
