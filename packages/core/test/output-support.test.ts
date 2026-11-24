/**
 * Per-engine output validation (#287, #302): sizes and frame rates an engine
 * cannot render are refused before anything is queued, with the engine, the
 * variant and the reason. Fake engines.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseProject } from '@reelforge/project-schema';
import { H264_LEVEL_6_2, PluginRegistry, ReelforgeService, createMemoryRepositories, h264OutputProblems, outputSupportIssues, type EnginePlugin } from '../src/index';
import { fakeEngine, tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-output-support-');
let svc: ReelforgeService;
// An engine that renders integer rates only and at most 1920 px on a side (a plugin declaring its limits).
const limited: EnginePlugin = { ...fakeEngine('motion-canvas'), capabilities: () => ({ frameRanges: false, output: { frameRates: [24, 25, 30, 50, 60], maxDimension: 1920 } }) };
const registry = () => new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(limited);

beforeAll(async () => {
  svc = await ReelforgeService.create(registry(), { repositories: createMemoryRepositories(), dataDir: join(dir, 'data'), configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } } });
});
afterAll(async () => {
  await svc.jobs.shutdown(0);
  await svc.stop();
  cleanup();
});

const manifest = (projectId: string, fps: unknown, extra: Record<string, unknown> = {}) => ({
  schemaVersion: '0.2',
  projectId,
  title: 'output support',
  output: { width: 1080, height: 1920, fps, format: 'mp4' },
  scenes: [
    { id: 'hook', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'Hook' } },
    { id: 'list', engine: 'motion-canvas', template: 'animated-explainer', durationFrames: 60, props: { title: 'List', points: ['a'] } },
  ],
  ...extra,
});

describe('H.264 output rules every engine shares', () => {
  it('odd sides and frames past level 6.2 are refused; normal sizes pass', () => {
    expect(h264OutputProblems(1920, 1080)).toEqual([]);
    expect(h264OutputProblems(4096, 4096)).toEqual([]);
    expect(h264OutputProblems(1081, 1920)[0]).toMatch(/odd side; H.264 with 4:2:0 chroma \(yuv420p\) needs an even width and height/);
    expect(h264OutputProblems(8192, 8192).join()).toMatch(/262144 macroblocks a frame; H.264 allows at most 139264/);
    expect(h264OutputProblems(17000, 16).join()).toMatch(/longer than H.264 allows \(16880 px/);
    expect(H264_LEVEL_6_2.maxFrameMacroblocks).toBe(139_264);
  });
});

describe('engine output support (#287, #302)', () => {
  it('lists every engine that cannot render the rate or size, for output and each variant', () => {
    const r = parseProject(manifest('x', '30000/1001', { variants: [{ id: 'uhd', width: 3840, height: 2160 }] }));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const issues = outputSupportIssues(r.project, registry());
    expect(issues.map((i) => [i.path, i.engine, i.variant])).toEqual([
      ['output', 'motion-canvas', null],
      ['variants.0', 'motion-canvas', 'uhd'],
      ['variants.0', 'motion-canvas', 'uhd'],
    ]);
    expect(issues[0]!.message).toBe('output 1080x1920: engine "motion-canvas" does not render 29.97 fps (30000/1001); it renders 24, 25, 30, 50, 60');
    expect(issues[2]!.message).toBe('variant "uhd" (3840x2160): engine "motion-canvas" renders at most 1920 px on a side');
    expect(outputSupportIssues(r.project, registry(), { variant: 'uhd' }).every((i) => i.variant === 'uhd')).toBe(true);
  });

  it('validate_project reports it, and render_project and preview_scene refuse it with 422 unsupported_output before queueing', async () => {
    await svc.createProject(manifest('ntsc', 29.97));
    const v = await svc.validateProject('ntsc');
    expect(v.ok).toBe(false);
    expect(v.errors).toContainEqual({ path: 'output', message: expect.stringMatching(/^unsupported output: .*does not render 29.97 fps/) });
    const before = (await svc.listJobs({ projectId: 'ntsc' })).jobs.length;
    await expect(svc.renderProject('ntsc')).rejects.toMatchObject({ code: 'unsupported_output', status: 422, details: { issues: [expect.objectContaining({ engine: 'motion-canvas', path: 'output' })] } });
    await expect(svc.preview('ntsc', { sceneId: 'hook' })).rejects.toMatchObject({ code: 'unsupported_output', status: 422 });
    expect((await svc.listJobs({ projectId: 'ntsc' })).jobs.length).toBe(before);

    // A variant over the engine's size: the batch is refused; rendering output alone works.
    await svc.createProject(manifest('sizes', 30, { variants: [{ id: 'square', width: 1080, height: 1080 }, { id: 'uhd', width: 3840, height: 2160 }] }));
    await expect(svc.renderProject('sizes')).rejects.toMatchObject({ code: 'unsupported_output', message: expect.stringContaining('variant "uhd"') });
    await expect(svc.renderProject('sizes', { variant: 'uhd' })).rejects.toMatchObject({ code: 'unsupported_output' });
    expect((await svc.listJobs({ projectId: 'sizes' })).jobs.length).toBe(0);
    const ok = await svc.renderProject('sizes', { variant: 'square' });
    expect((await svc.waitForJob(ok.job.id, 60)).status).toBe('succeeded');
  }, 60_000);

  it('get_capabilities lists the frame rates of each engine', async () => {
    const caps = await svc.capabilities();
    const rates = Object.fromEntries((caps.engines as Array<{ id: string; frameRates: unknown }>).map((e) => [e.id, e.frameRates]));
    expect(rates['motion-canvas']).toEqual([24, 25, 30, 50, 60]);
    expect(rates.remotion).toEqual(['24000/1001', 24, 25, '30000/1001', 30, 48, 50, '60000/1001', 60]);
    expect(caps.limits.supportedFps).toEqual(['24000/1001', 24, 25, '30000/1001', 30, 48, 50, '60000/1001', 60]);
  });
});
