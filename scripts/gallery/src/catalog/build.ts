/**
 * Reel specs -> gallery entries. A gallery entry (examples/gallery/<slug>.json)
 * is `{ gallery, manifest }`: `manifest` is a plain v0.2 project manifest that
 * any agent can send to create_project; `gallery` holds what the showcase
 * needs on top (category, tags, the prompt the agent was given, music).
 */
import { CANVAS_DESIGNS, type CanvasDesignName } from './canvas';
import { DESIGNS, type DesignName } from './designs';
import { hashSeed, themeFor, type Engine, type SceneCtx, type Transition } from './kit';
import { PALETTES, type PaletteId } from './palettes';

export type MusicId = 'pulse' | 'lofi' | 'drive' | 'ambient' | 'bright' | 'stomp';

export type SceneSpec =
  | { kind: 'template'; engine: Engine; template: string; dur: number; props: Record<string, unknown>; id?: string }
  | { kind: 'design'; engine: 'html' | 'hyperframes'; design: DesignName; dur: number; props: any; id?: string }
  | { kind: 'canvas'; engine: 'hyperframes'; design: CanvasDesignName; dur: number; props: any; id?: string };

export interface ReelSpec {
  slug: string;
  title: string;
  category: string;
  tags: string[];
  palette: PaletteId;
  prompt: string;
  scenes: SceneSpec[];
  featured?: boolean;
  music?: MusicId;
  transition?: Transition;
  /** One-line description for the gallery card. */
  description?: string;
}

export interface GalleryInfo {
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  prompt: string;
  palette: string;
  theme: string;
  engines: string[];
  featured: boolean;
  music: MusicId | null;
  durationSeconds: number;
}

export interface GalleryEntry {
  gallery: GalleryInfo;
  manifest: Record<string, unknown>;
}

/* Scene helpers used by the catalog files. */
export const R = (dur: number, headline: string, subline?: string, extra: Record<string, unknown> = {}): SceneSpec => ({
  kind: 'template',
  engine: 'remotion',
  template: 'kinetic-title',
  dur,
  props: { headline, ...(subline ? { subline } : {}), ...extra },
});
export const MC = (dur: number, title: string, points: string[], extra: Record<string, unknown> = {}): SceneSpec => ({
  kind: 'template',
  engine: 'motion-canvas',
  template: 'animated-explainer',
  dur,
  props: { title, points, ...extra },
});
/** Greedy line breaks for a headline (short lines read better on a phone). */
export function breakLines(text: string, max = 14): string[] {
  const lines: string[] = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && (last + ' ' + w).length <= max) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines;
}
/** A title card written as an html scene (the hero design). */
export const HT = (dur: number, headline: string, subline?: string, kicker?: string): SceneSpec => ({
  kind: 'design',
  engine: 'html',
  design: 'hero',
  dur,
  props: { lines: breakLines(headline), ...(subline ? { sub: subline } : {}), ...(kicker ? { eyebrow: kicker } : {}) },
});
/** The same title card as a HyperFrames composition. */
export const HFT = (dur: number, headline: string, subline?: string): SceneSpec => ({
  kind: 'design',
  engine: 'hyperframes',
  design: 'hero',
  dur,
  props: { lines: breakLines(headline), ...(subline ? { sub: subline } : {}) },
});
/** The built-in html-title template (used where a reel showcases the built-in templates). */
export const HTT = (dur: number, headline: string, subline?: string, kicker?: string): SceneSpec => ({
  kind: 'template',
  engine: 'html',
  template: 'html-title',
  dur,
  props: { headline, ...(subline ? { subline } : {}), ...(kicker ? { kicker } : {}) },
});
/** The built-in hyperframes-title template. */
export const HFTT = (dur: number, headline: string, subline?: string): SceneSpec => ({
  kind: 'template',
  engine: 'hyperframes',
  template: 'hyperframes-title',
  dur,
  props: { headline, ...(subline ? { subline } : {}) },
});
/** An agent-written html scene from a design. */
export function X<N extends DesignName>(design: N, dur: number, props: Parameters<(typeof DESIGNS)[N]>[1]): SceneSpec {
  return { kind: 'design', engine: 'html', design, dur, props };
}
/** The same designs as a HyperFrames composition (counters via the seek script). */
export function XF<N extends DesignName>(design: N, dur: number, props: Parameters<(typeof DESIGNS)[N]>[1]): SceneSpec {
  return { kind: 'design', engine: 'hyperframes', design, dur, props };
}
/** A generative HyperFrames canvas scene. */
export function CV<N extends CanvasDesignName>(design: N, dur: number, props: Parameters<(typeof CANVAS_DESIGNS)[N]>[1]): SceneSpec {
  return { kind: 'canvas', engine: 'hyperframes', design, dur, props };
}

const ROTATION: Transition[] = ['wipe', 'push', 'zoom', 'iris'];

function isSource(sc: SceneSpec | undefined): boolean {
  return Boolean(sc && sc.kind !== 'template');
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Builds the gallery entry (and the full manifest) for one reel spec. */
export function buildEntry(spec: ReelSpec): GalleryEntry {
  if (!SLUG.test(spec.slug)) throw new Error(`bad slug ${spec.slug}`);
  const pal = PALETTES[spec.palette];
  if (!pal) throw new Error(`${spec.slug}: unknown palette ${spec.palette}`);
  const tx = spec.transition ?? ROTATION[hashSeed(spec.slug) % ROTATION.length]!;
  const scenes = spec.scenes.map((sc, i) => {
    const id = sc.id ?? `s${i + 1}-${sc.kind === 'template' ? sc.template.split('-')[0] : sc.design.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`;
    const base = { id, engine: sc.engine, durationSeconds: sc.dur };
    if (sc.kind === 'template') return { ...base, template: sc.template, props: sc.props };
    const prev = spec.scenes[i - 1];
    const next = spec.scenes[i + 1];
    const ctx: SceneCtx = {
      engine: sc.engine,
      dur: sc.dur,
      pal,
      tin: i === 0 ? 'none' : isSource(prev) ? tx : 'fade',
      tout: i === spec.scenes.length - 1 ? 'none' : isSource(next) ? tx : 'fade',
      seed: hashSeed(`${spec.slug}:${i}`),
    };
    const src = sc.kind === 'canvas' ? (CANVAS_DESIGNS[sc.design] as any)(ctx, sc.props) : (DESIGNS[sc.design] as any)(ctx, sc.props);
    return { ...base, html: src.html, ...(src.css ? { css: src.css } : {}), notes: `agent-written ${sc.engine} scene (${sc.design})` };
  });
  const durationSeconds = Math.round(spec.scenes.reduce((a, sc) => a + sc.dur, 0) * 1000) / 1000;
  const engines = [...new Set(spec.scenes.map((sc) => sc.engine))];
  const manifest = {
    schemaVersion: '0.2',
    projectId: spec.slug,
    title: spec.title,
    brief: {
      title: spec.title,
      goal: spec.prompt.slice(0, 2000),
      platform: 'instagram-reels',
      language: 'en',
      targetSeconds: durationSeconds,
    },
    theme: themeFor(pal),
    output: { width: 1080, height: 1920, fps: 30, format: 'mp4' },
    scenes,
  };
  return {
    gallery: {
      slug: spec.slug,
      title: spec.title,
      description: spec.description ?? spec.prompt.split(/(?<=\.)\s/)[0]!.slice(0, 200),
      category: spec.category,
      tags: spec.tags,
      prompt: spec.prompt,
      palette: pal.id,
      theme: pal.pure ? pal.base : `${pal.base} + inline tokens (${pal.name})`,
      engines,
      featured: Boolean(spec.featured),
      music: spec.music ?? null,
      durationSeconds,
    },
    manifest,
  };
}
