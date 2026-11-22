import type { HtmlTitleProps, OutputSettings, ThemeTokens } from '@reelforge/project-schema';

/**
 * Builds the sandboxed document an html scene is rendered from. Agent HTML and
 * CSS go inside a fixed shell with a Content-Security-Policy that blocks every
 * script and every non-data: resource; the renderer also aborts all network
 * requests (render.ts), so a scene cannot reach the network or run code.
 */

export const CSP =
  "default-src 'none'; img-src data:; font-src data:; media-src data:; style-src 'unsafe-inline' data:; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** CSS custom properties every html scene can use: --rf-bg, --rf-accent, --rf-font, ... */
export function themeCss(theme: ThemeTokens, output: OutputSettings, durationSeconds: number): string {
  const c = theme.colors;
  return `:root{--rf-bg:${c.background};--rf-surface:${c.surface};--rf-text:${c.text};--rf-muted:${c.mutedText};--rf-accent:${c.accent};--rf-accent2:${c.accent2};--rf-font:${theme.fontFamily};--rf-heading-weight:${theme.headingWeight};--rf-radius:${theme.radius};--rf-spacing:${theme.spacing};--rf-speed:${theme.motionSpeed};--rf-width:${output.width}px;--rf-height:${output.height}px;--rf-duration:${durationSeconds}s;--rf-unit:${output.width / 100}px}`;
}

export function buildDocument(opts: {
  html: string;
  css: string;
  theme: ThemeTokens;
  output: OutputSettings;
  durationSeconds: number;
}): string {
  if (/<\/style/i.test(opts.css)) throw new Error('css must not contain "</style"');
  const { width, height } = opts.output;
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style>${themeCss(opts.theme, opts.output, opts.durationSeconds)}` +
    `html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:var(--rf-bg);color:var(--rf-text);font-family:var(--rf-font)}` +
    `#rf-root{position:relative;width:${width}px;height:${height}px;overflow:hidden;box-sizing:border-box}` +
    '*{box-sizing:border-box}</style>' +
    `<style>${opts.css}</style></head>` +
    `<body><div id="rf-root">${opts.html}</div></body></html>`
  );
}

/**
 * Built-in template "html-title": kicker, headline (words rise in one by
 * one), accent bar and subline, with an exit in the last 12%. The first
 * frame already shows the background shapes and a faint headline, so
 * thumbnails are never blank.
 */
export function htmlTitle(props: HtmlTitleProps, durationSeconds: number): { html: string; css: string } {
  const words = props.headline.split(/\s+/).filter(Boolean);
  const exitAt = (durationSeconds * 0.88).toFixed(3);
  const exitLen = Math.max(0.15, durationSeconds * 0.12 - 0.02).toFixed(3);
  const accent = props.accent ? `--rf-accent:${props.accent};` : '';
  const background = props.background ? `--rf-bg:${props.background};` : '';
  const html =
    `<div class="rf-t" style="${accent}${background}">` +
    `<div class="rf-card">` +
    (props.kicker ? `<div class="rf-kicker">${escapeHtml(props.kicker)}</div>` : '') +
    `<h1>${words.map((w, i) => `<span style="animation-delay:calc(${(i * 0.08).toFixed(2)}s / var(--rf-speed))">${escapeHtml(w)}</span>`).join(' ')}</h1>` +
    '<div class="rf-bar"></div>' +
    (props.subline ? `<p>${escapeHtml(props.subline)}</p>` : '') +
    '</div></div>';
  const css = `
.rf-t{position:absolute;inset:0;background:var(--rf-bg);display:flex;align-items:center;padding:calc(var(--rf-unit)*9 * var(--rf-spacing));overflow:hidden}
.rf-card{position:relative;width:100%;animation:rf-exit ${exitLen}s ease-in ${exitAt}s both}
.rf-kicker{display:inline-block;font-size:calc(var(--rf-unit)*4);font-weight:700;letter-spacing:.12em;color:var(--rf-bg);background:var(--rf-accent);padding:.35em .7em;border-radius:calc(var(--rf-radius)*.4em);margin-bottom:calc(var(--rf-unit)*4);animation:rf-fade calc(.5s / var(--rf-speed)) ease-out both}
h1{margin:0;font-size:calc(var(--rf-unit)*10.5);line-height:1.05;font-weight:var(--rf-heading-weight);letter-spacing:-.02em;color:var(--rf-text)}
h1 span{display:inline-block;animation:rf-rise calc(.7s / var(--rf-speed)) cubic-bezier(.16,1,.3,1) both}
.rf-bar{height:calc(var(--rf-unit)*1.4);background:var(--rf-accent);border-radius:999px;margin-top:calc(var(--rf-unit)*3.5);transform-origin:left center;animation:rf-bar calc(.8s / var(--rf-speed)) cubic-bezier(.3,.8,.2,1) calc(.25s / var(--rf-speed)) both;width:45%}
p{margin:calc(var(--rf-unit)*4) 0 0;font-size:calc(var(--rf-unit)*4.8);font-weight:500;color:var(--rf-muted);animation:rf-fade calc(.6s / var(--rf-speed)) ease-out calc(.5s / var(--rf-speed)) both}
@keyframes rf-rise{from{opacity:.3;transform:translateY(.45em) scale(.94)}to{opacity:1;transform:none}}
@keyframes rf-fade{from{opacity:0;transform:translateY(.6em)}to{opacity:1;transform:none}}
@keyframes rf-bar{from{transform:scaleX(.15)}to{transform:scaleX(1)}}
@keyframes rf-exit{from{opacity:1;transform:none}to{opacity:0;transform:translateY(calc(var(--rf-unit)*-6))}}
`;
  return { html, css };
}
