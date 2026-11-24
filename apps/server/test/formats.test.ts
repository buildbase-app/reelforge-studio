/**
 * Any output format (#287): every built-in template on its engine at 16:9,
 * 1:1, 4:5 and 9:16 (rendered at a fifth of the real size, proportional) and
 * a 4K smoke render, each checked for overflow on the rendered pixels; and
 * the DOM templates (html, hyperframes) measured in the browser at the real
 * sizes. Real-size renders with contact sheets: `pnpm formats:prove`
 * (scripts/formats/prove.ts, same matrix). Layout primitives (split, picture-in-picture,
 * lower third, grid, fit modes) are measured in the browser at real sizes and
 * checked on rendered pixels at the end of the file; their contact sheets come
 * from `pnpm formats:prove-layouts`.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { buildDocument, htmlTitle } from '@reelforge/engine-html';
import { buildComposition } from '@reelforge/engine-hyperframes';
import { checkExpectation, probe, resolveTools } from '@reelforge/media-pipeline';
import type { ResolvedAsset } from '@reelforge/core';
import { FIT_TEXT_SCRIPT, frameLayout, htmlTitleProps, layoutPanes, layoutSceneDom, layoutSceneProps, toLayoutSpec, type OutputSettings } from '@reelforge/project-schema';
import { LAYOUT_ENGINES, LAYOUT_FORMATS, LAYOUT_SAMPLES, renderLayout, type LayoutSample } from './formats/layouts';
import { FORMATS, FORMAT_4K, SAMPLES, THEME, checkOverflow, engines, frameRgb, renderSample, scaled, type Format } from './formats/matrix';

const run = promisify(execFile);

const browser = process.env.REELFORGE_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-formats-test-'));
const cacheDir = resolve(import.meta.dirname, '../../../.render-cache');
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

describe('browser requirement', () => {
  it.runIf(process.env.REELFORGE_REQUIRE_BROWSER === '1')('REELFORGE_REQUIRE_BROWSER=1: a browser must be configured', () => {
    expect(hasBrowser).toBe(true);
  });
});

/** Longest props the schema allows, and a long unbreakable word: the worst cases for fit-to-box. */
const STRESS = [
  {
    headline: 'WWWW Headlines shrink to fit their box instead of running off the frame edge',
    subline: 'A subline of a realistic length that wraps onto a second or third line on narrow frames',
  },
  { headline: 'Internationalisation-and-localisation-ready', subline: 'One unbreakable word wider than a tall frame at full size' },
];

interface DomBox {
  sel: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  overflowX: boolean;
  overflowY: boolean;
}

/** Load a scene document at its real size, seek its animations to `atMs` and measure its text. */
async function measureDom(doc: string, f: Format, atMs: number, fitByRenderer: boolean, selectors: string[]): Promise<DomBox[]> {
  const b = await chromium.launch({ executablePath: browser!, headless: true });
  try {
    const page = await b.newPage({ viewport: { width: f.width, height: f.height } });
    await page.setContent(doc, { waitUntil: 'load' });
    // The html engine runs the fit script from the renderer; hyperframes compositions carry it inline.
    if (fitByRenderer) await page.evaluate(FIT_TEXT_SCRIPT);
    return await page.evaluate(
      ({ atMs, selectors }) => {
        for (const a of document.getAnimations()) {
          a.pause();
          a.currentTime = atMs;
        }
        return selectors.flatMap((sel) =>
          [...document.querySelectorAll(sel)].map((el) => {
            const r = el.getBoundingClientRect();
            return {
              sel,
              left: r.left,
              top: r.top,
              right: r.right,
              bottom: r.bottom,
              overflowX: el.scrollWidth > el.clientWidth + 1,
              // A whole line that does not fit, not the few pixels glyphs of a tight line height stick out.
              overflowY: el.scrollHeight > el.clientHeight + parseFloat(getComputedStyle(el).fontSize) * 0.25,
            };
          })
        );
      },
      { atMs, selectors }
    );
  } finally {
    await b.close();
  }
}

function expectInsideSafeArea(boxes: DomBox[], f: Format) {
  const l = frameLayout(f.width, f.height);
  const tol = l.unit; // subpixel layout and the entry offsets that have settled by then
  expect(boxes.length).toBeGreaterThan(0);
  for (const b of boxes) {
    const where = `${b.sel} at ${f.width}x${f.height}`;
    expect(b.overflowX, `${where} overflows horizontally`).toBe(false);
    expect(b.overflowY, `${where} overflows vertically`).toBe(false);
    expect(b.left, where).toBeGreaterThanOrEqual(l.box.x - tol);
    expect(b.top, where).toBeGreaterThanOrEqual(l.box.y - tol);
    expect(b.right, where).toBeLessThanOrEqual(l.box.x + l.box.width + tol);
    expect(b.bottom, where).toBeLessThanOrEqual(l.box.y + l.box.height + tol);
  }
}

describe.skipIf(!hasBrowser)('DOM templates at real sizes: text inside the safe area, nothing overflows (#287)', () => {
  const sizes = [...FORMATS, FORMAT_4K, { id: '21x9', label: '21:9', width: 2560, height: 1080 }];
  for (const f of sizes) {
    it(`html-title and hyperframes-title at ${f.width}x${f.height}`, async () => {
      const output: OutputSettings = { width: f.width, height: f.height, fps: 30, format: 'mp4' };
      const seconds = 3;
      for (const props of [SAMPLES.find((s) => s.template === 'html-title')!.props, ...STRESS]) {
        const p = htmlTitleProps.parse(props);
        const html = htmlTitle(p, seconds);
        const doc = buildDocument({ html: html.html, css: html.css, theme: THEME, output, durationSeconds: seconds });
        expectInsideSafeArea(await measureDom(doc, f, seconds * 800, true, ['.rf-card>h1', '.rf-card>p', '.rf-kicker']), f);

        const hfProps = { headline: p.headline, ...(p.subline ? { subline: p.subline } : {}) };
        const comp = buildComposition({ id: 's', engine: 'hyperframes', template: 'hyperframes-title', durationFrames: seconds * 30, props: hfProps }, output, THEME);
        expectInsideSafeArea(await measureDom(comp, f, seconds * 800, false, ['#hf-head', '#hf-sub']), f);
      }
    }, 60_000);
  }
});

describe.skipIf(!hasBrowser)('every built-in template renders inside the safe area at every format (#287)', () => {
  const plugins = hasBrowser ? engines() : {};
  for (const sample of SAMPLES) {
    for (const full of FORMATS) {
      const f = scaled(full, 5);
      it(`${sample.engine}/${sample.template} at ${full.label}, rendered at ${f.width}x${f.height}`, async () => {
        const r = await renderSample(plugins[sample.engine]!, sample, f, dir, cacheDir);
        const info = await probe(resolveTools().ffprobe, r.file);
        expect(checkExpectation(info, { width: f.width, height: f.height, fps: 30, frames: r.frames, audio: false }).filter((p) => !p.startsWith('pixel format'))).toEqual([]);
        const check = await checkOverflow(r, sample);
        expect(check.problems, JSON.stringify(check)).toEqual([]);
        rmSync(r.file, { force: true });
      }, 180_000);
    }
  }

  it('the overflow check fails a scene whose text runs off the frame', async () => {
    const sample = { template: 'source', engine: 'html', seconds: 1, settled: 0.5, props: {} };
    const f = scaled(FORMATS[0]!, 5);
    const output: OutputSettings = { width: f.width, height: f.height, fps: 30, format: 'mp4' };
    const out = join(dir, 'overflow.mp4');
    const tools = resolveTools();
    await plugins.html!.render(
      { id: 'overflow', engine: 'html', durationFrames: 30, props: {}, html: '<h1 style="margin:4px;font-size:60px;white-space:nowrap;color:#fff">A headline that runs off</h1>' },
      { output, theme: THEME, out, workDir: join(dir, 'overflow-work'), cacheDir, tools, assets: new Map(), signal: new AbortController().signal, progress: () => undefined, log: () => undefined }
    );
    const check = await checkOverflow({ file: out, frames: 30, output }, sample);
    expect(check.ok).toBe(false);
    expect(check.problems.join('; ')).toMatch(/right of the safe area/);
    expect(check.problems.join('; ')).toMatch(/clipped/);
  }, 120_000);

  it('4K smoke render (3840x2160): html-title renders at full size inside the safe area', async () => {
    const sample = { ...SAMPLES.find((s) => s.template === 'html-title')!, seconds: 2 };
    const r = await renderSample(plugins.html!, sample, FORMAT_4K, dir, cacheDir, 24);
    const info = await probe(resolveTools().ffprobe, r.file);
    expect(checkExpectation(info, { width: 3840, height: 2160, fps: 24, frames: 48, audio: false })).toEqual([]);
    const check = await checkOverflow(r, sample);
    expect(check.problems, JSON.stringify(check)).toEqual([]);
    rmSync(r.file, { force: true });
  }, 300_000);
});

/* ---------------------------------------------------------------------------
 * Layout primitives (#287): split screen, picture-in-picture, lower thirds,
 * grid and fit modes on the html and hyperframes engines.
 * ------------------------------------------------------------------------- */

/** A stand-in picture of a given aspect ratio (text layout does not depend on the pixels). */
const stubPicture = (aspect: number) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(aspect * 300)}" height="300"><rect width="100%" height="100%" fill="#556677"/></svg>`)}`;
const STUB_ASPECT: Record<string, number> = { still: 4 / 3, wide: 16 / 9, tall: 9 / 16 };

interface LayoutMeasure {
  panes: Array<{ index: number; left: number; top: number; width: number; height: number }>;
  texts: Array<{ sel: string; pane: number; safe: string; left: number; top: number; right: number; bottom: number; overflowX: boolean; overflowY: boolean; box: { left: number; top: number; right: number; bottom: number } }>;
  lowerThird: { left: number; top: number; right: number; bottom: number; overflowX: boolean } | null;
}

async function measureLayout(doc: string, f: Format, atMs: number, fitByRenderer: boolean): Promise<LayoutMeasure> {
  const b = await chromium.launch({ executablePath: browser!, headless: true });
  try {
    const page = await b.newPage({ viewport: { width: f.width, height: f.height } });
    await page.setContent(doc, { waitUntil: 'load' });
    if (fitByRenderer) await page.evaluate(FIT_TEXT_SCRIPT);
    return await page.evaluate((atMs) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = atMs;
      }
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const panes = [...document.querySelectorAll('[data-rfl-pane]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { index: Number(el.getAttribute('data-rfl-pane')), left: r.left, top: r.top, width: r.width, height: r.height };
      });
      const texts = [...document.querySelectorAll('[data-rfl-text]')].flatMap((box) =>
        [...box.querySelectorAll('.rfl-card, .rfl-card>h2, .rfl-card>p, .rfl-label')].map((el) => ({
          sel: `${el.tagName.toLowerCase()}.${el.className}`,
          pane: Number(box.getAttribute('data-rfl-text')),
          safe: box.getAttribute('data-rfl-safe') ?? '',
          ...rect(el),
          overflowX: el.scrollWidth > el.clientWidth + 1,
          overflowY: el.scrollHeight > el.clientHeight + parseFloat(getComputedStyle(el).fontSize) * 0.25,
          box: rect(box),
        }))
      );
      const lt = document.querySelector('.rfl-lt');
      const ltText = document.querySelector('.rfl-lt-text');
      const ltOverflow = ltText ? ltText.scrollWidth > ltText.clientWidth + 1 || ltText.scrollHeight > ltText.clientHeight + 1 : false;
      return { panes, texts, lowerThird: lt ? { ...rect(lt), overflowX: ltOverflow } : null };
    }, atMs);
  } finally {
    await b.close();
  }
}

function expectLayoutFits(m: LayoutMeasure, sample: LayoutSample, f: Format, where: string) {
  const l = frameLayout(f.width, f.height);
  const props = layoutSceneProps.parse(sample.props);
  const geometry = layoutPanes(l, toLayoutSpec(props.layout), props.panes.length);
  // Every pane where the geometry puts it (the same numbers in every engine).
  expect(m.panes.length, where).toBe(geometry.panes.length);
  for (const p of geometry.panes) {
    const got = m.panes.find((x) => x.index === p.index)!;
    for (const [a, b] of [
      [got.left, p.x],
      [got.top, p.y],
      [got.width, p.width],
      [got.height, p.height],
    ] as const) expect(Math.abs(a - b), `${where} pane ${p.index}`).toBeLessThanOrEqual(1);
    if (p.role === 'inset') {
      expect(p.x >= l.box.x && p.y >= l.box.y && p.x + p.width <= l.box.x + l.box.width && p.y + p.height <= l.box.y + l.box.height, `${where} inset inside the safe area`).toBe(true);
    }
  }
  const tol = l.unit;
  const title = { x0: l.safe.title.left, y0: l.safe.title.top, x1: f.width - l.safe.title.right, y1: f.height - l.safe.title.bottom };
  const content = { x0: l.box.x, y0: l.box.y, x1: l.box.x + l.box.width, y1: l.box.y + l.box.height };
  for (const t of m.texts) {
    const w = `${where} pane ${t.pane} ${t.sel}`;
    expect(t.overflowX, `${w} overflows horizontally`).toBe(false);
    expect(t.overflowY, `${w} overflows vertically`).toBe(false);
    // Inside its pane's text box, and that box inside the content safe area (title safe for a pane in the app-overlay zone).
    expect(t.left, w).toBeGreaterThanOrEqual(t.box.left - 1);
    expect(t.top, w).toBeGreaterThanOrEqual(t.box.top - tol);
    expect(t.right, w).toBeLessThanOrEqual(t.box.right + 1);
    expect(t.bottom, w).toBeLessThanOrEqual(t.box.bottom + tol);
    const safe = t.safe === 'content' ? content : title;
    expect(t.left >= safe.x0 - tol && t.top >= safe.y0 - tol && t.right <= safe.x1 + tol && t.bottom <= safe.y1 + tol, `${w} inside the ${t.safe} safe area`).toBe(true);
  }
  if (props.lowerThird) {
    const lt = m.lowerThird!;
    expect(lt.overflowX, `${where} lower third text overflows`).toBe(false);
    expect(lt.left >= content.x0 - tol && lt.top >= content.y0 - tol && lt.right <= content.x1 + tol && lt.bottom <= content.y1 + tol, `${where} lower third inside the safe area`).toBe(true);
    // No pane text under the lower third.
    for (const t of m.texts) {
      const overlaps = t.left < lt.right && t.right > lt.left && t.top < lt.bottom && t.bottom > lt.top;
      expect(overlaps, `${where} ${t.sel} under the lower third`).toBe(false);
    }
  }
}

describe.skipIf(!hasBrowser)('layout primitives at real sizes: panes where the geometry says, text inside the safe area (#287)', () => {
  const sizes = [...LAYOUT_FORMATS, { id: '4x5', label: '4:5', width: 1080, height: 1350 }, { id: '21x9', label: '21:9', width: 2560, height: 1080 }];
  // The longest text the schema allows in every pane of a 6-pane grid, and a lower third at its limits over a split.
  const longText = {
    layout: { type: 'grid' },
    panes: Array.from({ length: 6 }, (_, i) => ({
      media: { asset: i % 2 ? 'wide' : 'tall', fit: 'cover' },
      label: 'A label of forty characters, at the cap',
      headline: 'WWWW A headline at the eighty character limit that must shrink to fit its pane',
      body: 'Body text of a realistic length that wraps onto two or three lines in a narrow pane and must stay inside the pane and the safe area too.',
    })),
  };
  const longLowerThird = {
    layout: { type: 'split' },
    panes: [
      { media: { asset: 'wide', fit: 'cover' }, label: 'A label of forty characters, at the cap', headline: 'WWWW A headline at the eighty character limit that must shrink to fit its pane' },
      { media: { asset: 'tall', fit: 'blur-fill' }, body: 'Body text of a realistic length that wraps onto two or three lines in a narrow pane and must stay inside the pane and the safe area too.' },
    ],
    lowerThird: { name: 'A name at the sixty character limit for lower third names ok', title: 'And a title of eighty characters that wraps onto a second line in narrow frames.' },
  };
  const samples: LayoutSample[] = [
    ...LAYOUT_SAMPLES,
    { id: 'stress-grid', title: 'longest text', seconds: 2, settled: 0.8, props: longText },
    { id: 'stress-lower-third', title: 'longest lower third', seconds: 2, settled: 0.8, props: longLowerThird },
  ];
  for (const f of sizes) {
    it(`every layout sample on html and hyperframes at ${f.width}x${f.height}`, async () => {
      const output: OutputSettings = { width: f.width, height: f.height, fps: 30, format: 'mp4' };
      for (const sample of samples) {
        const props = layoutSceneProps.parse(sample.props);
        const dom = layoutSceneDom({
          props,
          width: f.width,
          height: f.height,
          durationSeconds: sample.seconds,
          picture: (r) => `<img class="${r.className}" style="${r.style}" alt="" src="${stubPicture(STUB_ASPECT[r.media.asset] ?? 1)}">`,
        });
        const doc = buildDocument({ html: dom.html, css: dom.css, theme: THEME, output, durationSeconds: sample.seconds });
        expectLayoutFits(await measureLayout(doc, f, sample.seconds * 1000 * sample.settled, true), sample, f, `html ${sample.id} ${f.id}`);

        const comp = buildComposition(
          { id: 's', engine: 'hyperframes', template: 'hyperframes-layout', durationFrames: sample.seconds * 30, props: sample.props as Record<string, unknown> },
          output,
          THEME,
          undefined,
          (asset) => ({ kind: 'image', src: stubPicture(STUB_ASPECT[asset] ?? 1) })
        );
        expectLayoutFits(await measureLayout(comp, f, sample.seconds * 1000 * sample.settled, false), sample, f, `hyperframes ${sample.id} ${f.id}`);
      }
    }, 180_000);
  }
});

describe.skipIf(!hasBrowser)('layout primitives render: fit modes and video panes on the rendered pixels (#287)', () => {
  const plugins = hasBrowser ? engines() : {};
  const PANE = '#0000ff';
  let assets: Map<string, ResolvedAsset>;
  const media = async () => {
    if (assets) return assets;
    const m = join(dir, 'layout-media');
    mkdirSync(m, { recursive: true });
    const ff = (args: string[]) => run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
    // A red 4:3 picture, and a 2 s video: red for 1 s, then green.
    await ff(['-f', 'lavfi', '-i', 'color=c=#ff0000:s=400x300', '-frames:v', '1', join(m, 'red.png')]);
    await ff(['-f', 'lavfi', '-i', 'color=c=#ff0000:s=320x240:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=#00ff00:s=320x240:r=30:d=1', '-filter_complex', '[0][1]concat=n=2:v=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(m, 'rg.mp4')]);
    assets = new Map<string, ResolvedAsset>([
      ['red', { id: 'red', file: join(m, 'red.png'), mediaType: 'image' }],
      ['rg', { id: 'rg', file: join(m, 'rg.mp4'), mediaType: 'video' }],
    ]);
    return assets;
  };
  const px = (rgb: Buffer, w: number, x: number, y: number) => {
    const i = (Math.round(y) * w + Math.round(x)) * 3;
    return [rgb[i]!, rgb[i + 1]!, rgb[i + 2]!] as const;
  };
  const isRed = ([r, g, b]: readonly [number, number, number]) => r > 200 && g < 60 && b < 60;
  const isBlue = ([r, g, b]: readonly [number, number, number]) => b > 200 && r < 60 && g < 60;
  const isGreen = ([r, g, b]: readonly [number, number, number]) => g > 200 && r < 60 && b < 60;
  /** The blurred, darkened copy of the red picture: red, but not the pane colour. */
  const isDimRed = ([r, g, b]: readonly [number, number, number]) => r > 90 && g < 60 && b < 90;

  for (const e of LAYOUT_ENGINES) {
    it(`${e.engine}: contain letterboxes, cover crops, blur-fill fills the letterbox with the blurred picture`, async () => {
      const a = await media();
      const sample: LayoutSample = {
        id: 'fit-pixels',
        title: 'fit',
        seconds: 1,
        settled: 0.9,
        props: { layout: { type: 'split', direction: 'horizontal', gap: 2 }, panes: ['contain', 'cover', 'blur-fill'].map((fit) => ({ color: PANE, media: { asset: 'red', fit } })) },
      };
      const f = { id: 'fit', label: '16:9 small', width: 384, height: 216 };
      const r = await renderLayout(plugins[e.engine]!, e.template, sample, f, a, dir, cacheDir);
      const info = await probe(resolveTools().ffprobe, r.file);
      expect(checkExpectation(info, { width: f.width, height: f.height, fps: 30, frames: 30, audio: false }).filter((p) => !p.startsWith('pixel format'))).toEqual([]);
      const rgb = await frameRgb(r.file, 27, f.width, f.height);
      const g = layoutPanes(frameLayout(f.width, f.height), { type: 'split', direction: 'horizontal', gap: 2 }, 3).panes;
      // Portrait panes: a 4:3 picture is letterboxed above and below.
      const at = (i: number, fy: number) => px(rgb, f.width, g[i]!.x + g[i]!.width / 2, g[i]!.y + g[i]!.height * fy);
      for (let i = 0; i < 3; i++) expect(isRed(at(i, 0.5)), `${e.engine} pane ${i} centre ${at(i, 0.5)}`).toBe(true);
      expect(isBlue(at(0, 0.08)), `contain shows the pane colour above the picture: ${at(0, 0.08)}`).toBe(true);
      expect(isRed(at(1, 0.08)), `cover fills the pane: ${at(1, 0.08)}`).toBe(true);
      expect(isDimRed(at(2, 0.08)) && !isRed(at(2, 0.08)), `blur-fill fills the letterbox with the darkened blur: ${at(2, 0.08)}`).toBe(true);
      // The gap between panes shows the frame background.
      const gapX = g[0]!.x + g[0]!.width + 0.5;
      const bg = px(rgb, f.width, gapX, f.height / 2);
      expect(isRed(bg) || isBlue(bg), `gap ${bg}`).toBe(false);
      rmSync(r.file, { force: true });
    }, 180_000);

    it(`${e.engine}: a video pane plays frame by frame from startSeconds and holds its last frame`, async () => {
      const a = await media();
      const f = { id: 'vid', label: 'square small', width: 216, height: 216 };
      const sample = (startSeconds: number): LayoutSample => ({
        id: `video-${startSeconds}`,
        title: 'video',
        seconds: 2,
        settled: 0.5,
        props: { layout: { type: 'full' }, panes: [{ media: { asset: 'rg', fit: 'cover', startSeconds } }] },
      });
      const r0 = await renderLayout(plugins[e.engine]!, e.template, sample(0), f, a, dir, cacheDir);
      const first = px(await frameRgb(r0.file, 3, f.width, f.height), f.width, 108, 108);
      const last = px(await frameRgb(r0.file, 56, f.width, f.height), f.width, 108, 108);
      expect(isRed(first), `${e.engine} frame 3 ${first}`).toBe(true);
      expect(isGreen(last), `${e.engine} frame 56 ${last}`).toBe(true);
      rmSync(r0.file, { force: true });
      // Starting 1 s in, the first frame is already green, and the second second holds the last frame.
      const r1 = await renderLayout(plugins[e.engine]!, e.template, sample(1), f, a, dir, cacheDir);
      const info = await probe(resolveTools().ffprobe, r1.file);
      expect(info.frames).toBe(60);
      for (const n of [1, 45, 59]) expect(isGreen(px(await frameRgb(r1.file, n, f.width, f.height), f.width, 108, 108)), `${e.engine} start 1 s, frame ${n}`).toBe(true);
      rmSync(r1.file, { force: true });
    }, 240_000);
  }
});
