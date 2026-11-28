// End to end: captures two pages from a local static server with the real
// pages step (Chromium + ffmpeg), checks the WebP files, the manifest entries
// and that a licence key and an email on the page were masked before the
// capture. Skips without a browser or ffmpeg unless RENDERWELD_REQUIRE_BROWSER=1.
// Run: pnpm test:capture
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { launch, newContext, readableText, shoot } from './browser.mjs';
import { pngSize } from './encode.mjs';
import { MASK, findSecrets, mergeCaptured, emptyManifest, parseArgs } from './lib.mjs';
import { createRun } from './run.mjs';
import { capturePages } from './steps/pages.mjs';

const KEY = 'ZX12C-DE34F-GH56J-KL78M-NP90Q';
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{font:16px system-ui;margin:0;padding:24px;background:#fff;color:#111}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}main{min-height:1400px}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`;
const PAGES = {
  '/': page('Home', `<p>Your licence key: <code>${KEY}</code></p><p>Signed in as buyer-e2e+test@reelforge.dev</p><input type="email" value="buyer-e2e+test@reelforge.dev"><p id="late"></p>
<script>setTimeout(() => { document.getElementById('late').textContent = 'Order key: ' + ['QW12E', 'RT34Y', 'UI56O', 'PA78S', 'DF90G'].join('-'); }, 300);</script>`),
  '/second': page('Second', '<p>Plain page.</p>'),
};

function available() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    return 'ffmpeg not found';
  }
  return null;
}

describe('capture e2e (local static server)', () => {
  let server;
  let site;
  let out;
  let browserProblem = available();
  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<urlset><url><loc>${site}/</loc></url><url><loc>${site}/second</loc></url></urlset>`);
      }
      const html = PAGES[url.pathname];
      res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' });
      res.end(html ?? page('Not found', ''));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    site = `http://127.0.0.1:${server.address().port}`;
    out = mkdtempSync(join(tmpdir(), 'rf-capture-e2e-'));
    if (!browserProblem) {
      try {
        const b = await launch();
        await b.close();
      } catch (e) {
        browserProblem = `no browser: ${e.message.split('\n')[0]}`;
      }
    }
  });
  after(() => {
    server?.close();
    if (out) rmSync(out, { recursive: true, force: true });
  });

  const skip = (t) => {
    if (!browserProblem) return false;
    if (process.env.RENDERWELD_REQUIRE_BROWSER === '1') throw new Error(browserProblem);
    t.skip(browserProblem);
    return true;
  };

  it('masks the key and the email before a page is captured, also when they appear later', { timeout: 60_000 }, async (t) => {
    if (skip(t)) return;
    const browser = await launch();
    try {
      const ctx = await newContext(browser, { width: 390, height: 844, theme: 'light' });
      const p = await ctx.newPage();
      await p.goto(`${site}/`);
      await p.waitForTimeout(800); // the late key arrives after load, under the observer (once looped forever)
      const text = await readableText(p);
      assert.ok(!text.includes('QW12E-RT34Y'), 'a key added after load is masked');
      assert.ok(text.includes(MASK.key), 'the key is replaced');
      assert.deepEqual(findSecrets(text), [], 'nothing readable is left');
      const shots = await shoot(p);
      assert.equal(pngSize(shots.fold).width, 780, 'fold at deviceScaleFactor 2');
      assert.ok(pngSize(shots.full).height > pngSize(shots.fold).height, 'full page is taller');
      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  it('captures 2 pages at one width and theme with deterministic names', async (t) => {
    if (skip(t)) return;
    const run = createRun(parseArgs(['--out', out, '--routes', '/,/second', '--widths', '390', '--themes', 'dark']));
    run.log = () => {};
    await capturePages(run, [site]);
    const keys = run.results.images.map((e) => e.key).sort();
    const label = `127-0-0-1-${new URL(site).port}`;
    assert.deepEqual(keys, [`store--${label}--home--390--dark--fold`, `store--${label}--home--390--dark--full`, `store--${label}--second--390--dark--fold`, `store--${label}--second--390--dark--full`]);
    for (const e of run.results.images) {
      const file = join(out, 'images', `${e.key}.webp`);
      const head = readFileSync(file).subarray(0, 12).toString('latin1');
      assert.ok(head.startsWith('RIFF') && head.endsWith('WEBP'), `${e.key} is a WebP`);
      assert.ok(statSync(file).size <= (e.crop === 'fold' ? 150_000 : 400_000), `${e.key} within budget`);
      assert.equal(e.status, 200);
    }
    const manifest = mergeCaptured(emptyManifest(), run.results.images);
    assert.equal(Object.keys(manifest.images).length, 4);
    assert.ok(Object.values(manifest.images).every((e) => e.pending && e.sha256 && !e.file));
  });
});
