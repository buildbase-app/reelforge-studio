import { badRequest } from './errors';

/**
 * Keyset pagination for list_projects, list_jobs and list_assets (#179, D-102).
 *
 * Every list is newest first by (createdAt, id), both descending; a page
 * starts strictly after the (createdAt, id) of the previous page's last row.
 * createdAt never changes, so a walk from the first page to nextCursor null
 * returns every row that existed when it started exactly once, whatever is
 * inserted, updated or deleted meanwhile (rows inserted during the walk are
 * newer than the cursor and only show up on a new walk).
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** The position a page starts after: the last row of the previous page. */
export interface PageAfter {
  createdAt: string;
  id: string;
}

export interface PageRequest {
  /** At most this many rows (the repositories are asked for limit + 1 to tell whether there is more). */
  limit: number;
  after?: PageAfter;
}

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/;
const BASE64URL = /^[A-Za-z0-9_-]{1,1024}$/;
const INVALID = 'cursor is invalid: pass nextCursor from the previous page of the same list, with the same filters, unchanged';

/**
 * The opaque cursor: base64url JSON { v, l: list, f: filter, t: createdAt, i: id }.
 * Not signed, because it only holds a position in a list the caller may read
 * anyway, and every page query is still scoped to the caller's workspace and
 * the request's filters. It is bound to its list and filter, so a cursor of
 * one list or filter is refused by another instead of silently skipping rows.
 */
export function encodeCursor(list: string, filter: string, row: PageAfter): string {
  return Buffer.from(JSON.stringify({ v: 1, l: list, f: filter, t: row.createdAt, i: row.id })).toString('base64url');
}

function decodeCursor(list: string, filter: string, cursor: unknown): PageAfter {
  if (typeof cursor !== 'string' || !BASE64URL.test(cursor)) throw badRequest(INVALID);
  let c: unknown;
  try {
    c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badRequest(INVALID);
  }
  if (typeof c !== 'object' || c === null || Array.isArray(c)) throw badRequest(INVALID);
  const o = c as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'f,i,l,t,v' || o.v !== 1 || o.l !== list || o.f !== filter) throw badRequest(INVALID);
  const { t, i } = o;
  if (typeof t !== 'string' || !ISO_MS.test(t) || !Number.isFinite(Date.parse(t)) || new Date(t).toISOString() !== t) throw badRequest(INVALID);
  if (typeof i !== 'string' || !ROW_ID.test(i)) throw badRequest(INVALID);
  return { createdAt: t, id: i };
}

/** `limit` and `cursor` of a list call (REST query or MCP arguments). Throws bad_request. */
export function parsePageQuery(list: string, filter: string, q: { limit?: unknown; cursor?: unknown }): PageRequest {
  let limit = DEFAULT_PAGE_SIZE;
  if (q.limit !== undefined && q.limit !== null && q.limit !== '') {
    const n = typeof q.limit === 'number' ? q.limit : typeof q.limit === 'string' && /^\d{1,4}$/.test(q.limit) ? Number(q.limit) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) throw badRequest(`limit must be an integer from 1 to ${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE})`);
    limit = n;
  }
  const cursor = q.cursor === undefined || q.cursor === null || q.cursor === '' ? undefined : decodeCursor(list, filter, q.cursor);
  return cursor ? { limit, after: cursor } : { limit };
}

/** Fetch one page (limit + 1 rows) and build nextCursor: null when this is the last page. */
export async function readPage<T extends PageAfter>(
  list: string,
  filter: string,
  req: PageRequest,
  fetch: (req: PageRequest) => Promise<T[]>
): Promise<{ items: T[]; nextCursor: string | null }> {
  const rows = await fetch({ ...req, limit: req.limit + 1 });
  const items = rows.slice(0, req.limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > req.limit && last ? encodeCursor(list, filter, last) : null };
}

/** In-memory keyset page over rows already sorted newest first (memory repositories). */
export function pageOf<T extends PageAfter>(sortedNewestFirst: T[], req: PageRequest): T[] {
  const a = req.after;
  const start = a ? sortedNewestFirst.filter((r) => r.createdAt < a.createdAt || (r.createdAt === a.createdAt && r.id < a.id)) : sortedNewestFirst;
  return start.slice(0, req.limit);
}
