import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SpanStatusCode, context, trace, type Context, type Span } from '@opentelemetry/api';
import { ApiError, notFound } from './errors';
import { NOOP_TELEMETRY, coreInstruments, type Telemetry } from './telemetry';
import { newId } from './fsutil';
import type { PageRequest } from './paging';
import { childJobs, isFannedOut, isTerminal, treeProgress, type ChildSpec } from './fanout';
import { defaultPriority, effectiveRank, priorityRank, type JobPriority } from './priority';
import type { DispatchListener, DispatchListenerStatus, DispatchMessage } from './dispatch';
import type { ChildSettlement, JobCaps, JobFilter, JobLeaseFence, JobProgress, JobRecord, JobRepository, JobStatus, QuotaWindow } from './repositories';

export type { JobProgress, JobRecord, JobStatus } from './repositories';
export const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

/** Longest log line stored; longer lines (e.g. a tool's whole stderr) are cut. */
const MAX_LOG_LINE = 64 * 1024;
/** Longest wait between claim attempts while the database fails. */
const MAX_BACKOFF_MS = 30_000;
/** How long shutdown() waits, after the grace period, for aborted jobs and claims in flight to hand their jobs back. */
const SETTLE_MS = 15_000;
/** Ready ids remembered per worker while they wait to be claimed (dispatch, D-104); more are dropped (the fallback poll covers them). */
const MAX_PENDING = 10_000;

/** What started a claim loop: the idle poll, the dispatch fallback poll, a dispatch message, or something on this instance. */
type ClaimTrigger = 'poll' | 'fallback' | 'wake' | 'local';

type ClaimInput = Parameters<JobRepository['claim']>[0];
/** What claimJob() did: nothing claimed, started (`run`), or handed straight back on shutdown (`handedBack`). */
type Claimed = { job: JobRecord | null; run?: Promise<void>; handedBack?: boolean };

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
  /**
   * Database queue only (D-097): fan this job out into `children` (queued rows
   * with `parentId`, fenced by this claim) and hand it off: once this resolves
   * the job stays `running` without a worker, its handler should return, and
   * its children's outcomes finish it (the last unit inserts the join, whose
   * result becomes this job's). Throws when the claim was lost or a cancel was
   * requested meanwhile.
   */
  fanOut?(children: ChildSpec[]): Promise<JobRecord[]>;
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
  /**
   * Longest wait between empty polls (queue.pollMaxIntervalMs, D-104): after an empty claim the next poll waits
   * twice as long as the last, from pollMs up to this; a claim that gets a job goes back to pollMs. Default 5000
   * (never below pollMs; equal to pollMs: no backoff).
   */
  pollMaxMs?: number;
  /**
   * Queue dispatch (D-104). `driver`: what the repository's transactions signal (`poll`: nothing; `notify`:
   * PostgreSQL NOTIFY), for metrics. `listener`: this worker's subscription (claiming roles only); a message wakes
   * the normal fair claim after a random delay of up to `jitterMs` (default 50), skipped when other workers'
   * claims already took the announced jobs. While the listener is connected, idle claiming only runs every
   * `fallbackMs` (default 30 000) so a lost message never strands a job; while it is disconnected, the poll.
   */
  dispatch?: { driver: string; listener?: DispatchListener; fallbackMs?: number; jitterMs?: number };
  /** Asked before each claim; `ok: false` pauses claiming (e.g. storage is down, so renders would only fail). */
  canClaim?: () => Promise<{ ok: boolean; reason?: string }>;
  /** `worker --once` (D-100): never claim on a timer; the only claim is the one runOnce() makes. */
  once?: boolean;
}

/** How runOnce() ended (`reelforge worker --once` turns it into the exit status, D-100). */
export type OnceOutcome =
  /** Nothing to claim within the wait (or the given job is missing, finished or running elsewhere). */
  | 'none'
  /** `--job`: the job is still queued when the wait ends (claiming paused, or its key at the running cap); run again later. */
  | 'deferred'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  /** Stopped by SIGTERM and handed back to the queue (D-077). */
  | 'released'
  /** The lease was lost (database unreachable for a lease period, or another worker took it). */
  | 'lost'
  /** A render fanned out into units and a join (D-097): its work is on the queue for any worker. */
  | 'fanned_out';

export interface OnceResult {
  outcome: OnceOutcome;
  /** The claimed job as this worker last saw it. */
  job?: JobRecord;
  /** Why nothing was claimed (outcome `none`). */
  reason?: string;
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
  /** queue.priorityAgingSeconds, read before each claim (D-103): a `batch` job queued this long counts as `standard`. 0 or unset: strict. */
  priorityAgingSeconds?: () => number | undefined;
  /** Called for every job this instance claims (or starts, in-process): the shared claim throughput (ClaimRate, D-103). */
  onClaim?: (job: JobRecord) => void;
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
  /** Queue dispatch (D-104): the driver, and this worker's listener when it has one. */
  dispatch?: {
    driver: string;
    /** The listener is connected (messages arrive); false: this worker polls until it reconnects. */
    listening?: boolean;
    listener?: DispatchListenerStatus;
    fallbackMs?: number;
    /** The current idle poll interval (backoff on empty polls). */
    pollMs: number;
    received: number;
    duplicates: number;
    fallbackClaims: number;
  };
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
  private readonly db: Required<Omit<DatabaseQueueOptions, 'canClaim' | 'workerId' | 'runJobs' | 'once' | 'dispatch'>> & Pick<DatabaseQueueOptions, 'canClaim'>;
  /** Queue dispatch (D-104): the driver, this worker's listener, fallback interval and wake jitter. */
  private readonly dispatch: { driver: string; listener?: DispatchListener; fallbackMs: number; jitterMs: number };
  /** The listener is connected: idle claiming waits for messages, with the fallback poll. */
  private listening = false;
  /** The next idle poll's delay: pollMs, doubled after each empty claim up to pollMaxMs. */
  private idleMs: number;
  /** Ready job ids announced and not yet seen claimed (by anyone), with the message order they arrived in. */
  private pending = new Map<string, { seq: number; ack?: () => Promise<void> }>();
  private seq = 0;
  private wakeTimer: NodeJS.Timeout | null = null;
  /** runOnce() waiting for a message. */
  private wakeWaiters: Array<() => void> = [];
  private counters = { received: 0, duplicates: 0, fallbackClaims: 0 };
  /** The listener is subscribed (paused while every slot is busy, so a busy worker is not sent every message). */
  private listenActive = true;
  readonly once: boolean;
  private readonly logger: NonNullable<JobRunnerOptions['log']>;
  private readonly maxRunningPerKey: () => number | undefined;
  private readonly agingSeconds: () => number | undefined;
  private readonly onClaim: (job: JobRecord) => void;
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
  /** Running jobs handed back to the queue since shutdown() started. */
  private released = 0;
  /** Jobs claimed while shutdown() started, handed straight back since then (#172). */
  private releasedClaims = 0;
  /** Claims in flight (claimJob): shutdown() waits for them, so a job they take is handed back, not left `running`. */
  private claims = new Set<Promise<unknown>>();
  /** Jobs whose handler fanned them out (D-097): when the handler returns, they are handed off, not finished. */
  private detached = new Set<string>();
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
    this.once = d.once ?? false;
    this.workerId = d.workerId ?? defaultWorkerId();
    const leaseMs = Math.max(1000, d.leaseMs ?? 60_000);
    this.db = {
      leaseMs,
      heartbeatMs: Math.max(100, d.heartbeatMs ?? Math.floor(leaseMs / 4)),
      maxAttempts: Math.max(1, d.maxAttempts ?? 3),
      pollMs: Math.max(20, d.pollMs ?? 1000),
      pollMaxMs: 0,
      canClaim: d.canClaim,
    };
    this.db.pollMaxMs = Math.max(this.db.pollMs, d.pollMaxMs ?? 5000);
    this.idleMs = this.db.pollMs;
    this.dispatch = {
      driver: d.dispatch?.driver ?? 'poll',
      ...(d.dispatch?.listener ? { listener: d.dispatch.listener } : {}),
      fallbackMs: Math.max(this.db.pollMs, d.dispatch?.fallbackMs ?? 30_000),
      jitterMs: Math.max(0, d.dispatch?.jitterMs ?? 50),
    };
    this.logger = opts.log ?? (() => undefined);
    this.maxRunningPerKey = () => {
      const n = opts.maxRunningPerKey?.();
      return n && n > 0 ? n : undefined;
    };
    this.agingSeconds = () => {
      const n = opts.priorityAgingSeconds?.();
      return n && n > 0 ? n : undefined;
    };
    this.onClaim = opts.onClaim ?? (() => undefined);
  }

  /** The claim's options besides worker, types and times: the per-key running cap and priority aging, read now. */
  private claimLimits(): Pick<ClaimInput, 'maxRunningPerKey' | 'priorityAgingSeconds'> {
    const cap = this.maxRunningPerKey();
    const aging = this.agingSeconds();
    return { ...(cap !== undefined ? { maxRunningPerKey: cap } : {}), ...(aging !== undefined ? { priorityAgingSeconds: aging } : {}) };
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
      const listener = this.dispatch.listener;
      if (listener && this.runJobs) {
        // Before claiming starts: a listener that cannot connect, or whose messages do not arrive, fails the start.
        await listener.start({
          message: (m) => this.onDispatch(m),
          connected: () => this.onListenerConnected(),
          disconnected: (reason) => this.onListenerLost(reason),
        });
        this.listening = true;
      }
      this.started = true;
      this.scheduleHeartbeat();
      this.schedulePoll(0, 'local');
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
    meta: { projectId?: string; retryOf?: string; apiKeyId?: string; priority?: JobPriority } = {},
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
      priority: meta.priority ?? defaultPriority(type),
    };
    // Durable before anyone sees the id.
    const limited =
      quota && ((meta.apiKeyId && (quota.windows.length || quota.maxActivePerKey !== undefined)) || quota.maxQueuedTotal !== undefined || quota.maxEstimatedWait !== undefined);
    if (quota && limited) {
      const r = await this.repo.insertWithQuota(structuredClone(job), job.createdAt, { ...quota, ...(meta.apiKeyId ? { apiKeyId: meta.apiKeyId } : {}) });
      if (!r.ok) {
        if (!('cap' in r)) throw new QuotaExceeded(r.window, r.used);
        throw new JobCapReached(r.cap, r.used, r.cap === 'estimated_wait' ? { oldestQueuedAt: r.oldestQueuedAt, estimatedWaitSeconds: r.estimatedWaitSeconds } : undefined);
      }
    } else {
      await this.repo.insert(structuredClone(job), job.createdAt);
    }
    if (this.mode === 'database') {
      this.queuedCount++;
      this.published(1, 'enqueue');
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
    return this.withTreeProgress(j);
  }

  /** A fanned-out parent's progress is its children's (D-097): frames done / total frames, then the join. */
  private async withTreeProgress(j: JobRecord): Promise<JobRecord> {
    if (!isFannedOut(j)) return j;
    const children = await this.repo.list({ parentId: j.id });
    return { ...j, progress: treeProgress(j, children) };
  }

  async list(filter: JobFilter = {}): Promise<JobRecord[]> {
    return this.withActive(await this.repo.list(filter));
  }

  /** One keyset page, newest first (list_jobs, D-102). */
  async page(filter: JobFilter, req: PageRequest): Promise<JobRecord[]> {
    return this.withActive(await this.repo.page(filter, req));
  }

  /** Jobs running in this process: their live state instead of the last one written. */
  private withActive(rows: JobRecord[]): JobRecord[] {
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
      ...(this.mode === 'database'
        ? {
            dispatch: {
              driver: this.dispatch.driver,
              ...(this.dispatch.listener && this.runJobs ? { listening: this.listening, listener: this.dispatch.listener.status(), fallbackMs: this.dispatch.fallbackMs } : {}),
              pollMs: this.idleMs,
              ...this.counters,
            },
          }
        : {}),
    };
  }

  /** Position in this instance's in-process queue (0 = next: higher classes first, then queue order), or null if not queued here. */
  queuePosition(id: string): number | null {
    const i = this.queue.indexOf(id);
    if (i < 0) return null;
    const rank = priorityRank(this.active.get(id)?.priority);
    return this.queue.filter((q, k) => {
      const r = priorityRank(this.active.get(q)?.priority);
      return r < rank || (r === rank && k < i);
    }).length;
  }

  /** Position of a queued job (0 = next): in-process or, for the database queue, among all instances. */
  async positionOf(job: JobRecord): Promise<number | null> {
    if (job.status !== 'queued') return null;
    if (job.queue !== 'database') return this.queuePosition(job.id);
    return this.repo.countQueued({ createdAt: job.createdAt, id: job.id, ...(job.priority ? { priority: job.priority } : {}) });
  }

  async cancel(id: string): Promise<JobRecord> {
    // Fan-out (D-097): cancelling a unit or the join cancels its render, and a render cascades to its children.
    const parentId = (this.active.get(id) ?? (await this.repo.get(id)))?.parentId;
    if (parentId) return this.cancel(parentId);
    const tree = await this.cancelTree(id);
    if (tree) return tree;
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
    // It may have fanned out meanwhile (its fan-out wins over the request only if it was stored first): cascade then.
    return (await this.cancelTree(id)) ?? this.get(id);
  }

  /** Cancel a fanned-out render and its children (D-097); null when the job is not one. */
  private async cancelTree(id: string): Promise<JobRecord | null> {
    if (this.mode !== 'database') return null;
    const stored = await this.repo.get(id);
    if (!stored || !isFannedOut(stored)) return null;
    const at = new Date().toISOString();
    const changed = await this.repo.cancelTree(id, at);
    if (!changed) return null;
    await this.repo.appendLog(id, at, `finished: cancelled (with its ${changed.length - 1} queued unit(s); running units stop at their next heartbeat; by ${this.workerId})`);
    this.emitSettled(changed);
    return this.get(id);
  }

  /** Status events and metrics for jobs a fan-out transaction finished or cancelled (they ran on no worker here). */
  private emitSettled(jobs: JobRecord[]) {
    const m = coreInstruments(this.telemetry.meter);
    for (const j of jobs) {
      if (isTerminal(j.status)) m.jobsFinished.add(1, { 'reelforge.job.type': j.type, 'reelforge.job.status': j.status });
      if (j.status === 'cancelled' && j.parentId) this.queuedCount = Math.max(0, this.queuedCount - 1);
      this.emit({ jobId: j.id, type: 'status', job: j });
    }
  }

  /** Start a new job with the same type and parameters. The old job and its output are untouched. */
  async retry(id: string, meta: { apiKeyId?: string; priority?: JobPriority } = {}, quota?: { types: string[]; windows: QuotaWindow[] } & JobCaps): Promise<JobRecord> {
    const job = await this.get(id);
    if (!TERMINAL.includes(job.status) || job.status === 'succeeded') {
      throw new ApiError('conflict', 409, `only failed or cancelled jobs can be retried (job is ${job.status})`);
    }
    if (job.parentId) throw new ApiError('conflict', 409, `job ${id} is part of render job ${job.parentId}; retry that job (its committed units are reused)`);
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
   * another worker takes them at once. Leases are released either way. A
   * claim still in flight hands its job straight back too (#172); the wait for
   * aborted jobs and claims is bounded (15 s), after which a job left behind
   * waits for its lease to end.
   */
  async shutdown(graceMs: number): Promise<{ finished: number; released: number }> {
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const runningAtStart = this.running.size;
    this.released = 0;
    this.releasedClaims = 0;
    if (runningAtStart) this.log('info', `shutting down: waiting up to ${Math.round(graceMs / 1000)} s for ${runningAtStart} running job(s)`);
    const deadline = Date.now() + graceMs;
    while (this.running.size && Date.now() < deadline) await sleep(Math.min(200, deadline - Date.now()));
    const left = [...this.running.keys()];
    for (const id of left) {
      this.abortReasons.set(id, this.mode === 'database' ? 'release' : 'cancel');
      this.running.get(id)?.abort();
    }
    // Aborted handlers settle quickly; the release (or final state) is written in start(). A claim in flight
    // hands its job back in claimJob().
    const settle = Date.now() + SETTLE_MS;
    while ((this.running.size || this.claims.size) && Date.now() < settle) await sleep(50);
    if (this.claims.size) this.log('warn', `shutting down: a job claim is still in flight after ${SETTLE_MS / 1000} s; a job it takes waits for its lease to end`);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.releaseWaiters();
    if (this.dispatch.listener && this.runJobs) {
      this.listening = false;
      await this.dispatch.listener.stop().catch((e: Error) => this.log('warn', `queue: could not stop the dispatch listener: ${e.message}`));
    }
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const w of this.watchers.values()) clearInterval(w.timer);
    this.watchers.clear();
    await this.flush();
    return { finished: runningAtStart - this.released, released: this.released + this.releasedClaims };
  }

  private emit(e: JobEvent) {
    this.events.emit('event', { ...e, job: structuredClone(e.job) });
  }

  private pump() {
    if (this.mode === 'database') {
      void this.claimLoop('local');
      return;
    }
    const cap = this.maxRunningPerKey();
    const aging = this.agingSeconds();
    // Priority first (D-103; batch aged into standard), then fair across keys (D-090): start the queued job whose
    // key runs the fewest jobs, oldest first among equals; jobs of a key at its cap (limits.maxRunningJobsPerKey)
    // wait and keep their place.
    this.queue = this.queue.filter((id) => this.active.get(id)?.status === 'queued');
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      let best = -1;
      let bestRank = Infinity;
      let bestRunning = Infinity;
      const now = Date.now();
      for (const [i, id] of this.queue.entries()) {
        const job = this.active.get(id)!;
        const key = job.apiKeyId;
        const n = key ? this.runningFor(key) : 0;
        if (cap !== undefined && key && n >= cap) continue;
        const r = effectiveRank(priorityRank(job.priority), Date.parse(job.createdAt), now, aging);
        if (r < bestRank || (r === bestRank && n < bestRunning)) {
          best = i;
          bestRank = r;
          bestRunning = n;
          if (n === 0 && r === 0) break;
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

  private schedulePoll(ms: number, trigger: ClaimTrigger = 'poll') {
    if (!this.started || this.stopping || !this.runJobs || this.once) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.claimLoop(trigger);
    }, ms);
    this.pollTimer.unref();
  }

  /**
   * The next idle claim (D-104). Listening for dispatch messages: only the fallback poll. Polling: pollMs while
   * claims get jobs (as before), otherwise twice the last wait after each empty claim, up to pollMaxMs, with up to
   * 10 % random spread so idle workers do not poll in step.
   */
  private scheduleIdle(empty: boolean) {
    if (this.listening) {
      this.schedulePoll(this.dispatch.fallbackMs, 'fallback');
      return;
    }
    if (!empty) {
      this.idleMs = this.db.pollMs;
      this.schedulePoll(this.db.pollMs);
      return;
    }
    const wait = this.idleMs;
    this.idleMs = Math.min(this.db.pollMaxMs, this.idleMs * 2);
    this.schedulePoll(wait > this.db.pollMs ? wait + Math.floor(Math.random() * wait * 0.1) : wait);
  }

  /** Claim queued jobs while there are free slots. One loop at a time; a request during a loop runs it again. */
  private async claimLoop(trigger: ClaimTrigger = 'local'): Promise<void> {
    if (!this.started || this.stopping || !this.runJobs || this.once) return;
    if (this.claiming) {
      this.claimAgain = true;
      return;
    }
    this.claiming = true;
    // Whether the last claim attempt found nothing (the queue holds nothing this worker may take now).
    let empty = false;
    let claimedAny = false;
    const m = coreInstruments(this.telemetry.meter);
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
          // Subscribed again before the claim, so a job committed after the claim's snapshot is still announced.
          await this.syncListen();
          const now = Date.now();
          // Ready messages that arrived before this attempt are answered by it (a later one may announce a job it missed).
          const seenSeq = this.seq;
          const { job, run } = await this.claimJob({
            workerId: this.workerId,
            types: Object.keys(this.handlers),
            now: new Date(now).toISOString(),
            leaseUntil: new Date(now + this.db.leaseMs).toISOString(),
            ...this.claimLimits(),
          });
          this.ok('claim');
          m.queueClaims.add(1, { 'reelforge.trigger': trigger, 'reelforge.result': job ? 'job' : 'empty' });
          if (job) this.consumePending(job.id);
          empty = !job;
          if (empty) this.consumePendingUpTo(seenSeq);
          // Nothing claimed, or shutdown() started meanwhile and the job went straight back.
          if (!run) break;
          claimedAny = true;
          this.queuedCount = Math.max(0, this.queuedCount - 1);
          if (this.dispatch.driver !== 'poll' && (trigger === 'fallback' || (trigger === 'poll' && this.dispatch.listener && !this.listening))) {
            // A message should have announced this job (fallback), or the listener is down (degraded).
            this.counters.fallbackClaims++;
            m.dispatchFallbackClaims.add(1, { 'reelforge.dispatch.driver': this.dispatch.driver, 'reelforge.reason': trigger === 'fallback' ? 'fallback' : 'degraded' });
          }
        }
      } while (this.claimAgain && !this.stopping);
      this.backoffMs = 0;
      // Every slot busy: stop receiving messages until one frees (the claim after a job ends subscribes again).
      void this.syncListen();
      this.scheduleIdle(empty && !claimedAny);
    } catch (e) {
      this.failed('claim', e as Error);
      this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs ? this.backoffMs * 2 : this.db.pollMs * 2);
      this.schedulePoll(this.backoffMs + Math.floor(Math.random() * this.db.pollMs));
    } finally {
      this.claiming = false;
    }
  }

  // ---- queue dispatch (D-104) -----------------------------------------------------

  /**
   * A dispatch message. It never picks the job: `ready` schedules the normal claim (priority, then fairness across
   * keys, then age; D-090, D-103) after a random delay of up to jitterMs, `claimed` forgets an announced job. When
   * the delay ends and every announced job was claimed by another worker meanwhile, no claim runs, so one job does
   * not cost one claim per idle worker. A worker without a free slot claims when its job ends (as always).
   * Duplicate or stale ids are no-ops: at most one claim, which takes whatever the fair order says or nothing.
   */
  private onDispatch(msg: DispatchMessage) {
    const m = coreInstruments(this.telemetry.meter);
    const driver = { 'reelforge.dispatch.driver': this.dispatch.driver };
    m.dispatchReceived.add(1, { ...driver, 'reelforge.dispatch.kind': msg.kind });
    if (msg.kind === 'claimed') {
      this.consumePending(msg.jobId);
      return;
    }
    this.counters.received++;
    if (this.pending.has(msg.jobId)) {
      this.counters.duplicates++;
      m.dispatchDuplicates.add(1, driver);
      void msg.ack?.().catch(() => undefined);
      return;
    }
    if (this.pending.size >= MAX_PENDING) {
      // Far more announced than claimed: forget the oldest (the fallback poll claims whatever they announced).
      const [oldest] = this.pending.keys();
      this.consumePending(oldest!);
    }
    this.pending.set(msg.jobId, { seq: ++this.seq, ...(msg.ack ? { ack: msg.ack } : {}) });
    this.releaseWaiters();
    if (!this.started || this.stopping || this.once || !this.runJobs || this.running.size >= this.concurrency || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      if (this.pending.size && this.running.size < this.concurrency) void this.claimLoop('wake');
    }, Math.floor(Math.random() * this.dispatch.jitterMs));
    this.wakeTimer.unref();
  }

  /** Subscribe while a slot is free, unsubscribe while none is (drivers with setActive). */
  private async syncListen(want = this.running.size < this.concurrency && !this.stopping): Promise<void> {
    const l = this.dispatch.listener;
    if (!l?.setActive || !this.listening || want === this.listenActive) return;
    this.listenActive = want;
    await l.setActive(want).catch((e: Error) => this.log('warn', `queue: could not ${want ? 'resume' : 'pause'} the dispatch listener: ${e.message}`));
  }

  private onListenerConnected() {
    this.listening = true;
    this.idleMs = this.db.pollMs;
    this.log('info', `queue: dispatch listener (${this.dispatch.driver}) connected again; claiming once for messages missed meanwhile`);
    void this.claimLoop('wake');
  }

  private onListenerLost(reason: string) {
    if (this.stopping) return;
    this.listening = false;
    this.idleMs = this.db.pollMs;
    this.log('warn', `queue: dispatch listener (${this.dispatch.driver}) disconnected (${reason}); polling every ${this.db.pollMs} ms (backing off to ${this.db.pollMaxMs} ms) until it reconnects`);
    this.schedulePoll(this.db.pollMs);
  }

  /** An announced job was claimed (by anyone): forget it, acknowledging its message. */
  private consumePending(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    void p.ack?.().catch(() => undefined);
  }

  /** A claim found nothing: every job announced before it started is taken, or not claimable by this worker now. */
  private consumePendingUpTo(seq: number) {
    for (const [id, p] of this.pending) if (p.seq <= seq) this.consumePending(id);
  }

  private releaseWaiters() {
    for (const w of this.wakeWaiters.splice(0)) w();
  }

  /** Sleep up to `ms`, or less when a ready message arrives (runOnce). */
  private waitForWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeWaiters = this.wakeWaiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      this.wakeWaiters.push(done);
    });
  }

  /** Dispatch metric: ready messages this instance's transactions published (the repository sends them; D-104). */
  private published(n: number, reason: 'enqueue' | 'requeue' | 'release' | 'fanout' | 'join') {
    if (this.dispatch.driver === 'poll' || n <= 0) return;
    coreInstruments(this.telemetry.meter).dispatchPublished.add(n, { 'reelforge.dispatch.driver': this.dispatch.driver, 'reelforge.reason': reason });
  }

  /**
   * `worker --once` (D-100): claim at most one job (exactly `jobId` when given,
   * with the same fenced claim as every worker), run it and report how it
   * ended. Waits up to `waitMs` for a job to be queued, polling every
   * `queue.pollIntervalMs`; returns `none` sooner when the given job is
   * missing or finished, or when shutdown() starts (`deferred` instead when
   * the given job is still queued then, or when the wait ends). Needs the database
   * queue with `once: true` and init() called; never claims a second job.
   */
  async runOnce(opts: { jobId?: string; waitMs: number }): Promise<OnceResult> {
    if (this.mode !== 'database' || !this.once || !this.runJobs) throw new Error('runOnce needs the database queue with once: true');
    if (!this.started) throw new Error('call init() before runOnce()');
    const deadline = Date.now() + Math.max(0, opts.waitMs);
    let reason = `nothing was queued within ${opts.waitMs} ms`;
    // --job: the job was still queued when the wait ended (paused claiming, per-key cap), so it still needs a run.
    let stillQueued = false;
    for (;;) {
      if (this.stopping) {
        const queued = opts.jobId !== undefined && (await this.repo.get(opts.jobId).catch(() => null))?.status === 'queued';
        return { outcome: queued ? 'deferred' : 'none', reason: 'shutting down before a job was claimed' };
      }
      let job: JobRecord | null = null;
      let claimed: Claimed | undefined;
      try {
        const can = this.db.canClaim ? await this.db.canClaim().catch((e: Error) => ({ ok: false, reason: e.message })) : { ok: true };
        if (!can.ok) {
          reason = `not claiming jobs: ${can.reason ?? 'not ready'}`;
          if (opts.jobId !== undefined) stillQueued = (await this.repo.get(opts.jobId))?.status === 'queued';
          if (this.pausedReason !== reason) this.log('warn', `queue: ${reason}`);
          this.pausedReason = reason;
        } else {
          this.pausedReason = undefined;
          const now = Date.now();
          claimed = await this.claimJob({
            workerId: this.workerId,
            types: Object.keys(this.handlers),
            now: new Date(now).toISOString(),
            leaseUntil: new Date(now + this.db.leaseMs).toISOString(),
            ...this.claimLimits(),
            ...(opts.jobId !== undefined ? { id: opts.jobId } : {}),
          });
          job = claimed.job;
          this.ok('claim');
          coreInstruments(this.telemetry.meter).queueClaims.add(1, { 'reelforge.trigger': 'local', 'reelforge.result': job ? 'job' : 'empty' });
          if (job) {
            this.consumePending(job.id);
            // One job per process: nothing else to wake it for.
            void this.syncListen(false);
          }
          if (!job && opts.jobId !== undefined) {
            // A launcher started this container for one job: when that job is gone or finished there is nothing to wait for.
            const stored = await this.repo.get(opts.jobId);
            if (!stored) return { outcome: 'none', reason: `job ${opts.jobId} does not exist` };
            if (TERMINAL.includes(stored.status)) return { outcome: 'none', reason: `job ${opts.jobId} is already ${stored.status}`, job: stored };
            reason =
              stored.status === 'queued'
                ? `job ${opts.jobId} is still queued (its API key is at limits.maxRunningJobsPerKey, or another worker is claiming it)`
                : `job ${opts.jobId} is ${stored.status}${stored.workerId ? ` on worker ${stored.workerId}` : ''}, not queued`;
            stillQueued = stored.status === 'queued';
          }
        }
      } catch (e) {
        this.failed('claim', e as Error);
        reason = `the queue could not be read: ${(e as Error).message.split('\n').filter(Boolean).pop() ?? 'unknown error'}`;
      }
      if (job) {
        // SIGTERM arrived while the claim was in flight: claimJob() handed it straight back.
        if (!claimed?.run) return { outcome: claimed?.handedBack ? 'released' : 'lost', job };
        await claimed.run;
        await this.flush();
        const outcome: OnceOutcome = TERMINAL.includes(job.status) ? (job.status as OnceOutcome) : job.status === 'queued' ? 'released' : isFannedOut(job) ? 'fanned_out' : 'lost';
        return { outcome, job: structuredClone(job) };
      }
      const left = deadline - Date.now();
      if (left <= 0) return { outcome: stillQueued ? 'deferred' : 'none', reason };
      // Listening (D-104): a ready message ends the wait at once; the poll stays as the fallback.
      if (this.listening) {
        const announced = this.seq;
        await this.waitForWake(Math.min(this.dispatch.fallbackMs, left));
        if (this.seq !== announced) await sleep(Math.floor(Math.random() * this.dispatch.jitterMs));
      } else await sleep(Math.min(this.db.pollMs, left));
    }
  }

  /**
   * One claim, tracked in `claims` until the job it took is either started
   * (`run`, registered in `running` before the claim stops counting, so
   * shutdown() always sees one or the other) or, when shutdown() started while
   * the claim was in flight, handed straight back like a running job
   * (`queued`, attempt not counted, D-077; `handedBack` false: the release
   * failed and the lease ends on its own). Claims nothing once shutdown() has
   * started.
   */
  private claimJob(input: ClaimInput): Promise<Claimed> {
    const claim = (async (): Promise<Claimed> => {
      if (this.stopping) return { job: null };
      const job = await this.repo.claim(input);
      if (!job) return { job };
      if (!this.stopping) return { job, run: this.start(job) };
      const handedBack = await this.repo.release(job.id, { workerId: this.workerId, attempts: job.attempts ?? 1 }, new Date().toISOString()).catch((e: Error) => {
        this.log('warn', `queue: could not hand back job ${job.id}, claimed as shutdown began (its lease expires on its own): ${e.message}`);
        return false;
      });
      if (!handedBack) return { job, handedBack };
      coreInstruments(this.telemetry.meter).jobsRequeued.add(1, { 'reelforge.reason': 'released' });
      this.published(1, 'release');
      this.releasedClaims++;
      this.log('info', `queue: job ${job.id} was claimed as shutdown began; handed back to the queue`);
      return { job: { ...job, status: 'queued' }, handedBack };
    })();
    this.claims.add(claim);
    const done = () => void this.claims.delete(claim);
    claim.then(done, done);
    return claim;
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
      const { requeued, failed, settled } = await this.repo.recoverExpired(new Date(now).toISOString(), this.db.maxAttempts);
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
      if (settled?.length) this.emitSettled(settled);
      this.queuedCount = await this.repo.countQueued();
      this.ok('recover');
      this.published(requeued.length, 'requeue');
      if (requeued.length && this.runJobs) void this.claimLoop('local');
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
    const stored = await this.repo.get(id).catch(() => null);
    const job = stored && (await this.withTreeProgress(stored).catch(() => stored));
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
    this.recordClaim(job);
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
      ...(fence ? { fanOut: (children: ChildSpec[]) => this.fanOut(job, fence, controller, children) } : {}),
    };
    try {
      const result = await context.with(trace.setSpan(parent, span), () => this.handlers[job.type]!(ctx));
      if (this.detached.delete(job.id)) {
        // Fanned out: no worker holds it now; its children finish it (D-097).
        this.emit({ jobId: job.id, type: 'status', job });
        this.drop(job, 'fanned out');
        return;
      }
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
          this.published(1, 'release');
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
      this.detached.delete(job.id);
      this.running.delete(job.id);
      this.abortReasons.delete(job.id);
      this.pump();
      if (this.mode === 'database') this.notifyIdle();
    }
  }

  /**
   * A claim (or an in-process start): the claim throughput hook, and the queue-wait histogram (D-103) for a render or
   * preview's first claim, labelled with its type and priority only. Units and joins are not measured: their queue
   * position (createdAt) is their render's, not when they were queued. A job handed back on shutdown counts again
   * from its enqueue at its next first claim (its attempt is not counted, D-077).
   */
  private recordClaim(job: JobRecord) {
    try {
      this.onClaim(job);
    } catch {
      // statistics never stop a job
    }
    if (job.parentId || (job.attempts ?? 1) > 1 || !job.startedAt) return;
    const wait = Math.max(0, (Date.parse(job.startedAt) - Date.parse(job.createdAt)) / 1000);
    coreInstruments(this.telemetry.meter).queueWait.record(wait, { 'reelforge.job.type': job.type, 'reelforge.job.priority': job.priority ?? 'standard' });
  }

  /** JobContext.fanOut (D-097): store the children and hand the parent off, in order with the job's other writes. */
  private async fanOut(job: JobRecord, fence: JobLeaseFence, controller: AbortController, specs: ChildSpec[]): Promise<JobRecord[]> {
    if (!specs.length) throw new Error('fanOut needs at least one child');
    if (controller.signal.aborted) throw new Error('cancelled');
    const at = new Date().toISOString();
    const children = childJobs(job, specs);
    const snapshot: JobRecord = { ...structuredClone(job), pendingChildren: children.length, progress: { stage: 'render', fraction: 0, detail: `${children.length} units queued` } };
    let outcome: Awaited<ReturnType<JobRepository['fanOut']>> | undefined;
    let error: unknown;
    await this.chain(job.id, async () => {
      try {
        outcome = await this.repo.fanOut(snapshot, children, at, fence);
      } catch (e) {
        error = e;
      }
    });
    if (error) throw error;
    if (outcome === 'lost') {
      this.abort(job.id, 'lost', 'its fan-out could not be stored: another worker holds it now');
      throw new Error('the job was lost before its fan-out was stored');
    }
    if (outcome === 'cancelled') {
      this.abortReasons.set(job.id, 'cancel');
      controller.abort();
      throw new Error('cancelled');
    }
    // No heartbeat for it any more: the row has no worker and no lease.
    this.fences.delete(job.id);
    this.detached.add(job.id);
    Object.assign(job, { pendingChildren: children.length, progress: snapshot.progress });
    delete job.workerId;
    delete job.leaseExpiresAt;
    this.queuedCount += children.length;
    this.published(children.length, 'fanout');
    this.log(job, `fanned out into ${children.length} units on the queue; no worker holds this job until its join finishes it`);
    for (const c of children) this.emit({ jobId: c.id, type: 'status', job: c });
    if (this.runJobs) queueMicrotask(() => this.pump());
    return children.map((c) => structuredClone(c));
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
    if (job.parentId && isTerminal(job.status) && this.mode === 'database') {
      return this.chain(job.id, async () => {
        const settled = await this.repo.finishChild(snapshot, at, fence);
        if (!settled) {
          if (fence) this.abort(job.id, 'lost', 'its state could not be written: another worker holds it now');
          return;
        }
        await this.afterChild(job, settled, at);
      });
    }
    return this.chain(job.id, async () => {
      const ok = await this.repo.transition(snapshot, at, fence);
      if (!ok && fence) this.abort(job.id, 'lost', 'its state could not be written: another worker holds it now');
    });
  }

  /** What a child's final state did to its render (D-097): events, the parent's log, and claim the join at once. */
  private async afterChild(child: JobRecord, s: ChildSettlement, at: string) {
    if (!s.parent) return;
    const p = child.params as { index?: number; count?: number; sceneId?: string };
    const what = child.type.endsWith('_join') ? 'join' : `unit ${typeof p.index === 'number' ? p.index + 1 : '?'}${p.count ? `/${p.count}` : ''}${p.sceneId ? ` (scene "${p.sceneId}")` : ''}`;
    const line = s.parentFinished
      ? `finished: ${s.parent.status}${s.parent.error ? ` (${s.parent.error.message})` : ''}${s.cancelled.length ? `; ${s.cancelled.length} queued unit(s) cancelled` : ''}`
      : `${what} ${child.status} on worker ${this.workerId} (job ${child.id}); ${s.parent.pendingChildren ?? 0} unit(s) left${s.join ? `; join queued as job ${s.join.id}` : ''}`;
    await this.repo.appendLog(s.parent.id, at, line);
    if (s.parentFinished) this.emitSettled([s.parent]);
    if (s.cancelled.length) this.emitSettled(s.cancelled);
    if (s.join) {
      this.queuedCount++;
      this.published(1, 'join');
      this.emit({ jobId: s.join.id, type: 'status', job: s.join });
      if (this.runJobs) queueMicrotask(() => this.pump());
    }
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
    readonly cap: 'active_per_key' | 'queued_total' | 'estimated_wait',
    readonly used: number,
    /** `estimated_wait`: the oldest queued job ahead and the estimate (D-103). */
    readonly wait?: { oldestQueuedAt: string; estimatedWaitSeconds: number }
  ) {
    super(`job cap reached (${cap})`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
