/**
 * Egress end to end (#291): the whole server, run as `pnpm start` runs it, under `strace -f`, through a full
 * journey over REST and MCP (four engines, uploaded music, burned captions, a preview, a render, downloads, the
 * dashboard, analytics, storage cleanup) with the licence enforced as in the sold image. The licence server is the
 * local mock. Every connect() and send of the server and of every process it starts (FFmpeg, Chromium, the engine
 * CLIs) must stay on loopback: one installation never talks to another, and nothing phones home. What the licence
 * client sends is checked too: the key and an instance id, nothing else (docs/PRIVACY.md).
 *
 * Needs strace (ptrace allowed) and RENDERWELD_CHROMIUM_PATH; skips without them, fails without them under
 * REELFORGE_REQUIRE_EGRESS=1.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, describe, expect, it } from 'vitest';
import { makeTone } from '../../../packages/core/test/helpers';
import { externalNetworkCalls } from '../../../packages/engine-hyperframes/test/strace-egress';
import { startMockLicenceServer } from '../../../e2e/mock-licence/server.mjs';
import { cliCreateKey } from './serverProcess';

const repo = resolve(import.meta.dirname, '../../..');
const tsx = join(repo, 'node_modules/.bin/tsx');
const browser = process.env.RENDERWELD_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const TRACE = ['-f', '-qq', '-yy', '-e', 'trace=connect,sendto,sendmsg,sendmmsg,execve'];
const hasStrace = spawnSync('strace', ['-f', '-qq', '-yy', '-e', 'trace=connect', '-o', '/dev/null', 'true']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'renderweld-egress-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

describe('egress requirement', () => {
  it.runIf(process.env.REELFORGE_REQUIRE_EGRESS === '1')('REELFORGE_REQUIRE_EGRESS=1: strace and a browser must be available', () => {
    expect(hasStrace, 'strace with ptrace allowed').toBe(true);
    expect(hasBrowser, 'RENDERWELD_CHROMIUM_PATH').toBe(true);
  });
});

/** Run a command under strace; resolves with the trace once every traced process has exited. */
function traced(log: string, command: string, args: string[], env: NodeJS.ProcessEnv) {
  // Its own process group, so stopping it stops the server and everything it started, not only strace.
  const child = spawn('strace', [...TRACE, '-o', log, command, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((ok) => child.once('exit', (code) => ok(code)));
  return {
    child,
    output: () => out,
    exited,
    async stop() {
      if (child.exitCode === null && child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
        const timer = setTimeout(() => child.pid && process.kill(-child.pid, 'SIGKILL'), 20_000);
        await exited;
        clearTimeout(timer);
      }
      return readFileSync(log, 'utf8');
    },
  };
}

describe('the recorder sees a leak (control)', () => {
  it.skipIf(!hasStrace)('EGR-01 a process that connects to a non-loopback address is caught', async () => {
    const t = traced(join(dir, 'control.trace'), process.execPath, ['-e', "require('net').connect(9, '192.0.2.1').on('error', () => {}); setTimeout(() => process.exit(0), 300)"], process.env);
    await t.exited;
    const leaks = externalNetworkCalls(await t.stop());
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks.join('\n')).toContain('192.0.2.1');
  });
});

describe.skipIf(!hasStrace || !hasBrowser)('a whole server makes no connection outside loopback (#291)', () => {
  it('EGR-02 a four-engine journey over REST and MCP with the licence enforced: only loopback, and the licence call carries only key and instance', async () => {
    const LICENCE_KEY = 'EGRAA-BCDEF-GHJKL-MNPQR-STUVW';
    const ORG = 'egress0000-mocklice';
    const licence = await startMockLicenceServer({ orgId: ORG, keys: [{ key: LICENCE_KEY, activationLimit: 1 }] });
    const dataDir = join(dir, 'data');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RENDERWELD_PORT: '0',
      RENDERWELD_HOST: '127.0.0.1',
      RENDERWELD_DATA_DIR: dataDir,
      RENDERWELD_CACHE_DIR: resolve(repo, '.render-cache'),
      RENDERWELD_CHROMIUM_PATH: browser!,
      RENDERWELD_LICENCE_MODE: 'required',
      RENDERWELD_LICENCE_KEY: LICENCE_KEY,
      RENDERWELD_LICENCE_SERVER_URL: licence.url,
      RENDERWELD_LICENCE_ORG_ID: ORG,
      RENDERWELD_RATE_LIMIT_PER_MINUTE: '0',
      RENDERWELD_DASHBOARD_ENABLED: 'true',
    };
    // Only the SQLite file under dataDir: a remote test database would be a connection outside loopback.
    delete env.DATABASE_URL;
    delete env.RENDERWELD_DATABASE_URL;
    const key = cliCreateKey(dataDir, 'egress', 'admin,owner');
    // The dashboard is part of the journey; its assets are built by the image, and here when missing (half a second).
    if (!existsSync(join(repo, 'apps/dashboard/dist/index.html'))) {
      expect(spawnSync(tsx, ['build.ts'], { cwd: join(repo, 'apps/dashboard'), stdio: 'ignore' }).status, 'dashboard build').toBe(0);
    }
    const server = traced(join(dir, 'server.trace'), tsx, ['apps/server/src/main.ts'], env);
    let trace = '';
    try {
      const url = await new Promise<string>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error(`server did not start:\n${server.output()}`)), 90_000);
        const check = () => {
          const m = /listening on (http:\/\/[^\s]+)/.exec(server.output());
          if (m) {
            clearTimeout(timer);
            ok(m[1]!);
          }
        };
        server.child.stdout!.on('data', check);
        server.child.stderr!.on('data', check);
        void server.exited.then((code) => fail(new Error(`server exited with ${code}:\n${server.output()}`)));
      });
      const rest = async (method: string, path: string, body?: unknown) => {
        const r = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await r.text();
        return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
      };
      const waitJob = async (id: string) => {
        for (let i = 0; i < 120; i++) {
          const j = (await rest('GET', `/v1/jobs/${id}?wait=10`)).json;
          if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
        }
        throw new Error(`job ${id} did not finish`);
      };

      expect((await rest('GET', '/healthz')).status).toBe(200);
      expect((await rest('GET', '/v1/capabilities')).status).toBe(200);
      expect((await rest('GET', '/v1/licence')).json).toMatchObject({ status: 'valid' });

      // A landscape project across the four engines, with music and burned captions.
      const layout = (color: string, headline: string) => ({ layout: { type: 'full' }, panes: [{ color, headline }] });
      const manifest = {
        schemaVersion: '0.2',
        projectId: 'egress',
        title: 'Egress',
        output: { width: 320, height: 180, fps: 30, format: 'mp4' },
        captions: { mode: 'burned' },
        scenes: [
          { id: 'a', engine: 'html', template: 'html-layout', props: layout('#101010', 'One'), durationFrames: 15 },
          { id: 'b', engine: 'hyperframes', template: 'hyperframes-layout', props: layout('#f0f0f0', 'Two'), durationFrames: 15 },
          { id: 'c', engine: 'remotion', template: 'remotion-layout', props: layout('#101010', 'Three'), durationFrames: 15 },
          { id: 'd', engine: 'motion-canvas', template: 'motion-canvas-layout', props: layout('#f0f0f0', 'Four'), durationFrames: 15 },
        ].map((s) => ({ ...s, captions: { text: `Scene ${s.id}` } })),
      };
      expect((await rest('POST', '/v1/projects', { manifest })).status).toBe(201);
      await makeTone(join(dir, 'music.mp3'), 2);
      const form = new FormData();
      form.set('file', new Blob([readFileSync(join(dir, 'music.mp3'))], { type: 'audio/mpeg' }), 'music.mp3');
      form.set('projectId', 'egress');
      form.set('assetId', 'music');
      form.set('license', JSON.stringify({ name: 'CC0-1.0', redistributable: true }));
      const up = await fetch(`${url}/v1/assets`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
      expect(up.status, await up.clone().text()).toBe(201);
      expect((await rest('PATCH', '/v1/projects/egress/audio', { music: { asset: 'music', volume: 0.5 } })).status).toBe(200);

      // A preview of one scene, then the whole render.
      const preview = await rest('POST', '/v1/projects/egress/preview', { sceneId: 'c' });
      expect([200, 201, 202]).toContain(preview.status);
      if (preview.json?.job?.id) expect((await waitJob(preview.json.job.id)).status).toBe('succeeded');
      const started = await rest('POST', '/v1/projects/egress/renders', {});
      const done = await waitJob(started.json.job.id);
      expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
      const runId = done.result.renderId as string;
      const output = await fetch(`${url}/v1/renders/${runId}/output`, { headers: { authorization: `Bearer ${key}` } });
      expect(output.status).toBe(200);
      expect((await output.arrayBuffer()).byteLength).toBeGreaterThan(1000);

      // The agent's way in, the dashboard, analytics and storage.
      const mcp = new Client({ name: 'egress-test', version: '0' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
      expect((await mcp.listTools()).tools.length).toBeGreaterThan(20);
      const listed = (await mcp.callTool({ name: 'list_projects', arguments: {} })) as { content: Array<{ text?: string }> };
      expect(listed.content[0]!.text).toContain('egress');
      await mcp.close();
      for (const [method, path, body] of [['GET', '/dashboard/'], ['GET', '/v1/analytics/summary'], ['POST', '/v1/storage/cleanup', { dryRun: true }]] as const) {
        const r = await rest(method, path, body);
        expect(r.status, `${method} ${path}: ${r.text.slice(0, 300)}`).toBe(200);
      }
      // Give timers a moment (licence revalidation, outbox, housekeeping) before stopping.
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      trace = await server.stop();
      await licence.close();
    }

    // The trace covers the whole tree: the server started FFmpeg and Chromium, and they were traced.
    const started = [...trace.matchAll(/execve\("([^"]+)"/g)].map((m) => m[1]!.split('/').pop()!);
    expect(started.some((b) => /^ffmpeg/.test(b)), 'ffmpeg traced').toBe(true);
    expect(started.some((b) => /chrom/i.test(b)), 'Chromium traced').toBe(true);
    // Nothing left loopback.
    expect(externalNetworkCalls(trace)).toEqual([]);
    // The licence client spoke only to the configured licence server, with the key and an instance id.
    expect(licence.requests.length).toBeGreaterThan(0);
    for (const r of licence.requests as Array<{ op: string; fields: string[] }>) {
      expect(['activate', 'validate', 'deactivate']).toContain(r.op);
      expect(r.fields.every((f) => f === 'key' || f === 'instance'), `licence ${r.op} sent ${r.fields.join(', ')}`).toBe(true);
    }
  }, 900_000);
});
