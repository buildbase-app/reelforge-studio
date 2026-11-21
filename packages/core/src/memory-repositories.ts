import type { Project, Theme } from '@reelforge/project-schema';
import { conflict } from './errors';
import { newId } from './fsutil';
import {
  DEFAULT_WORKSPACE_ID,
  type ApiKeyRecord,
  type AssetRecord,
  type AuditEntry,
  type JobRecord,
  type ProjectMeta,
  type ProviderSettingInfo,
  type Repositories,
  type StoredProject,
} from './repositories';

const clone = <T>(v: T): T => structuredClone(v);
const byNewest = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/**
 * In-memory repositories: same contract as the database ones, nothing on disk.
 * For unit tests and throwaway instances; data is lost when the process ends.
 */
export function createMemoryRepositories(workspaceId = DEFAULT_WORKSPACE_ID): Repositories {
  const projects = new Map<string, { meta: ProjectMeta; versions: Map<number, Project> }>();
  const keys = new Map<string, ApiKeyRecord>();
  const jobs = new Map<string, JobRecord>();
  const jobLogs = new Map<string, string[]>();
  const themes = new Map<string, Theme>();
  const settings = new Map<string, { value: string; info: ProviderSettingInfo }>();
  const assets = new Map<string, AssetRecord>();
  const audit: AuditEntry[] = [];

  return {
    workspaceId,
    projects: {
      async create(p: StoredProject) {
        if (projects.has(p.meta.id)) throw conflict(`project "${p.meta.id}" already exists; use update_project or pick another projectId`);
        projects.set(p.meta.id, { meta: clone(p.meta), versions: new Map([[p.meta.version, clone(p.manifest)]]) });
      },
      async get(id) {
        const p = projects.get(id);
        return p ? { meta: clone(p.meta), manifest: clone(p.versions.get(p.meta.version)!) } : null;
      },
      async getVersion(id, version) {
        const m = projects.get(id)?.versions.get(version);
        return m ? clone(m) : null;
      },
      async listVersions(id) {
        return [...(projects.get(id)?.versions.keys() ?? [])].sort((a, b) => a - b);
      },
      async list() {
        return [...projects.values()]
          .map((p) => ({ meta: clone(p.meta), manifest: clone(p.versions.get(p.meta.version)!) }))
          .sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt) || a.meta.id.localeCompare(b.meta.id));
      },
      async saveVersion(id, expectedVersion, manifest, updatedAt) {
        const p = projects.get(id);
        if (!p || p.meta.version !== expectedVersion) return null;
        p.meta = { ...p.meta, version: expectedVersion + 1, updatedAt };
        p.versions.set(p.meta.version, clone(manifest));
        return clone(p.meta);
      },
      async delete(id) {
        return projects.delete(id);
      },
    },
    keys: {
      async list() {
        return [...keys.values()].map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      },
      async count() {
        return keys.size;
      },
      async insert(record) {
        if (keys.has(record.id)) throw conflict(`key "${record.id}" already exists`);
        keys.set(record.id, clone(record));
      },
      async delete(id) {
        return keys.delete(id);
      },
      async findByPrefix(prefix) {
        return [...keys.values()].filter((k) => k.prefix === prefix).map(clone);
      },
      async touch(id, lastUsedAt) {
        const k = keys.get(id);
        if (k) k.lastUsedAt = lastUsedAt;
      },
    },
    jobs: {
      async insert(job) {
        if (jobs.has(job.id)) throw conflict(`job "${job.id}" already exists`);
        jobs.set(job.id, clone(job));
      },
      async update(job) {
        if (jobs.has(job.id)) jobs.set(job.id, clone(job));
      },
      async transition(job) {
        if (jobs.has(job.id)) jobs.set(job.id, clone(job));
      },
      async get(id) {
        const j = jobs.get(id);
        return j ? clone(j) : null;
      },
      async list(filter = {}) {
        return [...jobs.values()]
          .filter((j) => (!filter.projectId || j.projectId === filter.projectId) && (!filter.status || j.status === filter.status) && (!filter.type || j.type === filter.type))
          .sort(byNewest)
          .map(clone);
      },
      async listUnfinished() {
        return [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').map(clone);
      },
      async appendLog(jobId, at, line) {
        if (!jobs.has(jobId)) return;
        const lines = jobLogs.get(jobId) ?? [];
        lines.push(`${at} ${line}`);
        jobLogs.set(jobId, lines);
      },
      async logs(jobId, tail) {
        const lines = jobLogs.get(jobId) ?? [];
        return tail ? lines.slice(-tail) : [...lines];
      },
    },
    themes: {
      async list() {
        return [...themes.values()].map(clone).sort((a, b) => a.id.localeCompare(b.id));
      },
      async get(id) {
        const t = themes.get(id);
        return t ? clone(t) : null;
      },
      async insert(theme) {
        if (themes.has(theme.id)) throw conflict(`theme "${theme.id}" already exists`);
        themes.set(theme.id, clone(theme));
      },
      async put(theme) {
        themes.set(theme.id, clone(theme));
      },
      async delete(id) {
        return themes.delete(id);
      },
    },
    providerSettings: {
      async values() {
        return Object.fromEntries([...settings].map(([k, v]) => [k, v.value]));
      },
      async list() {
        return [...settings.values()].map((s) => clone(s.info)).sort((a, b) => a.name.localeCompare(b.name));
      },
      async apply(changes, at, providerId) {
        for (const [name, value] of Object.entries(changes)) {
          if (value === null) settings.delete(name);
          else {
            const keep = providerId ?? settings.get(name)?.info.providerId;
            settings.set(name, { value, info: { name, updatedAt: at, ...(keep ? { providerId: keep } : {}) } });
          }
        }
      },
    },
    assets: {
      async get(id) {
        const a = assets.get(id);
        return a ? clone(a) : null;
      },
      async insertIfAbsent(asset) {
        if (!assets.has(asset.id)) assets.set(asset.id, clone(asset));
        return clone(assets.get(asset.id)!);
      },
      async list() {
        return [...assets.values()].sort(byNewest).map(clone);
      },
      async update(id, patch) {
        const a = assets.get(id);
        if (!a) return null;
        const next = { ...a, ...clone(patch) };
        assets.set(id, next);
        return clone(next);
      },
    },
    audit: {
      async write(entry) {
        const e: AuditEntry = { id: newId('aud'), at: new Date().toISOString(), ...clone(entry) };
        audit.push(e);
        return clone(e);
      },
      async list(opts = {}) {
        return [...audit].reverse().slice(0, opts.limit ?? 100).map(clone);
      },
    },
  };
}
