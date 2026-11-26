import { open, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_ZIP_ENTRIES,
  alphaStats,
  assertDecodable,
  av1EncoderFrom,
  checkExpectation,
  encodeGif,
  encodePngZip,
  formatPlan,
  gifGeometry,
  missingEncoders,
  probe,
  probeAudio,
  rateFraction,
  zipEntries,
  zipPngHeader,
  type FormatPlan,
  type Tools,
} from '@renderweld/media-pipeline';
import {
  AUDIO_ONLY_FORMATS,
  formatSpec,
  fpsValue,
  framesToSeconds,
  resolveCaptions,
  totalFrames,
  withVariant,
  type CaptionMode,
  type FormatSpec,
  type FrameRate,
  type Project,
} from '@renderweld/project-schema';
import type { PluginRegistry } from './registry';

/**
 * Output formats beyond H.264 MP4 (#302, D-123): what a server can render
 * (refused with `422 unsupported_output` before a job is queued), and the
 * format half of a render (packaging and per-format QA) used by render.ts.
 */

/** The delivered file of any format (render outputs a server serves). */
export const OUTPUT_FILE_PATTERN = /^(final\.(mp4|mov|webm|gif|m4a|wav)|frames\.zip)$/;

export const MP4_SPEC: FormatSpec = Object.freeze({ format: 'mp4', codec: 'h264', alpha: false });

export const isAudioOnly = (s: FormatSpec) => AUDIO_ONLY_FORMATS.includes(s.format);

export interface OutputFormatIssue {
  /** `output.format`, `output.alpha`, `variants.<i>.format`, ... */
  path: string;
  variant: string | null;
  engine: string | null;
  message: string;
}

/** What the checks need from the server: its FFmpeg and limits. */
export interface FormatCheckContext {
  encoders: Set<string>;
  /** libass can draw into an alpha channel (assHasAlpha). */
  assAlpha: boolean;
  /** render.formats.gifMaxSeconds */
  gifMaxSeconds: number;
  /** The render's captions override and the server default (resolveCaptions). */
  captionsMode?: CaptionMode;
  captionsDefault?: CaptionMode;
}

/** Whether a project has any audio to put in an audio-only file. */
export function hasProjectAudio(p: Project): boolean {
  return Boolean(p.audio.music || p.audio.voice?.asset || p.audio.sfx.length);
}

/**
 * Every reason the project (output, and each variant, or only `variant`)
 * cannot be rendered in its format on this server: engines without alpha,
 * encoders this FFmpeg lacks, audio-only without audio or with burned
 * captions, GIF over its length limit, PNG sequences over a zip's entries.
 * H.264 MP4 has no checks here.
 */
export function outputFormatIssues(project: Project, registry: PluginRegistry, ctx: FormatCheckContext, opts: { variant?: string | null } = {}): OutputFormatIssue[] {
  const targets: Array<{ path: string; variant: string | null; p: Project }> = [];
  if (opts.variant === undefined || opts.variant === null) targets.push({ path: 'output', variant: null, p: project });
  project.variants?.forEach((v, i) => {
    if (opts.variant === undefined || opts.variant === v.id) targets.push({ path: `variants.${i}`, variant: v.id, p: withVariant(project, v.id) });
  });
  const out: OutputFormatIssue[] = [];
  for (const t of targets) {
    const spec = formatSpec(t.p.output);
    if (spec.format === 'mp4') continue;
    const where = t.variant ? `variant "${t.variant}" (${spec.format}/${spec.codec})` : `output (${spec.format}/${spec.codec})`;
    const add = (field: string, message: string, engine: string | null = null) => out.push({ path: `${t.path}.${field}`, variant: t.variant, engine, message: `${where}: ${message}` });
    const plan = formatPlan(spec, { av1Encoder: av1EncoderFrom(ctx.encoders) ?? undefined });
    const missing = missingEncoders(plan, ctx.encoders);
    if (missing.length) add('codec', `this server's FFmpeg has no ${missing.join(', ')} encoder; install an FFmpeg built with it (\`ffmpeg -encoders\`) or choose another format`);
    if (spec.alpha) {
      const engines = [...new Set(t.p.scenes.map((s) => s.engine))];
      const capable = registry.listEngines().filter((e) => e.capabilities?.().output?.alpha).map((e) => e.id);
      for (const id of engines) {
        let ok = false;
        try {
          ok = registry.engine(id).capabilities?.().output?.alpha === true;
        } catch {
          continue; // unknown engine: the schema reports it
        }
        if (!ok) add('alpha', `engine "${id}" cannot render a transparent background (engines that can: ${capable.join(', ') || 'none'}); set alpha to false or use those engines`, id);
      }
    }
    const captions = resolveCaptions(t.p, { ...(ctx.captionsMode ? { mode: ctx.captionsMode } : {}), ...(ctx.captionsDefault ? { defaultMode: ctx.captionsDefault } : {}) }).mode;
    const burns = captions === 'burned' || captions === 'both';
    if (isAudioOnly(spec)) {
      if (!hasProjectAudio(t.p)) add('format', 'the project has no audio to export: set audio.music, audio.voice (with an asset) or audio.sfx');
      if (burns) add('format', `captions mode "${captions}" burns captions into pictures, and ${spec.format} has none; use captions mode "sidecar" (SRT, WebVTT and ASS files are written next to the audio)`);
    }
    if (burns && spec.alpha && !ctx.assAlpha) add('alpha', "this server's FFmpeg cannot burn captions into an alpha channel (libass `alpha` option, FFmpeg 5 or newer); use captions mode \"sidecar\"");
    const frames = totalFrames(t.p);
    const seconds = framesToSeconds(frames, t.p.output.fps);
    if (spec.format === 'gif' && seconds > ctx.gifMaxSeconds) add('format', `the video is ${seconds.toFixed(2)} s; GIF output is limited to ${ctx.gifMaxSeconds} s on this server (render.formats.gifMaxSeconds); use webm or mp4 for longer videos`);
    if (spec.format === 'png-sequence' && frames > MAX_ZIP_ENTRIES) add('format', `${frames} frames is more than one zip holds (${MAX_ZIP_ENTRIES}); render a shorter project or another format`);
  }
  return out;
}

/** The plan for a render's format on this FFmpeg (AV1: the encoder it has). */
export function planFor(spec: FormatSpec, encoders: Set<string>): FormatPlan {
  return formatPlan(spec, { av1Encoder: av1EncoderFrom(encoders) ?? undefined });
}

export interface PackageResult {
  /** The delivered file. */
  file: string;
  /** FFmpeg arguments of the packaging step (GIF, PNG frames), for the render manifest. */
  args?: string[];
  /** GIF frames / zip entries the delivered file must hold. */
  frames: number;
  /** GIF size and rate (`rate`: exact, e.g. "30000/1001" when the project's is kept). */
  width?: number;
  height?: number;
  fps?: number;
  rate?: string;
}

/** GIF and PNG sequences: make the delivered file from the master. MOV and WebM: the master is the file. */
export async function packageFormat(o: { plan: FormatPlan; tools: Tools; master: string; dir: string; workDir: string; width: number; height: number; fps: FrameRate; frames: number; signal?: AbortSignal }): Promise<PackageResult> {
  const file = join(o.dir, o.plan.file);
  const seconds = framesToSeconds(o.frames, o.fps);
  if (o.plan.kind === 'animation') {
    const g = gifGeometry(o.width, o.height, o.fps);
    const r = await encodeGif({ ffmpeg: o.tools.ffmpeg, master: o.master, out: file, width: o.width, height: o.height, fps: o.fps, frames: o.frames, seconds, ...(o.signal ? { signal: o.signal } : {}) });
    return { file, args: r.args, frames: r.frames, width: g.width, height: g.height, fps: g.fps, rate: g.rate };
  }
  if (o.plan.kind === 'image-sequence') {
    const r = await encodePngZip({ ffmpeg: o.tools.ffmpeg, master: o.master, out: file, workDir: join(o.workDir, 'frames'), alpha: o.plan.spec.alpha, frames: o.frames, ...(o.signal ? { signal: o.signal } : {}) });
    return { file, args: r.args, frames: r.entries };
  }
  return { file: o.master, frames: o.frames };
}

export interface FormatCheck {
  /** Probed facts for the render manifest's output. */
  info: Record<string, unknown> & { width: number; height: number; fps: number; frameRate: string; frames: number; durationSeconds: number };
  problems: string[];
  checks: Record<string, string>;
}

/**
 * Per-format QA of the delivered file (#302): ffprobe codec, profile, pixel
 * format, alpha plane, frame count, duration and audio present or absent;
 * GIF size limit; PNG zip entries and headers. Then a full decode.
 */
export async function checkFormatOutput(o: {
  plan: FormatPlan;
  tools: Tools;
  pkg: PackageResult;
  workDir: string;
  width: number;
  height: number;
  fps: FrameRate;
  frames: number;
  /** Whether the file carries audio: the format's (plan.audio), unless a muted render has no track (render.audio.mutedTrack "none"). */
  audio?: boolean;
  gifMaxBytes: number;
}): Promise<FormatCheck> {
  const { plan, tools, pkg } = o;
  const { spec, expect } = plan;
  const seconds = framesToSeconds(o.frames, o.fps);
  const fps = fpsValue(o.fps);
  const frameRate = rateFraction(o.fps);
  const withAudio = plan.audio && o.audio !== false;
  const problems: string[] = [];
  const checks: Record<string, string> = {};
  const base = { format: spec.format, codec: spec.codec, alpha: spec.alpha, contentType: plan.contentType, bytes: (await stat(pkg.file)).size };

  if (plan.kind === 'audio') {
    const a = await probeAudio(tools.ffprobe, pkg.file);
    if (a.hasVideo) problems.push('expected no video stream, found one');
    if (a.audioCodec !== expect.audioCodec) problems.push(`audio codec is ${a.audioCodec}, expected ${expect.audioCodec}`);
    if (Math.abs(a.durationSeconds - seconds) > 0.05) problems.push(`duration is ${a.durationSeconds}s, expected ${seconds}s`);
    await assertDecodable(tools.ffmpeg, pkg.file);
    Object.assign(checks, { metadata: 'pass', decode: 'pass', duration: 'pass', audio: 'pass' });
    // The timeline's rate (there are no pictures): what the frame count is counted in.
    return { info: { ...base, width: 0, height: 0, fps, frameRate, frames: o.frames, durationSeconds: a.durationSeconds, hasAudio: true, audioCodec: a.audioCodec, audioSampleRate: a.sampleRate, audioChannels: a.channels, videoCodec: null }, problems, checks };
  }

  if (plan.kind === 'image-sequence') {
    const entries = await zipEntries(pkg.file);
    if (entries.length !== o.frames) problems.push(`the zip has ${entries.length} entries, expected ${o.frames} frames`);
    const pad = (n: number) => `frame_${String(n).padStart(6, '0')}.png`;
    if (entries[0]?.name !== pad(1) || entries.at(-1)?.name !== pad(o.frames)) problems.push(`entries run ${entries[0]?.name} to ${entries.at(-1)?.name}, expected ${pad(1)} to ${pad(o.frames)}`);
    const colorType = spec.alpha ? 6 : 2;
    for (const e of [entries[0], entries.at(-1)].filter(Boolean)) {
      const h = await zipPngHeader(pkg.file, e!);
      if (h.width !== o.width || h.height !== o.height) problems.push(`${e!.name} is ${h.width}x${h.height}, expected ${o.width}x${o.height}`);
      if (h.colorType !== colorType || h.bitDepth !== 8) problems.push(`${e!.name} has PNG colour type ${h.colorType} at ${h.bitDepth} bits, expected ${colorType} (${spec.alpha ? 'RGBA' : 'RGB'}) at 8`);
    }
    // ffprobe one frame as a file, the same check as a video's.
    let first: Awaited<ReturnType<typeof probe>> | null = null;
    if (entries[0]) {
      const png = join(o.workDir, 'probe-frame.png');
      const fh = await open(pkg.file, 'r');
      try {
        const buf = Buffer.alloc(entries[0].bytes);
        await fh.read(buf, 0, buf.length, entries[0].dataOffset);
        await writeFile(png, buf);
      } finally {
        await fh.close();
      }
      first = await probe(tools.ffprobe, png);
      if (first.videoCodec !== 'png' || !expect.pixelFormats.includes(first.pixelFormat)) problems.push(`the first frame probes as ${first.videoCodec} ${first.pixelFormat}, expected png ${expect.pixelFormats.join(' or ')}`);
      if (spec.alpha) {
        const a = await alphaStats(tools.ffmpeg, png);
        if (!a) problems.push('the first frame has no alpha plane');
      }
      await assertDecodable(tools.ffmpeg, png);
      await rm(png, { force: true });
    }
    Object.assign(checks, { entries: 'pass', pngHeaders: 'pass', decode: 'pass', ...(spec.alpha ? { alpha: 'pass' } : {}) });
    // A PNG sequence has no timing of its own: the frames are the timeline's, at its exact rate.
    return { info: { ...base, width: o.width, height: o.height, fps, frameRate, frames: entries.length, durationSeconds: seconds, entries: entries.length, videoCodec: 'png', pixelFormat: first?.pixelFormat ?? null, hasAudio: false }, problems, checks };
  }

  const info = await probe(tools.ffprobe, pkg.file);
  const animation = plan.kind === 'animation';
  const want = animation ? { width: pkg.width!, height: pkg.height!, fps: pkg.rate ?? pkg.fps!, frames: pkg.frames } : { width: o.width, height: o.height, fps: o.fps, frames: o.frames };
  problems.push(
    ...checkExpectation(info, {
      ...want,
      audio: withAudio,
      videoCodec: expect.videoCodec!,
      pixelFormats: expect.pixelFormats,
      // MOV and WebM: r_frame_rate exactly the manifest's rate (30000/1001; #302, #376).
      exactRate: !animation,
    })
      // GIF delays are whole centiseconds, so its stream rate is not the nominal one; frames and duration are checked.
      .filter((p) => !(animation && p.startsWith('fps')))
  );
  const tolerance = animation ? 1 / pkg.fps! + 0.02 : 1 / fps + 0.001;
  if (Math.abs(info.durationSeconds - seconds) > tolerance) problems.push(`duration is ${info.durationSeconds}s, expected ${seconds}s`);
  if (withAudio && info.audioCodec !== expect.audioCodec) problems.push(`audio codec is ${info.audioCodec}, expected ${expect.audioCodec}`);
  if (expect.profile && info.videoProfile !== expect.profile) problems.push(`profile is ${info.videoProfile}, expected ${expect.profile}`);
  if (spec.codec === 'vp9') {
    if (spec.alpha && info.alphaMode !== true) problems.push('the VP9 stream has no alpha (alpha_mode tag missing)');
    if (!spec.alpha && info.alphaMode === true) problems.push('the VP9 stream has an alpha channel, expected none');
  }
  if (spec.alpha) {
    const a = await alphaStats(tools.ffmpeg, pkg.file, 0, { vp9: spec.codec === 'vp9' });
    if (!a) problems.push('the decoded video has no alpha plane');
    checks.alpha = 'pass';
  }
  if (plan.kind === 'animation') {
    const bytes = base.bytes;
    if (o.gifMaxBytes > 0 && bytes > o.gifMaxBytes) problems.push(`the GIF is ${bytes} bytes, more than render.formats.gifMaxBytes (${o.gifMaxBytes}); lower render.formats.gifMaxSide or gifFps, or shorten the video`);
    checks.size = 'pass';
  }
  await assertDecodable(tools.ffmpeg, pkg.file);
  Object.assign(checks, { metadata: 'pass', decode: 'pass', duration: 'pass' });
  // A GIF's stream rate is whole centiseconds per frame (15 fps reads as 16.67); report the rate it was made at.
  return { info: { ...base, ...info, ...(animation ? { fps: pkg.fps!, frameRate: rateFraction(pkg.rate ?? pkg.fps!), streamFps: info.fps, streamFrameRate: info.frameRate } : {}) }, problems, checks };
}
