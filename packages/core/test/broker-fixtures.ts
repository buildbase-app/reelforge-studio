/**
 * Fixtures for the broker dispatch drivers (`sqs`, `redis`; D-105) in the
 * shared dispatch contract (dispatch-contract.ts) and the broker tests:
 *
 *   memory queue  always: competing consumers with a visibility timeout, the
 *                 semantics SQS and Redis consumer groups share (CI runs it)
 *   sqs           when TEST_SQS_ENDPOINT is set (LocalStack): a fresh queue
 *   redis         when TEST_REDIS_URL is set: a fresh stream key
 *
 * Listeners reach the broker through a TcpProxy, so a test can cut their
 * connection the way a network failure does (sockets reset, connects refused)
 * while the relay keeps publishing directly.
 */
import { randomBytes } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Redis } from 'ioredis';
import {
  BrokerListener,
  OutboxRelay,
  RedisDispatchListener,
  RedisDispatchPublisher,
  SqsDispatchListener,
  SqsDispatchPublisher,
  type BrokerDelivery,
  type DispatchListener,
  type DispatchOutboxRepository,
  type DispatchPublisher,
  type JobRepository,
  type RedisDispatchConfig,
  type SqsDispatchConfig,
} from '../src/index';
import type { DispatchTarget } from './dispatch-contract';

/** A TCP proxy that can go down (every socket reset, connects refused) and come back on the same port. */
export class TcpProxy {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  port = 0;
  constructor(
    private readonly host: string,
    private readonly targetPort: number
  ) {}

  async up(): Promise<void> {
    if (this.server) return;
    const server = createServer((client) => {
      const upstream = connect(this.targetPort, this.host);
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
        s.on('error', () => undefined);
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as { port: number }).port;
    this.server = server;
  }

  async down(): Promise<void> {
    const s = this.server;
    this.server = null;
    for (const sock of this.sockets) sock.resetAndDestroy();
    this.sockets.clear();
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

/** Competing consumers over an in-memory queue: one delivery per receive, invisible until acked, released or timed out. */
export class MemoryQueueBroker {
  private seq = 0;
  private messages = new Map<string, { body: string; invisibleUntil: number; receipt?: string }>();
  private waiters = new Set<() => void>();
  down = false;
  constructor(readonly visibilityMs = 3000) {}

  get size(): number {
    return this.messages.size;
  }

  publisher(): DispatchPublisher {
    return {
      driver: 'memory-queue',
      publish: async (ids) => {
        if (this.down) throw new Error('broker unavailable (test)');
        for (const id of ids) this.messages.set(String(++this.seq), { body: `r:${id}`, invisibleUntil: 0 });
        for (const w of [...this.waiters]) w();
      },
    };
  }

  take(max: number): BrokerDelivery[] {
    const now = Date.now();
    const out: BrokerDelivery[] = [];
    for (const [id, m] of this.messages) {
      if (out.length >= max) break;
      if (m.invisibleUntil > now) continue;
      m.receipt = `${id}.${randomBytes(4).toString('hex')}`;
      m.invisibleUntil = now + this.visibilityMs;
      out.push({ handle: m.receipt, body: m.body });
    }
    return out;
  }

  async receive(max: number, waitMs: number): Promise<BrokerDelivery[]> {
    if (this.down) throw new Error('broker unavailable (test)');
    const got = this.take(max);
    if (got.length) return got;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, waitMs);
      this.waiters.add(done);
    });
    if (this.down) throw new Error('broker unavailable (test)');
    return this.take(max);
  }

  ack(handle: string) {
    if (this.down) throw new Error('broker unavailable (test)');
    const id = handle.split('.')[0]!;
    if (this.messages.get(id)?.receipt === handle) this.messages.delete(id);
  }

  release(handle: string) {
    if (this.down) throw new Error('broker unavailable (test)');
    const m = this.messages.get(handle.split('.')[0]!);
    if (m?.receipt === handle) m.invisibleUntil = 0;
    for (const w of [...this.waiters]) w();
  }

  listener(): MemoryQueueListener {
    return new MemoryQueueListener(this);
  }
}

export class MemoryQueueListener extends BrokerListener {
  readonly driver = 'memory-queue';
  constructor(private readonly broker: MemoryQueueBroker) {
    super({ redeliverAfterMs: broker.visibilityMs, maxBatch: 10 });
  }
  protected async connect() {
    if (this.broker.down) throw new Error('broker unavailable (test)');
  }
  protected receive(max: number) {
    return this.broker.receive(max, 200);
  }
  protected async acknowledge(d: BrokerDelivery) {
    this.broker.ack(d.handle);
  }
  protected async giveBack(d: BrokerDelivery) {
    this.broker.release(d.handle);
  }
  protected async close() {}
}

/** A job repository whose transactions write outbox rows (ReadySignal `outbox`). */
export interface OutboxRepos {
  jobs: JobRepository;
  outbox: DispatchOutboxRepository;
  close(): Promise<void>;
}

/** One broker under test: a publisher for the relay, listeners for workers, a way to cut their connection. */
export interface BrokerUnderTest {
  driver: string;
  publisher: DispatchPublisher;
  listener(): DispatchListener;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  /** Messages still in the broker (not yet acknowledged). */
  backlog(): Promise<number>;
  close(): Promise<void>;
}

export async function memoryQueueBroker(visibilityMs = 3000): Promise<BrokerUnderTest & { broker: MemoryQueueBroker }> {
  const broker = new MemoryQueueBroker(visibilityMs);
  return {
    driver: 'memory-queue',
    broker,
    publisher: broker.publisher(),
    listener: () => broker.listener(),
    disconnect: async () => void (broker.down = true),
    reconnect: async () => void (broker.down = false),
    backlog: async () => broker.size,
    close: async () => undefined,
  };
}

const sqsCreds = { region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test' };

/** A fresh SQS queue on TEST_SQS_ENDPOINT (LocalStack); listeners go through a proxy. */
export async function sqsBroker(o: { visibilityTimeoutSeconds?: number; publishThroughProxy?: boolean; listenerConfig?: Partial<SqsDispatchConfig> } = {}): Promise<BrokerUnderTest & { proxy: TcpProxy; queueUrl: string; config(viaProxy: boolean): SqsDispatchConfig }> {
  const endpoint = process.env.TEST_SQS_ENDPOINT!;
  const u = new URL(endpoint);
  const admin = new SQSClient({ endpoint, region: sqsCreds.region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const { QueueUrl } = await admin.send(new CreateQueueCommand({ QueueName: `rf-test-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}` }));
  const proxy = new TcpProxy(u.hostname, Number(u.port || 80));
  await proxy.up();
  const config = (viaProxy: boolean): SqsDispatchConfig => ({
    ...sqsCreds,
    queueUrl: QueueUrl!,
    endpoint: viaProxy ? `http://127.0.0.1:${proxy.port}` : endpoint,
    visibilityTimeoutSeconds: o.visibilityTimeoutSeconds ?? 5,
    waitTimeSeconds: 2,
  });
  const publisher = new SqsDispatchPublisher(() => config(Boolean(o.publishThroughProxy)));
  const listeners: DispatchListener[] = [];
  return {
    driver: 'sqs',
    proxy,
    queueUrl: QueueUrl!,
    config,
    publisher,
    listener: () => {
      const l = new SqsDispatchListener(() => ({ ...config(true), ...o.listenerConfig }));
      listeners.push(l);
      return l;
    },
    disconnect: () => proxy.down(),
    reconnect: () => proxy.up(),
    async backlog() {
      const a = await admin.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
      return Number(a.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(a.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    },
    async close() {
      for (const l of listeners) await l.stop().catch(() => undefined);
      await publisher.close();
      await proxy.down();
      await admin.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined);
      admin.destroy();
    },
  };
}

/** A fresh stream key on TEST_REDIS_URL; listeners go through a proxy. */
export async function redisBroker(o: { claimIdleSeconds?: number; publishThroughProxy?: boolean } = {}): Promise<BrokerUnderTest & { proxy: TcpProxy; admin: Redis; config(viaProxy: boolean): RedisDispatchConfig }> {
  const url = process.env.TEST_REDIS_URL!;
  const u = new URL(url);
  const proxy = new TcpProxy(u.hostname, Number(u.port || 6379));
  await proxy.up();
  const stream = `rf-test:${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const config = (viaProxy: boolean): RedisDispatchConfig => {
    const v = new URL(url);
    if (viaProxy) {
      v.hostname = '127.0.0.1';
      v.port = String(proxy.port);
    }
    return { url: v.toString(), stream, group: 'workers', claimIdleSeconds: o.claimIdleSeconds ?? 5, maxLength: 10_000 };
  };
  const admin = new Redis(url);
  const publisher = new RedisDispatchPublisher(() => config(Boolean(o.publishThroughProxy)));
  const listeners: DispatchListener[] = [];
  let n = 0;
  return {
    driver: 'redis',
    proxy,
    admin,
    config,
    publisher,
    listener: () => {
      const l = new RedisDispatchListener(() => config(true), { consumer: `c${++n}` });
      listeners.push(l);
      return l;
    },
    disconnect: () => proxy.down(),
    reconnect: () => proxy.up(),
    async backlog() {
      // Entries not yet delivered (lag) plus delivered and not acknowledged (pending).
      if (!(await admin.exists(stream))) return 0;
      const groups = (await admin.call('XINFO', 'GROUPS', stream)) as unknown[][];
      let total = 0;
      for (const g of groups) {
        const f: Record<string, unknown> = {};
        for (let i = 0; i + 1 < g.length; i += 2) f[String(g[i])] = g[i + 1];
        total += Number(f.pending ?? 0) + Number(f.lag ?? 0);
      }
      return total;
    },
    async close() {
      for (const l of listeners) await l.stop().catch(() => undefined);
      await publisher.close();
      await proxy.down();
      await admin.del(stream).catch(() => undefined);
      admin.disconnect();
    },
  };
}

/** Contract targets for the broker drivers on top of `repos` (memory, or a database in packages/db). */
export function brokerTargets(name: string, repos: () => Promise<OutboxRepos>): DispatchTarget[] {
  const target = (driver: string, make: () => Promise<BrokerUnderTest>): DispatchTarget => ({
    name: `${driver} on ${name}`,
    driver,
    async open() {
      const r = await repos();
      const b = await make();
      const relay = new OutboxRelay({ repo: r.outbox, publisher: b.publisher, sweepMs: 250 });
      relay.start();
      return {
        repo: r.jobs,
        listener: () => b.listener(),
        disconnect: () => b.disconnect(),
        reconnect: () => void b.reconnect(),
        dispatch: { onPublished: () => relay.kick() },
        close: async () => {
          await relay.stop();
          await b.close();
          await r.close();
        },
      };
    },
  });
  return [
    target('memory-queue', () => memoryQueueBroker()),
    ...(process.env.TEST_SQS_ENDPOINT ? [target('sqs', () => sqsBroker())] : []),
    ...(process.env.TEST_REDIS_URL ? [target('redis', () => redisBroker())] : []),
  ];
}

/** A fresh SQS queue on TEST_SQS_ENDPOINT for other packages' tests (they do not depend on the SDK themselves). */
export async function createSqsTestQueue(prefix = 'rf-test'): Promise<{ queueUrl: string; drop(): Promise<void> }> {
  const admin = new SQSClient({ endpoint: process.env.TEST_SQS_ENDPOINT!, region: sqsCreds.region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const { QueueUrl } = await admin.send(new CreateQueueCommand({ QueueName: `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}` }));
  return {
    queueUrl: QueueUrl!,
    drop: async () => {
      await admin.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined);
      admin.destroy();
    },
  };
}

/** A Redis ACL user with `password` on TEST_REDIS_URL (and a stream key to delete afterwards). */
export async function createRedisTestUser(password: string): Promise<{ user: string; stream: string; drop(): Promise<void> }> {
  const r = new Redis(process.env.TEST_REDIS_URL!);
  const user = `rf${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const stream = `rf-test:${user}`;
  await r.call('ACL', 'SETUSER', user, 'on', `>${password}`, '~*', '&*', '+@all');
  return {
    user,
    stream,
    drop: async () => {
      await r.del(stream).catch(() => undefined);
      await r.call('ACL', 'DELUSER', user).catch(() => undefined);
      r.disconnect();
    },
  };
}
