import { z } from 'zod';
import { TEMPLATES, type TemplateId } from './templates';

/**
 * Manifest v0.1 (legacy). Kept so v0.1 files are validated with their own
 * rules and paths before being migrated to the current version (migrate.ts).
 * Do not extend: new fields go into project.ts.
 */
export const V01_SCHEMA_VERSION = '0.1' as const;
const V01_ENGINES = ['remotion', 'motion-canvas'] as const;

import { MAX_PROJECT_SECONDS, assetLicense, output, safeRelativePath } from './common';

const id = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    'must be lowercase letters, digits and dashes, starting with a letter or digit (max 63)'
  );

const asset = z
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

const scene = z
  .object({
    id,
    engine: z.enum(V01_ENGINES),
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

const audio = z
  .object({
    musicTrack: id.nullable().default(null),
    voiceTrack: id.nullable().default(null),
    /** Music level relative to full scale, 0..1. */
    musicVolume: z.number().min(0).max(1).default(0.8),
  })
  .strict();

const projectShape = z
  .object({
    schemaVersion: z.literal(V01_SCHEMA_VERSION),
    projectId: id,
    title: z.string().min(1).max(120),
    output,
    audio: audio.default({ musicTrack: null, voiceTrack: null, musicVolume: 0.8 }),
    assets: z.array(asset).default([]),
    scenes: z.array(scene).min(1).max(50),
  })
  .strict();

export const projectV01 = projectShape.superRefine((p, ctx) => {
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

    const template = TEMPLATES[s.template as TemplateId] as (typeof TEMPLATES)[TemplateId] | undefined;
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

export type ProjectV01 = z.infer<typeof projectV01>;
export type ProjectV01Input = z.input<typeof projectV01>;
