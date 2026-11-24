import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FORMAT_CODECS, OUTPUT_FILES, OUTPUT_FORMATS, formatSpec, formatSpecIssues, migrate, parseProject, withVariant } from '../src/index';

/** Output formats beyond MP4 (#302): the manifest's format / codec / alpha and variant overrides. */

const sampleV01 = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8')) as Record<string, unknown>;
function v02(output: Record<string, unknown> = {}): any {
  const r = migrate(sampleV01);
  if (!r.ok) throw new Error('sample must migrate');
  const m = structuredClone(r.manifest) as any;
  m.output = { ...m.output, ...output };
  return m;
}
function issuesOf(input: unknown) {
  const r = parseProject(input);
  return r.ok ? [] : r.issues;
}

describe('output.format, output.codec, output.alpha (#302)', () => {
  it('accepts every format with each of its codecs, and alpha where the codec keeps it', () => {
    for (const format of OUTPUT_FORMATS) {
      for (const codec of FORMAT_CODECS[format]) {
        const r = parseProject(v02({ format, codec }));
        expect(r.ok, `${format}/${codec}`).toBe(true);
      }
    }
    for (const [format, codec] of [['mov', 'prores-4444'], ['webm', 'vp9'], ['png-sequence', 'png']] as const) {
      expect(parseProject(v02({ format, codec, alpha: true })).ok, `${format}/${codec} alpha`).toBe(true);
    }
  });

  it('fills the default codec; mov with alpha defaults to ProRes 4444', () => {
    expect(formatSpec({ format: 'mp4' })).toEqual({ format: 'mp4', codec: 'h264', alpha: false });
    expect(formatSpec({ format: 'mov' })).toEqual({ format: 'mov', codec: 'prores-422-hq', alpha: false });
    expect(formatSpec({ format: 'mov', alpha: true })).toEqual({ format: 'mov', codec: 'prores-4444', alpha: true });
    expect(formatSpec({ format: 'webm' }).codec).toBe('vp9');
    expect(formatSpec({ format: 'wav' }).codec).toBe('pcm-s16le');
    expect(OUTPUT_FILES['png-sequence']).toBe('frames.zip');
    expect(parseProject(v02({ format: 'mov', alpha: true })).ok).toBe(true);
  });

  it('refuses a codec of another format and alpha where it cannot be kept, by field', () => {
    const bad: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ format: 'webm', codec: 'prores-4444' }, 'output.codec', /format "webm" takes codec "vp9" or "av1", not "prores-4444"/],
      [{ format: 'mp4', codec: 'vp9' }, 'output.codec', /format "mp4" takes codec "h264"/],
      [{ format: 'mp4', alpha: true }, 'output.alpha', /codec "h264" has no alpha channel/],
      [{ format: 'mov', codec: 'prores-422-hq', alpha: true }, 'output.alpha', /codec "prores-422-hq" has no alpha/],
      [{ format: 'webm', codec: 'av1', alpha: true }, 'output.alpha', /codec "av1" has no alpha/],
      [{ format: 'gif', alpha: true }, 'output.alpha', /GIF has only on\/off transparency/],
      [{ format: 'm4a', alpha: true }, 'output.alpha', /audio only/],
      [{ format: 'wav', alpha: true }, 'output.alpha', /audio only/],
    ];
    for (const [o, path, message] of bad) {
      expect(issuesOf(v02(o)), JSON.stringify(o)).toEqual([expect.objectContaining({ path, message: expect.stringMatching(message) })]);
    }
    expect(issuesOf(v02({ format: 'hevc' }))).toEqual([expect.objectContaining({ path: 'output.format', message: expect.stringContaining('format must be one of mp4, mov, webm, gif, png-sequence, m4a, wav') })]);
    expect(issuesOf(v02({ format: 'mp4', codec: 'h265' }))).toEqual([expect.objectContaining({ path: 'output.codec' })]);
    expect(formatSpecIssues({ format: 'mp4' })).toEqual([]);
  });

  it('variants override format, codec and alpha; a variant with its own format inherits neither codec nor alpha', () => {
    const r = parseProject({
      ...v02({ format: 'mov', codec: 'prores-4444', alpha: true }),
      variants: [
        { id: 'same', width: 1920, height: 1080 },
        { id: 'web', width: 1080, height: 1080, format: 'webm' },
        { id: 'web-alpha', width: 1080, height: 1080, format: 'webm', alpha: true },
        { id: 'opaque', width: 1080, height: 1080, alpha: false },
        { id: 'gif', width: 720, height: 720, format: 'gif' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(withVariant(r.project, 'same').output).toMatchObject({ width: 1920, height: 1080, format: 'mov', codec: 'prores-4444', alpha: true });
    expect(formatSpec(withVariant(r.project, 'web').output)).toEqual({ format: 'webm', codec: 'vp9', alpha: false });
    expect(formatSpec(withVariant(r.project, 'web-alpha').output)).toEqual({ format: 'webm', codec: 'vp9', alpha: true });
    expect(formatSpec(withVariant(r.project, 'opaque').output)).toEqual({ format: 'mov', codec: 'prores-4444', alpha: false });
    expect(formatSpec(withVariant(r.project, 'gif').output)).toEqual({ format: 'gif', codec: 'gif', alpha: false });
  });

  it('refuses an invalid combination in a variant, as rendered', () => {
    const issues = issuesOf({
      ...v02({ format: 'mov', codec: 'prores-4444', alpha: true }),
      variants: [
        { id: 'gif', width: 720, height: 720, format: 'gif', alpha: true },
        { id: 'hq', width: 720, height: 720, codec: 'prores-422-hq' },
        { id: 'web', width: 720, height: 720, format: 'webm', codec: 'prores-4444' },
      ],
    });
    expect(issues).toEqual([
      expect.objectContaining({ path: 'variants.0.alpha', message: expect.stringMatching(/variant "gif": alpha needs/) }),
      expect.objectContaining({ path: 'variants.1.alpha', message: expect.stringMatching(/variant "hq": .*prores-422-hq/) }),
      expect.objectContaining({ path: 'variants.2.codec', message: expect.stringMatching(/variant "web": format "webm" takes codec/) }),
    ]);
  });
});
