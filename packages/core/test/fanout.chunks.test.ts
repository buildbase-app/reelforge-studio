/**
 * Render fan-out with frame ranges (#156 step 3, D-097): `render.fanOut:
 * scenes+chunks` splits a long scene whose engine declares frame ranges into
 * chunks, one unit each. Chunk planning (pure), capability gating, and the
 * service end to end with fake engines (an api and three workers on one
 * in-memory database): the joined render has every frame of the split scene
 * exactly once (the fake engine draws frame n with its own luma), a key frame
 * at every chunk start, and equals the single-worker render; retry reuses the
 * committed chunks; progress is sent once per 10 %. Ids:
 * docs/providers/queue-and-scaling.md.
 */
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyFrames, probe, resolveTools, run } from '@reelforge/media-pipeline';
import type { Project, RenderScene } from '@reelforge/project-schema';
import { JOIN_JOB_TYPE, PluginRegistry, ReelforgeService, UNIT_JOB_TYPE, createMemoryRepositories, type EnginePlugin, type JobEvent, type JobRecord, type Repositories } from '../src/index';
import { LocalBackend } from '../src/backends/local';
import { chunkRanges, planChunks, unitSpecs, type ChunkPolicy, type RenderJobParams } from '../src/render-fanout';
import { fakeEngine, fakeFrameLuma, tempDir } from './helpers';

const params: RenderJobParams = { projectId: 'p', version: 1, backend: 'local', runId: 'run_x' };
const project = (scenes: Array<{ id: string; engine: string; frames: number }>) =>
  ({ output: { width: 360, height: 640, fps: 30 }, scenes: scenes.map((s) => ({ id: s.id, engine: s.engine, durationFrames: s.frames, template: null, props: {} })) }) as unknown as Project;
const policy = (over: Partial<ChunkPolicy> = {}): ChunkPolicy => ({ chunkFrames: 60, minSceneFrames: 120, canSplit: (s) => s.engine === 'remotion', ...over });

describe('chunk planning (pure)', () => {
  it('FAN-40 chunkRanges: fixed chunks, the last one the rest; a rest under half a chunk joins the one before; never empty', () => {
    expect(chunkRanges(240, 60)).toEqual([[0, 59], [60, 119], [120, 179], [180, 239]]);
    // Last chunk shorter: 240 = 90 + 90 + 60.
    expect(chunkRanges(240, 90)).toEqual([[0, 89], [90, 179], [180, 239]]);
    // A rest of 40 (< 50) joins the chunk before it: no unit for a handful of frames.
    expect(chunkRanges(240, 100)).toEqual([[0, 99], [100, 239]]);
    // Exactly half a chunk left: its own (shorter) chunk.
    expect(chunkRanges(250, 100)).toEqual([[0, 99], [100, 199], [200, 249]]);
    // Shorter than a chunk, or a chunk and a bit: one range, the whole scene.
    expect(chunkRanges(50, 100)).toEqual([[0, 49]]);
    expect(chunkRanges(40, 100)).toEqual([[0, 39]]);
    expect(chunkRanges(1, 1)).toEqual([[0, 0]]);
    // Every frame exactly once, in order, for any length.
    for (let frames = 1; frames < 400; frames += 7) {
      for (const size of [1, 13, 30, 60, 90, 150]) {
        const r = chunkRanges(frames, size);
        expect(r[0]![0]).toBe(0);
        expect(r.at(-1)![1]).toBe(frames - 1);
        for (let i = 1; i < r.length; i++) expect(r[i]![0]).toBe(r[i - 1]![1] + 1);
        for (const [a, b] of r) expect(b - a + 1).toBeGreaterThanOrEqual(Math.min(frames, Math.ceil(size / 2)));
      }
    }
  });

  it('FAN-41 planChunks: only scenes of at least the minimum whose engine renders frame ranges; none without a policy', () => {
    const p = project([
      { id: 'short', engine: 'remotion', frames: 119 },
      { id: 'long', engine: 'remotion', frames: 240 },
      { id: 'mc', engine: 'motion-canvas', frames: 600 },
      { id: 'edge', engine: 'remotion', frames: 120 },
    ]);
    expect(planChunks(p, policy())).toEqual({ '1': [[0, 59], [60, 119], [120, 179], [180, 239]], '3': [[0, 59], [60, 119]] });
    // Backend or setting without frame ranges: no policy, no chunks.
    expect(planChunks(p, null)).toEqual({});
    // An engine that cannot split keeps every scene whole, however long.
    expect(planChunks(p, policy({ canSplit: () => false }))).toEqual({});
    // A chunk as long as the scene: one unit, not a "chunked" scene.
    expect(planChunks(p, policy({ chunkFrames: 240, minSceneFrames: 2 }))).toEqual({});
  });

  it('FAN-42 unitSpecs: one unit per chunk (frames, range) and per whole scene, longest first, chunks of a scene in order', () => {
    const p = project([
      { id: 'a', engine: 'remotion', frames: 45 },
      { id: 'long', engine: 'remotion', frames: 240 },
      { id: 'mc', engine: 'motion-canvas', frames: 150 },
    ]);
    const specs = unitSpecs(params, p, planChunks(p, policy({ chunkFrames: 90 })));
    expect(specs.every((s) => s.type === UNIT_JOB_TYPE)).toBe(true);
    expect(specs.map((s) => [s.params.sceneId, s.params.frames, s.params.range ?? null])).toEqual([
      ['mc', 150, null],
      ['long', 90, [0, 89]],
      ['long', 90, [90, 179]],
      ['long', 60, [180, 239]],
      ['a', 45, null],
    ]);
    expect(specs.map((s) => [s.params.index, s.params.count])).toEqual([[2, 3], [1, 3], [1, 3], [1, 3], [0, 3]]);
    // The frames of all units add up to the render's.
    expect(specs.reduce((n, s) => n + (s.params.frames as number), 0)).toBe(45 + 240 + 150);
    // Without chunks: one unit per scene, as with render.fanOut: scenes.
    expect(unitSpecs(params, p).map((s) => s.params.sceneId)).toEqual(['long', 'mc', 'a']);
    expect(unitSpecs({ ...params, chunks: { '1': [[0, 9]] } }, p).every((s) => !('chunks' in s.params))).toBe(true);
  });

  it('FAN-43 capability gating: the local backend reports frame ranges only when an installed engine declares them', () => {
    const runner = async () => ({ runId: 'r', dir: '', outputFile: '', manifestFile: '' });
    expect(new LocalBackend(runner, () => ['remotion']).capabilities().frameRanges).toBe(false);
    expect(new LocalBackend(runner, () => ['remotion', 'html'], () => []).capabilities().frameRanges).toBe(false);
    expect(new LocalBackend(runner, () => ['remotion', 'html'], () => ['remotion']).capabilities().frameRanges).toBe(true);
    expect(fakeEngine('remotion').capabilities).toBeUndefined();
    expect(fakeEngine('remotion', { frameRanges: true }).capabilities?.()).toEqual({ frameRanges: true });
  });
});

// ---- the service: an api and three workers, fake engines --------------------

const { dir, cleanup } = tempDir('reelforge-chunks-');
const repos: Repositories = createMemoryRepositories();
const engines = { remotion: fakeEngine('remotion', { frameRanges: true }), mc: fakeEngine('motion-canvas') };
/** `${sceneId}@${first}`: chunks whose render fails (FAN-46). */
const failing = new Set<string>();

function registry(): PluginRegistry {
  const flaky = (e: EnginePlugin): EnginePlugin => ({
    ...e,
    render: async (scene: RenderScene, ctx) => {
      if (failing.has(`${scene.id}@${ctx.frameRange?.[0] ?? 'all'}`)) throw new Error(`injected failure in ${scene.id} at ${ctx.frameRange?.[0]}`);
      return e.render(scene, ctx);
    },
  });
  return new PluginRegistry().registerEngine(flaky(engines.remotion)).registerEngine(flaky(engines.mc));
}

const ENV = { REELFORGE_RENDER_FAN_OUT: 'scenes+chunks', REELFORGE_RENDER_CHUNK_SECONDS: '2', REELFORGE_RENDER_CHUNK_MIN_SCENE_SECONDS: '4' };
const services: ReelforgeService[] = [];
async function instance(workerId: string, runJobs: boolean, env: Record<string, string> = ENV) {
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
    ? { id, engine, template: 'kinetic-title', durationFrames, props: { headline: id, subline: 'chunks', accent: '#ff3d71', background: '#0b0b14' } }
    : { id, engine, template: 'animated-explainer', durationFrames, props: { title: id, points: ['a', 'b'], accent: '#00d1b2', background: '#0b0b14' } };
const manifest = (projectId: string, scenes = [scene('a', 'remotion', 45), scene('long', 'remotion', 240), scene('mc', 'motion-canvas', 150), scene('b', 'remotion', 45)]) => ({
  schemaVersion: '0.1',
  projectId,
  title: 'chunks',
  output: { width: 360, height: 640, fps: 30, format: 'mp4' },
  audio: { musicTrack: null, voiceTrack: null },
  assets: [],
  scenes,
});
const LONG_START = 45;
const TOTAL = 45 + 240 + 150 + 45;
const CHUNKS = [[0, 59], [60, 119], [120, 179], [180, 239]];

let api: ReelforgeService;
let workers: ReelforgeService[];
const events: Array<{ worker: string; e: JobEvent }> = [];
const webhooks: Array<{ worker: string; type: string; data: Record<string, unknown> }> = [];
beforeAll(async () => {
  api = await instance('api', false);
  workers = [];
  for (const w of ['w1', 'w2', 'w3']) {
    const s = await instance(w, true);
    s.jobs.onEvent((e) => events.push({ worker: w, e }));
    const emit = s.webhooks.emit.bind(s.webhooks);
    s.webhooks.emit = (type, data) => {
      webhooks.push({ worker: w, type, data });
      emit(type, data);
    };
    workers.push(s);
  }
}, 60_000);
afterAll(async () => {
  for (const s of services) {
    await s.jobs.shutdown(0);
    await s.stop();
  }
  cleanup();
});

const children = (parent: JobRecord) => repos.jobs.list({ parentId: parent.id });
const runIdOf = (j: JobRecord) => (j.params as { runId: string }).runId;
const rendersDir = (pid: string) => join(dir, 'data', 'projects', pid, 'renders');
async function lumaSeries(file: string): Promise<number[]> {
  const { stdout } = await run(resolveTools().ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], 'luma');
  return [...stdout.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
}
async function setFanOut(value: 'off' | 'scenes' | 'scenes+chunks') {
  await api.updateConfig({ 'render.fanOut': value });
  for (const s of [api, ...workers]) await s.settings.refresh();
}

describe('render.fanOut scenes+chunks in the service (fake engines)', () => {
  it('FAN-44 a long scene is split into chunks over three workers, joined with every frame once, a key frame at each chunk start, equal to one worker', async () => {
    await api.createProject(manifest('chunky'));
    const job = await api.startRender('chunky');
    const done = await api.waitForJob(job.id, 60);
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: 'succeeded', pendingChildren: 0, result: { frames: TOTAL } });
    // The plan is on the render job (and its join): scene 1 in four chunks; the Motion Canvas scene (no frame ranges) and the short ones whole.
    expect((done.params as unknown as RenderJobParams).chunks).toEqual({ '1': CHUNKS });
    const kids = await children(job);
    const units = kids.filter((k) => k.type === UNIT_JOB_TYPE).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(units.map((u) => [(u.params as { sceneId: string }).sceneId, (u.params as { range?: number[] }).range ?? null])).toEqual([
      ['mc', null],
      ...CHUNKS.map((r) => ['long', r]),
      ['a', null],
      ['b', null],
    ]);
    expect(units.every((u) => u.status === 'succeeded')).toBe(true);
    expect(new Set(units.map((u) => u.workerId)).size).toBeGreaterThan(1);
    const joins = kids.filter((k) => k.type === JOIN_JOB_TYPE);
    expect(joins).toHaveLength(1);
    expect((joins[0]!.params as unknown as RenderJobParams).chunks).toEqual({ '1': CHUNKS });
    expect(engines.remotion.ranges).toEqual(expect.arrayContaining(CHUNKS));
    expect(engines.mc.ranges.every((r) => r === null)).toBe(true);

    const runId = runIdOf(job);
    const m = JSON.parse(readFileSync(join(rendersDir('chunky'), runId, 'render-manifest.json'), 'utf8'));
    expect(m.scenes.map((s: { sceneId: string; startFrame: number; frames: number; frameRange?: number[] }) => [s.sceneId, s.startFrame, s.frames, s.frameRange ?? null])).toEqual([
      ['a', 0, 45, null],
      ...CHUNKS.map(([f, l]) => ['long', LONG_START + f!, l! - f! + 1, [f, l]]),
      ['mc', 285, 150, null],
      ['b', 435, 45, null],
    ]);
    expect(m.scenes.map((s: { file: string }) => s.file)).toContain('clips/02-long.f60-119.mp4');
    expect(m.join).toEqual({ method: 'concat demuxer, video stream copy', clips: 7 });
    expect(m.checks).toMatchObject({ timestamps: 'pass', avDuration: 'pass' });

    // Every frame of the split scene exactly once, in order: frame n shows the engine's frame n (no duplicated or missing frame at a seam).
    const tools = resolveTools();
    const file = join(rendersDir('chunky'), runId, 'final.mp4');
    const luma = await lumaSeries(file);
    expect(luma).toHaveLength(TOTAL);
    const longLuma = luma.slice(LONG_START, LONG_START + 240);
    const off = longLuma.map((v, n) => Math.abs(v - fakeFrameLuma(n)));
    expect(Math.max(...off)).toBeLessThan(1.5);
    // An IDR at every unit start: each chunk was encoded on its own (and at no other cut than the units').
    const keys = await keyFrames(tools.ffprobe, file);
    for (const start of [0, ...CHUNKS.map(([f]) => LONG_START + f!), 285, 435]) expect(keys).toContain(start);

    // The same project on one worker: same metadata and the same pictures, frame for frame.
    await setFanOut('off');
    const single = await api.waitForJob((await api.startRender('chunky')).id, 60);
    await setFanOut('scenes+chunks');
    expect(single.status).toBe('succeeded');
    expect(await children(single)).toHaveLength(0);
    const one = join(rendersDir('chunky'), runIdOf(single), 'final.mp4');
    const [a, b] = [await probe(tools.ffprobe, one), await probe(tools.ffprobe, file)];
    expect({ ...b, file: '', sizeBytes: 0, bitRate: 0 }).toEqual({ ...a, file: '', sizeBytes: 0, bitRate: 0 });
    const ref = await lumaSeries(one);
    expect(Math.max(...ref.map((v, i) => Math.abs(v - luma[i]!)))).toBeLessThan(1.5);
  }, 120_000);

  it('FAN-45 progress: the render job gets one progress event per 10 % of committed frames (one worker each, never twice, never backwards) and job.progress webhooks', async () => {
    const job = await api.startRender('chunky');
    expect((await api.waitForJob(job.id, 60)).status).toBe('succeeded');
    const mine = events.filter((x) => x.e.jobId === job.id && x.e.type === 'progress');
    const fractions = mine.map((x) => x.e.job.progress.fraction);
    expect(fractions.length).toBeGreaterThan(2);
    const steps = fractions.map((f) => Math.floor(f * 10 + 1e-9));
    expect(new Set(steps).size).toBe(steps.length);
    expect([...steps].sort((x, y) => x - y)).toEqual(steps);
    expect(fractions.at(-1)).toBeCloseTo(0.9, 6);
    expect(mine.every((x) => /\/480 frames, \d\/7 units rendered/.test(x.e.job.progress.detail ?? ''))).toBe(true);
    // The service turns them into job.progress webhooks of the render job (never of its units).
    const hooks = webhooks.filter((w) => w.type === 'job.progress' && (w.data.job as { id: string }).id === job.id);
    expect(hooks.length).toBe(mine.length);
    expect(webhooks.filter((w) => w.type === 'job.progress' && (w.data.job as { parentId?: string }).parentId)).toEqual([]);
  }, 60_000);

  it('FAN-46 a failing chunk fails the render; retry_job renders only the chunks not committed and reuses the rest', async () => {
    await api.createProject(manifest('chunk-retry', [scene('long', 'remotion', 240), scene('b', 'remotion', 45)]));
    failing.add('long@120');
    const first = await api.waitForJob((await api.startRender('chunk-retry')).id, 60);
    expect(first.status).toBe('failed');
    expect(first.error!.message).toMatch(/unit 1\/2 \(scene "long", frames 120-179\) failed: injected failure/);
    const end = Date.now() + 10_000;
    while ((await children(first)).some((k) => k.status === 'queued' || k.status === 'running') && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
    // Committed = a stored unit manifest (a unit may commit and still be recorded as cancelled when the render failed meanwhile).
    const unitsDir = join(rendersDir('chunk-retry'), `.tmp-${runIdOf(first)}`, 'units');
    const committed = (existsSync(unitsDir) ? readdirSync(unitsDir) : []).flatMap((f) => {
      const m = /^\d\d(?:\.f(\d+)-(\d+))?\.json$/.exec(f);
      return m ? [JSON.stringify(m[1] ? [Number(m[1]), Number(m[2])] : null)] : [];
    });
    expect(committed).not.toContain(JSON.stringify([120, 179]));
    failing.clear();
    const before = engines.remotion.ranges.length;
    const retry = await api.waitForJob((await api.retryJob(first.id)).id, 60);
    expect(retry).toMatchObject({ status: 'succeeded', retryOf: first.id, result: { frames: 285 } });
    expect(engines.remotion.ranges.length - before).toBe(5 - committed.length);
    const reused = (await children(retry)).filter((k) => k.result?.reused).map((k) => JSON.stringify((k.params as { range?: number[] }).range ?? null));
    expect(reused.sort()).toEqual([...committed].sort());
    expect((await children(retry)).filter((k) => k.type === JOIN_JOB_TYPE)).toHaveLength(1);
    const luma = await lumaSeries(join(rendersDir('chunk-retry'), runIdOf(retry), 'final.mp4'));
    expect(Math.max(...luma.slice(0, 240).map((v, n) => Math.abs(v - fakeFrameLuma(n))))).toBeLessThan(1.5);
  }, 120_000);

  it('FAN-47 one long scene alone fans out into its chunks; `scenes` keeps it whole; chunks never split a scene below the minimum', async () => {
    await api.createProject(manifest('solo-long', [scene('long', 'remotion', 240)]));
    const solo = await api.waitForJob((await api.startRender('solo-long')).id, 60);
    expect(solo.status).toBe('succeeded');
    expect((await children(solo)).filter((k) => k.type === UNIT_JOB_TYPE)).toHaveLength(4);
    await setFanOut('scenes');
    const whole = await api.waitForJob((await api.startRender('solo-long')).id, 60);
    expect(whole.status).toBe('succeeded');
    expect(await children(whole)).toHaveLength(0); // one scene, one unit: rendered by one worker as before
    await setFanOut('scenes+chunks');
    await api.updateConfig({ 'render.chunkMinSceneSeconds': 9 });
    for (const s of [api, ...workers]) await s.settings.refresh();
    const short = await api.waitForJob((await api.startRender('solo-long')).id, 60);
    expect(await children(short)).toHaveLength(0); // 8 s < 9 s: not split
    await api.updateConfig({ 'render.chunkMinSceneSeconds': 4 });
    for (const s of [api, ...workers]) await s.settings.refresh();
  }, 120_000);

  it('FAN-48 the settings: scenes+chunks is accepted, chunk lengths are validated', async () => {
    await expect(api.updateConfig({ 'render.chunkSeconds': 0.5 })).rejects.toThrow(/chunkSeconds/);
    await expect(api.updateConfig({ 'render.chunkMinSceneSeconds': 1 })).rejects.toThrow(/chunkMinSceneSeconds/);
    await expect(instance('bad', false, { ...ENV, REELFORGE_RENDER_CHUNK_SECONDS: '0' })).rejects.toThrow(/CHUNK_SECONDS|chunkSeconds/);
    expect(api.settings.current.config.render).toMatchObject({ fanOut: 'scenes+chunks', chunkSeconds: 2, chunkMinSceneSeconds: 4 });
    expect(api.capabilities().engines.find((e) => e.id === 'remotion')).toMatchObject({ frameRanges: true });
    expect(api.capabilities().engines.find((e) => e.id === 'motion-canvas')).toMatchObject({ frameRanges: false });
    expect(api.capabilities().backends.find((b) => b.id === 'local')!.capabilities.frameRanges).toBe(true);
  });
});
