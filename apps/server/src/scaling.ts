import { effectiveQueueMode, type ResolvedConfig } from '@renderweld/core';
import { parseDatabaseUrl } from '@renderweld/db';

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
        `server.role "${role}" needs a shared database: SQLite is one file that only one instance can own. Set RENDERWELD_DATABASE_URL (or DATABASE_URL_FILE) to postgresql://... or mysql://..., ${fix}`
      );
    }
    if (mode !== 'database') {
      errors.push(`server.role "${role}" needs the database job queue, but queue.driver is "${c.queue.driver}": set RENDERWELD_QUEUE_DRIVER=database (or auto), ${fix}`);
    }
    if (c.storage.driver === 'local' && !c.storage.localShared) {
      errors.push(
        `server.role "${role}" needs storage every instance can read: storage.driver is "local", so each instance would only see its own files. Use storage.driver s3, azure or gcs, or, if ${c.storage.dataDir} is one shared volume (NFS, EFS, Azure Files, a ReadWriteMany volume) mounted by every instance, set RENDERWELD_STORAGE_LOCAL_SHARED=true; ${fix}`
      );
    }
  } else if (mode === 'database' && kind === 'sqlite') {
    warnings.push('queue.driver "database" on SQLite: claims are atomic, but SQLite supports one instance only (use PostgreSQL or MySQL to run several)');
  }
  // Queue dispatch (D-105): LISTEN/NOTIFY exists only on PostgreSQL.
  if (c.queue.dispatch === 'notify') {
    if (kind !== 'postgresql') {
      errors.push(
        `queue.dispatch "notify" needs PostgreSQL (LISTEN/NOTIFY), but the database is ${kind === 'mysql' ? 'MySQL/MariaDB' : 'SQLite'}: set RENDERWELD_QUEUE_DISPATCH=poll (idle polls back off up to queue.pollMaxIntervalMs) or move to PostgreSQL (docs/providers/queue-and-scaling.md)`
      );
    } else if (mode !== 'database') {
      warnings.push('queue.dispatch "notify" has no effect with the in-process queue (queue.driver resolves to "inprocess"); it applies to the database queue only');
    }
  }
  // Broker dispatch (D-105): the broker must be named; any database works (the outbox is a table).
  if (c.queue.dispatch === 'sqs' && !c.queue.sqs.queueUrl) {
    errors.push('queue.dispatch "sqs" needs queue.sqs.queueUrl (RENDERWELD_QUEUE_SQS_QUEUE_URL, an SQS standard queue): set it or use RENDERWELD_QUEUE_DISPATCH=poll (docs/providers/queue-and-scaling.md)');
  }
  if (c.queue.dispatch === 'redis' && !c.queue.redis.url) {
    errors.push('queue.dispatch "redis" needs queue.redis.url (RENDERWELD_QUEUE_REDIS_URL or RENDERWELD_QUEUE_REDIS_URL_FILE, redis:// or rediss://): set it or use RENDERWELD_QUEUE_DISPATCH=poll (docs/providers/queue-and-scaling.md)');
  }
  if ((c.queue.dispatch === 'sqs' || c.queue.dispatch === 'redis') && mode !== 'database') {
    warnings.push(`queue.dispatch "${c.queue.dispatch}" has no effect with the in-process queue (queue.driver resolves to "inprocess"); it applies to the database queue only`);
  }
  return { errors, warnings };
}
