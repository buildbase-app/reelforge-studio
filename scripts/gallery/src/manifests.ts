/**
 * `pnpm gallery build`: writes examples/gallery/<slug>.json from the catalog
 * (src/catalog), validating every manifest with the same schema the server
 * uses, and removes files for reels that left the catalog. The JSON files are
 * committed: they are what `pnpm gallery render` sends to the studio.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProject } from '@reelforge/project-schema';
import type { GalleryEntry } from './catalog/build';

export function stableJson(v: unknown): string {
  return JSON.stringify(v, null, 2) + '\n';
}

/** sha256 of the manifest JSON (what the gallery records as manifestHash). */
export function manifestHash(manifest: unknown): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function validateEntry(entry: GalleryEntry): string[] {
  const r = parseProject(entry.manifest);
  const problems: string[] = [];
  if (!r.ok) problems.push(...r.issues.map((i) => `${i.path}: ${i.message}`));
  else {
    if (r.migratedFrom) problems.push(`manifest migrated from ${r.migratedFrom}`);
    const secs = entry.gallery.durationSeconds;
    if (secs < 8 || secs > 25) problems.push(`duration ${secs}s outside 8-25 s`);
  }
  if (!entry.gallery.prompt || entry.gallery.prompt.length < 40) problems.push('prompt missing or too short');
  return problems;
}

export function writeEntries(entries: GalleryEntry[], dir: string): { written: number; unchanged: number; removed: string[] } {
  mkdirSync(dir, { recursive: true });
  let written = 0;
  let unchanged = 0;
  const keep = new Set<string>();
  for (const e of entries) {
    const problems = validateEntry(e);
    if (problems.length) throw new Error(`${e.gallery.slug}: ${problems.join('; ')}`);
    const file = join(dir, `${e.gallery.slug}.json`);
    keep.add(`${e.gallery.slug}.json`);
    const json = stableJson(e);
    let old = '';
    try {
      old = readFileSync(file, 'utf8');
    } catch {
      /* new */
    }
    if (old === json) unchanged++;
    else {
      writeFileSync(file, json);
      written++;
    }
  }
  const removed = readdirSync(dir).filter((f) => f.endsWith('.json') && !keep.has(f));
  for (const f of removed) rmSync(join(dir, f));
  return { written, unchanged, removed };
}

export function readEntries(dir: string, slugs?: string[]): GalleryEntry[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const want = slugs?.length ? new Set(slugs) : null;
  return files
    .filter((f) => !want || want.has(f.replace(/\.json$/, '')))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as GalleryEntry);
}
