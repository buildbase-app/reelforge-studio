/**
 * Inline SVG charts (no library): a stacked column chart and thin bars. Every
 * position is an SVG attribute, never a style, so the strict CSP holds. Marks
 * follow the dataviz rules: columns at most 24 px wide, 4 px rounded tops,
 * square at the baseline, a 2 px surface gap between segments, hairline solid
 * grid, muted tabular tick labels, one tooltip on hover and keyboard focus.
 * Every chart has a table next to it (the view adds it), so no value lives in
 * the chart alone.
 */
import { s } from './dom';

export interface Series {
  name: string;
  /** CSS class of the marks and the legend key (colour comes from the stylesheet). */
  cls: string;
}

export interface Column {
  /** Short axis label ("24 Nov"). */
  label: string;
  /** Tooltip heading ("Tue 24 Nov 2026"). */
  title: string;
  /** One value per series, bottom to top. */
  values: number[];
}

/** Round tick values: 0 and 3 to 5 steps of 1, 2 or 5 × 10^n up to at least `max`. */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((st) => st >= raw) ?? 10 * pow;
  const unit = Math.max(1, step); // counts: whole numbers only
  const ticks: number[] = [];
  for (let v = 0; v < max + unit; v += unit) {
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

/** 1,234 -> "1.2K" on an axis that reaches 10 000; full numbers below. */
export function tickText(v: number, max: number): string {
  if (max >= 10_000) return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(v % 1_000_000 ? 1 : 0)}M` : `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K`;
  return v.toLocaleString('en-GB');
}

/** Which axis labels to show: every k-th so that at most `max` fit. */
export function labelEvery(n: number, max: number): number {
  return Math.max(1, Math.ceil(n / Math.max(1, max)));
}

/** A path for a column segment: rounded top corners (radius r) when `top`, square otherwise. */
function segmentPath(x: number, y: number, w: number, h: number, top: boolean): string {
  const r = top ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h}Z`;
}

/**
 * A stacked column chart `width` px wide. Hover or arrow keys (when focused)
 * show one column's values in a tooltip drawn inside the SVG.
 */
export function columnChart(opts: { width: number; height?: number; columns: Column[]; series: Series[]; label: string }): SVGElement {
  const { columns, series } = opts;
  const width = Math.max(240, Math.floor(opts.width));
  const height = opts.height ?? 240;
  const m = { top: 12, right: 8, bottom: 28, left: 40 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  const totals = columns.map((c) => c.values.reduce((a, b) => a + b, 0));
  const ticks = niceTicks(Math.max(...totals, 0));
  const top = ticks[ticks.length - 1]!;
  const y = (v: number) => m.top + ph - (v / top) * ph;
  const band = pw / Math.max(1, columns.length);
  const barW = Math.max(2, Math.min(24, band * 0.64));
  const every = labelEvery(columns.length, Math.floor(pw / 56));

  const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img', 'aria-label': opts.label, tabindex: '0' });
  const grid = s('g', { class: 'grid', 'aria-hidden': 'true' });
  for (const t of ticks) {
    const ty = Math.round(y(t)) + 0.5;
    grid.append(s('line', { x1: m.left, x2: width - m.right, y1: ty, y2: ty }), s('text', { x: m.left - 8, y: ty + 4, class: 'tick', 'text-anchor': 'end' }, tickText(t, top)));
  }
  const hover = s('rect', { class: 'hover-band', x: 0, y: m.top, width: band, height: ph, rx: 4, visibility: 'hidden' });
  const marks = s('g', { 'aria-hidden': 'true' });
  const labels = s('g', { class: 'grid', 'aria-hidden': 'true' });
  columns.forEach((c, i) => {
    const x = m.left + i * band + (band - barW) / 2;
    let acc = 0;
    const lastNonZero = c.values.reduce((last, v, k) => (v > 0 ? k : last), -1);
    c.values.forEach((v, k) => {
      if (v <= 0) return;
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      // 2 px surface gap above every segment but the top one.
      const gap = k === lastNonZero ? 0 : 2;
      const h = Math.max(1, y0 - y1 - gap);
      marks.append(s('path', { d: segmentPath(x, y1 + gap, barW, h, k === lastNonZero), class: `mark ${series[k]!.cls}` }));
    });
    if (i % every === 0) labels.append(s('text', { x: m.left + i * band + band / 2, y: height - 8, class: 'tick', 'text-anchor': 'middle' }, c.label));
  });
  const base = Math.round(y(0)) + 0.5;
  const axis = s('line', { class: 'axis', x1: m.left, x2: width - m.right, y1: base, y2: base, 'aria-hidden': 'true' });

  // Tooltip: a box and lines of text, positioned with a transform attribute.
  const tip = s('g', { class: 'tip', visibility: 'hidden', 'aria-hidden': 'true' });
  const tipBox = s('rect', { class: 'tip-box', rx: 8, x: 0, y: 0 });
  const tipText = s('text', { class: 'tip-text', x: 12, y: 0 });
  tip.append(tipBox, tipText);
  svg.append(grid, hover, marks, axis, labels, tip);

  let shown = -1;
  const show = (i: number) => {
    if (i < 0 || i >= columns.length) return hide();
    shown = i;
    const c = columns[i]!;
    hover.setAttribute('x', String(m.left + i * band));
    hover.setAttribute('visibility', 'visible');
    const lines = [c.title, `${totals[i]!.toLocaleString('en-GB')} total`, ...series.map((se, k) => `${se.name} ${c.values[k]!.toLocaleString('en-GB')}`)];
    tipText.replaceChildren(...lines.map((l, k) => s('tspan', { x: 12, dy: k === 0 ? 20 : 18, class: k === 0 ? 'tip-title' : null }, l)));
    const w = Math.max(...lines.map((l) => l.length)) * 7 + 24;
    const h = lines.length * 18 + 14;
    tipBox.setAttribute('width', String(w));
    tipBox.setAttribute('height', String(h));
    const cx = m.left + i * band + band / 2;
    const tx = cx + 12 + w > width ? Math.max(0, cx - 12 - w) : cx + 12;
    tip.setAttribute('transform', `translate(${Math.round(tx)},${m.top})`);
    tip.setAttribute('visibility', 'visible');
  };
  const hide = () => {
    shown = -1;
    hover.setAttribute('visibility', 'hidden');
    tip.setAttribute('visibility', 'hidden');
  };
  const at = (clientX: number) => {
    const r = svg.getBoundingClientRect();
    return Math.floor(((clientX - r.left) * (width / r.width) - m.left) / band);
  };
  svg.addEventListener('pointermove', (e) => show(at((e as PointerEvent).clientX)));
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('focus', () => show(shown >= 0 ? shown : columns.length - 1));
  svg.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') {
      e.preventDefault();
      const cur = shown >= 0 ? shown : columns.length - 1;
      show(k === 'Home' ? 0 : k === 'End' ? columns.length - 1 : Math.min(columns.length - 1, Math.max(0, cur + (k === 'ArrowLeft' ? -1 : 1))));
    } else if (k === 'Escape') hide();
  });
  return svg;
}

/** Legend: a small key mark beside each series name (the text keeps the text colour). */
export function legend(series: Series[]): SVGElement[] {
  return series.map((se) => s('svg', { width: 10, height: 10, viewBox: '0 0 10 10', class: 'key', 'aria-hidden': 'true' }, s('rect', { width: 10, height: 10, rx: 2, class: `mark ${se.cls}` })));
}

/**
 * A thin horizontal bar (8 px, rounded ends) in percent of the row: `parts`
 * are consecutive segments with a 2 px gap, each with its class. Widths are
 * SVG percentages, so it scales with its container without a style.
 */
export function thinBar(parts: Array<{ value: number; cls: string }>, max: number, label?: string): SVGElement {
  const svg = s('svg', { class: 'thin', width: '100%', height: 8, 'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label ?? null });
  svg.append(s('rect', { class: 'track', x: 0, y: 0, width: '100%', height: 8, rx: 4 }));
  let at = 0;
  const gaps: SVGElement[] = [];
  parts
    .filter((p) => p.value > 0)
    .forEach((p, i) => {
      const w = max > 0 ? (p.value / max) * 100 : 0;
      svg.append(s('rect', { class: `mark ${p.cls}`, x: `${at}%`, y: 0, width: `${w}%`, height: 8, rx: 4 }));
      // A 2 px surface gap centred on the joint.
      if (i > 0) gaps.push(s('rect', { class: 'gap', x: `${at}%`, y: 0, width: 2, height: 8, transform: 'translate(-1,0)' }));
      at += w;
    });
  svg.append(...gaps);
  return svg;
}

/**
 * A range bar for percentiles: a light bar to p95 with the p50 part in ink on
 * top, both scaled to `max`.
 */
export function rangeBar(p50: number, p95: number, max: number): SVGElement {
  const pct = (v: number) => `${max > 0 ? Math.min(100, (v / max) * 100) : 0}%`;
  return s(
    'svg',
    { class: 'thin', width: '100%', height: 8, 'aria-hidden': 'true' },
    s('rect', { class: 'track', x: 0, y: 0, width: '100%', height: 8, rx: 4 }),
    s('rect', { class: 'mark m-p95', x: 0, y: 0, width: pct(p95), height: 8, rx: 4 }),
    s('rect', { class: 'mark m-p50', x: 0, y: 0, width: pct(p50), height: 8, rx: 4 })
  );
}
