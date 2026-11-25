import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTools, run } from '@renderweld/media-pipeline';
import type { CaptionCue } from '@renderweld/project-schema';
import {
  FasterWhisperStt,
  PluginRegistry,
  ReelforgeService,
  createMemoryRepositories,
  type SpeechToTextPlugin,
  type SttRequest,
  type SttResult,
} from '../src/index';
import { fakeEngine, makeTone, tempDir } from './helpers';

/**
 * Captions PR 2 (#300, D-114): speech-to-text with a fake provider, the
 * approval tools (get_captions / update_captions with an etag), several
 * languages per render, audio-description tracks and the server default mode.
 */

const { dir, cleanup } = tempDir('reelforge-captions2-');
afterAll(cleanup);
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const tools = resolveTools();

/** Returns fixed word timings, as faster-whisper would for "Made on your own machine." */
class FakeStt implements SpeechToTextPlugin {
  readonly id = 'fake-stt';
  readonly displayName = 'Fake speech-to-text (tests)';
  available = true;
  calls: SttRequest[] = [];
  availability() {
    return this.available ? { ok: true } : { ok: false, reason: 'not installed (test)' };
  }
  async transcribe(req: SttRequest): Promise<SttResult> {
    this.calls.push(req);
    return {
      language: 'en',
      durationSeconds: 2,
      engine: { name: 'fake' },
      words: [
        { text: 'Made', start: 0.5, end: 0.8 },
        { text: 'on', start: 0.85, end: 1 },
        { text: 'your', start: 1.05, end: 1.3 },
        { text: 'own', start: 1.35, end: 1.6 },
        { text: 'machine.', start: 1.65, end: 2.2 },
      ],
    };
  }
}

async function regionStats(file: string, frame: number, r: { x: number; y: number; w: number; h: number }) {
  const { stdout } = await run(
    tools.ffmpeg,
    ['-hide_banner', '-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),crop=${r.w}:${r.h}:${r.x}:${r.y},signalstats,metadata=print:file=-`, '-frames:v', '1', '-f', 'null', '-'],
    'region-stats'
  );
  return { yMax: Number(/lavfi\.signalstats\.YMAX=([0-9.]+)/.exec(stdout)![1]) };
}

let svc: ReelforgeService;
const stt = new FakeStt();

beforeAll(async () => {
  await makeTone(join(dir, 'tone.mp3'), 2);
  const registry = new PluginRegistry()
    .registerEngine(fakeEngine('remotion'))
    .registerEngine(fakeEngine('motion-canvas'))
    .registerStt(stt)
    .registerStt(new FasterWhisperStt({ env: { PATH: '' } }));
  svc = await ReelforgeService.create(registry, {
    repositories: createMemoryRepositories(),
    dataDir: join(dir, 'data'),
    publicUrl: 'https://studio.example.com/',
    configSources: { env: { REELFORGE_LICENCE_MODE: 'off', REELFORGE_STT_PROVIDER: 'fake-stt' } },
  });
  await svc.createProject({ ...sample, projectId: 'cap2', output: { ...sample.output, width: 540, height: 960 } });
});

describe('speech-to-text (fake provider)', () => {
  it('reports in capabilities whether speech-to-text can run', () => {
    const c = svc.capabilities().captions;
    expect(c).toMatchObject({ modes: ['off', 'burned', 'sidecar', 'both'], defaultMode: 'off', stt: { available: true, provider: 'fake-stt', model: 'small', language: 'auto', computeType: 'int8' } });
    const fw = c.stt.providers.find((p) => p.id === 'faster-whisper')!;
    expect(fw.available).toBe(false);
    expect(fw.reason).toContain('deployment/stt');
  });

  it('refuses without a voice track, and when the provider is not available', async () => {
    await expect(svc.transcribeCaptions('cap2', {})).rejects.toMatchObject({ code: 'no_voice_track', status: 409 });
    stt.available = false;
    await expect(svc.transcribeCaptions('cap2', {})).rejects.toMatchObject({ code: 'stt_unavailable', status: 409 });
    stt.available = true;
    await expect(svc.transcribeCaptions('cap2', { language: 'english!' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(svc.transcribeCaptions('cap2', { provider: 'nope' })).rejects.toMatchObject({ code: 'unknown_stt_provider', status: 404 });
  });

  it('stores word timings on the voice track; cues are built from them; the result is cached', async () => {
    await svc.uploadAsset(readFileSync(join(dir, 'tone.mp3')), { filename: 'voice.mp3', projectId: 'cap2', assetId: 'voice', license: { name: 'test', redistributable: true } });
    await svc.setAudio('cap2', { voice: { asset: 'voice', startFrame: 15 } });
    const r = await svc.transcribeCaptions('cap2', {});
    expect(r).toMatchObject({ provider: 'fake-stt', detectedLanguage: 'en', words: 5, cached: false });
    expect(stt.calls).toHaveLength(1);
    expect(stt.calls[0]!.language).toBe('auto');
    expect(stt.calls[0]!.file.startsWith(join(dir, 'data'))).toBe(true);
    const p = (await svc.getProject('cap2')).manifest;
    expect(p.audio.voice?.words?.map((w) => w.text)).toEqual(['Made', 'on', 'your', 'own', 'machine.']);
    expect(p.captions.language).toBe('en');
    // buildCuesFromWords, shifted by the voice start (15 frames = 0.5 s).
    expect(r.captions.languages[0]).toMatchObject({ language: 'en', primary: true, source: 'voice', cues: [{ start: 1, text: 'Made on your own machine.' }] });
    expect(r.captions.languages[0]!.cues[0]!.words).toHaveLength(5);
    const again = await svc.transcribeCaptions('cap2', {});
    expect(again.cached).toBe(true);
    expect(stt.calls).toHaveLength(1);
  });

  it('says when manual cues hide the transcription; replaceCues removes them but keeps descriptions', async () => {
    await svc.updateProject('cap2', { captions: { cues: [{ start: 0, end: 1, text: 'Manual' }, { start: 0, end: 3, text: 'A dark title card.', kind: 'description' }] } });
    const r = await svc.transcribeCaptions('cap2', {});
    expect(r.note).toContain('replaceCues');
    expect(r.captions.languages[0]!.source).toBe('cues');
    const replaced = await svc.transcribeCaptions('cap2', { replaceCues: true });
    expect(replaced.captions.languages[0]).toMatchObject({ source: 'voice', descriptions: [{ text: 'A dark title card.' }] });
  });
});

describe('approval: get_captions / update_captions', () => {
  it('edits cues only with the current etag, re-runs the quality rules and records an audit event', async () => {
    const view = await svc.getCaptions({ projectId: 'cap2' });
    expect(view).toMatchObject({ projectId: 'cap2', mode: 'off', modeSource: 'default', approved: false, approval: null });
    expect(view.etag).toMatch(/^"c-[0-9a-f]{24}"$/);
    await expect(svc.updateCaptions('cap2', { etag: '"c-stale"', mode: 'burned' })).rejects.toMatchObject({ code: 'captions_conflict', status: 409, details: { etag: view.etag } });
    // Editing a cue built from the voice saves the cues as manual ones; the edited cue loses its word timings.
    const edited = await svc.updateCaptions('cap2', { etag: view.etag, edits: [{ index: 0, text: 'Made on your machine.' }], mode: 'both' });
    expect(edited.languages[0]).toMatchObject({ source: 'cues', cues: [{ text: 'Made on your machine.' }], descriptions: [{ text: 'A dark title card.' }] });
    expect(edited.languages[0]!.cues[0]!.words).toBeUndefined();
    expect(edited.etag).not.toBe(view.etag);
    expect(edited.mode).toBe('both');
    expect(edited.languages[0]!.qa).toMatchObject({ ok: true });
    const stored = (await svc.getProject('cap2')).manifest.captions;
    expect(stored.cues?.map((c) => c.kind ?? 'caption')).toEqual(['caption', 'description']);
    // A too-fast cue: the re-run quality check reports it.
    const fast = await svc.updateCaptions('cap2', { etag: edited.etag, edits: [{ index: 0, end: 1.2 }] });
    expect(fast.languages[0]!.qa.issues.map((i) => i.rule)).toContain('readingSpeed');
    await expect(svc.updateCaptions('cap2', { etag: fast.etag, edits: [{ index: 7, delete: true }] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(svc.updateCaptions('cap2', { etag: fast.etag, nonsense: 1 })).rejects.toMatchObject({ code: 'bad_request' });
    const fixed = await svc.updateCaptions('cap2', { etag: fast.etag, edits: [{ index: 0, start: 0.5, end: 2.5 }] });
    expect(fixed.languages[0]!.qa.ok).toBe(true);
    const audit = await svc.listAuditEvents({ action: 'captions.*' });
    expect(audit.events.filter((e) => e.action === 'captions.update' && e.targetId === 'cap2').length).toBeGreaterThanOrEqual(3);
    expect(audit.events[0]!.data).toMatchObject({ language: 'en', edits: 1, etagBefore: fast.etag, etag: fixed.etag });
  });

  it('approves the captions as they are; any later change voids the approval', async () => {
    const view = await svc.getCaptions({ projectId: 'cap2' });
    const ok = await svc.updateCaptions('cap2', { etag: view.etag, approve: true });
    expect(ok).toMatchObject({ approved: true, etag: view.etag, approval: { etag: view.etag } });
    expect((await svc.listAuditEvents({ action: 'captions.approve' })).events[0]).toMatchObject({ targetId: 'cap2', data: { approved: true } });
    await svc.updateProject('cap2', { captions: { highlight: 'none' } });
    expect((await svc.getCaptions({ projectId: 'cap2' })).approved).toBe(false);
    await svc.updateProject('cap2', { captions: { highlight: null } });
    expect((await svc.getCaptions({ projectId: 'cap2' })).approved).toBe(true);
  });

  it('adds a language, chooses the burned one and validates language tags', async () => {
    const view = await svc.getCaptions({ projectId: 'cap2' });
    await expect(svc.updateCaptions('cap2', { etag: view.etag, language: 'en_US', cues: [] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(svc.updateCaptions('cap2', { etag: view.etag, burnLanguage: 'fr' })).rejects.toMatchObject({ code: 'invalid_manifest' });
    const es: CaptionCue[] = [
      { start: 0.5, end: 2.5, text: 'Hecho en tu propia máquina.' },
      { start: 0.5, end: 2.5, text: 'Una tarjeta de título oscura.', kind: 'description' },
    ];
    const added = await svc.updateCaptions('cap2', { etag: view.etag, language: 'es', cues: es, burnLanguage: 'es' });
    expect(added.languages.map((l) => [l.language, l.primary, l.burned])).toEqual([
      ['en', true, false],
      ['es', false, true],
    ]);
    expect(added.burnLanguage).toBe('es');
    expect(added.approved).toBe(false);
    expect((await svc.getCaptions({ projectId: 'cap2', language: 'ES' })).languages).toHaveLength(1);
    await expect(svc.getCaptions({ projectId: 'cap2', language: 'de' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.getCaptions({ projectId: 'cap2', renderId: 'x' })).rejects.toMatchObject({ code: 'bad_request' });
    // The primary language as a track is refused by the manifest checks.
    await expect(svc.updateProject('cap2', { captions: { tracks: { en: { cues: [] } } } })).rejects.toMatchObject({ code: 'invalid_manifest' });
  });
});

describe('several languages and audio description in a render', () => {
  const region = { x: 40, y: 600, w: 460, h: 170 };

  it('burns the burn language, writes sidecars per language and description tracks', async () => {
    const view = await svc.getCaptions({ projectId: 'cap2' });
    // English 3-5 s, Spanish 0.5-2.5 s: only Spanish is burned.
    await svc.updateCaptions('cap2', { etag: view.etag, cues: [{ start: 3, end: 5, text: 'Two engines, one timeline.' }, { start: 0, end: 3, text: 'A dark title card.', kind: 'description' }], approve: true });
    const done = await svc.jobs.waitFor((await svc.startRender('cap2')).id, 120_000);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const renderId = done.result!.renderId as string;
    const summary = await svc.getRender(renderId);
    expect(summary.captions).toMatchObject({ mode: 'both', burned: true, burnLanguage: 'es', language: 'en', approved: true });
    expect(summary.captions!.languages).toEqual([
      { language: 'en', primary: true, burned: false, cues: 1, descriptions: 1, qaOk: true },
      { language: 'es', primary: false, burned: true, cues: 1, descriptions: 1, qaOk: true },
    ]);
    expect(summary.captions!.files.map((f) => [f.file, f.kind, f.language])).toEqual([
      ['captions.srt', 'captions', 'en'],
      ['captions.vtt', 'captions', 'en'],
      ['captions.ass', 'captions', 'en'],
      ['descriptions.vtt', 'descriptions', 'en'],
      ['captions.es.srt', 'captions', 'es'],
      ['captions.es.vtt', 'captions', 'es'],
      ['captions.es.ass', 'captions', 'es'],
      ['descriptions.es.vtt', 'descriptions', 'es'],
    ]);
    const read = async (f: string) => readFileSync((await svc.renderFile(renderId, f)).path, 'utf8');
    expect(await read('captions.es.vtt')).toBe('WEBVTT\nLanguage: es\n\n00:00:00.500 --> 00:00:02.500\nHecho en tu propia máquina.\n');
    expect(await read('descriptions.vtt')).toBe('WEBVTT\nKind: descriptions\nLanguage: en\n\n00:00:00.000 --> 00:00:03.000\nA dark title card.\n');
    expect(await read('captions.srt')).not.toContain('dark title card'); // descriptions are never captions
    expect(await read('captions.es.ass')).toContain('ScriptType: v4.00+\nLanguage: es\nPlayResX: 540');
    const manifest = (await svc.getRenderManifest(renderId)) as any;
    expect(manifest.captions.burnArgs).toContain('ass=captions.es.ass:fontsdir=fonts'); // the bundled theme font goes to libass (#447)
    expect(manifest.captions).toMatchObject({ burnLanguage: 'es', modeSource: 'project', approved: true });
    // Pixels: Spanish (0.5-2.5 s) is on the video, English (3-5 s) is not, and no description is.
    const out = (await svc.renderFile(renderId)).path;
    expect((await regionStats(out, 30, region)).yMax).toBeGreaterThan(200);
    expect((await regionStats(out, 120, region)).yMax).toBeLessThan(60);
    // get_captions on the render: the cues as rendered, per language.
    const rv = await svc.getCaptions({ renderId });
    expect(rv).toMatchObject({ renderId, mode: 'both', burned: true, burnLanguage: 'es', approved: true });
    expect(rv.languages[1]).toMatchObject({ language: 'es', burned: true, cues: [{ text: 'Hecho en tu propia máquina.' }], files: { vtt: 'captions.es.vtt', descriptions: 'descriptions.es.vtt' } });
    // Only caption file names are served.
    await expect(svc.renderObject(renderId, 'captions.es.exe')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(svc.renderObject(renderId, 'captions.../x.vtt')).rejects.toMatchObject({ code: 'bad_request' });
  }, 180_000);

  it('the server default mode applies to projects without captions.mode; descriptions are written in every mode but off', async () => {
    await svc.updateProject('cap2', { captions: { mode: null, tracks: null, burnLanguage: null } });
    expect((await svc.getCaptions({ projectId: 'cap2' })).modeSource).toBe('default');
    await svc.updateConfig({ 'captions.defaultMode': 'burned' });
    try {
      expect(svc.capabilities().captions.defaultMode).toBe('burned');
      expect(await svc.getCaptions({ projectId: 'cap2' })).toMatchObject({ mode: 'burned', modeSource: 'server' });
      const done = await svc.jobs.waitFor((await svc.startRender('cap2')).id, 120_000);
      expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
      const summary = await svc.getRender(done.result!.renderId as string);
      expect(summary.captions).toMatchObject({ mode: 'burned', burned: true });
      expect(summary.captions!.files.map((f) => f.file)).toEqual(['descriptions.vtt']);
      // The project's own mode wins over the default.
      await svc.updateProject('cap2', { captions: { mode: 'off' } });
      expect((await svc.getCaptions({ projectId: 'cap2' })).mode).toBe('off');
    } finally {
      await svc.updateConfig({ 'captions.defaultMode': null });
    }
  }, 180_000);
});
