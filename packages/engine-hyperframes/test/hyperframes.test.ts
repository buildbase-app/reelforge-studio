import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PipelineError, checkExpectation, frameStats, probe, resolveTools } from '@reelforge/media-pipeline';
import { builtinTheme, type OutputSettings, type RenderScene } from '@reelforge/project-schema';
import { HF_CSP, buildComposition, hyperframesEngine, hyperframesEnv, hyperframesVersion, renderHyperframesScene } from '../src/index';

const browser = process.env.REELFORGE_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const requireBrowser = process.env.REELFORGE_REQUIRE_BROWSER === '1';
const dir = mkdtempSync(join(tmpdir(), 'reelforge-hf-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const output: OutputSettings = { width: 360, height: 640, fps: 30, format: 'mp4' };
const theme = builtinTheme('default')!.tokens;

describe('composition builder', () => {
  it('wraps fragments in a sized root composition with a network-blocking CSP', () => {
    const doc = buildComposition({ id: 's', engine: 'hyperframes', durationFrames: 60, props: {}, html: '<h1 class="clip" data-start="0" data-duration="2">Hi</h1>' }, output, theme);
    expect(doc).toContain(HF_CSP);
    expect(doc).toContain('data-composition-id="main"');
    expect(doc).toContain('data-duration="2"');
    expect(doc).toContain('data-width="360" data-height="640"');
  });
  it('injects the CSP into full documents and checks their size', () => {
    const full = '<!doctype html><html><head><title>x</title></head><body><div data-composition-id="main" data-width="360" data-height="640"></div></body></html>';
    expect(buildComposition({ id: 's', engine: 'hyperframes', durationFrames: 30, props: {}, html: full }, output, theme)).toMatch(/<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/);
    expect(() => buildComposition({ id: 's', engine: 'hyperframes', durationFrames: 30, props: {}, html: full.replace('360', '1080') }, output, theme)).toThrow(/data-width="360"/);
  });
  it('rejects external scripts (e.g. GSAP from a CDN)', () => {
    expect(() =>
      buildComposition({ id: 's', engine: 'hyperframes', durationFrames: 30, props: {}, html: '<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>' }, output, theme)
    ).toThrow(PipelineError);
  });
  it('runs the CLI with telemetry, update checks and installs disabled', () => {
    const env = hyperframesEnv('/bin/chrome', '/tmp/cache', { PATH: '/usr/bin', SECRET_TOKEN: 'x', ELEVENLABS_API_KEY: 'k' });
    expect(env).toMatchObject({ HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_NO_AUTO_INSTALL: '1', HYPERFRAMES_BROWSER_PATH: '/bin/chrome' });
    expect(env.TMPDIR).toBe('/tmp/cache/hyperframes/tmp'); // temp files on the data volume, not a small /tmp tmpfs
    expect(env.HYPERFRAMES_CHROME_SANDBOX).toMatch(/^[01]$/); // the shared sandbox rule, never HyperFrames' silent fallback
    expect(hyperframesEnv('/bin/chrome', '/c', { REELFORGE_CHROMIUM_NO_SANDBOX: '1' }).HYPERFRAMES_CHROME_SANDBOX).toBe('0');
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.ELEVENLABS_API_KEY).toBeUndefined();
  });
  it('is a plugin with the hyperframes-title template and a pinned version', () => {
    const e = hyperframesEngine();
    expect(e.templates().map((t) => t.id)).toEqual(['hyperframes-title']);
    expect(hyperframesVersion()).toBe('0.9.77');
  });
});

describe('browser requirement', () => {
  it.runIf(requireBrowser)('REELFORGE_REQUIRE_BROWSER=1: a browser must be configured', () => expect(hasBrowser).toBe(true));
});

describe.skipIf(!hasBrowser)('renderHyperframesScene with the local HyperFrames renderer (needs REELFORGE_CHROMIUM_PATH)', () => {
  const tools = hasBrowser ? resolveTools() : (null as never);

  it('renders the hyperframes-title template at the exact size, fps and frame count; animation advances', async () => {
    const scene: RenderScene = { id: 'hf', engine: 'hyperframes', template: 'hyperframes-title', durationFrames: 45, props: { headline: 'HyperFrames works', subline: 'Rendered locally' } };
    const out = join(dir, 'hf.mp4');
    await renderHyperframesScene({ scene, output, theme, out, workDir: join(dir, 'w1'), cacheDir: join(dir, 'cache') });
    const info = await probe(tools.ffprobe, out);
    expect(checkExpectation(info, { width: 360, height: 640, fps: 30, frames: 45 }).filter((p) => !p.startsWith('pixel format') && !p.includes('audio'))).toEqual([]);
    const f0 = await frameStats(tools.ffmpeg, out, 0);
    const f30 = await frameStats(tools.ffmpeg, out, 30);
    expect(f0.yMax - f0.yMin).toBeGreaterThan(40); // non-empty first frame
    expect(Math.abs(f30.yAvg - f0.yAvg)).toBeGreaterThan(0.5); // the CSS animation was seeked
  }, 300_000);

  it('renders agent-supplied markup and blocks network requests', async () => {
    let hits = 0;
    const server = createServer((_q, r) => {
      hits++;
      r.writeHead(200).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const scene: RenderScene = {
        id: 'agent',
        engine: 'hyperframes',
        durationFrames: 30,
        props: {},
        html: `<div class="clip" data-start="0" data-duration="1" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"><h1 style="color:var(--rf-accent);font-size:60px">Agent</h1><img src="http://127.0.0.1:${port}/x.png"></div><script>fetch('http://127.0.0.1:${port}/js').catch(()=>{})</script>`,
      };
      const out = join(dir, 'agent.mp4');
      await renderHyperframesScene({ scene, output, theme, out, workDir: join(dir, 'w2'), cacheDir: join(dir, 'cache') });
      expect((await probe(tools.ffprobe, out)).frames).toBe(30);
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  }, 300_000);

  it('can be cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1500);
    const err = await renderHyperframesScene({
      scene: { id: 'c', engine: 'hyperframes', template: 'hyperframes-title', durationFrames: 300, props: { headline: 'Cancel me' } },
      output,
      theme,
      out: join(dir, 'c.mp4'),
      workDir: join(dir, 'w3'),
      cacheDir: join(dir, 'cache'),
      signal: controller.signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err.message).toMatch(/cancelled/);
  }, 120_000);
});
