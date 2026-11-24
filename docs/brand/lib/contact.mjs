// Contact sheets: every asset with its file name and pixel size, light and dark,
// circle-crop previews of avatars and 1:1 plus enlarged renders of the favicons.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SRC, C, fontFaceCss } from './brand.mjs';

const W = 2400;
const url = (rel) => 'file://' + path.join(ROOT, rel);

function css() {
  return `${fontFaceCss()}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;background:#E7E6E1;font-family:Geist,sans-serif;color:${C.ink};padding:56px 64px 72px}
h1{font-weight:600;font-size:40px;letter-spacing:-0.02em}
.sub{color:${C.mutedLight};font-size:20px;margin:8px 0 8px}
h2{font-weight:600;font-size:24px;letter-spacing:-0.01em;margin:44px 0 16px;padding-top:16px;border-top:2px solid #CFCDC5}
.row{display:flex;flex-wrap:wrap;gap:28px;align-items:flex-start}
.card{display:flex;flex-direction:column;gap:8px}
.lab{font-size:15px;line-height:1.35}
.lab b{font-weight:500}
.lab span{color:${C.mutedLight};font-family:'Geist Mono';font-size:13px}
.box{position:relative;display:flex;align-items:center;justify-content:center;border-radius:6px}
.l{background:${C.light}}.d{background:${C.dark}}.w{background:#FFFFFF}
.chk{background-color:#fff;background-image:linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%),linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%);background-size:16px 16px;background-position:0 0,8px 8px}
img{display:block}
.px{image-rendering:pixelated}
.safe{position:absolute;border:2px dashed ${C.orange};pointer-events:none}
.circle{border-radius:50%;overflow:hidden}
.pair{display:flex;gap:8px}`;
}

const sz = (a) => `${a.w}×${a.h}`;
function card(a, maxW, maxH, opts = {}) {
  const k = Math.min(maxW / a.w, maxH / a.h, opts.noUpscale ? 1 : 99);
  const w = Math.round(a.w * k), h = Math.round(a.h * k);
  const img = `<img src="${url(a.file)}" width="${w}" height="${h}" ${a.w <= 64 && k > 1 ? 'class="px"' : ''}>`;
  let safe = '';
  if (a.safe) safe = `<div class="safe" style="left:${a.safe.x * k}px;top:${a.safe.y * k}px;width:${a.safe.w * k}px;height:${a.safe.h * k}px"></div>`;
  let inner;
  if (a.transparent) {
    inner = `<div class="pair"><div class="box l" style="width:${w + 24}px;height:${h + 24}px">${img}</div><div class="box d" style="width:${w + 24}px;height:${h + 24}px">${img}</div></div>`;
  } else {
    inner = `<div class="box" style="width:${w}px;height:${h}px">${img}${safe}</div>`;
  }
  if (a.circle) {
    inner = `<div class="pair">${inner}<div class="box circle" style="width:${w}px;height:${h}px">${img}</div></div>`;
  }
  const note = opts.note ? ` · ${opts.note}` : '';
  return `<div class="card">${inner}<div class="lab"><b>${a.file}</b><br><span>${sz(a)}${a.safe ? ' · dashed: safe area' : ''}${a.circle ? ' · right: circle crop' : ''}${note}</span></div></div>`;
}

function svgCard(name, bgClass, h = 120, label) {
  return `<div class="card"><div class="box ${bgClass}" style="padding:28px 36px"><img src="${url('src/' + name)}" style="height:${h}px;width:auto"></div><div class="lab"><b>src/${name}</b><br><span>${label ?? 'vector'}</span></div></div>`;
}

export function contactSheets(A, cacheDir) {
  const by = (pre) => A.filter((a) => a.file.startsWith(pre));
  const f = (name) => A.find((a) => a.file.endsWith(name));

  // ---- sheet 1: identity and icons ----
  let s1 = `<h1>RenderWeld brand kit · sheet 1 of 2: identity and icons</h1><div class="sub">Approved (#410). Every asset is shown at a reduced scale with its real pixel size; transparent assets sit on light and dark.</div>`;
  s1 += `<h2>Master SVGs (src/)</h2><div class="row">`;
  s1 += svgCard('lockup-horizontal-light.svg', 'l', 90) + svgCard('lockup-horizontal-dark.svg', 'd', 90);
  s1 += svgCard('lockup-stacked-light.svg', 'l', 170) + svgCard('lockup-stacked-dark.svg', 'd', 170);
  s1 += svgCard('wordmark-light.svg', 'l', 60) + svgCard('wordmark-dark.svg', 'd', 60);
  s1 += svgCard('mark-light.svg', 'l', 150) + svgCard('mark-dark.svg', 'd', 150) + svgCard('mark-ink.svg', 'w', 150) + svgCard('mark-white.svg', 'd', 150);
  s1 += svgCard('app-tile.svg', 'l', 150) + svgCard('app-tile-square.svg', 'l', 150);
  s1 += `</div>`;

  // favicons at 1:1 and enlarged
  const fav = (bg, name, size) => `<div class="box ${bg}" style="width:${size + 24}px;height:${size + 24}px"><img src="${url(name)}" width="${size}" height="${size}"></div>`;
  const favz = (bg, name, size, z) => `<div class="box ${bg}" style="width:${size * z + 24}px;height:${size * z + 24}px"><img class="px" src="${url(name)}" width="${size * z}" height="${size * z}"></div>`;
  s1 += `<h2>Favicons: 1:1 and enlarged 8× (16 px) and 4× (32 px), nearest-neighbour</h2><div class="row" style="align-items:center">`;
  for (const bg of ['l', 'w', 'd']) {
    s1 += `<div class="card"><div class="pair" style="align-items:center">${fav(bg, 'web/favicon-16x16.png', 16)}${fav(bg, 'web/favicon-32x32.png', 32)}${favz(bg, 'web/favicon-16x16.png', 16, 8)}${favz(bg, 'web/favicon-32x32.png', 32, 4)}</div><div class="lab"><b>web/favicon-16x16.png, web/favicon-32x32.png</b><br><span>on ${bg === 'l' ? 'light' : bg === 'w' ? 'white' : 'dark (PNG/ICO are ink; dark tabs use icon.svg)'}</span></div></div>`;
  }
  s1 += `<div class="card"><div class="pair" style="align-items:center"><div class="box l" style="width:40px;height:40px"><img src="${url('web/icon.svg')}" width="16" height="16"></div><div class="box l" style="width:56px;height:56px"><img src="${url('web/icon.svg')}" width="32" height="32"></div></div><div class="lab"><b>web/icon.svg</b><br><span>vector, follows the OS theme</span></div></div>`;
  s1 += `</div>`;

  s1 += `<h2>Web app icons (web/)</h2><div class="row">`;
  for (const a of by('web/')) if (!a.file.includes('favicon')) s1 += card(a, 220, 220, { noUpscale: true });
  s1 += `</div>`;

  s1 += `<h2>Avatars and app icons, with circle-crop previews</h2><div class="row">`;
  for (const a of [...by('social/').filter((a) => a.w === a.h), f('github/org-avatar.png'), ...by('slack-discord-apps/'), ...by('listings/').filter((a) => a.w === a.h)]) s1 += card(a, 160, 160);
  s1 += `</div>`;

  // ---- sheet 2: share, banners, business ----
  let s2 = `<h1>RenderWeld brand kit · sheet 2 of 2: share images, banners and print</h1><div class="sub">Dashed orange boxes show each platform's safe area for logo and text (not part of the files).</div>`;
  s2 += `<h2>Share images (share/) and GitHub (github/)</h2><div class="row">`;
  for (const a of [...by('share/'), ...by('github/').filter((a) => a.w !== a.h)]) s2 += card(a, a.w === a.h ? 520 : 680, 520);
  s2 += `</div>`;
  s2 += `<h2>Social banners and gallery (social/)</h2><div class="row">`;
  for (const a of by('social/').filter((a) => a.w !== a.h)) s2 += card(a, a.w / a.h > 4 ? 1100 : 720, 420);
  s2 += `</div>`;
  s2 += `<h2>Listings (listings/)</h2><div class="row">`;
  for (const a of by('listings/').filter((a) => a.w !== a.h)) s2 += card(a, 600, 340, { noUpscale: true });
  s2 += `</div>`;
  s2 += `<h2>Business (business/)</h2><div class="row">`;
  for (const a of by('business/')) s2 += card(a, a.w > 1000 ? 540 : 600, 320, { noUpscale: a.w < 1000 });
  s2 += `</div><div class="row" style="margin-top:28px">`;
  const pdfs = fs.readdirSync(cacheDir).filter((x) => x.startsWith('pdf-') && x.endsWith('.png')).sort();
  for (const p of pdfs) {
    const name = p.replace(/^pdf-/, '').replace(/-\d+\.png$/, '.pdf');
    const pg = p.match(/-(\d+)\.png$/)[1];
    s2 += `<div class="card"><div class="box w" style="padding:10px"><img src="file://${path.join(cacheDir, p)}" style="height:${name.includes('card') ? 220 : 420}px;width:auto"></div><div class="lab"><b>business/${name}</b><br><span>page ${Number(pg)}${name.includes('card') ? ' · bleed and crop marks' : ' · A4'}</span></div></div>`;
  }
  s2 += `<div class="card"><div class="box w" style="padding:10px"><img src="${url('business/letterhead-header.svg')}" style="width:520px"></div><div class="lab"><b>business/letterhead-header.svg</b><br><span>210×36 mm, outlined</span></div></div>`;
  s2 += `<div class="card"><div class="box w" style="padding:10px"><img src="${url('business/invoice-header.svg')}" style="width:520px"></div><div class="lab"><b>business/invoice-header.svg</b><br><span>210×58 mm, outlined</span></div></div>`;
  s2 += `</div>`;

  const sheets = [];
  for (const [i, body] of [s1, s2].entries()) {
    const file = path.join(cacheDir, `contact-${i + 1}.html`);
    fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>${css()}</style></head><body>${body}</body></html>`);
    sheets.push({ file, w: W });
  }
  return sheets;
}
