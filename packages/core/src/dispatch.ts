import { newSequentialId } from './fsutil';
import { NOOP_TELEMETRY, coreInstruments, type Telemetry } from './telemetry';
import type { DispatchOutboxRepository } from './repositories';

/**
 * Queue dispatch (D-105, issue #158): how workers learn that jobs became
 * claimable. The database stays the queue of record (D-096): job state,
 * leases, fencing, attempts, priorities and fairness live in the Job table,
 * and every claim is the normal fenced, fair claim (JobRepository.claim). A
 * dispatch message only wakes a worker up; it never chooses the job.
 *
 *   poll    (default) idle workers look every queue.pollIntervalMs, backing
 *           off exponentially on empty polls up to queue.pollMaxIntervalMs
 *   notify  PostgreSQL LISTEN/NOTIFY: the transaction that makes a job
 *           claimable sends NOTIFY (delivered on commit, dropped on
 *           rollback), workers LISTEN on a direct session connection; a
 *           fallback poll (queue.dispatchFallbackSeconds) catches lost messages
 *
 *   sqs     Amazon SQS standard queue (dispatch-sqs.ts)
 *   redis   Redis Streams with a consumer group (dispatch-redis.ts)
 *
 * External brokers publish from the outbox (DispatchOutboxRepository +
 * OutboxRelay): the enqueue transaction writes an outbox row, a relay
 * publishes the job ids with retries. Messages carry job ids only, at least
 * once; each goes to one worker, which acknowledges it once the claim it woke
 * has run (dispatch-broker.ts). NATS JetStream is a follow-up.
 */
export type DispatchDriverId = 'poll' | 'notify' | 'sqs' | 'redis';

/**
 * What a listener delivers. `ready`: the job became claimable (enqueued,
 * queued again after a lost lease, handed back, a fan-out unit or join).
 * `claimed`: a worker claimed it (lets idle workers skip a claim that would
 * find nothing). Both may be duplicated, late or lost; `ack` (brokers with
 * acknowledgements) is called once the claim it triggered has run, `release`
 * when the worker cannot claim now (no free slot), so the broker gives the
 * message to another worker at once. Both are idempotent.
 */
export type DispatchMessage = { kind: 'ready'; jobId: string; ack?: () => Promise<void>; release?: () => Promise<void> } | { kind: 'claimed'; jobId: string };

export interface DispatchListenerStatus {
  driver: string;
  connected: boolean;
  /** When the listener last connected or lost its connection. */
  since?: string;
  /** Reconnects after the first connect. */
  reconnects: number;
  /** Subscribed now (false while the worker has no free slot and paused it with setActive). */
  active?: boolean;
  lastError?: string;
}

export interface DispatchListenerHandlers {
  message(m: DispatchMessage): void;
  /** After a reconnect (not the first connect): messages sent meanwhile are lost, so the runner claims once. */
  connected(): void;
  /** The connection was lost; the runner polls (with backoff) until `connected`. */
  disconnected(reason: string): void;
  /**
   * Claims the worker could start now (free slots). Broker listeners keep at most this many messages delivered and
   * not yet acknowledged or released, so a message never waits in a busy worker while another one is idle.
   */
  capacity?(): number;
}

/** A worker's subscription to dispatch messages (one per worker process). */
export interface DispatchListener {
  readonly driver: string;
  /** Connect and subscribe; resolves once messages arrive (throws when the first connect or its delivery check fails). */
  start(h: DispatchListenerHandlers): Promise<void>;
  stop(): Promise<void>;
  status(): DispatchListenerStatus;
  /**
   * Stop (false) or resume (true) receiving messages. A worker pauses while it has no free slot, so a busy fleet
   * is not sent every message (with NOTIFY each delivered message costs the listening backend a short
   * transaction), and resumes before its next claim. Resolves once the change took effect.
   */
  setActive?(active: boolean): Promise<void>;
  /** The worker's free slots may have changed (a claim loop ended): broker listeners look at `capacity()` again. */
  capacityChanged?(): void;
}

/** Publishes job ids to an external broker (outbox drivers). */
export interface DispatchPublisher {
  readonly driver: string;
  publish(jobIds: string[]): Promise<void>;
  close?(): Promise<void>;
}

/** What /readyz shows about an instance's outbox relay (outbox drivers). */
export interface OutboxRelayStatus {
  driver: string;
  /** The last publish failed (the rows are retried with backoff; the workers' fallback poll covers their jobs meanwhile). */
  failing: boolean;
  published: number;
  failed: number;
  dropped: number;
  lastPublishedAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

/**
 * How a repository's transactions that make jobs claimable tell the workers:
 * `notify` (PostgreSQL NOTIFY on `channel` inside the transaction), `outbox`
 * (an outbox row inside the transaction), or `bus` (in-memory repositories:
 * after the write; tests and single-process use).
 */
export type ReadySignal = { kind: 'notify'; channel: string; announceClaimsWithinMs?: number } | { kind: 'outbox' } | { kind: 'bus'; bus: MemoryDispatchBus; announceClaimsWithinMs?: number };

/**
 * A claim is announced (`c:<id>`) only when the job was queued at most this long ago (default 2 s): the
 * announcement only helps idle workers that are about to claim after a fresh `r:` message, and every
 * delivered message costs each listening PostgreSQL backend a short transaction, so draining an old
 * backlog announces nothing. Re-queued and handed-back jobs (old createdAt) are not announced either.
 */
export const ANNOUNCE_CLAIMS_WITHIN_MS = 2000;
export function announceClaim(signal: ReadySignal | undefined, createdAt: string | Date, now: string | Date): boolean {
  if (!signal || signal.kind === 'outbox') return false;
  const age = new Date(now).getTime() - new Date(createdAt).getTime();
  return age <= (signal.announceClaimsWithinMs ?? ANNOUNCE_CLAIMS_WITHIN_MS);
}

/** Payload prefixes on the wire (NOTIFY payloads): `r:<job id>` ready, `c:<job id>` claimed, `p:<nonce>` a delivery check. */
export const READY_PREFIX = 'r:';
export const CLAIMED_PREFIX = 'c:';
export const PROBE_PREFIX = 'p:';

export function parseDispatchPayload(payload: string): { kind: 'ready' | 'claimed' | 'probe'; id: string } | null {
  const kind = payload.startsWith(READY_PREFIX) ? 'ready' : payload.startsWith(CLAIMED_PREFIX) ? 'claimed' : payload.startsWith(PROBE_PREFIX) ? 'probe' : null;
  const id = payload.slice(2);
  return kind && id ? { kind, id } : null;
}

/**
 * In-process dispatch for the in-memory repositories and the dispatch
 * contract suite: broadcasts like NOTIFY (every listener gets every message,
 * asynchronously). `drop(n)` loses the next n messages and `listener()`'s
 * `disconnect()` / `reconnect()` simulate a lost connection.
 */
export class MemoryDispatchBus {
  private subs = new Set<(m: DispatchMessage) => void>();
  private dropping = 0;
  published = 0;

  /** Lose the next `n` messages (a broker or connection that drops them). */
  drop(n = 1): void {
    this.dropping += n;
  }

  publish(kind: 'ready' | 'claimed', jobIds: string[]): void {
    for (const jobId of jobIds) {
      this.published++;
      if (this.dropping > 0) {
        this.dropping--;
        continue;
      }
      const m: DispatchMessage = { kind, jobId };
      for (const s of this.subs) setTimeout(() => s(m), 0);
    }
  }

  listener(): DispatchListener & { disconnect(reason?: string): void; reconnect(): void } {
    const bus = this;
    let active = true;
    let handlers: DispatchListenerHandlers | undefined;
    let sub: ((m: DispatchMessage) => void) | undefined;
    const state: DispatchListenerStatus = { driver: 'memory', connected: false, reconnects: 0 };
    const attach = () => {
      sub = (m) => {
        if (active) handlers?.message(m);
      };
      bus.subs.add(sub);
      state.connected = true;
      state.since = new Date().toISOString();
    };
    const detach = () => {
      if (sub) bus.subs.delete(sub);
      sub = undefined;
      state.connected = false;
      state.since = new Date().toISOString();
    };
    return {
      driver: 'memory',
      async start(h) {
        handlers = h;
        attach();
      },
      async stop() {
        detach();
        handlers = undefined;
      },
      status: () => ({ ...state, active }),
      async setActive(a) {
        active = a;
      },
      disconnect(reason = 'connection lost (test)') {
        if (!state.connected) return;
        detach();
        state.lastError = reason;
        handlers?.disconnected(reason);
      },
      reconnect() {
        if (state.connected || !handlers) return;
        attach();
        state.reconnects++;
        handlers.connected();
      },
    };
  }
}

export interface OutboxRelayOptions {
  repo: DispatchOutboxRepository;
  publisher: DispatchPublisher;
  /** Look for due rows this often besides kick() (rows of a crashed instance, retries). Default 5000. */
  sweepMs?: number;
  /** Rows per publish. Default 100. */
  batch?: number;
  /** A row is dropped after this many failed publishes (the job stays claimable through the fallback poll). Default 10. */
  maxAttempts?: number;
  /** Lease on claimed rows while publishing. Default 30 000. */
  leaseMs?: number;
  telemetry?: Telemetry;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
  now?: () => number;
  random?: () => number;
}

/**
 * Publishes outbox rows (the transactional outbox of D-071, generic for every
 * external dispatch driver): claims due rows with a lease (each row by one
 * relay, several instances may run one), publishes their job ids in one
 * call, deletes them; a failed publish keeps the rows with exponential
 * backoff and full jitter (1 s, 2 s, ... up to 5 min) and drops them after
 * `maxAttempts`, logging it: the job itself stays queued in the database and
 * the workers' fallback poll claims it.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private readonly o: Required<Omit<OutboxRelayOptions, 'log' | 'telemetry'>> & Pick<OutboxRelayOptions, 'log'>;
  private readonly telemetry: Telemetry;
  /** The earliest retry this instance scheduled (a failed publish), so it does not wait for the next sweep. */
  private retryAt: number | null = null;
  private state: OutboxRelayStatus;

  constructor(opts: OutboxRelayOptions) {
    this.o = {
      sweepMs: 5000,
      batch: 100,
      maxAttempts: 10,
      leaseMs: 30_000,
      now: Date.now,
      random: Math.random,
      ...opts,
    };
    this.telemetry = opts.telemetry ?? NOOP_TELEMETRY;
    this.state = { driver: opts.publisher.driver, failing: false, published: 0, failed: 0, dropped: 0 };
  }

  status(): OutboxRelayStatus {
    return { ...this.state };
  }

  start(): void {
    this.stopped = false;
    this.kick();
  }

  /** Publish now (after this instance committed a job): no wait for the sweep. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          while ((await this.runOnce()).claimed === this.o.batch && !this.stopped);
        } while (this.again && !this.stopped);
      } catch (e) {
        this.o.log?.('warn', `dispatch outbox: could not read the outbox: ${(e as Error).message}`);
      } finally {
        this.running = null;
        this.schedule();
      }
    })();
  }

  private schedule() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const retryIn = this.retryAt === null ? Infinity : Math.max(0, this.retryAt - this.o.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.retryAt = null;
      this.kick();
    }, Math.min(this.o.sweepMs, retryIn));
    this.timer.unref();
  }

  /** Delay before attempt `n + 1` after `n` failed publishes: full jitter over min(5 min, 1 s × 2^(n-1)). */
  backoffMs(attempts: number): number {
    const cap = Math.min(300_000, 1000 * 2 ** Math.max(0, attempts - 1));
    return Math.round(cap / 2 + this.o.random() * (cap / 2));
  }

  /** One batch: claim, publish, delete or schedule a retry. */
  async runOnce(): Promise<{ claimed: number; published: number; failed: number; dropped: number }> {
    const now = this.o.now();
    const rows = await this.o.repo.claim(new Date(now).toISOString(), new Date(now + this.o.leaseMs).toISOString(), this.o.batch);
    if (!rows.length) return { claimed: 0, published: 0, failed: 0, dropped: 0 };
    const m = coreInstruments(this.telemetry.meter);
    const driver = { 'renderweld.dispatch.driver': this.o.publisher.driver };
    try {
      await this.o.publisher.publish(rows.map((r) => r.jobId));
      await this.o.repo.remove(rows.map((r) => r.id));
      m.dispatchPublished.add(rows.length, { ...driver, 'renderweld.reason': 'outbox' });
      if (this.state.failing) this.o.log?.('info', `dispatch outbox: publishing to ${this.o.publisher.driver} works again`);
      this.state = { ...this.state, failing: false, published: this.state.published + rows.length, lastPublishedAt: new Date(this.o.now()).toISOString() };
      return { claimed: rows.length, published: rows.length, failed: 0, dropped: 0 };
    } catch (e) {
      const message = ((e as Error).message ?? String(e)).split('\n')[0]!.slice(0, 300);
      let dropped = 0;
      for (const r of rows) {
        const attempts = r.attempts + 1;
        if (attempts >= this.o.maxAttempts) {
          dropped++;
          await this.o.repo.remove([r.id]);
        } else {
          const at = this.o.now() + this.backoffMs(attempts);
          this.retryAt = this.retryAt === null ? at : Math.min(this.retryAt, at);
          await this.o.repo.retry(r.id, attempts, new Date(at).toISOString(), message);
        }
      }
      m.dispatchPublishFailures.add(rows.length, driver);
      this.state = {
        ...this.state,
        failing: true,
        failed: this.state.failed + rows.length - dropped,
        dropped: this.state.dropped + dropped,
        lastError: message,
        lastErrorAt: new Date(this.o.now()).toISOString(),
      };
      this.o.log?.(
        'warn',
        `dispatch outbox: publishing ${rows.length} job id(s) to ${this.o.publisher.driver} failed (${message}); ${dropped ? `${dropped} dropped after ${this.o.maxAttempts} attempts (their jobs stay queued and are claimed by the fallback poll), ` : ''}retrying with backoff`
      );
      return { claimed: rows.length, published: 0, failed: rows.length - dropped, dropped };
    }
  }

  /** Stop the sweep; waits for a batch in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }
}

/** An outbox row id: sequential, so rows are published roughly in enqueue order. */
export const newOutboxId = () => newSequentialId('dsp');
