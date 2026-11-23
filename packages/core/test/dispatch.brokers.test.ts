/**
 * Broker dispatch drivers (D-105, issue #158) on memory repositories: the
 * shared dispatch contract and the broker cases BRK-01..07 through the outbox
 * and its relay, on the in-memory competing-consumer queue (always), Amazon
 * SQS (TEST_SQS_ENDPOINT, LocalStack) and Redis Streams (TEST_REDIS_URL);
 * BRK-08: a wrong Redis password.
 * The same on PostgreSQL and MySQL: packages/db/test/dispatch.brokers.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { JobRunner, RedisDispatchListener, createMemoryRepositories } from '../src/index';
import { brokerTargets, createRedisTestUser, type OutboxRepos } from './broker-fixtures';
import { dispatchContract } from './dispatch-contract';
import { brokerCases } from './dispatch-broker-cases';

const memory = async (): Promise<OutboxRepos> => {
  const repos = createMemoryRepositories(undefined, { readySignal: { kind: 'outbox' } });
  return { jobs: repos.jobs, outbox: repos.dispatchOutbox, close: async () => undefined };
};

for (const t of brokerTargets('memory repositories', memory)) dispatchContract(t, { timeoutMs: 60_000 });
brokerCases('memory repositories', memory);

describe.skipIf(!process.env.TEST_REDIS_URL)('broker dispatch: redis credentials', () => {
  it('BRK-08 a wrong Redis password: the worker starts and polls, the listener reports WRONGPASS without the password, a corrected password connects', async () => {
    const password = 'Corr3ctRedisPassw0rd-0123456789';
    const wrong = 'Wr0ngRedisPassw0rd-0123456789';
    const u = await createRedisTestUser(password);
    const repos = await memory();
    let current = wrong;
    const cfg = () => ({ url: `${process.env.TEST_REDIS_URL!.replace('redis://', `redis://${u.user}@`)}`, password: current, stream: u.stream, group: 'g', claimIdleSeconds: 10, maxLength: 10_000 });
    const l = new RedisDispatchListener(cfg, { consumer: 'w1' });
    const w = new JobRunner({ repo: repos.jobs, handlers: { render: async () => ({}) }, mode: 'database', database: { workerId: 'w1', pollMs: 200, pollMaxMs: 200, dispatch: { driver: 'redis', listener: l } } });
    try {
      await w.init();
      expect(w.status().dispatch).toMatchObject({ listening: false });
      expect(l.status().lastError).toMatch(/WRONGPASS/);
      expect(JSON.stringify(l.status())).not.toContain(wrong);
      // The password is a runtime setting: the next connect attempt uses the new value.
      current = password;
      for (let i = 0; i < 200 && !w.status().dispatch!.listening; i++) await new Promise((r) => setTimeout(r, 100));
      expect(w.status().dispatch).toMatchObject({ listening: true });
    } finally {
      await w.shutdown(0);
      await u.drop();
    }
  }, 40_000);
});
