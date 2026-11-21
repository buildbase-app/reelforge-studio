import { z } from 'zod';

/**
 * The template catalog: every scene names an engine and a template, and the
 * template decides which props are valid. A plan that names a template the
 * engine does not have is rejected; it is never silently mapped to another
 * engine or template (TEST_PLAN §1, Planner).
 */

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour such as #ff3366');

export const kineticTitleProps = z
  .object({
    headline: z.string().min(1).max(60),
    subline: z.string().max(80).optional(),
    accent: hexColor.optional(),
    background: hexColor.optional(),
  })
  .strict();

export const animatedExplainerProps = z
  .object({
    title: z.string().min(1).max(40),
    points: z.array(z.string().min(1).max(40)).min(1).max(4),
    accent: hexColor.optional(),
    background: hexColor.optional(),
  })
  .strict();

export const ENGINES = ['remotion', 'motion-canvas'] as const;
export type EngineId = (typeof ENGINES)[number];

export interface TemplateDefinition {
  engine: EngineId;
  description: string;
  props: z.ZodType;
  /** Shortest and longest duration the template is designed for, in seconds. */
  minSeconds: number;
  maxSeconds: number;
}

export const TEMPLATES = {
  'kinetic-title': {
    engine: 'remotion',
    description: 'Bold animated headline with an optional subline. Good as a hook.',
    props: kineticTitleProps,
    minSeconds: 1.5,
    maxSeconds: 8,
  },
  'animated-explainer': {
    engine: 'motion-canvas',
    description: 'A title followed by up to four points revealed one by one.',
    props: animatedExplainerProps,
    minSeconds: 2,
    maxSeconds: 20,
  },
} as const satisfies Record<string, TemplateDefinition>;

export type TemplateId = keyof typeof TEMPLATES;
export type KineticTitleProps = z.infer<typeof kineticTitleProps>;
export type AnimatedExplainerProps = z.infer<typeof animatedExplainerProps>;

export function templatesForEngine(engine: EngineId): TemplateId[] {
  return (Object.keys(TEMPLATES) as TemplateId[]).filter(
    (id) => TEMPLATES[id].engine === engine
  );
}
