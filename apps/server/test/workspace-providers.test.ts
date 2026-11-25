import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PluginRegistry, runInWorkspace, type ProviderPlugin, type ProviderRunContext, type WorkspaceRouter } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * Per-workspace provider credentials (#480): a workspace brings its own provider account, its calls use it and
 * no other workspace's do, the instance's account is shared only as providers.shareWithWorkspaces allows
 * (nothing by default), and a secret is never echoed.
 */
const { dir, cleanup } = tempDir('renderweld-wsprov-');
let server: StartedServer;
let dropDb: () => Promise<void> = async () => undefined;
const A = 'alpha';
const B = 'beta';
const keys = { owner: '', a: '', aWrite: '', b: '', defaultAdmin: '' };
/** The key each call of the providers was given, in order: [workspace of the caller, key]. */
const calls: Array<{ provider: string; key: string | undefined }> = [];

/** Reads its key from ctx.env, like ElevenLabs. */
class ScopedTts implements ProviderPlugin {
  readonly id = 'scoped-tts';
  readonly kind = 'tts' as const;
  readonly displayName = 'Scoped test TTS';
  readonly env = ['SCOPED_TTS_KEY'];
  readonly scopedSettings = true;
  readonly costNote = 'Test provider.';
  readonly params = z.object({ text: z.string() });
  constructor(private readonly environment: NodeJS.ProcessEnv) {}
  configured(env: Readonly<Record<string, string | undefined>> = this.environment) {
    return Boolean(env.SCOPED_TTS_KEY);
  }
  async run(_params: unknown, ctx: ProviderRunContext) {
    calls.push({ provider: this.id, key: (ctx.env ?? this.environment).SCOPED_TTS_KEY });
    return { asset: await ctx.putAsset({ data: Buffer.from('ID3 test audio'), source: this.id, metadata: {} } as never) };
  }
}

/** An older plugin: reads only the environment it was built with. */
class LegacyTts implements ProviderPlugin {
  readonly id = 'legacy-tts';
  readonly kind = 'tts' as const;
  readonly displayName = 'Legacy test TTS';
  readonly env = ['LEGACY_TTS_KEY'];
  readonly costNote = 'Test provider.';
  readonly params = z.object({ text: z.string() });
  constructor(private readonly environment: NodeJS.ProcessEnv) {}
  configured() {
    return Boolean(this.environment.LEGACY_TTS_KEY);
  }
  async run(_params: unknown, ctx: ProviderRunContext) {
    calls.push({ provider: this.id, key: this.environment.LEGACY_TTS_KEY });
    return { asset: await ctx.putAsset({ data: Buffer.from('ID3 test audio'), source: this.id, metadata: {} } as never) };
  }
}

const rest = async (key: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, text, json: text ? JSON.parse(text) : {} };
};
const mcp = async (key: string, name: string, args: Record<string, unknown>) => {
  const r = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await r.text();
  const result = (JSON.parse(text) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { text, isError: Boolean(result.isError), body: result.content[0]!.text };
};
const run = (key: string, provider: string) => rest(key, 'POST', `/v1/providers/${provider}/run`, { params: { text: `hello ${calls.length}` }, acknowledgeCost: true });
const lastKey = () => calls.at(-1)?.key;
const providerOf = async (key: string, id: string) => ((await rest(key, 'GET', '/v1/providers')).json.providers as Array<Record<string, any>>).find((p) => p.id === id)!;

beforeAll(async () => {
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    {
      registry: (providerEnv) => new PluginRegistry().registerEngine(fakeEngine('remotion')).registerProvider(new ScopedTts(providerEnv)).registerProvider(new LegacyTts(providerEnv)),
      env: {
        ...database.env,
        REELFORGE_LICENCE_MODE: 'off',
        REELFORGE_RATE_LIMIT_PER_MINUTE: '0',
        REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0',
        REELFORGE_SECRET_KEY: 'workspace-providers-secret-0123456789',
        SCOPED_TTS_KEY: 'instance-scoped-key',
        LEGACY_TTS_KEY: 'instance-legacy-key',
      },
      quiet: true,
    }
  );
  const repos = server.service.repos as WorkspaceRouter;
  for (const id of [A, B]) await repos.workspaces.create({ id, name: id, status: 'active', createdAt: new Date().toISOString() });
  repos.invalidateWorkspaces();
  keys.owner = (await server.service.keys.create('owner', ['admin', 'owner'])).key;
  keys.defaultAdmin = (await server.service.keys.create('default-admin', ['admin', 'render', 'read'])).key;
  keys.a = (await runInWorkspace(A, () => server.service.keys.create('alpha-admin', ['admin']))).key;
  keys.aWrite = (await runInWorkspace(A, () => server.service.keys.create('alpha-writer', ['read', 'write', 'render']))).key;
  keys.b = (await runInWorkspace(B, () => server.service.keys.create('beta-admin', ['admin']))).key;
}, 60_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

describe('per-workspace provider credentials (#480)', () => {
  it('WSP-01 by default a workspace without its own key cannot use the instance account; the default workspace can; the owner can share it', async () => {
    const before = calls.length;
    const refused = await run(keys.a, 'scoped-tts');
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('provider_not_configured');
    expect(refused.json.error.message).toContain('configure_workspace_provider');
    expect((await run(keys.b, 'legacy-tts')).status).toBe(409);
    expect(calls.length).toBe(before);
    expect(await providerOf(keys.a, 'scoped-tts')).toMatchObject({ configured: false, settingsFrom: 'none', perWorkspace: true });
    expect((await run(keys.defaultAdmin, 'scoped-tts')).status).toBe(201);
    expect(lastKey()).toBe('instance-scoped-key');

    // Sharing every provider (how workspaces worked before #480) puts them on the instance account, and they say so.
    expect((await rest(keys.owner, 'PATCH', '/v1/config', { 'providers.shareWithWorkspaces': ['*'] })).status).toBe(200);
    expect((await run(keys.a, 'scoped-tts')).status).toBe(201);
    expect(lastKey()).toBe('instance-scoped-key');
    expect((await run(keys.b, 'legacy-tts')).status).toBe(201);
    expect(lastKey()).toBe('instance-legacy-key');
    const p = await providerOf(keys.a, 'scoped-tts');
    expect(p).toMatchObject({ configured: true, settingsFrom: 'instance', perWorkspace: true });
    expect(p.settings[0]).toMatchObject({ name: 'SCOPED_TTS_KEY', set: true, source: 'env' });
    expect(await providerOf(keys.a, 'legacy-tts')).toMatchObject({ settingsFrom: 'instance', perWorkspace: false });
  });

  it("WSP-02 a workspace admin sets its own key: its calls use it, the others' never do, and it is never echoed", async () => {
    const set = await rest(keys.a, 'PUT', '/v1/providers/scoped-tts/workspace-config', { values: { SCOPED_TTS_KEY: 'alpha-own-key' } });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ id: 'scoped-tts', configured: true, settingsFrom: 'workspace' });
    expect(set.json.settings[0]).toMatchObject({ set: true, source: 'workspace' });
    expect(set.text).not.toContain('alpha-own-key');

    expect((await run(keys.a, 'scoped-tts')).status).toBe(201);
    expect(lastKey()).toBe('alpha-own-key');
    expect((await run(keys.b, 'scoped-tts')).status).toBe(201);
    expect(lastKey()).toBe('instance-scoped-key');
    expect((await run(keys.defaultAdmin, 'scoped-tts')).status).toBe(201);
    expect(lastKey()).toBe('instance-scoped-key');

    // B and the default workspace still see the instance's; A's own value is in no answer.
    expect(await providerOf(keys.b, 'scoped-tts')).toMatchObject({ settingsFrom: 'instance' });
    for (const k of [keys.a, keys.b, keys.owner]) {
      expect((await rest(k, 'GET', '/v1/providers')).text).not.toContain('alpha-own-key');
      expect((await rest(k, 'GET', '/v1/capabilities')).text).not.toContain('alpha-own-key');
    }
    expect((await rest(keys.owner, 'GET', '/v1/config?prefix=providers')).text).not.toContain('alpha-own-key');
    // get_capabilities over MCP shows A's own view.
    const caps = JSON.parse((await mcp(keys.a, 'get_capabilities', {})).body);
    expect(caps.providers.find((p: { id: string }) => p.id === 'scoped-tts')).toMatchObject({ settingsFrom: 'workspace', configured: true });

    // Stored encrypted in A's rows only; A's audit log says "set", never the value.
    const repos = server.service.repos as WorkspaceRouter;
    const stored = await repos.forWorkspace(A).providerSettings.values();
    expect(stored.SCOPED_TTS_KEY!.scheme).toBe('aes-256-gcm');
    expect(stored.SCOPED_TTS_KEY!.value).not.toContain('alpha-own-key');
    expect(await repos.forWorkspace(B).providerSettings.values()).toEqual({});
    const audit = await rest(keys.a, 'GET', '/v1/audit?action=provider.configure');
    expect(audit.text).toContain('"SCOPED_TTS_KEY":"set"');
    expect(audit.text).not.toContain('alpha-own-key');
  });

  it("WSP-03 the owner sets another workspace's key with configure_provider { workspaceId }; a write key and the default workspace cannot", async () => {
    const r = await mcp(keys.owner, 'configure_provider', { providerId: 'scoped-tts', values: { SCOPED_TTS_KEY: 'beta-own-key' }, workspaceId: B });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.body)).toMatchObject({ settingsFrom: 'workspace', configured: true });
    expect(r.text).not.toContain('beta-own-key');
    expect((await run(keys.b, 'scoped-tts')).status).toBe(201);
    expect(lastKey()).toBe('beta-own-key');
    expect((await run(keys.a, 'scoped-tts')).status).toBe(201);
    expect(lastKey()).toBe('alpha-own-key');

    expect((await rest(keys.aWrite, 'PUT', '/v1/providers/scoped-tts/workspace-config', { values: { SCOPED_TTS_KEY: 'x' } })).status).toBe(403);
    const def = await rest(keys.defaultAdmin, 'PUT', '/v1/providers/scoped-tts/workspace-config', { values: { SCOPED_TTS_KEY: 'x' } });
    expect(def.status).toBe(403);
    expect(def.json.error.message).toContain('configure_provider');
    // A workspace admin cannot reach the instance's settings or another workspace's.
    expect((await rest(keys.a, 'PUT', '/v1/providers/scoped-tts/config', { values: { SCOPED_TTS_KEY: 'x' }, workspaceId: B })).status).toBe(403);
    expect((await rest(keys.owner, 'PUT', '/v1/providers/scoped-tts/config', { values: { SCOPED_TTS_KEY: 'x' }, workspaceId: 'no-such-workspace' })).status).toBe(404);
    expect((await rest(keys.owner, 'PUT', '/v1/providers/scoped-tts/config', { values: { OTHER: 'x' }, workspaceId: B })).status).toBe(400);
  });

  it('WSP-04 with shareWithWorkspaces off, a workspace without its own key cannot use the instance account; clearing falls back only when shared', async () => {
    expect((await rest(keys.owner, 'PATCH', '/v1/config', { 'providers.shareWithWorkspaces': [] })).status).toBe(200);
    // A clears its own key: nothing to fall back to.
    expect((await rest(keys.a, 'PUT', '/v1/providers/scoped-tts/workspace-config', { values: { SCOPED_TTS_KEY: null } })).json).toMatchObject({ configured: false, settingsFrom: 'none' });
    const before = calls.length;
    const refused = await run(keys.a, 'scoped-tts');
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toContain('configure_workspace_provider');
    expect(calls.length).toBe(before);
    // B keeps its own; the default workspace keeps the instance's.
    expect((await run(keys.b, 'scoped-tts')).status).toBe(201);
    expect(lastKey()).toBe('beta-own-key');
    expect((await run(keys.defaultAdmin, 'scoped-tts')).status).toBe(201);
    expect(lastKey()).toBe('instance-scoped-key');
    // Sharing one provider by id brings A back onto the instance account.
    expect((await rest(keys.owner, 'PATCH', '/v1/config', { 'providers.shareWithWorkspaces': ['scoped-tts'] })).status).toBe(200);
    expect((await run(keys.a, 'scoped-tts')).status).toBe(201);
    expect(lastKey()).toBe('instance-scoped-key');
  });

  it('WSP-05 a provider without scopedSettings takes no workspace key, and is off for workspaces that may not share', async () => {
    const r = await rest(keys.a, 'PUT', '/v1/providers/legacy-tts/workspace-config', { values: { LEGACY_TTS_KEY: 'alpha-legacy' } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('provider_not_per_workspace');
    // shareWithWorkspaces is ["scoped-tts"]: the legacy provider is not shared.
    expect(await providerOf(keys.a, 'legacy-tts')).toMatchObject({ configured: false, settingsFrom: 'none' });
    const before = calls.length;
    expect((await run(keys.a, 'legacy-tts')).status).toBe(409);
    expect(calls.length).toBe(before);
    expect((await run(keys.defaultAdmin, 'legacy-tts')).status).toBe(201);
    expect(lastKey()).toBe('instance-legacy-key');
    // Back to the default: nothing shared.
    expect((await rest(keys.owner, 'PATCH', '/v1/config', { 'providers.shareWithWorkspaces': null })).status).toBe(200);
    expect(await providerOf(keys.b, 'legacy-tts')).toMatchObject({ configured: false, settingsFrom: 'none' });
  });
});
