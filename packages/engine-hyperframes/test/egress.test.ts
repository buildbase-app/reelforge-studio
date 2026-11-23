import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinTheme } from '@reelforge/project-schema';
import { hyperframesEnv, renderHyperframesScene, startNetworkSink } from '../src/index';

/**
 * #318: HyperFrames resolves web fonts with the CLI's own Node `fetch`
 * (fonts.googleapis.com, with the page's characters in `text=`), outside its
 * capture proxy. These tests prove that nothing leaves the machine: the guard
 * refuses the fetch, a refusing proxy that would see any request sees none,
 * and (where strace works) the render makes no connect() outside loopback.
 */

const browser = process.env.REELFORGE_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const repoRoot = resolve(import.meta.dirname, '../../..');
const hasStrace = spawnSync('strace', ['-f', '-qq', '-e', 'trace=connect', '-o', '/dev/null', 'true']).status === 0;
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
      expect(guarded.stderr).toContain('[ReelForge:FONT_REFUSED] host=fonts.googleapis.com');
      expect(guarded.stderr).toContain('[ReelForge:FONT_REFUSED] host=fonts.gstatic.com');
      expect(guarded.stderr).toContain('[ReelForge:EGRESS_REFUSED] host=cdn.example.com');
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

/** connect() calls in an strace log that leave loopback (IPv4, IPv6) or go to a DNS port. */
function externalConnects(log: string): string[] {
  return log.split('\n').filter((line) => {
    if (!/\bconnect\(/.test(line)) return false;
    const v4 = /sin_port=htons\((\d+)\), sin_addr=inet_addr\("([^"]+)"\)/.exec(line);
    const v6 = /sin6_port=htons\((\d+)\).*inet_pton\(AF_INET6, "([^"]+)"/.exec(line);
    const m = v4 ?? v6;
    if (!m) return false;
    const [, port, addr] = m as unknown as [string, string, string];
    const loopback = /^127\./.test(addr) || addr === '::1' || /^::ffff:127\./.test(addr);
    return !loopback || port === '53';
  });
}

describe.skipIf(!hasBrowser)('SECT-42 a HyperFrames scene that names a missing web font renders offline (needs REELFORGE_CHROMIUM_PATH)', () => {
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

  it.runIf(hasStrace)('strace: the whole render (CLI, browser, children) makes 0 connect() calls outside loopback and no DNS lookups', async () => {
    const out = join(dir, 'strace');
    const traceFile = join(dir, 'strace-connect.txt');
    const res = await new Promise<{ stdout: string; stderr: string }>((resolve_) => {
      execFile(
        'strace',
        ['-f', '-qq', '-e', 'trace=connect', '-o', traceFile, process.execPath, '--import', 'tsx', join(import.meta.dirname, 'fixtures', 'render-missing-font.mts'), out],
        { cwd: repoRoot, env: { ...process.env, REELFORGE_CHROMIUM_PATH: browser }, timeout: 280_000, maxBuffer: 16 * 1024 * 1024 },
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
    expect(externalConnects(trace)).toEqual([]);
    expect(result.log.join('\n')).toMatch(/not installed and was not downloaded/);
  }, 300_000);
});
