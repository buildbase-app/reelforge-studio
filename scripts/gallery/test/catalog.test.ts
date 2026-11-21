import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProject } from '@reelforge/project-schema';
import { breakLines, buildEntry, type GalleryEntry } from '../src/catalog/build';
import { buildAll, REELS } from '../src/catalog/index';
import { hashSeed, rng, themeFor } from '../src/catalog/kit';
import { PALETTES } from '../src/catalog/palettes';
import { manifestHash, stableJson, validateEntry } from '../src/manifests';

const EXAMPLES = join(import.meta.dirname, '../../../examples/gallery');
const entries = buildAll();

function sources(e: GalleryEntry): string {
  return (e.manifest.scenes as { html?: string; css?: string }[]).map((s) => `${s.html ?? ''}\n${s.css ?? ''}`).join('\n');
}

describe('gallery catalog', () => {
  it('has 100+ reels with unique slugs, all valid v0.2 manifests', () => {
    expect(entries.length).toBeGreaterThanOrEqual(100);
    expect(new Set(entries.map((e) => e.gallery.slug)).size).toBe(entries.length);
    for (const e of entries) {
      const r = parseProject(e.manifest);
      expect(r.ok, `${e.gallery.slug}: ${r.ok ? '' : JSON.stringify(r.issues)}`).toBe(true);
      expect(validateEntry(e), e.gallery.slug).toEqual([]);
    }
  });

  it('uses all four engines and both built-in themes', () => {
    const engines = new Set(entries.flatMap((e) => e.gallery.engines));
    expect([...engines].sort()).toEqual(['html', 'hyperframes', 'motion-canvas', 'remotion']);
    const themes = new Set(entries.map((e) => (typeof e.manifest.theme === 'string' ? e.manifest.theme : (e.manifest.theme as { base: string }).base)));
    expect(themes).toEqual(new Set(['default', 'midnight']));
    expect(entries.filter((e) => e.gallery.engines.length >= 2).length).toBeGreaterThan(entries.length * 0.6);
  });

  it('keeps each reel 8-25 s with 1-6 scenes and a prompt an agent could have been given', () => {
    for (const e of entries) {
      const scenes = e.manifest.scenes as unknown[];
      expect(scenes.length, e.gallery.slug).toBeGreaterThanOrEqual(1);
      expect(scenes.length, e.gallery.slug).toBeLessThanOrEqual(6);
      expect(e.gallery.durationSeconds).toBeGreaterThanOrEqual(8);
      expect(e.gallery.durationSeconds).toBeLessThanOrEqual(25);
      expect(e.gallery.prompt.length).toBeGreaterThan(60);
      expect((e.manifest.brief as { goal: string }).goal).toBe(e.gallery.prompt);
    }
  });

  it('is deterministic: building twice gives identical manifests', () => {
    const again = buildAll();
    expect(again.map((e) => manifestHash(e.manifest))).toEqual(entries.map((e) => manifestHash(e.manifest)));
  });

  it('matches the committed examples/gallery files (run `pnpm gallery build` after editing the catalog)', () => {
    const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(entries.length);
    for (const e of entries) expect(readFileSync(join(EXAMPLES, `${e.gallery.slug}.json`), 'utf8')).toBe(stableJson(e));
  });

  it('agent-written scenes reach no network and load no external fonts or files', () => {
    for (const e of entries) {
      const src = sources(e);
      expect(src, e.gallery.slug).not.toMatch(/https?:\/\//);
      expect(src).not.toMatch(/@import|@font-face|<link|<img[^>]+src="(?!data:)/i);
      expect(src).not.toMatch(/<script[^>]*\bsrc=/i);
    }
  });

  // The unslop rules (AGENTS.md "Design and UI/UX rules"; unslop by Damir Sokolovsky, CC BY 4.0).
  it('follows the design rules: no gradient text, glows, blur, glass, overshoot easing or tracked uppercase labels', () => {
    for (const e of entries) {
      const src = sources(e);
      const where = e.gallery.slug;
      expect(src, where).not.toMatch(/background-clip:\s*text/);
      expect(src, where).not.toMatch(/drop-shadow\(|filter:\s*blur|backdrop-filter/);
      expect(src, where).not.toMatch(/box-shadow:0 0 \d+px/);
      expect(src, where).not.toMatch(/text-transform:\s*uppercase/);
      expect(src, where).not.toMatch(/cubic-bezier\(\.34,1\.56/);
      expect(src, where).not.toMatch(/font-weight:\s*(800|900)|font:\s*(800|900) /);
      expect(src, where).not.toMatch(/linear-gradient\(\d+deg,var\(--rf-accent\),var\(--rf-accent2\)/);
      expect(src, where).not.toMatch(/conic-gradient/);
      expect(src, where).not.toMatch(/[\u{1F300}-\u{1FAFF}✨]/u);
    }
  });

  it('inline palettes keep tinted neutrals, one accent and 600 headings', () => {
    for (const p of Object.values(PALETTES)) {
      const t = themeFor(p);
      if (p.pure) expect(t).toBe(p.base);
      else expect((t as { tokens: Record<string, unknown> }).tokens.headingWeight).toBe(600);
    }
  });

  it('every reel is fictional: quote cards say so', () => {
    for (const spec of REELS) {
      for (const sc of spec.scenes) {
        if (sc.kind === 'design' && sc.design === 'quote') expect(JSON.stringify(sc.props)).toMatch(/Sample|Demo|Placeholder|Example|fictional/);
      }
    }
  });
});

describe('catalog helpers', () => {
  it('breaks headlines into short lines', () => {
    expect(breakLines('Light from three sides', 14)).toEqual(['Light from', 'three sides']);
    expect(breakLines('Supercalifragilistic word', 10)).toEqual(['Supercalifragilistic', 'word']);
  });
  it('has a seeded PRNG and hash', () => {
    const a = rng(42);
    const b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(hashSeed('x')).toBe(hashSeed('x'));
    expect(hashSeed('x')).not.toBe(hashSeed('y'));
  });
  it('refuses a bad slug or palette', () => {
    expect(() => buildEntry({ slug: 'Bad Slug', title: 't', category: 'c', tags: [], palette: 'default', prompt: 'p', scenes: [] })).toThrow(/slug/);
    expect(() => buildEntry({ slug: 'ok', title: 't', category: 'c', tags: [], palette: 'nope' as never, prompt: 'p', scenes: [] })).toThrow(/palette/);
  });
});
