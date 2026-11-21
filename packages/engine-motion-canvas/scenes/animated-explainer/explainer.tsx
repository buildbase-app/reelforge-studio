import { Layout, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import {
  all,
  createRef,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  sequence,
  useScene,
  waitFor,
} from '@motion-canvas/core';

/**
 * Template "animated-explainer": a title, then up to four points revealed one
 * by one, then a hold. Every timing is derived from `durationSeconds` so the
 * scene lasts exactly as long as the manifest says.
 *
 * Props arrive as project variables (see src/runtime.ts).
 */
export default makeScene2D(function* (view) {
  const vars = useScene().variables;
  const title = vars.get('title', 'How it works')();
  const points = vars.get('points', ['One', 'Two', 'Three'])() as string[];
  const accent = vars.get('accent', '#00d1b2')();
  const background = vars.get('background', '#0b0b14')();
  const duration = vars.get('durationSeconds', 4)() as number;

  view.fill(background);

  const titleRef = createRef<Txt>();
  const underline = createRef<Rect>();
  const rows = points.map(() => createRef<Layout>());

  view.add(
    <Layout layout direction="column" gap={56} width={880} alignItems="start" y={-40}>
      <Txt
        ref={titleRef}
        text={title}
        fontFamily="sans-serif"
        fontWeight={800}
        fontSize={110}
        fill="#ffffff"
        opacity={0}
        y={40}
      />
      <Rect ref={underline} width={0} height={14} radius={7} fill={accent} />
      {points.map((point, i) => (
        <Layout
          ref={rows[i]}
          layout
          direction="row"
          gap={32}
          alignItems="center"
          opacity={0}
          x={-60}
        >
          <Rect
            layout
            width={72}
            height={72}
            radius={36}
            fill={accent}
            alignItems="center"
            justifyContent="center"
          >
            <Txt
              text={String(i + 1)}
              fontFamily="sans-serif"
              fontWeight={800}
              fontSize={44}
              fill={background}
            />
          </Rect>
          <Txt
            text={point}
            fontFamily="sans-serif"
            fontWeight={600}
            fontSize={64}
            fill="#e8e8f0"
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
    titleRef().y(0, titleTime * 0.8, easeOutCubic),
    underline().width(260, titleTime, easeInOutCubic)
  );
  yield* sequence(
    perPoint,
    ...rows.map((row) =>
      all(row().opacity(1, perPoint * 0.9, easeOutCubic), row().x(0, perPoint * 0.9, easeOutBack))
    )
  );
  yield* waitFor(holdTime);
});
