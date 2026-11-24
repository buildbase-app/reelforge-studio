import type { AnalyticsSummary } from '../api';
import { columnChart, legend, rangeBar, thinBar, type Series } from '../chart';
import { fill, h, notice, tableWrap } from '../dom';
import { ago, bucketLabel, bucketTitle, bytes, clock, count, dateTime, duration, ms, rate } from '../format';
import type { View } from '../main';

type Preset = '24h' | '7d' | '30d' | '90d';
const PRESETS: Array<[Preset, string]> = [
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
];
/** The chosen range survives leaving the page (memory only). */
let chosen: { preset: Preset } | { from: string; to: string } = { preset: '30d' };

const SERIES: Series[] = [
  { name: 'Succeeded', cls: 'm-ok' },
  { name: 'Failed', cls: 'm-fail' },
  { name: 'Cancelled', cls: 'm-cancel' },
  { name: 'Queued or running', cls: 'm-open' },
];

const isoDate = (t: number) => new Date(t).toISOString().slice(0, 10);

function query(): string {
  if ('from' in chosen) return `from=${chosen.from}&to=${chosen.to}`;
  if (chosen.preset === '24h') return 'bucket=hour';
  const days = chosen.preset === '7d' ? 7 : chosen.preset === '90d' ? 90 : 30;
  return `from=${isoDate(Date.now() - (days - 1) * 86_400_000)}`;
}

function stat(label: string, value: string, sub: string): HTMLElement {
  return h('div', { class: 'stat' }, h('dt', null, label), h('dd', { class: 'stat-value' }, value), h('dd', { class: 'sub' }, sub));
}

/** #/analytics: renders over time, rates, render and queue times, minutes, storage, errors and webhook health. */
export const analyticsView: View = (ctx, main) => {
  const ac = new AbortController();
  let resize: ResizeObserver | undefined;
  const updated = h('span', { class: 'meta' }, 'Loading');
  const body = h('div', { class: 'analytics', 'aria-live': 'polite', 'aria-busy': 'true' });
  const presetButtons = PRESETS.map(([p, label]) =>
    h('button', { type: 'button', class: 'seg', 'aria-pressed': String('preset' in chosen && chosen.preset === p), onclick: () => ((chosen = { preset: p }), void load()) }, label)
  );
  const today = isoDate(Date.now());
  const from = h('input', { type: 'date', id: 'an-from', max: today, value: 'from' in chosen ? chosen.from : isoDate(Date.now() - 29 * 86_400_000) });
  const to = h('input', { type: 'date', id: 'an-to', max: today, value: 'from' in chosen ? chosen.to : today });
  const formMsg = h('div');
  const form = h(
    'form',
    {
      class: 'filters',
      'aria-label': 'Time range',
      onsubmit: (e) => {
        e.preventDefault();
        if (!from.value || !to.value) return;
        chosen = { from: from.value, to: to.value };
        void load();
      },
    },
    h('div', { class: 'segs', role: 'group', 'aria-label': 'Last' }, presetButtons),
    h('div', { class: 'field-inline' }, h('label', { for: 'an-from' }, 'From'), from),
    h('div', { class: 'field-inline' }, h('label', { for: 'an-to' }, 'To'), to),
    h('button', { type: 'submit', class: 'btn' }, 'Apply')
  );
  fill(main, h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, 'Analytics'), updated), form, formMsg, body);

  const draw = (a: AnalyticsSummary) => {
    resize?.disconnect();
    const { totals: t, range } = a;
    const unit = range.bucket === 'day' ? 'day' : 'hour';
    const storage = 'error' in a.storage ? stat('Storage used', '–', `Not measured: ${a.storage.error}`) : stat('Storage used', bytes(a.storage.totalBytes), `${count(a.storage.renders.count)} renders · ${bytes(a.storage.assets.bytes)} of assets`);
    const stats = h(
      'dl',
      { class: 'stats stats-6' },
      stat('Renders', count(t.jobs), `${count(t.succeeded)} succeeded · ${count(t.failed)} failed${t.cancelled ? ` · ${count(t.cancelled)} cancelled` : ''}`),
      stat('Success rate', rate(t.successRate), `Failure rate ${rate(t.failureRate)}, cancelled jobs left out`),
      stat('Render time, p50', ms(a.renderTime.p50Ms), `p95 ${ms(a.renderTime.p95Ms)} · ${count(a.renderTime.samples)} renders`),
      stat('Queue wait, p50', ms(a.queueWait.p50Ms), `p95 ${ms(a.queueWait.p95Ms)} · ${count(a.queueWait.samples)} jobs`),
      stat('Minutes rendered', a.minutesRendered.total < 60 ? `${a.minutesRendered.total.toFixed(1)} min` : duration(a.minutesRendered.total * 60_000), `${a.minutesRendered.renders.toFixed(1)} min of renders, ${a.minutesRendered.previews.toFixed(1)} of previews`),
      storage
    );

    // The one chart of the page: jobs per bucket by outcome.
    const columns = a.series.map((p) => ({ label: bucketLabel(p.start, range.bucket), title: bucketTitle(p.start, range.bucket), values: [p.succeeded, p.failed, p.cancelled, p.unfinished] }));
    const chartBox = h('div', { class: 'chart-box' });
    const chartLabel = `Render and preview jobs per ${unit}, ${bucketTitle(a.series[0]?.start ?? range.from, range.bucket)} to ${bucketTitle(a.series.at(-1)?.start ?? range.to, range.bucket)}: ${count(t.jobs)} jobs, ${count(t.succeeded)} succeeded, ${count(t.failed)} failed. Use the arrow keys for each ${unit}; the table below has every value.`;
    let lastWidth = 0;
    const redraw = () => {
      const w = chartBox.clientWidth;
      if (!w || Math.abs(w - lastWidth) < 2) return;
      lastWidth = w;
      fill(chartBox, columnChart({ width: w, height: 240, columns, series: SERIES, label: chartLabel }));
    };
    const keys = legend(SERIES);
    const table = tableWrap(
      `Jobs per ${unit}`,
      h(
        'table',
        { class: 'table nowrap' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, range.bucket === 'day' ? 'Day (UTC)' : 'Hour (UTC)'), ...['Jobs', 'Succeeded', 'Failed', 'Cancelled', 'Queued or running', 'Success rate'].map((c) => h('th', { scope: 'col', class: 'num' }, c)))),
        h(
          'tbody',
          null,
          [...a.series].reverse().map((p) =>
            h(
              'tr',
              null,
              h('th', { scope: 'row' }, bucketTitle(p.start, range.bucket)),
              ...[p.jobs, p.succeeded, p.failed, p.cancelled, p.unfinished].map((v) => h('td', { class: 'num' }, count(v))),
              h('td', { class: 'num' }, rate(p.succeeded + p.failed ? p.succeeded / (p.succeeded + p.failed) : null))
            )
          )
        )
      )
    );
    const chartPanel = h(
      'section',
      { class: 'panel chart-panel', 'aria-labelledby': 'per-day-h' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { id: 'per-day-h' }, `Renders per ${unit}`),
        h('ul', { class: 'legend', 'aria-label': 'Legend' }, SERIES.map((se, i) => h('li', null, keys[i]!, se.name)))
      ),
      chartBox,
      h('details', { class: 'numbers' }, h('summary', null, 'Show the numbers'), table)
    );

    // Render time per engine: p50 in ink over the p95 range.
    const maxP95 = Math.max(0, ...a.engines.byEngine.map((e) => e.p95Ms ?? 0));
    const engines = h(
      'section',
      { class: 'panel', 'aria-labelledby': 'engines-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'engines-h' }, 'Scene render time by engine'), a.engines.byEngine.length ? h('ul', { class: 'legend', 'aria-label': 'Legend' }, h('li', null, legend([{ name: 'p50', cls: 'm-p50' }])[0]!, 'p50'), h('li', null, legend([{ name: 'p95', cls: 'm-p95' }])[0]!, 'p95')) : null),
      a.engines.byEngine.length
        ? h(
            'ul',
            { class: 'bars' },
            a.engines.byEngine.map((e) =>
              h(
                'li',
                null,
                h('div', { class: 'bar-head' }, h('span', { class: 'bar-name' }, e.engine), h('span', { class: 'num' }, `p50 ${ms(e.p50Ms)} · p95 ${ms(e.p95Ms)}`)),
                rangeBar(e.p50Ms ?? 0, e.p95Ms ?? 0, maxP95),
                h('span', { class: 'sub' }, `${count(e.scenes)} scenes · ${duration(e.totalMs)} in total`)
              )
            )
          )
        : h('p', { class: 'empty' }, 'No successful renders with scene timings in this range.'),
      a.engines.renders ? h('p', { class: 'help' }, `From the manifests of ${count(a.engines.sampled)} of ${count(a.engines.renders)} successful renders, the newest first.`) : null
    );

    const topCount = a.errors[0]?.count ?? 0;
    const errors = h(
      'section',
      { class: 'panel', 'aria-labelledby': 'errors-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'errors-h' }, 'Top error codes')),
      a.errors.length
        ? h(
            'ol',
            { class: 'bars' },
            a.errors.map((e) =>
              h(
                'li',
                null,
                h('div', { class: 'bar-head' }, h('code', { class: 'bar-name' }, e.code), h('span', { class: 'num' }, `${count(e.count)} ${e.count === 1 ? 'job' : 'jobs'}`)),
                thinBar([{ value: e.count, cls: 'm-fail' }], topCount),
                h('span', { class: 'sub' }, `Last ${ago(e.lastAt)}${e.stage ? ` at ${e.stage}` : ''}: ${e.message}`)
              )
            )
          )
        : h('p', { class: 'empty' }, 'No failed jobs in this range.')
    );

    const wh = a.webhooks;
    const webhooks = h(
      'section',
      { class: 'panel', 'aria-labelledby': 'wh-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'wh-h' }, 'Webhook deliveries'), wh.endpoints.length ? h('span', { class: 'meta' }, `Success rate ${rate(wh.totals.successRate)}`) : null),
      wh.endpoints.length
        ? tableWrap(
            'Deliveries per endpoint',
            h(
              'table',
              { class: 'table' },
              h(
                'thead',
                null,
                h('tr', null, h('th', { scope: 'col' }, 'Endpoint'), h('th', { scope: 'col', class: 'col-bar wide' }, 'Outcome'), ...['Delivered', 'Failed', 'Waiting', 'Success rate'].map((c) => h('th', { scope: 'col', class: c === 'Waiting' ? 'num wide' : 'num' }, c)))
              ),
              h(
                'tbody',
                null,
                wh.endpoints.map((e) => {
                  const waiting = e.counts.pending + e.counts.delivering;
                  const all = e.counts.succeeded + e.counts.dead + waiting;
                  return h(
                    'tr',
                    null,
                    h('td', null, h('a', { href: `#/settings/webhooks/${e.id}` }, e.name), h('span', { class: 'sub' }, `${e.type}${e.enabled ? '' : ' · disabled'}`)),
                    h('td', { class: 'col-bar wide' }, thinBar([{ value: e.counts.succeeded, cls: 'm-ok' }, { value: e.counts.dead, cls: 'm-fail' }, { value: waiting, cls: 'm-open' }], all)),
                    h('td', { class: 'num' }, count(e.counts.succeeded)),
                    h('td', { class: 'num' }, count(e.counts.dead)),
                    h('td', { class: 'num wide' }, count(waiting)),
                    h('td', { class: 'num' }, rate(e.successRate))
                  );
                })
              )
            )
          )
        : h('p', { class: 'empty' }, 'No webhooks are set up.'),
      wh.endpoints.length ? h('p', { class: 'help' }, 'Every delivery still in the delivery log, not only this range. Failed: given up after the last retry.') : null
    );

    fill(
      body,
      a.scan.truncated ? notice(`This range has more jobs than one summary reads (${count(a.scan.limit)}). The figures cover ${dateTime(a.scan.coveredFrom)} onwards; choose a shorter range for all of it.`) : null,
      h('section', { 'aria-label': 'Totals' }, stats),
      chartPanel,
      h('div', { class: 'grid-2' }, engines, errors),
      webhooks
    );
    body.setAttribute('aria-busy', 'false');
    redraw();
    resize = new ResizeObserver(() => redraw());
    resize.observe(chartBox);
    fill(updated, `${bucketTitle(range.from, 'day')} to ${bucketTitle(new Date(Date.parse(range.to) - 1).toISOString(), 'day')} · updated ${clock(new Date(a.generatedAt))}`);
  };

  const load = async () => {
    presetButtons.forEach((b, i) => b.setAttribute('aria-pressed', String('preset' in chosen && chosen.preset === PRESETS[i]![0])));
    body.setAttribute('aria-busy', 'true');
    fill(formMsg);
    try {
      draw(await ctx.api.get<AnalyticsSummary>(`/v1/analytics/summary?${query()}`, ac.signal));
    } catch (e) {
      if (ac.signal.aborted || ctx.authLost(e)) return;
      body.setAttribute('aria-busy', 'false');
      fill(formMsg, notice(`Could not load analytics: ${(e as Error).message}`, 'error'));
    }
  };
  void load();

  return () => {
    ac.abort();
    resize?.disconnect();
  };
};
