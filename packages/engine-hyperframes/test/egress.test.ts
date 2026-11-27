import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinTheme } from '@renderweld/project-schema';
import { hyperframesEnv, renderHyperframesScene, startNetworkSink } from '../src/index';
import { externalNetworkCalls } from './strace-egress';

/**
 * #318: HyperFrames resolves web fonts with the CLI's own Node `fetch`
 * (fonts.googleapis.com, with the page's characters in `text=`), outside its
 * capture proxy. These tests prove that nothing leaves the machine: the guard
 * refuses the fetch, a refusing proxy that would see any request sees none,
 * and (where strace works) the render makes no connect() outside loopback.
 */

const browser = process.env.RENDERWELD_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const repoRoot = resolve(import.meta.dirname, '../../..');
const hasStrace = spawnSync('strace', ['-f', '-qq', '-yy', '-e', 'trace=connect', '-o', '/dev/null', 'true']).status === 0;
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
/** NODE_USE_ENV_PROXY (fetch and http through HTTP(S)_PROXY) exists from Node 22.21 and 24.5. */
const nodeHasEnvProxy = major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);

const dir = mkdtempSync(join(tmpdir(), 'reelforge-hf-egress-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn(`could not remove ${dir}: ${(e as Error).message}`);
  }
});

function run(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve_) => {
    execFile(process.execPath, args, { env, cwd, timeout: 60_000 }, (_err, stdout, stderr) => resolve_({ stdout, stderr }));
  });
}

// Each line prints what happened to one fetch: "<label> ok <status>" or "<label> refused <code>".
const FETCHES = (local: string) => `
const go = (label, url) => fetch(url).then((r) => console.log(label, 'ok', r.status), (e) => console.log(label, 'refused', e.cause?.code));
await go('css', 'https://fonts.googleapis.com/css2?family=Roboto:wght@400&text=Quarterly%20launch');
await go('woff2', 'https://fonts.gstatic.com/s/roboto/v1/x.woff2');
await go('other', 'https://cdn.example.com/x.js');
await go('local', '${local}');
`;

describe('SECT-41 the HyperFrames CLI process cannot fetch fonts (or anything) from the network (#318)', () => {
  it('the CLI environment preloads the fetch guard, keeps NODE_OPTIONS, routes Node proxies to the sink and keeps its font cache on the data volume', () => {
    const env = hyperframesEnv('/bin/chrome', '/data/cache', { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=2048' }, 'http://127.0.0.1:9');
    expect(env.NODE_OPTIONS).toMatch(/^--max-old-space-size=2048 --import=file:\/\/\S+\/egress-guard\.mjs$/);
    expect(env).toMatchObject({
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HYPERFRAMES_FONT_CACHE_DIR: '/data/cache/hyperframes/fonts',
    });
    expect(env.NO_PROXY).toContain('127.0.0.1');
    expect(hyperframesEnv('/bin/chrome', '/c', { PATH: '/usr/bin' }).NODE_OPTIONS).toMatch(/^--import=file:\/\/\S+\/egress-guard\.mjs$/);
  });

  it('Google Fonts and every other remote fetch are refused before a connection; a refusing proxy sees 0 requests; loopback still works', async () => {
    const local = createServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
    const localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}/`;
    const seen: string[] = [];
    const sink = await startNetworkSink((t) => seen.push(t));
    try {
      const env = hyperframesEnv('/bin/chrome', join(dir, 'unit'), { PATH: process.env.PATH }, sink.url);
      const guarded = await run(['--input-type=module', '-e', FETCHES(localUrl)], env);
      expect(guarded.stdout.trim().split('\n')).toEqual(['css refused ECONNREFUSED', 'woff2 refused ECONNREFUSED', 'other refused ECONNREFUSED', 'local ok 200']);
      expect(guarded.stderr).toContain('[RenderWeld:FONT_REFUSED] host=fonts.googleapis.com');
      expect(guarded.stderr).toContain('[RenderWeld:FONT_REFUSED] host=fonts.gstatic.com');
      expect(guarded.stderr).toContain('[RenderWeld:EGRESS_REFUSED] host=cdn.example.com');
      expect(guarded.stderr).not.toContain('Quarterly'); // the page text never appears, not even in the log
      expect(seen).toEqual([]); // the refusing proxy saw 0 requests

      // Control: the same process without the guard does try to leave, and the proxy
      // catches it (so "0 requests" above is a real observation, not a blind spot).
      if (nodeHasEnvProxy) {
        const unguarded = await run(['--input-type=module', '-e', FETCHES(localUrl)], { ...env, NODE_OPTIONS: '' });
        expect(unguarded.stdout).toMatch(/^css (ok 403|refused)/m);
        expect(seen).toContain('fonts.googleapis.com:443');
      }
    } finally {
      await sink.close();
      local.close();
    }
  });
});

describe('SECT-43 the strace egress check (#318, D-111)', () => {
  // The line CI saw on a runner with an IPv6 stack but no IPv6 route (job 137840212606), as `-yy` prints it.
  const probe = '14841 connect(24<UDPv6:[5531201]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:4860:4860::8888", &sin6_addr), sin6_scope_id=0}, 28) = -1 ENETUNREACH (Network is unreachable)';

  it("allows only Chromium's IPv6 reachability check: a UDP connect() that sends nothing", () => {
    expect(externalNetworkCalls(probe)).toEqual([]);
    expect(externalNetworkCalls(probe.replace('= -1 ENETUNREACH (Network is unreachable)', '= 0'))).toEqual([]);
    expect(externalNetworkCalls('7 connect(5<TCP:[9]>, {sa_family=AF_INET, sin_port=htons(41231), sin_addr=inet_addr("127.0.0.1")}, 16) = 0')).toEqual([]);
  });

  it('counts every other connect() or send outside loopback, whatever its result', () => {
    const leaks = [
      // the same line without -yy (as CI printed it): the socket type is unknown, so it counts
      probe.replace('<UDPv6:[5531201]>', ''),
      // DNS over HTTPS to the same address is TCP
      probe.replace('UDPv6', 'TCPv6'),
      probe.replace('2001:4860:4860::8888', '2001:4860:4860::8844'),
      probe.replace('htons(443)', 'htons(853)'),
      '9 connect(31<TCP:[77]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("142.251.183.95")}, 16) = -1 EINPROGRESS (Operation now in progress)',
      '9 connect(31<UDP:[78]>, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("8.8.8.8")}, 16) = 0',
      '9 connect(31<UDP:[79]>, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("127.0.0.53")}, 16) = 0', // a DNS lookup, even via a local resolver
      '9 sendto(31<UDP:[80]>, "x", 1, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("8.8.4.4")}, 16) = 1',
      '9 sendto(31<UDPv6:[[2001:db8::2]:5000->[2001:4860:4860::8888]:443]>, "x", 1, 0, NULL, 0) = 1',
    ];
    for (const line of leaks) expect(externalNetworkCalls(line), line).toEqual([line]);
    // anything sent on the probe socket after its connect()
    const send = '14841 sendmsg(24<UDPv6:[5531201]>, {msg_name=NULL, msg_namelen=0, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1}, 0) = 1';
    expect(externalNetworkCalls(`${probe}\n${send}`)).toEqual([send]);
  });
});

describe.skipIf(!hasBrowser)('SECT-42 a HyperFrames scene that names a missing web font renders offline (needs RENDERWELD_CHROMIUM_PATH)', () => {
  const theme = { ...builtinTheme('default')!.tokens, fontFamily: '"Roboto", sans-serif' };

  it('renders with the fallback font; the font fetch was refused and nothing reached the sink (it is also the CLI\'s HTTP(S)_PROXY)', async () => {
    const log: string[] = [];
    // A fresh cache: no font downloaded earlier can hide the fetch.
    await renderHyperframesScene({
      scene: { id: 'font', engine: 'hyperframes', template: 'hyperframes-title', durationFrames: 15, props: { headline: 'Quarterly launch' } },
      output: { width: 320, height: 320, fps: 30, format: 'mp4' },
      theme,
      out: join(dir, 'font.mp4'),
      workDir: join(dir, 'w-font'),
      cacheDir: join(dir, 'cache-font'),
      log: (l) => log.push(l),
    });
    expect(existsSync(join(dir, 'font.mp4'))).toBe(true);
    // The guard refused HyperFrames' Google Fonts request (any request that reached the
    // sink would have failed the render with a network error instead).
    expect(log.join('\n')).toMatch(/not installed and was not downloaded/);
  }, 300_000);

  it.runIf(hasStrace)('strace: the whole render (CLI, browser, children) connects and sends nothing outside loopback and makes no DNS lookup', async () => {
    const out = join(dir, 'strace');
    const traceFile = join(dir, 'strace-connect.txt');
    const res = await new Promise<{ stdout: string; stderr: string }>((resolve_) => {
      execFile(
        'strace',
        ['-f', '-qq', '-yy', '-e', 'trace=connect,sendto,sendmsg,sendmmsg', '-o', traceFile, process.execPath, '--import', 'tsx', join(import.meta.dirname, 'fixtures', 'render-missing-font.mts'), out],
        { cwd: repoRoot, env: { ...process.env, RENDERWELD_CHROMIUM_PATH: browser }, timeout: 280_000, maxBuffer: 16 * 1024 * 1024 },
        (_e, stdout, stderr) => resolve_({ stdout, stderr })
      );
    });
    const line = /^RESULT (.*)$/m.exec(res.stdout)?.[1];
    expect(line, res.stderr.slice(-2000)).toBeDefined();
    const result = JSON.parse(line!) as { ok: boolean; error?: string; log: string[] };
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const trace = readFileSync(traceFile, 'utf8');
    expect(trace).toMatch(/AF_INET/); // the trace did see the render's (loopback) connections
    expect(trace).toMatch(/<(TCP|UDP|UNIX)/); // -yy labelled the sockets (the probe exception needs it)
    expect(externalNetworkCalls(trace)).toEqual([]);
    expect(result.log.join('\n')).toMatch(/not installed and was not downloaded/);
  }, 300_000);
});
