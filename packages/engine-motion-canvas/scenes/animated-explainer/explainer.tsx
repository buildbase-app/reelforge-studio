import { Layout, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import {
  all,
  createRef,
  easeInOutCubic,
  easeOutCubic,
  sequence,
  useScene,
  waitFor,
} from '@motion-canvas/core';
import { frameLayout } from '@reelforge/project-schema/layout';

interface ThemeVars {
  colors: { background: string; text: string; mutedText: string; accent: string; accent2: string };
  fontFamily: string;
  headingWeight: number;
  motionSpeed: number;
}

const FALLBACK: ThemeVars = {
  colors: { background: '#0b0b14', text: '#ffffff', mutedText: '#e8e8f0', accent: '#00d1b2', accent2: '#ff3d71' },
  fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif',
  headingWeight: 800,
  motionSpeed: 1,
};

/**
 * Template "animated-explainer": a title, then up to four points revealed one
 * by one, then a hold. Every timing is derived from `durationSeconds` so the
 * scene lasts exactly as long as the manifest says.
 *
 * Any size (#287): sizes are multiples of the layout unit (1 % of the shorter
 * side, `frameLayout`) and the block is centred in the content safe area
 * (title safe, plus the social ui zone on tall frames). Portrait and square
 * frames stack the title above the points; landscape frames (4:3 and wider)
 * put the title in a left column and the points in a right one. If the laid
 * out block is still larger than the safe area (long points on a short frame)
 * it is scaled down to fit. Text wraps inside its column, and the first frame
 * already shows the title and its underline so a thumbnail is never blank.
 * Colours and font come from the theme; the `accent` and `background` props
 * override it.
 *
 * Props, theme and platform arrive as project variables (see src/render.ts).
 */
export default makeScene2D(function* (view) {
  const scene = useScene();
  const vars = scene.variables;
  const theme = (vars.get('theme', null)() as ThemeVars | null) ?? FALLBACK;
  const title = vars.get('title', 'How it works')() as string;
  const points = vars.get('points', ['One', 'Two', 'Three'])() as string[];
  const accent = (vars.get('accent', null)() as string | null) ?? theme.colors.accent;
  const background = (vars.get('background', null)() as string | null) ?? theme.colors.background;
  const duration = vars.get('durationSeconds', 4)() as number;
  const platform = (vars.get('platform', null)() as string | null) ?? undefined;

  const size = scene.getSize();
  const width = size.x;
  const height = size.y;
  const l = frameLayout(width, height, platform);
  const u = l.unit;
  const row = l.direction === 'row';
  const padX = Math.max(l.box.x, 8 * u);
  const contentWidth = width - 2 * padX;
  // Centre of the content box (Motion Canvas puts the origin at the frame centre).
  const centerX = 0;
  const centerY = l.box.y + l.box.height / 2 - height / 2;
  const columnGap = 6 * u;
  const titleWidth = row ? (contentWidth - columnGap) * 0.4 : contentWidth;
  const pointsWidth = row ? contentWidth - columnGap - titleWidth : contentWidth;
  const font = theme.fontFamily;

  view.fill(background);

  const block = createRef<Layout>();
  const titleRef = createRef<Txt>();
  const underline = createRef<Rect>();
  const rows = points.map(() => createRef<Layout>());
  const titleSize = (title.length > 24 ? 8.5 : 10.2) * u;
  const pointSize = (points.some((p) => p.length > 40) ? 5 : 5.9) * u;
  const badge = 6.7 * u;
  const gap = 3 * u;
  const stackGap = 4.8 * u;

  view.add(
    <Layout
      ref={block}
      layout
      direction={row ? 'row' : 'column'}
      gap={row ? columnGap : stackGap}
      width={contentWidth}
      alignItems={row ? 'center' : 'start'}
      x={centerX}
      y={centerY}
    >
      <Layout layout direction="column" gap={stackGap} width={titleWidth} alignItems="start" shrink={0}>
        <Txt
          ref={titleRef}
          text={title}
          width={titleWidth}
          textWrap
          fontFamily={font}
          fontWeight={theme.headingWeight}
          fontSize={titleSize}
          lineHeight={titleSize * 1.08}
          fill={theme.colors.text}
          opacity={0.35}
          x={-2.2 * u}
        />
        <Rect ref={underline} width={4.4 * u} height={1.3 * u} radius={0.65 * u} fill={accent} />
      </Layout>
      <Layout layout direction="column" gap={stackGap} width={pointsWidth} alignItems="start" shrink={0}>
        {points.map((point, i) => (
          <Layout ref={rows[i]} layout direction="row" gap={gap} alignItems="start" opacity={0} x={-5.6 * u} width={pointsWidth}>
            <Rect
              layout
              width={badge}
              height={badge}
              radius={badge / 2}
              fill={accent}
              alignItems="center"
              justifyContent="center"
              shrink={0}
            >
              <Txt text={String(i + 1)} fontFamily={font} fontWeight={800} fontSize={4.1 * u} fill={background} />
            </Rect>
            <Txt
              text={point}
              width={pointsWidth - badge - gap}
              textWrap
              fontFamily={font}
              fontWeight={600}
              fontSize={pointSize}
              lineHeight={pointSize * 1.15}
              fill={theme.colors.mutedText}
            />
          </Layout>
        ))}
      </Layout>
    </Layout>
  );

  // Fit to the safe area: the laid-out block shrinks (never grows) when it is taller than the box.
  const laidOut = block().size();
  const fit = Math.min(1, l.box.height / Math.max(1, laidOut.y), contentWidth / Math.max(1, laidOut.x));
  if (fit < 1) block().scale(fit);

  // Budget: 25% title, 55% points, 20% hold. All tweens finish inside it.
  const titleTime = duration * 0.25;
  const pointsTime = duration * 0.55;
  const holdTime = duration - titleTime - pointsTime;
  const perPoint = pointsTime / Math.max(points.length, 1);

  yield* all(
    titleRef().opacity(1, titleTime * 0.8, easeOutCubic),
    titleRef().x(0, titleTime * 0.8, easeOutCubic),
    underline().width(24 * u, titleTime, easeInOutCubic)
  );
  yield* sequence(
    perPoint,
    ...rows.map((row) =>
      all(row().opacity(1, perPoint * 0.9, easeOutCubic), row().x(0, perPoint * 0.9, easeOutCubic))
    )
  );
  yield* waitFor(holdTime);
});
