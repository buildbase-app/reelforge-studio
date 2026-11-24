import { z } from 'zod';

/** Frame rates the pipeline supports. Kept small on purpose: each one is tested. */
export const SUPPORTED_FPS = [24, 25, 30, 60] as const;

/** Upper bound on a whole project, in seconds. Short-form first. */
export const MAX_PROJECT_SECONDS = 180;

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

export const output = z
  .object({
    width: z.number().int().min(16).max(4096),
    height: z.number().int().min(16).max(4096),
    fps: z.union(
      SUPPORTED_FPS.map((f) => z.literal(f)) as [z.ZodLiteral<24>, z.ZodLiteral<25>, z.ZodLiteral<30>, z.ZodLiteral<60>],
      // Say what is allowed, so a client (or agent) can correct itself (#322).
      { error: (issue) => `fps must be one of ${SUPPORTED_FPS.join(', ')} (got ${fpsShown(issue.input)})` }
    ),
    format: z.literal('mp4'),
  })
  .strict()
  .refine((o) => o.width % 2 === 0 && o.height % 2 === 0, {
    message: 'width and height must be even (required by H.264 yuv420p)',
  });

export type OutputSettings = z.infer<typeof output>;

export const DEFAULT_OUTPUT: OutputSettings = { width: 1080, height: 1920, fps: 30, format: 'mp4' };

/** Most output variants one project may declare (each is one render). */
export const MAX_OUTPUT_VARIANTS = 8;

/**
 * One extra output format of a project (#287): the same scenes rendered at
 * another size. fps and format come from `output`, so the timeline is the
 * same in every variant; templates lay out again for the new size (reflow,
 * not cropping). `platform` overrides `brief.platform` for this variant
 * (safe areas for app overlays on tall frames).
 */
export const outputVariant = z
  .object({
    id: slugId,
    width: z.number().int().min(16).max(4096),
    height: z.number().int().min(16).max(4096),
    platform: z.string().min(1).max(40).optional(),
  })
  .strict()
  .refine((o) => o.width % 2 === 0 && o.height % 2 === 0, {
    message: 'width and height must be even (required by H.264 yuv420p)',
  });

export type OutputVariant = z.infer<typeof outputVariant>;
