/**
 * Output variants (#287): one render_project call over a manifest with
 * `variants` starts one render per variant (its own job and run id, one batch
 * id), each at its variant's size; `variant` renders one of them. Fake engine.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probe, resolveTools } from '@renderweld/media-pipeline';
import { parseProject, withVariant, type RenderScene } from '@renderweld/project-schema';
import { PluginRegistry, ReelforgeService, createMemoryRepositories, type EnginePlugin } from '../src/index';
import { unitSpecs } from '../src/render-fanout';
import { fakeEngine, tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-variants-');
let svc: ReelforgeService;
/** What each engine call saw: the output size. */
const seen: Array<{ scene: string; width: number; height: number }> = [];

beforeAll(async () => {
  const base = fakeEngine('remotion');
  const recording: EnginePlugin = {
    ...base,
    render: (scene: RenderScene, ctx) => {
      seen.push({ scene: scene.id, width: ctx.output.width, height: ctx.output.height });
      return base.render(scene, ctx);
    },
  };
  svc = await ReelforgeService.create(new PluginRegistry().registerEngine(recording), {
    repositories: createMemoryRepositories(),
    dataDir: join(dir, 'data'),
    configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } },
  });
});
afterAll(async () => {
  await svc.jobs.shutdown(0);
  await svc.stop();
  cleanup();
});

const manifest = (projectId: string, variants?: unknown) => ({
  schemaVersion: '0.2',
  projectId,
  title: 'variants',
  output: { width: 216, height: 384, fps: 30, format: 'mp4' },
  ...(variants ? { variants } : {}),
  scenes: [{ id: 'hook', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'One project, three formats' } }],
});

const VARIANTS = [
  { id: 'vertical', width: 216, height: 384, platform: 'tiktok' },
  { id: 'wide', width: 384, height: 216 },
  { id: 'square', width: 216, height: 216 },
];

describe('output variants (#287)', () => {
  it('VAR-01 one render_project call: one render per variant, each its own job and run id, one batch id, each at its size', async () => {
    const v = await svc.validateManifest(manifest('multi', VARIANTS));
    expect(v.ok).toBe(true);
    expect(v.summary?.variants).toEqual(VARIANTS.map(({ id, width, height }) => ({ id, width, height, format: 'mp4', codec: 'h264', alpha: false })));
    await svc.createProject(manifest('multi', VARIANTS));
    const r = await svc.renderProject('multi');
    expect(r.jobs).toHaveLength(3);
    expect(r.job.id).toBe(r.jobs![0]!.id);
    expect(r.batchId).toMatch(/^bat/);
    const params = r.jobs!.map((j) => j.params as { runId: string; variant: string; batchId: string });
    expect(params.map((p) => p.variant)).toEqual(['vertical', 'wide', 'square']);
    expect(new Set(params.map((p) => p.runId)).size).toBe(3);
    expect(params.every((p) => p.batchId === r.batchId)).toBe(true);
    for (const [i, job] of r.jobs!.entries()) {
      const done = await svc.waitForJob(job.id, 60);
      expect(done.status).toBe('succeeded');
      const { width, height } = VARIANTS[i]!;
      expect(done.result).toMatchObject({ renderId: params[i]!.runId, width, height, fps: 30, frames: 45 });
      const out = await svc.renderFile(params[i]!.runId);
      const info = await probe(resolveTools().ffprobe, out.path);
      expect([info.width, info.height]).toEqual([width, height]);
    }
    expect(seen.map((s) => [s.width, s.height])).toEqual(VARIANTS.map((x) => [x.width, x.height]));
  }, 120_000);

  it('VAR-02 variant renders only that one; an unknown variant is 404 with the list; no variants renders output as before', async () => {
    const one = await svc.renderProject('multi', { variant: 'wide' });
    expect(one.jobs).toBeUndefined();
    expect(one.job.params).toMatchObject({ variant: 'wide' });
    expect((await svc.waitForJob(one.job.id, 60)).result).toMatchObject({ width: 384, height: 216 });
    await expect(svc.renderProject('multi', { variant: 'cinema' })).rejects.toMatchObject({ code: 'not_found', status: 404, details: { variants: ['vertical', 'wide', 'square'] } });
    await expect(svc.renderProject('multi', { variant: 7 })).rejects.toMatchObject({ status: 400 });

    await svc.createProject(manifest('plain'));
    const plain = await svc.renderProject('plain');
    expect(plain.jobs).toBeUndefined();
    expect(plain.job.params).not.toHaveProperty('variant');
    expect((await svc.waitForJob(plain.job.id, 60)).result).toMatchObject({ width: 216, height: 384 });
  }, 120_000);

  it('VAR-03 a variant over the render limits refuses the whole batch before anything is queued', async () => {
    await svc.createProject(manifest('big', [...VARIANTS, { id: 'uhd', width: 3840, height: 2160 }]));
    await svc.updateConfig({ 'limits.maxRenderDimension': 1920 });
    try {
      const before = (await svc.listJobs({ projectId: 'big' })).jobs.length;
      await expect(svc.renderProject('big')).rejects.toMatchObject({ code: 'render_limit_exceeded', status: 422, message: expect.stringContaining('variant "uhd"') });
      expect((await svc.listJobs({ projectId: 'big' })).jobs.length).toBe(before);
      const v = await svc.validateProject('big');
      expect(v.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'variants.3' })]));
    } finally {
      await svc.updateConfig({ 'limits.maxRenderDimension': 4096 });
    }
  }, 60_000);

  it('VAR-05 the captions override reaches every variant job and is checked before anything is queued', async () => {
    const before = (await svc.listJobs({ projectId: 'multi' })).jobs.length;
    await expect(svc.renderProject('multi', { captions: 'loud' })).rejects.toMatchObject({ status: 400 });
    expect((await svc.listJobs({ projectId: 'multi' })).jobs.length).toBe(before);
    const r = await svc.renderProject('multi', { captions: 'sidecar' });
    expect(r.jobs!.map((j) => (j.params as { captions?: string }).captions)).toEqual(['sidecar', 'sidecar', 'sidecar']);
    const one = await svc.renderProject('multi', { variant: 'square', captions: 'off' });
    expect(one.job.params).toMatchObject({ variant: 'square', captions: 'off' });
    for (const j of [...r.jobs!, one.job]) await svc.waitForJob(j.id, 60);
  }, 120_000);

  it('VAR-06 preview_scene takes a variant: the preview renders at that variant\'s size (scaled) and platform', async () => {
    seen.length = 0;
    const job = await svc.preview('multi', { variant: 'wide', scale: 0.5 });
    expect(job.params).toMatchObject({ variant: 'wide', scale: 0.5 });
    const done = await svc.waitForJob(job.id, 60);
    expect(done.status).toBe('succeeded');
    expect(done.result).toMatchObject({ width: 192, height: 108, frames: 45 });
    expect(seen.map((x) => [x.width, x.height])).toEqual([[192, 108]]);
    // Without a variant the preview is of output, as before.
    const plain = await svc.preview('multi', { scale: 0.5 });
    expect(plain.params).not.toHaveProperty('variant');
    expect((await svc.waitForJob(plain.id, 60)).result).toMatchObject({ width: 108, height: 192 });
    await expect(svc.preview('multi', { variant: 'cinema' })).rejects.toMatchObject({ code: 'not_found', status: 404, details: { variants: ['vertical', 'wide', 'square'] } });
    await expect(svc.preview('multi', { variant: 3 })).rejects.toMatchObject({ status: 400 });
  }, 120_000);

  it('VAR-04 fan-out units carry the variant, so every unit and the join render at its size', () => {
    const r = parseProject(manifest('fan', VARIANTS));
    if (!r.ok) throw new Error('invalid');
    const specs = unitSpecs({ projectId: 'fan', version: 1, backend: 'local', runId: 'run-x', variant: 'wide', batchId: 'bat-x' }, r.project);
    expect(specs.map((u) => u.params)).toEqual([expect.objectContaining({ variant: 'wide', runId: 'run-x' })]);
    expect(withVariant(r.project, 'wide').output).toMatchObject({ width: 384, height: 216, fps: 30 });
    expect(withVariant(r.project, 'vertical').brief?.platform).toBe('tiktok');
  });
});
