// Uploads the captured images to BuildBase Assets (images only), idempotently:
// names carry the key and a content hash, the committed manifest maps key ↔
// asset, a re-run skips what is there and replaces what changed (the old
// asset is deleted, so nothing piles up). Same token rules as the docs sync.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTokenEnvironment, readToken } from '../docs/sync-buildbase.mjs';
import { ASSET_PREFIX, applyUploadResults, planUploads, sha256 } from './lib.mjs';

export const DEFAULT_SERVER_URL = 'https://api.console.buildbase.app';

/** A thin client for the org API's asset routes. */
export function createAssetsApi({ serverUrl = DEFAULT_SERVER_URL, token, fetchImpl = fetch }) {
  const base = serverUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'reelforge-capture' };
  async function call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${base}/api/${path}`, { method, headers, body });
      const text = await res.text();
      // Only reads and deletes are repeated; an upload is retried only when refused before it ran (429).
      if ((res.status === 429 || (method !== 'POST' && res.status >= 500)) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (!res.ok) throw new Error(`${method} /api/${path.split('?')[0]}: HTTP ${res.status} ${typeof parsed === 'object' ? parsed?.message ?? parsed?.code ?? '' : String(parsed).slice(0, 120)}`);
      return parsed;
    }
  }
  return {
    /** Every asset whose name starts with the capture prefix. */
    async listCaptureAssets() {
      const out = [];
      const filter = encodeURIComponent(JSON.stringify({ name: { $regex: `^${ASSET_PREFIX}` } }));
      for (let page = 1; page <= 50; page++) {
        const body = await call('GET', `assets?$limit=500&$page=${page}&filter=${filter}`);
        out.push(...(body?.docs ?? []));
        if (!body?.hasNextPage) break;
      }
      return out;
    },
    async upload(file, name, type = 'image/webp') {
      const form = new FormData();
      form.append('file', new Blob([readFileSync(file)], { type }), name);
      form.append('public', 'true');
      const body = await call('POST', 'assets', form);
      const asset = body?.file?.[0];
      if (!asset?._id) throw new Error(`upload of ${name}: no asset in the answer`);
      return asset;
    },
    delete: (id) => call('DELETE', `assets/${id}`),
  };
}

/** The manifest entry fields that come from BuildBase. */
const entryFrom = (asset, sha) => ({ assetId: asset._id, url: asset.bucket?.url, assetName: asset.name, sha256: sha });

/**
 * Syncs local images (from this run, or every manifest entry whose file is
 * still on disk) to BuildBase Assets and returns the updated manifest.
 */
export async function syncAssets({ api, local, manifest, dryRun = false, log = console.log }) {
  const remote = await api.listCaptureAssets();
  const actions = planUploads(local, manifest, remote);
  const count = (t) => actions.filter((a) => a.type === t).length;
  log(`assets: ${local.length} images — ${count('skip')} unchanged, ${count('reuse')} found by hash, ${count('upload')} to upload, ${count('delete')} old to delete (${remote.length} capture assets in BuildBase)`);
  if (dryRun) {
    for (const a of actions) if (a.type !== 'skip') log(`  [dry run] ${a.type} ${a.key}${a.name ? ` as ${a.name}` : ''}`);
    return { manifest, actions };
  }
  const results = [];
  const shaOf = new Map(local.map((l) => [l.key, l.sha256]));
  for (const a of actions) {
    if (a.type === 'upload') {
      const asset = await api.upload(a.file, a.name);
      results.push({ type: 'upload', key: a.key, entry: entryFrom(asset, a.sha256) });
      log(`  uploaded ${a.name}`);
    } else if (a.type === 'reuse') {
      results.push({ type: 'reuse', key: a.key, entry: entryFrom(a.asset, shaOf.get(a.key)) });
    }
  }
  // Delete replaced assets only after the new ones are in place.
  for (const a of actions.filter((x) => x.type === 'delete')) {
    try {
      await api.delete(a.assetId);
      results.push(a);
      log(`  deleted the replaced asset of ${a.key}`);
    } catch (e) {
      log(`  could not delete the replaced asset of ${a.key}: ${e.message}`);
    }
  }
  return { manifest: applyUploadResults(manifest, results), actions };
}

/** The token, checked against the dev environment key the capture uploads to. */
export function assetToken(envKey, env = process.env) {
  const token = readToken(env);
  if (!token) throw new Error('--upload needs BUILDBASE_API_TOKEN or BUILDBASE_API_TOKEN_FILE (the development environment token)');
  checkTokenEnvironment(token, envKey, env.BUILDBASE_ORG_ID);
  return token;
}

/** Manifest entries whose image is on disk (under <out>/images) with the same content. */
export function localFromManifest(manifest, outDir) {
  const local = [];
  for (const [key, e] of Object.entries(manifest.images ?? {})) {
    const file = join(outDir, 'images', `${key}.webp`);
    if (!e.sha256 || !existsSync(file) || sha256(readFileSync(file)) !== e.sha256) continue;
    local.push({ key, sha256: e.sha256, file });
  }
  return local;
}
