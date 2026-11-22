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
 * Layout scales with the output size (designed at 1080x1920, scaled by the
 * smaller of width/1080 and height/1920), text wraps inside the content width,
 * and the first frame already shows the title and its underline so a
 * thumbnail is never blank. Colours and font come from the theme; the
 * `accent` and `background` props override it.
 *
 * Props and theme arrive as project variables (see src/render.ts).
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

  const size = scene.getSize();
  const width = size.x;
  const height = size.y;
  const s = Math.min(width / 1080, height / 1920);
  const contentWidth = width * 0.84;
  const font = theme.fontFamily;

  view.fill(background);

  const titleRef = createRef<Txt>();
  const underline = createRef<Rect>();
  const rows = points.map(() => createRef<Layout>());
  const titleSize = (title.length > 24 ? 92 : 110) * s;
  const pointSize = (points.some((p) => p.length > 40) ? 54 : 64) * s;
  const badge = 72 * s;
  const gap = 32 * s;

  view.add(
    <Layout layout direction="column" gap={52 * s} width={contentWidth} alignItems="start">
      <Txt
        ref={titleRef}
        text={title}
        width={contentWidth}
        textWrap
        fontFamily={font}
        fontWeight={theme.headingWeight}
        fontSize={titleSize}
        lineHeight={titleSize * 1.08}
        fill={theme.colors.text}
        opacity={0.35}
        x={-24 * s}
      />
      <Rect ref={underline} width={48 * s} height={14 * s} radius={7 * s} fill={accent} />
      {points.map((point, i) => (
        <Layout ref={rows[i]} layout direction="row" gap={gap} alignItems="start" opacity={0} x={-60 * s} width={contentWidth}>
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
            <Txt text={String(i + 1)} fontFamily={font} fontWeight={800} fontSize={44 * s} fill={background} />
          </Rect>
          <Txt
            text={point}
            width={contentWidth - badge - gap}
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
  );

  // Budget: 25% title, 55% points, 20% hold. All tweens finish inside it.
  const titleTime = duration * 0.25;
  const pointsTime = duration * 0.55;
  const holdTime = duration - titleTime - pointsTime;
  const perPoint = pointsTime / Math.max(points.length, 1);

  yield* all(
    titleRef().opacity(1, titleTime * 0.8, easeOutCubic),
    titleRef().x(0, titleTime * 0.8, easeOutCubic),
    underline().width(260 * s, titleTime, easeInOutCubic)
  );
  yield* sequence(
    perPoint,
    ...rows.map((row) =>
      all(row().opacity(1, perPoint * 0.9, easeOutCubic), row().x(0, perPoint * 0.9, easeOutCubic))
    )
  );
  yield* waitFor(holdTime);
});
