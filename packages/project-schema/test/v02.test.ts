import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_THEMES,
  SCHEMA_VERSION,
  TEMPLATES,
  builtinTheme,
  mergeTokens,
  migrate,
  parseProject,
  projectJsonSchema,
  theme,
  timeline,
  totalFrames,
  type ProjectInput,
} from '../src/index';

const sampleV01 = JSON.parse(
  readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8')
) as Record<string, unknown>;

function v02(): any {
  const r = migrate(sampleV01);
  if (!r.ok) throw new Error('sample must migrate');
  return structuredClone(r.manifest) as any;
}

function issuesOf(input: unknown) {
  const r = parseProject(input);
  if (r.ok) throw new Error('expected validation to fail');
  return r.issues;
}

describe('migration v0.1 -> v0.2', () => {
  it('migrates the sample losslessly and reports where it came from', () => {
    const r = parseProject(sampleV01);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe('0.1');
    expect(r.project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.project.theme).toBe('default');
    expect(r.project.render.backend).toBe('local');
    expect(r.project.audio).toEqual({ voice: null, music: null, sfx: [] });
    expect(timeline(r.project).map((s) => [s.startFrame, s.endFrame])).toEqual([
      [0, 90],
      [90, 210],
    ]);
    expect(r.project.scenes[0]!.props).toEqual((sampleV01.scenes as any)[0].props);
  });

  it('maps v0.1 audio tracks and asset paths', () => {
    const p = structuredClone(sampleV01) as any;
    p.assets = [
      { id: 'song', path: 'music/song.mp3', mediaType: 'audio', license: { name: 'CC0-1.0', redistributable: true } },
      { id: 'vo', path: 'vo.wav', mediaType: 'audio' },
    ];
    p.audio = { musicTrack: 'song', voiceTrack: 'vo', musicVolume: 0.5 };
    const r = migrate(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.audio).toEqual({
      music: { asset: 'song', volume: 0.5, ducking: false, fadeOutSeconds: 1 },
      voice: { asset: 'vo', volume: 1, startFrame: 0 },
      sfx: [],
    });
    expect(r.manifest.assets![0]!.uri).toBe('project://music/song.mp3');
    expect(r.manifest.assets![0]!.license?.name).toBe('CC0-1.0');
    expect(parseProject(p).ok).toBe(true);
  });

  it('is idempotent: a v0.2 manifest passes through unchanged', () => {
    const m = v02();
    const r = migrate(m);
    expect(r.ok && r.migratedFrom).toBe(null);
    expect(r.ok && r.manifest).toEqual(m);
  });

  it('rejects unknown versions with the list of supported ones', () => {
    const r = migrate({ ...sampleV01, schemaVersion: '0.9' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.message).toMatch(/supported: 0.1, 0.2/);
  });
});

describe('manifest v0.2', () => {
  it('accepts durationSeconds and rounds to frames', () => {
    const m = v02();
    delete m.scenes[0].durationFrames;
    m.scenes[0].durationSeconds = 3;
    const r = parseProject(m);
    expect(r.ok).toBe(true);
    if (r.ok) expect(totalFrames(r.project)).toBe(210);
  });

  it('warns when seconds are not a whole number of frames', () => {
    const m = v02();
    delete m.scenes[0].durationFrames;
    m.scenes[0].durationSeconds = 3.01;
    const r = parseProject(m);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some((w) => w.path === 'scenes.0.durationSeconds')).toBe(true);
      expect(timeline(r.project)[0]!.durationFrames).toBe(90);
    }
  });

  it('requires exactly one of durationFrames and durationSeconds', () => {
    const both = v02();
    both.scenes[0].durationSeconds = 3;
    expect(issuesOf(both).some((i) => i.message.includes('exactly one'))).toBe(true);
    const neither = v02();
    delete neither.scenes[0].durationFrames;
    expect(issuesOf(neither).some((i) => i.message.includes('exactly one'))).toBe(true);
  });

  it('lists available engines when an engine is unknown', () => {
    const m = v02();
    m.scenes[0].engine = 'after-effects';
    const issue = issuesOf(m).find((i) => i.path === 'scenes.0.engine');
    expect(issue?.message).toMatch(/available engines: remotion, motion-canvas, html, hyperframes/);
  });

  it('honours a restricted catalog (engines not installed on this server)', () => {
    const r = parseProject(v02(), {
      catalog: { engines: ['remotion'], templates: { 'kinetic-title': TEMPLATES['kinetic-title'] } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.message.includes('available engines: remotion'))).toBe(true);
  });

  it('accepts html scenes with source, and rejects html on other engines', () => {
    const m = v02();
    m.scenes.push({ id: 'card', engine: 'html', html: '<h1>Hi</h1>', css: 'h1{color:red}', durationSeconds: 2 });
    expect(parseProject(m).ok).toBe(true);
    m.scenes[0].html = '<p>x</p>';
    expect(issuesOf(m).some((i) => i.path === 'scenes.0.html')).toBe(true);
  });

  it('rejects template + html together and oversized html', () => {
    const m = v02();
    m.scenes.push({ id: 'card', engine: 'html', template: 'html-title', html: '<p/>', props: { headline: 'x' }, durationFrames: 30 });
    expect(issuesOf(m).some((i) => i.message.includes('not both'))).toBe(true);
    const big = v02();
    big.scenes.push({ id: 'card', engine: 'html', html: 'x'.repeat(300_000), durationFrames: 30 });
    expect(issuesOf(big).some((i) => i.message.includes('larger than'))).toBe(true);
  });

  it('accepts a theme id or inline tokens, and rejects unsafe font families', () => {
    const m = v02();
    m.theme = 'midnight';
    expect(parseProject(m).ok).toBe(true);
    m.theme = { base: 'midnight', tokens: { colors: { accent: '#ff0000' } } };
    expect(parseProject(m).ok).toBe(true);
    m.theme = { tokens: { fontFamily: 'x; } body { display:none' } };
    expect(issuesOf(m).some((i) => i.path.startsWith('theme'))).toBe(true);
  });

  it('validates audio: music, voice and sfx references and timing', () => {
    const m = v02();
    m.assets = [
      { id: 'song', uri: 'asset://ast-0123456789abcdef', mediaType: 'audio' },
      { id: 'logo', uri: 'asset://ast-fedcba9876543210', mediaType: 'image' },
    ];
    m.audio = {
      music: { asset: 'song', volume: 0.5 },
      voice: { asset: 'logo' },
      sfx: [{ asset: 'nope', atFrame: 10 }, { asset: 'song', atFrame: 5000 }],
    };
    const paths = issuesOf(m).map((i) => i.path);
    expect(paths).toContain('audio.voice.asset');
    expect(paths).toContain('audio.sfx.0.asset');
    expect(paths).toContain('audio.sfx.1.atFrame');
  });

  it('accepts a voice to be generated later, with a warning', () => {
    const m = v02();
    m.audio = { voice: { provider: 'elevenlabs', text: 'Hello', voiceId: 'abc' } };
    const r = parseProject(m);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.path === 'audio.voice.asset')).toBe(true);
    m.audio = { voice: { volume: 1 } };
    expect(issuesOf(m).some((i) => i.path === 'audio.voice')).toBe(true);
  });

  it('validates asset URIs', () => {
    for (const uri of ['file:///etc/passwd', 'http://example.com/a.mp3', 'project://../x', 'asset://nope', '/abs']) {
      const m = v02();
      m.assets = [{ id: 'a', uri, mediaType: 'audio' }];
      expect(issuesOf(m).some((i) => i.path === 'assets.0.uri'), uri).toBe(true);
    }
    const m = v02();
    m.assets = [{ id: 'a', uri: 'https://example.com/a.mp3', mediaType: 'audio', license: { name: 'CC0-1.0', redistributable: true } }];
    const r = parseProject(m);
    expect(r.ok && r.warnings.some((w) => w.path === 'assets.0.uri')).toBe(true);
  });

  it('accepts only "cut" transitions for now', () => {
    const m = v02();
    m.scenes[1].transitionIn = { type: 'cut' };
    expect(parseProject(m).ok).toBe(true);
    m.scenes[1].transitionIn = { type: 'crossfade' };
    expect(issuesOf(m).some((i) => i.message.includes('only "cut"'))).toBe(true);
  });

  it('accepts a brief and warns when the timing misses the target', () => {
    const m = v02();
    m.brief = { title: 'Sample', goal: 'Show the product', targetSeconds: 30, platform: 'instagram-reels', language: 'en' };
    const r = parseProject(m);
    expect(r.ok && r.warnings.some((w) => w.path === 'brief.targetSeconds')).toBe(true);
  });

  it('exports a JSON Schema naming the current version and engines', () => {
    const s = JSON.stringify(projectJsonSchema());
    expect(s).toContain('"0.2"');
    expect(s).toContain('hyperframes');
    expect(s).toContain('durationSeconds');
  });
});

describe('themes', () => {
  it('ships default and midnight, both valid', () => {
    expect(BUILTIN_THEMES.map((t) => t.id)).toEqual(['default', 'midnight']);
    for (const t of BUILTIN_THEMES) expect(theme.safeParse(t).success).toBe(true);
  });

  it('merges partial tokens on top of a base', () => {
    const base = builtinTheme('default')!.tokens;
    const merged = mergeTokens(base, { colors: { accent: '#123456' }, motionSpeed: 2 });
    expect(merged.colors.accent).toBe('#123456');
    expect(merged.colors.background).toBe(base.colors.background);
    expect(merged.motionSpeed).toBe(2);
  });
});
