import { clearOfLowerThird, frameLayout, layoutPanes, lowerThirdBox, LAYOUT_DEFAULTS, type LayoutResult, type PaneBox } from './layout';
import { toLayoutSpec, type LayoutPane, type LayoutSceneProps } from './layouts';

/**
 * The layout templates (#287) as HTML and CSS for the DOM engines (html and
 * hyperframes). Geometry comes from layout.ts, so both engines put every pane,
 * text block and lower third on the same pixels. Engines differ only in how a
 * picture gets into the page, which they supply as `picture()`: the html
 * engine inlines images and swaps video frames per frame, HyperFrames plays a
 * `<video>` clip from the scene folder.
 *
 * Theme colours and fonts come from the page's `--rf-*` variables (both
 * engines set them). Text shrinks to fit its box (`data-rf-fit`).
 */

export interface PictureRequest {
  pane: number;
  /** `fg` is the picture; `bg` the blurred copy behind it (blur-fill). */
  layer: 'fg' | 'bg';
  media: NonNullable<LayoutPane['media']>;
  /** Class and inline style the element must carry (position, fit, filter). */
  className: string;
  style: string;
}

export interface LayoutDomOptions {
  props: LayoutSceneProps;
  width: number;
  height: number;
  platform?: string;
  durationSeconds: number;
  /** Markup of one picture element (`<img>` or `<video>`) with the given class and style. */
  picture: (req: PictureRequest) => string;
}

export interface LayoutDom {
  html: string;
  css: string;
  layout: LayoutResult;
}

/** Font size of a pane's text card in units: its headline; the body is 0.58 of it. */
const CARD_SIZE = 7.2;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const box = (r: { x: number; y: number; width: number; height: number }) => `left:${px(r.x)};top:${px(r.y)};width:${px(r.width)};height:${px(r.height)}`;

function paneMarkup(o: LayoutDomOptions, p: PaneBox, pane: LayoutPane, unit: number): string {
  const parts: string[] = [];
  const m = pane.media;
  if (m) {
    const pos = `object-position:${m.focus?.x ?? 50}% ${m.focus?.y ?? 50}%`;
    if (m.fit === 'blur-fill') {
      const blur = (m.blur ?? LAYOUT_DEFAULTS.blur) * unit;
      // Scaled up so the blur's soft edge stays outside the pane; darkened so the picture in front reads first.
      parts.push(o.picture({ pane: p.index, layer: 'bg', media: m, className: 'rfl-pic rfl-bg', style: `object-fit:cover;${pos};filter:blur(${px(blur)}) brightness(.62);transform:scale(1.12)` }));
    }
    parts.push(o.picture({ pane: p.index, layer: 'fg', media: m, className: 'rfl-pic', style: `object-fit:${m.fit === 'cover' ? 'cover' : 'contain'};${pos}` }));
  }
  const bg = pane.color ? `background:${pane.color};` : '';
  return `<div class="rfl-pane rfl-${p.role}" data-rfl-pane="${p.index}" style="${box(p)};${bg}">${parts.join('')}</div>`;
}

function textMarkup(p: PaneBox, pane: LayoutPane, top: boolean, onMedia: boolean, unit: number): string {
  const minCard = CARD_SIZE * unit * 0.36;
  if (!pane.headline && !pane.body && !pane.label) return '';
  const label = pane.label ? `<div class="rfl-label" data-rf-fit>${esc(pane.label)}</div>` : '';
  const card =
    pane.headline || pane.body
      ? // The whole card shrinks to fit (headline, body and padding are in em of the card).
        `<div class="rfl-card${onMedia ? ' rfl-on-media' : ''}" data-rf-fit data-rf-fit-tol="0" data-rf-fit-min="${Math.floor(minCard)}">` +
        (pane.headline ? `<h2>${esc(pane.headline)}</h2>` : '') +
        (pane.body ? `<p>${esc(pane.body)}</p>` : '') +
        '</div>'
      : '';
  return `<div class="rfl-text${top ? ' rfl-top' : ''}" data-rfl-text="${p.index}" data-rfl-safe="${p.textSafe}" style="${box(p.text)}">${label}${card}</div>`;
}

function lowerThirdMarkup(o: LayoutDomOptions): { html: string; css: string } {
  const lt = o.props.lowerThird;
  if (!lt) return { html: '', css: '' };
  const l = frameLayout(o.width, o.height, o.platform);
  const b = lowerThirdBox(l, lt.align);
  const vars = `${lt.accent ? `--rfl-lt-accent:${lt.accent};` : ''}${lt.background ? `--rfl-lt-bg:${lt.background};` : ''}${lt.text ? `--rfl-lt-text:${lt.text};` : ''}`;
  const side = lt.align === 'left' ? `left:${px(b.x)}` : `right:${px(o.width - b.x)}`;
  const outAt = Math.max(0, o.durationSeconds - 0.45).toFixed(3);
  const html =
    `<div class="rfl-lt rfl-lt-${lt.align}" style="${vars}${side};bottom:${px(o.height - b.bottom)};max-width:${px(b.maxWidth)};max-height:${px(b.height)}">` +
    // The text block shrinks as a whole (name, title and padding are in em of it) until it fits the band.
    `<div class="rfl-lt-bar"></div><div class="rfl-lt-text" data-rf-fit data-rf-fit-tol="0" data-rf-fit-min="${Math.floor(b.nameSize * 0.45)}">` +
    `<div class="rfl-lt-name">${esc(lt.name)}</div>` +
    (lt.title ? `<div class="rfl-lt-title">${esc(lt.title)}</div>` : '') +
    '</div></div>';
  const css =
    `.rfl-lt{position:absolute;display:flex;align-items:stretch;background:var(--rfl-lt-bg,var(--rf-surface));color:var(--rfl-lt-text,var(--rf-text));border-radius:${px(0.8 * l.unit)};overflow:hidden;animation:rfl-lt-in .5s cubic-bezier(.2,.8,.2,1) .25s both,rfl-out .4s ease-in ${outAt}s both}` +
    `.rfl-lt-right{flex-direction:row-reverse}` +
    `.rfl-lt-bar{flex:0 0 ${px(b.bar)};background:var(--rfl-lt-accent,var(--rf-accent))}` +
    `.rfl-lt-text{min-width:0;max-height:${px(b.height)};overflow:hidden;font-size:${px(b.nameSize)};padding:${(b.padding * 0.8) / b.nameSize}em ${b.padding / b.nameSize}em}` +
    `.rfl-lt-name{font-weight:var(--rf-heading-weight);line-height:1.12}` +
    `.rfl-lt-title{font-size:${b.titleSize / b.nameSize}em;line-height:1.3;opacity:.78;margin-top:.1em;text-wrap:pretty}` +
    `.rfl-lt-right .rfl-lt-text{text-align:right}` +
    `@keyframes rfl-lt-in{from{opacity:0;transform:translateX(${px((lt.align === 'left' ? -4 : 4) * l.unit)})}to{opacity:1;transform:none}}`;
  return { html, css };
}

/** HTML and CSS of a layout scene at one frame size. */
export function layoutSceneDom(o: LayoutDomOptions): LayoutDom {
  const l = frameLayout(o.width, o.height, o.platform);
  const u = l.unit;
  const panesOnly = layoutPanes(l, toLayoutSpec(o.props.layout), o.props.panes.length);
  const layout = o.props.lowerThird ? clearOfLowerThird(panesOnly, lowerThirdBox(l, o.props.lowerThird.align)) : panesOnly;
  const lt = lowerThirdMarkup(o);
  const textTop = Boolean(o.props.lowerThird);
  const panes = layout.panes.map((p) => paneMarkup(o, p, o.props.panes[p.index]!, u)).join('');
  const texts = layout.panes.map((p) => textMarkup(p, o.props.panes[p.index]!, textTop, Boolean(o.props.panes[p.index]!.media), u)).join('');
  const vars = `${o.props.background ? `--rf-bg:${o.props.background};` : ''}${o.props.accent ? `--rf-accent:${o.props.accent};` : ''}`;
  const html = `<div class="rfl" style="${vars}">${panes}${texts}${lt.html}</div>`;
  const inset = layout.panes.find((p) => p.role === 'inset');
  const css =
    `.rfl{position:absolute;inset:0;overflow:hidden;background:var(--rf-bg);font-family:var(--rf-font);color:var(--rf-text)}` +
    `.rfl-pane{position:absolute;overflow:hidden;background:var(--rf-surface)}` +
    `.rfl-pic{position:absolute;inset:0;width:100%;height:100%;display:block}` +
    (inset
      ? `.rfl-inset{border-radius:${px(1.4 * u)};outline:${px(0.4 * u)} solid var(--rf-bg);animation:rfl-pop .55s cubic-bezier(.2,.8,.2,1) .15s both}`
      : '') +
    `.rfl-text{position:absolute;display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-start;gap:${px(1.6 * u)}}` +
    `.rfl-text.rfl-top{justify-content:flex-start}` +
    `.rfl-label{flex-shrink:0;max-width:100%;white-space:nowrap;overflow:hidden;font-size:${px(3.4 * u)};font-weight:600;line-height:1.2;padding:.2em .42em;border-radius:.18em;background:var(--rf-bg);color:var(--rf-text);animation:rfl-in .5s ease-out both}` +
    `.rfl-text:not(.rfl-top) .rfl-label{order:-1;margin-bottom:auto}` +
    `.rfl-card{display:flex;flex-direction:column;min-height:0;max-height:100%;max-width:min(100%,${px(95 * u)});font-size:${px(CARD_SIZE * u)};animation:rfl-in .6s cubic-bezier(.2,.8,.2,1) .1s both}` +
    `.rfl-card.rfl-on-media{background:var(--rf-bg);padding:.28em .36em;border-radius:.11em}` +
    `.rfl-card>*{flex-shrink:0}` +
    `.rfl-card>h2{margin:0;font-size:1em;font-weight:var(--rf-heading-weight);line-height:1.08;letter-spacing:-.01em}` +
    `.rfl-card>p{margin:0;font-size:.58em;line-height:1.32;color:var(--rf-muted);text-wrap:pretty}` +
    `.rfl-card>h2+p{margin-top:.34em}` +
    `@keyframes rfl-in{from{opacity:0;transform:translateY(${px(2.5 * u)})}to{opacity:1;transform:none}}` +
    `@keyframes rfl-pop{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}` +
    `@keyframes rfl-out{to{opacity:0}}` +
    lt.css;
  return { html, css, layout };
}
