import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDecodable, checkExpectation, frameStats, probe, resolveTools } from '@reelforge/media-pipeline';
import { tempDir } from '../../../packages/core/test/helpers';
import { cliCreateKey, startServerProcess, type ServerProcess } from './serverProcess';

/**
 * The whole agent journey over MCP only, against a real server process
 * (`tsx apps/server/src/main.ts`) with keys made by the CLI and the official
 * MCP SDK client over Streamable HTTP with Bearer auth. Real engines render a
 * 1080x1920 MP4 that is downloaded and checked with ffprobe.
 *
 * Needs a Chromium (REELFORGE_CHROMIUM_PATH). Skips without one, unless
 * REELFORGE_REQUIRE_BROWSER=1 (CI), which turns a missing browser into a failure.
 */
const browser = process.env.REELFORGE_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));
const requireBrowser = process.env.REELFORGE_REQUIRE_BROWSER === '1';

describe('browser requirement', () => {
  it.runIf(requireBrowser)('REELFORGE_REQUIRE_BROWSER=1: a browser must be configured', () => {
    expect(hasBrowser, `REELFORGE_CHROMIUM_PATH=${browser ?? '(unset)'} does not point at a browser`).toBe(true);
  });
});

describe.skipIf(!hasBrowser)('agent journey over MCP against a real server process (needs REELFORGE_CHROMIUM_PATH)', () => {
  const { dir, cleanup } = tempDir('reelforge-mcp-e2e-');
  const dataDir = join(dir, 'data');
  const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
  let server: ServerProcess;
  let key: string;
  let readOnlyKey: string;

  beforeAll(async () => {
    key = cliCreateKey(dataDir, 'agent', 'read,write,render');
    readOnlyKey = cliCreateKey(dataDir, 'viewer', 'read');
    server = await startServerProcess({
      REELFORGE_DATA_DIR: dataDir,
      REELFORGE_CACHE_DIR: resolve(__dirname, '../../../.render-cache'),
      REELFORGE_CHROMIUM_PATH: browser!,
    });
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
    cleanup();
  });

  async function connect(k: string) {
    const client = new Client({ name: 'reelforge-e2e-agent', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${k}` } } }));
    return client;
  }
  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as any[];
    return { isError: Boolean(r.isError), data: JSON.parse(content.find((c) => c.type === 'text').text), content };
  }
  async function ok(client: Client, name: string, args: Record<string, unknown>) {
    const r = await call(client, name, args);
    if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.data)}`);
    return r;
  }

  it('refuses a missing or wrong key with 401', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await fetch(`${server.url}/mcp`, { method: 'POST', headers, body })).status).toBe(401);
    expect((await fetch(`${server.url}/mcp`, { method: 'POST', headers: { ...headers, authorization: 'Bearer rf_not_a_real_key_000000000000' }, body })).status).toBe(401);
    const client = new Client({ name: 'no-key', version: '0' });
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)))).rejects.toThrow();
  });

  it('refuses tools that need a scope the key lacks (forbidden, the 403 of MCP)', async () => {
    const viewer = await connect(readOnlyKey);
    expect((await ok(viewer, 'list_themes', {})).data.themes.length).toBeGreaterThanOrEqual(2);
    const r = await call(viewer, 'create_project', { manifest: sample });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('forbidden');
    expect(r.data.error.message).toMatch(/"write" scope/);
    const render = await call(viewer, 'render_project', { projectId: 'sample-reel' });
    expect(render.data.error.code).toBe('forbidden');
    await viewer.close();
  });

  it('returns a structured validation error for a bad manifest', async () => {
    const agent = await connect(key);
    const bad = {
      schemaVersion: '0.2',
      projectId: 'bad-one',
      title: 'Bad',
      output: { width: 1080, height: 1920, fps: 30, format: 'mp4' },
      scenes: [
        { id: 'hook', engine: 'remotion', template: 'kinetic-title', durationFrames: 900, props: { headline: '' } },
        { id: 'two', engine: 'after-effects', template: 'x', durationSeconds: 2 },
      ],
    };
    const r = await call(agent, 'create_project', { manifest: bad });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('invalid_manifest');
    const paths = r.data.error.details.issues.map((i: any) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['scenes.0.durationFrames', 'scenes.0.props.headline', 'scenes.1.engine']));
    const shape = await call(agent, 'create_project', { manifest: { ...sample, projectId: 'bad-two', output: { ...sample.output, fps: 29 } } });
    expect(shape.data.error.details.issues.some((i: any) => i.path.startsWith('output.fps'))).toBe(true);
    await agent.close();
  });

  it('does the whole journey: discover, create, edit with per-scene timing, theme, validate, render, download a checked MP4', async () => {
    const agent = await connect(key);
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['get_capabilities', 'create_project', 'add_scene', 'render_project', 'get_render_output']));

    const caps = (await ok(agent, 'get_capabilities', {})).data;
    const engines = caps.engines.map((e: any) => e.id);
    expect(engines).toEqual(['remotion', 'motion-canvas', 'html', 'hyperframes']);
    for (const e of caps.engines) expect(e.available, `${e.id}: ${e.reason}`).toBe(true);
    const themes = (await ok(agent, 'list_themes', {})).data.themes.map((t: any) => t.id);
    expect(themes).toEqual(expect.arrayContaining(['default', 'midnight']));
    const templates = (await ok(agent, 'list_templates', {})).data.templates.map((t: any) => t.id);
    expect(templates).toEqual(['kinetic-title', 'animated-explainer', 'html-title', 'hyperframes-title']);

    expect((await ok(agent, 'create_project', { manifest: sample })).data.migratedFrom).toBe('0.1');
    await ok(agent, 'set_theme', { projectId: 'sample-reel', theme: 'midnight' });
    await ok(agent, 'add_scene', {
      projectId: 'sample-reel',
      scene: { id: 'outro', engine: 'remotion', template: 'kinetic-title', props: { headline: 'Render it yourself' }, durationSeconds: 2.5 },
    });
    await ok(agent, 'add_scene', {
      projectId: 'sample-reel',
      scene: {
        id: 'agent-html',
        engine: 'html',
        durationSeconds: 1,
        html: '<div class="pill">Agent-written HTML</div>',
        css: '#rf-root{display:flex;align-items:center;justify-content:center}.pill{font-size:80px;font-weight:800;color:var(--rf-text);background:var(--rf-accent);padding:40px 60px;border-radius:999px;animation:pop .5s ease-out both}@keyframes pop{from{transform:scale(.6)}to{transform:none}}',
      },
    });
    await ok(agent, 'add_scene', { projectId: 'sample-reel', scene: { id: 'card', engine: 'html', template: 'html-title', durationFrames: 45, props: { headline: 'Four engines, one timeline', kicker: 'HTML' } } });
    await ok(agent, 'add_scene', { projectId: 'sample-reel', scene: { id: 'hf', engine: 'hyperframes', template: 'hyperframes-title', durationSeconds: 1.5, props: { headline: 'HyperFrames, rendered locally' } } });
    // Per-scene timing edits: seconds on one scene, frames on another, and a reorder.
    await ok(agent, 'update_scene', { projectId: 'sample-reel', sceneId: 'outro', patch: { durationSeconds: 2, props: { subline: 'Self-hosted' } } });
    await ok(agent, 'update_scene', { projectId: 'sample-reel', sceneId: 'hook', patch: { durationFrames: 75 } });
    const reordered = (await ok(agent, 'reorder_scenes', { projectId: 'sample-reel', order: ['hook', 'how-it-works', 'agent-html', 'card', 'hf', 'outro'] })).data;
    expect(reordered.timing.map((t: any) => [t.id, t.startFrame, t.durationFrames])).toEqual([
      ['hook', 0, 75],
      ['how-it-works', 75, 120],
      ['agent-html', 195, 30],
      ['card', 225, 45],
      ['hf', 270, 45],
      ['outro', 315, 60],
    ]);
    const report = (await ok(agent, 'validate_project', { projectId: 'sample-reel' })).data;
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
    expect(report.summary.totalFrames).toBe(375);

    const { job } = (await ok(agent, 'render_project', { projectId: 'sample-reel' })).data;
    let status = job;
    for (let i = 0; i < 400 && !['succeeded', 'failed', 'cancelled'].includes(status.status); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      status = (await ok(agent, 'get_job', { jobId: job.id })).data;
    }
    if (status.status !== 'succeeded') {
      const logs = (await ok(agent, 'get_job_logs', { jobId: job.id, tail: 40 })).data.lines.join('\n');
      throw new Error(`render ${status.status}: ${JSON.stringify(status.error)}\n${logs}`);
    }

    const out = await ok(agent, 'get_render_output', { jobId: job.id });
    expect(out.data.checks).toEqual({ metadata: 'pass', decode: 'pass', duration: 'pass' });
    expect(out.content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
    expect(out.data.versions.engines).toMatchObject({ remotion: '4.0.545', 'motion-canvas': '3.17.2', hyperframes: 'hyperframes 0.9.77' });

    // Download with the same key from the URL the tool returned and check it independently.
    const res = await fetch(new URL(out.data.outputUrl, server.url), { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    const file = join(dir, 'final.mp4');
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const tools2 = resolveTools();
    const info = await probe(tools2.ffprobe, file);
    expect(checkExpectation(info, { width: 1080, height: 1920, fps: 30, frames: 375, audio: true })).toEqual([]);
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
    expect(info.durationSeconds).toBeCloseTo(12.5, 1);
    await assertDecodable(tools2.ffmpeg, file);
    const first = await frameStats(tools2.ffmpeg, file, 0);
    expect(first.yMax - first.yMin).toBeGreaterThan(40); // non-empty thumbnail frame
    await agent.close();
  }, 600_000);
});
