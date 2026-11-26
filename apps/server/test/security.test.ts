/**
 * Security hardening of the HTTP surface (private security review SEC-06, SEC-08,
 * SEC-09; D-088). Test ids SECT-2x; the list is in docs/security/HARDENING.md.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, ReelforgeService, chromiumSandbox, createMemoryRepositories } from '@renderweld/core';
import { Redactor, createApp, loadConfig, originAllowed } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

const { dir, cleanup } = tempDir('reelforge-security-');
afterAll(cleanup);

let service: ReelforgeService;
let admin: string;
let agent: string;
const apps: Record<string, ReturnType<typeof createApp>> = {};

beforeAll(async () => {
  const registry = new PluginRegistry().registerEngine({ ...fakeEngine('remotion'), browserSandbox: () => false }).registerEngine({ ...fakeEngine('html'), browserSandbox: () => chromiumSandbox() });
  const base = loadConfig({ REELFORGE_DATA_DIR: join(dir, 'data'), REELFORGE_PUBLIC_URL: 'https://studio.example.com' });
  service = await ReelforgeService.create(registry, {
    repositories: createMemoryRepositories(),
    dataDir: base.dataDir,
    configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } },
  });
  admin = (await service.keys.create('admin', ['admin', 'owner'])).key;
  agent = (await service.keys.create('agent', ['read', 'write', 'render'])).key;
  apps.default = createApp({ service, config: base });
  apps.anonymous = createApp({ service, config: loadConfig({ REELFORGE_DATA_DIR: join(dir, 'data'), REELFORGE_METRICS_ALLOW_ANONYMOUS: 'true' }) });
  apps.token = createApp({ service, config: loadConfig({ REELFORGE_DATA_DIR: join(dir, 'data'), REELFORGE_METRICS_TOKEN: 'metrics-token-sect-0123456789' }) });
  apps.local = createApp({ service, config: loadConfig({ REELFORGE_DATA_DIR: join(dir, 'data') }) });
});
afterAll(() => service?.jobs.flush());

const req = (app: string, path: string, opts: { key?: string; headers?: Record<string, string>; method?: string; body?: string } = {}) =>
  apps[app]!.request(path, {
    method: opts.method ?? 'GET',
    headers: { host: 'localhost', ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...(opts.headers ?? {}) },
    body: opts.body,
  });

describe('security: /metrics needs a token by default (SEC-06)', () => {
  it('SECT-20 no token configured: 401 with what to set; allowAnonymous opens it; a configured token is required', async () => {
    const def = await req('default', '/metrics');
    expect(def.status).toBe(401);
    expect(def.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect(((await def.json()) as any).error.message).toMatch(/observability\.metrics\.bearerToken.*observability\.metrics\.allowAnonymous/s);
    expect((await req('default', '/metrics', { key: admin })).status).toBe(401); // an API key is not the metrics token
    expect((await req('anonymous', '/metrics')).status).toBe(200);
    expect((await req('token', '/metrics')).status).toBe(401);
    expect((await req('token', '/metrics', { key: 'metrics-token-sect-0123456789' })).status).toBe(200);
  });
});

describe('security: /readyz detail only for admins (SEC-06)', () => {
  it('SECT-21 anonymous and non-admin callers get status per dependency only: no paths, versions, free space or error text', async () => {
    for (const key of [undefined, agent, 'rf_not_a_real_key_0000000000000000000000']) {
      const r = await req('default', '/readyz', { key });
      expect(r.status).toBe(200);
      const body = (await r.json()) as any;
      expect(Object.keys(body).sort()).toEqual(['checks', 'dependencies', 'engines', 'ok']);
      for (const d of Object.values(body.dependencies) as any[]) expect(Object.keys(d).sort()).toEqual(['required', 'status']);
      for (const v of Object.values(body.checks)) expect(['ok', 'error']).toContain(v);
      for (const e of body.engines) expect(Object.keys(e).sort()).toEqual(['id', 'ok']);
      const text = JSON.stringify(body);
      expect(text).not.toContain(dir);
      expect(text).not.toMatch(/version|freeBytes|path|latencyMs|Chrome|ffmpeg version/);
    }
  });

  it('SECT-22 an admin key gets the full report, including the Chromium sandbox per engine and warnings', async () => {
    const full = (await (await req('default', '/readyz', { key: admin })).json()) as any;
    expect(full.dependencies.storage.path).toBe(service.dataDir);
    expect(full.dependencies.ffmpeg.version).toMatch(/ffmpeg version/);
    expect(full.security.chromiumSandbox).toMatchObject({ remotion: false });
    expect(full.security.warnings.join('\n')).toMatch(/Remotion always starts Chromium without its sandbox/);
    const saved = process.env.REELFORGE_CHROMIUM_NO_SANDBOX;
    process.env.REELFORGE_CHROMIUM_NO_SANDBOX = '1';
    try {
      const off = (await (await req('default', '/readyz', { key: admin })).json()) as any;
      expect(off.security.warnings.join('\n')).toMatch(/REELFORGE_CHROMIUM_NO_SANDBOX=1.*explicit opt-out/);
      expect(service.capabilities().security.warning).toMatch(/explicit opt-out/);
    } finally {
      if (saved === undefined) delete process.env.REELFORGE_CHROMIUM_NO_SANDBOX;
      else process.env.REELFORGE_CHROMIUM_NO_SANDBOX = saved;
    }
  });
});

describe('security: /mcp Origin compares scheme, host and port (SEC-09)', () => {
  it('SECT-23 originAllowed: the public URL origin, or the Host the request was sent to; other ports and schemes are refused', () => {
    const cfg = { allowedHosts: ['localhost', '127.0.0.1', 'studio.example.com'], publicUrl: 'https://studio.example.com' };
    expect(originAllowed('https://studio.example.com', 'studio.example.com', cfg)).toBe(true);
    expect(originAllowed('http://studio.example.com', 'internal:4321', cfg)).toBe(false);
    expect(originAllowed('https://studio.example.com:8443', 'internal:4321', cfg)).toBe(false);
    expect(originAllowed('http://localhost:4321', 'localhost:4321', cfg)).toBe(true);
    expect(originAllowed('http://localhost:1234', 'localhost:4321', cfg)).toBe(false);
    expect(originAllowed('http://evil.example:4321', 'localhost:4321', cfg)).toBe(false);
    expect(originAllowed('null', 'localhost:4321', cfg)).toBe(false);
    expect(originAllowed('file://', 'localhost:4321', cfg)).toBe(false);
  });

  it('SECT-24 over HTTP: Origin on another port is 403, the same origin reaches authentication', async () => {
    const mcp = (origin: string) =>
      req('local', '/mcp', {
        method: 'POST',
        key: agent,
        headers: { host: 'localhost:4321', origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    const other = await mcp('http://localhost:1234');
    expect(other.status).toBe(403);
    expect(((await other.json()) as any).error.code).toBe('forbidden_origin');
    expect((await mcp('http://localhost:4321')).status).not.toBe(403);
  });
});

describe('security: log redaction of presigned URLs (SEC-08)', () => {
  it('SECT-25 S3, GCS and Azure SAS signature parameters are redacted', () => {
    const r = new Redactor();
    const line = r.text(
      'GET https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4&X-Amz-Credential=AKIAEXAMPLE%2F20261121&X-Amz-Security-Token=TOKENVALUE&X-Amz-Signature=deadbeef01 ' +
        'https://storage.googleapis.com/b/o?X-Goog-Credential=svc%40p&X-Goog-Signature=cafebabe02 ' +
        'https://a.blob.core.windows.net/c/x?sv=2024-01-01&se=2026-12-01&sp=r&sig=SASSIGNATURE03'
    );
    for (const secret of ['AKIAEXAMPLE', 'TOKENVALUE', 'deadbeef01', 'cafebabe02', 'SASSIGNATURE03', '2026-12-01']) expect(line).not.toContain(secret);
    expect(line).toContain('X-Amz-Algorithm=AWS4'); // not a secret
  });
});
