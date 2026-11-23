import { execFileSync } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { avDurations, checkTimestamps, framePsnr, frameStats, keyFrames, probe, resolveTools, run, streamParams } from '@reelforge/media-pipeline';
import { createTestDatabase, type TestDatabase } from '@reelforge/db';
import { S3StorageDriver, streamToBuffer } from '@reelforge/core';
import { tempDir } from '../../../packages/core/test/helpers';
import { cliCreateKey, startServerProcess, type ServerProcess } from './serverProcess';

/**
 * Render fan-out end to end (#156, D-097, FAN-30..31): real engines (Remotion,
 * Motion Canvas, html, HyperFrames), PostgreSQL, MinIO and one api with three
 * worker processes, as an operator runs them. A 6-scene, 4-engine 1080x1920
 * reel rendered with `render.fanOut: scenes` must equal the single-worker
 * render in frame count, scene-boundary frames, A/V duration and ffprobe
 * stream parameters; a unit worker killed with SIGKILL mid-render must lead to
 * the unit being claimed again and exactly one join. With `scenes+chunks`
 * (FAN-32) an 8 s 1080x1920 Remotion scene splits into 2 s chunks over the
 * three workers and must equal the single-worker render frame for frame,
 * with a key frame at every chunk start.
 *
 * Heavy, so opt-in: FANOUT_E2E=1 with TEST_POSTGRES_URL, FANOUT_E2E_S3_ENDPOINT
 * (a MinIO; e2e/minio/build-image.sh builds one), FANOUT_E2E_S3_ACCESS_KEY /
 * FANOUT_E2E_S3_SECRET_KEY and REELFORGE_CHROMIUM_PATH. Command and the latest
 * numbers: docs/providers/queue-and-scaling.md#render-fan-out.
 */
const env = process.env;
const enabled = env.FANOUT_E2E === '1' && !!env.TEST_POSTGRES_URL && !!env.FANOUT_E2E_S3_ENDPOINT && !!env.REELFORGE_CHROMIUM_PATH;
const { dir, cleanup } = tempDir('reelforge-fanout-e2e-');
const BUCKET = `fanout-${Date.now().toString(36)}`;
const SECRET_KEY = 'fanout-e2e-secret-key-0123456789abcdef0123';
const tools = resolveTools();

const credentials = { accessKeyId: env.FANOUT_E2E_S3_ACCESS_KEY ?? 'minioadmin', secretAccessKey: env.FANOUT_E2E_S3_SECRET_KEY ?? 'minioadmin' };
/** The bucket, made and removed with the AWS SDK that comes with @reelforge/core (the server's S3 driver has no bucket calls). */
async function bucket(command: 'CreateBucketCommand' | 'DeleteBucketCommand') {
  const req = createRequire(join(__dirname, '../../../packages/core/package.json'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = await import(req.resolve('@aws-sdk/client-s3'));
  const client = new sdk.S3Client({ endpoint: env.FANOUT_E2E_S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials });
  await client.send(new sdk[command]({ Bucket: BUCKET }));
}
/** Objects as the server stores them, through its own S3 driver. */
const store = () => S3StorageDriver.create({ bucket: BUCKET, endpoint: env.FANOUT_E2E_S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, ...credentials });

const scene = (id: string, engine: string, durationFrames: number, headline: string) =>
  engine === 'remotion'
    ? { id, engine, template: 'kinetic-title', durationFrames, props: { headline, subline: 'Rendered on many workers', accent: '#ff3d71', background: '#0b0b14' } }
    : engine === 'motion-canvas'
      ? { id, engine, template: 'animated-explainer', durationFrames, props: { title: headline, points: ['One unit per scene', 'Joined by stream copy'], accent: '#00d1b2', background: '#0b0b14' } }
      : engine === 'html'
        ? { id, engine, template: 'html-title', durationFrames, props: { headline, kicker: 'HTML' } }
        : { id, engine, template: 'hyperframes-title', durationFrames, props: { headline } };
const SCENES = [
  scene('hook', 'remotion', 45, 'Fan-out'),
  scene('explain', 'motion-canvas', 60, 'How it splits'),
  scene('card', 'html', 30, 'Six scenes'),
  scene('hf', 'hyperframes', 30, 'Four engines'),
  scene('card2', 'html', 30, 'Three workers'),
  scene('outro', 'remotion', 45, 'One join'),
];
const TOTAL = SCENES.reduce((n, s) => n + s.durationFrames, 0);
/** FAN-32: the longest Remotion scene the kinetic-title template allows (8 s), then a short html card. */
const CHUNK_SCENES = [scene('long', 'remotion', 240, 'One long scene, four chunks'), scene('end', 'html', 30, 'Joined')];
const CHUNK_TOTAL = 270;
const CHUNK_STARTS = [60, 120, 180];
const BOUNDARIES = SCENES.slice(1).map((_, i) => SCENES.slice(0, i + 1).reduce((n, s) => n + s.durationFrames, 0));

/** A process and everything it started (tsx runs the server in a child node process, which starts Chromium and FFmpeg). */
function tree(pid: number): number[] {
  let kids: number[] = [];
  try {
    kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch {
    // no children
  }
  return [pid, ...kids.flatMap(tree)];
}
const killTree = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (!pid) return;
  for (const p of tree(pid).reverse()) {
    try {
      process.kill(p, signal);
    } catch {
      // gone already
    }
  }
};
/** FANOUT_E2E_REPORT: append the measured numbers there (vitest hides console output of passing tests). */
const report = (line: string) => {
  console.log(line);
  if (env.FANOUT_E2E_REPORT) appendFileSync(env.FANOUT_E2E_REPORT, `${line}\n`);
};

/** Mean luma of every frame (one decode pass): a duplicated or missing frame shifts the series at a cut. */
async function lumaSeries(file: string): Promise<number[]> {
  const { stdout } = await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], 'luma');
  return [...stdout.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
}

describe.skipIf(!enabled)('render fan-out e2e: real engines, PostgreSQL, MinIO, an api and three workers', () => {
  let db: TestDatabase;
  let api: ServerProcess;
  const workers: Array<{ name: string; proc: ServerProcess; id: string }> = [];
  let key: string;
  const results: Record<string, { seconds: number; file: string; job: any }> = {};

  const baseEnv = () => ({
    REELFORGE_LICENCE_MODE: 'off',
    REELFORGE_SECRET_KEY: SECRET_KEY,
    DATABASE_URL: db.url,
    REELFORGE_STORAGE_DRIVER: 's3',
    REELFORGE_S3_ENDPOINT: env.FANOUT_E2E_S3_ENDPOINT!,
    REELFORGE_S3_BUCKET: BUCKET,
    REELFORGE_S3_REGION: 'us-east-1',
    REELFORGE_S3_FORCE_PATH_STYLE: 'true',
    REELFORGE_S3_ACCESS_KEY_ID: env.FANOUT_E2E_S3_ACCESS_KEY ?? 'minioadmin',
    REELFORGE_S3_SECRET_ACCESS_KEY: env.FANOUT_E2E_S3_SECRET_KEY ?? 'minioadmin',
    REELFORGE_RATE_LIMIT_PER_MINUTE: '0',
    REELFORGE_QUEUE_LEASE_SECONDS: '8',
    REELFORGE_QUEUE_SHUTDOWN_GRACE_SECONDS: '2',
    REELFORGE_QUEUE_POLL_INTERVAL_MS: '250',
    REELFORGE_WORKER_CONCURRENCY: '1',
    REELFORGE_CHROMIUM_PATH: env.REELFORGE_CHROMIUM_PATH!,
  });
  const worker = async (name: string) => {
    const proc = await startServerProcess({ ...baseEnv(), REELFORGE_ROLE: 'worker', REELFORGE_DATA_DIR: join(dir, name) });
    let m: RegExpExecArray | null = null;
    for (let i = 0; i < 100 && !(m = /\(worker ([\w.-]+),/.exec(proc.output())); i++) await new Promise((r) => setTimeout(r, 100));
    if (!m) throw new Error(`no worker id in the output of ${name}:\n${proc.output()}`);
    const id = m[1]!;
    workers.push({ name, proc, id });
  };
  async function rest(method: string, path: string, body?: unknown) {
    const res = await fetch(`${api.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  }
  const jobs = async (pid = 'fanout') => (await rest('GET', `/v1/jobs?projectId=${pid}`)).json.jobs as any[];
  async function waitDone(id: string, ms = 900_000) {
    const end = Date.now() + ms;
    for (;;) {
      const j = (await rest('GET', `/v1/jobs/${id}?wait=20`)).json;
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
      if (Date.now() > end) throw new Error(`job ${id} did not finish: ${JSON.stringify(j)}`);
    }
  }
  async function setFanOut(value: 'off' | 'scenes' | 'scenes+chunks', extra: Record<string, number> = {}) {
    const res = await rest('PATCH', '/v1/config', { 'render.fanOut': value, ...extra });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // Every instance re-reads runtime settings every 15 s (D-077).
    await new Promise((r) => setTimeout(r, 16_000));
  }
  async function download(job: any, name: string, pid = 'fanout') {
    const file = join(dir, `${name}.mp4`);
    await pipeline(await (await store()).get(`projects/${pid}/renders/${job.result.renderId}/final.mp4`), createWriteStream(file));
    return file;
  }
  async function renderTimed(name: string, pid = 'fanout') {
    const t = Date.now();
    const started = (await rest('POST', `/v1/projects/${pid}/renders`, {})).json.job;
    const job = await waitDone(started.id);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    results[name] = { seconds: (Date.now() - t) / 1000, file: await download(job, name, pid), job };
    return results[name]!;
  }

  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    await bucket('CreateBucketCommand');
    db = await createTestDatabase('postgresql', dir);
    key = cliCreateKey(join(dir, 'api'), 'fanout-e2e', 'admin', { ...baseEnv() });
    api = await startServerProcess({ ...baseEnv(), REELFORGE_ROLE: 'api', REELFORGE_DATA_DIR: join(dir, 'api') });
    for (const w of ['w1', 'w2', 'w3']) await worker(w);
    // v0.1 manifests know two engines: create with the first two scenes, then add the rest (html, HyperFrames) in order.
    const manifest = { schemaVersion: '0.1', projectId: 'fanout', title: 'Fan-out e2e', output: { width: 1080, height: 1920, fps: 30, format: 'mp4' }, audio: { musicTrack: null, voiceTrack: null }, assets: [], scenes: SCENES.slice(0, 2) };
    const created = await rest('POST', '/v1/projects', { manifest });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    for (const sc of SCENES.slice(2)) {
      const added = await rest('POST', '/v1/projects/fanout/scenes', { scene: sc });
      expect(added.status, JSON.stringify(added.json)).toBe(201);
    }
    // Music over the whole timeline: mixed once by the join.
    const tone = join(dir, 'tone.mp3');
    await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=12', '-c:a', 'libmp3lame', tone], 'fixture');
    const form = new FormData();
    form.append('file', new Blob([readFileSync(tone)], { type: 'audio/mpeg' }), 'tone.mp3');
    form.append('projectId', 'fanout');
    form.append('assetId', 'music');
    expect((await rest('POST', '/v1/assets', form)).status).toBe(201);
    const audio = await rest('PATCH', '/v1/projects/fanout/audio', { music: { asset: 'music', volume: 0.4, fadeOutSeconds: 1 } });
    expect(audio.status, JSON.stringify(audio.json)).toBeLessThan(300);
  }, 300_000);

  afterAll(async () => {
    await Promise.all([...workers.map((w) => w.proc.stop()), api?.stop()]);
    for (const p of [...workers.map((w) => w.proc), api]) killTree(p?.child.pid, 'SIGKILL');
    await db?.drop();
    try {
      const d = await store();
      for (const o of await d.list('projects/')) await d.delete(o.key);
      await bucket('DeleteBucketCommand');
    } catch {
      // best effort
    }
    cleanup();
  }, 120_000);

  it('FAN-30 the fanned-out render equals the single-worker render: frames, scene boundaries, A/V duration, stream parameters', async () => {
    await setFanOut('off');
    const single = await renderTimed('single');
    expect((await jobs()).filter((j) => j.parentId)).toHaveLength(0);
    await setFanOut('scenes');
    const fanned = await renderTimed('fanned');
    const children = (await jobs()).filter((j) => j.parentId === fanned.job.id);
    expect(children.filter((c) => c.type === 'render_unit' && c.status === 'succeeded')).toHaveLength(6);
    expect(children.filter((c) => c.type === 'render_join' && c.status === 'succeeded')).toHaveLength(1);
    const unitWorkers = new Set(children.filter((c) => c.type === 'render_unit').map((c) => c.workerId));
    expect(unitWorkers.size).toBe(3);

    const [a, b] = [await probe(tools.ffprobe, single.file), await probe(tools.ffprobe, fanned.file)];
    expect(a).toMatchObject({ width: 1080, height: 1920, fps: 30, frames: TOTAL, videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'aac' });
    expect(b).toEqual(a);
    expect(await streamParams(tools.ffprobe, fanned.file)).toEqual(await streamParams(tools.ffprobe, single.file));
    const [da, dbs] = [await avDurations(tools.ffprobe, single.file), await avDurations(tools.ffprobe, fanned.file)];
    expect(dbs).toEqual(da);
    expect(dbs.video).toBeCloseTo(TOTAL / 30, 3);
    expect(await checkTimestamps(tools.ffprobe, fanned.file, TOTAL, 30)).toEqual([]);
    // Every frame lines up: the per-frame luma of the two renders agree (both encoded once from the same engine frames).
    const [la, lb] = [await lumaSeries(single.file), await lumaSeries(fanned.file)];
    expect(lb.length).toBe(TOTAL);
    const worst = Math.max(...la.map((v, i) => Math.abs(v - lb[i]!)));
    // At each cut: the frames either side match the single render, and the cut is where the scenes change.
    const boundary: Array<{ frame: number; single: number[]; fanned: number[] }> = [];
    for (const f of BOUNDARIES) {
      const s = [await frameStats(tools.ffmpeg, single.file, f - 1), await frameStats(tools.ffmpeg, single.file, f)];
      const x = [await frameStats(tools.ffmpeg, fanned.file, f - 1), await frameStats(tools.ffmpeg, fanned.file, f)];
      boundary.push({ frame: f, single: s.map((v) => v.yAvg), fanned: x.map((v) => v.yAvg) });
      for (const k of [0, 1]) expect(Math.abs(s[k]!.yAvg - x[k]!.yAvg)).toBeLessThan(1.5);
    }
    const manifest = JSON.parse((await streamToBuffer(await (await store()).get(`projects/fanout/renders/${fanned.job.result.renderId}/render-manifest.json`))).toString('utf8'));
    expect(manifest.join).toEqual({ method: 'concat demuxer, video stream copy', clips: 6 });
    expect(manifest.checks).toMatchObject({ timestamps: 'pass', avDuration: 'pass' });
    // The temporary units are gone from the bucket.
    expect((await (await store()).list('projects/fanout/renders/')).filter((o) => o.key.includes('/.tmp-'))).toEqual([]);
    report(
      `FAN-30: ${TOTAL} frames at 1080x1920; single worker ${single.seconds.toFixed(1)} s, fanned out over 3 workers ${fanned.seconds.toFixed(1)} s; ` +
        `max per-frame luma difference ${worst.toFixed(2)}; boundaries ${JSON.stringify(boundary)}`
    );
    expect(worst).toBeLessThan(2);
  }, 1_200_000);

  it('FAN-32 scenes+chunks: an 8 s Remotion scene in 2 s chunks over 3 workers equals the single-worker render frame for frame', async () => {
    const manifest = { schemaVersion: '0.1', projectId: 'chunks', title: 'Chunks e2e', output: { width: 1080, height: 1920, fps: 30, format: 'mp4' }, audio: { musicTrack: null, voiceTrack: null }, assets: [], scenes: CHUNK_SCENES.slice(0, 1) };
    expect((await rest('POST', '/v1/projects', { manifest })).status).toBe(201);
    expect((await rest('POST', '/v1/projects/chunks/scenes', { scene: CHUNK_SCENES[1] })).status).toBe(201);
    const tone = join(dir, 'tone.mp3');
    const form = new FormData();
    form.append('file', new Blob([readFileSync(tone)], { type: 'audio/mpeg' }), 'tone.mp3');
    form.append('projectId', 'chunks');
    form.append('assetId', 'music');
    expect((await rest('POST', '/v1/assets', form)).status).toBe(201);
    expect((await rest('PATCH', '/v1/projects/chunks/audio', { music: { asset: 'music', volume: 0.4, fadeOutSeconds: 1 } })).status).toBeLessThan(300);

    await setFanOut('off');
    const single = await renderTimed('chunks-single', 'chunks');
    await setFanOut('scenes+chunks', { 'render.chunkSeconds': 2, 'render.chunkMinSceneSeconds': 4 });
    const chunked = await renderTimed('chunks-fanned', 'chunks');
    await setFanOut('scenes');
    expect(chunked.job.params.chunks).toEqual({ '0': [[0, 59], [60, 119], [120, 179], [180, 239]] });
    const children = (await jobs('chunks')).filter((j) => j.parentId === chunked.job.id);
    const units = children.filter((c) => c.type === 'render_unit');
    expect(units.map((u) => u.params.range ?? null).sort()).toEqual([[0, 59], [120, 179], [180, 239], [60, 119], null].sort());
    expect(units.every((u) => u.status === 'succeeded')).toBe(true);
    expect(children.filter((c) => c.type === 'render_join' && c.status === 'succeeded')).toHaveLength(1);
    const unitWorkers = new Set(units.map((c) => c.workerId));
    expect(unitWorkers.size).toBe(3);

    const [a, b] = [await probe(tools.ffprobe, single.file), await probe(tools.ffprobe, chunked.file)];
    expect(a).toMatchObject({ width: 1080, height: 1920, fps: 30, frames: CHUNK_TOTAL, videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'aac' });
    expect(b).toEqual(a);
    expect(await streamParams(tools.ffprobe, chunked.file)).toEqual(await streamParams(tools.ffprobe, single.file));
    const [da, dc] = [await avDurations(tools.ffprobe, single.file), await avDurations(tools.ffprobe, chunked.file)];
    expect(dc).toEqual(da);
    expect(dc.video).toBeCloseTo(CHUNK_TOTAL / 30, 3);
    expect(await checkTimestamps(tools.ffprobe, chunked.file, CHUNK_TOTAL, 30)).toEqual([]);
    // Each chunk was encoded on its own: an IDR at every chunk start (and at the html scene).
    const keys = await keyFrames(tools.ffprobe, chunked.file);
    for (const k of [0, ...CHUNK_STARTS, 240]) expect(keys).toContain(k);
    // Frame for frame: per-frame luma, and the pictures themselves (PSNR) at and around every chunk boundary.
    const [la, lc] = [await lumaSeries(single.file), await lumaSeries(chunked.file)];
    expect(lc.length).toBe(CHUNK_TOTAL);
    const worst = Math.max(...la.map((v, i) => Math.abs(v - lc[i]!)));
    const psnr = await framePsnr(tools.ffmpeg, single.file, chunked.file);
    expect(psnr).toHaveLength(CHUNK_TOTAL);
    const shifted = await framePsnr(tools.ffmpeg, single.file, chunked.file, 1);
    const boundary: Array<{ frame: number; single: number[]; chunked: number[]; psnr: number[] }> = [];
    for (const f of CHUNK_STARTS) {
      const s = [await frameStats(tools.ffmpeg, single.file, f - 1), await frameStats(tools.ffmpeg, single.file, f)];
      const x = [await frameStats(tools.ffmpeg, chunked.file, f - 1), await frameStats(tools.ffmpeg, chunked.file, f)];
      boundary.push({ frame: f, single: s.map((v) => v.yAvg), chunked: x.map((v) => v.yAvg), psnr: [psnr[f - 1]!, psnr[f]!].map((v) => Number(v.toFixed(1))) });
      for (const k of [0, 1]) expect(Math.abs(s[k]!.yAvg - x[k]!.yAvg)).toBeLessThan(1.5);
    }
    const minPsnr = Math.min(...psnr);
    const minAt = psnr.indexOf(minPsnr);
    const minRemotion = Math.min(...psnr.slice(0, 240));
    const minHtml = Math.min(...psnr.slice(240));
    const low = psnr.flatMap((v, i) => (v < 42 ? [`${i}:${v.toFixed(1)}`] : []));
    const unitSeconds = units.map((u) => `${u.params.range ? u.params.range.join('-') : u.params.sceneId}: ${((u.result?.millis ?? 0) / 1000).toFixed(1)} s`).join(', ');
    const minAtSeams = Math.min(...CHUNK_STARTS.flatMap((f) => [psnr[f - 1]!, psnr[f]!]));
    const manifest2 = JSON.parse((await streamToBuffer(await (await store()).get(`projects/chunks/renders/${chunked.job.result.renderId}/render-manifest.json`))).toString('utf8'));
    expect(manifest2.join).toEqual({ method: 'concat demuxer, video stream copy', clips: 5 });
    expect(manifest2.scenes.map((x: any) => x.frameRange ?? null)).toEqual([[0, 59], [60, 119], [120, 179], [180, 239], null]);
    expect((await (await store()).list('projects/chunks/renders/')).filter((o) => o.key.includes('/.tmp-'))).toEqual([]);
    report(
      `FAN-32: ${CHUNK_TOTAL} frames at 1080x1920 (an 8 s Remotion scene in 4 chunks of 2 s + a 1 s html scene), ${units.length} units on ${unitWorkers.size} workers; ` +
        `wall time (shared sandbox, not a benchmark): single worker ${single.seconds.toFixed(1)} s, chunked over 3 workers ${chunked.seconds.toFixed(1)} s; ` +
        `engine time per unit ${unitSeconds}; ` +
        `max per-frame luma difference ${worst.toFixed(2)}; per-frame PSNR vs single: min ${minPsnr.toFixed(1)} dB at frame ${minAt} (Remotion scene ${minRemotion.toFixed(1)}, html scene ${minHtml.toFixed(1)}), frames under 42 dB [${low.join(' ')}], min at chunk seams ${minAtSeams.toFixed(1)} dB ` +
        `(one frame shifted: min ${Math.min(...shifted).toFixed(1)} dB); key frames ${JSON.stringify(keys)}; boundaries ${JSON.stringify(boundary)}`
    );
    expect(worst).toBeLessThan(2);
    expect(minAtSeams).toBeGreaterThan(38);
    expect(minPsnr).toBeGreaterThan(Math.min(...shifted));
  }, 1_200_000);

  it('FAN-31 a unit worker killed with SIGKILL mid-render: the unit is claimed again and the render gets exactly one join', async () => {
    const started = (await rest('POST', '/v1/projects/fanout/renders', {})).json.job;
    // Wait for a unit to be rendering on a worker, then kill that worker process.
    let victim: { unit: any; worker: (typeof workers)[number] } | undefined;
    for (let i = 0; i < 600 && !victim; i++) {
      const units = (await jobs()).filter((j) => j.parentId === started.id && j.type === 'render_unit' && j.status === 'running' && (j.progress?.fraction ?? 0) > 0.05);
      const unit = units[0];
      const w = unit && workers.find((x) => x.id === unit.workerId);
      if (unit && w) victim = { unit, worker: w };
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(victim).toBeDefined();
    // A crash: the worker's whole process tree dies at once (no shutdown, no hand-back).
    killTree(victim!.worker.proc.child.pid, 'SIGKILL');
    workers.splice(workers.indexOf(victim!.worker), 1); // gone: nothing to stop in afterAll
    const job = await waitDone(started.id);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const children = (await jobs()).filter((j) => j.parentId === started.id);
    const unit = children.find((c) => c.id === victim!.unit.id)!;
    expect(unit).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(unit.workerId).not.toBe(victim!.worker.id);
    expect(children.filter((c) => c.type === 'render_join')).toHaveLength(1);
    expect(children.filter((c) => c.type === 'render_unit' && c.status === 'succeeded')).toHaveLength(6);
    const file = await download(job, 'crash');
    expect(await probe(tools.ffprobe, file)).toEqual(await probe(tools.ffprobe, results.single!.file));
    expect(await checkTimestamps(tools.ffprobe, file, TOTAL, 30)).toEqual([]);
    const logs = (await rest('GET', `/v1/jobs/${unit.id}/logs`)).json.lines.join('\n');
    expect(logs).toMatch(new RegExp(`lease expired: worker ${victim!.worker.id}`));
    report(`FAN-31: killed ${victim!.worker.id} while it rendered unit ${unit.params.index + 1} (scene "${unit.params.sceneId}"); attempt 2 on ${unit.workerId}; 1 join`);
  }, 1_200_000);
});
