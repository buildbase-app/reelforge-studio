import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_SCENES,
  SUPPORTED_FPS,
  fpsArg,
  fpsLabel,
  fpsRational,
  fpsValue,
  framesToSeconds,
  parseFrameRate,
  sceneFrames,
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
    for (const fps of [29, 120, 0, -30, 'abc', '30/0', { num: 1, den: 3 }, { num: 30 }, 29.9]) {
      const p = clone();
      (p.output as { fps: unknown }).fps = fps;
      expect(issuesOf(p).some((i) => i.path.startsWith('output.fps')), JSON.stringify(fps)).toBe(true);
    }
  });

  it('says which frame rates are supported when one is not (#322)', () => {
    for (const [fps, got] of [[23, '23'], [0, '0'], [120, '120'], ['31', '"31"']] as const) {
      const p = clone();
      (p.output as { fps: unknown }).fps = fps;
      const issue = issuesOf(p).find((i) => i.path === 'output.fps');
      expect(issue?.message, String(fps)).toBe(
        `fps must be one of 23.976 ("24000/1001"), 24, 25, 29.97 ("30000/1001"), 30, 48, 50, 59.94 ("60000/1001"), 60; give NTSC rates as "30000/1001", { "num": 30000, "den": 1001 } or 29.97 (got ${got})`
      );
    }
  });

  it('accepts every supported rate as a number, a "num/den" string or { num, den }, and stores it exactly (#302)', () => {
    const cases: Array<[unknown, unknown]> = [
      [24, 24], [25, 25], [30, 30], [48, 48], [50, 50], [60, 60],
      ['30', 30], ['30/1', 30], [{ num: 60, den: 2 }, 30],
      [23.976, '24000/1001'], [23.98, '24000/1001'], ['24000/1001', '24000/1001'], [{ num: 24000, den: 1001 }, '24000/1001'],
      [29.97, '30000/1001'], ['29.97', '30000/1001'], ['30000/1001', '30000/1001'], [{ num: 30000, den: 1001 }, '30000/1001'],
      [59.94, '60000/1001'], ['60000/1001', '60000/1001'],
    ];
    for (const [input, stored] of cases) {
      const p = clone();
      (p.output as { fps: unknown }).fps = input;
      const r = parseProject(p);
      expect(r.ok, JSON.stringify(input)).toBe(true);
      if (r.ok) expect(r.project.output.fps, JSON.stringify(input)).toBe(stored);
    }
    expect(SUPPORTED_FPS).toEqual(['24000/1001', 24, 25, '30000/1001', 30, 48, 50, '60000/1001', 60]);
    // An exact fraction is never rounded to an NTSC rate.
    expect(parseFrameRate('2997/100')).toBeNull();
    expect(parseFrameRate(29.97)).toBe('30000/1001');
  });

  it('frame rate helpers are exact (#302)', () => {
    expect(fpsArg('30000/1001')).toBe('30000/1001');
    expect(fpsArg(30)).toBe('30');
    expect(fpsArg(30000 / 1001)).toBe('30000/1001');
    expect(fpsRational('24000/1001')).toEqual({ num: 24000, den: 1001 });
    expect(fpsLabel('60000/1001')).toBe('59.94');
    expect(fpsValue('30000/1001')).toBeCloseTo(29.97003, 5);
    // 30000 frames at 29.97 are exactly 1001 s.
    expect(framesToSeconds(30000, '30000/1001')).toBe(1001);
    expect(framesToSeconds(90, 30)).toBe(3);
    // Seconds round to whole frames at the exact rate: 10 s at 29.97 is 299.7 -> 300 frames.
    expect(sceneFrames({ durationSeconds: 10 }, '30000/1001')).toBe(300);
    expect(sceneFrames({ durationSeconds: 10 }, '24000/1001')).toBe(240);
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

  it('rejects projects longer than the manifest bound (4 h); shorter ones are left to the server limit (#302)', () => {
    const p = clone();
    const scenes = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `s${i}`, engine: 'motion-canvas', template: 'animated-explainer', durationFrames: 20 * 30, props: { title: 'T', points: ['a'] } }));
    // 200 s: valid as a manifest; limits.maxRenderSeconds (default 180) refuses the render (packages/core limits).
    p.scenes = scenes(10);
    expect(parseProject(p).ok).toBe(true);
    // 721 x 20 s = 14420 s, past 4 hours.
    p.scenes = scenes(721);
    expect(issuesOf(p).some((i) => i.message === 'project is 14420.0s; the limit is 14400s')).toBe(true);
    p.scenes = scenes(MAX_SCENES + 1);
    expect(issuesOf(p).some((i) => i.path === 'scenes')).toBe(true);
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
