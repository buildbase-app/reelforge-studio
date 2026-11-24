import { z } from 'zod';
import { hexColor } from './common';

/**
 * Brand themes: named sets of design tokens that templates read. A project
 * names a theme (`"theme": "midnight"`) or brings inline tokens on top of a
 * base theme. Scene props such as `accent` still override a theme per scene.
 */

/**
 * A CSS font-family list. Restricted characters so a token can be placed into
 * CSS, SVG or canvas code without escaping problems.
 */
export const fontFamily = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9 ,"'\-_.]+$/,
    'must be a CSS font-family list using letters, digits, spaces, commas, quotes, dashes and dots'
  );

export const themeColors = z
  .object({
    background: hexColor,
    surface: hexColor,
    text: hexColor,
    mutedText: hexColor,
    accent: hexColor,
    accent2: hexColor,
  })
  .strict();

/**
 * A caption colour that can be switched off: null or "none". "none" exists
 * because a JSON merge patch (update_project) cannot set a key to null (null
 * deletes the key, so the default comes back); both mean the same.
 */
export const captionColorOrNone = z.union([hexColor, z.literal('none')]).nullable();

/** "none" -> null, so renderers only see a colour or null. */
export function captionColor<T extends string | null | undefined>(c: T): T | null {
  return c === 'none' ? null : c;
}

export const captionStyle = z
  .object({
    /** Inside the safe area: bottom (default), top or centre (docs/CAPTIONS.md#style). */
    position: z.enum(['top', 'center', 'bottom']).default('bottom'),
    /** Font size as a fraction of the shorter side of the video (min(width, height)). */
    fontScale: z.number().min(0.02).max(0.12).default(0.05),
    color: hexColor.default('#ffffff'),
    /** Box behind each line; null or "none" for no box (text with an outline instead). */
    background: captionColorOrNone.default('#000000'),
    /** Opacity of the box, 0..1. Default 0.8. */
    backgroundOpacity: z.number().min(0).max(1).optional(),
    /** Caption font. Default: the theme's fontFamily (its first family is used). */
    fontFamily: fontFamily.optional(),
    /** Default 700. */
    weight: z.number().int().min(100).max(900).optional(),
    /** Outline colour when there is no box. Default: #000000; null or "none" for none. */
    outline: captionColorOrNone.optional(),
    /** Colour of the word being spoken (word highlight). Default: the theme's accent. */
    highlightColor: hexColor.optional(),
  })
  .strict();

export const themeTokens = z
  .object({
    colors: themeColors,
    fontFamily,
    headingWeight: z.number().int().min(100).max(900).default(800),
    /** Corner radius scale, 0 (square) .. 2 (very round). */
    radius: z.number().min(0).max(2).default(1),
    /** Spacing scale, 0.5 (tight) .. 2 (airy). */
    spacing: z.number().min(0.5).max(2).default(1),
    /** Animation speed multiplier: 2 = twice as fast. Templates that list `motionSpeed` honour it. */
    motionSpeed: z.number().min(0.25).max(4).default(1),
    captionStyle: captionStyle.default({ position: 'bottom', fontScale: 0.05, color: '#ffffff', background: '#000000' }),
  })
  .strict();

export type ThemeTokens = z.infer<typeof themeTokens>;
export type ThemeTokensInput = z.input<typeof themeTokens>;

/** Partial tokens used for inline project overrides and theme updates. */
export const themeTokensPatch = z
  .object({
    colors: themeColors.partial().optional(),
    fontFamily: fontFamily.optional(),
    headingWeight: z.number().int().min(100).max(900).optional(),
    radius: z.number().min(0).max(2).optional(),
    spacing: z.number().min(0.5).max(2).optional(),
    motionSpeed: z.number().min(0.25).max(4).optional(),
    captionStyle: captionStyle.partial().optional(),
  })
  .strict();

export type ThemeTokensPatch = z.infer<typeof themeTokensPatch>;

export const themeId = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    'must be lowercase letters, digits and dashes, starting with a letter or digit (max 63)'
  );

export const theme = z
  .object({
    id: themeId,
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    tokens: themeTokens,
  })
  .strict();

export type Theme = z.infer<typeof theme>;
export type ThemeInput = z.input<typeof theme>;

const SYSTEM_SANS = 'Inter, "Helvetica Neue", Arial, sans-serif';

export const BUILTIN_THEMES: readonly Theme[] = [
  theme.parse({
    id: 'default',
    name: 'Default',
    description: 'Near-black background, pink accent, white text. The look of the sample reel.',
    tokens: {
      colors: {
        background: '#0b0b14',
        surface: '#1a1a2b',
        text: '#ffffff',
        mutedText: '#c9c9d6',
        accent: '#ff3d71',
        accent2: '#00d1b2',
      },
      fontFamily: SYSTEM_SANS,
    },
  }),
  theme.parse({
    id: 'midnight',
    name: 'Midnight',
    description: 'Deep navy background, periwinkle accent, teal secondary accent.',
    tokens: {
      colors: {
        background: '#070b24',
        surface: '#141b45',
        text: '#f4f6ff',
        mutedText: '#aab3e0',
        accent: '#7c9cff',
        accent2: '#2ee6c5',
      },
      fontFamily: '"Avenir Next", "Segoe UI", Roboto, Arial, sans-serif',
      headingWeight: 700,
      motionSpeed: 0.9,
    },
  }),
];

export function builtinTheme(id: string): Theme | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}

/** Apply a partial token patch on top of full tokens. */
export function mergeTokens(base: ThemeTokens, patch: ThemeTokensPatch | undefined): ThemeTokens {
  if (!patch) return base;
  return themeTokens.parse({
    ...base,
    ...stripUndefined(patch),
    colors: { ...base.colors, ...stripUndefined(patch.colors ?? {}) },
    captionStyle: { ...base.captionStyle, ...stripUndefined(patch.captionStyle ?? {}) },
  });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
