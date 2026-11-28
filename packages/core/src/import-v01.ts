import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Project, Theme } from '@renderweld/project-schema';
import { ApiError } from './errors';
import { readJson } from './fsutil';
import type { StoredAsset } from './plugins';
import type { ApiKeyRecord, JobRecord, ProjectMeta, Repositories } from './repositories';

/**
 * Importer for the v0.1 filesystem layout (before the database, D-017 of
 * agent platform v0.1):
 *
 *   projects/<id>/{meta.json, project.json, versions/<NNNNNN>.json}
 *   keys.json, themes/<id>.json, secrets.json
 *   jobs/<id>.json + jobs/<id>.log
 *   assets/<id>/meta.json (+ the file, which stays where it is)
 *
 * Idempotent: rows that already exist are skipped, so running it twice (or
 * after a crash half way) never duplicates or overwrites anything. Nothing on
 * disk is changed or deleted: the old JSON files remain as a backup, and
 * binary files (assets, renders) stay in place because the storage layout is
 * unchanged.
 */

export interface ImportReport {
  projects: number;
  versions: number;
  keys: number;
  themes: number;
  jobs: number;
  logLines: number;
  assets: number;
  providerSettings: number;
  skipped: number;
  warnings: string[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const isConflict = (e: unknown) => e instanceof ApiError && e.code === 'conflict';

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** True if the directory holds anything the importer would read. */
export function hasFilesystemData(dataDir: string): boolean {
  const d = resolve(dataDir);
  return ['projects', 'keys.json', 'themes', 'jobs', 'assets', 'secrets.json'].some((p) => existsSync(join(d, p)));
}

export async function importFilesystemV01(repos: Repositories, dataDir: string, log: (line: string) => void = () => undefined): Promise<ImportReport> {
  const root = resolve(dataDir);
  const r: ImportReport = { projects: 0, versions: 0, keys: 0, themes: 0, jobs: 0, logLines: 0, assets: 0, providerSettings: 0, skipped: 0, warnings: [] };
  const warn = (w: string) => {
    r.warnings.push(w);
    log(`warning: ${w}`);
  };

  // ---- projects + versions
  for (const id of (await listDir(join(root, 'projects'))).filter((i) => ID.test(i))) {
    const dir = join(root, 'projects', id);
    const meta = await readJson<ProjectMeta>(join(dir, 'meta.json')).catch(() => undefined);
    if (!meta) continue; // a directory with only assets/renders, or not a project
    if (await repos.projects.get(id)) {
      r.skipped++;
      continue;
    }
    const versions: Array<{ n: number; manifest: Project }> = [];
    for (const f of (await listDir(join(dir, 'versions'))).filter((x) => /^\d{6}\.json$/.test(x))) {
      const m = await readJson<Project>(join(dir, 'versions', f)).catch(() => undefined);
      if (m) versions.push({ n: Number(f.slice(0, 6)), manifest: m });
    }
    versions.sort((a, b) => a.n - b.n);
    const current = await readJson<Project>(join(dir, 'project.json')).catch(() => undefined);
    const contiguous = versions.length > 0 && versions.every((v, i) => v.n === i + 1) && versions.at(-1)!.n === meta.version;
    if (!contiguous) {
      warn(`project "${id}": versions on disk are not 1..${meta.version}; importing what exists in order${current ? ' and the current manifest last' : ''}`);
      if (current && JSON.stringify(versions.at(-1)?.manifest) !== JSON.stringify(current)) versions.push({ n: versions.length + 1, manifest: current });
    }
    if (!versions.length) {
      warn(`project "${id}": no manifest found; skipped`);
      continue;
    }
    try {
      const first = versions[0]!;
      await repos.projects.create({ meta: { id, version: 1, createdAt: meta.createdAt, updatedAt: versions.length === 1 ? meta.updatedAt : meta.createdAt }, manifest: first.manifest });
      for (let i = 1; i < versions.length; i++) {
        const last = i === versions.length - 1;
        const saved = await repos.projects.saveVersion(id, i, versions[i]!.manifest, last ? meta.updatedAt : meta.createdAt);
        if (!saved) throw new Error(`version ${i + 1} could not be stored`);
      }
      r.projects++;
      r.versions += versions.length;
    } catch (e) {
      if (isConflict(e)) r.skipped++;
      else throw e;
    }
  }

  // ---- API keys (salted hashes are kept, so existing keys keep working)
  const keys = (await readJson<ApiKeyRecord[]>(join(root, 'keys.json')).catch(() => undefined)) ?? [];
  const haveKeys = new Set((await repos.keys.list()).map((k) => k.id));
  for (const k of keys) {
    if (haveKeys.has(k.id)) {
      r.skipped++;
      continue;
    }
    try {
      // v0.1 admin keys ran the whole install: they keep that as the instance-level owner scope (#304).
      await repos.keys.insert(k.scopes.includes('admin') && !k.scopes.includes('owner') ? { ...k, scopes: [...k.scopes, 'owner'] } : k);
      r.keys++;
    } catch (e) {
      if (isConflict(e)) r.skipped++;
      else throw e;
    }
  }

  // ---- themes
  for (const f of (await listDir(join(root, 'themes'))).filter((x) => x.endsWith('.json'))) {
    const t = await readJson<Theme>(join(root, 'themes', f)).catch(() => undefined);
    if (!t?.id) continue;
    if (await repos.themes.get(t.id)) {
      r.skipped++;
      continue;
    }
    const at = (await stat(join(root, 'themes', f))).mtime.toISOString();
    try {
      await repos.themes.insert(t, at);
      r.themes++;
    } catch (e) {
      if (isConflict(e)) r.skipped++;
      else throw e;
    }
  }

  // ---- provider settings (values already in the database win)
  const secrets = (await readJson<Record<string, string>>(join(root, 'secrets.json')).catch(() => undefined)) ?? {};
  const haveSettings = await repos.providerSettings.values();
  const newSettings = Object.fromEntries(Object.entries(secrets).filter(([k, v]) => typeof v === 'string' && !(k in haveSettings)));
  if (Object.keys(newSettings).length) {
    const at = (await stat(join(root, 'secrets.json'))).mtime.toISOString();
    // Plain text, as v0.1 stored it; encrypted on the next start with RENDERWELD_SECRET_KEY (RuntimeConfig.encryptPlaintext).
    await repos.providerSettings.apply(Object.fromEntries(Object.entries(newSettings).map(([k, v]) => [k, { value: v, scheme: 'plain' }])), at);
    r.providerSettings = Object.keys(newSettings).length;
  }

  // ---- jobs + logs
  for (const f of (await listDir(join(root, 'jobs'))).filter((x) => x.endsWith('.json'))) {
    const job = await readJson<JobRecord>(join(root, 'jobs', f)).catch(() => undefined);
    if (!job?.id) continue;
    if (await repos.jobs.get(job.id)) {
      r.skipped++;
      continue;
    }
    try {
      await repos.jobs.insert(job, job.finishedAt ?? job.startedAt ?? job.createdAt);
    } catch (e) {
      if (isConflict(e)) {
        r.skipped++;
        continue;
      }
      throw e;
    }
    r.jobs++;
    let text = '';
    try {
      text = await readFile(join(root, 'jobs', `${job.id}.log`), 'utf8');
    } catch {
      // no log
    }
    let lastAt = job.createdAt;
    for (const line of text.split('\n').filter(Boolean)) {
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/.exec(line);
      if (m) lastAt = m[1]!;
      await repos.jobs.appendLog(job.id, lastAt, m ? m[2]! : line);
      r.logLines++;
    }
  }

  // ---- asset metadata (bytes stay in <data>/assets/<id>/)
  for (const id of (await listDir(join(root, 'assets'))).filter((x) => /^ast-[0-9a-f]{16}$/.test(x))) {
    const meta = await readJson<StoredAsset>(join(root, 'assets', id, 'meta.json')).catch(() => undefined);
    if (!meta) continue;
    const file = (await listDir(join(root, 'assets', id))).find((x) => x.startsWith('file.'));
    if (!file) {
      warn(`asset ${id}: metadata without a file; skipped`);
      continue;
    }
    if (await repos.assets.get(id)) {
      r.skipped++;
      continue;
    }
    await repos.assets.insertIfAbsent({ ...meta, storageKey: `${id}/${file}` });
    r.assets++;
  }

  return r;
}
