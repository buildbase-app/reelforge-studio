import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveTools } from '@reelforge/media-pipeline';
import { FasterWhisperStt, cleanSttWords, resolveCommand, whisperLanguage, type SttSettings } from '../src/index';
import { tempDir } from './helpers';

/** The faster-whisper provider (#300, D-114): the spawn contract with fake programs, and the real program when installed. */

const { dir, cleanup } = tempDir('reelforge-stt-');
afterAll(cleanup);

const settings = (over: Partial<SttSettings> = {}): SttSettings => ({
  command: 'fake-whisper',
  model: 'small',
  language: 'auto',
  computeType: 'int8',
  device: 'cpu',
  timeoutSeconds: 30,
  ...over,
});
const ctx = () => ({ signal: new AbortController().signal, log: () => undefined });

/** A shell program in its own directory: records its arguments and environment, then runs `body`. */
function program(name: string, body: string): string {
  const bin = join(dir, name);
  writeFileSync(join(dir, `${name}.out.json`), JSON.stringify({ language: 'en', duration: 2, words: [{ text: ' Hello', start: 0.1, end: 0.4 }, { text: 'world.', start: 0.5, end: 0.9 }, { text: '\u0007', start: 1, end: 1.1 }] }));
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, `${name}.args`)}"\nenv > "${join(dir, `${name}.env`)}"\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('faster-whisper provider (fake programs)', () => {
  const audio = join(dir, 'voice.mp3');
  writeFileSync(audio, 'not really audio');

  it('finds the program on PATH or by absolute path, never by a relative path', () => {
    const bin = program('fake-whisper', 'cat "$0.out.json"');
    expect(resolveCommand('fake-whisper', `/nonexistent${delimiter}${dir}`)).toBe(bin);
    expect(resolveCommand(bin, '')).toBe(bin);
    expect(resolveCommand('fake-whisper', '/nonexistent')).toBeNull();
    expect(resolveCommand('./fake-whisper', dir)).toBeNull();
    expect(resolveCommand('fake whisper; rm -rf /', dir)).toBeNull();
    expect(resolveCommand(join(dir, 'fake-whisper.out.json'), '')).toBeNull(); // not executable
    const s = new FasterWhisperStt({ env: { PATH: '' } });
    expect(s.availability(settings())).toMatchObject({ ok: false, reason: expect.stringContaining('deployment/stt') });
    expect(s.availability(settings({ command: bin, modelDir: join(dir, 'missing') }))).toMatchObject({ ok: false, reason: expect.stringContaining('modelDir') });
    expect(s.availability(settings({ command: bin }))).toEqual({ ok: true });
  });

  it('starts it with a fixed argument list and an offline, secret-free environment; parses and cleans the words', async () => {
    program('fake-whisper', 'cat "$0.out.json"');
    const s = new FasterWhisperStt({ env: { PATH: `${dir}${delimiter}/usr/bin${delimiter}/bin`, HOME: dir, ELEVENLABS_API_KEY: 'secret-value', HF_HOME: join(dir, 'hf') } });
    const r = await s.transcribe({ file: audio, language: 'pt-BR', settings: settings({ modelDir: dir }) }, ctx());
    expect(r).toEqual({ language: 'en', durationSeconds: 2, words: [{ text: 'Hello', start: 0.1, end: 0.4 }, { text: 'world.', start: 0.5, end: 0.9 }], engine: { name: 'faster-whisper', model: 'small', computeType: 'int8' } });
    expect(readFileSync(join(dir, 'fake-whisper.args'), 'utf8').trim().split('\n')).toEqual([
      '--input', audio, '--model', 'small', '--compute-type', 'int8', '--device', 'cpu', '--language', 'pt', '--output', 'json', '--model-dir', dir,
    ]);
    const env = readFileSync(join(dir, 'fake-whisper.env'), 'utf8');
    expect(env).toContain('HF_HUB_OFFLINE=1');
    expect(env).toContain(`HF_HOME=${join(dir, 'hf')}`);
    expect(env).not.toContain('secret-value');
    await expect(s.transcribe({ file: 'voice.mp3', language: 'auto', settings: settings() }, ctx())).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('stops a program that runs too long or prints too much, and reports failures without a shell', async () => {
    const env = { PATH: `${dir}${delimiter}/usr/bin${delimiter}/bin` };
    program('slow-whisper', 'sleep 5');
    await expect(new FasterWhisperStt({ env }).transcribe({ file: audio, language: 'auto', settings: settings({ command: 'slow-whisper', timeoutSeconds: 1 }) }, ctx())).rejects.toMatchObject({ code: 'stt_timeout', status: 504 });
    program('loud-whisper', 'head -c 200000 /dev/zero');
    await expect(new FasterWhisperStt({ env, maxOutputBytes: 1000 }).transcribe({ file: audio, language: 'auto', settings: settings({ command: 'loud-whisper' }) }, ctx())).rejects.toMatchObject({ code: 'stt_failed', message: expect.stringContaining('more than 1000 bytes') });
    program('bad-whisper', 'echo "model small is not available offline" >&2; exit 3');
    await expect(new FasterWhisperStt({ env }).transcribe({ file: audio, language: 'auto', settings: settings({ command: 'bad-whisper' }) }, ctx())).rejects.toMatchObject({ code: 'stt_failed', message: 'speech-to-text failed (exit 3): model small is not available offline' });
    program('junk-whisper', 'echo "{not json"');
    await expect(new FasterWhisperStt({ env }).transcribe({ file: audio, language: 'auto', settings: settings({ command: 'junk-whisper' }) }, ctx())).rejects.toMatchObject({ code: 'stt_failed', message: expect.stringContaining('expected JSON') });
    const aborted = new AbortController();
    aborted.abort();
    await expect(new FasterWhisperStt({ env }).transcribe({ file: audio, language: 'auto', settings: settings({ command: 'slow-whisper' }) }, { signal: aborted.signal, log: () => undefined })).rejects.toMatchObject({ code: 'stt_cancelled' });
  }, 20_000);

  it('cleans words and maps language tags to Whisper codes', () => {
    expect(cleanSttWords([{ text: ' a\u0000b ', start: 0, end: 1 }, { text: '', start: 0, end: 1 }, { text: 'x', start: 2, end: 1 }, { text: 'y', start: -1, end: 1 }, { text: 'z'.repeat(101), start: 0, end: 1 }, { text: 'ok', start: 0.12345, end: 0.5 }])).toEqual([
      { text: 'a b', start: 0, end: 1 },
      { text: 'ok', start: 0.123, end: 0.5 },
    ]);
    expect(whisperLanguage('pt-BR')).toBe('pt');
    expect(whisperLanguage('EN')).toBe('en');
    expect(whisperLanguage('auto')).toBe('auto');
  });
});

// ---- the real program (optional image layer, deployment/stt) ------------------------

const realCommand = resolveCommand(process.env.REELFORGE_STT_COMMAND ?? 'reelforge-whisper');
const tools = resolveTools();
const hasFlite = /\bflite\b/.test(spawnSync(tools.ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '');

describe.skipIf(!realCommand || !hasFlite)('faster-whisper provider (the real program, skipped when it is not installed)', () => {
  it('transcribes synthetic speech offline into word timings', async () => {
    const wav = join(dir, 'speech.wav');
    const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', "flite=text='Captions are made on your own machine.':voice=slt", '-ar', '16000', wav]);
    expect(r.status).toBe(0);
    const s = new FasterWhisperStt();
    const out = await s.transcribe(
      {
        file: wav,
        language: 'auto',
        settings: settings({ command: realCommand!, model: process.env.REELFORGE_STT_MODEL ?? 'small', ...(process.env.REELFORGE_STT_MODEL_DIR ? { modelDir: process.env.REELFORGE_STT_MODEL_DIR } : {}), timeoutSeconds: 300 }),
      },
      ctx()
    );
    expect(out.language).toBe('en');
    expect(out.engine.name).toBe('faster-whisper');
    expect(out.words.map((w) => w.text.toLowerCase()).join(' ')).toContain('machine');
    for (let i = 1; i < out.words.length; i++) expect(out.words[i]!.start).toBeGreaterThanOrEqual(out.words[i - 1]!.start);
    expect(out.words.at(-1)!.end).toBeLessThan(4);
  }, 300_000);
});
