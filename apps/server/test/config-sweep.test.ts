import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, SETTINGS, type ConfigEntry } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * Every runtime setting, changed over the API (configuration sweep): set over REST (PATCH /v1/config), read back
 * over MCP (get_config) as a runtime value, cleared over MCP (update_config with null), and back to its earlier
 * source over REST. The setting list is the schema, so a new runtime setting is covered the day it is added.
 * Each value is one small step from the current one, so the server stays usable between steps.
 */
const { dir, cleanup } = tempDir('renderweld-config-sweep-');
let server: StartedServer;
let owner: string;
let dropDb: () => Promise<void> = async () => undefined;

const rest = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${owner}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : {} };
};
const mcp = async (name: string, args: Record<string, unknown>) => {
  const r = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${owner}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const res = (JSON.parse(raw.startsWith('event:') ? raw.split('data: ')[1]! : raw) as { result?: { isError?: boolean; content: Array<{ text: string }> } }).result;
  if (!res) return { isError: true, json: { status: r.status, raw: raw.slice(0, 300) } };
  let json: any;
  try {
    json = JSON.parse(res.content[0]!.text);
  } catch {
    json = { text: res.content[0]?.text };
  }
  return { isError: Boolean(res.isError), json };
};

const STRINGS = ['https://example.com/hook', 'x-probe=1', 'example.com', 'en', 'info', 'x-probe', 'probe', '1h', '#000000', 'stdout', 'elevenlabs', 'a'];
/** A valid value for the setting other than its current one, from what get_config says about it. */
function nextValue(e: ConfigEntry): unknown {
  const def = SETTINGS.find((d) => d.key === e.key)!;
  const ok = (v: unknown) => def.schema.safeParse(v).success && JSON.stringify(v) !== JSON.stringify(e.value);
  const candidates: unknown[] = [];
  switch (e.kind) {
    case 'boolean':
      candidates.push(!e.value);
      break;
    case 'integer':
    case 'number': {
      // One step up from a non-zero value; from 0 (usually "off" or "no limit") the loosest valid value, so a limit
      // never shuts the sweep out.
      const cur = typeof e.value === 'number' ? e.value : 0;
      if (cur > 0) candidates.push(cur + 1, cur * 2, cur - 1);
      candidates.push(e.max, 1_000_000, 100_000, 10_000, 1000, 100, 10, 2, 1);
      break;
    }
    case 'enum':
      candidates.push(...(e.options ?? []));
      break;
    case 'list':
      // Address allowlists first with this machine, so the sweep keeps its own access.
      candidates.push(['127.0.0.1/32'], ['127.0.0.1'], ...STRINGS.map((s) => [s]), ['*']);
      break;
    default:
      candidates.push(...STRINGS);
  }
  return candidates.find((c) => c !== undefined && ok(c));
}

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    {
      registry: new PluginRegistry().registerEngine(fakeEngine('remotion')),
      env: { ...database.env, REELFORGE_LICENCE_MODE: 'off', REELFORGE_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_SECRET_KEY: 'config-sweep-secret-key-0123456789abcdef' },
      quiet: true,
    }
  );
  owner = (await server.service.keys.create('owner', ['admin', 'owner'])).key;
}, 60_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

describe('configuration sweep', () => {
  it('CFG-SWEEP-01 every runtime setting can be set over REST, read over MCP, cleared over MCP and read over REST', async () => {
    const before = (await rest('GET', '/v1/config')).json.settings as ConfigEntry[];
    const runtime = before.filter((e) => e.scope === 'runtime' && !e.locked);
    expect(runtime.length).toBeGreaterThan(100);
    const wrong: string[] = [];
    const noValue: string[] = [];
    for (const e of runtime) {
      const v = nextValue(e);
      if (v === undefined) {
        noValue.push(e.key);
        continue;
      }
      let patch: Record<string, unknown> = { [e.key]: v };
      let set = await rest('PATCH', '/v1/config', patch);
      // Settings that only make sense together (an access key id and its secret) are refused alone: set the pair.
      const pair = set.status === 422 ? /set both ([\w.]+) and ([\w.]+)/.exec(JSON.stringify(set.json)) : null;
      if (pair) {
        const other = [pair[1], pair[2]].find((k) => k !== e.key)!;
        patch = { ...patch, [other]: nextValue(runtime.find((x) => x.key === other)!) };
        set = await rest('PATCH', '/v1/config', patch);
      }
      if (set.status !== 200) {
        wrong.push(`${e.key}=${JSON.stringify(v)}: PATCH ${set.status} ${JSON.stringify(set.json).slice(0, 160)}`);
        continue;
      }
      const read = await mcp('get_config', { prefix: e.key });
      const got = (read.json.settings as ConfigEntry[]).find((x) => x.key === e.key);
      const expected = e.secret ? 'set' : v;
      if (read.isError || got?.source !== 'runtime' || JSON.stringify(got.value) !== JSON.stringify(expected)) {
        wrong.push(`${e.key}: get_config after PATCH gave ${JSON.stringify(got?.value)} from ${got?.source}`);
      }
      const clear = await mcp('update_config', { settings: Object.fromEntries(Object.keys(patch).map((k) => [k, null])) });
      if (clear.isError) wrong.push(`${e.key}: update_config null refused: ${JSON.stringify(clear.json).slice(0, 160)}`);
      const after = ((await rest('GET', `/v1/config?prefix=${encodeURIComponent(e.key)}`)).json.settings as ConfigEntry[]).find((x) => x.key === e.key);
      if (after?.source !== e.source || JSON.stringify(after.value) !== JSON.stringify(e.value)) {
        wrong.push(`${e.key}: after clearing, ${JSON.stringify(after?.value)} from ${after?.source}, was ${JSON.stringify(e.value)} from ${e.source}`);
      }
    }
    expect(noValue).toEqual([]);
    expect(wrong).toEqual([]);
  }, 120_000);

  it('CFG-SWEEP-02 every start-up setting is refused at runtime with where to set it, over REST and MCP', async () => {
    const startup = ((await rest('GET', '/v1/config')).json.settings as ConfigEntry[]).filter((e) => e.scope === 'startup');
    expect(startup.length).toBeGreaterThan(50);
    const wrong: string[] = [];
    for (const e of startup) {
      const r = await rest('PATCH', '/v1/config', { [e.key]: e.value ?? 'x' });
      const body = JSON.stringify(r.json);
      if (r.status !== 409 || r.json.error?.code !== 'startup_only_setting' || !body.includes(e.env)) wrong.push(`${e.key}: REST ${r.status} ${body.slice(0, 120)}`);
    }
    const m = await mcp('update_config', { settings: { [startup[0]!.key]: startup[0]!.value ?? 'x' } });
    if (!m.isError) wrong.push(`${startup[0]!.key}: MCP accepted a start-up setting`);
    expect(wrong).toEqual([]);
  });
});
