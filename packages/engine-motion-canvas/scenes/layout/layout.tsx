import { Img, Layout, Node, Rect, Txt, blur, brightness, makeScene2D } from '@motion-canvas/2d';
import { createRef, useScene, type Reference } from '@motion-canvas/core';
import {
  LAYOUT_DEFAULTS,
  LAYOUT_STYLE,
  animationProgress,
  clearOfLowerThird,
  fitMedia,
  frameLayout,
  layoutPanes,
  lowerThirdBox,
  type LayoutSpec,
  type PaneBox,
  type Rect as Box,
} from '@reelforge/project-schema/layout';
import { mediaKey, mediaUrlAt, type FitMode, type SceneMedia } from '@reelforge/project-schema/media';

/**
 * Template "motion-canvas-layout" (#287): split screen, picture-in-picture,
 * grid, full frame and lower third, with the same props as html-layout,
 * hyperframes-layout and remotion-layout.
 *
 * Motion Canvas draws on a canvas, not in the DOM, so this scene builds the
 * same picture from Motion Canvas nodes. Everything that decides where things
 * go comes from the same functions as the DOM engines
 * (`@reelforge/project-schema/layout`): pane rectangles (`layoutPanes`), text
 * boxes kept clear of the lower third (`clearOfLowerThird`), the lower third's
 * box (`lowerThirdBox`), where media lands for each fit mode (`fitMedia`), and
 * the type sizes, spacing and timing (`LAYOUT_STYLE`). Text wraps in Motion
 * Canvas's layout, which is the browser's flexbox and line breaking, and
 * shrinks to fit its box the way the DOM engines' fit-to-box does (a binary
 * search on the font size, never below the same minimum).
 *
 * Every frame is a function of its frame number: the main thread sets the
 * state of frame i (animation progress, the video picture) and yields once,
 * so a seek lands on the same pixels. A video pane shows picture i of its clip
 * at frame i (staged by src/render.ts as one picture per output frame).
 *
 * Props arrive parsed (defaults applied), with `spec` the geometry spec of
 * `props.layout` (see src/render.ts).
 */

interface ThemeVars {
  colors: { background: string; surface: string; text: string; mutedText: string; accent: string };
  fontFamily: string;
  headingWeight: number;
}

interface PaneMediaVar {
  asset: string;
  fit: FitMode;
  focus?: { x: number; y: number };
  startSeconds: number;
  blur?: number;
}

interface PaneVar {
  media?: PaneMediaVar;
  color?: string;
  label?: string;
  headline?: string;
  body?: string;
}

interface LowerThirdVar {
  name: string;
  title?: string;
  align: 'left' | 'right';
  accent?: string;
  background?: string;
  text?: string;
}

interface PropsVar {
  panes: PaneVar[];
  lowerThird?: LowerThirdVar;
  background?: string;
  accent?: string;
}

const FALLBACK: ThemeVars = {
  colors: { background: '#0b0b14', surface: '#1a1a2b', text: '#ffffff', mutedText: '#c9c9d6', accent: '#ff3d71' },
  fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif',
  headingWeight: 800,
};

const S = LAYOUT_STYLE;
const M = S.motion;

/** Img's shared picture cache (one entry per src); video pictures are dropped from it once shown. */
const imgPool = (Img as unknown as { pool: Record<string, HTMLImageElement> }).pool;

/**
 * The largest font size in [min, max] at which `fits` holds, as the DOM
 * engines' fit-to-box finds it (14 halvings, then floored to 0.1 px).
 */
function shrinkToFit(max: number, min: number, fits: (size: number) => boolean): number {
  if (fits(max)) return max;
  let lo = min;
  let hi = max;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  const size = Math.floor(lo * 10) / 10;
  fits(size);
  return size;
}

export default makeScene2D(function* (view) {
  const scene = useScene();
  const vars = scene.variables;
  const theme = (vars.get('theme', null)() as ThemeVars | null) ?? FALLBACK;
  const props = vars.get('props', null)() as PropsVar | null;
  const spec = vars.get('spec', null)() as LayoutSpec | null;
  if (!props || !spec) throw new Error('motion-canvas-layout renders only through the ReelForge renderer (no props)');
  const duration = vars.get('durationSeconds', 2)() as number;
  /** The exact rate as a number (fpsValue: 29.97 is 30000/1001); frame i shows time i / fps. */
  const fps = vars.get('fps', 30)() as number;
  const platform = (vars.get('platform', null)() as string | null) ?? undefined;
  const assets = (vars.get('assets', null)() as Record<string, SceneMedia> | null) ?? {};

  const size = scene.getSize();
  const width = size.x;
  const height = size.y;
  const l = frameLayout(width, height, platform);
  const u = l.unit;
  const colors = {
    bg: props.background ?? theme.colors.background,
    surface: theme.colors.surface,
    text: theme.colors.text,
    muted: theme.colors.mutedText,
    accent: props.accent ?? theme.colors.accent,
  };
  const font = theme.fontFamily;
  const frames = (vars.get('frames', null)() as number | null) ?? Math.max(1, Math.round(duration * fps));

  const lt = props.lowerThird;
  const ltBox = lt ? lowerThirdBox(l, lt.align) : null;
  const geometry = layoutPanes(l, spec, props.panes.length);
  const layout = ltBox ? clearOfLowerThird(geometry, ltBox) : geometry;

  // Motion Canvas puts the origin at the frame centre; boxes are top-left based.
  const centre = (r: Box) => ({ x: r.x + r.width / 2 - width / 2, y: r.y + r.height / 2 - height / 2 });

  view.fill(colors.bg);
  // A filtered node is drawn through a cache canvas clipped to the view plus its cache padding: without room
  // around the frame, a blur would fade to transparent at the frame's edges (the DOM's blur reaches past them).
  const blurs = props.panes.filter((p) => p.media?.fit === 'blur-fill').map((p) => (p.media!.blur ?? LAYOUT_DEFAULTS.blur) * u * S.blurFill.scale);
  if (blurs.length) view.cachePadding(Math.ceil(Math.max(...blurs) * 3));

  /** What changes per frame: video pictures, and animated nodes. */
  const videos: Array<{ media: SceneMedia; refs: Array<Reference<Img>>; shown: string }> = [];
  const updates: Array<(t: number) => void> = [];

  // Panes, in order (the inset after the main picture), then their text, then the lower third: the DOM engines' stacking.
  for (const p of layout.panes) {
    const pane = props.panes[p.index]!;
    const inset = p.role === 'inset';
    const group = createRef<Node>();
    const c = centre(p);
    const radius = inset ? S.inset.radius * u : 0;
    const paneNode = createRef<Rect>();
    view.add(
      <Node ref={group} x={c.x} y={c.y}>
        {inset ? (
          // The DOM engines' outline: the frame colour around the inset, following its rounded corners.
          <Rect width={p.width + 2 * S.inset.outline * u} height={p.height + 2 * S.inset.outline * u} radius={radius + S.inset.outline * u} fill={colors.bg} />
        ) : null}
        <Rect ref={paneNode} width={p.width} height={p.height} radius={radius} fill={pane.color ?? colors.surface} clip />
      </Node>
    );
    const m = pane.media;
    const staged = m ? assets[mediaKey(m.asset, m.startSeconds || undefined)] : undefined;
    if (m && !staged) throw new Error(`asset "${m.asset}" is not available to the renderer`);
    if (m && staged) {
      // Pane-local coordinates (origin at the pane's centre).
      const local = (r: Box) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height });
      const box = { x: -p.width / 2, y: -p.height / 2, width: p.width, height: p.height };
      const focus = m.focus ?? { x: 50, y: 50 };
      const refs: Array<Reference<Img>> = [];
      if (m.fit === 'blur-fill') {
        // A cover copy behind, blurred, darkened and enlarged about the pane's centre (CSS transform: scale on the element).
        const cover = fitMedia(box, staged.width, staged.height, 'cover', focus).fg;
        const k = S.blurFill.scale;
        const bgRef = createRef<Img>();
        refs.push(bgRef);
        paneNode().add(
          <Img
            ref={bgRef}
            src={staged.url}
            {...local({ x: cover.x * k, y: cover.y * k, width: cover.width * k, height: cover.height * k })}
            filters={[blur((m.blur ?? LAYOUT_DEFAULTS.blur) * u * k), brightness(S.blurFill.brightness)]}
          />
        );
      }
      const fg = fitMedia(box, staged.width, staged.height, m.fit === 'cover' ? 'cover' : 'contain', focus).fg;
      const fgRef = createRef<Img>();
      refs.push(fgRef);
      paneNode().add(<Img ref={fgRef} src={staged.url} {...local(fg)} />);
      if (staged.frames && staged.frames.urls.length > 1) videos.push({ media: staged, refs, shown: staged.url });
    }
    if (inset) {
      updates.push((t) => {
        const k = animationProgress(t, M.inset);
        group().opacity(k);
        group().scale(M.inset.from + (1 - M.inset.from) * k);
      });
    }
  }

  // Pane text: a label at the top of the text box and a card at its bottom (both at the top when there is a lower third).
  const textTop = Boolean(lt);
  for (const p of layout.panes) {
    const pane = props.panes[p.index]!;
    if (!pane.label && !pane.headline && !pane.body) continue;
    const t = p.text;
    let labelHeight = 0;
    let labelNode: Reference<Rect> | null = null;
    if (pane.label) {
      labelNode = createRef<Rect>();
      const txt = createRef<Txt>();
      const max = S.label.size * u;
      view.add(
        <Rect ref={labelNode} layout offset={[-1, -1]} fill={colors.bg} fontFamily={font} fontWeight={S.label.weight} lineHeight={`${S.label.lineHeight * 100}%`}>
          <Txt ref={txt} text={pane.label} textWrap={false} fill={colors.text} />
        </Rect>
      );
      const apply = (s: number) => {
        labelNode!().fontSize(s);
        labelNode!().padding([S.label.padYEm * s, S.label.padXEm * s]);
        labelNode!().radius(S.label.radiusEm * s);
      };
      // Shrinks until it fits the text box's width (the DOM label is one line, max-width 100 %).
      shrinkToFit(max, max * 0.4, (s) => {
        apply(s);
        return labelNode!().size().x <= t.width + 1;
      });
      labelHeight = labelNode().size().y;
    }
    let cardNode: Reference<Rect> | null = null;
    let cardHeight = 0;
    if (pane.headline || pane.body) {
      cardNode = createRef<Rect>();
      const onMedia = Boolean(pane.media);
      const head = createRef<Txt>();
      const body = createRef<Txt>();
      view.add(
        <Rect
          ref={cardNode}
          layout
          direction="column"
          alignItems="stretch"
          offset={[-1, -1]}
          maxWidth={Math.min(t.width, S.card.maxWidth * u)}
          fill={onMedia ? colors.bg : null}
          fontFamily={font}
        >
          {pane.headline ? (
            <Txt ref={head} text={pane.headline} textWrap fill={colors.text} fontWeight={theme.headingWeight} lineHeight={`${S.card.headlineLineHeight * 100}%`} />
          ) : null}
          {pane.body ? <Txt ref={body} text={pane.body} textWrap fill={colors.muted} lineHeight={`${S.card.bodyLineHeight * 100}%`} /> : null}
        </Rect>
      );
      const available = t.height - (labelNode ? labelHeight + S.textGap * u : 0);
      const apply = (s: number) => {
        const card = cardNode!();
        card.fontSize(s);
        card.padding(onMedia ? [S.card.padYEm * s, S.card.padXEm * s] : 0);
        card.radius(onMedia ? S.card.radiusEm * s : 0);
        if (pane.headline) head().letterSpacing(S.card.letterSpacingEm * s);
        if (pane.body) {
          body().fontSize(S.card.bodyEm * s);
          body().margin.top(pane.headline ? S.card.bodyGapEm * s : 0);
        }
      };
      const max = S.card.size * u;
      shrinkToFit(max, Math.floor(max * S.card.minShare), (s) => {
        apply(s);
        const got = cardNode!().size();
        return got.y <= available + 1 && got.x <= Math.min(t.width, S.card.maxWidth * u) + 1;
      });
      cardHeight = cardNode().size().y;
    }
    // Positions in the text box (flex column: label first; the card at the end unless the text sits at the top).
    const labelY = t.y;
    const cardY = textTop ? t.y + (labelNode ? labelHeight + S.textGap * u : 0) : t.y + t.height - cardHeight;
    const at = (r: Reference<Rect>, x: number, y: number) => r().position([x - width / 2, y - height / 2]);
    if (labelNode) {
      const node = labelNode;
      at(node, t.x, labelY);
      updates.push((time) => {
        const k = animationProgress(time, M.label);
        node().opacity(k);
        at(node, t.x, labelY + M.label.rise * u * (1 - k));
      });
    }
    if (cardNode) {
      const node = cardNode;
      at(node, t.x, cardY);
      updates.push((time) => {
        const k = animationProgress(time, M.card);
        node().opacity(k);
        at(node, t.x, cardY + M.card.rise * u * (1 - k));
      });
    }
  }

  // Lower third: an accent bar and a text block in brand colours, in the bottom corner of the content safe area.
  if (lt && ltBox) {
    const b = ltBox;
    const block = createRef<Rect>();
    const textBlock = createRef<Layout>();
    const title = createRef<Txt>();
    const left = lt.align === 'left';
    view.add(
      <Rect
        ref={block}
        layout
        direction={left ? 'row' : 'row-reverse'}
        alignItems="stretch"
        offset={[left ? -1 : 1, 1]}
        x={b.x - width / 2}
        y={b.bottom - height / 2}
        maxWidth={b.maxWidth}
        maxHeight={b.height}
        radius={S.lowerThird.radius * u}
        clip
        fill={lt.background ?? colors.surface}
        fontFamily={font}
      >
        <Rect width={b.bar} shrink={0} fill={lt.accent ?? colors.accent} />
        <Layout ref={textBlock} layout direction="column" alignItems={left ? 'start' : 'end'} shrink={1}>
          <Txt text={lt.name} textWrap fill={lt.text ?? colors.text} fontWeight={theme.headingWeight} lineHeight={`${S.lowerThird.nameLineHeight * 100}%`} textAlign={left ? 'left' : 'right'} />
          {lt.title ? (
            <Txt
              ref={title}
              text={lt.title}
              textWrap
              fill={lt.text ?? colors.text}
              opacity={S.lowerThird.titleOpacity}
              lineHeight={`${S.lowerThird.titleLineHeight * 100}%`}
              textAlign={left ? 'left' : 'right'}
            />
          ) : null}
        </Layout>
      </Rect>
    );
    const apply = (s: number) => {
      textBlock().fontSize(s);
      textBlock().padding([(b.padding * S.lowerThird.padYShare * s) / b.nameSize, (b.padding * s) / b.nameSize]);
      if (lt.title) {
        title().fontSize((b.titleSize / b.nameSize) * s);
        title().margin.top(S.lowerThird.titleGapEm * s);
      }
    };
    // The text block shrinks as a whole (name, title and padding) until the block fits its band; measured
    // without the band's height limit, which would clip it.
    block().maxHeight(null);
    shrinkToFit(b.nameSize, Math.floor(b.nameSize * S.lowerThird.minShare), (s) => {
      apply(s);
      const got = textBlock().size();
      return got.y <= b.height + 1 && got.x <= b.maxWidth - b.bar + 1;
    });
    block().maxHeight(b.height);
    const outAt = Math.max(0, duration - M.lowerThirdOut.lead);
    const x0 = b.x - width / 2;
    updates.push((time) => {
      const k = animationProgress(time, M.lowerThirdIn);
      const out = animationProgress(time, { ...M.lowerThirdOut, delay: outAt });
      block().opacity(k * (1 - out));
      block().x(x0 + (left ? -1 : 1) * M.lowerThirdIn.slide * u * (1 - k));
    });
  }

  // One yield per frame; frame i shows the state at i / fps and picture i of each video.
  for (let i = 0; i < frames; i++) {
    const time = i / fps;
    for (const f of updates) f(time);
    for (const v of videos) {
      const next = mediaUrlAt(v.media, i);
      if (next !== v.shown) {
        for (const r of v.refs) r().src(next);
        delete imgPool[v.shown];
        v.shown = next;
      }
    }
    yield;
  }
});
