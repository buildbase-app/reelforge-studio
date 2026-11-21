import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ApiError, notFound } from './errors';
import { newId, readJson, writeJsonAtomic } from './fsutil';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

export interface JobProgress {
  stage: string;
  /** 0..1 for the whole job. */
  fraction: number;
  detail?: string;
}

export interface JobRecord {
  id: string;
  type: string;
  status: JobStatus;
  projectId?: string;
  params: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress: JobProgress;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; stage?: string };
  /** Job this one retries, if any. */
  retryOf?: string;
}

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
  dataDir: string;
  /** Jobs that run at the same time. Renders are CPU and memory heavy: default 1. */
  concurrency?: number;
  handlers: Record<string, JobHandler>;
}

/**
 * In-process job queue with persisted state:
 *   <dataDir>/jobs/<id>.json   status, progress, result or error
 *   <dataDir>/jobs/<id>.log    log lines
 *
 * queued → running → succeeded | failed | cancelled. Cancellation aborts the
 * handler's AbortSignal. Jobs left queued/running by a previous process are
 * marked failed on start (their work cannot be resumed).
 */
export class JobRunner {
  readonly dir: string;
  readonly concurrency: number;
  private handlers: Record<string, JobHandler>;
  private jobs = new Map<string, JobRecord>();
  private queue: string[] = [];
  private running = new Map<string, AbortController>();
  private events = new EventEmitter();
  private lastPersist = new Map<string, number>();
  private idleWaiters: Array<() => void> = [];
  /** Per-job write chains so state and log writes land in order. */
  private chains = new Map<string, Promise<void>>();

  constructor(opts: JobRunnerOptions) {
    this.dir = resolve(opts.dataDir, 'jobs');
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.handlers = opts.handlers;
    this.events.setMaxListeners(0);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const f of await readdir(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const job = await readJson<JobRecord>(join(this.dir, f));
      if (!job) continue;
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.error = { code: 'interrupted', message: 'the server restarted before this job finished; start it again' };
        await this.persist(job, true);
      }
      this.jobs.set(job.id, job);
    }
  }

  submit(type: string, params: Record<string, unknown>, meta: { projectId?: string; retryOf?: string } = {}): JobRecord {
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
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    void this.persist(job, true);
    this.emit({ jobId: job.id, type: 'status', job });
    queueMicrotask(() => this.pump());
    return structuredClone(job);
  }

  get(id: string): JobRecord {
    const j = this.jobs.get(id);
    if (!j) throw notFound('job', id);
    return structuredClone(j);
  }

  list(filter: { projectId?: string; status?: JobStatus; type?: string } = {}): JobRecord[] {
    return [...this.jobs.values()]
      .filter((j) => (!filter.projectId || j.projectId === filter.projectId) && (!filter.status || j.status === filter.status) && (!filter.type || j.type === filter.type))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((j) => structuredClone(j));
  }

  /** Position in the queue (0 = next), or null if not queued. */
  queuePosition(id: string): number | null {
    const i = this.queue.indexOf(id);
    return i < 0 ? null : i;
  }

  async cancel(id: string): Promise<JobRecord> {
    const job = this.jobs.get(id);
    if (!job) throw notFound('job', id);
    if (TERMINAL.includes(job.status)) return structuredClone(job);
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
  retry(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw notFound('job', id);
    if (!TERMINAL.includes(job.status) || job.status === 'succeeded') {
      throw new ApiError('conflict', 409, `only failed or cancelled jobs can be retried (job is ${job.status})`);
    }
    return this.submit(job.type, job.params, { projectId: job.projectId, retryOf: job.id });
  }

  async logs(id: string, tail?: number): Promise<string[]> {
    if (!this.jobs.has(id)) throw notFound('job', id);
    await this.chains.get(`${id}.log`);
    let text = '';
    try {
      text = await readFile(join(this.dir, `${id}.log`), 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n').filter(Boolean);
    return tail ? lines.slice(-tail) : lines;
  }

  subscribe(id: string, fn: (e: JobEvent) => void): () => void {
    const listener = (e: JobEvent) => {
      if (e.jobId === id) fn(e);
    };
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  /** Resolves when one job reaches a terminal state. */
  waitFor(id: string, timeoutMs = 600_000): Promise<JobRecord> {
    const job = this.get(id);
    if (TERMINAL.includes(job.status)) return Promise.resolve(job);
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
      const job = this.jobs.get(id);
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
    await this.persist(job, true);
    this.emit({ jobId: job.id, type: 'status', job });
    this.log(job, `started ${job.type}`);
    const ctx: JobContext = {
      job: structuredClone(job),
      signal: controller.signal,
      log: (line) => this.log(job, line),
      progress: (stage, fraction, detail) => {
        job.progress = { stage, fraction: Math.max(0, Math.min(1, fraction)), ...(detail ? { detail } : {}) };
        void this.persist(job, false);
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
    void this.persist(job, true);
    this.emit({ jobId: job.id, type: 'status', job });
  }

  private log(job: JobRecord, line: string) {
    const stamped = `${new Date().toISOString()} ${line}`;
    this.chain(`${job.id}.log`, () => appendFile(join(this.dir, `${job.id}.log`), stamped + '\n'));
    this.emit({ jobId: job.id, type: 'log', job, line: stamped });
  }

  /** Progress updates are throttled to one write per 500 ms; status changes always write. */
  private async persist(job: JobRecord, force: boolean) {
    const now = Date.now();
    if (!force && now - (this.lastPersist.get(job.id) ?? 0) < 500) return;
    this.lastPersist.set(job.id, now);
    const snapshot = structuredClone(job);
    await this.chain(`${job.id}.json`, () => writeJsonAtomic(join(this.dir, `${job.id}.json`), snapshot));
  }

  private chain(key: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(fn).catch(() => undefined);
    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  /** Wait for pending state and log writes (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}
