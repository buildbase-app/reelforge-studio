import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { KineticTitleProps, SceneMedia, ThemeTokens } from '@reelforge/project-schema';
import { fitText, frameLayout } from '@reelforge/project-schema/layout';
import { BackgroundMedia, Logo } from './Media';

type ThemeLike = Pick<ThemeTokens, 'colors' | 'fontFamily' | 'headingWeight'>;

const FALLBACK: ThemeLike = {
  colors: {
    background: '#0b0b14',
    surface: '#1a1a2b',
    text: '#ffffff',
    mutedText: '#c9c9d6',
    accent: '#ff3d71',
    accent2: '#00d1b2',
  },
  fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif',
  headingWeight: 800,
};

/**
 * Template "kinetic-title": the headline springs in word by word, an accent
 * bar sweeps under it, the subline fades up, and everything exits in the last
 * 15% of the scene so the cut to the next scene is clean. No background
 * glow and no overshoot (design rules in AGENTS.md).
 *
 * Colours, font family and heading weight come from the project theme; the
 * `accent` and `background` props override it per scene. The first frame
 * already shows a faint headline and the accent bar, so
 * thumbnails are never blank.
 *
 * Any size (#287): sizes are multiples of the layout unit (1 % of the shorter
 * side), the text stays inside the content safe area of `frameLayout` (title
 * safe, plus the social ui zone on tall frames), and the headline size is the
 * largest that fits its box (`fitText`, measured with the browser's canvas
 * text metrics in the theme font, 4.5 to 10.5 units). On landscape frames the
 * line length is capped.
 *
 * Optional `media` (#299): a background image or video under a dim layer of
 * the background colour, fitted contain / cover / blur-fill; `logo`: an image
 * in a corner of the content safe area (Media.tsx).
 */

const LINE_HEIGHT = 1.05;
const WORD_GAP_EM = 0.28;
const LETTER_SPACING_EM = -0.02;
/** The whole title pushes in to this scale; fit the text to the box divided by it. */
const PUSH = 1.04;

/** Text width at 1 px font size, from the browser's canvas text metrics. */
function canvasMeasure(fontFamily: string, weight: number): (s: string) => number {
  const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!ctx) return (s) => s.length * 0.6;
  ctx.font = `${weight} 100px ${fontFamily}`;
  return (s) => (ctx.measureText(s).width + LETTER_SPACING_EM * 100 * s.length) / 100;
}

export const KineticTitle: React.FC<KineticTitleProps & { theme?: ThemeLike; platform?: string; assets?: Record<string, SceneMedia> }> = ({
  headline,
  subline,
  accent: accentProp,
  background: backgroundProp,
  media,
  logo,
  theme = FALLBACK,
  platform,
  assets = {},
}) => {
  const accent = accentProp ?? theme.colors.accent;
  const background = backgroundProp ?? theme.colors.background;
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const layout = frameLayout(width, height, platform);
  const { unit: u, box } = layout;
  const padX = Math.max(box.x, 9 * u);
  const contentWidth = Math.min(width - 2 * padX, layout.direction === 'row' ? 150 * u : Infinity);
  const sublineSize = Math.round(layout.type.caption);
  const words = headline.split(/\s+/).filter(Boolean);
  const stagger = Math.max(2, Math.round(fps * 0.08));
  const exitStart = Math.round(durationInFrames * 0.85);

  const exit = interpolate(frame, [exitStart, durationInFrames - 1], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });

  const barIn = 0.15 + 0.85 * spring({ frame: frame - words.length * stagger, fps, config: { damping: 200 } });
  const sublineIn = interpolate(
    frame,
    [words.length * stagger + fps * 0.2, words.length * stagger + fps * 0.6],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const push = interpolate(frame, [0, durationInFrames], [1, PUSH]);
  // Room the bar and the subline take below the headline (about 3 lines of subline).
  const below = 5 * u + (subline ? 4 * u + sublineSize * 1.3 * 3 : 0);
  const fit = useMemo(
    () =>
      fitText({
        text: headline,
        measure: canvasMeasure(theme.fontFamily, theme.headingWeight),
        maxWidth: contentWidth / PUSH,
        maxHeight: (box.height - below) / PUSH,
        min: layout.type.displayMin,
        max: layout.type.display,
        lineHeight: LINE_HEIGHT,
        wordGapEm: WORD_GAP_EM,
      }),
    [headline, theme.fontFamily, theme.headingWeight, contentWidth, box.height, below, layout.type.display, layout.type.displayMin]
  );
  const fontSize = fit.fontSize;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: background,
        justifyContent: 'center',
        paddingTop: box.y,
        paddingBottom: height - box.y - box.height,
        paddingLeft: padX,
        paddingRight: padX,
        fontFamily: theme.fontFamily,
        overflow: 'hidden',
      }}
    >
      {media ? (
        <>
          <BackgroundMedia media={media} assets={assets} unit={u} />
          {media.dim > 0 ? <AbsoluteFill style={{ backgroundColor: background, opacity: media.dim }} /> : null}
        </>
      ) : null}
      <div
        style={{
          position: 'relative',
          width: contentWidth,
          opacity: 1 - exit,
          // A slow push for the whole scene, so a held title never reads as a frozen frame.
          transform: `translateY(${-exit * 8 * u}px) scale(${push})`,
          transformOrigin: 'left center',
        }}
      >
        <h1
          style={{
            margin: 0,
            color: theme.colors.text,
            fontSize,
            lineHeight: LINE_HEIGHT,
            fontWeight: theme.headingWeight,
            letterSpacing: fontSize * LETTER_SPACING_EM,
            display: 'flex',
            flexWrap: 'wrap',
            columnGap: fontSize * WORD_GAP_EM,
          }}
        >
          {words.map((word, i) => {
            const s = spring({ frame: frame - i * stagger, fps, config: { damping: 200 } });
            return (
              <span
                key={`${word}-${i}`}
                style={{
                  display: 'inline-block',
                  opacity: 0.35 + 0.65 * Math.min(1, s * 1.5),
                  transform: `translateY(${(1 - s) * fontSize * 0.6}px) scale(${0.85 + 0.15 * s})`,
                }}
              >
                {word}
              </span>
            );
          })}
        </h1>
        <div
          style={{
            marginTop: 3.5 * u,
            height: Math.round(1.4 * u),
            width: `${barIn * 45}%`,
            borderRadius: fontSize,
            backgroundColor: accent,
          }}
        />
        {subline ? (
          <p
            style={{
              marginTop: 4 * u,
              marginBottom: 0,
              color: theme.colors.mutedText,
              fontSize: sublineSize,
              fontWeight: 500,
              opacity: sublineIn,
              transform: `translateY(${(1 - sublineIn) * 2.4 * u}px)`,
            }}
          >
            {subline}
          </p>
        ) : null}
      </div>
      {logo ? <Logo logo={logo} assets={assets} unit={u} box={box} width={width} height={height} /> : null}
    </AbsoluteFill>
  );
};
