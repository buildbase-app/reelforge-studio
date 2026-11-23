/**
 * Any output format (#287): every built-in template on its engine at 16:9,
 * 1:1, 4:5 and 9:16 (rendered at a fifth of the real size, proportional) and
 * a 4K smoke render, each checked for overflow on the rendered pixels; and
 * the DOM templates (html, hyperframes) measured in the browser at the real
 * sizes. Real-size renders with contact sheets: `pnpm formats:prove`
 * (scripts/formats/prove.ts, same matrix).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { buildDocument, htmlTitle } from '@reelforge/engine-html';
import { buildComposition } from '@reelforge/engine-hyperframes';
import { checkExpectation, probe, resolveTools } from '@reelforge/media-pipeline';
import { FIT_TEXT_SCRIPT, frameLayout, htmlTitleProps, type OutputSettings } from '@reelforge/project-schema';
import { FORMATS, FORMAT_4K, SAMPLES, THEME, checkOverflow, engines, renderSample, scaled, type Format } from './formats/matrix';

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
