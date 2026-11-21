import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDecodable, checkExpectation, probe, resolveTools } from '@reelforge/media-pipeline';
import { startServer, type StartedServer } from '../src/index';
import { tempDir } from '../../../packages/core/test/helpers';

/**
 * End to end with the real engines: an MCP client (official SDK) drives a
 * real server on a random port from project creation to a validated MP4.
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

describe.skipIf(!hasBrowser)('MCP end to end with real engines (needs REELFORGE_CHROMIUM_PATH)', () => {
  const { dir, cleanup } = tempDir('reelforge-e2e-');
  const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
  let server: StartedServer;
  let key: string;
  let client: Client;

  beforeAll(async () => {
    server = await startServer(
      { dataDir: join(dir, 'data'), cacheDir: join(__dirname, '../../../.render-cache'), port: 0, host: '127.0.0.1' },
      { env: { REELFORGE_CHROMIUM_PATH: browser }, quiet: true }
    );
    key = (await server.service.keys.create('e2e', ['read', 'write', 'render'])).key;
    client = new Client({ name: 'reelforge-e2e', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } })
    );
  });
  afterAll(async () => {
    await client?.close();
    await server?.close();
    cleanup();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as any[]).find((c) => c.type === 'text').text;
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return { data: JSON.parse(text), content: r.content as any[] };
  };

  it('creates, edits, validates, renders and returns a validated 1080x1920 MP4', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(24);

    const caps = (await call('get_capabilities', {})).data;
    for (const e of caps.engines.filter((x: any) => ['remotion', 'motion-canvas'].includes(x.id))) expect(e.available, e.reason).toBe(true);

    const created = (await call('create_project', { manifest: sample })).data;
    expect(created.migratedFrom).toBe('0.1');
    await call('set_theme', { projectId: 'sample-reel', theme: 'midnight' });
    await call('add_scene', {
      projectId: 'sample-reel',
      scene: { id: 'outro', engine: 'remotion', template: 'kinetic-title', props: { headline: 'Render it yourself' }, durationSeconds: 2.5 },
    });
    const updated = (await call('update_scene', { projectId: 'sample-reel', sceneId: 'outro', patch: { durationSeconds: 2, props: { subline: 'Self-hosted' } } })).data;
    expect(updated.timing.map((t: any) => t.durationFrames)).toEqual([90, 120, 60]);
    const report = (await call('validate_project', { projectId: 'sample-reel' })).data;
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);

    const { job } = (await call('render_project', { projectId: 'sample-reel' })).data;
    let status = job;
    for (let i = 0; i < 300 && !['succeeded', 'failed', 'cancelled'].includes(status.status); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      status = (await call('get_job', { jobId: job.id })).data;
    }
    if (status.status !== 'succeeded') {
      const logs = (await call('get_job_logs', { jobId: job.id, tail: 40 })).data.lines.join('\n');
      throw new Error(`render ${status.status}: ${JSON.stringify(status.error)}\n${logs}`);
    }

    const out = await call('get_render_output', { jobId: job.id });
    expect(out.data.checks).toEqual({ metadata: 'pass', decode: 'pass', duration: 'pass' });
    expect(out.content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);

    // Download through the REST URL with the same key and check it independently.
    const res = await fetch(`${server.url}/v1/renders/${out.data.renderId}/output`, { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    const file = join(dir, 'final.mp4');
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const tools2 = resolveTools();
    const info = await probe(tools2.ffprobe, file);
    expect(checkExpectation(info, { width: 1080, height: 1920, fps: 30, frames: 270, audio: true })).toEqual([]);
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
    expect(info.durationSeconds).toBeCloseTo(9, 1);
    await assertDecodable(tools2.ffmpeg, file);
  }, 600_000);
});
