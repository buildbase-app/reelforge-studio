import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createTestDatabase, serverTestDatabaseKind } from '@renderweld/db';

/** Helpers that run the server and CLI exactly as an operator does: separate processes. */
const repo = resolve(__dirname, '../../..');
const tsx = join(repo, 'node_modules/.bin/tsx');

/**
 * The database a server test runs against: REELFORGE_TEST_DB=sqlite (default:
 * the SQLite file in the data directory), postgres (TEST_POSTGRES_URL) or
 * mysql (TEST_MYSQL_URL), each a fresh empty database.
 */
export async function testDatabase(dir: string): Promise<{ env: Record<string, string>; url?: string; drop: () => Promise<void> }> {
  const kind = serverTestDatabaseKind();
  if (kind === 'sqlite') return { env: {}, drop: async () => undefined };
  const t = await createTestDatabase(kind, dir);
  return { env: { DATABASE_URL: t.url }, url: t.url, drop: t.drop };
}

export function cliCreateKey(dataDir: string, name: string, scopes: string, env: Record<string, string> = {}): string {
  const r = spawnSync(tsx, ['apps/server/src/cli.ts', 'keys', 'create', '--name', name, '--scopes', scopes], {
    cwd: repo,
    env: { ...process.env, RENDERWELD_DATA_DIR: dataDir, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`keys create failed: ${r.stderr}`);
  const key = r.stdout.trim().split('\n').pop()!.trim();
  if (!/^rf_/.test(key)) throw new Error(`unexpected CLI output: ${r.stdout}`);
  return key;
}

export interface ServerProcess {
  url: string;
  child: ChildProcess;
  output: () => string;
  stop(): Promise<void>;
}

/** Start `tsx apps/server/src/main.ts` (what `pnpm start` runs) on a random port. */
export async function startServerProcess(env: Record<string, string>): Promise<ServerProcess> {
  const child = spawn(tsx, ['apps/server/src/main.ts'], {
    cwd: repo,
    env: { ...process.env, RENDERWELD_PORT: '0', RENDERWELD_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const url = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`server did not start:\n${out}`)), 60_000);
    const check = () => {
      const m = /listening on (http:\/\/[^\s]+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m[1]!);
      }
    };
    child.stdout!.on('data', check);
    child.on('exit', (code) => fail(new Error(`server exited with ${code}:\n${out}`)));
  });
  return {
    url,
    child,
    output: () => out,
    stop: () =>
      new Promise<void>((ok) => {
        if (child.exitCode !== null) return ok();
        child.once('exit', () => ok());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }),
  };
}
