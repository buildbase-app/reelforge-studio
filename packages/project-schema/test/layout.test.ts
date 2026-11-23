import { describe, expect, it } from 'vitest';
import { SAFE_AREA_SPEC, fitText, frameLayout, layoutCssVars, safeAreaInsets, wrapWords } from '../src/index';

describe('safe areas (#287)', () => {
  it('title safe 90 % and action safe 93 % of each dimension (EBU R 95, ITU-R BT.1848)', () => {
    const s = safeAreaInsets(1920, 1080);
    expect(s.title).toEqual({ top: 54, right: 96, bottom: 54, left: 96 });
    expect(s.action).toEqual({ top: 38, right: 67, bottom: 38, left: 67 });
    expect(s.ui).toBeNull();
    expect(s.content).toEqual(s.title);
    expect(SAFE_AREA_SPEC.title).toBe(0.05);
    expect(SAFE_AREA_SPEC.action).toBe(0.035);
  });

  it('tall frames get the conservative social ui zone: 14 % top, 35 % bottom, 6 % sides', () => {
    const s = safeAreaInsets(1080, 1920);
    expect(s.ui).toEqual({ top: 269, right: 65, bottom: 672, left: 65 });
    // Per side, the larger of title safe and the ui zone.
    expect(s.content).toEqual({ top: 269, right: 65, bottom: 672, left: 65 });
    expect(safeAreaInsets(1080, 1920, 'tiktok').ui).toEqual(s.ui);
  });

  it('no ui zone on 4:5, 1:1 and wide frames, or for platforms without app ui', () => {
    expect(safeAreaInsets(1080, 1350).ui).toBeNull();
    expect(safeAreaInsets(1080, 1080).ui).toBeNull();
    expect(safeAreaInsets(1080, 1920, 'broadcast').ui).toBeNull();
    expect(safeAreaInsets(1080, 1920, 'None').ui).toBeNull();
    expect(safeAreaInsets(1080, 1920, 'none').content).toEqual(safeAreaInsets(1080, 1920, 'none').title);
  });
});

describe('frame layout (#287)', () => {
  it('the unit is 1 % of the shorter side, so a headline has the same size at 9:16, 1:1 and 16:9', () => {
    for (const [w, h] of [
      [1080, 1920],
      [1080, 1080],
      [1920, 1080],
      [1080, 1350],
    ] as const) {
      expect(frameLayout(w, h).unit).toBe(10.8);
      expect(frameLayout(w, h).type.display).toBeCloseTo(113.4);
    }
    expect(frameLayout(3840, 2160).unit).toBe(21.6);
  });

  it('orientation and direction: wide frames lay out in a row, the rest stack', () => {
    expect(frameLayout(1920, 1080)).toMatchObject({ orientation: 'landscape', direction: 'row' });
    expect(frameLayout(2560, 1080)).toMatchObject({ orientation: 'landscape', direction: 'row' });
    expect(frameLayout(1080, 1080)).toMatchObject({ orientation: 'square', direction: 'column' });
    expect(frameLayout(1080, 1350)).toMatchObject({ orientation: 'portrait', direction: 'column' });
    expect(frameLayout(1080, 1920)).toMatchObject({ orientation: 'portrait', direction: 'column' });
  });

  it('the content box is the frame minus the content insets', () => {
    expect(frameLayout(1080, 1920).box).toEqual({ x: 65, y: 269, width: 950, height: 979 });
    expect(frameLayout(1920, 1080).box).toEqual({ x: 96, y: 54, width: 1728, height: 972 });
  });

  it('CSS variables for DOM engines', () => {
    const css = layoutCssVars(1920, 1080);
    expect(css).toContain('--rf-unit:10.8px');
    expect(css).toContain('--rf-unit-w:19.2px');
    expect(css).toContain('--rf-safe-left:96px');
    expect(css).toContain('--rf-action-safe-top:38px');
    expect(css).toContain('--rf-content-h:972px');
  });
});

describe('fitText (#287)', () => {
  // A monospace-like measure: every character is 0.5 em wide.
  const measure = (s: string) => s.length * 0.5;

  it('keeps the largest size when the text fits', () => {
    const r = fitText({ text: 'Short title', measure, maxWidth: 1000, maxHeight: 500, min: 20, max: 100, lineHeight: 1 });
    expect(r).toMatchObject({ fontSize: 100, fits: true, lines: ['Short title'] });
  });

  it('shrinks until the wrapped lines fit the height, never below min', () => {
    const text = 'one two three four five six seven eight nine ten';
    const r = fitText({ text, measure, maxWidth: 400, maxHeight: 200, min: 10, max: 100, lineHeight: 1 });
    expect(r.fits).toBe(true);
    expect(r.fontSize).toBeLessThan(100);
    expect(r.lines.length * r.fontSize).toBeLessThanOrEqual(200);
    // One px larger does not fit.
    const bigger = wrapWords(text.split(' '), r.fontSize + 1, { measure, maxWidth: 400 });
    expect(bigger === null || bigger.length * (r.fontSize + 1) > 200).toBe(true);
  });

  it('shrinks a single long word to the width', () => {
    const r = fitText({ text: 'Internationalisation', measure, maxWidth: 300, maxHeight: 1000, min: 10, max: 100, lineHeight: 1.1 });
    expect(r.fits).toBe(true);
    expect(measure('Internationalisation') * r.fontSize).toBeLessThanOrEqual(300);
  });

  it('reports fits: false at min when nothing fits', () => {
    const r = fitText({ text: 'a b c d e f g h', measure, maxWidth: 10, maxHeight: 10, min: 20, max: 40, lineHeight: 1 });
    expect(r).toMatchObject({ fontSize: 20, fits: false });
  });
});
