import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDecodable, checkExpectation, probe, resolveTools } from '@reelforge/media-pipeline';
import { tempDir } from '../../../packages/core/test/helpers';
import { cliCreateKey, startServerProcess, testDatabase, type ServerProcess } from './serverProcess';

/**
 * The REST twin of mcp.e2e.test.ts: the same agent journey with plain HTTP
 * against a real server process, keys from the CLI, real engines, ffprobe.
 */
const browser = process.env.REELFORGE_CHROMIUM_PATH;
const hasBrowser = Boolean(browser && existsSync(browser));

describe.skipIf(!hasBrowser)('agent journey over REST against a real server process (needs REELFORGE_CHROMIUM_PATH)', () => {
  const { dir, cleanup } = tempDir('reelforge-rest-e2e-');
  const dataDir = join(dir, 'data');
  let server: ServerProcess;
  let key: string;
  let readOnlyKey: string;
  let database: Awaited<ReturnType<typeof testDatabase>>;

  beforeAll(async () => {
    database = await testDatabase(dir);
    key = cliCreateKey(dataDir, 'agent', 'read,write,render', database.env);
    readOnlyKey = cliCreateKey(dataDir, 'viewer', 'read', database.env);
    server = await startServerProcess({
      ...database.env,
      REELFORGE_DATA_DIR: dataDir,
      REELFORGE_CACHE_DIR: resolve(__dirname, '../../../.render-cache'),
      REELFORGE_CHROMIUM_PATH: browser!,
      REELFORGE_LICENCE_MODE: 'off',
    });
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
    await database?.drop();
    cleanup();
  });

  const api = async (method: string, path: string, body?: unknown, k: string | null = key) => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  };

  const manifest = {
    schemaVersion: '0.2',
    projectId: 'rest-reel',
    title: 'REST reel',
    brief: { goal: 'Prove the REST journey', targetSeconds: 6, platform: 'instagram-reels' },
    output: { width: 1080, height: 1920, fps: 30, format: 'mp4' },
    scenes: [
      { id: 'hook', engine: 'remotion', template: 'kinetic-title', durationSeconds: 2, props: { headline: 'REST works too' } },
      { id: 'steps', engine: 'motion-canvas', template: 'animated-explainer', durationSeconds: 3, props: { title: 'Steps', points: ['POST /v1/projects', 'POST /renders'] } },
    ],
  };

  it('negatives: 401 without a key, 403 without the scope, 422 with structured issues', async () => {
    expect((await api('GET', '/v1/capabilities', undefined, null)).status).toBe(401);
    const forbidden = await api('POST', '/v1/projects', manifest, readOnlyKey);
    expect(forbidden.status).toBe(403);
    expect(forbidden.json.error.code).toBe('forbidden');
    const bad = await api('POST', '/v1/projects', { ...manifest, scenes: [{ ...manifest.scenes[0], durationSeconds: 30 }] });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe('invalid_manifest');
    expect(bad.json.error.details.issues[0]).toMatchObject({ path: 'scenes.0.durationSeconds' });
    // Layout scenes (#287) are checked like any template: pane counts, and media that must be image or video assets.
    const layout = await api('POST', '/v1/projects', {
      ...manifest,
      projectId: 'rest-layout',
      scenes: [{ id: 'split', engine: 'html', template: 'html-layout', durationSeconds: 2, props: { layout: { type: 'split', ratios: [2, 1] }, panes: [{ media: { asset: 'missing' } }] } }],
    });
    expect(layout.status).toBe(422);
    expect(layout.json.error.details.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'scenes.0.props.panes', message: 'a split has 2 to 4 panes, got 1' }),
        expect.objectContaining({ path: 'scenes.0.props.layout.ratios' }),
      ])
    );
  });

  it('does the whole journey and returns a checked MP4', async () => {
    const caps = await api('GET', '/v1/capabilities');
    expect(caps.json.engines.map((e: any) => e.id)).toEqual(['remotion', 'motion-canvas', 'html', 'hyperframes']);
    expect((await api('GET', '/v1/themes')).json.themes.length).toBeGreaterThanOrEqual(2);
    expect((await api('GET', '/v1/templates')).json.templates.length).toBe(8);

    expect((await api('POST', '/v1/projects', manifest)).status).toBe(201);
    expect((await api('POST', '/v1/projects/rest-reel/scenes', { scene: { id: 'card', engine: 'html', template: 'html-title', durationSeconds: 1, props: { headline: 'Over HTTP' } } })).status).toBe(201);
    const patched = await api('PATCH', '/v1/projects/rest-reel/scenes/steps', { durationFrames: 75 });
    expect(patched.status).toBe(200);
    expect((await api('PUT', '/v1/projects/rest-reel/theme', { theme: { base: 'midnight', tokens: { colors: { accent: '#ff8800' } } } })).status).toBe(200);
    const report = await api('POST', '/v1/projects/rest-reel/validate');
    expect(report.json.ok, JSON.stringify(report.json.errors)).toBe(true);
    expect(report.json.summary.totalFrames).toBe(60 + 75 + 30);

    const start = await api('POST', '/v1/projects/rest-reel/renders', {});
    expect(start.status).toBe(202);
    let job = start.json.job;
    for (let i = 0; i < 300 && !['succeeded', 'failed', 'cancelled'].includes(job.status); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      job = (await api('GET', `/v1/jobs/${job.id}`)).json;
    }
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');

    const res = await fetch(`${server.url}/v1/renders/${job.result.renderId}/output`, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    const file = join(dir, 'rest.mp4');
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const t = resolveTools();
    const info = await probe(t.ffprobe, file);
    expect(checkExpectation(info, { width: 1080, height: 1920, fps: 30, frames: 165, audio: true })).toEqual([]);
    expect(info.audioCodec).toBe('aac');
    await assertDecodable(t.ffmpeg, file);
  }, 600_000);
});
