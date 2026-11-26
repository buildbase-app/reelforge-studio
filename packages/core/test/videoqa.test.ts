import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectVideoIssues, parseVideoQa, resolveTools, run } from '@renderweld/media-pipeline';
import { PluginRegistry, ReelforgeService, createMemoryRepositories, lowMotionOutsideFreezes, sceneTimes, seekSamples, videoQaIssues, type VideoQaManifest } from '../src/index';
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
const project = (projectId: string, scenes: unknown[], loop?: boolean) => ({
  schemaVersion: '0.1',
  projectId,
  title: projectId,
  output: { width: 320, height: 568, fps: 30, format: 'mp4', ...(loop === undefined ? {} : { loop }) },
  audio: { musicTrack: null, voiceTrack: null },
  assets: [],
  scenes,
});
/** A project with a light background (a dark one would count as black), or the one given. */
async function create(projectId: string, scenes: unknown[], background = '#f2f0ea', loop?: boolean) {
  await svc.createProject(project(projectId, scenes, loop));
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
  // The fake remotion picture steps 5 luma levels a frame and wraps every 40 frames: the last frame is far from the first.
  await create('loop-jump', [scene('hook', 'remotion', 45), scene('outro', 'remotion', 45)], undefined, true);
  // One colour from start to end: the loop joins (it is also a still, which the other checks report).
  await create('loop-joined', [scene('card', 'motion-canvas', 60)], undefined, true);
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

  it('VQA-07 a stretch that barely moves is reported outside the frozen part only; a loop that jumps names the last and first scenes', () => {
    const times = [{ sceneId: 'a', start: 0, end: 2 }, { sceneId: 'b', start: 2, end: 8 }, { sceneId: 'c', start: 8, end: 10 }];
    const low = { startSeconds: 1, endSeconds: 9, durationSeconds: 8, peakMotion: 0.31 };
    // A freeze in the middle leaves 1-3 s and 6-9 s; with 3 s as the minimum only the second is still worth reporting.
    expect(lowMotionOutsideFreezes([low], [{ startSeconds: 3, endSeconds: 6, durationSeconds: 3 }], 3)).toEqual([{ startSeconds: 6, endSeconds: 9, durationSeconds: 3, peakMotion: 0.31 }]);
    expect(lowMotionOutsideFreezes([low], [{ startSeconds: 0, endSeconds: 10, durationSeconds: 10 }], 1)).toEqual([]);
    expect(lowMotionOutsideFreezes([low], [], 3)).toEqual([low]);
    const issues = videoQaIssues({ freezes: [], blacks: [], lows: [low], loop: { seamMotion: 40, typicalMotion: 5, jump: true } }, times, 'warning');
    expect(issues.map((i) => i.rule)).toEqual(['video.motion', 'video.loop']);
    expect(issues[0]).toMatchObject({ scenes: ['a', 'b', 'c'], startSeconds: 1, durationSeconds: 8 });
    expect(issues[0]!.message).toContain('the picture barely moves for 8.00 s, from 1.00 s to 9.00 s');
    expect(issues[0]!.message).toContain('raise render.qa.lowMotionSeconds if the hold is deliberate');
    expect(issues[1]).toMatchObject({ scenes: ['c', 'a'], startSeconds: 10, durationSeconds: 0 });
    expect(issues[1]!.message).toContain('the loop does not join: going from the last frame back to the first changes the picture by 40 luma levels, against 5');
    expect(videoQaIssues({ freezes: [], blacks: [], loop: { seamMotion: 0.2, typicalMotion: 5, jump: false } }, times, 'warning')).toEqual([]);
  });

  it('VQA-09 the seek check picks frames spread over the clips that can start mid-scene, never a first frame; a different picture is an issue', () => {
    const clips = [
      { sceneId: 'a', engine: 'remotion', startFrame: 0, frames: 61 },
      { sceneId: 'b', engine: 'motion-canvas', startFrame: 61, frames: 90 },
      // Two chunks of one split scene: each starts cold in the render already.
      { sceneId: 'c', engine: 'remotion', startFrame: 151, frames: 41, frameRange: [0, 40] as const },
      { sceneId: 'c', engine: 'remotion', startFrame: 192, frames: 41, frameRange: [41, 81] as const },
    ];
    const canSeek = (engine: string) => engine === 'remotion';
    // 60 + 40 + 40 = 140 candidate frames; two spread at 35 (in "a") and 105 (the sixth after the second chunk's first).
    expect(seekSamples(clips, canSeek, 2)).toEqual([
      { sceneId: 'a', sceneFrame: 36, timelineFrame: 36 },
      { sceneId: 'c', sceneFrame: 47, timelineFrame: 198 },
    ]);
    expect(seekSamples(clips, canSeek, 0)).toEqual([]);
    expect(seekSamples(clips, () => false, 5)).toEqual([]);
    const all = seekSamples([{ sceneId: 'x', engine: 'remotion', startFrame: 10, frames: 4 }], canSeek, 20);
    expect(all.map((s) => s.sceneFrame)).toEqual([1, 2, 3]);
    expect(all.map((s) => s.timelineFrame)).toEqual([11, 12, 13]);
    const times = [{ sceneId: 'a', start: 0, end: 2 }];
    const seeks = [
      { sceneId: 'a', sceneFrame: 12, timelineFrame: 12, seconds: 0.4, meanDiff: 0.1, maxDiff: 4 },
      { sceneId: 'a', sceneFrame: 40, timelineFrame: 40, seconds: 1.333, meanDiff: 30, maxDiff: 120 },
      { sceneId: 'a', sceneFrame: 50, timelineFrame: 50, seconds: 1.667, error: 'engine failed' },
    ];
    const [issue, ...rest] = videoQaIssues({ freezes: [], blacks: [], seeks }, times, 'warning');
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ rule: 'video.seek', scenes: ['a'], startSeconds: 1.333, durationSeconds: 0 });
    expect(issue!.message).toContain('frame 40 of scene "a" (1.33 s into the video) is not the same picture when the engine starts at it as in the full render: up to 120 luma levels apart on a 64x64 grid');
    expect(issue!.message).toContain('render.fanOut: scenes+chunks');
  });
});

describe('renders', () => {
  it('VQA-03 a picture that keeps moving passes both checks', async () => {
    const { done, manifest } = await render('moving');
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(manifest!.checks).toMatchObject({ freeze: 'pass', black: 'pass', flash: 'pass', motion: 'pass', loop: 'skipped', seek: 'pass' });
    // Two frames of the remotion scenes rendered on their own match the video (the fake engine is frame-pure).
    expect(manifest!.videoQa!.seek).toMatchObject({ grid: 64, maxDiff: 24 });
    expect(manifest!.videoQa!.seek!.frames.map((s) => [s.sceneId, s.sceneFrame, s.timelineFrame])).toEqual([['hook', 38, 38], ['body', 53, 113]]);
    for (const s of manifest!.videoQa!.seek!.frames) expect(s.maxDiff, JSON.stringify(s)).toBeLessThanOrEqual(2);
    expect(manifest!.videoQa).toMatchObject({ mode: 'warn', thresholds: { freezeSeconds: 3, blackSeconds: 0.5 }, freezes: [], blacks: [], flashes: [], issues: [] });
    // Five luma levels a frame on the 32x32 grid, in each of the five seconds; no loop asked for.
    expect(manifest!.videoQa!.motion).toMatchObject({ floor: 0.4, lowSeconds: 3, lows: [] });
    expect(manifest!.videoQa!.motion!.energyPerSecond).toHaveLength(5);
    expect(Math.min(...manifest!.videoQa!.motion!.energyPerSecond)).toBeGreaterThan(3);
    expect(manifest!.videoQa!.motion!.loop).toBeUndefined();
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
    // The same pictures are not reported a second time as barely moving.
    expect(manifest!.checks.motion).toBe('pass');
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

  it('VQA-08 output.loop: a video whose end does not match its start gets a loop warning; one that joins passes', async () => {
    const jump = await render('loop-jump');
    expect(jump.done.status, JSON.stringify(jump.done.error)).toBe('succeeded');
    expect(jump.manifest!.checks.loop).toBe('warn');
    expect(jump.manifest!.videoQa!.motion!.loop).toMatchObject({ jump: true });
    expect(jump.manifest!.videoQa!.issues.find((i) => i.rule === 'video.loop')).toMatchObject({ scenes: ['outro', 'hook'], startSeconds: 3 });
    const joined = await render('loop-joined');
    expect(joined.manifest!.checks.loop).toBe('pass');
    expect(joined.manifest!.videoQa!.motion!.loop).toMatchObject({ seamMotion: 0, jump: false });
    // A preview of one of the two scenes is not the whole loop, so the seam is not checked.
    const preview = await render('loop-jump', { preview: 'hook' });
    expect(preview.manifest!.checks.loop).toBe('skipped');
    // Nor is the seek check run for a preview.
    expect(preview.manifest!.checks.seek).toBe('skipped');
    expect(preview.manifest!.videoQa!.seek).toBeUndefined();
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
    expect(off.manifest!.checks).toMatchObject({ freeze: 'skipped', black: 'skipped', flash: 'skipped', motion: 'skipped', loop: 'skipped', seek: 'skipped' });
    expect(off.manifest!.videoQa).toBeUndefined();
    await svc.updateConfig({ 'render.qa.video': null, 'render.qa.seekFrames': 0 });
    const noSeek = await render('moving');
    expect(noSeek.manifest!.checks.seek).toBe('skipped');
    await svc.updateConfig({ 'render.qa.seekFrames': null });
  }, 240_000);

  it('VQA-10 a scene that paints a frame differently when its engine starts there fails the seek check, with the frame and scene', async () => {
    // The same project on an engine that claims frame ranges but paints a range from its own start.
    const registry = new PluginRegistry().registerEngine(fakeEngine('remotion', { frameRanges: true, impure: true })).registerEngine(fakeEngine('motion-canvas'));
    const impure = await ReelforgeService.create(registry, { repositories: createMemoryRepositories(), dataDir: join(dir, 'impure'), configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } } });
    await impure.createProject(project('moving', [scene('hook', 'remotion', 60), scene('body', 'remotion', 90)]));
    await impure.setTheme('moving', { base: 'default', tokens: { colors: { background: '#f2f0ea' } } });
    const done = await impure.jobs.waitFor((await impure.startRender('moving')).id, 120_000);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const manifest = (await impure.getRenderManifest(done.result!.renderId as string)) as { checks: Record<string, string>; videoQa?: VideoQaManifest };
    expect(manifest.checks.seek).toBe('warn');
    const issues = manifest.videoQa!.issues.filter((i) => i.rule === 'video.seek');
    expect(issues.map((i) => i.scenes)).toEqual([['hook'], ['body']]);
    // Frame 38 is a light grey in the video and the darkest grey on its own: 190 of the 219 levels of video range.
    expect(issues[0]!.message).toContain('frame 38 of scene "hook" (1.27 s into the video) is not the same picture when the engine starts at it as in the full render: up to ');
    expect(manifest.videoQa!.seek!.frames[0]!.maxDiff).toBeGreaterThan(200);
  }, 120_000);
});
