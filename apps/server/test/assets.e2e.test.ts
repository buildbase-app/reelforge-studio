import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RenderWeldService, createMemoryRepositories } from '@renderweld/core';
import { probe, resolveTools, run, type Tools } from '@renderweld/media-pipeline';
import { tempDir } from '../../../packages/core/test/helpers';
import { externalNetworkCalls } from '../../../packages/engine-hyperframes/test/strace-egress';
import { QUAD, TEST_FONTS, colorDistance, makeNumberedClip, makeQuadImage, makeTone, meanColor, readBars, readPicture } from '../../../packages/media-pipeline/test/media-fixtures';
import { createDefaultRegistry } from '../src/registry';

/**
 * #299 end to end: assets uploaded to the store are used by every engine in
 * one render (image, video clip, SVG logo in the scenes; an audio bed under
 * them, a font the theme names), and the Remotion and Motion Canvas layout templates (#287) with the
 * same image and clip, checked on the final video's pixels and sound; the whole render runs
 * under strace where it can and makes no connection outside loopback. A
 * project cannot render another project's assets.
 */

const browser = process.env.RENDERWELD_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const repoRoot = resolve(import.meta.dirname, '../../..');
const hasStrace = spawnSync('strace', ['-f', '-qq', '-yy', '-e', 'trace=connect', '-o', '/dev/null', 'true']).status === 0;
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="fetch(\'https://evil.example/svg-onload\')">' +
  '<script>fetch("https://evil.example/svg-script")</script><rect width="40" height="40" fill="#e61e1e"/>' +
  '<image href="https://evil.example/remote.png" width="40" height="40"/></svg>';

describe.skipIf(!hasBrowser)('ASSET-E2E uploaded assets on every engine in one render (needs RENDERWELD_CHROMIUM_PATH)', () => {
  const { dir, cleanup } = tempDir('reelforge-assets-e2e-');
  let tools: Tools;
  let result: { ok: boolean; error?: string; file?: string; manifest?: any; log: string[] };
  let trace = '';
  afterAll(cleanup);

  beforeAll(async () => {
    tools = resolveTools();
    await makeQuadImage(tools.ffmpeg, join(dir, 'quad.png'));
    await makeNumberedClip(tools.ffmpeg, join(dir, 'clip.mp4'), { fps: 30, frames: 90 });
    await makeTone(tools.ffmpeg, join(dir, 'tone.m4a'), 8);
    writeFileSync(join(dir, 'logo.svg'), LOGO_SVG);
    copyFileSync(join(TEST_FONTS, 'rf-block.woff2'), join(dir, 'brand.woff2'));
    const traceFile = join(dir, 'strace.txt');
    const fixture = join(import.meta.dirname, 'fixtures', 'render-assets.mts');
    const [cmd, args] = hasStrace
      ? ['strace', ['-f', '-qq', '-yy', '-e', 'trace=connect,sendto,sendmsg,sendmmsg', '-o', traceFile, process.execPath, '--import', 'tsx', fixture, dir]]
      : [process.execPath, ['--import', 'tsx', fixture, dir]];
    const out = await new Promise<{ stdout: string; stderr: string }>((resolve_) => {
      execFile(cmd, args as string[], { cwd: repoRoot, env: { ...process.env, RENDERWELD_CHROMIUM_PATH: browser }, timeout: 900_000, maxBuffer: 64 * 1024 * 1024 }, (_e, stdout, stderr) => resolve_({ stdout, stderr }));
    });
    const line = /^RESULT (.*)$/m.exec(out.stdout)?.[1];
    if (!line) throw new Error(`the render fixture printed no result:\n${out.stderr.slice(-4000)}`);
    result = JSON.parse(line);
    if (hasStrace) trace = readFileSync(traceFile, 'utf8');
  }, 900_000);

  it('the render succeeds with the audio bed mixed in', async () => {
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const info = await probe(tools.ffprobe, result.file!);
    expect(info).toMatchObject({ width: 320, height: 320, frames: 225, hasAudio: true, audioCodec: 'aac' });
    expect(result.manifest.audio.music.asset).toBe('bed');
    // The bed is audible (a silent track would be about -91 dB).
    const { stderr } = await run(tools.ffmpeg, ['-hide_banner', '-i', result.file!, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'], 'volume');
    const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr)?.[1]);
    expect(mean).toBeGreaterThan(-30);
  });

  it('every engine shows the image, the SVG logo and the video at the right frame', async () => {
    const size = { width: 320, height: 320 };
    const at = (f: number) => readPicture(tools.ffmpeg, result.file!, f, size);
    // Remotion (frames 0-44): clip contained at the top of the frame, frame-exact.
    for (const f of [0, 44]) expect(readBars(await at(f), { x: 0, y: 2, width: 320, height: 12 }), `remotion frame ${f}`).toBe(f);
    // Motion Canvas (45-104): the picture covers the frame.
    const mc = await at(45 + 30);
    expect(colorDistance(meanColor(mc, 8, 8), QUAD.tl)).toBeLessThan(30);
    expect(colorDistance(meanColor(mc, 312, 8), QUAD.tr)).toBeLessThan(30);
    // html (105-134) and HyperFrames (135-164): image, SVG logo (its rect) and video bars.
    for (const [engine, first] of [['html', 105], ['hyperframes', 135]] as const) {
      for (const k of [0, 29]) {
        const p = await at(first + k);
        expect(colorDistance(meanColor(p, 50, 25), QUAD.tl), `${engine} ${k}`).toBeLessThan(30);
        expect(colorDistance(meanColor(p, 150, 75), QUAD.br), `${engine} ${k}`).toBeLessThan(30);
        expect(colorDistance(meanColor(p, 280, 20), [230, 30, 30]), `${engine} ${k} svg`).toBeLessThan(30);
        expect(readBars(p, { x: 0, y: 220, width: 320, height: 80 }), `${engine} frame ${k}`).toBe(k);
      }
    }
    // remotion-layout (165-194) and motion-canvas-layout (195-224): top pane, the clip from 1 s contained
    // (160 px tall, 284.4 px wide, centred); bottom pane, the 2:1 picture covering 320x160 exactly.
    for (const [engine, first] of [['remotion-layout', 165], ['motion-canvas-layout', 195]] as const) {
      for (const k of [0, 13, 29]) {
        const p = await at(first + k);
        expect(readBars(p, { x: 17.8, y: 0, width: 284.4, height: 160 }), `${engine} frame ${k}`).toBe(30 + k);
        expect(colorDistance(meanColor(p, 80, 200), QUAD.tl), `${engine} ${k} picture`).toBeLessThan(30);
        expect(colorDistance(meanColor(p, 240, 280), QUAD.br), `${engine} ${k} picture`).toBeLessThan(30);
      }
    }
  });

  it('every engine loaded the theme\'s uploaded font (#303) and the bundled fallback named after it', () => {
    const log = result.log.join('\n');
    for (const engine of ['rem', 'mc', 'html', 'hf']) expect(log, engine).toMatch(new RegExp(`render:${engine}[\\s\\S]*?assets: fonts RF Block \\(project\\), Inter \\(bundled\\)`));
  });

  it.runIf(hasStrace)('strace: the whole render connects and sends nothing outside loopback (0 network egress)', () => {
    expect(trace).toMatch(/AF_INET/); // it saw the render's loopback connections
    expect(externalNetworkCalls(trace)).toEqual([]);
    expect(trace).not.toMatch(/evil\.example/);
  });

  it('a project cannot use or render another project\'s assets; shared (unattached) uploads work for all', async () => {
    const svc = await RenderWeldService.create(createDefaultRegistry({}), {
      repositories: createMemoryRepositories(),
      dataDir: join(dir, 'data-iso'),
      configSources: { env: { RENDERWELD_LICENCE_MODE: 'off' } },
      licence: { start: false },
    });
    try {
      const scene = (html: string) => ({ id: 's', engine: 'html', durationSeconds: 1, html });
      const manifest = (id: string, assets: unknown[], html: string) => ({ schemaVersion: '0.2', projectId: id, title: id, output: { width: 320, height: 320, fps: 30, format: 'mp4' }, assets, scenes: [scene(html)] });
      await svc.createProject(manifest('a', [], '<p>a</p>'));
      await svc.createProject(manifest('b', [], '<p>b</p>'));
      const quad = readFileSync(join(dir, 'quad.png'));
      const owned = await svc.uploadAsset(quad, { projectId: 'a', assetId: 'logo' });
      // B names A's logo by A's manifest id: unknown in B.
      await expect(svc.updateProject('b', manifest('b', [], '<img src="asset:logo">'))).rejects.toMatchObject({ code: 'invalid_manifest' });
      // B lists A's store id: refused by validation and by the render.
      const stolen = manifest('b', [{ id: 'logo', uri: owned.uri, mediaType: 'image' }], '<img src="asset:logo">');
      await svc.updateProject('b', stolen).catch(() => undefined);
      const report = await svc.validateProject('b');
      expect(JSON.stringify(report.errors)).toMatch(/belongs to another project/);
      await expect(svc.resolveAssets(stolen as never, 'b')).rejects.toMatchObject({ code: 'asset_not_in_project' });
      // Uploading the same bytes for B attaches it to B as well; a shared upload is usable by every project.
      await svc.uploadAsset(quad, { projectId: 'b', assetId: 'logo' });
      expect((await svc.resolveAssets((await svc.getProject('b')).manifest as never, 'b')).get('logo')?.mediaType).toBe('image');
      const shared = await svc.uploadAsset(readFileSync(join(dir, 'logo.svg')));
      const sharedManifest = manifest('b', [{ id: 'brand', uri: shared.uri, mediaType: 'image' }], '<img src="asset:brand">');
      expect((await svc.resolveAssets(sharedManifest as never, 'b')).has('brand')).toBe(true);
      expect(shared.asset.contentType).toBe('image/svg+xml');
    } finally {
      await svc.stop();
    }
  }, 120_000);
});
