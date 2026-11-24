import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasLibass, probe, resolveTools, run } from '@reelforge/media-pipeline';
import { BUILTIN_THEMES, formatSrt, parseProject, type CaptionCue } from '@reelforge/project-schema';
import {
  ElevenLabsTts,
  PluginRegistry,
  ReelforgeService,
  assColor,
  assTime,
  captionFontChoice,
  captionRenderStyle,
  captionSafeArea,
  createMemoryRepositories,
  firstFontFamily,
  mapCuesToClips,
  toAss,
  voiceWords,
} from '../src/index';
import { fakeEngine, makeTone, tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-captions-');
afterAll(cleanup);
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const tools = resolveTools();
const theme = BUILTIN_THEMES[0]!.tokens;

/** Luma and chroma statistics of a rectangle of one frame (FFmpeg crop + signalstats). */
async function regionStats(file: string, frame: number, r: { x: number; y: number; w: number; h: number }) {
  const { stdout } = await run(
    tools.ffmpeg,
    ['-hide_banner', '-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),crop=${r.w}:${r.h}:${r.x}:${r.y},signalstats,metadata=print:file=-`, '-frames:v', '1', '-f', 'null', '-'],
    'region-stats'
  );
  const get = (k: string) => Number(new RegExp(`lavfi\\.signalstats\\.${k}=([0-9.]+)`).exec(stdout)![1]);
  return { yMax: get('YMAX'), yAvg: get('YAVG'), vMax: get('VMAX') };
}

const cues: CaptionCue[] = [
  {
    start: 0.5,
    end: 2.5,
    text: 'Made on your own machine.',
    words: [
      { text: 'Made', start: 0.5, end: 0.8 },
      { text: 'on', start: 0.85, end: 1 },
      { text: 'your', start: 1.05, end: 1.3 },
      { text: 'own', start: 1.35, end: 1.6 },
      { text: 'machine.', start: 1.65, end: 2.2 },
    ],
  },
  { start: 3, end: 5, text: 'Two engines, one timeline.' },
];

let svc: ReelforgeService;
const mockFetch: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const chars = [...body.text];
  return new Response(
    JSON.stringify({
      audio_base64: readFileSync(join(dir, 'tone.mp3')).toString('base64'),
      alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1) },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};

beforeAll(async () => {
  await makeTone(join(dir, 'tone.mp3'), 2);
  const registry = new PluginRegistry()
    .registerEngine(fakeEngine('remotion'))
    .registerEngine(fakeEngine('motion-canvas'))
    .registerProvider(new ElevenLabsTts({ ELEVENLABS_API_KEY: 'test-key' }));
  svc = await ReelforgeService.create(registry, {
    repositories: createMemoryRepositories(),
    dataDir: join(dir, 'data'),
    publicUrl: 'https://studio.example.com/',
    fetch: mockFetch,
    configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } },
  });
  // Half size keeps the test fast; every caption measure scales with the output.
  await svc.createProject({ ...sample, projectId: 'cap-reel', output: { ...sample.output, width: 540, height: 960 } });
});

describe('caption style and ASS', () => {
  it('places captions inside the safe area', () => {
    expect(captionSafeArea(1080, 1920)).toEqual({ top: 230, bottom: 384, left: 86, right: 86 });
    expect(captionSafeArea(1920, 1080)).toEqual({ top: 108, bottom: 108, left: 192, right: 192 });
  });

  it('resolves the theme caption tokens, scaled to the shorter side', () => {
    const project = parseProject({ ...sample, output: { ...sample.output, width: 1920, height: 1080 } });
    if (!project.ok) throw new Error('sample');
    const st = captionRenderStyle(project.project, theme, project.project.output, 42);
    expect(st).toMatchObject({ fontName: 'Inter', fontPx: 54, bold: true, color: '#ffffff', background: '#000000', highlightColor: theme.colors.accent, position: 'bottom' });
    // Portrait 32-character lines: the font shrinks so a full line fits the safe width.
    const portrait = captionRenderStyle({ ...project.project, captions: { enabled: false, style: { fontScale: 0.1, fontFamily: '"Avenir Next", sans-serif' } } }, theme, { ...project.project.output, width: 1080, height: 1920 }, 32);
    expect(portrait.fontName).toBe('Avenir Next');
    expect(portrait.fontPx * 0.55 * 32).toBeLessThanOrEqual(1080 - 2 * 86);
    expect(firstFontFamily("'Brand Sans', Arial")).toBe('Brand Sans');
  });

  it('writes an ASS script with pixel units, theme colours and one event per spoken word', () => {
    expect(assColor('#ff3d71')).toBe('&H00713DFF');
    expect(assColor('#000000', 0.8)).toBe('&H33000000');
    expect(assTime(3661.256)).toBe('1:01:01.26');
    const project = parseProject(sample);
    if (!project.ok) throw new Error('sample');
    const st = captionRenderStyle(project.project, theme, project.project.output, 32);
    const ass = toAss(cues, { width: 1080, height: 1920 }, st, 'word');
    expect(ass).toContain('PlayResX: 1080\nPlayResY: 1920');
    expect(ass).toMatch(/^Style: Caption,Inter,\d+,&H00FFFFFF,&H00FFFFFF,&H33000000,&H33000000,-1,0,0,0,100,100,0,0,3,\d+,0,2,86,86,384,1$/m);
    expect(ass).toMatch(/^Style: Word,Inter,\d+,&H00713DFF,&H00713DFF,&H33000000,&H33000000,-1,0,0,0,100,100,0,0,1,0,0,2,86,86,384,1$/m);
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    // cue 1: the whole cue on layer 0 plus five words (one at a time) on layer 1; cue 2 has no words: one event
    expect(events).toHaveLength(7);
    expect(events[0]).toBe('Dialogue: 0,0:00:00.50,0:00:02.50,Caption,,0,0,0,,Made on your own machine.');
    expect(events[1]).toBe('Dialogue: 1,0:00:00.50,0:00:00.85,Word,,0,0,0,,{\\1a&HFF&}{\\1a&H00&}Made{\\1a&HFF&} on your own machine.');
    expect(events[5]).toContain('1,0:00:01.65,0:00:02.50,Word');
    expect(events[6]).toBe('Dialogue: 0,0:00:03.00,0:00:05.00,Caption,,0,0,0,,Two engines, one timeline.');
    // no highlight, braces and backslashes cannot inject override tags
    const plain = toAss([{ start: 0, end: 1, text: 'a {\\b1} \\N b' }], { width: 100, height: 100 }, { ...st, position: 'top', background: null }, 'none');
    expect(plain).toContain('Dialogue: 0,0:00:00.00,0:00:01.00,Caption,,0,0,0,,a (\\⁠b1) \\⁠N b');
    expect(plain).toMatch(/,1,\d+,0,8,86,86,230,1$/m);
  });

  it('"none" switches the box and the outline off, like null (#451)', () => {
    const base = parseProject(sample);
    if (!base.ok) throw new Error('sample');
    const project = parseProject({ ...base.project, captions: { style: { background: 'none', outline: 'none' } } });
    if (!project.ok) throw new Error(JSON.stringify(project.issues));
    const st = captionRenderStyle(project.project, theme, project.project.output, 32);
    expect(st).toMatchObject({ background: null, outline: null });
    expect(captionRenderStyle({ ...project.project, captions: { enabled: false, style: { background: null } } }, theme, project.project.output, 32)).toMatchObject({ background: null, outline: '#000000' });
    // Theme tokens take it too; anything else is still refused.
    expect(parseProject({ ...base.project, theme: { base: 'midnight', tokens: { captionStyle: { background: 'none' } } } }).ok).toBe(true);
    expect(parseProject({ ...base.project, captions: { style: { background: 'nothing' } } }).ok).toBe(false);
  });

  it('moves cues to where a scene subset plays in a preview', () => {
    const mapped = mapCuesToClips(cues, [{ startFrame: 180, frames: 30 }], 30);
    expect(mapped).toEqual([]);
    const inFirst = mapCuesToClips(cues, [{ startFrame: 60, frames: 90 }], 30);
    expect(inFirst.map((c) => [c.start, c.end])).toEqual([
      [0, 0.5],
      [1, 3],
    ]);
  });

  it('turns provider word timestamps into manifest words', () => {
    expect(voiceWords([{ word: 'Hi', start: 0, end: 0.2 }, { text: 'there', start: 0.3, end: 0.61234 }, { word: '', start: 1, end: 2 }, { word: 'x', start: 2, end: 1 }, 'junk'])).toEqual([
      { text: 'Hi', start: 0, end: 0.2 },
      { text: 'there', start: 0.3, end: 0.612 },
    ]);
    expect(voiceWords(undefined)).toEqual([]);
  });
});

describe('captions in a render', () => {
  const region = { x: 40, y: 600, w: 460, h: 170 }; // the bottom caption band of 540x960, above the 20% bottom safe margin

  it('the FFmpeg on this machine has libass', () => {
    expect(hasLibass(tools.ffmpeg)).toBe(true);
  });

  it('burns captions into the video and writes SRT, WebVTT and ASS next to final.mp4', async () => {
    await svc.updateProject('cap-reel', { captions: { mode: 'both', language: 'en', cues } });
    const done = await svc.jobs.waitFor((await svc.startRender('cap-reel')).id, 120_000);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const renderId = done.result!.renderId as string;
    const summary = await svc.getRender(renderId);
    expect(summary.files).toEqual(expect.arrayContaining(['final.mp4', 'captions.srt', 'captions.vtt', 'captions.ass']));
    expect(summary.captions).toMatchObject({ mode: 'both', burned: true, cues: 2, source: 'cues', language: 'en', qa: { ok: true } });
    expect(summary.captions!.files.map((f) => [f.format, f.url])).toEqual([
      ['srt', `https://studio.example.com/v1/renders/${renderId}/output?file=captions.srt`],
      ['vtt', `https://studio.example.com/v1/renders/${renderId}/output?file=captions.vtt`],
      ['ass', `https://studio.example.com/v1/renders/${renderId}/output?file=captions.ass`],
    ]);
    expect(summary.captions!.files[0]!.downloadUrl).toContain('file=captions.srt');

    // Sidecar contents.
    const srt = await svc.renderFile(renderId, 'captions.srt');
    expect(srt.contentType).toMatch(/^application\/x-subrip/);
    expect(readFileSync(srt.path, 'utf8')).toBe(formatSrt(cues, 32));
    expect(readFileSync(srt.path, 'utf8')).toBe('1\n00:00:00,500 --> 00:00:02,500\nMade on your own machine.\n\n2\n00:00:03,000 --> 00:00:05,000\nTwo engines, one timeline.\n');
    const vtt = readFileSync((await svc.renderFile(renderId, 'captions.vtt')).path, 'utf8');
    expect(vtt).toBe(
      'WEBVTT\nLanguage: en\n\n00:00:00.500 --> 00:00:02.500\nMade <00:00:00.850>on <00:00:01.050>your <00:00:01.350>own <00:00:01.650>machine.\n\n00:00:03.000 --> 00:00:05.000\nTwo engines, one timeline.\n'
    );
    expect(readFileSync((await svc.renderFile(renderId, 'captions.ass')).path, 'utf8')).toContain('PlayResX: 540');

    // The video: same size, frames and audio; captions visible exactly while a cue is on screen.
    const out = (await svc.renderFile(renderId)).path;
    const info = await probe(tools.ffprobe, out);
    expect(info).toMatchObject({ width: 540, height: 960, frames: 210, hasAudio: true });
    const before = await regionStats(out, 6, region); // 0.2 s: no cue yet
    const during = await regionStats(out, 30, region); // 1.0 s: cue 1, word "on" highlighted
    const second = await regionStats(out, 120, region); // 4.0 s: cue 2, no words
    const after = await regionStats(out, 180, region); // 6.0 s: no cue
    expect(before.yMax).toBeLessThan(60);
    expect(after.yMax).toBeLessThan(60);
    expect(during.yMax).toBeGreaterThan(200); // white text
    expect(second.yMax).toBeGreaterThan(200);
    expect(during.vMax).toBeGreaterThan(170); // the pink highlight (#ff3d71, Cr about 220)
    expect(second.vMax).toBeLessThan(150); // white on black: no highlight colour
    // Outside the caption band nothing changed.
    expect((await regionStats(out, 30, { x: 40, y: 100, w: 460, h: 300 })).yMax).toBeLessThan(60);

    const manifest = (await svc.getRenderManifest(renderId)) as any;
    expect(manifest.captions).toMatchObject({ mode: 'both', burned: true, files: { srt: 'captions.srt', vtt: 'captions.vtt', ass: 'captions.ass' }, style: { position: 'bottom', fontPx: expect.any(Number) } });
    expect(manifest.captions.style.fontName).toEqual(expect.any(String));
    expect(manifest.captions.qa).toMatchObject({ ok: true, cues: 2, rules: { maxLineChars: 32, maxCharsPerSecond: 20 } });
    // The theme font (Inter) is a bundled font: libass gets its files (#447).
    expect(manifest.captions.burnArgs).toContain('ass=captions.ass:fontsdir=fonts');
    expect(JSON.stringify(manifest.captions.burnArgs)).not.toContain(dir);
    expect(manifest.checks).toMatchObject({ metadata: 'pass', decode: 'pass', duration: 'pass' });
  }, 180_000);

  it('sidecar only: files written, the video is untouched; a render option overrides the manifest', async () => {
    await svc.updateProject('cap-reel', { captions: { mode: 'off' } });
    const off = await svc.jobs.waitFor((await svc.startRender('cap-reel')).id, 120_000);
    expect(off.status).toBe('succeeded');
    const offSummary = await svc.getRender(off.result!.renderId as string);
    expect(offSummary.captions).toBeUndefined();
    expect(offSummary.files).not.toContain('captions.srt');
    expect(((await svc.getRenderManifest(offSummary.renderId)) as any).captions).toBeUndefined();

    const job = await svc.startRender('cap-reel', { captions: 'sidecar' });
    const done = await svc.jobs.waitFor(job.id, 120_000);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const summary = await svc.getRender(done.result!.renderId as string);
    expect(summary.captions).toMatchObject({ mode: 'sidecar', burned: false, cues: 2 });
    expect(summary.files).toEqual(expect.arrayContaining(['captions.srt', 'captions.vtt', 'captions.ass']));
    const out = (await svc.renderFile(summary.renderId)).path;
    expect((await regionStats(out, 30, region)).yMax).toBeLessThan(60);
    await expect(svc.startRender('cap-reel', { captions: 'loud' })).rejects.toMatchObject({ code: 'bad_request' });
  }, 180_000);

  it('update_project can switch the caption box off with a merge patch: background "none" (#451)', async () => {
    // null in a merge patch deletes the key and brings the default box back; "none" survives the patch.
    await svc.updateProject('cap-reel', { captions: { mode: 'both', style: { background: 'none', outline: '#ff0000' } } });
    expect((await svc.getProject('cap-reel')).manifest.captions.style).toMatchObject({ background: 'none', outline: '#ff0000' });
    const done = await svc.jobs.waitFor((await svc.startRender('cap-reel')).id, 120_000);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const renderId = done.result!.renderId as string;
    const manifest = (await svc.getRenderManifest(renderId)) as any;
    expect(manifest.captions.style).toMatchObject({ background: null, outline: '#ff0000' });
    // ASS BorderStyle 1 (outline + shadow) instead of 3 (opaque box), red outline (&H000000FF).
    const ass = readFileSync((await svc.renderFile(renderId, 'captions.ass')).path, 'utf8');
    expect(ass).toMatch(/^Style: Caption,[^,]+,\d+,&H00FFFFFF,&H00FFFFFF,&H000000FF,[^,]+,-1,0,0,0,100,100,0,0,1,/m);
    const out = (await svc.renderFile(renderId)).path;
    // cue 2 (no word highlight) at 4.0 s: white text with a red outline; with a box the edge is the black box.
    const second = await regionStats(out, 120, region);
    expect(second.yMax).toBeGreaterThan(200);
    expect(second.vMax).toBeGreaterThan(170);
    await svc.updateProject('cap-reel', { captions: { style: null } });
  }, 180_000);

  it('a scene preview shows the cues of that scene at its own time', async () => {
    await svc.updateProject('cap-reel', { captions: { mode: 'burned' } });
    const done = await svc.jobs.waitFor((await svc.preview('cap-reel', { sceneId: 'how-it-works', scale: 1 })).id, 120_000);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const manifest = (await svc.getRenderManifest(done.result!.renderId as string)) as any;
    // how-it-works starts at 3 s: cue 2 (3-5 s) plays at 0-2 s of the preview.
    expect(manifest.captions).toMatchObject({ burned: true, cues: 1 });
    const out = (await svc.renderFile(done.result!.renderId as string)).path;
    expect((await regionStats(out, 15, region)).yMax).toBeGreaterThan(200);
    expect((await regionStats(out, 75, region)).yMax).toBeLessThan(60);
  }, 180_000);
});

describe('caption sources', () => {
  it('generate_voice stores word timestamps on the voice track and cues are built from them', async () => {
    await svc.updateProject('cap-reel', { captions: { cues: null, mode: 'burned' } });
    await svc.runProvider('elevenlabs', { text: 'Hi there.', voiceId: 'voice123' }, { projectId: 'cap-reel', acknowledgeCost: true });
    const p = (await svc.getProject('cap-reel')).manifest;
    expect(p.audio.voice?.words).toEqual([
      { text: 'Hi', start: 0, end: 0.2 },
      { text: 'there.', start: 0.3, end: 0.9 },
    ]);
    const report = await svc.validateProject('cap-reel');
    expect(report.warnings.filter((w) => w.path.startsWith('captions'))).toEqual([]);
    // Another voice asset drops the old timestamps.
    await svc.setAudio('cap-reel', { voice: { asset: null, provider: 'elevenlabs', text: 'New text' } });
    expect((await svc.getProject('cap-reel')).manifest.audio.voice?.words).toBeUndefined();
  });

  it('imports SRT and WebVTT into cues, with the line of a parse error', async () => {
    const r = await svc.importCaptions('cap-reel', { content: '1\n00:00:00,500 --> 00:00:02,000\nHello\n\n2\n00:00:02,500 --> 00:00:04,000\nWorld\n', mode: 'sidecar', language: 'de' });
    expect(r.imported).toBe(2);
    expect(r.manifest.captions).toMatchObject({ mode: 'sidecar', language: 'de', cues: [{ start: 0.5, end: 2, text: 'Hello' }, { start: 2.5, end: 4, text: 'World' }] });
    const v = await svc.importCaptions('cap-reel', { content: 'WEBVTT\n\n00:01.000 --> 00:02.000\nOnly one' });
    expect(v.manifest.captions.cues).toEqual([{ start: 1, end: 2, text: 'Only one' }]);
    await expect(svc.importCaptions('cap-reel', { content: 'WEBVTT\n\n00:01.000 -> 00:02.000\nBad' })).rejects.toMatchObject({ code: 'invalid_captions', status: 422, details: { line: 3 } });
    await expect(svc.importCaptions('cap-reel', { content: 'x', format: 'ass' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(svc.importCaptions('cap-reel', { content: '1\n00:00:00,500 --> 00:00:02,000\nHi\n', mode: 'loud' })).rejects.toMatchObject({ code: 'invalid_manifest' });
  });
});

describe('caption fonts: uploaded and bundled fonts reach the burn pass (#447)', () => {
  const region = { x: 40, y: 600, w: 460, h: 170 };
  const rfBlock = () => readFileSync(new URL('./fixtures/fonts/rf-block.ttf', import.meta.url));
  const renderBurned = async (projectId: string) => {
    const done = await svc.jobs.waitFor((await svc.startRender(projectId)).id, 120_000);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const id = done.result!.renderId as string;
    return { file: (await svc.renderFile(id)).path, manifest: (await svc.getRenderManifest(id)) as any };
  };

  it('picks the first family of the list that is a project font, a bundled font or installed; else names the fallback', () => {
    expect(captionFontChoice('"RF Block", Inter, sans-serif', ['RF Block'])).toEqual({ family: 'RF Block', source: 'project', requested: 'RF Block' });
    expect(captionFontChoice('"RF Block", Inter, sans-serif', [])).toEqual({ family: 'Inter', source: 'bundled', requested: 'RF Block' });
    expect(captionFontChoice('"source serif 4", serif', [])).toMatchObject({ family: 'Source Serif 4', source: 'bundled' });
    const missing = captionFontChoice('"Nope Sans", sans-serif', []);
    expect(missing).toMatchObject({ source: 'fallback', requested: 'Nope Sans' });
    expect(missing.family).not.toBe('Nope Sans');
  });

  it('a render with an uploaded font named in captionStyle.fontFamily burns the captions in that font (manifest and pixels)', async () => {
    await svc.createProject({ ...sample, projectId: 'font-reel', output: { ...sample.output, width: 540, height: 960 } });
    await svc.updateProject('font-reel', { captions: { mode: 'burned', language: 'en', cues } });
    const before = await renderBurned('font-reel');
    expect(before.manifest.captions.style).toMatchObject({ fontName: 'Inter', fontSource: 'bundled' });
    expect(before.manifest.captions.burnArgs.join(' ')).toContain('fontsdir=fonts');

    await svc.uploadAsset(rfBlock(), { filename: 'rf-block.ttf', projectId: 'font-reel', assetId: 'brand-font', license: { name: 'CC0-1.0', redistributable: true } });
    await svc.updateProject('font-reel', { theme: { base: 'default', tokens: { captionStyle: { fontFamily: '"RF Block", Inter' } } } });
    expect((await svc.validateProject('font-reel')).warnings.filter((w) => w.message.includes('burned captions'))).toEqual([]);
    const after = await renderBurned('font-reel');
    expect(after.manifest.captions.style).toMatchObject({ fontName: 'RF Block', fontSource: 'project' });
    expect(after.manifest.captions.burnArgs).toContain('-vf');
    expect(after.manifest.captions.burnArgs.join(' ')).toMatch(/ass=captions\.ass:fontsdir=fonts/);
    expect(JSON.stringify(after.manifest.captions.burnArgs)).not.toContain(dir);
    // RF Block draws every glyph as a solid box: the caption band is much brighter than the same cue in Inter (about 1.5x here).
    const inter = await regionStats(before.file, 120, region);
    const block = await regionStats(after.file, 120, region);
    expect(inter.yMax).toBeGreaterThan(200);
    expect(block.yAvg, `Inter ${inter.yAvg}, RF Block ${block.yAvg}`).toBeGreaterThan(inter.yAvg * 1.3);
  }, 240_000);

  it('validate_project warns when the caption font is none of them, naming the fallback; the manifest names it too', async () => {
    await svc.updateProject('font-reel', { captions: { style: { fontFamily: '"Nope Sans", sans-serif' } } });
    const w = (await svc.validateProject('font-reel')).warnings.filter((x) => x.message.includes('burned captions'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ path: 'captions.style.fontFamily' });
    const fallback = captionFontChoice('"Nope Sans", sans-serif', []).family;
    expect(w[0]!.message).toContain(`font "Nope Sans" is not a font asset of this project`);
    expect(w[0]!.message).toContain(`they use "${fallback}" instead`);
    const r = await renderBurned('font-reel');
    expect(r.manifest.captions.style).toMatchObject({ fontName: fallback, fontSource: 'fallback' });
    expect(r.manifest.captions.burnArgs.join(' ')).not.toContain('fontsdir');
    // Sidecar only: no warning (nothing is burned).
    await svc.updateProject('font-reel', { captions: { mode: 'sidecar' } });
    expect((await svc.validateProject('font-reel')).warnings.filter((x) => x.message.includes('burned captions'))).toEqual([]);
  }, 240_000);
});
