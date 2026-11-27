import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { StorageDriver } from '../plugins';
import type { StorageObject } from '../plugins';
import { OUTPUT_FILE_PATTERN } from '../output-formats';
import { mapLimit, PROJECTS_PREFIX, RENDER_MANIFEST, renderPrefix, rendersPrefix, streamToBuffer, TEMP_RUN_PREFIX } from './keys';

/** One render directory as stored: complete when its manifest exists. */
export interface StoredRun {
  projectId: string;
  /** The run id, or `.tmp-<runId>` for an unfinished one. */
  runId: string;
  temp: boolean;
  complete: boolean;
  objects: number;
  bytes: number;
  keys: string[];
  /** Bytes of the delivered file (`final.*` or `frames.zip`), when the run has one (render plans, #485). */
  outputBytes?: number;
  /** When the render was committed (the manifest's write time), else the newest object's. */
  createdAt: string;
}

/** Group listed objects `projects/<id>/renders/<run>/<file>` into runs; other keys are ignored. */
export function groupRuns(objects: StorageObject[]): StoredRun[] {
  const runs = new Map<string, StoredRun>();
  for (const o of objects) {
    const m = /^projects\/([^/]+)\/renders\/([^/]+)\/(.+)$/.exec(o.key);
    if (!m) continue;
    const [, projectId, runId, file] = m as unknown as [string, string, string, string];
    const id = `${projectId}/${runId}`;
    let r = runs.get(id);
    if (!r) {
      r = { projectId, runId, temp: runId.startsWith(TEMP_RUN_PREFIX), complete: false, objects: 0, bytes: 0, keys: [], createdAt: o.modifiedAt };
      runs.set(id, r);
    }
    r.objects++;
    r.bytes += o.bytes;
    r.keys.push(o.key);
    if (OUTPUT_FILE_PATTERN.test(file)) r.outputBytes = o.bytes;
    if (file === RENDER_MANIFEST) {
      r.complete = !r.temp;
      r.createdAt = o.modifiedAt;
    } else if (!r.complete && o.modifiedAt > r.createdAt) r.createdAt = o.modifiedAt;
  }
  return [...runs.values()];
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/**
 * Renders in storage: `projects/<id>/renders/<runId>/...`, the manifest last
 * (D-067). Works on whatever driver is current.
 */
export class RenderStore {
  constructor(private readonly driver: () => StorageDriver) {}

  async listRuns(projectId: string): Promise<StoredRun[]> {
    return groupRuns(await this.driver().list(rendersPrefix(projectId)));
  }

  /** Every render of every project (also of projects whose row is gone). */
  async listAllRuns(): Promise<StoredRun[]> {
    return groupRuns(await this.driver().list(PROJECTS_PREFIX));
  }

  async exists(projectId: string, runId: string): Promise<boolean> {
    return (await this.driver().stat(renderPrefix(projectId, runId) + RENDER_MANIFEST)) !== null;
  }

  async readManifest<T>(projectId: string, runId: string): Promise<T | undefined> {
    const key = renderPrefix(projectId, runId) + RENDER_MANIFEST;
    if (!(await this.driver().stat(key))) return undefined;
    return JSON.parse((await streamToBuffer(await this.driver().get(key))).toString('utf8')) as T;
  }

  /** Delete a render: the manifest first, so a partly deleted render is never listed as complete. */
  async deleteRun(run: Pick<StoredRun, 'projectId' | 'runId' | 'keys'>): Promise<void> {
    const d = this.driver();
    const manifest = renderPrefix(run.projectId, run.runId) + RENDER_MANIFEST;
    if (run.keys.includes(manifest)) await d.delete(manifest);
    await mapLimit(run.keys.filter((k) => k !== manifest), 8, (k) => d.delete(k));
  }

  /**
   * Commit a finished render from a local directory to remote storage:
   * upload everything under `.tmp-<runId>/`, then copy to `<runId>/` with the
   * manifest last, then delete the temporary keys. An existing render is
   * never overwritten; on failure nothing partial stays behind.
   */
  async commit(localDir: string, projectId: string, runId: string): Promise<{ objects: number; bytes: number }> {
    const d = this.driver();
    const tmp = renderPrefix(projectId, TEMP_RUN_PREFIX + runId);
    const final = renderPrefix(projectId, runId);
    if (await d.stat(final + RENDER_MANIFEST)) throw new Error(`render ${runId} already exists in storage; refusing to overwrite it`);
    const files = (await walk(localDir)).map((f) => ({ path: f, rel: relative(localDir, f).split(sep).join('/') }));
    if (!files.some((f) => f.rel === RENDER_MANIFEST)) throw new Error(`no ${RENDER_MANIFEST} in ${localDir}`);
    const data = files.filter((f) => f.rel !== RENDER_MANIFEST);
    const uploaded: string[] = [];
    const committed: string[] = [];
    let bytes = 0;
    try {
      await mapLimit(files, 4, async (f) => {
        bytes += (await d.putFile(tmp + f.rel, f.path)).bytes;
        uploaded.push(tmp + f.rel);
      });
      await mapLimit(data, 4, async (f) => {
        await d.copy(tmp + f.rel, final + f.rel);
        committed.push(final + f.rel);
      });
      if (await d.stat(final + RENDER_MANIFEST)) throw new Error(`render ${runId} appeared in storage during the commit; refusing to overwrite it`);
      await d.copy(tmp + RENDER_MANIFEST, final + RENDER_MANIFEST);
    } catch (e) {
      await mapLimit([...uploaded, ...committed], 8, (k) => d.delete(k).catch(() => undefined));
      throw e;
    }
    await mapLimit(uploaded, 8, (k) => d.delete(k).catch(() => undefined));
    return { objects: files.length, bytes };
  }
}
