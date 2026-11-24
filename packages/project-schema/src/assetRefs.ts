import { z } from 'zod';
import { slugId } from './common';
import { FIT_MODES } from './media';

/**
 * How scenes use the project's assets (#299).
 *
 * Templates take media as props (`media`: a background image or video with a
 * fit mode; `logo`: an image in a corner), always by the id of an entry in
 * the manifest's `assets`. Scenes with their own html/css (html, hyperframes)
 * write `asset:<id>` where a URL goes (`<img src="asset:logo">`,
 * `<video src="asset:clip">`, `url(asset:hero)`); the renderer replaces it
 * with a URL on the render's own local origin. Ids that are not in the
 * manifest, raw store ids (`asset://ast-...`) and paths are refused, so a
 * scene can only reach the files its own project lists.
 */

export const mediaRef = z
  .object({
    asset: slugId.describe("Id of an image or video in the manifest's assets"),
    fit: z.enum(FIT_MODES).default('cover').describe('contain: letterbox; cover: fill and crop; blur-fill: letterbox over a blurred, cropped copy of the same media'),
    focus: z
      .object({ x: z.number().min(0).max(100).default(50), y: z.number().min(0).max(100).default(50) })
      .strict()
      .optional()
      .describe('Point kept in view when cropping, in percent of the media (default the centre)'),
    /** Video only: seconds into the clip shown at the scene's first frame. */
    start: z.number().min(0).max(3600).optional().describe('Video only: the in-point, seconds into the clip shown at the first frame of the scene'),
    /** Darken the media under the text: 0 (none) to 0.9. */
    dim: z.number().min(0).max(0.9).default(0.45).describe('How much the background colour covers the media so text stays readable: 0 (none) to 0.9'),
  })
  .strict();

export const logoRef = z
  .object({
    asset: slugId.describe("Id of an image in the manifest's assets (PNG, JPEG, WebP, GIF or SVG)"),
    corner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('top-right'),
    /** Width of the logo's box in layout units (1 % of the shorter side). */
    size: z.number().min(4).max(40).default(14),
  })
  .strict();

export type MediaRef = z.infer<typeof mediaRef>;
export type LogoRef = z.infer<typeof logoRef>;

export type AssetMediaType = 'audio' | 'image' | 'video' | 'font';

/** One asset a template's props place, for validation and for the renderer. */
export interface PropAssetRef {
  path: (string | number)[];
  asset: string;
  /** Media types allowed there. Default: image or video. */
  mediaTypes?: readonly AssetMediaType[];
  /** Video in-point in seconds (mediaRef.start). */
  start?: number;
}

/** The media props every built-in template has: `media` (image or video) and `logo` (image). */
export const templateMediaProps = { media: mediaRef.optional(), logo: logoRef.optional() };

/** Asset references in the `media` and `logo` props of a built-in template (already parsed or raw). */
export function builtinMediaRefs(props: unknown): PropAssetRef[] {
  const p = (props ?? {}) as { media?: { asset?: unknown; start?: unknown }; logo?: { asset?: unknown } };
  const out: PropAssetRef[] = [];
  if (p.media && typeof p.media.asset === 'string') {
    out.push({ path: ['media', 'asset'], asset: p.media.asset, mediaTypes: ['image', 'video'], ...(typeof p.media.start === 'number' ? { start: p.media.start } : {}) });
  }
  if (p.logo && typeof p.logo.asset === 'string') out.push({ path: ['logo', 'asset'], asset: p.logo.asset, mediaTypes: ['image'] });
  return out;
}

/** One `asset:` reference in scene html or css. */
export interface MarkupAssetRef {
  asset: string;
  /** Where it was found, for messages. */
  where: 'html' | 'css';
}

/**
 * `asset:<id>` where a URL can start: after a quote, `(`, `=`, `,`, or
 * whitespace (srcset), and ending where a URL ends. The id is a manifest
 * asset id.
 */
const MARKUP_REF = /(^|["'(=,\s])asset:([a-z0-9][a-z0-9-]{0,62})(?=$|["'),\s])/g;
/** Every `asset:` at a URL start, whatever follows. */
const MARKUP_ANY = /(^|["'(=,\s])asset:([^"'),\s]{0,80})/g;
const GOOD_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Every `asset:<id>` in html/css, and the malformed ones (store ids such as `asset://ast-...`, paths, query strings). */
export function assetRefsInMarkup(html: string | undefined, css: string | undefined): { refs: MarkupAssetRef[]; bad: string[] } {
  const refs: MarkupAssetRef[] = [];
  const bad: string[] = [];
  for (const [where, text] of [['html', html], ['css', css]] as const) {
    if (!text) continue;
    for (const m of text.matchAll(MARKUP_ANY)) {
      const id = m[2] ?? '';
      if (GOOD_ID.test(id)) refs.push({ asset: id, where });
      else if (id) bad.push(`asset:${id}`.slice(0, 60)); // "asset:" followed by a space is prose, not a reference
    }
  }
  return { refs, bad };
}

/**
 * Replace every `asset:<id>` in html/css with `url(id)`. The caller has
 * checked the ids (unknown ones are left as they are and fail to load).
 */
export function rewriteAssetRefs(text: string, url: (id: string) => string | undefined): string {
  return text.replace(MARKUP_REF, (all, lead: string, id: string) => {
    const u = url(id);
    return u === undefined ? all : `${lead}${u}`;
  });
}
