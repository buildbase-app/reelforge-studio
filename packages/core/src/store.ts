import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Project } from '@reelforge/project-schema';
import { ApiError, notFound } from './errors';
import { KeyedMutex } from './fsutil';
import type { ProjectMeta, ProjectRepository, StoredProject } from './repositories';

export type { ProjectMeta, StoredProject } from './repositories';

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Saves retried after losing a race to another writer (another process) before giving up. */
const MAX_SAVE_ATTEMPTS = 20;

/**
 * Projects: manifests and versions in the database (ProjectRepository), files
 * on the local filesystem:
 *
 *   <dataDir>/projects/<id>/assets/             files referenced as project://
 *   <dataDir>/projects/<id>/renders/<runId>/    render outputs
 *
 * Updates are optimistic: read version n, compute the new manifest, then save
 * it as n+1 only if the project is still at n (one transaction). Writes are
 * also serialised per project inside this process, so concurrent requests to
 * one server never conflict with each other; a write from another process
 * is retried, or reported as `version_conflict` when the caller pinned
 * `expectedVersion`.
 */
export class ProjectStore {
  readonly root: string;
  private mutex = new KeyedMutex();

  constructor(
    private readonly repo: ProjectRepository,
    dataDir: string
  ) {
    this.root = resolve(dataDir, 'projects');
  }

  private checkId(id: string): void {
    if (!ID.test(id)) throw new ApiError('bad_request', 400, `invalid project id "${id}"`);
  }

  dir(id: string): string {
    this.checkId(id);
    return join(this.root, id);
  }
  assetsDir(id: string): string {
    return join(this.dir(id), 'assets');
  }
  rendersDir(id: string): string {
    return join(this.dir(id), 'renders');
  }

  async exists(id: string): Promise<boolean> {
    this.checkId(id);
    return (await this.repo.get(id)) !== null;
  }

  async create(manifest: Project): Promise<StoredProject> {
    const id = manifest.projectId;
    this.checkId(id);
    return this.mutex.run(id, async () => {
      const now = new Date().toISOString();
      const stored: StoredProject = { meta: { id, version: 1, createdAt: now, updatedAt: now }, manifest };
      await this.repo.create(stored);
      return stored;
    });
  }

  async get(id: string): Promise<StoredProject> {
    this.checkId(id);
    const p = await this.repo.get(id);
    if (!p) throw notFound('project', id);
    return p;
  }

  async getVersion(id: string, version: number): Promise<Project> {
    this.checkId(id);
    const m = Number.isInteger(version) && version > 0 ? await this.repo.getVersion(id, version) : null;
    if (!m) throw notFound('project version', `${id}@${version}`);
    return m;
  }

  async listVersions(id: string): Promise<number[]> {
    this.checkId(id);
    return this.repo.listVersions(id);
  }

  async list(): Promise<ProjectMeta[]> {
    return (await this.repo.list()).map((p) => p.meta);
  }

  /** Every project with its current manifest (one query). */
  async listWithManifests(): Promise<StoredProject[]> {
    return this.repo.list();
  }

  /**
   * Read-modify-write. `update` receives the current manifest and returns the
   * new one (already validated by the caller). `expectedVersion` gives
   * optimistic concurrency for agents.
   */
  async update(
    id: string,
    update: (current: Project, meta: ProjectMeta) => Promise<Project> | Project,
    expectedVersion?: number
  ): Promise<StoredProject> {
    this.checkId(id);
    return this.mutex.run(id, async () => {
      for (let attempt = 1; ; attempt++) {
        const current = await this.get(id);
        if (expectedVersion !== undefined && expectedVersion !== current.meta.version) throw versionConflict(id, current.meta.version, expectedVersion);
        const manifest = await update(current.manifest, current.meta);
        if (manifest.projectId !== id) {
          throw new ApiError('bad_request', 400, `projectId cannot change (was "${id}", got "${manifest.projectId}")`);
        }
        const meta = await this.repo.saveVersion(id, current.meta.version, manifest, new Date().toISOString());
        if (meta) return { meta, manifest };
        // Another process saved first (or deleted the project).
        const now = await this.get(id);
        if (expectedVersion !== undefined || attempt >= MAX_SAVE_ATTEMPTS) throw versionConflict(id, now.meta.version, expectedVersion ?? current.meta.version);
        await new Promise((r) => setTimeout(r, Math.random() * 10 * attempt)); // jitter, so two writers stop colliding
      }
    });
  }

  async delete(id: string): Promise<void> {
    this.checkId(id);
    await this.mutex.run(id, async () => {
      if (!(await this.repo.delete(id))) throw notFound('project', id);
      await rm(this.dir(id), { recursive: true, force: true });
    });
  }
}

function versionConflict(id: string, actual: number, expected: number) {
  return new ApiError(
    'version_conflict',
    409,
    `project "${id}" is at version ${actual}, not ${expected}; fetch it again and reapply your change`
  );
}
