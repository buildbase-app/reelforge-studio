import { SUPPORTED_FPS, fpsArg, fpsLabel, withVariant, type FrameRate, type Project } from '@renderweld/project-schema';
import type { PluginRegistry } from './registry';

/**
 * Output sizes and frame rates each engine can render, checked before a
 * render or preview is queued (#287, #302). Every engine writes H.264 with
 * 4:2:0 chroma (yuv420p), so the codec's rules apply to all of them; an
 * engine adds its own through `EngineCapabilities.output`.
 */

/**
 * H.264 level 6.2, the highest level (ITU-T H.264 Table A-1): at most 139,264
 * macroblocks (16x16 pixels) per frame; a frame side may not exceed
 * sqrt(8 x MaxFS) macroblocks (A.3.1), 1,055 MBs = 16,880 px. (Its 16,711,680
 * macroblocks a second cannot be reached at 60 fps or less within that frame size.)
 */
export const H264_LEVEL_6_2 = { maxFrameMacroblocks: 139_264, maxSideMacroblocks: 1_055 } as const;

/** What an engine renders beyond the codec rules (EngineCapabilities.output). */
export interface EngineOutputSupport {
  /** Frame rates it renders. Omitted: every rate in SUPPORTED_FPS. */
  frameRates?: readonly FrameRate[];
  /** Longest side in pixels. */
  maxDimension?: number;
  /** Largest frame in pixels (width x height). */
  maxPixels?: number;
  /** Renders a transparent background when EngineRenderContext.alpha is set (#302). */
  alpha?: boolean;
}

/** Why an H.264 yuv420p encoder cannot write this size and rate. Empty when it can. */
export function h264OutputProblems(width: number, height: number): string[] {
  const out: string[] = [];
  if (width % 2 || height % 2) out.push(`${width}x${height} has an odd side; H.264 with 4:2:0 chroma (yuv420p) needs an even width and height`);
  const mbW = Math.ceil(width / 16);
  const mbH = Math.ceil(height / 16);
  const l = H264_LEVEL_6_2;
  if (mbW * mbH > l.maxFrameMacroblocks) out.push(`${width}x${height} is ${mbW * mbH} macroblocks a frame; H.264 allows at most ${l.maxFrameMacroblocks} (level 6.2, about 35.6 megapixels)`);
  if (Math.max(mbW, mbH) > l.maxSideMacroblocks) out.push(`a side of ${Math.max(width, height)} px is longer than H.264 allows (${l.maxSideMacroblocks * 16} px at level 6.2)`);
  return out;
}

export interface OutputSupportIssue {
  /** Manifest path: `output`, or `variants.<i>` for a variant. */
  path: string;
  engine: string | null;
  variant: string | null;
  message: string;
}

/**
 * Every reason the project (and each of its variants) cannot be rendered at
 * its size and rate by the engines its scenes use. `variant` restricts the
 * check to one variant (or `output` when null); omitted: output and every
 * variant. Engines that are not installed are skipped (the schema reports them).
 */
export function outputSupportIssues(project: Project, registry: PluginRegistry, opts: { variant?: string | null } = {}): OutputSupportIssue[] {
  const targets: Array<{ path: string; variant: string | null; p: Project }> = [];
  if (opts.variant === undefined || opts.variant === null) targets.push({ path: 'output', variant: null, p: project });
  project.variants?.forEach((v, i) => {
    if (opts.variant === undefined || opts.variant === v.id) targets.push({ path: `variants.${i}`, variant: v.id, p: withVariant(project, v.id) });
  });
  const engines = [...new Set(project.scenes.map((s) => s.engine))];
  const out: OutputSupportIssue[] = [];
  for (const t of targets) {
    const { width, height, fps } = t.p.output;
    const where = t.variant ? `variant "${t.variant}" (${width}x${height})` : `output ${width}x${height}`;
    for (const message of h264OutputProblems(width, height)) out.push({ path: t.path, engine: null, variant: t.variant, message: `${where}: ${message}` });
    for (const id of engines) {
      let support: EngineOutputSupport | undefined;
      try {
        support = registry.engine(id).capabilities?.().output;
      } catch {
        continue;
      }
      if (!support) continue;
      const add = (message: string) => out.push({ path: t.path, engine: id, variant: t.variant, message: `${where}: engine "${id}" ${message}` });
      if (support.frameRates && !support.frameRates.includes(fps)) {
        add(`does not render ${fpsLabel(fps)} fps (${fpsArg(fps)}); it renders ${support.frameRates.map((r) => fpsLabel(r)).join(', ')}`);
      }
      if (support.maxDimension && Math.max(width, height) > support.maxDimension) add(`renders at most ${support.maxDimension} px on a side`);
      if (support.maxPixels && width * height > support.maxPixels) add(`renders at most ${support.maxPixels} pixels a frame`);
    }
  }
  return out;
}

/** The frame rates every installed engine renders (for get_capabilities). */
export function frameRatesFor(registry: PluginRegistry, engineId: string): readonly FrameRate[] {
  try {
    return registry.engine(engineId).capabilities?.().output?.frameRates ?? SUPPORTED_FPS;
  } catch {
    return [];
  }
}
