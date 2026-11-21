import { z } from 'zod';

/** Frame rates the pipeline supports. Kept small on purpose: each one is tested. */
export const SUPPORTED_FPS = [24, 25, 30, 60] as const;

/** Upper bound on a whole project, in seconds. Short-form first. */
export const MAX_PROJECT_SECONDS = 180;

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

export const output = z
  .object({
    width: z.number().int().min(16).max(4096),
    height: z.number().int().min(16).max(4096),
    fps: z.union(SUPPORTED_FPS.map((f) => z.literal(f)) as [
      z.ZodLiteral<24>,
      z.ZodLiteral<25>,
      z.ZodLiteral<30>,
      z.ZodLiteral<60>,
    ]),
    format: z.literal('mp4'),
  })
  .strict()
  .refine((o) => o.width % 2 === 0 && o.height % 2 === 0, {
    message: 'width and height must be even (required by H.264 yuv420p)',
  });

export type OutputSettings = z.infer<typeof output>;

export const DEFAULT_OUTPUT: OutputSettings = { width: 1080, height: 1920, fps: 30, format: 'mp4' };
