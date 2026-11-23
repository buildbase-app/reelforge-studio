import type { Config } from './config/schema';
import type { DispatchPublisher } from './dispatch';
import type { BrokerListener } from './dispatch-broker';
import { RedisDispatchListener, RedisDispatchPublisher, redactRedisUrl } from './dispatch-redis';
import { SqsDispatchListener, SqsDispatchPublisher } from './dispatch-sqs';

export * from './dispatch-broker';
export * from './dispatch-redis';
export * from './dispatch-sqs';

/** The outbox (broker) dispatch drivers (D-105). */
export const BROKER_DISPATCH_DRIVERS = ['sqs', 'redis'] as const;
export type BrokerDispatchDriver = (typeof BROKER_DISPATCH_DRIVERS)[number];
export const isBrokerDispatch = (d: string): d is BrokerDispatchDriver => (BROKER_DISPATCH_DRIVERS as readonly string[]).includes(d);

export interface BrokerDispatch {
  driver: BrokerDispatchDriver;
  /** The outbox relay's publisher (every instance). */
  publisher: DispatchPublisher;
  /** A worker's listener (claiming instances). */
  listener(opts?: { consumer?: string }): BrokerListener;
  /** Where messages go, for the start-up log (no secrets). */
  describe(): string;
}

/**
 * The publisher and listeners of `queue.dispatch` `sqs` or `redis`. `queue` returns the current queue settings
 * (runtime changes of credentials and passwords apply to the next call or connect).
 */
export function createBrokerDispatch(driver: BrokerDispatchDriver, queue: () => Config['queue'], opts: { log?: (level: 'info' | 'warn' | 'error', line: string) => void } = {}): BrokerDispatch {
  if (driver === 'sqs') {
    const cfg = () => queue().sqs;
    return {
      driver,
      publisher: new SqsDispatchPublisher(cfg),
      listener: () => new SqsDispatchListener(cfg, opts),
      describe: () => `SQS queue ${cfg().queueUrl ?? '(unset)'}, visibility timeout ${cfg().visibilityTimeoutSeconds} s, credentials ${cfg().accessKeyId ? 'queue.sqs.accessKeyId' : 'AWS default chain'}`,
    };
  }
  const cfg = () => queue().redis;
  return {
    driver,
    publisher: new RedisDispatchPublisher(cfg),
    listener: (o = {}) => new RedisDispatchListener(cfg, { ...opts, ...o }),
    describe: () => `Redis stream ${cfg().stream} (group ${cfg().group}) on ${redactRedisUrl(cfg().url)}, reclaim after ${cfg().claimIdleSeconds} s idle`,
  };
}
