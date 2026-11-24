import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PipelineError, normaliseClip, streamParams, toolVersion, type StreamParams, type Tools } from '@reelforge/media-pipeline';
import {
  timeline,
  type CaptionMode,
  type Project,
  type RenderAudioOptions,
  type ThemeTokens,
  type FrameRate,
} from '@reelforge/project-schema';
import type { AudioDefaults } from './audio';
import { describeUnit, JOIN_JOB_TYPE, UNIT_JOB_TYPE, type ChildSpec } from './fanout';
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
 * Chunks (`render.fanOut: scenes+chunks`, #156 step 3): a scene of at least
 * `render.chunkMinSceneSeconds` whose engine renders frame ranges
 * (EngineCapabilities.frameRanges, on a backend whose capabilities allow them)
 * becomes one unit per chunk of `render.chunkSeconds`. A chunk renders only
 * its frames (the scene keeps its full length, so a frame-pure engine draws
 * the same pixels as a whole render) and is normalised like any unit: its own
 * IDR first frame, the same encoding parameters, its exact frame count. The
 * plan (which scenes are split, and where) is stored on the render job when it
 * fans out, so the join (which gets a copy of the render's parameters) stitches
 * exactly the chunks that were queued, whatever the settings are by then.
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
  /** captions.mode override of this render (render_project's `captions`). */
  captions?: CaptionMode;
  /** Audio toggles and loudness preset of this render (render_project's `audio`). */
  audio?: RenderAudioOptions;
  /** The server's captions.defaultMode when the render was queued. */
  captionsDefault?: CaptionMode;
  /** Render this output variant of the project (#287): its size and platform replace `output`'s. */
  variant?: string;
  /** Renders started by one render_project call over the project's variants share this id. */
  batchId?: string;
  /**
   * Set when the render fans out: the scenes split into chunks, by timeline
   * index, each with its chunks' frame ranges (first, last, inclusive). Scenes
   * not listed are one unit. Read by the join.
   */
  chunks?: Record<string, Array<[number, number]>>;
}

export interface UnitJobParams extends RenderJobParams {
  /** Timeline index of the scene. */
  index: number;
  /** Scenes in the render. */
  count: number;
  sceneId: string;
  /** Frames this unit renders (the scene's, or its chunk's). */
  frames: number;
  /** A chunk: the scene's frames it renders, first and last inclusive. */
  range?: [number, number];
}

/** How long scenes are split (render.fanOut: scenes+chunks). */
export interface ChunkPolicy {
  /** Frames per chunk (render.chunkSeconds × fps). */
  chunkFrames: number;
  /** Scenes with fewer frames stay whole (render.chunkMinSceneSeconds × fps). */
  minSceneFrames: number;
  /** Whether this scene's engine (on this backend) renders frame ranges. */
  canSplit(scene: { engine: string }): boolean;
}

interface UnitManifest {
  kind: 'render-unit';
  runId: string;
  index: number;
  sceneId: string;
  projectVersion: number;
  frames: number;
  /** A chunk's frame range within the scene (absent: the whole scene). */
  range?: [number, number];
  output: { width: number; height: number; fps: FrameRate };
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
  /** The project version as rendered: with `variant`, at that variant's size (withVariant). */
  project(projectId: string, version: number, variant?: string): Promise<Project>;
  theme(project: Project): Promise<ThemeTokens>;
  assets(project: Project, projectId: string): Promise<Map<string, ResolvedAsset>>;
  /** The server's render.audio.* settings when the join runs. */
  audioDefaults?(): AudioDefaults;
}

const pad = (n: number) => String(n).padStart(2, '0');
const runTempPrefix = (projectId: string, runId: string) => renderPrefix(projectId, TEMP_RUN_PREFIX + runId);
/** `units/03.mp4` for a whole scene, `units/03.f120-239.mp4` for a chunk of it. */
export const unitKey = (projectId: string, runId: string, index: number, ext: 'mp4' | 'json', range?: readonly [number, number]) =>
  `${runTempPrefix(projectId, runId)}units/${pad(index + 1)}${range ? `.f${range[0]}-${range[1]}` : ''}.${ext}`;

/**
 * The chunks of a scene of `frames` frames: `chunkFrames` each, the last one
 * the rest; a rest under half a chunk joins the chunk before it (a browser
 * start and an encode for a handful of frames cost more than they save). One
 * range (the whole scene) when it does not split.
 */
export function chunkRanges(frames: number, chunkFrames: number): Array<[number, number]> {
  const size = Math.max(1, Math.floor(chunkFrames));
  const n = Math.max(1, Math.round(frames / size));
  return Array.from({ length: n }, (_, k): [number, number] => [k * size, k === n - 1 ? frames - 1 : (k + 1) * size - 1]);
}

/** The render's plan: which scenes split into which frame ranges (none without a policy). */
export function planChunks(project: Project, policy: ChunkPolicy | null): Record<string, Array<[number, number]>> {
  const chunks: Record<string, Array<[number, number]>> = {};
  if (!policy) return chunks;
  timeline(project).forEach((s, index) => {
    if (s.durationFrames < policy.minSceneFrames || !policy.canSplit(s)) return;
    const ranges = chunkRanges(s.durationFrames, policy.chunkFrames);
    if (ranges.length > 1) chunks[String(index)] = ranges;
  });
  return chunks;
}

/**
 * One unit per scene, or per chunk of a split scene (`chunks`, from
 * planChunks), longest first: the queue claims them in this order, so the
 * slowest unit starts first.
 */
export function unitSpecs(p: RenderJobParams, project: Project, chunks: Record<string, Array<[number, number]>> = {}): ChildSpec[] {
  const scenes = timeline(project);
  return scenes
    .flatMap((s, index) => (chunks[String(index)] ?? [null]).map((range) => ({ s, index, range, frames: range ? range[1] - range[0] + 1 : s.durationFrames })))
    .sort((a, b) => b.frames - a.frames || a.index - b.index || (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0))
    .map(({ s, index, range, frames }) => ({
      type: UNIT_JOB_TYPE,
      params: {
        projectId: p.projectId,
        version: p.version,
        backend: p.backend,
        runId: p.runId,
        ...(p.variant ? { variant: p.variant } : {}),
        index,
        count: scenes.length,
        sceneId: s.id,
        frames,
        ...(range ? { range } : {}),
      } satisfies UnitJobParams,
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
  const m = await readManifest(deps.storage, unitKey(p.projectId, p.runId, p.index, 'json', p.range));
  if (!m || m.runId !== p.runId || m.index !== p.index || m.sceneId !== p.sceneId || m.projectVersion !== p.version || m.frames !== p.frames) return null;
  if (!sameRange(m.range, p.range)) return null;
  if (m.output.width !== output.width || m.output.height !== output.height || m.output.fps !== output.fps) return null;
  return (await deps.storage.driver.stat(unitKey(p.projectId, p.runId, p.index, 'mp4', p.range))) ? m : null;
}

const sameRange = (a?: readonly [number, number], b?: readonly [number, number]) => (a?.[0] ?? -1) === (b?.[0] ?? -1) && (a?.[1] ?? -1) === (b?.[1] ?? -1);

/** `render_unit`: render one scene (or one chunk of it) and upload its clip, then its manifest, to the run's temporary prefix. */
export async function renderUnit(deps: FanOutDeps, ctx: JobContext): Promise<Record<string, unknown>> {
  const p = ctx.job.params as unknown as UnitJobParams;
  const project = await deps.project(p.projectId, p.version, p.variant);
  const scene = timeline(project)[p.index];
  const matches =
    scene?.id === p.sceneId &&
    (p.range ? p.range[0] >= 0 && p.range[1] < scene.durationFrames && p.range[1] - p.range[0] + 1 === p.frames : scene.durationFrames === p.frames);
  if (!scene || !matches) {
    throw new PipelineError('unit', `scene ${p.index + 1} of project ${p.projectId} version ${p.version} is not "${p.sceneId}" with ${p.range ? `frames ${p.range[0]}-${p.range[1]}` : `${p.frames} frames`}`);
  }
  const what = describeUnit(p as unknown as Record<string, unknown>, ctx.job.id);
  const output = { width: project.output.width, height: project.output.height, fps: project.output.fps };
  const clipKey = unitKey(p.projectId, p.runId, p.index, 'mp4', p.range);
  const done = await committedUnit(deps, p, output);
  if (done) {
    ctx.log(`${what} was already committed by job ${done.jobId}; reusing it`);
    ctx.progress('done', 1);
    return { index: p.index, sceneId: p.sceneId, frames: p.frames, ...(p.range ? { range: p.range } : {}), clip: clipKey, reused: done.jobId };
  }
  const work = join(deps.storage.stagingRoot, p.projectId, `${TEMP_RUN_PREFIX}${p.runId}`, `unit-${pad(p.index + 1)}${p.range ? `-f${p.range[0]}` : ''}-${ctx.job.id}`);
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
      ...(project.brief?.platform ? { platform: project.brief.platform } : {}),
      out: join(work, 'engine.mp4'),
      workDir: join(work, 'work'),
      progress: (n, total) => ctx.progress('render', (0.85 * Math.min(n, total)) / Math.max(1, total), `${n}/${total} frames`),
      ...(p.range ? { frameRange: p.range } : {}),
    });
    if (ctx.signal.aborted) throw new PipelineError('unit', 'cancelled');
    // Normalise once here, so the join can stream-copy (D-097).
    ctx.progress('normalise', 0.87);
    const tools = deps.tools();
    const normalised = join(work, 'clip.mp4');
    await normaliseClip({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, input: clip.file, out: normalised, width: output.width, height: output.height, fps: output.fps, frames: p.frames, signal: ctx.signal });
    const stream = await streamParams(tools.ffprobe, normalised);
    ctx.progress('upload', 0.97);
    await deps.storage.driver.putFile(clipKey, normalised);
    const { file: _file, ...info } = clip;
    const manifest: UnitManifest = {
      kind: 'render-unit',
      runId: p.runId,
      index: p.index,
      sceneId: p.sceneId,
      projectVersion: p.version,
      frames: p.frames,
      ...(p.range ? { range: p.range } : {}),
      output,
      clip: info,
      stream,
      ffmpeg: toolVersion(tools.ffmpeg),
      jobId: ctx.job.id,
      attempt: ctx.job.attempts ?? 1,
      createdAt: new Date().toISOString(),
    };
    // The manifest last: it marks the clip complete (a retry or the join trusts nothing without it).
    await deps.storage.driver.put(unitKey(p.projectId, p.runId, p.index, 'json', p.range), Buffer.from(JSON.stringify(manifest, null, 2)), { contentType: 'application/json' });
    return { index: p.index, sceneId: p.sceneId, frames: p.frames, ...(p.range ? { range: p.range } : {}), clip: clipKey, engine: clip.engine, millis: clip.millis };
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
  const project = await deps.project(pid, p.version, p.variant);
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
    // The units the render queued: one per scene, or one per chunk of a scene the plan split.
    const units = scenes.flatMap((scene, i) => (p.chunks?.[String(i)] ?? [null]).map((range) => ({ scene, i, range })));
    for (const [n, { scene, i, range }] of units.entries()) {
      if (ctx.signal.aborted) throw new PipelineError('join', 'cancelled');
      const frames = range ? range[1] - range[0] + 1 : scene.durationFrames;
      const what = `unit ${i + 1}/${scenes.length} (scene "${scene.id}"${range ? `, frames ${range[0]}-${range[1]}` : ''})`;
      const m = await readManifest(deps.storage, unitKey(pid, p.runId, i, 'json', range ?? undefined));
      if (!m || m.sceneId !== scene.id || m.projectVersion !== p.version || m.frames !== frames || !sameRange(m.range, range ?? undefined) || (range && range[1] >= scene.durationFrames)) {
        throw new PipelineError('join', `${what} has no matching manifest in the run's temporary storage`);
      }
      const file = join(tmp, 'clips', `${pad(i + 1)}-${scene.id}${range ? `.f${range[0]}-${range[1]}` : ''}.mp4`);
      const key = unitKey(pid, p.runId, i, 'mp4', range ?? undefined);
      const direct = deps.storage.driver.localPath(key);
      if (direct) await copyFile(direct, file);
      else await pipeline(await deps.storage.driver.get(key), createWriteStream(file));
      clips.push({ ...m.clip, file, frames, startFrame: scene.startFrame + (range ? range[0] : 0), ...(range ? { frameRange: range } : {}) });
      manifests.push(m);
      ctx.progress('fetch', (0.1 * (n + 1)) / units.length, `unit ${n + 1}/${units.length}`);
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
        ...(p.captions ? { captionsMode: p.captions } : {}),
        ...(p.audio ? { audio: p.audio } : {}),
        ...(deps.audioDefaults ? { audioDefaults: deps.audioDefaults() } : {}),
        ...(p.captionsDefault ? { captionsDefault: p.captionsDefault } : {}),
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
    const u = `unit ${m.index + 1}${m.range ? ` (frames ${m.range[0]}-${m.range[1]})` : ''}`;
    if (!m.stream || !m.ffmpeg) return `${u} has no stream parameters (made by an older version)`;
    if (m.ffmpeg !== first.ffmpeg) return `${u} was encoded by another FFmpeg build (${m.ffmpeg} vs ${first.ffmpeg})`;
    const a = JSON.stringify(m.stream);
    const b = JSON.stringify(first.stream);
    if (a !== b) return `${u} has other stream parameters (${a} vs ${b})`;
    if (m.stream.otherStreams !== 0) return `${u} has more than a video stream`;
  }
  return null;
}

async function removeUnits(deps: FanOutDeps, projectId: string, runId: string) {
  const prefix = `${runTempPrefix(projectId, runId)}units/`;
  for (const o of await deps.storage.driver.list(prefix)) await deps.storage.driver.delete(o.key);
  if (deps.storage.isLocal) await rm(join(deps.rendersDir(projectId), `${TEMP_RUN_PREFIX}${runId}`), { recursive: true, force: true });
}
