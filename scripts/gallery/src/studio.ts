/**
 * Talking to a ReelForge Studio: start a local server for the gallery job (or
 * target a running one), and an MCP client that records every tool it calls,
 * so each reel's meta.json can say exactly which tools the "agent" used.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const REPO = resolve(import.meta.dirname, '../../..');
const TSX = join(REPO, 'node_modules/.bin/tsx');

export class ToolError extends Error {
  constructor(
    public tool: string,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(`${tool}: ${code}: ${message}`);
  }
}

/** The subset of an MCP client the pipeline needs (a fake in unit tests). */
export interface ToolCaller {
  call(name: string, args: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

/** Records tool names in call order (a reel's "tools called"). */
export class RecordingCaller implements ToolCaller {
  readonly calls: string[] = [];
  constructor(private inner: ToolCaller) {}
  async call(name: string, args: Record<string, unknown>) {
    this.calls.push(name);
    return this.inner.call(name, args);
  }
  close() {
    return this.inner.close();
  }
  /** Unique tool names, first-call order. */
  tools(): string[] {
    return [...new Set(this.calls)];
  }
}

/** MCP over Streamable HTTP with a Bearer key (the agent path). */
export async function connectMcp(url: string, key: string): Promise<ToolCaller> {
  const client = new Client({ name: 'reelforge-gallery', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return {
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
      const content = (r.content ?? []) as { type: string; text?: string }[];
      const text = content.find((c) => c.type === 'text')?.text ?? '{}';
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { text };
      }
      if (r.isError) throw new ToolError(name, data?.error?.code ?? 'error', data?.error?.message ?? text.slice(0, 500), data?.error?.details);
      return data;
    },
    close: () => client.close(),
  };
}

export interface LocalStudio {
  url: string;
  key: string;
  child: ChildProcess;
  stop(): Promise<void>;
  output(): string;
}

/**
 * Start `apps/server/src/main.ts` for the gallery job: its own data directory,
 * licence mode off (a local render job; never in a shipped config), the given
 * Chromium, and a key with read,write,render scopes made by the CLI.
 */
export async function startLocalStudio(opts: { dataDir: string; cacheDir: string; chromium: string; concurrency: number; noSandbox: boolean }): Promise<LocalStudio> {
  mkdirSync(opts.dataDir, { recursive: true });
  mkdirSync(opts.cacheDir, { recursive: true });
  const env = {
    ...process.env,
    REELFORGE_DATA_DIR: opts.dataDir,
    REELFORGE_CACHE_DIR: opts.cacheDir,
    REELFORGE_LICENCE_MODE: 'off',
    REELFORGE_CHROMIUM_PATH: opts.chromium,
    REELFORGE_RENDER_CONCURRENCY: String(opts.concurrency),
    REELFORGE_PORT: '0',
    REELFORGE_HOST: '127.0.0.1',
    ...(opts.noSandbox ? { REELFORGE_CHROMIUM_NO_SANDBOX: '1' } : {}),
  };
  const k = spawnSync(TSX, ['apps/server/src/cli.ts', 'keys', 'create', '--name', `gallery-${Date.now()}`, '--scopes', 'read,write,render'], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (k.status !== 0) throw new Error(`keys create failed: ${k.stderr}`);
  const key = k.stdout.trim().split('\n').pop()!.trim();
  if (!key.startsWith('rf_')) throw new Error('unexpected output from keys create');
  const child = spawn(TSX, ['apps/server/src/main.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const keep = (d: Buffer) => {
    out += d.toString();
    if (out.length > 400_000) out = out.slice(-200_000);
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  const url = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`studio did not start:\n${out.slice(-4000)}`)), 120_000);
    const check = () => {
      const m = /listening on (http:\/\/[^\s]+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m[1]!);
      }
    };
    child.stdout!.on('data', check);
    child.stderr!.on('data', check);
    child.on('exit', (code) => fail(new Error(`studio exited with ${code}:\n${out.slice(-4000)}`)));
  });
  return {
    url,
    key,
    child,
    output: () => out,
    stop: () =>
      new Promise<void>((ok) => {
        if (child.exitCode !== null) return ok();
        child.once('exit', () => ok());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
      }),
  };
}
