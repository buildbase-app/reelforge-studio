/**
 * Pre-build the engines' browser bundles next to their packages
 * (packages/engine-motion-canvas/.prebuilt, packages/engine-remotion/.prebuilt).
 *
 *   pnpm prebuild:engines                           both, locally (Remotion from the workspace or RENDERWELD_REMOTION_HOME)
 *   tsx apps/server/src/prebuild.ts motion-canvas   the official image (Dockerfile): it ships no Remotion (#783)
 *   tsx apps/server/src/prebuild.ts remotion        the customer's Remotion add-on image (deployment/remotion/Dockerfile)
 *
 * At render time each engine uses its pre-built bundle when the bundle's source
 * hash matches the sources, so a production container never runs Webpack or
 * Vite and needs no writable bundle directory (read-only root filesystem). If
 * the sources change, the engine builds into the cache directory as before.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENGINES = ['motion-canvas', 'remotion'] as const;
const asked = process.argv.slice(2);
const bad = asked.filter((a) => !(ENGINES as readonly string[]).includes(a));
if (bad.length) {
  console.error(`[prebuild] unknown engine ${bad.join(', ')}; expected ${ENGINES.join(' or ')}`);
  process.exit(2);
}
const engines = asked.length ? asked : [...ENGINES];

const scratch = mkdtempSync(join(tmpdir(), 'reelforge-prebuild-'));
try {
  const started = Date.now();
  if (engines.includes('motion-canvas')) {
    const { prebuildMotionCanvas } = await import('@renderweld/engine-motion-canvas');
    console.log(`[prebuild] motion-canvas: ${await prebuildMotionCanvas(join(scratch, 'vite'))}`);
  }
  if (engines.includes('remotion')) {
    const { prebuildCompositions } = await import('@renderweld/engine-remotion');
    console.log(`[prebuild] remotion: ${await prebuildCompositions()}`);
  }
  console.log(`[prebuild] done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
