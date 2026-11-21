import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { KineticTitleProps } from '@reelforge/project-schema';

/**
 * Template "kinetic-title": the headline springs in word by word, an accent
 * bar sweeps under it, the subline fades up, and everything exits in the last
 * 15% of the scene so the cut to the next scene is clean.
 *
 * Uses the system sans-serif stack on purpose: no font files are bundled until
 * their licenses are recorded (research/LICENSING_AND_COSTS.md §4).
 */
export const KineticTitle: React.FC<KineticTitleProps> = ({
  headline,
  subline,
  accent = '#ff3d71',
  background = '#0b0b14',
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width } = useVideoConfig();
  const words = headline.split(/\s+/).filter(Boolean);
  const stagger = Math.max(2, Math.round(fps * 0.08));
  const exitStart = Math.round(durationInFrames * 0.85);

  const exit = interpolate(frame, [exitStart, durationInFrames - 1], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });

  const barIn = spring({ frame: frame - words.length * stagger, fps, config: { damping: 200 } });
  const sublineIn = interpolate(
    frame,
    [words.length * stagger + fps * 0.2, words.length * stagger + fps * 0.6],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const fontSize = Math.round(width * 0.105);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: background,
        justifyContent: 'center',
        padding: width * 0.09,
        fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif',
      }}
    >
      <div
        style={{
          opacity: 1 - exit,
          transform: `translateY(${-exit * 80}px)`,
        }}
      >
        <h1
          style={{
            margin: 0,
            color: '#ffffff',
            fontSize,
            lineHeight: 1.05,
            fontWeight: 800,
            letterSpacing: -fontSize * 0.02,
            display: 'flex',
            flexWrap: 'wrap',
            columnGap: fontSize * 0.28,
          }}
        >
          {words.map((word, i) => {
            const s = spring({ frame: frame - i * stagger, fps, config: { damping: 14, mass: 0.6 } });
            return (
              <span
                key={`${word}-${i}`}
                style={{
                  display: 'inline-block',
                  opacity: Math.min(1, s * 1.5),
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
            marginTop: fontSize * 0.35,
            height: Math.round(fontSize * 0.14),
            width: `${barIn * 45}%`,
            borderRadius: fontSize,
            backgroundColor: accent,
          }}
        />
        {subline ? (
          <p
            style={{
              marginTop: fontSize * 0.4,
              marginBottom: 0,
              color: '#c9c9d6',
              fontSize: Math.round(fontSize * 0.45),
              fontWeight: 500,
              opacity: sublineIn,
              transform: `translateY(${(1 - sublineIn) * 24}px)`,
            }}
          >
            {subline}
          </p>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
