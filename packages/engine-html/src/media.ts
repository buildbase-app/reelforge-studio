import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedAsset } from '@renderweld/core';
import { PipelineError, extractVideoFrames } from '@renderweld/media-pipeline';
import { layoutSceneDom, layoutSceneProps, type LayoutDom, type OutputSettings } from '@renderweld/project-schema';

/**
 * Pictures for the html engine's layout scenes (#287). The page may load
 * nothing but data: URLs (page.ts CSP), so images are inlined, and a video
 * becomes one JPEG per output frame (extractVideoFrames) that the renderer
 * puts into the page before each screenshot: frame-exact, and no codec has to
 * exist in the browser.
 */

const IMAGE_TYPES: Array<[(b: Buffer) => boolean, string]> = [
  [(b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png'],
  [(b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, 'image/jpeg'],
  [(b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP', 'image/webp'],
  [(b) => b.subarray(0, 6).toString('latin1').startsWith('GIF8'), 'image/gif'],
  [(b) => looksLikeSvg(b.subarray(0, 2048).toString('utf8')), 'image/svg+xml'],
];

/**
 * An SVG document: optional XML declaration and comments, then `<svg`. A linear scan with indexOf, not a regex:
 * a pattern with a repeated lazy comment group can backtrack exponentially on `<!--` runs (CodeQL js/redos).
 */
export function looksLikeSvg(text: string): boolean {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  skipSpace();
  if (text.startsWith('<?xml', i)) {
    const end = text.indexOf('>', i);
    if (end < 0) return false;
    i = end + 1;
    skipSpace();
  }
  while (text.startsWith('<!--', i)) {
    const end = text.indexOf('-->', i + 4);
    if (end < 0) return false;
    i = end + 3;
    skipSpace();
  }
  if (text.slice(i, i + 4).toLowerCase() !== '<svg') return false;
  const next = text[i + 4];
  return next === '>' || (next !== undefined && /\s/.test(next));
}

/** The image's type from its first bytes (the stored content type is not trusted for a data: URL). */
export function sniffImageType(b: Buffer): string | null {
  for (const [test, type] of IMAGE_TYPES) if (test(b)) return type;
  return null;
}

export interface LayoutSource {
  dom: LayoutDom;
  /** Per video picture key, its frame files in order (the page shows frame k of each at output frame k). */
  videos: Map<string, string[]>;
}

/** HTML for an html-layout scene, with its pictures prepared. */
export async function layoutSource(opts: {
  props: unknown;
  output: OutputSettings;
  platform?: string;
  durationSeconds: number;
  frames: number;
  assets: ReadonlyMap<string, ResolvedAsset>;
  ffmpeg: string;
  /** Where the video frames go (one folder per video); the caller removes it. */
  framesDir: string;
  stage: string;
  signal?: AbortSignal;
}): Promise<LayoutSource> {
  const props = layoutSceneProps.parse(opts.props);
  const images = new Map<string, string>();
  const videos = new Map<string, string[]>();
  const firstFrame = new Map<string, string>();
  // One set of frames per asset and start offset, shared by the panes (and blur-fill layers) that show it.
  for (const pane of props.panes) {
    const m = pane.media;
    if (!m) continue;
    const a = opts.assets.get(m.asset);
    if (!a) throw new PipelineError(opts.stage, `asset "${m.asset}" is not available to the renderer`);
    if (a.mediaType === 'image') {
      if (images.has(a.id)) continue;
      const bytes = await readFile(a.file);
      const type = sniffImageType(bytes);
      if (!type) throw new PipelineError(opts.stage, `asset "${a.id}" is not a PNG, JPEG, WebP, GIF or SVG image`);
      images.set(a.id, `data:${type};base64,${bytes.toString('base64')}`);
    } else if (a.mediaType === 'video') {
      const key = `${a.id}@${m.startSeconds}`;
      if (videos.has(key)) continue;
      const files = await extractVideoFrames({
        ffmpeg: opts.ffmpeg,
        input: a.file,
        dir: join(opts.framesDir, String(videos.size)),
        fps: opts.output.fps,
        frames: opts.frames,
        startSeconds: m.startSeconds,
        maxSide: Math.max(opts.output.width, opts.output.height),
        signal: opts.signal,
      });
      videos.set(key, files);
      firstFrame.set(key, await frameDataUrl(files[0]!));
    } else {
      throw new PipelineError(opts.stage, `asset "${a.id}" is ${a.mediaType}; panes show images or videos`);
    }
  }
  const dom = layoutSceneDom({
    props,
    width: opts.output.width,
    height: opts.output.height,
    ...(opts.platform ? { platform: opts.platform } : {}),
    durationSeconds: opts.durationSeconds,
    picture: ({ media, className, style }) => {
      const a = opts.assets.get(media.asset)!;
      if (a.mediaType === 'image') return `<img class="${className}" style="${style}" alt="" src="${images.get(a.id)}">`;
      const key = `${a.id}@${media.startSeconds}`;
      return `<img class="${className}" style="${style}" alt="" data-rf-video="${key}" src="${firstFrame.get(key)}">`;
    },
  });
  return { dom, videos };
}

export async function frameDataUrl(file: string): Promise<string> {
  return `data:image/jpeg;base64,${(await readFile(file)).toString('base64')}`;
}
