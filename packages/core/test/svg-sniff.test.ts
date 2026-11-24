import { describe, expect, it } from 'vitest';
import { looksLikeSvg, svgSize } from '../src/svg';

describe('SVG sniffing and size (linear scans, no backtracking regexes)', () => {
  it('recognises SVG documents as before', () => {
    for (const s of [
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<svg>',
      '﻿  <svg\n width="1">',
      '<?xml version="1.0"?><svg/>',
      '<!-- a --> <!-- b --><svg>',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg>',
      '<!doctype  SVG><svg>',
    ]) expect(looksLikeSvg(s), s).toBe(true);
    expect(looksLikeSvg(Buffer.from('<svg viewBox="0 0 1 1">'))).toBe(true);
  });

  it('refuses everything else', () => {
    for (const s of ['', 'svg', '<svgx>', '<html><svg>', '<!-- open <svg>', '<!DOCTYPE html>', '<?xmlfoo', 'text <svg>'])
      expect(looksLikeSvg(s), s).toBe(false);
  });

  it('stays linear on hostile input (the old regex backtracked on repeated comment starts)', () => {
    const hostile = '<!--' + '-'.repeat(200_000) + '<!--'.repeat(50_000);
    const t = performance.now();
    expect(looksLikeSvg(hostile)).toBe(false);
    expect(performance.now() - t).toBeLessThan(200);
    const spaces = `<svg width=".${' '.repeat(100_000)}x" height="2">`;
    const t2 = performance.now();
    svgSize(spaces);
    expect(performance.now() - t2).toBeLessThan(200);
  });

  it('reads px sizes with or without spaces and the px unit', () => {
    expect(svgSize('<svg width=" 120 px " height="80">')).toMatchObject({ width: 120, height: 80 });
    expect(svgSize('<svg width="12.5px" height="4">')).toMatchObject({ width: 12.5, height: 4 });
  });
});
