/**
 * Frame rates (#302): every engine renders each of the frame rates added to
 * 24/25/30/60 (23.976, 29.97, 48, 50, 59.94) with exactly the scene's frames,
 * normalisation gives the exact rational rate (ffprobe r_frame_rate
 * 30000/1001, not a rounded decimal), and a four-engine project at 29.97
 * renders end to end with the exact rate, frame count and duration.
 * Needs REELFORGE_CHROMIUM_PATH (skips without; fails under REELFORGE_REQUIRE_BROWSER=1).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { envValue, ReelforgeService, createMemoryRepositories, type EnginePlugin } from '@renderweld/core';
import { assertDecodable, checkExpectation, checkTimestamps, normaliseClip, probe, resolveTools } from '@renderweld/media-pipeline';
import { builtinTheme, fpsLabel, fpsValue, sceneFrames, type FrameRate, type OutputSettings, type RenderScene } from '@renderweld/project-schema';
import { createDefaultRegistry } from '../src/registry';

const browser = envValue('REELFORGE_CHROMIUM_PATH');
const hasBrowser = Boolean(browser && existsSync(browser));
const dir = mkdtempSync(join(tmpdir(), 'reelforge-fps-test-'));
const cacheDir = resolve(import.meta.dirname, '../../../.render-cache');
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

describe('browser requirement', () => {
  it.runIf(envValue('REELFORGE_REQUIRE_BROWSER') === '1')('REELFORGE_REQUIRE_BROWSER=1: a browser must be configured', () => {
    expect(hasBrowser).toBe(true);
  });
});

const NEW_RATES: FrameRate[] = ['24000/1001', '30000/1001', 48, 50, '60000/1001'];
const SAMPLES: Array<{ engine: string; template: string; seconds: number; props: Record<string, unknown> }> = [
  { engine: 'remotion', template: 'kinetic-title', seconds: 1.5, props: { headline: 'Any frame rate' } },
  { engine: 'motion-canvas', template: 'animated-explainer', seconds: 2, props: { title: 'Rates', points: ['23.976', '29.97', '59.94'] } },
  { engine: 'html', template: 'html-title', seconds: 1.5, props: { headline: 'Exact rates' } },
  { engine: 'hyperframes', template: 'hyperframes-title', seconds: 1.5, props: { headline: 'Exact rates' } },
];
const theme = builtinTheme('midnight')!.tokens;

describe.skipIf(!hasBrowser)('every engine renders the new frame rates with exact frame counts (#302)', () => {
  const registry = hasBrowser ? createDefaultRegistry({}) : null;
  for (const s of SAMPLES) {
    it(`${s.engine}: ${NEW_RATES.map((r) => fpsLabel(r)).join(', ')} fps`, async () => {
      const engine: EnginePlugin = registry!.engine(s.engine);
      const tools = resolveTools();
      for (const fps of NEW_RATES) {
        const output: OutputSettings = { width: 180, height: 320, fps, format: 'mp4' };
        const frames = sceneFrames({ durationSeconds: s.seconds }, fps);
        const scene: RenderScene = { id: `${s.engine}-${fpsLabel(fps)}`, engine: s.engine, template: s.template, durationFrames: frames, props: s.props, assets: [] };
        const out = join(dir, `${scene.id}.mp4`);
        const workDir = join(dir, 'work', scene.id);
        mkdirSync(workDir, { recursive: true });
        await engine.render(scene, { output, theme, out, workDir, cacheDir, tools, assets: new Map(), signal: new AbortController().signal, progress: () => undefined, log: () => undefined });
        const clip = await probe(tools.ffprobe, out);
        const where = `${s.engine} at ${fpsLabel(fps)}`;
        // The engine's clip: exactly the scene's frames, at the rate (engines may label it with a rounded fraction).
        expect(clip.frames, where).toBe(frames);
        expect(Math.abs(clip.fps - fpsValue(fps)), `${where}: clip fps ${clip.fps} (${clip.frameRate})`).toBeLessThan(0.01);
        // Normalised as the pipeline does: the exact rational rate and the same frames.
        const norm = join(dir, `${scene.id}-norm.mp4`);
        await normaliseClip({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, input: out, out: norm, width: 180, height: 320, fps, frames });
        const n = await probe(tools.ffprobe, norm);
        expect(checkExpectation(n, { width: 180, height: 320, fps, frames, audio: false, exactRate: true }), where).toEqual([]);
        expect(await checkTimestamps(tools.ffprobe, norm, frames, fps), where).toEqual([]);
        rmSync(out, { force: true });
        rmSync(norm, { force: true });
      }
    }, 600_000);
  }
});

describe.skipIf(!hasBrowser)('a four-engine project at 29.97 fps renders end to end with the exact rate (#302)', () => {
  it('ffprobe r_frame_rate is 30000/1001, the frame count is the timeline, the duration is frames x 1001 / 30000', async () => {
    const svc = await ReelforgeService.create(createDefaultRegistry({}), {
      repositories: createMemoryRepositories(),
      dataDir: join(dir, 'data'),
      cacheDir,
      configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } },
    });
    try {
      const manifest = {
        schemaVersion: '0.2',
        projectId: 'ntsc',
        title: 'NTSC',
        output: { width: 360, height: 640, fps: { num: 30000, den: 1001 }, format: 'mp4' },
        captions: { mode: 'sidecar' },
        scenes: SAMPLES.map((s, i) => ({ id: `s${i}`, engine: s.engine, template: s.template, durationSeconds: s.seconds, props: s.props, captions: { text: `Scene ${i + 1}` } })),
      };
      const created = await svc.createProject(manifest);
      expect(created.manifest.output.fps).toBe('30000/1001');
      const frames = SAMPLES.reduce((n, s) => n + sceneFrames({ durationSeconds: s.seconds }, '30000/1001'), 0);
      const job = await svc.startRender('ntsc');
      const done = await svc.waitForJob(job.id, 600);
      expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
      expect(done.result).toMatchObject({ frames, frameRate: '30000/1001' });
      const file = (await svc.renderFile((job.params as { runId: string }).runId)).path;
      const t = resolveTools();
      const info = await probe(t.ffprobe, file);
      expect(checkExpectation(info, { width: 360, height: 640, fps: '30000/1001', frames, audio: true, exactRate: true })).toEqual([]);
      expect(Math.abs(info.durationSeconds - (frames * 1001) / 30000)).toBeLessThan(0.002);
      expect(await checkTimestamps(t.ffprobe, file, frames, '30000/1001')).toEqual([]);
      await assertDecodable(t.ffmpeg, file);
    } finally {
      await svc.jobs.shutdown(0);
      await svc.stop();
    }
  }, 900_000);
});
