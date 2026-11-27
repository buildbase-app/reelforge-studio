import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { textRunTracker, textSampleStep, type ClipTextCheck, type RenderScene } from '@renderweld/project-schema';
import { PluginRegistry, ReelforgeService, createMemoryRepositories, textCheckOn, textQa, videoQaIssues, VIDEO_QA_DEFAULTS, type EnginePlugin, type VideoQaManifest } from '../src/index';
import { fakeEngine, tempDir } from './helpers';

/**
 * Text overflow check (#294, #386): the runs DOM engines sample while rendering, placed on the video's timeline and
 * reported as `video.text` when they last render.qa.textSeconds. The engine here is a fake that returns the samples a
 * DOM engine would; the html engine's own sampling is tested in packages/engine-html/test/textqa.test.ts.
 */
const { dir, cleanup } = tempDir('renderweld-textqa-');
afterAll(cleanup);

describe('text runs', () => {
  it('TQA-01 samples at least 4 a second; consecutive samples of one element and rule make one run, a gap ends it', () => {
    expect([24, 25, 30, 50, 60, 29.97].map(textSampleStep)).toEqual([6, 6, 7, 12, 15, 7]);
    expect(textSampleStep(8)).toBe(2);
    expect(textSampleStep(2)).toBe(1);
    const t = textRunTracker({ frames: 40, step: 7 });
    const wide = { rule: 'text.frame' as const, key: 1, text: 'Too wide', box: [0, 0, 400, 50] as [number, number, number, number] };
    const boxed = { rule: 'text.box' as const, key: 2, text: 'Boxed', box: [10, 10, 100, 20] as [number, number, number, number] };
    t.add(0, []);
    t.add(7, [wide]);
    t.add(14, [wide, boxed]);
    t.add(21, [boxed]);
    t.add(28, [wide]);
    t.add(35, [wide]);
    const r = t.finish();
    expect(r.samples).toBe(6);
    expect(r.runs.map((x) => [x.rule, x.startFrame, x.endFrame])).toEqual([
      ['text.frame', 7, 21],
      ['text.box', 14, 28],
      ['text.frame', 28, 40], // the last sample plus a step, no further than the clip
    ]);
    expect(r.runs[0]!.box).toEqual({ x: 0, y: 0, width: 400, height: 50 });
  });

  it('TQA-02 runs go on the timeline; shorter than the threshold are counted, not reported; scenes without samples are listed', () => {
    const text = (runs: ClipTextCheck['runs']): ClipTextCheck => ({ samples: 10, step: 7, runs });
    const run = (startFrame: number, endFrame: number) => ({ rule: 'text.frame' as const, text: 'Headline', box: { x: 0, y: 0, width: 10, height: 10 }, startFrame, endFrame });
    const clips = [
      { sceneId: 'a', startFrame: 0, text: text([run(0, 21)]) }, // 0.7 s: an entrance
      { sceneId: 'b', startFrame: 60, text: text([run(7, 42)]) }, // 1.167 s
      { sceneId: 'c', startFrame: 120 }, // an engine that does not sample
    ];
    const q = textQa(clips, 30, 1);
    expect(q).toMatchObject({ minSeconds: 1, samplesPerSecond: 4, sampledScenes: ['a', 'b'], notSampledScenes: ['c'], shortRuns: 1 });
    expect(q.runs).toEqual([{ sceneId: 'b', rule: 'text.frame', text: 'Headline', box: { x: 0, y: 0, width: 10, height: 10 }, startSeconds: 2.233, endSeconds: 3.4, durationSeconds: 1.167 }]);
    // A preview of scene b alone starts at 0.
    expect(textQa([clips[1]!], 30, 1).runs[0]).toMatchObject({ startSeconds: 0.233, endSeconds: 1.4 });
    expect(textQa(clips, 30, 0.5).runs).toHaveLength(2);
    const [issue] = videoQaIssues({ freezes: [], blacks: [], texts: q.runs }, [], 'warning');
    expect(issue).toMatchObject({ rule: 'video.text', severity: 'warning', scenes: ['b'], startSeconds: 2.233, endSeconds: 3.4 });
    expect(issue!.message).toContain('"Headline" runs off the edge of the frame');
    expect(issue!.message).toContain('data-layout-allow-overflow');
    const clip = videoQaIssues({ freezes: [], blacks: [], texts: [{ ...q.runs[0]!, rule: 'text.clip' }] }, [], 'error')[0]!;
    expect(clip.message).toContain('cut off by a box that hides what overflows it');
    expect(videoQaIssues({ freezes: [], blacks: [], texts: [{ ...q.runs[0]!, rule: 'text.box' }] }, [], 'error')[0]!.message).toContain('does not fit its box');
  });

  it('TQA-03 the check is on by default, off with render.qa.textSeconds 0 or render.qa.video off', () => {
    expect(VIDEO_QA_DEFAULTS.textSeconds).toBe(1);
    expect(textCheckOn(undefined)).toBe(true);
    expect(textCheckOn({ ...VIDEO_QA_DEFAULTS, textSeconds: 0 })).toBe(false);
    expect(textCheckOn({ ...VIDEO_QA_DEFAULTS, video: 'off' })).toBe(false);
  });
});

describe('renders', () => {
  let svc: ReelforgeService;
  const asked: Array<[string, boolean]> = [];
  /** A fake DOM engine: when asked, scene "wide" reports text running off the frame from frame 7 to its end. */
  const sampling = (e: EnginePlugin): EnginePlugin => ({
    ...e,
    render: async (scene: RenderScene, ctx) => {
      asked.push([scene.id, ctx.textCheck === true]);
      const res = await e.render(scene, ctx);
      if (!ctx.textCheck) return res;
      const runs = scene.id === 'wide' ? [{ rule: 'text.frame' as const, text: 'A headline that runs off', box: { x: 4, y: 4, width: 316, height: 70 }, startFrame: 7, endFrame: scene.durationFrames }] : [];
      return { ...res, text: { samples: Math.ceil(scene.durationFrames / 7), step: 7, runs } };
    },
  });
  const scene = (id: string, engine: string, durationFrames: number) =>
    engine === 'remotion' ? { id, engine, template: 'kinetic-title', durationFrames, props: { headline: id } } : { id, engine, template: 'animated-explainer', durationFrames, props: { title: id, points: ['one'] } };
  async function render(projectId: string, opts: { preview?: string } = {}) {
    const job = opts.preview ? await svc.preview(projectId, { sceneId: opts.preview }) : await svc.startRender(projectId);
    const done = await svc.jobs.waitFor(job.id, 120_000);
    return { done, manifest: done.status === 'succeeded' ? ((await svc.getRenderManifest(done.result!.renderId as string)) as { checks: Record<string, string>; scenes: Array<Record<string, unknown>>; videoQa?: VideoQaManifest }) : undefined };
  }

  beforeAll(async () => {
    const registry = new PluginRegistry().registerEngine(sampling(fakeEngine('remotion', { frameRanges: true }))).registerEngine(fakeEngine('motion-canvas'));
    svc = await ReelforgeService.create(registry, { repositories: createMemoryRepositories(), dataDir: join(dir, 'data'), configSources: { env: { REELFORGE_LICENCE_MODE: 'off', REELFORGE_RENDER_QA_SEEK_FRAMES: '0' } } });
    const project = (projectId: string, scenes: unknown[]) => ({ schemaVersion: '0.1', projectId, title: projectId, output: { width: 320, height: 568, fps: 30, format: 'mp4' }, audio: { musicTrack: null, voiceTrack: null }, assets: [], scenes });
    await svc.createProject(project('clean', [scene('hook', 'remotion', 45), scene('body', 'remotion', 45)]));
    await svc.createProject(project('overflow', [scene('hook', 'remotion', 45), scene('mc', 'motion-canvas', 60), scene('wide', 'remotion', 60)]));
    for (const id of ['clean', 'overflow']) await svc.setTheme(id, { base: 'default', tokens: { colors: { background: '#f2f0ea' } } });
  }, 60_000);
  afterAll(async () => {
    await svc.jobs.shutdown(0);
    await svc.stop();
  });

  it('TQA-04 text that stays in the frame passes; the samples stay out of the scene list', async () => {
    asked.length = 0;
    const { done, manifest } = await render('clean');
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(asked).toEqual([
      ['hook', true],
      ['body', true],
    ]);
    expect(manifest!.checks.text).toBe('pass');
    expect(manifest!.videoQa!.text).toEqual({ minSeconds: 1, samplesPerSecond: 4, sampledScenes: ['hook', 'body'], notSampledScenes: [], runs: [], shortRuns: 0 });
    expect(manifest!.scenes.every((s) => !('text' in s))).toBe(true);
  }, 120_000);

  it('TQA-05 text that runs off the frame is reported with its scene, times, text and box; engines that cannot sample are listed', async () => {
    const { done, manifest } = await render('overflow');
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(manifest!.checks.text).toBe('warn');
    expect(manifest!.videoQa!.text).toMatchObject({ sampledScenes: ['hook', 'wide'], notSampledScenes: ['mc'] });
    // Scene "wide" starts at frame 105: from 112/30 to 165/30 s.
    expect(manifest!.videoQa!.text!.runs).toEqual([{ sceneId: 'wide', rule: 'text.frame', text: 'A headline that runs off', box: { x: 4, y: 4, width: 316, height: 70 }, startSeconds: 3.733, endSeconds: 5.5, durationSeconds: 1.767 }]);
    const issue = manifest!.videoQa!.issues.find((i) => i.rule === 'video.text');
    expect(issue).toMatchObject({ severity: 'warning', scenes: ['wide'], startSeconds: 3.733, endSeconds: 5.5 });
    expect((await svc.getRender(done.result!.renderId as string)).videoQa?.issues.some((i) => i.rule === 'video.text')).toBe(true);
    // A preview of the scene alone: its own timeline.
    const preview = await render('overflow', { preview: 'wide' });
    expect(preview.manifest!.videoQa!.text!.runs[0]).toMatchObject({ startSeconds: 0.233, endSeconds: 2 });
  }, 120_000);

  it('TQA-06 render.qa.video fail fails the render on it; textSeconds 0 or video off do not ask the engines to sample', async () => {
    await svc.updateConfig({ 'render.qa.video': 'fail', 'render.qa.freezeSeconds': 3600, 'render.qa.lowMotionSeconds': 0 });
    const failed = await render('overflow');
    expect(failed.done.status).toBe('failed');
    expect(JSON.stringify(failed.done.error)).toContain('the text \\"A headline that runs off\\" runs off the edge of the frame');
    await svc.updateConfig({ 'render.qa.video': null, 'render.qa.freezeSeconds': null, 'render.qa.lowMotionSeconds': null, 'render.qa.textSeconds': 2 });
    expect((await render('overflow')).manifest!.videoQa!.text).toMatchObject({ minSeconds: 2, runs: [], shortRuns: 1 });
    for (const off of [{ 'render.qa.textSeconds': 0 }, { 'render.qa.textSeconds': null, 'render.qa.video': 'off' }]) {
      await svc.updateConfig(off);
      asked.length = 0;
      const { done, manifest } = await render('clean');
      expect(done.status).toBe('succeeded');
      expect(asked.every(([, on]) => !on)).toBe(true);
      expect(manifest!.checks.text).toBe('skipped');
      expect(manifest!.videoQa?.text).toBeUndefined();
    }
    await svc.updateConfig({ 'render.qa.video': null });
  }, 180_000);
});
