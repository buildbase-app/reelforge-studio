/**
 * Photosensitive flash analysis (WCAG 2.2 SC 2.3.1, three flashes or below threshold; ITU-R BT.1702-3 and Ofcom
 * use the same numbers for SDR), modelled on EA IRIS (github.com/electronicarts/IRIS), on a coarse grid of each
 * frame. A frame is given as GRID x GRID cells of 8-bit sRGB (an area-averaged downscale), so each cell is 1/64 of
 * the picture.
 *
 * - Relative luminance per cell: L = 0.2126 R + 0.7152 G + 0.0722 B on linearised sRGB (WCAG 2.2 definition).
 * - A transition is a change of at least 0.1 in L, the darker side below 0.80, and opposite to the cell's previous
 *   transition (a flash is a pair of opposing transitions).
 * - Saturated red (R / (R + G + B) >= 0.8): a red transition is a change of more than 20 in (R - G - B) x 320,
 *   WCAG 2.0's working definition (Understanding SC 2.3.1, note 3). WCAG 2.1 and 2.2 replaced it with a CIE 1976
 *   u'v' change of more than 0.2, not measured yet.
 * - Area: a frame counts as a flash transition only when the cells that make the same transition on it cover at
 *   least a quarter of the picture (the 25 % of a 10-degree field rule, taken on the whole frame as analysers do for
 *   video). Small flashing elements pass.
 * - A failure is more than 6 transitions (more than three flashes) in any one-second window.
 */
export const FLASH_GRID = 8;

/** The thresholds above, fixed by the standard (sources and dates: docs/QA.md#picture). */
export const FLASH_RULES = {
  /** Smallest change in relative luminance that is a transition. */
  minLuminanceChange: 0.1,
  /** The darker side of a transition must be below this relative luminance. */
  darkerBelow: 0.8,
  /** A cell is saturated red when R / (R + G + B) is at least this. */
  redRatio: 0.8,
  /** (R - G - B) is scaled by this before the red change is measured. */
  redScale: 320,
  /** A red transition is a change of more than this in the scaled (R - G - B). */
  redChange: 20,
  /** Share of the picture the cells making the same transition must cover. */
  minArea: 0.25,
  /** Most transitions allowed in any one second (three flashes; a flash is two). */
  maxTransitionsPerSecond: 6,
} as const;

const CELLS = FLASH_GRID * FLASH_GRID;
const AREA_CELLS = Math.ceil(CELLS * FLASH_RULES.minArea);

export interface FlashWindow {
  startSeconds: number;
  endSeconds: number;
  /** The most transitions found in one second inside this stretch (a flash is two). */
  transitionsPerSecond: number;
  kind: 'general' | 'red';
}

const linear = (c8: number) => {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Per-cell transition detector: alternating changes of at least `step`, the darker side under `darkMax`. */
class Cell {
  private lo = Infinity;
  private hi = -Infinity;
  private last: 0 | 1 | -1 = 0;
  constructor(
    private readonly step: number,
    private readonly darkMax: number
  ) {}
  /** 1 for a rising transition completed at this value, -1 for a falling one, 0 for none. */
  push(v: number): 1 | -1 | 0 {
    this.lo = Math.min(this.lo, v);
    this.hi = Math.max(this.hi, v);
    if (this.last !== 1 && v - this.lo >= this.step && this.lo < this.darkMax) {
      this.last = 1;
      this.lo = this.hi = v;
      return 1;
    }
    if (this.last !== -1 && this.hi - v >= this.step && v < this.darkMax) {
      this.last = -1;
      this.lo = this.hi = v;
      return -1;
    }
    return 0;
  }
}

/** Frame indices at which a quarter or more of the picture made the same transition. */
function frameTransitions(series: Float64Array[], frames: number, step: number, darkMax: number): number[] {
  const cells = series.map(() => new Cell(step, darkMax));
  const out: number[] = [];
  for (let f = 0; f < frames; f++) {
    let up = 0;
    let down = 0;
    for (let c = 0; c < series.length; c++) {
      const t = cells[c]!.push(series[c]![f]!);
      if (t === 1) up++;
      else if (t === -1) down++;
    }
    if (up >= AREA_CELLS || down >= AREA_CELLS) out.push(f);
  }
  return out;
}

/** Stretches where some one-second window holds more than `max` transitions, merged. */
function windows(transitions: number[], fps: number, max: number, kind: FlashWindow['kind']): FlashWindow[] {
  const span = Math.round(fps); // frames in one second
  const out: FlashWindow[] = [];
  let j = 0;
  for (let i = 0; i < transitions.length; i++) {
    while (transitions[i]! - transitions[j]! >= span) j++;
    const count = i - j + 1;
    if (count <= max) continue;
    const start = transitions[j]! / fps;
    const end = (transitions[i]! + 1) / fps;
    const prev = out.at(-1);
    if (prev && start <= prev.endSeconds) {
      prev.endSeconds = Math.max(prev.endSeconds, end);
      prev.transitionsPerSecond = Math.max(prev.transitionsPerSecond, count);
    } else out.push({ startSeconds: start, endSeconds: end, transitionsPerSecond: count, kind });
  }
  return out.map((w) => ({ ...w, startSeconds: Math.round(w.startSeconds * 1000) / 1000, endSeconds: Math.round(w.endSeconds * 1000) / 1000 }));
}

/**
 * The stretches that break the general-flash or red-flash threshold, from raw rgb24 frames of FLASH_GRID x
 * FLASH_GRID cells each (as `scale=8:8:flags=area,format=rgb24` writes them).
 */
export function analyseFlashes(grid: Uint8Array, fps: number): FlashWindow[] {
  const frameBytes = CELLS * 3;
  const frames = Math.floor(grid.length / frameBytes);
  if (frames < 2) return [];
  const lum = Array.from({ length: CELLS }, () => new Float64Array(frames));
  const red = Array.from({ length: CELLS }, () => new Float64Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < CELLS; c++) {
      const o = f * frameBytes + c * 3;
      const r = linear(grid[o]!);
      const g = linear(grid[o + 1]!);
      const b = linear(grid[o + 2]!);
      lum[c]![f] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sum = r + g + b;
      red[c]![f] = sum > 0 && r / sum >= FLASH_RULES.redRatio ? Math.max(0, (r - g - b) * FLASH_RULES.redScale) : 0;
    }
  }
  return [
    ...windows(frameTransitions(lum, frames, FLASH_RULES.minLuminanceChange, FLASH_RULES.darkerBelow), fps, FLASH_RULES.maxTransitionsPerSecond, 'general'),
    // Red transitions: a change of more than 20 in (R - G - B) x 320, in either direction.
    ...windows(frameTransitions(red, frames, FLASH_RULES.redChange + 1e-6, Infinity), fps, FLASH_RULES.maxTransitionsPerSecond, 'red'),
  ].sort((a, b) => a.startSeconds - b.startSeconds);
}
