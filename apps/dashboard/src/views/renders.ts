import { HttpError, type Job } from '../api';
import { fill, h, notice, tableWrap } from '../dom';
import { ago, between, dateTime } from '../format';
import type { View } from '../main';

/** Which finished outputs the page lists (GET /v1/jobs?status=succeeded&type=...). */
export type RendersKind = 'render' | 'preview';

/** The list query for one page of finished renders or previews. */
export function rendersQuery(kind: RendersKind, cursor?: string): string {
  const q = new URLSearchParams({ status: 'succeeded', type: kind, limit: '50' });
  if (cursor) q.set('cursor', cursor);
  return `/v1/jobs?${q}`;
}

/** The output a job produced, when it names one (renders made before #182 may not). */
export function renderIdOf(j: Pick<Job, 'result'>): string | null {
  const id = j.result?.renderId;
  return typeof id === 'string' && /^[\w-]+$/.test(id) ? id : null;
}

let kept: RendersKind = 'render';

/**
 * #/renders: every finished render (or preview) of the workspace across all its projects, newest first, in
 * keyset pages (#292): its output (opens the render page with player, checks and downloads), project, when it
 * finished, how long it took and the variant. Read scope.
 */
export const rendersView: View = (ctx, main) => {
  const ac = new AbortController();
  const msg = h('div', { 'aria-live': 'polite' });
  const summary = h('p', { class: 'meta' }, 'Loading');
  const tbody = h('tbody');
  const more = h('div');
  const picker = h(
    'div',
    { class: 'segs', role: 'group', 'aria-label': 'Show' },
    ...(['render', 'preview'] as const).map((k) =>
      h('button', { type: 'button', class: 'seg', 'aria-pressed': String(k === kept), onclick: () => switchTo(k) }, k === 'render' ? 'Renders' : 'Previews')
    )
  );
  const table = h(
    'table',
    { class: 'table stack' },
    h('thead', null, h('tr', null, ...['Output', 'Project', 'Variant', 'Finished', 'Took'].map((t) => h('th', { scope: 'col' }, t)))),
    tbody
  );
  fill(main, h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, 'Renders'), picker), msg, summary, tableWrap('Finished renders', table), more);

  let rows: Job[] = [];
  let generation = 0;
  const show = () => {
    const now = Date.now();
    fill(summary, rows.length ? `${rows.length} finished ${kept === 'render' ? 'renders' : 'previews'} shown, newest first` : `No finished ${kept === 'render' ? 'renders' : 'previews'} yet.`);
    fill(
      tbody,
      rows.map((j) => {
        const rid = renderIdOf(j);
        const variant = typeof j.params.variant === 'string' ? j.params.variant : '–';
        return h(
          'tr',
          null,
          h('td', null, rid ? h('a', { href: `#/renders/${rid}`, class: 'mono' }, rid) : h('span', { class: 'mono' }, j.id)),
          h('td', { 'data-label': 'Project' }, j.projectId ? h('a', { href: `#/library/${j.projectId}` }, j.projectId) : '–'),
          h('td', { 'data-label': 'Variant' }, variant),
          h('td', { title: dateTime(j.finishedAt), 'data-label': 'Finished' }, ago(j.finishedAt, now)),
          h('td', { class: 'num', 'data-label': 'Took' }, between(j.startedAt, j.finishedAt, now))
        );
      })
    );
  };

  const load = async (cursor?: string) => {
    const mine = generation;
    const page = await ctx.api.get<{ jobs: Job[]; nextCursor: string | null }>(rendersQuery(kept, cursor), ac.signal);
    if (mine !== generation) return;
    rows.push(...page.jobs);
    show();
    fill(more, page.nextCursor ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => void load(page.nextCursor!).catch(fail) }, 'Show more') : null);
  };
  const fail = (e: unknown) => {
    if (ac.signal.aborted || ctx.authLost(e)) return;
    fill(msg, notice(e instanceof HttpError ? e.message : 'Could not load the renders.', 'error'));
  };
  const switchTo = (k: RendersKind) => {
    if (k === kept && rows.length) return;
    kept = k;
    generation++;
    rows = [];
    for (const b of picker.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.textContent === (k === 'render' ? 'Renders' : 'Previews')));
    fill(summary, 'Loading');
    fill(tbody);
    fill(more);
    void load().catch(fail);
  };
  void load().catch(fail);
  return () => ac.abort();
};
