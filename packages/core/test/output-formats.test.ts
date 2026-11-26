/**
 * Output formats (#302): every format rendered through the service with the
 * fake engines (no browser) and checked with ffprobe: codec, profile, pixel
 * format, alpha plane, frame count, duration, audio present or absent; GIF
 * size and frames; PNG zip entries; audio only; sidecar captions for every
 * format and burned captions where there are pictures; storage, content types
 * and signed downloads; every invalid combination refused with 422 before a
 * job is queued. Each ffprobe result is printed as one row of the PR's table.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alphaStats, checkAvSync, encodersOf, measureEbur128, probe, probeAudio, resolveTools, zipEntries, zipPngHeader } from '@renderweld/media-pipeline';
import { PluginRegistry, ReelforgeService, createMemoryRepositories } from '../src/index';
import { fakeEngine, makeTone, tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-output-formats-');
let svc: ReelforgeService;
const tools = resolveTools();
const W = 192;
const H = 108;
const FPS = 30;
const html = fakeEngine('html', { alpha: true });
const remotion = fakeEngine('remotion');

beforeAll(async () => {
  await makeTone(join(dir, 'tone.mp3'), 3);
  svc = await ReelforgeService.create(new PluginRegistry().registerEngine(remotion).registerEngine(html), {
    repositories: createMemoryRepositories(),
    dataDir: join(dir, 'data'),
    publicUrl: 'https://studio.example.com/',
    configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } },
  });
});
afterAll(async () => {
  await svc.jobs.shutdown(0);
  await svc.stop();
  cleanup();
});

const CUES = [{ start: 0.1, end: 1.2, text: 'Every format keeps its captions.' }];

function manifest(projectId: string, output: Record<string, unknown>, opts: { engines?: string[]; captions?: string; variants?: unknown[] } = {}) {
  const engines = opts.engines ?? ['html', 'html'];
  return {
    schemaVersion: '0.2',
    projectId,
    title: projectId,
    output: { width: W, height: H, fps: FPS, ...output },
    ...(opts.variants ? { variants: opts.variants } : {}),
    captions: opts.captions ? { mode: opts.captions, cues: CUES } : { mode: 'off' },
    scenes: engines.map((engine, i) =>
      engine === 'html'
        ? { id: `s${i}`, engine, template: 'html-title', durationFrames: 45 + i * 3, props: { headline: 'Formats' } }
        : { id: `s${i}`, engine, template: 'kinetic-title', durationFrames: 45 + i * 3, props: { headline: 'Formats' } }
    ),
  };
}

async function create(m: ReturnType<typeof manifest>, music = true) {
  await svc.createProject(m);
  if (music) {
    await svc.uploadAsset(readFileSync(join(dir, 'tone.mp3')), { filename: 'tone.mp3', projectId: m.projectId, assetId: 'music', license: { name: 'CC0-1.0', redistributable: true } });
    await svc.setAudio(m.projectId, { music: { asset: 'music', volume: 0.6 } });
  }
}

async function renderOk(projectId: string, opts: { variant?: string; captions?: string; audio?: Record<string, unknown> } = {}) {
  const r = await svc.renderProject(projectId, { ...(opts.variant ? { variant: opts.variant } : {}), ...(opts.captions ? { captions: opts.captions } : {}), ...(opts.audio ? { audio: opts.audio } : {}) });
  const done = await svc.waitForJob(r.job.id, 120);
  if (done.status !== 'succeeded') throw new Error(`render of ${projectId} ${done.status}: ${JSON.stringify(done.error)}`);
  return svc.getRender(done.result!.renderId as string);
}

/** One row of the evidence table: what ffprobe says about the delivered file. */
const evidence: string[] = [];
afterAll(() => {
  // REELFORGE_FORMATS_EVIDENCE=<file> writes the table (Markdown) for a pull request.
  const out = process.env.REELFORGE_FORMATS_EVIDENCE;
  if (out && evidence.length) writeFileSync(out, ['| format | codec | file | ffprobe codec / profile | pix_fmt | alpha min-max | frames | duration (s) | audio |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...evidence].join('\n') + '\n');
});

const FRAMES = 45 + 48; // two scenes: 45 + 48 frames
const SECONDS = FRAMES / FPS;

describe('every output format through the service (#302)', () => {
  const video: Array<{ id: string; output: Record<string, unknown>; codec: string; profile?: string; pix: string[]; audio: string; alpha: boolean; file: string; type: string }> = [
    { id: 'mov-hq', output: { format: 'mov' }, codec: 'prores', profile: 'HQ', pix: ['yuv422p10le'], audio: 'pcm_s24le', alpha: false, file: 'final.mov', type: 'video/quicktime' },
    { id: 'mov-4444', output: { format: 'mov', codec: 'prores-4444' }, codec: 'prores', profile: '4444', pix: ['yuv444p12le', 'yuv444p10le'], audio: 'pcm_s24le', alpha: false, file: 'final.mov', type: 'video/quicktime' },
    { id: 'mov-4444-alpha', output: { format: 'mov', alpha: true }, codec: 'prores', profile: '4444', pix: ['yuva444p12le', 'yuva444p10le'], audio: 'pcm_s24le', alpha: true, file: 'final.mov', type: 'video/quicktime' },
    { id: 'webm-vp9', output: { format: 'webm' }, codec: 'vp9', pix: ['yuv420p'], audio: 'opus', alpha: false, file: 'final.webm', type: 'video/webm' },
    { id: 'webm-vp9-alpha', output: { format: 'webm', alpha: true }, codec: 'vp9', pix: ['yuv420p'], audio: 'opus', alpha: true, file: 'final.webm', type: 'video/webm' },
    { id: 'webm-av1', output: { format: 'webm', codec: 'av1' }, codec: 'av1', pix: ['yuv420p'], audio: 'opus', alpha: false, file: 'final.webm', type: 'video/webm' },
  ];
  for (const c of video) {
    it(`FMT ${c.id}: ${c.codec}${c.profile ? ` ${c.profile}` : ''}, pix_fmt, alpha ${c.alpha}, ${FRAMES} frames, ${SECONDS.toFixed(3)} s, audio ${c.audio}, sidecar captions`, async () => {
      if (c.codec === 'av1' && !['libsvtav1', 'libaom-av1'].some((e) => encodersSync.has(e))) return;
      await create(manifest(c.id, c.output, { captions: 'sidecar', ...(c.alpha ? {} : { engines: ['remotion', 'html'] }) }));
      const r = await renderOk(c.id);
      expect(r).toMatchObject({ file: c.file, contentType: c.type, alpha: c.alpha, frames: FRAMES, width: W, height: H });
      expect(r.files).toEqual(expect.arrayContaining([c.file, 'poster.png', 'render-manifest.json', 'captions.srt', 'captions.vtt', 'captions.ass']));
      expect(r.outputUrl).toBe(`https://studio.example.com/v1/renders/${r.renderId}/output?file=${c.file}`);
      expect(r.downloadUrl).toContain(`file=${c.file}`);
      const f = await svc.renderFile(r.renderId);
      expect(f.contentType).toBe(c.type);
      const info = await probe(tools.ffprobe, f.path);
      expect(info.videoCodec).toBe(c.codec);
      if (c.profile) expect(info.videoProfile).toBe(c.profile);
      expect(c.pix).toContain(info.pixelFormat);
      expect(info.frames).toBe(FRAMES);
      expect(Math.abs(info.durationSeconds - SECONDS)).toBeLessThan(1 / FPS + 0.01);
      expect(info.audioCodec).toBe(c.audio);
      if (c.codec === 'vp9') expect(info.alphaMode === true).toBe(c.alpha);
      const alpha = await alphaStats(tools.ffmpeg, f.path, 5, { vp9: c.codec === 'vp9' });
      if (c.alpha) {
        expect(alpha!.min).toBeLessThan(5); // transparent background
        expect(alpha!.max).toBeGreaterThan(250); // the opaque box
      } else expect(alpha).toBeNull();
      const m = (await svc.getRenderManifest(r.renderId)) as { output: Record<string, unknown>; checks: Record<string, string> };
      expect(m.output).toMatchObject({ file: c.file, format: c.output.format, alpha: c.alpha });
      if (c.alpha) expect(m.checks.alpha).toBe('pass');
      evidence.push(`| ${c.output.format} | ${r.codec}${c.alpha ? ' + alpha' : ''} | ${c.file} | ${info.videoCodec}${info.videoProfile && c.profile ? ` / ${info.videoProfile}` : ''} | ${info.pixelFormat}${info.alphaMode ? ' (alpha_mode=1)' : ''} | ${alpha ? `${alpha.min}-${alpha.max}` : 'none'} | ${info.frames} | ${info.durationSeconds} | ${info.audioCodec} |`);
    }, 180_000);
  }

  it('FMT gif: palette GIF at the GIF rate and size, frame count, no audio, burned captions, sidecars kept', async () => {
    await create(manifest('gif', { format: 'gif' }, { captions: 'both', engines: ['remotion', 'html'] }));
    const r = await renderOk('gif');
    expect(r).toMatchObject({ file: 'final.gif', contentType: 'image/gif', format: 'gif' });
    expect(r.files).toEqual(expect.arrayContaining(['final.gif', 'poster.png', 'captions.srt']));
    const f = await svc.renderFile(r.renderId);
    const info = await probe(tools.ffprobe, f.path);
    expect(info.videoCodec).toBe('gif');
    expect([info.width, info.height]).toEqual([W, H]); // under render.formats.gifMaxSide (480)
    expect(info.frames).toBe(Math.round(SECONDS * 15));
    expect(Math.abs(info.durationSeconds - SECONDS)).toBeLessThan(1 / 15 + 0.02);
    expect(info.hasAudio).toBe(false);
    const m = (await svc.getRenderManifest(r.renderId)) as { captions: { burned: boolean }; checks: Record<string, string>; output: { bytes: number } };
    expect(m.captions.burned).toBe(true);
    expect(m.checks.size).toBe('pass');
    expect(m.output.bytes).toBeLessThan(1_000_000);
    // No audio in a GIF: nothing mixed, and the audio checks say they were skipped (with the project's music set).
    expect(r.audio).toMatchObject({ track: 'none', reason: 'gif has no audio', checks: { avSync: 'skipped', loudness: 'skipped' } });
    expect(m.checks).toMatchObject({ avSync: 'skipped', loudness: 'skipped' });
    evidence.push(`| gif | gif | final.gif | ${info.videoCodec} | ${info.pixelFormat} | none | ${info.frames} (15 fps) | ${info.durationSeconds} | none |`);
  }, 180_000);

  it('FMT png-sequence alpha: one RGBA PNG per frame in frames.zip, no audio', async () => {
    await create(manifest('png-alpha', { format: 'png-sequence', alpha: true }, { captions: 'sidecar' }));
    const r = await renderOk('png-alpha');
    expect(r).toMatchObject({ file: 'frames.zip', contentType: 'application/zip', format: 'png-sequence', alpha: true, frames: FRAMES });
    const f = await svc.renderFile(r.renderId);
    const entries = await zipEntries(f.path);
    expect(entries).toHaveLength(FRAMES);
    expect(entries[0]!.name).toBe('frame_000001.png');
    expect(await zipPngHeader(f.path, entries[0]!)).toEqual({ width: W, height: H, colorType: 6, bitDepth: 8 });
    const png = join(dir, 'frame.png');
    writeFileSync(png, readFileSync(f.path).subarray(entries[5]!.dataOffset, entries[5]!.dataOffset + entries[5]!.bytes));
    const info = await probe(tools.ffprobe, png);
    const alpha = await alphaStats(tools.ffmpeg, png);
    expect([info.videoCodec, info.pixelFormat]).toEqual(['png', 'rgba']);
    expect(alpha!.min).toBeLessThan(5);
    expect(alpha!.max).toBeGreaterThan(250);
    expect(r.files).toEqual(expect.arrayContaining(['frames.zip', 'captions.srt']));
    expect(r.audio).toMatchObject({ track: 'none', reason: 'png-sequence has no audio', checks: { avSync: 'skipped', loudness: 'skipped' } });
    expect(r.frameRate).toBe('30/1');
    evidence.push(`| png-sequence | png + alpha | frames.zip | ${info.videoCodec} | ${info.pixelFormat} | ${alpha!.min}-${alpha!.max} | ${entries.length} entries | ${SECONDS.toFixed(6)} | none |`);
  }, 180_000);

  it('FMT png-sequence: RGB frames', async () => {
    await create(manifest('png', { format: 'png-sequence' }, { engines: ['remotion'] }), false);
    const r = await renderOk('png');
    const f = await svc.renderFile(r.renderId);
    const entries = await zipEntries(f.path);
    expect(entries).toHaveLength(45);
    expect((await zipPngHeader(f.path, entries[0]!)).colorType).toBe(2);
  }, 120_000);

  for (const [format, codec, type] of [['m4a', 'aac', 'audio/mp4'], ['wav', 'pcm_s16le', 'audio/wav']] as const) {
    it(`FMT ${format}: audio only, no video and no poster, exact length, sidecar captions, no scene rendered`, async () => {
      const before = html.renders.length + remotion.renders.length;
      await create(manifest(`audio-${format}`, { format }, { captions: 'sidecar' }));
      const r = await renderOk(`audio-${format}`);
      expect(html.renders.length + remotion.renders.length).toBe(before);
      expect(r).toMatchObject({ file: `final.${format}`, contentType: type, format });
      expect(r.posterUrl).toBeUndefined();
      expect(r.files).not.toContain('poster.png');
      expect(r.files).toEqual(expect.arrayContaining([`final.${format}`, 'captions.srt', 'captions.vtt']));
      const f = await svc.renderFile(r.renderId);
      const a = await probeAudio(tools.ffprobe, f.path);
      expect(a).toMatchObject({ hasVideo: false, audioCodec: codec, sampleRate: 48000, channels: 2 });
      expect(Math.abs(a.durationSeconds - SECONDS)).toBeLessThan(0.05);
      // The same mix and loudness normalisation as a video (social preset by default), checked on the file; no video to sync with.
      expect(r.audio).toMatchObject({ track: 'mixed', preset: 'social', normalisation: 'linear', checks: { avSync: 'skipped', loudness: 'pass' } });
      expect(Math.abs(r.audio!.measured!.integrated! - -14)).toBeLessThanOrEqual(1);
      const got = await measureEbur128(tools.ffmpeg, f.path);
      expect(Math.abs(got.integrated! - -14), `${got.integrated} LUFS`).toBeLessThanOrEqual(1);
      expect(got.truePeak!).toBeLessThanOrEqual(-2);
      evidence.push(`| ${format} | ${r.codec} | final.${format} | (no video) | - | - | - | ${a.durationSeconds} | ${a.audioCodec} |`);
    }, 120_000);
  }

  it('FMT webm at 29.97 with audio: r_frame_rate 30000/1001, A/V in sync within one frame, loudness on the social preset', async () => {
    const m = manifest('webm-ntsc', { format: 'webm', fps: '30000/1001' }, { engines: ['remotion', 'html'] });
    await create(m);
    const r = await renderOk('webm-ntsc');
    expect(r).toMatchObject({ file: 'final.webm', format: 'webm', frameRate: '30000/1001', frames: FRAMES });
    const f = await svc.renderFile(r.renderId);
    const info = await probe(tools.ffprobe, f.path);
    expect([info.videoCodec, info.audioCodec, info.frameRate, info.frames]).toEqual(['vp9', 'opus', '30000/1001', FRAMES]);
    const sync = await checkAvSync(tools.ffprobe, f.path, 30000 / 1001);
    expect(sync.problems).toEqual([]);
    expect(Math.abs(sync.audioDuration! - (FRAMES * 1001) / 30000)).toBeLessThanOrEqual(1001 / 30000);
    expect(r.audio).toMatchObject({ track: 'mixed', preset: 'social', checks: { avSync: 'pass', loudness: 'pass' } });
    const got = await measureEbur128(tools.ffmpeg, f.path);
    expect(Math.abs(got.integrated! - -14), `${got.integrated} LUFS`).toBeLessThanOrEqual(1);
    const man = (await svc.getRenderManifest(r.renderId)) as { checks: Record<string, string>; ffmpegAssembleArgs: string[] };
    expect(man.checks).toMatchObject({ metadata: 'pass', avSync: 'pass', loudness: 'pass' });
    // Two passes: VP9 video only, then Opus with the video copied.
    expect(man.ffmpegAssembleArgs).toContain('&&');
    expect(man.ffmpegAssembleArgs).toContain('libopus');
  }, 180_000);

  it('FMT muted ProRes MOV: a silent PCM track by default, no audio stream with render.audio.mutedTrack "none"', async () => {
    await create(manifest('mov-muted', { format: 'mov' }, { engines: ['remotion'] }));
    const silent = await renderOk('mov-muted', { audio: { mute: true } });
    expect(silent.audio).toMatchObject({ track: 'silent', reason: 'muted', checks: { avSync: 'pass', loudness: 'skipped' } });
    const s = await probe(tools.ffprobe, (await svc.renderFile(silent.renderId)).path);
    expect([s.videoCodec, s.videoProfile, s.audioCodec]).toEqual(['prores', 'HQ', 'pcm_s24le']);
    expect((await measureEbur128(tools.ffmpeg, (await svc.renderFile(silent.renderId)).path)).integrated).toBeNull();
    await svc.updateConfig({ 'render.audio.mutedTrack': 'none' });
    try {
      const none = await renderOk('mov-muted', { audio: { mute: true } });
      expect(none.audio).toMatchObject({ track: 'none', checks: { avSync: 'skipped', loudness: 'skipped' } });
      const n = await probe(tools.ffprobe, (await svc.renderFile(none.renderId)).path);
      expect([n.videoCodec, n.hasAudio, n.frames]).toEqual(['prores', false, 45]);
      // An audio-only render has nothing to write without a track.
      await create(manifest('m4a-muted', { format: 'm4a' }));
      const job = await svc.renderProject('m4a-muted', { audio: { mute: true } });
      const done = await svc.waitForJob(job.job.id, 60);
      expect(done.status).toBe('failed');
      expect(JSON.stringify(done.error)).toContain('nothing to write');
    } finally {
      await svc.updateConfig({ 'render.audio.mutedTrack': null });
    }
  }, 180_000);

  it('FMT mp4 is unchanged: H.264 yuv420p with AAC at final.mp4', async () => {
    await create(manifest('mp4', { format: 'mp4' }, { engines: ['remotion'] }), false);
    const r = await renderOk('mp4');
    expect(r).toMatchObject({ file: 'final.mp4', format: 'mp4', codec: 'h264', alpha: false, contentType: 'video/mp4' });
    expect(r.outputUrl).toBe(`https://studio.example.com/v1/renders/${r.renderId}/output`);
    const info = await probe(tools.ffprobe, (await svc.renderFile(r.renderId)).path);
    expect([info.videoCodec, info.pixelFormat, info.audioCodec]).toEqual(['h264', 'yuv420p', 'aac']);
  }, 120_000);

  it('FMT burned captions over alpha: libass draws into the alpha channel (mov ProRes 4444)', async () => {
    await create(manifest('alpha-burn', { format: 'mov', alpha: true }, { captions: 'burned' }), false);
    const r = await renderOk('alpha-burn');
    const m = (await svc.getRenderManifest(r.renderId)) as { captions: { burned: boolean } };
    expect(m.captions.burned).toBe(true);
    const f = await svc.renderFile(r.renderId);
    const info = await probe(tools.ffprobe, f.path);
    expect(info.pixelFormat).toMatch(/^yuva/);
  }, 120_000);

  it('FMT variants: one project renders mov alpha, webm and gif variants, each in its own format', async () => {
    await create(
      manifest('multi', { format: 'mov', alpha: true }, {
        variants: [
          { id: 'overlay', width: W, height: H },
          { id: 'web', width: H, height: H, format: 'webm', alpha: false },
          { id: 'gif', width: W, height: H, format: 'gif' },
        ],
      }),
      false
    );
    const r = await svc.renderProject('multi');
    const files: string[] = [];
    for (const j of r.jobs!) {
      const done = await svc.waitForJob(j.id, 120);
      expect(done.status).toBe('succeeded');
      const s = await svc.getRender(done.result!.renderId as string);
      files.push(`${s.file}:${s.alpha}:${s.width}x${s.height}`);
    }
    expect(files).toEqual([`final.mov:true:${W}x${H}`, `final.webm:false:${H}x${H}`, `final.gif:false:${W}x${H}`]);
  }, 240_000);

  it('FMT previews stay H.264 MP4 whatever the format', async () => {
    const job = await svc.preview('gif', { scale: 1 / 2 });
    const done = await svc.waitForJob(job.id, 60);
    expect(done.status).toBe('succeeded');
    expect(done.result).toMatchObject({ file: 'final.mp4', format: 'mp4' });
  }, 60_000);
});

let encodersSync = new Set<string>();
beforeAll(async () => {
  encodersSync = await encodersOf(tools.ffmpeg);
});

describe('invalid combinations are refused with 422 before a job is queued (#302)', () => {
  const refused = async (id: string, m: ReturnType<typeof manifest>, path: RegExp, message: RegExp, opts: { music?: boolean; captions?: string; variant?: string } = {}) => {
    await create(m, opts.music ?? true);
    const queued = (await svc.jobs.list({ projectId: id })).length;
    const err = await svc.renderProject(id, { ...(opts.captions ? { captions: opts.captions } : {}), ...(opts.variant ? { variant: opts.variant } : {}) }).then(
      () => null,
      (e: unknown) => e as { status: number; code: string; details: { issues: Array<{ path: string; message: string }> } }
    );
    expect(err, id).not.toBeNull();
    expect(err!.status).toBe(422);
    expect(err!.code).toBe('unsupported_output');
    expect(err!.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringMatching(path), message: expect.stringMatching(message) })]));
    expect((await svc.jobs.list({ projectId: id })).length).toBe(queued);
    // validate_project lists the same problem (with the manifest's own captions mode).
    if (!opts.captions) {
      const v = await svc.validateProject(id);
      expect(v.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringMatching(path), message: expect.stringMatching(message) })]));
    }
  };

  it('REF-01 alpha with an engine that cannot render a transparent background', async () => {
    await refused('ref-engine', manifest('ref-engine', { format: 'webm', alpha: true }, { engines: ['html', 'remotion'] }), /^output\.alpha$/, /engine "remotion" cannot render a transparent background \(engines that can: html\)/);
  });
  it('REF-02 audio only without any audio', async () => {
    await refused('ref-noaudio', manifest('ref-noaudio', { format: 'wav' }), /^output\.format$/, /no audio to export/, { music: false });
  });
  it('REF-03 audio only with burned captions (manifest, and render_project captions override)', async () => {
    await refused('ref-burn', manifest('ref-burn', { format: 'm4a' }, { captions: 'burned' }), /^output\.format$/, /captions mode "burned" burns captions into pictures, and m4a has none/);
    await refused('ref-burn2', manifest('ref-burn2', { format: 'm4a' }, { captions: 'sidecar' }), /^output\.format$/, /captions mode "both"/, { captions: 'both' });
  });
  it('REF-04 GIF longer than render.formats.gifMaxSeconds', async () => {
    await svc.settings.update({ 'render.formats.gifMaxSeconds': 1 });
    try {
      await refused('ref-gif', manifest('ref-gif', { format: 'gif' }), /^output\.format$/, /GIF output is limited to 1 s/);
    } finally {
      await svc.settings.update({ 'render.formats.gifMaxSeconds': null });
    }
  });
  it('REF-05 a variant with an alpha engine problem refuses the whole batch; naming another variant renders it', async () => {
    const m = manifest('ref-variant', { format: 'mp4' }, { engines: ['remotion'], variants: [{ id: 'ok', width: W, height: H }, { id: 'clear', width: W, height: H, format: 'mov', alpha: true }] });
    await refused('ref-variant', m, /^variants\.1\.alpha$/, /variant "clear" .*engine "remotion" cannot render a transparent background/);
    const one = await svc.renderProject('ref-variant', { variant: 'ok' });
    expect(one.job.status).toMatch(/queued|running|succeeded/);
    await svc.waitForJob(one.job.id, 60);
  });
  it('REF-06 schema-level combinations: invalid_manifest 422 with the field', async () => {
    for (const [output, path] of [
      [{ format: 'gif', alpha: true }, 'output.alpha'],
      [{ format: 'mp4', alpha: true }, 'output.alpha'],
      [{ format: 'webm', codec: 'av1', alpha: true }, 'output.alpha'],
      [{ format: 'mov', codec: 'prores-422-hq', alpha: true }, 'output.alpha'],
      [{ format: 'm4a', alpha: true }, 'output.alpha'],
      [{ format: 'png-sequence', codec: 'gif' }, 'output.codec'],
      [{ format: 'webm', codec: 'h264' }, 'output.codec'],
      [{ format: 'mp4', codec: 'hevc' }, 'output.codec'],
      [{ format: 'mkv' }, 'output.format'],
    ] as const) {
      const err = await svc.createProject(manifest(`bad-${path.replace('.', '-')}-${String((output as { format: string }).format)}`, output)).then(
        () => null,
        (e: unknown) => e as { status: number; code: string; details: { issues: Array<{ path: string }> } }
      );
      expect(err, JSON.stringify(output)).not.toBeNull();
      expect([err!.status, err!.code]).toEqual([422, 'invalid_manifest']);
      expect(err!.details.issues.map((i) => i.path)).toContain(path);
    }
  });
});
