import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * get_frames (#379) over REST and MCP on real renders. The fake engine paints frame k of each scene with luma
 * 16 + (k mod 40) x 5, so a tile's pixels tell which frame it really is.
 */
const { dir, cleanup } = tempDir('renderweld-frames-');
let server: StartedServer;
let admin: string;
let reader: string;
let renderId: string;
let dropDb: () => Promise<void> = async () => undefined;

const manifest = {
  schemaVersion: '0.1',
  projectId: 'frames-reel',
  title: 'Frames',
  output: { width: 360, height: 640, fps: 30, format: 'mp4' },
  audio: { musicTrack: null, voiceTrack: null },
  assets: [],
  scenes: [
    { id: 'hook', engine: 'remotion', template: 'kinetic-title', durationFrames: 60, props: { headline: 'One' } },
    { id: 'middle', engine: 'remotion', template: 'kinetic-title', durationFrames: 75, props: { headline: 'Two' } },
    { id: 'outro', engine: 'remotion', template: 'kinetic-title', durationFrames: 50, props: { headline: 'Three' } },
  ],
};
/** Where each scene starts, and frame f's code. */
const starts = { hook: 0, middle: 60, outro: 135 };
const codeOf = (f: number) => (f - (f >= starts.outro ? starts.outro : f >= starts.middle ? starts.middle : starts.hook)) % 40;

/** Mean luma of a JPEG's top-left corner (clear of labels and overlay), or of the tile whose corner is at left, top, mapped back to the painted code. */
function codeIn(jpeg: Buffer, left = 0, top = 0): number {
  const file = join(dir, `tile-${Math.random().toString(36).slice(2)}.jpg`);
  writeFileSync(file, jpeg);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', `crop=16:16:${left + 4}:${top + 4},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`, '-f', 'null', '-'], { encoding: 'utf8' });
  const y = Number(/YAVG=([\d.]+)/.exec(r.stdout)?.[1]);
  // The JPEG is full range: 16..235 became 0..255.
  return Math.round((y * 219) / 255 / 5);
}

const rest = (path: string, key: string | null = admin, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) } });

beforeAll(async () => {
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion', { frameRanges: true }));
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' }, { registry, env: { ...database.env, REELFORGE_LICENCE_MODE: 'off' }, quiet: true });
  admin = (await server.service.keys.create('admin', ['admin', 'owner'])).key;
  reader = (await server.service.keys.create('reader', ['read'])).key;
  const created = await rest('/v1/projects', admin, { method: 'POST', body: JSON.stringify({ manifest }) });
  expect(created.status, await created.clone().text()).toBe(201);
  const { job } = await (await rest('/v1/projects/frames-reel/renders', admin, { method: 'POST', body: '{}' })).json();
  for (let i = 0; i < 600; i++) {
    const j = await (await rest(`/v1/jobs/${job.id}`)).json();
    if (j.status === 'succeeded') {
      renderId = j.result.renderId;
      break;
    }
    if (['failed', 'cancelled'].includes(j.status)) throw new Error(JSON.stringify(j.error));
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(renderId).toBeTruthy();
}, 120_000);
afterAll(async () => {
  await server?.close();
  await dropDb();
  cleanup();
});

describe('GET /v1/renders/:id/frames', () => {
  it('FRM-10 auto on three scenes: 9 labelled tiles at the scene timing, one JPEG sheet under 1 MB', async () => {
    const r = await rest(`/v1/renders/${renderId}/frames`, reader);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ renderId, mode: 'auto', layout: 'sheet', overlay: 'none', labels: true, video: { width: 360, height: 640, fps: 30, frames: 185 }, tileWidth: 360, tileHeight: 640 });
    expect(body.tiles.map((t: any) => `${t.frame}:${t.sceneId}:${t.position}`)).toEqual([
      '0:hook:first', '29:hook:mid', '59:hook:cut-out', '60:middle:cut-in', '97:middle:mid', '134:middle:cut-out', '135:outro:cut-in', '159:outro:mid', '184:outro:last',
    ]);
    expect(body.columns * body.rows).toBeGreaterThanOrEqual(9);
    expect(body.images).toHaveLength(1);
    const jpeg = Buffer.from(body.images[0].data, 'base64');
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(jpeg.length).toBe(body.images[0].bytes);
    expect(jpeg.length).toBeLessThan(1_000_000);
    expect(JSON.stringify(body)).not.toContain(dir); // no local paths
  });

  it('FRM-11 every tile is exactly the frame asked for (pixel code check), with separate images', async () => {
    const body = await (await rest(`/v1/renders/${renderId}/frames?layout=separate`, reader)).json();
    expect(body.images).toHaveLength(9);
    body.tiles.forEach((t: any, i: number) => expect(codeIn(Buffer.from(body.images[i].data, 'base64')), `frame ${t.frame}`).toBe(codeOf(t.frame)));
    const picked = await (await rest(`/v1/renders/${renderId}/frames?frames=1,39,61,183&layout=separate&width=120`, reader)).json();
    expect(picked.tiles.map((t: any) => t.frame)).toEqual([1, 39, 61, 183]);
    expect(picked.tileWidth).toBe(120);
    picked.tiles.forEach((t: any, i: number) => expect(codeIn(Buffer.from(picked.images[i].data, 'base64')), `frame ${t.frame}`).toBe(codeOf(t.frame)));
  });

  it('FRM-12 at, scenes, every, overlay and format=jpeg; bad input is 400; a read key is enough, no key is 401', async () => {
    const at = await (await rest(`/v1/renders/${renderId}/frames?at=0.5,3&scenes=middle:end,outro`, reader)).json();
    expect(at.tiles.map((t: any) => `${t.frame}:${t.position}`)).toEqual(['15:at', '90:at', '134:end', '159:mid']);
    const every = await (await rest(`/v1/renders/${renderId}/frames?every=1&overlay=safe`, reader)).json();
    expect(every).toMatchObject({ mode: 'every', overlay: 'safe' });
    expect(every.tiles.map((t: any) => t.frame)).toEqual([0, 30, 60, 90, 120, 150, 180]);
    const sheet = await rest(`/v1/renders/${renderId}/frames?format=jpeg`, reader);
    expect(sheet.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await sheet.arrayBuffer()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    for (const [q, msg] of [
      ['width=1000', 'width must be a whole number from 120 to 720'],
      ['at=x', 'at: "x" is not a number'],
      ['frames=185', 'frame 185 is not in 0..184'],
      ['scenes=nope', 'no scene "nope"'],
      ['scenes=hook:side', 'position must be start, mid or end'],
      ['layout=grid', 'layout must be sheet or separate'],
      ['format=jpeg&layout=separate', 'use layout=sheet'],
      ['at=1&every=1', 'give at or everySeconds, not both'],
    ]) {
      const r = await rest(`/v1/renders/${renderId}/frames?${q}`, reader);
      expect(r.status, q).toBe(400);
      expect((await r.json()).error.message, q).toContain(msg);
    }
    expect((await rest(`/v1/renders/${renderId}/frames`, null)).status).toBe(401);
    expect((await rest('/v1/renders/run_nope/frames', reader)).status).toBe(404);
  });
});

describe('MCP get_frames', () => {
  it('FRM-13 returns the JSON and the sheet as image content, from renderId or jobId', async () => {
    const client = new Client({ name: 'frames-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${reader}` } } }));
    const r: any = await client.callTool({ name: 'get_frames', arguments: { renderId, overlay: 'safe', width: 180 } });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content.find((c: any) => c.type === 'text').text);
    expect(body).toMatchObject({ renderId, overlay: 'safe', tileWidth: 180, tileHeight: 320 });
    expect(body.images).toEqual([{ mimeType: 'image/jpeg', bytes: expect.any(Number) }]);
    const images = r.content.filter((c: any) => c.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe('image/jpeg');
    expect(Buffer.from(images[0].data, 'base64').length).toBe(body.images[0].bytes);
    const missing: any = await client.callTool({ name: 'get_frames', arguments: {} });
    expect(missing.isError).toBe(true);
    await client.close();
  });
});

describe('stored contact sheet', () => {
  it('FRM-15 every render stores a labelled sheet of the automatic tiles, each the frame it names; its links work with a read key or signed', async () => {
    const summary = await (await rest(`/v1/renders/${renderId}`, reader)).json();
    const sheet = summary.contactSheet;
    expect(sheet).toMatchObject({ file: 'contact-sheet.jpg', mode: 'auto', overlay: 'none', labels: true, tileWidth: 360, tileHeight: 640 });
    expect(summary.files).toContain('contact-sheet.jpg');
    // The same frames, labels and layout get_frames gives by default.
    const frames = await (await rest(`/v1/renders/${renderId}/frames`, reader)).json();
    expect(sheet.tiles).toEqual(frames.tiles.map(({ index: _index, ...t }: any) => t));
    expect([sheet.columns, sheet.rows]).toEqual([frames.columns, frames.rows]);
    const file = await rest(`/v1/renders/${renderId}/output?file=contact-sheet.jpg`, reader);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    const jpeg = Buffer.from(await file.arrayBuffer());
    expect(jpeg.length).toBe(sheet.bytes);
    expect(jpeg.length).toBeLessThan(1_000_000);
    // Tiles left to right, top to bottom, with a padding of tileWidth / 90 around each.
    const pad = Math.max(2, Math.round(sheet.tileWidth / 90));
    sheet.tiles.forEach((t: any, i: number) => {
      const [col, row] = [i % sheet.columns, Math.floor(i / sheet.columns)];
      expect(codeIn(jpeg, pad + col * (sheet.tileWidth + pad), pad + row * (sheet.tileHeight + pad)), `frame ${t.frame}`).toBe(codeOf(t.frame));
    });
    const signed = await fetch(new URL(sheet.downloadUrl, server.url));
    expect(signed.status).toBe(200);
    expect(Buffer.from(await signed.arrayBuffer()).equals(jpeg)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(dir);
  });

  it('FRM-16 get_render_output lists the sheet, and attaches it only with includeContactSheet', async () => {
    const client = new Client({ name: 'frames-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${reader}` } } }));
    const plain: any = await client.callTool({ name: 'get_render_output', arguments: { renderId } });
    expect(plain.isError).toBeFalsy();
    const body = JSON.parse(plain.content.find((c: any) => c.type === 'text').text);
    expect(body.contactSheet).toMatchObject({ file: 'contact-sheet.jpg', tiles: expect.any(Array) });
    expect(plain.content.filter((c: any) => c.type === 'image').map((c: any) => c.mimeType)).toEqual(['image/png']);
    const both: any = await client.callTool({ name: 'get_render_output', arguments: { renderId, includeContactSheet: true } });
    expect(both.content.filter((c: any) => c.type === 'image').map((c: any) => c.mimeType)).toEqual(['image/png', 'image/jpeg']);
    const only: any = await client.callTool({ name: 'get_render_output', arguments: { renderId, includePoster: false, includeContactSheet: true } });
    const images = only.content.filter((c: any) => c.type === 'image');
    expect(images.map((c: any) => c.mimeType)).toEqual(['image/jpeg']);
    expect(Buffer.from(images[0].data, 'base64').length).toBe(body.contactSheet.bytes);
    await client.close();
  });
});

describe('cache', () => {
  it('FRM-14 stills are cached per render and removed with the project', async () => {
    const cache = join(server.service.cacheDir, 'frames', renderId);
    expect(readdirSync(cache).some((f) => f.endsWith('.jpg'))).toBe(true);
    const again = await (await rest(`/v1/renders/${renderId}/frames`, reader)).json();
    expect(again.tiles).toHaveLength(9);
    expect((await rest('/v1/projects/frames-reel', admin, { method: 'DELETE' })).status).toBeLessThan(300);
    expect(existsSync(cache)).toBe(false);
    expect((await rest(`/v1/renders/${renderId}/frames`, reader)).status).toBe(404);
  });
});
