/**
 * Beat-length scenes (#450): scenes down to MIN_SCENE_FRAMES (3) frames. Every
 * engine (html and HyperFrames source, the four layout templates) renders a
 * clip of exactly the scene's frames; normalisation and the fan-out join
 * (normaliseClip + concatClips, stream copy) keep every frame in place with a
 * key frame at each cut; and a four-engine project of 6-frame scenes with
 * music and burned captions validates (with a short-scene warning) and
 * renders end to end with the exact frame count.
 * Needs REELFORGE_CHROMIUM_PATH (skips without; fails under REELFORGE_REQUIRE_BROWSER=1).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { envValue, ReelforgeService, createMemoryRepositories, type EnginePlugin } from '@reelforge/core';
import { assertDecodable, checkExpectation, checkTimestamps, concatClips, frameStats, keyFrames, normaliseClip, probe, resolveTools } from '@reelforge/media-pipeline';
import { MIN_SCENE_FRAMES, builtinTheme, parseProject, type OutputSettings, type RenderScene } from '@reelforge/project-schema';
import { makeTone } from '../../../packages/core/test/helpers';
import { createDefaultRegistry } from '../src/registry';

const browser = envValue('REELFORGE_CHROMIUM_PATH');
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-short-scenes-'));
const cacheDir = resolve(import.meta.dirname, '../../../.render-cache');
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

describe('browser requirement', () => {
  it.runIf(envValue('REELFORGE_REQUIRE_BROWSER') === '1')('REELFORGE_REQUIRE_BROWSER=1: a browser must be configured', () => {
    expect(hasBrowser).toBe(true);
  });
});

const theme = builtinTheme('midnight')!.tokens;
/** A full-frame layout pane of one flat colour, so each cut is visible in the luma. */
const layout = (color: string, headline: string) => ({ layout: { type: 'full' }, panes: [{ color, headline }] });
/** Flat source scene markup of one colour (html and HyperFrames). */
const source = (engine: 'html' | 'hyperframes', color: string) =>
  engine === 'html'
    ? `<div style="position:absolute;inset:0;background:${color}"></div>`
    : `<div class="clip" data-start="0" data-duration="10" style="position:absolute;inset:0;background:${color}"></div>`;

type Sample = Omit<RenderScene, 'id' | 'durationFrames' | 'assets'> & { name: string; luma: 'dark' | 'light' };
/** Alternating dark and light scenes, so a frame that moved across a cut changes the luma. */
const SAMPLES: Sample[] = [
  { name: 'html source', engine: 'html', props: {}, html: source('html', '#101010'), luma: 'dark' },
  { name: 'hyperframes source', engine: 'hyperframes', props: {}, html: source('hyperframes', '#f0f0f0'), luma: 'light' },
  { name: 'html-layout', engine: 'html', template: 'html-layout', props: layout('#101010', 'Cut'), luma: 'dark' },
  { name: 'hyperframes-layout', engine: 'hyperframes', template: 'hyperframes-layout', props: layout('#f0f0f0', 'Cut'), luma: 'light' },
  { name: 'remotion-layout', engine: 'remotion', template: 'remotion-layout', props: layout('#101010', 'Cut'), luma: 'dark' },
  { name: 'motion-canvas-layout', engine: 'motion-canvas', template: 'motion-canvas-layout', props: layout('#f0f0f0', 'Cut'), luma: 'light' },
];
const FRAMES = [MIN_SCENE_FRAMES, 6];

describe.skipIf(!hasBrowser)('every engine renders beat-length scenes with exact frame counts (#450)', () => {
  const registry = hasBrowser ? createDefaultRegistry({}) : null;
  const tools = resolveTools();
  const output: OutputSettings = { width: 180, height: 320, fps: 30, format: 'mp4' };
  const normalised: Array<{ file: string; frames: number; luma: 'dark' | 'light' }> = [];

  for (const frames of FRAMES) {
    for (const s of SAMPLES) {
      it(`${s.name}: ${frames} frames`, async () => {
        const engine: EnginePlugin = registry!.engine(s.engine);
        const { name, luma, ...rest } = s;
        const scene: RenderScene = { ...rest, id: `${name.replace(/ /g, '-')}-${frames}`, durationFrames: frames, assets: [] };
        const out = join(dir, `${scene.id}.mp4`);
        const workDir = join(dir, 'work', scene.id);
        mkdirSync(workDir, { recursive: true });
        await engine.render(scene, { output, theme, out, workDir, cacheDir, tools, assets: new Map(), signal: new AbortController().signal, progress: () => undefined, log: () => undefined });
        expect((await probe(tools.ffprobe, out)).frames, `${name}: engine clip`).toBe(frames);
        const norm = join(dir, `${scene.id}-norm.mp4`);
        await normaliseClip({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, input: out, out: norm, width: 180, height: 320, fps: 30, frames });
        expect(checkExpectation(await probe(tools.ffprobe, norm), { width: 180, height: 320, fps: 30, frames, audio: false, exactRate: true }), name).toEqual([]);
        expect(await checkTimestamps(tools.ffprobe, norm, frames, 30), name).toEqual([]);
        normalised.push({ file: norm, frames, luma });
        rmSync(out, { force: true });
      }, 300_000);
    }
  }

  it('the fan-out join (stream copy) of every short clip keeps each frame in its scene, with a key frame at every cut', async () => {
    expect(normalised).toHaveLength(FRAMES.length * SAMPLES.length);
    const total = normalised.reduce((n, c) => n + c.frames, 0);
    const out = join(dir, 'joined.mp4');
    await concatClips({ ffmpeg: tools.ffmpeg, clips: normalised, out, fps: 30, listFile: join(dir, 'joined.txt'), noAudio: true });
    expect(checkExpectation(await probe(tools.ffprobe, out), { width: 180, height: 320, fps: 30, frames: total, audio: false, exactRate: true })).toEqual([]);
    expect(await checkTimestamps(tools.ffprobe, out, total, 30)).toEqual([]);
    await assertDecodable(tools.ffmpeg, out);
    const starts = normalised.map((_, i) => normalised.slice(0, i).reduce((n, c) => n + c.frames, 0));
    expect(await keyFrames(tools.ffprobe, out)).toEqual(expect.arrayContaining(starts));
    // The first and last frame of every scene show that scene (dark or light), so no frame moved across a cut.
    for (const [i, c] of normalised.entries()) {
      for (const f of [starts[i]!, starts[i]! + c.frames - 1]) {
        const y = (await frameStats(tools.ffmpeg, out, f)).yAvg;
        expect(c.luma === 'dark' ? y < 60 : y > 180, `frame ${f} (clip ${i}, ${c.luma}): yAvg ${y}`).toBe(true);
      }
    }
  }, 300_000);
});

describe.skipIf(!hasBrowser)('a four-engine project of 6-frame scenes validates and renders end to end (#450)', () => {
  it('html and HyperFrames source plus Remotion and Motion Canvas layouts, music and burned captions: exact frame count', async () => {
    const svc = await ReelforgeService.create(createDefaultRegistry({}), {
      repositories: createMemoryRepositories(),
      dataDir: join(dir, 'data'),
      cacheDir,
      configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } },
    });
    try {
      const scenes = [
        { id: 'a', engine: 'html', html: source('html', '#101010'), durationFrames: 6 },
        { id: 'b', engine: 'hyperframes', html: source('hyperframes', '#f0f0f0'), durationFrames: 6 },
        { id: 'c', engine: 'remotion', template: 'remotion-layout', props: layout('#101010', 'Three'), durationFrames: 6 },
        { id: 'd', engine: 'motion-canvas', template: 'motion-canvas-layout', props: layout('#f0f0f0', 'Four'), durationFrames: 6 },
        { id: 'e', engine: 'html', template: 'html-layout', props: layout('#101010', 'Five'), durationFrames: MIN_SCENE_FRAMES },
        { id: 'f', engine: 'hyperframes', template: 'hyperframes-layout', props: layout('#f0f0f0', 'Six'), durationFrames: MIN_SCENE_FRAMES },
      ].map((s) => ({ props: {}, captions: { text: `Beat ${s.id}` }, ...s }));
      const manifest = {
        schemaVersion: '0.2',
        projectId: 'beats',
        title: 'Beat cuts',
        output: { width: 180, height: 320, fps: 30, format: 'mp4' },
        captions: { mode: 'burned' },
        scenes,
      };
      const created = await svc.createProject(manifest);
      await makeTone(join(dir, 'music.mp3'), 2);
      await svc.uploadAsset(readFileSync(join(dir, 'music.mp3')), { filename: 'music.mp3', projectId: 'beats', assetId: 'music', license: { name: 'CC0-1.0', redistributable: true } });
      await svc.setAudio('beats', { music: { asset: 'music', volume: 0.5 } });
      expect(created.warnings.filter((w) => w.message.includes('under 0.25s')).map((w) => w.path)).toEqual(['scenes.0.durationFrames', 'scenes.1.durationFrames', 'scenes.2.durationFrames', 'scenes.3.durationFrames', 'scenes.4.durationFrames', 'scenes.5.durationFrames']);
      const frames = scenes.reduce((n, s) => n + s.durationFrames, 0);
      const job = await svc.startRender('beats');
      const done = await svc.waitForJob(job.id, 600);
      expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
      expect(done.result).toMatchObject({ frames });
      const file = (await svc.renderFile((job.params as { runId: string }).runId)).path;
      const t = resolveTools();
      expect(checkExpectation(await probe(t.ffprobe, file), { width: 180, height: 320, fps: 30, frames, audio: true, exactRate: true })).toEqual([]);
      expect(await checkTimestamps(t.ffprobe, file, frames, 30)).toEqual([]);
      await assertDecodable(t.ffmpeg, file);
    } finally {
      await svc.jobs.shutdown(0);
      await svc.stop();
    }
  }, 900_000);

  it('a scene of fewer than MIN_SCENE_FRAMES frames, or seconds that round to fewer, is refused', () => {
    const base = { schemaVersion: '0.2', projectId: 'p', title: 't', output: { width: 180, height: 320, fps: 30, format: 'mp4' } };
    const one = parseProject({ ...base, scenes: [{ id: 'a', engine: 'html', html: '<p>x</p>', durationFrames: MIN_SCENE_FRAMES - 1 }] });
    expect(one.ok).toBe(false);
    expect(!one.ok && one.issues).toEqual([{ path: 'scenes.0.durationFrames', message: `a scene needs at least ${MIN_SCENE_FRAMES} frames; this scene is ${MIN_SCENE_FRAMES - 1} frames` }]);
    const tiny = parseProject({ ...base, scenes: [{ id: 'a', engine: 'html', template: 'html-layout', props: layout('#101010', 'x'), durationSeconds: 0.01 }] });
    expect(!tiny.ok && tiny.issues.map((i) => i.path)).toEqual(['scenes.0.durationSeconds']);
  });
});
