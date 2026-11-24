#!/usr/bin/env node
// RenderWeld brand kit generator.
//   npm install && node build.mjs   -> rebuilds every derived file from src/ and the Geist fonts
// Needs: Node 18+, Playwright with Chromium, Python 3 + Pillow, pdftoppm (poppler) for the
// contact-sheet previews of the PDFs, and `zip`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, SRC, FONT_DIR, C, THEMES, TAGLINE_ONE, DOMAIN, readSvg, wordmarkSvg, lockupH, lockupV, font, MARK_BOX, r2 } from './lib/brand.mjs';
import * as T from './lib/templates.mjs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const g = execFileSync('npm', ['root', '-g']).toString().trim();
    return require(path.join(g, 'playwright'));
  }
}
const { chromium } = loadPlaywright();

const out = (...p) => path.join(ROOT, ...p);
const mkdir = (d) => fs.mkdirSync(out(d), { recursive: true });
const write = (rel, s) => (mkdir(path.dirname(rel)), fs.writeFileSync(out(rel), s));
const CACHE = out('.cache');

// ---------- 0. fonts + licence ----------
const GEIST = path.join(ROOT, 'node_modules/geist');
fs.mkdirSync(FONT_DIR, { recursive: true });
for (const f of ['Geist-Regular', 'Geist-Medium', 'Geist-SemiBold']) {
  for (const ext of ['ttf', 'woff2']) fs.copyFileSync(path.join(GEIST, 'dist/fonts/geist-sans', `${f}.${ext}`), path.join(FONT_DIR, `${f}.${ext}`));
}
for (const ext of ['ttf', 'woff2']) fs.copyFileSync(path.join(GEIST, 'dist/fonts/geist-mono', `GeistMono-Medium.${ext}`), path.join(FONT_DIR, `GeistMono-Medium.${ext}`));
fs.copyFileSync(path.join(GEIST, 'LICENSE.txt'), path.join(FONT_DIR, 'OFL-LICENSE.txt'));
const geistVersion = JSON.parse(fs.readFileSync(path.join(GEIST, 'package.json'))).version;
write('fonts/SOURCE.txt', `Geist and Geist Mono, from the npm package "geist" version ${geistVersion} (Vercel, with basement.studio).\nLicence: SIL Open Font License 1.1, see OFL-LICENSE.txt.\nOnly the weights this kit uses are copied here. The fonts are bundled for building the kit; the logo SVGs are outlined and need no font.\n`);

// ---------- 1. derived src SVGs (outlined wordmark and lockups) ----------
write('src/wordmark-light.svg', wordmarkSvg(C.ink));
write('src/wordmark-dark.svg', wordmarkSvg(C.onDark));
for (const th of ['light', 'dark']) {
  write(`src/lockup-horizontal-${th}.svg`, lockupH(th).svg);
  write(`src/lockup-stacked-${th}.svg`, lockupV(th).svg);
}

// ---------- 2. asset list ----------
const A = []; // {file, w, h, html, transparent, use, who, group}
const add = (file, w, h, html, meta = {}) => A.push({ file, w, h, html, ...meta });
const safeM = (w, h, mx, my = mx) => ({ x: mx, y: my, w: w - 2 * mx, h: h - 2 * my });

// web
add('web/favicon-16x16.png', 16, 16, T.smallMark(16, 'mark-16.svg'), { transparent: true });
add('web/favicon-32x32.png', 32, 32, T.smallMark(32, 'mark-32.svg'), { transparent: true });
add('.cache/favicon-48x48.png', 48, 48, T.tile(48, { variant: 'mark', theme: 'light', scale: 30.5 / 32 }), { transparent: true });
add('web/apple-touch-icon.png', 180, 180, T.tile(180, { variant: 'square', scale: 0.6 }));
add('web/android-chrome-192x192.png', 192, 192, T.tile(192, { variant: 'rounded', scale: 0.6 }), { transparent: true });
add('web/android-chrome-512x512.png', 512, 512, T.tile(512, { variant: 'rounded', scale: 0.6 }), { transparent: true });
add('web/maskable-512x512.png', 512, 512, T.tile(512, { variant: 'square', scale: 0.56 }));
// Opaque, like the other app icons: the dark mark (orange weld dot) on the TileColor square. A
// transparent all-white mark vanished on light backgrounds and dropped the orange dot.
add('web/mstile-150x150.png', 150, 150, T.tile(150, { variant: 'square', scale: 0.5 }));

// share
const og = (w, h, th) => T.hero(w, h, th, safeM(w, h, 72, 64));
add('share/og-image.png', 1200, 630, og(1200, 630, 'light'));
add('share/og-image-dark.png', 1200, 630, og(1200, 630, 'dark'));
add('share/twitter-card.png', 1200, 675, og(1200, 675, 'light'));
add('share/linkedin-share.png', 1200, 627, og(1200, 627, 'light'));
add('share/og-image-square.png', 1200, 1200, T.heroSquare(1200, 1200, 'light', safeM(1200, 1200, 100)));

// github
add('github/social-preview.png', 1280, 640, T.hero(1280, 640, 'light', { x: 112, y: 84, w: 1056, h: 472 }), { safe: { x: 40, y: 20, w: 1200, h: 600 } });
add('github/social-preview-dark.png', 1280, 640, T.hero(1280, 640, 'dark', { x: 112, y: 84, w: 1056, h: 472 }), { safe: { x: 40, y: 20, w: 1200, h: 600 } });
add('github/org-avatar.png', 500, 500, T.tile(500, { scale: 0.56 }), { circle: true });
for (const th of ['light', 'dark']) add(`github/readme-banner-${th}.png`, 1280, 320, T.twoCol(1280, 320, th, safeM(1280, 320, 88, 64)));

// social: avatars (opaque, circle-safe)
const avatars = [
  ['social/x-avatar-400x400.png', 400],
  ['social/linkedin-logo-400x400.png', 400],
  ['social/youtube-channel-icon-800x800.png', 800],
  ['social/instagram-threads-avatar-320x320.png', 320],
  ['social/tiktok-avatar-200x200.png', 200],
  ['social/facebook-profile-720x720.png', 720],
  ['social/discord-server-icon-512x512.png', 512],
  ['social/bluesky-avatar-1000x1000.png', 1000],
  ['social/producthunt-thumbnail-240x240.png', 240],
  ['social/reddit-avatar-256x256.png', 256],
  ['social/mastodon-avatar-400x400.png', 400],
];
for (const [f, s] of avatars) add(f, s, s, T.tile(s, { scale: 0.56 }), { circle: true });

// social: banners. S = where logo and text may go (platform crops and avatar overlap kept clear).
const X_SAFE = { x: 470, y: 96, w: 950, h: 300 };
add('social/x-header-1500x500.png', 1500, 500, T.twoCol(1500, 500, 'light', X_SAFE), { safe: X_SAFE });
add('social/mastodon-header-1500x500.png', 1500, 500, T.twoCol(1500, 500, 'light', X_SAFE), { safe: X_SAFE });
const LI_SAFE = { x: 270, y: 34, w: 800, h: 123 };
add('social/linkedin-cover-1128x191.png', 1128, 191, T.twoCol(1128, 191, 'light', LI_SAFE, { lockup: false }), { safe: LI_SAFE });
const LI2 = { x: 362, y: 46, w: 1072, h: 164 };
add('social/linkedin-cover-1512x256.png', 1512, 256, T.twoCol(1512, 256, 'light', LI2, { lockup: false }), { safe: LI2 });
const YT_SAFE = { x: 507, y: 508, w: 1546, h: 424 };
add('social/youtube-banner-2560x1440.png', 2560, 1440, T.twoCol(2560, 1440, 'light', { x: 547, y: 532, w: 1466, h: 376 }), { safe: YT_SAFE });
const FB_SAFE = { x: 290, y: 96, w: 1060, h: 432 };
add('social/facebook-cover-1640x624.png', 1640, 624, T.twoCol(1640, 624, 'light', FB_SAFE), { safe: FB_SAFE });
const DC_SAFE = { x: 96, y: 150, w: 768, h: 240 };
add('social/discord-server-banner-960x540.png', 960, 540, T.twoCol(960, 540, 'light', DC_SAFE, { tagline: false, lh: 76, ch: 220 }), { safe: DC_SAFE });
const BS_SAFE = { x: 800, y: 220, w: 1960, h: 560 };
add('social/bluesky-banner-3000x1000.png', 3000, 1000, T.twoCol(3000, 1000, 'light', BS_SAFE), { safe: BS_SAFE });
const RD_SAFE = { x: 400, y: 80, w: 1120, h: 224 };
add('social/reddit-banner-1920x384.png', 1920, 384, T.twoCol(1920, 384, 'light', RD_SAFE), { safe: RD_SAFE });
add('social/producthunt-gallery-1-1270x760.png', 1270, 760, T.hero(1270, 760, 'light', safeM(1270, 760, 80, 72)));
add('social/producthunt-gallery-2-1270x760.png', 1270, 760, T.howItWorks(1270, 760, 'light'));

// slack / discord / github apps
add('slack-discord-apps/slack-app-icon-512x512.png', 512, 512, T.tile(512, { scale: 0.6 }));
add('slack-discord-apps/slack-app-icon-1024x1024.png', 1024, 1024, T.tile(1024, { scale: 0.6 }));
add('slack-discord-apps/slack-workspace-icon-512x512.png', 512, 512, T.tile(512, { scale: 0.6 }));
add('slack-discord-apps/discord-app-icon-1024x1024.png', 1024, 1024, T.tile(1024, { scale: 0.56 }), { circle: true });
add('slack-discord-apps/github-app-logo-1024x1024.png', 1024, 1024, T.tile(1024, { scale: 0.56 }), { circle: true });

// listings
add('listings/dockerhub-logo-512x512.png', 512, 512, T.tile(512, { scale: 0.6 }));
add('listings/listing-icon-512x512.png', 512, 512, T.tile(512, { variant: 'rounded', scale: 0.6 }), { transparent: true });
add('listings/google-business-logo-720x720.png', 720, 720, T.tile(720, { scale: 0.56 }), { circle: true });
add('listings/google-business-cover-1080x608.png', 1080, 608, T.hero(1080, 608, 'light', safeM(1080, 608, 72, 64)));
add('listings/directory-card-800x418.png', 800, 418, T.hero(800, 418, 'light', safeM(800, 418, 48, 44)));
add('listings/promo-tile-440x280.png', 440, 280, T.hero(440, 280, 'light', safeM(440, 280, 28, 26), { domain: false }));

// business rasters
add('business/email-signature-300x80.png', 300, 80, T.emailSig(300, 80, 1));
add('business/email-signature-600x160.png', 600, 160, T.emailSig(600, 160, 2));
for (const th of ['light', 'dark']) {
  add(`business/slide-title-${th}-1920x1080.png`, 1920, 1080, T.slideTitle(th));
  add(`business/slide-section-${th}-1920x1080.png`, 1920, 1080, T.slideSection(th));
}

// ---------- 3. vector web files ----------
fs.mkdirSync(out('web'), { recursive: true });
fs.copyFileSync(path.join(SRC, 'icon.svg'), out('web/icon.svg'));
fs.copyFileSync(path.join(SRC, 'icon.svg'), out('web/favicon.svg'));
// Safari pinned tab: one colour, no style, black on transparent.
write('web/safari-pinned-tab.svg', readSvg('mark-ink.svg').replace(/#141413/g, '#000000').replace(/<title>.*?<\/title>/, ''));
write(
  'web/site.webmanifest',
  JSON.stringify(
    {
      name: 'RenderWeld',
      short_name: 'RenderWeld',
      description: TAGLINE_ONE,
      start_url: '/',
      display: 'standalone',
      theme_color: C.dark,
      background_color: C.dark,
      icons: [
        { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ],
    },
    null,
    2
  ) + '\n'
);
write('web/browserconfig.xml', `<?xml version="1.0" encoding="utf-8"?>\n<browserconfig>\n  <msapplication>\n    <tile>\n      <square150x150logo src="/mstile-150x150.png"/>\n      <TileColor>${C.dark}</TileColor>\n    </tile>\n  </msapplication>\n</browserconfig>\n`);
write(
  'web/head-snippet.html',
  `<!-- RenderWeld icons and metadata. Files from web/ are served from the site root; share/ images from /og/. -->
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon-16x16.png" type="image/png" sizes="16x16">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
<link rel="mask-icon" href="/safari-pinned-tab.svg" color="${C.ink}">
<link rel="manifest" href="/site.webmanifest">
<meta name="msapplication-config" content="/browserconfig.xml">
<meta name="msapplication-TileColor" content="${C.dark}">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${C.light}">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${C.dark}">
<meta name="color-scheme" content="light dark">

<meta property="og:type" content="website">
<meta property="og:site_name" content="RenderWeld">
<meta property="og:title" content="RenderWeld">
<meta property="og:description" content="${TAGLINE_ONE}">
<meta property="og:url" content="https://${DOMAIN}/">
<meta property="og:image" content="https://${DOMAIN}/og/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="RenderWeld: ${TAGLINE_ONE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="RenderWeld">
<meta name="twitter:description" content="${TAGLINE_ONE}">
<meta name="twitter:image" content="https://${DOMAIN}/og/twitter-card.png">
<meta name="twitter:image:alt" content="RenderWeld: ${TAGLINE_ONE}">
`
);

// business SVG headers (text outlined so they need no font)
function textPath(text, x, y, size, weight, fill, anchor = 'start') {
  const f = font(weight);
  const w = f.getAdvanceWidth(text, size, { kerning: true });
  const x0 = anchor === 'end' ? x - w : x;
  return `<path fill="${fill}" d="${f.getPath(text, x0, y, size, { kerning: true }).toPathData(2)}"/>`;
}
function headerSvg() {
  // 210 x 36 mm, user units = mm
  const L = lockupH('light');
  const lhmm = 7;
  const s = lhmm / L.h;
  const inner = L.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '').replace(/<title>.*?<\/title>/, '');
  const vbTop = Number(L.svg.match(/viewBox="0 ([-\d.]+)/)[1]);
  let b = `<g transform="translate(20 16) scale(${s}) translate(0 ${-vbTop})">${inner}</g>`;
  b += textPath(DOMAIN, 190, 18.4, 3, 400, C.mutedLight, 'end');
  b += textPath('hello@renderweld.com', 190, 22.9, 3, 400, C.mutedLight, 'end');
  b += `<rect x="20" y="31" width="170" height="0.3" fill="${C.ruleLight}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 36" width="210mm" height="36mm"><title>RenderWeld letterhead header</title>${b}</svg>\n`;
}
write('business/letterhead-header.svg', headerSvg());
{
  // invoice header: same band plus the word "Invoice"
  let s = headerSvg();
  s = s.replace('letterhead header', 'invoice header').replace('viewBox="0 0 210 36" width="210mm" height="36mm"', 'viewBox="0 0 210 58" width="210mm" height="58mm"');
  s = s.replace('</svg>', `${textPath('Invoice', 20, 52, 9, 600, C.ink)}</svg>`);
  write('business/invoice-header.svg', s);
}

// ---------- 4. render ----------
mkdir('.cache');
const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const page = await ctx.newPage();
async function shot(html, file, w, h, transparent) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  mkdir(path.dirname(file));
  await page.screenshot({ path: out(file), omitBackground: !!transparent, clip: { x: 0, y: 0, width: w, height: h } });
}
for (const a of A) await shot(a.html, a.file, a.w, a.h, a.transparent);
console.log(`rendered ${A.length} rasters`);

const PDF_DATE = '20261124000000'; // kit version date
async function pdf(html, file, wmm, hmm) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  mkdir(path.dirname(file));
  await page.pdf({ path: out(file), width: `${wmm}mm`, height: `${hmm}mm`, printBackground: true, preferCSSPageSize: true });
  // Pin the timestamps (same byte length, so xref offsets stay valid) for byte-reproducible PDFs.
  const buf = fs.readFileSync(out(file)).toString('latin1');
  fs.writeFileSync(out(file), Buffer.from(buf.replace(/\/(CreationDate|ModDate) \(D:\d{14}/g, (m, k) => `/${k} (D:${PDF_DATE}`), 'latin1'));
}
const us = T.businessCard(88.9, 50.8);
await pdf(us.html, 'business/business-card-us-3.5x2in.pdf', us.W, us.H);
const eu = T.businessCard(85, 55);
await pdf(eu.html, 'business/business-card-eu-85x55mm.pdf', eu.W, eu.H);
await pdf(T.letterhead(), 'business/letterhead-a4.pdf', 210, 297);
await pdf(T.invoice(), 'business/invoice-a4.pdf', 210, 297);
const cmyk = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const k = 1 - Math.max(r, g, b);
  const f = (x) => Math.round(((1 - x - k) / (1 - k || 1)) * 100);
  return `${f(r)} ${f(g)} ${f(b)} ${Math.round(k * 100)}`;
};
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
const colours = [
  [C.ink, 'Ink', rgb(C.ink), cmyk(C.ink), 'Text and frames on light'],
  [C.orange, 'Signal orange', rgb(C.orange), cmyk(C.orange), 'The one accent: the weld dot'],
  [C.light, 'Light', rgb(C.light), cmyk(C.light), 'Light background'],
  [C.dark, 'Dark', rgb(C.dark), cmyk(C.dark), 'Dark background, app tile'],
];
await pdf(T.pressKit({ colours }), 'business/press-kit.pdf', 210, 297);
console.log('rendered PDFs');

// ---------- 5. post-process (ICO, sizes, circle checks, PNG optimisation) ----------
const checks = {
  ico: { out: 'web/favicon.ico', sources: ['web/favicon-16x16.png', 'web/favicon-32x32.png', '.cache/favicon-48x48.png'] },
  sizes: Object.fromEntries(A.map((a) => [a.file, [a.w, a.h]])),
  // limit: share of the radius the mark may reach. 0.8 = maskable safe zone; 0.78 leaves room for circle crops.
  circle: Object.fromEntries([
    ...A.filter((a) => a.circle).map((a) => [a.file, [C.dark, 0.78]]),
    ['web/maskable-512x512.png', [C.dark, 0.8]],
    ['web/apple-touch-icon.png', [C.dark, 0.8]],
    ['web/mstile-150x150.png', [C.dark, 0.8]],
  ]),
};
fs.writeFileSync(path.join(CACHE, 'checks.json'), JSON.stringify(checks));
execFileSync('python3', ['-I', out('lib/post.py'), ROOT, path.join(CACHE, 'checks.json')], { stdio: 'inherit' });

// ---------- 5b. asset index in BRAND.md ----------
{
  const { assetIndex } = await import('./lib/index.mjs');
  const md = fs.readFileSync(out('BRAND.md'), 'utf8');
  const next = md.replace(/<!-- asset-index:start -->[\s\S]*<!-- asset-index:end -->/, `<!-- asset-index:start -->\n${assetIndex(A)}\n<!-- asset-index:end -->`);
  fs.writeFileSync(out('BRAND.md'), next);
}

// ---------- 6. contact sheets ----------
for (const f of fs.readdirSync(out('business')).filter((f) => f.endsWith('.pdf'))) {
  execFileSync('pdftoppm', ['-png', '-r', '72', out('business', f), path.join(CACHE, 'pdf-' + f.replace('.pdf', ''))]);
}
const { contactSheets } = await import('./lib/contact.mjs');
const sheets = contactSheets(A, CACHE);
for (const [i, s] of sheets.entries()) {
  await page.setViewportSize({ width: s.w, height: 800 });
  await page.goto('file://' + s.file);
  await page.evaluate(() => document.fonts.ready);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: s.w, height: h });
  await page.screenshot({ path: out(`contact-sheet-${i + 1}.png`), fullPage: true });
}
await browser.close();
execFileSync('python3', ['-I', '-c', `
from PIL import Image
import sys
for p in sys.argv[1:]:
    im = Image.open(p); im.load(); im.save(p, optimize=True)
`, ...sheets.map((_, i) => out(`contact-sheet-${i + 1}.png`))]);
console.log(`contact sheets: ${sheets.length}`);

// ---------- 7. zip ----------
const zip = out('renderweld-brand-kit.zip');
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-qrX', zip, '.', '-x', 'node_modules/*', '.cache/*', 'renderweld-brand-kit.zip', '.gitignore', '.npmrc'], { cwd: ROOT });
console.log('zip:', zip, (fs.statSync(zip).size / 1e6).toFixed(2), 'MB');
