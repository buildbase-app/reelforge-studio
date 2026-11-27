import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { MAX_PROJECT_SECONDS } from '@renderweld/project-schema';
import { renderChildEnv } from '../childEnv';
import { ApiError } from '../errors';
import type { Availability, Logger, SpeechToTextPlugin, SttRequest, SttResult, SttSettings } from '../plugins';

/**
 * Local speech-to-text with faster-whisper (#300, D-114, docs/CAPTIONS.md#speech-to-text).
 *
 * faster-whisper is a Python library, so it is not in the base image: the
 * optional image layer in deployment/stt installs it with a pre-downloaded
 * model and the `reelforge-whisper` program (deployment/stt/reelforge-whisper),
 * which prints word timings as JSON. This plugin starts that program directly
 * (an argument array, never a shell), with an allowlisted environment that
 * forces Hugging Face offline mode, a timeout and a cap on its output.
 */

/** Largest stdout accepted from the program (a 10-minute voice-over is well under 1 MB of JSON). */
export const STT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
const BARE_COMMAND = /^[A-Za-z0-9._+-]+$/;

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The absolute path of `command`: itself when it is an absolute path to an executable file, else the first match on PATH; null when not found. */
export function resolveCommand(command: string, path = process.env.PATH ?? ''): string | null {
  if (isAbsolute(command)) return isExecutableFile(command) ? command : null;
  if (!BARE_COMMAND.test(command)) return null;
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, command);
    if (isExecutableFile(file)) return file;
  }
  return null;
}

/** The program's JSON output; unknown keys are dropped. */
const sttOutput = z.object({
  language: z.string().max(35).nullable().optional(),
  duration: z.number().min(0).max(86_400).optional(),
  words: z
    .array(
      z.object({
        text: z.string().max(1000),
        start: z.number(),
        end: z.number(),
      })
    )
    .max(100_000),
  engine: z.record(z.string().max(64), z.string().max(200)).optional(),
});

/** Plain text of one word: control characters removed (a linear scan), whitespace collapsed. */
function cleanText(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c < 32 || c === 127 ? ' ' : ch;
  }
  return out.split(' ').filter(Boolean).join(' ');
}

/** Valid timed words only: non-empty text of at most 100 characters, 0 <= start <= end within the project limit, times in milliseconds. */
export function cleanSttWords(words: ReadonlyArray<{ text: string; start: number; end: number }>): SttResult['words'] {
  const out: SttResult['words'] = [];
  for (const w of words) {
    const text = cleanText(w.text);
    if (!text || text.length > 100) continue;
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || w.end < w.start || w.end > MAX_PROJECT_SECONDS) continue;
    out.push({ text, start: Math.round(w.start * 1000) / 1000, end: Math.round(w.end * 1000) / 1000 });
  }
  return out;
}

/** The primary language subtag Whisper understands ("pt-BR" -> "pt"), or "auto". */
export function whisperLanguage(tag: string): string {
  return tag === 'auto' ? 'auto' : (tag.split('-')[0] ?? tag).toLowerCase();
}

interface Bounded {
  code: number | null;
  stdout: Buffer;
  stderrTail: string;
  stopped?: 'timeout' | 'output' | 'aborted';
}

/** Run a program with an argument array (no shell), a timeout, an abort signal and a cap on stdout; keep the end of stderr. */
export function runBounded(file: string, args: string[], o: { env: Record<string, string>; timeoutMs: number; maxStdout: number; signal: AbortSignal }): Promise<Bounded> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) return resolve({ code: null, stdout: Buffer.alloc(0), stderrTail: '', stopped: 'aborted' });
    const child = spawn(file, args, { shell: false, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let stopped: Bounded['stopped'];
    const stop = (why: NonNullable<Bounded['stopped']>) => {
      if (stopped) return;
      stopped = why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), o.timeoutMs);
    const onAbort = () => stop('aborted');
    o.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (b: Buffer) => {
      bytes += b.length;
      if (bytes > o.maxStdout) return stop('output');
      chunks.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    const done = () => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
    };
    child.on('error', (e) => {
      done();
      reject(e);
    });
    child.on('close', (code) => {
      done();
      resolve({ code, stdout: Buffer.concat(chunks), stderrTail: stderr, ...(stopped ? { stopped } : {}) });
    });
  });
}

/** Environment names the STT program may additionally see (the Hugging Face cache location). */
const STT_ENV_PASSTHROUGH = ['HF_HOME', 'HF_HUB_CACHE', 'OMP_NUM_THREADS', 'CUDA_VISIBLE_DEVICES'];

export class FasterWhisperStt implements SpeechToTextPlugin {
  readonly id = 'faster-whisper';
  readonly displayName = 'faster-whisper (local speech-to-text, optional image layer)';

  constructor(private readonly opts: { env?: NodeJS.ProcessEnv; maxOutputBytes?: number } = {}) {}

  private get env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  availability(s: SttSettings): Availability {
    if (!resolveCommand(s.command, this.env.PATH ?? '')) {
      return {
        ok: false,
        reason: `the speech-to-text program "${s.command}" is not installed (not on PATH and not an executable absolute path): build the optional image layer in deployment/stt, or install faster-whisper and deployment/stt/reelforge-whisper and set captions.stt.command`,
      };
    }
    if (s.modelDir && !isDir(s.modelDir)) return { ok: false, reason: `captions.stt.modelDir "${s.modelDir}" is not a directory; pre-download the model there (deployment/stt/README.md)` };
    if (isAbsolute(s.model) && !isDir(s.model)) return { ok: false, reason: `captions.stt.model "${s.model}" is not a model directory` };
    return { ok: true };
  }

  async transcribe(req: SttRequest, ctx: { signal: AbortSignal; log: Logger }): Promise<SttResult> {
    const s = req.settings;
    const file = resolveCommand(s.command, this.env.PATH ?? '');
    if (!file) throw new ApiError('stt_unavailable', 409, this.availability(s).reason ?? 'speech-to-text is not installed');
    // Paths come from the asset store and are absolute, so none can be read as an option.
    if (!isAbsolute(req.file)) throw new ApiError('bad_request', 400, 'the audio file must be an absolute path from the asset store');
    const language = whisperLanguage(req.language);
    const args = ['--input', req.file, '--model', s.model, '--compute-type', s.computeType, '--device', s.device, '--language', language, '--output', 'json'];
    if (s.modelDir) args.push('--model-dir', s.modelDir);
    // One argument with "=", so a prompt that starts with "-" is never read as an option (#486).
    if (req.prompt) args.push(`--initial-prompt=${req.prompt}`);
    const extra: Record<string, string | undefined> = { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
    for (const name of STT_ENV_PASSTHROUGH) if (this.env[name]) extra[name] = this.env[name];
    ctx.log(`stt: ${this.id} model ${s.model} (${s.computeType}, ${s.device}), language ${language}`);
    let r: Bounded;
    try {
      r = await runBounded(file, args, { env: renderChildEnv(this.env, extra), timeoutMs: s.timeoutSeconds * 1000, maxStdout: this.opts.maxOutputBytes ?? STT_MAX_OUTPUT_BYTES, signal: ctx.signal });
    } catch (e) {
      throw new ApiError('stt_failed', 502, `could not start the speech-to-text program: ${(e as Error).message}`);
    }
    if (r.stopped === 'timeout') throw new ApiError('stt_timeout', 504, `speech-to-text took longer than captions.stt.timeoutSeconds (${s.timeoutSeconds} s) and was stopped; use a smaller model or raise the timeout`);
    if (r.stopped === 'aborted') throw new ApiError('stt_cancelled', 499, 'speech-to-text was cancelled');
    if (r.stopped === 'output') throw new ApiError('stt_failed', 502, `the speech-to-text program wrote more than ${this.opts.maxOutputBytes ?? STT_MAX_OUTPUT_BYTES} bytes; stopped`);
    const lastLine = r.stderrTail.trim().split('\n').at(-1)?.slice(0, 500) ?? '';
    if (r.code !== 0) throw new ApiError('stt_failed', 502, `speech-to-text failed (exit ${r.code})${lastLine ? `: ${lastLine}` : ''}`);
    let parsed: z.infer<typeof sttOutput>;
    try {
      parsed = sttOutput.parse(JSON.parse(r.stdout.toString('utf8')));
    } catch {
      throw new ApiError('stt_failed', 502, 'the speech-to-text program did not print the expected JSON ({ language, duration, words: [{ text, start, end }] })');
    }
    return {
      language: parsed.language ?? null,
      words: cleanSttWords(parsed.words),
      ...(parsed.duration !== undefined ? { durationSeconds: parsed.duration } : {}),
      engine: { name: 'faster-whisper', model: s.model, computeType: s.computeType, ...parsed.engine },
    };
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
