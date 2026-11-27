import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, type Scope } from '@renderweld/core';
import { REST_ROUTES, TOOLS, startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * Every REST route and every MCP tool, walked (security sweep): no key is refused with 401, and a key that has
 * every scope except the one the route needs is refused with 403, before the route looks at its parameters or
 * body. The route table (routes.ts) is the list, so a new route is covered the day it is added.
 */
const { dir, cleanup } = tempDir('renderweld-authz-');
let server: StartedServer;
let dropDb: () => Promise<void> = async () => undefined;

/** The scopes a key holds when it lacks the one a route needs: everything below it, never more. */
const BELOW: Record<string, Scope[]> = {
  write: ['read', 'render'],
  render: ['read', 'write'],
  admin: ['read', 'write', 'render'],
  owner: ['read', 'write', 'render', 'admin'],
};
const keys: Record<string, string> = {};
/** Routes that answer without a key on purpose, each with why. */
const PUBLIC = new Map<string, string>([]);

/** Arguments that pass a tool's input schema, so the call reaches the scope check (the MCP SDK validates first). */
const STRINGS = ['authzprobe0', 'https://example.com/a.png', '00000000-0000-4000-8000-000000000000', 'a@example.com', '2026-01-01T00:00:00Z', '#000000', 'x'];
function sample(schema: any): unknown {
  const d = schema?.def ?? schema?._def;
  switch (d?.type) {
    case 'optional':
    case 'default':
    case 'prefault':
      return undefined;
    case 'nullable':
    case 'readonly':
    case 'catch':
      return sample(d.innerType);
    case 'pipe':
      return sample(d.in);
    case 'lazy':
      return sample(d.getter());
    case 'string':
      return STRINGS.find((c) => schema.safeParse(c).success) ?? 'x';
    case 'number':
    case 'int':
      return [1, 0, 100, 1000].find((c) => schema.safeParse(c).success) ?? 1;
    case 'boolean':
      return false;
    case 'literal':
      return d.values[0];
    case 'enum':
      return Object.values(d.entries)[0];
    case 'array': {
      const one = [sample(d.element)];
      return schema.safeParse([]).success ? [] : one;
    }
    case 'record':
      return {};
    case 'union':
      for (const o of d.options) {
        const v = sample(o);
        if (schema.safeParse(v).success) return v;
      }
      return sample(d.options[0]);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d.shape as Record<string, unknown>)) {
        const x = sample(v);
        if (x !== undefined) out[k] = x;
      }
      return out;
    }
    default:
      return 'x';
  }
}
const argsFor = (input: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const x = sample(v);
    if (x !== undefined) out[k] = x;
  }
  return out;
};

/** A concrete path for a route pattern: every `:param` (with or without a Hono regex) becomes a made-up id. */
const concrete = (r: (typeof REST_ROUTES)[number]) => (r.display ?? r.path).replace(/\/:(\w+)(\{[^}]*\})?/g, '/authz-probe-0');

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    {
      registry: new PluginRegistry().registerEngine(fakeEngine('remotion')),
      env: { ...database.env, REELFORGE_LICENCE_MODE: 'off', REELFORGE_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_AUTH_FAILURES_PER_MINUTE: '0', REELFORGE_SECRET_KEY: 'authz-sweep-secret-key-0123456789abcdef' },
      quiet: true,
    }
  );
  for (const [scope, below] of Object.entries(BELOW)) keys[scope] = (await server.service.keys.create(`below-${scope}`, below)).key;
}, 60_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

const send = (method: string, path: string, key?: string) =>
  fetch(`${server.url}${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/json' }) },
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
  });

describe('authorization sweep over the route table', () => {
  it('AUTHZ-01 every REST route refuses a request with no key (401), before reading its parameters', async () => {
    const wrong: string[] = [];
    for (const r of REST_ROUTES) {
      if (PUBLIC.has(`${r.method} ${r.path}`)) continue;
      const res = await send(r.method, concrete(r));
      await res.arrayBuffer();
      if (res.status !== 401) wrong.push(`${r.method} ${concrete(r)} -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
    expect(REST_ROUTES.length).toBeGreaterThan(70);
  });

  it('AUTHZ-02 every REST route refuses a key that has every scope below the one it needs (403)', async () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const r of REST_ROUTES) {
      const key = keys[r.scope];
      if (!key) continue; // read: no scope below it
      checked++;
      const res = await send(r.method, concrete(r), key);
      const body = await res.text();
      if (res.status !== 403) wrong.push(`${r.method} ${concrete(r)} (${r.scope}) -> ${res.status} ${body.slice(0, 120)}`);
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(40);
  });

  it('AUTHZ-03 every MCP tool refuses a key without its scope, and /mcp refuses no key', async () => {
    const rpc = async (key: string | undefined, method: string, params: unknown) => {
      const res = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return { status: res.status, text: await res.text() };
    };
    expect((await rpc(undefined, 'tools/list', {})).status).toBe(401);
    const wrong: string[] = [];
    let checked = 0;
    for (const t of TOOLS) {
      const key = keys[t.scope];
      if (!key) continue;
      checked++;
      const r = await rpc(key, 'tools/call', { name: t.name, arguments: argsFor(t.input as Record<string, unknown>) });
      // The tool must answer with the scope refusal itself: not a validation error, not a result.
      let refused = false;
      try {
        const res = JSON.parse(r.text).result as { isError?: boolean; content: Array<{ text: string }> };
        const err = JSON.parse(res.content[0]!.text).error as { code: string; message: string } | undefined;
        refused = res.isError === true && err?.code === 'forbidden' && err.message.includes(`"${t.scope}" scope needed by ${t.name}`);
      } catch {
        refused = false;
      }
      if (!refused) wrong.push(`${t.name} (${t.scope}) -> ${r.status} ${r.text.slice(0, 160)}`);
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(40);
  });
});
