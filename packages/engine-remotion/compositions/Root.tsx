import React from 'react';
import { Composition, registerRoot } from 'remotion';
import type { FontFaceSpec, KineticTitleProps, SceneMedia, ThemeTokens } from '@renderweld/project-schema';
import { FontGate } from './Fonts';
import { KineticTitle } from './KineticTitle';
import { LayoutScene, type LayoutSceneInput } from './LayoutScene';

/**
 * Size, frame rate and duration come from the render request (inputProps
 * `__output`), so one composition serves every project. The defaults below are
 * only used by Remotion Studio previews.
 */
interface RenderInput {
  __output?: { width: number; height: number; fps: number; durationInFrames: number };
}

// Props are validated by @renderweld/project-schema before a render starts, so
// the composition does not declare a Remotion (zod 3) schema of its own.
// Remotion merges a composition's defaultProps into every render's inputProps, so placeholder text there would
// show in customer videos whenever a scene leaves an optional prop out (#320). The placeholder is used only by
// Remotion Studio previews, which have no render request (`__output`).
const KINETIC_TITLE_PREVIEW: KineticTitleProps = {
  headline: 'Make Reels on your own machine',
  subline: 'Two engines. One timeline.',
};

const KineticTitleEntry: React.FC<Record<string, unknown>> = ({ __output, __theme, __platform, __assets, __fonts, ...props }) => (
  <FontGate fonts={(__fonts as FontFaceSpec[] | undefined) ?? []}>
    <KineticTitle
      {...(__output ? (props as unknown as KineticTitleProps) : { ...KINETIC_TITLE_PREVIEW, ...(props as Partial<KineticTitleProps>) })}
      theme={(__theme as ThemeTokens | undefined) ?? undefined}
      platform={typeof __platform === 'string' ? __platform : undefined}
      assets={(__assets as Record<string, SceneMedia> | undefined) ?? {}}
    />
  </FontGate>
);

// remotion-layout (#287): the markup comes ready-built from src/render.ts (`__layout`), with staged media in `__assets`.
const LayoutEntry: React.FC<Record<string, unknown>> = ({ __layout, __assets }) => {
  const layout = __layout as LayoutSceneInput | undefined;
  if (!layout) throw new Error('remotion-layout renders only through the RenderWeld renderer (no __layout input)');
  return <LayoutScene {...layout} assets={(__assets as Record<string, SceneMedia> | undefined) ?? {}} />;
};

const metadata = ({ props }: { props: Record<string, unknown> }) => {
  const out = (props as RenderInput).__output;
  return out ? { width: out.width, height: out.height, fps: out.fps, durationInFrames: out.durationInFrames } : {};
};

export const Root: React.FC = () => (
  <>
    <Composition
      id="kinetic-title"
      component={KineticTitleEntry}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={90}
      defaultProps={{}}
      calculateMetadata={metadata}
    />
    <Composition id="remotion-layout" component={LayoutEntry} width={1920} height={1080} fps={30} durationInFrames={60} defaultProps={{}} calculateMetadata={metadata} />
  </>
);

registerRoot(Root);
