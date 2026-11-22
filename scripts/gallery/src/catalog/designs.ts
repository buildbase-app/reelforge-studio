/**
 * Scene designs for the html and hyperframes engines. Each design is what an
 * agent would write into a scene's `html`/`css`: real motion design (masked
 * type, eased counters, SVG path drawing, parallax layers, UI mock-ups), with
 * only procedural visuals. Designs take content and return a SceneSource via
 * `shell` (backdrop, camera push, transitions).
 */
import {
  EASE,
  EASE_BACK,
  EASE_IN_OUT,
  MONO,
  brandMark,
  counter,
  d,
  esc,
  eyebrow,
  eyebrowCss,
  icon,
  letters,
  lettersCss,
  maskCss,
  maskLines,
  rng,
  s,
  shell,
  type Backdrop,
  type SceneCtx,
  type SceneSource,
} from './kit';

type Design<P> = (ctx: SceneCtx, p: P) => SceneSource;

const WRAP = `.wrap{position:absolute;left:90px;right:90px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center}`;
const H1 = (size: number) =>
  `h1{margin:0;font-size:${size}px;line-height:.95;font-weight:var(--rf-heading-weight);letter-spacing:-.03em;color:var(--rf-text)}`;
const SUB = `.sub{margin:44px 0 0;font-size:48px;line-height:1.25;font-weight:400;color:var(--rf-muted);max-width:860px}`;
const ACC = `.acc{color:var(--rf-accent);font-style:normal}`;

/** Wraps *words* in <em class="acc"> for highlighted words in a headline. */
function hl(text: string): string {
  return esc(text).replace(/\*(.+?)\*/g, '<em class="acc">$1</em>');
}

/* ------------------------------------------------------------------ */
/* 1. Hero: eyebrow, masked headline, subline, CTA chip, outline marquee */
/* ------------------------------------------------------------------ */
export interface HeroProps {
  eyebrow?: string;
  lines: string[];
  sub?: string;
  cta?: string;
  marquee?: string;
  backdrop?: Backdrop;
  align?: 'left' | 'center';
  size?: number;
}
export const hero: Design<HeroProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.15 : 0.35;
  const size = p.size ?? (Math.max(...p.lines.map((l) => l.length)) > 11 ? 128 : 156);
  // A single long word (a URL, a product name) must still fit the 900 px column.
  const longest = Math.max(...p.lines.flatMap((l) => l.split(/\s+/)).map((w) => w.length));
  const fitted = Math.min(size, Math.floor(900 / (longest * 0.56)));
  const center = p.align === 'center';
  const words = p.lines.join(' ').split(/\s+/).length;
  const html =
    `<div class="wrap${center ? ' ctr' : ''}">` +
    (p.eyebrow ? `<div>${eyebrow(p.eyebrow, t0)}</div>` : '') +
    `<h1>${maskLines(p.lines, t0 + 0.15)}</h1>` +
    (p.sub ? `<p class="sub rise" ${d(t0 + 0.5 + words * 0.075)}>${hl(p.sub)}</p>` : '') +
    (p.cta ? `<div class="cta pop" ${d(t0 + 0.8 + words * 0.075)}>${esc(p.cta)} ${icon('arrow', 44)}</div>` : '') +
    '</div>';
  const css =
    WRAP +
    H1(fitted) +
    SUB +
    maskCss() +
    eyebrowCss +
    `.ctr{align-items:center;text-align:center}.ctr .sub{margin-left:auto;margin-right:auto}
.wrap>div:first-child{margin-bottom:56px}
.cta{display:inline-flex;align-items:center;gap:20px;margin-top:64px;align-self:flex-start;font-size:44px;font-weight:600;padding:30px 48px;border-radius:999px;background:var(--rf-text);color:var(--rf-bg)}
.ctr .cta{align-self:center}
`;
  return shell(ctx, { html, css, backdrop: p.backdrop ?? 'plain' });
};

/* ------------------------------------------------------------------ */
/* 2. Big stat: counter, unit, label, progress meter                    */
/* ------------------------------------------------------------------ */
export interface StatProps {
  eyebrow?: string;
  value: number;
  prefix?: string;
  suffix?: string;
  label: string;
  note?: string;
  /** 0..1, draws a meter under the number. */
  meter?: number;
  backdrop?: Backdrop;
}
export const stat: Design<StatProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const c = counter(ctx, p.value, t0 + 0.2, Math.min(2.2, ctx.dur * 0.45));
  const digits = String(p.value).length + (p.prefix?.length ?? 0) + (p.suffix?.length ?? 0);
  const size = digits <= 3 ? 400 : digits <= 4 ? 330 : digits <= 5 ? 270 : 220;
  const html =
    `<div class="wrap">` +
    (p.eyebrow ? `<div>${eyebrow(p.eyebrow, t0)}</div>` : '') +
    `<div class="num pop" ${d(t0 + 0.1)}>${p.prefix ? `<span class="aff">${esc(p.prefix)}</span>` : ''}${c.html}${p.suffix ? `<span class="aff">${esc(p.suffix)}</span>` : ''}</div>` +
    (p.meter !== undefined ? `<div class="meter"><i style="width:${Math.round(p.meter * 100)}%"></i></div>` : '') +
    `<div class="lbl">${maskLines([p.label], t0 + 0.6, 'mk', 0.05)}</div>` +
    (p.note ? `<p class="note rise" ${d(t0 + 1.1)}>${hl(p.note)}</p>` : '') +
    `</div>`;
  const css =
    WRAP +
    c.css +
    maskCss() +
    eyebrowCss +
    ACC +
    `.wrap>div:first-child{margin-bottom:40px}
.num{font-size:${size}px;line-height:.9;font-weight:600;letter-spacing:-.06em;color:var(--rf-text);font-variant-numeric:tabular-nums;transform-origin:left bottom}
.aff{font-size:.5em;letter-spacing:-.02em;margin:0 .04em;color:var(--rf-accent)}
.meter{height:22px;border-radius:99px;background:color-mix(in srgb,var(--rf-text) 12%,transparent);margin:40px 0 10px;overflow:hidden}
.meter i{display:block;height:100%;border-radius:99px;background:var(--rf-accent);transform-origin:left;animation:mt ${s(Math.min(2.2, ctx.dur * 0.45))} ${EASE} ${s(t0 + 0.2)} both}
@keyframes mt{from{transform:scaleX(0)}to{transform:none}}
.lbl{margin-top:36px;font-size:66px;line-height:1.08;font-weight:600;letter-spacing:-.02em;color:var(--rf-text)}
.note{margin:36px 0 0;font-size:42px;line-height:1.3;color:var(--rf-muted)}`;
  return shell(ctx, { html, css, backdrop: p.backdrop ?? 'plain' });
};

/* ------------------------------------------------------------------ */
/* 3. Horizontal bars with counting values                              */
/* ------------------------------------------------------------------ */
export interface BarsProps {
  title: string;
  eyebrow?: string;
  bars: { label: string; value: number; suffix?: string }[];
  /** Index of the highlighted bar. */
  highlight?: number;
  source?: string;
}
export const bars: Design<BarsProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const max = Math.max(...p.bars.map((b) => b.value));
  const len = Math.min(1.6, ctx.dur * 0.3);
  let extra = '';
  const rows = p.bars
    .map((b, i) => {
      const at = t0 + 0.6 + i * 0.18;
      const c = counter(ctx, b.value, at, len);
      extra += c.css;
      const hi = i === (p.highlight ?? -1);
      return (
        `<div class="row${hi ? ' hi' : ''}"><div class="rl slide-l" ${d(at - 0.1)}>${esc(b.label)}</div>` +
        `<div class="track"><div class="fill" style="width:${Math.max(8, Math.round((b.value / max) * 100))}%;animation-delay:${s(at)}"></div>` +
        `<div class="val fade" ${d(at + 0.1)}>${c.html}${esc(b.suffix ?? '')}</div></div></div>`
      );
    })
    .join('');
  const html =
    `<div class="wrap">` +
    (p.eyebrow ? `<div>${eyebrow(p.eyebrow, t0)}</div>` : '') +
    `<h2>${maskLines([p.title], t0 + 0.1, 'mk', 0.05)}</h2><div class="rows">${rows}</div>` +
    (p.source ? `<div class="src fade" ${d(t0 + 1.4)}>${esc(p.source)}</div>` : '') +
    `</div>`;
  const css =
    WRAP +
    maskCss() +
    eyebrowCss +
    extra +
    `.wrap>div:first-child{margin-bottom:40px}
h2{margin:0 0 70px;font-size:92px;line-height:1;letter-spacing:-.035em;font-weight:var(--rf-heading-weight)}
.row{margin-bottom:44px}
.rl{font-size:40px;font-weight:600;color:var(--rf-muted);margin-bottom:16px}
.track{position:relative;height:96px;border-radius:16px;background:color-mix(in srgb,var(--rf-text) 7%,transparent)}
.fill{height:100%;border-radius:16px;background:color-mix(in srgb,var(--rf-text) 22%,transparent);transform-origin:left;animation:bf ${s(len)} ${EASE} both}
.hi .fill{background:var(--rf-accent)}
.hi .rl{color:var(--rf-text)}
@keyframes bf{from{transform:scaleX(0)}to{transform:none}}
.val{position:absolute;right:28px;top:0;bottom:0;display:flex;align-items:center;font:500 46px/1 ${MONO};color:var(--rf-text)}
.src{margin-top:30px;font:500 28px/1.3 ${MONO};color:var(--rf-muted);opacity:.8}`;
  return shell(ctx, { html, css, backdrop: 'grid' });
};

/* ------------------------------------------------------------------ */
/* 4. Line chart: path draws, area fades, end dot pulses, value counts  */
/* ------------------------------------------------------------------ */
export interface LineProps {
  title: string;
  eyebrow?: string;
  points: number[];
  value: number;
  prefix?: string;
  suffix?: string;
  caption: string;
  labels?: string[];
}
export const line: Design<LineProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const w = 900;
  const h = 620;
  const min = Math.min(...p.points);
  const max = Math.max(...p.points);
  const xy = p.points.map((v, i) => [(i / (p.points.length - 1)) * w, h - 40 - ((v - min) / (max - min || 1)) * (h - 120)] as const);
  // Smooth path (Catmull-Rom to cubic Bezier).
  let path = `M${xy[0]![0].toFixed(1)},${xy[0]![1].toFixed(1)}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const p0 = xy[Math.max(0, i - 1)]!;
    const p1 = xy[i]!;
    const p2 = xy[i + 1]!;
    const p3 = xy[Math.min(xy.length - 1, i + 2)]!;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    path += ` C${c1[0]!.toFixed(1)},${c1[1]!.toFixed(1)} ${c2[0]!.toFixed(1)},${c2[1]!.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const last = xy[xy.length - 1]!;
  const drawLen = Math.min(2.4, ctx.dur * 0.45);
  const c = counter(ctx, p.value, t0 + 0.5, drawLen);
  const grid = [0, 1, 2, 3].map((i) => `<line x1="0" x2="${w}" y1="${40 + i * ((h - 80) / 3)}" y2="${40 + i * ((h - 80) / 3)}"/>`).join('');
  const labels = (p.labels ?? []).map((l, i, a) => `<span style="left:${(i / (a.length - 1)) * 100}%">${esc(l)}</span>`).join('');
  const html =
    `<div class="wrap">` +
    (p.eyebrow ? `<div>${eyebrow(p.eyebrow, t0)}</div>` : '') +
    `<h2>${maskLines([p.title], t0 + 0.1, 'mk', 0.05)}</h2>` +
    `<div class="big pop" ${d(t0 + 0.4)}>${esc(p.prefix ?? '')}${c.html}${esc(p.suffix ?? '')}</div>` +
    `<div class="cap rise" ${d(t0 + 0.6)}>${hl(p.caption)}</div>` +
    `<div class="chart"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="visible">` +
    `<defs><linearGradient id="ar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--rf-accent)" stop-opacity=".14"/><stop offset="1" stop-color="var(--rf-accent)" stop-opacity=".02"/></linearGradient>` +
    `<linearGradient id="ln" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--rf-accent2)"/><stop offset="1" stop-color="var(--rf-accent)"/></linearGradient></defs>` +
    `<g class="grid">${grid}</g>` +
    `<path class="area" d="${path} L${w},${h} L0,${h} Z" fill="url(#ar)"/>` +
    `<path class="ln" d="${path}" pathLength="1" fill="none" stroke="var(--rf-accent)" stroke-width="10" stroke-linecap="round"/>` +
    `<circle class="dot" cx="${last[0]}" cy="${last[1]}" r="16"/>` +
    `</svg><div class="xl">${labels}</div></div></div>`;
  const css =
    WRAP +
    maskCss() +
    eyebrowCss +
    ACC +
    c.css +
    `.wrap>div:first-child{margin-bottom:36px}
h2{margin:0;font-size:64px;line-height:1.05;letter-spacing:-.03em;font-weight:600;color:var(--rf-muted)}
.big{font-size:210px;font-weight:600;letter-spacing:-.06em;line-height:1;margin-top:10px;font-variant-numeric:tabular-nums;transform-origin:left}
.cap{font-size:44px;font-weight:600;margin:6px 0 70px;color:var(--rf-text)}
.chart{position:relative}
.grid line{stroke:color-mix(in srgb,var(--rf-text) 12%,transparent);stroke-width:2;stroke-dasharray:6 10}
.ln{stroke-dasharray:1;stroke-dashoffset:1;animation:ld ${s(drawLen)} ${EASE_IN_OUT} ${s(t0 + 0.5)} both}
@keyframes ld{to{stroke-dashoffset:0}}
.area{opacity:0;animation:k-fade 1s ease-out ${s(t0 + 0.5 + drawLen * 0.7)} both}
.dot{fill:var(--rf-bg);stroke:var(--rf-accent);stroke-width:8;transform-box:fill-box;transform-origin:center;animation:k-pop .5s ${EASE_BACK} ${s(t0 + 0.5 + drawLen)} both}
.xl{position:relative;height:50px;margin-top:24px}.xl span{position:absolute;transform:translateX(-50%);font:500 28px/1 ${MONO};color:var(--rf-muted)}
.xl span:first-child{transform:none}.xl span:last-child{transform:translateX(-100%)}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 5. Donut / ring with percentage and legend                           */
/* ------------------------------------------------------------------ */
export interface DonutProps {
  title: string;
  eyebrow?: string;
  percent: number;
  label: string;
  legend?: { label: string; color?: 'accent' | 'accent2' | 'x3' }[];
}
export const donut: Design<DonutProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const len = Math.min(2, ctx.dur * 0.4);
  const c = counter(ctx, p.percent, t0 + 0.4, len);
  const r = 300;
  const circ = 2 * Math.PI * r;
  const legend = (p.legend ?? [])
    .map((l, i) => `<div class="lg rise" ${d(t0 + 1 + i * 0.15)}><i style="background:var(--${l.color === 'x3' ? 'x3' : `rf-${l.color ?? 'accent'}`})"></i>${esc(l.label)}</div>`)
    .join('');
  const html =
    `<div class="wrap">` +
    (p.eyebrow ? `<div>${eyebrow(p.eyebrow, t0)}</div>` : '') +
    `<h2>${maskLines([p.title], t0 + 0.1, 'mk', 0.05)}</h2>` +
    `<div class="ring"><svg width="760" height="760" viewBox="-380 -380 760 760">` +
    `<circle r="${r}" class="rt"/><circle r="${r}" class="rv" pathLength="100" style="stroke-dasharray:${p.percent} 100"/>` +
    `</svg>` +
    `<div class="pct"><div class="pv">${c.html}<small>%</small></div><div class="pl">${esc(p.label)}</div></div></div>` +
    `<div class="lgs">${legend}</div></div>`;
  void circ;
  const css =
    WRAP +
    maskCss() +
    eyebrowCss +
    c.css +
    `.wrap{align-items:center;text-align:center}.wrap>div:first-child{margin-bottom:36px}
h2{margin:0 0 60px;font-size:82px;line-height:1;letter-spacing:-.035em;font-weight:var(--rf-heading-weight)}
.ring{position:relative;width:760px;height:760px}
.ring svg{transform:rotate(-90deg)}
.rt{fill:none;stroke:color-mix(in srgb,var(--rf-text) 10%,transparent);stroke-width:64}
.rv{fill:none;stroke:var(--rf-accent);stroke-width:64;stroke-linecap:round;stroke-dashoffset:${p.percent};animation:rv ${s(len)} ${EASE} ${s(t0 + 0.4)} both}
@keyframes rv{to{stroke-dashoffset:0}}
.pct{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.pv{font-size:220px;font-weight:500;letter-spacing:-.05em;line-height:1;font-variant-numeric:tabular-nums}.pv small{font-size:.4em;color:var(--rf-muted)}
.pl{font-size:40px;font-weight:600;color:var(--rf-muted);max-width:420px;margin-top:6px}
.lgs{display:flex;gap:40px;margin-top:70px;flex-wrap:wrap;justify-content:center}
.lg{display:flex;align-items:center;gap:16px;font-size:38px;font-weight:600;color:var(--rf-muted)}.lg i{width:28px;height:28px;border-radius:8px}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 6. Checklist: items slide in, check marks draw                       */
/* ------------------------------------------------------------------ */
export interface ChecklistProps {
  title: string;
  eyebrow?: string;
  items: string[];
  /** 'check' (default), 'num' (numbered) or 'cross' (don'ts). */
  mark?: 'check' | 'num' | 'cross';
}
export const checklist: Design<ChecklistProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const gap = Math.min(0.55, (ctx.dur - 2) / Math.max(1, p.items.length + 1));
  const rows = p.items
    .map((it, i) => {
      const at = t0 + 0.7 + i * gap;
      const mark =
        p.mark === 'num'
          ? `<b>${String(i + 1).padStart(2, '0')}</b>`
          : `<svg viewBox="0 0 32 32"><path d="${p.mark === 'cross' ? 'M9 9l14 14M23 9L9 23' : 'M7 17l6 6L25 10'}" pathLength="1" style="animation-delay:${s(at + 0.25)}"/></svg>`;
      return `<li class="slide-l" ${d(at)}><span class="mk2${p.mark === 'cross' ? ' x' : ''}">${mark}</span><span>${hl(it)}</span></li>`;
    })
    .join('');
  const html =
    `<div class="wrap">` +
    (p.eyebrow ? `<div>${eyebrow(p.eyebrow, t0)}</div>` : '') +
    `<h2>${maskLines([p.title], t0 + 0.1, 'mk', 0.05)}</h2><ul>${rows}</ul></div>`;
  const css =
    WRAP +
    maskCss() +
    eyebrowCss +
    ACC +
    `.wrap>div:first-child{margin-bottom:40px}
h2{margin:0 0 64px;font-size:96px;line-height:1;letter-spacing:-.04em;font-weight:var(--rf-heading-weight)}
ul{list-style:none;margin:0;padding:0}
li{display:flex;align-items:center;gap:36px;font-size:52px;line-height:1.15;font-weight:500;padding:32px 36px;margin-bottom:24px;border-radius:28px;background:var(--rf-surface);border:2px solid color-mix(in srgb,var(--rf-text) 8%,transparent)}
.mk2{flex:0 0 88px;height:88px;border-radius:20px;background:color-mix(in srgb,var(--rf-text) 8%,transparent);display:flex;align-items:center;justify-content:center;color:var(--rf-accent)}
.mk2.x{color:var(--rf-muted)}
.mk2 b{font:600 40px/1 ${MONO}}
.mk2 svg{width:58px;height:58px;fill:none;stroke:currentColor;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}
.mk2 path{stroke-dasharray:1;stroke-dashoffset:1;animation:ck .45s ${EASE} both}
@keyframes ck{to{stroke-dashoffset:0}}`;
  return shell(ctx, { html, css, backdrop: 'grid' });
};

/* ------------------------------------------------------------------ */
/* 7. Quote card (fictional, clearly labelled)                          */
/* ------------------------------------------------------------------ */
export interface QuoteProps {
  lines: string[];
  name: string;
  role: string;
  label?: string;
  serif?: boolean;
}
export const quote: Design<QuoteProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const words = p.lines.join(' ').split(/\s+/).length;
  const initials = p.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2);
  const html =
    `<div class="wrap"><div class="qm pop" ${d(t0)}>“</div>` +
    `<blockquote>${maskLines(p.lines, t0 + 0.25, 'mk', 0.06)}</blockquote>` +
    `<div class="who rise" ${d(t0 + 0.5 + words * 0.06)}><span class="av">${esc(initials)}</span><span><b>${esc(p.name)}</b><br>${esc(p.role)}</span></div>` +
    `<div class="lab fade" ${d(t0 + 0.9 + words * 0.06)}>${esc(p.label ?? 'Illustrative quote · fictional person')}</div></div>`;
  const css =
    WRAP +
    maskCss() +
    ACC +
    `.qm{font-size:360px;line-height:.9;font-weight:600;${p.serif ? 'font-family:"DejaVu Serif",Georgia,serif;' : ''}color:var(--rf-accent);height:220px;margin-bottom:20px;transform-origin:left bottom}
blockquote{margin:0;font-size:84px;line-height:1.08;font-weight:${p.serif ? 500 : 700};letter-spacing:-.025em;${p.serif ? 'font-family:"DejaVu Serif",Georgia,serif;' : ''}}
.who{display:flex;align-items:center;gap:30px;margin-top:80px;font-size:38px;line-height:1.3;color:var(--rf-muted)}
.who b{color:var(--rf-text);font-size:42px}
.av{width:120px;height:120px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:44px;color:var(--rf-text);background:var(--rf-surface);border:2px solid color-mix(in srgb,var(--rf-text) 10%,transparent)}
.lab{margin-top:56px;font:500 26px/1 ${MONO};color:var(--rf-muted);opacity:.7}`;
  return shell(ctx, { html, css, backdrop: 'split' });
};

/* ------------------------------------------------------------------ */
/* 8. Phone mock-up with an app UI and floating feature chips           */
/* ------------------------------------------------------------------ */
export interface PhoneProps {
  app: string;
  headline?: string;
  chips: string[];
  /** Screen kind. */
  screen: 'finance' | 'habits' | 'music' | 'chat' | 'map' | 'shop';
  balance?: string;
}
function phoneScreen(kind: PhoneProps['screen'], ctx: SceneCtx, app: string, t0: number, balance?: string): { html: string; css: string } {
  const r = rng(ctx.seed + 7);
  switch (kind) {
    case 'finance': {
      const bars = Array.from({ length: 12 }, (_, i) => `<i class="${i === 11 ? 'on' : ''}" style="height:${30 + Math.round(r() * 70)}%;animation-delay:${s(t0 + 0.6 + i * 0.05)}"></i>`).join('');
      return {
        html: `<div class="sc-h">${esc(app)}</div><div class="sc-k">Balance</div><div class="sc-big">${esc(balance ?? '4,280.50')}</div><div class="sc-bars">${bars}</div>${['Groceries', 'Transit', 'Savings']
          .map((t, i) => `<div class="sc-row slide-r" ${d(t0 + 1 + i * 0.15)}><span class="sc-dot" style="background:var(--${['rf-accent', 'rf-accent2', 'x3'][i]})"></span>${t}<b>${['-62.10', '-18.00', '+250.00'][i]}</b></div>`)
          .join('')}`,
        css: `.sc-bars{display:flex;align-items:flex-end;gap:10px;height:200px;margin:30px 0}.sc-bars i{flex:1;border-radius:6px;background:color-mix(in srgb,var(--rf-text) 22%,transparent);transform-origin:bottom;animation:sb .8s ${EASE} both}@keyframes sb{from{transform:scaleY(0)}}.sc-bars i.on{background:var(--rf-accent)}`,
      };
    }
    case 'habits':
      return {
        html: `<div class="sc-h">${esc(app)}</div><div class="sc-k">Today</div><div class="sc-big">3 / 4</div>${['Drink water', 'Read 10 pages', 'Stretch', 'Walk 8k steps']
          .map((t, i) => `<div class="sc-row slide-r" ${d(t0 + 0.6 + i * 0.18)}><span class="sc-chk${i < 3 ? ' on' : ''}" style="animation-delay:${s(t0 + 0.9 + i * 0.18)}"></span>${t}</div>`)
          .join('')}`,
        css: `.sc-chk{width:44px;height:44px;border-radius:14px;border:4px solid color-mix(in srgb,var(--rf-text) 30%,transparent)}.sc-chk.on{background:var(--rf-accent);border-color:var(--rf-accent);animation:k-pop .5s ${EASE_BACK} both}`,
      };
    case 'music': {
      const eq = Array.from({ length: 24 }, (_, i) => `<i style="animation-delay:-${(r() * 1).toFixed(2)}s;animation-duration:${(0.5 + r() * 0.6).toFixed(2)}s"></i>`).join('');
      void eq;
      return {
        html: `<div class="sc-h">${esc(app)}</div><div class="sc-art"></div><div class="sc-big" style="font-size:44px">Night Drive</div><div class="sc-k">Fictional Artist</div><div class="sc-prog"><i></i></div><div class="sc-ctl">${icon('play', 70)}</div>`,
        css: `.sc-art{height:330px;border-radius:30px;margin:20px 0 26px;background:linear-gradient(160deg,var(--rf-accent),color-mix(in srgb,var(--rf-accent) 55%,#000));animation:sa ${s(ctx.dur)} linear both}@keyframes sa{to{transform:scale(1.04)}}.sc-prog{height:10px;border-radius:9px;background:color-mix(in srgb,var(--rf-text) 15%,transparent);margin:26px 0}.sc-prog i{display:block;height:100%;width:100%;border-radius:9px;background:var(--rf-text);transform-origin:left;animation:sp ${s(ctx.dur)} linear both}@keyframes sp{from{transform:scaleX(.2)}to{transform:scaleX(.6)}}.sc-ctl{display:flex;justify-content:center}`,
      };
    }
    case 'chat':
      return {
        html: `<div class="sc-h">${esc(app)}</div>${[
          ['in', 'Can you move standup to 10?'],
          ['out', 'Done. Invites updated for all 6.'],
          ['in', 'Perfect, thanks'],
          ['out', 'I also drafted the agenda'],
        ]
          .map(([w, t], i) => `<div class="sc-msg ${w} pop" ${d(t0 + 0.5 + i * 0.45)}>${esc(t!)}</div>`)
          .join('')}`,
        css: `.sc-msg{max-width:78%;padding:20px 26px;border-radius:28px;font-size:30px;line-height:1.3;margin:16px 0;font-weight:500}.sc-msg.in{background:color-mix(in srgb,var(--rf-text) 12%,transparent);border-bottom-left-radius:8px;transform-origin:left}.sc-msg.out{margin-left:auto;background:var(--rf-accent);color:var(--rf-bg);border-bottom-right-radius:8px;transform-origin:right}`,
      };
    case 'map':
      return {
        html: `<div class="sc-h">${esc(app)}</div><div class="sc-map"><svg viewBox="0 0 400 420"><path d="M40 380 C 120 300, 60 220, 170 200 S 300 120, 360 40" pathLength="1" class="sc-route"/><circle cx="40" cy="380" r="14" class="sc-p"/><circle cx="360" cy="40" r="14" class="sc-p2"/></svg></div><div class="sc-row">${icon('clock', 40)} 18 min · 4.2 km</div>`,
        css: `.sc-map{height:520px;border-radius:30px;margin-top:20px;background:repeating-linear-gradient(0deg,transparent 0 58px,color-mix(in srgb,var(--rf-text) 8%,transparent) 58px 60px),repeating-linear-gradient(90deg,transparent 0 58px,color-mix(in srgb,var(--rf-text) 8%,transparent) 58px 60px),color-mix(in srgb,var(--rf-text) 5%,transparent)}.sc-map svg{width:100%;height:100%}.sc-route{fill:none;stroke:var(--rf-accent);stroke-width:12;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;animation:ld 2s ${EASE_IN_OUT} ${s(t0 + 0.5)} both}@keyframes ld{to{stroke-dashoffset:0}}.sc-p{fill:var(--rf-text)}.sc-p2{fill:var(--rf-accent2);animation:k-pop .5s ${EASE_BACK} ${s(t0 + 2.4)} both;transform-box:fill-box;transform-origin:center}`,
      };
    case 'shop':
      return {
        html: `<div class="sc-h">${esc(app)}</div><div class="sc-prod"></div><div class="sc-big" style="font-size:46px">Everyday Tote</div><div class="sc-k">Recycled canvas · 3 colours</div><div class="sc-buy pop" ${d(t0 + 1.2)}>Add to bag · 49</div>`,
        css: `.sc-prod{height:420px;border-radius:30px;margin:20px 0;background:radial-gradient(40% 34% at 50% 55%,var(--rf-accent2),transparent 70%),linear-gradient(160deg,color-mix(in srgb,var(--rf-accent) 50%,var(--rf-surface)),var(--rf-surface));position:relative}.sc-prod::after{content:"";position:absolute;left:30%;right:30%;top:30%;bottom:18%;border-radius:20px 20px 40px 40px;background:var(--rf-accent);box-shadow:inset 0 -30px 0 rgba(0,0,0,.15)}.sc-buy{margin-top:26px;text-align:center;padding:26px;border-radius:24px;background:var(--rf-text);color:var(--rf-bg);font-weight:600;font-size:32px}`,
      };
  }
}
export const phone: Design<PhoneProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const scr = phoneScreen(p.screen, ctx, p.app, t0);
  const positions = [
    [40, 520, 'slide-l'],
    [600, 760, 'slide-r'],
    [20, 1180, 'slide-l'],
    [560, 1360, 'slide-r'],
  ] as const;
  const chips = p.chips
    .slice(0, 4)
    .map((c, i) => {
      const [x, y, cls] = positions[i]!;
      return `<div class="chip ${cls}" style="left:${x}px;top:${y}px;animation-delay:${s(t0 + 0.9 + i * 0.3)}">${icon(['bolt', 'lock', 'chart', 'star'][i]!, 40)}${esc(c)}</div>`;
    })
    .join('');
  const html =
    (p.headline ? `<div class="ph-hd">${maskLines([p.headline], t0, 'mk', 0.06)}</div>` : '') +
    `<div class="ph"><div class="ph-in"><div class="ph-notch"></div>${scr.html}</div></div>${chips}`;
  const css =
    maskCss() +
    scr.css +
    `.ph-hd{position:absolute;left:90px;right:90px;top:250px;text-align:center;font-size:84px;font-weight:var(--rf-heading-weight);letter-spacing:-.035em;line-height:1}
.ph{position:absolute;left:50%;top:${p.headline ? 520 : 400}px;width:560px;height:1140px;margin-left:-280px;border-radius:84px;padding:18px;background:color-mix(in srgb,var(--rf-text) 16%,var(--rf-surface));box-shadow:0 40px 80px -40px rgba(0,0,0,.6),0 0 0 3px color-mix(in srgb,var(--rf-text) 14%,transparent);animation:ph-in 1.2s ${EASE} ${s(t0)} both}
@keyframes ph-in{from{transform:translateY(240px);opacity:0}}
.ph-in{position:relative;height:100%;border-radius:68px;overflow:hidden;background:var(--rf-bg);padding:90px 40px 40px;color:var(--rf-text)}
.ph-notch{position:absolute;top:22px;left:50%;width:150px;height:40px;margin-left:-75px;border-radius:30px;background:#000}
.sc-h{font-size:28px;font-weight:600;color:var(--rf-muted)}
.sc-k{font-size:28px;color:var(--rf-muted);margin-top:20px}
.sc-big{font-size:76px;font-weight:600;letter-spacing:-.03em;line-height:1.05}
.sc-row{display:flex;align-items:center;gap:20px;font-size:30px;font-weight:600;padding:24px 0;border-bottom:2px solid color-mix(in srgb,var(--rf-text) 8%,transparent)}
.sc-row b{margin-left:auto;font-family:${MONO};font-size:26px}
.sc-dot{width:22px;height:22px;border-radius:50%}
.chip{position:absolute;display:flex;align-items:center;gap:16px;padding:22px 30px;border-radius:26px;font-size:34px;font-weight:600;color:var(--rf-text);background:var(--rf-surface);border:2px solid color-mix(in srgb,var(--rf-text) 10%,transparent);z-index:3}
.chip .ic{color:var(--rf-muted)}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 9. Browser window: SaaS dashboard, cursor click, toast               */
/* ------------------------------------------------------------------ */
export interface BrowserProps {
  app: string;
  title?: string;
  action: string;
  toast: string;
  rows: string[];
}
export const browser: Design<BrowserProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const click = Math.min(ctx.dur - 1.6, t0 + 1.9);
  const rows = p.rows
    .map(
      (r, i) =>
        `<div class="br-row rise" ${d(t0 + 0.6 + i * 0.12)}><span class="br-av" style="background:color-mix(in srgb,var(--rf-text) ${[24, 16, 10, 20][i % 4]}%,transparent)"></span><span class="br-t">${esc(r)}</span><span class="br-pill${i === 0 ? ' go' : ''}" style="animation-delay:${s(click + 0.2)}">${i === 0 ? 'Draft' : 'Live'}</span></div>`
    )
    .join('');
  const html =
    (p.title ? `<div class="br-hd">${maskLines([p.title], t0, 'mk', 0.06)}</div>` : '') +
    `<div class="br"><div class="br-bar"><i></i><i></i><i></i><span>app.${esc(p.app.toLowerCase().replace(/[^a-z0-9]/g, ''))}.example</span></div>` +
    `<div class="br-body"><div class="br-side">${brandMark(p.app, 56)}<b></b><b></b><b></b><b></b></div><div class="br-main">` +
    `<div class="br-top"><div class="br-h">${esc(p.app)}</div><div class="br-btn" style="animation-delay:${s(click)}">${esc(p.action)}</div></div>${rows}</div></div>` +
    `<div class="br-toast" style="animation-delay:${s(click + 0.35)}">${icon('check', 40)} ${esc(p.toast)}</div></div>` +
    `<div class="cur" style="animation-delay:${s(t0 + 0.8)}"><svg width="70" height="70" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="var(--rf-text)" stroke="var(--rf-bg)" stroke-width="1.5"/></svg><span class="rip" style="animation-delay:${s(click)}"></span></div>`;
  const css =
    maskCss() +
    `.br-hd{position:absolute;left:90px;right:90px;top:300px;font-size:92px;font-weight:var(--rf-heading-weight);letter-spacing:-.04em;line-height:1}
.br{position:absolute;left:60px;right:60px;top:${p.title ? 620 : 480}px;height:900px;border-radius:36px;background:var(--rf-surface);box-shadow:0 40px 80px -40px rgba(0,0,0,.6),0 0 0 2px color-mix(in srgb,var(--rf-text) 10%,transparent);overflow:hidden;animation:br-in 1s ${EASE} ${s(t0)} both}
@keyframes br-in{from{transform:translateY(160px);opacity:0}}
.br-bar{height:72px;display:flex;align-items:center;gap:12px;padding:0 28px;background:color-mix(in srgb,var(--rf-text) 6%,transparent)}
.br-bar i{width:20px;height:20px;border-radius:50%;background:color-mix(in srgb,var(--rf-text) 25%,transparent)}
.br-bar span{margin-left:24px;padding:8px 24px;border-radius:12px;background:color-mix(in srgb,var(--rf-bg) 60%,transparent);font:500 24px/1.2 ${MONO};color:var(--rf-muted)}
.br-body{display:flex;height:calc(100% - 72px)}
.br-side{width:120px;padding:30px 0;display:flex;flex-direction:column;align-items:center;gap:34px;border-right:2px solid color-mix(in srgb,var(--rf-text) 7%,transparent)}
.br-side b{width:44px;height:12px;border-radius:6px;background:color-mix(in srgb,var(--rf-text) 18%,transparent)}
.br-main{flex:1;padding:40px}
.br-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px}
.br-h{font-size:44px;font-weight:600;letter-spacing:-.02em}
.br-btn{padding:20px 30px;border-radius:18px;background:var(--rf-accent);color:var(--rf-bg);font-weight:600;font-size:28px;animation:bp .35s ease-out both}
@keyframes bp{0%{transform:scale(1)}40%{transform:scale(.92)}100%{transform:scale(1)}}
.br-row{display:flex;align-items:center;gap:22px;padding:24px;margin-bottom:16px;border-radius:22px;background:color-mix(in srgb,var(--rf-text) 5%,transparent)}
.br-av{width:56px;height:56px;border-radius:16px;flex:none}
.br-t{flex:1;font-size:30px;font-weight:600}
.br-pill{font:500 22px/1 ${MONO};padding:12px 18px;border-radius:10px;background:color-mix(in srgb,var(--rf-text) 8%,transparent);color:var(--rf-muted)}
.br-pill.go{background:color-mix(in srgb,var(--rf-text) 12%,transparent);color:var(--rf-muted);animation:pg .01s step-end both}
@keyframes pg{to{background:color-mix(in srgb,var(--rf-accent) 22%,transparent);color:var(--rf-text)}}
.br-toast{position:absolute;left:50%;bottom:40px;display:flex;align-items:center;gap:16px;transform:translateX(-50%);padding:24px 36px;border-radius:24px;background:var(--rf-text);color:var(--rf-bg);font-size:30px;font-weight:600;white-space:nowrap;animation:bt .6s ${EASE} both}
@keyframes bt{from{transform:translate(-50%,140px);opacity:0}}
.cur{position:absolute;left:0;top:0;z-index:10;animation:cm ${s(click - t0 - 0.8)} ${EASE_IN_OUT} both}
@keyframes cm{from{transform:translate(860px,1700px)}to{transform:translate(${p.title ? 830 : 830}px,${p.title ? 790 : 650}px)}}
.rip{position:absolute;left:-30px;top:-30px;width:60px;height:60px;border-radius:50%;border:4px solid var(--rf-accent);opacity:0;animation:rp .7s ease-out both}
@keyframes rp{from{transform:scale(.3);opacity:1}to{transform:scale(2.6);opacity:0}}`;
  return shell(ctx, { html, css, backdrop: 'grid' });
};

/* ------------------------------------------------------------------ */
/* 10. Code editor typing + terminal result                             */
/* ------------------------------------------------------------------ */
export interface CodeProps {
  title?: string;
  file: string;
  /** Lines of code; tokens in `backticks` get the accent colour, ~tilde~ muted (comments). */
  code: string[];
  result?: string;
}
export const code: Design<CodeProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.4;
  const per = Math.min(0.42, (ctx.dur - 2.4) / (p.code.length + 1));
  const lines = p.code
    .map((l, i) => {
      const at = t0 + 0.5 + i * per;
      const ch = Math.max(1, l.replace(/[`~]/g, '').length);
      const body = esc(l)
        .replace(/`(.+?)`/g, '<i class="k">$1</i>')
        .replace(/~(.+?)~/g, '<i class="c">$1</i>')
        .replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<i class="st">$1</i>');
      return `<div class="ln"><span class="no">${i + 1}</span><span class="ty" style="--ch:${ch};animation-delay:${s(at)};animation-duration:${s(Math.min(per * 0.9, 0.05 + ch * 0.018))};animation-timing-function:steps(${ch},end)">${body || '&nbsp;'}</span></div>`;
    })
    .join('');
  const done = t0 + 0.6 + p.code.length * per;
  const html =
    (p.title ? `<div class="cd-hd">${maskLines([p.title], t0, 'mk', 0.06)}</div>` : '') +
    `<div class="ed"><div class="ed-bar"><i></i><i></i><i></i><span>${esc(p.file)}</span></div><div class="ed-code">${lines}</div>` +
    (p.result ? `<div class="term rise" ${d(done)}><span class="pr">$</span> ${esc(p.result)}<span class="ok pop" ${d(done + 0.3)}>${icon('check', 36)}</span></div>` : '') +
    `</div>`;
  const css =
    maskCss() +
    `.cd-hd{position:absolute;left:90px;right:90px;top:280px;font-size:88px;font-weight:var(--rf-heading-weight);letter-spacing:-.04em;line-height:1}
.ed{position:absolute;left:60px;right:60px;top:${p.title ? 600 : 460}px;border-radius:32px;background:color-mix(in srgb,var(--rf-bg) 70%,#000);box-shadow:0 0 0 2px color-mix(in srgb,var(--rf-text) 10%,transparent);overflow:hidden;animation:k-rise .9s ${EASE} ${s(t0 - 0.2)} both}
.ed-bar{height:70px;display:flex;align-items:center;gap:12px;padding:0 28px;background:color-mix(in srgb,var(--rf-text) 6%,transparent)}
.ed-bar i{width:20px;height:20px;border-radius:50%;background:#ff5f57}.ed-bar i:nth-child(2){background:#febc2e}.ed-bar i:nth-child(3){background:#28c840}
.ed-bar span{margin-left:20px;font:500 26px/1 ${MONO};color:var(--rf-muted)}
.ed-code{padding:34px 34px 40px;font:500 33px/1.65 ${MONO};color:var(--rf-text)}
.ln{display:flex;white-space:pre}
.no{width:56px;flex:none;color:color-mix(in srgb,var(--rf-text) 30%,transparent)}
.ty{display:inline-block;overflow:hidden;width:calc(var(--ch) * 1ch + 2px);animation-name:ty;animation-fill-mode:both}
@keyframes ty{from{width:0}}
.k{font-style:normal;color:var(--rf-accent)}.c{font-style:normal;color:color-mix(in srgb,var(--rf-text) 42%,transparent)}.st{font-style:normal;color:color-mix(in srgb,var(--rf-accent) 55%,var(--rf-text))}
.term{display:flex;align-items:center;gap:16px;margin:0 34px 34px;padding:26px 30px;border-radius:20px;background:color-mix(in srgb,var(--rf-text) 6%,transparent);font:600 30px/1.3 ${MONO};color:var(--rf-text)}
.pr{color:var(--rf-muted)}.ok{margin-left:auto;color:var(--rf-accent);display:flex}`;
  return shell(ctx, { html, css, backdrop: 'grid' });
};

/* ------------------------------------------------------------------ */
/* 11. Countdown: digits flip 3-2-1 or a days/hours/minutes clock       */
/* ------------------------------------------------------------------ */
export interface CountdownProps {
  eyebrow?: string;
  label: string;
  /** Simple 3..1 flip when omitted; else big unit blocks. */
  units?: { value: number; unit: string }[];
  date?: string;
}
export const countdown: Design<CountdownProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  let body: string;
  let extra = '';
  if (!p.units) {
    const step = Math.min(0.9, (ctx.dur - 1.6) / 3);
    body =
      `<div class="flip">` +
      [3, 2, 1]
        .map((n, i) => `<span style="animation-delay:${s(t0 + i * step)};animation-duration:${s(step)}">${n}</span>`)
        .join('') +
      `<span class="go" style="animation-delay:${s(t0 + 3 * step)}">${icon('bolt', 300)}</span></div>`;
    extra = `.flip{position:relative;height:620px;width:100%}
.flip span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:640px;font-weight:600;letter-spacing:-.06em;line-height:1;opacity:0;animation-name:fl;animation-timing-function:${EASE};animation-fill-mode:both}
@keyframes fl{0%{opacity:0;transform:translateY(60px)}25%{opacity:1;transform:none}80%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-60px)}}
.flip .go{animation:k-pop .7s ${EASE} both;color:var(--rf-accent);opacity:1}`;
  } else {
    body =
      `<div class="units">` +
      p.units
        .map((u, i) => {
          const c = counter(ctx, u.value, t0 + 0.3 + i * 0.12, 1.4, Math.min(99, u.value + 17), 2);
          extra += c.css;
          return `<div class="u pop" ${d(t0 + 0.2 + i * 0.12)}><div class="uv">${c.html}</div><div class="ul">${esc(u.unit)}</div></div>`;
        })
        .join('') +
      `</div>`;
    extra += `.units{display:flex;gap:28px;width:100%}
.u{flex:1;padding:50px 0 40px;border-radius:40px;text-align:center;background:var(--rf-surface);border:2px solid color-mix(in srgb,var(--rf-text) 8%,transparent)}
.uv{font:600 170px/1 ${MONO};letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.ul{margin-top:20px;font:600 30px/1 ${MONO};color:var(--rf-muted)}`;
  }
  const html =
    `<div class="wrap ctr">` +
    (p.eyebrow ? `<div class="ebw">${eyebrow(p.eyebrow, t0)}</div>` : '') +
    body +
    `<h2>${maskLines([p.label], t0 + 0.4, 'mk', 0.06)}</h2>` +
    (p.date ? `<div class="dt rise" ${d(t0 + 0.9)}>${icon('cal', 44)} ${esc(p.date)}</div>` : '') +
    `</div>`;
  const css =
    WRAP +
    maskCss() +
    eyebrowCss +
    extra +
    `.ctr{align-items:center;text-align:center}.ebw{margin-bottom:60px}
h2{margin:70px 0 0;font-size:88px;line-height:1;letter-spacing:-.04em;font-weight:var(--rf-heading-weight)}
.dt{display:flex;align-items:center;gap:18px;margin-top:40px;font:500 38px/1 ${MONO};color:var(--rf-muted)}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 12. Versus: two columns, rows of ticks and crosses                   */
/* ------------------------------------------------------------------ */
export interface VersusProps {
  title: string;
  left: string;
  right: string;
  rows: { label: string; left: boolean; right: boolean }[];
}
export const versus: Design<VersusProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const gap = Math.min(0.4, (ctx.dur - 2.2) / (p.rows.length + 1));
  const mark = (ok: boolean, at: number) =>
    `<span class="vm ${ok ? 'y' : 'n'} pop" ${d(at)}>${icon(ok ? 'check' : 'cross', 44)}</span>`;
  const rows = p.rows
    .map((r, i) => {
      const at = t0 + 0.9 + i * gap;
      return `<div class="vr rise" ${d(at)}>${mark(r.left, at + 0.15)}<span class="vl">${esc(r.label)}</span>${mark(r.right, at + 0.25)}</div>`;
    })
    .join('');
  const html =
    `<div class="wrap"><h2>${maskLines([p.title], t0, 'mk', 0.05)}</h2>` +
    `<div class="vh"><span class="slide-l" ${d(t0 + 0.4)}>${esc(p.left)}</span><b class="pop" ${d(t0 + 0.6)}>VS</b><span class="slide-r hi" ${d(t0 + 0.4)}>${esc(p.right)}</span></div>${rows}</div>`;
  const css =
    WRAP +
    maskCss() +
    `h2{margin:0 0 70px;font-size:90px;line-height:1;letter-spacing:-.04em;font-weight:var(--rf-heading-weight);text-align:center}
.vh{display:flex;align-items:center;justify-content:space-between;margin-bottom:40px}
.vh span{flex:1;text-align:center;font-size:44px;font-weight:600;padding:26px;border-radius:24px;background:color-mix(in srgb,var(--rf-text) 8%,transparent)}
.vh span.hi{background:var(--rf-accent);color:var(--rf-bg)}
.vh b{width:120px;text-align:center;font:600 40px/1 ${MONO};color:var(--rf-muted)}
.vr{display:flex;align-items:center;padding:28px 10px;border-bottom:2px solid color-mix(in srgb,var(--rf-text) 10%,transparent)}
.vl{flex:1;text-align:center;font-size:40px;font-weight:600}
.vm{width:90px;height:90px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none}
.vm.y{background:color-mix(in srgb,var(--rf-text) 8%,transparent);color:var(--rf-text)}
.vm.n{background:color-mix(in srgb,var(--rf-text) 8%,transparent);color:color-mix(in srgb,var(--rf-text) 45%,transparent)}`;
  return shell(ctx, { html, css, backdrop: 'grid' });
};

/* ------------------------------------------------------------------ */
/* 13. Before / after wipe                                              */
/* ------------------------------------------------------------------ */
export interface BeforeAfterProps {
  title: string;
  before: { label: string; lines: string[] };
  after: { label: string; lines: string[] };
  /** Visual: 'ui' cluttered vs clean cards, 'chart' flat vs rising bars, 'room' dull vs warm room. */
  visual: 'ui' | 'chart' | 'room';
}
function baVisual(kind: BeforeAfterProps['visual'], after: boolean): string {
  if (kind === 'chart') {
    const vals = after ? [30, 42, 51, 63, 77, 92] : [40, 38, 41, 37, 39, 36];
    return `<div class="ba-ch">${vals.map((v) => `<i style="height:${v}%"></i>`).join('')}</div>`;
  }
  if (kind === 'room') {
    return `<div class="ba-room ${after ? 'warm' : ''}"><i class="win"></i><i class="sofa"></i><i class="lamp"></i><i class="plant"></i></div>`;
  }
  return after
    ? `<div class="ba-ui"><b style="width:70%"></b><b style="width:50%"></b><div class="ba-card"></div><div class="ba-card"></div></div>`
    : `<div class="ba-ui mess"><b style="width:90%"></b><b style="width:40%"></b><b style="width:75%"></b><b style="width:60%"></b><b style="width:85%"></b><b style="width:30%"></b><b style="width:66%"></b></div>`;
}
export const beforeAfter: Design<BeforeAfterProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const wipeAt = t0 + Math.min(1.6, ctx.dur * 0.3);
  const wipeLen = Math.min(1.4, ctx.dur * 0.25);
  const side = (k: 'b' | 'a', v: BeforeAfterProps['before']) =>
    `<div class="ba-s ba-${k}"><div class="ba-tag">${esc(v.label)}</div>${baVisual(p.visual, k === 'a')}<ul>${v.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
  const html =
    `<div class="ba-hd">${maskLines([p.title], t0, 'mk', 0.05)}</div>` +
    `<div class="ba">${side('b', p.before)}${side('a', p.after)}<div class="ba-div"><span>${icon('arrow', 40)}</span></div></div>`;
  const css =
    maskCss() +
    `.ba-hd{position:absolute;left:90px;right:90px;top:260px;font-size:88px;font-weight:var(--rf-heading-weight);letter-spacing:-.04em;line-height:1;text-align:center}
.ba{position:absolute;left:70px;right:70px;top:520px;height:1000px;border-radius:44px;overflow:hidden;box-shadow:0 0 0 2px color-mix(in srgb,var(--rf-text) 8%,transparent);animation:k-rise .9s ${EASE} ${s(t0)} both}
.ba-s{position:absolute;inset:0;padding:60px}
.ba-b{background:color-mix(in srgb,var(--rf-surface) 85%,#777);filter:saturate(.3)}
.ba-a{background:var(--rf-surface);clip-path:inset(0 0 0 100%);animation:ba-w ${s(wipeLen)} ${EASE_IN_OUT} ${s(wipeAt)} both}
@keyframes ba-w{to{clip-path:inset(0 0 0 0)}}
.ba-div{position:absolute;top:0;bottom:0;left:100%;width:6px;margin-left:-3px;background:var(--rf-text);animation:ba-d ${s(wipeLen)} ${EASE_IN_OUT} ${s(wipeAt)} both;z-index:4}
@keyframes ba-d{to{left:0}}
.ba-div span{position:absolute;top:50%;left:50%;width:100px;height:100px;margin:-50px 0 0 -50px;border-radius:50%;background:var(--rf-text);color:var(--rf-bg);display:flex;align-items:center;justify-content:center;transform:rotate(180deg)}
.ba-tag{display:inline-block;font:500 30px/1 ${MONO};padding:16px 24px;border-radius:14px;background:color-mix(in srgb,var(--rf-text) 12%,transparent)}
.ba-a .ba-tag{background:var(--rf-accent);color:var(--rf-bg)}
.ba-s ul{position:absolute;left:60px;right:60px;bottom:60px;margin:0;padding:0;list-style:none}
.ba-s li{font-size:42px;font-weight:600;margin-top:16px}
.ba-b li{color:color-mix(in srgb,var(--rf-text) 60%,transparent);text-decoration:line-through;text-decoration-thickness:3px}
.ba-ui{margin-top:60px}.ba-ui b{display:block;height:34px;border-radius:10px;margin-bottom:22px;background:color-mix(in srgb,var(--rf-text) 22%,transparent)}
.ba-ui.mess b:nth-child(odd){transform:rotate(-1.5deg)}
.ba-card{height:130px;border-radius:24px;margin-top:26px;background:color-mix(in srgb,var(--rf-text) 10%,transparent);box-shadow:inset 8px 0 0 var(--rf-accent)}
.ba-ch{display:flex;align-items:flex-end;gap:22px;height:420px;margin-top:60px}.ba-ch i{flex:1;border-radius:14px 14px 4px 4px;background:color-mix(in srgb,var(--rf-text) 30%,transparent)}
.ba-a .ba-ch i{background:color-mix(in srgb,var(--rf-text) 30%,transparent)}.ba-a .ba-ch i:last-child{background:var(--rf-accent)}
.ba-room{position:relative;height:460px;margin-top:40px;border-radius:30px;background:color-mix(in srgb,var(--rf-text) 8%,transparent);overflow:hidden}
.ba-room i{position:absolute;display:block}
.ba-room .win{left:8%;top:10%;width:34%;height:42%;border-radius:12px;background:color-mix(in srgb,var(--rf-text) 20%,transparent)}
.ba-room .sofa{left:30%;bottom:10%;width:58%;height:26%;border-radius:30px 30px 14px 14px;background:color-mix(in srgb,var(--rf-text) 25%,transparent)}
.ba-room .lamp{right:8%;top:16%;width:70px;height:70px;border-radius:50%;background:color-mix(in srgb,var(--rf-text) 25%,transparent)}
.ba-room .plant{left:10%;bottom:10%;width:80px;height:160px;border-radius:40px 40px 10px 10px;background:color-mix(in srgb,var(--rf-text) 18%,transparent)}
.ba-room.warm{background:radial-gradient(38% 46% at 88% 20%,rgba(255,210,122,.32),transparent 72%),color-mix(in srgb,#ffb35c 12%,var(--rf-surface))}
.ba-room.warm .win{background:color-mix(in srgb,#ffd9a0 45%,var(--rf-surface))}
.ba-room.warm .sofa{background:var(--rf-accent)}.ba-room.warm .lamp{background:#ffd27a}.ba-room.warm .plant{background:#3fbf7f}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 14. Recipe card: procedural bowl, ingredients, timer ring            */
/* ------------------------------------------------------------------ */
export interface RecipeProps {
  dish: string;
  minutes: number;
  ingredients: string[];
  /** Colours of the food blobs. */
  food?: string[];
}
export const recipe: Design<RecipeProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const r = rng(ctx.seed + 3);
  const food = p.food ?? ['#f4a261', '#2a9d8f', '#e9c46a', '#e76f51'];
  const blobs = Array.from({ length: 14 }, (_, i) => {
    const a = r() * Math.PI * 2;
    const rad = 40 + r() * 150;
    const sz = 50 + r() * 70;
    return `<i style="left:${(250 + Math.cos(a) * rad - sz / 2).toFixed(0)}px;top:${(250 + Math.sin(a) * rad * 0.8 - sz / 2).toFixed(0)}px;width:${sz.toFixed(0)}px;height:${(sz * (0.7 + r() * 0.5)).toFixed(0)}px;background:${food[i % food.length]};animation-delay:${s(t0 + 0.4 + i * 0.06)};border-radius:${40 + Math.round(r() * 20)}% ${40 + Math.round(r() * 20)}%"></i>`;
  }).join('');
  const c = counter(ctx, p.minutes, t0 + 0.6, 1.4);
  const ings = p.ingredients
    .map((g, i) => `<span class="ig pop" ${d(t0 + 0.9 + i * 0.15)}>${esc(g)}</span>`)
    .join('');
  const html =
    `<div class="rc-hd">${maskLines([p.dish], t0, 'mk', 0.06)}</div>` +
    `<div class="bowl"><div class="plate"></div><div class="food">${blobs}</div><div class="steam"><b></b><b></b><b></b></div></div>` +
    `<div class="tm pop" ${d(t0 + 0.5)}><svg viewBox="-60 -60 120 120"><circle r="50" class="tt"/><circle r="50" class="tv" pathLength="100"/></svg><div><b>${c.html}</b><small>min</small></div></div>` +
    `<div class="igs">${ings}</div>`;
  const css =
    maskCss() +
    c.css +
    `.rc-hd{position:absolute;left:90px;right:90px;top:260px;font-size:100px;font-weight:var(--rf-heading-weight);letter-spacing:-.04em;line-height:.98}
.bowl{position:absolute;left:50%;top:580px;width:640px;height:640px;margin-left:-320px}
.plate{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 40% 35%,#ffffff,#e9e6df 60%,#cfc9bd);box-shadow:0 40px 80px -30px rgba(0,0,0,.5),inset 0 0 0 40px rgba(255,255,255,.55);animation:k-pop .8s ${EASE} ${s(t0 + 0.1)} both}
.food{position:absolute;left:60px;top:60px;width:500px;height:500px}
.food i{position:absolute;box-shadow:inset -10px -12px 0 rgba(0,0,0,.12);animation:k-pop .6s ${EASE} both}
.steam{position:absolute;left:0;right:0;top:-220px;height:240px;display:flex;justify-content:center;gap:70px}
.steam b{width:26px;height:200px;border-radius:30px;background:linear-gradient(transparent,color-mix(in srgb,var(--rf-text) 30%,transparent));animation:sm 2.2s ease-in-out infinite both}
.steam b:nth-child(2){animation-delay:-.7s}.steam b:nth-child(3){animation-delay:-1.4s}
@keyframes sm{0%{transform:translateY(60px) scaleY(.6);opacity:0}50%{opacity:.8}100%{transform:translateY(-60px) scaleY(1.1);opacity:0}}
.tm{position:absolute;right:80px;top:1100px;width:230px;height:230px;border-radius:50%;background:var(--rf-surface);border:2px solid color-mix(in srgb,var(--rf-text) 8%,transparent)}
.tm svg{position:absolute;inset:15px;transform:rotate(-90deg)}
.tt{fill:none;stroke:color-mix(in srgb,var(--rf-text) 12%,transparent);stroke-width:10}
.tv{fill:none;stroke:var(--rf-accent);stroke-width:10;stroke-linecap:round;stroke-dasharray:100;stroke-dashoffset:100;animation:tvv ${s(ctx.dur * 0.8)} linear ${s(t0 + 0.5)} both}
@keyframes tvv{to{stroke-dashoffset:20}}
.tm div{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.tm b{font:600 76px/1 ${MONO}}.tm small{font:600 24px/1 ${MONO};color:var(--rf-muted);}
.igs{position:absolute;left:80px;right:80px;top:1320px;display:flex;flex-wrap:wrap;gap:18px}
.ig{font-size:38px;font-weight:500;padding:20px 30px;border-radius:20px;background:var(--rf-surface);border:2px solid color-mix(in srgb,var(--rf-text) 12%,transparent)}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 15. Travel route over a stylised map                                 */
/* ------------------------------------------------------------------ */
export interface RouteProps {
  title: string;
  stops: string[];
  distance: number;
  unit?: string;
  days?: string;
}
export const route: Design<RouteProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const r = rng(ctx.seed + 11);
  const n = p.stops.length;
  const pts = p.stops.map((_, i) => [120 + (i % 2 === 0 ? r() * 200 : 520 + r() * 220), 1360 - i * (860 / Math.max(1, n - 1))] as const);
  let path = `M${pts[0]![0].toFixed(0)},${pts[0]![1].toFixed(0)}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    path += ` Q${((a[0] + b[0]) / 2 + (i % 2 ? 160 : -160)).toFixed(0)},${((a[1] + b[1]) / 2).toFixed(0)} ${b[0].toFixed(0)},${b[1].toFixed(0)}`;
  }
  const drawLen = Math.min(3, ctx.dur * 0.55);
  const c = counter(ctx, p.distance, t0 + 0.4, drawLen);
  const land = Array.from({ length: 7 }, () => {
    const x = r() * 900;
    const y = 300 + r() * 1300;
    const w = 220 + r() * 380;
    return `<i style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;width:${w.toFixed(0)}px;height:${(w * (0.5 + r() * 0.4)).toFixed(0)}px;border-radius:${40 + Math.round(r() * 30)}% ${30 + Math.round(r() * 40)}% ${45 + Math.round(r() * 20)}% ${35 + Math.round(r() * 30)}%"></i>`;
  }).join('');
  const pins = p.stops
    .map((st, i) => {
      const at = t0 + 0.4 + (i / Math.max(1, n - 1)) * drawLen;
      const [x, y] = pts[i]!;
      const right = x < 540;
      return `<div class="pin" style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;animation-delay:${s(at)}"><span class="pd"></span><span class="pl ${right ? 'r' : 'l'}">${esc(st)}</span></div>`;
    })
    .join('');
  const html =
    `<div class="land">${land}</div>` +
    `<svg class="rt" width="1080" height="1920" viewBox="0 0 1080 1920"><path d="${path}" pathLength="1" class="rp"/><path d="${path}" class="rpd"/></svg>${pins}` +
    `<div class="rt-hd"><div class="rt-t">${maskLines([p.title], t0, 'mk', 0.06)}</div><div class="rt-k rise" ${d(t0 + 0.5)}>${c.html} ${esc(p.unit ?? 'km')}${p.days ? ` · ${esc(p.days)}` : ''}</div></div>`;
  const css =
    maskCss() +
    c.css +
    `.land{position:absolute;inset:0}.land i{position:absolute;display:block;background:color-mix(in srgb,var(--rf-text) 5%,transparent);border:2px solid color-mix(in srgb,var(--rf-text) 9%,transparent)}
.rt{position:absolute;inset:0}
.rp{fill:none;stroke:var(--rf-accent);stroke-width:10;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;animation:ld ${s(drawLen)} ${EASE_IN_OUT} ${s(t0 + 0.4)} both}
.rpd{fill:none;stroke:color-mix(in srgb,var(--rf-text) 30%,transparent);stroke-width:4;stroke-dasharray:4 18}
@keyframes ld{to{stroke-dashoffset:0}}
.pin{position:absolute;width:0;height:0;animation:k-pop .5s ${EASE} both}
.pd{position:absolute;left:-24px;top:-24px;width:48px;height:48px;border-radius:50%;background:var(--rf-text);border:10px solid var(--rf-accent)}
.pl{position:absolute;top:-30px;white-space:nowrap;font-size:42px;font-weight:600;padding:8px 22px;border-radius:16px;background:var(--rf-bg);border:2px solid color-mix(in srgb,var(--rf-text) 15%,transparent)}
.pl.r{left:50px}.pl.l{right:50px}
.rt-hd{position:absolute;left:90px;right:90px;top:200px}
.rt-t{font-size:96px;font-weight:var(--rf-heading-weight);letter-spacing:-.04em;line-height:.98}
.rt-k{margin-top:24px;font:500 46px/1 ${MONO};color:var(--rf-muted)}`;
  return shell(ctx, { html, css, backdrop: 'grid' });
};

/* ------------------------------------------------------------------ */
/* 16. Real estate: floor plan draws, price and spec chips              */
/* ------------------------------------------------------------------ */
export interface ListingProps {
  title: string;
  price: string;
  beds: number;
  baths: number;
  area: string;
  place: string;
}
export const listing: Design<ListingProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const drawLen = Math.min(2.4, ctx.dur * 0.45);
  const walls = [
    'M40 40 H860 V700 H40 Z',
    'M40 360 H380 M380 40 V520 M380 520 H560 M560 360 V700 M560 360 H860 M640 40 V240 M640 240 H860',
  ];
  const html =
    `<div class="ls-hd"><div class="ls-pl rise" ${d(t0)}>${icon('pin', 40)} ${esc(p.place)}</div><div class="ls-t">${maskLines([p.title], t0 + 0.1, 'mk', 0.06)}</div></div>` +
    `<div class="plan"><svg viewBox="0 0 900 740">${walls.map((w, i) => `<path d="${w}" pathLength="1" class="wl" style="animation-delay:${s(t0 + 0.3 + i * 0.4)}"/>`).join('')}` +
    `<rect x="70" y="70" width="280" height="260" class="rm" style="animation-delay:${s(t0 + drawLen)}"/><rect x="590" y="390" width="240" height="280" class="rm" style="animation-delay:${s(t0 + drawLen + 0.2)}"/></svg>` +
    `<span class="lb" style="left:12%;top:24%;animation-delay:${s(t0 + drawLen)}">Living</span><span class="lb" style="left:70%;top:68%;animation-delay:${s(t0 + drawLen + 0.2)}">Bedroom</span><span class="lb" style="left:74%;top:16%;animation-delay:${s(t0 + drawLen + 0.3)}">Bath</span></div>` +
    `<div class="price pop" ${d(t0 + drawLen * 0.6)}>${esc(p.price)}</div>` +
    `<div class="specs">${[
      ['bed', `${p.beds} bed`],
      ['bath', `${p.baths} bath`],
      ['area', p.area],
    ]
      .map(([ic, t], i) => `<span class="sp rise" ${d(t0 + drawLen * 0.6 + 0.3 + i * 0.12)}>${icon(ic!, 44)}${esc(t!)}</span>`)
      .join('')}</div>`;
  const css =
    maskCss() +
    `.ls-hd{position:absolute;left:90px;right:90px;top:230px}
.ls-pl{display:flex;align-items:center;gap:14px;font:500 34px/1 ${MONO};color:var(--rf-muted)}
.ls-t{margin-top:26px;font-size:92px;font-weight:var(--rf-heading-weight);letter-spacing:-.04em;line-height:.98}
.plan{position:absolute;left:90px;right:90px;top:620px;height:600px;border-radius:36px;background:color-mix(in srgb,var(--rf-surface) 80%,transparent);border:2px solid color-mix(in srgb,var(--rf-text) 10%,transparent);padding:20px}
.plan svg{width:100%;height:100%}
.wl{fill:none;stroke:var(--rf-text);stroke-width:12;stroke-linecap:square;stroke-dasharray:1;stroke-dashoffset:1;animation:ld ${s(drawLen * 0.7)} ${EASE_IN_OUT} both}
@keyframes ld{to{stroke-dashoffset:0}}
.rm{fill:color-mix(in srgb,var(--rf-accent) 22%,transparent);opacity:0;animation:k-fade .6s ease-out both}
.lb{position:absolute;font:600 28px/1 ${MONO};color:var(--rf-muted);animation:k-fade .6s ease-out both}
.price{position:absolute;left:90px;top:1270px;font-size:130px;font-weight:600;letter-spacing:-.05em;transform-origin:left}
.specs{position:absolute;left:90px;right:90px;top:1440px;display:flex;gap:18px}
.sp{display:flex;align-items:center;gap:14px;font-size:36px;font-weight:600;padding:20px 28px;border-radius:22px;background:color-mix(in srgb,var(--rf-text) 8%,transparent)}
.sp .ic{color:var(--rf-muted)}`;
  return shell(ctx, { html, css, backdrop: 'grid' });
};

/* ------------------------------------------------------------------ */
/* 17. Event ticket                                                     */
/* ------------------------------------------------------------------ */
export interface TicketProps {
  event: string;
  date: string;
  place: string;
  tag?: string;
}
export const ticket: Design<TicketProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const r = rng(ctx.seed + 5);
  const qr = Array.from({ length: 81 }, (_, i) => {
    const corner = [0, 1, 2, 9, 10, 11, 18, 19, 20, 6, 7, 8, 15, 16, 17, 24, 25, 26, 54, 55, 56, 63, 64, 65, 72, 73, 74].includes(i);
    return `<i${corner || r() > 0.5 ? ' class="on"' : ''}></i>`;
  }).join('');
  const html =
    `<div class="tk"><div class="tk-top"><div class="tk-tag">${esc(p.tag ?? 'Admit one')}</div><div class="tk-ev">${maskLines(p.event.split('|'), t0 + 0.4, 'mk', 0.06)}</div>` +
    `<div class="tk-meta rise" ${d(t0 + 0.9)}><span>${icon('cal', 40)} ${esc(p.date)}</span><span>${icon('pin', 40)} ${esc(p.place)}</span></div></div>` +
    `<div class="tk-cut"></div><div class="tk-bot"><div class="qr">${qr}</div><div class="tk-no">No. ${String(1000 + Math.round(r() * 8999))}<br><b>Fictional event</b></div></div></div>`;
  const css =
    maskCss() +
    `.tk{position:absolute;left:110px;right:110px;top:330px;height:1220px;border-radius:48px;background:var(--rf-accent);color:var(--rf-bg);box-shadow:0 40px 80px -40px rgba(0,0,0,.6);overflow:hidden;animation:tk-in 1.1s ${EASE} ${s(t0)} both}
@keyframes tk-in{from{transform:translateY(200px);opacity:0}}
.tk-top{padding:70px 70px 40px;height:760px;display:flex;flex-direction:column}
.tk-tag{align-self:flex-start;font:500 28px/1 ${MONO};padding:16px 22px;border-radius:12px;border:3px solid currentColor}
.tk-ev{margin-top:auto;font-size:112px;font-weight:600;letter-spacing:-.05em;line-height:.92}
.tk-meta{margin-top:44px;display:flex;flex-direction:column;gap:18px;font-size:40px;font-weight:600}
.tk-meta span{display:flex;align-items:center;gap:16px}
.tk-cut{height:0;border-top:6px dashed color-mix(in srgb,var(--rf-bg) 45%,transparent);margin:0 50px;position:relative}
.tk-cut::before,.tk-cut::after{content:"";position:absolute;top:-50px;width:100px;height:100px;border-radius:50%;background:var(--rf-bg)}
.tk-cut::before{left:-110px}.tk-cut::after{right:-110px}
.tk-bot{display:flex;align-items:center;gap:50px;padding:60px 70px}
.qr{display:grid;grid-template-columns:repeat(9,30px);gap:4px;padding:18px;background:var(--rf-bg);border-radius:18px}
.qr i{width:30px;height:30px;border-radius:4px}.qr i.on{background:var(--rf-text)}
.tk-no{font:600 32px/1.5 ${MONO}}.tk-no b{font-size:26px;opacity:.7}
`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 18. Hiring: role card with perks                                     */
/* ------------------------------------------------------------------ */
export interface RoleProps {
  company: string;
  role: string;
  chips: string[];
  perks: string[];
}
export const role: Design<RoleProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const html =
    `<div class="wrap"><div class="co rise" ${d(t0)}>${brandMark(p.company, 72)}<span>${esc(p.company)}</span><b>is hiring</b></div>` +
    `<h1>${maskLines(p.role.split('|'), t0 + 0.2, 'mk', 0.07)}</h1>` +
    `<div class="chips">${p.chips.map((c, i) => `<span class="pop" ${d(t0 + 0.8 + i * 0.1)}>${esc(c)}</span>`).join('')}</div>` +
    `<div class="perks">${p.perks.map((k, i) => `<div class="pk slide-l" ${d(t0 + 1.2 + i * 0.15)}>${icon(['heart', 'globe', 'book', 'gift', 'clock'][i % 5]!, 48)}${esc(k)}</div>`).join('')}</div></div>`;
  const css =
    WRAP +
    H1(128) +
    maskCss() +
    `.co{display:flex;align-items:center;gap:20px;font-size:44px;font-weight:600;margin-bottom:50px}.co b{font-weight:500;color:var(--rf-muted)}
.chips{display:flex;flex-wrap:wrap;gap:16px;margin-top:50px}
.chips span{font:500 34px/1 ${MONO};padding:18px 26px;border-radius:16px;background:color-mix(in srgb,var(--rf-text) 8%,transparent);color:var(--rf-text)}
.perks{margin-top:70px;display:grid;gap:20px}
.pk{display:flex;align-items:center;gap:24px;font-size:42px;font-weight:500;padding:28px 32px;border-radius:24px;background:var(--rf-surface)}
.pk .ic{color:var(--rf-accent)}`;
  return shell(ctx, { html, css, backdrop: 'split' });
};

/* ------------------------------------------------------------------ */
/* 19. Lyric / kinetic type: one word at a time on the beat             */
/* ------------------------------------------------------------------ */
export interface LyricProps {
  words: string[];
  /** Seconds per word. */
  beat?: number;
  footer?: string;
}
export const lyric: Design<LyricProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.05 : 0.3;
  const beat = p.beat ?? Math.max(0.3, (ctx.dur - t0 - 0.6) / p.words.length);
  const styles = ['a', 'b', 'c', 'd'];
  const ws = p.words
    .map((w, i) => {
      const at = t0 + i * beat;
      const last = i === p.words.length - 1;
      return `<div class="lw ${styles[i % 4]}${last ? ' last' : ''}" style="animation-delay:${s(at)};animation-duration:${s(last ? ctx.dur - at : beat)}">${letters(w, 0, 0)}</div>`;
    })
    .join('');
  const bars = Array.from({ length: 40 }, (_, i) => `<i style="animation-delay:-${((i * 0.137) % 1).toFixed(2)}s;animation-duration:${s(beat * 2)}"></i>`).join('');
  const html = `<div class="ly">${ws}</div><div class="eq">${bars}</div>` + (p.footer ? `<div class="ft fade" ${d(t0)}>${icon('music', 36)} ${esc(p.footer)}</div>` : '');
  const css =
    lettersCss() +
    `.ly{position:absolute;inset:0}
.lw{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 60px;font-size:230px;font-weight:600;letter-spacing:-.05em;line-height:.9;opacity:0;animation-name:lw;animation-fill-mode:both;animation-timing-function:linear}
.lw .lt{animation:none}
.lw.a{color:var(--rf-text)}.lw.b{color:var(--rf-text)}.lw.c{color:var(--rf-muted)}.lw.d{color:var(--rf-accent)}
@keyframes lw{0%{opacity:0;transform:translateY(80px)}14%{opacity:1;transform:none}86%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-50px)}}
.lw.last{animation-name:lwl}@keyframes lwl{0%{opacity:0;transform:translateY(80px)}14%{opacity:1;transform:none}100%{opacity:1;transform:scale(1.04)}}
.eq{position:absolute;left:90px;right:90px;bottom:330px;height:140px;display:flex;align-items:flex-end;gap:8px}
.eq i{flex:1;height:100%;border-radius:4px;background:color-mix(in srgb,var(--rf-text) 28%,transparent);transform-origin:bottom;animation:eq ease-in-out infinite alternate both}
@keyframes eq{from{transform:scaleY(.12)}to{transform:scaleY(1)}}
.ft{position:absolute;left:0;right:0;top:260px;display:flex;justify-content:center;align-items:center;gap:14px;font:600 32px/1 ${MONO};color:var(--rf-muted)}`;
  return shell(ctx, { html, css, backdrop: 'plain', push: false });
};

/* ------------------------------------------------------------------ */
/* 20. Podcast clip: waveform, episode, captions highlighted word by word */
/* ------------------------------------------------------------------ */
export interface PodcastProps {
  show: string;
  episode: string;
  caption: string;
  host: string;
}
export const podcast: Design<PodcastProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const words = p.caption.split(/\s+/);
  const per = (ctx.dur - t0 - 1.2) / words.length;
  const cap = words.map((w, i) => `<span style="animation-delay:${s(t0 + 0.6 + i * per)}">${esc(w)}</span>`).join(' ');
  const r = rng(ctx.seed + 9);
  const wave = Array.from({ length: 56 }, () => `<i style="height:${(18 + r() * 82).toFixed(0)}%;animation-delay:-${(r() * 1.2).toFixed(2)}s"></i>`).join('');
  const initials = p.host
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2);
  const html =
    `<div class="pc"><div class="pc-av pop" ${d(t0)}><span>${esc(initials)}</span></div>` +
    `<div class="pc-show rise" ${d(t0 + 0.2)}>${icon('mic', 40)} ${esc(p.show)}</div><div class="pc-ep rise" ${d(t0 + 0.3)}>${esc(p.episode)}</div>` +
    `<div class="pc-wave">${wave}</div><div class="pc-cap">${cap}</div><div class="pc-host fade" ${d(t0 + 0.6)}>${esc(p.host)} · fictional host</div></div>`;
  const css = `.pc{position:absolute;left:80px;right:80px;top:260px;bottom:360px;display:flex;flex-direction:column;align-items:center;text-align:center}
.pc-av{position:relative;width:300px;height:300px;border-radius:50%;background:var(--rf-surface);border:2px solid color-mix(in srgb,var(--rf-text) 10%,transparent);display:flex;align-items:center;justify-content:center;font-size:110px;font-weight:500;color:var(--rf-text)}
.pc-show{display:flex;align-items:center;gap:14px;margin-top:56px;font:500 32px/1 ${MONO};color:var(--rf-accent)}
.pc-ep{margin-top:18px;font-size:48px;font-weight:600;color:var(--rf-muted)}
.pc-wave{display:flex;align-items:center;gap:7px;height:160px;width:100%;margin:46px 0}
.pc-wave i{flex:1;border-radius:6px;background:var(--rf-accent);animation:pw .9s ease-in-out infinite alternate both}
@keyframes pw{from{transform:scaleY(.25)}to{transform:scaleY(1)}}
.pc-cap{font-size:76px;line-height:1.1;font-weight:600;letter-spacing:-.025em}
.pc-cap span{color:color-mix(in srgb,var(--rf-text) 28%,transparent);animation:cw .25s ease-out both}
@keyframes cw{to{color:var(--rf-text)}}
.pc-host{margin-top:auto;font:500 28px/1 ${MONO};color:var(--rf-muted)}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 21. Interval timer (fitness)                                         */
/* ------------------------------------------------------------------ */
export interface TimerProps {
  move: string;
  reps: number;
  sets: string;
  cue: string;
}
export const timer: Design<TimerProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const c = counter(ctx, p.reps, t0 + 0.4, Math.max(1.5, ctx.dur - 2));
  const ticks = Array.from({ length: 60 }, (_, i) => `<i style="transform:rotate(${i * 6}deg) translateY(-330px)"></i>`).join('');
  const html =
    `<div class="tm-hd"><div class="tm-set rise" ${d(t0)}>${icon('flame', 40)} ${esc(p.sets)}</div><div class="tm-mv">${maskLines([p.move], t0 + 0.1, 'mk', 0.06)}</div></div>` +
    `<div class="dial"><div class="ticks">${ticks}</div><svg viewBox="-300 -300 600 600"><circle r="270" class="dt"/><circle r="270" class="dv" pathLength="100"/></svg>` +
    `<div class="dn"><b>${c.html}</b><small>reps</small></div></div>` +
    `<div class="cue rise" ${d(t0 + 0.8)}>${icon('bulb', 48)}<span>${hl(p.cue)}</span></div>`;
  const css =
    maskCss() +
    c.css +
    ACC +
    `.tm-hd{position:absolute;left:90px;right:90px;top:240px;text-align:center}
.tm-set{display:inline-flex;align-items:center;gap:14px;font:500 32px/1 ${MONO};color:var(--rf-accent)}
.tm-mv{margin-top:20px;font-size:116px;font-weight:600;letter-spacing:-.05em;line-height:.95}
.dial{position:absolute;left:50%;top:620px;width:700px;height:700px;margin-left:-350px}
.ticks{position:absolute;left:50%;top:50%}.ticks i{position:absolute;width:4px;height:22px;margin-left:-2px;background:color-mix(in srgb,var(--rf-text) 25%,transparent);border-radius:2px}
.dial svg{position:absolute;inset:50px;transform:rotate(-90deg)}
.dt{fill:color-mix(in srgb,var(--rf-surface) 70%,transparent);stroke:color-mix(in srgb,var(--rf-text) 10%,transparent);stroke-width:34}
.dv{fill:none;stroke:var(--rf-accent);stroke-width:34;stroke-linecap:round;stroke-dasharray:100;stroke-dashoffset:100;animation:dvv ${s(Math.max(1.5, ctx.dur - 2))} linear ${s(t0 + 0.4)} both}
@keyframes dvv{to{stroke-dashoffset:0}}
.dn{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.dn b{font:600 250px/1 ${MONO};letter-spacing:-.06em}.dn small{font:600 34px/1 ${MONO};color:var(--rf-muted)}
.cue{position:absolute;left:90px;right:90px;top:1390px;display:flex;gap:24px;align-items:center;font-size:44px;font-weight:600;padding:32px;border-radius:30px;background:var(--rf-surface)}
.cue .ic{color:var(--rf-muted);flex:none}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 22. Scoreboard (sports stats, fictional teams)                       */
/* ------------------------------------------------------------------ */
export interface ScoreProps {
  league: string;
  home: string;
  away: string;
  score: [number, number];
  stats: { label: string; home: number; away: number }[];
}
export const scoreboard: Design<ScoreProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const h = counter(ctx, p.score[0], t0 + 0.5, 1.2);
  const a = counter(ctx, p.score[1], t0 + 0.5, 1.2);
  let extra = h.css + a.css;
  const stats = p.stats
    .map((st, i) => {
      const at = t0 + 1.1 + i * 0.2;
      const tot = st.home + st.away || 1;
      const hc = counter(ctx, st.home, at, 1);
      const ac = counter(ctx, st.away, at, 1);
      extra += hc.css + ac.css;
      return `<div class="st rise" ${d(at)}><div class="stl"><b>${hc.html}</b><span>${esc(st.label)}</span><b>${ac.html}</b></div><div class="stb"><i class="hb" style="width:${((st.home / tot) * 100).toFixed(1)}%;animation-delay:${s(at)}"></i><i class="ab" style="width:${((st.away / tot) * 100).toFixed(1)}%;animation-delay:${s(at)}"></i></div></div>`;
    })
    .join('');
  const html =
    `<div class="sb-l rise" ${d(t0)}>${esc(p.league)} · <b>Full time</b></div>` +
    `<div class="sb"><div class="tm slide-l" ${d(t0 + 0.2)}><div class="crest c1">${esc(p.home.slice(0, 1))}</div>${esc(p.home)}</div>` +
    `<div class="sc pop" ${d(t0 + 0.4)}>${h.html}<i>:</i>${a.html}</div>` +
    `<div class="tm slide-r" ${d(t0 + 0.2)}><div class="crest c2">${esc(p.away.slice(0, 1))}</div>${esc(p.away)}</div></div><div class="sts">${stats}</div>`;
  const css =
    extra +
    `.sb-l{position:absolute;left:0;right:0;top:300px;text-align:center;font:600 32px/1 ${MONO};color:var(--rf-muted)}.sb-l b{color:var(--rf-accent)}
.sb{position:absolute;left:60px;right:60px;top:400px;display:flex;align-items:center;justify-content:space-between;padding:50px 30px;border-radius:40px;background:color-mix(in srgb,var(--rf-surface) 85%,transparent);border:2px solid color-mix(in srgb,var(--rf-text) 10%,transparent)}
.tm{width:250px;display:flex;flex-direction:column;align-items:center;gap:20px;font-size:38px;font-weight:600;text-align:center}
.crest{width:150px;height:170px;border-radius:30px 30px 75px 75px;display:flex;align-items:center;justify-content:center;font-size:84px;font-weight:600;color:var(--rf-bg)}
.c1{background:var(--rf-accent)}.c2{background:color-mix(in srgb,var(--rf-text) 70%,var(--rf-bg))}
.sc{font:600 170px/1 ${MONO};letter-spacing:-.06em;display:flex;align-items:center;font-variant-numeric:tabular-nums}.sc i{font-style:normal;color:var(--rf-muted);margin:0 10px;font-size:.6em}
.sts{position:absolute;left:80px;right:80px;top:880px}
.st{margin-bottom:52px}
.stl{display:flex;justify-content:space-between;align-items:baseline;font-size:36px;font-weight:600;color:var(--rf-muted);margin-bottom:16px}.stl b{font:600 48px/1 ${MONO};color:var(--rf-text)}
.stb{display:flex;gap:8px;height:22px}.stb i{display:block;height:100%;border-radius:12px;animation:sbb 1s ${EASE} both}
.hb{background:var(--rf-accent);transform-origin:right}.ab{background:color-mix(in srgb,var(--rf-text) 30%,transparent);transform-origin:left}
@keyframes sbb{from{transform:scaleX(0)}}`;
  return shell(ctx, { html, css, backdrop: 'split' });
};

/* ------------------------------------------------------------------ */
/* 23. Changelog: version badge and tagged items                        */
/* ------------------------------------------------------------------ */
export interface ChangelogProps {
  product: string;
  version: string;
  items: { tag: 'NEW' | 'FIX' | 'FAST' | 'UI'; text: string }[];
}
const TAG_LABEL = { NEW: 'New', FIX: 'Fixed', FAST: 'Faster', UI: 'Design' } as const;
export const changelog: Design<ChangelogProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const gap = Math.min(0.5, (ctx.dur - 2) / (p.items.length + 1));
  const html =
    `<div class="wrap"><div class="cl-p rise" ${d(t0)}>${brandMark(p.product, 64)} ${esc(p.product)}</div>` +
    `<div class="cl-v pop" ${d(t0 + 0.15)}>v${esc(p.version)}</div><div class="cl-k rise" ${d(t0 + 0.3)}>What's new</div>` +
    `<div class="cl-items">${p.items
      .map((it, i) => `<div class="ci slide-r" ${d(t0 + 0.7 + i * gap)}><span class="tg ${it.tag.toLowerCase()}">${TAG_LABEL[it.tag]}</span><span>${hl(it.text)}</span></div>`)
      .join('')}</div></div>`;
  const css =
    WRAP +
    ACC +
    `.cl-p{display:flex;align-items:center;gap:20px;font-size:44px;font-weight:600}
.cl-v{margin-top:30px;font:600 220px/1 ${MONO};letter-spacing:-.06em;color:var(--rf-text);transform-origin:left}
.cl-k{font-size:60px;font-weight:600;color:var(--rf-muted);margin:10px 0 60px}
.ci{display:flex;align-items:center;gap:28px;padding:30px 0;border-top:2px solid color-mix(in srgb,var(--rf-text) 10%,transparent);font-size:46px;font-weight:600;line-height:1.15}
.tg{flex:none;width:150px;text-align:center;font:600 28px/1 ${MONO};padding:16px 0;border-radius:14px}
.tg{background:color-mix(in srgb,var(--rf-text) 8%,transparent);color:var(--rf-muted)}.tg.new{background:var(--rf-accent);color:var(--rf-bg)}`;
  return shell(ctx, { html, css, backdrop: 'grid' });
};

/* ------------------------------------------------------------------ */
/* 24. Outro / CTA with a fictional brand mark                          */
/* ------------------------------------------------------------------ */
export interface OutroProps {
  brand: string;
  line: string;
  url?: string;
  button?: string;
  backdrop?: Backdrop;
}
export const outro: Design<OutroProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const html =
    `<div class="wrap ctr"><div class="mark">${brandMark(p.brand, 220)}</div>` +
    `<div class="bn">${letters(p.brand, t0 + 0.4, 0.04)}</div>` +
    `<p class="ln rise" ${d(t0 + 0.8)}>${hl(p.line)}</p>` +
    (p.button ? `<div class="btn pop" ${d(t0 + 1.1)}>${esc(p.button)}</div>` : '') +
    (p.url ? `<div class="url fade" ${d(t0 + 1.3)}>${esc(p.url)}</div>` : '') +
    `</div>`;
  const css =
    WRAP +
    lettersCss() +
    ACC +
    `.ctr{align-items:center;text-align:center}
.mark .bm{width:260px;height:260px}.mark{animation:mk-in 1s ${EASE} ${s(t0)} both}
@keyframes mk-in{from{transform:scale(.8);opacity:0}}
.bn{margin-top:60px;font-size:${p.brand.length > 12 ? 104 : 140}px;font-weight:600;letter-spacing:-.05em;line-height:1}
.ln{margin:30px 0 0;font-size:50px;font-weight:600;color:var(--rf-muted);max-width:840px;line-height:1.25}
.btn{margin-top:70px;font-size:46px;font-weight:600;padding:34px 70px;border-radius:999px;background:var(--rf-text);color:var(--rf-bg);animation:k-pop .7s ${EASE} ${s(t0 + 1.1)} both}
.url{margin-top:40px;font:600 36px/1 ${MONO};color:var(--rf-muted)}`;
  return shell(ctx, { html, css, backdrop: p.backdrop ?? 'plain' });
};

/* ------------------------------------------------------------------ */
/* 25. Notification stack                                               */
/* ------------------------------------------------------------------ */
export interface NotifProps {
  title: string;
  items: { app: string; text: string; time?: string }[];
}
export const notifications: Design<NotifProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const gap = Math.min(0.6, (ctx.dur - 2) / (p.items.length + 1));
  const html =
    `<div class="nt-hd">${maskLines(p.title.split('|'), t0, 'mk', 0.06)}</div><div class="nts">${p.items
      .map(
        (n, i) =>
          `<div class="nt" style="animation-delay:${s(t0 + 0.6 + i * gap)}">${brandMark(n.app, 84)}<div><div class="nt-a">${esc(n.app)}<span>${esc(n.time ?? 'now')}</span></div><div class="nt-t">${esc(n.text)}</div></div></div>`
      )
      .join('')}</div>`;
  const css =
    maskCss() +
    `.nt-hd{position:absolute;left:90px;right:90px;top:250px;font-size:100px;font-weight:var(--rf-heading-weight);letter-spacing:-.045em;line-height:.95}
.nts{position:absolute;left:70px;right:70px;top:${p.title.includes('|') ? 640 : 540}px;display:flex;flex-direction:column;gap:26px}
.nt{display:flex;gap:28px;align-items:center;padding:32px;border-radius:40px;background:var(--rf-surface);border:2px solid color-mix(in srgb,var(--rf-text) 8%,transparent);animation:nt-in .8s ${EASE} both}
@keyframes nt-in{from{transform:translateY(-60px);opacity:0}}
.nt .bm{flex:none;border-radius:22px}
.nt>div{flex:1}
.nt-a{display:flex;justify-content:space-between;font-size:30px;font-weight:600;color:var(--rf-muted);letter-spacing:.06em}.nt-a span{text-transform:none;letter-spacing:0;font-weight:500}
.nt-t{margin-top:8px;font-size:40px;font-weight:600;line-height:1.2}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 26. Feature grid: 2x2 tiles with icons                               */
/* ------------------------------------------------------------------ */
export interface GridProps {
  title: string;
  tiles: { icon: string; label: string; text?: string }[];
}
export const featureGrid: Design<GridProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const html =
    `<div class="wrap"><h2>${maskLines(p.title.split('|'), t0, 'mk', 0.06)}</h2><div class="fg">${p.tiles
      .slice(0, 4)
      .map(
        (t, i) =>
          `<div class="tile" style="animation-delay:${s(t0 + 0.6 + i * 0.18)}"><span class="ti">${icon(t.icon, 64)}</span><b>${esc(t.label)}</b>${t.text ? `<small>${esc(t.text)}</small>` : ''}</div>`
      )
      .join('')}</div></div>`;
  const css =
    WRAP +
    maskCss() +
    `h2{margin:0 0 70px;font-size:104px;line-height:.95;letter-spacing:-.045em;font-weight:var(--rf-heading-weight)}
.fg{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.tile{display:flex;flex-direction:column;gap:22px;padding:44px 40px;min-height:380px;border-radius:40px;background:var(--rf-surface);border:2px solid color-mix(in srgb,var(--rf-text) 8%,transparent);animation:tl .9s ${EASE} both}
.tile:nth-child(2){background:var(--rf-accent);color:var(--rf-bg)}.tile:nth-child(2) .ti{background:var(--rf-bg);color:var(--rf-accent)}.tile:nth-child(2) small{color:color-mix(in srgb,var(--rf-bg) 75%,transparent)}
@keyframes tl{from{transform:translateY(60px);opacity:0}}
.ti{width:110px;height:110px;border-radius:24px;background:color-mix(in srgb,var(--rf-text) 8%,transparent);color:var(--rf-text);display:flex;align-items:center;justify-content:center}
.tile b{font-size:50px;font-weight:600;letter-spacing:-.02em;line-height:1.05;margin-top:auto}
.tile small{font-size:32px;font-weight:500;line-height:1.3;color:var(--rf-muted)}`;
  return shell(ctx, { html, css, backdrop: 'grid' });
};

/* ------------------------------------------------------------------ */
/* 27. Manifesto blocks: words on alternating colour blocks             */
/* ------------------------------------------------------------------ */
export interface ManifestoProps {
  words: string[];
  footer?: string;
}
export const manifesto: Design<ManifestoProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0 : 0.25;
  const n = p.words.length;
  const per = (ctx.dur - t0 - 0.3) / n;
  const blocks = p.words
    .map((w, i) => {
      const at = t0 + i * per;
      const kind = ['b1', 'b2', 'b3', 'b4'][i % 4];
      return `<div class="mb ${kind}" style="animation-delay:${s(at)};z-index:${i + 1}"><span style="animation-delay:${s(at + 0.12)}">${esc(w)}</span></div>`;
    })
    .join('');
  const html = `<div class="mbs">${blocks}</div>` + (p.footer ? `<div class="mf">${esc(p.footer)}</div>` : '');
  const css = `.mbs{position:absolute;inset:0}
.mb{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:0 70px;text-align:center;clip-path:inset(100% 0 0 0);animation:mb-in .5s ${EASE_IN_OUT} both}
.mb:first-child{clip-path:none;animation:none}
@keyframes mb-in{to{clip-path:inset(0 0 0 0)}}
.mb span{font-size:200px;font-weight:600;letter-spacing:-.055em;line-height:.9;animation:mb-t .8s ${EASE} both}
@keyframes mb-t{from{transform:translateY(60px);opacity:0}}
.b1{background:var(--rf-bg);color:var(--rf-text)}.b2{background:var(--rf-surface);color:var(--rf-text)}.b3{background:var(--rf-text);color:var(--rf-bg)}.b4{background:var(--rf-accent);color:var(--rf-bg)}
.mf{position:absolute;left:0;right:0;bottom:380px;z-index:99;text-align:center;font:500 30px/1 ${MONO};mix-blend-mode:difference;color:#fff}`;
  return shell(ctx, { html, css, backdrop: 'plain', push: true });
};

/* ------------------------------------------------------------------ */
/* 28. Timeline / roadmap                                               */
/* ------------------------------------------------------------------ */
export interface TimelineProps {
  title: string;
  steps: { when: string; what: string }[];
}
export const timeline: Design<TimelineProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const gap = Math.min(0.55, (ctx.dur - 2.2) / (p.steps.length + 1));
  const lineLen = gap * p.steps.length + 0.4;
  const html =
    `<div class="wrap"><h2>${maskLines(p.title.split('|'), t0, 'mk', 0.06)}</h2><div class="tl"><div class="tl-l"></div>${p.steps
      .map(
        (st, i) =>
          `<div class="ts"><span class="td" style="animation-delay:${s(t0 + 0.6 + i * gap)}"></span><div class="slide-r" ${d(t0 + 0.65 + i * gap)}><b>${esc(st.when)}</b><span>${esc(st.what)}</span></div></div>`
      )
      .join('')}</div></div>`;
  const css =
    WRAP +
    maskCss() +
    `h2{margin:0 0 70px;font-size:100px;line-height:.95;letter-spacing:-.045em;font-weight:var(--rf-heading-weight)}
.tl{position:relative;padding-left:90px}
.tl-l{position:absolute;left:28px;top:20px;bottom:20px;width:8px;border-radius:4px;background:color-mix(in srgb,var(--rf-text) 18%,transparent);transform-origin:top;animation:tll ${s(lineLen)} linear ${s(t0 + 0.5)} both}
@keyframes tll{from{transform:scaleY(0)}}
.ts{position:relative;margin-bottom:56px}
.td{position:absolute;left:-84px;top:8px;width:52px;height:52px;border-radius:50%;background:var(--rf-bg);border:8px solid color-mix(in srgb,var(--rf-text) 40%,transparent);animation:k-pop .5s ${EASE} both}.ts:last-child .td{border-color:var(--rf-accent)}
.ts b{display:block;font:500 32px/1 ${MONO};color:var(--rf-muted)}
.ts span{display:block;margin-top:12px;font-size:50px;font-weight:600;line-height:1.1;letter-spacing:-.02em}`;
  return shell(ctx, { html, css, backdrop: 'split' });
};

/* ------------------------------------------------------------------ */
/* 29. Pricing card (fictional product)                                 */
/* ------------------------------------------------------------------ */
export interface PricingProps {
  plan: string;
  price: number;
  per: string;
  currency?: string;
  features: string[];
  badge?: string;
}
export const pricing: Design<PricingProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const c = counter(ctx, p.price, t0 + 0.4, 1.3, Math.round(p.price * 2.2));
  const html =
    `<div class="pcard"><div class="pc-top">${p.badge ? `<span class="pb pop" ${d(t0 + 0.3)}>${esc(p.badge)}</span>` : ''}<div class="pp">${esc(p.plan)}</div>` +
    `<div class="pv"><sup>${esc(p.currency ?? '$')}</sup>${c.html}<small>/${esc(p.per)}</small></div></div>` +
    `<ul>${p.features.map((f, i) => `<li class="rise" ${d(t0 + 0.8 + i * 0.14)}>${icon('check', 44)}${esc(f)}</li>`).join('')}</ul>` +
    `<div class="pbtn pop" ${d(t0 + 0.9 + p.features.length * 0.14)}>Start free trial</div></div>`;
  const css =
    c.css +
    `.pcard{position:absolute;left:110px;right:110px;top:340px;padding:70px 64px;border-radius:56px;background:color-mix(in srgb,var(--rf-surface) 88%,transparent);border:2px solid color-mix(in srgb,var(--rf-text) 10%,transparent);animation:k-rise 1s ${EASE} ${s(t0)} both}
.pb{display:inline-block;font:500 28px/1 ${MONO};color:var(--rf-accent);margin-bottom:30px}
.pp{font-size:56px;font-weight:600;color:var(--rf-muted)}
.pv{font-size:230px;font-weight:600;letter-spacing:-.06em;line-height:1;margin:10px 0 40px;font-variant-numeric:tabular-nums}.pv sup{font-size:.35em;vertical-align:top;position:relative;top:.4em}.pv small{font-size:.22em;letter-spacing:0;color:var(--rf-muted);font-weight:600}
ul{list-style:none;margin:0;padding:40px 0 0;border-top:2px solid color-mix(in srgb,var(--rf-text) 10%,transparent)}
li{display:flex;align-items:center;gap:22px;font-size:42px;font-weight:400;margin-bottom:28px}li .ic{color:var(--rf-muted);flex:none}
.pbtn{margin-top:30px;text-align:center;font-size:44px;font-weight:600;padding:34px;border-radius:28px;background:var(--rf-text);color:var(--rf-bg)}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 30. Tip card: big number, tip text, icon                             */
/* ------------------------------------------------------------------ */
export interface TipProps {
  n: number;
  topic: string;
  tip: string[];
  detail?: string;
  icon?: string;
}
export const tip: Design<TipProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const words = p.tip.join(' ').split(/\s+/).length;
  const html =
    `<div class="tp-n">${String(p.n).padStart(2, '0')}</div><div class="wrap"><div class="tp-top rise" ${d(t0)}><span class="tp-ic">${icon(p.icon ?? 'bulb', 56)}</span>${esc(p.topic)} · tip ${p.n}</div>` +
    `<h1>${maskLines(p.tip, t0 + 0.2, 'mk', 0.065)}</h1>` +
    (p.detail ? `<p class="sub rise" ${d(t0 + 0.4 + words * 0.065)}>${hl(p.detail)}</p>` : '') +
    `</div>`;
  const css =
    WRAP +
    H1(112) +
    SUB +
    maskCss() +
    ACC +
    `.tp-n{position:absolute;right:-40px;top:120px;font-size:720px;font-weight:600;letter-spacing:-.08em;line-height:1;color:transparent;-webkit-text-stroke:4px color-mix(in srgb,var(--rf-text) 12%,transparent)}
.tp-top{display:flex;align-items:center;gap:22px;margin-bottom:60px;font:500 32px/1 ${MONO};color:var(--rf-muted)}
.tp-ic{width:100px;height:100px;border-radius:30px;background:var(--rf-accent);color:var(--rf-bg);display:flex;align-items:center;justify-content:center}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

/* ------------------------------------------------------------------ */
/* 31. Steps: one big numbered step with progress dots                  */
/* ------------------------------------------------------------------ */
export interface StepProps {
  step: number;
  of: number;
  title: string[];
  text?: string;
  icon?: string;
}
export const step: Design<StepProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const dots = Array.from({ length: p.of }, (_, i) => `<i class="${i < p.step ? 'on' : ''}${i === p.step - 1 ? ' cur' : ''}"></i>`).join('');
  const html =
    `<div class="wrap"><div class="sp-top rise" ${d(t0)}><span class="sp-n">${p.step}</span><span class="sp-dots">${dots}</span></div>` +
    `<div class="sp-ic pop" ${d(t0 + 0.2)}>${icon(p.icon ?? 'arrow', 120)}</div>` +
    `<h1>${maskLines(p.title, t0 + 0.3, 'mk', 0.07)}</h1>` +
    (p.text ? `<p class="sub rise" ${d(t0 + 0.8)}>${hl(p.text)}</p>` : '') +
    `</div>`;
  const css =
    WRAP +
    H1(120) +
    SUB +
    maskCss() +
    ACC +
    `.sp-top{display:flex;align-items:center;gap:30px;margin-bottom:60px}
.sp-n{width:110px;height:110px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:600 54px/1 ${MONO};background:var(--rf-text);color:var(--rf-bg)}
.sp-dots{display:flex;gap:14px}.sp-dots i{width:60px;height:12px;border-radius:6px;background:color-mix(in srgb,var(--rf-text) 16%,transparent)}.sp-dots i.on{background:var(--rf-text)}
.sp-ic{width:220px;height:220px;border-radius:60px;margin-bottom:60px;display:flex;align-items:center;justify-content:center;background:var(--rf-accent);color:var(--rf-bg);transform-origin:left}`;
  return shell(ctx, { html, css, backdrop: 'grid' });
};

/* ------------------------------------------------------------------ */
/* 32. Product hero: 3D card with light sweep and spec labels           */
/* ------------------------------------------------------------------ */
export interface ProductProps {
  name: string;
  tagline: string;
  specs: string[];
  /** 'device' (rounded slab), 'bottle', 'headphones', 'watch'. */
  shape: 'device' | 'bottle' | 'headphones' | 'watch';
}
function productShape(shape: ProductProps['shape']): string {
  switch (shape) {
    case 'bottle':
      return `<div class="pr-bottle"><i class="cap"></i><i class="body"></i><i class="label"></i></div>`;
    case 'headphones':
      return `<div class="pr-hp"><i class="band"></i><i class="cup l"></i><i class="cup r"></i></div>`;
    case 'watch':
      return `<div class="pr-watch"><i class="strap"></i><i class="face"><b></b></i></div>`;
    default:
      return `<div class="pr-dev"><i class="scr"></i><i class="cam"></i></div>`;
  }
}
export const product: Design<ProductProps> = (ctx, p) => {
  const t0 = ctx.tin === 'none' ? 0.1 : 0.35;
  const specPos = [
    [80, 1200],
    [620, 1270],
    [140, 1400],
  ];
  const html =
    `<div class="pr-hd"><div class="pr-n">${letters(p.name, t0, 0.035)}</div><div class="pr-t rise" ${d(t0 + 0.5)}>${hl(p.tagline)}</div></div>` +
    `<div class="pr-stage"><div class="pr-obj">${productShape(p.shape)}</div><div class="pr-shadow"></div></div>` +
    p.specs
      .slice(0, 3)
      .map((sp, i) => `<div class="pr-spec pop" style="left:${specPos[i]![0]}px;top:${specPos[i]![1]}px;animation-delay:${s(t0 + 1 + i * 0.2)}"><i></i>${esc(sp)}</div>`)
      .join('');
  const css =
    lettersCss() +
    ACC +
    `.pr-hd{position:absolute;left:80px;right:80px;top:230px;text-align:center}
.pr-n{font-size:136px;font-weight:600;letter-spacing:-.05em;line-height:1}
.pr-t{margin-top:20px;font-size:46px;font-weight:600;color:var(--rf-muted)}
.pr-stage{position:absolute;left:0;right:0;top:520px;height:640px}
.pr-obj{position:absolute;left:50%;top:0;width:480px;height:600px;margin-left:-240px;animation:po-in 1.2s ${EASE} ${s(t0 + 0.2)} both}
@keyframes po-in{from{transform:translateY(120px);opacity:0}}
.pr-shadow{position:absolute;left:50%;bottom:-30px;width:420px;height:60px;margin-left:-210px;border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.5),transparent)}
.pr-dev{position:absolute;inset:0 60px;border-radius:70px;overflow:hidden;background:linear-gradient(150deg,color-mix(in srgb,var(--rf-text) 55%,var(--rf-surface)),var(--rf-surface) 55%,#000);box-shadow:inset 0 0 0 6px color-mix(in srgb,var(--rf-text) 30%,transparent),0 50px 100px -30px rgba(0,0,0,.8)}
.pr-dev .scr{position:absolute;inset:26px;border-radius:50px;background:radial-gradient(60% 40% at 30% 30%,var(--rf-accent),transparent 70%),radial-gradient(60% 50% at 80% 80%,var(--rf-accent2),transparent 70%),#05050a}
.pr-dev .cam{position:absolute;top:44px;left:50%;width:90px;height:26px;margin-left:-45px;border-radius:14px;background:#000}
.pr-bottle{position:absolute;inset:0 120px}
.pr-bottle .cap{position:absolute;left:30%;right:30%;top:0;height:80px;border-radius:20px;background:var(--rf-text)}
.pr-bottle .body{position:absolute;left:0;right:0;top:70px;bottom:0;border-radius:90px 90px 60px 60px;background:linear-gradient(90deg,color-mix(in srgb,var(--rf-accent) 70%,#000),var(--rf-accent) 40%,color-mix(in srgb,var(--rf-accent) 60%,#fff) 55%,color-mix(in srgb,var(--rf-accent) 70%,#000))}
.pr-bottle .label{position:absolute;left:0;right:0;top:250px;height:180px;background:color-mix(in srgb,var(--rf-bg) 85%,transparent)}
.pr-hp{position:absolute;inset:0}
.pr-hp .band{position:absolute;left:60px;right:60px;top:40px;height:440px;border-radius:220px 220px 0 0;border:46px solid color-mix(in srgb,var(--rf-text) 80%,var(--rf-surface));border-bottom:0}
.pr-hp .cup{position:absolute;top:330px;width:170px;height:240px;border-radius:70px;background:linear-gradient(160deg,var(--rf-accent),color-mix(in srgb,var(--rf-accent) 50%,#000))}
.pr-hp .cup.l{left:20px}.pr-hp .cup.r{right:20px}
.pr-watch{position:absolute;inset:0}
.pr-watch .strap{position:absolute;left:150px;right:150px;top:0;bottom:0;border-radius:40px;background:linear-gradient(90deg,color-mix(in srgb,var(--rf-accent2) 60%,#000),var(--rf-accent2),color-mix(in srgb,var(--rf-accent2) 60%,#000))}
.pr-watch .face{position:absolute;left:70px;right:70px;top:120px;height:360px;border-radius:90px;background:#05050a;box-shadow:inset 0 0 0 14px color-mix(in srgb,var(--rf-text) 60%,#000)}
.pr-watch .face b{position:absolute;inset:70px;border-radius:50%;border:16px solid var(--rf-accent);border-right-color:transparent;animation:wf ${s(ctx.dur)} linear both}
@keyframes wf{to{transform:rotate(200deg)}}
.pr-spec{position:absolute;display:flex;align-items:center;gap:16px;padding:18px 28px;border-radius:16px;font-size:36px;font-weight:500;background:var(--rf-surface);border:2px solid color-mix(in srgb,var(--rf-text) 8%,transparent)}
.pr-spec i{width:14px;height:14px;border-radius:50%;background:var(--rf-muted)}`;
  return shell(ctx, { html, css, backdrop: 'plain' });
};

export const DESIGNS = {
  hero,
  stat,
  bars,
  line,
  donut,
  checklist,
  quote,
  phone,
  browser,
  code,
  countdown,
  versus,
  beforeAfter,
  recipe,
  route,
  listing,
  ticket,
  role,
  lyric,
  podcast,
  timer,
  scoreboard,
  changelog,
  outro,
  notifications,
  featureGrid,
  manifesto,
  timeline,
  pricing,
  tip,
  step,
  product,
} as const;

export type DesignName = keyof typeof DESIGNS;
export { EASE };
