import { describe, expect, it } from 'vitest';
import {
  LAYOUT_DEFAULTS,
  LAYOUT_STYLE,
  animationProgress,
  cubicBezier,
  layoutMediaRefs,
  layoutSceneDom,
  autoGrid,
  fitMedia,
  frameLayout,
  layoutPanes,
  layoutSceneProps,
  lowerThirdBox,
  parseProject,
  pipInset,
  toLayoutSpec,
  type Rect,
} from '../src/index';

const SIZES = [
  [1920, 1080],
  [1080, 1080],
  [1080, 1350],
  [1080, 1920],
  [3840, 2160],
  [2560, 1080],
] as const;

const inside = (r: Rect, o: Rect, tol = 0.5) =>
  r.x >= o.x - tol && r.y >= o.y - tol && r.x + r.width <= o.x + o.width + tol && r.y + r.height <= o.y + o.height + tol;

describe('split screen (#287)', () => {
  it('auto direction: side by side on wide frames, stacked on square and tall ones', () => {
    const wide = layoutPanes(frameLayout(1920, 1080), { type: 'split' }, 2);
    expect(wide.panes.map((p) => [p.x, p.y, p.width, p.height])).toEqual([
      [0, 0, 957, 1080],
      [963, 0, 957, 1080],
    ]);
    const tall = layoutPanes(frameLayout(1080, 1920), { type: 'split' }, 2);
    expect(tall.panes.map((p) => [p.x, p.y, p.width, p.height])).toEqual([
      [0, 0, 1080, 957],
      [0, 963, 1080, 957],
    ]);
    expect(layoutPanes(frameLayout(1080, 1080), { type: 'split' }, 2).panes[1]!.y).toBeGreaterThan(0);
  });

  it('ratios, explicit direction, gaps in units, and panes that tile the area exactly', () => {
    for (const [w, h] of SIZES) {
      const l = frameLayout(w, h);
      for (const direction of ['horizontal', 'vertical'] as const) {
        for (const n of [2, 3, 4]) {
          const ratios = Array.from({ length: n }, (_, i) => i + 1);
          const r = layoutPanes(l, { type: 'split', direction, ratios, gap: 1 }, n);
          const along = (p: Rect) => (direction === 'horizontal' ? [p.x, p.width] : [p.y, p.height]);
          expect(along(r.panes[0]!)[0]).toBe(0);
          const last = r.panes[n - 1]!;
          expect(along(last)[0]! + along(last)[1]!).toBe(direction === 'horizontal' ? w : h);
          for (let i = 1; i < n; i++) {
            const gap = along(r.panes[i]!)[0]! - (along(r.panes[i - 1]!)[0]! + along(r.panes[i - 1]!)[1]!);
            expect(Math.abs(gap - l.unit)).toBeLessThanOrEqual(1);
          }
          // Sizes follow the ratios (within a pixel of rounding).
          const usable = (direction === 'horizontal' ? w : h) - l.unit * (n - 1);
          const total = ratios.reduce((a, b) => a + b, 0);
          r.panes.forEach((p, i) => expect(Math.abs(along(p)[1]! - (usable * ratios[i]!) / total)).toBeLessThanOrEqual(1));
        }
      }
    }
  });

  it('inset keeps the panes inside a safe area', () => {
    const l = frameLayout(1080, 1920);
    const r = layoutPanes(l, { type: 'split', inset: 'content' }, 3);
    for (const p of r.panes) expect(inside(p, l.box)).toBe(true);
  });

  it('pane text stays inside the content safe area and inside its pane', () => {
    for (const [w, h] of SIZES) {
      const l = frameLayout(w, h);
      for (const p of layoutPanes(l, { type: 'split' }, 2).panes) {
        expect(p.textSafe).toBe('content');
        expect(inside(p.text, l.box)).toBe(true);
        expect(inside(p.text, p)).toBe(true);
      }
    }
  });
});

describe('grid (#287)', () => {
  it('n x m cells in row-major order with equal sizes', () => {
    const l = frameLayout(1920, 1080);
    const r = layoutPanes(l, { type: 'grid', columns: 3, rows: 2, gap: 0 }, 6);
    expect(r.panes.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [640, 0],
      [1280, 0],
      [0, 540],
      [640, 540],
      [1280, 540],
    ]);
    expect(new Set(r.panes.map((p) => `${p.width}x${p.height}`))).toEqual(new Set(['640x540']));
  });

  it('without columns and rows, picks cells closest to square for the frame (reflow per variant)', () => {
    expect(autoGrid(4, 16 / 9)).toEqual({ columns: 2, rows: 2 });
    expect(autoGrid(6, 16 / 9)).toEqual({ columns: 3, rows: 2 });
    expect(autoGrid(6, 9 / 16)).toEqual({ columns: 2, rows: 3 });
    expect(autoGrid(3, 16 / 9)).toEqual({ columns: 3, rows: 1 });
    expect(autoGrid(3, 9 / 16)).toEqual({ columns: 1, rows: 3 });
    expect(autoGrid(16, 1)).toEqual({ columns: 4, rows: 4 });
  });

  it('text in a cell inside the tall frame\'s app-overlay zone falls back to title safe and says so', () => {
    const l = frameLayout(1080, 1920);
    const r = layoutPanes(l, { type: 'grid', columns: 2, rows: 3 }, 6);
    expect(r.panes.slice(0, 2).every((p) => p.textSafe === 'content')).toBe(true);
    const bottom = r.panes[5]!;
    expect(bottom.textSafe).toBe('title');
    expect(inside(bottom.text, bottom)).toBe(true);
    expect(inside(bottom.text, { x: l.safe.title.left, y: l.safe.title.top, width: 1080 - 2 * l.safe.title.left, height: 1920 - 2 * l.safe.title.top })).toBe(true);
  });
});

describe('picture-in-picture (#287)', () => {
  it('the inset sits in the chosen corner, the margin in units from the content safe area', () => {
    const l = frameLayout(1920, 1080);
    const m = 2 * l.unit;
    const br = pipInset(l, { type: 'pip' });
    expect(Math.abs(br.width - 36 * l.unit)).toBeLessThanOrEqual(1);
    expect(Math.abs(br.height - (36 * l.unit) / (16 / 9))).toBeLessThanOrEqual(1);
    expect(br.x + br.width).toBe(Math.round(l.box.x + l.box.width - m));
    expect(br.y + br.height).toBe(Math.round(l.box.y + l.box.height - m));
    const tl = pipInset(l, { type: 'pip', corner: 'top-left', width: 50, aspect: 1, margin: 0 });
    expect([tl.x, tl.y, tl.width, tl.height]).toEqual([l.box.x, l.box.y, 540, 540]);
  });

  it('stays inside the content safe area at every size, also clear of the app-overlay zone on 9:16', () => {
    for (const [w, h] of SIZES) {
      const l = frameLayout(w, h);
      for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
        for (const width of [undefined, 20, 60, 100]) {
          const r = pipInset(l, { type: 'pip', corner, ...(width ? { width } : {}) });
          expect(inside(r, l.box, 1), `${w}x${h} ${corner} ${width}`).toBe(true);
        }
      }
    }
    const tall = frameLayout(1080, 1920);
    const r = pipInset(tall, { type: 'pip' });
    expect(r.y + r.height).toBeLessThanOrEqual(1920 - tall.safe.ui!.bottom);
    // At the default width a frame-shaped inset on a tall frame is capped at 45 % of the safe height.
    expect(r.height).toBeLessThanOrEqual(Math.ceil((tall.box.height - 4 * tall.unit) * LAYOUT_DEFAULTS.pipMaxShare));
  });

  it('pane 0 is the full frame, pane 1 the inset', () => {
    const r = layoutPanes(frameLayout(1080, 1080), { type: 'pip', corner: 'top-right' }, 2);
    expect(r.panes.map((p) => p.role)).toEqual(['main', 'inset']);
    expect(r.panes[0]).toMatchObject({ x: 0, y: 0, width: 1080, height: 1080 });
  });
});

describe('lower third and fit modes (#287)', () => {
  it('the lower third anchors to the bottom corner of the content safe area', () => {
    const l = frameLayout(1080, 1920);
    const b = lowerThirdBox(l);
    expect(b).toMatchObject({ x: 65, bottom: 1920 - 672, align: 'left' });
    expect(lowerThirdBox(l, 'right').x).toBe(65 + 950);
    expect(lowerThirdBox(frameLayout(3840, 2160)).nameSize).toBeCloseTo(6 * 21.6);
  });

  it('contain letterboxes, cover crops, blur-fill letterboxes over a cover copy', () => {
    const box = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(fitMedia(box, 1080, 1920, 'contain')).toEqual({ fg: { x: 656.25, y: 0, width: 607.5, height: 1080 }, bg: null });
    const cover = fitMedia(box, 1080, 1920, 'cover').fg;
    expect([cover.x, cover.width]).toEqual([0, 1920]);
    expect(cover.y).toBeCloseTo(-1166.667, 2);
    expect(cover.height).toBeCloseTo(3413.333, 2);
    expect(fitMedia(box, 1080, 1920, 'cover', { x: 50, y: 0 }).fg.y).toBe(0);
    const bf = fitMedia(box, 1080, 1920, 'blur-fill');
    expect(bf.fg.width).toBe(607.5);
    expect(bf.bg!.width).toBe(1920);
  });
});

describe('layout scene props (#287)', () => {
  const pane = { color: '#223344' };
  it('accepts every primitive and checks pane counts, ratios and grid sizes', () => {
    expect(layoutSceneProps.safeParse({ layout: { type: 'full' }, panes: [pane] }).success).toBe(true);
    expect(layoutSceneProps.safeParse({ layout: { type: 'split', ratios: [2, 1] }, panes: [pane, pane] }).success).toBe(true);
    expect(layoutSceneProps.safeParse({ layout: { type: 'pip', aspect: '4:3' }, panes: [pane, pane] }).success).toBe(true);
    expect(layoutSceneProps.safeParse({ layout: { type: 'grid' }, panes: Array(16).fill(pane) }).success).toBe(true);

    const msgs = (input: unknown) => {
      const r = layoutSceneProps.safeParse(input);
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    expect(msgs({ layout: { type: 'split' }, panes: [pane] })).toEqual(['panes: a split has 2 to 4 panes, got 1']);
    expect(msgs({ layout: { type: 'split', ratios: [1, 1, 1] }, panes: [pane, pane] })).toEqual(['layout.ratios: give one ratio per pane: 2 panes, 3 ratios']);
    expect(msgs({ layout: { type: 'pip' }, panes: [pane] })[0]).toMatch(/exactly 2 panes/);
    expect(msgs({ layout: { type: 'grid', columns: 2, rows: 2 }, panes: Array(5).fill(pane) })).toEqual(['layout: a 2x2 grid holds 4 panes, got 5']);
    expect(msgs({ layout: { type: 'pip', aspect: '9:0' }, panes: [pane, pane] }).join()).toMatch(/1:5 and 5:1/);
    expect(msgs({ layout: { type: 'full' }, panes: [{ media: { asset: 'a', fit: 'cover', blur: 2 } }] })).toEqual(['panes.0.media.blur: blur applies to fit "blur-fill" only']);
    expect(msgs({ layout: { type: 'full' }, panes: [{ media: { asset: 'a', fit: 'stretch' } }] }).join()).toMatch(/contain|cover|blur-fill/);
  });

  it('pip aspect "W:H" becomes a number for the geometry', () => {
    const p = layoutSceneProps.parse({ layout: { type: 'pip', aspect: '4:3' }, panes: [pane, pane] });
    expect(toLayoutSpec(p.layout)).toMatchObject({ type: 'pip', aspect: 4 / 3 });
  });

  it('a manifest checks that pane media are image or video assets it lists', () => {
    const manifest = (assets: unknown[], media: string) => ({
      schemaVersion: '0.2',
      projectId: 'p',
      title: 'p',
      output: { width: 1920, height: 1080, fps: 30, format: 'mp4' },
      assets,
      scenes: [
        { id: 's', engine: 'html', template: 'html-layout', durationSeconds: 2, props: { layout: { type: 'split' }, panes: [{ media: { asset: media } }, { media: { asset: 'img', fit: 'blur-fill' } }] } },
      ],
    });
    const img = { id: 'img', uri: 'project://a.png', mediaType: 'image' };
    const clip = { id: 'clip', uri: 'project://a.mp4', mediaType: 'video' };
    const song = { id: 'song', uri: 'project://a.mp3', mediaType: 'audio' };
    expect(parseProject(manifest([img, clip], 'clip')).ok).toBe(true);
    const bad = parseProject(manifest([img, song], 'song'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues).toContainEqual({ path: 'scenes.0.props.panes.0.media.asset', message: 'asset "song" is audio; expected image or video' });
    const missing = parseProject(manifest([img], 'nope'));
    if (!missing.ok) expect(missing.issues[0]!.message).toMatch(/unknown asset id "nope"/);
    else throw new Error('expected an error');
    // The same props on the hyperframes engine.
    const hf = manifest([img, clip], 'clip');
    hf.scenes[0]!.engine = 'hyperframes';
    hf.scenes[0]!.template = 'hyperframes-layout';
    expect(parseProject(hf).ok).toBe(true);
  });
});

describe('layouts on every engine (#287): one props schema, shared style and timing', () => {
  it('the four layout templates take the same props, and a scene moves between engines by engine and template only', () => {
    const scene = { id: 's', durationSeconds: 2, props: { layout: { type: 'pip' }, panes: [{ media: { asset: 'clip', fit: 'blur-fill', startSeconds: 1.5 } }, { color: '#223344', headline: 'Inset' }] } };
    for (const [engine, template] of [
      ['html', 'html-layout'],
      ['hyperframes', 'hyperframes-layout'],
      ['remotion', 'remotion-layout'],
      ['motion-canvas', 'motion-canvas-layout'],
    ] as const) {
      const r = parseProject({
        schemaVersion: '0.2',
        projectId: 'p',
        title: 'p',
        output: { width: 1080, height: 1920, fps: 30, format: 'mp4' },
        assets: [{ id: 'clip', uri: 'project://a.mp4', mediaType: 'video' }],
        scenes: [{ ...scene, engine, template }],
      });
      expect(r.ok, `${engine}/${template}`).toBe(true);
    }
  });

  it('layoutMediaRefs gives each pane asset with its in-point, for staging', () => {
    expect(layoutMediaRefs({ layout: { type: 'split' }, panes: [{ media: { asset: 'a', startSeconds: 2 } }, { media: { asset: 'b' } }] })).toEqual([
      { path: ['panes', 0, 'media', 'asset'], asset: 'a', mediaTypes: ['image', 'video'], start: 2 },
      { path: ['panes', 1, 'media', 'asset'], asset: 'b', mediaTypes: ['image', 'video'] },
    ]);
  });

  it('cubicBezier is the CSS timing function', () => {
    const linear = cubicBezier(0, 0, 1, 1);
    for (const x of [0, 0.1, 0.5, 0.9, 1]) expect(linear(x)).toBeCloseTo(x, 5);
    // CSS `ease` (0.25, 0.1, 0.25, 1) at x = 0.5 is 0.8024, `ease-out` (0, 0, 0.58, 1) 0.6847.
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3);
    expect(cubicBezier(0, 0, 0.58, 1)(0.5)).toBeCloseTo(0.6847, 3);
    const ease = cubicBezier(0.2, 0.8, 0.2, 1);
    let last = 0;
    for (let i = 0; i <= 100; i++) {
      const y = ease(i / 100);
      expect(y).toBeGreaterThanOrEqual(last - 1e-9);
      last = y;
    }
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
  });

  it('animationProgress follows delay, duration and easing with fill both', () => {
    const a = LAYOUT_STYLE.motion.card;
    expect(animationProgress(0, a)).toBe(0);
    expect(animationProgress(a.delay, a)).toBe(0);
    expect(animationProgress(a.delay + a.duration, a)).toBe(1);
    expect(animationProgress(10, a)).toBe(1);
    expect(animationProgress(a.delay + a.duration / 2, a)).toBeGreaterThan(0.5);
  });

  it('the DOM builder reads its sizes and timing from LAYOUT_STYLE', () => {
    const props = layoutSceneProps.parse({ layout: { type: 'pip' }, panes: [{ color: '#112233' }, { label: 'Cam', headline: 'Hi', body: 'There' }], lowerThird: { name: 'Sam' } });
    const dom = layoutSceneDom({ props, width: 1000, height: 1000, durationSeconds: 3, picture: () => '' });
    const m = LAYOUT_STYLE.motion;
    expect(dom.css).toContain(`rfl-pop ${m.inset.duration}s cubic-bezier(${m.inset.ease.join(',')}) ${m.inset.delay}s both`);
    expect(dom.css).toContain(`rfl-in ${m.card.duration}s cubic-bezier(${m.card.ease.join(',')}) ${m.card.delay}s both`);
    expect(dom.css).toContain(`rfl-out ${m.lowerThirdOut.duration}s cubic-bezier(${m.lowerThirdOut.ease.join(',')}) ${(3 - m.lowerThirdOut.lead).toFixed(3)}s both`);
    expect(dom.css).toContain(`font-size:${LAYOUT_STYLE.card.size * 10}px`);
    expect(dom.html).toContain(`data-rf-fit-tol="${LAYOUT_STYLE.fitInk}"`);
  });
});
