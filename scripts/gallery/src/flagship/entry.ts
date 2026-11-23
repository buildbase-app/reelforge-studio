import type { GalleryEntry } from '../catalog/build';
import { PALETTES } from '../catalog/palettes';
import { themeFor } from '../catalog/kit';
import type { FlagshipReel } from './kit';

/** A flagship reel as a gallery entry: one HyperFrames scene in a v0.2 manifest. */
export function flagshipEntry(reel: FlagshipReel): GalleryEntry {
  const pal = PALETTES.midnight!;
  const manifest = {
    schemaVersion: '0.2',
    projectId: reel.slug,
    title: reel.title,
    brief: { title: reel.title, goal: reel.prompt.slice(0, 2000), platform: 'instagram-reels', language: 'en', targetSeconds: reel.duration },
    theme: themeFor(pal),
    output: { width: 1080, height: 1920, fps: 30, format: 'mp4' },
    scenes: [{ id: 's1-story', engine: 'hyperframes', durationSeconds: reel.duration, html: reel.html, notes: 'agent-written hyperframes scene (flagship, canvas + DOM captions)' }],
  };
  return {
    gallery: {
      slug: reel.slug,
      title: reel.title,
      description: reel.description,
      category: reel.category,
      tags: reel.tags,
      prompt: reel.prompt,
      palette: pal.id,
      theme: pal.pure ? pal.base : `${pal.base} + inline tokens (${pal.name})`,
      engines: ['hyperframes'],
      featured: true,
      music: reel.music ?? null,
      durationSeconds: reel.duration,
    },
    manifest,
  } as GalleryEntry;
}
