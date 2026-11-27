/**
 * MCP authorization (#305, D-112): /mcp as an OAuth 2.1 resource server next
 * to API keys, against a local mock authorization server (RFC 8414 metadata
 * and a JWKS served by an injected fetch; tokens signed here). Test ids
 * OAUTH-nn (docs/security/HARDENING.md).
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, RenderWeldService, createMemoryRepositories, createMemoryWorkspaceRepositories, runInWorkspace, type Repositories } from '@renderweld/core';
import { createApp, loadConfig } from '../src/index';
import { OAuthVerifier, looksLikeJwt, resourceMetadataUrl, scopesFromClaims } from '../src/oauth';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

const { dir, cleanup } = tempDir('reelforge-mcp-oauth-');
afterAll(cleanup);

const ISSUER = 'https://auth.example.test/realms/studio';
const AUDIENCE = 'https://studio.example.com/mcp';

/** A mock authorization server: metadata at the RFC 8414 location, a JWKS it can rotate, and fetch counts. */
class MockIssuer {
  readonly rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
  published: Array<{ kid: string; key: KeyObject; alg: string }> = [
    { kid: 'rsa-1', key: this.rsa.publicKey, alg: 'RS256' },
    { kid: 'ec-1', key: this.ec.publicKey, alg: 'ES256' },
  ];
  fetches: string[] = [];
  fetch = (async (url: string) => {
    this.fetches.push(String(url));
    if (url === 'https://auth.example.test/.well-known/oauth-authorization-server/realms/studio') {
      return Response.json({ issuer: ISSUER, jwks_uri: 'https://auth.example.test/realms/studio/jwks', token_endpoint: 'https://auth.example.test/token' });
    }
    if (url === 'https://auth.example.test/realms/studio/jwks') {
      return Response.json({ keys: this.published.map((p) => ({ ...p.key.export({ format: 'jwk' }), kid: p.kid, alg: p.alg, use: 'sig' })) });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  token(claims: Record<string, unknown>, o: { kid?: string; alg?: string; key?: KeyObject } = {}): string {
    const alg = o.alg ?? 'RS256';
    const now = Math.floor(Date.now() / 1000);
    const header = { alg, typ: 'at+jwt', kid: o.kid ?? (alg === 'ES256' ? 'ec-1' : 'rsa-1') };
    const body = { iss: ISSUER, aud: AUDIENCE, sub: 'user-42', client_id: 'claude-desktop', iat: now, exp: now + 300, scope: 'renderweld:read', ...claims };
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const input = `${enc(header)}.${enc(body)}`;
    const key = o.key ?? (alg === 'ES256' ? this.ec.privateKey : this.rsa.privateKey);
    const sig = alg === 'none' ? '' : sign(alg === 'ES256' ? 'sha256' : 'sha256', Buffer.from(input), alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key);
    return `${input}.${Buffer.from(sig).toString('base64url')}`;
  }
}

const rpc = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

async function setup(env: Record<string, string>, issuer?: MockIssuer, repositories: Repositories = createMemoryRepositories()) {
  const config = loadConfig({
    RENDERWELD_DATA_DIR: join(dir, `d${Math.random().toString(36).slice(2)}`),
    RENDERWELD_PUBLIC_URL: 'https://studio.example.com',
    RENDERWELD_SECRET_KEY: 'mcp-oauth-secret-key-0123456789abcdef',
    RENDERWELD_LICENCE_MODE: 'off',
    ...env,
  });
  const service = await RenderWeldService.create(new PluginRegistry().registerEngine(fakeEngine('remotion')), {
    repositories,
    dataDir: config.dataDir,
    publicUrl: config.publicUrl,
    configSources: config.sources,
  });
  const key = (await service.keys.create('agent', ['read'])).key;
  const app = createApp({ service, config, ...(issuer ? { fetch: issuer.fetch } : {}) });
  const mcp = (token: string | null, method = 'tools/list', params: Record<string, unknown> = {}) =>
    app.request('/mcp', {
      method: 'POST',
      headers: { host: 'studio.example.com', accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: rpc(method, params),
    });
  return { app, mcp, key, service };
}

describe('MCP OAuth 2.1 resource server', () => {
  const issuer = new MockIssuer();
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup({ RENDERWELD_MCP_OAUTH_ISSUER: ISSUER }, issuer);
  });

  it('OAUTH-01 protected-resource metadata (RFC 9728) names the issuer, the resource and the scopes', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await s.app.request(path, { headers: { host: 'studio.example.com' } });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({
        resource: AUDIENCE,
        authorization_servers: [ISSUER],
        // Only the RenderWeld scope names; the old reelforge:* names are gone (D-140).
        scopes_supported: ['renderweld:read', 'renderweld:write', 'renderweld:render', 'renderweld:approve', 'renderweld:admin', 'renderweld:owner'],
        resource_name: 'RenderWeld MCP',
        bearer_methods_supported: ['header'],
      });
    }
    expect(resourceMetadataUrl(AUDIENCE)).toBe('https://studio.example.com/.well-known/oauth-protected-resource/mcp');
  });

  it('OAUTH-02 a 401 on /mcp points the client at the metadata; REST 401s do not', async () => {
    const r = await s.mcp(null);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata="https://studio.example.com/.well-known/oauth-protected-resource/mcp"');
    const rest = await s.app.request('/v1/capabilities', { headers: { host: 'studio.example.com' } });
    expect(rest.status).toBe(401);
    expect(rest.headers.get('www-authenticate')).not.toContain('resource_metadata');
  });

  it('OAUTH-03 a valid access token (RS256 or ES256) works on /mcp, scoped by its claims; API keys keep working', async () => {
    const r = await s.mcp(issuer.token({}));
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).toContain('list_projects');
    expect((await s.mcp(issuer.token({}, { alg: 'ES256' }))).status).toBe(200);
    expect((await s.mcp(s.key)).status).toBe(200);
    // The RenderWeld scope name works like the old one (#413).
    expect((await s.mcp(issuer.token({ scope: 'renderweld:read' }))).status).toBe(200);
    // Metadata and keys were fetched once and cached.
    expect(issuer.fetches.filter((u) => u.endsWith('/jwks'))).toHaveLength(1);
    // A read token may not call a write tool (the MCP layer refuses it by scope, like a read key).
    const write = await s.mcp(issuer.token({}), 'tools/call', { name: 'create_project', arguments: { manifest: {} } });
    expect(JSON.stringify(await write.json())).toMatch(/scope|forbidden/i);
  });

  it('OAUTH-04 refused tokens: wrong audience, wrong issuer, expired, bad signature, alg none / HS256, no RenderWeld scope', async () => {
    const cases: Array<[string, string, number, RegExp]> = [
      ['audience', issuer.token({ aud: 'https://other.example.com/mcp' }), 401, /not for this server/],
      ['issuer', issuer.token({ iss: 'https://evil.example.test' }), 401, /wrong issuer/],
      ['expired', issuer.token({ exp: Math.floor(Date.now() / 1000) - 120 }), 401, /expired/],
      ['signature', issuer.token({}, { key: issuer.stranger.privateKey }), 401, /bad signature/],
      ['none', issuer.token({}, { alg: 'none' }), 401, /not accepted/],
      ['HS256', issuer.token({}, { alg: 'HS256' }).replace(/\.[^.]*$/, '.c2ln'), 401, /not accepted/],
      ['scope', issuer.token({ scope: 'openid profile' }), 403, /none of renderweld:read, renderweld:write, renderweld:render, renderweld:approve, renderweld:admin, renderweld:owner$/],
    ];
    for (const [name, token, status, message] of cases) {
      const r = await s.mcp(token);
      expect(r.status, name).toBe(status);
      const err = r.headers.get('www-authenticate') ?? '';
      expect(err, name).toContain(status === 403 ? 'error="insufficient_scope"' : 'error="invalid_token"');
      expect(((await r.json()) as { error: { message: string } }).error.message, name).toMatch(message);
    }
  });

  it('OAUTH-05 key rotation: an unknown kid refetches the JWKS at most every 30 s, then verifies', async () => {
    const own = new MockIssuer();
    const clock = { t: Date.now() };
    const v = new OAuthVerifier({ issuer: ISSUER, audience: AUDIENCE }, own.fetch, () => clock.t);
    expect((await v.verify(own.token({}))).ok).toBe(true);
    const jwks = () => own.fetches.filter((u) => u.endsWith('/jwks')).length;
    expect(jwks()).toBe(1);
    own.published.push({ kid: 'rsa-2', key: own.rotated.publicKey, alg: 'RS256' });
    const fresh = own.token({}, { kid: 'rsa-2', key: own.rotated.privateKey });
    // Within 30 s of the last fetch: refused without a refetch (bad tokens cannot flood the issuer).
    clock.t += 10_000;
    expect(await v.verify(fresh)).toMatchObject({ ok: false, error: 'invalid_token' });
    expect(jwks()).toBe(1);
    clock.t += 25_000;
    expect(await v.verify(fresh)).toMatchObject({ ok: true, subject: 'user-42', auth: { keyId: 'oauth:user-42', scopes: ['read'] } });
    expect(jwks()).toBe(2);
  });

  it('OAUTH-09 workspaces (#304): a token acts in the default workspace, never in another, and is never an owner', async () => {
    const repos = createMemoryWorkspaceRepositories();
    const w = await setup({ RENDERWELD_MCP_OAUTH_ISSUER: ISSUER }, issuer, repos);
    await repos.workspaces.create({ id: 'alpha', name: 'alpha', status: 'active', createdAt: new Date().toISOString() });
    repos.invalidateWorkspaces();
    const reel = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
    // This server has the Remotion engine only.
    const sample = { ...reel, projectId: 'alpha-only-oauth', scenes: reel.scenes.filter((x: { engine: string }) => x.engine === 'remotion') };
    await runInWorkspace('alpha', () => w.service.createProject(sample));
    const admin = issuer.token({ scope: 'renderweld:read renderweld:write renderweld:admin' });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await w.mcp(admin, 'tools/call', { name, arguments: args });
      expect(r.status, name).toBe(200);
      const body = (await r.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      return { isError: body.result.isError, text: body.result.content[0]!.text };
    };
    const list = await call('list_projects');
    expect(list.isError).toBeFalsy();
    expect(list.text).not.toContain('alpha-only-oauth');
    for (const name of ['get_project', 'list_renders', 'delete_project']) {
      const r = await call(name, { projectId: 'alpha-only-oauth' });
      expect(r.isError, name).toBe(true);
      expect(JSON.parse(r.text).error.code, name).toBe('not_found');
    }
    // renderweld:admin is a workspace admin: instance settings need the owner scope (renderweld:owner, OAUTH-10).
    const cfg = await call('get_config');
    expect(JSON.parse(cfg.text).error.code).toBe('forbidden');
    // What the token writes lands in the default workspace.
    expect((await call('create_project', { manifest: { ...sample, projectId: 'oauth-made' } })).isError).toBeFalsy();
    expect(await repos.forWorkspace('default').projects.get('oauth-made')).not.toBeNull();
    expect(await repos.forWorkspace('alpha').projects.get('oauth-made')).toBeNull();
    expect(await repos.forWorkspace('alpha').projects.get('alpha-only-oauth')).not.toBeNull();
  });

  it('OAUTH-10 renderweld:owner makes a token the instance owner; renderweld:admin alone does not (#304)', async () => {
    const w = await setup({ RENDERWELD_MCP_OAUTH_ISSUER: ISSUER }, issuer, createMemoryWorkspaceRepositories());
    const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
      const r = await w.mcp(token, 'tools/call', { name, arguments: args });
      expect(r.status, name).toBe(200);
      const body = (await r.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      return { isError: body.result.isError, json: JSON.parse(body.result.content[0]!.text) };
    };
    const admin = issuer.token({ scope: 'renderweld:read renderweld:admin' });
    const owner = issuer.token({ scope: 'renderweld:owner' });
    for (const name of ['get_config', 'list_workspaces', 'get_storage']) {
      expect((await call(admin, name)).json.error?.code, name).toBe('forbidden');
      const r = await call(owner, name);
      expect(r.isError, name).toBeFalsy();
    }
    // An owner can change a runtime setting and read it back; the change is audited under the token's subject.
    const set = await call(owner, 'update_config', { settings: { 'limits.rateLimitPerMinute': 777 } });
    expect(set.isError).toBeFalsy();
    expect(JSON.stringify((await call(owner, 'get_config', { prefix: 'limits.rateLimitPerMinute' })).json)).toContain('777');
    // The metadata advertises it.
    const meta = (await (await w.app.request('/.well-known/oauth-protected-resource', { headers: { host: 'studio.example.com' } })).json()) as { scopes_supported: string[] };
    expect(meta.scopes_supported).toContain('renderweld:owner');
  });

  it('OAUTH-11 security.oauth.workspaceClaim (#479): a token acts in the workspace its claim names; no claim, an unknown or a deleted workspace is 401, a suspended one 403', async () => {
    const repos = createMemoryWorkspaceRepositories();
    const w = await setup({ RENDERWELD_MCP_OAUTH_ISSUER: ISSUER, RENDERWELD_MCP_OAUTH_WORKSPACE_CLAIM: 'renderweld_workspace' }, issuer, repos);
    for (const id of ['alpha', 'beta', 'paused', 'gone']) await repos.workspaces.create({ id, name: id, status: id === 'paused' ? 'suspended' : id === 'gone' ? 'deleted' : 'active', createdAt: new Date().toISOString() });
    repos.invalidateWorkspaces();
    const reel = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
    const sample = { ...reel, scenes: reel.scenes.filter((x: { engine: string }) => x.engine === 'remotion') };
    await runInWorkspace('alpha', () => w.service.createProject({ ...sample, projectId: 'alpha-reel' }));
    await runInWorkspace('beta', () => w.service.createProject({ ...sample, projectId: 'beta-reel' }));
    const scope = 'renderweld:read renderweld:write';
    const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
      const r = await w.mcp(token, 'tools/call', { name, arguments: args });
      expect(r.status, name).toBe(200);
      const body = (await r.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      return { isError: body.result.isError, text: body.result.content[0]!.text };
    };
    const alpha = issuer.token({ scope, renderweld_workspace: 'alpha' });
    const listed = await call(alpha, 'list_projects');
    expect(listed.text).toContain('alpha-reel');
    expect(listed.text).not.toContain('beta-reel');
    expect(JSON.parse((await call(alpha, 'get_project', { projectId: 'beta-reel' })).text).error.code).toBe('not_found');
    // Writes land in the token's workspace and nowhere else.
    expect((await call(alpha, 'create_project', { manifest: { ...sample, projectId: 'made-by-token' } })).isError).toBeFalsy();
    expect(await repos.forWorkspace('alpha').projects.get('made-by-token')).not.toBeNull();
    expect(await repos.forWorkspace('default').projects.get('made-by-token')).toBeNull();
    expect((await call(issuer.token({ scope, renderweld_workspace: 'beta' }), 'list_projects')).text).toContain('beta-reel');
    // Refusals, before any tool runs.
    const refused = async (claims: Record<string, unknown>, status: number, code: string, words: string) => {
      const r = await w.mcp(issuer.token({ scope, ...claims }));
      expect(r.status, words).toBe(status);
      const body = (await r.json()) as { error: { code: string; message: string } };
      expect(body.error.code, words).toBe(code);
      expect(body.error.message, words).toContain(words);
      if (status === 401) expect(r.headers.get('www-authenticate')).toContain('invalid_token');
    };
    await refused({}, 401, 'invalid_token', 'no "renderweld_workspace" claim');
    await refused({ renderweld_workspace: 42 }, 401, 'invalid_token', 'no "renderweld_workspace" claim');
    await refused({ renderweld_workspace: 'nope' }, 401, 'invalid_token', 'workspace "nope", which does not exist');
    await refused({ renderweld_workspace: 'gone' }, 401, 'invalid_token', 'workspace "gone", which does not exist');
    await refused({ renderweld_workspace: 'paused' }, 403, 'workspace_suspended', '(paused) is suspended');
    // API keys are unaffected by the claim setting.
    expect((await w.mcp(w.key)).status).toBe(200);
  });

  it('OAUTH-12 security.oauth.blockedSubjects (#479): a blocked subject is refused at once, others are not, and unblocking restores it', async () => {
    const w = await setup({ RENDERWELD_MCP_OAUTH_ISSUER: ISSUER }, issuer);
    const lost = issuer.token({ sub: 'lost-laptop', scope: 'renderweld:read' });
    const other = issuer.token({ sub: 'still-fine', scope: 'renderweld:read' });
    expect((await w.mcp(lost)).status).toBe(200);
    await w.service.updateConfig({ 'security.oauth.blockedSubjects': ['lost-laptop'] });
    const refused = await w.mcp(lost);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain('invalid_token');
    expect(((await refused.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'invalid_token', message: expect.stringContaining('subject is blocked') });
    expect((await w.mcp(other)).status).toBe(200);
    expect((await w.mcp(w.key)).status).toBe(200); // API keys are not subjects
    await w.service.updateConfig({ 'security.oauth.blockedSubjects': null });
    expect((await w.mcp(lost)).status).toBe(200);
    // A subject with a space or a comma cannot be listed (the environment form is comma-separated).
    await expect(w.service.updateConfig({ 'security.oauth.blockedSubjects': ['a b'] })).rejects.toThrow();
  });

  it('OAUTH-06 scopes come from `scope` or `scp`; only renderweld:* values count, the old reelforge:* ones grant nothing (D-140)', () => {
    expect(scopesFromClaims({ scope: 'openid renderweld:read renderweld:admin' })).toEqual(['read', 'admin']);
    expect(scopesFromClaims({ scp: ['renderweld:write', 'read'] })).toEqual(['write']);
    expect(scopesFromClaims({ scp: ['renderweld:admin', 'renderweld:admin', 'renderweld:write'] })).toEqual(['admin', 'write']);
    expect(scopesFromClaims({ scope: 'renderweld:owner' })).toEqual(['owner']);
    expect(scopesFromClaims({ scope: 'openid reelforge:read reelforge:admin' })).toEqual([]);
    expect(scopesFromClaims({ scp: ['reelforge:owner', 'renderweld:read'] })).toEqual(['read']);
    expect(scopesFromClaims({ scope: 'read write' })).toEqual([]);
    expect(looksLikeJwt('rf_abcdefghijklmnopqrstuvwxyz')).toBe(false);
  });
});

describe('without OAuth', () => {
  it('OAUTH-07 no metadata, no resource_metadata in challenges, a JWT is just an invalid key', async () => {
    const issuer = new MockIssuer();
    const s = await setup({}, issuer);
    expect((await s.app.request('/.well-known/oauth-protected-resource', { headers: { host: 'studio.example.com' } })).status).toBe(404);
    const r = await s.mcp(issuer.token({}));
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).not.toContain('resource_metadata');
    expect(issuer.fetches).toEqual([]);
  });

  it('OAUTH-08 an issuer without an audience or public URL is a configuration error', () => {
    expect(() => loadConfig({ RENDERWELD_MCP_OAUTH_ISSUER: ISSUER })).toThrow(/security\.oauth\.audience/);
  });
});
