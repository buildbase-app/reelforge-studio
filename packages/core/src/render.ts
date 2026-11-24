import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  PipelineError,
  assemble,
  assertDecodable,
  avDurations,
  checkExpectation,
  checkTimestamps,
  concatClips,
  encodersOf,
  formatSettings,
  encodeAudioOnly,
  probe,
  run,
  toolVersion,
  type Tools,
} from '@reelforge/media-pipeline';
import {
  fpsValue,
  framesToSeconds,
  SCHEMA_VERSION,
  timeline,
  formatSpec,
  type FormatSpec,
  toRenderScene,
  type CaptionMode,
  type OutputSettings,
  type Project,
  type RenderAudioOptions,
  type ThemeTokens,
  type TimelineScene,
} from '@reelforge/project-schema';
import { audioPass, resolveAudioPlan, verifyAudio, type AudioDefaults } from './audio';
import { captionPass } from './captions';
import { writeJsonAtomic } from './fsutil';
import { MP4_SPEC, checkFormatOutput, isAudioOnly, packageFormat, planFor } from './output-formats';
import type { Logger, ResolvedAsset } from './plugins';
import type { PluginRegistry } from './registry';
import { NOOP_TELEMETRY, coreInstruments, withSpan, type Telemetry } from './telemetry';

export interface RenderPipelineInput {
  runId: string;
  kind: 'render' | 'preview';
  project: Project;
  projectVersion: number;
  theme: ThemeTokens;
  assets: ReadonlyMap<string, ResolvedAsset>;
  registry: PluginRegistry;
  tools: Tools;
  /** <project>/renders */
  rendersDir: string;
  cacheDir: string;
  sceneIds?: string[];
  scale?: number;
  serverVersion: string;
  signal: AbortSignal;
  log: Logger;
  progress(stage: string, fraction: number, detail?: string): void;
  /** Spans for each engine render and FFmpeg step, render metrics (D-050). Default: none. */
  telemetry?: Telemetry;
  /** Overrides the manifest's `captions.mode` for this render (render_project's `captions`). */
  captionsMode?: CaptionMode;
  /** Overrides the manifest's audio toggles and loudness preset for this render (render_project's `audio`). */
  audio?: RenderAudioOptions;
  /** The server's `render.audio.*` settings (default: AUDIO_DEFAULTS). */
  audioDefaults?: AudioDefaults;
  /** The server's captions.defaultMode when the job was queued (projects without captions.mode). */
  captionsDefault?: CaptionMode;
  /** GIF output larger than this fails its check (render.formats.gifMaxBytes; 0: no limit). */
  gifMaxBytes?: number;
}

export interface RenderPipelineResult {
  runId: string;
  dir: string;
  outputFile: string;
  manifestFile: string;
  /** null for audio-only formats. */
  posterFile: string | null;
  durationSeconds: number;
  frames: number;
  width: number;
  height: number;
  /** Frames per second as a number (29.97002997 for NTSC 29.97). */
  fps: number;
  /** The exact rate ffprobe reports (r_frame_rate), e.g. "30000/1001". */
  frameRate: string;
}

/** One rendered scene clip, as recorded in the render manifest. */
export interface SceneClip {
  sceneId: string;
  file: string;
  frames: number;
  engine: string;
  template: string | null;
  startFrame: number;
  /** A chunk of a long scene (render fan-out, D-097): its first and last frame within the scene; `frames` and `startFrame` are the chunk's. */
  frameRange?: [number, number];
  engineVersion: string;
  browserVersion?: string;
  millis: number;
}

/** What renderSceneClip needs: one scene of the timeline, rendered to `out` at `output`. */
export interface SceneRenderInput extends Pick<RenderPipelineInput, 'runId' | 'theme' | 'assets' | 'registry' | 'tools' | 'cacheDir' | 'signal' | 'log' | 'telemetry'> {
  scene: TimelineScene;
  output: OutputSettings;
  out: string;
  workDir: string;
  /** Engine progress for this scene (or frame range). */
  progress(done: number, total: number): void;
  /** Only these frames of the scene, inclusive (a fan-out chunk; the engine must declare frame ranges). */
  frameRange?: readonly [number, number];
  /** brief.platform (safe areas, #287). */
  platform?: string;
  /** Keep a transparent background (#302): the engine must declare output.alpha; the clip is ProRes 4444 with alpha. */
  alpha?: boolean;
}

/**
 * Render one scene with its engine and check the clip (size, fps, at least
 * the scene's frames; pixel format and exact count are normalised later).
 * Used by the single-worker pipeline and by fan-out units (D-097).
 */
export async function renderSceneClip(input: SceneRenderInput): Promise<SceneClip> {
  const { scene, output, out, workDir, tools, log } = input;
  const { tracer, meter } = input.telemetry ?? NOOP_TELEMETRY;
  const metrics = coreInstruments(meter);
  const engine = input.registry.engine(scene.engine);
  const range = input.frameRange;
  const stage = `render:${scene.id}${range ? `[${range[0]}-${range[1]}]` : ''}`;
  if (range) {
    if (!engine.capabilities?.().frameRanges) throw new PipelineError(stage, `engine "${scene.engine}" does not render frame ranges`);
    if (input.alpha) throw new PipelineError(stage, 'a frame range cannot keep alpha (renders with alpha run on one worker)');
    if (!Number.isInteger(range[0]) || !Number.isInteger(range[1]) || range[0] < 0 || range[1] < range[0] || range[1] >= scene.durationFrames) {
      throw new PipelineError(stage, `frame range ${range[0]}-${range[1]} is not inside the scene's ${scene.durationFrames} frames`);
    }
  }
  if (input.alpha && engine.capabilities?.().output?.alpha !== true) throw new PipelineError(stage, `engine "${scene.engine}" cannot render a transparent background`);
  const frames = range ? range[1] - range[0] + 1 : scene.durationFrames;
  await mkdir(workDir, { recursive: true });
  // A cancel can land while the line above awaits: never hand an engine a signal that is already aborted (an engine
  // that only listens for the abort event would never hear it and run until the render timeout; #345).
  if (input.signal.aborted) throw new PipelineError(stage, 'cancelled');
  log(`${stage}: ${scene.engine}/${scene.template ?? 'html'} ${frames} frames${range ? ` (frames ${range[0]}-${range[1]} of ${scene.durationFrames})` : ''} at ${output.width}x${output.height}`);
  const engineAttrs = { 'reelforge.engine': scene.engine };
  const sceneStarted = Date.now();
  const res = await withSpan(
    tracer,
    `engine.render ${scene.engine}`,
    {
      ...engineAttrs,
      'reelforge.render.id': input.runId,
      'reelforge.scene.id': scene.id,
      'reelforge.scene.template': scene.template ?? 'html',
      'reelforge.scene.frames': frames,
      'reelforge.output.width': output.width,
      'reelforge.output.height': output.height,
      'reelforge.output.fps': fpsValue(output.fps),
    },
    () =>
      engine.render(toRenderScene(scene), {
        output,
        theme: input.theme,
        ...(input.platform ? { platform: input.platform } : {}),
        out,
        workDir,
        cacheDir: input.cacheDir,
        tools,
        assets: input.assets,
        signal: input.signal,
        log,
        progress: input.progress,
        ...(range ? { frameRange: [range[0], range[1]] as const } : {}),
        ...(input.alpha ? { alpha: true } : {}),
      })
  ).catch((e) => {
    metrics.sceneDuration.record((Date.now() - sceneStarted) / 1000, { ...engineAttrs, 'reelforge.outcome': 'error' });
    throw e;
  });
  const sceneSeconds = (Date.now() - sceneStarted) / 1000;
  metrics.sceneDuration.record(sceneSeconds, { ...engineAttrs, 'reelforge.outcome': 'ok' });
  metrics.framesRendered.add(frames, engineAttrs);
  if (sceneSeconds > 0) metrics.renderFps.record(frames / sceneSeconds, engineAttrs);
  const info = await withSpan(tracer, 'ffprobe clip', { 'reelforge.render.id': input.runId }, () => probe(tools.ffprobe, out));
  const problems = checkExpectation(info, {
    width: output.width,
    height: output.height,
    fps: output.fps,
    frames,
    ...(input.alpha ? { videoCodec: 'prores' } : {}),
  }).filter((p) => !p.startsWith('pixel format') && !p.startsWith('frame count')); // normalised during assembly
  if (input.alpha && !info.pixelFormat.startsWith('yuva')) problems.push(`clip has pixel format ${info.pixelFormat}, expected one with alpha (ProRes 4444)`);
  if (info.frames < frames) problems.push(`clip has ${info.frames} frames, needs ${frames}`);
  if (problems.length) throw new PipelineError(stage, problems.join('; '));
  log(`${stage}: done in ${(res.millis / 1000).toFixed(1)}s`);
  await rm(workDir, { recursive: true, force: true });
  return {
    sceneId: scene.id,
    file: out,
    frames,
    engine: scene.engine,
    template: scene.template ?? null,
    startFrame: scene.startFrame + (range ? range[0] : 0),
    ...(range ? { frameRange: [range[0], range[1]] as [number, number] } : {}),
    engineVersion: res.engineVersion,
    ...(res.browserVersion ? { browserVersion: res.browserVersion } : {}),
    millis: res.millis,
  };
}

const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);

/** Output settings for a preview: same fps, scaled size (even dimensions). */
export function scaledOutput(o: OutputSettings, scale = 1): OutputSettings {
  if (scale >= 1) return o;
  return { ...o, width: even(o.width * scale), height: even(o.height * scale) };
}

/**
 * The render pipeline: per-scene engine render → probe each clip → assemble
 * with music/voice/sfx → probe and decode the result → poster frame → render
 * manifest. Everything is written into `renders/.tmp-<runId>` and renamed to
 * `renders/<runId>` only when every check passed, so a failed or cancelled
 * run never replaces or corrupts a good output.
 */
export async function runRenderPipeline(input: RenderPipelineInput): Promise<RenderPipelineResult> {
  const { project, signal } = input;
  const output = scaledOutput(project.output, input.scale);
  const all = timeline(project);
  const scenes = input.sceneIds?.length ? all.filter((s) => input.sceneIds!.includes(s.id)) : all;
  if (scenes.length === 0) throw new PipelineError('setup', 'no scenes to render');

  const tmp = join(input.rendersDir, `.tmp-${input.runId}`);
  const finalDir = join(input.rendersDir, input.runId);
  // A worker that died mid-render (database queue, D-075) may have left this run's temp directory behind.
  await rm(tmp, { recursive: true, force: true });
  await mkdir(join(tmp, 'clips'), { recursive: true });
  const started = Date.now();
  // Output format (#302). Previews are always H.264 MP4 (quick review), whatever the manifest asks for.
  const spec = input.kind === 'preview' ? MP4_SPEC : formatSpec(project.output);

  try {
    // Audio only (m4a, wav): no scene is rendered; the mix covers the whole timeline.
    if (isAudioOnly(spec)) return await finishRender({ input, tmp, finalDir, clips: [], fullTimeline: scenes.length === all.length, output, started, spec, audioOnlyFrames: scenes.reduce((n, s) => n + s.durationFrames, 0) });
    const totalSceneFrames = scenes.reduce((n, s) => n + s.durationFrames, 0);
    let framesBefore = 0;
    const clips: SceneClip[] = [];

    for (const [i, scene] of scenes.entries()) {
      if (signal.aborted) throw new PipelineError('render', 'cancelled');
      const stage = `render:${scene.id}`;
      const out = join(tmp, 'clips', `${String(i + 1).padStart(2, '0')}-${scene.id}.${spec.alpha ? 'mov' : 'mp4'}`);
      input.progress(stage, (0.85 * framesBefore) / totalSceneFrames, `scene ${i + 1}/${scenes.length}`);
      clips.push(
        await renderSceneClip({
          ...input,
          scene,
          output,
          ...(project.brief?.platform ? { platform: project.brief.platform } : {}),
          out,
          ...(spec.alpha ? { alpha: true } : {}),
          workDir: join(tmp, 'work', scene.id),
          progress: (done, total) =>
            input.progress(stage, (0.85 * (framesBefore + Math.min(done, total))) / totalSceneFrames, `scene ${i + 1}/${scenes.length}: ${done}/${total} frames`),
        })
      );
      framesBefore += scene.durationFrames;
    }
    return await finishRender({ input, tmp, finalDir, clips, fullTimeline: scenes.length === all.length, output, started, spec });
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** The assembled-and-committed half of a render: inputs from the scene clips onwards. */
export interface FinishRenderInput {
  input: RenderPipelineInput;
  /** The run's working directory; renamed to `finalDir` when every check passed. */
  tmp: string;
  finalDir: string;
  /** Scene clips in timeline order (files inside `tmp`). */
  clips: SceneClip[];
  /** Every scene of the project (audio is mixed only then). */
  fullTimeline: boolean;
  output: OutputSettings;
  started: number;
  /**
   * Render fan-out (D-097): the clips are normalised to the final encoding, so
   * join them with the concat demuxer and stream copy (no re-encode) and check
   * the joined timestamps and A/V durations too. Unset: assemble() re-encodes.
   */
  streamCopy?: boolean;
  /** Output format (#302); default H.264 MP4. Other formats never use streamCopy. */
  spec?: FormatSpec;
  /** Audio-only formats: the timeline's frames (there are no clips). */
  audioOnlyFrames?: number;
}

/**
 * Assemble the clips with music/voice/sfx → probe and decode the result →
 * poster frame → render manifest (last) → rename `tmp` to `finalDir`. Shared
 * by the single-worker pipeline and the fan-out join (D-097). Leaves `tmp` in
 * place on failure (the caller removes it).
 */
export async function finishRender(f: FinishRenderInput): Promise<RenderPipelineResult> {
  const { input, tmp, finalDir, clips, fullTimeline, output, started } = f;
  const { project, tools, signal, log } = input;
  const { tracer } = input.telemetry ?? NOOP_TELEMETRY;
  const ffmpegSpan = <T>(name: string, fn: () => Promise<T>) => withSpan(tracer, name, { 'reelforge.render.id': input.runId }, fn);
  const rel = (p: string) => relative(tmp, p).split(sep).join('/');
  // Output format (#302): H.264 MP4 keeps the path below; others assemble a master with their encoder.
  const spec = f.spec ?? MP4_SPEC;
  const mp4 = spec.format === 'mp4';
  if (!mp4 && f.streamCopy) throw new PipelineError('assemble', 'only H.264 MP4 renders are joined by stream copy');
  const fmt = mp4 ? null : planFor(spec, await encodersOf(tools.ffmpeg));
  const outName = fmt?.file ?? 'final.mp4';
  const audioOnly = fmt?.kind === 'audio';

  // Audio (#301): one mix over the whole timeline, normalised, before assembly. Previews of a scene subset use silence.
  // GIF and PNG sequences carry no audio, so there is no mix (and no A/V or loudness check) for them.
  const totalFrames = audioOnly ? (f.audioOnlyFrames ?? 0) : clips.reduce((n, c) => n + c.frames, 0);
  const totalSeconds = framesToSeconds(totalFrames, output.fps);
  const audioPlan = resolveAudioPlan(project, input.audio, input.audioDefaults);
  input.progress('audio', 0.86);
  const audio = await ffmpegSpan('ffmpeg audio', () =>
    audioPass({ project, output, fullTimeline, totalSeconds, assets: input.assets, plan: audioPlan, tools, workDir: join(tmp, 'work', 'audio'), signal, log, ...(fmt && !fmt.audio ? { formatWithoutAudio: spec.format } : {}) })
  );
  if (audioOnly && audio.noAudio) {
    throw new PipelineError('audio', `a muted ${spec.format} render with render.audio.mutedTrack "none" has nothing to write; unmute it, or set render.audio.mutedTrack to "silent"`);
  }
  const { music, voice, sfx } = audio.manifest;
  const audioArgs = audio.noAudio ? { noAudio: true } : { audioFile: audio.file };

  input.progress('assemble', 0.87);
  const finalTmp = join(tmp, fmt?.master?.file ?? outName);
  log(`${f.streamCopy ? 'join (concat, video stream copy)' : 'assemble'}: ${clips.length} clips${music ? ' + music' : ''}${voice ? ' + voice' : ''}${sfx.length ? ` + ${sfx.length} sfx` : ''}`);
  const assembled = await ffmpegSpan(f.streamCopy ? 'ffmpeg join' : 'ffmpeg assemble', async () => fmt && !fmt.master
    ? { totalFrames, ...(await encodeAudioOnly({ ffmpeg: tools.ffmpeg, input: audio.file!, out: finalTmp, seconds: totalSeconds, codecArgs: spec.codec === 'aac' ? ['-c:a', 'aac', '-b:a', `${formatSettings().aacKbps}k`] : ['-c:a', 'pcm_s16le'], signal })) }
    : f.streamCopy
    ? concatClips({ ffmpeg: tools.ffmpeg, clips, out: finalTmp, fps: output.fps, listFile: join(tmp, 'concat.txt'), ...audioArgs, signal })
    : assemble({
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    clips,
    out: finalTmp,
    width: output.width,
    height: output.height,
    fps: output.fps,
    ...audioArgs,
    ...(fmt?.master ? { encoding: fmt.master } : {}),
    signal,
  }));

  // Captions (#300, D-107): sidecars next to final.mp4, and the libass burn-in pass over the assembled file.
  input.progress('captions', 0.9);
  const captions = await ffmpegSpan('captions', () =>
    captionPass(
      {
        project,
        assets: input.assets,
        theme: input.theme,
        output,
        ...(input.captionsMode ? { modeOverride: input.captionsMode } : {}),
        ...(input.captionsDefault ? { defaultMode: input.captionsDefault } : {}),
        ...(fullTimeline ? {} : { subset: clips }),
        durationSeconds: framesToSeconds(assembled.totalFrames, output.fps),
        dir: tmp,
        workDir: join(tmp, 'work', 'captions'),
        ...(fmt ? { encoding: fmt.master ? { video: fmt.master.video, alpha: spec.alpha } : null } : {}),
        tools,
        signal,
        log,
      },
      finalTmp
    )
  );

  input.progress('validate', 0.93);
  let info: { width: number; height: number; fps: number; frameRate: string; frames: number; durationSeconds: number } & Record<string, unknown>;
  let formatChecks: Record<string, string> | null = null;
  let packaging: string[] | undefined;
  let outputTmp = finalTmp;
  let poster: string | null = join(tmp, 'poster.png');
  const makePoster = (from: string, o: { frame?: number; width?: number; vp9Alpha?: boolean } = {}) =>
    ffmpegSpan('ffmpeg poster', () =>
      run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...(o.vp9Alpha ? ['-c:v', 'libvpx-vp9'] : []), '-i', from, '-vf', `select=eq(n\\,${o.frame ?? 0}),scale=${o.width ?? 270}:-2`, '-frames:v', '1', poster!], 'poster')
    );
  let posterFrame = 0;
  const problems: string[] = [];
  if (fmt) {
    // Other formats (#302): GIF / PNG zip from the master, then the format's own checks.
    const geometry = { width: output.width, height: output.height, fps: output.fps, frames: assembled.totalFrames };
    const pkg = await ffmpegSpan('ffmpeg package', () => packageFormat({ plan: fmt, tools, master: finalTmp, dir: tmp, workDir: join(tmp, 'work', 'format'), ...geometry, signal }));
    outputTmp = pkg.file;
    packaging = pkg.args;
    await mkdir(join(tmp, 'work', 'format'), { recursive: true });
    const fc = await ffmpegSpan('ffprobe output', () => checkFormatOutput({ plan: fmt, tools, pkg, workDir: join(tmp, 'work', 'format'), ...geometry, audio: !audio.noAudio, gifMaxBytes: input.gifMaxBytes ?? 0 }));
    problems.push(...fc.problems);
    info = fc.info;
    formatChecks = fc.checks;
    // Other formats' posters come from the middle frame (a first frame is often still empty, and MOV and PNG
    // sequences show it as their still in the dashboard) at 540 px; VP9 alpha needs libvpx to decode its alpha.
    posterFrame = Math.floor((fmt.kind === 'animation' ? pkg.frames : assembled.totalFrames) / 2);
    if (fmt.kind === 'audio') poster = null;
    else await makePoster(fmt.kind === 'image-sequence' ? finalTmp : outputTmp, { frame: posterFrame, width: 540, vp9Alpha: spec.codec === 'vp9' && spec.alpha });
    if (fmt.master && !fmt.master.final) await rm(finalTmp, { force: true });
  } else {
    const probed = await ffmpegSpan('ffprobe output', () => probe(tools.ffprobe, finalTmp));
    info = { ...probed };
    problems.push(
      ...checkExpectation(probed, {
        width: output.width,
        height: output.height,
        fps: output.fps,
        frames: assembled.totalFrames,
        audio: !audio.noAudio,
        // r_frame_rate exactly the manifest's rate (30000/1001, not 2997/100; #302).
        exactRate: true,
      })
    );
    const expectedSeconds = framesToSeconds(assembled.totalFrames, output.fps);
    if (Math.abs(probed.durationSeconds - expectedSeconds) > 1 / fpsValue(output.fps) + 0.001) {
      problems.push(`duration is ${probed.durationSeconds}s, expected ${expectedSeconds}s`);
    }
    if (!audio.noAudio && probed.audioCodec !== 'aac') problems.push(`audio codec is ${probed.audioCodec}, expected aac`);
    if (f.streamCopy) {
      // A stream-copy join: every frame exactly once, one frame apart (no duplicated or missing frame at a boundary), and audio as long as video.
      problems.push(...(await ffmpegSpan('ffprobe timestamps', () => checkTimestamps(tools.ffprobe, finalTmp, assembled.totalFrames, output.fps))));
      const d = await avDurations(tools.ffprobe, finalTmp);
      if ((d.audio === null && !audio.noAudio) || (d.audio !== null && Math.abs(d.audio - expectedSeconds) > 0.05) || Math.abs(d.video - expectedSeconds) > 0.001) {
        problems.push(`A/V durations are ${d.video}s video / ${d.audio}s audio, expected ${expectedSeconds}s`);
      }
    }
    await ffmpegSpan('ffmpeg decode check', () => assertDecodable(tools.ffmpeg, finalTmp));
  }
  // Audio after the final encode: A/V sync (always a failure) and loudness against the preset (render.audio.loudnessQa).
  // Formats without audio (GIF, PNG sequence) and muted renders without a track skip both; audio-only files have no
  // video to be in sync with, so only their loudness is checked.
  const audioQa = await ffmpegSpan('ffmpeg audio check', () => verifyAudio(tools, outputTmp, fpsValue(output.fps), audio.manifest, audioPlan.qa, signal, { sync: !audioOnly }));
  problems.push(...audioQa.syncProblems, ...audioQa.failures);
  if (problems.length) throw new PipelineError('validate:output', problems.join('; '));
  for (const issue of audioQa.manifest.qa?.issues ?? []) log(`audio qa (${issue.severity}): ${issue.message}`);

  if (!fmt) {

    // A small poster from the first frame (for agents and thumbnails).
    await makePoster(finalTmp);
  }

  const engineVersions: Record<string, string> = {};
  for (const c of clips) engineVersions[c.engine] = c.engineVersion;
  const browsers = [...new Set(clips.map((c) => c.browserVersion).filter(Boolean))];
  const manifest = {
    renderId: input.runId,
    kind: input.kind,
    projectId: project.projectId,
    projectVersion: input.projectVersion,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    wallClockMillis: Date.now() - started,
    output: fmt ? { file: outName, ...(poster ? { poster: 'poster.png', posterFrame } : {}), ...info } : { file: 'final.mp4', poster: 'poster.png', ...info },
    scenes: clips.map((c) => ({ ...c, file: rel(c.file) })),
    audio: audioQa.manifest,
    theme: input.theme,
    versions: {
      server: input.serverVersion,
      node: process.version,
      ffmpeg: toolVersion(tools.ffmpeg),
      ffprobe: toolVersion(tools.ffprobe),
      engines: engineVersions,
      browser: browsers.length ? browsers : ['(not reported)'],
    },
    ...(packaging ? { ffmpegPackageArgs: packaging.map((arg) => (arg.startsWith(tmp) ? rel(arg) : arg)) } : {}),
    ffmpegAssembleArgs: assembled.args.map((arg) => (arg.startsWith(tmp) ? rel(arg) : arg.includes(sep) && arg.startsWith('/') ? '<asset>' : arg)),
    ...(captions ? { captions: { ...captions, ...(captions.burnArgs ? { burnArgs: captions.burnArgs.map((arg) => (arg.startsWith(tmp) ? rel(arg) : arg)) } : {}) } } : {}),
    checks: {
      ...(formatChecks ?? { metadata: 'pass', decode: 'pass', duration: 'pass', ...(f.streamCopy ? { timestamps: 'pass', avDuration: 'pass' } : {}) }),
      avSync: audio.noAudio || audioOnly ? 'skipped' : 'pass',
      loudness: audioQa.manifest.loudness.measured ? (audioQa.manifest.qa?.issues.some((x) => x.rule !== 'loudness.lra') ? 'warn' : 'pass') : 'skipped',
    },
    ...(f.streamCopy ? { join: { method: 'concat demuxer, video stream copy', clips: clips.length } } : {}),
    project,
  };
  await writeJsonAtomic(join(tmp, 'render-manifest.json'), manifest);
  await rm(join(tmp, 'work'), { recursive: true, force: true });

  if (signal.aborted) throw new PipelineError('render', 'cancelled');
  // Never overwrite: run ids are unique, and an existing dir is an error.
  if (await stat(finalDir).then(() => true, () => false)) {
    throw new PipelineError('finalize', `output directory already exists: ${input.runId}`);
  }
  await rename(tmp, finalDir);
  input.progress('done', 1);
  log(`done: ${info.width}x${info.height} @ ${info.fps}fps, ${info.frames} frames, ${info.durationSeconds}s`);
  return {
    runId: input.runId,
    dir: finalDir,
    outputFile: join(finalDir, relative(tmp, outputTmp)),
    manifestFile: join(finalDir, 'render-manifest.json'),
    posterFile: poster ? join(finalDir, 'poster.png') : null,
    durationSeconds: info.durationSeconds,
    frames: info.frames,
    width: info.width,
    height: info.height,
    fps: info.fps,
    frameRate: info.frameRate,
  };
}
