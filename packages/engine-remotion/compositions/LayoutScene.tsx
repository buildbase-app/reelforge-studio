import React, { useLayoutEffect, useRef, useState } from 'react';
import { cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SceneMedia } from '@reelforge/project-schema';
import { FIT_TEXT_SCRIPT } from '@reelforge/project-schema/layout';
import { mediaUrlAt } from '@reelforge/project-schema/media';

/**
 * Template "remotion-layout" (#287): split screen, picture-in-picture, grid,
 * full frame and lower third, with the same props as html-layout and
 * hyperframes-layout.
 *
 * The markup is built on the Node side by `layoutSceneDom`, the builder the
 * html and HyperFrames engines use, from the same geometry functions
 * (`@reelforge/project-schema/layout`), so the three engines put every pane,
 * text block and lower third on the same pixels. This component draws it and
 * makes it frame-pure, the way the html engine does:
 *
 * - before the first frame: fonts loaded, every picture decoded, and the text
 *   shrunk to fit its box (`FIT_TEXT_SCRIPT`, the html engine's fit-to-box);
 * - on every frame: each CSS animation of the scene is paused at
 *   `frame / fps` (Web Animations `currentTime`) and its state baked into
 *   inline styles (`bakeAnimations`), and each video pane shows
 *   picture `frame` of its clip (staged by src/render.ts as one picture per
 *   output frame on the render's loopback asset origin). The frame waits
 *   (`delayRender`) until those pictures are decoded.
 *
 * Remotion renders frames in parallel tabs and in any order; nothing here
 * depends on the previous frame, so a frame-range chunk shows the same pixels
 * as a whole render.
 */

export interface LayoutSceneInput {
  /** `layoutSceneDom(...).html`: pictures carry their staged URL; video pictures also `data-rf-video="<key>"`. */
  html: string;
  /** `layoutSceneDom(...).css`. */
  css: string;
  /** Page-level CSS: theme and layout custom properties (`domThemeCss`). */
  rootCss: string;
}

/** Same page rules as the html engine's document (engine-html/src/page.ts). */
const pageCss = (width: number, height: number) =>
  `#rf-root{position:relative;width:${width}px;height:${height}px;overflow:hidden;box-sizing:border-box;background:var(--rf-bg);color:var(--rf-text);font-family:var(--rf-font)}` +
  '#rf-root,#rf-root *{box-sizing:border-box}';

/** The fit-to-box script as a function (a constant from layout.ts, not input). */
const fitText = new Function(`return ${FIT_TEXT_SCRIPT}`) as () => number;

/** Inline styles of elements whose animation state is baked in, as they were before (null: no style attribute). */
const baked = new Map<HTMLElement, string | null>();

/**
 * Every CSS animation of the scene paused at `ms`, then its state written into
 * the element's inline style (`animation: none` with the computed opacity and
 * transform). Remotion moves the composition's DOM into its own wrapper after
 * the first frame is ready, and a moved element restarts its CSS animations;
 * baked styles do not move in time. The previous frame's baking is undone
 * first, so the CSS animations come back and are seeked afresh.
 */
function bakeAnimations(root: HTMLElement, ms: number): void {
  for (const [e, style] of baked) {
    if (style === null) e.removeAttribute('style');
    else e.setAttribute('style', style);
  }
  baked.clear();
  const targets = new Set<HTMLElement>();
  for (const a of root.getAnimations({ subtree: true })) {
    a.pause();
    a.currentTime = ms;
    const t = (a.effect as KeyframeEffect | null)?.target;
    if (t instanceof HTMLElement) targets.add(t);
  }
  const states = [...targets].map((t) => {
    const cs = getComputedStyle(t);
    return [t, cs.opacity, cs.transform] as const;
  });
  for (const [t, opacity, transform] of states) {
    baked.set(t, t.getAttribute('style'));
    t.style.animation = 'none';
    t.style.opacity = opacity;
    t.style.transform = transform;
  }
}

async function decodePictures(root: HTMLElement): Promise<string[]> {
  const imgs = [...root.querySelectorAll('img')];
  await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
  return imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src);
}

export const LayoutScene: React.FC<LayoutSceneInput & { assets: Record<string, SceneMedia> }> = ({ html, css, rootCss, assets }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const root = useRef<HTMLDivElement>(null);
  const prepared = useRef<Promise<void> | null>(null);
  // Held from the first render until the first frame is ready (fonts, pictures, text fit).
  const [first] = useState(() => delayRender('remotion-layout: fonts, pictures and text fit'));
  const firstDone = useRef(false);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const handle = delayRender(`remotion-layout: frame ${frame}`);
    prepared.current ??= (async () => {
      await document.fonts.ready;
      const broken = await decodePictures(el);
      if (broken.length) throw new Error(`picture(s) did not load: ${broken.slice(0, 3).join(', ')}`);
      fitText();
    })();
    let live = true;
    prepared.current
      .then(async () => {
        // A newer frame took over this element; its own effect draws that frame.
        if (!live) return continueRender(handle);
        bakeAnimations(el, (frame * 1000) / fps);
        const loads: Array<Promise<void>> = [];
        for (const img of el.querySelectorAll<HTMLImageElement>('img[data-rf-video]')) {
          const m = assets[img.dataset.rfVideo ?? ''];
          if (!m) throw new Error(`video "${img.dataset.rfVideo}" was not staged`);
          const next = mediaUrlAt(m, frame);
          if (img.src !== next) img.src = next;
          loads.push(img.decode().catch(() => undefined));
        }
        await Promise.all(loads);
        const missing = [...el.querySelectorAll<HTMLImageElement>('img[data-rf-video]')].filter((i) => !i.complete || i.naturalWidth === 0);
        if (missing.length) throw new Error(`video picture for frame ${frame} did not load`);
        const lab = el.querySelector('.rfl-label');
        continueRender(handle);
        if (!firstDone.current) {
          firstDone.current = true;
          continueRender(first);
        }
      })
      .catch((e: unknown) => cancelRender(e instanceof Error ? e : new Error(String(e))));
    return () => {
      live = false;
    };
  }, [frame, fps, assets, first]);

  return (
    <>
      <style>{rootCss + pageCss(width, height) + css}</style>
      <div id="rf-root" ref={root} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
};
