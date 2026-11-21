import { z } from 'zod';

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

export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour such as #ff3366');

export const kineticTitleProps = z
  .object({
    headline: z.string().min(1).max(60),
    subline: z.string().max(80).optional(),
    /** Overrides the theme accent colour for this scene. */
    accent: hexColor.optional(),
    /** Overrides the theme background colour for this scene. */
    background: hexColor.optional(),
  })
  .strict();

export const animatedExplainerProps = z
  .object({
    title: z.string().min(1).max(60),
    /** Long points wrap onto several lines; keep them short for readability. */
    points: z.array(z.string().min(1).max(90)).min(1).max(4),
    accent: hexColor.optional(),
    background: hexColor.optional(),
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
  })
  .strict();

export const hyperframesTitleProps = z
  .object({
    headline: z.string().min(1).max(80),
    subline: z.string().max(120).optional(),
    accent: hexColor.optional(),
    background: hexColor.optional(),
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
  /** Shortest and longest duration the template is designed for, in seconds. */
  minSeconds: number;
  maxSeconds: number;
  /** Theme tokens the template reads (props such as `accent` override them). */
  themeTokens: readonly ThemeTokenName[];
}

const COMMON_TOKENS = [
  'colors.background',
  'colors.text',
  'colors.mutedText',
  'colors.accent',
  'fontFamily',
  'headingWeight',
] as const satisfies readonly ThemeTokenName[];

export const TEMPLATES = {
  'kinetic-title': {
    engine: 'remotion',
    description:
      'Bold animated headline (max 60 chars) that springs in word by word, an accent bar and an optional subline. Good as a hook. 1.5-8 s.',
    props: kineticTitleProps,
    minSeconds: 1.5,
    maxSeconds: 8,
    themeTokens: COMMON_TOKENS,
  },
  'animated-explainer': {
    engine: 'motion-canvas',
    description:
      'A title followed by 1-4 numbered points revealed one by one; long points wrap. Good for steps or lists. 2-20 s.',
    props: animatedExplainerProps,
    minSeconds: 2,
    maxSeconds: 20,
    themeTokens: COMMON_TOKENS,
  },
  'html-title': {
    engine: 'html',
    description:
      'Headline card built from HTML/CSS with an optional kicker and subline, animated with CSS keyframes. 1-12 s.',
    props: htmlTitleProps,
    minSeconds: 1,
    maxSeconds: 12,
    themeTokens: [...COMMON_TOKENS, 'colors.surface', 'motionSpeed'],
  },
  'hyperframes-title': {
    engine: 'hyperframes',
    description:
      'Headline and subline as a HyperFrames composition (GSAP timeline), rendered locally by the HyperFrames renderer. 1-12 s.',
    props: hyperframesTitleProps,
    minSeconds: 1,
    maxSeconds: 12,
    themeTokens: COMMON_TOKENS,
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

/** Duration limits for scenes that bring their own HTML source. */
export const SOURCE_SCENE_SECONDS = { min: 0.5, max: 60 } as const;

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
