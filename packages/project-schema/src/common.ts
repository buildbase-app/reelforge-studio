import { z } from 'zod';
import { formatSpecIssues, outputFormat, outputFormatFields } from './output-formats';

/**
 * Frame rates (#302). Each is exact: an integer, or an NTSC rate as the
 * rational FFmpeg uses (`30000/1001` is 29.97 fps). A manifest may give a rate
 * as a number (30, 29.97), a string ("30000/1001", "29.97") or `{ num, den }`;
 * it is stored in this canonical form: integer rates as numbers (so `30`
 * stays `30`), NTSC rates as their "num/1001" string.
 */
export const FRAME_RATES = [
  { fps: '24000/1001', num: 24000, den: 1001, label: '23.976' },
  { fps: 24, num: 24, den: 1, label: '24' },
  { fps: 25, num: 25, den: 1, label: '25' },
  { fps: '30000/1001', num: 30000, den: 1001, label: '29.97' },
  { fps: 30, num: 30, den: 1, label: '30' },
  { fps: 48, num: 48, den: 1, label: '48' },
  { fps: 50, num: 50, den: 1, label: '50' },
  { fps: '60000/1001', num: 60000, den: 1001, label: '59.94' },
  { fps: 60, num: 60, den: 1, label: '60' },
] as const;

/** A frame rate in its canonical form. */
export type FrameRate = (typeof FRAME_RATES)[number]['fps'];

/** Frame rates the pipeline supports, canonical. Each one is tested on every engine. */
export const SUPPORTED_FPS: readonly FrameRate[] = FRAME_RATES.map((r) => r.fps);

function rateOf(fps: FrameRate | number | string) {
  const r = FRAME_RATES.find((x) => x.fps === fps);
  if (r) return r;
  // A plain number that equals a rate (e.g. 29.97002997 from fpsValue).
  if (typeof fps === 'number') {
    const near = FRAME_RATES.find((x) => Math.abs(x.num / x.den - fps) < 1e-9);
    if (near) return near;
  }
  throw new Error(`unsupported frame rate ${String(fps)}`);
}

/** Frames per second as a number (29.97002997... for 30000/1001). Use for arithmetic, never for FFmpeg arguments. */
export function fpsValue(fps: FrameRate | number): number {
  if (typeof fps === 'number') return fps;
  const r = rateOf(fps);
  return r.num / r.den;
}

/** The rate as an exact fraction. */
export function fpsRational(fps: FrameRate | number): { num: number; den: number } {
  const r = rateOf(fps);
  return { num: r.num, den: r.den };
}

/** The rate as FFmpeg reads it: "30" or "30000/1001" (exact, unlike a decimal). */
export function fpsArg(fps: FrameRate | number): string {
  const r = rateOf(fps);
  return r.den === 1 ? String(r.num) : `${r.num}/${r.den}`;
}

/** Human-readable rate: "29.97", "30". */
export function fpsLabel(fps: FrameRate | number): string {
  return rateOf(fps).label;
}

/** Seconds of `frames` frames at a rate (exact up to floating point). */
export function framesToSeconds(frames: number, fps: FrameRate | number): number {
  if (typeof fps === 'number' && !FRAME_RATES.some((x) => x.fps === fps)) return frames / fps;
  const r = rateOf(fps);
  return (frames * r.den) / r.num;
}

/**
 * Parse a frame rate the way a manifest may give it, or null when it is not a
 * supported rate. Decimal NTSC spellings (23.976, 23.98, 29.97, 59.94) and
 * any fraction equal to a supported rate ({ num: 60, den: 2 }) are accepted.
 */
export function parseFrameRate(input: unknown): FrameRate | null {
  let value: number | null = null;
  let exact = false;
  if (typeof input === 'number') value = input;
  else if (typeof input === 'string') {
    const t = input.trim();
    const m = /^(\d{1,6})\s*\/\s*(\d{1,6})$/.exec(t);
    if (m) {
      const num = Number(m[1]);
      const den = Number(m[2]);
      if (den > 0) {
        value = num / den;
        exact = true;
      }
    } else if (/^\d{1,3}(\.\d{1,6})?$/.test(t)) value = Number(t);
  } else if (input && typeof input === 'object') {
    const { num, den, ...rest } = input as Record<string, unknown>;
    if (Object.keys(rest).length === 0 && Number.isInteger(num) && Number.isInteger(den) && (den as number) > 0 && (num as number) > 0) {
      value = (num as number) / (den as number);
      exact = true;
    }
  }
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  for (const r of FRAME_RATES) {
    const v = r.num / r.den;
    if (Math.abs(value - v) < 1e-9) return r.fps;
    // Decimal spellings of NTSC rates: 23.976 or 23.98, 29.97, 59.94 (never for an exact fraction).
    if (!exact && r.den === 1001 && Math.abs(value - v) < 0.006) return r.fps;
  }
  return null;
}

/**
 * The longest project the manifest format describes, in seconds (4 hours, #302).
 * This is a structural bound, not the server's limit: what a server renders is
 * `limits.maxRenderSeconds` (default 180 s; an admin raises it up to this).
 */
export const MAX_PROJECT_SECONDS = 4 * 3600;

/** The most scenes a manifest may hold (structural; the server's limit is `limits.maxScenes`, default 50). */
export const MAX_SCENES = 2000;

export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour such as #ff3366');

export const slugId = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    'must be lowercase letters, digits and dashes, starting with a letter or digit (max 63)'
  );

/**
 * A path inside the project folder. Absolute paths, `..` segments, backslashes,
 * NUL bytes and URL schemes are rejected so an imported plan cannot point the
 * renderer outside its work directory (ARCHITECTURE §6).
 */
export const safeRelativePath = z
  .string()
  .min(1)
  .max(255)
  .refine((p) => !p.includes('\0'), 'must not contain NUL bytes')
  .refine((p) => !p.includes('\\'), 'must use forward slashes')
  .refine((p) => !p.startsWith('/') && !/^[a-zA-Z]:/.test(p), 'must be relative')
  .refine((p) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p), 'must not be a URL')
  .refine((p) => !p.split('/').includes('..'), 'must not contain ".." segments');

export function isSafeRelativePath(p: string): boolean {
  return safeRelativePath.safeParse(p).success;
}

export const assetLicense = z
  .object({
    /** SPDX id or plain name, e.g. "CC0-1.0", "OFL-1.1", "user-provided". */
    name: z.string().min(1),
    source: z.string().min(1).optional(),
    author: z.string().min(1).optional(),
    attribution: z.string().optional(),
    /** Whether the asset may be shipped inside a paid ReelForge bundle. */
    redistributable: z.boolean(),
  })
  .strict();

function fpsShown(input: unknown): string {
  if (input === undefined) return 'nothing';
  try {
    return String(JSON.stringify(input)).slice(0, 40);
  } catch {
    return typeof input;
  }
}

const FPS_HELP = `fps must be one of ${FRAME_RATES.map((r) => (r.den === 1 ? r.label : `${r.label} ("${r.num}/${r.den}")`)).join(', ')}; give NTSC rates as "30000/1001", { "num": 30000, "den": 1001 } or 29.97`;

/**
 * A frame rate in a manifest: a number, a "num/den" string or { num, den },
 * stored canonically (FRAME_RATES). Unsupported rates are refused with the
 * list of supported ones, so a client (or agent) can correct itself (#322).
 */
export const frameRate = z
  .union([z.number(), z.string().max(20), z.object({ num: z.number().int().positive(), den: z.number().int().positive() }).strict()])
  .transform((v, ctx): FrameRate => {
    const r = parseFrameRate(v);
    if (r === null) {
      ctx.addIssue({ code: 'custom', message: `${FPS_HELP} (got ${fpsShown(v)})` });
      return z.NEVER;
    }
    return r;
  })
  .describe(
    'Frames per second: 24, 25, 30, 48, 50, 60, or an NTSC rate as an exact fraction: "24000/1001" (23.976), "30000/1001" (29.97), "60000/1001" (59.94). ' +
      'Also accepted: { "num": 30000, "den": 1001 } and the decimals 23.976, 29.97, 59.94; stored as the number or the "num/den" string.'
  );

export const output = z
  .object({
    width: z.number().int().min(16).max(4096),
    height: z.number().int().min(16).max(4096),
    fps: frameRate,
    /** Container (#302): mp4, mov, webm, gif, png-sequence (a zip of PNG frames), m4a or wav (audio only). */
    format: outputFormat,
    ...outputFormatFields,
    /**
     * The video is meant to repeat (a loop on a page or a feed, #294): the picture checks compare the last frame
     * with the first and report a jump where it repeats (`checks.loop`). Nothing about the render changes.
     */
    loop: z.boolean().optional(),
  })
  .strict()
  .refine((o) => o.width % 2 === 0 && o.height % 2 === 0, {
    message: 'width and height must be even (required by H.264 yuv420p)',
  })
  .superRefine((o, ctx) => {
    for (const i of formatSpecIssues(o)) ctx.addIssue({ code: 'custom', path: [i.field], message: i.message });
  });

export type OutputSettings = z.infer<typeof output>;

export const DEFAULT_OUTPUT: OutputSettings = { width: 1080, height: 1920, fps: 30, format: 'mp4' };

/** Most output variants one project may declare (each is one render). */
export const MAX_OUTPUT_VARIANTS = 8;

/**
 * One extra output format of a project (#287): the same scenes rendered at
 * another size. fps comes from `output`, so the timeline is the same in every
 * variant; templates lay out again for the new size (reflow, not cropping).
 * `platform` overrides `brief.platform` for this variant (safe areas for app
 * overlays on tall frames). `format`, `codec` and `alpha` override output's
 * (#302): a variant that sets `format` takes neither codec nor alpha from
 * `output`; one that does not inherits them unless it sets them.
 */
export const outputVariant = z
  .object({
    id: slugId,
    width: z.number().int().min(16).max(4096),
    height: z.number().int().min(16).max(4096),
    platform: z.string().min(1).max(40).optional(),
    format: outputFormat.optional(),
    ...outputFormatFields,
  })
  .strict()
  .refine((o) => o.width % 2 === 0 && o.height % 2 === 0, {
    message: 'width and height must be even (required by H.264 yuv420p)',
  });

export type OutputVariant = z.infer<typeof outputVariant>;
