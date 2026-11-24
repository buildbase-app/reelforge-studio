/**
 * A few DOM helpers instead of a framework. Text always goes in as text nodes
 * (never innerHTML), and no element ever gets a `style` attribute, so the
 * strict Content-Security-Policy (no inline styles or scripts) holds.
 */
export type Child = Node | string | number | null | undefined | false | Child[];
type Handler = (e: Event) => void;
export type Attrs = Record<string, string | number | boolean | null | undefined | Handler>;

function apply(el: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style') throw new Error('inline styles are not allowed (CSP)');
    if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
export function s(tag: string, attrs?: Attrs | null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG, tag) as SVGElement;
  apply(el, attrs);
  append(el, children);
  return el;
}

/** Replace an element's children. */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** The ReelForge mark: a 9:16 reel frame with the tally light (docs/brand/reelforge-mark.svg). */
export function mark(size = 20): SVGElement {
  return s(
    'svg',
    { viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true', class: 'mark', focusable: 'false' },
    s('rect', { x: '8.25', y: '2.25', width: '15.5', height: '27.5', rx: '4', 'stroke-width': '2.5', class: 'mark-frame' }),
    s('circle', { cx: '16', cy: '16', r: '4.25', class: 'mark-dot' })
  );
}

/** A status dot plus its word: the running dot is the mark's tally light. */
export function status(st: string, text?: string): HTMLElement {
  const label = text ?? STATUS_LABEL[st] ?? st;
  return h('span', { class: `status status-${st}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), label);
}

export const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** A message box: role alert for errors, status for notes. */
export function notice(text: string, kind: 'error' | 'note' = 'note'): HTMLElement {
  return h('p', { class: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
}

/** A table that may scroll sideways: a labelled region that keyboard users can focus and scroll. */
export function tableWrap(label: string, table: HTMLTableElement): HTMLElement {
  return h('div', { class: 'table-wrap', role: 'region', 'aria-label': label, tabindex: '0' }, table);
}
