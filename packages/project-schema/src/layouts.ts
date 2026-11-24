import { z } from 'zod';
import { hexColor, slugId } from './common';
import { FIT_MODES, LAYOUT_DEFAULTS, type LayoutSpec } from './layout';

/**
 * Manifest props of the layout templates (#287): `html-layout`,
 * `hyperframes-layout`, `remotion-layout` and `motion-canvas-layout` share
 * them, so a scene moves between engines by changing only its engine and
 * template. A scene is a layout
 * (full frame, split screen, picture-in-picture or grid) of panes, each with
 * media (an image or video asset placed with a fit mode), a colour and
 * optional text, plus an optional lower third. Sizes are in layout units
 * (1 % of the shorter side) and positions follow the safe areas, so the
 * scene reflows for every output size and variant (geometry: layout.ts).
 */

export const fitMode = z.enum(FIT_MODES).describe('contain: letterbox; cover: fill and crop; blur-fill: letterbox over a blurred, cropped copy of the same media');

const inset = z
  .enum(['none', 'action', 'title', 'content'])
  .describe('Safe area the panes stay inside; none (default) fills the whole frame, edge to edge');

/** An aspect ratio as a number (1.7778) or "W:H" ("16:9"). */
export const aspectRatio = z.union([
  z.number().min(0.2).max(5),
  z
    .string()
    .regex(/^\d{1,4}(\.\d{1,3})?:\d{1,4}(\.\d{1,3})?$/, 'must be a number or "W:H" such as "16:9"')
    .refine((s) => {
      const [w, h] = s.split(':').map(Number);
      return w! > 0 && h! > 0 && w! / h! >= 0.2 && w! / h! <= 5;
    }, 'must be between 1:5 and 5:1'),
]);

export function aspectValue(a: number | string): number {
  if (typeof a === 'number') return a;
  const [w, h] = a.split(':').map(Number);
  return w! / h!;
}

const units = (max: number) => z.number().min(0).max(max);

export const layoutSpecSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('full'), inset: inset.optional() }).strict(),
  z
    .object({
      type: z.literal('split'),
      direction: z
        .enum(['auto', 'horizontal', 'vertical'])
        .optional()
        .describe('horizontal: panes side by side; vertical: stacked; auto (default): side by side on 4:3 and wider frames, stacked on square and tall ones'),
      ratios: z.array(z.number().positive().max(100)).min(2).max(LAYOUT_DEFAULTS.maxSplitPanes).optional().describe('Relative pane sizes, one per pane, e.g. [2, 1]'),
      gap: units(20).optional().describe(`Gap between panes in units (default ${LAYOUT_DEFAULTS.splitGap})`),
      inset: inset.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('grid'),
      columns: z.number().int().min(1).max(LAYOUT_DEFAULTS.maxGridSide).optional().describe('Omit columns and rows to pick them per frame (cells closest to square)'),
      rows: z.number().int().min(1).max(LAYOUT_DEFAULTS.maxGridSide).optional(),
      gap: units(20).optional().describe(`Gap between cells in units (default ${LAYOUT_DEFAULTS.gridGap})`),
      inset: inset.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('pip'),
      corner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional().describe('Corner of the inset (default bottom-right)'),
      width: z.number().min(10).max(100).optional().describe(`Inset width in units (default ${LAYOUT_DEFAULTS.pipWidth}); kept inside the safe area`),
      aspect: aspectRatio.optional().describe('Inset aspect ratio (default: the frame\'s)'),
      margin: units(20).optional().describe(`Distance from the safe area's edge in units (default ${LAYOUT_DEFAULTS.pipMargin})`),
      inset: inset.optional().describe('Safe area the inset is placed in (default content: title safe plus the app-overlay zone on tall frames)'),
    })
    .strict(),
]);

export type LayoutSpecInput = z.infer<typeof layoutSpecSchema>;

/** The geometry spec (layout.ts) of a parsed layout. */
export function toLayoutSpec(s: LayoutSpecInput): LayoutSpec {
  if (s.type === 'pip') {
    const { aspect, ...rest } = s;
    return { ...rest, ...(aspect !== undefined ? { aspect: aspectValue(aspect) } : {}) };
  }
  return s;
}

export const paneMedia = z
  .object({
    asset: slugId.describe('Id of an image or video asset in the manifest\'s assets'),
    fit: fitMode.default('cover'),
    focus: z
      .object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) })
      .strict()
      .optional()
      .describe('Point kept in view when cropping, in percent of the media (default 50, 50: the centre)'),
    startSeconds: z.number().min(0).max(86_400).default(0).describe('Video only: where in the video the scene starts. A video shorter than the scene holds its last frame'),
    blur: units(20).optional().describe(`blur-fill only: blur radius in units (default ${LAYOUT_DEFAULTS.blur})`),
  })
  .strict();

export const layoutPane = z
  .object({
    media: paneMedia.optional(),
    color: hexColor.optional().describe('Pane colour (behind contain media, or the whole pane without media). Default: the theme surface'),
    label: z.string().min(1).max(40).optional().describe('Short label in the pane\'s top corner'),
    headline: z.string().min(1).max(80).optional(),
    body: z.string().min(1).max(160).optional(),
  })
  .strict();

export const lowerThird = z
  .object({
    name: z.string().min(1).max(60),
    title: z.string().min(1).max(80).optional(),
    align: z.enum(['left', 'right']).default('left'),
    /** Brand colours; default: theme accent, surface and text. */
    accent: hexColor.optional(),
    background: hexColor.optional(),
    text: hexColor.optional(),
  })
  .strict();

export const layoutSceneProps = z
  .object({
    layout: layoutSpecSchema,
    panes: z.array(layoutPane).min(1).max(LAYOUT_DEFAULTS.maxPanes),
    lowerThird: lowerThird.optional(),
    /** Frame colour behind the panes and in the gaps (default: the theme background). */
    background: hexColor.optional(),
    accent: hexColor.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const n = p.panes.length;
    const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const l = p.layout;
    if (l.type === 'full' && n !== 1) add(['panes'], `a full layout has exactly 1 pane, got ${n}`);
    if (l.type === 'pip' && n !== 2) add(['panes'], `picture-in-picture has exactly 2 panes (the main picture, then the inset), got ${n}`);
    if (l.type === 'split') {
      if (n < 2 || n > LAYOUT_DEFAULTS.maxSplitPanes) add(['panes'], `a split has 2 to ${LAYOUT_DEFAULTS.maxSplitPanes} panes, got ${n}`);
      if (l.ratios && l.ratios.length !== n) add(['layout', 'ratios'], `give one ratio per pane: ${n} panes, ${l.ratios.length} ratios`);
    }
    if (l.type === 'grid' && l.columns !== undefined && l.rows !== undefined && l.columns * l.rows < n) {
      add(['layout'], `a ${l.columns}x${l.rows} grid holds ${l.columns * l.rows} panes, got ${n}`);
    }
    if (l.type === 'grid' && (l.columns !== undefined) !== (l.rows !== undefined)) {
      const given = l.columns ?? l.rows!;
      if (Math.ceil(n / given) > LAYOUT_DEFAULTS.maxGridSide) add(['layout'], `${n} panes need more than ${LAYOUT_DEFAULTS.maxGridSide} ${l.columns ? 'rows' : 'columns'}`);
    }
    p.panes.forEach((pane, i) => {
      if (pane.media?.blur !== undefined && pane.media.fit !== 'blur-fill') add(['panes', i, 'media', 'blur'], 'blur applies to fit "blur-fill" only');
    });
  });

export type LayoutSceneProps = z.infer<typeof layoutSceneProps>;
export type LayoutPane = z.infer<typeof layoutPane>;
export type LowerThird = z.infer<typeof lowerThird>;

/** Asset ids the panes use, with their manifest paths and in-points (the project schema checks they exist and are images or videos; renderers stage exactly these). */
export function layoutMediaRefs(props: unknown): Array<{ path: (string | number)[]; asset: string; mediaTypes: readonly ['image', 'video']; start?: number }> {
  const parsed = layoutSceneProps.safeParse(props);
  if (!parsed.success) return [];
  return parsed.data.panes.flatMap((p, i) =>
    p.media
      ? [{ path: ['panes', i, 'media', 'asset'], asset: p.media.asset, mediaTypes: ['image', 'video'] as const, ...(p.media.startSeconds ? { start: p.media.startSeconds } : {}) }]
      : []
  );
}
