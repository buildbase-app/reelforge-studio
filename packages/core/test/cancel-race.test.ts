import { BUILTIN_THEMES, type TimelineScene } from '@renderweld/project-schema';
import { resolveTools } from '@renderweld/media-pipeline';
import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '../src/index';
import { renderSceneClip } from '../src/render';
import { fakeEngine, tempDir } from './helpers';

/**
 * #345 (OPS-05): a cancel that lands after the per-scene check but before the
 * engine is called must stop the scene. An engine that only listens for the
 * abort event never hears an abort that already happened, so the pipeline must
 * not call it with an aborted signal.
 */
describe('cancel before the engine is called (#345)', () => {
  it('never calls the engine with a signal that is already aborted', async () => {
    const engine = fakeEngine('remotion');
    const registry = new PluginRegistry().registerEngine(engine);
    const { dir, cleanup } = tempDir();
    try {
      const ac = new AbortController();
      ac.abort();
      const scene = { id: 's1', engine: 'remotion', template: 'kinetic-title', props: { headline: 'Hi' }, assets: [], durationFrames: 30, startFrame: 0, endFrame: 30 } as unknown as TimelineScene;
      const run = renderSceneClip({
        runId: 'r1',
        scene,
        output: { width: 64, height: 112, fps: 30 } as never,
        theme: BUILTIN_THEMES[0]!.tokens,
        assets: new Map(),
        registry,
        tools: resolveTools(),
        cacheDir: dir,
        out: `${dir}/s1.mp4`,
        workDir: `${dir}/work`,
        signal: ac.signal,
        log: () => undefined,
        progress: () => undefined,
      });
      await expect(run).rejects.toThrow(/cancelled/);
      expect(engine.renders).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
