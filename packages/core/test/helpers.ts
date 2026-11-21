import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '@reelforge/media-pipeline';
import { TEMPLATES, type RenderScene } from '@reelforge/project-schema';
import type { EnginePlugin, EngineRenderContext, ClipResult } from '../src/index';

export function tempDir(prefix = 'reelforge-core-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A fake engine for fast tests: FFmpeg's colour source in the theme's
 * background colour (no browser). Uses the real template catalog so manifest
 * validation behaves as in production.
 */
export function fakeEngine(id: string, opts: { delayPerFrameMs?: number; fail?: boolean } = {}): EnginePlugin & { renders: RenderScene[] } {
  const renders: RenderScene[] = [];
  return {
    id,
    displayName: `fake ${id}`,
    acceptsSource: id === 'html' || id === 'hyperframes',
    renders,
    version: () => '0.0.0-test',
    availability: () => ({ ok: true }),
    templates: () =>
      Object.entries(TEMPLATES)
        .filter(([, t]) => t.engine === id)
        .map(([tid, t]) => ({ ...t, id: tid })),
    async render(scene: RenderScene, ctx: EngineRenderContext): Promise<ClipResult> {
      renders.push(scene);
      const started = Date.now();
      if (opts.fail) throw new Error('fake engine failure');
      for (let f = 1; f <= scene.durationFrames; f++) {
        if (ctx.signal.aborted) throw new Error('cancelled');
        if (opts.delayPerFrameMs) await new Promise((r) => setTimeout(r, opts.delayPerFrameMs));
        if (f % 10 === 0 || f === scene.durationFrames) ctx.progress(f, scene.durationFrames);
      }
      const colour = ctx.theme.colors.background.replace('#', '0x');
      await run(
        ctx.tools.ffmpeg,
        ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:size=${ctx.output.width}x${ctx.output.height}:rate=${ctx.output.fps}`,
          '-frames:v', String(scene.durationFrames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ctx.out],
        'fake-render',
        { signal: ctx.signal }
      );
      return { file: ctx.out, frames: scene.durationFrames, engineVersion: '0.0.0-test', millis: Date.now() - started };
    },
  };
}

export async function makeTone(file: string, seconds: number) {
  const { resolveTools } = await import('@reelforge/media-pipeline');
  await run(resolveTools().ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'libmp3lame', file], 'fixture');
}
