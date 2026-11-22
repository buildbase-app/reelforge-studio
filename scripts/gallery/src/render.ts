/**
 * `pnpm gallery render`: renders every gallery entry through the studio's MCP
 * server, the way an agent would, and writes per reel
 *   <out>/<slug>/final.mp4          the checked 1080x1920 master (with audio)
 *   <out>/<slug>/render-manifest.json  the studio's own record of the render
 *   <out>/<slug>/meta.json          what the showcase publishes (see Meta)
 * Resumable: a reel whose meta.json has the same manifest hash is skipped.
 * Idempotent: every write call carries an idempotency key derived from the
 * reel and its manifest hash, so a retried call never renders twice.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, type as osType, release } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GalleryEntry } from './catalog/build';
import { manifestHash } from './manifests';
import { MUSIC_LICENSE, musicWav } from './music';
import { RecordingCaller, ToolError, type ToolCaller } from './studio';

export interface Meta {
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  engines: string[];
  theme: string;
  palette: string;
  featured: boolean;
  music: string | null;
  durationSeconds: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  /** The studio's wall-clock render time (render-manifest wallClockMillis), seconds. */
  renderSeconds: number;
  /** Time from render_project to a finished job as the client saw it (includes queueing). */
  jobSeconds: number;
  hardware: { cpu: string; cores: number; ramGb: number; os: string };
  studioVersion: string;
  engineVersions: Record<string, string>;
  ffmpeg: string;
  renderedAt: string;
  manifestHash: string;
  prompt: string;
  toolsCalled: string[];
  mcpCalls: number;
  bytes: number;
  checks: Record<string, string>;
}

export function hardwareSummary(): Meta['hardware'] {
  const c = cpus();
  return { cpu: (c[0]?.model ?? 'unknown').replace(/\s+/g, ' ').trim(), cores: c.length, ramGb: Math.round(totalmem() / 2 ** 30), os: `${osType()} ${release()}` };
}

export function isDone(outDir: string, entry: GalleryEntry): boolean {
  const f = join(outDir, entry.gallery.slug, 'meta.json');
  if (!existsSync(f) || !existsSync(join(outDir, entry.gallery.slug, 'final.mp4'))) return false;
  try {
    return (JSON.parse(readFileSync(f, 'utf8')) as Meta).manifestHash === manifestHash(entry.manifest);
  } catch {
    return false;
  }
}

async function download(url: string, file: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) throw new Error(`download ${url} -> ${res.status}`);
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
  renameSync(tmp, file);
  return Number(res.headers.get('content-length') ?? 0);
}

export interface RenderOptions {
  outDir: string;
  /** Base URL of the studio, for downloads. */
  studioUrl: string;
  key: string;
  log?: (line: string) => void;
  /** Max wait for one render (default 30 min). */
  timeoutMs?: number;
}

/** Render one entry over MCP and write its files. Returns the meta. */
export async function renderEntry(caller: ToolCaller, entry: GalleryEntry, opts: RenderOptions): Promise<Meta> {
  const log = opts.log ?? (() => undefined);
  const slug = entry.gallery.slug;
  const hash = manifestHash(entry.manifest);
  const idem = (step: string) => `gallery-${slug}-${hash.slice(0, 16)}-${step}`;
  const agent = new RecordingCaller(caller);
  const projectId = slug;

  // 1. Create the project (replace an older version of the same reel).
  try {
    await agent.call('create_project', { manifest: entry.manifest, idempotencyKey: idem('create') });
  } catch (e) {
    if (!(e instanceof ToolError) || !/exist|conflict/i.test(e.code + e.message)) throw e;
    log(`${slug}: project exists, replacing it`);
    await agent.call('delete_project', { projectId });
    await agent.call('create_project', { manifest: entry.manifest, idempotencyKey: idem('create2') });
  }

  // 2. Music: a generated bed, uploaded as an asset and set as the music track.
  if (entry.gallery.music) {
    const wavBytes = musicWav(entry.gallery.music, entry.gallery.durationSeconds);
    await agent.call('upload_asset', {
      dataBase64: wavBytes.toString('base64'),
      filename: `${entry.gallery.music}.wav`,
      projectId,
      assetId: 'music',
      license: MUSIC_LICENSE,
    });
    await agent.call('set_audio', { projectId, audio: { music: { asset: 'music', volume: 0.55, fadeOutSeconds: 1.2 } } });
  }

  // 3. Validate, render, wait.
  const report = await agent.call('validate_project', { projectId });
  if (!report.ok) throw new Error(`${slug}: validate_project failed: ${JSON.stringify(report.errors).slice(0, 1000)}`);
  const started = Date.now();
  const { job } = await agent.call('render_project', { projectId, idempotencyKey: idem('render') });
  let status = job;
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  while (!['succeeded', 'failed', 'cancelled'].includes(status.status)) {
    if (Date.now() > deadline) throw new Error(`${slug}: render did not finish in time (job ${job.id})`);
    status = await agent.call('get_job', { jobId: job.id, waitSeconds: 45 });
  }
  const jobSeconds = (Date.now() - started) / 1000;
  if (status.status !== 'succeeded') {
    const logs = await agent.call('get_job_logs', { jobId: job.id, tail: 30 }).catch(() => ({ lines: [] }));
    throw new Error(`${slug}: render ${status.status}: ${JSON.stringify(status.error)}\n${(logs.lines ?? []).join('\n')}`);
  }

  // 4. Fetch the output: the signed MP4 link and the render manifest.
  const out = await agent.call('get_render_output', { jobId: job.id, includePoster: false });
  const dir = join(opts.outDir, slug);
  const tmpDir = `${dir}.tmp`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const auth = { Authorization: `Bearer ${opts.key}` };
  const abs = (u: string) => (u.startsWith('http') ? u : `${opts.studioUrl}${u}`);
  await download(abs(out.downloadUrl ?? out.outputUrl), join(tmpDir, 'final.mp4'), out.downloadUrl ? {} : auth);
  const rmUrl = out.manifestUrl ?? out.renderManifestUrl ?? `/v1/renders/${out.renderId}/render-manifest.json`;
  await download(abs(rmUrl), join(tmpDir, 'render-manifest.json'), auth);
  const rm = JSON.parse(readFileSync(join(tmpDir, 'render-manifest.json'), 'utf8'));

  // 5. Free the studio's disk: the reel lives in the gallery output now.
  await agent.call('delete_project', { projectId });

  const o = rm.output ?? {};
  const meta: Meta = {
    slug,
    title: entry.gallery.title,
    description: entry.gallery.description,
    category: entry.gallery.category,
    tags: entry.gallery.tags,
    engines: entry.gallery.engines,
    theme: entry.gallery.theme,
    palette: entry.gallery.palette,
    featured: entry.gallery.featured,
    music: entry.gallery.music,
    durationSeconds: o.durationSeconds ?? entry.gallery.durationSeconds,
    frames: o.frames ?? Math.round(entry.gallery.durationSeconds * 30),
    fps: o.fps ?? 30,
    width: o.width ?? 1080,
    height: o.height ?? 1920,
    renderSeconds: Math.round((rm.wallClockMillis ?? jobSeconds * 1000) / 100) / 10,
    jobSeconds: Math.round(jobSeconds * 10) / 10,
    hardware: hardwareSummary(),
    studioVersion: rm.versions?.server ?? 'unknown',
    engineVersions: rm.versions?.engines ?? {},
    ffmpeg: String(rm.versions?.ffmpeg ?? '').split('\n')[0] ?? '',
    renderedAt: rm.createdAt ?? new Date().toISOString(),
    manifestHash: hash,
    prompt: entry.gallery.prompt,
    toolsCalled: agent.tools(),
    mcpCalls: agent.calls.length,
    bytes: statSync(join(tmpDir, 'final.mp4')).size,
    checks: rm.checks ?? {},
  };
  writeFileSync(join(tmpDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmpDir, dir);
  return meta;
}

/** Run `work` over items with at most `n` in flight. */
export async function pool<T>(items: T[], n: number, work: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await work(items[i]!, i);
    }
  });
  await Promise.all(runners);
}

export interface RenderAllResult {
  rendered: string[];
  skipped: string[];
  failed: { slug: string; error: string }[];
}

export async function renderAll(caller: ToolCaller, entries: GalleryEntry[], opts: RenderOptions & { concurrency: number; force?: boolean }): Promise<RenderAllResult> {
  const log = opts.log ?? console.log;
  const res: RenderAllResult = { rendered: [], skipped: [], failed: [] };
  const todo = entries.filter((e) => {
    if (!opts.force && isDone(opts.outDir, e)) {
      res.skipped.push(e.gallery.slug);
      return false;
    }
    return true;
  });
  log(`gallery: ${todo.length} to render, ${res.skipped.length} already done`);
  let done = 0;
  await pool(todo, opts.concurrency, async (e) => {
    const t0 = Date.now();
    try {
      const m = await renderEntry(caller, e, opts);
      res.rendered.push(e.gallery.slug);
      log(`gallery: [${++done}/${todo.length}] ${e.gallery.slug} ok in ${((Date.now() - t0) / 1000).toFixed(0)} s (studio ${m.renderSeconds} s, ${m.engines.join('+')})`);
    } catch (err) {
      res.failed.push({ slug: e.gallery.slug, error: (err as Error).message.slice(0, 2000) });
      log(`gallery: [${++done}/${todo.length}] ${e.gallery.slug} FAILED: ${(err as Error).message.slice(0, 400)}`);
    }
  });
  // One retry, one at a time, for renders that failed (a crashed browser under load, a timeout).
  const retry = res.failed.splice(0);
  for (const f of retry) {
    const e = todo.find((x) => x.gallery.slug === f.slug)!;
    try {
      const m = await renderEntry(caller, e, opts);
      res.rendered.push(e.gallery.slug);
      log(`gallery: retry ${e.gallery.slug} ok (studio ${m.renderSeconds} s)`);
    } catch (err) {
      res.failed.push({ slug: e.gallery.slug, error: (err as Error).message.slice(0, 2000) });
      log(`gallery: retry ${e.gallery.slug} FAILED again: ${(err as Error).message.slice(0, 400)}`);
    }
  }
  return res;
}
