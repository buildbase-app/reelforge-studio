/**
 * GET /mcp (#403): the server is stateless and has no server-to-client stream, so it answers 405 with `Allow: POST`
 * before auth, rate limiting and the access log, and an idle MCP client stops reconnecting. Test ids MCPG-01..02.
 */
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

const { dir, cleanup } = tempDir('renderweld-mcp-get-');
let server: StartedServer;
let key: string;
let dropDb: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    { registry: new PluginRegistry().registerEngine(fakeEngine('remotion')), env: { ...database.env, REELFORGE_LICENCE_MODE: 'off' }, quiet: true }
  );
  key = (await server.service.keys.create('agent', ['read', 'write', 'render'])).key;
}, 120_000);

afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

describe('GET /mcp (#403)', () => {
  it('MCPG-01 answers 405 with Allow: POST, with or without a key', async () => {
    const tries: Array<Record<string, string>> = [{ accept: 'text/event-stream', authorization: `Bearer ${key}` }, { accept: 'text/event-stream' }];
    for (const headers of tries) {
      const r = await fetch(`${server.url}/mcp`, { headers });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('POST');
      await r.body?.cancel();
    }
  });

  it('MCPG-02 an idle SDK client sends at most one request in 30 s besides its calls', async () => {
    const sent: string[] = [];
    const counting: typeof fetch = (input, init) => {
      sent.push(init?.method ?? 'GET');
      return fetch(input, init);
    };
    const client = new Client({ name: 'renderweld-idle-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { fetch: counting, requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    const afterConnect = sent.length;
    await new Promise((r) => setTimeout(r, 30_000));
    const idle = sent.slice(afterConnect);
    await client.close();
    expect(idle.length, `requests while idle: ${idle.join(', ')}`).toBeLessThanOrEqual(1);
  }, 60_000);
});
