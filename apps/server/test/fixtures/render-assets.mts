// One project that uses uploaded assets on every engine (#299): an image, a
// video clip and an SVG logo in the scenes, and an audio bed under them; and
// the same image and clip in the Remotion and Motion Canvas layout templates (#287).
// Rendered by the real service with the server's engines, then prints one
// JSON line. Run by assets.e2e.test.ts, under strace where it works
// (`node --import tsx render-assets.mts <dir>`), so every connect() and send
// of the render (server process, browsers, HyperFrames, FFmpeg) is seen.
// <dir> holds quad.png, clip.mp4, tone.m4a and logo.svg.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ReelforgeService, createMemoryRepositories } from '@reelforge/core';
import { createDefaultRegistry } from '../../src/registry';

const dir = process.argv[2]!;
const log: string[] = [];
const result = await (async () => {
  const svc = await ReelforgeService.create(createDefaultRegistry({}), {
    repositories: createMemoryRepositories(),
    dataDir: join(dir, 'data'),
    cacheDir: resolve(import.meta.dirname, '../../../../.render-cache'),
    configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } },
    licence: { start: false },
  });
  try {
    const up = async (file: string, name: string) => (await svc.uploadAsset(readFileSync(join(dir, file)), { filename: name })).asset;
    const [quad, clip, tone, logo] = [await up('quad.png', 'quad.png'), await up('clip.mp4', 'clip.mp4'), await up('tone.m4a', 'bed.m4a'), await up('logo.svg', 'logo.svg')];
    const entry = (id: string, a: typeof quad) => ({ id, uri: `asset://${a.id}`, mediaType: a.mediaType, license: { name: 'test fixture', redistributable: false } });
    const sourceLayout =
      '<img src="asset:quad" style="position:absolute;left:0;top:0;width:200px;height:100px">' +
      '<img src="asset:logo" style="position:absolute;left:260px;top:0;width:40px;height:40px">';
    await svc.createProject({
      schemaVersion: '0.2',
      projectId: 'assets-reel',
      title: 'Assets on every engine',
      output: { width: 320, height: 320, fps: 30, format: 'mp4' },
      theme: { base: 'default', tokens: { colors: { background: '#000000' } } },
      assets: [entry('quad', quad), entry('clip', clip), entry('bed', tone), entry('logo', logo)],
      audio: { music: { asset: 'bed', volume: 0.8, fadeOutSeconds: 0 } },
      scenes: [
        { id: 'rem', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'Remotion', media: { asset: 'clip', fit: 'contain', focus: { x: 50, y: 0 }, dim: 0 }, logo: { asset: 'logo', corner: 'bottom-right', size: 14 } } },
        { id: 'mc', engine: 'motion-canvas', template: 'animated-explainer', durationFrames: 60, props: { title: 'Motion Canvas', points: ['One'], media: { asset: 'quad', fit: 'cover', dim: 0 }, logo: { asset: 'logo', corner: 'bottom-right', size: 14 } } },
        { id: 'html', engine: 'html', durationFrames: 30, html: sourceLayout + '<video src="asset:clip" style="position:absolute;left:0;top:220px;width:320px;height:80px;object-fit:fill"></video>', css: '#rf-root{background:#000}' },
        {
          id: 'hf',
          engine: 'hyperframes',
          durationFrames: 30,
          html: sourceLayout + '<video src="asset:clip" muted playsinline data-start="0" style="position:absolute;left:0;top:220px;width:320px;height:80px;object-fit:fill"></video>',
          css: '#root{background:#000}',
        },
        // Layout templates (#287): the clip from 1 s over the picture, stacked, on Remotion and Motion Canvas.
        ...(['remotion', 'motion-canvas'] as const).map((engine) => ({
          id: `${engine}-layout`,
          engine,
          template: `${engine}-layout`,
          durationFrames: 30,
          props: { layout: { type: 'split', direction: 'vertical', gap: 0 }, panes: [{ media: { asset: 'clip', fit: 'contain', startSeconds: 1 }, color: '#000000' }, { media: { asset: 'quad', fit: 'cover' } }] },
        })),
      ],
    });
    const { job } = await svc.renderProject('assets-reel');
    const done = await svc.jobs.waitFor(job.id, 600_000);
    log.push(...(await svc.jobLogs(job.id)));
    if (done.status !== 'succeeded') return { ok: false, error: JSON.stringify(done.error), log };
    const renderId = String(done.result!.renderId);
    return { ok: true, renderId, file: (await svc.renderFile(renderId)).path, manifest: await svc.getRenderManifest(renderId), log };
  } finally {
    await svc.stop();
  }
})().catch((e: Error) => ({ ok: false, error: e.stack ?? e.message, log }));
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
