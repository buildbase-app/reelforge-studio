/**
 * `pnpm gallery publish`: upserts one record per reel into the BuildBase
 * Collection `gallery` (Records API, org API token), from each reel's
 * meta.json and the web media list. Idempotent: records are matched by slug
 * and only changed fields are sent; running it twice changes nothing.
 *
 * Records hold metadata and media *paths* (`gallery/<slug>/<file>.<hash>.mp4`),
 * not absolute URLs: the store joins them with its configured media base URL
 * (an R2 custom domain today, a Worker route or a local static server for a
 * preview), so moving the media never means rewriting records. Posters stay
 * on R2 next to the videos too: BuildBase assets take images only (no video)
 * and no AVIF, and one immutable, hashed media origin keeps the store's CSP to
 * a single extra host.
 *
 * A record is `published` only when its media answers at the media base URL
 * (checked with HEAD before publishing; `--status` forces it). Until R2 is
 * live, every record is written `hidden`.
 *
 * Token: BUILDBASE_API_TOKEN (`<orgId>:<secret>`) or BUILDBASE_API_TOKEN_FILE.
 * Server: BUILDBASE_SERVER_URL (default https://api.console.buildbase.app).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Meta } from './render';
import { readMedia, type MediaEntry } from './transcode';

export const COLLECTION_SLUG = 'gallery';

type FieldType = 'text' | 'number' | 'integer' | 'bool' | 'date' | 'select' | 'multi-select' | 'link';

export interface FieldDef {
  slug: string;
  title: string;
  type: FieldType;
  required?: boolean;
  helpText?: string;
  options?: { value: string; label: string }[];
  max?: number;
}

/** The gallery schema (collection version v1). */
export const GALLERY_FIELDS: FieldDef[] = [
  { slug: 'title', title: 'Title', type: 'text', required: true, max: 120 },
  { slug: 'slug', title: 'Slug', type: 'text', required: true, max: 63, helpText: 'URL part of /gallery/<slug>; matches examples/gallery/<slug>.json in the studio' },
  { slug: 'description', title: 'Description', type: 'text', max: 400 },
  { slug: 'category', title: 'Category', type: 'text', required: true, max: 60 },
  { slug: 'tags', title: 'Tags', type: 'text', max: 400, helpText: 'Comma separated' },
  {
    slug: 'engines',
    title: 'Engines',
    type: 'multi-select',
    options: [
      { value: 'remotion', label: 'Remotion' },
      { value: 'motion-canvas', label: 'Motion Canvas' },
      { value: 'html', label: 'HTML' },
      { value: 'hyperframes', label: 'HyperFrames' },
    ],
  },
  { slug: 'theme', title: 'Theme', type: 'text', max: 120 },
  { slug: 'durationSeconds', title: 'Duration (s)', type: 'number' },
  { slug: 'frames', title: 'Frames', type: 'integer' },
  { slug: 'fps', title: 'FPS', type: 'integer' },
  { slug: 'renderSeconds', title: 'Render time (s)', type: 'number', helpText: 'Wall clock of the studio render (render-manifest wallClockMillis)' },
  { slug: 'hardware', title: 'Hardware', type: 'text', max: 200 },
  { slug: 'studioVersion', title: 'Studio version', type: 'text', max: 60 },
  { slug: 'engineVersions', title: 'Engine versions', type: 'text', max: 400 },
  { slug: 'renderedAt', title: 'Rendered at', type: 'date' },
  { slug: 'prompt', title: 'Agent prompt', type: 'text', max: 2000 },
  { slug: 'tools', title: 'MCP tools called', type: 'text', max: 600, helpText: 'Comma separated, in first-call order' },
  { slug: 'mcpCalls', title: 'MCP calls', type: 'integer' },
  { slug: 'manifestHash', title: 'Manifest sha256', type: 'text', max: 64 },
  { slug: 'manifestPath', title: 'Manifest path', type: 'text', max: 300 },
  { slug: 'posterPath', title: 'Poster (JPEG) path', type: 'text', max: 300 },
  { slug: 'posterAvifPath', title: 'Poster (AVIF) path', type: 'text', max: 300 },
  { slug: 'posterSmallPath', title: 'Small poster (JPEG) path', type: 'text', max: 300 },
  { slug: 'posterSmallAvifPath', title: 'Small poster (AVIF) path', type: 'text', max: 300 },
  { slug: 'mp4Path', title: 'MP4 path', type: 'text', max: 300 },
  { slug: 'webmPath', title: 'WebM path', type: 'text', max: 300 },
  { slug: 'mp4Bytes', title: 'MP4 bytes', type: 'integer' },
  {
    slug: 'status',
    title: 'Status',
    type: 'select',
    required: true,
    options: [
      { value: 'published', label: 'Published' },
      { value: 'hidden', label: 'Hidden' },
    ],
  },
  { slug: 'featured', title: 'Featured', type: 'bool' },
  { slug: 'order', title: 'Order', type: 'integer', helpText: 'Lower first' },
];

/** The field list as the versions API takes it. */
export function apiFields(): Record<string, unknown>[] {
  return GALLERY_FIELDS.map((f) => ({
    slug: f.slug,
    title: f.title,
    helpText: f.helpText ?? '',
    type: f.type,
    required: Boolean(f.required),
    defaultValue: f.type === 'bool' ? false : '',
    ...(f.options ? { options: f.options } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
  }));
}

export interface GalleryRecordData {
  [k: string]: unknown;
  slug: string;
  status: 'published' | 'hidden';
}

/** "Intel Xeon @ 2.10GHz, 4 cores, 16 GB RAM": readable, without trademark marks or kernel versions. */
export function hardwareLabel(h: Meta['hardware']): string {
  const cpu = h.cpu
    .replace(/\((R|TM)\)/gi, '')
    .replace(/\b(CPU|Processor)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${cpu}, ${h.cores} cores, ${h.ramGb} GB RAM`;
}

/** One record's data from a reel's meta and media entry. */
export function recordData(meta: Meta, media: MediaEntry | undefined, manifestPath: string | undefined, order: number, status: 'published' | 'hidden'): GalleryRecordData {
  const engineVersions = Object.entries(meta.engineVersions ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');
  return {
    title: meta.title,
    slug: meta.slug,
    description: meta.description,
    category: meta.category,
    tags: meta.tags.join(', '),
    engines: meta.engines,
    theme: meta.theme,
    durationSeconds: meta.durationSeconds,
    frames: meta.frames,
    fps: meta.fps,
    renderSeconds: meta.renderSeconds,
    hardware: hardwareLabel(meta.hardware),
    studioVersion: meta.studioVersion,
    engineVersions: engineVersions.slice(0, 400),
    renderedAt: meta.renderedAt,
    prompt: meta.prompt.slice(0, 2000),
    tools: meta.toolsCalled.join(', '),
    mcpCalls: meta.mcpCalls,
    manifestHash: meta.manifestHash,
    manifestPath: manifestPath ?? '',
    posterPath: media?.poster.jpg.key ?? '',
    posterAvifPath: media?.poster.avif.key ?? '',
    posterSmallPath: media?.poster.jpg360.key ?? '',
    posterSmallAvifPath: media?.poster.avif360.key ?? '',
    mp4Path: media?.mp4.key ?? '',
    webmPath: media?.webm.key ?? '',
    mp4Bytes: media?.mp4.bytes ?? 0,
    status,
    featured: meta.featured,
    order,
  };
}

/** Fields whose value differs (what a PATCH needs to send). */
export function diffRecord(current: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    const c = current[k];
    const same = Array.isArray(v) ? JSON.stringify([...(c as unknown[] ?? [])].sort()) === JSON.stringify([...v].sort()) : k === 'renderedAt' ? c !== undefined && new Date(String(c)).getTime() === new Date(String(v)).getTime() : c === v || (c === undefined && v === '');
    if (!same) out[k] = v;
  }
  return out;
}

export type Fetch = typeof fetch;

export class BuildBaseCollections {
  constructor(
    private server: string,
    private token: string,
    private f: Fetch = fetch
  ) {}

  async req(method: string, path: string, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${this.server}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-BuildBase-Client': 'reelforge-gallery' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 4) {
        await new Promise((ok) => setTimeout(ok, 1000 * Number(res.headers.get('retry-after') ?? 2)));
        continue;
      }
      const text = await res.text();
      let data: any = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* plain text */
      }
      if (!res.ok) throw new Error(`BuildBase ${method} ${path} -> ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 600)}`);
      return data;
    }
  }

  /** The collection and its live version, created (v1 with the gallery fields, live) when missing. */
  async ensureCollection(dryRun = false): Promise<{ collectionId: string; versionId: string; created: boolean }> {
    const list = await this.req('GET', '/api/collections?limit=100');
    let col = (list.docs ?? []).find((c: any) => c.slug === COLLECTION_SLUG);
    let created = false;
    if (!col) {
      if (dryRun) return { collectionId: '(new)', versionId: '(new)', created: true };
      col = await this.req('POST', '/api/collections', { name: 'Gallery', slug: COLLECTION_SLUG });
      created = true;
    }
    const versions = await this.req('GET', `/api/collections/${col._id}/versions`);
    const vdocs: any[] = Array.isArray(versions) ? versions : (versions.docs ?? []);
    let live = vdocs.find((v) => v.live);
    if (!live) {
      if (dryRun) return { collectionId: col._id, versionId: '(new)', created };
      const draft = vdocs.find((v) => !v.live && !v.deprecated) ?? (await this.req('POST', `/api/collections/${col._id}/versions`, { name: 'v1' }));
      await this.req('PATCH', `/api/collections/${col._id}/versions/${draft._id}`, { fields: apiFields() });
      live = await this.req('PATCH', `/api/collections/${col._id}/versions/${draft._id}`, { live: true });
      live = { ...draft, ...live, _id: draft._id };
    } else {
      const full = await this.req('GET', `/api/collections/${col._id}/versions/${live._id}`);
      const have = new Set((full.fields ?? []).map((f: any) => f.slug));
      const missing = GALLERY_FIELDS.filter((f) => !have.has(f.slug)).map((f) => f.slug);
      if (missing.length) throw new Error(`the live version of "${COLLECTION_SLUG}" lacks fields ${missing.join(', ')}: publish a new version with them (docs/GALLERY.md)`);
    }
    return { collectionId: col._id, versionId: live._id, created };
  }

  async records(): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; ; page++) {
      const r = await this.req('GET', `/api/collections/data/${COLLECTION_SLUG}?latest=true&$page=${page}&$limit=200`);
      out.push(...(r.docs ?? []));
      if (!r.hasNextPage) return out;
    }
  }
}

async function isLive(baseUrl: string, path: string, f: Fetch): Promise<boolean> {
  if (!path) return false;
  try {
    const r = await f(`${baseUrl.replace(/\/$/, '')}/${path}`, { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

export interface PublishOptions {
  dryRun?: boolean;
  baseUrl?: string;
  status?: 'published' | 'hidden';
  fetch?: Fetch;
  server?: string;
  token?: string;
  log?: (s: string) => void;
}

export async function publishAll(outDir: string, opts: PublishOptions = {}): Promise<{ created: number; updated: number; unchanged: number; published: number; hidden: number }> {
  const log = opts.log ?? console.log;
  const f = opts.fetch ?? fetch;
  const token = opts.token ?? process.env.BUILDBASE_API_TOKEN ?? (process.env.BUILDBASE_API_TOKEN_FILE ? readFileSync(process.env.BUILDBASE_API_TOKEN_FILE, 'utf8').trim() : '');
  if (!token) throw new Error('set BUILDBASE_API_TOKEN or BUILDBASE_API_TOKEN_FILE (an org API token of the environment to publish to)');
  const server = opts.server ?? process.env.BUILDBASE_SERVER_URL ?? 'https://api.console.buildbase.app';
  const baseUrl = opts.baseUrl ?? process.env.RENDERWELD_GALLERY_MEDIA_URL ?? 'https://media.reelforge.buildbase.app';
  const media = readMedia(outDir);
  const urls = existsSync(join(outDir, 'web', 'urls.json')) ? JSON.parse(readFileSync(join(outDir, 'web', 'urls.json'), 'utf8')) : { manifests: {} };
  const bb = new BuildBaseCollections(server, token, f);
  const { collectionId, versionId, created } = await bb.ensureCollection(opts.dryRun);
  log(`publish: collection "${COLLECTION_SLUG}" ${created ? 'created' : 'found'} (version ${versionId})`);
  const existing = created || opts.dryRun && collectionId === '(new)' ? [] : await bb.records();
  const bySlug = new Map(existing.map((r: any) => [r.data?.slug, r]));
  const slugs = Object.keys(media).sort();
  // Order: featured first, then catalog order is not known here, so by category and title.
  const metas = slugs.map((s) => JSON.parse(readFileSync(join(outDir, s, 'meta.json'), 'utf8')) as Meta);
  metas.sort((a, b) => Number(b.featured) - Number(a.featured) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  const res = { created: 0, updated: 0, unchanged: 0, published: 0, hidden: 0 };
  for (const [i, meta] of metas.entries()) {
    const m = media[meta.slug];
    const live = opts.status ? opts.status === 'published' : (await isLive(baseUrl, m?.mp4.key ?? '', f)) && (await isLive(baseUrl, m?.poster.jpg.key ?? '', f));
    const status = live ? 'published' : 'hidden';
    res[status]++;
    const data = recordData(meta, m, urls.manifests?.[meta.slug], (i + 1) * 10, status);
    const cur = bySlug.get(meta.slug);
    if (!cur) {
      if (!opts.dryRun) await bb.req('POST', `/api/collections/${collectionId}/versions/${versionId}/records`, data);
      res.created++;
      log(`publish: + ${meta.slug} (${status})`);
    } else {
      const patch = diffRecord(cur.data ?? {}, data);
      if (!Object.keys(patch).length) {
        res.unchanged++;
        continue;
      }
      if (!opts.dryRun) await bb.req('PATCH', `/api/collections/${collectionId}/versions/${cur.versionId ?? versionId}/records/${cur._id}`, patch);
      res.updated++;
      log(`publish: ~ ${meta.slug} (${Object.keys(patch).join(', ')})`);
    }
  }
  writeFileSync(join(outDir, 'publish-report.json'), JSON.stringify({ at: new Date().toISOString(), server, baseUrl, dryRun: Boolean(opts.dryRun), ...res }, null, 2));
  log(`publish: ${res.created} created, ${res.updated} updated, ${res.unchanged} unchanged; ${res.published} published, ${res.hidden} hidden${opts.dryRun ? ' (dry run)' : ''}`);
  return res;
}
