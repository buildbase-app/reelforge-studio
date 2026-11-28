import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '../../..');
const TSX = join(REPO, 'node_modules/.bin/tsx');

export interface Studio {
  url: string;
  key: string;
  /** True when this run started the server (it stops it at the end). */
  owned: boolean;
  stop(): Promise<void>;
}

/** Create an API key with the CLI (`pnpm keys:create`), as an operator does. */
export function createKey(dataDir: string, name: string, scopes = 'read,write,render'): string {
  const r = spawnSync(TSX, ['apps/server/src/cli.ts', 'keys', 'create', '--name', name, '--scopes', scopes], {
    cwd: REPO,
    env: { ...process.env, RENDERWELD_DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(`keys create failed: ${r.stderr}`);
  const key = r.stdout.trim().split('\n').pop()!.trim();
  if (!/^rf_/.test(key)) throw new Error('unexpected output from keys create');
  return key;
}

/**
 * Use the studio named by RENDERWELD_URL + RENDERWELD_API_KEY, or start one from
 * this checkout with a fresh data directory under `outDir`.
 * The started server runs with RENDERWELD_LICENCE_MODE=off: local development only.
 */
export async function useStudio(outDir: string): Promise<Studio> {
  if (process.env.RENDERWELD_URL && process.env.RENDERWELD_API_KEY) {
    return { url: process.env.RENDERWELD_URL.replace(/\/$/, ''), key: process.env.RENDERWELD_API_KEY, owned: false, stop: async () => undefined };
  }
  const chromium = process.env.RENDERWELD_CHROMIUM_PATH;
  if (!chromium) throw new Error('set RENDERWELD_CHROMIUM_PATH (Chrome Headless Shell), or point RENDERWELD_URL and RENDERWELD_API_KEY at a running studio');
  const dataDir = join(outDir, 'studio-data');
  mkdirSync(dataDir, { recursive: true });
  const port = process.env.RENDERWELD_TUTORIAL_PORT ?? '4352';
  const env = {
    ...process.env,
    RENDERWELD_DATA_DIR: dataDir,
    RENDERWELD_HOST: '127.0.0.1',
    RENDERWELD_PORT: port,
    RENDERWELD_LICENCE_MODE: 'off', // local development only; a real install activates a licence key
    RENDERWELD_CHROMIUM_NO_SANDBOX: process.env.RENDERWELD_CHROMIUM_NO_SANDBOX ?? '1',
  };
  const key = createKey(dataDir, 'tutorial-proof');
  const child = spawn(TSX, ['scripts/tutorials/serve.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const url = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`the studio did not start:\n${log}`)), 90_000);
    child.stdout.on('data', () => {
      const m = /listening on (http:\/\/[^\s]+?)\s/.exec(log);
      if (m) {
        clearTimeout(timer);
        ok(m[1]!);
      }
    });
    child.on('exit', (code) => fail(new Error(`the studio exited with ${code}:\n${log}`)));
  });
  return {
    url,
    key,
    owned: true,
    stop: () =>
      new Promise<void>((ok) => {
        writeFileSync(join(outDir, 'studio.log'), log);
        if (child.exitCode !== null) return ok();
        child.once('exit', () => ok());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }),
  };
}

/** Minimal REST client used by the proofs to check what an agent did. */
export function rest(studio: Pick<Studio, 'url' | 'key'>) {
  const headers = { Authorization: `Bearer ${studio.key}` };
  async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(studio.url + path, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 800)}`);
    return text ? JSON.parse(text) : (undefined as T);
  }
  return {
    get: <T = any>(path: string) => call<T>('GET', path),
    post: <T = any>(path: string, body: unknown = {}) => call<T>('POST', path, body),
    del: <T = any>(path: string) => call<T>('DELETE', path),
    /** Long-poll `GET /v1/jobs/:id?wait=50` until the job is finished. */
    async waitJob(jobId: string, timeoutMs = 20 * 60_000): Promise<any> {
      const t0 = Date.now();
      for (;;) {
        const job = await call('GET', `/v1/jobs/${jobId}?wait=50`);
        if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
        if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} still ${job.status} after ${timeoutMs / 1000}s`);
      }
    },
    async download(renderId: string, file: string, to: string): Promise<number> {
      const res = await fetch(`${studio.url}/v1/renders/${renderId}/output?file=${encodeURIComponent(file)}`, { headers });
      if (!res.ok) throw new Error(`download ${file} -> ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(to, buf);
      return buf.length;
    },
  };
}
