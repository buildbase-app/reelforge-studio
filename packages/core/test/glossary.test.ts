import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyGlossaryToTranscript, checkGlossary, glossaryPrompt, projectGlossary, restoreGlossaryTerms, spokenText } from '@renderweld/project-schema';
import { createMemoryRepositories, PluginRegistry, RenderWeldService, type ProviderPlugin, type ProviderRunContext, type SpeechToTextPlugin, type SttRequest, type SttResult } from '../src/index';
import { fakeEngine, makeTone, tempDir } from './helpers';

/** The project glossary (#486): speech-to-text prompt and spellings, TTS pronunciations, caption QA. */
const { dir, cleanup } = tempDir('renderweld-glossary-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const glossary = [
  { term: 'RenderWeld', spoken: 'render weld', alternatives: ['render weld', 'rendaweld'] },
  { term: 'Claude Code', doNotTranslate: true },
];

/** Speech-to-text that hears the brand name as two words. */
class HearsTwoWords implements SpeechToTextPlugin {
  readonly id = 'fake-stt';
  readonly displayName = 'Fake speech-to-text';
  calls: SttRequest[] = [];
  availability() {
    return { ok: true } as const;
  }
  async transcribe(req: SttRequest): Promise<SttResult> {
    this.calls.push(req);
    const words = ['Try', 'render', 'weld,', 'built', 'with', 'claude', 'code.'];
    return { language: 'en', durationSeconds: 3, engine: { name: 'fake' }, words: words.map((text, i) => ({ text, start: 0.3 + i * 0.35, end: 0.6 + i * 0.35 })) };
  }
}

/** TTS that records the text it was asked to read and returns timings for exactly those words. */
class RecordingTts implements ProviderPlugin {
  readonly id = 'fake-tts';
  readonly kind = 'tts' as const;
  readonly displayName = 'Fake TTS';
  readonly env: string[] = [];
  readonly costNote = 'Test provider.';
  readonly params = z.object({ text: z.string(), voiceId: z.string().optional() });
  texts: string[] = [];
  constructor(private readonly audio: Buffer) {}
  configured() {
    return true;
  }
  cacheKey(params: unknown) {
    return `fake-tts:${(params as { text: string }).text}`;
  }
  async run(params: unknown, ctx: ProviderRunContext) {
    const { text } = params as { text: string };
    this.texts.push(text);
    const words = text.split(/\s+/).map((w, i) => ({ word: w, start: i * 0.4, end: i * 0.4 + 0.35 }));
    const asset = await ctx.putAsset({ data: this.audio, source: this.id, metadata: {} } as never);
    return { asset, data: { words } };
  }
}

let svc: RenderWeldService;
const stt = new HearsTwoWords();
let tts: RecordingTts;

beforeAll(async () => {
  await makeTone(join(dir, 'tone.mp3'), 3);
  tts = new RecordingTts(readFileSync(join(dir, 'tone.mp3')));
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas')).registerStt(stt).registerProvider(tts);
  svc = await RenderWeldService.create(registry, {
    repositories: createMemoryRepositories(),
    dataDir: join(dir, 'data'),
    configSources: { env: { RENDERWELD_LICENCE_MODE: 'off', RENDERWELD_STT_PROVIDER: 'fake-stt' } },
  });
});
afterAll(() => cleanup());

describe('glossary helpers', () => {
  it('GL-01 the schema refuses duplicate terms, the prompt lists the terms, transcripts get the exact spelling', () => {
    expect(projectGlossary.safeParse([{ term: 'RenderWeld' }, { term: 'renderweld' }]).success).toBe(false);
    expect(projectGlossary.safeParse([{ term: 'RenderWeld', extra: 1 }]).success).toBe(false);
    expect(glossaryPrompt(glossary)).toBe('RenderWeld, Claude Code.');
    expect(glossaryPrompt([])).toBeUndefined();
    const words = ['Try', 'render', 'weld,', 'and', 'RENDERWELD', 'or', 'rendaweld.'].map((text, i) => ({ text, start: i, end: i + 0.5 }));
    const r = applyGlossaryToTranscript(words, glossary);
    expect(r.words.map((w) => w.text)).toEqual(['Try', 'RenderWeld,', 'and', 'RenderWeld', 'or', 'RenderWeld.']);
    // The two words become one, spanning both.
    expect(r.words[1]).toMatchObject({ start: 1, end: 2.5 });
    expect(r.replacements).toHaveLength(3);
  });

  it('GL-02 TTS text uses the spoken form; its timings go back to the term; QA compares script and captions', () => {
    expect(spokenText('Meet RenderWeld, then renderweld again.', glossary)).toEqual({ text: 'Meet render weld, then render weld again.', replaced: 2 });
    expect(spokenText('Nothing to change.', glossary)).toEqual({ text: 'Nothing to change.', replaced: 0 });
    const timed = ['Meet', 'render', 'weld.'].map((text, i) => ({ text, start: i, end: i + 0.5 }));
    expect(restoreGlossaryTerms(timed, glossary).words.map((w) => w.text)).toEqual(['Meet', 'RenderWeld.']);
    expect(checkGlossary('Meet RenderWeld.', 'Meet render weld.', glossary)).toEqual([expect.objectContaining({ term: 'RenderWeld', rule: 'missingFromCaptions', inScript: 1, inCaptions: 0 })]);
    expect(checkGlossary('Meet RenderWeld.', 'Meet RenderWeld.', glossary)).toEqual([]);
  });
});

describe('glossary in the studio', () => {
  it('GL-10 speech-to-text gets the terms as its prompt; the stored words have the exact spellings; the replacements are reported', async () => {
    await svc.createProject({ ...sample, projectId: 'stt-glossary' });
    await svc.updateProject('stt-glossary', { glossary });
    await svc.uploadAsset(readFileSync(join(dir, 'tone.mp3')), { filename: 'voice.mp3', projectId: 'stt-glossary', assetId: 'voice', license: { name: 'test', redistributable: true } });
    await svc.setAudio('stt-glossary', { voice: { asset: 'voice', startFrame: 0 } });
    const r = await svc.transcribeCaptions('stt-glossary', {});
    expect(stt.calls.at(-1)!.prompt).toBe('RenderWeld, Claude Code.');
    const words = (await svc.getProject('stt-glossary')).manifest.audio.voice?.words?.map((w) => w.text);
    expect(words).toEqual(['Try', 'RenderWeld,', 'built', 'with', 'Claude Code.']);
    expect((r as { glossaryReplacements?: unknown[] }).glossaryReplacements).toHaveLength(2);
  });

  it('GL-11 a voice for a project reads the spoken form; the stored text and the caption words keep the term', async () => {
    await svc.createProject({ ...sample, projectId: 'tts-glossary' });
    await svc.updateProject('tts-glossary', { glossary });
    await svc.runProvider('fake-tts', { text: 'Meet RenderWeld today.' }, { projectId: 'tts-glossary', acknowledgeCost: true });
    expect(tts.texts.at(-1)).toBe('Meet render weld today.');
    const voice = (await svc.getProject('tts-glossary')).manifest.audio.voice;
    expect(voice?.text).toBe('Meet RenderWeld today.');
    expect(voice?.words?.map((w) => w.text)).toEqual(['Meet', 'RenderWeld', 'today.']);
    // Without a project there is no glossary: the text goes as written.
    await svc.runProvider('fake-tts', { text: 'Meet RenderWeld again.' }, { acknowledgeCost: true });
    expect(tts.texts.at(-1)).toBe('Meet RenderWeld again.');
  });

  it('GL-12 caption QA flags a term the cues misspell, and is clean once they spell it', async () => {
    const view = await svc.getCaptions({ projectId: 'tts-glossary' });
    expect(view.languages[0]!.qa.glossary ?? []).toEqual([]);
    const edited = await svc.updateCaptions('tts-glossary', { etag: view.etag, edits: [{ index: 0, text: 'Meet render weld today.' }] });
    expect(edited.languages[0]!.qa.ok).toBe(false);
    expect(edited.languages[0]!.qa.glossary).toEqual([expect.objectContaining({ term: 'RenderWeld', rule: 'missingFromCaptions' })]);
    const fixed = await svc.updateCaptions('tts-glossary', { etag: edited.etag, edits: [{ index: 0, text: 'Meet RenderWeld today.' }] });
    expect(fixed.languages[0]!.qa.glossary ?? []).toEqual([]);
  });
});
