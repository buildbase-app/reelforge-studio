import { effectiveQueueMode, type ResolvedConfig } from '@reelforge/core';
import { parseDatabaseUrl } from '@reelforge/db';

/**
 * Start-up guard for more than one instance (D-076). The `api` and `worker`
 * roles exist to run several instances against one database and one storage;
 * on SQLite (one file owned by one host) or per-instance local storage they
 * would silently lose jobs or files, so they refuse to start and say why.
 * Returns the problems (empty: fine) and warnings.
 */
export function scalingProblems(resolved: ResolvedConfig, databaseUrl: string): { errors: string[]; warnings: string[] } {
  const c = resolved.config;
  const role = c.server.role;
  const mode = effectiveQueueMode(role, c.queue.driver);
  const errors: string[] = [];
  const warnings: string[] = [];
  let kind: string;
  try {
    kind = parseDatabaseUrl(databaseUrl).kind;
  } catch {
    return { errors, warnings }; // a bad URL is reported by the database layer with its own message
  }
  if (role !== 'all') {
    const fix = 'or use server.role "all" for a single instance (docs/providers/queue-and-scaling.md)';
    if (kind === 'sqlite') {
      errors.push(
        `server.role "${role}" needs a shared database: SQLite is one file that only one instance can own. Set REELFORGE_DATABASE_URL (or DATABASE_URL_FILE) to postgresql://... or mysql://..., ${fix}`
      );
    }
    if (mode !== 'database') {
      errors.push(`server.role "${role}" needs the database job queue, but queue.driver is "${c.queue.driver}": set REELFORGE_QUEUE_DRIVER=database (or auto), ${fix}`);
    }
    if (c.storage.driver === 'local' && !c.storage.localShared) {
      errors.push(
        `server.role "${role}" needs storage every instance can read: storage.driver is "local", so each instance would only see its own files. Use storage.driver s3, azure or gcs, or, if ${c.storage.dataDir} is one shared volume (NFS, EFS, Azure Files, a ReadWriteMany volume) mounted by every instance, set REELFORGE_STORAGE_LOCAL_SHARED=true; ${fix}`
      );
    }
  } else if (mode === 'database' && kind === 'sqlite') {
    warnings.push('queue.driver "database" on SQLite: claims are atomic, but SQLite supports one instance only (use PostgreSQL or MySQL to run several)');
  }
  return { errors, warnings };
}
