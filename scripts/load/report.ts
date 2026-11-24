/** Markdown tables from a load-test result file (scripts/load/run.ts), for docs/PERFORMANCE.md. */
/* eslint-disable @typescript-eslint/no-explicit-any */

type Any = any;

const row = (cells: unknown[]) => `| ${cells.map((c) => String(c ?? '')).join(' | ')} |`;

export function renderMarkdown(doc: Any): string {
  const h = doc.host;
  const foot = `${doc.hardwareNote}: ${h.vcpu} vCPU (${h.cpuModel}), ${h.ramGiB} GiB RAM, ${h.disk}, ${doc.postgres.version} (${doc.postgres.external ? `external server ${doc.postgres.external.host}${doc.postgres.external.pooler ? `, pooler ${doc.postgres.external.pooler}` : ''}` : doc.postgres.image}; ${Object.entries(doc.postgres.settings)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}), ${doc.config.apiInstances} api instances × connection_limit ${doc.config.apiPool}, workers connection_limit ${doc.config.workerPool}, Node ${h.node}, ${h.date.slice(0, 10)}`;
  const out: string[] = [`Conditions: ${doc.caveat}. ${foot}.`, ''];
  for (const [pooler, r] of Object.entries<Any>(doc.results)) {
    out.push(`### ${pooler === 'pgbouncer' ? (doc.postgres.external ? 'Through the external pooler (LOAD_POOLER_URL)' : `PgBouncer (transaction mode, pool ${doc.postgres.pgbouncer?.default_pool_size})`) : 'Direct connections'}`, '');
    const crudRows = Object.entries<Any>(r).filter(([k]) => k.startsWith('a:') || k.startsWith('b:'));
    if (crudRows.length) {
      out.push(
        row(['Run', 'req/s (all)', '2xx/s', 'p50 ms', 'p95 ms', 'p99 ms', '429s', 'errors', 'error rate %', '503 overloaded (shed, retryable)', 'DB CPU % (mean/max, 100 = 1 vCPU)', 'DB conns (mean/max)', 'lock waits (max)', 'DB tx/s', 'statements per request', 'api CPU % per instance', 'client CPU %', 'host load avg (mean/max)']),
        row(Array(18).fill('---'))
      );
      for (const [k, v] of crudRows) {
        const c = v.result.crud ?? v.result;
        out.push(
          row([
            k,
            c.total.perSecond,
            c.total.okPerSecond,
            c.total.latencyMs.p50,
            c.total.latencyMs.p95,
            c.total.latencyMs.p99,
            c.total.rateLimited,
            c.total.errors,
            c.total.errorRate,
            c.total.shed ?? 'n/a',
            v.dbCpu ? `${v.dbCpu.meanPct} / ${v.dbCpu.maxPct}` : 'n/a',
            `${v.db.connections.mean} / ${v.db.connections.max}`,
            v.db.lockWaits.max,
            v.db.txPerSecond,
            Math.round((v.db.statementsPerSecond / (c.total.perSecond || 1)) * 10) / 10,
            v.apiCpuPct.join(', '),
            v.clientCpuPct,
            `${v.hostLoadAvg.mean} / ${v.hostLoadAvg.max}`,
          ])
        );
      }
      out.push('');
      const probes = crudRows.filter(([, v]) => v.listProjects);
      if (probes.length) {
        out.push(
          'list_projects on its own, before and after each run: the default call (the first page since #179; the whole list before), and a walk of every page at limit=200:',
          '',
          row(['Run', 'projects', 'items returned', 'ms', 'response bytes', 'walk: pages', 'walk: ms']),
          row(Array(7).fill('---'))
        );
        for (const [k, v] of probes) {
          const { before: b, after: a } = v.listProjects;
          const items = (p: Any) => p.items ?? p.projects;
          out.push(row([k, `${b.projects} → ${a.projects}`, `${items(b)} → ${items(a)}`, `${b.medianMs} → ${a.medianMs}`, `${b.bytes} → ${a.bytes}`, `${b.walk?.pages ?? 'n/a'} → ${a.walk?.pages ?? 'n/a'}`, `${b.walk?.ms ?? 'n/a'} → ${a.walk?.ms ?? 'n/a'}`]));
        }
        out.push('');
      }
      const many = r['a:many-keys'] ?? r['b:fake-engine'];
      if (many) {
        const c = many.result.crud ?? many.result;
        out.push(`Per operation (${many === r['a:many-keys'] ? 'a:many-keys' : 'b:fake-engine'}):`, '', row(['Operation', 'req/s', 'p50 ms', 'p95 ms', 'p99 ms', '429s', 'errors']), row(Array(7).fill('---')));
        for (const [op, o] of Object.entries<Any>(c.ops)) out.push(row([op, o.perSecond, o.latencyMs.p50, o.latencyMs.p95, o.latencyMs.p99, o.rateLimited, o.errors]));
        out.push('');
      }
    }
    const checks = Object.entries<Any>(r).filter(([, v]) => v.exactlyOnce);
    if (checks.length) {
      out.push(row(['Run', 'jobs', 'lost', 'unexpected (duplicate enqueue)', 'duplicated runs', 'running events ≠ attempts', 're-claimed', 'queue wait p50 / p95 / p99 ms']), row(Array(8).fill('---')));
      for (const [k, v] of checks) {
        const e = v.exactlyOnce;
        // (c) queues every job before the workers start: its wait is the drain time, not a queue wait.
        const wait = k.startsWith('c:') ? 'n/a (all queued up front)' : `${e.queueWaitMs.p50} / ${e.queueWaitMs.p95} / ${e.queueWaitMs.p99}`;
        out.push(row([k, e.jobs, e.lost, e.unexpected, e.duplicated, e.runningEventsNotEqualAttempts, e.reclaimed, wait]));
      }
      out.push('');
    }
    const claims = Object.entries<Any>(r).filter(([k]) => k.startsWith('c:'));
    if (claims.length) {
      out.push(
        row(['Workers', 'jobs', 'claims/s (claim + fenced finish)', 'enqueue/s', 'DB CPU % busy (mean/max)', 'DB conns busy (max)', 'DB tx/s busy', 'idle: DB tx/s', 'idle: DB CPU %', 'host load avg (mean)']),
        row(Array(10).fill('---'))
      );
      for (const [, v] of claims) {
        out.push(
          row([
            v.workers,
            v.jobs,
            v.claimsPerSecond,
            v.enqueuePerSecond,
            v.busy.dbCpu ? `${v.busy.dbCpu.meanPct} / ${v.busy.dbCpu.maxPct}` : 'n/a',
            v.busy.db.connections.max,
            v.busy.db.txPerSecond,
            v.idle.db.txPerSecond,
            v.idle.dbCpu ? v.idle.dbCpu.meanPct : 'n/a',
            v.busy.hostLoadAvg.mean,
          ])
        );
      }
      out.push('');
    }
  }
  if (doc.pgbouncerProbes) {
    out.push('PgBouncer transaction-mode probes:', '');
    for (const [k, v] of Object.entries(doc.pgbouncerProbes)) out.push(`- ${k}: ${v}`);
    out.push('');
  }
  return out.join('\n');
}
