import type { OnceOutcome, PluginRegistry } from '@renderweld/core';
import { startServer } from './server';

/**
 * Exit statuses of `reelforge worker --once` (D-100). Job platforms retry a
 * container that exits non-zero, so only "this unit still needs a run" and
 * "the unit failed" are non-zero; a failed job is already final in the
 * database, and a retry of its container claims nothing or the next job.
 */
export const ONCE_EXIT: Record<OnceOutcome, number> = {
  none: 0,
  succeeded: 0,
  cancelled: 0,
  // A render that fanned out (D-097): its units and join are queued for any worker; this container is done.
  fanned_out: 0,
  failed: 1,
  // EX_TEMPFAIL: handed back (SIGTERM), lease lost, or (`--job`) still queued after the wait: the job needs another run.
  deferred: 75,
  released: 75,
  lost: 75,
};

export interface OnceOptions {
  /** Claim exactly this job id (fenced), for launchers that start one container per job. */
  jobId?: string;
  /** Override queue.onceWaitMs. */
  waitMs?: number;
  /** The plugins (tests: fake engines); default: the server's registry. */
  registry?: (providerEnv: NodeJS.ProcessEnv) => PluginRegistry;
}

/**
 * `reelforge worker --once [--job <id>] [--wait-ms N]` and
 * `REELFORGE_WORKER_ONCE=1`: start the service as a worker without an HTTP
 * listener, claim at most one job, render it and return the exit status.
 * SIGTERM/SIGINT stops claiming; a running job gets
 * `queue.shutdownGraceSeconds`, then it is handed back to the queue (D-077).
 */
export async function runWorkerOnce(env: NodeJS.ProcessEnv, opts: OnceOptions = {}): Promise<number> {
  // `worker --once` is a worker: the role guard (shared database and storage, D-076) applies as for any worker.
  const started = await startServer({}, { env: { ...env, REELFORGE_ROLE: 'worker' }, once: true, ...(opts.registry ? { registry: opts.registry } : {}) });
  const say = started.log;
  const cfg = started.config.resolved.config;
  const waitMs = opts.waitMs ?? cfg.queue.onceWaitMs ?? cfg.queue.pollIntervalMs * 3;
  let signalled: string | null = null;
  const onSignal = (sig: NodeJS.Signals) => {
    if (signalled) process.exit(ONCE_EXIT.released);
    signalled = sig;
    say('info', `${sig}: stopping; a running job gets ${cfg.queue.shutdownGraceSeconds} s, then it is handed back to the queue`);
    void started.service.jobs.shutdown(cfg.queue.shutdownGraceSeconds * 1000);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  let code: number = ONCE_EXIT.failed;
  try {
    say('info', `worker --once ${started.service.jobs.workerId}: waiting up to ${waitMs} ms for ${opts.jobId ? `job ${opts.jobId}` : 'a queued job'}`);
    const r = await started.service.jobs.runOnce({ waitMs, ...(opts.jobId ? { jobId: opts.jobId } : {}) });
    code = ONCE_EXIT[r.outcome];
    const what = r.job ? `job ${r.job.id}` : 'no job';
    say(r.outcome === 'failed' || r.outcome === 'lost' ? 'warn' : 'info', `worker --once: ${r.outcome} (${what}${r.reason ? `: ${r.reason}` : ''}); exit ${code}`);
  } finally {
    await started.close().catch((e: Error) => say('error', `worker --once: shutdown failed: ${e.message}`));
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
  return code;
}

/** `--job <id>` / `--job=<id>` and `--wait-ms N` from an argument list. */
export function onceArgs(argv: string[]): OnceOptions {
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  };
  const jobId = value('job');
  const wait = value('wait-ms');
  if (argv.includes('--job') && !jobId) throw new Error('--job needs a job id');
  if (wait !== undefined && !/^\d+$/.test(wait)) throw new Error('--wait-ms must be a whole number of milliseconds');
  return { ...(jobId ? { jobId } : {}), ...(wait !== undefined ? { waitMs: Number(wait) } : {}) };
}
