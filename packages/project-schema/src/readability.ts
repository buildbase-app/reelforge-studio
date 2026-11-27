import { frameLayout } from './layout';
import { builtinTheme, mergeTokens, type ThemeTokens } from './themes';
import type { ValidationWarning } from './index';
import type { Project } from './project';

/**
 * Readability checks before a render (validate_project warnings): text the built-in templates would set too small to
 * read at the output size, and text that does not stand out from a pane or lower-third colour.
 */
export const READABILITY = {
  /** Smallest body text, px, that built-in templates should set (Studio default: below it words blur on a phone). */
  minBodyPx: 12,
  /** WCAG 2.2 SC 1.4.3: normal text against its background. */
  contrastNormal: 4.5,
  /** WCAG 2.2 SC 1.4.3: large text (18 pt, or 14 pt bold): the templates' headlines. */
  contrastLarge: 3,
} as const;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** WCAG 2.2 relative luminance of an sRGB hex colour (#rgb or #rrggbb); null for anything else. */
export function relativeLuminance(hex: string): number | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2 contrast ratio (1 to 21) of two hex colours; null when either is not a hex colour. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The project's theme tokens when they can be resolved here (a built-in theme, plus inline tokens); else null. */
function themeTokens(p: Project): ThemeTokens | null {
  if (typeof p.theme === 'string') return builtinTheme(p.theme)?.tokens ?? null;
  const base = builtinTheme(p.theme.base)?.tokens;
  return base ? mergeTokens(base, p.theme.tokens) : null;
}

type PaneProps = { panes?: Array<{ color?: string; headline?: string; body?: string }>; lowerThird?: { name?: string; title?: string; background?: string; text?: string } };

export function readabilityWarnings(p: Project): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  // Text size: only built-in templates set their own text size; an html scene's author sets theirs.
  if (p.scenes.some((s) => s.template)) {
    const sizes = [
      { path: 'output', width: p.output.width, height: p.output.height, platform: p.brief?.platform },
      ...(p.variants ?? []).map((v, i) => ({ path: `variants.${i}`, width: v.width, height: v.height, platform: v.platform ?? p.brief?.platform })),
    ];
    for (const s of sizes) {
      const t = frameLayout(s.width, s.height, s.platform).type;
      if (t.body < READABILITY.minBodyPx) {
        warnings.push({
          path: s.path,
          message: `at ${s.width}x${s.height} the built-in templates set body text at ${t.body.toFixed(1)} px and labels at ${t.label.toFixed(1)} px, under ${READABILITY.minBodyPx} px: too small to read. Use a larger frame, keep this size for an image with few or no words, or set the text size yourself in an html scene`,
        });
      }
    }
  }
  // Contrast: text over a colour the manifest chose.
  const tokens = themeTokens(p);
  if (!tokens) return warnings;
  const { text, mutedText } = tokens.colors;
  const low = (fg: string, bg: string, min: number) => {
    const r = contrastRatio(fg, bg);
    return r !== null && r < min ? r : null;
  };
  p.scenes.forEach((scene, i) => {
    const props = (scene.props ?? {}) as PaneProps;
    props.panes?.forEach((pane, j) => {
      if (!pane.color) return;
      const where = `pane ${j + 1} of scene "${scene.id}"`;
      const head = pane.headline ? low(text, pane.color, READABILITY.contrastLarge) : null;
      if (head !== null) {
        warnings.push({ path: `scenes.${i}.props.panes.${j}.color`, message: `${where}: its colour ${pane.color} and the headline colour ${text} contrast ${head.toFixed(2)}:1, under ${READABILITY.contrastLarge}:1 for large text (WCAG 2.2 SC 1.4.3), so the headline is hard to read. Pick a pane colour further from ${text}, or change the theme's text colour` });
      }
      const body = pane.body ? low(mutedText, pane.color, READABILITY.contrastNormal) : null;
      if (body !== null) {
        warnings.push({ path: `scenes.${i}.props.panes.${j}.color`, message: `${where}: its colour ${pane.color} and the body text colour ${mutedText} contrast ${body.toFixed(2)}:1, under ${READABILITY.contrastNormal}:1 (WCAG 2.2 SC 1.4.3). Pick a pane colour further from ${mutedText}, or change the theme's mutedText colour` });
      }
    });
    const lt = props.lowerThird;
    if (lt?.name) {
      const bg = lt.background ?? tokens.colors.surface;
      const fg = lt.text ?? text;
      const r = low(fg, bg, READABILITY.contrastNormal);
      if (r !== null) {
        warnings.push({ path: `scenes.${i}.props.lowerThird`, message: `the lower third of scene "${scene.id}": text ${fg} on ${bg} contrasts ${r.toFixed(2)}:1, under ${READABILITY.contrastNormal}:1 (WCAG 2.2 SC 1.4.3). Set lowerThird.text or lowerThird.background further apart` });
      }
    }
  });
  return warnings;
}
