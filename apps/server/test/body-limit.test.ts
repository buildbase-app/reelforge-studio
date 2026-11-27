/**
 * A body over the limit with a declared Content-Length (#404): the client reads `413 too_large` instead of a reset
 * connection ("other side closed"), on REST and on /mcp, and the server drains without buffering. Test ids LIMS-08..09.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

const { dir, cleanup } = tempDir('renderweld-body-limit-');
const LIMIT = 256 * 1024;
let server: StartedServer;
let key: string;
let dropDb: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    { registry: new PluginRegistry().registerEngine(fakeEngine('remotion')), env: { ...database.env, REELFORGE_LICENCE_MODE: 'off', REELFORGE_MAX_JSON_BYTES: String(LIMIT), REELFORGE_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0' }, quiet: true }
  );
  key = (await server.service.keys.create('agent', ['read', 'write', 'render'])).key;
}, 120_000);

afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

/** 100 sends of twice the limit with a declared length; how many read the 413 body naming the limit. */
async function tally(path: string, headers: Record<string, string> = {}) {
  const body = JSON.stringify({ filler: 'x'.repeat(2 * LIMIT) });
  let ok = 0;
  const failures: string[] = [];
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body,
      });
      const json = (await r.json()) as { error?: { code?: string } };
      if (r.status === 413 && json.error?.code === 'too_large') ok++;
      else failures.push(`${r.status} ${JSON.stringify(json).slice(0, 80)}`);
    } catch (e) {
      failures.push(String((e as Error & { cause?: Error }).cause?.message ?? (e as Error).message));
    }
  }
  return { ok, failures };
}

describe('a body over limits.maxJsonBytes with a declared length (#404)', () => {
  it('LIMS-08 REST: Node fetch reads 413 too_large, not a reset connection, in at least 99 of 100 sends', async () => {
    const { ok, failures } = await tally('/v1/projects');
    expect(ok, failures.slice(0, 5).join('; ')).toBeGreaterThanOrEqual(99);
  }, 120_000);

  it('LIMS-09 /mcp: the same', async () => {
    const { ok, failures } = await tally('/mcp');
    expect(ok, failures.slice(0, 5).join('; ')).toBeGreaterThanOrEqual(99);
  }, 120_000);
});
