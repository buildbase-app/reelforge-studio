import { HttpError } from '../api';
import { fill, h, notice, tableWrap } from '../dom';
import { ago, bytes, dateTime } from '../format';
import type { View } from '../main';

/** One stored asset as GET /v1/assets lists it (StoredAsset). */
export interface AssetRow {
  id: string;
  bytes: number;
  contentType: string;
  mediaType: 'audio' | 'image' | 'video' | 'font';
  createdAt: string;
  source: string;
  originalName?: string;
  license?: { name: string; redistributable: boolean };
  durationSeconds?: number;
}

/** Where an asset came from, in a few words: an upload, a provider, or the host of the URL it was imported from. */
export function assetSource(source: string): string {
  if (source === 'upload') return 'Upload';
  try {
    return new URL(source).host || source;
  } catch {
    return source;
  }
}

const TYPE: Record<AssetRow['mediaType'], string> = { image: 'Image', video: 'Video', audio: 'Audio', font: 'Font' };

/**
 * #/assets: every stored asset of the workspace (#292), newest first, in keyset pages: its name and id, type,
 * size, length, licence (assets without one are marked: a render with them may not be yours to publish), where
 * it came from and when. Read scope.
 */
export const assetsView: View = (ctx, main) => {
  const ac = new AbortController();
  const msg = h('div', { 'aria-live': 'polite' });
  const summary = h('p', { class: 'meta' }, 'Loading assets');
  const tbody = h('tbody');
  const more = h('div');
  const table = h(
    'table',
    { class: 'table stack' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Preview')), ...['Asset', 'Type', 'Size', 'Length', 'Licence', 'Source', 'Added'].map((t) => h('th', { scope: 'col' }, t)))),
    tbody
  );
  fill(main, h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, 'Assets')), msg, summary, tableWrap('Assets', table), more);

  const rows: AssetRow[] = [];
  // Image previews through the API (the key is a header, so an <img src> cannot fetch them): three at a time,
  // each fetched once, object URLs revoked when the page closes.
  const urls = new Map<string, string>();
  const queue: Array<() => Promise<void>> = [];
  let active = 0;
  const pump = () => {
    while (active < 3 && queue.length && !ac.signal.aborted) {
      const job = queue.shift()!;
      active++;
      void job().finally(() => {
        active--;
        pump();
      });
    }
  };
  const thumb = (a: AssetRow) => {
    if (a.mediaType !== 'image') return null;
    const img = h('img', { class: 'asset-thumb', alt: '', width: '40', height: '40', loading: 'lazy' });
    const known = urls.get(a.id);
    if (known) img.src = known;
    else {
      queue.push(async () => {
        try {
          const url = await ctx.api.objectUrl(`/v1/assets/${encodeURIComponent(a.id)}/file`, ac.signal);
          urls.set(a.id, url);
          img.src = url;
        } catch {
          img.remove();
        }
      });
      pump();
    }
    return img;
  };
  const show = () => {
    const now = Date.now();
    const unlicensed = rows.filter((a) => !a.license).length;
    const total = rows.reduce((n, a) => n + a.bytes, 0);
    fill(summary, `${rows.length} ${rows.length === 1 ? 'asset' : 'assets'} shown · ${bytes(total)}${unlicensed ? ` · ${unlicensed} without a licence` : ''}`);
    fill(
      tbody,
      rows.map((a) =>
        h(
          'tr',
          null,
          h('td', null, thumb(a)),
          h('td', null, h('span', { class: 'break' }, a.originalName ?? a.id), a.originalName ? h('span', { class: 'sub mono' }, a.id) : null),
          h('td', { 'data-label': 'Type' }, TYPE[a.mediaType] ?? a.mediaType, h('span', { class: 'sub mono' }, a.contentType)),
          h('td', { class: 'num', 'data-label': 'Size' }, bytes(a.bytes)),
          h('td', { class: 'num', 'data-label': 'Length' }, a.durationSeconds ? `${a.durationSeconds.toFixed(1)} s` : '–'),
          h('td', { 'data-label': 'Licence' }, a.license ? a.license.name : h('span', { class: 'checks' }, h('span', { class: 'status warn', title: 'No licence recorded: a render with this asset may not be yours to publish' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), 'None'))),
          h('td', { class: 'break', 'data-label': 'Source' }, assetSource(a.source)),
          h('td', { title: dateTime(a.createdAt), 'data-label': 'Added' }, ago(a.createdAt, now))
        )
      )
    );
  };

  const load = async (cursor?: string) => {
    const page = await ctx.api.get<{ assets: AssetRow[]; nextCursor: string | null }>(`/v1/assets?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, ac.signal);
    rows.push(...page.assets);
    show();
    fill(more, page.nextCursor ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => void load(page.nextCursor!).catch(fail) }, 'Show more assets') : null);
    if (!rows.length) fill(summary, 'No assets yet. Upload one with upload_asset or POST /v1/assets.');
  };
  const fail = (e: unknown) => {
    if (ac.signal.aborted || ctx.authLost(e)) return;
    fill(msg, notice(e instanceof HttpError ? e.message : 'Could not load the assets.', 'error'));
  };
  void load().catch(fail);
  return () => {
    ac.abort();
    for (const u of urls.values()) URL.revokeObjectURL(u);
  };
};
