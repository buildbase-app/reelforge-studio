import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  PipelineError,
  assemble,
  assertDecodable,
  checkExpectation,
  probe,
  run,
  toolVersion,
  type Tools,
} from '@reelforge/media-pipeline';
import {
  SCHEMA_VERSION,
  timeline,
  toRenderScene,
  type OutputSettings,
  type Project,
  type ThemeTokens,
} from '@reelforge/project-schema';
import { writeJsonAtomic } from './fsutil';
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
}

export interface RenderPipelineResult {
  runId: string;
  dir: string;
  outputFile: string;
  manifestFile: string;
  posterFile: string;
  durationSeconds: number;
  frames: number;
  width: number;
  height: number;
  fps: number;
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
  const { project, tools, signal, log } = input;
  const { tracer, meter } = input.telemetry ?? NOOP_TELEMETRY;
  const metrics = coreInstruments(meter);
  const ffmpegSpan = <T>(name: string, fn: () => Promise<T>) => withSpan(tracer, name, { 'reelforge.render.id': input.runId }, fn);
  const output = scaledOutput(project.output, input.scale);
  const all = timeline(project);
  const scenes = input.sceneIds?.length ? all.filter((s) => input.sceneIds!.includes(s.id)) : all;
  if (scenes.length === 0) throw new PipelineError('setup', 'no scenes to render');

  const tmp = join(input.rendersDir, `.tmp-${input.runId}`);
  const finalDir = join(input.rendersDir, input.runId);
  await mkdir(join(tmp, 'clips'), { recursive: true });
  const started = Date.now();
  const rel = (p: string) => relative(tmp, p).split(sep).join('/');

  try {
    const totalSceneFrames = scenes.reduce((n, s) => n + s.durationFrames, 0);
    let framesBefore = 0;
    const clips: Array<{
      sceneId: string;
      file: string;
      frames: number;
      engine: string;
      template: string | null;
      startFrame: number;
      engineVersion: string;
      browserVersion?: string;
      millis: number;
    }> = [];

    for (const [i, scene] of scenes.entries()) {
      if (signal.aborted) throw new PipelineError('render', 'cancelled');
      const engine = input.registry.engine(scene.engine);
      const stage = `render:${scene.id}`;
      const out = join(tmp, 'clips', `${String(i + 1).padStart(2, '0')}-${scene.id}.mp4`);
      const workDir = join(tmp, 'work', scene.id);
      await mkdir(workDir, { recursive: true });
      log(`${stage}: ${scene.engine}/${scene.template ?? 'html'} ${scene.durationFrames} frames at ${output.width}x${output.height}`);
      input.progress(stage, (0.85 * framesBefore) / totalSceneFrames, `scene ${i + 1}/${scenes.length}`);
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
          'reelforge.scene.frames': scene.durationFrames,
          'reelforge.output.width': output.width,
          'reelforge.output.height': output.height,
          'reelforge.output.fps': output.fps,
        },
        () =>
          engine.render(toRenderScene(scene), {
            output,
            theme: input.theme,
            out,
            workDir,
            cacheDir: input.cacheDir,
            tools,
            assets: input.assets,
            signal,
            log,
            progress: (done, total) =>
              input.progress(stage, (0.85 * (framesBefore + Math.min(done, total))) / totalSceneFrames, `scene ${i + 1}/${scenes.length}: ${done}/${total} frames`),
          })
      ).catch((e) => {
        metrics.sceneDuration.record((Date.now() - sceneStarted) / 1000, { ...engineAttrs, 'reelforge.outcome': 'error' });
        throw e;
      });
      const sceneSeconds = (Date.now() - sceneStarted) / 1000;
      metrics.sceneDuration.record(sceneSeconds, { ...engineAttrs, 'reelforge.outcome': 'ok' });
      metrics.framesRendered.add(scene.durationFrames, engineAttrs);
      if (sceneSeconds > 0) metrics.renderFps.record(scene.durationFrames / sceneSeconds, engineAttrs);
      const info = await ffmpegSpan('ffprobe clip', () => probe(tools.ffprobe, out));
      const problems = checkExpectation(info, {
        width: output.width,
        height: output.height,
        fps: output.fps,
        frames: scene.durationFrames,
      }).filter((p) => !p.startsWith('pixel format') && !p.startsWith('frame count')); // normalised during assembly
      if (info.frames < scene.durationFrames) problems.push(`clip has ${info.frames} frames, needs ${scene.durationFrames}`);
      if (problems.length) throw new PipelineError(stage, problems.join('; '));
      log(`${stage}: done in ${(res.millis / 1000).toFixed(1)}s`);
      clips.push({
        sceneId: scene.id,
        file: out,
        frames: scene.durationFrames,
        engine: scene.engine,
        template: scene.template ?? null,
        startFrame: scene.startFrame,
        engineVersion: res.engineVersion,
        ...(res.browserVersion ? { browserVersion: res.browserVersion } : {}),
        millis: res.millis,
      });
      framesBefore += scene.durationFrames;
      await rm(workDir, { recursive: true, force: true });
    }

    // Audio. Previews of a scene subset use silence: their timing differs.
    const fullTimeline = scenes.length === all.length;
    const audioFile = (id: string | undefined) => {
      if (!id) return undefined;
      const a = input.assets.get(id);
      if (!a) throw new PipelineError('assemble', `audio asset "${id}" is not available`);
      return a.file;
    };
    const a = project.audio;
    const music = fullTimeline && a.music ? { file: audioFile(a.music.asset)!, volume: a.music.volume, fadeOutSeconds: a.music.fadeOutSeconds } : null;
    const voice =
      fullTimeline && a.voice?.asset
        ? { file: audioFile(a.voice.asset)!, volume: a.voice.volume, startSeconds: a.voice.startFrame / output.fps }
        : null;
    const sfx = fullTimeline
      ? a.sfx.map((s) => ({ file: audioFile(s.asset)!, volume: s.volume, atSeconds: s.atFrame / output.fps }))
      : [];

    input.progress('assemble', 0.87);
    const finalTmp = join(tmp, 'final.mp4');
    log(`assemble: ${clips.length} clips${music ? ' + music' : ''}${voice ? ' + voice' : ''}${sfx.length ? ` + ${sfx.length} sfx` : ''}`);
    const assembled = await ffmpegSpan('ffmpeg assemble', () => assemble({
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      clips,
      out: finalTmp,
      width: output.width,
      height: output.height,
      fps: output.fps,
      music,
      voice,
      sfx,
      signal,
    }));

    input.progress('validate', 0.93);
    const info = await ffmpegSpan('ffprobe output', () => probe(tools.ffprobe, finalTmp));
    const problems = checkExpectation(info, {
      width: output.width,
      height: output.height,
      fps: output.fps,
      frames: assembled.totalFrames,
      audio: true,
    });
    const expectedSeconds = assembled.totalFrames / output.fps;
    if (Math.abs(info.durationSeconds - expectedSeconds) > 1 / output.fps + 0.001) {
      problems.push(`duration is ${info.durationSeconds}s, expected ${expectedSeconds}s`);
    }
    if (info.audioCodec !== 'aac') problems.push(`audio codec is ${info.audioCodec}, expected aac`);
    await ffmpegSpan('ffmpeg decode check', () => assertDecodable(tools.ffmpeg, finalTmp));
    if (problems.length) throw new PipelineError('validate:output', problems.join('; '));

    // A small poster from the first frame (for agents and thumbnails).
    const poster = join(tmp, 'poster.png');
    await ffmpegSpan('ffmpeg poster', () =>
      run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', finalTmp, '-vf', 'select=eq(n\\,0),scale=270:-2', '-frames:v', '1', poster], 'poster')
    );

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
      output: { file: 'final.mp4', poster: 'poster.png', ...info },
      scenes: clips.map((c) => ({ ...c, file: rel(c.file) })),
      audio: {
        music: music ? { asset: a.music!.asset, volume: music.volume } : null,
        voice: voice ? { asset: a.voice!.asset, volume: voice.volume, startSeconds: voice.startSeconds } : null,
        sfx: fullTimeline ? a.sfx : [],
        ...(fullTimeline ? {} : { note: 'preview of a scene subset: audio replaced by silence' }),
      },
      theme: input.theme,
      versions: {
        server: input.serverVersion,
        node: process.version,
        ffmpeg: toolVersion(tools.ffmpeg),
        ffprobe: toolVersion(tools.ffprobe),
        engines: engineVersions,
        browser: browsers.length ? browsers : ['(not reported)'],
      },
      ffmpegAssembleArgs: assembled.args.map((arg) => (arg.startsWith(tmp) ? rel(arg) : arg.includes(sep) && arg.startsWith('/') ? '<asset>' : arg)),
      checks: { metadata: 'pass', decode: 'pass', duration: 'pass' },
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
      outputFile: join(finalDir, 'final.mp4'),
      manifestFile: join(finalDir, 'render-manifest.json'),
      posterFile: join(finalDir, 'poster.png'),
      durationSeconds: info.durationSeconds,
      frames: info.frames,
      width: info.width,
      height: info.height,
      fps: info.fps,
    };
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
}
