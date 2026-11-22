/**
 * `pnpm gallery upload`: puts every web file (and each reel's manifest) into
 * the R2 bucket `reelforge-media` through the Cloudflare REST API (the API
 * Wrangler itself uses), with
 *   Cache-Control: public, max-age=31536000, immutable
 * Keys carry a content hash, so an object never changes once written: the
 * upload skips keys it has written before (the ledger in
 * <out>/web/r2-uploaded.json) and the whole step can be re-run safely.
 * Creates the bucket when it does not exist. Writes <out>/web/urls.json, the
 * public URL of every file under the media base URL.
 *
 * Needs CLOUDFLARE_API_TOKEN (R2 edit) and CLOUDFLARE_ACCOUNT_ID. With
 * --dry-run it prints what it would do and touches nothing remote.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fetch } from './publish';
import { readMedia, type MediaFile } from './transcode';

export const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const API = 'https://api.cloudflare.com/client/v4';

export interface UploadItem {
  key: string;
  file: string;
  contentType: string;
}

/** Every object a gallery output has: web media plus one manifest JSON per reel (hashed name). */
export function uploadItems(outDir: string, examplesDir?: string): { items: UploadItem[]; manifests: Record<string, string> } {
  const media = readMedia(outDir);
  const items: UploadItem[] = [];
  const manifests: Record<string, string> = {};
  for (const [slug, m] of Object.entries(media)) {
    const files: MediaFile[] = [m.mp4, m.webm, m.poster.avif, m.poster.jpg, m.poster.avif360, m.poster.jpg360];
    for (const f of files) items.push({ key: f.key, file: f.file, contentType: f.contentType });
    const src = examplesDir ? join(examplesDir, `${slug}.json`) : '';
    if (src && existsSync(src)) {
      const manifest = JSON.parse(readFileSync(src, 'utf8')).manifest;
      const body = JSON.stringify(manifest, null, 2) + '\n';
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
      const file = join(outDir, 'web', slug, `manifest.${hash}.json`);
      writeFileSync(file, body);
      const key = `gallery/${slug}/manifest.${hash}.json`;
      items.push({ key, file, contentType: 'application/json' });
      manifests[slug] = key;
    }
  }
  return { items, manifests };
}

export class R2Rest {
  constructor(
    private account: string,
    private token: string,
    private bucket: string,
    private f: Fetch = fetch
  ) {}

  private async call(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${API}/accounts/${this.account}${path}`, {
        method,
        body: init.body,
        headers: { Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
        continue;
      }
      const text = await res.text();
      let data: any = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      if (!res.ok || data?.success === false) {
        const errs = (data?.errors ?? []).map((e: any) => `${e.code}: ${e.message}`).join('; ');
        throw new Error(`Cloudflare ${method} ${path} -> ${res.status} ${errs || String(text).slice(0, 300)}`);
      }
      return data;
    }
  }

  async ensureBucket(): Promise<'exists' | 'created'> {
    const list = await this.call('GET', '/r2/buckets');
    const buckets = list?.result?.buckets ?? [];
    if (buckets.some((b: any) => b.name === this.bucket)) return 'exists';
    await this.call('POST', '/r2/buckets', { body: JSON.stringify({ name: this.bucket }), headers: { 'Content-Type': 'application/json' } });
    return 'created';
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.call('PUT', `/r2/buckets/${this.bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`, {
      body: new Uint8Array(body),
      headers: { 'Content-Type': contentType, 'Cache-Control': CACHE_CONTROL },
    });
  }
}

export interface UploadOptions {
  dryRun?: boolean;
  bucket?: string;
  baseUrl?: string;
  examplesDir?: string;
  fetch?: Fetch;
  account?: string;
  token?: string;
  log?: (s: string) => void;
}

export async function uploadAll(outDir: string, opts: UploadOptions = {}): Promise<{ uploaded: number; skipped: number; bucket: string }> {
  const log = opts.log ?? console.log;
  const bucket = opts.bucket ?? 'reelforge-media';
  const baseUrl = (opts.baseUrl ?? process.env.REELFORGE_GALLERY_MEDIA_URL ?? 'https://media.reelforge.buildbase.app').replace(/\/$/, '');
  const { items, manifests } = uploadItems(outDir, opts.examplesDir ?? join(import.meta.dirname, '../../../examples/gallery'));
  const ledgerFile = join(outDir, 'web', 'r2-uploaded.json');
  const ledger: Record<string, string> = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : {};
  const urls = {
    baseUrl,
    files: Object.fromEntries(items.map((i) => [i.key, `${baseUrl}/${i.key}`])),
    manifests,
  };
  writeFileSync(join(outDir, 'web', 'urls.json'), JSON.stringify(urls, null, 2));
  const todo = items.filter((i) => ledger[i.key] !== bucket);
  log(`upload: ${items.length} objects, ${todo.length} new, bucket ${bucket}, public base ${baseUrl}${opts.dryRun ? ' (dry run)' : ''}`);
  if (opts.dryRun) {
    for (const i of todo.slice(0, 8)) log(`upload: would PUT ${i.key} (${i.contentType}, ${CACHE_CONTROL})`);
    if (todo.length > 8) log(`upload: ... and ${todo.length - 8} more`);
    return { uploaded: 0, skipped: items.length - todo.length, bucket };
  }
  const account = opts.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = opts.token ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (R2 edit)');
  const r2 = new R2Rest(account, token, bucket, opts.fetch);
  const state = await r2.ensureBucket();
  log(`upload: bucket ${bucket} ${state}`);
  let uploaded = 0;
  for (const i of todo) {
    await r2.put(i.key, readFileSync(i.file), i.contentType);
    ledger[i.key] = bucket;
    uploaded++;
    if (uploaded % 25 === 0) {
      writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
      log(`upload: ${uploaded}/${todo.length}`);
    }
    // The REST API allows 1,200 R2 requests per 5 minutes per account.
    await new Promise((ok) => setTimeout(ok, 260));
  }
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  log(`upload: ${uploaded} uploaded, ${items.length - todo.length} already there`);
  return { uploaded, skipped: items.length - todo.length, bucket };
}
