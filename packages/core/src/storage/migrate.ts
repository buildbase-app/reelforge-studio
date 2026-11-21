import type { StorageDriver, StorageObject } from '../plugins';
import { ASSETS_PREFIX, mapLimit, PROJECTS_PREFIX, RENDER_MANIFEST, streamToBuffer, TEMP_RUN_PREFIX } from './keys';

export interface MigrationReport {
  from: string;
  to: string;
  dryRun: boolean;
  copied: { objects: number; bytes: number };
  skipped: { objects: number; bytes: number };
  failed: Array<{ key: string; error: string }>;
}

/** What a migration moves: assets and finished renders (not unfinished uploads, not project:// folders). */
export function isMigratable(key: string): boolean {
  if (key.startsWith(ASSETS_PREFIX)) return !/(^|\/)\.[^/]*\.tmp$/.test(key);
  const m = /^projects\/[^/]+\/renders\/([^/]+)\/[^/]/.exec(key);
  return Boolean(m && !m[1]!.startsWith(TEMP_RUN_PREFIX) && !/(^|\/)\.[^/]*\.tmp$/.test(key));
}

/**
 * Copy assets and renders from one driver to another (D-069), e.g. the data
 * directory to S3. Idempotent: an object that exists in the target with the
 * same size is skipped, so an interrupted run can simply be started again.
 * Within each render the manifest is copied last, so a render appears in the
 * target only once all its files are there. Nothing is deleted from the source.
 */
export async function migrateStorage(
  from: StorageDriver,
  to: StorageDriver,
  opts: { dryRun?: boolean; concurrency?: number; log?: (line: string) => void } = {}
): Promise<MigrationReport> {
  const report: MigrationReport = { from: from.id, to: to.id, dryRun: Boolean(opts.dryRun), copied: { objects: 0, bytes: 0 }, skipped: { objects: 0, bytes: 0 }, failed: [] };
  const objects = [...(await from.list(ASSETS_PREFIX)), ...(await from.list(PROJECTS_PREFIX))].filter((o) => isMigratable(o.key));
  const isManifest = (o: StorageObject) => o.key.endsWith(`/${RENDER_MANIFEST}`) && o.key.startsWith(PROJECTS_PREFIX);
  const failedRuns = new Set<string>();
  const runOf = (key: string) => key.split('/').slice(0, 4).join('/');
  const one = async (o: StorageObject) => {
    try {
      const existing = await to.stat(o.key);
      if (existing && existing.bytes === o.bytes) {
        report.skipped.objects++;
        report.skipped.bytes += o.bytes;
        return;
      }
      if (!opts.dryRun) {
        const local = from.localPath(o.key);
        if (local) await to.putFile(o.key, local);
        else await to.put(o.key, await streamToBuffer(await from.get(o.key)));
      }
      report.copied.objects++;
      report.copied.bytes += o.bytes;
      if (report.copied.objects % 100 === 0) opts.log?.(`  ${report.copied.objects} objects copied`);
    } catch (e) {
      report.failed.push({ key: o.key, error: (e as Error).message });
      if (o.key.startsWith(PROJECTS_PREFIX)) failedRuns.add(runOf(o.key));
    }
  };
  const n = opts.concurrency ?? 4;
  await mapLimit(objects.filter((o) => !isManifest(o)), n, one);
  // Manifests last, and only for renders whose files all arrived.
  await mapLimit(objects.filter((o) => isManifest(o) && !failedRuns.has(runOf(o.key))), n, one);
  return report;
}
