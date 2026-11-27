/**
 * Output formats with the real engines over REST (#302): the html and
 * HyperFrames engines capture a transparent background, rendered to MOV
 * (ProRes 4444) and WebM (VP9 alpha); a Remotion scene in an alpha render is
 * refused with 422 before a job is queued; the output route and a signed
 * download serve the format's file with its content type. Skips without a
 * browser unless REELFORGE_REQUIRE_BROWSER=1.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RenderWeldService, createMemoryRepositories } from '@renderweld/core';
import { alphaStats, probe, resolveTools } from '@renderweld/media-pipeline';
import { createApp, loadConfig } from '../src/index';
import { createDefaultRegistry } from '../src/registry';
import { tempDir } from '../../../packages/core/test/helpers';

const browser = process.env.RENDERWELD_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const { dir, cleanup } = tempDir('reelforge-formats-e2e-');
const tools = resolveTools();
let service: RenderWeldService;
let app: ReturnType<typeof createApp>;
let key: string;

describe('browser requirement', () => {
  it.runIf(process.env.REELFORGE_REQUIRE_BROWSER === '1')('REELFORGE_REQUIRE_BROWSER=1: a browser must be configured', () => {
    expect(hasBrowser).toBe(true);
  });
});

beforeAll(async () => {
  if (!hasBrowser) return;
  const config = loadConfig({ RENDERWELD_DATA_DIR: join(dir, 'data'), RENDERWELD_PUBLIC_URL: 'https://studio.example.com' });
  service = await RenderWeldService.create(createDefaultRegistry({}), {
    repositories: createMemoryRepositories(),
    dataDir: config.dataDir,
    cacheDir: resolve(import.meta.dirname, '../../../.render-cache'),
    publicUrl: config.publicUrl,
    configSources: { env: { RENDERWELD_SECRET_KEY: 'test-secret-key-0123456789-abcdefghij', RENDERWELD_LICENCE_MODE: 'off' } },
  });
  key = (await service.keys.create('admin', ['admin'])).key;
  app = createApp({ service, config });
}, 60_000);
afterAll(async () => {
  await service?.jobs.shutdown(0);
  await service?.stop();
  cleanup();
});

const req = (method: string, path: string, body?: unknown, auth = true) =>
  app.request(path, { method, headers: { host: 'localhost', ...(auth ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

/** A box on a transparent page, moving: the page paints no background when alpha is on. */
const BOX = {
  html: '<div class="box"></div>',
  css: '.box{position:absolute;left:12px;top:12px;width:60px;height:60px;background:#d94a2b;border-radius:8px;animation:m 1s linear both}@keyframes m{to{transform:translateX(80px)}}',
};
const W = 240;
const H = 136;

function manifest(projectId: string, output: Record<string, unknown>, engines: string[]) {
  return {
    schemaVersion: '0.2',
    projectId,
    title: projectId,
    output: { width: W, height: H, fps: 30, ...output },
    scenes: engines.map((engine, i) =>
      engine === 'remotion'
        ? { id: `s${i}`, engine, template: 'kinetic-title', durationFrames: 45, props: { headline: 'Opaque' } }
        : { id: `s${i}`, engine, durationFrames: 30, ...BOX }
    ),
  };
}

async function render(projectId: string) {
  const r = await req('POST', `/v1/projects/${projectId}/renders`, {});
  expect(r.status).toBe(202);
  const { job } = (await r.json()) as { job: { id: string } };
  for (let i = 0; i < 1200; i++) {
    const j = (await (await req('GET', `/v1/jobs/${job.id}`)).json()) as { status: string; result?: Record<string, any>; error?: unknown };
    if (j.status === 'succeeded') return j.result!;
    if (j.status === 'failed' || j.status === 'cancelled') throw new Error(`${projectId}: ${JSON.stringify(j.error)}`);
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('timeout');
}

describe.runIf(hasBrowser)('transparent renders with the real engines (#302)', () => {
  for (const [format, codec, file, type] of [['mov', 'prores', 'final.mov', 'video/quicktime'], ['webm', 'vp9', 'final.webm', 'video/webm']] as const) {
    it(`html + hyperframes with alpha to ${format}: alpha plane, ${codec}, frames, duration; served with ${type}`, async () => {
      const id = `alpha-${format}`;
      expect((await req('POST', '/v1/projects', manifest(id, { format, alpha: true }, ['html', 'hyperframes']))).status).toBe(201);
      const result = await render(id);
      expect(result).toMatchObject({ format, alpha: true, file, contentType: type, frames: 60, width: W, height: H });
      // The output route without ?file= serves the format's file.
      const out = await req('GET', `/v1/renders/${result.renderId}/output`);
      expect(out.status).toBe(200);
      expect(out.headers.get('content-type')).toBe(type);
      expect(out.headers.get('content-disposition')).toContain(file);
      const local = join(dir, `${id}-${file}`);
      writeFileSync(local, Buffer.from(await out.arrayBuffer()));
      // The signed link works without a key, for this file.
      const signed = new URL(result.downloadUrl);
      expect(signed.searchParams.get('file')).toBe(file);
      const dl = await req('GET', signed.pathname + signed.search, undefined, false);
      expect(dl.status).toBe(200);
      expect(dl.headers.get('content-type')).toBe(type);
      const info = await probe(tools.ffprobe, local);
      expect(info.videoCodec).toBe(codec);
      expect(info.frames).toBe(60);
      expect(Math.abs(info.durationSeconds - 2)).toBeLessThan(1 / 30 + 0.01);
      expect(info.hasAudio).toBe(true);
      // Both engines' scenes keep a transparent background around an opaque box.
      for (const frame of [5, 45]) {
        const a = await alphaStats(tools.ffmpeg, local, frame, { vp9: codec === 'vp9' });
        expect(a, `frame ${frame}`).not.toBeNull();
        expect(a!.min, `frame ${frame}`).toBeLessThan(5);
        expect(a!.max, `frame ${frame}`).toBeGreaterThan(250);
      }
    }, 300_000);
  }

  it('an engine without alpha in an alpha render: 422 unsupported_output before anything is queued', async () => {
    expect((await req('POST', '/v1/projects', manifest('alpha-remotion', { format: 'mov', alpha: true }, ['html', 'remotion']))).status).toBe(201);
    const r = await req('POST', '/v1/projects/alpha-remotion/renders', {});
    expect(r.status).toBe(422);
    const body = (await r.json()) as { error: { code: string; details: { issues: Array<{ path: string; engine: string }> } } };
    expect(body.error.code).toBe('unsupported_output');
    expect(body.error.details.issues).toEqual([expect.objectContaining({ path: 'output.alpha', engine: 'remotion' })]);
    const caps = (await (await req('GET', '/v1/capabilities')).json()) as { engines: Array<{ id: string; alpha: boolean }> };
    expect(Object.fromEntries(caps.engines.map((e) => [e.id, e.alpha]))).toEqual({ remotion: false, 'motion-canvas': false, html: true, hyperframes: true });
  }, 60_000);
});
