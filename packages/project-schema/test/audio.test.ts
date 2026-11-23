import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DUCKING_DEFAULTS, LOUDNESS_TARGETS, migrate, parseProject, renderAudioOptions, resolveDucking } from '../src/index';

const sampleV01 = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8')) as Record<string, unknown>;
/** The sample (v0.2) with a music asset and track. */
function v02(): any {
  const r = migrate(sampleV01);
  if (!r.ok) throw new Error('sample must migrate');
  const m = structuredClone(r.manifest) as any;
  m.assets.push({ id: 'song', uri: 'project://song.wav', mediaType: 'audio', license: { name: 'CC0-1.0', redistributable: true } });
  m.audio = { ...m.audio, music: { asset: 'song' } };
  return m;
}

describe('manifest audio settings (#301, #298)', () => {
  it('accepts loudness, mute, bus toggles, bus gains, music fades and tuned ducking', () => {
    const m = v02();
    m.assets.push({ id: 'vo', uri: 'project://vo.wav', mediaType: 'audio', license: { name: 'own', redistributable: true } });
    m.audio = {
      ...m.audio,
      voice: { asset: 'vo' },
      music: { ...m.audio.music, fadeInSeconds: 0.5, ducking: { depthDb: 20, releaseMs: 600 } },
      loudness: 'broadcast-ebu',
      mute: false,
      enabled: { sfx: false },
      gainDb: { music: -3, voice: 2 },
    };
    const r = parseProject(m);
    expect(r.ok, JSON.stringify(!r.ok && r.issues)).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.filter((w) => w.path.startsWith('audio'))).toEqual([]);
    expect(resolveDucking(r.project.audio.music!.ducking)).toEqual({ ...DUCKING_DEFAULTS, depthDb: 20, releaseMs: 600 });
  });

  it('rejects unknown presets, gains out of range and unknown keys, all at once', () => {
    const m = v02();
    m.audio = { ...m.audio, loudness: 'loud', gainDb: { music: 40 }, enabled: { drums: false } };
    const r = parseProject(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path).sort()).toEqual(['audio.enabled', 'audio.gainDb.music', 'audio.loudness']);
  });

  it('warns about ducking without a voice; ducking: true uses the defaults; false is off', () => {
    const m = v02();
    m.audio.music.ducking = true;
    const r = parseProject(m);
    if (!r.ok) throw new Error('valid');
    expect(r.warnings.map((w) => w.path)).toContain('audio.music.ducking');
    expect(resolveDucking(true)).toEqual(DUCKING_DEFAULTS);
    expect(resolveDucking(false)).toBeNull();
  });

  it('render options are strict and the presets carry their targets', () => {
    expect(renderAudioOptions.safeParse({ mute: true, music: false, loudness: 'podcast' }).success).toBe(true);
    expect(renderAudioOptions.safeParse({ volume: 2 }).success).toBe(false);
    expect(LOUDNESS_TARGETS.social).toMatchObject({ integrated: -14, truePeak: -2 });
    expect(LOUDNESS_TARGETS['broadcast-ebu']).toMatchObject({ integrated: -23, truePeak: -1 });
    expect(LOUDNESS_TARGETS['broadcast-atsc']).toMatchObject({ integrated: -24, truePeak: -2 });
    expect(LOUDNESS_TARGETS.podcast).toMatchObject({ integrated: -16, truePeak: -1 });
  });
});
