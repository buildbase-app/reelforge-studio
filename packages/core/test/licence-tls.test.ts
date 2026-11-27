/**
 * The release build's licence calls trust only Node's built-in root
 * certificates (#108). Before, an operator could point the licence server's
 * name at their own machine (a hosts entry, `docker run --add-host`), trust a
 * home-made CA with NODE_EXTRA_CA_CERTS (or turn verification off with
 * NODE_TLS_REJECT_UNAUTHORIZED=0) and answer `{ valid: true }` for any key.
 *
 * The certificates are made with `openssl` for this run only (a throwaway CA
 * and a certificate for localhost); nothing is kept.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server } from 'node:https';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BuildBaseLicenceClient,
  LicenceServerError,
  RuntimeConfig,
  builtInRootsFetch,
  createLicenceManager,
  createMemoryRepositories,
  httpsFetchTrusting,
  parseBuildInfo,
  proxyFor,
} from '../src/index';
import { tempDir } from './helpers';

const { dir, cleanup } = tempDir('renderweld-licence-tls-');
const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MADE_UP_KEY = 'MADEU-PXXXX-XXXXX-XXXXX-XXXXX';
const SECRET = 'licence-tls-test-0123456789abcdefghijklmnop';

let caPem = '';
let server: Server;
let base = '';
let port = 0;
const seen: string[] = [];
let proxy: HttpServer;
let proxyUrl = '';
const tunnels: Array<{ target: string; auth?: string }> = [];
const sockets = new Set<{ destroy(): void }>();
const defaultCAs = getCACertificates('default');

function openssl(...args: string[]) {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

beforeAll(async () => {
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=Home-made licence CA');
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost');
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  openssl('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.crt', '-days', '2', '-extfile', 'ext.cnf');
  caPem = readFileSync(join(dir, 'ca.crt'), 'utf8');
  // A fake licence server: every key is valid. /moved redirects.
  server = createServer({ key: readFileSync(join(dir, 'srv.key')), cert: readFileSync(join(dir, 'srv.crt')) }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      if (req.url?.startsWith('/moved')) {
        res.writeHead(302, { location: 'https://localhost/elsewhere' });
        res.end();
        return;
      }
      const { instance } = body ? (JSON.parse(body) as { instance?: string }) : {};
      res.writeHead(200, { 'content-type': 'application/json', date: new Date().toUTCString() });
      res.end(JSON.stringify({ valid: true, reason: null, key: { status: 'active', activations: 1, activationLimit: null, expiresAt: null }, item: { id: 'itm_fake', title: 'Fake' }, instance: instance ? { instance, activatedAt: new Date().toISOString() } : null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  base = `https://localhost:${port}`;
  // An egress proxy that tunnels (CONNECT) and never sees inside TLS; "deny.test" targets are refused.
  proxy = createHttpServer((_req, res) => res.writeHead(405).end());
  proxy.on('connect', (req, client) => {
    tunnels.push({ target: req.url ?? '', auth: req.headers['proxy-authorization'] });
    sockets.add(client);
    if (req.url?.startsWith('deny.test')) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = netConnect(port, '127.0.0.1', () => {
      sockets.add(upstream);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client).pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyUrl = `http://user:p%40ss@127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterEach(() => {
  setDefaultCACertificates(defaultCAs);
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  await new Promise((r) => proxy?.close(r));
  cleanup();
});

/** What NODE_EXTRA_CA_CERTS does at start-up: Node's default trust store also holds the home-made CA. */
function trustHomeMadeCA() {
  setDefaultCACertificates([...defaultCAs, caPem]);
}

const release = () => parseBuildInfo({ edition: 'release', locked: { 'licence.mode': 'required', 'licence.serverUrl': base, 'licence.orgId': ORG } });

describe('release licence calls trust only built-in root certificates (#108)', () => {
  it('LICT-1 the attack: with the home-made CA trusted, the default client takes a made-up key as valid', async () => {
    trustHomeMadeCA();
    const answer = await new BuildBaseLicenceClient({ serverUrl: base, orgId: ORG }).validate(MADE_UP_KEY);
    expect(answer.valid).toBe(true);
  });

  it('LICT-2 a release client refuses the same server: the certificate is not from a built-in root', async () => {
    trustHomeMadeCA();
    const before = seen.length;
    const client = new BuildBaseLicenceClient({ serverUrl: base, orgId: ORG, noRedirects: true, builtInRootsOnly: true });
    const err = await client.validate(MADE_UP_KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LicenceServerError);
    expect((err as LicenceServerError).kind).toBe('unreachable');
    expect((err as LicenceServerError).message).toMatch(/SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|CERT/);
    // The TLS handshake failed: the key never reached the fake server.
    expect(seen.length).toBe(before);
  });

  it('LICT-3 NODE_TLS_REJECT_UNAUTHORIZED=0 does not turn verification off for a release client', async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const err = await new BuildBaseLicenceClient({ serverUrl: base, orgId: ORG, builtInRootsOnly: true }).validate(MADE_UP_KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LicenceServerError);
    expect((err as LicenceServerError).kind).toBe('unreachable');
  });

  it('LICT-4 a release build activates against the fake server and stays invalid: renders refused', async () => {
    trustHomeMadeCA();
    const settings = new RuntimeConfig(createMemoryRepositories(), { env: { RENDERWELD_SECRET_KEY: SECRET, RENDERWELD_LICENCE_KEY: MADE_UP_KEY }, build: release() });
    await settings.load();
    expect(settings.current.config.licence.serverUrl).toBe(base);
    const repos = createMemoryRepositories();
    const lic = createLicenceManager(settings, repos, { log: () => {} });
    await lic.init();
    const r = await lic.activateNow();
    expect(r.status).toBe('invalid');
    expect(r.reason).toBe('unreachable');
    expect(r.renderAllowed).toBe(false);
    await expect(lic.assertRenderAllowed()).rejects.toMatchObject({ code: 'licence_invalid', status: 403 });
    lic.stop();
  });

  it('LICT-5 the same configuration as a dev build still reaches it (only the release build is pinned)', async () => {
    trustHomeMadeCA();
    const settings = new RuntimeConfig(createMemoryRepositories(), {
      env: { RENDERWELD_SECRET_KEY: SECRET, RENDERWELD_LICENCE_KEY: MADE_UP_KEY, RENDERWELD_LICENCE_SERVER_URL: base, RENDERWELD_LICENCE_ORG_ID: ORG },
    });
    await settings.load();
    const lic = createLicenceManager(settings, createMemoryRepositories(), { log: () => {} });
    await lic.init();
    expect((await lic.activateNow()).status).toBe('valid');
    lic.stop();
  });

  it('LICT-6 the pinned fetch: answers, headers and the body go through; redirects and plain http are refused', async () => {
    const f = httpsFetchTrusting([caPem]);
    const res = await f(`${base}/api/v1/licenses/${ORG}/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'K', instance: 'rf-1' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('date')).toBeTruthy();
    expect(((await res.json()) as { instance: { instance: string } }).instance.instance).toBe('rf-1');
    expect(seen.at(-1)).toContain('"key":"K"');
    await expect(f(`${base}/moved`, { method: 'POST' })).rejects.toMatchObject({ cause: { code: expect.stringMatching(/redirect/) } });
    await expect(f('http://localhost:1/x')).rejects.toThrow(/must use https/);
    await expect(builtInRootsFetch('http://localhost:1/x')).rejects.toThrow(/must use https/);
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(f(`${base}/x`, { signal: ac.signal })).rejects.toThrow(/stop/);
  });

  it('LICT-7 behind an egress proxy (NODE_USE_ENV_PROXY=1, HTTPS_PROXY): a CONNECT tunnel with TLS end to end, still pinned', async () => {
    const env = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxyUrl };
    const before = tunnels.length;
    const res = await httpsFetchTrusting([caPem], env)(`${base}/api/v1/licenses/${ORG}/validate`, { method: 'POST', body: JSON.stringify({ key: 'K' }) });
    expect(res.status).toBe(200);
    expect(tunnels.slice(before)).toEqual([{ target: `localhost:${port}`, auth: `Basic ${Buffer.from('user:p@ss').toString('base64')}` }]);
    // The home-made CA trusted by Node and a tunnel: the built-in roots still refuse the certificate.
    trustHomeMadeCA();
    await expect(httpsFetchTrusting([...getCACertificates('bundled')], env)(`${base}/x`)).rejects.toMatchObject({ cause: { code: expect.stringMatching(/SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|CERT/) } });
    // A refused tunnel is an error, not an answer.
    await expect(httpsFetchTrusting([caPem], env)('https://deny.test/x')).rejects.toMatchObject({ cause: { code: 'PROXY_HTTP_403' } });
  });

  it('LICT-8 which proxy: only with NODE_USE_ENV_PROXY=1, NO_PROXY respected, http proxies only', () => {
    const u = new URL('https://api.console.buildbase.app/api/v1/licenses/x/validate');
    expect(proxyFor(u, { HTTPS_PROXY: 'http://p:3128' })).toBeUndefined();
    expect(proxyFor(u, { NODE_USE_ENV_PROXY: '1' })).toBeUndefined();
    expect(proxyFor(u, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://p:3128' })?.host).toBe('p:3128');
    expect(proxyFor(u, { NODE_USE_ENV_PROXY: '1', https_proxy: 'p:3128' })?.href).toBe('http://p:3128/');
    for (const NO_PROXY of ['*', 'buildbase.app', '.buildbase.app', '*.buildbase.app', 'api.console.buildbase.app:443', 'localhost, api.console.buildbase.app']) {
      expect(proxyFor(u, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://p:3128', NO_PROXY }), NO_PROXY).toBeUndefined();
    }
    for (const NO_PROXY of ['example.com', 'api.console.buildbase.app:8443', 'xbuildbase.app']) {
      expect(proxyFor(u, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://p:3128', NO_PROXY }), NO_PROXY).toBeDefined();
    }
    expect(() => proxyFor(u, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'https://p:3128' })).toThrow(/http:\/\/ proxy/);
  });
});
