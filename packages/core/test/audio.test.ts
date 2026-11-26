import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureEbur128, probe, resolveTools, run } from '@renderweld/media-pipeline';
import { parseProject } from '@renderweld/project-schema';
import { AUDIO_DEFAULTS, PluginRegistry, ReelforgeService, createMemoryRepositories, resolveAudioPlan, sfxMaskingIssues, verifyAudio, type AudioManifest } from '../src/index';
import { fakeEngine, tempDir } from './helpers';

// Renders through the service with the fake engines and synthetic audio (#301, #298): loudness after the final AAC
// encode, ducking, toggles, muted output, A/V sync, and the QA rule.
const { dir, cleanup } = tempDir('reelforge-audio-');
afterAll(cleanup);
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const tools = resolveTools();
let svc: ReelforgeService;

async function wav(name: string, source: string, filter = 'anull') {
  const file = join(dir, name);
  await run(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-af', `${filter},pan=stereo|c0=c0|c1=c0,aformat=sample_rates=48000`, file], 'fixture');
  return readFileSync(file);
}

beforeAll(async () => {
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));
  svc = await ReelforgeService.create(registry, { repositories: createMemoryRepositories(), dataDir: join(dir, 'data'), configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } } });
  await svc.createProject({ ...sample, projectId: 'mix' });
  const lic = { name: 'CC0-1.0', redistributable: true };
  // Loud on purpose, like today's renders: tones near full scale, a voice of band-limited noise bursts, a hit.
  await svc.uploadAsset(await wav('music.wav', 'aevalsrc=0.5*sin(2*PI*220*t)+0.3*sin(2*PI*330*t):s=48000:d=8'), { filename: 'music.wav', projectId: 'mix', assetId: 'music', license: lic });
  await svc.uploadAsset(await wav('voice.wav', 'anoisesrc=d=5:c=pink:a=0.9', "highpass=f=1500,highpass=f=1500,lowpass=f=6000,volume='if(between(t,1,2.5)+between(t,3.5,4.8),1.6,0)':eval=frame"), { filename: 'voice.wav', projectId: 'mix', assetId: 'voice', license: lic });
  await svc.uploadAsset(await wav('hit.wav', 'aevalsrc=0.8*cos(2*PI*200*t):s=48000:d=0.3'), { filename: 'hit.wav', projectId: 'mix', assetId: 'hit', license: lic });
  await svc.setAudio('mix', { music: { asset: 'music', volume: 1, ducking: true }, voice: { asset: 'voice', startFrame: 15 }, sfx: [{ asset: 'hit', atFrame: 90 }] });
}, 120_000);

async function render(opts: { audio?: unknown } = {}) {
  const job = await svc.startRender('mix', opts);
  const done = await svc.jobs.waitFor(job.id, 240_000);
  expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
  const id = done.result!.renderId as string;
  return { id, file: (await svc.renderFile(id)).path, manifest: (await svc.getRenderManifest(id)) as { audio: AudioManifest; checks: Record<string, string> } };
}

describe('render audio', () => {
  it('AUD-10 normalises the default render to social (-14 LUFS, <= -2 dBTP) measured after the final AAC encode, ducks the music under the voice, and records it', async () => {
    const { id, file, manifest } = await render();
    const a = manifest.audio;
    expect(a.track).toBe('mixed');
    expect(a.loudness.preset).toBe('social');
    expect(a.loudness.input!.integrated!).toBeGreaterThan(-12); // the mix as it was rendered before #301
    // Measured independently on the delivered file, and as recorded.
    const got = await measureEbur128(tools.ffmpeg, file);
    expect(Math.abs(got.integrated! + 14)).toBeLessThanOrEqual(1);
    expect(got.truePeak!).toBeLessThanOrEqual(-2);
    expect(a.loudness.measured).toEqual(got);
    expect(a.ducking!.windows.length).toBe(2);
    expect(a.ducking!.windows[0]![0]).toBeCloseTo(1.5, 1); // voice starts at frame 15 (0.5 s), speech 1 s into it
    expect(a.ducking!.depthDb).toBe(18);
    expect(a.qa).toMatchObject({ ok: true, mode: 'warn' });
    expect(a.avSync!.audioStart).toBe(0);
    expect(Math.abs(a.avSync!.audioDuration! - a.avSync!.videoDuration)).toBeLessThanOrEqual(1 / 30);
    expect(manifest.checks).toMatchObject({ avSync: 'pass', loudness: 'pass' });
    const summary = await svc.getRender(id);
    expect(summary.audio).toMatchObject({ track: 'mixed', preset: 'social', target: { integrated: -14, truePeak: -2 }, qa: { ok: true } });
  }, 240_000);

  it('AUD-11 a render can ask for another preset (broadcast-ebu: -23 LUFS, <= -1 dBTP)', async () => {
    const { file, manifest } = await render({ audio: { loudness: 'broadcast-ebu' } });
    const got = await measureEbur128(tools.ffmpeg, file);
    expect(Math.abs(got.integrated! + 23)).toBeLessThanOrEqual(1);
    expect(got.truePeak!).toBeLessThanOrEqual(-1);
    expect(manifest.audio.loudness.preset).toBe('broadcast-ebu');
  }, 240_000);

  it('AUD-12 toggles leave buses out for one render; the manifest keeps them', async () => {
    const { manifest } = await render({ audio: { music: false, sfx: false } });
    expect(manifest.audio.music).toBeNull();
    expect(manifest.audio.sfx).toEqual([]);
    expect(manifest.audio.voice).toMatchObject({ asset: 'voice' });
    expect(manifest.audio.ducking).toBeNull();
    expect(manifest.audio.toggles).toEqual({ mute: false, voice: true, music: false, sfx: false });
    expect((await svc.getProject('mix')).manifest.audio.music).not.toBeNull();
  }, 240_000);

  it('AUD-13 mute: a valid silent AAC track by default, no audio stream with render.audio.mutedTrack = none', async () => {
    const silent = await render({ audio: { mute: true } });
    expect(silent.manifest.audio.track).toBe('silent');
    const info = await probe(tools.ffprobe, silent.file);
    expect(info.audioCodec).toBe('aac');
    expect((await measureEbur128(tools.ffmpeg, silent.file)).integrated).toBeNull();
    expect(silent.manifest.checks.loudness).toBe('skipped');
    await svc.updateConfig({ 'render.audio.mutedTrack': 'none' });
    try {
      const none = await render({ audio: { mute: true } });
      expect(none.manifest.audio.track).toBe('none');
      expect((await probe(tools.ffprobe, none.file)).hasAudio).toBe(false);
      expect(none.manifest.checks.avSync).toBe('skipped');
    } finally {
      await svc.updateConfig({ 'render.audio.mutedTrack': null });
    }
  }, 240_000);

  it('AUD-18 music bed plus loud short SFX, no voice (#449): social within 1 LU of -14 LUFS, true peak <= -2 dBTP, peak-limited and recorded', async () => {
    await svc.createProject({ ...sample, projectId: 'sfx-mix' });
    const lic = { name: 'CC0-1.0', redistributable: true };
    // A soft pad (about -31 dBFS) and a 6 ms 2 kHz click near full scale: the click sets the true peak.
    await svc.uploadAsset(await wav('pad.wav', 'aevalsrc=0.03*sin(2*PI*220*t)+0.02*sin(2*PI*277*t)+0.02*sin(2*PI*330*t):s=48000:d=8'), { filename: 'pad.wav', projectId: 'sfx-mix', assetId: 'pad', license: lic });
    await svc.uploadAsset(await wav('click.wav', 'aevalsrc=0.95*sin(2*PI*2000*t):s=48000:d=0.006'), { filename: 'click.wav', projectId: 'sfx-mix', assetId: 'click', license: lic });
    await svc.setAudio('sfx-mix', { music: { asset: 'pad', volume: 1 }, sfx: [15, 50, 85, 120, 155, 190].map((atFrame) => ({ asset: 'click', atFrame })) });
    const job = await svc.startRender('sfx-mix');
    const done = await svc.jobs.waitFor(job.id, 240_000);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const id = done.result!.renderId as string;
    const file = (await svc.renderFile(id)).path;
    const a = ((await svc.getRenderManifest(id)) as { audio: AudioManifest }).audio;
    const got = await measureEbur128(tools.ffmpeg, file);
    expect(Math.abs(got.integrated! + 14), `${got.integrated} LUFS`).toBeLessThanOrEqual(1);
    expect(got.truePeak!, `${got.truePeak} dBTP`).toBeLessThanOrEqual(-2);
    expect(a.loudness.normalisation).toBe('limited');
    expect(a.loudness.limiter).toMatchObject({ ceilingDb: -2.8, passes: expect.any(Number) });
    expect(a.qa).toMatchObject({ ok: true, issues: [] });
    expect((await svc.getRender(id)).audio).toMatchObject({ normalisation: 'limited', checks: { loudness: 'pass', avSync: 'pass' } });
  }, 240_000);

  it('AUD-19 a peak-limited mix that still misses says why and what to change', async () => {
    const { file } = await render();
    const m: AudioManifest = {
      music: null, voice: null, sfx: [], track: 'mixed', toggles: { mute: false, voice: true, music: true, sfx: true }, gainDb: { voice: 0, music: 0, sfx: 0 }, ducking: null,
      loudness: { preset: 'broadcast-ebu', target: { integrated: -23, truePeak: -1, lra: 20, tolerance: 1, truePeakCeiling: -1 }, input: null, normalisation: 'limited', gainDb: 9.5 },
    };
    const r = await verifyAudio(tools, file, 30, m, 'warn');
    expect(r.manifest.qa!.issues.find((i) => i.rule === 'loudness.integrated')!.message).toMatch(/peak-limited .*9\.5 dB of gain.*audio\.gainDb\.sfx/);
  }, 240_000);

  it('AUD-20 a sound effect masked by the music bed is a warning with the cue, its time and a volume that clears it; a loud one passes (#459)', async () => {
    await svc.createProject({ ...sample, projectId: 'masked' });
    const lic = { name: 'CC0-1.0', redistributable: true };
    // The #459 reel in small: a loud tonal bed (about -9.6 dBFS at 0.8), a whoosh (band-passed noise swell, about -19 dBFS)
    // at half volume, so about 16 dB under the bed, and a hit at full volume well over it.
    await svc.uploadAsset(await wav('bed.wav', 'aevalsrc=0.5*sin(2*PI*220*t)+0.3*sin(2*PI*330*t):s=48000:d=8'), { filename: 'bed.wav', projectId: 'masked', assetId: 'bed', license: lic });
    await svc.uploadAsset(await wav('whoosh.wav', 'anoisesrc=d=0.6:c=white:a=0.6', "bandpass=f=1500:t=h:w=3000,volume='sin(PI*t/0.6)':eval=frame"), { filename: 'whoosh.wav', projectId: 'masked', assetId: 'whoosh', license: lic });
    await svc.uploadAsset(await wav('hit2.wav', 'aevalsrc=0.8*cos(2*PI*200*t):s=48000:d=0.3'), { filename: 'hit2.wav', projectId: 'masked', assetId: 'hit2', license: lic });
    await svc.setAudio('masked', { music: { asset: 'bed', volume: 0.8 }, sfx: [{ asset: 'whoosh', atFrame: 60, volume: 0.5 }, { asset: 'hit2', atFrame: 120, volume: 2 }] });
    const renderMasked = async () => {
      const job = await svc.startRender('masked');
      const done = await svc.jobs.waitFor(job.id, 240_000);
      expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
      const id = done.result!.renderId as string;
      return { id, manifest: (await svc.getRenderManifest(id)) as { audio: AudioManifest; checks: Record<string, string> } };
    };

    const { id, manifest } = await renderMasked();
    const a = manifest.audio;
    expect(a.sfxAudibility!.thresholdDb).toBe(3);
    const [whoosh, hit] = a.sfxAudibility!.cues;
    expect(whoosh).toMatchObject({ cue: 0, asset: 'whoosh', atSeconds: 2, windowSeconds: 0.5 });
    expect(whoosh!.marginDb!, JSON.stringify(whoosh)).toBeLessThan(-10);
    expect(whoosh!.marginDb!, JSON.stringify(whoosh)).toBeGreaterThan(-20);
    expect(hit).toMatchObject({ cue: 1, asset: 'hit2', atSeconds: 4, windowSeconds: 0.3 });
    expect(hit!.marginDb!, JSON.stringify(hit)).toBeGreaterThan(3);
    const masked = a.qa!.issues.filter((i) => i.rule === 'sfx.masked');
    expect(masked).toHaveLength(1);
    expect(masked[0]).toMatchObject({ severity: 'warn', cue: 0, asset: 'whoosh', atSeconds: 2, marginDb: whoosh!.marginDb, suggestedVolume: 2 });
    expect(masked[0]!.message).toMatch(/sound effect 0 \("whoosh" at 2 s\) is [\d.]+ dB under the music and voice under it .*raise its volume to 2 \(now 0\.5\) and lower the music by about \d+ dB/);
    // A warning, not a failure, and it does not count against loudness.
    expect(a.qa!.ok).toBe(false);
    expect(manifest.checks).toMatchObject({ sfx: 'warn', loudness: 'pass', avSync: 'pass' });
    expect((await svc.getRender(id)).audio).toMatchObject({ checks: { sfx: 'warn', loudness: 'pass' }, qa: { issues: [expect.objectContaining({ rule: 'sfx.masked', cue: 0 })] } });

    // render.audio.sfxMaskingDb is a runtime setting: lowered far enough, the same reel passes.
    await svc.updateConfig({ 'render.audio.sfxMaskingDb': -20 });
    try {
      const again = await renderMasked();
      expect(again.manifest.audio.sfxAudibility!.thresholdDb).toBe(-20);
      expect(again.manifest.audio.qa!.issues.filter((i) => i.rule === 'sfx.masked')).toEqual([]);
      expect(again.manifest.checks.sfx).toBe('pass');
    } finally {
      await svc.updateConfig({ 'render.audio.sfxMaskingDb': null });
    }
  }, 480_000);

  it('AUD-21 sound effects with nothing under them are not measured (checks.sfx skipped)', async () => {
    const { manifest } = await render({ audio: { music: false, voice: false } });
    expect(manifest.audio.sfxAudibility).toBeUndefined();
    expect(manifest.checks.sfx).toBe('skipped');
  }, 240_000);

  it('AUD-14 refuses an invalid audio option before queueing', async () => {
    await expect(svc.startRender('mix', { audio: { loudness: 'loud' } })).rejects.toMatchObject({ status: 400 });
    await expect(svc.startRender('mix', { audio: { music: 'yes' } })).rejects.toMatchObject({ status: 400 });
  });
});

describe('audio plan and QA rule', () => {
  it('a render option beats the manifest, which beats the server default', async () => {
    const v02 = (await svc.getProject('mix')).manifest;
    const r = parseProject({ ...v02, audio: { ...v02.audio, loudness: 'podcast', mute: false, enabled: { music: false } } });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(resolveAudioPlan(r.project)).toMatchObject({ loudness: 'podcast', music: false, voice: true, mute: false });
    expect(resolveAudioPlan(r.project, { loudness: 'off', music: true, mute: true })).toMatchObject({ loudness: 'off', music: true, mute: true });
    const bare = parseProject({ ...v02, audio: {} });
    if (!bare.ok) throw new Error('sample');
    expect(resolveAudioPlan(bare.project, {}, { ...AUDIO_DEFAULTS, loudness: 'broadcast-atsc' }).loudness).toBe('broadcast-atsc');
  });

  it('AUD-22 the sfx.masked message: a volume within reach, or the music to lower when 2 is not enough', () => {
    const m = (marginDb: number, volume: number): Pick<AudioManifest, 'sfx' | 'sfxAudibility'> => ({
      sfx: [{ asset: 'pop', atFrame: 45, volume }],
      sfxAudibility: { thresholdDb: 3, cues: [{ cue: 0, asset: 'pop', atSeconds: 1.5, windowSeconds: 0.2, cueDb: -20, bedDb: -20 - marginDb, marginDb }] },
    });
    // 1 dB over a 3 dB threshold: 5 dB more brings it 3 dB past it (0.5 * 10^(5/20) = 0.89).
    const near = sfxMaskingIssues(m(1, 0.5));
    expect(near).toEqual([expect.objectContaining({ rule: 'sfx.masked', severity: 'warn', cue: 0, marginDb: 1, suggestedVolume: 0.89 })]);
    expect(near[0]!.message).toMatch(/is only 1 dB over the music and voice under it \(first 0\.2 s; wanted at least 3 dB over\).*raise its volume to about 0\.89 \(now 0\.5\)/);
    // 14 dB under: 20 dB is wanted (to 6 dB over); 0.5 -> 2 gives 12 dB, the music has to give the other 8.
    const far = sfxMaskingIssues(m(-14, 0.5));
    expect(far[0]).toMatchObject({ suggestedVolume: 2 });
    expect(far[0]!.message).toMatch(/is 14 dB under .*raise its volume to 2 \(now 0\.5\) and lower the music by about 8 dB .*audio\.gainDb\.sfx/);
    // At or over the threshold, or nothing under it: no warning.
    expect(sfxMaskingIssues(m(3, 1))).toEqual([]);
    expect(sfxMaskingIssues({ sfx: [], sfxAudibility: { thresholdDb: 3, cues: [{ cue: 0, asset: 'x', atSeconds: 0, windowSeconds: 0.1, cueDb: -10, bedDb: null, marginDb: null }] } })).toEqual([]);
    expect(sfxMaskingIssues({ sfx: [] })).toEqual([]);
  });

  it('AUD-15 off-target loudness is a warning in warn mode and a failure in fail mode; the LRA guideline only warns', async () => {
    // A -14 LUFS render checked against the EBU target: 9 LU off.
    const { file } = await render();
    const manifest = (): AudioManifest => ({
      music: null, voice: null, sfx: [], track: 'mixed', toggles: { mute: false, voice: true, music: true, sfx: true }, gainDb: { voice: 0, music: 0, sfx: 0 }, ducking: null,
      loudness: { preset: 'broadcast-ebu', target: { integrated: -23, truePeak: -1, lra: 0.5, tolerance: 1, truePeakCeiling: -1 }, input: null, normalisation: 'linear' },
    });
    const warn = await verifyAudio(tools, file, 30, manifest(), 'warn');
    expect(warn.failures).toEqual([]);
    expect(warn.manifest.qa!.ok).toBe(false);
    expect(warn.manifest.qa!.issues.map((i) => i.rule)).toContain('loudness.integrated');
    const fail = await verifyAudio(tools, file, 30, manifest(), 'fail');
    expect(fail.failures.join(' ')).toMatch(/integrated loudness is -1[345]\.\d+ LUFS, target -23/);
    expect(fail.manifest.qa!.issues.find((i) => i.rule === 'loudness.lra')?.severity ?? 'warn').toBe('warn');
    expect(fail.syncProblems).toEqual([]);
  }, 240_000);
});
