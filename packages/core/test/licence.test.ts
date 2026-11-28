import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ApiError,
  BuildBaseLicenceClient,
  LicenceManager,
  LicenceServerError,
  PluginRegistry,
  RenderWeldService,
  createMemoryRepositories,
  maskLicenceKey,
  type LicenceAnswer,
  type LicenceApi,
  type LicenceManagerOptions,
  type Repositories,
} from '../src/index';
import { fakeEngine, tempDir } from './helpers';

const DAY = 86_400_000;
const KEY = 'ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2';
const KEY2 = 'ZZZZZ-YYYYY-XXXXX-WWWWW-VVVVV';
const T0 = Date.parse('2026-11-21T12:00:00.000Z');

/** A mock LicensesApi: one key store with BuildBase's semantics, plus switches for outages. */
class MockApi implements LicenceApi {
  keys = new Map<string, { status: string; limit: number | null; instances: Set<string>; item?: { id: string; title: string } | null }>();
  calls: Array<{ op: string; key: string; instance?: string }> = [];
  offline = false;
  rateLimited = false;
  serverError = false;
  constructor(keys: Array<{ key: string; limit?: number | null; status?: string; instances?: string[]; item?: { id: string; title: string } | null }> = [{ key: KEY }]) {
    for (const k of keys) this.keys.set(k.key, { status: k.status ?? 'active', limit: k.limit === undefined ? 1 : k.limit, instances: new Set(k.instances ?? []), item: k.item });
  }
  /** The item a key was bought for (BuildBase answers it); `null`: an answer without an item. */
  private item(k: { item?: { id: string; title: string } | null }) {
    return k.item === undefined ? { item: { id: 'itm_1', title: 'RenderWeld' } } : k.item ? { item: k.item } : {};
  }
  private fail() {
    if (this.offline) throw new LicenceServerError('unreachable', 'licence server unreachable (ECONNREFUSED)');
    if (this.rateLimited) throw new LicenceServerError('rate_limited', 'licence server: too many checks (LICENSE_CHECKS_LIMITED)', 429, 'LICENSE_CHECKS_LIMITED', 600);
    if (this.serverError) throw new LicenceServerError('server_error', 'licence server error (HTTP 503)', 503);
  }
  private view(k: { status: string; limit: number | null; instances: Set<string> }) {
    return { status: k.status, activations: k.instances.size, activationLimit: k.limit, expiresAt: null };
  }
  async validate(key: string, instance?: string): Promise<LicenceAnswer> {
    this.calls.push({ op: 'validate', key, instance });
    this.fail();
    const k = this.keys.get(key);
    if (!k) return { valid: false, reason: 'not_found' };
    if (k.status !== 'active') return { valid: false, reason: k.status, key: this.view(k) };
    if (instance && !k.instances.has(instance)) return { valid: false, reason: 'not_activated', key: this.view(k), instance: null };
    return { valid: true, reason: null, key: this.view(k), ...this.item(k), instance: instance ? { instance, activatedAt: new Date(T0).toISOString() } : null };
  }
  async activate(key: string, instance: string): Promise<LicenceAnswer> {
    this.calls.push({ op: 'activate', key, instance });
    this.fail();
    const k = this.keys.get(key);
    if (!k) return { valid: false, reason: 'not_found' };
    if (k.status !== 'active') return { valid: false, reason: k.status, key: this.view(k) };
    if (!k.instances.has(instance)) {
      if (k.limit !== null && k.instances.size >= k.limit) return { valid: false, reason: 'limit_reached', key: this.view(k), instance: null };
      k.instances.add(instance);
    }
    return { valid: true, reason: null, key: this.view(k), ...this.item(k), instance: { instance, activatedAt: new Date(T0).toISOString() } };
  }
  async deactivate(key: string, instance: string): Promise<LicenceAnswer> {
    this.calls.push({ op: 'deactivate', key, instance });
    this.fail();
    const k = this.keys.get(key);
    if (!k) return { valid: false, reason: 'not_found' };
    k.instances.delete(instance);
    return { valid: true, reason: null, key: this.view(k), instance: null };
  }
}

function setup(opts: Partial<Omit<LicenceManagerOptions, 'key' | 'api'>> & { key?: string | null; api?: MockApi; repos?: Repositories; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: T0 };
  const api = opts.api ?? new MockApi();
  const repos = opts.repos ?? createMemoryRepositories();
  const keyRef = { value: opts.key === null ? undefined : (opts.key ?? KEY) };
  const logs: string[] = [];
  const m = new LicenceManager({
    repo: repos.licence,
    api,
    key: () => ({ value: keyRef.value, source: 'env (RENDERWELD_LICENCE_KEY)' }),
    mode: opts.mode ?? 'required',
    graceDays: opts.graceDays ?? 14,
    licenceServer: { url: 'https://licence.example.test', orgId: 'org123456' },
    now: () => clock.t,
    timers: false,
    log: (level, line) => logs.push(`${level}: ${line}`),
    sealSecret: opts.sealSecret ?? 'licence-unit-seal-secret-0123456789abcdef',
    itemIds: opts.itemIds,
    version: opts.version,
  });
  return { m, api, repos, clock, keyRef, logs };
}

describe('LicenceManager', () => {
  it('without a key: unlicensed; required refuses renders with a fix, off allows them with a warning; no network', async () => {
    const { m, api } = setup({ key: null });
    await m.init();
    await m.check('start');
    const r = m.report();
    expect(r).toMatchObject({ status: 'unlicensed', reason: 'no_key', renderAllowed: false, key: null, mode: 'required' });
    expect(r.fix).toMatch(/activate_licence/);
    const err = await m.assertRenderAllowed().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'licence_required', status: 403 });
    expect(err.message).toMatch(/read, listed and downloaded/);
    expect(api.calls).toEqual([]);

    const off = setup({ key: null, mode: 'off' });
    await off.m.init();
    expect(off.m.report()).toMatchObject({ status: 'unlicensed', renderAllowed: true });
    expect(off.m.report().warning).toMatch(/licence.mode is "off"/);
    await expect(off.m.assertRenderAllowed()).resolves.toBeUndefined();
  });

  it('activates on first start with only the key and the instance id, stores the answer, then validates (same instance id after a restart)', async () => {
    const { m, api, repos, clock } = setup();
    await m.init();
    expect(m.report().status).toBe('invalid'); // nothing checked yet, no check running
    m.start();
    expect(m.report().status).toBe('checking');
    await m.assertRenderAllowed(); // waits for the running check
    const r = m.report();
    expect(r).toMatchObject({ status: 'valid', reason: null, renderAllowed: true, key: 'ABCDE-*****-*****-*****-*****', keySource: 'env (RENDERWELD_LICENCE_KEY)' });
    expect(r).toMatchObject({ item: { id: 'itm_1', title: 'RenderWeld' }, activations: { used: 1, limit: 1 }, lastSuccessAt: new Date(T0).toISOString(), graceUntil: new Date(T0 + 14 * DAY).toISOString() });
    expect(r.nextCheckAt).toBe(new Date(T0 + DAY).toISOString());
    expect(api.calls).toEqual([{ op: 'activate', key: KEY, instance: r.instanceId }]);
    expect(r.instanceId).toMatch(/^rf-[0-9a-f-]{36}$/);
    // The key is never stored.
    expect(JSON.stringify(await repos.licence.get())).not.toContain('FGHJK');

    // A restart on the same database: same instance, validate (not activate).
    clock.t += DAY;
    const again = setup({ api, repos, clock });
    await again.m.init();
    expect(again.m.instanceId).toBe(r.instanceId);
    await again.m.check('start');
    expect(api.calls.at(-1)).toEqual({ op: 'validate', key: KEY, instance: r.instanceId });
    expect(again.m.report().status).toBe('valid');
  });

  it('limit_reached: invalid, with how to free an activation', async () => {
    const api = new MockApi([{ key: KEY, limit: 1, instances: ['rf-other-server'] }]);
    const { m } = setup({ api });
    await m.init();
    const r = await m.check('start');
    expect(r).toMatchObject({ status: 'invalid', reason: 'limit_reached', renderAllowed: false, activations: { used: 1, limit: 1 } });
    expect(r.fix).toMatch(/deactivate_licence/);
    await expect(m.assertRenderAllowed()).rejects.toMatchObject({ code: 'licence_invalid', details: { licence: { reason: 'limit_reached' } } });
    // Freed elsewhere: the next check activates.
    api.keys.get(KEY)!.instances.clear();
    expect((await m.check('scheduled')).status).toBe('valid');
  });

  it('revoked at the daily validate: invalid; being offline afterwards does not bring it back', async () => {
    const { m, api, clock } = setup();
    await m.init();
    await m.check('start');
    api.keys.get(KEY)!.status = 'revoked';
    clock.t += DAY;
    expect(await m.check('scheduled')).toMatchObject({ status: 'invalid', reason: 'revoked' });
    api.offline = true;
    clock.t += DAY;
    expect(await m.check('scheduled')).toMatchObject({ status: 'invalid', reason: 'revoked' });
  });

  it('offline: grace (warning, graceUntil) up to 14 days after the last success, then invalid; back online: valid', async () => {
    const { m, api, clock, logs } = setup();
    await m.init();
    await m.check('start');
    api.offline = true;
    clock.t = T0 + 3 * DAY;
    let r = await m.check('scheduled');
    expect(r).toMatchObject({ status: 'grace', renderAllowed: true, graceUntil: new Date(T0 + 14 * DAY).toISOString(), lastError: { kind: 'unreachable' } });
    expect(r.warning).toMatch(/renders keep working until 2026-12-05T12:00:00.000Z/);
    expect(logs.some((l) => l.startsWith('warn: licence: licence server unreachable'))).toBe(true);
    await expect(m.assertRenderAllowed()).resolves.toBeUndefined();
    clock.t = T0 + 14 * DAY - 1000;
    expect((await m.check('scheduled')).status).toBe('grace');
    clock.t = T0 + 14 * DAY + 1000;
    r = await m.check('scheduled');
    expect(r).toMatchObject({ status: 'invalid', reason: 'grace_expired', renderAllowed: false });
    expect(r.message).toMatch(/more than 14 days/);
    expect(r.fix).toMatch(/licence\.example\.test/);
    await expect(m.assertRenderAllowed()).rejects.toMatchObject({ code: 'licence_invalid' });
    api.offline = false;
    expect((await m.check('scheduled')).status).toBe('valid');
  });

  it('a shorter offlineGraceDays shortens the grace period', async () => {
    const { m, api, clock } = setup({ graceDays: 2 });
    await m.init();
    await m.check('start');
    api.offline = true;
    clock.t = T0 + 3 * DAY;
    expect(await m.check('scheduled')).toMatchObject({ status: 'invalid', reason: 'grace_expired' });
  });

  it('never reached the licence server: invalid "unreachable" (no grace without a first success)', async () => {
    const api = new MockApi();
    api.offline = true;
    const { m } = setup({ api });
    await m.init();
    const r = await m.check('start');
    expect(r).toMatchObject({ status: 'invalid', reason: 'unreachable', renderAllowed: false });
    expect(r.message).toMatch(/first activation needs it once/);
  });

  it('clock checks: a "last success" in the future or a clock set back gives no grace', async () => {
    // Edited state: last success far in the future, licence server unreachable. The
    // stored state is sealed (D-089), so the edit is detected before any clock check.
    const repos = createMemoryRepositories();
    const { m, api, clock } = setup({ repos });
    await m.init();
    await m.check('start');
    const stored = (await repos.licence.get())!;
    await repos.licence.save({ ...stored, lastSuccessAt: '2099-01-01T00:00:00.000Z' });
    api.offline = true;
    clock.t += DAY;
    expect(await m.check('scheduled')).toMatchObject({ status: 'invalid', reason: 'state_untrusted', renderAllowed: false });

    // Clock set back behind the latest time seen (offline).
    const b = setup();
    await b.m.init();
    await b.m.check('start');
    b.api.offline = true;
    b.clock.t = T0 + 10 * DAY;
    expect((await b.m.check('scheduled')).status).toBe('grace');
    b.clock.t = T0 + 2 * DAY; // someone sets the clock back to stretch the grace period
    expect(await b.m.check('scheduled')).toMatchObject({ status: 'invalid', reason: 'clock_skew' });
    // Online again, a fresh answer is trusted.
    b.api.offline = false;
    expect((await b.m.check('scheduled')).status).toBe('valid');
  });

  it('the highest time seen is recorded at every start and by the hourly marker, and a restart with the clock set back gets no grace', async () => {
    const repos = createMemoryRepositories();
    const first = setup({ repos });
    await first.m.init();
    await first.m.check('start'); // valid at T0
    first.api.offline = true;
    first.clock.t = T0 + 8 * DAY;
    expect((await first.m.check('scheduled')).status).toBe('grace');
    // Still running offline a day later: the hourly marker moves with the clock.
    first.clock.t = T0 + 9 * DAY;
    await first.m.markClock('timer');
    expect((await repos.licence.get())!.highWaterAt).toBe(new Date(T0 + 9 * DAY).toISOString());
    expect(first.m.report().status).toBe('grace');

    // Stopped, clock set back to T0 + 1 day, started again (no licence check has run yet).
    const clock = { t: T0 + DAY };
    const again = setup({ repos, api: first.api, clock });
    await again.m.init();
    expect(again.logs.some((l) => /^error: licence: the system clock .* is behind the latest time this server has seen/.test(l))).toBe(true);
    expect(again.m.report()).toMatchObject({ status: 'invalid', reason: 'clock_skew', renderAllowed: false });
    // The marker is never moved backwards.
    expect((await repos.licence.get())!.highWaterAt).toBe(new Date(T0 + 9 * DAY).toISOString());

    // A normal restart moves the marker forward.
    const later = setup({ repos, api: first.api, clock: { t: T0 + 10 * DAY } });
    await later.m.init();
    expect((await repos.licence.get())!.highWaterAt).toBe(new Date(T0 + 10 * DAY).toISOString());
    expect(later.m.report().status).toBe('grace');
  });

  it('backs off on 429 (Retry-After) and 5xx, doubling, and resets after a success', async () => {
    const { m, api, clock } = setup();
    await m.init();
    await m.check('start');
    api.rateLimited = true;
    let r = await m.check('scheduled');
    expect(r.status).toBe('grace');
    expect(r.lastError).toMatchObject({ kind: 'rate_limited', status: 429, code: 'LICENSE_CHECKS_LIMITED' });
    expect(Date.parse(r.nextCheckAt!) - clock.t).toBeGreaterThanOrEqual(600_000); // Retry-After: 600 s
    api.rateLimited = false;
    api.serverError = true;
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      r = await m.check('retry');
      waits.push(Date.parse(r.nextCheckAt!) - clock.t);
    }
    // 2nd..5th failure: 2, 4, 8, 16 minutes (+ up to 10 % jitter)
    expect(waits[0]).toBeGreaterThanOrEqual(120_000);
    expect(waits[1]).toBeGreaterThanOrEqual(240_000);
    expect(waits[3]).toBeGreaterThanOrEqual(960_000);
    expect(waits[3]).toBeLessThan(960_000 * 1.11);
    api.serverError = false;
    r = await m.check('retry');
    expect(Date.parse(r.nextCheckAt!) - clock.t).toBe(DAY);
  });

  it('re-activates by itself when the activation was freed elsewhere (validate says not_activated)', async () => {
    const { m, api } = setup();
    await m.init();
    await m.check('start');
    api.keys.get(KEY)!.instances.clear();
    expect((await m.check('scheduled')).status).toBe('valid');
    expect(api.calls.slice(-2).map((c) => c.op)).toEqual(['validate', 'activate']);
  });

  it('deactivate: frees the slot, is not undone by later checks or restarts, activateNow takes it again; offline deactivate changes nothing', async () => {
    const { m, api, repos, clock } = setup();
    await m.init();
    await m.check('start');
    let r = await m.deactivate();
    expect(r).toMatchObject({ status: 'invalid', reason: 'deactivated', renderAllowed: false, nextCheckAt: null });
    expect(api.keys.get(KEY)!.instances.size).toBe(0);
    const n = api.calls.length;
    await m.check('scheduled');
    const restarted = setup({ api, repos, clock });
    await restarted.m.init();
    expect((await restarted.m.check('start')).reason).toBe('deactivated');
    expect(api.calls.length).toBe(n);
    r = await restarted.m.activateNow();
    expect(r.status).toBe('valid');
    api.offline = true;
    const err = await restarted.m.deactivate().catch((e) => e);
    expect(err).toMatchObject({ code: 'licence_server_unavailable', status: 503 });
    expect(restarted.m.report().status).toBe('valid');
    expect(api.keys.get(KEY)!.instances.size).toBe(1);
  });

  it('a new key is activated and the old answer no longer applies', async () => {
    const api = new MockApi([{ key: KEY }, { key: KEY2, limit: null }]);
    const { m, keyRef } = setup({ api });
    await m.init();
    await m.check('start');
    keyRef.value = KEY2;
    expect(m.report().status).toBe('invalid'); // not checked yet for this key
    const r = await m.check('key changed');
    expect(r).toMatchObject({ status: 'valid', key: 'ZZZZZ-*****-*****-*****-*****', activations: { used: 1, limit: null } });
    expect(api.calls.at(-1)).toMatchObject({ op: 'activate', key: KEY2 });
    keyRef.value = 'NOPE0-NOPE0-NOPE0-NOPE0-NOPE0';
    expect(await m.check('key changed')).toMatchObject({ status: 'invalid', reason: 'not_found' });
  });

  it('masks keys to the first group', () => {
    expect(maskLicenceKey(KEY)).toBe('ABCDE-*****-*****-*****-*****');
    expect(maskLicenceKey('ABCDEFGHJKLMNPQRSTUVWXYZ2')).toBe('ABCDE-*****-*****-*****-*****');
    expect(maskLicenceKey('short')).toBe('short');
  });
});

describe('a key covers one major version (licence.itemIds, D-142)', () => {
  const V1 = { id: 'itm_rw1_commercial', title: 'RenderWeld 1 Commercial' };
  const V1P = { id: 'itm_rw1_personal', title: 'RenderWeld 1 Personal' };
  const V2 = { id: 'itm_rw2_commercial', title: 'RenderWeld 2 Commercial' };

  it('LICV-1 a key bought for one of the listed items is valid, Personal and Commercial alike', async () => {
    for (const item of [V1, V1P]) {
      const { m, api } = setup({ api: new MockApi([{ key: KEY, item }]), itemIds: [V1.id, V1P.id], version: '1.4.0' });
      await m.init();
      const r = await m.check('start');
      expect(r).toMatchObject({ status: 'valid', renderAllowed: true, item });
      expect(api.calls.map((c) => c.op)).toEqual(['activate']);
    }
  });

  it('LICV-2 a key for another major version is refused (wrong_version), renders stay refused, and its activation is given back', async () => {
    const { m, api, logs } = setup({ api: new MockApi([{ key: KEY, item: V1 }]), itemIds: [V2.id], version: '2.0.0' });
    await m.init();
    const r = await m.check('start');
    expect(r).toMatchObject({ status: 'invalid', reason: 'wrong_version', renderAllowed: false, activatedAt: null });
    expect(r.message).toMatch(/bought for another RenderWeld version \(RenderWeld 1 Commercial\); this image is RenderWeld 2\.0\.0 and accepts keys for RenderWeld 2/);
    expect(r.fix).toMatch(/buy a key for this version/);
    // It took an activation to learn the item, then gave it back: the buyer's 1.x server keeps its slot.
    expect(api.calls.map((c) => c.op)).toEqual(['activate', 'deactivate']);
    expect(api.keys.get(KEY)!.instances.size).toBe(0);
    const err = await m.assertRenderAllowed().catch((e) => e);
    expect(err).toMatchObject({ code: 'licence_invalid', status: 403 });
    expect(logs.join('\n')).toMatch(/wrong_version/);
  });

  it('LICV-3 an answer that names no item is refused while a list is set; with no list any item works (0.x images)', async () => {
    const strict = setup({ api: new MockApi([{ key: KEY, item: null }]), itemIds: [V1.id], version: '1.0.0' });
    await strict.m.init();
    expect(await strict.m.check('start')).toMatchObject({ status: 'invalid', reason: 'wrong_version' });

    for (const itemIds of [undefined, []]) {
      const open = setup({ api: new MockApi([{ key: KEY, item: V2 }]), itemIds, version: '0.1.0' });
      await open.m.init();
      expect(await open.m.check('start')).toMatchObject({ status: 'valid', item: V2 });
    }
  });

  it('LICV-4 upgrading to the next major version: the state a 1.x image stored is not valid on 2.0, also offline (no grace)', async () => {
    const repos = createMemoryRepositories();
    const clock = { t: T0 };
    const api = new MockApi([{ key: KEY, item: V1 }]);
    const v1 = setup({ api, repos, clock, itemIds: [V1.id], version: '1.9.0' });
    await v1.m.init();
    expect(await v1.m.check('start')).toMatchObject({ status: 'valid' });

    // The 2.0 image starts on the same database; the licence server is not reachable.
    api.offline = true;
    clock.t += 60_000;
    const v2 = setup({ api, repos, clock, itemIds: [V2.id], version: '2.0.0' });
    await v2.m.init();
    expect(v2.m.report()).toMatchObject({ status: 'invalid', reason: 'wrong_version', renderAllowed: false });
    await v2.m.check('scheduled');
    expect(v2.m.report()).toMatchObject({ status: 'invalid', renderAllowed: false });

    // Online again: the daily validate still says "valid" for the key; the 2.0 image still refuses it and keeps no
    // activation of its own. Going back to the 1.x image works.
    api.offline = false;
    clock.t += DAY;
    expect(await v2.m.check('scheduled')).toMatchObject({ status: 'invalid', reason: 'wrong_version' });
    const back = setup({ api, repos, clock, itemIds: [V1.id], version: '1.9.0' });
    await back.m.init();
    expect(await back.m.check('start')).toMatchObject({ status: 'valid' });
  });

  it('LICV-5 a valid stored answer edited to name an accepted item fails the seal: no valid state without the licence server', async () => {
    const repos = createMemoryRepositories();
    const { m } = setup({ api: new MockApi([{ key: KEY, item: V1 }]), repos, itemIds: [V2.id], version: '2.0.0' });
    await m.init();
    await m.check('start');
    const row = (await repos.licence.get())!;
    const answer = JSON.parse(JSON.stringify(row.answer)) as Record<string, unknown>;
    answer.valid = true;
    answer.reason = null;
    answer.item = V2;
    await repos.licence.save({ ...row, answer, lastSuccessAt: new Date(T0).toISOString() });
    const offline = new MockApi([{ key: KEY, item: V1 }]);
    offline.offline = true;
    const again = setup({ api: offline, repos, itemIds: [V2.id], version: '2.0.0' });
    await again.m.init();
    expect(again.m.report()).toMatchObject({ renderAllowed: false });
    expect(again.m.report().status).not.toBe('valid');
  });
});

describe('BuildBaseLicenceClient (HTTP)', () => {
  type Call = { url: string; init: RequestInit };
  const client = (respond: (call: Call) => Response | Promise<Response>) => {
    const calls: Call[] = [];
    const c = new BuildBaseLicenceClient({
      serverUrl: 'https://api.console.buildbase.app/',
      orgId: '6b01478bb42d2c444e99fcd8-fsyqdskf',
      fetch: (async (url: string, init: RequestInit) => {
        const call = { url: String(url), init };
        calls.push(call);
        return respond(call);
      }) as unknown as typeof fetch,
      timeoutMs: 2000,
    });
    return { c, calls };
  };

  it('posts { key, instance } to /api/v1/licenses/<org>/<op> with no credentials', async () => {
    const answer = { valid: true, reason: null, key: { status: 'active', activations: 1, activationLimit: 1, expiresAt: null }, item: { id: 'i', title: 't' }, instance: { instance: 'rf-1', activatedAt: 'x' } };
    const { c, calls } = client(() => Response.json(answer));
    expect(await c.activate(KEY, 'rf-1')).toEqual(answer);
    await c.validate(KEY, 'rf-1');
    await c.validate(KEY);
    await c.deactivate(KEY, 'rf-1');
    expect(calls.map((x) => x.url)).toEqual([
      'https://api.console.buildbase.app/api/v1/licenses/6b01478bb42d2c444e99fcd8-fsyqdskf/activate',
      'https://api.console.buildbase.app/api/v1/licenses/6b01478bb42d2c444e99fcd8-fsyqdskf/validate',
      'https://api.console.buildbase.app/api/v1/licenses/6b01478bb42d2c444e99fcd8-fsyqdskf/validate',
      'https://api.console.buildbase.app/api/v1/licenses/6b01478bb42d2c444e99fcd8-fsyqdskf/deactivate',
    ]);
    expect(calls.map((x) => JSON.parse(String(x.init.body)))).toEqual([{ key: KEY, instance: 'rf-1' }, { key: KEY, instance: 'rf-1' }, { key: KEY }, { key: KEY, instance: 'rf-1' }]);
    for (const x of calls) {
      expect(x.init.method).toBe('POST');
      // No credentials: only the content headers and the product User-Agent (#413).
      expect(x.init.headers).toEqual({ 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'RenderWeld-Licence/1' });
    }
  });

  it('maps 429 LICENSE_CHECKS_LIMITED, 5xx, network errors and odd answers to LicenceServerError', async () => {
    const limited = client(() => Response.json({ code: 'LICENSE_CHECKS_LIMITED', message: 'slow down' }, { status: 429, headers: { 'retry-after': '90' } }));
    await expect(limited.c.validate(KEY, 'rf-1')).rejects.toMatchObject({ kind: 'rate_limited', status: 429, code: 'LICENSE_CHECKS_LIMITED', retryAfterSeconds: 90 });
    const down = client(() => new Response('bad gateway', { status: 502 }));
    await expect(down.c.validate(KEY, 'rf-1')).rejects.toMatchObject({ kind: 'server_error', status: 502 });
    const net = client(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    });
    await expect(net.c.validate(KEY, 'rf-1')).rejects.toMatchObject({ kind: 'unreachable', message: 'licence server unreachable (ENOTFOUND)' });
    const odd = client(() => new Response('<html>', { status: 200 }));
    await expect(odd.c.validate(KEY, 'rf-1')).rejects.toMatchObject({ kind: 'bad_response' });
    const org = client(() => Response.json({ code: 'ORG_NOT_FOUND', message: 'unknown organisation' }, { status: 404 }));
    await expect(org.c.validate(KEY, 'rf-1')).rejects.toMatchObject({ kind: 'refused', status: 404, code: 'ORG_NOT_FOUND' });
    // A refusal that carries an answer is an answer.
    const nf = client(() => Response.json({ valid: false, reason: 'not_found' }, { status: 404 }));
    await expect(nf.c.validate(KEY, 'rf-1')).resolves.toEqual({ valid: false, reason: 'not_found' });
    const slow = client(({ init }) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    await expect(slow.c.validate(KEY, 'rf-1')).rejects.toMatchObject({ kind: 'unreachable', message: 'licence server unreachable (no answer within 2 s)' });
  });
});

describe('RenderWeldService with a licence', () => {
  const { dir, cleanup } = tempDir('reelforge-licence-svc-');
  afterAll(cleanup);
  const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));

  it('refuses render/preview/retry with a structured error when invalid; reading still works; capabilities and audit say why', async () => {
    const api = new MockApi();
    const clock = { t: T0 };
    const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));
    const svc = await RenderWeldService.create(registry, {
      repositories: createMemoryRepositories(),
      dataDir: join(dir, 'data'),
      configSources: { env: { RENDERWELD_SECRET_KEY: 'licence-test-secret-key-0123456789abcd' } },
      licence: { api, now: () => clock.t },
    });
    await svc.createProject(sample);
    expect(svc.capabilities().licence).toMatchObject({ status: 'unlicensed', renderAllowed: false, reason: 'no_key' });
    await expect(svc.startRender('sample-reel')).rejects.toMatchObject({ code: 'licence_required', status: 403 });
    await expect(svc.preview('sample-reel')).rejects.toMatchObject({ code: 'licence_required' });

    // activate_licence: stores the key encrypted and activates.
    const r = await svc.activateLicence(KEY, { actorType: 'api_key', actorId: 'key_admin' });
    expect(r).toMatchObject({ status: 'valid', keySource: 'runtime', key: 'ABCDE-*****-*****-*****-*****' });
    expect(api.calls.filter((c) => c.op === 'activate')).toHaveLength(1);
    expect(svc.getConfig({ prefix: 'licence' }).settings.find((s) => s.key === 'licence.key')).toMatchObject({ value: 'set', atRest: 'aes-256-gcm' });
    const job = await svc.startRender('sample-reel');
    // Poll up to 2 minutes: on a loaded machine (parallel test files) one wait of 30 s was not always enough.
    let done = await svc.waitForJob(job.id, 30);
    for (let i = 0; i < 3 && !['succeeded', 'failed', 'cancelled'].includes(done.status); i++) done = await svc.waitForJob(job.id, 30);
    expect(done.status).toBe('succeeded');

    // Revoked: renders refused at the next check; reading, listing and downloads keep working.
    api.keys.get(KEY)!.status = 'revoked';
    clock.t += DAY;
    await svc.licence.check('scheduled');
    const err = await svc.startRender('sample-reel').catch((e) => e);
    expect(err).toMatchObject({ code: 'licence_invalid', status: 403, details: { licence: { status: 'invalid', reason: 'revoked' } } });
    expect(err.message).toMatch(/revoked/);
    await expect(svc.preview('sample-reel')).rejects.toMatchObject({ code: 'licence_invalid' });
    await expect(svc.retryJob(job.id)).rejects.toMatchObject({ code: 'licence_invalid' });
    expect((await svc.listProjects()).projects.length).toBe(1);
    const renders = await svc.listRenders('sample-reel');
    expect(renders.length).toBe(1);
    expect((await svc.renderFile(renders[0]!.renderId)).path).toMatch(/final\.mp4$/);
    expect(svc.capabilities().licence).toMatchObject({ status: 'invalid', reason: 'revoked', renderAllowed: false });

    const audit = await svc.repos.audit.list();
    const act = audit.find((a) => a.action === 'licence.activate')!;
    expect(act).toMatchObject({ actorId: 'key_admin', data: { key: 'ABCDE-*****-*****-*****-*****', status: 'valid' } });
    expect(JSON.stringify(audit)).not.toContain('FGHJK');
    svc.licence.stop();
  }, 180_000);

  it('activate_licence without a key and none configured is a clear 400; update_config of licence.key activates in the background', async () => {
    const api = new MockApi();
    const svc = await RenderWeldService.create(new PluginRegistry().registerEngine(fakeEngine('remotion')), {
      repositories: createMemoryRepositories(),
      dataDir: join(dir, 'data2'),
      configSources: { env: { RENDERWELD_SECRET_KEY: 'licence-test-secret-key-0123456789abcd' } },
      licence: { api },
    });
    await expect(svc.activateLicence(undefined)).rejects.toMatchObject({ code: 'licence_key_missing', status: 400 });
    await svc.updateConfig({ 'licence.key': KEY });
    await svc.licence.assertRenderAllowed();
    expect(svc.getLicence().status).toBe('valid');
    expect(api.calls.map((c) => c.op)).toEqual(['activate']);
    svc.licence.stop();
  });
});

/**
 * Licence at scale (#154, D-098): several instances share one stored state (one
 * repository here, one database in production). Only api/all instances call the
 * licence server, single flight per deployment; workers only read the sealed state.
 */
describe('licence at scale: one check per deployment, workers never call', () => {
  const SECRET = 'licence-scale-secret-key-0123456789abcdef';
  /** A licence API a worker must never use. */
  const forbidden: LicenceApi = {
    validate: async () => {
      throw new Error('a worker called validate');
    },
    activate: async () => {
      throw new Error('a worker called activate');
    },
    deactivate: async () => {
      throw new Error('a worker called deactivate');
    },
  };
  function instance(name: string, shared: { repos: Repositories; api: MockApi; clock: { t: number } }, o: { readOnly?: boolean; secret?: string; key?: string | null; clock?: { t: number } } = {}) {
    const logs: string[] = [];
    const keyRef = { value: o.key === null ? undefined : (o.key ?? KEY) };
    const clock = o.clock ?? shared.clock;
    const m = new LicenceManager({
      repo: shared.repos.licence,
      api: o.readOnly ? forbidden : shared.api,
      key: () => ({ value: keyRef.value, source: 'env (RENDERWELD_LICENCE_KEY)' }),
      mode: 'required',
      graceDays: 14,
      licenceServer: { url: 'https://licence.example.test', orgId: 'org123456' },
      now: () => clock.t,
      timers: false,
      log: (level, line) => logs.push(`${level}: ${line}`),
      sealSecret: o.secret ?? SECRET,
      readOnly: o.readOnly,
      instanceName: name,
    });
    return { m, logs, keyRef };
  }
  function cluster(apis = 2, workers = 3) {
    const shared = { repos: createMemoryRepositories(), api: new MockApi(), clock: { t: T0 } };
    return {
      ...shared,
      apis: Array.from({ length: apis }, (_, i) => instance(`api-${i + 1}`, shared)),
      workers: Array.from({ length: workers }, (_, i) => instance(`worker-${i + 1}`, shared, { readOnly: true })),
    };
  }
  const ops = (api: MockApi) => api.calls.map((c) => c.op);
  const tickAll = (c: ReturnType<typeof cluster>, why = 'scheduled') => Promise.all([...c.apis, ...c.workers].map((x) => x.m.check(why, { claim: true })));

  it('2 api + 3 workers start together: exactly 1 activate; a day later exactly 1 validate; workers make no call', async () => {
    const c = cluster();
    await Promise.all([...c.apis, ...c.workers].map((x) => x.m.init()));
    await tickAll(c, 'start');
    expect(ops(c.api)).toEqual(['activate']);
    // Every instance applies the one stored answer (a worker after its next read).
    await tickAll(c, 'refresh');
    for (const x of [...c.apis, ...c.workers]) expect(x.m.report()).toMatchObject({ status: 'valid', renderAllowed: true });
    const ids = new Set([...c.apis, ...c.workers].map((x) => x.m.report().instanceId));
    expect(ids.size).toBe(1);
    const leader = c.apis[0]!.m.report().checkedBy;
    expect(['api-1', 'api-2']).toContain(leader);
    expect(c.workers[0]!.m.report()).toMatchObject({ checkedBy: leader, checksLicenceServer: false });
    // Many ticks within the day: no more calls.
    for (let i = 0; i < 5; i++) {
      c.clock.t += 3_600_000;
      await tickAll(c, 'refresh');
    }
    expect(ops(c.api)).toEqual(['activate']);
    // The next day: one validate, whichever api instance wins.
    for (const day of [1, 2, 3]) {
      c.clock.t = T0 + day * DAY + 60_000;
      await tickAll(c);
      await tickAll(c, 'refresh');
      expect(ops(c.api).filter((o) => o === 'validate')).toHaveLength(day);
    }
    expect(ops(c.api).filter((o) => o === 'activate')).toHaveLength(1);
    // A restart (or a new replica) with a fresh stored state makes no call at all (scale-to-zero churn).
    const fresh = instance('api-3', c);
    await fresh.m.init();
    await fresh.m.check('start', { claim: true });
    expect(fresh.m.report().status).toBe('valid');
    expect(ops(c.api)).toHaveLength(4);
  });

  it('1 api + 50 workers: 1 activation and 1 call in total at start, 0 from the workers', async () => {
    const c = cluster(1, 50);
    await Promise.all([...c.apis, ...c.workers].map((x) => x.m.init()));
    await tickAll(c, 'start');
    await tickAll(c, 'refresh');
    expect(ops(c.api)).toEqual(['activate']);
    expect(c.workers.every((w) => w.m.report().renderAllowed)).toBe(true);
  });

  it('a worker with no stored check waits (not allowed, clear log), then applies the api instance check; it never calls', async () => {
    const c = cluster(1, 1);
    const w = c.workers[0]!;
    await w.m.init();
    w.m.start();
    expect(w.m.report()).toMatchObject({ status: 'checking', reason: 'waiting_for_api', renderAllowed: false, checksLicenceServer: false });
    expect(w.m.report().fix).toMatch(/api instance/);
    expect(w.logs.some((l) => /^warn: licence: checking \(waiting_for_api\).*Workers never call the licence server/.test(l))).toBe(true);
    await expect(w.m.assertRenderAllowed()).rejects.toMatchObject({ code: 'licence_invalid' });
    const a = c.apis[0]!;
    await a.m.init();
    await a.m.check('start', { claim: true });
    // assertRenderAllowed re-reads the stored state before it refuses.
    await expect(w.m.assertRenderAllowed()).resolves.toBeUndefined();
    expect(w.m.report()).toMatchObject({ status: 'valid', renderAllowed: true });
    // A worker does not need the key itself: the api instances' check applies.
    const keyless = instance('worker-x', c, { readOnly: true, key: null });
    await keyless.m.init();
    expect(keyless.m.report()).toMatchObject({ status: 'valid', renderAllowed: true });
    await expect(w.m.deactivate()).rejects.toMatchObject({ code: 'licence_read_only' });
    expect(ops(c.api)).toEqual(['activate']);
    w.m.stop();
  });

  it('a worker refuses an edited state or one sealed with another secret key, and a stored refusal', async () => {
    const c = cluster(1, 0);
    const a = c.apis[0]!;
    await a.m.init();
    await a.m.check('start', { claim: true });
    // Another RENDERWELD_SECRET_KEY than the api instances: the seal does not verify.
    const other = instance('worker-other', c, { readOnly: true, secret: 'a-different-secret-key-0123456789abcdef' });
    await other.m.init();
    expect(other.m.report()).toMatchObject({ status: 'invalid', reason: 'state_untrusted', renderAllowed: false });
    expect(other.logs.some((l) => /^error: licence: the stored licence state failed its integrity check .*different RENDERWELD_SECRET_KEY/.test(l))).toBe(true);
    // The database row edited by hand.
    const stored = (await c.repos.licence.get())!;
    await c.repos.licence.save({ ...stored, lastSuccessAt: '2099-01-01T00:00:00.000Z' });
    const w = instance('worker-1', c, { readOnly: true });
    await w.m.init();
    expect(w.m.report()).toMatchObject({ status: 'invalid', reason: 'state_untrusted', renderAllowed: false });
    // The api instance checks again (revoked meanwhile): the worker applies the stored refusal.
    c.api.keys.get(KEY)!.status = 'revoked';
    await a.m.check('manual');
    expect((await w.m.check('refresh')).reason).toBe('revoked');
    expect(w.m.report().renderAllowed).toBe(false);
    expect(ops(c.api)).toEqual(['activate', 'validate']);
  });

  it('a worker honours the offline grace period and the clock checks, from the stored state alone', async () => {
    const c = cluster(1, 0);
    const a = c.apis[0]!;
    await a.m.init();
    await a.m.check('start', { claim: true });
    c.api.offline = true;
    c.clock.t = T0 + 3 * DAY;
    await a.m.check('scheduled', { claim: true });
    const w = instance('worker-1', c, { readOnly: true });
    await w.m.init();
    expect(w.m.report()).toMatchObject({ status: 'grace', renderAllowed: true, graceUntil: new Date(T0 + 14 * DAY).toISOString() });
    // Past the grace period: refused by the worker's own clock, even before the api instance checks again.
    c.clock.t = T0 + 14 * DAY + 1000;
    expect(w.m.report()).toMatchObject({ status: 'invalid', reason: 'grace_expired', renderAllowed: false });
    // A worker clock set back behind the latest time the deployment has seen gets no grace.
    c.clock.t = T0 + 3 * DAY;
    const skewed = instance('worker-skewed', c, { readOnly: true, clock: { t: T0 + 3 * DAY - 3_600_000 } });
    await skewed.m.init();
    expect(skewed.m.report()).toMatchObject({ status: 'invalid', reason: 'clock_skew', renderAllowed: false });
    // A worker never moves the marker (it only reads).
    const before = (await c.repos.licence.get())!.updatedAt;
    await skewed.m.markClock('timer');
    await w.m.check('refresh');
    expect((await c.repos.licence.get())!.updatedAt).toBe(before);
  });

  it('the check lease: an instance that took the check and died is replaced after the lease; backoff keeps doubling across instances', async () => {
    const c = cluster(2, 0);
    const [a, b] = c.apis as [ReturnType<typeof instance>, ReturnType<typeof instance>];
    await Promise.all([a.m.init(), b.m.init()]);
    // a took the first check and died before answering.
    expect(await c.repos.licence.claimCheck({ now: new Date(c.clock.t).toISOString(), leaseUntil: new Date(c.clock.t + 120_000).toISOString() })).toBe(true);
    await b.m.check('start', { claim: true });
    expect(b.m.report().status).toBe('checking');
    expect(c.api.calls).toHaveLength(0);
    c.clock.t += 121_000;
    await b.m.check('scheduled', { claim: true });
    expect(b.m.report().status).toBe('valid');
    expect(ops(c.api)).toEqual(['activate']);

    // Licence server errors: the retries move between instances and still back off 1, 2, 4 minutes.
    c.api.serverError = true;
    c.clock.t = T0 + DAY + 200_000;
    const waits: number[] = [];
    for (const x of [a, b, a]) {
      const r = await x.m.check('scheduled', { claim: true });
      waits.push(Date.parse(r.nextCheckAt!) - c.clock.t);
      c.clock.t = Date.parse(r.nextCheckAt!) + 1;
    }
    expect(waits[0]).toBeGreaterThanOrEqual(60_000);
    expect(waits[1]).toBeGreaterThanOrEqual(120_000);
    expect(waits[2]).toBeGreaterThanOrEqual(240_000);
    expect(ops(c.api).filter((o) => o === 'validate')).toHaveLength(3);
    expect(await b.m.refresh()).toMatchObject({ status: 'grace', checkedBy: 'api-1' });
  });

  it('a key change is checked once: the instance that sees it first activates, the others use the stored answer', async () => {
    const shared = { repos: createMemoryRepositories(), api: new MockApi([{ key: KEY }, { key: KEY2, limit: null }]), clock: { t: T0 } };
    const a = instance('api-1', shared);
    const b = instance('api-2', shared);
    await Promise.all([a.m.init(), b.m.init()]);
    await Promise.all([a.m.check('start', { claim: true }), b.m.check('start', { claim: true })]);
    shared.clock.t += 60_000;
    a.keyRef.value = KEY2;
    b.keyRef.value = KEY2;
    a.m.keyChanged();
    await a.m.check('key changed', { claim: true }); // the running check
    b.m.keyChanged();
    await b.m.check('key changed', { claim: true });
    expect(b.m.report()).toMatchObject({ status: 'valid', key: 'ZZZZZ-*****-*****-*****-*****' });
    expect(shared.api.calls.map((x) => `${x.op}:${x.key.slice(0, 5)}`)).toEqual(['activate:ABCDE', 'activate:ZZZZZ']);
  });

  it('instances configured with different keys do not take turns activating them; the conflict is logged', async () => {
    const shared = { repos: createMemoryRepositories(), api: new MockApi([{ key: KEY }, { key: KEY2, limit: null }]), clock: { t: T0 } };
    const a = instance('api-1', shared);
    const b = instance('api-2', shared, { key: KEY2 });
    await Promise.all([a.m.init(), b.m.init()]);
    await Promise.all([a.m.check('start', { claim: true }), b.m.check('start', { claim: true })]);
    for (let i = 0; i < 5; i++) {
      shared.clock.t += 60_000;
      await Promise.all([a.m.check('refresh', { claim: true }), b.m.check('refresh', { claim: true })]);
    }
    expect(shared.api.calls).toHaveLength(1);
    const loser = shared.api.calls[0]!.key === KEY ? b : a;
    expect(loser.logs.filter((l) => /^error: licence: another instance of this deployment checked a different licence key/.test(l))).toHaveLength(1);
    expect(loser.m.report()).toMatchObject({ status: 'invalid', reason: 'not_checked', renderAllowed: false });
  });

  it('the hourly clock marker never writes an older state over a newer check (compare-and-set)', async () => {
    const c = cluster(1, 0);
    const a = c.apis[0]!;
    await a.m.init();
    const stale = (await c.repos.licence.get())!;
    c.clock.t += 1000;
    await a.m.check('start', { claim: true });
    expect(await c.repos.licence.save({ ...stale, highWaterAt: new Date(T0 + 1).toISOString() }, { ifUpdatedAt: stale.updatedAt })).toBe(false);
    c.clock.t += 3_600_000;
    await a.m.markClock('timer');
    expect(a.m.report().status).toBe('valid');
    expect((await c.repos.licence.get())!.highWaterAt).toBe(new Date(T0 + 1000 + 3_600_000).toISOString());
  });

  it('services: a worker claims no render job while the stored state disallows renders and says why', async () => {
    const { dir, cleanup } = tempDir('reelforge-licence-workers-');
    try {
      const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
      const repos = createMemoryRepositories();
      const api = new MockApi();
      const clock = { t: Date.now() };
      const env = { RENDERWELD_SECRET_KEY: SECRET, RENDERWELD_LICENCE_KEY: KEY, RENDERWELD_STORAGE_LOCAL_SHARED: 'true' };
      const mk = (role: 'api' | 'worker', workerId: string, licenceApi: LicenceApi) =>
        RenderWeldService.create(new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas')), {
          repositories: repos,
          dataDir: join(dir, 'data'),
          configSources: { env: { ...env, RENDERWELD_ROLE: role } },
          licence: { api: licenceApi, now: () => clock.t, refreshMs: 50 },
          queue: { workerId, pollMs: 50, leaseMs: 4000, heartbeatMs: 300 },
          maintenance: false,
        });
      const worker = await mk('worker', 'worker-1', forbidden);
      expect(worker.getLicence()).toMatchObject({ status: 'checking', reason: 'waiting_for_api', renderAllowed: false });
      const apiSvc = await mk('api', 'api-1', api);
      await apiSvc.licence.assertRenderAllowed();
      await apiSvc.createProject(sample);
      const job = await apiSvc.startRender('sample-reel');
      let done = await apiSvc.waitForJob(job.id, 30);
      for (let i = 0; i < 3 && !['succeeded', 'failed'].includes(done.status); i++) done = await apiSvc.waitForJob(job.id, 30);
      expect(done.status).toBe('succeeded');
      expect(done.workerId).toBe('worker-1');

      // Revoked at the next check: the api refuses to enqueue, and a job already queued is not claimed.
      api.keys.get(KEY)!.status = 'revoked';
      await apiSvc.licence.check('manual');
      await expect(apiSvc.startRender('sample-reel')).rejects.toMatchObject({ code: 'licence_invalid' });
      for (let i = 0; i < 50 && worker.getLicence().renderAllowed; i++) await new Promise((r) => setTimeout(r, 50));
      expect(worker.getLicence()).toMatchObject({ status: 'invalid', reason: 'revoked', renderAllowed: false });
      const queued = await apiSvc.jobs.submit('render', { ...(done.params as object), runId: `run_${Date.now().toString(36)}0123456789` }, { projectId: 'sample-reel' });
      await new Promise((r) => setTimeout(r, 500));
      expect((await apiSvc.jobs.get(queued.id)).status).toBe('queued');
      expect(worker.jobs.status().paused).toMatch(/the licence does not allow renders \(invalid, revoked\)/);

      // Valid again (a new activation): the worker claims it within a refresh.
      api.keys.get(KEY)!.status = 'active';
      await apiSvc.activateLicence(undefined);
      let j = await apiSvc.waitForJob(queued.id, 30);
      for (let i = 0; i < 3 && !['succeeded', 'failed'].includes(j.status); i++) j = await apiSvc.waitForJob(queued.id, 30);
      expect(j.status, JSON.stringify(j.error)).toBe('succeeded');
      expect(api.calls.map((x) => x.op)).toEqual(['activate', 'validate', 'activate']);
      for (const svc of [worker, apiSvc]) {
        await svc.jobs.shutdown(1000);
        await svc.stop();
      }
    } finally {
      cleanup();
    }
  }, 120_000);
});
