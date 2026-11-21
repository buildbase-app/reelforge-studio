import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEntry, R, X, type GalleryEntry } from '../src/catalog/build';
import { manifestHash } from '../src/manifests';
import { SAMPLE_RATE, musicWav, synth } from '../src/music';
import { BuildBaseCollections, GALLERY_FIELDS, apiFields, diffRecord, publishAll, recordData } from '../src/publish';
import { judge, parseSignals, posterTime } from '../src/quality';
import { CACHE_CONTROL, uploadAll } from '../src/r2';
import { isDone, pool, renderAll, renderEntry, type Meta } from '../src/render';
import { RecordingCaller, ToolError, type ToolCaller } from '../src/studio';
import { budgetBytes } from '../src/transcode';

const dir = mkdtempSync(join(tmpdir(), 'reelforge-gallery-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry: GalleryEntry = buildEntry({
  slug: 'unit-reel',
  title: 'Unit reel',
  category: 'Test',
  tags: ['a', 'b'],
  palette: 'paper',
  music: 'lofi',
  prompt: 'A reel used by the unit tests of the gallery pipeline, long enough to read like a prompt.',
  scenes: [R(2, 'Hello'), X('stat', 2, { value: 3, label: 'tests' })],
});

describe('quality gate parsing', () => {
  it('reads blackdetect, freezedetect and volumedetect output', () => {
    const stderr = `[blackdetect @ 0x1] black_start:0 black_end:0.6 black_duration:0.6
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 3.2
[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 2.8
[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 6
[Parsed_volumedetect_0 @ 0x3] mean_volume: -21.4 dB
[Parsed_volumedetect_0 @ 0x3] max_volume: -3.0 dB`;
    expect(parseSignals(stderr)).toEqual({ black: [{ start: 0, end: 0.6 }], frozen: [{ start: 3.2, end: 6 }], meanVolumeDb: -21.4, maxVolumeDb: -3 });
    expect(parseSignals('mean_volume: -inf dB').meanVolumeDb).toBe(-Infinity);
  });

  it('judges size, fps, frames, black/frozen stretches and silent music', () => {
    const good = { width: 1080, height: 1920, fps: 30, frames: 120, durationSeconds: 4, videoCodec: 'h264', audioCodec: 'aac' };
    const quiet = { black: [], frozen: [], meanVolumeDb: -20, maxVolumeDb: -3 };
    expect(judge({ durationSeconds: 4, music: 'lofi' }, good, quiet)).toEqual([]);
    const bad = judge({ durationSeconds: 4, music: 'lofi' }, { ...good, width: 720, frames: 100, fps: 25 }, { black: [{ start: 1, end: 2 }], frozen: [{ start: 0, end: Infinity }], meanVolumeDb: -91, maxVolumeDb: -91 });
    expect(bad.join('\n')).toMatch(/size 720x1920/);
    expect(bad.join('\n')).toMatch(/fps 25/);
    expect(bad.join('\n')).toMatch(/100 frames, expected 120/);
    expect(bad.join('\n')).toMatch(/black frames 1.00-2.00/);
    expect(bad.join('\n')).toMatch(/frozen 0.00-end/);
    expect(bad.join('\n')).toMatch(/silent/);
    // No music: a silent track is expected.
    expect(judge({ durationSeconds: 4, music: null }, good, { ...quiet, meanVolumeDb: -91 })).toEqual([]);
  });

  it('takes the poster from the end of the first scene', () => {
    expect(posterTime(entry.manifest)).toBeCloseTo(1.2);
    expect(posterTime({ scenes: [{ durationSeconds: 10 }] })).toBe(3.2);
  });
});

describe('transcode budgets', () => {
  it('follows SITE_PLAN B.6: 800 KB up to 15 s, scaled above, 1.5 MB for featured', () => {
    expect(budgetBytes(12, false)).toBe(800 * 1024);
    expect(budgetBytes(15, false)).toBe(800 * 1024);
    expect(budgetBytes(18, false)).toBe(Math.round(960 * 1024));
    expect(budgetBytes(25, false)).toBe(1200 * 1024);
    expect(budgetBytes(25, true)).toBe(1500 * 1024);
  });
});

describe('procedural music', () => {
  it('is deterministic, the right length, normalised, and a valid WAV', () => {
    const a = musicWav('pulse', 2);
    expect(a.equals(musicWav('pulse', 2))).toBe(true);
    expect(a.subarray(0, 4).toString()).toBe('RIFF');
    expect(a.subarray(8, 12).toString()).toBe('WAVE');
    expect(a.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(a.length).toBe(44 + 2 * SAMPLE_RATE * 2);
    const pcm = synth('ambient', 3);
    const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(20000);
    expect(peak).toBeLessThanOrEqual(23200);
    expect(musicWav('drive', 2).equals(a)).toBe(false);
  });
});

describe('pool', () => {
  it('never runs more than n at once and runs everything', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await pool([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((ok) => setTimeout(ok, 5));
      done.push(n);
      running--;
    });
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

/** A fake studio: MCP tools in memory plus an HTTP server for downloads. */
function fakeStudio(opts: { failRender?: number; existing?: boolean } = {}) {
  const calls: { name: string; args: any }[] = [];
  let renders = 0;
  let exists = Boolean(opts.existing);
  const caller: ToolCaller = {
    async call(name, args) {
      calls.push({ name, args });
      switch (name) {
        case 'create_project':
          if (exists) throw new ToolError(name, 'conflict', 'project already exists');
          exists = true;
          return { manifest: args.manifest };
        case 'delete_project':
          exists = false;
          return { deleted: true };
        case 'upload_asset':
          return { id: 'ast-0000000000000001' };
        case 'set_audio':
          return { ok: true };
        case 'validate_project':
          return { ok: true, errors: [], warnings: [] };
        case 'render_project':
          renders++;
          return { job: { id: `job-${renders}`, status: 'queued' } };
        case 'get_job':
          if (opts.failRender && renders <= opts.failRender) return { id: args.jobId, status: 'failed', error: { code: 'render_failed', message: 'Target crashed' } };
          return { id: args.jobId, status: 'succeeded', result: { renderId: 'r1' } };
        case 'get_job_logs':
          return { lines: ['boom'] };
        case 'get_render_output':
          return { renderId: 'r1', downloadUrl: '/dl/final.mp4', manifestUrl: '/dl/render-manifest.json' };
        default:
          throw new Error(`unexpected tool ${name}`);
      }
    },
    close: async () => undefined,
  };
  return { caller, calls };
}

describe('render over MCP (fake studio)', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/dl/final.mp4') {
        res.end(Buffer.alloc(1234, 1));
      } else if (req.url === '/dl/render-manifest.json') {
        expect(req.headers.authorization).toBe('Bearer rf_test');
        res.end(
          JSON.stringify({
            wallClockMillis: 12345,
            createdAt: '2026-11-21T10:00:00.000Z',
            output: { width: 1080, height: 1920, fps: 30, frames: 120, durationSeconds: 4 },
            versions: { server: '0.1.0', engines: { remotion: '4.0.545', html: 'reelforge-html/0.1.0' }, ffmpeg: 'ffmpeg version 6.1.1\nmore' },
            checks: { metadata: 'pass', decode: 'pass', duration: 'pass' },
          })
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it('creates, adds music, validates, renders with idempotency keys, downloads and writes meta.json', async () => {
    const out = join(dir, 'render1');
    const { caller, calls } = fakeStudio();
    const meta = await renderEntry(caller, entry, { outDir: out, studioUrl: url, key: 'rf_test' });
    expect(calls.map((c) => c.name)).toEqual(['create_project', 'upload_asset', 'set_audio', 'validate_project', 'render_project', 'get_job', 'get_render_output', 'delete_project']);
    const hash = manifestHash(entry.manifest);
    expect(calls[0]!.args.idempotencyKey).toBe(`gallery-unit-reel-${hash.slice(0, 16)}-create`);
    expect(calls[4]!.args.idempotencyKey).toBe(`gallery-unit-reel-${hash.slice(0, 16)}-render`);
    expect(calls[1]!.args.license).toMatchObject({ name: 'CC0-1.0', redistributable: true });
    expect(calls[5]!.args.waitSeconds).toBe(45);
    expect(readFileSync(join(out, 'unit-reel', 'final.mp4')).length).toBe(1234);
    const onDisk = JSON.parse(readFileSync(join(out, 'unit-reel', 'meta.json'), 'utf8')) as Meta;
    expect(onDisk).toEqual(meta);
    expect(meta).toMatchObject({ slug: 'unit-reel', renderSeconds: 12.3, frames: 120, width: 1080, height: 1920, studioVersion: '0.1.0', ffmpeg: 'ffmpeg version 6.1.1', bytes: 1234, manifestHash: hash, music: 'lofi' });
    expect(meta.toolsCalled).toContain('render_project');
    expect(meta.prompt).toBe(entry.gallery.prompt);
    expect(isDone(out, entry)).toBe(true);
  });

  it('replaces an existing project, skips done reels and retries a failed render once', async () => {
    const out = join(dir, 'render2');
    const { caller, calls } = fakeStudio({ existing: true, failRender: 1 });
    const res = await renderAll(caller, [entry], { outDir: out, studioUrl: url, key: 'rf_test', concurrency: 2, log: () => undefined });
    expect(res).toMatchObject({ rendered: ['unit-reel'], failed: [] });
    expect(calls.filter((c) => c.name === 'render_project')).toHaveLength(2);
    expect(calls[1]!.name).toBe('delete_project');
    const again = await renderAll(caller, [entry], { outDir: out, studioUrl: url, key: 'rf_test', concurrency: 2, log: () => undefined });
    expect(again.skipped).toEqual(['unit-reel']);
  });

  it('records tool names in first-call order', async () => {
    const inner: ToolCaller = { call: async () => ({}), close: async () => undefined };
    const r = new RecordingCaller(inner);
    await r.call('a', {});
    await r.call('b', {});
    await r.call('a', {});
    expect(r.tools()).toEqual(['a', 'b']);
    expect(r.calls).toHaveLength(3);
  });
});

/** A gallery output with one transcoded reel, for publish and upload. */
function fakeOutput(root: string): string {
  const out = join(root, 'out');
  const slug = 'unit-reel';
  mkdirSync(join(out, slug), { recursive: true });
  mkdirSync(join(out, 'web', slug), { recursive: true });
  const meta: Partial<Meta> = {
    slug,
    title: 'Unit reel',
    description: 'd',
    category: 'Test',
    tags: ['a', 'b'],
    engines: ['remotion', 'html'],
    theme: 'default',
    featured: true,
    durationSeconds: 4,
    frames: 120,
    fps: 30,
    renderSeconds: 12.3,
    hardware: { cpu: 'Example CPU', cores: 4, ramGb: 16, os: 'Linux' },
    studioVersion: '0.1.0',
    engineVersions: { remotion: '4.0.545' },
    renderedAt: '2026-11-21T10:00:00.000Z',
    prompt: 'p',
    toolsCalled: ['create_project', 'render_project'],
    mcpCalls: 2,
    manifestHash: 'h',
  };
  writeFileSync(join(out, slug, 'meta.json'), JSON.stringify(meta));
  const f = (name: string, contentType: string) => {
    const file = join(out, 'web', slug, name);
    writeFileSync(file, name);
    return { key: `gallery/${slug}/${name}`, file, bytes: name.length, sha256: 'x', contentType };
  };
  const media = {
    slug,
    mp4: f('unit-reel.aaaaaaaaaaaa.mp4', 'video/mp4'),
    webm: f('unit-reel.bbbbbbbbbbbb.webm', 'video/webm'),
    poster: {
      avif: f('poster.cccccccccccc.avif', 'image/avif'),
      jpg: f('poster.dddddddddddd.jpg', 'image/jpeg'),
      avif360: f('poster-360.eeeeeeeeeeee.avif', 'image/avif'),
      jpg360: f('poster-360.ffffffffffff.jpg', 'image/jpeg'),
    },
    crf: { mp4: 23, webm: 34 },
    budgetBytes: 1,
  };
  writeFileSync(join(out, 'web', 'media.json'), JSON.stringify({ entries: { [slug]: media } }));
  const ex = join(root, 'examples');
  mkdirSync(ex, { recursive: true });
  writeFileSync(join(ex, `${slug}.json`), JSON.stringify(entry));
  return out;
}

/** A fake BuildBase org API (collections, versions, records) behind a fetch function. */
function fakeBuildBase() {
  const state = { collections: [] as any[], versions: [] as any[], records: [] as any[], log: [] as string[] };
  let id = 0;
  const f: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.log.push(`${method} ${u.pathname}`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer org:secret');
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    const p = u.pathname;
    if (p === '/api/collections' && method === 'GET') return json({ docs: state.collections });
    if (p === '/api/collections' && method === 'POST') {
      const c = { _id: `c${++id}`, ...body };
      state.collections.push(c);
      return json(c);
    }
    let m = /^\/api\/collections\/([^/]+)\/versions$/.exec(p);
    if (m && method === 'GET') return json(state.versions.filter((v) => v.collectionId === m![1]));
    if (m && method === 'POST') {
      const v = { _id: `v${++id}`, collectionId: m[1], name: body.name, live: false, fields: [] };
      state.versions.push(v);
      return json(v);
    }
    m = /^\/api\/collections\/([^/]+)\/versions\/([^/]+)$/.exec(p);
    if (m && method === 'PATCH') {
      const v = state.versions.find((x) => x._id === m![2]);
      Object.assign(v, body);
      return json(v);
    }
    if (m && method === 'GET') return json(state.versions.find((x) => x._id === m![2]));
    if (p === '/api/collections/data/gallery') return json({ docs: state.records, hasNextPage: false });
    m = /^\/api\/collections\/([^/]+)\/versions\/([^/]+)\/records$/.exec(p);
    if (m && method === 'POST') {
      const r = { _id: `r${++id}`, versionId: m[2], data: body };
      state.records.push(r);
      return json(r);
    }
    m = /^\/api\/collections\/([^/]+)\/versions\/([^/]+)\/records\/([^/]+)$/.exec(p);
    if (m && method === 'PATCH') {
      const r = state.records.find((x) => x._id === m![3]);
      Object.assign(r.data, body);
      return json(r);
    }
    return json({ error: true, message: 'not found' }, 404);
  };
  return { state, f };
}

describe('publish to the BuildBase Collection (fake API)', () => {
  it('defines a schema the versions API accepts', () => {
    const f = apiFields();
    expect(f.map((x) => x.slug)).toEqual(GALLERY_FIELDS.map((x) => x.slug));
    for (const x of f) expect(x).toHaveProperty('helpText');
    expect(f.find((x) => x.slug === 'status')).toMatchObject({ type: 'select', required: true });
  });

  it('creates the collection with a live v1, writes hidden records until media answers, then is idempotent', async () => {
    const out = fakeOutput(join(dir, 'pub'));
    const bb = fakeBuildBase();
    const offline: typeof fetch = async (input, init) => (String(input).startsWith('https://media.example') ? new Response(null, { status: 404 }) : bb.f(input, init));
    const r1 = await publishAll(out, { token: 'org:secret', server: 'https://bb.example', baseUrl: 'https://media.example', fetch: offline, log: () => undefined });
    expect(r1).toEqual({ created: 1, updated: 0, unchanged: 0, published: 0, hidden: 1 });
    expect(bb.state.collections[0]).toMatchObject({ slug: 'gallery', name: 'Gallery' });
    expect(bb.state.versions[0]).toMatchObject({ live: true });
    expect(bb.state.records[0].data).toMatchObject({ slug: 'unit-reel', status: 'hidden', mp4Path: 'gallery/unit-reel/unit-reel.aaaaaaaaaaaa.mp4', tools: 'create_project, render_project', featured: true });

    const r2 = await publishAll(out, { token: 'org:secret', server: 'https://bb.example', baseUrl: 'https://media.example', fetch: offline, log: () => undefined });
    expect(r2).toMatchObject({ created: 0, updated: 0, unchanged: 1 });

    // Media is live now: the record flips to published with a PATCH of that one field.
    const online: typeof fetch = async (input, init) => (String(input).startsWith('https://media.example') ? new Response(null, { status: 200 }) : bb.f(input, init));
    bb.state.log.length = 0;
    const r3 = await publishAll(out, { token: 'org:secret', server: 'https://bb.example', baseUrl: 'https://media.example', fetch: online, log: () => undefined });
    expect(r3).toMatchObject({ updated: 1, published: 1 });
    expect(bb.state.records[0].data.status).toBe('published');
    expect(bb.state.log.filter((l) => l.startsWith('PATCH'))).toHaveLength(1);
  });

  it('dry run writes nothing', async () => {
    const out = fakeOutput(join(dir, 'pub2'));
    const bb = fakeBuildBase();
    await publishAll(out, { token: 'org:secret', server: 'https://bb.example', baseUrl: 'https://media.example', fetch: bb.f, dryRun: true, log: () => undefined, status: 'hidden' });
    expect(bb.state.log.every((l) => l.startsWith('GET'))).toBe(true);
  });

  it('diffs records field by field', async () => {
    expect(diffRecord({ a: 1, tags: ['x', 'y'], renderedAt: '2026-11-21T10:00:00Z' }, { a: 1, tags: ['y', 'x'], renderedAt: '2026-11-21T10:00:00.000Z' })).toEqual({});
    expect(diffRecord({ a: 1 }, { a: 2, b: '' })).toEqual({ a: 2 });
    const meta = JSON.parse(readFileSync(join(fakeOutput(join(dir, 'pub3')), 'unit-reel', 'meta.json'), 'utf8'));
    expect(recordData(meta, undefined, undefined, 10, 'hidden')).toMatchObject({ mp4Path: '', status: 'hidden', order: 10, hardware: 'Example, 4 cores, 16 GB RAM' });
    const { hardwareLabel } = await import('../src/publish');
    expect(hardwareLabel({ cpu: 'Intel(R) Xeon(R) Processor @ 2.10GHz', cores: 4, ramGb: 16, os: 'Linux 6' })).toBe('Intel Xeon @ 2.10GHz, 4 cores, 16 GB RAM');
  });

  it('refuses a live version without the gallery fields', async () => {
    const bb = fakeBuildBase();
    bb.state.collections.push({ _id: 'c1', slug: 'gallery' });
    bb.state.versions.push({ _id: 'v1', collectionId: 'c1', live: true, fields: [{ slug: 'title' }] });
    await expect(new BuildBaseCollections('https://bb.example', 'org:secret', bb.f).ensureCollection()).rejects.toThrow(/lacks fields/);
  });
});

describe('upload to R2 (fake Cloudflare API)', () => {
  it('creates the bucket, puts hashed keys with immutable cache headers, writes urls.json, and skips what it uploaded before', async () => {
    const root = join(dir, 'r2');
    const out = fakeOutput(root);
    const puts: { key: string; headers: Record<string, string> }[] = [];
    let buckets: string[] = [];
    const f: typeof fetch = async (input, init) => {
      const u = new URL(String(input));
      expect(u.origin).toBe('https://api.cloudflare.com');
      expect(u.pathname.startsWith('/client/v4/accounts/acc/r2/buckets')).toBe(true);
      const method = init?.method ?? 'GET';
      if (method === 'GET') return new Response(JSON.stringify({ success: true, result: { buckets: buckets.map((name) => ({ name })) } }));
      if (method === 'POST') {
        buckets.push(JSON.parse(String(init!.body)).name);
        return new Response(JSON.stringify({ success: true, result: {} }));
      }
      puts.push({ key: decodeURIComponent(u.pathname.split('/objects/')[1]!), headers: init!.headers as Record<string, string> });
      return new Response(JSON.stringify({ success: true, result: {} }));
    };
    const dry = await uploadAll(out, { dryRun: true, examplesDir: join(root, 'examples'), log: () => undefined, fetch: f, account: 'acc', token: 't' });
    expect(dry.uploaded).toBe(0);
    expect(puts).toHaveLength(0);
    const r = await uploadAll(out, { examplesDir: join(root, 'examples'), baseUrl: 'https://media.example/', log: () => undefined, fetch: f, account: 'acc', token: 't' });
    expect(buckets).toEqual(['reelforge-media']);
    expect(r.uploaded).toBe(7);
    expect(puts.every((p) => p.headers['Cache-Control'] === CACHE_CONTROL)).toBe(true);
    expect(puts.find((p) => p.key.endsWith('.mp4'))!.headers['Content-Type']).toBe('video/mp4');
    expect(puts.some((p) => /^gallery\/unit-reel\/manifest\.[0-9a-f]{12}\.json$/.test(p.key))).toBe(true);
    const urls = JSON.parse(readFileSync(join(out, 'web', 'urls.json'), 'utf8'));
    expect(urls.files['gallery/unit-reel/unit-reel.aaaaaaaaaaaa.mp4']).toBe('https://media.example/gallery/unit-reel/unit-reel.aaaaaaaaaaaa.mp4');
    expect(existsSync(join(out, 'web', 'r2-uploaded.json'))).toBe(true);
    const again = await uploadAll(out, { examplesDir: join(root, 'examples'), log: () => undefined, fetch: f, account: 'acc', token: 't' });
    expect(again).toMatchObject({ uploaded: 0, skipped: 7 });
    buckets = [];
  });
});

describe('local media server', () => {
  it('maps bucket paths to the web folder and refuses anything else', async () => {
    const { resolveMediaPath } = await import('../src/serve');
    expect(resolveMediaPath('/w', '/gallery/a-b/x.123.mp4')).toBe('/w/a-b/x.123.mp4');
    expect(resolveMediaPath('/w', '/gallery/a/../../etc/passwd')).toBeNull();
    expect(resolveMediaPath('/w', '/etc/passwd')).toBeNull();
  });
});
