import { HttpError, type AuditEntry } from '../api';
import { fill, h, notice, status, tableWrap } from '../dom';
import { dateTime } from '../format';
import type { View } from '../main';

const RESULT: Record<AuditEntry['result'], [string, string]> = {
  success: ['succeeded', 'Success'],
  failure: ['failed', 'Failure'],
  denied: ['cancelled', 'Denied'],
};

/** The filters kept while the tab is open (memory only). */
let kept = { action: '', result: '', actor: '', from: '', to: '' };

/** The query of the filters: an action is a prefix ("key." -> "key.*"), times are local and sent as ISO. */
export function auditQuery(f: typeof kept): URLSearchParams {
  const q = new URLSearchParams();
  const action = f.action.trim();
  if (action) q.set('action', action.includes('*') ? action : `${action}*`);
  if (f.result) q.set('result', f.result);
  if (f.actor.trim()) q.set('actorId', f.actor.trim());
  for (const k of ['from', 'to'] as const) {
    const t = f[k] ? Date.parse(f[k]) : NaN;
    if (Number.isFinite(t)) q.set(k, new Date(t).toISOString());
  }
  return q;
}

/** #/audit: the audit log, filtered, newest first, with keyset pages and CSV / JSONL exports (admin). */
export const auditView: View = (ctx, main) => {
  const ac = new AbortController();
  const msg = h('div', { 'aria-live': 'polite' });
  const body = h('div');
  fill(main, h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, 'Audit log')), msg, body);
  if (!ctx.can('admin')) {
    fill(body, notice('The audit log needs a key with the admin scope.'));
    return () => ac.abort();
  }

  const input = (id: string, label: string, attrs: Record<string, string>) => {
    const el = h('input', { id, autocomplete: 'off', spellcheck: 'false', ...attrs });
    return { el, field: h('div', { class: 'field' }, h('label', { for: id }, label), el) };
  };
  const action = input('au-action', 'Action starts with', { placeholder: 'key., config.update', value: kept.action });
  const actor = input('au-actor', 'Actor key id', { placeholder: 'key_…', value: kept.actor });
  const from = input('au-from', 'From', { type: 'datetime-local', value: kept.from });
  const to = input('au-to', 'To', { type: 'datetime-local', value: kept.to });
  const result = h('select', { id: 'au-result' }, ['', 'success', 'failure', 'denied'].map((r) => h('option', { value: r, selected: r === kept.result }, r ? RESULT[r as AuditEntry['result']][1] : 'Any')));
  const rows = h('tbody');
  const more = h('div', { class: 'actions' });
  const counted = h('p', { class: 'meta' });
  let shown = 0;

  const read = () => (kept = { action: action.el.value, result: result.value, actor: actor.el.value, from: from.el.value, to: to.el.value });

  const row = (e: AuditEntry) => {
    const [st, label] = RESULT[e.result];
    return h(
      'tr',
      null,
      h('td', { class: 'nowrap' }, dateTime(e.at)),
      h('td', null, e.actorName ?? e.actorType, h('span', { class: 'sub mono' }, e.actorId ?? e.actorType)),
      h('td', null, h('code', null, e.action)),
      h('td', { class: 'wide' }, e.targetType ? `${e.targetType} ` : '', e.targetId ? h('span', { class: 'mono break' }, e.targetId) : e.targetType ? '' : '–'),
      h('td', null, status(st, label)),
      h('td', { class: 'wide mono' }, e.ip ?? '–')
    );
  };

  const page = async (cursor?: string) => {
    const q = auditQuery(kept);
    q.set('limit', '50');
    if (cursor) q.set('cursor', cursor);
    const r = await ctx.api.get<{ events: AuditEntry[]; nextCursor: string | null; retentionDays: number }>(`/v1/audit?${q}`, ac.signal);
    rows.append(...r.events.map(row));
    shown += r.events.length;
    fill(counted, shown ? `${shown} ${shown === 1 ? 'entry' : 'entries'} shown, newest first. Entries are kept ${r.retentionDays} days.` : 'No entries match these filters.');
    fill(more, r.nextCursor ? h('button', { type: 'button', class: 'btn', onclick: () => void page(r.nextCursor!).catch(fail) }, 'Show older entries') : null);
  };
  const fail = (e: unknown) => {
    if (ac.signal.aborted || ctx.authLost(e)) return;
    fill(msg, notice(e instanceof HttpError && e.status === 400 ? e.message : `Could not load the audit log: ${(e as Error).message}`, 'error'));
  };
  const load = () => {
    fill(msg);
    rows.replaceChildren();
    shown = 0;
    void page().catch(fail);
  };
  const exportAs = (format: 'csv' | 'jsonl') => {
    const q = auditQuery(read());
    q.set('format', format);
    fill(msg);
    ctx.api.download(`/v1/audit?${q}`, `reelforge-audit.${format}`).catch(fail);
  };

  fill(
    body,
    h(
      'form',
      {
        class: 'filters panel audit-filters',
        'aria-label': 'Filter the audit log',
        onsubmit: (e) => {
          e.preventDefault();
          read();
          load();
        },
      },
      action.field,
      h('div', { class: 'field' }, h('label', { for: 'au-result' }, 'Result'), result),
      actor.field,
      from.field,
      to.field,
      h(
        'div',
        { class: 'actions filter-actions' },
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Apply'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => exportAs('csv') }, 'Export CSV'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => exportAs('jsonl') }, 'Export JSONL')
      )
    ),
    counted,
    tableWrap(
      'Audit log',
      h(
        'table',
        { class: 'table panel-table stack' },
        h('thead', null, h('tr', null, ...['Time', 'Actor', 'Action', 'Target', 'Result', 'IP'].map((c, i) => h('th', { scope: 'col', class: i === 3 || i === 5 ? 'wide' : null }, c)))),
        rows
      )
    ),
    more,
    h('p', { class: 'help' }, 'Exports follow the filters and hold up to 100 000 entries. They are downloaded with this key, never through a link that carries it.')
  );
  load();
  return () => ac.abort();
};
