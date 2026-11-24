import { HttpError, type ConfigEntry, type ConfigReport, type KeyRecord, type Licence, type Provider, type Webhook, type WebhookDelivery, type WebhookLog } from '../api';
import { fill, h, notice, s as svg, status, tableWrap } from '../dom';
import { ago, count, dateTime, groupTitle, latency, rate, scopeText } from '../format';
import type { Ctx, View } from '../main';

type Tab = 'config' | 'keys' | 'webhooks' | 'providers';
const TABS: Array<[Tab, string, string]> = [
  ['config', 'Configuration', '#/settings'],
  ['keys', 'API keys', '#/settings/keys'],
  ['webhooks', 'Webhooks', '#/settings/webhooks'],
  ['providers', 'Providers and licence', '#/settings/providers'],
];

/** The settings page frame: heading, tabs (links with aria-current), and a body for the tab. */
function frame(main: HTMLElement, tab: Tab, heading = 'Settings'): HTMLElement {
  const body = h('div', { class: 'settings-body' });
  fill(
    main,
    h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, heading)),
    h('nav', { class: 'tabs', 'aria-label': 'Settings' }, TABS.map(([t, label, href]) => h('a', { href, 'aria-current': t === tab ? 'page' : null }, label))),
    body
  );
  return body;
}

function failed(ctx: Ctx, el: HTMLElement, what: string, e: unknown, signal: AbortSignal): void {
  if (signal.aborted || ctx.authLost(e)) return;
  fill(el, notice(e instanceof HttpError && e.status === 403 ? `${what} needs another scope: ${e.message}` : `Could not load ${what.toLowerCase()}: ${(e as Error).message}`, 'error'));
}

/** A one-time secret: shown once in a read-only field with a copy button, and a warning. */
function secretBox(label: string, value: string, note: string): HTMLElement {
  const id = `secret-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input', { id, type: 'text', readonly: true, value, class: 'mono secret-value', spellcheck: 'false', autocomplete: 'off' });
  const copied = h('span', { class: 'meta', role: 'status' });
  return h(
    'div',
    { class: 'secret', role: 'region', 'aria-label': label },
    h('label', { for: id }, label),
    h('div', { class: 'secret-row' }, input, h('button', { type: 'button', class: 'btn', onclick: () => void navigator.clipboard?.writeText(value).then(() => fill(copied, 'Copied'), () => (input.select(), fill(copied, 'Select and copy it'))) }, 'Copy')),
    h('p', { class: 'help' }, note, ' ', copied)
  );
}

// ---- configuration ------------------------------------------------------------

const SOURCE_TEXT: Record<string, string> = { default: 'Default', file: 'Config file', env: 'Environment', runtime: 'Set here', database: 'Set here', build: 'Fixed by the image' };

/** Whether the value is shown as typed (mono), rather than a word such as "Not set" or "On". */
function literal(e: ConfigEntry): boolean {
  return !e.secret && e.value !== undefined && e.value !== null && e.value !== '' && typeof e.value !== 'boolean' && !(Array.isArray(e.value) && !e.value.length);
}

/** Descriptions mark names with backticks: those become code. */
function prose(text: string): Array<string | HTMLElement> {
  return text.split('`').map((part, i) => (i % 2 ? h('code', null, part) : part));
}

function valueText(e: ConfigEntry): string {
  if (e.secret) return e.value === 'set' || (e.value !== undefined && e.value !== null && e.value !== 'not set') ? 'Set (hidden)' : 'Not set';
  if (e.value === undefined || e.value === null || e.value === '') return 'Not set';
  if (Array.isArray(e.value)) return e.value.length ? e.value.join(', ') : 'Empty list';
  if (typeof e.value === 'boolean') return e.value ? 'On' : 'Off';
  return String(e.value);
}

function sourceText(e: ConfigEntry): string {
  const base = SOURCE_TEXT[e.source] ?? e.source;
  if (e.source === 'env' && e.origin) return `${base}: ${e.origin}`;
  if (e.source === 'file' && e.origin) return `${base}: ${e.origin}`;
  if (e.updatedAt) return `${base} ${ago(e.updatedAt)}`;
  return base;
}

/** Parse what was typed the way the server will, so mistakes show before update_config. */
export function parseInput(e: Pick<ConfigEntry, 'kind' | 'options' | 'min' | 'max'>, raw: string | boolean): { ok: true; value: unknown } | { ok: false; message: string } {
  if (e.kind === 'boolean') return { ok: true, value: raw === true };
  const text = String(raw).trim();
  if (e.kind === 'integer' || e.kind === 'number') {
    const n = Number(text);
    if (!text || !Number.isFinite(n)) return { ok: false, message: 'Enter a number.' };
    if (e.kind === 'integer' && !Number.isInteger(n)) return { ok: false, message: 'Enter a whole number.' };
    if (e.min !== undefined && n < e.min) return { ok: false, message: `The lowest value is ${e.min}.` };
    if (e.max !== undefined && n > e.max) return { ok: false, message: `The highest value is ${e.max}.` };
    return { ok: true, value: n };
  }
  if (e.kind === 'enum') return e.options?.includes(text) ? { ok: true, value: text } : { ok: false, message: `Choose one of ${e.options?.join(', ')}.` };
  if (e.kind === 'list') return { ok: true, value: text ? text.split(',').map((x) => x.trim()).filter(Boolean) : [] };
  if (!text) return { ok: false, message: 'Enter a value, or use Reset to clear it.' };
  if (e.kind === 'url') {
    try {
      const u = new URL(text);
      if (!/^https?:$/.test(u.protocol)) return { ok: false, message: 'Enter an http or https URL.' };
    } catch {
      return { ok: false, message: 'Enter a full http or https URL, with the scheme.' };
    }
  }
  return { ok: true, value: text };
}

/** #/settings: every setting, grouped, with its source; admins edit runtime settings in place. */
export const configView: View = (ctx, main) => {
  const ac = new AbortController();
  const body = frame(main, 'config');
  fill(body, h('p', { class: 'meta' }, 'Loading'));
  const editable = (e: ConfigEntry) => ctx.can('admin') && e.scope === 'runtime' && !e.locked;

  const row = (entry: ConfigEntry): HTMLElement => {
    let e = entry;
    const li = h('li', { class: 'setting', 'data-key': e.key });
    const id = `cfg-${e.key.replace(/\W/g, '-')}`;
    const show = () => {
      const notes: string[] = [];
      if (e.scope === 'startup') notes.push('Applies at start-up');
      if (e.locked) notes.push('Fixed by the image');
      if (e.placeholder) notes.push(e.placeholder);
      fill(
        li,
        h('div', { class: 'setting-main' }, h('code', { class: 'setting-key', id: `${id}-k` }, e.key), h('p', { class: 'help' }, prose(e.description)), e.error ? h('p', { class: 'field-error' }, e.error) : null),
        h(
          'div',
          { class: 'setting-value' },
          h('span', { class: literal(e) ? 'value mono' : 'value' }, valueText(e)),
          h('span', { class: 'sub' }, [sourceText(e), ...notes].join(' · ')),
          editable(e) ? h('button', { type: 'button', class: 'btn btn-quiet', 'aria-describedby': `${id}-k`, onclick: () => edit() }, 'Edit') : null
        )
      );
    };
    const edit = () => {
      const err = h('p', { class: 'field-error', id: `${id}-err`, role: 'alert' });
      let input: HTMLInputElement | HTMLSelectElement;
      if (e.kind === 'boolean') input = h('input', { id, type: 'checkbox', checked: e.value === true });
      else if (e.kind === 'enum') input = h('select', { id }, (e.options ?? []).map((o) => h('option', { value: o, selected: o === e.value }, o)));
      else
        input = h('input', {
          id,
          type: e.secret ? 'password' : e.kind === 'integer' || e.kind === 'number' ? 'number' : 'text',
          inputmode: e.kind === 'integer' ? 'numeric' : null,
          min: e.min,
          max: e.max,
          step: e.kind === 'number' ? 'any' : null,
          value: e.secret ? '' : Array.isArray(e.value) ? e.value.join(', ') : e.value === undefined || e.value === null ? '' : String(e.value),
          autocomplete: 'off',
          spellcheck: 'false',
          'aria-describedby': `${id}-err ${id}-hint`,
        });
      const hint =
        e.kind === 'list' ? 'Comma-separated.' : e.kind === 'integer' || e.kind === 'number' ? [e.min !== undefined ? `From ${e.min}` : '', e.max !== undefined ? `to ${e.max}` : ''].filter(Boolean).join(' ') : e.secret ? 'Stored encrypted; never shown again.' : '';
      const save = async (value: unknown) => {
        fill(err);
        try {
          await ctx.api.patch('/v1/config', { settings: { [e.key]: value } });
          // Only this row is read again: the filter, open groups and scroll position stay.
          const fresh = await ctx.api.get<ConfigReport>(`/v1/config?prefix=${encodeURIComponent(e.key)}`, ac.signal);
          e = fresh.settings.find((x) => x.key === e.key) ?? e;
          show();
          li.querySelector<HTMLButtonElement>('button')?.focus();
        } catch (x) {
          if (ctx.authLost(x)) return;
          const issues = (x instanceof HttpError ? (x.details?.issues as Array<{ message: string }> | undefined) : undefined) ?? [];
          input.setAttribute('aria-invalid', 'true');
          fill(err, issues.length ? issues.map((i) => i.message).join(' ') : (x as Error).message);
        }
      };
      fill(
        li,
        h(
          'form',
          {
            class: 'setting-edit',
            novalidate: true,
            onsubmit: (ev) => {
              ev.preventDefault();
              const r = parseInput(e, input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value);
              if (!r.ok) {
                input.setAttribute('aria-invalid', 'true');
                fill(err, r.message);
                input.focus();
                return;
              }
              void save(r.value);
            },
          },
          h('div', { class: 'setting-main' }, h('label', { for: id, class: 'setting-key mono' }, e.key), h('p', { class: 'help' }, prose(e.description))),
          h(
            'div',
            { class: 'setting-value' },
            e.kind === 'boolean' ? h('div', { class: 'check' }, input, h('label', { for: id }, 'On')) : input,
            hint ? h('span', { class: 'sub', id: `${id}-hint` }, hint) : null,
            err,
            h(
              'div',
              { class: 'actions' },
              h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save'),
              h('button', { type: 'button', class: 'btn', onclick: () => (show(), li.querySelector<HTMLButtonElement>('button')?.focus()) }, 'Cancel'),
              e.source === 'runtime' ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => void save(null) }, 'Reset') : null
            )
          )
        )
      );
      input.focus();
    };
    show();
    return li;
  };

  const load = async () => {
    let report: ConfigReport;
    try {
      report = await ctx.api.get<ConfigReport>('/v1/config', ac.signal);
    } catch (e) {
      if (e instanceof HttpError && e.status === 403) {
        fill(body, notice('The configuration needs a key with the admin scope. This key can see analytics, jobs and renders.'));
        return;
      }
      return failed(ctx, body, 'Configuration', e, ac.signal);
    }
    const groups = new Map<string, ConfigEntry[]>();
    for (const e of report.settings) {
      const g = e.key.split('.')[0]!;
      groups.set(g, [...(groups.get(g) ?? []), e]);
    }
    const filter = h('input', { id: 'cfg-filter', type: 'search', placeholder: 'limits, REELFORGE_PORT, webhook', autocomplete: 'off', spellcheck: 'false' });
    const sections = [...groups.entries()].map(([g, entries]) => {
      const list = h('ul', { class: 'settings-list' }, entries.map((e) => row(e)));
      const changed = entries.filter((e) => e.source !== 'default').length;
      const det = h('details', { class: 'panel group', 'data-group': g }, h('summary', null, svg('svg', { viewBox: '0 0 12 12', width: 12, height: 12, class: 'chev', 'aria-hidden': 'true', focusable: 'false' }, svg('path', { d: 'M4.5 2.5 8 6l-3.5 3.5' })), h('span', { class: 'group-title' }, groupTitle(g)), h('span', { class: 'meta' }, `${entries.length} ${entries.length === 1 ? 'setting' : 'settings'}${changed ? ` · ${changed} set` : ''}`)), list);
      return { det, entries, list };
    });
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const s of sections) {
        let any = false;
        s.entries.forEach((e, i) => {
          // A dotted key or an env name matches names only; plain words also match the descriptions.
          const byName = q.includes('.') || q.startsWith('reelforge_');
          const hit = !q || e.key.toLowerCase().includes(q) || e.env.toLowerCase().includes(q) || (!byName && e.description.toLowerCase().includes(q));
          (s.list.children[i] as HTMLElement).hidden = !hit;
          any ||= hit;
        });
        s.det.hidden = !any;
        s.det.open = Boolean(q) && any;
      }
    });
    fill(
      body,
      h(
        'dl',
        { class: 'facts facts-row' },
        h('div', null, h('dt', null, 'Edition'), h('dd', null, report.edition)),
        h('div', null, h('dt', null, 'Config file'), h('dd', { class: 'mono break' }, report.configFile ?? 'None')),
        h('div', null, h('dt', null, 'Secret key'), h('dd', null, report.secretKey === 'set' ? 'Set: secrets can be stored here' : 'Not set: secrets come from the environment only'))
      ),
      report.warnings.length ? h('ul', { class: 'notice warnings' }, report.warnings.map((w) => h('li', null, w.key ? h('code', null, w.key) : null, w.key ? ' ' : null, w.message))) : null,
      h(
        'div',
        { class: 'filter-row' },
        h('label', { for: 'cfg-filter' }, 'Filter settings'),
        filter,
        h('p', { class: 'help' }, ctx.can('admin') ? 'Settings that apply at runtime can be changed here; the change takes effect at once and is in the audit log. Start-up settings are set in the config file or the environment.' : 'This key can read the settings but not change them.')
      ),
      h('div', { class: 'groups' }, sections.map((s) => s.det))
    );
  };
  void load();
  return () => ac.abort();
};

// ---- API keys -------------------------------------------------------------------

const SCOPES = ['read', 'write', 'render', 'admin'] as const;

/** #/settings/keys: list, create (secret shown once), rotate and revoke (admin). */
export const keysView: View = (ctx, main) => {
  const ac = new AbortController();
  const body = frame(main, 'keys');
  const secret = h('div', { 'aria-live': 'polite' });
  const list = h('div');
  if (!ctx.can('admin')) {
    fill(body, notice('Managing API keys needs a key with the admin scope.'));
    return () => ac.abort();
  }

  const act = async (k: KeyRecord, what: 'rotate' | 'revoke') => {
    if (what === 'revoke' && !window.confirm(`Revoke ${k.name}? Clients using it stop working at once.`)) return;
    fill(secret);
    try {
      if (what === 'rotate') {
        const r = await ctx.api.post<{ key: string; record: KeyRecord }>(`/v1/keys/${encodeURIComponent(k.id)}/rotate`, { graceHours: 24 });
        fill(secret, secretBox(`New secret for ${k.name}`, r.key, 'Store it now: it is not shown again. The old secret keeps working for 24 hours.'));
      } else await ctx.api.post(`/v1/keys/${encodeURIComponent(k.id)}/revoke`);
      await load();
    } catch (e) {
      if (!ctx.authLost(e)) fill(secret, notice(`Could not ${what} ${k.name}: ${(e as Error).message}`, 'error'));
    }
  };

  const load = async () => {
    const { keys } = await ctx.api.get<{ keys: KeyRecord[] }>('/v1/keys', ac.signal);
    keys.sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
    const now = Date.now();
    fill(
      list,
      tableWrap(
        'API keys',
        h(
          'table',
          { class: 'table stack' },
          h('thead', null, h('tr', null, ...['Key', 'Scopes', 'Status', 'Last used', 'Expires', ''].map((c, i) => h('th', { scope: 'col', class: i === 3 || i === 4 ? 'wide' : i === 5 ? 'num' : null }, c || h('span', { class: 'sr-only' }, 'Actions'))))),
          h(
            'tbody',
            null,
            keys.map((k) => {
              const self = k.id === ctx.me.id;
              return h(
                'tr',
                { 'data-key': k.id },
                h('td', null, k.name, self ? h('span', { class: 'meta' }, ' (this key)') : null, h('span', { class: 'sub mono' }, `${k.prefix}… · ${k.id}`)),
                h('td', null, scopeText(k.scopes)),
                h('td', null, status(k.status === 'active' ? 'succeeded' : k.status === 'revoked' ? 'failed' : 'cancelled', k.status === 'active' ? 'Active' : k.status === 'revoked' ? 'Revoked' : 'Expired')),
                h('td', { class: 'wide' }, k.lastUsedAt ? ago(k.lastUsedAt, now) : 'Never'),
                h('td', { class: 'wide' }, k.expiresAt ? dateTime(k.expiresAt) : 'Never'),
                h(
                  'td',
                  { class: 'num row-actions' },
                  k.status === 'active'
                    ? [
                        h('button', { type: 'button', class: 'btn btn-quiet', 'aria-label': `Rotate ${k.name}`, onclick: () => void act(k, 'rotate') }, 'Rotate'),
                        h('button', { type: 'button', class: 'btn btn-quiet', disabled: self, 'aria-label': `Revoke ${k.name}`, title: self ? 'The key in use cannot revoke itself' : null, onclick: () => void act(k, 'revoke') }, 'Revoke'),
                      ]
                    : null
                )
              );
            })
          )
        )
      )
    );
  };

  const name = h('input', { id: 'key-name', required: true, maxlength: 100, autocomplete: 'off' });
  const days = h('input', { id: 'key-days', type: 'number', min: 1, max: 3650, inputmode: 'numeric' });
  const boxes = SCOPES.map((sc) => h('input', { type: 'checkbox', id: `scope-${sc}`, value: sc, checked: sc === 'read' }));
  const formErr = h('p', { class: 'field-error', role: 'alert' });
  const form = h(
    'form',
    {
      class: 'panel create-form',
      'aria-labelledby': 'new-key-h',
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        fill(formErr);
        const scopes = boxes.filter((b) => b.checked).map((b) => b.value);
        if (!name.value.trim()) return (fill(formErr, 'Give the key a name, e.g. the client that will use it.'), name.focus());
        if (!scopes.length) return (fill(formErr, 'Choose at least one scope.'), boxes[0]!.focus());
        try {
          const r = await ctx.api.post<{ key: string; record: KeyRecord }>('/v1/keys', { name: name.value.trim(), scopes, ...(days.value ? { expiresInDays: Number(days.value) } : {}) });
          fill(secret, secretBox(`Secret of ${r.record.name}`, r.key, 'Store it now: it is not shown again.'));
          name.value = '';
          days.value = '';
          await load();
        } catch (x) {
          if (!ctx.authLost(x)) fill(formErr, (x as Error).message);
        }
      },
    },
    h('h2', { id: 'new-key-h' }, 'New key'),
    h('div', { class: 'field' }, h('label', { for: 'key-name' }, 'Name'), name),
    h('fieldset', { class: 'field' }, h('legend', null, 'Scopes'), h('div', { class: 'checks-row' }, SCOPES.map((sc, i) => h('div', { class: 'check' }, boxes[i]!, h('label', { for: `scope-${sc}` }, sc))))),
    h('div', { class: 'field' }, h('label', { for: 'key-days' }, 'Expires after (days, optional)'), days),
    formErr,
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create key'))
  );
  fill(body, secret, h('div', { class: 'keys-grid' }, h('section', { class: 'panel', 'aria-label': 'Keys' }, list), form));
  load().catch((e) => failed(ctx, list, 'API keys', e, ac.signal));
  return () => ac.abort();
};

// ---- webhooks ---------------------------------------------------------------------

/** #/settings/webhooks: endpoints (admin); each opens its delivery log. */
export const webhooksView: View = (ctx, main) => {
  const ac = new AbortController();
  const body = frame(main, 'webhooks');
  if (!ctx.can('admin')) {
    fill(body, notice('The list of webhooks needs a key with the admin scope. A read key can open an endpoint\'s delivery log from Analytics.'));
    return () => ac.abort();
  }
  fill(body, h('p', { class: 'meta' }, 'Loading'));
  ctx.api
    .get<{ webhooks: Webhook[] }>('/v1/webhooks', ac.signal)
    .then(({ webhooks }) => {
      if (!webhooks.length) {
        fill(body, h('p', { class: 'empty' }, 'No webhooks yet. Create one with create_webhook or POST /v1/webhooks.'));
        return;
      }
      fill(
        body,
        tableWrap(
          'Webhooks',
          h(
            'table',
            { class: 'table panel-table' },
            h('thead', null, h('tr', null, ...['Endpoint', 'Target', 'Events', 'State'].map((c, i) => h('th', { scope: 'col', class: i === 1 || i === 2 ? 'wide' : null }, c)))),
            h(
              'tbody',
              null,
              webhooks.map((w) =>
                h(
                  'tr',
                  null,
                  h('td', null, h('a', { href: `#/settings/webhooks/${w.id}` }, w.name), h('span', { class: 'sub mono' }, w.id)),
                  h('td', { class: 'wide' }, h('span', { class: 'mono break' }, w.url ?? w.email?.to.join(', ') ?? '–'), h('span', { class: 'sub' }, w.type)),
                  h('td', { class: 'wide mono' }, w.events.join(', ')),
                  h('td', null, w.enabled ? 'Enabled' : `Disabled${w.disabledReason ? `: ${w.disabledReason}` : ''}`, w.signing?.rotating ? h('span', { class: 'sub' }, `Two secrets until ${dateTime(w.signing.previousSecretValidUntil)}`) : null)
                )
              )
            )
          )
        )
      );
    })
    .catch((e) => failed(ctx, body, 'Webhooks', e, ac.signal));
  return () => ac.abort();
};

const DELIVERY_STATUS: Record<WebhookDelivery['status'], [string, string]> = {
  succeeded: ['succeeded', 'Delivered'],
  dead: ['failed', 'Failed'],
  pending: ['queued', 'Waiting'],
  delivering: ['running', 'Sending'],
};

/** #/settings/webhooks/:id: the delivery log (read scope), with test, resend and secret rotation for admins. */
export const webhookView: View = (ctx, main, id) => {
  const webhookId = id!;
  const ac = new AbortController();
  const body = frame(main, 'webhooks', 'Webhook');
  const title = main.querySelector('h1')!;
  const head = h('div', { class: 'webhook-head' });
  const msg = h('div', { 'aria-live': 'polite' });
  const rows = h('tbody');
  const more = h('div', { class: 'actions' });
  const admin = ctx.can('admin');
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/settings/webhooks' }, 'Webhooks'), h('span', { 'aria-current': 'page', class: 'mono' }, webhookId));

  const run = async (label: string, fn: () => Promise<unknown>) => {
    fill(msg);
    try {
      await fn();
    } catch (e) {
      if (!ctx.authLost(e)) fill(msg, notice(`${label}: ${(e as Error).message}`, 'error'));
    }
  };
  const resend = (d: WebhookDelivery) =>
    run('Could not resend', async () => {
      const r = await ctx.api.post<{ action: string; delivery: { id: string } }>(`/v1/webhooks/${encodeURIComponent(webhookId)}/resend`, { deliveryId: d.id });
      fill(msg, notice(r.action === 'rescheduled' ? `Delivery ${d.id} is due again now.` : `Queued again as ${r.delivery.id}.`));
      await load();
    });

  const deliveryRow = (d: WebhookDelivery) => {
    const [st, label] = DELIVERY_STATUS[d.status];
    return h(
      'tr',
      null,
      h('td', null, h('span', { class: 'mono' }, d.eventType), h('span', { class: 'sub mono' }, d.id)),
      h('td', null, status(st, label), d.lastError ? h('span', { class: 'sub' }, d.lastError) : null),
      h('td', { class: 'num wide' }, String(d.attempts)),
      h('td', { class: 'num wide' }, d.lastStatus ? String(d.lastStatus) : '–'),
      h('td', { class: 'num wide' }, latency(d.latencyMs)),
      h('td', { class: 'num wide' }, ago(d.createdAt)),
      admin ? h('td', { class: 'num' }, h('button', { type: 'button', class: 'btn btn-quiet', 'aria-label': `Resend ${d.id}`, disabled: d.status === 'delivering', onclick: () => void resend(d) }, 'Resend')) : null
    );
  };

  let cursor: string | null = null;
  const page = async (next?: string) => {
    const log = await ctx.api.get<WebhookLog>(`/v1/webhooks/${encodeURIComponent(webhookId)}/log?limit=50${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, ac.signal);
    cursor = log.nextCursor;
    rows.append(...log.deliveries.map(deliveryRow));
    fill(more, cursor ? h('button', { type: 'button', class: 'btn', onclick: () => void run('Could not load more', () => page(cursor!)) }, 'Show older deliveries') : null);
    return log;
  };

  const load = async () => {
    rows.replaceChildren();
    const log = await page();
    const w = log.webhook;
    title.textContent = w.name;
    document.title = `${w.name} · ReelForge Studio`;
    const sm = log.summary;
    fill(
      head,
      h('p', { class: 'meta head-meta' }, `${w.type} · ${w.enabled ? 'enabled' : `disabled${w.disabledReason ? `: ${w.disabledReason}` : ''}`}`),
      h(
        'dl',
        { class: 'stats stats-4' },
        h('div', { class: 'stat' }, h('dt', null, 'Success rate'), h('dd', { class: 'stat-value' }, rate(sm.successRate)), h('dd', { class: 'sub' }, `${count(sm.attempts)} attempts in the newest ${count(sm.deliveries)} deliveries`)),
        h('div', { class: 'stat' }, h('dt', null, 'Latency, p50'), h('dd', { class: 'stat-value' }, latency(sm.latencyMs.p50)), h('dd', { class: 'sub' }, `p95 ${latency(sm.latencyMs.p95)}`)),
        h('div', { class: 'stat' }, h('dt', null, 'Last delivered'), h('dd', { class: 'stat-value stat-text' }, sm.lastSuccessAt ? ago(sm.lastSuccessAt) : 'Never'), h('dd', { class: 'sub' }, sm.lastFailureAt ? `Last failure ${ago(sm.lastFailureAt)}` : 'No failures')),
        h('div', { class: 'stat' }, h('dt', null, 'Retries'), h('dd', { class: 'stat-value stat-text' }, `${log.retry.maxAttempts} attempts`), h('dd', { class: 'sub' }, `Over ${log.retry.windowHours} h, ${log.retry.timeoutSeconds} s timeout`))
      ),
      admin
        ? h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', class: 'btn', disabled: !w.enabled, onclick: () => void run('Could not send a test', async () => (await ctx.api.post(`/v1/webhooks/${encodeURIComponent(webhookId)}/test`, { waitSeconds: 5 }), await load(), fill(msg, notice('Test event sent; its delivery is at the top of the log.')))) }, 'Send test event'),
            h(
              'button',
              {
                type: 'button',
                class: 'btn',
                onclick: () =>
                  void run('Could not rotate the secret', async () => {
                    if (!window.confirm('Rotate the signing secret? Both secrets sign for 24 hours, so the receiver can switch.')) return;
                    const r = await ctx.api.post<{ secret?: string; note: string }>(`/v1/webhooks/${encodeURIComponent(webhookId)}/rotate-secret`, { overlapHours: 24 });
                    fill(msg, r.secret ? secretBox('New signing secret', r.secret, `Store it now: it is not shown again. ${r.note}`) : notice(r.note));
                  }),
              },
              'Rotate secret'
            )
          )
        : h('p', { class: 'help' }, 'Test, resend and secret rotation need the admin scope.')
    );
  };

  fill(
    body,
    crumbs,
    head,
    msg,
    h(
      'section',
      { class: 'panel', 'aria-labelledby': 'log-h' },
      h('h2', { id: 'log-h' }, 'Delivery log'),
      tableWrap(
        'Deliveries, newest first',
        h(
          'table',
          { class: 'table stack' },
          h('thead', null, h('tr', null, ...['Event', 'Status', 'Attempts', 'HTTP', 'Latency', 'Created'].map((c, i) => h('th', { scope: 'col', class: i >= 2 ? 'num wide' : null }, c)), admin ? h('th', { scope: 'col', class: 'num' }, h('span', { class: 'sr-only' }, 'Actions')) : null)),
          rows
        )
      ),
      more
    )
  );
  load().catch((e) => failed(ctx, msg, 'The delivery log', e, ac.signal));
  return () => ac.abort();
};

// ---- providers and licence ---------------------------------------------------------

/** #/settings/providers: media providers (configured or not, which settings are set) and the licence. */
export const providersView: View = (ctx, main) => {
  const ac = new AbortController();
  const body = frame(main, 'providers');
  fill(body, h('p', { class: 'meta' }, 'Loading'));
  Promise.all([ctx.api.get<{ providers: Provider[] }>('/v1/providers', ac.signal), ctx.api.get<Licence>('/v1/licence', ac.signal)])
    .then(([{ providers }, l]) => {
      const lic: Array<[string, string]> = [
        ['Status', `${l.status.charAt(0).toUpperCase()}${l.status.slice(1)}`],
        ['Renders', l.renderAllowed ? 'Allowed' : 'Refused'],
        ['Key', l.key ?? 'None'],
        ['Product', l.item?.title ?? '–'],
        ['Activations', l.activations ? `${l.activations.used} of ${l.activations.limit ?? 'unlimited'}` : '–'],
        ['Last check', l.lastCheckedAt ? dateTime(l.lastCheckedAt) : 'Never'],
      ];
      if (l.graceUntil) lic.push(['Grace until', dateTime(l.graceUntil)]);
      if (l.expiresAt) lic.push(['Expires', dateTime(l.expiresAt)]);
      fill(
        body,
        h(
          'div',
          { class: 'grid-2' },
          h(
            'section',
            { class: 'panel', 'aria-labelledby': 'lic-h' },
            h('h2', { id: 'lic-h' }, 'Licence'),
            h('dl', { class: 'facts' }, lic.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', { class: k === 'Key' ? 'mono' : null }, v)))),
            h('p', { class: 'help' }, prose(l.message), l.fix ? [' ', prose(l.fix)] : '')
          ),
          h(
            'section',
            { class: 'panel', 'aria-labelledby': 'prov-h' },
            h('h2', { id: 'prov-h' }, 'Media providers'),
            providers.length
              ? h(
                  'ul',
                  { class: 'providers' },
                  providers.map((p) =>
                    h(
                      'li',
                      null,
                      h('div', { class: 'bar-head' }, h('span', { class: 'bar-name' }, p.displayName), status(p.configured ? 'succeeded' : 'cancelled', p.configured ? 'Configured' : 'Not configured')),
                      h('span', { class: 'sub' }, `${p.kind}${p.costNote ? ` · ${p.costNote}` : ''}`),
                      p.settings.length ? h('ul', { class: 'provider-settings' }, p.settings.map((st) => h('li', null, h('code', null, st.name), ` ${st.set ? `set (${st.source})` : 'not set'}${st.error ? ` · ${st.error}` : ''}`))) : null
                    )
                  )
                )
              : h('p', { class: 'empty' }, 'No providers are installed.'),
            h('p', { class: 'help' }, ctx.can('admin') ? 'Provider settings are secrets: set them with configure_provider or PUT /v1/providers/:id/config.' : 'Configuring a provider needs the admin scope.')
          )
        )
      );
    })
    .catch((e) => failed(ctx, body, 'Providers and licence', e, ac.signal));
  return () => ac.abort();
};
