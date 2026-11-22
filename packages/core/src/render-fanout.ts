import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PipelineError, normaliseClip, streamParams, toolVersion, type StreamParams, type Tools } from '@reelforge/media-pipeline';
import { timeline, type Project, type ThemeTokens } from '@reelforge/project-schema';
import { JOIN_JOB_TYPE, UNIT_JOB_TYPE, type ChildSpec } from './fanout';
import type { JobContext } from './jobs';
import type { ResolvedAsset } from './plugins';
import type { PluginRegistry } from './registry';
import { finishRender, renderSceneClip, type RenderPipelineResult, type SceneClip } from './render';
import { renderPrefix, streamToBuffer, TEMP_RUN_PREFIX } from './storage/keys';
import type { StorageManager } from './storage/manager';
import type { Telemetry } from './telemetry';

/**
 * Render fan-out (D-097, #156): what a `render_unit` and the `render_join`
 * do. The queue side (parent → units → one join, leases, fencing, cascades)
 * is in jobs.ts and the repositories; this file renders one scene per unit and
 * stitches the units' clips in the join.
 *
 * Storage: each unit renders its scene, normalises it to the final encoding
 * (normaliseClip: the render's size, fps, yuv420p, H.264 high, exact frame
 * count, IDR at frame 0, video only) and uploads the clip and then a small
 * JSON manifest (last, so a manifest means a complete clip) to the run's
 * temporary prefix, `projects/<id>/renders/.tmp-<runId>/units/<NN>.mp4|json`.
 * The join reads every manifest, checks that every clip has the same stream
 * parameters and FFmpeg build, joins them with the concat demuxer and stream
 * copy (the video is encoded once, by the units), mixes the audio once over
 * the whole timeline, validates and commits the render as the single-worker
 * pipeline does (manifest last), then deletes the units. The
 * retention sweep removes the prefix of a run that is no longer queued or
 * running after `storage.retention.tempHours`; until then `retry_job` of a
 * failed render reuses the units it finds (same run id, project version,
 * scene and output).
 */
export { JOIN_JOB_TYPE, UNIT_JOB_TYPE };

export interface RenderJobParams {
  projectId: string;
  version: number;
  backend: string;
  runId: string;
  sceneIds?: string[];
  scale?: number;
}

export interface UnitJobParams extends RenderJobParams {
  /** Timeline index of the scene. */
  index: number;
  /** Scenes in the render. */
  count: number;
  sceneId: string;
  frames: number;
}

interface UnitManifest {
  kind: 'render-unit';
  runId: string;
  index: number;
  sceneId: string;
  projectVersion: number;
  frames: number;
  output: { width: number; height: number; fps: number };
  clip: Omit<SceneClip, 'file'>;
  /** The normalised clip's stream parameters and the FFmpeg that encoded it: every unit of a join must agree. */
  stream: StreamParams;
  ffmpeg: string;
  jobId: string;
  attempt: number;
  createdAt: string;
}

export interface FanOutDeps {
  storage: StorageManager;
  registry: PluginRegistry;
  tools(): Tools;
  cacheDir: string;
  serverVersion: string;
  telemetry: Telemetry;
  /** Local storage: where a project's renders live. */
  rendersDir(projectId: string): string;
  project(projectId: string, version: number): Promise<Project>;
  theme(project: Project): Promise<ThemeTokens>;
  assets(project: Project, projectId: string): Promise<Map<string, ResolvedAsset>>;
}

const pad = (n: number) => String(n).padStart(2, '0');
const runTempPrefix = (projectId: string, runId: string) => renderPrefix(projectId, TEMP_RUN_PREFIX + runId);
export const unitKey = (projectId: string, runId: string, index: number, ext: 'mp4' | 'json') => `${runTempPrefix(projectId, runId)}units/${pad(index + 1)}.${ext}`;

/** One unit per scene, longest first: the queue claims them in this order, so the slowest scene starts first. */
export function unitSpecs(p: RenderJobParams, project: Project): ChildSpec[] {
  const scenes = timeline(project);
  return scenes
    .map((s, index) => ({ s, index }))
    .sort((a, b) => b.s.durationFrames - a.s.durationFrames || a.index - b.index)
    .map(({ s, index }) => ({
      type: UNIT_JOB_TYPE,
      params: { projectId: p.projectId, version: p.version, backend: p.backend, runId: p.runId, index, count: scenes.length, sceneId: s.id, frames: s.durationFrames } satisfies UnitJobParams,
    }));
}

async function readManifest(storage: StorageManager, key: string): Promise<UnitManifest | null> {
  if (!(await storage.driver.stat(key))) return null;
  try {
    return JSON.parse((await streamToBuffer(await storage.driver.get(key))).toString('utf8')) as UnitManifest;
  } catch {
    return null;
  }
}

/** A unit already committed for this run (earlier attempt, or the render before a retry_job) that matches the scene. */
async function committedUnit(deps: FanOutDeps, p: UnitJobParams, output: UnitManifest['output']): Promise<UnitManifest | null> {
  const m = await readManifest(deps.storage, unitKey(p.projectId, p.runId, p.index, 'json'));
  if (!m || m.runId !== p.runId || m.index !== p.index || m.sceneId !== p.sceneId || m.projectVersion !== p.version || m.frames !== p.frames) return null;
  if (m.output.width !== output.width || m.output.height !== output.height || m.output.fps !== output.fps) return null;
  return (await deps.storage.driver.stat(unitKey(p.projectId, p.runId, p.index, 'mp4'))) ? m : null;
}

/** `render_unit`: render one scene and upload its clip, then its manifest, to the run's temporary prefix. */
export async function renderUnit(deps: FanOutDeps, ctx: JobContext): Promise<Record<string, unknown>> {
  const p = ctx.job.params as unknown as UnitJobParams;
  const project = await deps.project(p.projectId, p.version);
  const scene = timeline(project)[p.index];
  if (!scene || scene.id !== p.sceneId || scene.durationFrames !== p.frames) {
    throw new PipelineError('unit', `scene ${p.index + 1} of project ${p.projectId} version ${p.version} is not "${p.sceneId}" with ${p.frames} frames`);
  }
  const output = { width: project.output.width, height: project.output.height, fps: project.output.fps };
  const done = await committedUnit(deps, p, output);
  if (done) {
    ctx.log(`unit ${p.index + 1}/${p.count} (scene "${p.sceneId}") was already committed by job ${done.jobId}; reusing it`);
    ctx.progress('done', 1);
    return { index: p.index, sceneId: p.sceneId, frames: p.frames, clip: unitKey(p.projectId, p.runId, p.index, 'mp4'), reused: done.jobId };
  }
  const work = join(deps.storage.stagingRoot, p.projectId, `${TEMP_RUN_PREFIX}${p.runId}`, `unit-${pad(p.index + 1)}-${ctx.job.id}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    const clip = await renderSceneClip({
      runId: p.runId,
      theme: await deps.theme(project),
      assets: await deps.assets(project, p.projectId),
      registry: deps.registry,
      tools: deps.tools(),
      cacheDir: deps.cacheDir,
      signal: ctx.signal,
      log: ctx.log,
      telemetry: deps.telemetry,
      scene,
      output: project.output,
      out: join(work, 'engine.mp4'),
      workDir: join(work, 'work'),
      progress: (n, total) => ctx.progress('render', (0.85 * Math.min(n, total)) / Math.max(1, total), `${n}/${total} frames`),
    });
    if (ctx.signal.aborted) throw new PipelineError('unit', 'cancelled');
    // Normalise once here, so the join can stream-copy (D-097).
    ctx.progress('normalise', 0.87);
    const tools = deps.tools();
    const normalised = join(work, 'clip.mp4');
    await normaliseClip({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, input: clip.file, out: normalised, width: output.width, height: output.height, fps: output.fps, frames: p.frames, signal: ctx.signal });
    const stream = await streamParams(tools.ffprobe, normalised);
    ctx.progress('upload', 0.97);
    const clipKey = unitKey(p.projectId, p.runId, p.index, 'mp4');
    await deps.storage.driver.putFile(clipKey, normalised);
    const { file: _file, ...info } = clip;
    const manifest: UnitManifest = {
      kind: 'render-unit',
      runId: p.runId,
      index: p.index,
      sceneId: p.sceneId,
      projectVersion: p.version,
      frames: p.frames,
      output,
      clip: info,
      stream,
      ffmpeg: toolVersion(tools.ffmpeg),
      jobId: ctx.job.id,
      attempt: ctx.job.attempts ?? 1,
      createdAt: new Date().toISOString(),
    };
    // The manifest last: it marks the clip complete (a retry or the join trusts nothing without it).
    await deps.storage.driver.put(unitKey(p.projectId, p.runId, p.index, 'json'), Buffer.from(JSON.stringify(manifest, null, 2)), { contentType: 'application/json' });
    return { index: p.index, sceneId: p.sceneId, frames: p.frames, clip: clipKey, engine: clip.engine, millis: clip.millis };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface JoinResult extends RenderPipelineResult {
  /** Local storage: the render directory; remote: the storage prefix. */
  stored: string;
}

/**
 * `render_join`: fetch every unit's clip (checking its manifest), then
 * assemble, validate and commit the render exactly as the single-worker
 * pipeline does (finishRender; manifest last), and delete the units.
 */
export async function joinUnits(deps: FanOutDeps, ctx: JobContext): Promise<JoinResult> {
  const p = ctx.job.params as unknown as RenderJobParams;
  const pid = p.projectId;
  const project = await deps.project(pid, p.version);
  const scenes = timeline(project);
  const output = project.output;
  const local = deps.storage.isLocal;
  const rendersDir = local ? deps.rendersDir(pid) : join(deps.storage.stagingRoot, pid);
  // Local storage: this is also where the units are stored (the prefix's directory); the join works in a subdirectory.
  const runTmp = join(rendersDir, `${TEMP_RUN_PREFIX}${p.runId}`);
  const tmp = join(runTmp, 'join');
  const finalDir = join(rendersDir, p.runId);
  const started = Date.now();
  await rm(tmp, { recursive: true, force: true });
  await mkdir(join(tmp, 'clips'), { recursive: true });
  let res: RenderPipelineResult;
  try {
    const clips: SceneClip[] = [];
    const manifests: UnitManifest[] = [];
    for (const [i, scene] of scenes.entries()) {
      if (ctx.signal.aborted) throw new PipelineError('join', 'cancelled');
      const m = await readManifest(deps.storage, unitKey(pid, p.runId, i, 'json'));
      if (!m || m.sceneId !== scene.id || m.projectVersion !== p.version || m.frames !== scene.durationFrames) {
        throw new PipelineError('join', `unit ${i + 1}/${scenes.length} (scene "${scene.id}") has no matching manifest in the run's temporary storage`);
      }
      const file = join(tmp, 'clips', `${pad(i + 1)}-${scene.id}.mp4`);
      const key = unitKey(pid, p.runId, i, 'mp4');
      const direct = deps.storage.driver.localPath(key);
      if (direct) await copyFile(direct, file);
      else await pipeline(await deps.storage.driver.get(key), createWriteStream(file));
      clips.push({ ...m.clip, file, startFrame: scene.startFrame });
      manifests.push(m);
      ctx.progress('fetch', (0.1 * (i + 1)) / scenes.length, `unit ${i + 1}/${scenes.length}`);
    }
    // Stream copy needs the same streams in every clip ("same codecs, same time base, etc."): units from another FFmpeg
    // build or an older version re-encode in assemble() instead, which is slower but always correct.
    const differs = joinMismatch(manifests);
    if (differs) ctx.log(`join: ${differs}; re-encoding with the filter graph instead of stream copy`);
    res = await finishRender({
      streamCopy: !differs,
      input: {
        runId: p.runId,
        kind: 'render',
        project,
        projectVersion: p.version,
        theme: await deps.theme(project),
        assets: await deps.assets(project, pid),
        registry: deps.registry,
        tools: deps.tools(),
        rendersDir,
        cacheDir: deps.cacheDir,
        serverVersion: deps.serverVersion,
        signal: ctx.signal,
        log: ctx.log,
        progress: ctx.progress,
        telemetry: deps.telemetry,
      },
      tmp,
      finalDir,
      clips,
      fullTimeline: true,
      output,
      started,
    });
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  if (!local) {
    try {
      const up = await deps.storage.renders.commit(res.dir, pid, p.runId);
      ctx.log(`stored: ${up.objects} files, ${up.bytes} bytes in ${deps.storage.driver.id} storage`);
    } finally {
      await rm(res.dir, { recursive: true, force: true });
    }
  }
  // The render is committed: its units are no longer needed (the sweep would remove them later anyway).
  await removeUnits(deps, pid, p.runId).catch((e: Error) => ctx.log(`could not delete the units of ${p.runId} (the retention sweep removes them): ${e.message}`));
  if (!local) await rm(runTmp, { recursive: true, force: true });
  return { ...res, stored: local ? res.dir : renderPrefix(pid, p.runId) };
}

/** Why the units' clips cannot be joined by stream copy, or null when they can. */
function joinMismatch(ms: UnitManifest[]): string | null {
  const first = ms[0];
  if (!first) return 'no units';
  for (const m of ms) {
    if (!m.stream || !m.ffmpeg) return `unit ${m.index + 1} has no stream parameters (made by an older version)`;
    if (m.ffmpeg !== first.ffmpeg) return `unit ${m.index + 1} was encoded by another FFmpeg build (${m.ffmpeg} vs ${first.ffmpeg})`;
    const a = JSON.stringify(m.stream);
    const b = JSON.stringify(first.stream);
    if (a !== b) return `unit ${m.index + 1} has other stream parameters (${a} vs ${b})`;
    if (m.stream.otherStreams !== 0) return `unit ${m.index + 1} has more than a video stream`;
  }
  return null;
}

async function removeUnits(deps: FanOutDeps, projectId: string, runId: string) {
  const prefix = `${runTempPrefix(projectId, runId)}units/`;
  for (const o of await deps.storage.driver.list(prefix)) await deps.storage.driver.delete(o.key);
  if (deps.storage.isLocal) await rm(join(deps.rendersDir(projectId), `${TEMP_RUN_PREFIX}${runId}`), { recursive: true, force: true });
}
