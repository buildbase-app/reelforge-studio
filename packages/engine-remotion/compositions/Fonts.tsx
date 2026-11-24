import React, { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender } from 'remotion';
import type { FontFaceSpec } from '@reelforge/project-schema';
import { FONT_LOAD_TIMEOUT_MS, loadFontFaces } from '@reelforge/project-schema/media';

/**
 * Fonts before frames (#303): the scene's font faces (project font assets and
 * bundled fonts, from the render's asset origin) are added with the FontFace
 * API, and nothing is rendered until all have loaded, so text is measured
 * (fitText) and drawn in the right font on every frame. A face that fails
 * cancels the render with its name instead of falling back silently.
 */
export const FontGate: React.FC<{ fonts: FontFaceSpec[]; children: React.ReactNode }> = ({ fonts, children }) => {
  const [handle] = useState(() => (fonts.length ? delayRender('RenderWeld fonts', { timeoutInMilliseconds: FONT_LOAD_TIMEOUT_MS + 5000 }) : null));
  const [ready, setReady] = useState(fonts.length === 0);
  useEffect(() => {
    if (handle === null) return;
    loadFontFaces(fonts).then(
      () => {
        setReady(true);
        continueRender(handle);
      },
      (e: Error) => cancelRender(e)
    );
  }, [fonts, handle]);
  return ready ? <>{children}</> : null;
};
