/**
 * Pre-build the engines' browser bundles next to their packages
 * (packages/engine-remotion/.prebuilt, packages/engine-motion-canvas/.prebuilt).
 * Run at image build time (Dockerfile), or locally with `pnpm prebuild`.
 *
 * At render time each engine uses its pre-built bundle when the bundle's source
 * hash matches the sources, so a production container never runs Webpack or
 * Vite and needs no writable bundle directory (read-only root filesystem). If
 * the sources change, the engine builds into the cache directory as before.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prebuildMotionCanvas } from '@reelforge/engine-motion-canvas';
import { prebuildCompositions } from '@reelforge/engine-remotion';

const scratch = mkdtempSync(join(tmpdir(), 'reelforge-prebuild-'));
try {
  const started = Date.now();
  console.log(`[prebuild] remotion: ${await prebuildCompositions()}`);
  console.log(`[prebuild] motion-canvas: ${await prebuildMotionCanvas(join(scratch, 'vite'))}`);
  console.log(`[prebuild] done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
