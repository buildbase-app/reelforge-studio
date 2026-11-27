import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PipelineError, checkExpectation, frameStats, probe, resolveTools } from '@renderweld/media-pipeline';
import { builtinTheme, type OutputSettings, type RenderScene } from '@renderweld/project-schema';
import { CSP, buildDocument, chromiumSandbox, escapeHtml, htmlEngine, htmlTitle, renderHtmlScene } from '../src/index';

const browser = process.env.RENDERWELD_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const requireBrowser = process.env.REELFORGE_REQUIRE_BROWSER === '1';
const dir = mkdtempSync(join(tmpdir(), 'reelforge-html-'));
// Chrome can still be flushing its profile when the suite ends; retry ENOTEMPTY/EBUSY.
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const output: OutputSettings = { width: 360, height: 640, fps: 30, format: 'mp4' };
const theme = builtinTheme('midnight')!.tokens;

describe('document builder', () => {
  it('wraps agent html in a CSP shell with theme variables', () => {
    const doc = buildDocument({ html: '<h1>Hi</h1>', css: 'h1{color:var(--rf-accent)}', theme, output, durationSeconds: 2 });
    expect(doc).toContain(CSP);
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain(`--rf-accent:${theme.colors.accent}`);
    expect(doc).toContain('--rf-width:360px');
  });
  it('refuses css that would break out of its style element', () => {
    expect(() => buildDocument({ html: '', css: '</style><script>x</script>', theme, output, durationSeconds: 1 })).toThrow(/<\/style/);
  });
  it('escapes template text', () => {
    expect(escapeHtml('<b>"x"&\'')).toBe('&lt;b&gt;&quot;x&quot;&amp;&#39;');
    expect(htmlTitle({ headline: '<script>alert(1)</script>' }, 2).html).not.toContain('<script>');
  });
  it('keeps the Chromium sandbox on unless root or explicitly disabled', () => {
    expect(chromiumSandbox({ RENDERWELD_CHROMIUM_NO_SANDBOX: '1' })).toBe(false);
    if (process.getuid?.() !== 0) expect(chromiumSandbox({})).toBe(true);
  });
  it('reports itself as a plugin with the html-title template', () => {
    const e = htmlEngine();
    expect(e.id).toBe('html');
    expect(e.acceptsSource).toBe(true);
    expect(e.templates().map((t) => t.id)).toEqual(['html-title', 'html-layout']);
  });
});

describe('security: document shell (SEC-01)', () => {
  it('SECT-40 markup that sets its own page policy is refused; the CSP stays the first element of <head>', async () => {
    const { parse } = await import('parse5');
    for (const html of ['<meta http-equiv="refresh" content="0;url=http://127.0.0.1/">', '<META HTTP-EQUIV="Content-Security-Policy" content="default-src *">', '<base href="http://127.0.0.1/">', '<template><meta http-equiv="refresh" content="0"></template>']) {
      expect(() => buildDocument({ html, css: '', theme, output, durationSeconds: 1 }), html).toThrow(/http-equiv|<base>/);
    }
    const doc = buildDocument({ html: '<!-- </head><head> --></div></body></html><html><head><title>x</title></head><p>y</p>', css: '', theme, output, durationSeconds: 1 });
    const head = (parse(doc).childNodes.find((n: any) => n.tagName === 'html') as any).childNodes.find((n: any) => n.tagName === 'head');
    const els = head.childNodes.filter((n: any) => n.tagName);
    expect(els[0].attrs).toEqual([{ name: 'charset', value: 'utf-8' }]);
    expect(els[1].attrs.find((a: any) => a.name === 'content').value).toBe(CSP);
  });
});

describe('browser requirement', () => {
  it.runIf(requireBrowser)('REELFORGE_REQUIRE_BROWSER=1: a browser must be configured', () => {
    expect(hasBrowser).toBe(true);
  });
});

describe.skipIf(!hasBrowser)('renderHtmlScene (needs RENDERWELD_CHROMIUM_PATH)', () => {
  const tools = hasBrowser ? resolveTools() : (null as never);

  it('renders the built-in html-title template: exact frames, non-empty first frame', async () => {
    const scene: RenderScene = { id: 'title', engine: 'html', template: 'html-title', durationFrames: 45, props: { headline: 'HTML scenes work', subline: 'Seeked per frame', kicker: 'NEW' } };
    const out = join(dir, 'title.mp4');
    let last = 0;
    const res = await renderHtmlScene({ scene, output, theme, out, ffmpeg: tools.ffmpeg, onProgress: (d) => (last = d) });
    expect(res.frames).toBe(45);
    expect(last).toBe(45);
    const info = await probe(tools.ffprobe, out);
    expect(checkExpectation(info, { width: 360, height: 640, fps: 30, frames: 45, audio: false })).toEqual([]);
    const first = await frameStats(tools.ffmpeg, out, 0);
    expect(first.yMax - first.yMin).toBeGreaterThan(40);
  }, 120_000);

  it('seeks CSS animations deterministically (frame N shows the animation at N/fps)', async () => {
    // A white box whose opacity goes 0 -> 1 linearly over 1 s on a black page.
    const scene: RenderScene = {
      id: 'fade',
      engine: 'html',
      durationFrames: 31,
      props: {},
      html: '<div id="b"></div>',
      css: 'body{background:#000}#b{position:absolute;inset:0;background:#fff;animation:f 1s linear both}@keyframes f{from{opacity:0}to{opacity:1}}',
    };
    const out = join(dir, 'fade.mp4');
    await renderHtmlScene({ scene, output, theme, out, ffmpeg: tools.ffmpeg });
    const a = await frameStats(tools.ffmpeg, out, 0);
    const mid = await frameStats(tools.ffmpeg, out, 15);
    const b = await frameStats(tools.ffmpeg, out, 30);
    expect(a.yAvg).toBeLessThan(25);
    expect(mid.yAvg).toBeGreaterThan(90);
    expect(mid.yAvg).toBeLessThan(170);
    expect(b.yAvg).toBeGreaterThan(220);
  }, 120_000);

  it('blocks all network access and page scripts', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'image/png' }).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const scene: RenderScene = {
        id: 'net',
        engine: 'html',
        durationFrames: 3,
        props: {},
        html: `<img src="http://127.0.0.1:${port}/x.png"><div id="s" style="width:100px;height:100px;background:#fff"></div><script>document.getElementById('s').style.background='#f00'; fetch('http://127.0.0.1:${port}/js')</script><iframe src="http://127.0.0.1:${port}/frame"></iframe>`,
        css: `@import url(http://127.0.0.1:${port}/a.css); body{background:url(http://127.0.0.1:${port}/bg.png)}`,
      };
      const res = await renderHtmlScene({ scene, output, theme, out: join(dir, 'net.mp4'), ffmpeg: tools.ffmpeg });
      expect(res.frames).toBe(3);
      expect(hits).toBe(0);
      // The inline script would have turned the white square red: it must not run.
      expect((await frameStats(tools.ffmpeg, join(dir, 'net.mp4'), 0)).yMax).toBeGreaterThan(200);
    } finally {
      server.close();
    }
  }, 120_000);

  it('times out and cancels cleanly', async () => {
    const scene: RenderScene = { id: 'slow', engine: 'html', template: 'html-title', durationFrames: 300, props: { headline: 'Slow' } };
    const err = await renderHtmlScene({ scene, output, theme, out: join(dir, 'slow.mp4'), ffmpeg: tools.ffmpeg, timeoutMs: 1500 }).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err.message).toMatch(/timed out/);
    const controller = new AbortController();
    const cancelled = await renderHtmlScene({
      scene,
      output,
      theme,
      out: join(dir, 'cancel.mp4'),
      ffmpeg: tools.ffmpeg,
      signal: controller.signal,
      onProgress: (d) => d === 5 && controller.abort(),
    }).catch((e) => e);
    expect(cancelled).toBeInstanceOf(PipelineError);
    expect(cancelled.message).toMatch(/cancelled/);
  }, 120_000);
});
