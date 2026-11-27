import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinTheme, textSampleStep, type OutputSettings, type RenderScene } from '@renderweld/project-schema';
import { type ResolvedAsset } from '@renderweld/core';
import { resolveTools } from '@renderweld/media-pipeline';
import { makeNumberedClip } from '../../media-pipeline/test/media-fixtures';
import { renderHyperframesScene } from '../src/index';

const browser = process.env.RENDERWELD_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-hf-textqa-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn(`could not remove ${dir}: ${(e as Error).message}`);
  }
});
const output: OutputSettings = { width: 360, height: 640, fps: 30, format: 'mp4' };
const theme = builtinTheme('midnight')!.tokens;

describe.skipIf(!hasBrowser)('TEXT-QA-HF text overflow in HyperFrames scenes (#294, #386)', () => {
  let n = 0;
  const render = async (scene: RenderScene, out: OutputSettings = output) => {
    const id = `${scene.id}-${++n}`;
    const res = await renderHyperframesScene({ scene, output: out, theme, out: join(dir, `${id}.mp4`), workDir: join(dir, `w-${id}`), cacheDir: join(dir, 'cache'), textCheck: true });
    expect(res.text, 'the check ran').toBeDefined();
    return res.text!;
  };
  const source = (html: string, css = '', durationFrames = 60): RenderScene => ({
    id: 'src',
    engine: 'hyperframes',
    durationFrames,
    props: {},
    html: `<div class="clip" data-start="0" data-duration="${durationFrames / 30}" style="position:absolute;inset:0;background:#000;color:#fff;font-family:sans-serif">${html}</div>`,
    css,
  });

  it('samples at 4 a second: a headline cut by the frame edge for the whole scene, a box that cuts its lines; text wholly off the frame, invisible or marked is left out', async () => {
    const t = await render(
      source(
        [
          '<h1 id="wide" style="position:absolute;left:4px;top:0;margin:0;font-size:60px;white-space:nowrap">A headline that runs off</h1>',
          '<div id="boxed" style="position:absolute;left:20px;top:200px;width:200px;height:44px;overflow:hidden;font-size:20px;line-height:30px">One two three four five six seven eight nine ten</div>',
          '<h1 style="position:absolute;left:500px;top:300px;margin:0;font-size:40px">Waiting off the frame</h1>',
          '<h1 style="position:absolute;left:4px;top:380px;margin:0;font-size:80px;white-space:nowrap;opacity:0">Faded out completely</h1>',
          '<div data-rf-decoration style="position:absolute;left:-40px;top:460px;font-size:80px;white-space:nowrap">BIG DECORATIVE WORD</div>',
          '<div data-layout-allow-overflow style="position:absolute;left:200px;top:560px;font-size:40px;white-space:nowrap">Ticker that runs off</div>',
        ].join('')
      )
    );
    expect(t.step).toBe(textSampleStep(30));
    expect(t.samples).toBe(9); // frames 0, 7, ... 56
    expect(t.runs.map((r) => [r.rule, r.text, r.startFrame, r.endFrame]).sort()).toEqual([
      ['text.clip', 'One two three four five six seven eight nine ten', 0, 60],
      ['text.frame', 'A headline that runs off', 0, 60],
    ]);
  }, 180_000);

  it('text that slides across the edge on its way in is found only while it crosses', async () => {
    const t = await render(
      source('<h1 id="h" style="margin:0;position:absolute;left:40px;top:200px;font-size:40px;white-space:nowrap">Slides in</h1>', '#h{animation:in .4s linear both}@keyframes in{from{transform:translateX(400px)}to{transform:none}}')
    );
    const runs = t.runs.filter((r) => r.rule === 'text.frame');
    expect(runs).toHaveLength(1);
    expect((runs[0]!.endFrame - runs[0]!.startFrame) / 30).toBeLessThan(0.75);
  }, 180_000);

  it('the built-in templates find nothing at 16:9, 1:1, 4:5 and 9:16, with the longest props the schema allows', async () => {
    const found: string[] = [];
    const layout = {
      layout: { type: 'grid' },
      panes: [1, 2, 3, 4].map((i) => ({ color: '#24303d', label: `Pane ${i}`, headline: `Grid pane number ${i}`, body: 'A body line under the headline' })),
      lowerThird: { name: 'A name at the sixty character limit for lower third names ok', title: 'And a title of eighty characters that wraps onto a second line in narrow frames.' },
    };
    for (const [template, props] of [
      ['hyperframes-title', { headline: 'WWWW Headlines shrink to fit their box instead of running off the frame edge', subline: 'A subline of a realistic length that wraps onto a second or third line on narrow frames' }],
      ['hyperframes-title', { headline: 'Internationalisation-and-localisation-ready', subline: 'One unbreakable word wider than a tall frame at full size' }],
      ['hyperframes-layout', layout],
    ] as const) {
      for (const [width, height] of [
        [640, 360],
        [480, 480],
        [480, 600],
        [360, 640],
      ] as const) {
        const t = await render({ id: `${template}-${width}x${height}`, engine: 'hyperframes', template, durationFrames: 60, props: props as Record<string, unknown> }, { ...output, width, height });
        for (const r of t.runs) found.push(`${template} ${width}x${height}: ${r.rule} "${r.text}" frames ${r.startFrame}-${r.endFrame}`);
      }
    }
    expect(found).toEqual([]);
  }, 900_000);

  it('text over a video is checked: the face detector HyperFrames would download is refused and the check carries on', async () => {
    const tools = resolveTools();
    const assets = new Map<string, ResolvedAsset>([['clip', { id: 'clip', file: await makeNumberedClip(tools.ffmpeg, join(dir, 'clip.mp4'), { fps: 30, frames: 30 }), mediaType: 'video' }]]);
    const log: string[] = [];
    const scene: RenderScene = { id: 'pip', engine: 'hyperframes', template: 'hyperframes-layout', durationFrames: 30, props: { layout: { type: 'pip', corner: 'top-right' }, panes: [{ media: { asset: 'clip', fit: 'blur-fill' } }, { color: '#24303d', headline: 'Inset' }], lowerThird: { name: 'Layouts', title: 'Text over a video' } } };
    const res = await renderHyperframesScene({ scene, output, theme, out: join(dir, 'pip.mp4'), workDir: join(dir, 'w-pip'), cacheDir: join(dir, 'cache'), tools, assets, textCheck: true, log: (l) => log.push(l) });
    expect(res.text, log.join('\n')).toEqual({ samples: 5, step: textSampleStep(30), runs: [] });
    expect(log.some((l) => l.includes('did not run'))).toBe(false);
  }, 300_000);
});
