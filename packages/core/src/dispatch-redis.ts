import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { Redis, type RedisOptions } from 'ioredis';
import { BrokerListener, brokerError, readyBody, type BrokerDelivery } from './dispatch-broker';
import type { DispatchPublisher } from './dispatch';

/**
 * `queue.dispatch: redis` (D-105): job ids on a Redis Stream read through one
 * consumer group.
 *
 * The outbox relay XADDs `j=r:<job id>` entries (MAXLEN ~ queue.redis.maxLength).
 * Each worker is a consumer of the group: XREADGROUP (BLOCK 5 s) gives each
 * entry to one worker, which wakes its ordinary claim and XACKs the entry once
 * that claim ran (dispatch-broker.ts has the semantics). Entries delivered to
 * a worker that died before its XACK stay pending; every listener runs
 * XAUTOCLAIM for entries idle longer than queue.redis.claimIdleSeconds and
 * answers them like new ones (its claim finds nothing new, it XACKs them).
 * A worker with no free slot gives an entry back by adding it again and
 * XACKing the old one in one MULTI. Consumers gone for an hour with nothing
 * pending are deleted from the group.
 *
 * Connection: queue.redis.url (`redis://` or `rediss://` for TLS, a secret
 * with `_FILE`), queue.redis.password (a secret; `_FILE` or an encrypted
 * runtime setting; overrides the URL's password; a change reconnects), and
 * queue.redis.tlsCaFile for a private CA. Redis 6.2 or later (XAUTOCLAIM).
 */
export interface RedisDispatchConfig {
  url?: string;
  password?: string;
  tlsCaFile?: string;
  stream: string;
  group: string;
  claimIdleSeconds: number;
  maxLength: number;
}

const BLOCK_MS = 5000;
const CONSUMER_GONE_MS = 3_600_000;

/** `redis://user:***@host:6379/0`: for logs. */
export function redactRedisUrl(url: string | undefined): string {
  if (!url) return '(unset)';
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(not a URL)';
  }
}

function fingerprint(c: RedisDispatchConfig): string {
  return createHash('sha256').update(JSON.stringify([c.url, c.password, c.tlsCaFile])).digest('hex');
}

/** The URL with queue.redis.password in it (ioredis lets a URL's own empty password win over an option). */
function connectUrl(c: RedisDispatchConfig): string {
  if (!c.url) throw new Error('queue.redis.url is not set');
  if (!c.password) return c.url;
  const u = new URL(c.url);
  u.password = encodeURIComponent(c.password);
  return u.toString();
}

/** ioredis reports why a connect failed (WRONGPASS, TLS) on the 'error' event and rejects with "Connection is closed". */
const lastError = new WeakMap<Redis, string>();
async function connected(r: Redis): Promise<void> {
  try {
    await r.connect();
  } catch (e) {
    throw new Error(lastError.get(r) ?? (e as Error).message);
  }
}

function client(c: RedisDispatchConfig, name: string): Redis {
  const url = connectUrl(c);
  const tls = url.startsWith('rediss://') ? { tls: c.tlsCaFile ? { ca: readFileSync(c.tlsCaFile) } : {} } : {};
  const opts: RedisOptions = {
    lazyConnect: true,
    // Fail fast instead of queueing or resending: the listener and the relay retry with their own backoff.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    autoResendUnfulfilledCommands: false,
    retryStrategy: () => null,
    connectTimeout: 10_000,
    connectionName: name,
    // RESP2: the reply shapes below (and Redis 6.2 without HELLO 3) are the same on every server.
    protocol: 2,
    ...tls,
  };
  const r = new Redis(url, opts);
  r.on('error', (e: Error) => void lastError.set(r, e.message.split('\n')[0]!.slice(0, 300))); // reported through the failing command

  return r;
}

async function ensureGroup(r: Redis, c: RedisDispatchConfig): Promise<void> {
  try {
    // `$`: a new group starts at the end (a stream's old entries would only wake claims that find nothing).
    await r.xgroup('CREATE', c.stream, c.group, '$', 'MKSTREAM');
  } catch (e) {
    if (!String((e as Error).message).startsWith('BUSYGROUP')) throw e;
  }
}

function addArgs(c: RedisDispatchConfig, body: string): [string, 'MAXLEN', '~', number, '*', 'j', string] {
  return [c.stream, 'MAXLEN', '~', c.maxLength, '*', 'j', body];
}

/** XREADGROUP / XAUTOCLAIM entries: [id, [field, value, ...] | null]. */
function entries(raw: unknown): BrokerDelivery[] {
  const out: BrokerDelivery[] = [];
  for (const e of (raw as Array<[string, string[] | null] | null>) ?? []) {
    if (!e) continue;
    const [id, fields] = e;
    const i = fields ? fields.indexOf('j') : -1;
    out.push({ handle: id, body: i >= 0 && i % 2 === 0 ? (fields![i + 1] ?? '') : '' });
  }
  return out;
}

export class RedisDispatchPublisher implements DispatchPublisher {
  readonly driver = 'redis';
  private conn: Redis | null = null;
  private fp = '';
  constructor(private readonly cfg: () => RedisDispatchConfig) {}

  private async open(): Promise<{ r: Redis; c: RedisDispatchConfig }> {
    const c = this.cfg();
    const fp = fingerprint(c);
    if (this.conn && fp === this.fp && this.conn.status === 'ready') return { r: this.conn, c };
    this.conn?.disconnect();
    this.conn = null;
    const r = client(c, 'reelforge-dispatch-publish');
    await connected(r);
    await ensureGroup(r, c);
    this.conn = r;
    this.fp = fp;
    return { r, c };
  }

  async publish(jobIds: string[]): Promise<void> {
    try {
      const { r, c } = await this.open();
      const p = r.pipeline();
      for (const id of jobIds) p.xadd(...addArgs(c, readyBody(id)));
      const res = (await p.exec()) ?? [];
      const err = res.find(([e]) => e)?.[0];
      if (err) throw err;
    } catch (e) {
      this.conn?.disconnect();
      this.conn = null;
      throw new Error(`Redis: ${brokerError(e)}`);
    }
  }

  async close(): Promise<void> {
    this.conn?.disconnect();
    this.conn = null;
  }
}

export class RedisDispatchListener extends BrokerListener {
  readonly driver = 'redis';
  readonly consumer: string;
  /** XREADGROUP blocks this connection; acknowledgements and reclaims use the other. */
  private reader: Redis | null = null;
  private cmd: Redis | null = null;
  private fp = '';
  private cursor = '0-0';
  private nextReclaim = 0;
  private reclaims = 0;

  constructor(
    private readonly cfg: () => RedisDispatchConfig,
    opts: { consumer?: string; log?: (level: 'info' | 'warn' | 'error', line: string) => void } = {}
  ) {
    super({ redeliverAfterMs: cfg().claimIdleSeconds * 1000, maxBatch: 10, ...(opts.log ? { log: opts.log } : {}) });
    this.consumer = opts.consumer ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  }

  /** The connections' client name, so an operator can find them in CLIENT LIST. */
  get connectionName(): string {
    return `reelforge-dispatch-${this.consumer}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  }

  protected async connect(): Promise<void> {
    this.drop();
    const c = this.cfg();
    const reader = client(c, this.connectionName);
    const cmd = client(c, this.connectionName);
    this.reader = reader;
    this.cmd = cmd;
    await Promise.all([connected(reader), connected(cmd)]);
    await ensureGroup(cmd, c);
    this.fp = fingerprint(c);
  }

  protected async receive(max: number): Promise<BrokerDelivery[]> {
    const c = this.cfg();
    if (fingerprint(c) !== this.fp) {
      this.base.log?.('info', 'dispatch: the Redis connection settings changed; reconnecting');
      await this.connect();
    }
    const reader = this.reader!;
    if (Date.now() >= this.nextReclaim) {
      const got = await this.reclaim(c, max);
      if (got.length) return got;
    }
    try {
      const raw = (await reader.call('XREADGROUP', 'GROUP', c.group, this.consumer, 'COUNT', String(max), 'BLOCK', String(BLOCK_MS), 'STREAMS', c.stream, '>')) as Array<[string, unknown]> | null;
      return raw ? raw.flatMap(([, list]) => entries(list)) : [];
    } catch (e) {
      // The stream or group was deleted (a Redis restart without persistence, FLUSHALL): create it again.
      if (String((e as Error).message).startsWith('NOGROUP')) {
        await ensureGroup(this.cmd!, c);
        return [];
      }
      throw e;
    }
  }

  /** XAUTOCLAIM: entries other consumers (dead workers) left pending longer than claimIdleSeconds. */
  private async reclaim(c: RedisDispatchConfig, max: number): Promise<BrokerDelivery[]> {
    const idleMs = c.claimIdleSeconds * 1000;
    this.nextReclaim = Date.now() + Math.max(1000, Math.floor(idleMs / 2));
    const r = this.cmd!;
    let res: unknown[];
    try {
      res = (await r.call('XAUTOCLAIM', c.stream, c.group, this.consumer, String(idleMs), this.cursor, 'COUNT', String(max))) as unknown[];
    } catch (e) {
      if (String((e as Error).message).startsWith('NOGROUP')) {
        await ensureGroup(r, c);
        return [];
      }
      throw e;
    }
    this.cursor = String(res[0] ?? '0-0');
    // Entries trimmed away (MAXLEN) while pending: nothing left to deliver; acknowledge them.
    const deleted = (res[2] as string[] | undefined) ?? [];
    if (deleted.length) await r.xack(c.stream, c.group, ...deleted);
    if (++this.reclaims % 20 === 0) await this.forgetGoneConsumers(c).catch(() => undefined);
    const got = entries(res[1]);
    if (got.length) this.base.log?.('info', `dispatch: reclaimed ${got.length} Redis entr${got.length === 1 ? 'y' : 'ies'} left pending by another worker`);
    return got;
  }

  /** Consumers idle for an hour with nothing pending (workers that are gone): XGROUP DELCONSUMER. */
  private async forgetGoneConsumers(c: RedisDispatchConfig): Promise<void> {
    const r = this.cmd!;
    const list = (await r.call('XINFO', 'CONSUMERS', c.stream, c.group)) as unknown[][];
    for (const row of list) {
      const f: Record<string, unknown> = {};
      for (let i = 0; i + 1 < row.length; i += 2) f[String(row[i])] = row[i + 1];
      if (f.name !== this.consumer && Number(f.pending) === 0 && Number(f.idle) > CONSUMER_GONE_MS) await r.xgroup('DELCONSUMER', c.stream, c.group, String(f.name));
    }
  }

  protected async acknowledge(d: BrokerDelivery): Promise<void> {
    const c = this.cfg();
    await this.cmd?.xack(c.stream, c.group, d.handle).catch((e) => this.base.log?.('warn', `dispatch: could not XACK a Redis entry (${brokerError(e)}); it is reclaimed later and is a no-op then`));
  }

  protected async giveBack(d: BrokerDelivery): Promise<void> {
    const c = this.cfg();
    // Redis has no "release": add the id again and acknowledge the old entry, atomically.
    await this.cmd
      ?.multi()
      .xadd(...addArgs(c, d.body))
      .xack(c.stream, c.group, d.handle)
      .exec()
      .catch(() => undefined);
  }

  private drop() {
    this.reader?.disconnect();
    this.cmd?.disconnect();
    this.reader = this.cmd = null;
  }

  protected async close(): Promise<void> {
    this.drop();
  }
}
