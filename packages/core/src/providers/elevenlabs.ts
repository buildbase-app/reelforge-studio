import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../errors';
import { userAgent } from '../product';
import type { ProviderPlugin, ProviderResult, ProviderRunContext } from '../plugins';

export const elevenLabsParams = z
  .object({
    text: z.string().min(1).max(5000).describe('What the voice says.'),
    voiceId: z.string().min(1).max(64).regex(/^[A-Za-z0-9]+$/, 'ElevenLabs voice ids are alphanumeric').describe('ElevenLabs voice id.'),
    modelId: z.string().min(1).max(64).default('eleven_multilingual_v2'),
    outputFormat: z.enum(['mp3_44100_128', 'mp3_44100_192']).default('mp3_44100_128'),
    languageCode: z.string().min(2).max(10).optional(),
  })
  .strict();

export type ElevenLabsParams = z.infer<typeof elevenLabsParams>;

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

/** Group ElevenLabs character alignment into words (whitespace separated). */
export function wordsFromAlignment(a: {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}): WordTimestamp[] {
  const words: WordTimestamp[] = [];
  let current: WordTimestamp | null = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (current) words.push(current);
      current = null;
      return;
    }
    const start = a.character_start_times_seconds[i] ?? 0;
    const end = a.character_end_times_seconds[i] ?? start;
    if (!current) current = { word: ch, start, end };
    else {
      current.word += ch;
      current.end = end;
    }
  });
  if (current) words.push(current);
  return words;
}

/**
 * Text-to-speech with ElevenLabs ("with-timestamps" endpoint), returning an
 * MP3 asset plus word timestamps for captions.
 *
 * Unit-tested against a mocked fetch only. Live behaviour against the real API
 * is UNTESTED in v0.1 (no key in CI); VERIFY before relying on it.
 * Endpoint per https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
 */
export class ElevenLabsTts implements ProviderPlugin {
  readonly id = 'elevenlabs';
  readonly kind = 'tts' as const;
  readonly displayName = 'ElevenLabs text-to-speech';
  readonly env = ['ELEVENLABS_API_KEY'];
  /** Each workspace may use its own ElevenLabs account (#480): the key comes from ctx.env. */
  readonly scopedSettings = true;
  readonly params = elevenLabsParams;
  readonly costNote =
    'Calls the ElevenLabs API with the operator\'s key and uses their character quota (billed by ElevenLabs per character). ' +
    'Identical requests are served from the local cache at no cost.';

  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly baseUrl = 'https://api.elevenlabs.io'
  ) {}

  configured(env: Readonly<Record<string, string | undefined>> = this.environment): boolean {
    return Boolean(env.ELEVENLABS_API_KEY);
  }

  cacheKey(params: unknown): string {
    const p = elevenLabsParams.parse(params);
    return createHash('sha256').update(JSON.stringify(['elevenlabs', p.voiceId, p.modelId, p.outputFormat, p.languageCode ?? '', p.text])).digest('hex');
  }

  async run(params: unknown, ctx: ProviderRunContext): Promise<ProviderResult> {
    // The settings of the calling workspace when the service passes them (#480); never mixed with the instance's.
    const key = (ctx.env ?? this.environment).ELEVENLABS_API_KEY;
    if (!key) throw new ApiError('provider_not_configured', 409, 'ElevenLabs is not configured: set ELEVENLABS_API_KEY (configure_provider, or configure_workspace_provider for one workspace)');
    const p = elevenLabsParams.parse(params);
    const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(p.voiceId)}/with-timestamps?output_format=${p.outputFormat}`;
    ctx.log(`elevenlabs: ${p.text.length} characters, voice ${p.voiceId}, model ${p.modelId}`);
    const res = await ctx.fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'application/json', 'user-agent': userAgent('Providers') },
      body: JSON.stringify({ text: p.text, model_id: p.modelId, ...(p.languageCode ? { language_code: p.languageCode } : {}) }),
      signal: ctx.signal,
    });
    if (!res.ok) {
      // Never echo the request headers (they contain the key).
      const body = (await res.text().catch(() => '')).slice(0, 500);
      throw new ApiError('provider_failed', 502, `ElevenLabs returned HTTP ${res.status}`, { body });
    }
    const json = (await res.json()) as {
      audio_base64?: string;
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null;
    };
    if (!json.audio_base64) throw new ApiError('provider_failed', 502, 'ElevenLabs response had no audio');
    const words = json.alignment ? wordsFromAlignment(json.alignment) : [];
    const durationSeconds = json.alignment?.character_end_times_seconds.at(-1);
    const asset = await ctx.putAsset({
      data: Buffer.from(json.audio_base64, 'base64'),
      source: 'elevenlabs',
      license: {
        name: 'ElevenLabs generated audio',
        source: 'elevenlabs',
        attribution: 'Check your ElevenLabs plan terms for commercial use',
        redistributable: false,
      },
      metadata: { provider: 'elevenlabs', voiceId: p.voiceId, modelId: p.modelId, text: p.text, words },
    });
    return { asset, data: { words, ...(durationSeconds !== undefined ? { durationSeconds } : {}) } };
  }
}
