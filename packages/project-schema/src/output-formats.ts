import { z } from 'zod';

/**
 * Output containers and codecs (#302, D-1XX). `output.format` picks the
 * container, `output.codec` the codec inside it (default: the first one
 * listed), `output.alpha` a transparent background where the codec carries
 * one. Licence and encoder notes: docs/public/manifest/formats.md#output-formats.
 *
 * HEVC/H.265 is deliberately absent: its patent pools license encoders in
 * products that are sold, and ReelForge is sold (D-1XX).
 */
export const OUTPUT_FORMATS = ['mp4', 'mov', 'webm', 'gif', 'png-sequence', 'm4a', 'wav'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Codecs per format; the first is the default (mov with alpha: prores-4444). */
export const FORMAT_CODECS = {
  mp4: ['h264'],
  mov: ['prores-422-hq', 'prores-4444'],
  webm: ['vp9', 'av1'],
  gif: ['gif'],
  'png-sequence': ['png'],
  m4a: ['aac'],
  wav: ['pcm-s16le'],
} as const satisfies Record<OutputFormat, readonly string[]>;

export const OUTPUT_CODECS = ['h264', 'prores-422-hq', 'prores-4444', 'vp9', 'av1', 'gif', 'png', 'aac', 'pcm-s16le'] as const;
export type OutputCodec = (typeof OUTPUT_CODECS)[number];

/** Codecs that keep an alpha channel (a transparent background). */
export const ALPHA_CODECS: readonly OutputCodec[] = ['prores-4444', 'vp9', 'png'];

/** Formats without pictures. */
export const AUDIO_ONLY_FORMATS: readonly OutputFormat[] = ['m4a', 'wav'];

export const outputFormat = z.enum(OUTPUT_FORMATS, { error: (i) => `format must be one of ${OUTPUT_FORMATS.join(', ')} (got ${JSON.stringify(i.input)})` });
export const outputCodec = z.enum(OUTPUT_CODECS, { error: (i) => `codec must be one of ${OUTPUT_CODECS.join(', ')} (got ${JSON.stringify(i.input)})` });

/** What a render writes: container, codec and whether it keeps alpha. */
export interface FormatSpec {
  format: OutputFormat;
  codec: OutputCodec;
  alpha: boolean;
}

/** The format, codec (default filled in) and alpha of an output. */
export function formatSpec(o: { format: OutputFormat; codec?: OutputCodec | undefined; alpha?: boolean | undefined }): FormatSpec {
  const alpha = o.alpha === true;
  const codec = o.codec ?? (o.format === 'mov' && alpha ? 'prores-4444' : FORMAT_CODECS[o.format][0]);
  return { format: o.format, codec, alpha };
}

/** Why a format/codec/alpha combination is invalid, by field. Empty when it is fine. */
export function formatSpecIssues(o: { format: OutputFormat; codec?: OutputCodec | undefined; alpha?: boolean | undefined }): Array<{ field: 'codec' | 'alpha'; message: string }> {
  const out: Array<{ field: 'codec' | 'alpha'; message: string }> = [];
  const allowed: readonly string[] = FORMAT_CODECS[o.format];
  if (o.codec !== undefined && !allowed.includes(o.codec)) {
    out.push({ field: 'codec', message: `format "${o.format}" takes codec ${allowed.map((c) => `"${c}"`).join(' or ')}, not "${o.codec}"` });
    return out;
  }
  const s = formatSpec(o);
  if (s.alpha && !ALPHA_CODECS.includes(s.codec)) {
    const why = AUDIO_ONLY_FORMATS.includes(s.format)
      ? `format "${s.format}" is audio only`
      : s.format === 'gif'
        ? 'GIF has only on/off transparency, so it is not offered'
        : `codec "${s.codec}" has no alpha channel`;
    out.push({ field: 'alpha', message: `alpha needs format "mov" (codec "prores-4444"), "webm" (codec "vp9") or "png-sequence"; ${why}` });
  }
  return out;
}

/** Fields shared by `output` and a variant's override. */
export const outputFormatFields = {
  /** Codec inside the container (#302); omitted: the format's default (FORMAT_CODECS). */
  codec: outputCodec.optional(),
  /** A transparent background (mov with prores-4444, webm with vp9, png-sequence); engines must declare it. */
  alpha: z.boolean().optional(),
};

/** The file a render writes for a format. */
export const OUTPUT_FILES: Record<OutputFormat, string> = {
  mp4: 'final.mp4',
  mov: 'final.mov',
  webm: 'final.webm',
  gif: 'final.gif',
  'png-sequence': 'frames.zip',
  m4a: 'final.m4a',
  wav: 'final.wav',
};
