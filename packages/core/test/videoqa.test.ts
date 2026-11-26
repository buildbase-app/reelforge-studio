import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectVideoIssues, parseVideoQa, resolveTools, run } from '@renderweld/media-pipeline';
import { PluginRegistry, ReelforgeService, createMemoryRepositories, sceneTimes, videoQaIssues, type VideoQaManifest } from '../src/index';
import { fakeEngine, tempDir } from './helpers';

/**
 * Picture checks after the encode (#294, render.qa.*). The fake "remotion" engine paints a picture that changes
 * every frame; the fake "motion-canvas" engine paints one solid colour (the theme background) for the whole scene.
 */
const { dir, cleanup } = tempDir('renderweld-videoqa-');
afterAll(cleanup);
const tools = resolveTools();
let svc: ReelforgeService;

const scene = (id: string, engine: 'remotion' | 'motion-canvas', frames: number) =>
  engine === 'remotion'
    ? { id, engine, template: 'kinetic-title', durationFrames: frames, props: { headline: id } }
    : { id, engine, template: 'animated-explainer', durationFrames: frames, props: { title: id, points: ['one'] } };
const project = (projectId: string, scenes: unknown[]) => ({
  schemaVersion: '0.1',
  projectId,
  title: projectId,
  output: { width: 320, height: 568, fps: 30, format: 'mp4' },
  audio: { musicTrack: null, voiceTrack: null },
  assets: [],
  scenes,
});
/** A project with a light background (a dark one would count as black), or the one given. */
async function create(projectId: string, scenes: unknown[], background = '#f2f0ea') {
  await svc.createProject(project(projectId, scenes));
  await svc.setTheme(projectId, { base: 'default', tokens: { colors: { background } } });
}

async function render(projectId: string, opts: { preview?: string } = {}) {
  const job = opts.preview ? await svc.preview(projectId, { sceneId: opts.preview }) : await svc.startRender(projectId);
  const done = await svc.jobs.waitFor(job.id, 120_000);
  return { done, manifest: done.status === 'succeeded' ? ((await svc.getRenderManifest(done.result!.renderId as string)) as { checks: Record<string, string>; videoQa?: VideoQaManifest }) : undefined };
}

beforeAll(async () => {
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion', { frameRanges: true })).registerEngine(fakeEngine('motion-canvas'));
  svc = await ReelforgeService.create(registry, { repositories: createMemoryRepositories(), dataDir: join(dir, 'data'), configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } } });
  await create('moving', [scene('hook', 'remotion', 60), scene('body', 'remotion', 90)]);
  await create('stuck', [scene('hook', 'remotion', 60), scene('still', 'motion-canvas', 150), scene('outro', 'remotion', 45)]);
  await create('dark', [scene('opening', 'motion-canvas', 60), scene('rest', 'remotion', 60)], '#000000');
}, 60_000);

describe('detectVideoIssues', () => {
  it('VQA-01 finds a black opening and a frozen stretch in one pass, and a freeze that runs to the end', async () => {
    const file = join(dir, 'qa.mp4');
    // 0-1 s black, 1-3 s moving, 3-7 s one grey picture, 7-8 s moving.
    await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=1', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30:d=4', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=1', '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p', '-c:v', 'libx264', file], 'fixture');
    const r = await detectVideoIssues({ ffmpeg: tools.ffmpeg, input: file, durationSeconds: 8, freezeSeconds: 3, blackSeconds: 0.5 });
    expect(r.blacks).toEqual([{ startSeconds: 0, endSeconds: 1, durationSeconds: 1 }]);
    expect(r.freezes).toEqual([{ startSeconds: 3, endSeconds: 7, durationSeconds: 4 }]);
    expect(await detectVideoIssues({ ffmpeg: tools.ffmpeg, input: file, durationSeconds: 8, freezeSeconds: 5, blackSeconds: 2 })).toMatchObject({ freezes: [], blacks: [] });
    expect(parseVideoQa('lavfi.freezedetect.freeze_start: 1.5\nlavfi.freezedetect.freeze_duration: 3', 6).freezes).toEqual([{ startSeconds: 1.5, endSeconds: 6, durationSeconds: 4.5 }]);
  });

  it('VQA-02 names the scenes a stretch overlaps; a preview of one scene starts at 0', () => {
    const clips = [
      { sceneId: 'a', startFrame: 0, frames: 60 },
      { sceneId: 'b', startFrame: 60, frames: 30 },
      { sceneId: 'b', startFrame: 90, frames: 30 },
      { sceneId: 'c', startFrame: 120, frames: 60 },
    ];
    const times = sceneTimes(clips, 30);
    expect(times).toEqual([{ sceneId: 'a', start: 0, end: 2 }, { sceneId: 'b', start: 2, end: 4 }, { sceneId: 'c', start: 4, end: 6 }]);
    const [freeze] = videoQaIssues({ freezes: [{ startSeconds: 1.98, endSeconds: 6, durationSeconds: 4.02 }], blacks: [] }, times, 'warning');
    expect(freeze!.scenes).toEqual(['b', 'c']);
    expect(sceneTimes([{ sceneId: 'c', startFrame: 120, frames: 60 }], 30)).toEqual([{ sceneId: 'c', start: 0, end: 2 }]);
    // Flashes (WCAG 2.3.1) become an issue with the rate, the scenes and what to change.
    const [flash] = videoQaIssues({ freezes: [], blacks: [], flashes: [{ startSeconds: 4.2, endSeconds: 5.5, transitionsPerSecond: 10, kind: 'general' }] }, times, 'error');
    expect(flash).toMatchObject({ rule: 'video.flash', severity: 'error', scenes: ['c'], startSeconds: 4.2, durationSeconds: 1.3 });
    expect(flash!.message).toContain('flashes at up to 5 a second over a quarter of the picture or more, from 4.20 s to 5.50 s (scene "c"): more than three a second can trigger seizures');
  });
});

describe('renders', () => {
  it('VQA-03 a picture that keeps moving passes both checks', async () => {
    const { done, manifest } = await render('moving');
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(manifest!.checks).toMatchObject({ freeze: 'pass', black: 'pass', flash: 'pass' });
    expect(manifest!.videoQa).toMatchObject({ mode: 'warn', thresholds: { freezeSeconds: 3, blackSeconds: 0.5 }, freezes: [], blacks: [], flashes: [], issues: [] });
  }, 120_000);

  it('VQA-04 a 5 s still scene is reported as frozen, with its scene and times, in the manifest and the render summary', async () => {
    const { done, manifest } = await render('stuck');
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(manifest!.checks).toMatchObject({ freeze: 'warn', black: 'pass' });
    const [issue] = manifest!.videoQa!.issues;
    expect(issue).toMatchObject({ rule: 'video.freeze', severity: 'warning', scenes: ['still'] });
    expect(issue!.startSeconds).toBeCloseTo(2, 1);
    expect(issue!.durationSeconds).toBeGreaterThan(4.8);
    expect(issue!.message).toContain('(scene "still"): a still that long reads as a frozen video');
    expect((await svc.getRender(done.result!.renderId as string)).videoQa?.issues).toHaveLength(1);
  }, 120_000);

  it('VQA-05 a black opening is reported with the thumbnail warning; a preview of one scene is checked on its own', async () => {
    const { manifest } = await render('dark');
    const black = manifest!.videoQa!.issues.find((i) => i.rule === 'video.black')!;
    // The black stretch is the opening scene; it may run a few frames into the next (the moving picture starts dark).
    expect(black.startSeconds).toBe(0);
    expect(black.scenes[0]).toBe('opening');
    expect(black.durationSeconds).toBeGreaterThanOrEqual(2);
    expect(black.message).toContain('the first frame is black, so platforms show a black thumbnail');
    expect(manifest!.checks.black).toBe('warn');
    const preview = await render('stuck', { preview: 'outro' });
    expect(preview.done.status).toBe('succeeded');
    expect(preview.manifest!.checks).toMatchObject({ freeze: 'pass', black: 'pass' });
  }, 120_000);

  it('VQA-06 render.qa.video: fail fails the render with the reason; off skips the pass; thresholds are live', async () => {
    await svc.updateConfig({ 'render.qa.video': 'fail' });
    const failed = await render('stuck');
    expect(failed.done.status).toBe('failed');
    expect(JSON.stringify(failed.done.error)).toContain('a still that long reads as a frozen video');
    await svc.updateConfig({ 'render.qa.video': 'warn', 'render.qa.freezeSeconds': 10 });
    expect((await render('stuck')).manifest!.checks.freeze).toBe('pass');
    await svc.updateConfig({ 'render.qa.video': 'off', 'render.qa.freezeSeconds': null });
    const off = await render('stuck');
    expect(off.manifest!.checks).toMatchObject({ freeze: 'skipped', black: 'skipped', flash: 'skipped' });
    expect(off.manifest!.videoQa).toBeUndefined();
    await svc.updateConfig({ 'render.qa.video': null });
  }, 240_000);
});
