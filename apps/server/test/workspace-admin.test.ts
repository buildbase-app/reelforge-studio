import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, type WorkspaceRouter } from '@reelforge/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, makeTone, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/** Workspace management (owner tools), per-workspace limits and the owner's view of every audit log (#304). */
const { dir, cleanup } = tempDir('reelforge-wsadmin-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
let server: StartedServer;
let owner: string;
let dropDb: () => Promise<void> = async () => undefined;

async function rest(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${opts.key ?? owner}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, headers: res.headers };
}

async function upload(key: string) {
  const form = new FormData();
  form.set('file', new Blob([readFileSync(join(dir, 'tone.mp3'))], { type: 'audio/mpeg' }), 'tone.mp3');
  return fetch(`${server.url}/v1/assets`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
}

beforeAll(async () => {
  await makeTone(join(dir, 'tone.mp3'), 1);
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    {
      registry: new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas')),
      env: { ...database.env, REELFORGE_LICENCE_MODE: 'off', REELFORGE_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_SECRET_KEY: 'workspace-admin-secret-key-0123456789' },
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

describe('workspace management (#304)', () => {
  let acme: string;

  it('WSA-01 the owner creates a workspace with its first admin key; the key sees only that workspace', async () => {
    expect((await rest('POST', '/v1/workspaces', { body: { id: 'Not Valid' } })).status).toBe(400);
    const c = await rest('POST', '/v1/workspaces', { body: { id: 'acme', name: 'Acme Ltd', adminKey: { name: 'acme-admin' } } });
    expect(c.status).toBe(201);
    expect(c.json.workspace).toMatchObject({ id: 'acme', name: 'Acme Ltd', status: 'active', effectiveLimits: {} });
    expect(c.json.keyRecord).toMatchObject({ name: 'acme-admin', scopes: ['admin'] });
    acme = c.json.key;
    expect((await rest('POST', '/v1/workspaces', { body: { id: 'acme' } })).status).toBe(409);
    expect((await rest('POST', '/v1/workspaces', { body: { id: 'x', adminKey: { scopes: ['owner'] } } })).status).toBe(400);
    const me = await rest('GET', '/v1/workspace', { key: acme });
    expect(me.json).toMatchObject({ id: 'acme', name: 'Acme Ltd', usage: { rendersToday: 0, rendersThisMonth: 0, storageBytes: 0 } });
    expect((await rest('GET', '/v1/workspace')).json.id).toBe('default');
    // A workspace admin manages its own keys and cannot use the owner tools.
    expect((await rest('GET', '/v1/workspaces', { key: acme })).status).toBe(403);
    expect((await rest('GET', '/v1/keys', { key: acme })).json.keys.map((k: any) => k.name)).toEqual(['acme-admin']);
    const list = await rest('GET', '/v1/workspaces');
    expect(list.json.workspaces.map((w: any) => w.id)).toEqual(['default', 'acme']);
  });

  it('WSA-02 rename, limits, suspend and resume; the default workspace cannot be suspended or deleted', async () => {
    const u = await rest('PATCH', '/v1/workspaces/acme', { body: { name: 'Acme', limits: { rendersPerDay: 1, storageBytes: null } } });
    expect(u.status).toBe(200);
    expect(u.json).toMatchObject({ name: 'Acme', limits: { rendersPerDay: 1 }, effectiveLimits: { rendersPerDay: 1 } });
    expect((await rest('PATCH', '/v1/workspaces/acme', { body: { limits: { bogus: 1 } } })).status).toBe(400);
    expect((await rest('PATCH', '/v1/workspaces/default', { body: { suspended: true } })).status).toBe(409);
    expect((await rest('DELETE', '/v1/workspaces/default')).status).toBe(409);
    expect((await rest('PATCH', '/v1/workspaces/nope', { body: { name: 'x' } })).status).toBe(404);
    expect((await rest('PATCH', '/v1/workspaces/acme', { body: { suspended: true } })).json.status).toBe('suspended');
    const refused = await rest('GET', '/v1/projects', { key: acme });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('workspace_suspended');
    expect((await rest('PATCH', '/v1/workspaces/acme', { body: { suspended: false } })).json.status).toBe('active');
    expect((await rest('GET', '/v1/projects', { key: acme })).status).toBe(200);
  });

  it('WSA-03 limits: renders per day (429 workspace_quota_exceeded), requests per minute and storage bytes (507)', async () => {
    expect((await rest('POST', '/v1/projects', { key: acme, body: { manifest: { ...sample, projectId: 'acme-reel' } } })).status).toBe(201);
    const first = await rest('POST', '/v1/projects/acme-reel/renders', { key: acme, body: {} });
    expect(first.status).toBe(202);
    expect((await rest('GET', `/v1/jobs/${first.json.job.id}?wait=45`, { key: acme })).json.status).toBe('succeeded');
    const second = await rest('POST', '/v1/projects/acme-reel/renders', { key: acme, body: {} });
    expect(second.status).toBe(429);
    expect(second.json.error).toMatchObject({ code: 'workspace_quota_exceeded', details: { limit: 'workspace.limits.rendersPerDay', max: 1, used: 1 } });
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
    // The default workspace is not limited by acme's limits.
    expect((await rest('POST', '/v1/projects', { body: { manifest: { ...sample, projectId: 'default-reel' } } })).status).toBe(201);
    expect((await rest('POST', '/v1/projects/default-reel/renders', { body: {} })).status).toBe(202);
    // Storage: acme now stores a render; a limit below that refuses uploads and renders.
    expect((await rest('GET', '/v1/workspace', { key: acme })).json.usage.storageBytes).toBeGreaterThan(0);
    await rest('PATCH', '/v1/workspaces/acme', { body: { limits: { storageBytes: 1 } } });
    const up = await upload(acme);
    expect(up.status).toBe(507);
    expect((await up.json()).error.code).toBe('storage_limit_exceeded');
    // Requests per minute across the workspace's keys.
    await rest('PATCH', '/v1/workspaces/acme', { body: { limits: { rateLimitPerMinute: 2 } } });
    (server.service.repos as WorkspaceRouter).invalidateWorkspaces();
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await rest('GET', '/v1/workspace', { key: acme })).status);
    expect(codes.slice(0, 2)).toEqual([200, 200]);
    const limited = await rest('GET', '/v1/workspace', { key: acme });
    expect(limited.status).toBe(429);
    expect(limited.json.error.details.scope).toBe('workspace');
    await rest('PATCH', '/v1/workspaces/acme', { body: { limits: null } });
    (server.service.repos as WorkspaceRouter).invalidateWorkspaces();
  }, 90_000);

  it('WSA-04 instance-wide default limits (workspaces.*) apply to workspaces without their own', async () => {
    expect((await rest('PATCH', '/v1/config', { body: { 'workspaces.rendersPerDay': 1 } })).status).toBe(200);
    expect((await rest('GET', '/v1/workspace', { key: acme })).json.effectiveLimits).toEqual({ rendersPerDay: 1 });
    const r = await rest('POST', '/v1/projects/acme-reel/renders', { key: acme, body: {} });
    expect(r.json.error?.code).toBe('workspace_quota_exceeded');
    expect((await rest('PATCH', '/v1/config', { body: { 'workspaces.rendersPerDay': null } })).status).toBe(200);
  });

  it('WSA-05 the owner reads every workspace\'s audit log; an admin only its own', async () => {
    const all = await rest('GET', '/v1/audit?workspaceId=*&limit=500');
    expect(all.status).toBe(200);
    const by = new Set(all.json.events.map((e: any) => e.workspaceId));
    expect([...by].sort()).toEqual(['acme', 'default']);
    expect(all.json.events.some((e: any) => e.workspaceId === 'acme' && e.action === 'workspace.update')).toBe(true);
    const sorted = [...all.json.events].sort((a: any, b: any) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    expect(all.json.events.map((e: any) => e.at)).toEqual(sorted.map((e: any) => e.at));
    const one = await rest('GET', '/v1/audit?workspaceId=acme&limit=500');
    expect(one.json.events.every((e: any) => e.workspaceId === 'acme')).toBe(true);
    expect((await rest('GET', '/v1/audit?workspaceId=default', { key: acme })).status).toBe(403);
    expect((await rest('GET', '/v1/audit?workspaceId=nope')).status).toBe(404);
    const own = await rest('GET', '/v1/audit?limit=500', { key: acme });
    expect(own.json.events.some((e: any) => e.action === 'project.create')).toBe(true);
    // The owner's actions on the workspace are in its own trail too.
    expect(own.json.events.filter((e: any) => e.actorName === 'owner').map((e: any) => e.action)).toEqual(expect.arrayContaining(['workspace.create', 'workspace.suspend', 'workspace.resume']));
    expect(own.json.events.every((e: any) => e.workspaceId === undefined)).toBe(true);
  });

  it('WSA-06 delete with a grace period, restore, then purge: rows and files of that workspace only', async () => {
    const del = await rest('DELETE', '/v1/workspaces/acme');
    expect(del.json).toMatchObject({ status: 'deleted' });
    expect(Date.parse(del.json.purgeAfter) - Date.parse(del.json.deletedAt)).toBe(30 * 86_400_000);
    expect((await rest('GET', '/v1/projects', { key: acme })).status).toBe(401);
    expect((await rest('POST', '/v1/workspaces/acme/restore')).json.status).toBe('active');
    expect((await rest('GET', '/v1/projects', { key: acme })).json.projects.map((p: any) => p.id)).toEqual(['acme-reel']);
    // Grace 0: the next sweep purges it.
    await rest('PATCH', '/v1/config', { body: { 'workspaces.deleteGraceDays': 0 } });
    await rest('DELETE', '/v1/workspaces/acme');
    expect(existsSync(join(dir, 'data', 'workspaces', 'acme'))).toBe(true);
    const swept = await server.service.sweep();
    expect(swept.workspacesPurged).toEqual(['acme']);
    expect(existsSync(join(dir, 'data', 'workspaces', 'acme'))).toBe(false);
    expect((await rest('GET', '/v1/workspaces')).json.workspaces.map((w: any) => w.id)).toEqual(['default']);
    expect(await (server.service.repos as WorkspaceRouter).forWorkspace('acme').projects.list()).toEqual([]);
    expect((await rest('GET', '/v1/projects')).json.projects.map((p: any) => p.id)).toEqual(['default-reel']);
    const purge = await rest('GET', '/v1/audit?action=workspace.purge');
    expect(purge.json.events[0]).toMatchObject({ targetId: 'acme', actorType: 'system' });
    expect((await rest('POST', '/v1/workspaces/acme/restore')).status).toBe(404);
    await rest('PATCH', '/v1/config', { body: { 'workspaces.deleteGraceDays': null } });
  }, 60_000);

  it('WSA-07 the same tools over MCP', async () => {
    const client = new Client({ name: 'reelforge-wsadmin', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${owner}` } } }));
    const parse = (r: any) => JSON.parse(r.content[0].text);
    const created = parse(await client.callTool({ name: 'create_workspace', arguments: { id: 'mcp-team', adminKey: true } }));
    expect(created.workspace.id).toBe('mcp-team');
    expect(created.key).toMatch(/^rf_/);
    expect(parse(await client.callTool({ name: 'update_workspace', arguments: { workspaceId: 'mcp-team', name: 'MCP team' } })).name).toBe('MCP team');
    expect(parse(await client.callTool({ name: 'list_workspaces', arguments: {} })).workspaces.map((w: any) => w.id)).toContain('mcp-team');
    expect(parse(await client.callTool({ name: 'delete_workspace', arguments: { workspaceId: 'mcp-team' } })).status).toBe('deleted');
    expect(parse(await client.callTool({ name: 'restore_workspace', arguments: { workspaceId: 'mcp-team' } })).status).toBe('active');
    await client.close();
    const team = new Client({ name: 'reelforge-wsadmin-team', version: '0.0.0' });
    await team.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${created.key}` } } }));
    expect(parse(await team.callTool({ name: 'get_workspace', arguments: {} })).id).toBe('mcp-team');
    expect(parse(await team.callTool({ name: 'list_workspaces', arguments: {} })).error.code).toBe('forbidden');
    await team.close();
  });

  // #343 (MCP OAuth) has not landed: when it does, an access token's workspace claim scopes it like a key.
  it.todo('WSA-08 an MCP OAuth access token is scoped by its workspace claim (reelforge:workspace); a token for an unknown or suspended workspace is refused');
});
