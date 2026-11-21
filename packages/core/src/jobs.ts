import { EventEmitter } from 'node:events';
import { ApiError, notFound } from './errors';
import { newId } from './fsutil';
import type { JobFilter, JobProgress, JobRecord, JobRepository, JobStatus } from './repositories';

export type { JobProgress, JobRecord, JobStatus } from './repositories';
export const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

/** Longest log line stored; longer lines (e.g. a tool's whole stderr) are cut. */
const MAX_LOG_LINE = 64 * 1024;

export interface JobEvent {
  jobId: string;
  type: 'status' | 'progress' | 'log';
  job: JobRecord;
  line?: string;
}

export interface JobContext {
  job: JobRecord;
  signal: AbortSignal;
  log(line: string): void;
  progress(stage: string, fraction: number, detail?: string): void;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown>>;

export interface JobRunnerOptions {
  repo: JobRepository;
  /** Jobs that run at the same time. Renders are CPU and memory heavy: default 1. */
  concurrency?: number;
  handlers: Record<string, JobHandler>;
}

/**
 * In-process job queue with persisted state (JobRepository): the job row
 * (status, progress, result or error) and its events (status changes and log
 * lines).
 *
 * queued → running → succeeded | failed | cancelled. Every state change is one
 * transaction (job row + status event). Cancellation aborts the handler's
 * AbortSignal. Jobs left queued/running by a previous process are marked
 * failed on start (their work cannot be resumed).
 *
 * Jobs this process is running are kept in memory (their progress is newer
 * than the throttled database copy); everything else is read from the
 * database.
 */
export class JobRunner {
  private _concurrency: number;
  private readonly repo: JobRepository;
  private handlers: Record<string, JobHandler>;
  /** Queued and running jobs of this process. */
  private active = new Map<string, JobRecord>();
  private queue: string[] = [];
  private running = new Map<string, AbortController>();
  private events = new EventEmitter();
  private lastPersist = new Map<string, number>();
  private idleWaiters: Array<() => void> = [];
  /** Per-job write chains so state and log writes land in order. */
  private chains = new Map<string, Promise<void>>();

  constructor(opts: JobRunnerOptions) {
    this.repo = opts.repo;
    this._concurrency = Math.max(1, opts.concurrency ?? 1);
    this.handlers = opts.handlers;
    this.events.setMaxListeners(0);
  }

  get concurrency(): number {
    return this._concurrency;
  }

  /** Change how many jobs run at once (runtime setting limits.renderConcurrency). Running jobs are never stopped. */
  setConcurrency(n: number): void {
    this._concurrency = Math.max(1, Math.floor(n));
    queueMicrotask(() => this.pump());
  }

  async init(): Promise<void> {
    for (const job of await this.repo.listUnfinished()) {
      if (this.active.has(job.id)) continue;
      const now = new Date().toISOString();
      job.status = 'failed';
      job.finishedAt = now;
      job.error = { code: 'interrupted', message: 'the server restarted before this job finished; start it again' };
      await this.repo.transition(job, now);
      await this.repo.appendLog(job.id, now, 'finished: failed (interrupted by a server restart)');
    }
  }

  async submit(type: string, params: Record<string, unknown>, meta: { projectId?: string; retryOf?: string; apiKeyId?: string } = {}): Promise<JobRecord> {
    if (!this.handlers[type]) throw new ApiError('bad_request', 400, `unknown job type "${type}"`);
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
    };
    // Durable before anyone sees the id.
    await this.repo.insert(structuredClone(job), job.createdAt);
    this.active.set(job.id, job);
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

  /** Position in the queue (0 = next), or null if not queued. */
  queuePosition(id: string): number | null {
    const i = this.queue.indexOf(id);
    return i < 0 ? null : i;
  }

  async cancel(id: string): Promise<JobRecord> {
    const job = this.active.get(id);
    if (!job) return this.get(id); // finished (or another process's): nothing to cancel here
    if (job.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      this.finish(job, 'cancelled', { error: { code: 'cancelled', message: 'cancelled before it started' } });
    } else {
      this.log(job, 'cancel requested');
      this.running.get(id)?.abort();
    }
    return structuredClone(job);
  }

  /** Start a new job with the same type and parameters. The old job and its output are untouched. */
  async retry(id: string, meta: { apiKeyId?: string } = {}): Promise<JobRecord> {
    const job = await this.get(id);
    if (!TERMINAL.includes(job.status) || job.status === 'succeeded') {
      throw new ApiError('conflict', 409, `only failed or cancelled jobs can be retried (job is ${job.status})`);
    }
    return this.submit(job.type, job.params, { projectId: job.projectId, retryOf: job.id, ...meta });
  }

  async logs(id: string, tail?: number): Promise<string[]> {
    await this.get(id);
    await this.chains.get(id);
    return this.repo.logs(id, tail);
  }

  subscribe(id: string, fn: (e: JobEvent) => void): () => void {
    const listener = (e: JobEvent) => {
      if (e.jobId === id) fn(e);
    };
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  /** Resolves when one job reaches a terminal state. */
  async waitFor(id: string, timeoutMs = 600_000): Promise<JobRecord> {
    const job = await this.get(id);
    if (TERMINAL.includes(job.status) || !this.active.has(id)) return job;
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

  /** Resolves when nothing is queued or running. */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private emit(e: JobEvent) {
    this.events.emit('event', { ...e, job: structuredClone(e.job) });
  }

  private pump() {
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const job = this.active.get(id);
      if (!job || job.status !== 'queued') continue;
      void this.start(job);
    }
    if (this.queue.length === 0 && this.running.size === 0) {
      const waiters = this.idleWaiters.splice(0);
      for (const w of waiters) w();
    }
  }

  private async start(job: JobRecord) {
    const controller = new AbortController();
    this.running.set(job.id, controller);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.progress = { stage: 'starting', fraction: 0 };
    await this.transition(job);
    this.emit({ jobId: job.id, type: 'status', job });
    this.log(job, `started ${job.type}`);
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
      const result = await this.handlers[job.type]!(ctx);
      if (controller.signal.aborted) throw new Error('cancelled');
      this.finish(job, 'succeeded', { result });
    } catch (e) {
      const err = e as Error & { code?: string; stage?: string };
      if (controller.signal.aborted) {
        this.finish(job, 'cancelled', { error: { code: 'cancelled', message: 'cancelled while running' } });
      } else {
        const code = e instanceof ApiError ? e.code : err.name === 'PipelineError' ? 'render_failed' : 'job_failed';
        this.log(job, `error: ${err.message}`);
        if ((err as { log?: string }).log) this.log(job, String((err as { log?: string }).log));
        this.finish(job, 'failed', { error: { code, message: err.message, ...(err.stage ? { stage: err.stage } : {}) } });
      }
    } finally {
      this.running.delete(job.id);
      this.pump();
    }
  }

  private finish(job: JobRecord, status: JobStatus, extra: Pick<JobRecord, 'result' | 'error'>) {
    job.status = status;
    job.finishedAt = new Date().toISOString();
    if (status === 'succeeded') job.progress = { stage: 'done', fraction: 1 };
    Object.assign(job, extra);
    this.log(job, `finished: ${status}${extra.error ? ` (${extra.error.message})` : ''}`);
    const written = this.transition(job);
    // Readers fall back to the database once the final state is stored.
    void written.then(() => {
      if (this.active.get(job.id) === job) this.active.delete(job.id);
      this.lastPersist.delete(job.id);
    });
    this.emit({ jobId: job.id, type: 'status', job });
  }

  private log(job: JobRecord, line: string) {
    const at = new Date().toISOString();
    const text = line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE)}… [${line.length - MAX_LOG_LINE} characters cut]` : line;
    this.chain(job.id, () => this.repo.appendLog(job.id, at, text));
    this.emit({ jobId: job.id, type: 'log', job, line: `${at} ${text}` });
  }

  /** A state change: always written, in order with the job's other writes. */
  private transition(job: JobRecord): Promise<void> {
    this.lastPersist.set(job.id, Date.now());
    const snapshot = structuredClone(job);
    const at = job.finishedAt ?? job.startedAt ?? job.createdAt;
    return this.chain(job.id, () => this.repo.transition(snapshot, at));
  }

  /** Progress updates are throttled to one write per 500 ms. */
  private persistProgress(job: JobRecord) {
    const now = Date.now();
    if (now - (this.lastPersist.get(job.id) ?? 0) < 500) return;
    this.lastPersist.set(job.id, now);
    const snapshot = structuredClone(job);
    void this.chain(job.id, () => this.repo.update(snapshot));
  }

  private chain(key: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(fn).catch((e) => {
      console.error(`[reelforge] could not store job ${key}: ${(e as Error).message}`);
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
