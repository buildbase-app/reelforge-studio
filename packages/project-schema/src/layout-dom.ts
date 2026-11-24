import { clearOfLowerThird, frameLayout, layoutCssVars, layoutPanes, lowerThirdBox, LAYOUT_DEFAULTS, LAYOUT_STYLE, type LayoutResult, type PaneBox } from './layout';
import { toLayoutSpec, type LayoutPane, type LayoutSceneProps } from './layouts';
import type { ThemeTokens } from './themes';

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

/**
 * The page's CSS custom properties for DOM scenes: theme (--rf-bg, --rf-surface,
 * --rf-text, --rf-muted, --rf-accent, --rf-font, ...) and layout (--rf-unit,
 * --rf-safe-*, ...). The html engine's page and the Remotion layout
 * composition both set these, so the same layout markup draws the same pixels.
 */
export function domThemeCss(theme: ThemeTokens, size: { width: number; height: number }, durationSeconds: number, platform?: string): string {
  const c = theme.colors;
  return `:root{--rf-bg:${c.background};--rf-surface:${c.surface};--rf-text:${c.text};--rf-muted:${c.mutedText};--rf-accent:${c.accent};--rf-accent2:${c.accent2};--rf-font:${theme.fontFamily};--rf-heading-weight:${theme.headingWeight};--rf-radius:${theme.radius};--rf-spacing:${theme.spacing};--rf-speed:${theme.motionSpeed};--rf-width:${size.width}px;--rf-height:${size.height}px;--rf-duration:${durationSeconds}s;${layoutCssVars(size.width, size.height, platform)}}`;
}

const S = LAYOUT_STYLE;
const M = S.motion;
const bez = (e: readonly number[]) => `cubic-bezier(${e.join(',')})`;

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
      parts.push(o.picture({ pane: p.index, layer: 'bg', media: m, className: 'rfl-pic rfl-bg', style: `object-fit:cover;${pos};filter:blur(${px(blur)}) brightness(${S.blurFill.brightness});transform:scale(${S.blurFill.scale})` }));
    }
    parts.push(o.picture({ pane: p.index, layer: 'fg', media: m, className: 'rfl-pic', style: `object-fit:${m.fit === 'cover' ? 'cover' : 'contain'};${pos}` }));
  }
  const bg = pane.color ? `background:${pane.color};` : '';
  return `<div class="rfl-pane rfl-${p.role}" data-rfl-pane="${p.index}" style="${box(p)};${bg}">${parts.join('')}</div>`;
}

function textMarkup(p: PaneBox, pane: LayoutPane, top: boolean, onMedia: boolean, unit: number): string {
  const minCard = S.card.size * unit * S.card.minShare;
  if (!pane.headline && !pane.body && !pane.label) return '';
  const label = pane.label ? `<div class="rfl-label" data-rf-fit>${esc(pane.label)}</div>` : '';
  const card =
    pane.headline || pane.body
      ? // The whole card shrinks to fit (headline, body and padding are in em of the card).
        `<div class="rfl-card${onMedia ? ' rfl-on-media' : ''}" data-rf-fit data-rf-fit-tol="${S.fitInk}" data-rf-fit-min="${Math.floor(minCard)}">` +
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
  const outAt = Math.max(0, o.durationSeconds - M.lowerThirdOut.lead).toFixed(3);
  const html =
    `<div class="rfl-lt rfl-lt-${lt.align}" style="${vars}${side};bottom:${px(o.height - b.bottom)};max-width:${px(b.maxWidth)};max-height:${px(b.height)}">` +
    // The text block shrinks as a whole (name, title and padding are in em of it) until it fits the band.
    `<div class="rfl-lt-bar"></div><div class="rfl-lt-text" data-rf-fit data-rf-fit-tol="0" data-rf-fit-min="${Math.floor(b.nameSize * S.lowerThird.minShare)}">` +
    `<div class="rfl-lt-name">${esc(lt.name)}</div>` +
    (lt.title ? `<div class="rfl-lt-title">${esc(lt.title)}</div>` : '') +
    '</div></div>';
  const css =
    `.rfl-lt{position:absolute;display:flex;align-items:stretch;background:var(--rfl-lt-bg,var(--rf-surface));color:var(--rfl-lt-text,var(--rf-text));border-radius:${px(S.lowerThird.radius * l.unit)};overflow:hidden;animation:rfl-lt-in ${M.lowerThirdIn.duration}s ${bez(M.lowerThirdIn.ease)} ${M.lowerThirdIn.delay}s both,rfl-out ${M.lowerThirdOut.duration}s ${bez(M.lowerThirdOut.ease)} ${outAt}s both}` +
    `.rfl-lt-right{flex-direction:row-reverse}` +
    `.rfl-lt-bar{flex:0 0 ${px(b.bar)};background:var(--rfl-lt-accent,var(--rf-accent))}` +
    `.rfl-lt-text{min-width:0;max-height:${px(b.height)};overflow:hidden;font-size:${px(b.nameSize)};padding:${(b.padding * S.lowerThird.padYShare) / b.nameSize}em ${b.padding / b.nameSize}em}` +
    `.rfl-lt-name{font-weight:var(--rf-heading-weight);line-height:${S.lowerThird.nameLineHeight}}` +
    `.rfl-lt-title{font-size:${b.titleSize / b.nameSize}em;line-height:${S.lowerThird.titleLineHeight};opacity:${S.lowerThird.titleOpacity};margin-top:${S.lowerThird.titleGapEm}em;text-wrap:pretty}` +
    `.rfl-lt-right .rfl-lt-text{text-align:right}` +
    `@keyframes rfl-lt-in{from{opacity:0;transform:translateX(${px((lt.align === 'left' ? -1 : 1) * M.lowerThirdIn.slide * l.unit)})}to{opacity:1;transform:none}}`;
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
      ? `.rfl-inset{border-radius:${px(S.inset.radius * u)};outline:${px(S.inset.outline * u)} solid var(--rf-bg);animation:rfl-pop ${M.inset.duration}s ${bez(M.inset.ease)} ${M.inset.delay}s both}`
      : '') +
    `.rfl-text{position:absolute;display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-start;gap:${px(S.textGap * u)}}` +
    `.rfl-text.rfl-top{justify-content:flex-start}` +
    `.rfl-label{flex-shrink:0;max-width:100%;white-space:nowrap;overflow:hidden;font-size:${px(S.label.size * u)};font-weight:${S.label.weight};line-height:${S.label.lineHeight};padding:${S.label.padYEm}em ${S.label.padXEm}em;border-radius:${S.label.radiusEm}em;background:var(--rf-bg);color:var(--rf-text);animation:rfl-in ${M.label.duration}s ${bez(M.label.ease)} ${M.label.delay}s both}` +
    `.rfl-text:not(.rfl-top) .rfl-label{order:-1;margin-bottom:auto}` +
    `.rfl-card{display:flex;flex-direction:column;min-height:0;max-height:100%;max-width:min(100%,${px(S.card.maxWidth * u)});font-size:${px(S.card.size * u)};animation:rfl-in ${M.card.duration}s ${bez(M.card.ease)} ${M.card.delay}s both}` +
    `.rfl-card.rfl-on-media{background:var(--rf-bg);padding:${S.card.padYEm}em ${S.card.padXEm}em;border-radius:${S.card.radiusEm}em}` +
    `.rfl-card>*{flex-shrink:0}` +
    `.rfl-card>h2{margin:0;font-size:1em;font-weight:var(--rf-heading-weight);line-height:${S.card.headlineLineHeight};letter-spacing:${S.card.letterSpacingEm}em}` +
    `.rfl-card>p{margin:0;font-size:${S.card.bodyEm}em;line-height:${S.card.bodyLineHeight};color:var(--rf-muted);text-wrap:pretty}` +
    `.rfl-card>h2+p{margin-top:${S.card.bodyGapEm}em}` +
    `@keyframes rfl-in{from{opacity:0;transform:translateY(${px(M.card.rise * u)})}to{opacity:1;transform:none}}` +
    `@keyframes rfl-pop{from{opacity:0;transform:scale(${M.inset.from})}to{opacity:1;transform:none}}` +
    `@keyframes rfl-out{to{opacity:0}}` +
    lt.css;
  return { html, css, layout };
}
