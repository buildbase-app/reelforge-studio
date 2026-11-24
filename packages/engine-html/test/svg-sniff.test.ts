import { describe, expect, it } from 'vitest';
import { looksLikeSvg } from '../src/media';

describe('SVG sniffing (CodeQL js/redos)', () => {
  it('accepts SVG with an XML declaration, comments and whitespace; refuses the rest', () => {
    expect(looksLikeSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(true);
    expect(looksLikeSvg('  <?xml version="1.0"?>\n<!-- a --> <!-- b -->\n<SVG>')).toBe(true);
    expect(looksLikeSvg('<svgx>')).toBe(false);
    expect(looksLikeSvg('<html><svg>')).toBe(false);
    expect(looksLikeSvg('<!-- never closed <svg>')).toBe(false);
    expect(looksLikeSvg('')).toBe(false);
  });
  it('runs in linear time on a hostile run of comments', () => {
    const hostile = '<!--' + '--><!--'.repeat(20_000);
    const t = performance.now();
    expect(looksLikeSvg(hostile)).toBe(false);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
