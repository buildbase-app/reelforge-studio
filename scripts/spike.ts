/**
 * Feasibility spike (docs/START_HERE_FOR_CODING_AGENT.md, Task 1):
 * render one Remotion scene and one Motion Canvas scene from a manifest,
 * assemble them into one 9:16 MP4, and validate the result. No AI API key.
 *
 *   pnpm spike [path/to/project.json]
 *
 * Writes out/<projectId>/final.mp4, per-scene clips, review frames around each
 * cut, and render-manifest.json recording inputs, versions and checks.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderMotionCanvasScene } from '@reelforge/engine-motion-canvas';
import { renderRemotionScene } from '@reelforge/engine-remotion';
import {
  PipelineError,
  assemble,
  assertDecodable,
  checkExpectation,
  extractFrames,
  probe,
  resolveTools,
  toolVersion,
} from '@reelforge/media-pipeline';
import { fpsValue, framesToSeconds, parseProject, timeline, totalFrames } from '@reelforge/project-schema';

const manifestPath = resolve(process.argv[2] ?? 'examples/sample-reel.json');
const cacheDir = resolve('.render-cache');

function log(stage: string, msg: string) {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${stage.padEnd(22)} ${msg}`);
}

async function main() {
  const parsed = parseProject(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (!parsed.ok) {
    for (const i of parsed.issues) console.error(`  ${i.path}: ${i.message}`);
    throw new PipelineError('validate', `${manifestPath} is not a valid project`);
  }
  const project = parsed.project;
  for (const w of parsed.warnings) log('validate', `warning ${w.path}: ${w.message}`);
  log('validate', `ok: ${project.scenes.length} scenes, ${totalFrames(project)} frames`);

  const tools = resolveTools();
  const outDir = resolve('out', project.projectId);
  mkdirSync(join(outDir, 'clips'), { recursive: true });
  mkdirSync(join(outDir, 'review'), { recursive: true });

  const scenes = timeline(project);
  const clips: { sceneId: string; file: string; frames: number; engine: string; millis: number }[] = [];
  for (const scene of scenes) {
    const out = join(outDir, 'clips', `${String(clips.length + 1).padStart(2, '0')}-${scene.id}.mp4`);
    const stage = `render:${scene.id}`;
    log(stage, `${scene.engine}/${scene.template}, ${scene.durationFrames} frames`);
    const progress = (d: number, t: number) => {
      if (d === t || d % 60 === 0) log(stage, `${d}/${t}`);
    };
    const result =
      scene.engine === 'remotion'
        ? await renderRemotionScene({ scene, output: project.output, out, cacheDir, onProgress: progress })
        : await renderMotionCanvasScene({
            scene,
            output: project.output,
            out,
            cacheDir,
            ffmpeg: tools.ffmpeg,
            onProgress: progress,
          });
    const info = await probe(tools.ffprobe, out);
    const problems = checkExpectation(info, {
      width: project.output.width,
      height: project.output.height,
      fps: project.output.fps,
      frames: scene.durationFrames,
    }).filter((p) => !p.startsWith('pixel format')); // clips are normalised during assembly
    if (problems.length) throw new PipelineError(stage, problems.join('; '));
    log(stage, `done in ${(result.millis / 1000).toFixed(1)}s (${info.pixelFormat})`);
    clips.push({ sceneId: scene.id, file: out, frames: scene.durationFrames, engine: scene.engine, millis: result.millis });
  }

  const final = join(outDir, 'final.mp4');
  log('assemble', `${clips.length} clips -> ${final}`);
  const assembled = await assemble({
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    clips,
    out: final,
    width: project.output.width,
    height: project.output.height,
    fps: project.output.fps,
    music: null,
  });

  log('validate:output', 'probing and decoding');
  const info = await probe(tools.ffprobe, final);
  const problems = checkExpectation(info, {
    width: project.output.width,
    height: project.output.height,
    fps: project.output.fps,
    frames: assembled.totalFrames,
    audio: true,
  });
  const expectedSeconds = framesToSeconds(assembled.totalFrames, project.output.fps);
  if (Math.abs(info.durationSeconds - expectedSeconds) > 1 / fpsValue(project.output.fps)) {
    problems.push(`duration is ${info.durationSeconds}s, expected ${expectedSeconds}s`);
  }
  await assertDecodable(tools.ffmpeg, final);
  if (problems.length) throw new PipelineError('validate:output', problems.join('; '));

  // Frames either side of every cut, plus first and last, for human review.
  const reviewFrames = new Set<number>([0, assembled.totalFrames - 1]);
  for (const s of scenes.slice(1)) {
    reviewFrames.add(s.startFrame - 1);
    reviewFrames.add(s.startFrame);
  }
  const review = await extractFrames(tools.ffmpeg, final, [...reviewFrames].sort((a, b) => a - b), (f) =>
    join(outDir, 'review', `frame-${String(f).padStart(5, '0')}.png`)
  );

  const report = {
    project: project.projectId,
    manifest: manifestPath,
    createdAt: new Date().toISOString(),
    output: { file: final, ...info },
    scenes: clips.map((c) => ({ ...c, file: c.file.replace(outDir + '/', '') })),
    reviewFrames: review.map((f) => f.replace(outDir + '/', '')),
    tools: {
      node: process.version,
      ffmpeg: toolVersion(tools.ffmpeg),
      chromium: process.env.REELFORGE_CHROMIUM_PATH ?? '(engine default)',
    },
    ffmpegAssembleArgs: assembled.args,
    checks: { metadata: 'pass', decode: 'pass' },
  };
  writeFileSync(join(outDir, 'render-manifest.json'), JSON.stringify(report, null, 2) + '\n');
  log('done', `${final} (${info.width}x${info.height} @ ${info.fps}fps, ${info.frames} frames, ${info.durationSeconds}s, ${info.videoCodec}/${info.audioCodec})`);
}

main().catch((e) => {
  if (e instanceof PipelineError) {
    console.error(`\nFAILED at stage "${e.stage}": ${e.message}`);
    if (e.log) console.error(e.log);
  } else {
    console.error(e);
  }
  process.exit(1);
});
