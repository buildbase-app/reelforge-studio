// HTML templates. Every template returns a full HTML document sized to exact pixels
// (rasters) or to a physical page (PDFs). Layout maths uses Geist's real metrics.
import { C, THEMES, TAGLINE, TAGLINE_ONE, DOMAIN, EMAIL, svgSized, markSvg, lockupAt, lockupWidth, cueSvg, measure, fontFaceCss, MARK_BOX, r2 } from './brand.mjs';

let FONT_CSS = null;
const fontCss = () => (FONT_CSS ??= fontFaceCss());

const TRACK = -0.02; // display tracking, same as the wordmark

export function doc(w, h, bg, body, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss()}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:${bg};-webkit-font-smoothing:antialiased}
body{position:relative;font-family:Geist,sans-serif;font-feature-settings:'ss01' 0}
.a{position:absolute}
svg{display:block}
${extraCss}</style></head><body>${body}</body></html>`;
}

const tagEm = Math.max(...TAGLINE.map((l) => measure(l, 1, 600, TRACK)));
const tagOneEm = measure(TAGLINE_ONE, 1, 600, TRACK);

function tagline(theme, x, y, fs, lines = TAGLINE, align = 'left') {
  const t = THEMES[theme];
  const html = lines.map((l) => `<div>${l}</div>`).join('');
  return `<div class="a" style="left:${r2(x)}px;top:${r2(y)}px;font-weight:600;font-size:${r2(fs)}px;line-height:1.12;letter-spacing:${TRACK}em;color:${t.fg};white-space:nowrap;text-align:${align}">${html}</div>`;
}
function textAt(theme, x, y, fs, text, { weight = 500, color, anchor = 'left', mono = false } = {}) {
  const t = THEMES[theme];
  const pos = anchor === 'right' ? `right:${r2(x)}px` : anchor === 'center' ? `left:${r2(x)}px;transform:translateX(-50%)` : `left:${r2(x)}px`;
  return `<div class="a" style="${pos};top:${r2(y)}px;font-family:${mono ? "'Geist Mono'" : 'Geist'};font-weight:${weight};font-size:${r2(fs)}px;line-height:1;color:${color ?? t.muted};white-space:nowrap">${text}</div>`;
}
const at = (x, y, inner) => `<div class="a" style="left:${r2(x)}px;top:${r2(y)}px">${inner}</div>`;

/**
 * Hero: lockup top-left, tagline as the headline, product cue bottom-right, domain bottom-left.
 * S = safe rect {x,y,w,h}. Used by OG, social preview, Product Hunt, listing cards.
 */
export function hero(w, h, theme, S, o = {}) {
  const t = THEMES[theme];
  const lh = o.lockup ?? Math.max(18, S.h * 0.085);
  const fs = o.fs ?? Math.min((S.w * 0.98) / tagEm, S.h * 0.115);
  const tagTop = S.y + lh + Math.max(lh * 1.1, S.h * 0.1);
  const tagH = fs * 1.12 * 2;
  const cueTop = tagTop + tagH + Math.max(fs * 0.7, S.h * 0.08);
  let ch = S.y + S.h - cueTop;
  let cue = cueSvg(theme, ch, { labels: ch > 110 });
  if (cue.w > S.w * (o.cueMaxW ?? 0.62)) cue = cueSvg(theme, (ch * S.w * (o.cueMaxW ?? 0.62)) / cue.w, { labels: ch > 110 });
  const domFs = Math.max(11, lh * 0.5);
  let body = at(S.x, S.y, lockupAt(theme, lh));
  body += tagline(theme, S.x, tagTop, fs);
  body += at(S.x + S.w - cue.w + cue.h * 0.035, S.y + S.h - cue.h, cue.svg);
  if (o.domain !== false) body += textAt(theme, S.x, S.y + S.h - domFs, domFs, DOMAIN);
  return doc(w, h, t.bg, body);
}

/** Square hero: lockup, cue centred, tagline below. */
export function heroSquare(w, h, theme, S) {
  const t = THEMES[theme];
  const lh = S.h * 0.06;
  const fs = Math.min((S.w * 0.98) / tagEm, S.h * 0.075);
  const tagH = fs * 1.12 * 2;
  const domFs = lh * 0.5;
  const cueH = S.h * 0.36;
  const cue = cueSvg(theme, cueH);
  const tagTop = S.y + S.h - tagH - domFs - S.h * 0.07;
  const cueTop = S.y + lh + (tagTop - (S.y + lh) - cueH) / 2;
  let body = at(S.x, S.y, lockupAt(theme, lh));
  body += at(S.x + (S.w - cue.w) / 2, cueTop, cue.svg);
  body += tagline(theme, S.x, tagTop, fs);
  body += textAt(theme, S.x, S.y + S.h - domFs, domFs, DOMAIN);
  return doc(w, h, t.bg, body);
}

/**
 * Strip: one row for wide banners. parts: lockup | tagline | cue, distributed inside S.
 */
export function strip(w, h, theme, S, o = {}) {
  const t = THEMES[theme];
  const parts = o.parts ?? ['lockup', 'tagline', 'cue'];
  const twoLine = o.twoLine ?? true;
  let lh = o.lockup ?? S.h * 0.3;
  let fs = o.fs ?? S.h * (twoLine ? 0.2 : 0.22);
  let ch = o.cue ?? S.h * 0.86;
  const gapMin = o.gap ?? S.h * 0.5;
  const widthOf = (k) => {
    const items = [];
    if (parts.includes('lockup')) items.push(lockupWidth(lh * k));
    if (parts.includes('tagline')) items.push((twoLine ? tagEm : tagOneEm) * fs * k);
    if (parts.includes('cue')) items.push(cueSvg(theme, ch * k).w);
    return items;
  };
  let k = 1;
  for (let i = 0; i < 40; i++) {
    const ws = widthOf(k);
    const total = ws.reduce((a, b) => a + b, 0) + gapMin * (ws.length - 1);
    if (total <= S.w) break;
    k *= 0.97;
  }
  lh *= k; fs *= k; ch *= k;
  const ws = widthOf(1);
  const free = S.w - ws.reduce((a, b) => a + b, 0);
  const gap = o.justify === 'start' ? gapMin : free / Math.max(1, ws.length - 1);
  let x = S.x;
  if (o.justify === 'start') x = S.x;
  let body = '';
  const cy = S.y + S.h / 2;
  for (const p of parts) {
    if (p === 'lockup') {
      body += at(x, cy - lh / 2, lockupAt(theme, lh));
      x += lockupWidth(lh) + gap;
    } else if (p === 'tagline') {
      const lines = twoLine ? TAGLINE : [TAGLINE_ONE];
      const th = fs * 1.12 * lines.length;
      body += tagline(theme, x, cy - th / 2 - fs * 0.02, fs, lines);
      x += (twoLine ? tagEm : tagOneEm) * fs + gap;
    } else if (p === 'cue') {
      const cue = cueSvg(theme, ch, { labels: ch > 100 });
      body += at(x, cy - cue.h / 2, cue.svg);
      x += cue.w + gap;
    }
  }
  if (o.guides) body += o.guides;
  return doc(w, h, t.bg, body);
}

/** Centred lockup (and optional tagline) for small or very wide spaces. */
export function centred(w, h, theme, { lockup, kind = 'h', tag = false, fs, cx = w / 2, cy = h / 2 } = {}) {
  const t = THEMES[theme];
  const lw = lockupWidth(lockup, kind);
  let body = '';
  if (tag) {
    const tf = fs ?? lockup * 0.42;
    const total = lockup + tf * 1.6 + tf * 1.12;
    const y0 = cy - total / 2;
    body += at(cx - lw / 2, y0, lockupAt(theme, lockup, kind));
    body += `<div class="a" style="left:0;width:${w}px;top:${r2(y0 + lockup + tf * 1.6)}px;text-align:center;font-weight:500;font-size:${r2(tf)}px;line-height:1.12;letter-spacing:${TRACK}em;color:${t.muted}">${TAGLINE_ONE}</div>`;
  } else {
    body += at(cx - lw / 2, cy - lockup / 2, lockupAt(theme, lockup, kind));
  }
  return doc(w, h, t.bg, body);
}

/**
 * Icon tile. variant: 'square' (opaque full-bleed), 'rounded' (app tile, transparent corners),
 * 'mark' (mark only, transparent). scale = mark visual width / tile width.
 */
export function tile(size, { variant = 'square', scale = 0.6, theme = 'dark', radius = 0.225, src } = {}) {
  const t = THEMES[theme];
  const mw = size * scale;
  const mh = (mw * MARK_BOX.h) / MARK_BOX.w;
  const bgCss = variant === 'mark' ? 'transparent' : variant === 'rounded' ? 'transparent' : t.bg;
  let body = '';
  if (variant === 'rounded') body += `<div class="a" style="left:0;top:0;width:${size}px;height:${size}px;border-radius:${r2(size * radius)}px;background:${t.bg}"></div>`;
  body += at((size - mw) / 2, (size - mh) / 2, markSvg(src ?? theme, mh));
  return doc(size, size, bgCss, body);
}

/** Render one of the small-size src SVGs (mark-16, mark-32) at exact size. */
export function smallMark(size, name, scheme = 'light') {
  // the small marks carry a prefers-color-scheme style; force the scheme for the raster
  let svg = svgSized(name, size, size);
  if (scheme === 'light') svg = svg.replace(/@media \(prefers-color-scheme:dark\)\{[^}]*\}\}/, '');
  else svg = svg.replace(/\.f\{fill:none;stroke:#141413\}/, '.f{fill:none;stroke:#F1F2F4}');
  return doc(size, size, 'transparent', svg);
}

/** Email signature: lockup on transparent, ink. */
export function emailSig(w, h, scale = 1) {
  const lh = 34 * scale;
  return doc(w, h, '#FFFFFF', at(14 * scale, (h - lh) / 2, lockupAt('light', lh)));
}

// ---------- slides ----------
export function slideTitle(theme) {
  const t = THEMES[theme];
  const W = 1920, H = 1080, m = 120;
  let b = at(m, m, lockupAt(theme, 44));
  b += `<div class="a" style="left:${m}px;top:400px;width:1300px;font-weight:600;font-size:104px;line-height:1.06;letter-spacing:${TRACK}em;color:${t.fg}">Presentation title in sentence case</div>`;
  b += `<div class="a" style="left:${m}px;top:660px;font-weight:400;font-size:40px;line-height:1.3;color:${t.muted}">Subtitle or speaker name, date</div>`;
  b += `<div class="a" style="left:${m}px;right:${m}px;bottom:${m + 40}px;border-top:2px solid ${t.rule}"></div>`;
  b += textAt(theme, m, H - m - 22, 22, DOMAIN);
  b += textAt(theme, m, H - m - 22, 22, TAGLINE_ONE, { anchor: 'right' });
  const cue = cueSvg(theme, 200, { labels: false });
  b += at(W - m - cue.w, m, cue.svg);
  return doc(W, H, t.bg, b);
}
export function slideSection(theme) {
  const t = THEMES[theme];
  const W = 1920, H = 1080, m = 120;
  let b = textAt(theme, m, 400, 40, '01', { mono: true, color: theme === 'dark' ? C.orange : t.muted });
  b += `<div class="a" style="left:${m}px;top:470px;width:1400px;font-weight:600;font-size:96px;line-height:1.06;letter-spacing:${TRACK}em;color:${t.fg}">Section title</div>`;
  b += `<div class="a" style="left:${m}px;top:600px;font-weight:400;font-size:36px;color:${t.muted}">One line that says what this section covers</div>`;
  b += `<div class="a" style="left:${m}px;right:${m}px;bottom:${m + 40}px;border-top:2px solid ${t.rule}"></div>`;
  b += at(m, H - m - 26, lockupAt(theme, 26));
  b += textAt(theme, m, H - m - 20, 20, 'Page 2', { anchor: 'right' });
  return doc(W, H, t.bg, b);
}

// ---------- Product Hunt gallery 2: how it works ----------
export function howItWorks(w, h, theme) {
  const t = THEMES[theme];
  const m = 72;
  let b = at(m, m, lockupAt(theme, 34));
  b += `<div class="a" style="left:${m}px;top:${m + 84}px;font-weight:600;font-size:54px;line-height:1.1;letter-spacing:${TRACK}em;color:${t.fg}">One manifest in. Every format out.</div>`;
  const code = [
    ['{', ''],
    ['  "formats": ', '["9:16", "16:9", "1:1"],'],
    ['  "fps": ', '30,'],
    ['  "engine": ', '"remotion",'],
    ['  "voice": ', '"narrator",'],
    ['  "music": ', '"bed-02",'],
    ['  "captions": ', 'true'],
    ['}', ''],
  ];
  const cardX = m, cardY = 330, cardW = 520, cardH = 340;
  b += `<div class="a" style="left:${cardX}px;top:${cardY}px;width:${cardW}px;height:${cardH}px;border:2px solid ${t.rule};border-radius:14px;background:${theme === 'light' ? '#FBFAF7' : '#1F2227'}"></div>`;
  b += textAt(theme, cardX + 28, cardY + 26, 17, 'manifest.json', { mono: true });
  b += `<pre class="a" style="left:${cardX + 28}px;top:${cardY + 70}px;font-family:'Geist Mono';font-weight:500;font-size:21px;line-height:1.55;color:${t.fg}">${code.map(([k, v]) => `${k}<span style="color:${t.muted}">${v}</span>`).join('\n')}</pre>`;
  // arrow
  const ax = cardX + cardW + 36, ay = cardY + cardH / 2, aw = 90;
  b += `<svg class="a" style="left:${ax}px;top:${ay - 14}px" width="${aw}" height="28" viewBox="0 0 ${aw} 28"><path d="M2 14H${aw - 4}M${aw - 16} 3l12 11-12 11" fill="none" stroke="${t.fg}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const cx = ax + aw + 36;
  const avail = w - m - cx;
  let cue = cueSvg(theme, 300);
  cue = cueSvg(theme, (300 * avail) / cue.w);
  const cueY = cardY + (cardH - cue.h) / 2;
  b += at(cx, cueY, cue.svg);
  b += `<div class="a" style="left:${cx}px;top:${cueY + cue.h + 28}px;width:${avail}px;font-size:21px;line-height:1.4;color:${t.muted}">Four engines, voice, music and captions, welded into one file per format.</div>`;
  return doc(w, h, t.bg, b);
}

// ---------- print (PDF) ----------
export function printDoc(wmm, hmm, body, bg = '#FFFFFF', extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss()}
@page{size:${wmm}mm ${hmm}mm;margin:0}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${wmm}mm;height:${hmm}mm;background:${bg};-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:Geist,sans-serif;color:${C.ink}}
.p{position:relative;width:${wmm}mm;height:${hmm}mm;overflow:hidden;page-break-after:always;break-after:page}
.p:last-child{page-break-after:auto;break-after:auto}
.a{position:absolute}
svg{display:block}
${extraCss}</style></head><body>${body}</body></html>`;
}

/** Business card page: trim + 3 mm bleed + 7 mm slug with crop marks. */
export function businessCard(trimW, trimH) {
  const bleed = 3, slug = 7;
  const off = bleed + slug; // trim offset from page edge
  const W = trimW + 2 * off, H = trimH + 2 * off;
  const marks = () => {
    const L = [];
    const s = 0.25; // pt-ish hairline in mm
    const x0 = off, x1 = off + trimW, y0 = off, y1 = off + trimH;
    const a = 0, b = slug - 1.5; // mark from page edge to 1.5 mm before bleed edge... drawn in slug only
    for (const x of [x0, x1]) {
      L.push(`<div class="a" style="left:${x - s / 2}mm;top:${a}mm;width:${s}mm;height:${b}mm;background:#000"></div>`);
      L.push(`<div class="a" style="left:${x - s / 2}mm;top:${H - b}mm;width:${s}mm;height:${b}mm;background:#000"></div>`);
    }
    for (const y of [y0, y1]) {
      L.push(`<div class="a" style="top:${y - s / 2}mm;left:${a}mm;height:${s}mm;width:${b}mm;background:#000"></div>`);
      L.push(`<div class="a" style="top:${y - s / 2}mm;left:${W - b}mm;height:${s}mm;width:${b}mm;background:#000"></div>`);
    }
    return L.join('');
  };
  const bleedBox = (bg, inner) => `<div class="a" style="left:${slug}mm;top:${slug}mm;width:${trimW + 2 * bleed}mm;height:${trimH + 2 * bleed}mm;background:${bg}"></div><div class="a" style="left:${off}mm;top:${off}mm;width:${trimW}mm;height:${trimH}mm">${inner}</div>`;
  const lhFront = 9; // mm
  const lw = (lockupWidth(100) / 100) * lhFront;
  const front = bleedBox(C.dark, `<div class="a" style="left:${(trimW - lw) / 2}mm;top:${(trimH - lhFront) / 2}mm">${lockupAt('dark', 100).replace(/width="[^"]*" height="[^"]*"/, `width="${lw}mm" height="${lhFront}mm"`)}</div>`);
  const mh = 4.2;
  const mw = (mh * MARK_BOX.w) / MARK_BOX.h;
  const safe = 5; // mm inside trim
  const back = bleedBox(
    C.light,
    `<div class="a" style="left:${safe}mm;top:${safe}mm">${markSvg('light', 10).replace(/width="[^"]*" height="[^"]*"/, `width="${mw}mm" height="${mh}mm"`)}</div>
     <div class="a" style="left:${safe}mm;bottom:${safe}mm;font-size:2.6mm;line-height:1.45;color:${C.ink}">
       <div style="font-weight:600;font-size:3.4mm;letter-spacing:${TRACK}em">Full name</div>
       <div style="color:${C.mutedLight};margin-bottom:1.6mm">Role</div>
       <div>${EMAIL}</div><div>${DOMAIN}</div></div>
     <div class="a" style="right:${safe}mm;bottom:${safe}mm;font-size:2.2mm;color:${C.mutedLight};text-align:right;width:30mm;line-height:1.4">Self-hosted video rendering. One Docker image.</div>`
  );
  const page = (inner) => `<div class="p" style="width:${W}mm;height:${H}mm">${inner}${marks()}</div>`;
  return { html: printDoc(W, H, page(front) + page(back)), W, H };
}

function a4Header(theme = 'light') {
  return `<div class="a" style="left:20mm;top:16mm">${lockupAt(theme, 100).replace(/width="[^"]*" height="[^"]*"/, `width="${(lockupWidth(100) / 100) * 7}mm" height="7mm"`)}</div>
  <div class="a" style="right:20mm;top:16mm;text-align:right;font-size:3mm;line-height:1.5;color:${C.mutedLight}">${DOMAIN}<br>${EMAIL}</div>
  <div class="a" style="left:20mm;right:20mm;top:31mm;border-top:0.3mm solid ${C.ruleLight}"></div>`;
}
function a4Footer() {
  return `<div class="a" style="left:20mm;right:20mm;bottom:14mm;border-top:0.3mm solid ${C.ruleLight}"></div>
  <div class="a" style="left:20mm;bottom:9mm;font-size:2.6mm;color:${C.mutedLight}">RenderWeld · ${DOMAIN} · ${EMAIL}</div>
  <div class="a" style="right:20mm;bottom:9mm;font-size:2.6mm;color:${C.mutedLight}">Company registration details</div>`;
}
export function letterhead() {
  const body = `<div class="p">${a4Header()}
  <div class="a" style="left:20mm;top:48mm;width:170mm;font-size:3.6mm;line-height:1.6;color:${C.ink}">
    <p style="color:${C.mutedLight}">Date</p><br>
    <p>Recipient name<br>Company<br>Address</p><br>
    <p>Dear recipient,</p><br>
    <p style="color:${C.mutedLight}">Body text in Geist Regular, 10.5 pt, ink on white. Keep one column, left aligned, with the margins of this page.</p>
  </div>${a4Footer()}</div>`;
  return printDoc(210, 297, body);
}
export function invoice() {
  const row = (cells, head = false) =>
    `<tr>${cells.map((c, i) => `<td style="padding:2.4mm 0;${i ? 'text-align:right;' : ''}${head ? `color:${C.mutedLight};font-weight:500;` : ''}border-bottom:0.3mm solid ${C.ruleLight}">${c}</td>`).join('')}</tr>`;
  const body = `<div class="p">${a4Header()}
  <div class="a" style="left:20mm;top:44mm;font-weight:600;font-size:9mm;letter-spacing:${TRACK}em">Invoice</div>
  <div class="a" style="right:20mm;top:45mm;font-size:3.2mm;line-height:1.7;text-align:right"><span style="color:${C.mutedLight}">Invoice no.</span> RW-0000<br><span style="color:${C.mutedLight}">Issued</span> YYYY-MM-DD<br><span style="color:${C.mutedLight}">Due</span> YYYY-MM-DD</div>
  <div class="a" style="left:20mm;top:68mm;width:80mm;font-size:3.2mm;line-height:1.6"><div style="color:${C.mutedLight}">From</div>RenderWeld<br>Address line<br>${EMAIL}</div>
  <div class="a" style="left:110mm;top:68mm;width:80mm;font-size:3.2mm;line-height:1.6"><div style="color:${C.mutedLight}">Bill to</div>Customer name<br>Company<br>Address line</div>
  <table class="a" style="left:20mm;top:100mm;width:170mm;border-collapse:collapse;font-size:3.2mm">
  ${row(['Description', 'Qty', 'Unit price', 'Amount'], true)}
  ${row(['RenderWeld licence, one deployment', '1', '0.00', '0.00'])}
  ${row(['Support plan', '1', '0.00', '0.00'])}
  <tr><td></td><td></td><td style="padding-top:4mm;text-align:right;color:${C.mutedLight}">Total</td><td style="padding-top:4mm;text-align:right;font-weight:600">0.00</td></tr>
  </table>${a4Footer()}</div>`;
  return printDoc(210, 297, body);
}

export function pressKit({ colours }) {
  const sw = (hex, name, rgb, cmyk, note, dark) =>
    `<div style="width:40mm"><div style="height:13mm;border-radius:1.5mm;background:${hex};${hex === C.light ? `box-shadow:none;border:0.3mm solid ${C.ruleLight}` : ''}"></div>
     <div style="font-size:2.9mm;line-height:1.5;margin-top:2mm"><b style="font-weight:600">${name}</b><br>${hex}<br><span style="color:${C.mutedLight}">RGB ${rgb}<br>CMYK ${cmyk}<br>${note}</span></div></div>`;
  const plate = (theme, inner, w = 80, h = 30) => `<div style="width:${w}mm;height:${h}mm;border-radius:2mm;background:${THEMES[theme].bg};display:flex;align-items:center;justify-content:center;${theme === 'light' ? `border:0.3mm solid ${C.ruleLight}` : ''}">${inner}</div>`;
  const lk = (theme, hmm) => lockupAt(theme, 100).replace(/width="[^"]*" height="[^"]*"/, `width="${(lockupWidth(100) / 100) * hmm}mm" height="${hmm}mm"`);
  const mk = (theme, hmm) => markSvg(theme, 10).replace(/width="[^"]*" height="[^"]*"/, `width="${(hmm * MARK_BOX.w) / MARK_BOX.h}mm" height="${hmm}mm"`);
  const h2 = (s) => `<div style="font-weight:600;font-size:4.2mm;letter-spacing:${TRACK}em;margin:0 0 3mm">${s}</div>`;
  const body = `<div class="p" style="padding:16mm 18mm">
  <div style="display:flex;justify-content:space-between;align-items:flex-start">
    ${lk('light', 8)}
    <div style="font-size:3mm;color:${C.mutedLight};text-align:right;line-height:1.5">Press kit · draft for review<br>${DOMAIN}</div>
  </div>
  <div style="font-weight:600;font-size:8mm;line-height:1.12;letter-spacing:${TRACK}em;margin:9mm 0 4mm;max-width:150mm">${TAGLINE_ONE}</div>
  <div style="font-size:3.4mm;line-height:1.55;max-width:160mm;color:${C.ink}">RenderWeld is a self-hosted video rendering engine shipped as one Docker image. AI agents (over MCP) or scripts (over REST) send a typed manifest; RenderWeld welds four render engines (Remotion, Motion Canvas, HTML and HyperFrames) with voice, music and captions into one finished file. Any size and aspect ratio, exact frame rates, several versions per call. RenderWeld is source-available.</div>
  <div style="margin-top:8mm">${h2('Logo')}
    <div style="display:flex;gap:4mm;flex-wrap:wrap">
      ${plate('light', lk('light', 7), 84, 26)}${plate('dark', lk('dark', 7), 84, 26)}
      ${plate('light', mk('light', 11), 40, 26)}${plate('dark', mk('dark', 11), 40, 26)}
      <div style="width:84mm;font-size:2.9mm;line-height:1.55;color:${C.mutedLight};align-self:center">The mark is two frames, portrait and landscape, joined at one weld point. The orange dot is the weld, and a camera's tally light.</div>
    </div></div>
  <div style="margin-top:7mm">${h2('Colours')}<div style="display:flex;gap:4mm">${colours.map((c) => sw(...c)).join('')}</div></div>
  <div style="margin-top:7mm;display:flex;gap:10mm">
    <div style="width:84mm">${h2('Usage')}<div style="font-size:3mm;line-height:1.6">
      Write RenderWeld as one word with a capital R and W. Never all caps, never split.<br>
      Keep clear space of twice the frame stroke on every side of the mark.<br>
      Minimum size: 16 px for the mark, 24 px when it sits next to the wordmark.<br>
      No gradients, shadows, glows, outlines, rotation or recolouring of the dot.<br>
      Orange is never used for text on light backgrounds.</div></div>
    <div style="width:80mm">${h2('Typography')}<div style="font-size:3mm;line-height:1.6">
      <span style="font-weight:600;font-size:5mm;letter-spacing:${TRACK}em">Geist Semibold</span><br>Headlines and the wordmark, tracking −0.02em.<br>
      <span style="font-size:4mm">Geist Regular</span><br>Body text.<br><span style="font-family:'Geist Mono';font-size:3.4mm">Geist Mono</span><br>Code, ratios and file names.</div></div>
  </div>
  <div class="a" style="left:18mm;right:18mm;bottom:14mm;border-top:0.3mm solid ${C.ruleLight};padding-top:3mm;display:flex;justify-content:space-between;font-size:3mm;color:${C.mutedLight}">
    <span>Press and partnerships: ${EMAIL}</span><span>Logo files: brand kit, src/ and the asset index in BRAND.md</span></div>
  </div>`;
  return printDoc(210, 297, body);
}

/**
 * Two columns inside S: lockup over tagline on the left, cue on the right.
 * Everything scales down together until it fits S.
 */
export function twoCol(w, h, theme, S, o = {}) {
  const t = THEMES[theme];
  const showLock = o.lockup !== false;
  const showTag = o.tagline !== false;
  let lh = o.lh ?? S.h * 0.17;
  let fs = o.fs ?? S.h * (showLock ? 0.15 : 0.24);
  let ch = o.ch ?? S.h * (showLock ? 0.8 : 0.95);
  const gapMin = o.gap ?? S.h * 0.25;
  const dims = () => {
    const lw = showLock ? lockupWidth(lh) : 0;
    const tw = showTag ? tagEm * fs : 0;
    const vgap = showLock && showTag ? Math.max(lh * 0.9, fs * 0.9) : 0;
    const leftW = Math.max(lw, tw);
    const leftH = (showLock ? lh : 0) + vgap + (showTag ? fs * 1.12 * 2 : 0);
    const cue = cueSvg(theme, ch, { labels: ch > 110 });
    return { leftW, leftH, vgap, cue };
  };
  for (let i = 0; i < 60; i++) {
    const d = dims();
    if (d.leftW + gapMin + d.cue.w <= S.w && d.leftH <= S.h && d.cue.h <= S.h) break;
    lh *= 0.97; fs *= 0.97; ch *= 0.97;
  }
  const d = dims();
  const ly = S.y + (S.h - d.leftH) / 2;
  let b = '';
  if (showLock) b += at(S.x, ly, lockupAt(theme, lh));
  if (showTag) b += tagline(theme, S.x, ly + (showLock ? lh + d.vgap : 0) - fs * 0.06, fs);
  const cx = o.cueAlign === 'centre' ? S.x + d.leftW + (S.w - d.leftW - d.cue.w) / 2 + gapMin / 2 : S.x + S.w - d.cue.w;
  b += at(cx, S.y + (S.h - d.cue.h) / 2, d.cue.svg);
  return doc(w, h, t.bg, b);
}
