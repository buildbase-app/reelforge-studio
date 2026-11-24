import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveTools } from '@reelforge/media-pipeline';
import { fontFaceCss, fontFamilies } from '@reelforge/project-schema';
import { AssetStore, BUNDLED_FONTS, bundledFontFaces, createMemoryRepositories, fontFaceDescriptors, readFontInfo, stageSceneAssets, type ResolvedAsset } from '../src/index';
import { tempDir } from './helpers';

const FONTS = join(import.meta.dirname, 'fixtures', 'fonts');
const font = (f: string) => readFileSync(join(FONTS, f));
const { dir, cleanup } = tempDir('reelforge-fonts-');
afterAll(cleanup);

describe('FONT-INFO font files are read without a font library (#303)', () => {
  it('reads family, style, weight, axes and licence from TTF, OTF, WOFF and WOFF2', () => {
    for (const f of ['rf-block.ttf', 'rf-block.woff', 'rf-block.woff2']) {
      expect(readFontInfo(font(f)), f).toMatchObject({ family: 'RF Block', subfamily: 'Regular', weight: 400, italic: false, axes: [], licence: 'CC0-1.0 test font made by ReelForge tests' });
    }
    expect(readFontInfo(font('rf-block.woff2')).format).toBe('woff2');
    expect(readFontInfo(font('rf-block-bold-italic.otf'))).toMatchObject({ format: 'otf', family: 'RF Block Serif', weight: 700, italic: true });
    const v = readFontInfo(font('rf-block-var.woff2'));
    expect(v.axes).toEqual([
      { tag: 'wght', min: 100, default: 400, max: 900 },
      { tag: 'wdth', min: 75, default: 100, max: 125 },
    ]);
    expect(fontFaceDescriptors(v)).toEqual({ weight: '100 900', style: 'normal', stretch: '75% 125%' });
    expect(fontFaceDescriptors(readFontInfo(font('rf-block-bold-italic.otf')))).toEqual({ weight: '700', style: 'italic' });
  });
  it('reads the bundled fonts (real WOFF2 files with transformed glyf tables)', () => {
    const faces = bundledFontFaces();
    expect([...new Set(faces.map((f) => f.family))]).toEqual(BUNDLED_FONTS.map((f) => f.family));
    for (const f of faces) expect(existsSync(f.file), f.file).toBe(true);
    const inter = faces.find((f) => f.family === 'Inter' && f.file.endsWith('inter-latin-wght-normal.woff2'))!;
    expect(inter).toMatchObject({ weight: '100 900', style: 'normal' });
    expect(inter.unicodeRange).toMatch(/^U\+0000-00FF/);
    expect(faces.some((f) => f.family === 'Inter' && f.style === 'italic')).toBe(true);
    expect(readFontInfo(readFileSync(inter.file))).toMatchObject({ family: 'Inter', axes: [{ tag: 'wght', min: 100, max: 900 }] });
  });
  it('refuses truncated, corrupt and non-font files', () => {
    expect(() => readFontInfo(font('rf-block.woff2').subarray(0, 60))).toThrow(/not a valid font file/);
    expect(() => readFontInfo(font('rf-block.woff').subarray(0, 100))).toThrow(/not a valid font file/);
    expect(() => readFontInfo(Buffer.from('wOF2' + 'x'.repeat(80)))).toThrow(/not a valid font file/);
    expect(() => readFontInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow(/not a TTF, OTF, WOFF or WOFF2/);
    const bad = Buffer.from(font('rf-block.ttf'));
    bad.writeUInt16BE(9999, 4); // table count
    expect(() => readFontInfo(bad)).toThrow(/not a valid font file/);
  });
  it('css helpers: family lists and @font-face rules', () => {
    expect(fontFamilies('"Brand Sans", Inter, \'Source Serif 4\', sans-serif')).toEqual(['Brand Sans', 'Inter', 'Source Serif 4', 'sans-serif']);
    expect(fontFaceCss([{ family: 'A "B"', url: 'http://x/t/f.woff2', format: 'woff2', weight: '100 900', style: 'italic', unicodeRange: 'U+0000-00FF' }])).toBe(
      '@font-face{font-family:"A B";src:url("http://x/t/f.woff2") format("woff2");font-weight:100 900;font-style:italic;unicode-range:U+0000-00FF;font-display:block}'
    );
  });
});

describe('FONT-STORE uploads are validated and described (#303)', () => {
  const store = new AssetStore(createMemoryRepositories().assets, join(dir, 'store'), { maxBytes: 1024 * 1024, timeoutMs: 1000, maxRedirects: 0 });
  it('records metadata.font; refuses a font that does not parse', async () => {
    const a = await store.put({ data: font('rf-block-var.woff2'), source: 'upload' });
    expect(a).toMatchObject({ mediaType: 'font', contentType: 'font/woff2' });
    expect(a.metadata?.font).toMatchObject({ family: 'RF Block Var', format: 'woff2', axes: [{ tag: 'wght' }, { tag: 'wdth' }], licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' });
    await expect(store.put({ data: font('rf-block.ttf').subarray(0, 200), source: 'upload' })).rejects.toMatchObject({ code: 'unsupported_media_type' });
  });
});

describe('FONT-STAGE a scene gets the faces of the families it names (#303)', () => {
  const tools = resolveTools();
  const stage = (family: string, assets: Map<string, ResolvedAsset>, markup?: string) =>
    stageSceneAssets({ uses: [], assets, dir: join(dir, `st-${Math.random()}`), tools, output: { width: 320, height: 320, fps: 30 }, frames: { first: 0, count: 1 }, fonts: { family, ...(markup ? { markup } : {}) } });
  const brand = new Map<string, ResolvedAsset>([
    ['brand', { id: 'brand', file: join(FONTS, 'rf-block.woff2'), mediaType: 'font' }],
    ['serif', { id: 'serif', file: join(FONTS, 'rf-block-bold-italic.otf'), mediaType: 'font' }],
  ]);

  it('project fonts by the family inside the file, then bundled fonts; generic and unknown families add nothing', async () => {
    const s = await stage('"RF Block", Inter, "Avenir Next", sans-serif', brand);
    const project = s.fonts.filter((f) => f.source === 'project');
    expect(project).toEqual([{ family: 'RF Block', name: 'fonts/brand.woff2', format: 'woff2', weight: '400', style: 'normal', source: 'project', asset: 'brand' }]);
    expect(s.fonts.filter((f) => f.source === 'bundled').every((f) => f.family === 'Inter')).toBe(true);
    expect(s.fonts.filter((f) => f.family === 'Inter').length).toBe(14);
    expect(s.files.get('fonts/brand.woff2')?.contentType).toBe('font/woff2');
    const faces = s.fontFaces('http://o/t/');
    expect(faces[0]).toMatchObject({ family: 'RF Block', url: 'http://o/t/fonts/brand.woff2' });
    expect((await stage('sans-serif', brand)).fonts).toEqual([]);
  });
  it('a family named only in the scene markup is staged; a project font replaces a bundled family of the same name', async () => {
    const s = await stage('sans-serif', brand, '<p style="font-family:\'RF Block Serif\'">x</p>');
    // Matched by name in the markup (a family whose name is part of another's is declared too: harmless, faces load only when used).
    expect(s.fonts.map((f) => [f.family, f.style, f.weight])).toContainEqual(['RF Block Serif', 'italic', '700']);
    expect(s.fonts.some((f) => f.source === 'bundled')).toBe(false);
    const inter = new Map<string, ResolvedAsset>([['my-inter', { id: 'my-inter', file: bundledFontFaces()[0]!.file, mediaType: 'font' }]]);
    const r = await stage('Inter', inter);
    expect(r.fonts.map((f) => f.source)).toEqual(['project']);
  });
  it('a broken font asset fails with its id', async () => {
    const { writeFileSync } = await import('node:fs');
    const f = join(dir, 'broken.ttf');
    writeFileSync(f, font('rf-block.ttf').subarray(0, 300));
    await expect(stage('X', new Map([['bad', { id: 'bad', file: f, mediaType: 'font' }]]))).rejects.toThrow(/font asset "bad"/);
  });
});
