/**
 * Broker dispatch drivers (D-105, issue #158) on PostgreSQL and MySQL (when
 * TEST_POSTGRES_URL / TEST_MYSQL_URL are set): the job repository writes the
 * outbox row in the job's transaction, the relay publishes it, workers claim
 * with the fenced, fair claim of the database. The broker cases BRK-01..07 on
 * the in-memory competing-consumer queue always run; with TEST_SQS_ENDPOINT
 * (LocalStack) and TEST_REDIS_URL the contract (DSP-nn) and BRK-01..07 run
 * against the real brokers too. Ids: docs/providers/queue-and-scaling.md.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { dispatchContract } from '../../core/test/dispatch-contract';
import { brokerCases } from '../../core/test/dispatch-broker-cases';
import { brokerTargets, type OutboxRepos } from '../../core/test/broker-fixtures';
import { availableTestDatabases, createTestDatabase, prepareDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-brokers-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

for (const kind of availableTestDatabases().filter((k) => k !== 'sqlite')) {
  const repos = async (): Promise<OutboxRepos> => {
    const t = await createTestDatabase(kind, tmp);
    const { db } = await prepareDatabase({ url: t.url, dataDir: join(tmp, 'none'), readySignal: { kind: 'outbox' } });
    const r = db.repositories();
    return {
      jobs: r.jobs,
      outbox: r.dispatchOutbox,
      close: async () => {
        await db.close();
        await t.drop();
      },
    };
  };
  // The in-memory queue's contract runs in core; here the database is what is new.
  for (const t of brokerTargets(kind, repos).filter((t) => t.driver !== 'memory-queue')) dispatchContract(t, { timeoutMs: 90_000 });
  brokerCases(kind, repos);
}
