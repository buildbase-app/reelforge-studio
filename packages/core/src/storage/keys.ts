import type { Readable } from 'node:stream';
import { isSafeRelativePath } from '@reelforge/project-schema';

/** Asset bytes: `assets/<assetId>/file.<ext>` (AssetRecord.storageKey is the part after `assets/`). */
export const ASSETS_PREFIX = 'assets/';
/** Every project's files: `projects/<projectId>/renders/<runId>/...`. */
export const PROJECTS_PREFIX = 'projects/';
/** A render that is still being written or committed: `projects/<id>/renders/.tmp-<runId>/...`. */
export const TEMP_RUN_PREFIX = '.tmp-';
/** The object whose presence marks a render as complete; written last. */
export const RENDER_MANIFEST = 'render-manifest.json';

export const rendersPrefix = (projectId: string) => `${PROJECTS_PREFIX}${projectId}/renders/`;
export const renderPrefix = (projectId: string, runId: string) => `${rendersPrefix(projectId)}${runId}/`;

/** A storage key: a safe relative path (no "..", no leading "/", no backslashes, no empty segments). */
export function checkKey(key: string): string {
  if (!isSafeRelativePath(key) || key.length > 1024 || key.endsWith('/') || key.split('/').some((s) => s === '' || s === '.')) {
    throw new Error(`unsafe storage key "${key}"`);
  }
  return key;
}

/** A list prefix: "" (everything) or a key-like path ending in "/". */
export function checkPrefix(prefix: string): string {
  if (prefix === '') return prefix;
  if (!prefix.endsWith('/')) throw new Error(`storage prefix must end with "/": "${prefix}"`);
  checkKey(prefix.slice(0, -1));
  return prefix;
}

/** Normalise a configured bucket prefix ("studio", "/studio/", "a/b") to "studio/" or "". */
export function normalisePrefix(p: string | undefined): string {
  const s = (p ?? '').replace(/^\/+|\/+$/g, '');
  if (!s) return '';
  checkKey(s);
  return `${s}/`;
}

export async function streamToBuffer(r: Readable | NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of r as AsyncIterable<Buffer | string>) chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c));
  return Buffer.concat(chunks);
}

export function contentTypeFor(key: string): string {
  if (key.endsWith('.mp4')) return 'video/mp4';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.srt')) return 'application/x-subrip; charset=utf-8';
  if (key.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
  if (key.endsWith('.ass')) return 'text/x-ssa; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * Run `fn` over `items` with at most `limit` at a time. After a failure no new
 * item starts, and the error is thrown only once the running ones have
 * settled (so cleanup after it sees every object that was written).
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (next < items.length && !failure) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return out;
}

/** A Content-Disposition value with a plain ASCII file name. */
export function inlineDisposition(filename: string): string {
  return `inline; filename="${filename.replace(/[^\w.-]/g, '_')}"`;
}
