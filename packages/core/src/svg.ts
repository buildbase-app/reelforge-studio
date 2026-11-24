import { defaultTreeAdapter as ta, parseFragment, type DefaultTreeAdapterMap } from 'parse5';

/**
 * SVG assets (#299). SVG is a document format: it can carry scripts, event
 * handlers, links, `<foreignObject>` HTML and references to remote files. An
 * uploaded SVG is therefore rewritten from an allowlist before it is stored
 * (and again when a render stages it): only drawing elements and attributes
 * survive, links may only point inside the file (`#id`), and styles that load
 * anything are dropped. Engines show SVG only as an image (`<img>`, Remotion
 * `<Img>`, Motion Canvas `Img`), where browsers never run scripts or load
 * subresources anyway, and the asset origin sends `script-src 'none'`.
 *
 * The file is parsed with parse5 (the HTML parser's foreign-content rules, so
 * element and attribute names get SVG's casing) and written back as XML by
 * this module, never by splicing text.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export class SvgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvgError';
  }
}

/** Largest SVG accepted (bytes). Logos and icons are a few KB. */
export const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 50_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'switch',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker', 'style',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA',
  'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology',
  'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]);

const SAFE_NAME = /^[A-Za-z_][-A-Za-z0-9_.]*$/;
/** url(...) that points anywhere but a fragment of this file. */
const EXTERNAL_URL = /url\(\s*(?!['"]?\s*#)/i;
const DANGEROUS = /javascript:|vbscript:|data:|@import|expression\s*\(|-moz-binding|behavior\s*:/i;

/** Does this text look like an SVG document (after an optional BOM, XML declaration, comments and doctype)? */
export function looksLikeSvg(head: Buffer | string): boolean {
  // A linear scan, not a regex: a backtracking pattern over repeated comments is a ReDoS on untrusted uploads.
  const s = (typeof head === 'string' ? head : head.toString('utf8')).replace(/^\uFEFF/, '');
  const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
  let i = 0;
  const skipSpace = () => {
    while (isSpace(s[i])) i++;
  };
  skipSpace();
  while (s.startsWith('<!--', i)) {
    const end = s.indexOf('-->', i + 4);
    if (end < 0) return false;
    i = end + 3;
    skipSpace();
  }
  if (s.startsWith('<?xml', i)) return isSpace(s[i + 5]);
  const lower = s.slice(i, i + 9).toLowerCase();
  if (lower === '<!doctype') {
    let j = i + 9;
    if (!isSpace(s[j])) return false;
    while (isSpace(s[j])) j++;
    return s.slice(j, j + 3).toLowerCase() === 'svg';
  }
  if (lower.startsWith('<svg')) return s[i + 4] === '>' || isSpace(s[i + 4]);
  return false;
}

function esc(s: string, attr: boolean): string {
  let out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (attr) out = out.replace(/"/g, '&quot;');
  // Characters XML 1.0 does not allow are dropped.
  return out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

function keepAttribute(a: Element['attrs'][number]): [string, string] | null {
  const name = a.prefix === 'xlink' && a.name === 'href' ? 'href' : a.prefix === 'xml' ? `xml:${a.name}` : a.prefix ? null : a.name;
  if (!name) return null;
  if (name.startsWith('xml:') ? !/^xml:(space|lang)$/.test(name) : !SAFE_NAME.test(name)) return null;
  if (/^on/i.test(name) || name === 'xmlns') return null;
  const value = a.value;
  if (name === 'href') return /^\s*#[-\w.:]*\s*$/.test(value) ? ['href', value.trim()] : null;
  if (DANGEROUS.test(value) || EXTERNAL_URL.test(value)) return null;
  return [name, value];
}

/**
 * The SVG rewritten from the allowlist, as a UTF-8 XML document. Throws
 * SvgError when there is no `<svg>` root or the file is too large or deep.
 */
export function sanitizeSvg(input: Buffer | string): Buffer {
  const text = (typeof input === 'string' ? input : input.toString('utf8')).replace(/^﻿/, '');
  if (Buffer.byteLength(text) > MAX_SVG_BYTES) throw new SvgError(`SVG is larger than ${MAX_SVG_BYTES} bytes`);
  // Prolog (XML declaration, comments, doctype with its internal subset: entities are never expanded) goes.
  const start = text.search(/<svg[\s>]/i);
  if (start < 0) throw new SvgError('not an SVG file: no <svg> element');
  const fragment = parseFragment(text.slice(start));
  const root = fragment.childNodes.find((n): n is Element => ta.isElementNode(n) && n.tagName === 'svg' && n.namespaceURI === SVG_NS);
  if (!root) throw new SvgError('not an SVG file: no <svg> root element');
  let nodes = 0;
  const write = (n: Node, depth: number): string => {
    if (++nodes > MAX_NODES) throw new SvgError(`SVG has more than ${MAX_NODES} nodes`);
    if (depth > 200) throw new SvgError('SVG is nested too deeply');
    if (ta.isTextNode(n)) return esc(n.value, false);
    if (!ta.isElementNode(n) || n.namespaceURI !== SVG_NS) return '';
    const kids = n.childNodes ?? [];
    // A link is unwrapped: its drawing stays, the link goes.
    if (n.tagName === 'a') return kids.map((c) => write(c, depth + 1)).join('');
    if (!ELEMENTS.has(n.tagName)) return '';
    if (n.tagName === 'style') {
      const css = kids.filter(ta.isTextNode).map((t) => t.value).join('');
      if (DANGEROUS.test(css) || EXTERNAL_URL.test(css)) return '';
      return `<style>${esc(css, false)}</style>`;
    }
    const attrs = n.attrs.map(keepAttribute).filter((x): x is [string, string] => x !== null);
    const head = n === root ? ` xmlns="${SVG_NS}"` : '';
    const body = kids.map((c) => write(c, depth + 1)).join('');
    return `<${n.tagName}${head}${attrs.map(([k, v]) => ` ${k}="${esc(v, true)}"`).join('')}>${body}</${n.tagName}>`;
  };
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${write(root, 0)}\n`, 'utf8');
}

/** Intrinsic size of a (sanitized) SVG: width/height in px when given, else the viewBox, else 300 x 150 like a browser. */
export function svgSize(input: Buffer | string): { width: number; height: number } {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  const attr = (n: string) => new RegExp(`\\s${n}="([^"]*)"`).exec(tag)?.[1];
  const px = (v: string | undefined) => {
    // Trimmed first, so the pattern has one whitespace run (no polynomial backtracking).
    const m = v ? /^([\d.]+)\s*(?:px)?$/.exec(v.trim()) : null;
    return m ? Number(m[1]) : NaN;
  };
  const vb = (attr('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const vbw = vb.length === 4 && vb[2]! > 0 ? vb[2]! : NaN;
  const vbh = vb.length === 4 && vb[3]! > 0 ? vb[3]! : NaN;
  let w = px(attr('width'));
  let h = px(attr('height'));
  if (!(w > 0) && !(h > 0)) {
    w = vbw;
    h = vbh;
  } else if (!(w > 0)) w = vbw > 0 ? (h * vbw) / vbh : 300;
  else if (!(h > 0)) h = vbh > 0 ? (w * vbh) / vbw : 150;
  return w > 0 && h > 0 ? { width: w, height: h } : { width: 300, height: 150 };
}
