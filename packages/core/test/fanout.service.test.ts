/**
 * Render fan-out end to end in the service (#156, D-097) with the fake engine:
 * an api instance and three worker instances on one (in-memory) database and
 * one shared data directory. `render.fanOut: scenes` splits a render into one
 * unit per scene and one join; `off` (the default) renders as before. Ids:
 * docs/providers/queue-and-scaling.md.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probe, resolveTools } from '@reelforge/media-pipeline';
import type { RenderScene } from '@reelforge/project-schema';
import { JOIN_JOB_TYPE, PluginRegistry, ReelforgeService, UNIT_JOB_TYPE, createMemoryRepositories, type EnginePlugin, type JobRecord, type Repositories } from '../src/index';
import { fakeEngine, tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-fanout-');
const repos: Repositories = createMemoryRepositories();
const engines = { remotion: fakeEngine('remotion'), mc: fakeEngine('motion-canvas', { delayPerFrameMs: 2 }) };
/** Scene ids whose render fails (FAN-13), or waits until it is cancelled (FAN-14). */
const failing = new Set<string>();
const blocking = new Set<string>();

function registry(): PluginRegistry {
  const flaky = (e: EnginePlugin): EnginePlugin => ({
    ...e,
    render: async (scene: RenderScene, ctx) => {
      if (failing.has(scene.id)) throw new Error(`injected failure in scene ${scene.id}`);
      if (blocking.has(scene.id)) await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      return e.render(scene, ctx);
    },
  });
  return new PluginRegistry().registerEngine(flaky(engines.remotion)).registerEngine(flaky(engines.mc));
}

const services: ReelforgeService[] = [];
async function instance(workerId: string, runJobs: boolean, env: Record<string, string> = {}) {
  const s = await ReelforgeService.create(registry(), {
    repositories: repos,
    dataDir: join(dir, 'data'),
    configSources: { env: { REELFORGE_LICENCE_MODE: 'off', ...env } },
    queue: { mode: 'database', workerId, runJobs, leaseMs: 5000, heartbeatMs: 100, pollMs: 30 },
    maintenance: false,
    storage: { sweep: false },
    webhooks: { worker: false },
  });
  services.push(s);
  return s;
}

const scene = (id: string, engine: 'remotion' | 'motion-canvas', durationFrames: number) =>
  engine === 'remotion'
    ? { id, engine, template: 'kinetic-title', durationFrames, props: { headline: id, subline: 'fan-out', accent: '#ff3d71', background: '#0b0b14' } }
    : { id, engine, template: 'animated-explainer', durationFrames, props: { title: id, points: ['a', 'b'], accent: '#00d1b2', background: '#0b0b14' } };

function manifest(projectId: string) {
  return {
    schemaVersion: '0.1',
    projectId,
    title: 'fan-out',
    output: { width: 360, height: 640, fps: 30, format: 'mp4' },
    audio: { musicTrack: null, voiceTrack: null },
    assets: [],
    scenes: [scene('a', 'remotion', 45), scene('b', 'motion-canvas', 72), scene('c', 'remotion', 48), scene('d', 'motion-canvas', 60)],
  };
}
const TOTAL = 45 + 72 + 48 + 60;

let api: ReelforgeService;
let workers: ReelforgeService[];
beforeAll(async () => {
  api = await instance('api', false, { REELFORGE_RENDER_FAN_OUT: 'scenes' });
  workers = [];
  for (const w of ['w1', 'w2', 'w3']) workers.push(await instance(w, true, { REELFORGE_RENDER_FAN_OUT: 'scenes' }));
}, 60_000);
afterAll(async () => {
  for (const s of services) {
    await s.jobs.shutdown(0);
    await s.stop();
  }
  cleanup();
});

const children = (parent: JobRecord) => repos.jobs.list({ parentId: parent.id });

describe('render fan-out in the service (fake engine)', () => {
  it('FAN-10 render.fanOut scenes: one unit per scene over three workers, one join, the same render as one worker makes', async () => {
    await api.createProject(manifest('fan'));
    const job = await api.startRender('fan');
    const done = await api.waitForJob(job.id, 60);
    expect(done).toMatchObject({ status: 'succeeded', pendingChildren: 0 });
    const runId = (job.params as { runId: string }).runId;
    expect(done.result).toMatchObject({ renderId: runId, frames: TOTAL, width: 360, height: 640, fps: 30 });
    const kids = await children(job);
    const units = kids.filter((k) => k.type === UNIT_JOB_TYPE).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(units.map((u) => (u.params as { sceneId: string }).sceneId)).toEqual(['b', 'd', 'c', 'a']); // longest first
    expect(units.every((u) => u.status === 'succeeded' && u.workerId?.startsWith('w'))).toBe(true);
    expect(new Set(units.map((u) => u.workerId)).size).toBeGreaterThan(1);
    expect(kids.filter((k) => k.type === JOIN_JOB_TYPE && k.status === 'succeeded')).toHaveLength(1);
    // The committed render: every scene, in timeline order, the units gone from the temporary prefix.
    const rendersDir = join(dir, 'data', 'projects', 'fan', 'renders');
    const m = JSON.parse(readFileSync(join(rendersDir, runId, 'render-manifest.json'), 'utf8'));
    expect(m.scenes.map((s: { sceneId: string; startFrame: number; frames: number }) => [s.sceneId, s.startFrame, s.frames])).toEqual([
      ['a', 0, 45],
      ['b', 45, 72],
      ['c', 117, 48],
      ['d', 165, 60],
    ]);
    expect(m.scenes.map((s: { file: string }) => s.file)).toEqual(['clips/01-a.mp4', 'clips/02-b.mp4', 'clips/03-c.mp4', 'clips/04-d.mp4']);
    // Joined by stream copy (units normalised to the final encoding), with the extra checks of the join.
    expect(m.join).toEqual({ method: 'concat demuxer, video stream copy', clips: 4 });
    expect(m.checks).toEqual({ metadata: 'pass', decode: 'pass', duration: 'pass', timestamps: 'pass', avDuration: 'pass' });
    expect(m.ffmpegAssembleArgs).toEqual(expect.arrayContaining(['concat', 'copy']));
    expect(existsSync(join(rendersDir, `.tmp-${runId}`))).toBe(false);
    const fanned = await probe(resolveTools().ffprobe, join(rendersDir, runId, 'final.mp4'));
    // The same project rendered by one worker (fan-out off) has the same frames, size, rate and duration.
    await workers[0]!.updateConfig({ 'render.fanOut': 'off' });
    for (const s of [api, ...workers]) await s.settings.refresh();
    const single = await api.waitForJob((await api.startRender('fan')).id, 60);
    expect(single.status).toBe('succeeded');
    expect(await repos.jobs.list({ parentId: single.id })).toHaveLength(0);
    const one = await probe(resolveTools().ffprobe, join(rendersDir, (single.params as { runId: string }).runId, 'final.mp4'));
    expect({ ...fanned, file: '', sizeBytes: 0, bitRate: 0 }).toEqual({ ...one, file: '', sizeBytes: 0, bitRate: 0 });
    await workers[0]!.updateConfig({ 'render.fanOut': 'scenes' });
    for (const s of [api, ...workers]) await s.settings.refresh();
  }, 90_000);

  it('FAN-11 previews and one-scene renders never fan out', async () => {
    await api.createProject({ ...manifest('one'), scenes: [scene('solo', 'remotion', 45)] });
    const solo = await api.waitForJob((await api.startRender('one')).id, 30);
    expect(solo.status).toBe('succeeded');
    const preview = await api.waitForJob((await api.preview('fan', { scale: 0.5 })).id, 30);
    expect(preview.status).toBe('succeeded');
    for (const j of [solo, preview]) expect(await repos.jobs.list({ parentId: j.id })).toHaveLength(0);
  }, 60_000);

  it('FAN-12 render.fanOut scenes+chunks is refused until frame ranges are built', async () => {
    await expect(api.updateConfig({ 'render.fanOut': 'scenes+chunks' })).rejects.toThrow(/scenes\+chunks.*not built yet/);
    await expect(instance('bad', false, { REELFORGE_RENDER_FAN_OUT: 'scenes+chunks' })).rejects.toThrow(/not built yet/);
  });

  it('FAN-13 a failing unit fails the render; retry_job renders only that scene again and reuses the committed units', async () => {
    await api.createProject({ ...manifest('retry'), projectId: 'retry' });
    failing.add('c');
    const first = await api.waitForJob((await api.startRender('retry')).id, 60);
    expect(first.status).toBe('failed');
    expect(first.error).toMatchObject({ code: 'job_failed', unit: expect.stringMatching(/^job_/) });
    expect(first.error!.message).toMatch(/unit 3\/4 \(scene "c"\) failed: injected failure in scene c/);
    // Let the cancelled or finished siblings settle; the committed units are those whose manifest is stored.
    const end = Date.now() + 10_000;
    while ((await children(first)).some((k) => k.status === 'queued' || k.status === 'running') && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
    const unitsDir = join(dir, 'data', 'projects', 'retry', 'renders', `.tmp-${(first.params as { runId: string }).runId}`, 'units');
    const scenes = ['a', 'b', 'c', 'd'];
    const committed = existsSync(unitsDir) ? readdirSync(unitsDir).filter((f) => f.endsWith('.json')).map((f) => scenes[Number(f.slice(0, 2)) - 1]!) : [];
    expect(committed).not.toContain('c');
    failing.clear();
    const before = engines.remotion.renders.length + engines.mc.renders.length;
    const retry = await api.retryJob(first.id);
    const done = await api.waitForJob(retry.id, 60);
    expect(done).toMatchObject({ status: 'succeeded', retryOf: first.id, result: { frames: TOTAL } });
    expect(engines.remotion.renders.length + engines.mc.renders.length - before).toBe(4 - committed.length);
    const reused = (await children(retry)).filter((k) => k.result?.reused);
    expect(reused.map((k) => (k.params as { sceneId: string }).sceneId).sort()).toEqual([...committed].sort());
  }, 90_000);

  it('FAN-15 the retention sweep removes the temporary units of a run that is no longer queued or running, never of an active one', async () => {
    failing.add('a'); // the shortest scene is claimed last, after a unit has committed
    const failed = await api.waitForJob((await api.startRender('retry')).id, 60);
    failing.clear();
    expect(failed.status).toBe('failed');
    const end = Date.now() + 10_000;
    while ((await children(failed)).some((k) => k.status === 'queued' || k.status === 'running') && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
    const runId = (failed.params as { runId: string }).runId;
    const unitsDir = join(dir, 'data', 'projects', 'retry', 'renders', `.tmp-${runId}`, 'units');
    expect(readdirSync(unitsDir).some((f) => f.endsWith('.mp4'))).toBe(true);
    // A run still in progress keeps its units however old they are.
    blocking.add('a');
    const active = await api.startRender('retry');
    const activeDir = join(dir, 'data', 'projects', 'retry', 'renders', `.tmp-${(active.params as { runId: string }).runId}`, 'units');
    const until = Date.now() + 20_000;
    while (!(existsSync(activeDir) && readdirSync(activeDir).some((f) => f.endsWith('.json'))) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    const report = await api.storage.cleanup({ overrides: { tempHours: 0, renderDays: 0, keepLastRendersPerProject: 0 } });
    expect(report.temp.map((t) => t.runId)).toContain(`.tmp-${runId}`);
    expect(report.temp.map((t) => t.runId)).not.toContain(`.tmp-${(active.params as { runId: string }).runId}`);
    expect(existsSync(unitsDir) ? readdirSync(unitsDir) : []).toEqual([]);
    expect(readdirSync(activeDir).length).toBeGreaterThan(0);
    await api.cancelJob(active.id);
    blocking.clear();
  }, 90_000);

  it('FAN-14 cancel_job on a fanned-out render on the api stops its units on the workers', async () => {
    await api.createProject({ ...manifest('cancel'), projectId: 'cancel', scenes: [scene('x', 'motion-canvas', 60), scene('y', 'motion-canvas', 60)] });
    blocking.add('x').add('y');
    const job = await api.startRender('cancel');
    const until = Date.now() + 20_000;
    while ((await children(job)).filter((k) => k.status === 'running').length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 30));
    expect(await api.cancelJob(job.id)).toMatchObject({ status: 'cancelled' });
    const end = Date.now() + 20_000;
    while ((await children(job)).some((k) => k.status !== 'cancelled') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect((await children(job)).map((k) => k.status)).toEqual(['cancelled', 'cancelled']);
    blocking.clear();
  }, 60_000);
});
