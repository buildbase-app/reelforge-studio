import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ElevenLabsTts, PluginRegistry, RemotionLambdaBackend } from '@reelforge/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * The configuration system end to end on a real HTTP server (#24, D-029/D-031):
 * sources and precedence, GET/PATCH /v1/config, get_config/update_config over
 * MCP, live effect of runtime settings, refusals, audit log, secrets, restart.
 */
const { dir, cleanup } = tempDir('reelforge-config-srv-');
const SECRET_KEY = 'server-test-secret-key-0123456789abcdef';
const ELEVEN = 'sk_config_test_value_987';
const configFile = join(dir, 'reelforge.yaml');
const dataDir = join(dir, 'data');
let env: NodeJS.ProcessEnv;
let server: StartedServer;
let admin: string;
let reader: string;
let dropDb: () => Promise<void> = async () => undefined;

const registry = (providerEnv: NodeJS.ProcessEnv) =>
  new PluginRegistry().registerEngine(fakeEngine('remotion')).registerProvider(new ElevenLabsTts(providerEnv)).registerBackend(new RemotionLambdaBackend(providerEnv));
const start = () => startServer({ port: 0, host: '127.0.0.1' }, { registry, env, quiet: true });

beforeAll(async () => {
  writeFileSync(configFile, `# test config\nstorage:\n  dataDir: ${dataDir}\nlimits:\n  maxJsonBytes: 65536\n  rateLimitPerMinute: 1000\nlogging:\n  level: warn\n`);
  const database = await testDatabase(dir);
  dropDb = database.drop;
  env = { ...database.env, REELFORGE_CONFIG: configFile, REELFORGE_RATE_LIMIT_PER_MINUTE: '500', REELFORGE_SECRET_KEY: SECRET_KEY, REELFORGE_LICENCE_MODE: 'off' };
  server = await start();
  admin = (await server.service.keys.create('admin', ['admin'])).key;
  reader = (await server.service.keys.create('reader', ['read'])).key;
});
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

async function rest(method: string, path: string, body?: unknown, key = admin, headers: Record<string, string> = {}) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}
const setting = (r: { json: any }, key: string) => r.json.settings.find((s: any) => s.key === key);

async function mcp(key = admin) {
  const client = new Client({ name: 'config-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}
const toolJson = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);

describe('configuration over REST', () => {
  it('GET /v1/config shows every setting with its effective value and source (admin only)', async () => {
    expect((await rest('GET', '/v1/config', undefined, reader)).status).toBe(403);
    const r = await rest('GET', '/v1/config');
    expect(r.status).toBe(200);
    expect(r.json.configFile).toBe(resolve(configFile));
    expect(r.json.secretKey).toBe('set');
    expect(setting(r, 'limits.maxJsonBytes')).toMatchObject({ value: 65536, source: 'file', origin: resolve(configFile), scope: 'runtime' });
    expect(setting(r, 'limits.rateLimitPerMinute')).toMatchObject({ value: 500, source: 'env', origin: 'REELFORGE_RATE_LIMIT_PER_MINUTE' });
    expect(setting(r, 'storage.dataDir')).toMatchObject({ value: dataDir, source: 'file', scope: 'startup' });
    expect(setting(r, 'server.port')).toMatchObject({ value: 4321, source: 'default', scope: 'startup', env: 'REELFORGE_PORT' });
    expect(setting(r, 'security.secretKey')).toMatchObject({ value: 'set', secret: true });
    expect(setting(r, 'database.url').value).toBe('set');
    expect(r.text).not.toContain(SECRET_KEY);
    expect(r.text).not.toContain('reelforge.db');
    const limits = await rest('GET', '/v1/config?prefix=limits');
    expect(limits.json.settings.map((s: any) => s.key)).toEqual(['limits.rateLimitPerMinute', 'limits.maxUploadBytes', 'limits.maxJsonBytes', 'limits.renderConcurrency']);
  });

  it('PATCH /v1/config changes a runtime setting at once: the rate limit', async () => {
    const limited = (await server.service.keys.create('limited', ['read'])).key;
    expect((await rest('PATCH', '/v1/config', { settings: { 'limits.rateLimitPerMinute': 3 } }, reader)).status).toBe(403);
    const r = await rest('PATCH', '/v1/config', { settings: { 'limits.rateLimitPerMinute': 3 } });
    expect(r.status).toBe(200);
    expect(r.json.changes).toEqual([{ key: 'limits.rateLimitPerMinute', from: 500, to: 3 }]);
    expect(r.json.settings[0]).toMatchObject({ key: 'limits.rateLimitPerMinute', value: 3, source: 'runtime', origin: 'database' });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await rest('GET', '/v1/capabilities', undefined, limited)).status);
    expect(codes).toEqual([200, 200, 200, 429]);
    // Clearing the runtime value falls back to the environment variable.
    const cleared = await rest('PATCH', '/v1/config', { limits: { rateLimitPerMinute: null } });
    expect(cleared.json.settings[0]).toMatchObject({ value: 500, source: 'env' });
    const audit = await server.service.repos.audit.list({ limit: 2 });
    expect(audit.map((a) => a.action)).toEqual(['config.update', 'config.update']);
    expect(audit[1]).toMatchObject({ actorType: 'api_key', targetType: 'config', data: { changes: [{ key: 'limits.rateLimitPerMinute', from: 500, to: 3 }] } });
  });

  it('applies the JSON body limit and allowed hosts at runtime', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(5000) });
    expect((await rest('POST', '/v1/keys', big)).status).not.toBe(413);
    await rest('PATCH', '/v1/config', { settings: { 'limits.maxJsonBytes': 4096 } });
    expect((await rest('POST', '/v1/keys', big)).status).toBe(413);
    await rest('PATCH', '/v1/config', { settings: { 'limits.maxJsonBytes': null } });

    // fetch() does not let a caller set Host; node:http does.
    const viaHost = () =>
      new Promise<number>((ok, fail) => {
        const u = new URL(`${server.url}/mcp`);
        const req = request(
          { host: u.hostname, port: u.port, path: '/mcp', method: 'POST', headers: { host: 'studio.internal:4321', authorization: `Bearer ${admin}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
          (res) => {
            res.resume();
            res.on('end', () => ok(res.statusCode!));
          }
        );
        req.on('error', fail);
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
      });
    expect(await viaHost()).toBe(403);
    const r = await rest('PATCH', '/v1/config', { settings: { 'server.allowedHosts': ['Studio.Internal'] } });
    expect(r.json.settings[0].value).toEqual(['studio.internal']);
    expect(await viaHost()).toBe(200);
    await rest('PATCH', '/v1/config', { settings: { 'server.allowedHosts': null } });
    expect(await viaHost()).toBe(403);
  });

  it('refuses start-up-only keys, unknown keys and invalid values, naming where to set them; nothing changes', async () => {
    const port = await rest('PATCH', '/v1/config', { settings: { 'server.port': 9000, 'limits.renderConcurrency': 2 } });
    expect(port.status).toBe(409);
    expect(port.json.error.code).toBe('startup_only_setting');
    expect(port.json.error.message).toMatch(/server\.port.*start-up only.*REELFORGE_CONFIG.*REELFORGE_PORT.*restart/);
    expect(server.service.jobs.concurrency).toBe(1);
    const bad = await rest('PATCH', '/v1/config', { settings: { 'limits.renderConcurrency': 'many', 'no.such': 1 } });
    expect(bad.status).toBe(422);
    expect(bad.json.error.details.issues.map((i: any) => i.code)).toEqual(['invalid_value', 'unknown_setting']);
    expect((await rest('PATCH', '/v1/config', {})).status).toBe(400);
  });

  it('stores provider keys encrypted and never returns them', async () => {
    const r = await rest('PATCH', '/v1/config', { settings: { 'providers.elevenlabs.apiKey': ELEVEN } });
    expect(r.status).toBe(200);
    expect(r.json.changes).toEqual([{ key: 'providers.elevenlabs.apiKey', from: 'not set', to: 'set' }]);
    for (const path of ['/v1/config', '/v1/providers', '/v1/capabilities']) expect((await rest('GET', path)).text).not.toContain(ELEVEN);
    expect(r.text).not.toContain(ELEVEN);
    expect((await rest('GET', '/v1/providers')).json.providers[0]).toMatchObject({ configured: true, settings: [{ source: 'api', set: true }] });
    const row = (await server.service.repos.providerSettings.values()).ELEVENLABS_API_KEY!;
    expect(row.scheme).toBe('aes-256-gcm');
    expect(row.value).not.toContain(ELEVEN);
    expect(JSON.stringify(await server.service.repos.audit.list({ limit: 20 }))).not.toContain(ELEVEN);
  });
});

describe('configuration over MCP', () => {
  it('get_config and update_config work like REST, with the same refusals', async () => {
    const client = await mcp();
    const all = toolJson(await client.callTool({ name: 'get_config', arguments: { prefix: 'logging' } }));
    expect(all.settings.map((s: any) => [s.key, s.value, s.source])).toEqual([
      ['logging.level', 'warn', 'file'],
      ['logging.format', 'json', 'default'],
    ]);
    const changed = toolJson(await client.callTool({ name: 'update_config', arguments: { settings: { 'logging.level': 'error', 'limits.renderConcurrency': 2 } } }));
    expect(changed.settings.map((s: any) => [s.key, s.value, s.source])).toEqual([
      ['logging.level', 'error', 'runtime'],
      ['limits.renderConcurrency', 2, 'runtime'],
    ]);
    expect(server.config.logLevel).toBe('error');
    expect(server.service.jobs.concurrency).toBe(2);
    const refused = await client.callTool({ name: 'update_config', arguments: { settings: { 'database.url': 'postgresql://x/y' } } });
    expect(refused.isError).toBe(true);
    const err = toolJson(refused).error;
    expect(err.code).toBe('startup_only_setting');
    expect(err.message).toMatch(/REELFORGE_DATABASE_URL.*_FILE/);
    expect(JSON.stringify(err)).not.toContain('postgresql://x/y');
    await client.close();
    const ro = await mcp(reader);
    const denied = await ro.callTool({ name: 'get_config', arguments: {} });
    expect(denied.isError).toBe(true);
    expect(toolJson(denied).error.code).toBe('forbidden');
    await ro.close();
  });
});

describe('restart', () => {
  it('keeps runtime settings and encrypted secrets across a restart', async () => {
    await rest('PATCH', '/v1/config', { settings: { 'limits.rateLimitPerMinute': 77 } });
    await server.close();
    server = await start();
    const r = await rest('GET', '/v1/config');
    expect(setting(r, 'limits.rateLimitPerMinute')).toMatchObject({ value: 77, source: 'runtime' });
    expect(setting(r, 'limits.renderConcurrency')).toMatchObject({ value: 2, source: 'runtime' });
    expect(setting(r, 'providers.elevenlabs.apiKey')).toMatchObject({ value: 'set', source: 'runtime', atRest: 'aes-256-gcm' });
    expect(server.config.rateLimitPerMinute).toBe(77);
    expect(server.service.jobs.concurrency).toBe(2);
    expect(server.service.providerEnv.ELEVENLABS_API_KEY).toBe(ELEVEN);
    expect((await rest('GET', '/v1/providers')).json.providers[0].configured).toBe(true);
  });
});

describe('reelforge config (CLI)', () => {
  const repo = resolve(__dirname, '../../..');
  const cli = (args: string[], extra: NodeJS.ProcessEnv) =>
    spawnSync(join(repo, 'node_modules/.bin/tsx'), ['apps/server/src/cli.ts', 'config', ...args], { cwd: repo, env: { PATH: process.env.PATH, ...extra }, encoding: 'utf8', timeout: 60_000 });

  it('config check validates the file and environment without a server', () => {
    const ok = cli(['check'], env);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/configuration is valid \(config file .*reelforge\.yaml\)/);
    const bad = cli(['check'], { ...env, REELFORGE_PORT: 'eighty', REELFORGE_SECRET_KEY: 'short-SECRET' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/REELFORGE_PORT: must be an integer \(got "eighty"\)/);
    expect(bad.stderr).toMatch(/REELFORGE_SECRET_KEY: must be at least 32 characters/);
    expect(bad.stderr).not.toContain('short-SECRET');
    const typo = join(dir, 'typo.yaml');
    writeFileSync(typo, 'limits:\n  rateLimit: 5\n');
    const t = cli(['check', '--file', typo], {});
    expect(t.status).toBe(1);
    expect(t.stderr).toMatch(/Unrecognized key.*limits\.rateLimit/);
  }, 60_000); // three CLI processes (tsx start-up); 5 s was not enough on a loaded machine

  it('config show prints the effective configuration with runtime values, secrets redacted', () => {
    const r = cli(['show', '--json'], env);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.settings.find((s: any) => s.key === 'limits.rateLimitPerMinute')).toMatchObject({ value: 77, source: 'runtime' });
    expect(r.stdout).not.toContain(ELEVEN);
    expect(r.stdout).not.toContain(SECRET_KEY);
    const text = cli(['show', '--offline'], env);
    expect(text.status).toBe(0);
    expect(text.stdout).toMatch(/limits\.rateLimitPerMinute\s+500\s+\(env: REELFORGE_RATE_LIMIT_PER_MINUTE\)/);
    expect(text.stdout).toMatch(/server\.port\s+4321\s+\(default, start-up only\)/);
  }, 60_000);
});
