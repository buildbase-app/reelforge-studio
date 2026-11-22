import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEntry, CV, R, X, type GalleryEntry } from '../src/catalog/build';
import { publishAll } from '../src/publish';
import { checkOne } from '../src/quality';
import { uploadAll } from '../src/r2';
import { renderAll } from '../src/render';
import { REPO, connectMcp, startLocalStudio, type LocalStudio, type ToolCaller } from '../src/studio';
import { transcodeOne } from '../src/transcode';

/**
 * The whole gallery pipeline on two short reels, against a real studio
 * process over MCP: render (all four engines, music on one), quality gate,
 * transcode with hashed names, R2 upload (dry run) and the BuildBase publish
 * (against an in-memory fake of the Records API).
 *
 * Needs a Chromium (REELFORGE_CHROMIUM_PATH); skips without one unless
 * REELFORGE_REQUIRE_BROWSER=1, which turns a missing browser into a failure.
 */
const browser = process.env.REELFORGE_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const requireBrowser = process.env.REELFORGE_REQUIRE_BROWSER === '1';

describe('browser requirement', () => {
  it.runIf(requireBrowser)('REELFORGE_REQUIRE_BROWSER=1: a browser must be configured', () => {
    expect(hasBrowser, `REELFORGE_CHROMIUM_PATH=${browser ?? '(unset)'}`).toBe(true);
  });
});

const reels: GalleryEntry[] = [
  buildEntry({
    slug: 'e2e-two-engines',
    title: 'E2E two engines',
    category: 'Test',
    tags: ['e2e'],
    palette: 'ember',
    music: 'pulse',
    prompt: 'End-to-end test reel: a Remotion title cut to an agent-written HTML stat scene, with a generated music bed.',
    scenes: [R(1.5, 'Gallery e2e'), X('stat', 1.5, { value: 42, label: 'frames checked' })],
  }),
  buildEntry({
    slug: 'e2e-canvas',
    title: 'E2E canvas',
    category: 'Test',
    tags: ['e2e'],
    palette: 'midnight',
    prompt: 'End-to-end test reel: a HyperFrames canvas globe and a Motion Canvas list, cut back to back, silent.',
    scenes: [CV('globe', 1.5, { lines: ['Globe'] }), { kind: 'template', engine: 'motion-canvas', template: 'animated-explainer', dur: 2, props: { title: 'Two points', points: ['One', 'Two'] } }],
  }),
];

describe.skipIf(!hasBrowser)('gallery pipeline end to end (needs REELFORGE_CHROMIUM_PATH)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reelforge-gallery-e2e-'));
  const out = join(dir, 'out');
  let studio: LocalStudio;
  let caller: ToolCaller;

  beforeAll(async () => {
    studio = await startLocalStudio({
      dataDir: join(dir, 'data'),
      cacheDir: join(REPO, '.render-cache'),
      chromium: browser!,
      concurrency: 2,
      noSandbox: process.env.REELFORGE_CHROMIUM_NO_SANDBOX === '1',
    });
    caller = await connectMcp(studio.url, studio.key);
  }, 180_000);

  afterAll(async () => {
    await caller?.close().catch(() => undefined);
    await studio?.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('renders both reels over MCP, passes the quality gate, transcodes and publishes', async () => {
    const caps = await caller.call('get_capabilities', {});
    for (const e of caps.engines) expect(e.available, `${e.id}: ${e.reason}`).toBe(true);

    const res = await renderAll(caller, reels, { outDir: out, studioUrl: studio.url, key: studio.key, concurrency: 2, log: () => undefined });
    expect(res.failed, JSON.stringify(res.failed)).toEqual([]);
    expect(res.rendered.sort()).toEqual(['e2e-canvas', 'e2e-two-engines']);

    const entries: Record<string, unknown> = {};
    for (const e of reels) {
      const meta = JSON.parse(readFileSync(join(out, e.gallery.slug, 'meta.json'), 'utf8'));
      expect(meta).toMatchObject({ width: 1080, height: 1920, fps: 30, checks: { metadata: 'pass', decode: 'pass', duration: 'pass' } });
      expect(meta.toolsCalled).toEqual(expect.arrayContaining(['create_project', 'validate_project', 'render_project', 'get_job', 'get_render_output', 'delete_project']));
      expect(meta.renderSeconds).toBeGreaterThan(0);

      const q = await checkOne(out, e);
      expect(q.problems, e.gallery.slug).toEqual([]);
      expect(statSync(q.contactSheet!).size).toBeGreaterThan(1000);

      const m = await transcodeOne(out, e);
      expect(m.mp4.key).toMatch(new RegExp(`^gallery/${e.gallery.slug}/${e.gallery.slug}\\.[0-9a-f]{12}\\.mp4$`));
      expect(m.mp4.bytes).toBeLessThanOrEqual(m.budgetBytes);
      expect(m.webm.bytes).toBeGreaterThan(0);
      expect(m.poster.avif.bytes).toBeGreaterThan(0);
      entries[e.gallery.slug] = m;
    }
    expect(JSON.parse(readFileSync(join(out, 'e2e-two-engines', 'meta.json'), 'utf8')).toolsCalled).toEqual(expect.arrayContaining(['upload_asset', 'set_audio']));

    // media.json the way transcodeAll writes it, then the R2 dry run and a publish to a fake Records API.
    writeFileSync(join(out, 'web', 'media.json'), JSON.stringify({ entries }));
    const up = await uploadAll(out, { dryRun: true, log: () => undefined });
    expect(up.uploaded).toBe(0);
    const urls = JSON.parse(readFileSync(join(out, 'web', 'urls.json'), 'utf8'));
    expect(Object.keys(urls.files).length).toBe(12);

    const records: any[] = [];
    const fake: typeof fetch = async (input, init) => {
      const u = new URL(String(input));
      const method = init?.method ?? 'GET';
      const json = (v: unknown) => new Response(JSON.stringify(v));
      if (u.pathname === '/api/collections' && method === 'GET') return json({ docs: [{ _id: 'c1', slug: 'gallery' }] });
      if (u.pathname === '/api/collections/c1/versions') return json([{ _id: 'v1', live: true }]);
      if (u.pathname === '/api/collections/c1/versions/v1') return json({ _id: 'v1', live: true, fields: (await import('../src/publish')).GALLERY_FIELDS });
      if (u.pathname === '/api/collections/data/gallery') return json({ docs: records, hasNextPage: false });
      if (method === 'POST') {
        records.push({ _id: `r${records.length}`, data: JSON.parse(String(init!.body)) });
        return json(records.at(-1));
      }
      if (method === 'HEAD') return new Response(null, { status: 404 });
      return new Response('nope', { status: 404 });
    };
    const pub = await publishAll(out, { token: 'org:secret', server: 'https://bb.example', baseUrl: 'https://media.example', fetch: fake, log: () => undefined });
    expect(pub).toMatchObject({ created: 2, hidden: 2 });
    expect(records.map((r) => r.data.slug).sort()).toEqual(['e2e-canvas', 'e2e-two-engines']);
  }, 1_200_000);
});
