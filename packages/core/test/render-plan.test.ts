import { describe, expect, it } from 'vitest';
import { estimateOutput, planId, renderRates, type PlanOutput, type RenderSample } from '../src/render-plan';

/** Render plan arithmetic (#485): rates from finished renders, applied to another size, engine mix and length. */
const vertical = (millisPerScene: number, extra: Partial<RenderSample> = {}): RenderSample => ({
  width: 1080,
  height: 1920,
  frames: 300,
  seconds: 10,
  wallClockMillis: millisPerScene * 2 * 1.5,
  outputBytes: 4_000_000,
  scenes: [
    { engine: 'html', frames: 150, millis: millisPerScene },
    { engine: 'html', frames: 150, millis: millisPerScene },
  ],
  ...extra,
});
const output = (o: Partial<PlanOutput>): PlanOutput => ({ variant: null, width: 1080, height: 1920, fps: 30, frames: 300, seconds: 10, format: 'mp4', scenes: [{ engine: 'html', frames: 300 }], ...o });

describe('render plan', () => {
  it('PLAN-01 rates are medians per engine, per megapixel-frame; overhead and bytes from the same renders', () => {
    const r = renderRates([vertical(10_000), vertical(12_000), vertical(30_000)]);
    expect(r.renders).toBe(3);
    // 12 000 ms over 2.0736 MP x 150 frames
    expect(r.msPerMegapixelFrame.html).toBeCloseTo(12_000 / (2.0736 * 150), 6);
    expect(r.overhead).toBeCloseTo(1.5, 6);
    expect(r.bytesPerMegapixelSecond).toBeCloseTo(4_000_000 / (2.0736 * 10), 3);
  });

  it('PLAN-02 an estimate scales with pixels and frames: the same rate gives a square video about half the time', () => {
    const r = renderRates([vertical(12_000)]);
    const same = estimateOutput(output({}), r);
    expect(same).toEqual({ renderSeconds: 36, bytes: 4_000_000, basis: 'measured' });
    const square = estimateOutput(output({ width: 1080, height: 1080 }), r);
    expect(square.renderSeconds).toBeCloseTo(36 * (1080 / 1920), 0);
    const long = estimateOutput(output({ frames: 600, seconds: 20, scenes: [{ engine: 'html', frames: 600 }] }), r);
    expect(long.renderSeconds).toBe(72);
    expect(long.bytes).toBe(8_000_000);
  });

  it('PLAN-03 an engine without a sample uses the median of the others and says "partial"; no sample says "none"', () => {
    const r = renderRates([vertical(12_000)]);
    const mixed = estimateOutput(output({ scenes: [{ engine: 'html', frames: 150 }, { engine: 'remotion', frames: 150 }] }), r);
    expect(mixed.basis).toBe('partial');
    expect(mixed.renderSeconds).toBe(36);
    expect(estimateOutput(output({}), renderRates([]))).toEqual({ renderSeconds: null, bytes: null, basis: 'none' });
  });

  it('PLAN-04 samples with missing numbers are left out; overhead is never below 1; unknown sizes give no byte estimate', () => {
    const r = renderRates([vertical(12_000, { wallClockMillis: 0 }), vertical(12_000, { width: 0 }), vertical(12_000, { wallClockMillis: 1000, outputBytes: undefined })]);
    expect(r.renders).toBe(1);
    expect(r.overhead).toBe(1);
    expect(r.bytesPerMegapixelSecond).toBeNull();
    expect(estimateOutput(output({}), r).bytes).toBeNull();
  });

  it('PLAN-05 planId is stable for the same version and options and changes with either', () => {
    const a = planId('reel', 3, { variant: null });
    expect(a).toMatch(/^plan_[0-9a-f]{24}$/);
    expect(planId('reel', 3, { variant: null })).toBe(a);
    expect(planId('reel', 4, { variant: null })).not.toBe(a);
    expect(planId('reel', 3, { variant: 'square' })).not.toBe(a);
    expect(planId('other', 3, { variant: null })).not.toBe(a);
  });
});
