import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, ReelforgeService, createMemoryRepositories } from '../src/index';
import { fakeEngine, tempDir } from './helpers';

/** The contact sheet stored with every render and preview (#379, render.contactSheet.*). */
const { dir, cleanup } = tempDir('renderweld-contactsheet-');
let svc: ReelforgeService;
afterAll(async () => {
  await svc?.jobs.shutdown(0);
  await svc?.stop();
  cleanup();
});

beforeAll(async () => {
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion', { frameRanges: true }));
  svc = await ReelforgeService.create(registry, { repositories: createMemoryRepositories(), dataDir: join(dir, 'data'), configSources: { env: { REELFORGE_LICENCE_MODE: 'off', REELFORGE_RENDER_QA_SEEK_FRAMES: '0' } } });
  await svc.createProject({
    schemaVersion: '0.1',
    projectId: 'sheet',
    title: 'Sheet',
    output: { width: 320, height: 568, fps: 30, format: 'mp4' },
    audio: { musicTrack: null, voiceTrack: null },
    assets: [],
    scenes: [
      { id: 'hook', engine: 'remotion', template: 'kinetic-title', durationFrames: 60, props: { headline: 'One' } },
      { id: 'body', engine: 'remotion', template: 'kinetic-title', durationFrames: 90, props: { headline: 'Two' } },
    ],
  });
}, 60_000);

async function finished(job: Promise<{ id: string }>) {
  const done = await svc.jobs.waitFor((await job).id, 120_000);
  expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
  const renderId = done.result!.renderId as string;
  return { summary: await svc.getRender(renderId), manifest: (await svc.getRenderManifest(renderId)) as { contactSheet?: unknown } };
}

describe('stored contact sheet', () => {
  it('CS-01 a render and a preview each store the automatic sheet, at their own size', async () => {
    const { summary, manifest } = await finished(svc.startRender('sheet'));
    expect(summary.contactSheet).toMatchObject({ file: 'contact-sheet.jpg', mode: 'auto', overlay: 'none', tileWidth: 320, tileHeight: 568 });
    expect(summary.contactSheet!.tiles.map((t) => `${t.frame}:${t.position}`)).toEqual(['0:first', '29:mid', '59:cut-out', '60:cut-in', '104:mid', '149:last']);
    expect(summary.contactSheet!.url).toBe(`${summary.outputUrl}?file=contact-sheet.jpg`);
    expect(manifest.contactSheet).toMatchObject({ file: 'contact-sheet.jpg', tiles: summary.contactSheet!.tiles });
    const file = await svc.renderFile(summary.renderId, 'contact-sheet.jpg');
    expect(file.contentType).toBe('image/jpeg');

    const preview = await finished(svc.preview('sheet'));
    expect(preview.summary.kind).toBe('preview');
    // Tiles are never wider than the video: a preview at a third of the size has tiles at its own size.
    expect(preview.summary.contactSheet).toMatchObject({ mode: 'auto', tileWidth: preview.summary.width, tileHeight: preview.summary.height });
  }, 120_000);

  it('CS-02 render.contactSheet.* is read when the render finishes: every N seconds, tile width, safe overlay, off', async () => {
    await expect(svc.updateConfig({ 'render.contactSheet.everySeconds': 0.1 })).rejects.toThrow();
    await svc.updateConfig({ 'render.contactSheet.select': 'every', 'render.contactSheet.everySeconds': 1, 'render.contactSheet.width': 160, 'render.contactSheet.overlay': 'safe' });
    const every = await finished(svc.startRender('sheet'));
    expect(every.summary.contactSheet).toMatchObject({ mode: 'every', everySeconds: 1, overlay: 'safe', tileWidth: 160, tileHeight: 284 });
    expect(every.summary.contactSheet!.tiles.map((t) => t.frame)).toEqual([0, 30, 60, 90, 120]);
    expect(every.summary.contactSheet!.tiles.map((t) => t.sceneId)).toEqual(['hook', 'hook', 'body', 'body', 'body']);

    await svc.updateConfig({ 'render.contactSheet.select': 'off' });
    const off = await finished(svc.startRender('sheet'));
    expect(off.summary.contactSheet).toBeUndefined();
    expect(off.summary.files).not.toContain('contact-sheet.jpg');
    expect(off.manifest.contactSheet).toBeUndefined();
    await expect(svc.renderFile(off.summary.renderId, 'contact-sheet.jpg')).rejects.toThrow();
    await svc.updateConfig({ 'render.contactSheet.select': null, 'render.contactSheet.everySeconds': null, 'render.contactSheet.width': null, 'render.contactSheet.overlay': null });
  }, 240_000);
});
