import { existsSync, readFileSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkExpectation, probe, resolveTools } from '@reelforge/media-pipeline';
import {
  ElevenLabsTts,
  PluginRegistry,
  RemotionLambdaBackend,
  ReelforgeService,
  createMemoryRepositories,
  wordsFromAlignment,
} from '../src/index';
import { fakeEngine, makeTone, tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-service-');
afterAll(cleanup);
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));

let svc: ReelforgeService;
let mockCalls = 0;
const mockFetch: typeof fetch = async (url, init) => {
  mockCalls++;
  const body = JSON.parse(String(init?.body));
  expect(String(url)).toMatch(/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/voice123\/with-timestamps/);
  expect((init?.headers as Record<string, string>)['xi-api-key']).toBe('test-key');
  const mp3 = readFileSync(join(dir, 'tone.mp3'));
  const chars = [...body.text];
  return new Response(
    JSON.stringify({
      audio_base64: mp3.toString('base64'),
      alignment: {
        characters: chars,
        character_start_times_seconds: chars.map((_, i) => i * 0.25),
        character_end_times_seconds: chars.map((_, i) => i * 0.25 + 0.25),
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};

beforeAll(async () => {
  await makeTone(join(dir, 'tone.mp3'), 2);
  const registry = new PluginRegistry()
    .registerEngine(fakeEngine('remotion'))
    .registerEngine(fakeEngine('motion-canvas', { delayPerFrameMs: 2 }))
    .registerProvider(new ElevenLabsTts({ ELEVENLABS_API_KEY: 'test-key' }))
    .registerBackend(new RemotionLambdaBackend({}));
  svc = await ReelforgeService.create(registry, { repositories: createMemoryRepositories(), dataDir: join(dir, 'data'), publicUrl: 'https://studio.example.com/', fetch: mockFetch, configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } } });
});

describe('ReelforgeService', () => {
  it('reports capabilities honestly', () => {
    const c = svc.capabilities();
    expect(c.schemaVersion).toBe('0.2');
    expect(c.engines.map((e) => e.id)).toEqual(['remotion', 'motion-canvas']);
    expect(c.templates.map((t) => t.id)).toEqual(['kinetic-title', 'animated-explainer']);
    expect(c.backends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'local', configured: true, implemented: true }),
        expect.objectContaining({ id: 'remotion-lambda', configured: false, implemented: false }),
      ])
    );
    expect(c.providers[0]).toMatchObject({ id: 'elevenlabs', kind: 'tts', configured: true });
    expect(c.versions.ffmpeg).toMatch(/ffmpeg version/);
  });

  it('creates a project from a v0.1 manifest (migrated to v0.2)', async () => {
    const r = await svc.createProject(sample);
    expect(r.migratedFrom).toBe('0.1');
    expect(r.manifest.schemaVersion).toBe('0.2');
    expect(r.meta.version).toBe(1);
    await expect(svc.createProject(sample)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects templates for engines that are not installed', async () => {
    await expect(
      svc.addScene('sample-reel', { id: 'x', engine: 'html', template: 'html-title', props: { headline: 'Hi' }, durationSeconds: 2 })
    ).rejects.toMatchObject({ code: 'invalid_manifest', status: 422 });
  });

  it('edits scenes: add at index, update with merge patch, switch duration units, reorder, remove', async () => {
    await svc.addScene('sample-reel', { id: 'outro', engine: 'remotion', template: 'kinetic-title', props: { headline: 'Bye' }, durationSeconds: 2 }, { index: 1 });
    let p = (await svc.getProject('sample-reel')).manifest;
    expect(p.scenes.map((s) => s.id)).toEqual(['hook', 'outro', 'how-it-works']);
    await svc.updateScene('sample-reel', 'outro', { durationFrames: 45, props: { subline: 'See you' } });
    p = (await svc.getProject('sample-reel')).manifest;
    const outro = p.scenes[1]!;
    expect(outro.durationFrames).toBe(45);
    expect(outro.durationSeconds).toBeUndefined();
    expect(outro.props).toEqual({ headline: 'Bye', subline: 'See you' });
    await svc.reorderScenes('sample-reel', ['hook', 'how-it-works', 'outro']);
    await expect(svc.reorderScenes('sample-reel', ['hook'])).rejects.toMatchObject({ code: 'bad_request' });
    await expect(svc.updateScene('sample-reel', 'nope', {})).rejects.toMatchObject({ code: 'not_found' });
    await svc.removeScene('sample-reel', 'outro');
    p = (await svc.getProject('sample-reel')).manifest;
    expect(p.scenes.map((s) => s.id)).toEqual(['hook', 'how-it-works']);
  });

  it('applies JSON merge patches and full replacements, with optimistic concurrency', async () => {
    const { meta } = await svc.getProject('sample-reel');
    const r = await svc.updateProject('sample-reel', { title: 'Patched', brief: { goal: 'Demo' } }, meta.version);
    expect(r.manifest.title).toBe('Patched');
    await expect(svc.updateProject('sample-reel', { title: 'Stale' }, meta.version)).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(svc.updateProject('sample-reel', { output: { fps: 29 } })).rejects.toMatchObject({ code: 'invalid_manifest' });
    const full = { ...r.manifest, title: 'Replaced' };
    expect((await svc.updateProject('sample-reel', full)).manifest.title).toBe('Replaced');
  });

  it('manages themes and applies them to projects', async () => {
    expect((await svc.listThemes()).map((t) => t.id)).toEqual(['default', 'midnight']);
    const t = await svc.createTheme({ id: 'brand', name: 'Brand', tokens: { colors: { background: '#112233', surface: '#223344', text: '#ffffff', mutedText: '#cccccc', accent: '#ff8800', accent2: '#00ff88' }, fontFamily: 'Arial, sans-serif' } });
    expect(t.builtin).toBe(false);
    await expect(svc.putTheme('default', {})).rejects.toMatchObject({ code: 'builtin_theme' });
    await expect(svc.setTheme('sample-reel', 'nope')).rejects.toMatchObject({ code: 'not_found' });
    await svc.setTheme('sample-reel', 'brand');
    expect((await svc.getProject('sample-reel')).manifest.theme).toBe('brand');
    const report = await svc.validateProject('sample-reel');
    expect(report.ok).toBe(true);
    expect(report.summary?.totalFrames).toBe(210);
  });

  it('reports a deleted theme and unknown backends in validation', async () => {
    await svc.createTheme({ id: 'temp', name: 'Temp', tokens: { colors: { background: '#000000', surface: '#111111', text: '#ffffff', mutedText: '#cccccc', accent: '#ff0000', accent2: '#00ff00' }, fontFamily: 'Arial' } });
    await svc.setTheme('sample-reel', 'temp');
    await svc.deleteTheme('temp');
    await svc.updateProject('sample-reel', { render: { backend: 'remotion-lambda' } });
    const report = await svc.validateProject('sample-reel');
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['theme', 'render.backend']));
    await expect(svc.startRender('sample-reel')).rejects.toMatchObject({ code: 'backend_not_configured' });
    await svc.setTheme('sample-reel', 'brand');
    await svc.updateProject('sample-reel', { render: { backend: 'local' } });
  });

  it('uploads a music asset and attaches it to the project', async () => {
    const r = await svc.uploadAsset(readFileSync(join(dir, 'tone.mp3')), { filename: 'tone.mp3', projectId: 'sample-reel', assetId: 'music', license: { name: 'CC0-1.0', redistributable: true } });
    expect(r.projectAssetId).toBe('music');
    await svc.setAudio('sample-reel', { music: { asset: 'music', volume: 0.5 } });
    const p = (await svc.getProject('sample-reel')).manifest;
    expect(p.assets[0]).toMatchObject({ id: 'music', uri: r.uri, mediaType: 'audio' });
    expect(p.audio.music).toMatchObject({ asset: 'music', volume: 0.5 });
  });

  it('renders the project end to end and never overwrites an earlier output', async () => {
    const job = await svc.startRender('sample-reel');
    expect(job.status).toBe('queued');
    const done = await svc.jobs.waitFor(job.id, 120_000);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const renderId = done.result!.renderId as string;
    const out = await svc.renderFile(renderId);
    const info = await probe(resolveTools().ffprobe, out.path);
    expect(checkExpectation(info, { width: 1080, height: 1920, fps: 30, frames: 210, audio: true })).toEqual([]);
    expect(info.audioCodec).toBe('aac');
    const manifest = (await svc.getRenderManifest(renderId)) as any;
    expect(manifest.output.file).toBe('final.mp4');
    expect(manifest.scenes[0].file).toMatch(/^clips\//);
    expect(manifest.audio.music.asset).toBe('music');
    expect(manifest.versions.engines).toEqual({ remotion: '0.0.0-test', 'motion-canvas': '0.0.0-test' });
    expect(manifest.theme.colors.background).toBe('#112233');
    expect(JSON.stringify(manifest.ffmpegAssembleArgs)).not.toContain(dir);
    const summary = await svc.getRender(renderId);
    expect(summary.outputUrl).toBe(`https://studio.example.com/v1/renders/${renderId}/output`);
    expect(existsSync((await svc.renderFile(renderId, 'poster.png')).path)).toBe(true);
    const logs = await svc.jobLogs(job.id);
    expect(logs.some((l) => l.includes('assemble'))).toBe(true);

    // A second render goes to a new directory; the first stays intact.
    const second = await svc.jobs.waitFor((await svc.startRender('sample-reel')).id, 120_000);
    expect(second.result!.renderId).not.toBe(renderId);
    expect(existsSync(out.path)).toBe(true);
    expect((await svc.listRenders('sample-reel')).length).toBe(2);
  }, 180_000);

  it('long-polls a job: waitForJob returns early when it finishes and caps the wait', async () => {
    const job = await svc.startRender('sample-reel');
    // A short wait returns the job still in progress, not an error.
    const early = await svc.waitForJob(job.id, 0);
    expect(['queued', 'running']).toContain(early.status);
    // A long wait returns as soon as the job finishes (well before the cap).
    const t0 = Date.now();
    let j = await svc.waitForJob(job.id, 50);
    while (j.status === 'queued' || j.status === 'running') j = await svc.waitForJob(job.id, 50);
    expect(j.status, JSON.stringify(j.error)).toBe('succeeded');
    expect(Date.now() - t0).toBeLessThan(170_000);
    // A finished job answers at once, whatever the wait.
    const t1 = Date.now();
    expect((await svc.waitForJob(job.id, 50)).status).toBe('succeeded');
    expect(Date.now() - t1).toBeLessThan(1_000);
  }, 180_000);

  it('cancels a running render and leaves no partial output', async () => {
    const before = readdirSync(join(dir, 'data/projects/sample-reel/renders'));
    const job = await svc.startRender('sample-reel');
    await new Promise<void>((resolve) => {
      const off = svc.jobs.subscribe(job.id, (e) => {
        if (e.type === 'progress' && e.job.progress.stage.startsWith('render:how-it-works')) {
          off();
          resolve();
        }
      });
    });
    await svc.cancelJob(job.id);
    const done = await svc.jobs.waitFor(job.id);
    expect(done.status).toBe('cancelled');
    const after = readdirSync(join(dir, 'data/projects/sample-reel/renders'));
    expect(after.sort()).toEqual(before.sort());
  }, 60_000);

  it('renders a low-resolution preview of one scene', async () => {
    const job = await svc.preview('sample-reel', { sceneId: 'hook', scale: 0.25 });
    const done = await svc.jobs.waitFor(job.id, 60_000);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.result).toMatchObject({ width: 270, height: 480, frames: 90, kind: 'preview' });
  }, 60_000);

  it('refuses to render invalid projects with the list of problems', async () => {
    await svc.createProject({ ...sample, projectId: 'broken', assets: [{ id: 'gone', path: 'missing.mp3', mediaType: 'audio' }], audio: { musicTrack: 'gone' } });
    await expect(svc.startRender('broken')).rejects.toMatchObject({ code: 'validation_failed', status: 422 });
  });

  it('generates a voice with ElevenLabs (mocked): cost acknowledgement, cache, attach to project', async () => {
    await expect(svc.runProvider('elevenlabs', { text: 'Hello world', voiceId: 'voice123' }, { projectId: 'sample-reel' })).rejects.toMatchObject({ code: 'cost_acknowledgement_required' });
    expect(mockCalls).toBe(0);
    const r = await svc.runProvider('elevenlabs', { text: 'Hello world', voiceId: 'voice123' }, { projectId: 'sample-reel', acknowledgeCost: true });
    expect(mockCalls).toBe(1);
    expect(r.cached).toBe(false);
    expect(r.data.words).toEqual([
      { word: 'Hello', start: 0, end: 1.25 },
      { word: 'world', start: 1.5, end: 2.75 },
    ]);
    const p = (await svc.getProject('sample-reel')).manifest;
    expect(p.audio.voice).toMatchObject({ asset: 'voice', provider: 'elevenlabs', text: 'Hello world', voiceId: 'voice123' });
    // Same request again: served from cache, no call, no acknowledgement needed.
    const again = await svc.runProvider('elevenlabs', { text: 'Hello world', voiceId: 'voice123' });
    expect(again.cached).toBe(true);
    expect(mockCalls).toBe(1);
    await expect(svc.runProvider('elevenlabs', { text: '' , voiceId: 'v' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(svc.runProvider('nope', {})).rejects.toMatchObject({ code: 'unknown_provider' });
  });

  it('reports unconfigured providers and the Lambda skeleton clearly', async () => {
    const tts = new ElevenLabsTts({});
    expect(tts.configured()).toBe(false);
    const lambda = new RemotionLambdaBackend({});
    expect(lambda.configured()).toBe(false);
    await expect(lambda.submit()).rejects.toMatchObject({ code: 'backend_not_configured' });
    const configured = new RemotionLambdaBackend({ REMOTION_LAMBDA_REGION: 'us-east-1', REMOTION_LAMBDA_FUNCTION_NAME: 'f', REMOTION_LAMBDA_SERVE_URL: 'https://x' });
    expect(configured.configured()).toBe(true);
    await expect(configured.submit()).rejects.toMatchObject({ code: 'not_implemented', status: 501 });
  });

  it('groups ElevenLabs character alignment into words', () => {
    expect(
      wordsFromAlignment({ characters: [...'Hi you'], character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] })
    ).toEqual([
      { word: 'Hi', start: 0, end: 0.2 },
      { word: 'you', start: 0.3, end: 0.6 },
    ]);
  });

  it('resolves project:// assets from the project folder', async () => {
    await svc.createProject({ ...sample, projectId: 'with-file', assets: [{ id: 'song', path: 'music/song.mp3', mediaType: 'audio', license: { name: 'CC0-1.0', redistributable: true } }], audio: { musicTrack: 'song' } });
    expect((await svc.validateProject('with-file')).ok).toBe(false);
    mkdirSync(join(dir, 'data/projects/with-file/assets/music'), { recursive: true });
    copyFileSync(join(dir, 'tone.mp3'), join(dir, 'data/projects/with-file/assets/music/song.mp3'));
    expect((await svc.validateProject('with-file')).ok).toBe(true);
  });
});
