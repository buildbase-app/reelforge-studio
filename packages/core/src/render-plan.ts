import { createHash } from 'node:crypto';

/**
 * Render plan (#485): what a render will cost before it is queued, measured from this install's own recent renders,
 * never guessed. Rates are per megapixel-frame (width x height x frames / 1e6), so a sample of vertical 1080p
 * renders also estimates a square or 4K one; a sample with no render of an engine says so instead of inventing a
 * number for it.
 */

/** One finished render, as read from its manifest and storage. */
export interface RenderSample {
  width: number;
  height: number;
  /** Frames of the finished video. */
  frames: number;
  /** Seconds of the finished video. */
  seconds: number;
  /** From the job starting to the file being stored. */
  wallClockMillis: number;
  /** Bytes of the output file, when known. */
  outputBytes?: number;
  scenes: Array<{ engine: string; frames: number; millis: number }>;
}

export interface RenderRates {
  /** Renders the rates come from. */
  renders: number;
  /** Median milliseconds per megapixel-frame of scene rendering, per engine. */
  msPerMegapixelFrame: Record<string, number>;
  /** Median whole-render time over the time spent in scene rendering (assembly, encode, checks). At least 1. */
  overhead: number | null;
  /** Median bytes of output per megapixel-second of video. */
  bytesPerMegapixelSecond: number | null;
}

/** One output the plan covers: the project's own, or a variant's. */
export interface PlanOutput {
  variant: string | null;
  width: number;
  height: number;
  fps: number | string;
  frames: number;
  seconds: number;
  format: string;
  scenes: Array<{ engine: string; frames: number }>;
}

export interface OutputEstimate {
  /** Seconds from start to stored file for this output alone, or null when the sample has no basis. */
  renderSeconds: number | null;
  bytes: number | null;
  /** `measured`: every engine has a rate; `partial`: an engine without one used the median of the others; `none`: no sample. */
  basis: 'measured' | 'partial' | 'none';
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mpx = (w: number, h: number) => (w * h) / 1e6;

/** Rates from finished renders; samples with missing or zero numbers are left out. */
export function renderRates(samples: RenderSample[]): RenderRates {
  const perEngine = new Map<string, number[]>();
  const overheads: number[] = [];
  const bytes: number[] = [];
  let used = 0;
  for (const s of samples) {
    const px = mpx(s.width, s.height);
    if (!(px > 0) || !(s.wallClockMillis > 0) || !s.scenes.length) continue;
    used++;
    let sceneMs = 0;
    for (const sc of s.scenes) {
      if (!(sc.frames > 0) || !(sc.millis >= 0)) continue;
      sceneMs += sc.millis;
      perEngine.set(sc.engine, [...(perEngine.get(sc.engine) ?? []), sc.millis / (px * sc.frames)]);
    }
    if (sceneMs > 0) overheads.push(Math.max(1, s.wallClockMillis / sceneMs));
    if (s.outputBytes && s.outputBytes > 0 && s.seconds > 0) bytes.push(s.outputBytes / (px * s.seconds));
  }
  return {
    renders: used,
    msPerMegapixelFrame: Object.fromEntries([...perEngine].map(([e, xs]) => [e, median(xs)!])),
    overhead: median(overheads),
    bytesPerMegapixelSecond: median(bytes),
  };
}

/** The estimate for one output from the rates. */
export function estimateOutput(out: PlanOutput, rates: RenderRates): OutputEstimate {
  const known = Object.values(rates.msPerMegapixelFrame);
  if (!rates.renders || !known.length || rates.overhead === null) {
    return { renderSeconds: null, bytes: null, basis: 'none' };
  }
  const fallback = median(known)!;
  const px = mpx(out.width, out.height);
  let partial = false;
  let sceneMs = 0;
  for (const sc of out.scenes) {
    const rate = rates.msPerMegapixelFrame[sc.engine];
    if (rate === undefined) partial = true;
    sceneMs += (rate ?? fallback) * px * sc.frames;
  }
  const seconds = Math.round((sceneMs * rates.overhead) / 100) / 10;
  const bytes = rates.bytesPerMegapixelSecond === null ? null : Math.round(rates.bytesPerMegapixelSecond * px * out.seconds);
  return { renderSeconds: seconds, bytes, basis: partial ? 'partial' : 'measured' };
}

/** A stable id for the plan: the project version and the options it was made for. */
export function planId(projectId: string, version: number, options: Record<string, unknown>): string {
  const keys = Object.keys(options).sort();
  const canonical = JSON.stringify([projectId, version, keys.map((k) => [k, options[k] ?? null])]);
  return `plan_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}
