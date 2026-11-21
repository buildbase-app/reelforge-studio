import { createHash } from 'node:crypto';
import { ApiError, badRequest } from './errors';
import type { IdempotencyRepository } from './repositories';

/**
 * Idempotency keys (#65, D-057). A create or render call sent with an
 * `Idempotency-Key` header (REST) or `idempotencyKey` argument (MCP) runs once
 * per (API key, idempotency key): a retry with the same arguments gets the
 * stored result instead of a second project, job or provider bill; the same
 * key with different arguments is refused (422 idempotency_conflict). The
 * hash covers the operation name and its canonical arguments (REST and MCP
 * build the same argument object, so the two share keys). Records live in the
 * database for idempotency.ttlHours (24 h) and are then swept. A call that
 * fails stores nothing, so it can be retried with the same key. Calls that
 * return a secret (create_key, rotate_key) do not take a key: storing their
 * result would store the secret.
 */

/** Printable ASCII without spaces, 1-128 characters (e.g. a UUID). */
export const IDEMPOTENCY_KEY_FORMAT = /^[\x21-\x7e]{1,128}$/;

/** The operations that accept an idempotency key (MCP tool names). */
export const IDEMPOTENT_OPERATIONS = [
  'create_project',
  'create_theme',
  'add_scene',
  'render_project',
  'preview_scene',
  'retry_job',
  'run_provider',
  'add_asset_from_url',
] as const;
export type IdempotentOperation = (typeof IDEMPOTENT_OPERATIONS)[number];

/** JSON with object keys sorted and undefined values dropped (stable across REST and MCP). */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
}

export function requestHash(operation: string, request: unknown): string {
  return createHash('sha256').update(operation).update('\n').update(canonicalJson(request)).digest('hex');
}

export interface IdempotentCall {
  /** The caller's key; undefined runs the call without idempotency. */
  key?: string;
  /** Who sends it (API key id). */
  actorId: string;
  operation: IdempotentOperation;
  /** The arguments that define "the same request". */
  request: unknown;
  ttlHours: number;
  now?: () => number;
}

/** Run `fn` at most once per (actorId, key). Returns its result and whether it was a replay. */
export async function withIdempotency<T>(repo: IdempotencyRepository, call: IdempotentCall, fn: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
  if (call.key === undefined || call.key === null || call.key === '') return { result: await fn(), replayed: false };
  if (typeof call.key !== 'string' || !IDEMPOTENCY_KEY_FORMAT.test(call.key)) {
    throw badRequest('the idempotency key must be 1-128 printable ASCII characters without spaces (a UUID is a good choice)');
  }
  const now = call.now ?? Date.now;
  const hash = requestHash(call.operation, call.request);
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = now();
    const record = {
      actorId: call.actorId,
      key: call.key,
      operation: call.operation,
      requestHash: hash,
      status: 'pending' as const,
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + call.ttlHours * 3_600_000).toISOString(),
    };
    if (await repo.begin(record)) {
      let result: T;
      try {
        result = await fn();
      } catch (e) {
        // Nothing is stored for a failed call: the caller may retry with the same key.
        await repo.delete(call.actorId, call.key).catch(() => undefined);
        throw e;
      }
      await repo.complete(call.actorId, call.key, result === undefined ? null : result);
      return { result, replayed: false };
    }
    const existing = await repo.get(call.actorId, call.key);
    if (!existing) continue; // deleted in between (a failed first call): try again
    if (Date.parse(existing.expiresAt) <= t) {
      // Expired but not swept yet: it no longer counts.
      await repo.delete(call.actorId, call.key);
      continue;
    }
    if (existing.operation !== call.operation || existing.requestHash !== hash) {
      throw new ApiError(
        'idempotency_conflict',
        422,
        `this idempotency key was already used with ${existing.operation === call.operation ? 'different arguments' : `another operation (${existing.operation})`}; use a new key for a different request`,
        { operation: existing.operation, firstUsedAt: existing.createdAt }
      );
    }
    if (existing.status === 'pending') {
      throw new ApiError('idempotency_in_progress', 409, 'a request with this idempotency key is still running; retry in a few seconds', { firstUsedAt: existing.createdAt });
    }
    return { result: existing.response as T, replayed: true };
  }
  throw new ApiError('idempotency_in_progress', 409, 'a request with this idempotency key is still running; retry in a few seconds');
}
