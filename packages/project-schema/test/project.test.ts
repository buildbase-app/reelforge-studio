import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_FPS,
  parseProject,
  projectJsonSchema,
  timeline,
  totalFrames,
  type ProjectInput,
} from '../src/index';

const sample = JSON.parse(
  readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8')
) as ProjectInput;

function clone(): any {
  return structuredClone(sample);
}

function issuesOf(input: unknown) {
  const r = parseProject(input);
  if (r.ok) throw new Error('expected validation to fail');
  return r.issues;
}

describe('parseProject', () => {
  it('accepts the bundled sample project', () => {
    const r = parseProject(sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.project.scenes).toHaveLength(2);
      expect(r.warnings).toEqual([]);
    }
  });

  it('rejects a missing schemaVersion', () => {
    const p = clone();
    delete p.schemaVersion;
    expect(issuesOf(p).some((i) => i.path === 'schemaVersion')).toBe(true);
  });

  it('rejects an unsupported schemaVersion', () => {
    const p = clone();
    p.schemaVersion = '9.9';
    expect(issuesOf(p).some((i) => i.path === 'schemaVersion')).toBe(true);
  });

  it('rejects duplicate scene ids', () => {
    const p = clone();
    p.scenes[1].id = p.scenes[0].id;
    expect(issuesOf(p).some((i) => i.message.includes('duplicate scene id'))).toBe(true);
  });

  it('rejects negative and zero durations', () => {
    for (const d of [-30, 0]) {
      const p = clone();
      p.scenes[0].durationFrames = d;
      expect(issuesOf(p).some((i) => i.path === 'scenes.0.durationFrames')).toBe(true);
    }
  });

  it('rejects unsupported frame rates', () => {
    const p = clone();
    p.output.fps = 29.97;
    expect(issuesOf(p).some((i) => i.path.startsWith('output.fps'))).toBe(true);
  });

  it('says which frame rates are supported when one is not (#322)', () => {
    for (const [fps, got] of [[23.976, '23.976'], [50, '50'], [0, '0'], [120, '120'], ['30', '"30"']] as const) {
      const p = clone();
      (p.output as { fps: unknown }).fps = fps;
      const issue = issuesOf(p).find((i) => i.path === 'output.fps');
      expect(issue?.message, String(fps)).toBe(`fps must be one of ${SUPPORTED_FPS.join(', ')} (got ${got})`);
    }
  });

  it('rejects odd or out-of-range dimensions', () => {
    const odd = clone();
    odd.output.width = 1081;
    expect(issuesOf(odd).some((i) => i.message.includes('even'))).toBe(true);
    const huge = clone();
    huge.output.height = 10000;
    expect(issuesOf(huge).some((i) => i.path === 'output.height')).toBe(true);
  });

  it('rejects unknown engines instead of mapping them to another engine', () => {
    const p = clone();
    p.scenes[0].engine = 'after-effects';
    expect(issuesOf(p).some((i) => i.path === 'scenes.0.engine')).toBe(true);
  });

  it('rejects a template used with the wrong engine', () => {
    const p = clone();
    p.scenes[0].engine = 'motion-canvas';
    expect(issuesOf(p).some((i) => i.message.includes('belongs to engine "remotion"'))).toBe(
      true
    );
  });

  it('rejects unknown templates', () => {
    const p = clone();
    p.scenes[1].template = 'does-not-exist';
    expect(issuesOf(p).some((i) => i.message.includes('unknown template'))).toBe(true);
  });

  it('rejects malformed template props and reports their path', () => {
    const p = clone();
    p.scenes[0].props = { headline: '', accent: 'red', extra: 1 };
    const paths = issuesOf(p).map((i) => i.path);
    expect(paths).toContain('scenes.0.props.headline');
    expect(paths).toContain('scenes.0.props.accent');
    expect(paths.some((x) => x.startsWith('scenes.0.props'))).toBe(true);
  });

  it('rejects text longer than the template allows', () => {
    const p = clone();
    p.scenes[0].props.headline = 'x'.repeat(61);
    expect(issuesOf(p).some((i) => i.path === 'scenes.0.props.headline')).toBe(true);
  });

  it('rejects scene durations outside the template range', () => {
    const p = clone();
    p.scenes[0].durationFrames = 30 * 30; // 30 s, kinetic-title max is 8 s
    expect(issuesOf(p).some((i) => i.message.includes('supports'))).toBe(true);
  });

  it('rejects startFrame values that would leave gaps or overlaps', () => {
    const p = clone();
    p.scenes[0].startFrame = 0;
    p.scenes[1].startFrame = 60; // overlaps scene 0, which ends at 90
    expect(issuesOf(p).some((i) => i.path === 'scenes.1.startFrame')).toBe(true);
    p.scenes[1].startFrame = 90;
    expect(parseProject(p).ok).toBe(true);
  });

  it('rejects unknown asset ids in scenes and audio', () => {
    const p = clone();
    p.scenes[0].assets = ['nope'];
    p.audio.musicTrack = 'missing-track';
    const paths = issuesOf(p).map((i) => i.path);
    expect(paths).toContain('scenes.0.assets.0');
    expect(paths).toContain('audio.musicTrack');
  });

  it('rejects a non-audio asset used as the music track', () => {
    const p = clone();
    p.assets = [{ id: 'logo', path: 'assets/logo.png', mediaType: 'image' }];
    p.audio.musicTrack = 'logo';
    expect(issuesOf(p).some((i) => i.message.includes('expected audio'))).toBe(true);
  });

  it('rejects unsafe asset paths', () => {
    for (const path of [
      '../secrets.txt',
      'assets/../../etc/passwd',
      '/etc/passwd',
      'C:/Windows/win.ini',
      'assets\\music.mp3',
      'https://example.com/a.mp3',
      'file:///etc/passwd',
      'a\0b.mp3',
    ]) {
      const p = clone();
      p.assets = [{ id: 'a', path, mediaType: 'audio' }];
      expect(issuesOf(p).some((i) => i.path === 'assets.0.path'), path).toBe(true);
    }
  });

  it('accepts unicode and spaces in a safe relative path', () => {
    const p = clone();
    p.assets = [
      {
        id: 'a',
        path: 'assets/música de fondo.mp3',
        mediaType: 'audio',
        license: { name: 'CC0-1.0', redistributable: true },
      },
    ];
    expect(parseProject(p).ok).toBe(true);
  });

  it('warns, but does not fail, when an asset has no license metadata', () => {
    const p = clone();
    p.assets = [{ id: 'a', path: 'assets/a.mp3', mediaType: 'audio' }];
    const r = parseProject(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings[0]?.path).toBe('assets.0.license');
  });

  it('rejects unknown top-level keys (typos should not pass silently)', () => {
    const p = clone();
    p.scences = [];
    expect(issuesOf(p).length).toBeGreaterThan(0);
  });

  it('rejects projects longer than the limit', () => {
    const p = clone();
    p.scenes = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      engine: 'motion-canvas',
      template: 'animated-explainer',
      durationFrames: 20 * 30,
      props: { title: 'T', points: ['a'] },
    }));
    expect(issuesOf(p).some((i) => i.message.includes('limit is'))).toBe(true);
  });

  it('reports every problem at once and never throws on garbage input', () => {
    for (const bad of [null, 42, 'x', [], {}]) {
      const r = parseProject(bad);
      expect(r.ok).toBe(false);
    }
    const p = clone();
    p.scenes[0].id = 'BAD ID';
    p.output.fps = 7;
    expect(issuesOf(p).length).toBeGreaterThanOrEqual(2);
  });
});

describe('timeline', () => {
  it('lays scenes back to back with exact frame boundaries', () => {
    const r = parseProject(sample);
    if (!r.ok) throw new Error('sample should be valid');
    const t = timeline(r.project);
    expect(t.map((s) => [s.startFrame, s.endFrame])).toEqual([
      [0, 90],
      [90, 210],
    ]);
    expect(totalFrames(r.project)).toBe(210);
  });
});

describe('projectJsonSchema', () => {
  it('produces a JSON Schema that external agents can use', () => {
    const schema = projectJsonSchema();
    expect(schema.type).toBe('object');
    expect(JSON.stringify(schema)).toContain('schemaVersion');
    expect(JSON.stringify(schema)).toContain('motion-canvas');
  });
});
