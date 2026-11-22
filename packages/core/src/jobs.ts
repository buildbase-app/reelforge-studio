import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SpanStatusCode, context, trace, type Context, type Span } from '@opentelemetry/api';
import { ApiError, notFound } from './errors';
import { NOOP_TELEMETRY, coreInstruments, type Telemetry } from './telemetry';
import { newId } from './fsutil';
import type { JobCaps, JobFilter, JobLeaseFence, JobProgress, JobRecord, JobRepository, JobStatus, QuotaWindow } from './repositories';

export type { JobProgress, JobRecord, JobStatus } from './repositories';
export const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

/** Longest log line stored; longer lines (e.g. a tool's whole stderr) are cut. */
const MAX_LOG_LINE = 64 * 1024;
/** Longest wait between claim attempts while the database fails. */
const MAX_BACKOFF_MS = 30_000;

export interface JobEvent {
  jobId: string;
  type: 'status' | 'progress' | 'log';
  job: JobRecord;
  line?: string;
  /** Read back from the database for a job running on another instance (database queue); onEvent never sees these. */
  remote?: true;
}

export interface JobContext {
  job: JobRecord;
  signal: AbortSignal;
  log(line: string): void;
  progress(stage: string, fraction: number, detail?: string): void;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown>>;

export type QueueMode = 'inprocess' | 'database';

/** The database queue (D-075): jobs are rows claimed with leases, shared by every worker instance. */
export interface DatabaseQueueOptions {
  /** Claim and run jobs (roles `all` and `worker`). An `api` instance only enqueues. Default true. */
  runJobs?: boolean;
  /** This instance's id in `Job.workerId` (default `<hostname>-<random>`). */
  workerId?: string;
  /** Lease length (queue.leaseSeconds). Default 60 000. */
  leaseMs?: number;
  /** Lease renewal, cancel check and recovery interval. Default leaseMs / 4. */
  heartbeatMs?: number;
  /** Claims per job before a lost lease fails it (queue.maxAttempts). Default 3. */
  maxAttempts?: number;
  /** Idle poll interval, and how often a job on another instance is re-read (queue.pollIntervalMs). Default 1000. */
  pollMs?: number;
  /** Asked before each claim; `ok: false` pauses claiming (e.g. storage is down, so renders would only fail). */
  canClaim?: () => Promise<{ ok: boolean; reason?: string }>;
}

export interface JobRunnerOptions {
  repo: JobRepository;
  /** Jobs that run at the same time. Renders are CPU and memory heavy: default 1. */
  concurrency?: number;
  handlers: Record<string, JobHandler>;
  /** Traces (a span per job, child of the request that submitted it) and job metrics (D-050). */
  telemetry?: Telemetry;
  /** `inprocess` (default) or `database` (with these options). */
  mode?: QueueMode;
  database?: DatabaseQueueOptions;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
  /** Jobs of one API key that may run at the same time (limits.maxRunningJobsPerKey, read before each start; 0 or unset: no limit). */
  maxRunningPerKey?: () => number | undefined;
}

/** What the database queue looks like from this instance (/readyz, metrics). */
export interface QueueStatus {
  mode: QueueMode;
  runJobs: boolean;
  workerId: string;
  running: number;
  /** Cluster-wide queued jobs (database queue: the last count read; in-process: this instance). */
  queued: number;
  concurrency: number;
  /** Claiming is paused (shutting down, or `canClaim` said no). */
  paused?: string;
  /** The last failed queue operation, cleared by the next success. */
  lastError?: { operation: string; message: string; at: string };
  lastHeartbeatAt?: string;
}

type AbortReason = 'cancel' | 'lost' | 'release';

export function defaultWorkerId(): string {
  const host = hostname().toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, 60) || 'worker';
  return `${host}-${randomBytes(3).toString('hex')}`;
}

/**
 * Job queue with persisted state (JobRepository): the job row (status,
 * progress, result or error) and its events (status changes and log lines).
 *
 * queued → running → succeeded | failed | cancelled. Every state change is one
 * transaction (job row + status event). Cancellation aborts the handler's
 * AbortSignal.
 *
 * Two modes (D-075):
 *   - `inprocess`: the instance runs the jobs it accepted, from an in-memory
 *     queue. Jobs left queued/running by a previous process are marked failed
 *     on start (their work cannot be resumed).
 *   - `database`: jobs are rows with `queue = "database"`; any instance with
 *     `runJobs` claims the oldest one atomically (row lock with SKIP LOCKED on
 *     PostgreSQL/MySQL) and holds it with a lease it renews on a heartbeat.
 *     A job whose lease runs out (its worker crashed) is queued again, up to
 *     `maxAttempts` claims. Writes by a worker are fenced by its claim, so a
 *     worker that lost its lease can never overwrite the new holder's state.
 *     Cancellation and progress work across instances through the database.
 *
 * Jobs this process is running are kept in memory (their progress is newer
 * than the throttled database copy); everything else is read from the
 * database.
 */
export class JobRunner {
  private _concurrency: number;
  private readonly repo: JobRepository;
  private handlers: Record<string, JobHandler>;
  /** Queued (in-process) and running jobs of this process. */
  private active = new Map<string, JobRecord>();
  private queue: string[] = [];
  private running = new Map<string, AbortController>();
  private events = new EventEmitter();
  private lastPersist = new Map<string, number>();
  private idleWaiters: Array<() => void> = [];
  /** Per-job write chains so state and log writes land in order. */
  private chains = new Map<string, Promise<void>>();
  /** The trace context each queued job was submitted in (in memory only). */
  private origins = new Map<string, Context>();
  private spans = new Map<string, Span>();
  private readonly telemetry: Telemetry;
  readonly mode: QueueMode;
  readonly workerId: string;
  readonly runJobs: boolean;
  private readonly db: Required<Omit<DatabaseQueueOptions, 'canClaim' | 'workerId' | 'runJobs'>> & Pick<DatabaseQueueOptions, 'canClaim'>;
  private readonly logger: NonNullable<JobRunnerOptions['log']>;
  private readonly maxRunningPerKey: () => number | undefined;
  /** Database queue: the claim (fence) of each job this process runs. */
  private fences = new Map<string, JobLeaseFence>();
  private abortReasons = new Map<string, AbortReason>();
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private claiming = false;
  private claimAgain = false;
  private backoffMs = 0;
  private stopping = false;
  private started = false;
  private pausedReason: string | undefined;
  private lastError: QueueStatus['lastError'];
  private lastWarnAt = new Map<string, number>();
  private lastHeartbeatOk = Date.now();
  private lastHeartbeatAt: string | undefined;
  private queuedCount = 0;
  /** Jobs handed back to the queue since shutdown() started. */
  private released = 0;
  /** Jobs running on other instances that someone here is waiting for (polled from the database). */
  private watchers = new Map<string, { timer: NodeJS.Timeout; refs: number; last: string }>();

  constructor(opts: JobRunnerOptions) {
    this.repo = opts.repo;
    this.telemetry = opts.telemetry ?? NOOP_TELEMETRY;
    this._concurrency = Math.max(1, opts.concurrency ?? 1);
    this.handlers = opts.handlers;
    this.events.setMaxListeners(0);
    this.mode = opts.mode ?? 'inprocess';
    const d = opts.database ?? {};
    this.runJobs = d.runJobs ?? true;
    this.workerId = d.workerId ?? defaultWorkerId();
    const leaseMs = Math.max(1000, d.leaseMs ?? 60_000);
    this.db = {
      leaseMs,
      heartbeatMs: Math.max(100, d.heartbeatMs ?? Math.floor(leaseMs / 4)),
      maxAttempts: Math.max(1, d.maxAttempts ?? 3),
      pollMs: Math.max(20, d.pollMs ?? 1000),
      canClaim: d.canClaim,
    };
    this.logger = opts.log ?? (() => undefined);
    this.maxRunningPerKey = () => {
      const n = opts.maxRunningPerKey?.();
      return n && n > 0 ? n : undefined;
    };
  }

  get concurrency(): number {
    return this._concurrency;
  }

  /** Change how many jobs run at once (runtime setting limits.renderConcurrency). Running jobs are never stopped. */
  setConcurrency(n: number): void {
    this._concurrency = Math.max(1, Math.floor(n));
    queueMicrotask(() => this.pump());
  }

  /** Look at the queue again (a limit read by the pump changed at runtime). */
  wake(): void {
    queueMicrotask(() => this.pump());
  }

  async init(): Promise<void> {
    if (this.mode === 'database') {
      // Nothing is failed here: jobs of a crashed worker come back through their expired lease.
      this.started = true;
      this.scheduleHeartbeat();
      this.schedulePoll(0);
      return;
    }
    for (const job of await this.repo.listUnfinished()) {
      // Database-queue jobs belong to the workers (a mixed setup is refused at start-up).
      if (this.active.has(job.id) || job.queue === 'database') continue;
      const now = new Date().toISOString();
      job.status = 'failed';
      job.finishedAt = now;
      job.error = { code: 'interrupted', message: 'the server restarted before this job finished; start it again' };
      await this.repo.transition(job, now);
      await this.repo.appendLog(job.id, now, 'finished: failed (interrupted by a server restart)');
    }
  }

  /**
   * Create a job. With `quota`, the job is only inserted while the API key's
   * render quota and the job caps (JobCaps) have room; the check and the insert
   * are atomic across processes (JobRepository.insertWithQuota). Throws
   * QuotaExceeded or JobCapReached when refused.
   */
  async submit(
    type: string,
    params: Record<string, unknown>,
    meta: { projectId?: string; retryOf?: string; apiKeyId?: string } = {},
    quota?: { types: string[]; windows: QuotaWindow[] } & JobCaps
  ): Promise<JobRecord> {
    if (!this.handlers[type]) throw new ApiError('bad_request', 400, `unknown job type "${type}"`);
    if (this.stopping && this.mode === 'inprocess') throw new ApiError('shutting_down', 503, 'the server is shutting down; retry on another instance or after the restart');
    const job: JobRecord = {
      id: newId('job'),
      type,
      status: 'queued',
      params,
      createdAt: new Date().toISOString(),
      progress: { stage: 'queued', fraction: 0 },
      ...(meta.projectId ? { projectId: meta.projectId } : {}),
      ...(meta.retryOf ? { retryOf: meta.retryOf } : {}),
      ...(meta.apiKeyId ? { apiKeyId: meta.apiKeyId } : {}),
      ...(this.mode === 'database' ? { queue: 'database' as const, attempts: 0 } : {}),
    };
    // Durable before anyone sees the id.
    const limited = quota && ((meta.apiKeyId && (quota.windows.length || quota.maxActivePerKey !== undefined)) || quota.maxQueuedTotal !== undefined);
    if (quota && limited) {
      const r = await this.repo.insertWithQuota(structuredClone(job), job.createdAt, { ...quota, ...(meta.apiKeyId ? { apiKeyId: meta.apiKeyId } : {}) });
      if (!r.ok) throw 'cap' in r ? new JobCapReached(r.cap, r.used) : new QuotaExceeded(r.window, r.used);
    } else {
      await this.repo.insert(structuredClone(job), job.createdAt);
    }
    if (this.mode === 'database') {
      this.queuedCount++;
      this.emit({ jobId: job.id, type: 'status', job });
      if (this.runJobs) queueMicrotask(() => this.pump());
      return structuredClone(job);
    }
    this.active.set(job.id, job);
    this.origins.set(job.id, context.active());
    this.queue.push(job.id);
    this.emit({ jobId: job.id, type: 'status', job });
    queueMicrotask(() => this.pump());
    return structuredClone(job);
  }

  async get(id: string): Promise<JobRecord> {
    const a = this.active.get(id);
    if (a) return structuredClone(a);
    const j = await this.repo.get(id);
    if (!j) throw notFound('job', id);
    return j;
  }

  async list(filter: JobFilter = {}): Promise<JobRecord[]> {
    const rows = await this.repo.list(filter);
    return rows.map((j) => {
      const a = this.active.get(j.id);
      return a ? structuredClone(a) : j;
    });
  }

  /** Jobs waiting (database queue: cluster-wide, last count read) and running here (queue depth, metrics). */
  stats(): { queued: number; running: number } {
    return { queued: this.mode === 'database' ? this.queuedCount : this.queue.length, running: this.running.size };
  }

  status(): QueueStatus {
    return {
      mode: this.mode,
      runJobs: this.runJobs,
      workerId: this.workerId,
      running: this.running.size,
      queued: this.stats().queued,
      concurrency: this._concurrency,
      ...(this.stopping ? { paused: 'shutting down' } : this.pausedReason ? { paused: this.pausedReason } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastHeartbeatAt ? { lastHeartbeatAt: this.lastHeartbeatAt } : {}),
    };
  }

  /** Position in this instance's in-process queue (0 = next), or null if not queued here. */
  queuePosition(id: string): number | null {
    const i = this.queue.indexOf(id);
    return i < 0 ? null : i;
  }

  /** Position of a queued job (0 = next): in-process or, for the database queue, among all instances. */
  async positionOf(job: JobRecord): Promise<number | null> {
    if (job.status !== 'queued') return null;
    if (job.queue !== 'database') return this.queuePosition(job.id);
    return this.repo.countQueued({ createdAt: job.createdAt, id: job.id });
  }

  async cancel(id: string): Promise<JobRecord> {
    const job = this.active.get(id);
    if (job) {
      if (job.status === 'queued') {
        this.queue = this.queue.filter((q) => q !== id);
        this.finish(job, 'cancelled', { error: { code: 'cancelled', message: 'cancelled before it started' } });
      } else {
        this.log(job, 'cancel requested');
        this.abortReasons.set(id, 'cancel');
        this.running.get(id)?.abort();
      }
      return structuredClone(job);
    }
    const stored = await this.get(id);
    if (stored.queue !== 'database' || TERMINAL.includes(stored.status)) return stored; // finished, or an in-process job of another instance
    const at = new Date().toISOString();
    if (stored.status === 'queued') {
      const cancelled = await this.repo.cancelQueued(id, at, { code: 'cancelled', message: 'cancelled before it started' });
      if (cancelled) {
        await this.repo.appendLog(id, at, `finished: cancelled (before it started; by ${this.workerId})`);
        this.queuedCount = Math.max(0, this.queuedCount - 1);
        this.emit({ jobId: id, type: 'status', job: cancelled });
        return cancelled;
      }
    }
    // Running on another instance (or claimed a moment ago): its worker stops it at the next heartbeat.
    if (await this.repo.requestCancel(id, at)) {
      await this.repo.appendLog(id, at, `cancel requested (by ${this.workerId}); the worker stops it within ${Math.ceil(this.db.heartbeatMs / 1000)} s`);
    }
    return this.get(id);
  }

  /** Start a new job with the same type and parameters. The old job and its output are untouched. */
  async retry(id: string, meta: { apiKeyId?: string } = {}, quota?: { types: string[]; windows: QuotaWindow[] } & JobCaps): Promise<JobRecord> {
    const job = await this.get(id);
    if (!TERMINAL.includes(job.status) || job.status === 'succeeded') {
      throw new ApiError('conflict', 409, `only failed or cancelled jobs can be retried (job is ${job.status})`);
    }
    return this.submit(job.type, job.params, { projectId: job.projectId, retryOf: job.id, ...meta }, quota);
  }

  async logs(id: string, tail?: number): Promise<string[]> {
    await this.get(id);
    await this.chains.get(id);
    return this.repo.logs(id, tail);
  }

  /**
   * Events of one job. For a job running on another instance (database
   * queue), status and progress changes are read from the database every
   * poll interval; log lines are only pushed by the instance running it.
   */
  subscribe(id: string, fn: (e: JobEvent) => void): () => void {
    const listener = (e: JobEvent) => {
      if (e.jobId === id) fn(e);
    };
    this.events.on('event', listener);
    const watched = this.mode === 'database' && !this.active.has(id);
    if (watched) this.watch(id);
    return () => {
      this.events.off('event', listener);
      if (watched) this.unwatch(id);
    };
  }

  /**
   * Every job event that happens on THIS instance: submits, and the status,
   * progress and log lines of jobs it runs (outbound events, webhooks). With
   * the database queue each event is emitted once, by the instance where it
   * happened (the worker running the job), never by instances that merely
   * watch it. Returns an unsubscribe function.
   */
  onEvent(fn: (e: JobEvent) => void): () => void {
    const listener = (e: JobEvent) => {
      if (!e.remote) fn(e);
    };
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  /** Resolves when one job reaches a terminal state (on any instance, for the database queue). */
  async waitFor(id: string, timeoutMs = 600_000): Promise<JobRecord> {
    const job = await this.get(id);
    if (TERMINAL.includes(job.status)) return job;
    if (this.mode === 'inprocess' && !this.active.has(id)) return job;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`job ${id} did not finish within ${timeoutMs} ms`));
      }, timeoutMs);
      const off = this.subscribe(id, (e) => {
        if (TERMINAL.includes(e.job.status)) {
          clearTimeout(timer);
          off();
          resolve(structuredClone(e.job));
        }
      });
    });
  }

  /** Resolves when nothing is queued or running in this process. */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /**
   * Graceful shutdown: stop claiming, wait up to `graceMs` for running jobs,
   * then stop the rest and (database queue) hand them back to the queue so
   * another worker takes them at once. Leases are released either way.
   */
  async shutdown(graceMs: number): Promise<{ finished: number; released: number }> {
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const runningAtStart = this.running.size;
    this.released = 0;
    if (runningAtStart) this.log('info', `shutting down: waiting up to ${Math.round(graceMs / 1000)} s for ${runningAtStart} running job(s)`);
    const deadline = Date.now() + graceMs;
    while (this.running.size && Date.now() < deadline) await sleep(Math.min(200, deadline - Date.now()));
    const left = [...this.running.keys()];
    for (const id of left) {
      this.abortReasons.set(id, this.mode === 'database' ? 'release' : 'cancel');
      this.running.get(id)?.abort();
    }
    // Aborted handlers settle quickly; the release (or final state) is written in start().
    const settle = Date.now() + 15_000;
    while (this.running.size && Date.now() < settle) await sleep(50);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const w of this.watchers.values()) clearInterval(w.timer);
    this.watchers.clear();
    await this.flush();
    return { finished: runningAtStart - this.released, released: this.released };
  }

  private emit(e: JobEvent) {
    this.events.emit('event', { ...e, job: structuredClone(e.job) });
  }

  private pump() {
    if (this.mode === 'database') {
      void this.claimLoop();
      return;
    }
    const cap = this.maxRunningPerKey();
    // Fair across keys (D-090): start the queued job whose key runs the fewest jobs, oldest first among
    // equals; jobs of a key at its cap (limits.maxRunningJobsPerKey) wait and keep their place.
    this.queue = this.queue.filter((id) => this.active.get(id)?.status === 'queued');
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      let best = -1;
      let bestRunning = Infinity;
      for (const [i, id] of this.queue.entries()) {
        const key = this.active.get(id)!.apiKeyId;
        const n = key ? this.runningFor(key) : 0;
        if (cap !== undefined && key && n >= cap) continue;
        if (n < bestRunning) {
          best = i;
          bestRunning = n;
          if (n === 0) break;
        }
      }
      if (best < 0) break;
      const [id] = this.queue.splice(best, 1);
      void this.start(this.active.get(id!)!);
    }
    this.notifyIdle();
  }

  /** Jobs of this API key running in this process. */
  private runningFor(apiKeyId: string): number {
    let n = 0;
    for (const id of this.running.keys()) if (this.active.get(id)?.apiKeyId === apiKeyId) n++;
    return n;
  }

  private notifyIdle() {
    if (this.queue.length === 0 && this.running.size === 0) {
      const waiters = this.idleWaiters.splice(0);
      for (const w of waiters) w();
    }
  }

  // ---- database queue -------------------------------------------------------

  private schedulePoll(ms: number) {
    if (!this.started || this.stopping || !this.runJobs) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.claimLoop();
    }, ms);
    this.pollTimer.unref();
  }

  /** Claim queued jobs while there are free slots. One loop at a time; a request during a loop runs it again. */
  private async claimLoop(): Promise<void> {
    if (!this.started || this.stopping || !this.runJobs) return;
    if (this.claiming) {
      this.claimAgain = true;
      return;
    }
    this.claiming = true;
    try {
      do {
        this.claimAgain = false;
        while (!this.stopping && this.running.size < this.concurrency) {
          if (this.db.canClaim) {
            const can = await this.db.canClaim().catch((e: Error) => ({ ok: false, reason: e.message }));
            if (!can.ok) {
              if (this.pausedReason !== can.reason) this.log('warn', `queue: not claiming jobs: ${can.reason}`);
              this.pausedReason = can.reason ?? 'not ready';
              break;
            }
            if (this.pausedReason) this.log('info', 'queue: claiming jobs again');
            this.pausedReason = undefined;
          }
          const now = Date.now();
          const job = await this.repo.claim({
            workerId: this.workerId,
            types: Object.keys(this.handlers),
            now: new Date(now).toISOString(),
            leaseUntil: new Date(now + this.db.leaseMs).toISOString(),
            ...(this.maxRunningPerKey() !== undefined ? { maxRunningPerKey: this.maxRunningPerKey() } : {}),
          });
          this.ok('claim');
          if (!job) break;
          this.queuedCount = Math.max(0, this.queuedCount - 1);
          void this.start(job);
        }
      } while (this.claimAgain && !this.stopping);
      this.backoffMs = 0;
      this.schedulePoll(this.db.pollMs);
    } catch (e) {
      this.failed('claim', e as Error);
      this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs ? this.backoffMs * 2 : this.db.pollMs * 2);
      this.schedulePoll(this.backoffMs + Math.floor(Math.random() * this.db.pollMs));
    } finally {
      this.claiming = false;
    }
  }

  private scheduleHeartbeat() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      void this.heartbeat().finally(() => {
        if (this.heartbeatTimer !== null || !this.stopping) this.scheduleHeartbeat();
      });
    }, this.db.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  /** Renew leases, see cancellations from other instances, re-queue jobs of crashed workers, count the queue. */
  async heartbeat(): Promise<void> {
    const now = Date.now();
    const ids = [...this.running.keys()].filter((id) => this.fences.has(id));
    if (ids.length) {
      try {
        const r = await this.repo.heartbeat(this.workerId, ids, new Date(now + this.db.leaseMs).toISOString());
        this.ok('heartbeat');
        this.lastHeartbeatOk = now;
        const held = new Set(r.held);
        for (const id of ids) {
          if (!held.has(id) && this.running.has(id)) this.abort(id, 'lost', 'this worker no longer holds the job (its lease expired and it was queued again, or it was cancelled)');
        }
        for (const id of r.cancelRequested) this.abort(id, 'cancel', 'cancel requested on another instance');
      } catch (e) {
        this.failed('heartbeat', e as Error);
        // Without a renewed lease another worker may take the job: stop before running it twice.
        if (now - this.lastHeartbeatOk >= this.db.leaseMs) {
          for (const id of ids) this.abort(id, 'lost', `the lease could not be renewed for ${Math.round((now - this.lastHeartbeatOk) / 1000)} s (database unreachable)`);
        }
      }
    } else {
      this.lastHeartbeatOk = now;
    }
    this.lastHeartbeatAt = new Date(now).toISOString();
    try {
      const { requeued, failed } = await this.repo.recoverExpired(new Date(now).toISOString(), this.db.maxAttempts);
      const m = coreInstruments(this.telemetry.meter);
      for (const j of requeued) {
        m.jobsRequeued.add(1, { 'reelforge.reason': 'lease_expired' });
        this.log('warn', `queue: job ${j.id} lost its worker (lease expired); queued again (attempt ${j.attempts ?? 0} of ${this.db.maxAttempts} used)`);
        this.emit({ jobId: j.id, type: 'status', job: j });
      }
      for (const j of failed) {
        m.jobsFinished.add(1, { 'reelforge.job.type': j.type, 'reelforge.job.status': 'failed' });
        this.log('error', `queue: job ${j.id} failed: ${j.error?.message ?? 'lease expired'}`);
        this.emit({ jobId: j.id, type: 'status', job: j });
      }
      this.queuedCount = await this.repo.countQueued();
      this.ok('recover');
      if (requeued.length && this.runJobs) void this.claimLoop();
    } catch (e) {
      this.failed('recover', e as Error);
    }
  }

  private abort(id: string, reason: AbortReason, why: string) {
    const c = this.running.get(id);
    if (!c || c.signal.aborted) return;
    this.abortReasons.set(id, reason);
    const job = this.active.get(id);
    if (job && reason !== 'lost') this.log(job, `stopping: ${why}`);
    else this.log('warn', `queue: stopping job ${id}: ${why}`);
    c.abort();
  }

  private ok(operation: string) {
    if (this.lastError?.operation === operation) {
      this.log('info', `queue: ${operation} works again`);
      this.lastError = undefined;
    }
  }

  private failed(operation: string, e: Error) {
    const message = e.message.split('\n').filter(Boolean).pop()?.slice(0, 300) ?? 'unknown error';
    this.lastError = { operation, message, at: new Date().toISOString() };
    coreInstruments(this.telemetry.meter).queueErrors.add(1, { 'reelforge.operation': operation });
    // At most one warning per operation and minute (a database outage must not flood the log).
    const last = this.lastWarnAt.get(operation) ?? 0;
    if (Date.now() - last >= 60_000) {
      this.lastWarnAt.set(operation, Date.now());
      this.log('warn', `queue: ${operation} failed (retrying with backoff): ${message}`);
    }
  }

  private watch(id: string) {
    const w = this.watchers.get(id);
    if (w) {
      w.refs++;
      return;
    }
    const entry = { refs: 1, last: '', timer: setInterval(() => void this.poll(id), this.db.pollMs) };
    entry.timer.unref();
    this.watchers.set(id, entry);
    void this.poll(id);
  }

  private unwatch(id: string) {
    const w = this.watchers.get(id);
    if (!w || --w.refs > 0) return;
    clearInterval(w.timer);
    this.watchers.delete(id);
  }

  /** Re-read a job running elsewhere; emit when its status or progress changed. */
  private async poll(id: string) {
    const w = this.watchers.get(id);
    if (!w || this.active.has(id)) return; // running here: events come from start()
    const job = await this.repo.get(id).catch(() => null);
    if (!job || !this.watchers.has(id)) return;
    const sig = JSON.stringify([job.status, job.progress]);
    if (sig === w.last) return;
    const first = w.last === '';
    const statusChanged = first || JSON.parse(w.last)[0] !== job.status;
    w.last = sig;
    if (!first || TERMINAL.includes(job.status)) this.emit({ jobId: id, type: statusChanged ? 'status' : 'progress', job, remote: true });
  }

  // ---- running a job ----------------------------------------------------------

  private async start(job: JobRecord) {
    const controller = new AbortController();
    this.running.set(job.id, controller);
    const fence = this.mode === 'database' ? { workerId: this.workerId, attempts: job.attempts ?? 1 } : undefined;
    if (fence) {
      // Claimed: the row is already running (claim wrote it and its status event).
      this.fences.set(job.id, fence);
      this.active.set(job.id, job);
    } else {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      job.progress = { stage: 'starting', fraction: 0 };
    }
    const parent = this.origins.get(job.id) ?? context.active();
    this.origins.delete(job.id);
    const span = this.telemetry.tracer.startSpan(
      `job ${job.type}`,
      {
        attributes: {
          'reelforge.job.id': job.id,
          'reelforge.job.type': job.type,
          'reelforge.job.queue_ms': Date.parse(job.startedAt!) - Date.parse(job.createdAt),
          ...(job.projectId ? { 'reelforge.project.id': job.projectId } : {}),
          ...(fence ? { 'reelforge.job.attempt': fence.attempts, 'reelforge.worker.id': this.workerId } : {}),
        },
      },
      parent
    );
    this.spans.set(job.id, span);
    if (!fence) await this.transition(job);
    this.emit({ jobId: job.id, type: 'status', job });
    this.log(job, fence ? `started ${job.type} on worker ${this.workerId} (attempt ${fence.attempts} of ${this.db.maxAttempts})` : `started ${job.type}`);
    const ctx: JobContext = {
      job: structuredClone(job),
      signal: controller.signal,
      log: (line) => this.log(job, line),
      progress: (stage, fraction, detail) => {
        job.progress = { stage, fraction: Math.max(0, Math.min(1, fraction)), ...(detail ? { detail } : {}) } satisfies JobProgress;
        this.persistProgress(job);
        this.emit({ jobId: job.id, type: 'progress', job });
      },
    };
    try {
      const result = await context.with(trace.setSpan(parent, span), () => this.handlers[job.type]!(ctx));
      if (controller.signal.aborted) throw new Error('cancelled');
      this.finish(job, 'succeeded', { result });
    } catch (e) {
      const err = e as Error & { code?: string; stage?: string };
      const reason = this.abortReasons.get(job.id);
      if (controller.signal.aborted && reason === 'lost') {
        // Another worker owns the job now (or will): write nothing, forget it here.
        this.drop(job, 'lease lost');
      } else if (fence && (reason === 'release' || (this.stopping && reason !== 'cancel'))) {
        // Shutting down: whatever ended the job now (our abort, or a tool killed by the same signal) is not
        // the job's fault. Hand it back so another worker runs it, instead of failing it.
        await this.chains.get(job.id);
        const released = await this.repo.release(job.id, fence, new Date().toISOString()).catch((x: Error) => {
          this.log('warn', `queue: could not release job ${job.id} (its lease expires on its own): ${x.message}`);
          return false;
        });
        if (released) {
          coreInstruments(this.telemetry.meter).jobsRequeued.add(1, { 'reelforge.reason': 'released' });
          this.queuedCount++;
          this.released++;
          job.status = 'queued';
          this.emit({ jobId: job.id, type: 'status', job });
        }
        this.drop(job, released ? 'released' : 'release failed');
      } else if (controller.signal.aborted) {
        this.finish(job, 'cancelled', { error: { code: 'cancelled', message: this.stopping && reason !== 'cancel' ? 'stopped by a server shutdown' : 'cancelled while running' } });
      } else {
        const code = e instanceof ApiError ? e.code : err.name === 'PipelineError' ? 'render_failed' : 'job_failed';
        this.log(job, `error: ${err.message}`);
        if ((err as { log?: string }).log) this.log(job, String((err as { log?: string }).log));
        this.finish(job, 'failed', { error: { code, message: err.message, ...(err.stage ? { stage: err.stage } : {}) } });
      }
    } finally {
      this.running.delete(job.id);
      this.abortReasons.delete(job.id);
      this.pump();
      if (this.mode === 'database') this.notifyIdle();
    }
  }

  /** Forget a job this worker no longer holds. */
  private drop(job: JobRecord, why: string) {
    this.fences.delete(job.id);
    this.active.delete(job.id);
    this.lastPersist.delete(job.id);
    const span = this.spans.get(job.id);
    if (span) {
      this.spans.delete(job.id);
      span.setAttribute('reelforge.job.status', why);
      span.end();
    }
  }

  private finish(job: JobRecord, status: JobStatus, extra: Pick<JobRecord, 'result' | 'error'>) {
    job.status = status;
    job.finishedAt = new Date().toISOString();
    if (status === 'succeeded') job.progress = { stage: 'done', fraction: 1 };
    Object.assign(job, extra);
    this.record(job);
    this.log(job, `finished: ${status}${extra.error ? ` (${extra.error.message})` : ''}`);
    const written = this.transition(job);
    // Readers fall back to the database once the final state is stored.
    void written.then(() => {
      if (this.active.get(job.id) === job) this.active.delete(job.id);
      this.fences.delete(job.id);
      this.lastPersist.delete(job.id);
    });
    this.emit({ jobId: job.id, type: 'status', job });
  }

  /** Metrics and the job's span for a final state. */
  private record(job: JobRecord) {
    this.origins.delete(job.id);
    const attrs = { 'reelforge.job.type': job.type, 'reelforge.job.status': job.status };
    const m = coreInstruments(this.telemetry.meter);
    m.jobsFinished.add(1, attrs);
    if (job.startedAt && job.finishedAt) m.jobDuration.record((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000, attrs);
    const span = this.spans.get(job.id);
    if (!span) return;
    this.spans.delete(job.id);
    span.setAttribute('reelforge.job.status', job.status);
    if (job.status === 'failed') span.setStatus({ code: SpanStatusCode.ERROR, message: `${job.error?.code ?? 'failed'}: ${job.error?.message ?? ''}`.slice(0, 500) });
    span.end();
  }

  private log(job: JobRecord, line: string): void;
  private log(level: 'info' | 'warn' | 'error', line: string): void;
  private log(target: JobRecord | 'info' | 'warn' | 'error', line: string) {
    if (typeof target === 'string') {
      this.logger(target, line);
      return;
    }
    const job = target;
    const at = new Date().toISOString();
    const text = line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE)}… [${line.length - MAX_LOG_LINE} characters cut]` : line;
    this.chain(job.id, () => this.repo.appendLog(job.id, at, text));
    this.emit({ jobId: job.id, type: 'log', job, line: `${at} ${text}` });
  }

  /** A state change: always written, in order with the job's other writes (fenced by the claim on the database queue). */
  private transition(job: JobRecord): Promise<void> {
    this.lastPersist.set(job.id, Date.now());
    const snapshot = structuredClone(job);
    const at = job.finishedAt ?? job.startedAt ?? job.createdAt;
    const fence = this.fences.get(job.id);
    return this.chain(job.id, async () => {
      const ok = await this.repo.transition(snapshot, at, fence);
      if (!ok && fence) this.abort(job.id, 'lost', 'its state could not be written: another worker holds it now');
    });
  }

  /** Progress updates are throttled to one write per 500 ms. */
  private persistProgress(job: JobRecord) {
    const now = Date.now();
    if (now - (this.lastPersist.get(job.id) ?? 0) < 500) return;
    this.lastPersist.set(job.id, now);
    const snapshot = structuredClone(job);
    const fence = this.fences.get(job.id);
    void this.chain(job.id, async () => {
      const ok = await this.repo.update(snapshot, fence);
      if (!ok && fence) this.abort(job.id, 'lost', 'its progress could not be written: another worker holds it now');
    });
  }

  private chain(key: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(fn).catch((e) => {
      this.logger('error', `could not store job ${key}: ${(e as Error).message}`);
    });
    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  /** Wait for pending state and log writes (tests, shutdown). */
  async flush(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }
}

/** insertWithQuota refused the job: which window was full and how many jobs it holds. */
export class QuotaExceeded extends Error {
  constructor(
    readonly window: number,
    readonly used: number
  ) {
    super('render quota exceeded');
  }
}

/** insertWithQuota refused the job: a job cap (D-090) is reached, with the current count. */
export class JobCapReached extends Error {
  constructor(
    readonly cap: 'active_per_key' | 'queued_total',
    readonly used: number
  ) {
    super(`job cap reached (${cap})`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
