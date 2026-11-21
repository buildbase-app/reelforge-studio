import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Project } from '@reelforge/project-schema';
import { ApiError, conflict, notFound } from './errors';
import { KeyedMutex, readJson, writeJsonAtomic } from './fsutil';

export interface ProjectMeta {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredProject {
  meta: ProjectMeta;
  manifest: Project;
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Projects on the local filesystem:
 *
 *   <dataDir>/projects/<id>/project.json        current manifest (latest schema)
 *   <dataDir>/projects/<id>/meta.json           version counter and timestamps
 *   <dataDir>/projects/<id>/versions/<n>.json   every saved version
 *   <dataDir>/projects/<id>/assets/             files referenced as project://
 *   <dataDir>/projects/<id>/renders/<runId>/    render outputs
 *
 * Writes are atomic (temp file + rename) and serialised per project.
 */
export class ProjectStore {
  readonly root: string;
  private mutex = new KeyedMutex();

  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'projects');
  }

  dir(id: string): string {
    if (!ID.test(id)) throw new ApiError('bad_request', 400, `invalid project id "${id}"`);
    return join(this.root, id);
  }
  assetsDir(id: string): string {
    return join(this.dir(id), 'assets');
  }
  rendersDir(id: string): string {
    return join(this.dir(id), 'renders');
  }

  async exists(id: string): Promise<boolean> {
    try {
      return (await stat(join(this.dir(id), 'project.json'))).isFile();
    } catch {
      return false;
    }
  }

  async create(manifest: Project): Promise<StoredProject> {
    const id = manifest.projectId;
    return this.mutex.run(id, async () => {
      if (await this.exists(id)) throw conflict(`project "${id}" already exists; use update_project or pick another projectId`);
      const now = new Date().toISOString();
      const meta: ProjectMeta = { id, version: 1, createdAt: now, updatedAt: now };
      await mkdir(join(this.dir(id), 'assets'), { recursive: true });
      await this.write(id, meta, manifest);
      return { meta, manifest };
    });
  }

  async get(id: string): Promise<StoredProject> {
    const dir = this.dir(id);
    const [meta, manifest] = await Promise.all([
      readJson<ProjectMeta>(join(dir, 'meta.json')),
      readJson<Project>(join(dir, 'project.json')),
    ]);
    if (!meta || !manifest) throw notFound('project', id);
    return { meta, manifest };
  }

  async getVersion(id: string, version: number): Promise<Project> {
    const m = await readJson<Project>(join(this.dir(id), 'versions', `${String(version).padStart(6, '0')}.json`));
    if (!m) throw notFound('project version', `${id}@${version}`);
    return m;
  }

  async listVersions(id: string): Promise<number[]> {
    try {
      const files = await readdir(join(this.dir(id), 'versions'));
      return files.filter((f) => /^\d{6}\.json$/.test(f)).map((f) => Number(f.slice(0, 6))).sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  async list(): Promise<ProjectMeta[]> {
    let ids: string[];
    try {
      ids = await readdir(this.root);
    } catch {
      return [];
    }
    const metas: ProjectMeta[] = [];
    for (const id of ids.filter((i) => ID.test(i))) {
      const meta = await readJson<ProjectMeta>(join(this.root, id, 'meta.json'));
      if (meta) metas.push(meta);
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Read-modify-write under the project lock. `update` receives the current
   * manifest and returns the new one (already validated by the caller).
   * `expectedVersion` gives optimistic concurrency for agents.
   */
  async update(
    id: string,
    update: (current: Project, meta: ProjectMeta) => Promise<Project> | Project,
    expectedVersion?: number
  ): Promise<StoredProject> {
    return this.mutex.run(id, async () => {
      const current = await this.get(id);
      if (expectedVersion !== undefined && expectedVersion !== current.meta.version) {
        throw new ApiError(
          'version_conflict',
          409,
          `project "${id}" is at version ${current.meta.version}, not ${expectedVersion}; fetch it again and reapply your change`
        );
      }
      const manifest = await update(current.manifest, current.meta);
      if (manifest.projectId !== id) {
        throw new ApiError('bad_request', 400, `projectId cannot change (was "${id}", got "${manifest.projectId}")`);
      }
      const meta: ProjectMeta = { ...current.meta, version: current.meta.version + 1, updatedAt: new Date().toISOString() };
      await this.write(id, meta, manifest);
      return { meta, manifest };
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutex.run(id, async () => {
      if (!(await this.exists(id))) throw notFound('project', id);
      await rm(this.dir(id), { recursive: true, force: true });
    });
  }

  private async write(id: string, meta: ProjectMeta, manifest: Project) {
    const dir = this.dir(id);
    await writeJsonAtomic(join(dir, 'versions', `${String(meta.version).padStart(6, '0')}.json`), manifest);
    await writeJsonAtomic(join(dir, 'project.json'), manifest);
    await writeJsonAtomic(join(dir, 'meta.json'), meta);
  }
}
