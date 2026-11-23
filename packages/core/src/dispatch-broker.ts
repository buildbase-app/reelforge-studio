import { READY_PREFIX, parseDispatchPayload, type DispatchListener, type DispatchListenerHandlers, type DispatchListenerStatus } from './dispatch';

/**
 * Shared worker side of the broker dispatch drivers (`sqs`, `redis`; D-105).
 *
 * A broker gives each message to one consumer and keeps it until that
 * consumer acknowledges it (SQS: deleted, else visible again after the
 * visibility timeout; Redis Streams: XACK, else reclaimed with XAUTOCLAIM
 * after the idle timeout). The semantics on top of that, the same for every
 * broker:
 *
 * - A message only wakes the worker's ordinary claim (priority, then fairness
 *   across keys, then age; D-090, D-103). It never claims "that id".
 * - The message is acknowledged once the claim it woke has run, whichever job
 *   that claim took (the message's own job, another one the fair order put
 *   first, or nothing because the job was taken already). Duplicate and stale
 *   ids are acknowledged without a second claim.
 * - Flow control: at most `capacity()` (the worker's free slots) messages are
 *   delivered and not yet answered. A worker with no free slot receives
 *   nothing (setActive(false)) and releases what it holds (visible to the
 *   other workers at once), so messages wait in the broker, where the
 *   autoscaler sees them, and never in a busy worker.
 * - Unanswered deliveries count against the capacity only until the broker
 *   would redeliver them (`redeliverAfterMs`): a lost acknowledgement never
 *   stops a worker from receiving.
 * - Connection errors: `disconnected` (the worker polls with backoff), retry
 *   with backoff (0.5 s doubling to 30 s), `connected` once the broker answers
 *   again. A broker that is down when the worker starts does not fail the
 *   start: the worker polls until it connects.
 */
export interface BrokerDelivery {
  /** The broker's handle for this delivery (SQS receipt handle, Redis entry id). */
  handle: string;
  /** The message body: `r:<job id>`. */
  body: string;
}

export interface BrokerListenerOptions {
  /** How long the broker keeps an unanswered delivery from other consumers (SQS visibility timeout, Redis claim idle time). */
  redeliverAfterMs: number;
  /** Most messages per receive call. */
  maxBatch: number;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
}

const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;

export abstract class BrokerListener implements DispatchListener {
  abstract readonly driver: string;
  protected handlers: DispatchListenerHandlers | undefined;
  protected stopped = true;
  private active = true;
  private loop: Promise<void> | null = null;
  private delay = MIN_RECONNECT_MS;
  private wakeUp: (() => void) | null = null;
  /** Delivered and not yet answered: handle -> when delivered. */
  private inFlight = new Map<string, { at: number; d: BrokerDelivery }>();
  private everConnected = false;
  protected state: DispatchListenerStatus;

  constructor(protected readonly base: BrokerListenerOptions) {
    this.state = { driver: 'broker', connected: false, reconnects: 0 };
  }

  /** Check the broker (credentials, the queue or stream exists); throws when it cannot be used. */
  protected abstract connect(): Promise<void>;
  /** Up to `max` messages; may wait (long poll) until one arrives or its own timeout passes. */
  protected abstract receive(max: number): Promise<BrokerDelivery[]>;
  protected abstract acknowledge(d: BrokerDelivery): Promise<void>;
  /** Make the message deliverable to other consumers now. */
  protected abstract giveBack(d: BrokerDelivery): Promise<void>;
  /** Stop: end a receive in flight and close connections. */
  protected abstract close(): Promise<void>;

  status(): DispatchListenerStatus {
    return { ...this.state, driver: this.driver, active: this.active };
  }

  async start(h: DispatchListenerHandlers): Promise<void> {
    this.handlers = h;
    this.stopped = false;
    try {
      await this.connect();
      this.markConnected();
    } catch (e) {
      this.markDisconnected(e as Error, false);
    }
    this.loop = this.run();
  }

  async setActive(active: boolean): Promise<void> {
    this.active = active;
    // A receive in flight finishes; what it returns while paused is given back at once.
    if (active) this.signal();
  }

  capacityChanged(): void {
    this.signal();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.signal();
    // Unanswered messages go back to the broker for another worker (best effort: the broker redelivers them anyway).
    const held = [...this.inFlight.values()].map((v) => v.d);
    this.inFlight.clear();
    await Promise.allSettled(held.map((d) => this.giveBack(d)));
    await this.close().catch(() => undefined);
    await this.loop?.catch(() => undefined);
    this.state = { ...this.state, connected: false, since: new Date().toISOString() };
  }

  /** Messages delivered and not answered yet that still hold the broker's lease. */
  protected held(): number {
    const now = Date.now();
    for (const [k, v] of this.inFlight) if (now - v.at >= this.base.redeliverAfterMs) this.inFlight.delete(k);
    return this.inFlight.size;
  }

  private room(): number {
    if (!this.active) return 0;
    const cap = this.handlers?.capacity ? this.handlers.capacity() : 1;
    return Math.min(this.base.maxBatch, cap - this.held());
  }

  private signal() {
    const w = this.wakeUp;
    this.wakeUp = null;
    w?.();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, ms);
      t.unref();
      this.wakeUp = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!this.state.connected) {
          await this.wait(this.delay);
          if (this.stopped) break;
          this.delay = Math.min(MAX_RECONNECT_MS, this.delay * 2);
          await this.connect();
          this.markConnected();
          continue;
        }
        const room = this.room();
        if (room <= 0) {
          // Re-checked when a message is answered, the worker resumes or a slot frees; the timeout covers expiry.
          await this.wait(1000);
          continue;
        }
        const got = await this.receive(room);
        if (this.stopped) {
          await Promise.allSettled(got.map((d) => this.giveBack(d)));
          break;
        }
        for (const d of got) this.deliver(d);
      } catch (e) {
        if (this.stopped) break;
        this.markDisconnected(e as Error, true);
      }
    }
  }

  private deliver(d: BrokerDelivery) {
    const m = parseDispatchPayload(d.body);
    if (!m || m.kind !== 'ready') {
      // Not ours (or a malformed body): acknowledge so it does not come back.
      void this.acknowledge(d).catch(() => undefined);
      return;
    }
    if (!this.active || !this.handlers) {
      void this.giveBack(d).catch(() => undefined);
      return;
    }
    this.inFlight.set(d.handle, { at: Date.now(), d });
    let answered = false;
    const answer = (how: (d: BrokerDelivery) => Promise<void>) => async () => {
      if (answered) return;
      answered = true;
      this.inFlight.delete(d.handle);
      this.signal();
      if (!this.stopped) await how.call(this, d);
    };
    this.handlers.message({ kind: 'ready', jobId: m.id, ack: answer(this.acknowledge), release: answer(this.giveBack) });
  }

  /** The first connect happens in start(): its outcome is read from status(), not sent to the handlers. */
  private markConnected() {
    const first = !this.everConnected && !this.state.lastError;
    this.everConnected = true;
    this.delay = MIN_RECONNECT_MS;
    this.state = { ...this.state, connected: true, since: new Date().toISOString(), reconnects: this.state.reconnects + (first ? 0 : 1) };
    if (first) return;
    this.base.log?.('info', `dispatch: ${this.driver} connected`);
    this.handlers?.connected();
  }

  private markDisconnected(e: Error, running: boolean) {
    const reason = brokerError(e);
    const was = this.state.connected;
    this.state = { ...this.state, connected: false, lastError: reason, ...(was || !this.state.since ? { since: new Date().toISOString() } : {}) };
    // Deliveries of the lost connection: the broker redelivers them (SQS visibility, Redis XAUTOCLAIM).
    this.inFlight.clear();
    if (!was && running) return; // still down: no new log line per retry
    this.base.log?.('warn', `dispatch: ${this.driver} ${was ? 'connection lost' : 'not reachable'} (${reason}); polling the database until it answers, retrying with backoff`);
    if (was && running) this.handlers?.disconnected(reason);
  }
}

/** One line, no stack, bounded: what a broker error says (never credentials: SDK and client errors do not carry them). */
export function brokerError(e: unknown): string {
  const err = e as { name?: string; code?: string; message?: string };
  const msg = (err?.message ?? String(e)).split('\n')[0]!.slice(0, 300);
  const code = err?.code ?? (err?.name && err.name !== 'Error' ? err.name : undefined);
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
}

/** The wire body of a ready message (the same prefix as the NOTIFY payloads). */
export const readyBody = (jobId: string) => `${READY_PREFIX}${jobId}`;
