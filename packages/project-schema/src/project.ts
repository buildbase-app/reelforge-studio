import { z } from 'zod';
import {
  MAX_PROJECT_SECONDS,
  assetLicense,
  isSafeRelativePath,
  output,
  slugId,
} from './common';
import {
  BUILTIN_CATALOG,
  MAX_SOURCE_BYTES,
  SOURCE_ENGINES,
  SOURCE_SCENE_SECONDS,
  type TemplateCatalog,
} from './templates';
import { themeId, themeTokensPatch, captionStyle } from './themes';

/**
 * Manifest v0.2: the agent-facing contract (docs/AGENT_PLATFORM.md §5).
 * v0.1 files are migrated automatically (migrate.ts); the server always stores
 * and answers in this version.
 */
export const SCHEMA_VERSION = '0.2' as const;

const id = slugId;

/** Content-addressed asset ids created by the server's asset store. */
export const STORE_ASSET_ID = /^ast-[0-9a-f]{16}$/;

/**
 * Where an asset's bytes live:
 * - `asset://ast-<16 hex>`: the server's asset store (upload or imported URL);
 * - `project://<relative/path>`: a file inside the project's `assets/` folder
 *   (what v0.1 `path` values migrate to);
 * - `https://...`: a remote file. It must be imported with add_asset_from_url
 *   (which rewrites it to `asset://`) before rendering; the renderer never
 *   downloads during a render.
 */
export const assetUri = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((u, ctx) => {
    if (u.startsWith('asset://')) {
      if (!STORE_ASSET_ID.test(u.slice('asset://'.length))) {
        ctx.addIssue({ code: 'custom', message: 'asset:// URIs must look like asset://ast-<16 hex digits>' });
      }
    } else if (u.startsWith('project://')) {
      if (!isSafeRelativePath(u.slice('project://'.length))) {
        ctx.addIssue({
          code: 'custom',
          message: 'project:// paths must be relative, use forward slashes and contain no ".." segments',
        });
      }
    } else if (u.startsWith('https://')) {
      try {
        new URL(u);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'not a valid https URL' });
      }
    } else {
      ctx.addIssue({ code: 'custom', message: 'must start with asset://, project:// or https://' });
    }
  });

export const asset = z
  .object({
    id,
    uri: assetUri,
    mediaType: z.enum(['audio', 'image', 'video', 'font']),
    /** sha256 of the file, hex. Filled in by the asset store. */
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    contentType: z.string().max(100).optional(),
    bytes: z.number().int().min(0).optional(),
    /** Where the file came from (for imported URLs: the original URL). */
    source: z.string().max(2048).optional(),
    /** Missing license metadata is allowed but produces a warning (FR-052). */
    license: assetLicense.optional(),
  })
  .strict();

export const sceneCaptions = z
  .object({
    /** Caption text for this scene. */
    text: z.string().max(500).optional(),
    /** 'voice' means: derive from the voice track's word timestamps. */
    source: z.enum(['text', 'voice']).default('text'),
  })
  .strict();

export const scene = z
  .object({
    id,
    engine: id.describe(
      'Engine that renders this scene. Built-in engines: remotion, motion-canvas, html, hyperframes. ' +
        'Only engines installed on the server can render (see get_capabilities).'
    ),
    /** Template id. Optional only for source engines (html, hyperframes) when `html` is given. */
    template: z.string().min(1).max(64).optional(),
    /** Agent-supplied HTML body for the html engine, or a full composition for hyperframes. */
    html: z.string().optional(),
    /** Agent-supplied CSS for the html engine. */
    css: z.string().optional(),
    /**
     * Optional. Scenes play one after another with no gaps or overlaps; when a
     * plan states startFrame it must match that timeline.
     */
    startFrame: z.number().int().min(0).optional(),
    /** Exactly one of durationFrames or durationSeconds. Seconds are rounded to whole frames. */
    durationFrames: z.number().int().positive().optional(),
    durationSeconds: z.number().positive().max(MAX_PROJECT_SECONDS).optional(),
    props: z.record(z.string(), z.unknown()).default({}),
    assets: z.array(id).default([]),
    /** Only "cut" exists in v0.2 (scenes play back to back, D-009). */
    transitionIn: z
      .object({ type: z.enum(['cut'], { error: 'only "cut" is supported in manifest v0.2' }) })
      .strict()
      .optional(),
    captions: sceneCaptions.optional(),
    /** Free text for the agent or a human reviewer; ignored by renderers. */
    notes: z.string().max(2000).optional(),
  })
  .strict();

export const voiceTrack = z
  .object({
    /** An audio asset (e.g. created by generate_voice). Required before rendering. */
    asset: id.optional(),
    /** Provider that generated or will generate the voice, e.g. "elevenlabs". */
    provider: z.string().min(1).max(64).optional(),
    text: z.string().max(5000).optional(),
    voiceId: z.string().min(1).max(128).optional(),
    volume: z.number().min(0).max(2).default(1),
    /** Frame at which the voice starts. */
    startFrame: z.number().int().min(0).default(0),
  })
  .strict();

export const musicTrack = z
  .object({
    asset: id,
    /** Level relative to full scale, 0..1. */
    volume: z.number().min(0).max(1).default(0.8),
    /** Lower the music under the voice. Stored; not applied by the v0.1 renderer (warning). */
    ducking: z.boolean().default(false),
    fadeOutSeconds: z.number().min(0).max(10).default(1),
  })
  .strict();

export const sfxCue = z
  .object({
    asset: id,
    atFrame: z.number().int().min(0),
    volume: z.number().min(0).max(2).default(1),
  })
  .strict();

export const audio = z
  .object({
    voice: voiceTrack.nullable().default(null),
    music: musicTrack.nullable().default(null),
    sfx: z.array(sfxCue).max(50).default([]),
  })
  .strict();

export const brief = z
  .object({
    title: z.string().max(200).optional(),
    goal: z.string().max(2000).optional(),
    audience: z.string().max(500).optional(),
    style: z.string().max(500).optional(),
    /** BCP 47 language tag, e.g. "en", "pt-BR". */
    language: z.string().min(2).max(35).optional(),
    targetSeconds: z.number().positive().max(MAX_PROJECT_SECONDS).optional(),
    /** e.g. "instagram-reels", "tiktok", "youtube-shorts". */
    platform: z.string().max(40).optional(),
  })
  .strict();

export const projectTheme = z.union([
  themeId.describe('Id of a theme (built-in "default" or "midnight", or one created with create_theme)'),
  z
    .object({
      base: themeId.default('default'),
      tokens: themeTokensPatch,
    })
    .strict()
    .describe('Inline tokens applied on top of a base theme'),
]);

export const projectCaptions = z
  .object({
    enabled: z.boolean().default(false),
    style: captionStyle.partial().optional(),
  })
  .strict();

export const renderSettings = z
  .object({
    /** Render backend id; "local" renders in the server process. */
    backend: z.string().min(1).max(64).default('local'),
  })
  .strict();

const projectShape = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    projectId: id,
    title: z.string().min(1).max(120),
    brief: brief.optional(),
    theme: projectTheme.default('default'),
    output,
    render: renderSettings.default({ backend: 'local' }),
    audio: audio.default({ voice: null, music: null, sfx: [] }),
    captions: projectCaptions.default({ enabled: false }),
    assets: z.array(asset).default([]),
    scenes: z.array(scene).min(1).max(50),
  })
  .strict();

type Shape = z.infer<typeof projectShape>;

function utf8Bytes(s: string | undefined): number {
  return s ? new TextEncoder().encode(s).length : 0;
}

/** Frames a scene occupies (seconds are rounded to the nearest frame). */
export function sceneFrames(s: { durationFrames?: number; durationSeconds?: number }, fps: number): number {
  if (s.durationFrames !== undefined) return s.durationFrames;
  return Math.max(1, Math.round((s.durationSeconds ?? 0) * fps));
}

/** Cross-field rules. The catalog decides which engines and templates exist. */
function checkProject(p: Shape, ctx: z.RefinementCtx, catalog: TemplateCatalog) {
  const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });

  const assetById = new Map<string, Shape['assets'][number]>();
  p.assets.forEach((a, i) => {
    if (assetById.has(a.id)) add(['assets', i, 'id'], `duplicate asset id "${a.id}"`);
    assetById.set(a.id, a);
  });

  const checkAudioRef = (path: (string | number)[], ref: string | undefined) => {
    if (ref === undefined) return;
    const a = assetById.get(ref);
    if (!a) add(path, `unknown asset id "${ref}"`);
    else if (a.mediaType !== 'audio') add(path, `asset "${ref}" is ${a.mediaType}, expected audio`);
  };
  checkAudioRef(['audio', 'music', 'asset'], p.audio.music?.asset);
  checkAudioRef(['audio', 'voice', 'asset'], p.audio.voice?.asset ?? undefined);
  p.audio.sfx.forEach((s, i) => checkAudioRef(['audio', 'sfx', i, 'asset'], s.asset));
  if (p.audio.voice && !p.audio.voice.asset && !(p.audio.voice.provider && p.audio.voice.text)) {
    add(['audio', 'voice'], 'a voice track needs an audio asset, or a provider and text to generate one');
  }

  const sceneIds = new Set<string>();
  let cursor = 0;
  p.scenes.forEach((s, i) => {
    if (sceneIds.has(s.id)) add(['scenes', i, 'id'], `duplicate scene id "${s.id}"`);
    sceneIds.add(s.id);

    const hasFrames = s.durationFrames !== undefined;
    const hasSeconds = s.durationSeconds !== undefined;
    if (hasFrames === hasSeconds) {
      add(['scenes', i, 'durationFrames'], 'give exactly one of durationFrames or durationSeconds');
    }
    const frames = sceneFrames(s, p.output.fps);

    if (s.startFrame !== undefined && s.startFrame !== cursor) {
      add(['scenes', i, 'startFrame'], `scenes play back to back: expected startFrame ${cursor}, got ${s.startFrame}`);
    }
    cursor += frames;

    s.assets.forEach((ref, j) => {
      if (!assetById.has(ref)) add(['scenes', i, 'assets', j], `unknown asset id "${ref}"`);
    });

    if (!catalog.engines.includes(s.engine)) {
      add(['scenes', i, 'engine'], `unknown engine "${s.engine}"; available engines: ${catalog.engines.join(', ')}`);
      return;
    }

    const isSourceEngine = (SOURCE_ENGINES as readonly string[]).includes(s.engine);
    if ((s.html !== undefined || s.css !== undefined) && !isSourceEngine) {
      add(['scenes', i, 'html'], `engine "${s.engine}" does not accept html/css; use a template`);
      return;
    }
    if (utf8Bytes(s.html) + utf8Bytes(s.css) > MAX_SOURCE_BYTES) {
      add(['scenes', i, 'html'], `html + css is larger than ${MAX_SOURCE_BYTES} bytes`);
    }
    const seconds = frames / p.output.fps;

    if (s.template === undefined) {
      if (!isSourceEngine || s.html === undefined) {
        add(['scenes', i, 'template'], 'a template is required (or html for the html/hyperframes engines)');
        return;
      }
      if (seconds < SOURCE_SCENE_SECONDS.min || seconds > SOURCE_SCENE_SECONDS.max) {
        add(
          ['scenes', i, 'durationFrames'],
          `html scenes support ${SOURCE_SCENE_SECONDS.min}-${SOURCE_SCENE_SECONDS.max}s; this scene is ${seconds.toFixed(2)}s`
        );
      }
      return;
    }
    if (s.html !== undefined) {
      add(['scenes', i, 'html'], 'give either a template or html, not both');
      return;
    }

    const template = catalog.templates[s.template];
    if (!template) {
      const known = Object.keys(catalog.templates).filter((t) => catalog.templates[t]!.engine === s.engine);
      add(
        ['scenes', i, 'template'],
        `unknown template "${s.template}"; templates for engine "${s.engine}": ${known.join(', ') || '(none)'}`
      );
      return;
    }
    if (template.engine !== s.engine) {
      add(['scenes', i, 'template'], `template "${s.template}" belongs to engine "${template.engine}", not "${s.engine}"`);
      return;
    }
    if (seconds < template.minSeconds || seconds > template.maxSeconds) {
      add(
        ['scenes', i, hasSeconds ? 'durationSeconds' : 'durationFrames'],
        `template "${s.template}" supports ${template.minSeconds}-${template.maxSeconds}s; this scene is ${seconds.toFixed(2)}s`
      );
    }
    const props = template.props.safeParse(s.props);
    if (!props.success) {
      for (const issue of props.error.issues) {
        add(['scenes', i, 'props', ...issue.path.map((k) => k as string | number)], issue.message);
      }
    }
  });

  p.audio.sfx.forEach((s, i) => {
    if (s.atFrame >= cursor) add(['audio', 'sfx', i, 'atFrame'], `atFrame ${s.atFrame} is after the end of the video (${cursor} frames)`);
  });
  if (p.audio.voice && p.audio.voice.startFrame >= cursor) {
    add(['audio', 'voice', 'startFrame'], `startFrame is after the end of the video (${cursor} frames)`);
  }

  const totalSeconds = cursor / p.output.fps;
  if (totalSeconds > MAX_PROJECT_SECONDS) {
    add(['scenes'], `project is ${totalSeconds.toFixed(1)}s; the limit is ${MAX_PROJECT_SECONDS}s`);
  }
}

const schemaCache = new WeakMap<TemplateCatalog, ReturnType<typeof makeProjectSchema>>();

/** The manifest schema validated against a template catalog. */
export function makeProjectSchema(catalog: TemplateCatalog) {
  return projectShape.superRefine((p, ctx) => checkProject(p, ctx, catalog));
}

export function projectSchemaFor(catalog: TemplateCatalog) {
  let s = schemaCache.get(catalog);
  if (!s) {
    s = makeProjectSchema(catalog);
    schemaCache.set(catalog, s);
  }
  return s;
}

/** Manifest schema with the built-in catalog. */
export const project = projectSchemaFor(BUILTIN_CATALOG);
/** Shape only (no cross-field rules); used for JSON Schema export. */
export const projectShapeSchema = projectShape;

export type Project = z.infer<typeof projectShape>;
export type ProjectInput = z.input<typeof projectShape>;
export type Scene = z.infer<typeof scene>;
export type SceneInput = z.input<typeof scene>;
export type Asset = z.infer<typeof asset>;
export type AudioSettings = z.infer<typeof audio>;
export type ProjectThemeRef = z.infer<typeof projectTheme>;

/**
 * What an engine needs to render one scene: the duration resolved to frames.
 * Engines never see durationSeconds.
 */
export interface RenderScene {
  id: string;
  engine: string;
  template?: string;
  html?: string;
  css?: string;
  durationFrames: number;
  props: Record<string, unknown>;
  assets?: string[];
}
