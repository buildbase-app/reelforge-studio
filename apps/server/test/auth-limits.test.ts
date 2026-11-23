/**
 * Limits before and around authentication (#305): the per-address budget and
 * the failed-authentication lockout run before the API key lookup, so a flood
 * of bad keys costs no database work; every limited response carries the
 * RateLimit-* fields and a 429 body with `scope` and `hint`. Test ids AUTH-nn
 * (docs/security/HARDENING.md). Also: a release build does not start without
 * REELFORGE_SECRET_KEY.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_SEAL_FILE, PluginRegistry, ReelforgeService, createMemoryRepositories, parseBuildInfo, resolveConfig, type Repositories } from '@reelforge/core';
import { createApp, loadConfig, startServer } from '../src/index';
import { PreAuthGuard, limiterClient } from '../src/authGuard';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

const { dir, cleanup } = tempDir('reelforge-auth-limits-');
afterAll(cleanup);

/** Memory repositories whose key lookups (keys.findByPrefix) are counted. */
function countedRepos(): { repos: Repositories; lookups: () => number } {
  const base = createMemoryRepositories();
  let n = 0;
  const keys = new Proxy(base.keys, {
    get(t, prop, r) {
      const v = Reflect.get(t, prop, r);
      if (typeof v !== 'function') return v;
      // findByPrefix is the lookup authentication does for every presented key.
      return (...a: unknown[]) => (prop === 'findByPrefix' && n++, (v as (...x: unknown[]) => unknown).apply(t, a));
    },
  });
  return { repos: { ...base, keys }, lookups: () => n };
}

const guess = () => `rf_${randomBytes(24).toString('base64url')}`;

async function setup(env: Record<string, string>) {
  const { repos, lookups } = countedRepos();
  const all = { REELFORGE_DATA_DIR: join(dir, `d${Math.random().toString(36).slice(2)}`), REELFORGE_SECRET_KEY: 'auth-limits-secret-key-0123456789abcdef', REELFORGE_LICENCE_MODE: 'off', REELFORGE_TRUST_PROXY: 'true', ...env };
  const config = loadConfig(all);
  const service = await ReelforgeService.create(new PluginRegistry().registerEngine(fakeEngine('remotion')), {
    repositories: repos,
    dataDir: config.dataDir,
    configSources: config.sources,
  });
  const key = (await service.keys.create('agent', ['admin'])).key;
  const app = createApp({ service, config });
  const call = (ip: string, token: string | null, path = '/v1/capabilities') =>
    app.request(path, { headers: { host: 'localhost', 'x-forwarded-for': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { service, key, call, lookups, before: lookups() };
}

describe('pre-auth limits over REST', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup({ REELFORGE_AUTH_FAILURES_PER_MINUTE: '5', REELFORGE_AUTH_LOCKOUT_SECONDS: '60', REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '1000' });
  });

  it('AUTH-01 an invalid-key flood from one address is cut off after the failure budget, without further key lookups', async () => {
    const start = s.lookups();
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 50; i++) {
      last = await s.call('203.0.113.7', guess());
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5).every((x) => x === 429)).toBe(true);
    // 5 lookups for the 5 failures the budget allows; none for the 45 refused requests.
    expect(s.lookups() - start).toBe(5);
    const body = (await last!.json()) as { error: { code: string; details: { scope: string; hint: string; retryAfterSeconds: number } } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details.scope).toBe('auth_failures');
    expect(body.error.details.hint).toMatch(/Check the API key/);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(55);
    expect(last!.headers.get('ratelimit-limit')).toBe('5');
    expect(last!.headers.get('ratelimit-remaining')).toBe('0');
    expect(Number(last!.headers.get('ratelimit-reset'))).toBeGreaterThan(55);
    // While locked out even a valid key from that address waits (no lookup), and requests without a key too.
    expect((await s.call('203.0.113.7', s.key)).status).toBe(429);
    expect((await s.call('203.0.113.7', null)).status).toBe(429);
    expect(s.lookups() - start).toBe(5);
    // Other addresses are not affected.
    expect((await s.call('198.51.100.9', guess())).status).toBe(401);
    expect((await s.call('198.51.100.9', s.key)).status).toBe(200);
  });

  it('AUTH-02 missing keys count as failures; a key used from a disallowed address does not', async () => {
    const start = s.lookups();
    for (let i = 0; i < 5; i++) expect((await s.call('203.0.113.20', null)).status).toBe(401);
    expect((await s.call('203.0.113.20', null)).status).toBe(429);
    expect(s.lookups()).toBe(start); // no key, no lookup
    const pinned = (await s.service.keys.create('pinned', ['read'], { ipAllowlist: ['10.0.0.0/8'] })).key;
    for (let i = 0; i < 8; i++) expect((await s.call('203.0.113.21', pinned)).status).toBe(403);
  });

  it('AUTH-03 IPv6 clients are counted per /64', async () => {
    for (let i = 0; i < 5; i++) expect((await s.call(`2001:db8:1:2::${i + 1}`, guess())).status).toBe(401);
    expect((await s.call('2001:db8:1:2:ffff::9', guess())).status).toBe(429);
    expect((await s.call('2001:db8:1:3::1', guess())).status).toBe(401);
    expect(limiterClient('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(limiterClient('203.0.113.7')).toBe('203.0.113.7');
  });

  it('AUTH-04 /readyz with a key from a locked-out address answers anonymously, without a lookup', async () => {
    const start = s.lookups();
    const r = await s.call('203.0.113.7', s.key, '/readyz');
    expect([200, 503]).toContain(r.status);
    expect(Object.keys((await r.json()) as object).sort()).toEqual(['checks', 'dependencies', 'engines', 'ok']); // the anonymous answer
    expect(s.lookups()).toBe(start);
  });
});

describe('per-address budget and per-key limit headers', () => {
  it('AUTH-05 the per-address budget refuses before the lookup (scope client_ip); the limits are runtime settings', async () => {
    const s = await setup({ REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '3', REELFORGE_RATE_LIMIT_PER_MINUTE: '1000' });
    // 3 per minute: a token comes back every 20 s, far longer than these requests take even on a loaded machine.
    for (let i = 0; i < 3; i++) expect((await s.call('192.0.2.1', s.key)).status).toBe(200);
    const start = s.lookups();
    const r = await s.call('192.0.2.1', s.key);
    expect(r.status).toBe(429);
    expect(s.lookups()).toBe(start);
    expect(((await r.json()) as { error: { details: { scope: string; hint: string } } }).error.details).toMatchObject({ scope: 'client_ip', hint: expect.stringMatching(/trustProxy/) });
    expect(r.headers.get('ratelimit-policy')).toBe('3;w=60');
    expect((await s.call('192.0.2.2', s.key)).status).toBe(200);
    // Raised at runtime: applies to the next request, no restart.
    await s.service.updateConfig({ 'limits.preAuthPerMinute': 0 });
    expect((await s.call('192.0.2.1', s.key)).status).toBe(200);
  });

  it('AUTH-06 per-key limit: every response has RateLimit-*; the 429 has Retry-After and a body with scope "key" and a hint', async () => {
    const s = await setup({ REELFORGE_RATE_LIMIT_PER_MINUTE: '3' });
    const ok = await s.call('192.0.2.50', s.key);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('ratelimit-limit')).toBe('3');
    expect(ok.headers.get('ratelimit-remaining')).toBe('2');
    expect(ok.headers.get('ratelimit-policy')).toBe('3;w=60');
    expect(ok.headers.get('retry-after')).toBeNull();
    await s.call('192.0.2.50', s.key);
    await s.call('192.0.2.50', s.key);
    const limited = await s.call('192.0.2.50', s.key);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get('ratelimit-remaining')).toBe('0');
    expect(Number(limited.headers.get('ratelimit-reset'))).toBeGreaterThanOrEqual(1);
    const body = (await limited.json()) as { error: { code: string; details: { scope: string; hint: string; limit: number } } };
    expect(body.error).toMatchObject({ code: 'rate_limited', details: { scope: 'key', limit: 3, hint: expect.stringMatching(/rateLimitPerMinute/) } });
  });
});

describe('PreAuthGuard', () => {
  const settings = { perMinute: 0, failuresPerMinute: 3, lockoutSeconds: 10, lockoutMaxSeconds: 60 };
  const T = Date.UTC(2026, 10, 23, 12);

  it('AUTH-07 each further lockout doubles, up to the maximum; a long quiet period starts over', () => {
    const g = new PreAuthGuard(() => settings);
    let t = T;
    const run = () => {
      // The third failure uses up the budget of three and starts a lockout.
      let lockout = 0;
      for (let i = 0; i < 20 && !lockout; i++) {
        expect(g.check('203.0.113.1', t).allowed).toBe(true);
        lockout = g.failure('203.0.113.1', t);
        if (!lockout) expect(i).toBeLessThan(2);
      }
      const locked = g.check('203.0.113.1', t);
      expect(locked).toMatchObject({ allowed: false, scope: 'auth_failures', decision: { retryAfterSeconds: lockout } });
      t += lockout * 1000;
      return lockout;
    };
    expect([run(), run(), run(), run(), run()]).toEqual([10, 20, 40, 60, 60]);
    t += 61_000; // quiet for longer than the longest lockout
    expect(run()).toBe(10);
  });

  it('AUTH-08 memory stays bounded under many addresses', () => {
    const g = new PreAuthGuard(() => ({ ...settings, perMinute: 100 }), 1000);
    for (let i = 0; i < 5000; i++) {
      const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      g.check(ip, T + i);
      g.failure(ip, T + i);
    }
    expect(g.size.requests).toBeLessThanOrEqual(1001);
    expect(g.size.failures).toBeLessThanOrEqual(1001);
  });
});

describe('start-up without REELFORGE_SECRET_KEY (#305)', () => {
  const registry = () => new PluginRegistry().registerEngine(fakeEngine('remotion'));

  it('AUTH-09 a release build refuses to start, with the fix in the error; nothing is created', async () => {
    const env = { REELFORGE_DATA_DIR: join(dir, 'release') };
    const release = parseBuildInfo({ edition: 'release', locked: { 'licence.mode': 'required', 'licence.serverUrl': 'https://licence.example.test', 'licence.orgId': 'aaaaaaaaaaaaaaaaaaaaaaaa' } });
    const resolved = resolveConfig({ env, build: release });
    const err = await startServer({ resolved, sources: { env }, port: 0, host: '127.0.0.1' }, { env, quiet: true, registry }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/REELFORGE_SECRET_KEY is not set: the release edition does not start without it.*REELFORGE_SECRET_KEY_FILE/);
    expect(existsSync(env.REELFORGE_DATA_DIR)).toBe(false);
  });

  it('AUTH-10 a dev build starts with a warning and seals the licence state with a key in its data directory', async () => {
    const env = { REELFORGE_DATA_DIR: join(dir, 'dev'), REELFORGE_LICENCE_MODE: 'off' };
    const lines: string[] = [];
    const started = await startServer({ port: 0, host: '127.0.0.1' }, { env, registry, logWrite: (level, line) => lines.push(`${level} ${line}`) });
    try {
      expect(lines.some((l) => /^warn .*REELFORGE_SECRET_KEY is not set.*licence-seal\.key/.test(l))).toBe(true);
      expect(existsSync(join(env.REELFORGE_DATA_DIR, LOCAL_SEAL_FILE))).toBe(true);
    } finally {
      await started.close();
    }
  });
});
