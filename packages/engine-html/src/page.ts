import { assertSafeSceneFragment } from '@reelforge/core';
import { domThemeCss, frameLayout, mediaLayersHtml, type DomLogo, type DomMediaLayer, type HtmlTitleProps, type OutputSettings, type ThemeTokens } from '@reelforge/project-schema';

/**
 * Builds the sandboxed document an html scene is rendered from. Agent HTML and
 * CSS go inside a fixed shell with a Content-Security-Policy that blocks every
 * script and every non-data: resource; the renderer also aborts all network
 * requests (render.ts), so a scene cannot reach the network or run code.
 * The fragment is parsed first: markup that would set its own page policy
 * (`<meta http-equiv>`, `<base>`) is refused (D-085). The shell's head comes
 * before the fragment, so nothing in the fragment can precede the CSP.
 */

export const CSP =
  "default-src 'none'; img-src data:; font-src data:; media-src data:; style-src 'unsafe-inline' data:; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * The policy for a scene that uses assets (#299): images and fonts may also
 * come from this render's own asset base (`http://rf-assets.invalid/<token>/`,
 * answered by request interception in render.ts, never by the network).
 */
export function cspFor(assetBase?: string): string {
  if (!assetBase) return CSP;
  return CSP.replace('img-src data:', `img-src data: ${assetBase}`).replace('font-src data:', `font-src data: ${assetBase}`);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * CSS custom properties every html scene can use: theme (--rf-bg, --rf-accent,
 * --rf-font, ...) and layout (#287): --rf-unit is 1 % of the shorter side;
 * --rf-safe-* are the content insets (title safe, plus the social ui zone on
 * tall frames), --rf-title-safe-* and --rf-action-safe-* the broadcast ones;
 * --rf-content-w/h the box inside --rf-safe-*.
 */
export function themeCss(theme: ThemeTokens, output: OutputSettings, durationSeconds: number, platform?: string): string {
  return domThemeCss(theme, output, durationSeconds, platform);
}

export function buildDocument(opts: {
  html: string;
  css: string;
  theme: ThemeTokens;
  output: OutputSettings;
  durationSeconds: number;
  /** brief.platform: decides the ui safe zone on tall frames. */
  platform?: string;
  /** The render's asset base URL, allowed by the policy for images and fonts. */
  assetBase?: string;
}): string {
  if (/<\/style/i.test(opts.css)) throw new Error('css must not contain "</style"');
  assertSafeSceneFragment(opts.html);
  const { width, height } = opts.output;
  const l = frameLayout(width, height, opts.platform);
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${cspFor(opts.assetBase)}">` +
    `<style>${themeCss(opts.theme, opts.output, opts.durationSeconds, opts.platform)}` +
    `html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:var(--rf-bg);color:var(--rf-text);font-family:var(--rf-font)}` +
    `#rf-root{position:relative;width:${width}px;height:${height}px;overflow:hidden;box-sizing:border-box}` +
    '*{box-sizing:border-box}</style>' +
    `<style>${opts.css}</style></head>` +
    `<body><div id="rf-root" data-rf-orientation="${l.orientation}" data-rf-direction="${l.direction}">${opts.html}</div></body></html>`
  );
}

/**
 * Built-in template "html-title": kicker, headline (words rise in one by
 * one), accent bar and subline, with an exit in the last 12%. The first
 * frame already shows the background shapes and a faint headline, so
 * thumbnails are never blank.
 *
 * Any size (#287): everything is in --rf-unit (1 % of the shorter side) and
 * sits inside the --rf-safe-* insets. The card is a flex column as tall as the
 * content box at most; the headline is the only part that shrinks
 * (`data-rf-fit`: the renderer lowers its font size until it fits, never
 * below 40 % of its size). On landscape frames the line length is capped so a
 * headline does not run across the whole width.
 */
export function htmlTitle(props: HtmlTitleProps, durationSeconds: number, media: { bg?: DomMediaLayer; logo?: DomLogo } = {}): { html: string; css: string } {
  const layers = mediaLayersHtml(media.bg, media.logo);
  const words = props.headline.split(/\s+/).filter(Boolean);
  const exitAt = (durationSeconds * 0.88).toFixed(3);
  const exitLen = Math.max(0.15, durationSeconds * 0.12 - 0.02).toFixed(3);
  const accent = props.accent ? `--rf-accent:${props.accent};` : '';
  const background = props.background ? `--rf-bg:${props.background};` : '';
  const html =
    `<div class="rf-t" style="${accent}${background}">` +
    layers.under +
    `<div class="rf-card">` +
    (props.kicker ? `<div class="rf-kicker">${escapeHtml(props.kicker)}</div>` : '') +
    `<h1 data-rf-fit>${words.map((w, i) => `<span style="animation-delay:calc(${(i * 0.08).toFixed(2)}s / var(--rf-speed))">${escapeHtml(w)}</span>`).join(' ')}</h1>` +
    '<div class="rf-bar"></div>' +
    (props.subline ? `<p>${escapeHtml(props.subline)}</p>` : '') +
    '</div>' +
    layers.over +
    '</div>';
  const css = `
.rf-t{position:absolute;inset:0;background:var(--rf-bg);display:flex;align-items:center;padding:var(--rf-safe-top) max(var(--rf-safe-right),calc(var(--rf-unit)*9*var(--rf-spacing))) var(--rf-safe-bottom) max(var(--rf-safe-left),calc(var(--rf-unit)*9*var(--rf-spacing)));overflow:hidden}
.rf-card{position:relative;z-index:1;width:100%;max-height:100%;display:flex;flex-direction:column;align-items:flex-start;animation:rf-exit ${exitLen}s ease-in ${exitAt}s both}
[data-rf-direction=row] .rf-card{max-width:calc(var(--rf-unit)*150)}
.rf-card>*{flex-shrink:0}
.rf-kicker{display:inline-block;font-size:calc(var(--rf-unit)*4);font-weight:700;letter-spacing:.12em;color:var(--rf-bg);background:var(--rf-accent);padding:.35em .7em;border-radius:calc(var(--rf-radius)*.4em);margin-bottom:calc(var(--rf-unit)*4);animation:rf-fade calc(.5s / var(--rf-speed)) ease-out both}
.rf-card>h1{flex-shrink:1;min-height:0;width:100%;margin:0;font-size:calc(var(--rf-unit)*10.5);line-height:1.05;font-weight:var(--rf-heading-weight);letter-spacing:-.02em;color:var(--rf-text);overflow-wrap:normal}
h1 span{display:inline-block;animation:rf-rise calc(.7s / var(--rf-speed)) cubic-bezier(.16,1,.3,1) both}
.rf-bar{height:calc(var(--rf-unit)*1.4);background:var(--rf-accent);border-radius:999px;margin-top:calc(var(--rf-unit)*3.5);transform-origin:left center;animation:rf-bar calc(.8s / var(--rf-speed)) cubic-bezier(.3,.8,.2,1) calc(.25s / var(--rf-speed)) both;width:45%}
p{margin:calc(var(--rf-unit)*4) 0 0;max-width:100%;text-wrap:pretty;font-size:calc(var(--rf-unit)*4.8);font-weight:500;color:var(--rf-muted);animation:rf-fade calc(.6s / var(--rf-speed)) ease-out calc(.5s / var(--rf-speed)) both}
@keyframes rf-rise{from{opacity:.3;transform:translateY(.45em) scale(.94)}to{opacity:1;transform:none}}
@keyframes rf-fade{from{opacity:0;transform:translateY(.6em)}to{opacity:1;transform:none}}
@keyframes rf-bar{from{transform:scaleX(.15)}to{transform:scaleX(1)}}
@keyframes rf-exit{from{opacity:1;transform:none}to{opacity:0;transform:translateY(calc(var(--rf-unit)*-6))}}
${layers.css}`;
  return { html, css };
}
