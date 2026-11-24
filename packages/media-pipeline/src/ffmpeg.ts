import { execFile, spawn, spawnSync } from 'node:child_process';
import { rateArg } from './rate';

/** Raised when a pipeline stage fails. Carries the stage name and tool output. */
export class PipelineError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly log = ''
  ) {
    super(`[${stage}] ${message}`);
    this.name = 'PipelineError';
  }
}

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
}

/**
 * Locate FFmpeg and ffprobe. Uses FFMPEG_PATH / FFPROBE_PATH when set,
 * otherwise whatever is on PATH. Fails with an actionable message instead of
 * a bare ENOENT later (TEST_PLAN §3, "Missing FFmpeg").
 */
export function resolveTools(env: NodeJS.ProcessEnv = process.env): Tools {
  const tools = toolPaths(env);
  for (const [name, bin] of Object.entries(tools)) {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      throw new PipelineError(
        'setup',
        `${name} was not found (tried "${bin}"). Install FFmpeg 6 or newer ` +
          `(e.g. "apt install ffmpeg" or "brew install ffmpeg"), or set ` +
          `${name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'} to its full path.`
      );
    }
  }
  return tools;
}

/** The FFmpeg and ffprobe commands (FFMPEG_PATH / FFPROBE_PATH, else PATH), without checking them. */
export function toolPaths(env: NodeJS.ProcessEnv = process.env): Tools {
  return { ffmpeg: env.FFMPEG_PATH || 'ffmpeg', ffprobe: env.FFPROBE_PATH || 'ffprobe' };
}

/** First line of `<bin> -version` per binary, filled by toolVersion() and toolVersionAsync() (#319). */
const toolVersions = new Map<string, string>();

/**
 * First line of `<bin> -version`. Cached per binary after the first answer,
 * so only the first call for a binary starts a (synchronous) process. Request
 * paths use toolVersionAsync() or a value probed earlier instead (#319).
 */
export function toolVersion(bin: string): string {
  const cached = toolVersions.get(bin);
  if (cached) return cached;
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 10_000 });
  const v = (r.stdout ?? '').split('\n')[0] ?? 'unknown';
  if (v && r.status === 0) toolVersions.set(bin, v);
  return v;
}

/**
 * First line of `<bin> -version` without blocking the event loop (an async
 * child process; always probes, and refreshes the cache toolVersion() reads).
 * null when the tool is missing or fails.
 */
export function toolVersionAsync(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const v = err ? '' : (stdout.split('\n')[0] ?? '');
      if (v) toolVersions.set(bin, v);
      resolve(v || null);
    });
  });
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Run a tool to completion. Rejects with the tail of stderr on failure. */
export function run(
  bin: string,
  args: string[],
  stage: string,
  opts: {
    signal?: AbortSignal;
    cwd?: string;
    /** The child's whole environment (default: inherited). Untrusted media is decoded with a scrubbed one. */
    env?: NodeJS.ProcessEnv;
    /** Kill the tool after this many milliseconds (rejects with a timeout error). */
    timeoutMs?: number;
  } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => reject(new PipelineError(stage, e.message, stderr)));
    child.on('close', (code, sig) => {
      if (code === 0) resolve({ stdout, stderr });
      else if (sig === 'SIGKILL' && opts.timeoutMs && !opts.signal?.aborted) reject(new PipelineError(stage, `${bin} did not finish within ${opts.timeoutMs} ms`, stderr.split('\n').slice(-30).join('\n')));
      else
        reject(
          new PipelineError(stage, `${bin} exited with code ${code}`, stderr.split('\n').slice(-30).join('\n'))
        );
    });
  });
}

/**
 * x264 settings that bound an encode's memory (#307, D-117; render.encoderThreads, render.encoderLookahead).
 * x264's memory grows with its frame threads (auto: 1.5 per CPU core, so it grows with the machine, not the
 * video) and with the frames its rate control looks ahead; each frame it holds is several full-size planes.
 * Neither changes the bitstream's format (profile, references, B-frames: the preset does), so clips encoded
 * by workers with different values still join by stream copy (render fan-out, D-097).
 */
export interface EncoderSettings {
  /** x264 threads; 0 = x264's automatic choice (1.5 per core). Also caps the decoder and filter threads of the same ffmpeg. */
  threads: number;
  /** x264 rc-lookahead in frames; 0 = the preset's own (40 for `medium`). */
  lookahead: number;
}

/** The defaults: measured in docs/SCALE.md (1080x1920 and 3840x2160, peak memory and SSIM/PSNR against the frames). */
export const DEFAULT_ENCODER_SETTINGS: Readonly<EncoderSettings> = Object.freeze({ threads: 2, lookahead: 20 });
let encoder: EncoderSettings = { ...DEFAULT_ENCODER_SETTINGS };

/** Process-wide encoder settings (the server applies render.encoderThreads / render.encoderLookahead, also at runtime). */
export function setEncoderSettings(s: Partial<EncoderSettings>): void {
  encoder = { ...encoder, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) };
}
export function encoderSettings(): Readonly<EncoderSettings> {
  return { ...encoder };
}

/**
 * @deprecated The encoding arguments with the default settings, for callers not yet moved to h264Args() (the
 * captions burn-in, #332): they get the bounded defaults but not runtime changes.
 */
export const H264_ARGS: readonly string[] = h264Args({ ...DEFAULT_ENCODER_SETTINGS });

/** The decoder thread cap: goes before each `-i` (an input option applies to the next input only). */
export function inputThreadArgs(s: EncoderSettings = encoder): string[] {
  return s.threads > 0 ? ['-threads', String(s.threads)] : [];
}

/** The filter graph thread cap (global options: anywhere before the output). */
export function filterThreadArgs(s: EncoderSettings = encoder): string[] {
  return s.threads > 0 ? ['-filter_threads', String(s.threads), '-filter_complex_threads', String(s.threads)] : [];
}

/**
 * The encoder thread cap (an output option) for encoders other than x264
 * (#302: prores_ks, libvpx-vp9, libaom-av1, ffv1): the same render.encoderThreads.
 */
export function encoderThreadArgs(s: EncoderSettings = encoder): string[] {
  return s.threads > 0 ? ['-threads', String(s.threads)] : [];
}

/** Video encoding settings every clip is normalised to before assembly (libx264 high, yuv420p, CRF 18, medium). */
export function h264Args(s: EncoderSettings = encoder): string[] {
  const x264 = [...(s.lookahead > 0 ? [`rc-lookahead=${s.lookahead}`] : [])];
  return [
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'high',
    ...(s.threads > 0 ? ['-threads', String(s.threads)] : []),
    ...(x264.length ? ['-x264-params', x264.join(':')] : []),
    '-movflags',
    '+faststart',
  ];
}

/**
 * The clip an engine writes when a render keeps alpha (#302, EngineRenderContext.alpha):
 * ProRes 4444 with a 16-bit alpha channel in a MOV (FFmpeg's prores_ks).
 */
export const ALPHA_CLIP_ARGS = ['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16'];

export interface FrameEncoder {
  /** Write one PNG frame. Resolves once FFmpeg has accepted it. */
  write(png: Buffer): Promise<void>;
  /** Close stdin and wait for FFmpeg to finish the file. */
  finish(): Promise<void>;
  /** Kill FFmpeg (used on cancellation or upstream failure). */
  kill(): void;
}

/**
 * Start an FFmpeg process that turns a stream of PNG frames into an H.264 MP4
 * at a constant frame rate. Used by engines that produce frames rather than
 * video files.
 */
export function startPngEncoder(
  ffmpeg: string,
  out: string,
  /** A number or an exact "num/den" such as "30000/1001" (#302). */
  fps: number | string,
  stage = 'encode',
  /** alpha: keep the PNGs' alpha channel (ALPHA_CLIP_ARGS, `out` should end in .mov) instead of H.264. */
  opts: { alpha?: boolean } = {}
): FrameEncoder {
  const child = spawn(
    ffmpeg,
    [
      '-hide_banner',
      '-y',
      ...filterThreadArgs(),
      ...inputThreadArgs(),
      '-f',
      'image2pipe',
      '-framerate',
      rateArg(fps),
      '-c:v',
      'png',
      '-i',
      '-',
      ...(opts.alpha ? [...ALPHA_CLIP_ARGS, ...encoderThreadArgs()] : h264Args()),
      '-r',
      rateArg(fps),
      '-an',
      out,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => reject(new PipelineError(stage, e.message, stderr)));
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new PipelineError(stage, `ffmpeg exited with code ${code}`, stderr.split('\n').slice(-30).join('\n'))
          )
    );
  });
  // Avoid an unhandled rejection if the caller kills before awaiting finish().
  done.catch(() => undefined);
  // Once ffmpeg exits (killed on cancel or timeout, or it failed), a pending or
  // later write fails with EPIPE. Without a listener that stream error is thrown
  // as an uncaught exception; keep it and report it through write() instead.
  let stdinError: Error | undefined;
  child.stdin.on('error', (e) => {
    stdinError ??= e;
  });

  return {
    write(png) {
      return new Promise((resolve, reject) => {
        if (stdinError) return reject(new PipelineError(stage, `ffmpeg stdin closed: ${stdinError.message}`, stderr));
        if (!child.stdin.writable) return reject(new PipelineError(stage, 'ffmpeg stdin closed', stderr));
        child.stdin.write(png, (err) => (err ? reject(new PipelineError(stage, err.message, stderr)) : resolve()));
      });
    },
    async finish() {
      child.stdin.end();
      await done;
    },
    kill() {
      child.kill('SIGKILL');
    },
  };
}
