import pg from 'pg';
import { DEFAULT_PG_SCHEMA } from './sql';
import { parseDatabaseUrl, redactDatabaseUrl } from './url';

/**
 * Is this PostgreSQL URL behind a transaction-mode pooler (PgBouncer
 * `pool_mode = transaction`, Cloud SQL managed pooling, ...)? Two short
 * session connections: A asks for its backend pid, B opens a transaction (the
 * pooler gives it a server connection, normally the one A just released), then
 * A asks again. On a direct connection, or a session-mode pooler, A keeps its
 * backend for the whole session: same pid. Behind a transaction-mode pooler A
 * gets another server connection (another pid), or waits for one (timeout).
 * `null`: the probe itself failed (no verdict).
 */
export async function probeTransactionPooler(url: string, timeoutMs = 3000): Promise<boolean | null> {
  const p = parseDatabaseUrl(url);
  if (p.kind !== 'postgresql') return false;
  const client = () => new pg.Client({ connectionString: p.driverUrl!, connectionTimeoutMillis: timeoutMs, application_name: 'reelforge-pooler-probe' });
  const a = client();
  const b = client();
  const pid = async (c: pg.Client) => Number((await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.all([a.connect(), b.connect()]);
    const first = await pid(a);
    await b.query('BEGIN');
    await pid(b);
    const second = await Promise.race([pid(a), new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), timeoutMs)))]);
    return second === 'timeout' || second !== first;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    await b.query('ROLLBACK').catch(() => undefined);
    await Promise.all([a.end(), b.end()].map((x) => x.catch(() => undefined)));
  }
}

/**
 * The start-up guard of #191: a warning when `?schema=` (a non-default schema)
 * goes through a transaction-mode pooler, else null. This version names the
 * schema in every raw statement, so the combination is safe for it; the
 * warning is for older ReelForge processes that may still use the same
 * database through the pooler during an upgrade, and for the operator's own
 * SQL. docs/providers/queue-and-scaling.md#pgbouncer-transaction-mode.
 */
export async function pooledSchemaWarning(url: string, probe: (url: string) => Promise<boolean | null> = probeTransactionPooler): Promise<string | null> {
  const p = parseDatabaseUrl(url);
  if (p.kind !== 'postgresql' || !p.schema || p.schema === DEFAULT_PG_SCHEMA) return null;
  if ((await probe(url)) !== true) return null;
  return (
    `database: ?schema=${p.schema} goes through a transaction-mode connection pooler (${redactDatabaseUrl(url)}), which does not keep each client's search_path. ` +
    'This version names the schema in every statement (#191), so it is safe here; ReelForge processes older than that fix using this database through the pooler can read or claim another schema\'s rows: upgrade every api and worker before running them side by side. ' +
    'Your own SQL through the pooler (psql, reporting tools) must name the schema too (docs/providers/queue-and-scaling.md#pgbouncer-transaction-mode)'
  );
}
