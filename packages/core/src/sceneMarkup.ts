import { defaultTreeAdapter as ta, parse, parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';

/**
 * Scene markup handling for the engines that render agent-supplied HTML
 * (html, hyperframes; D-085). Agent markup is parsed with parse5, the
 * WHATWG HTML parser (the same tree a browser builds, scripting enabled), never
 * spliced with regular expressions:
 *
 *   - elements that change the page's own policy are refused:
 *     `<meta http-equiv>` (Content-Security-Policy, refresh, ...) and `<base>`,
 *     also inside `<template>` and `iframe srcdoc`;
 *   - comments, `<noscript>`, `<noembed>` and `<noframes>` are dropped, and
 *     attributes with unusual names are removed, so later tools that re-parse
 *     the document with another parser see the same structure;
 *   - RenderWeld's head (charset, CSP, theme) is inserted as the first children
 *     of the parsed `<head>`, and the serialized result is parsed again to
 *     check that the CSP is the first policy element and the only one.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Template = DefaultTreeAdapterMap['template'];

export class SceneMarkupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SceneMarkupError';
  }
}

const DROPPED_ELEMENTS = new Set(['noscript', 'noembed', 'noframes']);
const SAFE_ATTRIBUTE = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;
const MAX_SRCDOC_DEPTH = 3;

function isElement(n: Node): n is Element {
  return ta.isElementNode(n);
}

function children(n: Node): Node[] {
  const out = [...((n as ParentNode).childNodes ?? [])];
  if (isElement(n) && n.tagName === 'template') out.push(...ta.getTemplateContent(n as Template).childNodes);
  return out;
}

function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

/** Problems with policy-changing elements anywhere in a parsed tree (srcdoc documents included). */
function policyProblems(root: Node, where: string, depth = 0): string[] {
  const problems: string[] = [];
  const visit = (n: Node) => {
    if (isElement(n)) {
      if (n.tagName === 'meta' && attr(n, 'http-equiv') !== undefined) {
        problems.push(`${where}: <meta http-equiv="${attr(n, 'http-equiv')}"> is not allowed (the renderer sets the page's policy itself)`);
      }
      if (n.tagName === 'base') problems.push(`${where}: <base> is not allowed`);
      const srcdoc = attr(n, 'srcdoc');
      if (srcdoc !== undefined) {
        if (depth >= MAX_SRCDOC_DEPTH) problems.push(`${where}: iframe srcdoc nested too deeply`);
        else problems.push(...policyProblems(parse(srcdoc), `${where} (iframe srcdoc)`, depth + 1));
      }
    }
    for (const c of children(n)) visit(c);
  };
  visit(root);
  return problems;
}

/** Drop comments and dropped elements, strip unusual attribute names (in place). */
function normalise(n: Node): void {
  const kids = (n as ParentNode).childNodes;
  if (kids) {
    for (const c of [...kids]) {
      if (ta.isCommentNode(c) || (isElement(c) && DROPPED_ELEMENTS.has(c.tagName))) ta.detachNode(c);
      else normalise(c);
    }
  }
  if (isElement(n)) {
    n.attrs = n.attrs.filter((a) => SAFE_ATTRIBUTE.test(a.name) && !a.prefix);
    if (n.tagName === 'template') normalise(ta.getTemplateContent(n as Template));
  }
}

function find(n: Node, pred: (e: Element) => boolean): Element | undefined {
  if (isElement(n) && pred(n)) return n;
  for (const c of children(n)) {
    const f = find(c, pred);
    if (f) return f;
  }
  return undefined;
}

function findAll(n: Node, pred: (e: Element) => boolean, out: Element[] = []): Element[] {
  if (isElement(n) && pred(n)) out.push(n);
  for (const c of children(n)) findAll(c, pred, out);
  return out;
}

/**
 * Check an agent fragment (body content) for policy-changing elements.
 * Throws SceneMarkupError listing every problem.
 */
export function assertSafeSceneFragment(html: string, where = 'scene html'): void {
  const problems = policyProblems(parseFragment(html), where);
  if (problems.length) throw new SceneMarkupError(problems.join('; '));
}

export interface PreparedSceneDocument {
  /** The serialized document to render. */
  html: string;
  /** Elements with `data-composition-id` etc. can be looked up by the caller. */
  findElement(pred: (tag: string, attrs: Record<string, string>) => boolean): Record<string, string> | undefined;
  /** `src` of every `<script>` that has one. */
  scriptSources: string[];
}

/**
 * Parse a full HTML document, refuse policy-changing elements, normalise it
 * and insert `headHtml` (parsed in head context) as the first children of
 * its `<head>`. `policyMeta` is the exact `content` of the CSP meta that
 * `headHtml` carries: the result is re-parsed and must have it as the first
 * `http-equiv` element of the head and the only one in the document.
 */
export function prepareSceneDocument(doc: string, headHtml: string, policyMeta: string, where = 'scene html'): PreparedSceneDocument {
  const document = parse(doc);
  const problems = policyProblems(document, where);
  if (problems.length) throw new SceneMarkupError(problems.join('; '));
  normalise(document);
  const html = find(document, (e) => e.tagName === 'html');
  const head = html && find(html, (e) => e.tagName === 'head');
  if (!html || !head) throw new SceneMarkupError(`${where}: no <head> after parsing`);
  html.attrs = html.attrs.filter((a) => ['lang', 'dir', 'class', 'style'].includes(a.name) || a.name.startsWith('data-'));
  head.attrs = [];
  const inserted = parseFragment(head, headHtml, {}).childNodes;
  const first = head.childNodes[0];
  for (const n of [...inserted]) {
    ta.detachNode(n);
    if (first) ta.insertBefore(head, n, first);
    else ta.appendChild(head, n);
  }
  const out = serialize(document);

  // Verify what a browser will see.
  const check = parse(out);
  const checkHead = find(check, (e) => e.tagName === 'head');
  const policies = findAll(check, (e) => e.tagName === 'meta' && attr(e, 'http-equiv') !== undefined);
  const firstPolicy = checkHead && find(checkHead, (e) => e.tagName === 'meta' && attr(e, 'http-equiv') !== undefined);
  if (policies.length !== 1 || !firstPolicy || firstPolicy !== policies[0] || attr(firstPolicy, 'content') !== policyMeta) {
    throw new SceneMarkupError(`${where}: the document could not be prepared with the renderer's Content-Security-Policy`);
  }
  const elementAttrs = (e: Element) => Object.fromEntries(e.attrs.map((a) => [a.name, a.value]));
  return {
    html: out,
    findElement: (pred) => {
      const e = find(check, (el) => pred(el.tagName, elementAttrs(el)));
      return e ? elementAttrs(e) : undefined;
    },
    scriptSources: findAll(check, (e) => e.tagName === 'script' && attr(e, 'src') !== undefined).map((e) => attr(e, 'src')!),
  };
}
