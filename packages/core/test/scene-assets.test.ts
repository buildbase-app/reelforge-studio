import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTools, type Tools } from '@renderweld/media-pipeline';
import { parseProject, type RenderScene } from '@renderweld/project-schema';
import {
  AssetStore,
  createMemoryRepositories,
  lookupAsset,
  markupAssetUses,
  rewriteSceneHtml,
  videoSelectorsAsImages,
  sanitizeSvg,
  sceneAssetUses,
  stageSceneAssets,
  startAssetServer,
  svgSize,
  type ResolvedAsset,
} from '../src/index';
import { TEMPLATES } from '@renderweld/project-schema';
import { makeNumberedClip, makeQuadImage } from '../../media-pipeline/test/media-fixtures';
import { tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-scene-assets-');

function rawGet(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}
afterAll(cleanup);
let tools: Tools;
let quad: string;
let clip: string;

const EVIL_SVG =
  '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 20" onload="alert(1)">' +
  '<script>alert(2)</script><style>@import url(http://evil.example/a.css); rect{fill:red}</style><style>.ok{fill:#0f0}</style>' +
  '<a href="javascript:alert(3)"><rect class="ok" width="40" height="20" onclick="alert(4)" fill="url(#g)"/></a>' +
  '<linearGradient id="g"><stop offset="0" stop-color="#00f"/></linearGradient>' +
  '<image href="http://evil.example/x.png"/><use xlink:href="http://evil.example/s.svg#a"/><use href="#g"/>' +
  '<foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="http://evil.example/"></iframe></foreignObject>' +
  '<set attributeName="href" to="javascript:alert(5)"/><animate attributeName="x" values="0;1"/>' +
  '<rect width="1" height="1" style="background:url(http://evil.example/b.png)"/><text x="1" y="1">&x; &lt;ok&gt;</text></svg>';

beforeAll(async () => {
  tools = resolveTools();
  quad = await makeQuadImage(tools.ffmpeg, join(dir, 'quad.png'));
  clip = await makeNumberedClip(tools.ffmpeg, join(dir, 'clip.mp4'), { fps: 30, frames: 30 });
}, 60_000);

describe('ASSET-SVG SVG is rewritten from an allowlist (#299)', () => {
  it('drops scripts, handlers, remote references, foreignObject, animation and loading styles; keeps drawing', () => {
    const out = sanitizeSvg(EVIL_SVG).toString('utf8');
    expect(out).not.toMatch(/script|onload|onclick|javascript|evil\.example|foreignObject|iframe|<set|<animate|@import|<image|<a[\s>]|ENTITY|boom/i);
    expect(out).toContain('<rect class="ok" width="40" height="20" fill="url(#g)"></rect>');
    expect(out).toContain('<style>.ok{fill:#0f0}</style>');
    expect(out).toContain('<use href="#g"></use>');
    expect(out).toContain('viewBox="0 0 40 20"');
    expect(out).toContain('&amp;x; &lt;ok&gt;');
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    // Idempotent: a second pass changes nothing.
    expect(sanitizeSvg(out).toString('utf8')).toBe(out);
    expect(svgSize(out)).toEqual({ width: 40, height: 20 });
    expect(svgSize('<svg width="300px" viewBox="0 0 10 5">')).toEqual({ width: 300, height: 150 });
  });
  it('refuses files without an <svg> root', () => {
    expect(() => sanitizeSvg('<html><body><svg></svg></body></html>')).not.toThrow(); // the svg element is what is kept
    expect(() => sanitizeSvg('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>1</script></html>')).toThrow(/no <svg>/);
  });
  it('the asset store accepts an SVG upload only as sanitised bytes, content-addressed on them', async () => {
    const store = new AssetStore(createMemoryRepositories().assets, join(dir, 'store'), { maxBytes: 1024 * 1024, timeoutMs: 1000, maxRedirects: 0 });
    const a = await store.put({ data: Buffer.from(EVIL_SVG), source: 'upload', declaredContentType: 'image/svg+xml' });
    expect(a).toMatchObject({ contentType: 'image/svg+xml', mediaType: 'image' });
    const stored = readFileSync(await store.file(a.id), 'utf8');
    expect(stored).toBe(sanitizeSvg(EVIL_SVG).toString('utf8'));
    expect(a.bytes).toBe(Buffer.byteLength(stored));
    await expect(store.put({ data: Buffer.from('<?xml version="1.0"?><html/>'), source: 'upload' })).rejects.toMatchObject({ code: 'unsupported_media_type' });
  });
});

describe('ASSET-REFS which assets a scene uses, and what is refused (#299)', () => {
  it('collects template media props, markup references with video in-points, and scene.assets', () => {
    const tpl: RenderScene = { id: 's', engine: 'remotion', template: 'kinetic-title', durationFrames: 30, props: { headline: 'x', media: { asset: 'clip', start: 2 }, logo: { asset: 'logo' } } };
    expect(sceneAssetUses(tpl, TEMPLATES['kinetic-title']).map((u) => [u.asset, u.start, u.mediaTypes])).toEqual([
      ['clip', 2, ['image', 'video']],
      ['logo', undefined, ['image']],
    ]);
    const src: RenderScene = {
      id: 's',
      engine: 'html',
      durationFrames: 30,
      props: {},
      html: '<img src="asset:a" srcset="asset:b 2x, asset:c 3x"><video src="asset:v" data-media-start="1.5"></video><div style="background:url(asset:d)"></div><style>.x{background:url("asset:e")}</style>',
      css: '@font-face{src:url(asset:f)}',
    };
    expect(sceneAssetUses(src).map((u) => `${u.asset}${u.start ? `@${u.start}` : ''}`)).toEqual(['a', 'b', 'c', 'v@1.5', 'd', 'e', 'f']);
  });
  it('refuses references in elements that open documents, store ids, paths and query strings', () => {
    for (const html of ['<iframe src="asset:a"></iframe>', '<object data="asset:a"></object>', '<embed src="asset:a">', '<a href="asset:a">x</a>', '<link rel="stylesheet" href="asset:a">']) {
      expect(() => markupAssetUses(html, undefined), html).toThrow(/is not allowed/);
    }
    for (const html of ['<img src="asset://ast-0123456789abcdef">', '<img src="asset:../x">', '<img src="asset:a?x=1">', '<img src="asset:A">', '<img src="asset:a/b">']) {
      expect(() => markupAssetUses(html, undefined), html).toThrow(/not an asset reference/);
    }
    expect(markupAssetUses('<p>Our best asset: you</p>', undefined)).toEqual([]);
  });
  it('the manifest refuses unknown ids, another project\'s ids, audio in markup and wrong media types in props', () => {
    const base = {
      schemaVersion: '0.2',
      projectId: 'p',
      title: 't',
      output: { width: 320, height: 320, fps: 30, format: 'mp4' },
      assets: [
        { id: 'img', uri: 'asset://ast-0123456789abcdef', mediaType: 'image' },
        { id: 'bed', uri: 'asset://ast-0123456789abcde0', mediaType: 'audio' },
      ],
    };
    const issues = (scene: Record<string, unknown>) => {
      const r = parseProject({ ...base, scenes: [{ id: 's', durationSeconds: 2, ...scene }] });
      return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
    };
    expect(issues({ engine: 'html', html: '<img src="asset:img">' })).toEqual([]);
    expect(issues({ engine: 'html', html: '<img src="asset:other-projects-logo">' }).join('\n')).toMatch(/unknown asset id "other-projects-logo"/);
    expect(issues({ engine: 'html', html: '<img src="asset://ast-0123456789abcdef">' }).join('\n')).toMatch(/is not an asset reference/);
    expect(issues({ engine: 'html', html: '<audio src="asset:bed"></audio>' }).join('\n')).toMatch(/is audio; sound goes in audio/);
    expect(issues({ engine: 'remotion', template: 'kinetic-title', props: { headline: 'x', media: { asset: 'bed' } } }).join('\n')).toMatch(/props\.media\.asset: asset "bed" is audio; expected image or video/);
    expect(issues({ engine: 'remotion', template: 'kinetic-title', props: { headline: 'x', logo: { asset: 'nope' } } }).join('\n')).toMatch(/unknown asset id "nope"/);
    expect(issues({ engine: 'remotion', template: 'kinetic-title', props: { headline: 'x', media: { asset: 'img', fit: 'stretch' } } }).join('\n')).toMatch(/props\.media\.fit/);
  });
});

describe('ASSET-STAGE staging checks every file and serves only what it staged (#299)', () => {
  const assets = () =>
    new Map<string, ResolvedAsset>([
      ['quad', { id: 'quad', file: quad, mediaType: 'image' }],
      ['clip', { id: 'clip', file: clip, mediaType: 'video' }],
    ]);
  const output = { width: 320, height: 320, fps: 30 };

  it('stages images and video pictures under made-up names; the server answers only those, by exact name', async () => {
    const staged = await stageSceneAssets({
      uses: [
        { asset: 'quad', where: 't' },
        { asset: 'clip', start: 0.5, where: 't' },
      ],
      assets: assets(),
      dir: join(dir, 'st1'),
      tools,
      output,
      frames: { first: 0, count: 10 },
    });
    expect(staged.items.get('quad')).toMatchObject({ name: 'quad.png', width: 200, height: 100, mediaType: 'image' });
    expect(staged.items.get('clip@0.5')?.frames?.names).toHaveLength(10);
    expect([...staged.files.keys()].sort()[0]).toBe('quad.png');
    const server = await startAssetServer(staged);
    try {
      const ok = await fetch(`${server.base}quad.png`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/png');
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
      expect(ok.headers.get('content-security-policy')).toContain("script-src 'none'");
      expect(Buffer.from(await ok.arrayBuffer()).equals(readFileSync(quad))).toBe(true);
      const token = server.base.split('/')[3]!;
      // Raw request paths (fetch would normalise dot segments before sending).
      const port = Number(new URL(server.origin).port);
      for (const p of [`/${token}/../${token}/quad.png`, `/${token}/%2e%2e/${token}/quad.png`, `/${token}/..%2fquad.png`, `/${token}/quad.png/..`, '/quad.png', `/${'0'.repeat(32)}/quad.png`, `/${token}/%00quad.png`, `/${token}/./quad.png`, `/${token}//quad.png`]) {
        expect(await rawGet(port, p), p).toBe(404);
      }
      expect((await fetch(`${server.base}quad.png`, { method: 'POST' })).status).toBe(404);
      expect(lookupAsset(staged, token, `/${token}/../../etc/passwd`)).toBeUndefined();
    } finally {
      await server.close();
    }
  }, 60_000);

  it('refuses an id that is not the project\'s, a wrong media type, bytes that are not what the manifest says, and a missing file', async () => {
    const stage = (uses: Parameters<typeof stageSceneAssets>[0]['uses'], map = assets()) =>
      stageSceneAssets({ uses, assets: map, dir: join(dir, `st-${Math.random()}`), tools, output, frames: { first: 0, count: 2 } });
    await expect(stage([{ asset: 'someone-elses', where: 'props.media.asset' }])).rejects.toThrow(/"someone-elses" \(props\.media\.asset\): not one of this project's assets/);
    await expect(stage([{ asset: 'clip', mediaTypes: ['image'], where: 'props.logo.asset' }])).rejects.toThrow(/is video; expected image/);
    const html = join(dir, 'fake.png');
    writeFileSync(html, '<!doctype html><script>alert(1)</script>');
    await expect(stage([{ asset: 'x', where: 'w' }], new Map([['x', { id: 'x', file: html, mediaType: 'image' as const }]]))).rejects.toThrow(/not a supported image/);
    await expect(stage([{ asset: 'x', where: 'w' }], new Map([['x', { id: 'x', file: clip, mediaType: 'image' as const }]]))).rejects.toThrow(/bytes are video .* manifest says image/);
    await expect(stage([{ asset: 'x', where: 'w' }], new Map([['x', { id: 'x', file: join(dir, 'gone.png'), mediaType: 'image' as const }]]))).rejects.toThrow(/missing/);
    await expect(stage([{ asset: 'clip', start: 99, where: 'w' }])).rejects.toThrow(/after the end of the clip/);
    await expect(stageSceneAssets({ uses: [{ asset: 'quad', where: 'w' }], assets: assets(), dir: join(dir, 'st-big'), tools, output, frames: { first: 0, count: 1 }, maxBytes: 10 })).rejects.toThrow(/bytes \(allowed: 1 to 10\)/);
  }, 60_000);

  it('a malicious SVG is staged sanitised whatever its source (store or project folder)', async () => {
    const svg = join(dir, 'evil.svg');
    writeFileSync(svg, EVIL_SVG);
    const staged = await stageSceneAssets({ uses: [{ asset: 'e', where: 'w' }], assets: new Map([['e', { id: 'e', file: svg, mediaType: 'image' as const }]]), dir: join(dir, 'st-svg'), tools, output, frames: { first: 0, count: 1 } });
    const it = staged.items.get('e')!;
    expect(it).toMatchObject({ name: 'e.svg', contentType: 'image/svg+xml', width: 40, height: 20 });
    expect(readFileSync(it.file, 'utf8')).not.toMatch(/script|onload|evil\.example/);
  });

  it('a symlink is followed to its target and checked like any file (the service refuses project:// links outside the folder)', async () => {
    mkdirSync(join(dir, 'proj'), { recursive: true });
    symlinkSync('/etc/hostname', join(dir, 'proj', 'link.png'));
    await expect(
      stageSceneAssets({ uses: [{ asset: 'l', where: 'w' }], assets: new Map([['l', { id: 'l', file: join(dir, 'proj', 'link.png'), mediaType: 'image' as const }]]), dir: join(dir, 'st-link'), tools, output, frames: { first: 0, count: 1 } })
    ).rejects.toThrow(/not a supported image/);
  });

  it('html rewrite: references become URLs; a staged video becomes an <img data-rf-video>', () => {
    const out = rewriteSceneHtml('<video src="asset:clip" data-media-start="2" autoplay class="v"></video><img src="asset:quad">', (k) => `http://o/t/${k}`, { videoAsImage: true, isVideo: (k) => k === 'clip@2' });
    expect(out).toBe('<img src="http://o/t/clip@2" class="v" data-rf-video="clip@2"><img src="http://o/t/quad">');
  });

  it('html rewrite (#448): CSS that selects `video` by tag also selects the <img> a clip became, at the same specificity', () => {
    const out = rewriteSceneHtml('<style>video{object-fit:cover}</style><video src="asset:clip"></video>', (k) => `http://o/t/${k}`, { videoAsImage: true, isVideo: (k) => k === 'clip' });
    expect(out).toBe('<style>video, img:where([data-rf-video]){object-fit:cover}</style><img src="http://o/t/clip" data-rf-video="clip">');
    // No clip swapped: the style stays as written.
    expect(rewriteSceneHtml('<style>video{a:b}</style><img src="asset:quad">', (k) => k, { videoAsImage: true, isVideo: () => false })).toBe('<style>video{a:b}</style><img src="quad">');
  });

  it('videoSelectorsAsImages (#448): only `video` type selectors, in every rule and nested block; values, comments and look-alikes untouched', () => {
    const v = videoSelectorsAsImages;
    expect(v('video{width:100%;height:100%;object-fit:cover}')).toBe('video, img:where([data-rf-video]){width:100%;height:100%;object-fit:cover}');
    expect(v('.pane > video.clip:hover , h1 video{x:y}')).toBe('.pane > video.clip:hover, .pane > img:where([data-rf-video]).clip:hover , h1 video, h1 img:where([data-rf-video]){x:y}');
    expect(v('div:not(video) p{x:y}')).toBe('div:not(video) p, div:not(img:where([data-rf-video])) p{x:y}');
    expect(v('@media (min-width: 10px) { video { x: y } .a { b: c } }')).toBe('@media (min-width: 10px) { video, img:where([data-rf-video]) { x: y } .a { b: c } }');
    // Look-alikes and non-selectors stay.
    const same = '.video,#video,[data-kind="video"],video-wrap,.a-video{content:"video";background:url(video.png)}/* video{} */@keyframes video{from{opacity:0}}@import "video.css";';
    expect(v(same)).toBe(same);
    expect(v('a{b:c}')).toBe('a{b:c}');
    expect(v('')).toBe('');
  });
});
