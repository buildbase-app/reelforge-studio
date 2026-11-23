import { buildEntry, type GalleryEntry, type ReelSpec } from './build';
import { resetCounters } from './kit';
import { BUSINESS } from './reels-business';
import { KNOWLEDGE } from './reels-knowledge';
import { LIFESTYLE } from './reels-lifestyle';

/** Every showcase reel spec, in gallery order. */
export const REELS: ReelSpec[] = [...BUSINESS, ...KNOWLEDGE, ...LIFESTYLE];

export function buildAll(): GalleryEntry[] {
  resetCounters();
  const seen = new Set<string>();
  return REELS.map((spec) => {
    if (seen.has(spec.slug)) throw new Error(`duplicate slug ${spec.slug}`);
    seen.add(spec.slug);
    return buildEntry(spec);
  });
}
