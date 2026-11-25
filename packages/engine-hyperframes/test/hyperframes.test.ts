import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PipelineError, checkExpectation, frameStats, probe, resolveTools } from '@renderweld/media-pipeline';
import { builtinTheme, type OutputSettings, type RenderScene } from '@renderweld/project-schema';
import { HF_CSP, buildComposition, hyperframesEngine, hyperframesEnv, hyperframesVersion, renderHyperframesScene, startNetworkSink } from '../src/index';
import { envValue } from '@renderweld/core';

const browser = envValue('REELFORGE_CHROMIUM_PATH');
const hasBrowser = Boolean(browser && existsSync(browser));
const requireBrowser = envValue('REELFORGE_REQUIRE_BROWSER') === '1';
const dir = mkdtempSync(join(tmpdir(), 'reelforge-hf-'));
// Best effort: renders reap their processes (SECT-38), but a cleanup problem must not fail the suite.
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn(`could not remove ${dir}: ${(e as Error).message}`);
  }
});

/** PIDs of processes whose TMPDIR lies under `prefix` (Linux /proc; [] elsewhere). */
function processesUnder(prefix: string): number[] {
  const out: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return out;
  }
  for (const e of entries.filter((x) => /^\d+$/.test(x))) {
    try {
      if (readFileSync(`/proc/${e}/environ`, 'latin1').split('\0').some((kv) => kv.startsWith(`TMPDIR=${prefix}`))) out.push(Number(e));
    } catch {
      // gone or not ours
    }
  }
  return out;
}
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
    expect(e.templates().map((t) => t.id)).toEqual(['hyperframes-layout', 'hyperframes-title']);
    expect(hyperframesVersion()).toBe('0.9.77');
  });
});

describe('security: composition isolation (SEC-01, SEC-02)', () => {
  const root = '<div data-composition-id="main" data-start="0" data-duration="1" data-width="360" data-height="640"><div class="clip" data-start="0" data-duration="1">x</div></div>';
  const scene = (html: string): RenderScene => ({ id: 's', engine: 'hyperframes', durationFrames: 30, props: {}, html });

  it('SECT-30 full documents: the CSP is the first element of the parsed <head> and the only policy', () => {
    for (const doc of [
      `<html><!-- <head> --><head><title>x</title></head><body>${root}</body></html>`,
      `<html><head><title><head></title></head><body>${root}</body></html>`,
      `<html data-a="<head>"><head></head><body>${root}</body></html>`,
    ]) {
      const out = buildComposition(scene(doc), output, theme);
      expect(out).toMatch(new RegExp(`^<html[^>]*><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HF_CSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`));
      expect(out.match(/http-equiv/g)).toHaveLength(1);
    }
  });

  it('SECT-31 documents that override or duplicate the policy, or load external scripts, are refused', () => {
    for (const doc of [
      `<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>${root}</body></html>`,
      `<html><head><meta http-equiv="refresh" content="0;url=http://127.0.0.1/"></head><body>${root}</body></html>`,
      `<html><head><base href="http://127.0.0.1/"></head><body>${root}</body></html>`,
      `<html><head></head><body>${root}<script src="//cdn.example.com/x.js"></script></body></html>`,
      `<html><head></head><body>${root}<script src=" HTTPS://cdn.example.com/x.js"></script></body></html>`,
    ]) {
      expect(() => buildComposition(scene(doc), output, theme), doc).toThrow(PipelineError);
    }
    expect(() => buildComposition(scene('<p>x</p><meta http-equiv="refresh" content="0">'), output, theme)).toThrow(/http-equiv/);
  });

  it('SECT-32 the CLI gets no server secrets and every outbound connection goes to the deny-all sink', () => {
    const env = hyperframesEnv('/bin/chrome', '/c', { PATH: '/usr/bin', DATABASE_URL: 'postgres://x', REELFORGE_SECRET_KEY: 's', REELFORGE_LICENCE_KEY: 'k', AWS_SECRET_ACCESS_KEY: 'a', HTTPS_PROXY: 'http://proxy:3128' }, 'http://127.0.0.1:9');
    for (const k of ['DATABASE_URL', 'REELFORGE_SECRET_KEY', 'REELFORGE_LICENCE_KEY', 'AWS_SECRET_ACCESS_KEY']) expect(env[k], k).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:9'); // never the server's proxy: Node's own proxy support goes to the sink too (#318)
    expect(env).toMatchObject({ PRODUCER_RESTRICT_PAGE_NETWORK: 'true', PRODUCER_NON_PUBLIC_CIDRS: '0.0.0.0/0,::/0', HYPERFRAMES_CAPTURE_PROXY: 'http://127.0.0.1:9' });
  });

  it('SECT-33 the sink refuses plain requests and CONNECT tunnels and reports each attempt', async () => {
    const seen: string[] = [];
    const sink = await startNetworkSink((t) => seen.push(t));
    try {
      const plain = await fetch(`${sink.url}/`, { headers: { host: 'example.com' } }).catch(() => null);
      expect(plain?.status).toBe(403);
      const { connect } = await import('node:net');
      const reply = await new Promise<string>((resolve) => {
        const u = new URL(sink.url);
        const sock = connect(Number(u.port), u.hostname, () => sock.write('CONNECT internal.example:443 HTTP/1.1\r\nHost: internal.example:443\r\n\r\n'));
        let data = '';
        sock.on('data', (d) => (data += d.toString()));
        sock.on('close', () => resolve(data));
        sock.on('error', () => resolve(data));
      });
      expect(reply).toMatch(/^HTTP\/1\.1 403/);
      expect(seen).toContain('internal.example:443');
      expect(seen.length).toBe(2);
    } finally {
      await sink.close();
    }
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

  it('SECT-38 no process of a render (CLI or browser) remains once it returns: success, cancel and timeout', async () => {
    const tmpRoot = join(dir, 'cache38', 'hyperframes', 'tmp');
    const base = { output, theme, workDir: join(dir, 'w38'), cacheDir: join(dir, 'cache38') };
    let seenRunning = 0;
    const watch = setInterval(() => (seenRunning = Math.max(seenRunning, processesUnder(tmpRoot).length)), 200);
    try {
      await renderHyperframesScene({ ...base, scene: { id: 'ok38', engine: 'hyperframes', template: 'hyperframes-title', durationFrames: 15, props: { headline: 'Done' } }, out: join(dir, 'ok38.mp4') });
      expect(processesUnder(tmpRoot)).toEqual([]);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 2500);
      const cancelled = await renderHyperframesScene({ ...base, scene: { id: 'c38', engine: 'hyperframes', template: 'hyperframes-title', durationFrames: 600, props: { headline: 'Cancel' } }, out: join(dir, 'c38.mp4'), signal: controller.signal }).catch((e) => e);
      expect(cancelled.message).toMatch(/cancelled/);
      expect(processesUnder(tmpRoot)).toEqual([]);
      const timedOut = await renderHyperframesScene({ ...base, scene: { id: 't38', engine: 'hyperframes', template: 'hyperframes-title', durationFrames: 600, props: { headline: 'Timeout' } }, out: join(dir, 't38.mp4'), timeoutMs: 2500 }).catch((e) => e);
      expect(timedOut.message).toMatch(/timed out/);
      expect(processesUnder(tmpRoot)).toEqual([]);
      expect(seenRunning).toBeGreaterThan(0); // the check does see a render's processes while it runs
      expect(readdirSync(tmpRoot)).toEqual([]); // per-render temp directories are removed
    } finally {
      clearInterval(watch);
    }
  }, 300_000);

  describe('security: no network from agent scenes (SEC-01, SEC-02)', () => {
    let hits: string[] = [];
    let port = 0;
    let udpPort = 0;
    const http = createServer((q, r) => {
      hits.push(`tcp ${q.url}`);
      r.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' }).end('<h1>INTERNAL-CANARY</h1>');
    });
    const udp = createSocket('udp4');
    udp.on('message', () => hits.push('udp'));
    beforeAll(async () => {
      await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
      port = (http.address() as AddressInfo).port;
      await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
      udpPort = udp.address().port;
    });
    afterAll(() => {
      http.close();
      udp.close();
    });
    const clip = '<div class="clip" data-start="0" data-duration="0.5" style="position:absolute;inset:0;background:#123">x</div>';
    const run = async (name: string, html: string) => {
      hits = [];
      const started = Date.now();
      const err = await renderHyperframesScene({
        scene: { id: name, engine: 'hyperframes', durationFrames: 15, props: {}, html },
        output: { width: 320, height: 320, fps: 30, format: 'mp4' },
        theme,
        out: join(dir, `${name}.mp4`),
        workDir: join(dir, `w-${name}`),
        cacheDir: join(dir, 'cache'),
      }).then(() => null, (e: Error) => e);
      await new Promise((r) => setTimeout(r, 500)); // late packets would show up here
      return { err, ms: Date.now() - started };
    };

    it('SECT-34 a full-document scene reaches nothing internal (iframe, img, fetch)', async () => {
      const doc = `<html><!-- <head> --><head><title>x</title></head><body><div data-composition-id="main" data-start="0" data-duration="0.5" data-width="320" data-height="320">${clip}<iframe src="http://127.0.0.1:${port}/iframe"></iframe><img src="http://127.0.0.1:${port}/img"><script>fetch('http://127.0.0.1:${port}/fetch').catch(()=>{})</script></div></body></html>`;
      await run('sect34', doc);
      expect(hits).toEqual([]);
    }, 300_000);

    it('SECT-35 navigating away fails the render fast with a clear error, and nothing is reached', async () => {
      const { err, ms } = await run('sect35', `${clip}<script>setTimeout(()=>{location.href='http://127.0.0.1:${port}/nav'},10)</script>`);
      expect(err).toBeInstanceOf(PipelineError);
      expect(err!.message).toMatch(/tried to reach the network/);
      expect(ms).toBeLessThan(60_000);
      expect(hits).toEqual([]);
    }, 300_000);

    it('SECT-36 WebRTC (STUN over UDP, also from a fresh iframe) sends no packets', async () => {
      const stun = `{iceServers:[{urls:'stun:127.0.0.1:${udpPort}'}]}`;
      await run(
        'sect36',
        `${clip}<script>try{const pc=new RTCPeerConnection(${stun});pc.createDataChannel('a');pc.createOffer().then(o=>pc.setLocalDescription(o))}catch(e){}` +
          `try{const f=document.createElement('iframe');document.body.appendChild(f);const pc=new f.contentWindow.RTCPeerConnection(${stun});pc.createDataChannel('b');pc.createOffer().then(o=>pc.setLocalDescription(o))}catch(e){}</script>`
      );
      expect(hits).toEqual([]);
    }, 300_000);

    it('SECT-37 a remote asset (fetched by the renderer outside the page) fails the render instead of being downloaded', async () => {
      const { err } = await run('sect37', `${clip}<img src="https://assets.example.com/logo.png">`);
      expect(err?.message).toMatch(/tried to reach the network \(assets\.example\.com:443\)/);
    }, 300_000);
  });
});
