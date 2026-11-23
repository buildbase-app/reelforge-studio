import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalLanguage, formatVtt, isLanguageTag, migrate, parseProject, resolveCaptions, sameLanguage, splitCueKinds, type CaptionCue } from '../src/index';

/** Captions PR 2 (#300, D-110): language tags, tracks per language, the burn language, description cues and the default mode. */

const migrated = migrate(JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8')));
if (!migrated.ok) throw new Error('the sample must migrate');
const sample = migrated.manifest as Record<string, unknown>;
const withCaptions = (captions: Record<string, unknown>, extra: Record<string, unknown> = {}) => parseProject({ ...sample, ...extra, captions });
const issues = (r: ReturnType<typeof parseProject>) => (r.ok ? [] : r.issues);

describe('BCP 47 language tags', () => {
  it('accepts well-formed tags and refuses everything else (no regex on the input)', () => {
    for (const t of ['en', 'de', 'pt-BR', 'zh-Hant-TW', 'es-419', 'sr-Latn', 'en-US-x-twain']) expect(isLanguageTag(t), t).toBe(true);
    for (const t of ['e', 'en_US', 'en US', 'en\nKind: x', '-en', 'en-', 'en--US', '123', 'x'.repeat(36), 'de-DE-1996-1996a-', '日本']) expect(isLanguageTag(t), t).toBe(false);
    expect(canonicalLanguage('PT-br')).toBe('pt-BR');
    expect(sameLanguage('pt-br', 'PT-BR')).toBe(true);
    expect(sameLanguage('pt', 'pt-BR')).toBe(false);
    expect(sameLanguage(null, 'en')).toBe(false);
  });

  it('validates captions.language, burnLanguage and track keys', () => {
    expect(issues(withCaptions({ language: 'en_US' })).map((i) => i.path)).toEqual(['captions.language']);
    expect(issues(withCaptions({ tracks: { 'not a tag': { cues: [] } } })).map((i) => i.path)).toContain('captions.tracks.not a tag');
    expect(issues(withCaptions({ language: 'en', burnLanguage: 'fr' }))).toEqual([{ path: 'captions.burnLanguage', message: expect.stringContaining('neither the primary language') }]);
    expect(issues(withCaptions({ language: 'en', tracks: { EN: { cues: [] } } }))[0]).toMatchObject({ path: 'captions.tracks.EN', message: expect.stringContaining('primary language') });
    expect(issues(withCaptions({ language: 'en', tracks: { 'pt-BR': { cues: [] }, 'pt-br': { cues: [] } } }))[0]).toMatchObject({ message: expect.stringContaining('twice') });
    const many = Object.fromEntries(['de', 'fr', 'it', 'es', 'pt', 'nl', 'sv', 'da', 'fi', 'no', 'pl', 'cs', 'sk', 'hu', 'ro', 'bg', 'el', 'tr', 'ja', 'ko'].map((l) => [l, { cues: [] }]));
    expect(issues(withCaptions({ language: 'en', tracks: many })).map((i) => i.path)).toEqual(['captions.tracks']);
    // brief.language is free text: only a valid tag becomes the primary caption language.
    const brief = withCaptions({ mode: 'sidecar', cues: [{ start: 0, end: 1, text: 'Hi' }] }, { brief: { language: 'English please' } });
    if (!brief.ok) throw new Error(JSON.stringify(brief.issues));
    expect(resolveCaptions(brief.project).language).toBeUndefined();
  });
});

describe('languages, description cues and modes', () => {
  const en: CaptionCue[] = [
    { start: 0, end: 2, text: 'Hello.' },
    { start: 0, end: 4, text: 'A logo on black.', kind: 'description' },
    { start: 2.5, end: 4, text: 'Welcome.' },
  ];

  it('keeps time order per kind, so captions and descriptions may overlap', () => {
    expect(withCaptions({ cues: en }).ok).toBe(true);
    const bad = withCaptions({ cues: [...en, { start: 1, end: 2, text: 'Late' }] });
    expect(issues(bad)).toEqual([{ path: 'captions.cues.3.start', message: 'caption cues must be in time order' }]);
    expect(issues(withCaptions({ tracks: { es: { cues: [{ start: 1, end: 0.5, text: 'Mal' }] } } })).map((i) => i.path)).toEqual(['captions.tracks.es.cues.0.end']);
    const k = splitCueKinds(en);
    expect(k.captions.map((c) => c.text)).toEqual(['Hello.', 'Welcome.']);
    expect(k.captionIndex).toEqual([0, 2]);
    expect(k.descriptionIndex).toEqual([1]);
  });

  it('resolves every language, the burned one, descriptions and where the mode comes from', () => {
    const r0 = withCaptions({ language: 'en', cues: en, tracks: { es: { cues: [{ start: 0, end: 2, text: 'Hola.' }] } } });
    if (!r0.ok) throw new Error(JSON.stringify(r0.issues));
    const off = resolveCaptions(r0.project);
    expect(off).toMatchObject({ mode: 'off', modeSource: 'default', burnLanguage: 'en' });
    expect(off.tracks.map((t) => [t.language, t.primary, t.burned, t.cues.length, t.descriptions.length])).toEqual([
      ['en', true, false, 2, 1],
      ['es', false, false, 1, 0],
    ]);
    expect(off.cues.map((c) => c.text)).toEqual(['Hello.', 'Welcome.']); // descriptions are not captions
    expect(off.qa.cues).toBe(2);
    expect(resolveCaptions(r0.project, { defaultMode: 'off' }).modeSource).toBe('default');
    const server = resolveCaptions(r0.project, { defaultMode: 'burned' });
    expect(server).toMatchObject({ mode: 'burned', modeSource: 'server' });
    expect(server.tracks.map((t) => t.burned)).toEqual([true, false]);
    expect(resolveCaptions(r0.project, { mode: 'sidecar', defaultMode: 'burned' })).toMatchObject({ mode: 'sidecar', modeSource: 'render' });

    const r1 = withCaptions({ mode: 'both', language: 'en', cues: en, burnLanguage: 'ES', tracks: { es: { cues: [{ start: 0, end: 2, text: 'Hola.' }] } } });
    if (!r1.ok) throw new Error(JSON.stringify(r1.issues));
    const both = resolveCaptions(r1.project, { defaultMode: 'off' });
    expect(both).toMatchObject({ mode: 'both', modeSource: 'project', burnLanguage: 'ES' });
    expect(both.tracks.map((t) => [t.language, t.burned])).toEqual([
      ['en', false],
      ['es', true],
    ]);
  });

  it('warns about the quality of every language and not about description cues', () => {
    const r = withCaptions({ mode: 'sidecar', language: 'en', cues: [{ start: 0, end: 4, text: 'A very long description of a scene that would be far too fast to read as a caption.', kind: 'description' }, { start: 0, end: 2, text: 'Hi.' }], tracks: { de: { cues: [{ start: 0, end: 0.3, text: 'Zu schnell.' }] } } });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const w = r.warnings.filter((x) => x.path.startsWith('captions'));
    expect(w.map((x) => x.path)).toEqual(['captions.tracks.de.cues.0', 'captions.tracks.de.cues.0']);
    expect(w[0]!.message).toContain('(de)');
  });

  it('writes the WebVTT Kind and Language headers only for safe tags', () => {
    expect(formatVtt([{ start: 0, end: 1, text: 'A door opens.' }], { kind: 'descriptions', language: 'en' })).toBe('WEBVTT\nKind: descriptions\nLanguage: en\n\n00:00:00.000 --> 00:00:01.000\nA door opens.\n');
    expect(formatVtt([], { language: 'en\nX-Evil: 1' })).toBe('WEBVTT\n\n');
  });
});
