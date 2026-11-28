import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { READABILITY, contrastRatio, frameLayout, parseProject } from '../src/index';

/** Readability warnings (#313 design gate): text too small at the output size, text over a pane colour that hides it. */
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const base = (over: Record<string, unknown> = {}, scenes?: unknown[]) => {
  const p = parseProject(sample);
  if (!p.ok) throw new Error('sample is invalid');
  const m = { ...p.project, ...over, ...(scenes ? { scenes } : {}) };
  const r = parseProject(m);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.warnings;
};
const layoutScene = (panes: unknown[], extra: Record<string, unknown> = {}) => ({ id: 'grid', engine: 'html', template: 'html-layout', durationFrames: 60, props: { layout: { type: 'split', direction: 'auto' }, panes, ...extra } });
const about = (w: Array<{ path: string; message: string }>, word: string) => w.filter((x) => x.message.includes(word));

describe('contrast ratio (WCAG 2.2)', () => {
  it('RDB-01 black on white is 21:1, a colour on itself 1:1, #767676 on white just passes 4.5:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#fff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')!).toBeGreaterThan(4.5);
    expect(contrastRatio('#777777', '#ffffff')!).toBeLessThan(4.5);
    expect(contrastRatio('red', '#ffffff')).toBeNull();
  });
});

describe('text size', () => {
  it('RDB-02 a banner where the built-in templates set body text under 12 px warns; common sizes do not', () => {
    const banner = about(base({ output: { ...sample.output, width: 728, height: 90 } }), 'too small to read');
    expect(banner).toHaveLength(1);
    expect(banner[0]!.path).toBe('output');
    expect(banner[0]!.message).toContain(`${frameLayout(728, 90).type.body.toFixed(1)} px`);
    for (const [w, h] of [[1080, 1920], [1920, 1080], [1080, 1080], [640, 360]]) {
      expect(about(base({ output: { ...sample.output, width: w, height: h } }), 'too small to read'), `${w}x${h}`).toEqual([]);
    }
    // The threshold is the body size: the first frame where it drops under 12 px warns.
    expect(frameLayout(640, 360).type.body).toBeGreaterThanOrEqual(READABILITY.minBodyPx);
  });

  it('RDB-03 each variant size is checked; html scenes that size their own text are not', () => {
    const w = base({ variants: [{ id: 'reel', width: 1080, height: 1920 }, { id: 'tiny', width: 320, height: 180 }] });
    expect(about(w, 'too small to read').map((x) => x.path)).toEqual(['variants.1']);
    const own = about(base({ output: { ...sample.output, width: 728, height: 90 } }, [{ id: 'own', engine: 'html', durationFrames: 30, props: {}, html: '<h1 style="font-size:40px">Sale</h1>' }]), 'too small to read');
    expect(own).toEqual([]);
  });
});

describe('contrast', () => {
  it('RDB-04 white headline text on a near-white pane warns; a dark pane does not', () => {
    const w = base({}, [layoutScene([{ color: '#f1faee', headline: 'Any size', body: 'Lays out for this frame' }, { color: '#1d3557', headline: 'Readable', body: 'On a dark pane' }])]);
    const low = about(w, 'contrast');
    expect(low.map((x) => x.path)).toEqual(['scenes.0.props.panes.0.color', 'scenes.0.props.panes.0.color']);
    expect(low[0]!.message).toContain(`under ${READABILITY.contrastLarge}:1 for large text`);
    expect(low[1]!.message).toContain(`under ${READABILITY.contrastNormal}:1`);
  });

  it('RDB-05 an inline theme with dark text makes the light pane readable; a lower third is checked too', () => {
    const dark = { base: 'default', tokens: { colors: { text: '#111111', mutedText: '#333333' } } };
    expect(about(base({ theme: dark }, [layoutScene([{ color: '#f1faee', headline: 'Any size', body: 'Lays out' }, { headline: 'Two' }])]), 'contrast')).toEqual([]);
    const lt = about(base({}, [layoutScene([{ headline: 'One' }, { headline: 'Two' }], { lowerThird: { name: 'Ada Lovelace', background: '#eeeeee', text: '#dddddd' } })]), 'lower third');
    expect(lt).toHaveLength(1);
    expect(lt[0]!.path).toBe('scenes.0.props.lowerThird');
  });
});
