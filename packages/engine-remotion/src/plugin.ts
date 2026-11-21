import { existsSync } from 'node:fs';
import { browserVersion, type EnginePlugin } from '@reelforge/core';
import { TEMPLATES } from '@reelforge/project-schema';
import { remotionVersion, renderRemotionScene } from './render';

export interface RemotionEngineOptions {
  /** Chrome Headless Shell binary; defaults to REELFORGE_CHROMIUM_PATH. */
  browserExecutable?: string;
  /** Parallel browser tabs per render. */
  concurrency?: number;
}

/** The Remotion engine as a plugin (templates: kinetic-title). */
export function remotionEngine(opts: RemotionEngineOptions = {}): EnginePlugin {
  const browser = () => opts.browserExecutable ?? process.env.REELFORGE_CHROMIUM_PATH;
  return {
    id: 'remotion',
    displayName: 'Remotion',
    acceptsSource: false,
    version: remotionVersion,
    templates: () =>
      Object.entries(TEMPLATES)
        .filter(([, t]) => t.engine === 'remotion')
        .map(([id, t]) => ({ ...t, id })),
    availability() {
      const b = browser();
      if (b && existsSync(b)) return { ok: true };
      return {
        ok: false,
        reason:
          'no browser: set REELFORGE_CHROMIUM_PATH to a Chrome Headless Shell binary (the server does not let Remotion download one at render time)',
      };
    },
    async render(scene, ctx) {
      const res = await renderRemotionScene({
        scene,
        output: ctx.output,
        theme: ctx.theme,
        out: ctx.out,
        cacheDir: ctx.cacheDir,
        browserExecutable: browser(),
        concurrency: opts.concurrency,
        signal: ctx.signal,
        onProgress: ctx.progress,
      });
      return { file: res.out, frames: res.frames, engineVersion: res.engineVersion, browserVersion: browserVersion(browser()), millis: res.millis };
    },
  };
}
