import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { parse } from 'parse5';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetStore,
  BuildBaseLicenceClient,
  ConfigError,
  DEV_BUILD,
  KeyStore,
  LicenceManager,
  SceneMarkupError,
  assertSafeSceneFragment,
  checkTargetUrl,
  createMemoryRepositories,
  isPrivateAddress,
  loadBuild,
  prepareSceneDocument,
  renderChildEnv,
  resolveConfig,
  sanitizeSourceUrl,
  sceneTimeoutCapMs,
  scrubSecretEnv,
  secretEnvNames,
  weakKeyReason,
  type LicenceAnswer,
  type LicenceApi,
} from '../src/index';
import { tempDir } from './helpers';

/**
 * Security hardening from the private security review (SEC-01..SEC-20; D-085..D-089).
 * Test ids SECT-xx; the list is in docs/security/HARDENING.md.
 */
const { dir, cleanup } = tempDir('reelforge-sec-');
afterAll(cleanup);

const CSP = "default-src 'self'; connect-src 'self'";
const HEAD = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>body{margin:0}</style>`;

/** What a browser builds from `html`: every http-equiv meta, and the first element of <head>. */
function inspect(html: string) {
  const metas: Array<{ inHead: boolean; content?: string }> = [];
  let firstHeadElement: string | undefined;
  const walk = (n: any, inHead: boolean) => {
    if (n.tagName === 'head') {
      firstHeadElement = n.childNodes.find((c: any) => c.tagName)?.attrs?.map((a: any) => `${a.name}=${a.value}`).join(' ');
    }
    if (n.tagName === 'meta' && n.attrs.some((a: any) => a.name === 'http-equiv')) {
      metas.push({ inHead, content: n.attrs.find((a: any) => a.name === 'content')?.value });
    }
    for (const c of n.childNodes ?? []) walk(c, inHead || n.tagName === 'head');
    if (n.content) walk(n.content, inHead);
  };
  walk(parse(html), false);
  return { metas, firstHeadElement };
}

describe('security: scene markup (SEC-01)', () => {
  const root = '<div data-composition-id="main" data-width="320" data-height="320"><p>x</p></div>';
  // Full documents of different shapes: ReelForge's head must always end up first in the parsed <head>.
  const tricky: Record<string, string> = {
    'document shape 1': `<html><!-- <head> --><head><title>x</title></head><body>${root}</body></html>`,
    'document shape 2': `<html><head><title><head></title></head><body>${root}</body></html>`,
    'document shape 3': `<html data-x="<head>"><head></head><body>${root}</body></html>`,
    'document shape 4': `<html><noscript><head></noscript><head></head><body>${root}</body></html>`,
    'document shape 5': `<html><![CDATA[<head>]]><head></head><body>${root}</body></html>`,
    'document shape 6': `<HTML  ><HEAD\n data-a=1 ><TITLE>t</TITLE></HEAD ><BODY>${root}</BODY></HTML>`,
    'document shape 7': `<html><body>${root}</body></html>`,
    'document shape 8': `<!-- <html><head> --><html><head></head><body>${root}</body></html>`,
    'document shape 9': `<html><head><script>var s="<head>"</script></head><body>${root}</body></html>`,
  };
  for (const [name, doc] of Object.entries(tricky)) {
    it(`SECT-01 ${name}: the CSP is the first element of the parsed <head> and the only policy`, () => {
      const out = prepareSceneDocument(doc, HEAD, CSP).html;
      const r = inspect(out);
      expect(r.firstHeadElement).toBe('charset=utf-8');
      expect(r.metas).toEqual([{ inHead: true, content: CSP }]);
      expect(out).not.toContain('<!--');
    });
  }

  it('SECT-02 documents that bring their own policy are refused (meta http-equiv, base; also in template and iframe srcdoc)', () => {
    const refused = [
      `<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>${root}</body></html>`,
      `<html><head><META HTTP-EQUIV=refresh content="0;url=http://example.com"></head><body>${root}</body></html>`,
      `<html><head><base href="http://example.com/"></head><body>${root}</body></html>`,
      `<html><body>${root}<template><meta http-equiv="refresh" content="0"></template></body></html>`,
      `<html><body>${root}<iframe srcdoc="<meta http-equiv='refresh' content='0;url=http://x'>"></iframe></body></html>`,
    ];
    for (const doc of refused) expect(() => prepareSceneDocument(doc, HEAD, CSP), doc).toThrow(SceneMarkupError);
  });

  it('SECT-03 fragments are checked the same way; ordinary markup passes', () => {
    expect(() => assertSafeSceneFragment('<meta http-equiv="refresh" content="0;url=data:text/html,x">')).toThrow(/http-equiv/);
    expect(() => assertSafeSceneFragment('<div><base href="//example.com"></div>')).toThrow(/<base>/);
    expect(() => assertSafeSceneFragment('<div class="a"><meta name="viewport" content="x"><svg><circle r="3"/></svg></div>')).not.toThrow();
  });

  it('SECT-04 unusual attribute names, comments and noscript are dropped; normal attributes are kept', () => {
    const out = prepareSceneDocument(`<html lang="en" onload="x()"><head></head><body><p a<b="1" data-ok="y" class="c">t</p><noscript><p>n</p></noscript><!-- c --></body></html>`, HEAD, CSP).html;
    expect(out).toContain('<html lang="en">');
    expect(out).toContain('data-ok="y"');
    expect(out).toContain('class="c"');
    expect(out).not.toContain('a<b');
    expect(out).not.toContain('noscript');
    expect(out).not.toContain('<!--');
  });
});

describe('security: SSRF guard for asset imports (SEC-05)', () => {
  it.each([
    ['::127.0.0.1', true, 'IPv4-compatible'],
    ['::7f00:1', true, 'IPv4-compatible, hex'],
    ['::a9fe:a9fe', true, 'IPv4-compatible metadata address'],
    ['::ffff:127.0.0.1', true, 'IPv4-mapped'],
    ['::ffff:7f00:1', true, 'IPv4-mapped, hex'],
    ['::ffff:0:7f00:1', true, 'SIIT'],
    ['64:ff9b::7f00:1', true, 'NAT64 well-known'],
    ['64:ff9b:1::a9fe:a9fe', true, 'NAT64 local-use'],
    ['2002:7f00:1::', true, '6to4'],
    ['2002:808:808::1', true, '6to4 of a public address'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', true, 'Teredo'],
    ['fec0::1', true, 'site-local'],
    ['fe80::1%eth0', true, 'link-local with zone'],
    ['3fff::1', true, 'documentation (2024)'],
    ['::', true, 'unspecified'],
    ['::1', true, 'loopback'],
    ['::ffff:8.8.8.8', false, 'IPv4-mapped public'],
    ['2606:4700:4700::1111', false, 'public IPv6'],
    ['2001:4860:4860::8888', false, 'public IPv6 in 2001::/16 outside the IETF block'],
    ['8.8.8.8', false, 'public IPv4'],
    ['not-an-ip', true, 'not an address'],
  ])('SECT-05 %s is private: %s (%s)', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe('security: the webhook client shares the improved guard (SEC-05)', () => {
  it('SECT-16 webhook targets on IPv6 transition, mapped or site-local addresses are refused when saved', () => {
    const policy = { allowHttp: false, allowPrivateNetworks: false };
    for (const url of ['https://[::127.0.0.1]/h', 'https://[::ffff:7f00:1]/h', 'https://[64:ff9b:1::a9fe:a9fe]/h', 'https://[2002:7f00:1::]/h', 'https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/h', 'https://[fec0::1]/h']) {
      expect(() => checkTargetUrl(url, policy), url).toThrow(/private, loopback and link-local/);
    }
    expect(checkTargetUrl('https://[2606:4700:4700::1111]/h', policy).hostname).toBe('[2606:4700:4700::1111]');
  });
});

describe('security: credentials in stored asset sources (SEC-08)', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), randomBytes(32)]);
    server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(png));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('SECT-06 the stored source keeps scheme, host and path only (no userinfo, query or fragment)', async () => {
    expect(sanitizeSourceUrl('https://u:p@bucket.s3.amazonaws.com/a/b.png?X-Amz-Signature=abc&X-Amz-Credential=k#frag')).toBe('https://bucket.s3.amazonaws.com/a/b.png');
    expect(sanitizeSourceUrl('https://acct.blob.core.windows.net/c/x.mp3?sv=1&se=2&sig=SECRET')).toBe('https://acct.blob.core.windows.net/c/x.mp3');
    const store = new AssetStore(createMemoryRepositories().assets, join(dir, 'assets'), { maxBytes: 64 * 1024, timeoutMs: 2000, maxRedirects: 0, allowInsecureForTests: true });
    const a = await store.fromUrl(`${base}/logo.png?X-Goog-Signature=SECRETSIG&token=abc`);
    expect(a.source).toBe(`${base}/logo.png`);
    expect(JSON.stringify(await store.list())).not.toContain('SECRETSIG');
  });

  it('SECT-06b unparseable sources are still stripped, and hostile inputs are handled in linear time', () => {
    // Not a valid URL (no scheme), so the string fallback runs.
    expect(sanitizeSourceUrl('//u:p@host.example/a/b.png?sig=SECRET#frag')).toBe('//host.example/a/b.png');
    expect(sanitizeSourceUrl('relative/path.png?token=x')).toBe('relative/path.png');
    expect(sanitizeSourceUrl('//host.example/a@b/c.png')).toBe('//host.example/a@b/c.png');
    const t0 = performance.now();
    sanitizeSourceUrl('#'.repeat(200_000));
    sanitizeSourceUrl('//' + '@'.repeat(200_000));
    isPrivateAddress('%'.repeat(200_000));
    isPrivateAddress('fe80::1' + '%'.repeat(200_000));
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('security: render child processes get no secrets (SEC-03)', () => {
  const secrets: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    DATABASE_URL: 'postgresql://u:dbpass-SECRET@db/x',
    REELFORGE_DATABASE_URL: 'postgresql://u:dbpass-SECRET@db/y',
    REELFORGE_SECRET_KEY: 'secret-key-SECRET-0123456789abcdefghij',
    REELFORGE_SECRET_KEY_FILE: '/run/secrets/key',
    REELFORGE_BOOTSTRAP_KEY: 'rf_bootstrap_SECRET',
    REELFORGE_ELEVENLABS_API_KEY: 'sk_SECRET_1',
    ELEVENLABS_API_KEY: 'sk_SECRET_2',
    REELFORGE_LICENCE_KEY: 'LICEN-SECRE-T0000-00000-00000',
    REELFORGE_S3_SECRET_ACCESS_KEY: 's3-SECRET',
    REELFORGE_METRICS_TOKEN: 'metrics-SECRET',
    REELFORGE_OTLP_HEADERS: 'x-key=SECRET',
    AWS_SECRET_ACCESS_KEY: 'aws-SECRET',
    GITHUB_TOKEN: 'ghp_SECRET',
  };
  const childEnv = (env: NodeJS.ProcessEnv) => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: env as Record<string, string>, encoding: 'utf8' });
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout) as Record<string, string>;
  };

  it('SECT-07 renderChildEnv: a spawned render process sees only allowlisted variables, no secret name or value', () => {
    const seen = childEnv(renderChildEnv(secrets, { HYPERFRAMES_BROWSER_PATH: '/bin/chrome' }));
    expect(seen.PATH).toBe(process.env.PATH);
    expect(seen.LANG).toBe('C.UTF-8');
    expect(seen.HYPERFRAMES_BROWSER_PATH).toBe('/bin/chrome');
    const dump = JSON.stringify(seen);
    expect(dump).not.toMatch(/SECRET/);
    for (const name of Object.keys(secrets).filter((k) => !['PATH', 'HOME', 'LANG'].includes(k))) expect(seen[name], name).toBeUndefined();
  });

  it('SECT-08 scrubSecretEnv: every secret setting (aliases and _FILE included) leaves the process environment', () => {
    const env = { ...secrets };
    const removed = scrubSecretEnv(env);
    expect(removed).toEqual(expect.arrayContaining(['DATABASE_URL', 'REELFORGE_SECRET_KEY', 'REELFORGE_SECRET_KEY_FILE', 'ELEVENLABS_API_KEY', 'REELFORGE_LICENCE_KEY', 'REELFORGE_BOOTSTRAP_KEY']));
    const seen = childEnv(env);
    for (const n of secretEnvNames()) expect(seen[n], n).toBeUndefined();
    expect(seen.PATH).toBe(process.env.PATH);
  });
});

describe('security: bootstrap key strength (SEC-20)', () => {
  it('SECT-09 short or low-entropy keys are refused with a clear reason; generated keys pass', async () => {
    expect(weakKeyReason('rf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatch(/not random enough/);
    expect(weakKeyReason('rf_abababababababababababababababab')).toMatch(/not random enough/);
    expect(weakKeyReason('rf_0123456789abcdefghij')).toMatch(/at least 32/);
    expect(weakKeyReason('nope')).toMatch(/rf_/);
    for (let i = 0; i < 200; i++) {
      expect(weakKeyReason(`rf_${randomBytes(24).toString('hex')}`)).toBeNull();
      expect(weakKeyReason(`rf_${randomBytes(32).toString('base64url')}`)).toBeNull();
    }
    expect(() => resolveConfig({ env: { REELFORGE_BOOTSTRAP_KEY: 'rf_aaaaaaaaaaaaaaaaaaaa' } })).toThrow(ConfigError);
    try {
      resolveConfig({ env: { REELFORGE_BOOTSTRAP_KEY: 'rf_aaaaaaaaaaaaaaaaaaaa' } });
    } catch (e) {
      expect((e as Error).message).toMatch(/REELFORGE_BOOTSTRAP_KEY: needs at least 32 random characters/);
      expect((e as Error).message).not.toContain('rf_aaaa');
    }
    const keys = new KeyStore(createMemoryRepositories().keys);
    await expect(keys.bootstrap('rf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toMatchObject({ code: 'bad_request' });
    expect(await keys.count()).toBe(0);
  });
});

describe('security: render time limit (SEC-02)', () => {
  it('SECT-10 the per-scene hard limit defaults to 15 minutes and is clamped to 30 s .. 1 h', () => {
    expect(sceneTimeoutCapMs({})).toBe(900_000);
    expect(sceneTimeoutCapMs({ REELFORGE_RENDER_SCENE_TIMEOUT_SECONDS: '120' })).toBe(120_000);
    expect(sceneTimeoutCapMs({ REELFORGE_RENDER_SCENE_TIMEOUT_SECONDS: '999999' })).toBe(3_600_000);
    expect(sceneTimeoutCapMs({ REELFORGE_RENDER_SCENE_TIMEOUT_SECONDS: '1' })).toBe(30_000);
    expect(() => resolveConfig({ env: { REELFORGE_RENDER_SCENE_TIMEOUT_SECONDS: '7200' } })).toThrow(ConfigError);
  });
});

describe('security: release edition fails closed (SEC-04)', () => {
  it('SECT-11 a release image without build-info.json, or with a dev one, refuses to start; source checkouts stay dev', () => {
    const missing = join(dir, 'no-build-info.json');
    const dev = join(dir, 'dev-build-info.json');
    writeFileSync(dev, JSON.stringify({ edition: 'dev', locked: {} }));
    expect(loadBuild(missing, 'dev')).toBe(DEV_BUILD);
    expect(() => loadBuild(missing, 'release')).toThrow(/release image.*refuses to start/);
    expect(() => loadBuild(dev, 'release')).toThrow(/describes a "dev" build/);
    const rel = join(dir, 'release-build-info.json');
    writeFileSync(rel, JSON.stringify({ edition: 'release', locked: { 'licence.mode': 'required', 'licence.serverUrl': 'https://licence.example.test', 'licence.orgId': 'aaaaaaaaaaaaaaaaaaaaaaaa' } }));
    expect(loadBuild(rel, 'release').edition).toBe('release');
  });
});

describe('security: stored licence state integrity and clock (SEC-04)', () => {
  const KEY = 'ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2';
  const T0 = Date.parse('2026-11-21T12:00:00.000Z');
  const DAY = 86_400_000;
  class Api implements LicenceApi {
    offline = false;
    serverSkewMs = 0;
    constructor(private readonly clock: { t: number }) {}
    private answer(instance: string): LicenceAnswer {
      if (this.offline) throw Object.assign(new Error('licence server unreachable'), { name: 'LicenceServerError' });
      return {
        valid: true,
        reason: null,
        key: { status: 'active', activations: 1, activationLimit: 1, expiresAt: null },
        item: { id: 'itm', title: 'ReelForge' },
        instance: { instance, activatedAt: new Date(T0).toISOString() },
        serverTime: new Date(this.clock.t + this.serverSkewMs).toISOString(),
      };
    }
    async validate(_k: string, instance = '') {
      return this.answer(instance);
    }
    async activate(_k: string, instance: string) {
      return this.answer(instance);
    }
    async deactivate(_k: string, instance: string) {
      return this.answer(instance);
    }
  }
  const manager = (repos: ReturnType<typeof createMemoryRepositories>, api: Api, clock: { t: number }, sealSecret?: string) => {
    const logs: string[] = [];
    const m = new LicenceManager({
      repo: repos.licence,
      api,
      key: () => ({ value: KEY, source: 'env' }),
      mode: 'required',
      graceDays: 14,
      licenceServer: { url: 'https://licence.example.test', orgId: 'org' },
      now: () => clock.t,
      timers: false,
      log: (level, line) => logs.push(`${level}: ${line}`),
      sealSecret,
    });
    return { m, logs };
  };
  const SECRET = 'seal-secret-0123456789-abcdefghijklmnop';

  it('SECT-12 a hand-edited licence row is rejected and needs an online check; an untouched one keeps its offline grace across restarts', async () => {
    const repos = createMemoryRepositories();
    const clock = { t: T0 };
    const api = new Api(clock);
    const a = manager(repos, api, clock, SECRET);
    await a.m.init();
    expect((await a.m.check('start')).status).toBe('valid');
    // Restart offline, untouched: grace.
    api.offline = true;
    clock.t += 2 * DAY;
    const b = manager(repos, api, clock, SECRET);
    await b.m.init();
    expect((await b.m.check('start')).status).toBe('grace');
    // Edit the row (a forged "valid" answer and a fresh last success), restart offline: refused.
    const stored = (await repos.licence.get())!;
    await repos.licence.save({ ...stored, lastSuccessAt: new Date(clock.t).toISOString(), highWaterAt: new Date(clock.t).toISOString(), answer: { ...(stored.answer as object), valid: true, item: { id: 'x', title: 'forged' } } });
    const c = manager(repos, api, clock, SECRET);
    await c.m.init();
    const r = await c.m.check('start');
    expect(r).toMatchObject({ status: 'invalid', reason: 'state_untrusted', renderAllowed: false });
    expect(c.logs.some((l) => /failed its integrity check/.test(l))).toBe(true);
    // Online again: a fresh answer is trusted and sealed.
    api.offline = false;
    expect((await c.m.check('scheduled')).status).toBe('valid');
    api.offline = true;
    const d = manager(repos, api, clock, SECRET);
    await d.m.init();
    expect((await d.m.check('start')).status).toBe('grace');
  });

  it('SECT-13 the seal is keyed by REELFORGE_SECRET_KEY: a state sealed with another key is not trusted', async () => {
    const repos = createMemoryRepositories();
    const clock = { t: T0 };
    const api = new Api(clock);
    const a = manager(repos, api, clock, SECRET);
    await a.m.init();
    await a.m.check('start');
    api.offline = true;
    const b = manager(repos, api, clock, 'another-secret-0123456789-abcdefghijkl');
    await b.m.init();
    expect(await b.m.check('start')).toMatchObject({ status: 'invalid', reason: 'state_untrusted' });
  });

  it('SECT-14 a local clock behind the licence server\'s time by more than the tolerance gets no grace (clock_skew)', async () => {
    const clock = { t: T0 };
    const api = new Api(clock);
    api.serverSkewMs = 2 * DAY; // the host clock was set back two days
    const { m } = manager(createMemoryRepositories(), api, clock, SECRET);
    await m.init();
    expect(await m.check('start')).toMatchObject({ status: 'invalid', reason: 'clock_skew', renderAllowed: false });
    api.serverSkewMs = 60_000; // within the 10-minute tolerance
    expect((await m.check('scheduled')).status).toBe('valid');
  });

  it('SECT-15 the licence client records the server\'s Date header without changing the request', async () => {
    let sent: { url: string; body: string; headers: Record<string, string> } | undefined;
    const fetchMock = (async (url: string, init: RequestInit) => {
      sent = { url, body: String(init.body), headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ valid: true, reason: null }), { status: 200, headers: { 'content-type': 'application/json', date: 'Sat, 21 Nov 2026 12:00:00 GMT' } });
    }) as unknown as typeof fetch;
    const client = new BuildBaseLicenceClient({ serverUrl: 'https://licence.example.test', orgId: 'org', fetch: fetchMock });
    const answer = await client.validate(KEY, 'rf-1');
    expect(answer.serverTime).toBe('2026-11-21T12:00:00.000Z');
    expect(sent!.url).toBe('https://licence.example.test/api/v1/licenses/org/validate');
    expect(JSON.parse(sent!.body)).toEqual({ key: KEY, instance: 'rf-1' });
    expect(Object.keys(sent!.headers).sort()).toEqual(['accept', 'content-type']);
  });
});
