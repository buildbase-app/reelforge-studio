import React from 'react';
import { Composition, registerRoot } from 'remotion';
import type { KineticTitleProps, ThemeTokens } from '@reelforge/project-schema';
import { KineticTitle } from './KineticTitle';

/**
 * Size, frame rate and duration come from the render request (inputProps
 * `__output`), so one composition serves every project. The defaults below are
 * only used by Remotion Studio previews.
 */
interface RenderInput {
  __output?: { width: number; height: number; fps: number; durationInFrames: number };
}

// Props are validated by @reelforge/project-schema before a render starts, so
// the composition does not declare a Remotion (zod 3) schema of its own.
const KineticTitleEntry: React.FC<Record<string, unknown>> = ({ __output: _ignored, __theme, __platform, ...props }) => (
  <KineticTitle
    {...(props as unknown as KineticTitleProps)}
    theme={(__theme as ThemeTokens | undefined) ?? undefined}
    platform={typeof __platform === 'string' ? __platform : undefined}
  />
);

export const Root: React.FC = () => (
  <>
    <Composition
      id="kinetic-title"
      component={KineticTitleEntry}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={90}
      defaultProps={
        {
          headline: 'Make Reels on your own machine',
          subline: 'Two engines. One timeline.',
        } satisfies KineticTitleProps as Record<string, unknown>
      }
      calculateMetadata={({ props }) => {
        const out = (props as RenderInput).__output;
        return out
          ? {
              width: out.width,
              height: out.height,
              fps: out.fps,
              durationInFrames: out.durationInFrames,
            }
          : {};
      }}
    />
  </>
);

registerRoot(Root);
