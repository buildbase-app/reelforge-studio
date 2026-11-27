import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveTools } from '@renderweld/media-pipeline';
import { builtinTheme, textSampleStep, type OutputSettings, type RenderScene } from '@renderweld/project-schema';
import { envValue } from '@renderweld/core';
import { renderHtmlScene } from '../src/index';

const browser = envValue('REELFORGE_CHROMIUM_PATH');
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-textqa-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const output: OutputSettings = { width: 360, height: 640, fps: 30, format: 'mp4' };
const theme = builtinTheme('midnight')!.tokens;

describe.skipIf(!hasBrowser)('TEXT-QA text overflow samples in the html engine (#294, #386)', () => {
  const tools = hasBrowser ? resolveTools() : (null as never);
  let n = 0;
  const sample = async (html: string, css = '', frames = 60, out: OutputSettings = output) => {
    const scene: RenderScene = { id: `t${++n}`, engine: 'html', durationFrames: frames, props: {}, html, css: `body{background:#000;margin:0;color:#fff;font-family:sans-serif}${css}` };
    const res = await renderHtmlScene({ scene, output: out, theme, out: join(dir, `${scene.id}.mp4`), ffmpeg: tools.ffmpeg, textCheck: true });
    return res.text!;
  };

  it('samples at least 4 times a second, and text well inside the frame breaks no rule', async () => {
    const t = await sample('<h1 style="margin:40px;font-size:32px">A short headline</h1><p style="margin:40px;font-size:18px">A line under it that wraps inside the frame as it should.</p>');
    expect(t.step).toBe(textSampleStep(30));
    expect(t.samples).toBeGreaterThanOrEqual(8); // 2 s, at least 4 a second
    expect(t.runs).toEqual([]);
  }, 120_000);

  it('a headline that runs off the frame is cut by its edge for the whole scene, and runs out of its box', async () => {
    const t = await sample('<h1 style="margin:4px;font-size:60px;white-space:nowrap">A headline that runs off</h1>');
    const frame = t.runs.find((r) => r.rule === 'text.frame');
    expect(frame).toMatchObject({ text: 'A headline that runs off', startFrame: 0, endFrame: 60 });
    expect(frame!.box.width).toBeLessThanOrEqual(360);
    expect(t.runs.some((r) => r.rule === 'text.box')).toBe(true);
  }, 120_000);

  it('text cut by a box that hides its overflow: lines cut off and lines hidden are both found', async () => {
    const t = await sample('<div style="margin:40px;width:200px;height:44px;overflow:hidden;font-size:20px;line-height:30px">One two three four five six seven eight nine ten</div>');
    expect(t.runs.map((r) => r.rule).sort()).toEqual(['text.box', 'text.clip']);
  }, 120_000);

  it('text that slides across the edge on its way in is found only while it crosses (a short run)', async () => {
    // In from the right over 0.4 s, then held well inside the frame.
    const t = await sample('<h1 id="h" style="margin:0;position:absolute;left:40px;top:200px;font-size:40px;white-space:nowrap">Slides in</h1>', '#h{animation:in .4s linear both}@keyframes in{from{transform:translateX(400px)}to{transform:none}}');
    const runs = t.runs.filter((r) => r.rule === 'text.frame');
    expect(runs).toHaveLength(1);
    for (const r of runs) expect((r.endFrame - r.startFrame) / 30).toBeLessThan(0.75);
  }, 120_000);

  it('text wholly off the frame, invisible, hidden by its mask, or marked as decoration or meant to run off breaks no rule', async () => {
    const t = await sample(
      [
        '<h1 style="position:absolute;left:500px;top:10px;margin:0">Waiting off the frame</h1>',
        '<h1 style="position:absolute;left:10px;top:100px;margin:0;opacity:0;white-space:nowrap;font-size:80px">Faded out completely</h1>',
        '<div style="position:absolute;left:10px;top:200px;opacity:.5"><p style="opacity:.05;white-space:nowrap;font-size:80px;margin:0">Parent and child both faded</p></div>',
        '<h1 style="position:absolute;left:10px;top:300px;margin:0;visibility:hidden;white-space:nowrap;font-size:80px">Hidden but laid out</h1>',
        '<div style="position:absolute;left:10px;top:400px;width:200px;height:40px;overflow:hidden"><div style="transform:translateY(60px);font-size:30px">Below its mask</div></div>',
        '<div data-rf-decoration style="position:absolute;left:-40px;top:480px;font-size:80px;white-space:nowrap">BIG DECORATIVE WORD</div>',
        '<div data-layout-allow-overflow style="position:absolute;left:200px;top:560px;font-size:40px;white-space:nowrap">Ticker that runs off</div>',
      ].join('')
    );
    expect(t.runs).toEqual([]);
  }, 120_000);

  it('built-in html templates find nothing at 16:9, 1:1, 4:5 and 9:16, with the longest props the schema allows', async () => {
    const sizes: Array<[number, number]> = [
      [640, 360],
      [480, 480],
      [480, 600],
      [360, 640],
    ];
    // The formats test's samples and stress props (apps/server/test/formats.test.ts), with text-only layout panes.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['html-title', { kicker: 'Any format', headline: 'Headlines shrink to fit their box instead of running off the edge of the frame', subline: 'Every size from one manifest' }],
      ['html-title', { headline: 'WWWW Headlines shrink to fit their box instead of running off the frame edge', subline: 'A subline of a realistic length that wraps onto a second or third line on narrow frames' }],
      ['html-title', { headline: 'Internationalisation-and-localisation-ready', subline: 'One unbreakable word wider than a tall frame at full size' }],
      [
        'html-layout',
        {
          layout: { type: 'split', ratios: [2, 1, 1], gap: 1 },
          panes: [
            { color: '#24303d', label: 'Main', headline: 'Two sources, one frame', body: 'Panes reflow per output size' },
            { color: '#1d2733', headline: 'Ratios 2:1:1', body: 'Sizes in layout units' },
            { color: '#2d3a49', label: 'Detail' },
          ],
          lowerThird: { name: 'A name at the sixty character limit for lower third names ok', title: 'And a title of eighty characters that wraps onto a second line in narrow frames.' },
        },
      ],
      ['html-layout', { layout: { type: 'grid' }, panes: [1, 2, 3, 4].map((i) => ({ color: '#24303d', label: `Pane ${i}`, headline: `Grid pane number ${i}`, body: 'A body line under the headline' })) }],
    ];
    const found: string[] = [];
    for (const [k, [template, props]] of cases.entries()) {
      for (const [width, height] of sizes) {
        const scene: RenderScene = { id: `${template}-${k}-${width}x${height}`, engine: 'html', template, durationFrames: 60, props };
        const res = await renderHtmlScene({ scene, output: { ...output, width, height }, theme, out: join(dir, `${scene.id}.mp4`), ffmpeg: tools.ffmpeg, textCheck: true });
        // Anything at all, short runs included: a built-in template keeps its text inside the frame and its boxes throughout.
        for (const r of res.text!.runs) found.push(`${scene.id}: ${r.rule} "${r.text}" frames ${r.startFrame}-${r.endFrame}`);
      }
    }
    expect(found).toEqual([]);
  }, 600_000);

  it('without textCheck nothing is sampled', async () => {
    const scene: RenderScene = { id: 'off', engine: 'html', durationFrames: 10, props: {}, html: '<h1 style="font-size:90px;white-space:nowrap">Runs off the frame</h1>' };
    const res = await renderHtmlScene({ scene, output, theme, out: join(dir, 'off.mp4'), ffmpeg: tools.ffmpeg });
    expect(res.text).toBeUndefined();
  }, 120_000);
});
