import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { PROBE_PREFIX, parseDispatchPayload, type DispatchListener, type DispatchListenerHandlers, type DispatchListenerStatus } from '@reelforge/core';
import { parseDatabaseUrl, redactDatabaseUrl } from './url';

/**
 * The NOTIFY channel of one deployment (D-104). Channels are per database, not
 * per schema, so deployments that share a PostgreSQL database in different
 * schemas (`?schema=`) get their own channel and never wake each other.
 */
export function notifyChannel(databaseUrl: string): string {
  const p = parseDatabaseUrl(databaseUrl);
  if (p.kind !== 'postgresql') throw new Error(`queue.dispatch "notify" needs PostgreSQL (LISTEN/NOTIFY); database.url is ${p.kind}`);
  return p.schema ? `reelforge_jobs_${createHash('sha256').update(p.schema).digest('hex').slice(0, 16)}` : 'reelforge_jobs';
}

export interface PgNotifyListenerOptions {
  /** A direct session connection to PostgreSQL (database.directUrl, else database.url). Never a transaction-mode pooler. */
  url: string;
  channel: string;
  /**
   * Send a NOTIFY through the application's own connection pool (the path the
   * job transactions take). Used for the delivery check after every connect:
   * the listener only counts as connected once that message arrived.
   */
  probe: (channel: string, payload: string) => Promise<unknown>;
  /** How long the delivery check waits. Default 5000. */
  probeTimeoutMs?: number;
  /** A `SELECT 1` on the listen connection this often finds a silently dead connection. Default 30 000. */
  pingMs?: number;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
}

const MAX_RECONNECT_MS = 30_000;

/** Thrown by the delivery check: the message sent through the pool never reached the LISTEN connection. */
export class NotifyDeliveryError extends Error {}

/**
 * PostgreSQL LISTEN on one dedicated session connection (node-postgres, kept
 * out of the Prisma pool). Reconnects with backoff (0.5 s doubling to 30 s);
 * after every (re)connect it LISTENs again and checks delivery end to end
 * (a NOTIFY sent through the application's pool must arrive here), which is
 * how a listen connection through PgBouncer transaction mode is caught: LISTEN
 * succeeds there, but the notifications go to whichever client holds the
 * server connection at the time, so they never arrive.
 */
export class PgNotifyListener implements DispatchListener {
  readonly driver = 'notify';
  private client: pg.Client | null = null;
  private handlers: DispatchListenerHandlers | undefined;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private delay = 500;
  private probes = new Map<string, () => void>();
  /** Wanted subscription state (setActive), applied in order on the connection and after every reconnect. */
  private active = true;
  private applying: Promise<void> = Promise.resolve();
  private state: DispatchListenerStatus = { driver: 'notify', connected: false, reconnects: 0 };
  private readonly o: Required<Omit<PgNotifyListenerOptions, 'log'>> & Pick<PgNotifyListenerOptions, 'log'>;

  constructor(opts: PgNotifyListenerOptions) {
    this.o = { probeTimeoutMs: 5000, pingMs: 30_000, ...opts };
  }

  status(): DispatchListenerStatus {
    return { ...this.state, active: this.active };
  }

  /** UNLISTEN while the worker has no free slot, LISTEN again before its next claim (in call order). */
  setActive(active: boolean): Promise<void> {
    if (active === this.active) return this.applying;
    this.active = active;
    this.applying = this.applying.then(async () => {
      const c = this.client;
      if (!c || !this.state.connected || this.active !== active) return;
      try {
        await c.query(`${active ? 'LISTEN' : 'UNLISTEN'} ${this.quotedChannel}`);
      } catch (e) {
        this.lost(c, (e as Error).message);
      }
    });
    return this.applying;
  }

  private get quotedChannel() {
    return `"${this.o.channel.replace(/"/g, '""')}"`;
  }

  /** The backend process id of the listen connection (tests terminate it to simulate a lost connection). */
  get backendPid(): number | undefined {
    return (this.client as unknown as { processID?: number } | null)?.processID;
  }

  async start(h: DispatchListenerHandlers): Promise<void> {
    this.handlers = h;
    this.stopped = false;
    try {
      await this.connect();
    } catch (e) {
      this.stopped = true;
      throw e;
    }
    this.pingTimer = setInterval(() => void this.ping(), this.o.pingMs);
    this.pingTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = this.pingTimer = null;
    const c = this.client;
    this.client = null;
    this.state.connected = false;
    await c?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const p = parseDatabaseUrl(this.o.url);
    if (p.kind !== 'postgresql') throw new Error(`queue.dispatch "notify" needs PostgreSQL; the listen URL is ${p.kind}`);
    const client = new pg.Client({
      connectionString: p.driverUrl!,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      application_name: 'reelforge-dispatch-listen',
    });
    client.on('notification', (n) => this.onNotification(n.channel, n.payload ?? ''));
    client.on('error', (e) => this.lost(client, e.message));
    client.on('end', () => this.lost(client, 'connection closed'));
    try {
      await client.connect();
      await client.query(`LISTEN ${this.quotedChannel}`);
      this.client = client;
      await this.check();
      if (!this.active) await client.query(`UNLISTEN ${this.quotedChannel}`);
    } catch (e) {
      this.client = null;
      await client.end().catch(() => undefined);
      const msg = (e as Error).message.split('\n')[0];
      if (e instanceof NotifyDeliveryError) throw e;
      throw new Error(`queue.dispatch "notify": cannot LISTEN on ${redactDatabaseUrl(this.o.url)}: ${msg}`);
    }
    this.state = { ...this.state, connected: true, since: new Date().toISOString() };
    this.delay = 500;
  }

  /** End-to-end delivery check: a NOTIFY sent through the application's pool must arrive on this connection. */
  private async check(): Promise<void> {
    const nonce = randomBytes(8).toString('hex');
    let timer: NodeJS.Timeout | undefined;
    const arrived = new Promise<void>((resolve, reject) => {
      this.probes.set(nonce, resolve);
      timer = setTimeout(
        () =>
          reject(
            new NotifyDeliveryError(
              `queue.dispatch "notify": a test notification sent through database.url did not arrive on the LISTEN connection (${redactDatabaseUrl(this.o.url)}) within ${this.o.probeTimeoutMs / 1000} s. ` +
                'LISTEN needs a direct session connection to PostgreSQL: if it goes through PgBouncer in transaction or statement mode (or another pooler that does not keep sessions), ' +
                'set database.directUrl (REELFORGE_DATABASE_DIRECT_URL or DATABASE_DIRECT_URL) to the PostgreSQL server itself, or use queue.dispatch "poll"'
            )
          ),
        this.o.probeTimeoutMs
      );
    });
    try {
      await this.o.probe(this.o.channel, `${PROBE_PREFIX}${nonce}`);
      await arrived;
    } finally {
      clearTimeout(timer);
      this.probes.delete(nonce);
    }
  }

  private onNotification(channel: string, payload: string) {
    if (channel !== this.o.channel) return;
    const m = parseDispatchPayload(payload);
    if (!m) return;
    if (m.kind === 'probe') {
      this.probes.get(m.id)?.();
      return;
    }
    if (!this.state.connected) return; // still checking delivery: the claim after (re)connect covers it
    this.handlers?.message({ kind: m.kind, jobId: m.id });
  }

  private lost(client: pg.Client, reason: string) {
    if (client !== this.client) return;
    this.client = null;
    void client.end().catch(() => undefined);
    this.state = { ...this.state, connected: false, since: new Date().toISOString(), lastError: reason.slice(0, 300) };
    if (this.stopped) return;
    this.o.log?.('warn', `dispatch: lost the LISTEN connection (${reason}); reconnecting`);
    this.handlers?.disconnected(reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const wait = this.delay;
    this.delay = Math.min(MAX_RECONNECT_MS, this.delay * 2);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      try {
        await this.connect();
        this.state.reconnects++;
        this.o.log?.('info', 'dispatch: LISTEN connection restored');
        this.handlers?.connected();
      } catch (e) {
        this.state.lastError = (e as Error).message.slice(0, 300);
        this.scheduleReconnect();
      }
    }, wait);
    this.reconnectTimer.unref();
  }

  private async ping() {
    const c = this.client;
    if (!c || this.stopped) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        c.query('SELECT 1'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('no answer to a ping within 10 s')), 10_000);
        }),
      ]);
    } catch (e) {
      this.lost(c, (e as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The `notify` listener of a worker on this database: LISTEN on `directUrl` (else the database's own URL), delivery checked through its pool. */
export function createNotifyListener(db: { url: string; prisma: { $queryRawUnsafe(sql: string, ...args: unknown[]): Promise<unknown> } }, opts: { directUrl?: string; pingMs?: number; probeTimeoutMs?: number; log?: PgNotifyListenerOptions['log'] } = {}): PgNotifyListener {
  return new PgNotifyListener({
    url: opts.directUrl || db.url,
    channel: notifyChannel(db.url),
    probe: (channel, payload) => db.prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM (SELECT pg_notify($1, $2)) s', channel, payload),
    ...(opts.pingMs ? { pingMs: opts.pingMs } : {}),
    ...(opts.probeTimeoutMs ? { probeTimeoutMs: opts.probeTimeoutMs } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
}
