// Shared state of one `pnpm capture` run: where files go and what was made.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pngToWebp } from './encode.mjs';
import { BUDGETS, emptyManifest, shotKey, stableJson } from './lib.mjs';

export const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname);
export const MANIFEST_PATH = join(REPO_ROOT, 'scripts/capture/assets.json');

export function loadManifest(path = MANIFEST_PATH) {
  if (!existsSync(path)) return emptyManifest();
  const m = JSON.parse(readFileSync(path, 'utf8'));
  m.images ??= {};
  m.videos ??= {};
  return m;
}

export function saveManifest(manifest, path = MANIFEST_PATH) {
  writeFileSync(path, stableJson(manifest));
}

export function createRun(args) {
  const out = resolve(REPO_ROOT, args.out);
  for (const d of ['images', 'videos', 'raw', 'work']) mkdirSync(join(out, d), { recursive: true });
  const results = { images: [], videos: [], notes: [], skipped: [] };
  /** @type {Promise<unknown>[]} */
  const pendingSaves = [];
  const run = {
    args,
    out,
    results,
    log: (line) => console.log(line),
    note: (text) => {
      results.notes.push(text);
      console.log(`  note: ${text}`);
    },
    skip: (what, why) => {
      results.skipped.push({ what, why });
      console.log(`  skipped ${what}: ${why}`);
    },
    /**
     * Encodes the PNGs of one state (full page and/or fold crop) to WebP
     * under images/, with deterministic names, and records them with the
     * docs page and the facts the docs show next to them.
     */
    async saveShots(parts, pngs, meta) {
      const saved = [];
      for (const crop of ['fold', 'full']) {
        if (!pngs[crop]) continue;
        const key = shotKey({ ...parts, crop });
        const file = join(out, 'images', `${key}.webp`);
        const enc = await pngToWebp(pngs[crop], file, { crop });
        const entry = { key, file: relative(REPO_ROOT, file), crop, ...parts, ...meta, capturedOn: new Date().toISOString().slice(0, 10), bytes: enc.bytes, width: enc.width, height: enc.height, quality: enc.quality, sha256: enc.sha256, overBudget: enc.overBudget };
        results.images.push(entry);
        saved.push(entry);
        if (enc.overBudget) run.note(`${key}: ${Math.round(enc.bytes / 1024)} KB, over its ${Math.round(BUDGETS[crop] / 1000)} KB budget at the smallest step`);
      }
      return saved;
    },
    /** Encodes in the background while the browser moves on; `flush()` waits for all of it. */
    async queueShots(parts, pngs, meta) {
      if (pendingSaves.length >= 2) await run.flush(); // at most two encodes at a time (shared machine)
      pendingSaves.push(run.saveShots(parts, pngs, meta));
    },
    async flush() {
      const all = pendingSaves.splice(0);
      await Promise.all(all);
    },
    writeResults() {
      writeFileSync(join(out, 'results.json'), stableJson(results));
    },
  };
  return run;
}
