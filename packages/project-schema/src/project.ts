import { z } from 'zod';
import { ENGINES, TEMPLATES, type TemplateId } from './templates';

export const SCHEMA_VERSION = '0.1' as const;

/** Frame rates the pipeline supports. Kept small on purpose: each one is tested. */
export const SUPPORTED_FPS = [24, 25, 30, 60] as const;

/** Upper bound on a whole project, in seconds. Short-form first. */
export const MAX_PROJECT_SECONDS = 180;

const id = z
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

export const asset = z
  .object({
    id,
    path: safeRelativePath,
    mediaType: z.enum(['audio', 'image', 'video', 'font']),
    /** sha256 of the file, hex. Checked on import when present. */
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /** Missing license metadata is allowed but produces a warning (FR-052). */
    license: assetLicense.optional(),
  })
  .strict();

export const scene = z
  .object({
    id,
    engine: z.enum(ENGINES),
    template: z.string().min(1),
    /**
     * Optional. Scenes play one after another with no gaps or overlaps; when a
     * plan states startFrame it must match that timeline.
     */
    startFrame: z.number().int().min(0).optional(),
    durationFrames: z.number().int().positive(),
    props: z.record(z.string(), z.unknown()).default({}),
    assets: z.array(id).default([]),
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

export const audio = z
  .object({
    musicTrack: id.nullable().default(null),
    voiceTrack: id.nullable().default(null),
    /** Music level relative to full scale, 0..1. */
    musicVolume: z.number().min(0).max(1).default(0.8),
  })
  .strict();

const projectShape = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    projectId: id,
    title: z.string().min(1).max(120),
    output,
    audio: audio.default({ musicTrack: null, voiceTrack: null, musicVolume: 0.8 }),
    assets: z.array(asset).default([]),
    scenes: z.array(scene).min(1).max(50),
  })
  .strict();

export const project = projectShape.superRefine((p, ctx) => {
  const assetIds = new Set<string>();
  p.assets.forEach((a, i) => {
    if (assetIds.has(a.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['assets', i, 'id'],
        message: `duplicate asset id "${a.id}"`,
      });
    }
    assetIds.add(a.id);
  });

  const assetById = new Map(p.assets.map((a) => [a.id, a]));
  for (const key of ['musicTrack', 'voiceTrack'] as const) {
    const ref = p.audio[key];
    if (ref === null) continue;
    const a = assetById.get(ref);
    if (!a) {
      ctx.addIssue({
        code: 'custom',
        path: ['audio', key],
        message: `unknown asset id "${ref}"`,
      });
    } else if (a.mediaType !== 'audio') {
      ctx.addIssue({
        code: 'custom',
        path: ['audio', key],
        message: `asset "${ref}" is ${a.mediaType}, expected audio`,
      });
    }
  }

  const sceneIds = new Set<string>();
  let cursor = 0;
  p.scenes.forEach((s, i) => {
    if (sceneIds.has(s.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes', i, 'id'],
        message: `duplicate scene id "${s.id}"`,
      });
    }
    sceneIds.add(s.id);

    if (s.startFrame !== undefined && s.startFrame !== cursor) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes', i, 'startFrame'],
        message: `scenes play back to back: expected startFrame ${cursor}, got ${s.startFrame}`,
      });
    }
    cursor += s.durationFrames;

    s.assets.forEach((ref, j) => {
      if (!assetIds.has(ref)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', i, 'assets', j],
          message: `unknown asset id "${ref}"`,
        });
      }
    });

    const template = TEMPLATES[s.template as TemplateId];
    if (!template) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes', i, 'template'],
        message: `unknown template "${s.template}"`,
      });
      return;
    }
    if (template.engine !== s.engine) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes', i, 'template'],
        message: `template "${s.template}" belongs to engine "${template.engine}", not "${s.engine}"`,
      });
      return;
    }
    const seconds = s.durationFrames / p.output.fps;
    if (seconds < template.minSeconds || seconds > template.maxSeconds) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes', i, 'durationFrames'],
        message: `template "${s.template}" supports ${template.minSeconds}-${template.maxSeconds}s; this scene is ${seconds.toFixed(2)}s`,
      });
    }
    const props = template.props.safeParse(s.props);
    if (!props.success) {
      for (const issue of props.error.issues) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', i, 'props', ...issue.path.map((k) => k as string | number)],
          message: issue.message,
        });
      }
    }
  });

  const totalSeconds = cursor / p.output.fps;
  if (totalSeconds > MAX_PROJECT_SECONDS) {
    ctx.addIssue({
      code: 'custom',
      path: ['scenes'],
      message: `project is ${totalSeconds.toFixed(1)}s; the limit is ${MAX_PROJECT_SECONDS}s`,
    });
  }
});

export type Project = z.infer<typeof project>;
export type ProjectInput = z.input<typeof project>;
export type Scene = z.infer<typeof scene>;
export type Asset = z.infer<typeof asset>;
export type OutputSettings = z.infer<typeof output>;
