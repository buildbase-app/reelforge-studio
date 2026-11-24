import { chromiumSandbox, type EnginePlugin } from '@reelforge/core';
import { PipelineError } from '@reelforge/media-pipeline';
import { TEMPLATES } from '@reelforge/project-schema';
import { motionCanvasVersion, renderMotionCanvasScene, resolveBrowser } from './render';

export interface MotionCanvasEngineOptions {
  /** Chromium binary; defaults to REELFORGE_CHROMIUM_PATH, then Playwright's default. */
  browserExecutable?: string;
}

/** The Motion Canvas engine as a plugin (templates: animated-explainer, motion-canvas-layout). */
export function motionCanvasEngine(opts: MotionCanvasEngineOptions = {}): EnginePlugin {
  return {
    id: 'motion-canvas',
    displayName: 'Motion Canvas',
    acceptsSource: false,
    version: motionCanvasVersion,
    templates: () =>
      Object.entries(TEMPLATES)
        .filter(([, t]) => t.engine === 'motion-canvas')
        .map(([id, t]) => ({ ...t, id })),
    browserSandbox: () => chromiumSandbox(),
    availability() {
      try {
        resolveBrowser(opts.browserExecutable);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e instanceof PipelineError ? e.message : String(e) };
      }
    },
    async render(scene, ctx) {
      const res = await renderMotionCanvasScene({
        scene,
        output: ctx.output,
        theme: ctx.theme,
        ...(ctx.platform ? { platform: ctx.platform } : {}),
        out: ctx.out,
        cacheDir: ctx.cacheDir,
        ffmpeg: ctx.tools.ffmpeg,
        browserExecutable: opts.browserExecutable,
        signal: ctx.signal,
        onProgress: ctx.progress,
        assets: ctx.assets,
        tools: ctx.tools,
        workDir: ctx.workDir,
        log: ctx.log,
      });
      return { file: res.out, frames: res.frames, engineVersion: res.engineVersion, browserVersion: res.browser, millis: res.millis };
    },
  };
}
