import { z } from 'zod';
import { builtinMediaRefs, templateMediaProps, type PropAssetRef } from './assetRefs';

/**
 * The template catalog: every scene names an engine and a template, and the
 * template decides which props are valid. A plan that names a template the
 * engine does not have is rejected; it is never silently mapped to another
 * engine or template (TEST_PLAN §1, Planner).
 *
 * Engine plugins (packages/core) expose the templates of their engine from
 * this catalog. Validation can be given a different catalog (for example only
 * the engines installed on a server) through `parseProject(input, { catalog })`.
 */

import { hexColor } from './common';
import { layoutMediaRefs, layoutSceneProps } from './layouts';

/**
 * The shortest scene, in frames, for scenes that bring their own HTML source
 * and for the layout templates (#450), so a scene can be a beat-length hard
 * cut (3 frames is 0.1 s at 30 fps). Every engine renders a clip of exactly
 * the scene's frames down to 1 frame; the floor comes from the render fan-out
 * join (D-097), which joins H.264 clips by stream copy: x264 (preset medium,
 * B-pyramid) starts a clip of 3 or more frames 2 frames of B-frame delay
 * before its first picture, and a clip of 1 or 2 frames with none, so a
 * 1-2 frame clip followed by a longer one makes non-increasing decode times
 * that the MP4 muxer squeezes, and the joined video's duration comes out
 * short (media-pipeline test ENC-03). Templates with a designed animation keep
 * their own `minSeconds`.
 */
export const MIN_SCENE_FRAMES = 3;

/** Below this a scene validates with a warning (an entry or caption cannot be read in that time). */
export const SHORT_SCENE_WARN_SECONDS = 0.25;

/** Duration limits for scenes that bring their own HTML source: at least MIN_SCENE_FRAMES frames, at most `max` seconds. */
export const SOURCE_SCENE_SECONDS = { max: 60 } as const;

export const kineticTitleProps = z
  .object({
    headline: z.string().min(1).max(60),
    subline: z.string().max(80).optional(),
    /** Overrides the theme accent colour for this scene. */
    accent: hexColor.optional(),
    /** Overrides the theme background colour for this scene. */
    background: hexColor.optional(),
    /** A background image or video (#299) and a logo, by manifest asset id. */
    ...templateMediaProps,
  })
  .strict();

export const animatedExplainerProps = z
  .object({
    title: z.string().min(1).max(60),
    /** Long points wrap onto several lines; keep them short for readability. */
    points: z.array(z.string().min(1).max(90)).min(1).max(4),
    accent: hexColor.optional(),
    background: hexColor.optional(),
    /** A background image or video (#299) and a logo, by manifest asset id. */
    ...templateMediaProps,
  })
  .strict();

export const htmlTitleProps = z
  .object({
    headline: z.string().min(1).max(80),
    subline: z.string().max(120).optional(),
    /** Small label above the headline, e.g. "STEP 1". */
    kicker: z.string().max(40).optional(),
    accent: hexColor.optional(),
    background: hexColor.optional(),
    /** A background image or video (#299) and a logo, by manifest asset id. */
    ...templateMediaProps,
  })
  .strict();

export const hyperframesTitleProps = z
  .object({
    headline: z.string().min(1).max(80),
    subline: z.string().max(120).optional(),
    accent: hexColor.optional(),
    background: hexColor.optional(),
    /** A background image or video (#299) and a logo, by manifest asset id. */
    ...templateMediaProps,
  })
  .strict();

/** Engines that have built-in templates. Servers report what is installed. */
export const ENGINES = ['remotion', 'motion-canvas', 'html', 'hyperframes'] as const;
export type EngineId = (typeof ENGINES)[number];

/** Theme tokens a template can read. See themes.ts. */
export type ThemeTokenName =
  | 'colors.background'
  | 'colors.surface'
  | 'colors.text'
  | 'colors.mutedText'
  | 'colors.accent'
  | 'colors.accent2'
  | 'fontFamily'
  | 'headingWeight'
  | 'motionSpeed';

export interface TemplateDefinition {
  engine: string;
  description: string;
  props: z.ZodType;
  /** Shortest and longest duration the template is designed for, in seconds. 0: down to MIN_SCENE_FRAMES frames. */
  minSeconds: number;
  maxSeconds: number;
  /** Theme tokens the template reads (props such as `accent` override them). */
  themeTokens: readonly ThemeTokenName[];
  /**
   * The assets the props place (#299). Validation checks that each one is in
   * the manifest's assets and of an allowed media type; the renderer stages
   * exactly these files for the scene.
   */
  mediaAssets?: (props: unknown) => PropAssetRef[];
}

const MEDIA_NOTE = ' Optional `media` (a background image or video asset, fit contain, cover or blur-fill, dimmed under the text) and `logo` (an image asset in a corner of the safe area).';

const COMMON_TOKENS = [
  'colors.background',
  'colors.text',
  'colors.mutedText',
  'colors.accent',
  'fontFamily',
  'headingWeight',
] as const satisfies readonly ThemeTokenName[];

const LAYOUT_TOKENS = ['colors.background', 'colors.surface', 'colors.text', 'colors.mutedText', 'colors.accent', 'fontFamily', 'headingWeight'] as const satisfies readonly ThemeTokenName[];

const LAYOUT_DESCRIPTION =
  'Layout of panes: full frame, split screen (2-4 panes, side by side or stacked, with ratios), picture-in-picture (corner, width and margin in units from the safe area) or grid (n x m, or chosen per frame). ' +
  'Each pane holds an image or video asset with a fit mode (contain, cover, blur-fill), a colour, a label, a headline and body text; an optional lower third (name, title, brand colours) sits in the safe area. ' +
  'Sizes are in layout units (1 % of the shorter side), so the scene reflows for every output size and variant. ' +
  `${MIN_SCENE_FRAMES} frames to 60 s.`;

export const TEMPLATES = {
  'kinetic-title': {
    engine: 'remotion',
    description:
      'Bold animated headline (max 60 chars) that springs in word by word, an accent bar and an optional subline. Good as a hook. 1.5-8 s.' + MEDIA_NOTE,
    props: kineticTitleProps,
    minSeconds: 1.5,
    maxSeconds: 8,
    themeTokens: COMMON_TOKENS,
    mediaAssets: builtinMediaRefs,
  },
  'animated-explainer': {
    engine: 'motion-canvas',
    description:
      'A title followed by 1-4 numbered points revealed one by one; long points wrap. Good for steps or lists. 2-20 s.' + MEDIA_NOTE,
    props: animatedExplainerProps,
    minSeconds: 2,
    maxSeconds: 20,
    themeTokens: COMMON_TOKENS,
    mediaAssets: builtinMediaRefs,
  },
  'html-title': {
    engine: 'html',
    description:
      'Headline card built from HTML/CSS with an optional kicker and subline, animated with CSS keyframes. 1-12 s.' + MEDIA_NOTE,
    props: htmlTitleProps,
    minSeconds: 1,
    maxSeconds: 12,
    themeTokens: [...COMMON_TOKENS, 'colors.surface', 'motionSpeed'],
    mediaAssets: builtinMediaRefs,
  },
  'remotion-layout': {
    engine: 'remotion',
    description: LAYOUT_DESCRIPTION,
    props: layoutSceneProps,
    minSeconds: 0,
    maxSeconds: 60,
    themeTokens: LAYOUT_TOKENS,
    mediaAssets: layoutMediaRefs,
  },
  'motion-canvas-layout': {
    engine: 'motion-canvas',
    description: LAYOUT_DESCRIPTION,
    props: layoutSceneProps,
    minSeconds: 0,
    maxSeconds: 60,
    themeTokens: LAYOUT_TOKENS,
    mediaAssets: layoutMediaRefs,
  },
  'html-layout': {
    engine: 'html',
    description: LAYOUT_DESCRIPTION,
    props: layoutSceneProps,
    minSeconds: 0,
    maxSeconds: 60,
    themeTokens: LAYOUT_TOKENS,
    mediaAssets: layoutMediaRefs,
  },
  'hyperframes-layout': {
    engine: 'hyperframes',
    description: LAYOUT_DESCRIPTION,
    props: layoutSceneProps,
    minSeconds: 0,
    maxSeconds: 60,
    themeTokens: LAYOUT_TOKENS,
    mediaAssets: layoutMediaRefs,
  },
  'hyperframes-title': {
    engine: 'hyperframes',
    description:
      'Headline and subline as a HyperFrames composition (CSS keyframes seeked by the HyperFrames runtime; no GSAP), rendered locally by the HyperFrames renderer. 1-12 s.' + MEDIA_NOTE,
    props: hyperframesTitleProps,
    minSeconds: 1,
    maxSeconds: 12,
    themeTokens: COMMON_TOKENS,
    mediaAssets: builtinMediaRefs,
  },
} as const satisfies Record<string, TemplateDefinition>;

export type TemplateId = keyof typeof TEMPLATES;
export type KineticTitleProps = z.infer<typeof kineticTitleProps>;
export type AnimatedExplainerProps = z.infer<typeof animatedExplainerProps>;
export type HtmlTitleProps = z.infer<typeof htmlTitleProps>;
export type HyperframesTitleProps = z.infer<typeof hyperframesTitleProps>;

/**
 * Engines that accept raw source code instead of (or as well as) a template:
 * the scene carries `html` (+ `css`) and no template.
 */
export const SOURCE_ENGINES = ['html', 'hyperframes'] as const;

/** A template's duration range for people and agents: "1-12 s", or "2 frames to 60 s" when it has no seconds floor. */
export function templateDurationLabel(t: { minSeconds: number; maxSeconds: number }): string {
  return t.minSeconds > 0 ? `${t.minSeconds}-${t.maxSeconds} s` : `${MIN_SCENE_FRAMES} frames to ${t.maxSeconds} s`;
}

/** Upper bound for agent-supplied html + css, in bytes (UTF-8). */
export const MAX_SOURCE_BYTES = 256 * 1024;

export interface TemplateCatalog {
  /** Engines that may appear in a manifest. */
  engines: readonly string[];
  templates: Readonly<Record<string, TemplateDefinition>>;
}

export const BUILTIN_CATALOG: TemplateCatalog = { engines: ENGINES, templates: TEMPLATES };

export function templatesForEngine(engine: string, catalog: TemplateCatalog = BUILTIN_CATALOG): string[] {
  return Object.keys(catalog.templates).filter((id) => catalog.templates[id]!.engine === engine);
}

/** JSON Schema of one template's props, for agents. */
export function templatePropsJsonSchema(def: TemplateDefinition): Record<string, unknown> {
  return z.toJSONSchema(def.props, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}
