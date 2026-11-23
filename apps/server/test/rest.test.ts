import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ElevenLabsTts, PluginRegistry, RemotionLambdaBackend, ReelforgeService } from '@reelforge/core';
import { prepareDatabase, type Database } from '@reelforge/db';
import { createApp, loadConfig, type ServerConfig } from '../src/index';
import { testDatabase } from './serverProcess';
import { fakeEngine, makeTone, tempDir } from '../../../packages/core/test/helpers';

const { dir, cleanup } = tempDir('reelforge-rest-');
let db: Database;
let dropDb: () => Promise<void> = async () => undefined;
afterAll(async () => {
  await service?.jobs.flush();
  await db?.close();
  await dropDb();
  cleanup();
});
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));

let app: ReturnType<typeof createApp>;
let service: ReelforgeService;
let admin: string;
let reader: string;
let config: ServerConfig;
let providerEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  await makeTone(join(dir, 'tone.mp3'), 2);
  providerEnv = {};
  const registry = new PluginRegistry()
    .registerEngine(fakeEngine('remotion'))
    .registerEngine(fakeEngine('motion-canvas'))
    .registerProvider(new ElevenLabsTts(providerEnv))
    .registerBackend(new RemotionLambdaBackend({}));
  config = { ...loadConfig({ REELFORGE_DATA_DIR: join(dir, 'data'), REELFORGE_PUBLIC_URL: 'https://studio.example.com' }), maxJsonBytes: 64 * 1024 };
  const database = await testDatabase(dir);
  dropDb = database.drop;
  db = (await prepareDatabase({ url: database.url ?? config.databaseUrl, dataDir: config.dataDir })).db;
  service = await ReelforgeService.create(registry, {
    repositories: db.repositories(),
    dataDir: config.dataDir,
    publicUrl: config.publicUrl,
    providerEnv,
    configSources: { env: { REELFORGE_SECRET_KEY: 'test-secret-key-0123456789-abcdefghij', REELFORGE_LICENCE_MODE: 'off' } },
  });
  admin = (await service.keys.create('admin', ['admin'])).key;
  reader = (await service.keys.create('reader', ['read'])).key;
  app = createApp({ service, config });
});

function req(method: string, path: string, opts: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: 'localhost', ...(opts.headers ?? {}) };
  const key = opts.key === undefined ? admin : opts.key;
  if (key) headers.authorization = `Bearer ${key}`;
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] ??= 'application/json';
  }
  return app.request(path, { method, headers, body });
}

async function pollJob(id: string) {
  for (let i = 0; i < 600; i++) {
    const job = (await (await req('GET', `/v1/jobs/${id}`)).json()) as { status: string; result?: any; error?: any };
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job did not finish');
}

describe('health and discovery', () => {
  it('serves /healthz, /readyz and the MCP server card without auth', async () => {
    expect((await req('GET', '/healthz', { key: null })).status).toBe(200);
    const ready = await req('GET', '/readyz', { key: null });
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as any).checks.ffmpeg).toBe('ok');
    const card = (await (await req('GET', '/.well-known/mcp.json', { key: null })).json()) as any;
    expect(card.endpoint).toBe('https://studio.example.com/mcp');
    expect(card.tools.map((t: any) => t.name)).toContain('render_project');
  });

  it('answers unknown routes with a JSON error', async () => {
    const r = await req('GET', '/nope');
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error.code).toBe('not_found');
  });
});

describe('auth', () => {
  it('requires a valid Bearer key', async () => {
    const none = await req('GET', '/v1/capabilities', { key: null });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await req('GET', '/v1/capabilities', { key: 'rf_wrongwrongwrongwrongwrong' })).status).toBe(401);
    expect((await req('GET', '/v1/capabilities', { key: reader })).status).toBe(200);
  });

  it('enforces scopes', async () => {
    const r = await req('POST', '/v1/projects', { key: reader, body: sample });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe('forbidden');
    expect((await req('GET', '/v1/keys', { key: reader })).status).toBe(403);
  });

  it('manages keys (admin), never returning hashes', async () => {
    const created = await req('POST', '/v1/keys', { body: { name: 'agent', scopes: ['read', 'write'] } });
    expect(created.status).toBe(201);
    const { key, record } = (await created.json()) as any;
    expect(key).toMatch(/^rf_/);
    expect((await req('GET', '/v1/capabilities', { key })).status).toBe(200);
    const list = await (await req('GET', '/v1/keys')).text();
    expect(list).not.toContain('hash');
    expect(list).not.toContain(key);
    expect((await req('DELETE', `/v1/keys/${record.id}`)).status).toBe(204);
    expect((await req('GET', '/v1/capabilities', { key })).status).toBe(401);
  });

  it('rate-limits per key', async () => {
    const limited = createApp({ service, config: { ...config, rateLimitPerMinute: 2 } });
    const call = () => limited.request('/v1/capabilities', { headers: { host: 'localhost', authorization: `Bearer ${reader}` } });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const third = await call();
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
  });

  it('protects /mcp against DNS rebinding (Host and Origin)', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const headers = { accept: 'application/json, text/event-stream' };
    expect((await req('POST', '/mcp', { body: init, headers: { ...headers, host: 'evil.example' } })).status).toBe(403);
    expect((await req('POST', '/mcp', { body: init, headers: { ...headers, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await req('POST', '/mcp', { key: null, body: init, headers })).status).toBe(401);
    expect((await req('POST', '/mcp', { body: init, headers: { ...headers, host: 'studio.example.com', origin: 'https://studio.example.com' } })).status).not.toBe(403);
  });
});

describe('REST v1', () => {
  it('reports capabilities, schema and templates', async () => {
    const caps = (await (await req('GET', '/v1/capabilities')).json()) as any;
    expect(caps.engines.map((e: any) => e.id)).toEqual(['remotion', 'motion-canvas']);
    const schema = (await (await req('GET', '/v1/schema/project')).json()) as any;
    expect(schema.type).toBe('object');
    const t = (await (await req('GET', '/v1/templates?engine=remotion')).json()) as any;
    expect(t.templates[0].id).toBe('kinetic-title');
    expect(t.templates[0].propsSchema.properties.headline).toBeTruthy();
  });

  it('creates a project from a v0.1 manifest and reports problems with paths', async () => {
    const r = await req('POST', '/v1/projects', { body: sample });
    expect(r.status).toBe(201);
    const created = (await r.json()) as any;
    expect(created.manifest.schemaVersion).toBe('0.2');
    expect(created.migratedFrom).toBe('0.1');
    const bad = await req('POST', '/v1/projects', { body: { ...sample, projectId: 'bad', output: { ...sample.output, fps: 29 } } });
    expect(bad.status).toBe(422);
    const err = ((await bad.json()) as any).error;
    expect(err.code).toBe('invalid_manifest');
    expect(err.details.issues.some((i: any) => i.path.startsWith('output.fps'))).toBe(true);
    // The message lists the supported frame rates (#322).
    expect(err.details.issues.find((i: any) => i.path === 'output.fps')?.message).toBe('fps must be one of 24, 25, 30, 60 (got 29)');
    expect((await req('POST', '/v1/projects', { body: 'not json' })).status).toBe(400);
  });

  it('patches with JSON merge patch and If-Match', async () => {
    const cur = (await (await req('GET', '/v1/projects/sample-reel')).json()) as any;
    const r = await req('PATCH', '/v1/projects/sample-reel', { body: { title: 'From REST' }, headers: { 'if-match': `"${cur.meta.version}"` } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).manifest.title).toBe('From REST');
    const stale = await req('PATCH', '/v1/projects/sample-reel', { body: { title: 'x' }, headers: { 'if-match': String(cur.meta.version) } });
    expect(stale.status).toBe(409);
    expect(((await (await req('GET', '/v1/projects/sample-reel/versions')).json()) as any).versions.length).toBe(2);
  });

  it('edits scenes including scenes:reorder', async () => {
    const add = await req('POST', '/v1/projects/sample-reel/scenes', {
      body: { scene: { id: 'cta', engine: 'remotion', template: 'kinetic-title', props: { headline: 'Follow' }, durationSeconds: 2 }, index: 0 },
    });
    expect(add.status).toBe(201);
    expect(((await add.json()) as any).manifest.scenes[0].id).toBe('cta');
    const patch = await req('PATCH', '/v1/projects/sample-reel/scenes/cta', { body: { props: { subline: 'for more' } } });
    expect(((await patch.json()) as any).manifest.scenes[0].props).toEqual({ headline: 'Follow', subline: 'for more' });
    const reorder = await req('POST', '/v1/projects/sample-reel/scenes:reorder', { body: { order: ['hook', 'how-it-works', 'cta'] } });
    expect(reorder.status).toBe(200);
    expect(((await reorder.json()) as any).manifest.scenes.map((s: any) => s.id)).toEqual(['hook', 'how-it-works', 'cta']);
    const del = await req('DELETE', '/v1/projects/sample-reel/scenes/cta');
    expect(((await del.json()) as any).manifest.scenes.length).toBe(2);
    expect((await req('DELETE', '/v1/projects/sample-reel/scenes/cta')).status).toBe(404);
  });

  it('manages themes', async () => {
    const tokens = { colors: { background: '#101010', surface: '#202020', text: '#ffffff', mutedText: '#bbbbbb', accent: '#22aaff', accent2: '#ffaa22' }, fontFamily: 'Arial, sans-serif' };
    expect((await req('POST', '/v1/themes', { body: { id: 'acme', name: 'Acme', tokens } })).status).toBe(201);
    expect(((await (await req('GET', '/v1/themes')).json()) as any).themes.map((t: any) => t.id)).toEqual(['default', 'midnight', 'acme']);
    expect((await req('PUT', '/v1/themes/acme', { body: { name: 'Acme 2', tokens } })).status).toBe(200);
    expect((await req('PUT', '/v1/themes/default', { body: { name: 'x', tokens } })).status).toBe(409);
    expect((await req('PUT', '/v1/projects/sample-reel/theme', { body: { theme: 'acme' } })).status).toBe(200);
    expect((await req('POST', '/v1/themes', { body: { id: 'bad', name: 'Bad', tokens: { colors: {} } } })).status).toBe(422);
  });

  it('uploads assets (multipart) and refuses unsafe URLs', async () => {
    const form = new FormData();
    form.set('file', new Blob([readFileSync(join(dir, 'tone.mp3'))], { type: 'audio/mpeg' }), 'tone.mp3');
    form.set('projectId', 'sample-reel');
    form.set('assetId', 'music');
    form.set('license', JSON.stringify({ name: 'CC0-1.0', redistributable: true }));
    const up = await req('POST', '/v1/assets', { body: form });
    expect(up.status).toBe(201);
    const { asset } = (await up.json()) as any;
    expect(asset.contentType).toBe('audio/mpeg');
    expect(((await (await req('GET', `/v1/assets/${asset.id}`)).json()) as any).sha256).toHaveLength(64);
    const ssrf = await req('POST', '/v1/assets', { body: { url: 'https://169.254.169.254/latest' } });
    expect(ssrf.status).toBe(400);
    expect(((await ssrf.json()) as any).error.code).toBe('url_not_allowed');
    expect((await req('POST', '/v1/assets', { body: { url: 'http://example.com/a.mp3' } })).status).toBe(400);
    expect((await req('PATCH', '/v1/projects/sample-reel/audio', { body: { music: { asset: 'music', volume: 0.6 } } })).status).toBe(200);
  });

  it('validates', async () => {
    const r = (await (await req('POST', '/v1/projects/sample-reel/validate')).json()) as any;
    expect(r.ok).toBe(true);
    expect(r.summary).toMatchObject({ totalFrames: 210, width: 1080, height: 1920, fps: 30 });
  });

  it('renders, streams job events and logs, lists outputs and serves the MP4 with Range', async () => {
    const start = await req('POST', '/v1/projects/sample-reel/renders', { body: {} });
    expect(start.status).toBe(202);
    const { job } = (await start.json()) as any;
    const done = await pollJob(job.id);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const renderId = done.result.renderId;
    expect(done.result.outputUrl).toBe(`https://studio.example.com/v1/renders/${renderId}/output`);

    const events = await (await req('GET', `/v1/jobs/${job.id}/events`)).text();
    expect(events).toContain('event: status');
    expect(events).toContain('"succeeded"');
    const logs = (await (await req('GET', `/v1/jobs/${job.id}/logs?tail=5`)).json()) as any;
    expect(logs.lines.length).toBeLessThanOrEqual(5);

    const renders = (await (await req('GET', '/v1/projects/sample-reel/renders')).json()) as any;
    expect(renders.renders[0].renderId).toBe(renderId);
    const full = await req('GET', `/v1/renders/${renderId}/output`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    const size = Number(full.headers.get('content-length'));
    expect(size).toBeGreaterThan(1000);
    const part = await req('GET', `/v1/renders/${renderId}/output`, { headers: { range: 'bytes=0-99' } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    // Signed link: works without a key, only for that file, only until it expires.
    const signed = new URL(done.result.downloadUrl);
    expect(signed.searchParams.get('sig')).toBeTruthy();
    const viaLink = await req('GET', signed.pathname + signed.search, { key: null });
    expect(viaLink.status).toBe(200);
    expect(viaLink.headers.get('content-type')).toBe('video/mp4');
    const tampered = new URL(signed);
    tampered.searchParams.set('file', 'render-manifest.json');
    expect((await req('GET', tampered.pathname + tampered.search, { key: null })).status).toBe(401);
    tampered.searchParams.delete('file');
    tampered.searchParams.set('expires', String(Number(signed.searchParams.get('expires')) + 1));
    expect((await req('GET', tampered.pathname + tampered.search, { key: null })).status).toBe(401);
    const manifest = (await (await req('GET', `/v1/renders/${renderId}/output?file=render-manifest.json`)).json()) as any;
    expect(manifest.audio.music.asset).toBe('music');
    expect((await req('GET', `/v1/renders/${renderId}/output?file=../../keys.json`)).status).toBe(400);
  }, 120_000);

  it('imports captions and serves the sidecars of a render (captions option), signed links included', async () => {
    const bad = await req('POST', '/v1/projects/sample-reel/captions/import', { body: { content: '1\n00:00:01 --> 00:00:02\nHi' } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).error).toMatchObject({ code: 'invalid_captions', details: { line: 2 } });
    const imp = await req('POST', '/v1/projects/sample-reel/captions/import', { body: { content: 'WEBVTT\n\n00:00.500 --> 00:02.000\nHello reels\n', language: 'en' } });
    expect(imp.status).toBe(200);
    expect(((await imp.json()) as any)).toMatchObject({ imported: 1, manifest: { captions: { cues: [{ start: 0.5, end: 2, text: 'Hello reels' }] } } });
    expect((await req('POST', '/v1/projects/sample-reel/renders', { body: { captions: 'sometimes' } })).status).toBe(400);
    const start = await req('POST', '/v1/projects/sample-reel/renders', { body: { captions: 'sidecar' } });
    expect(start.status).toBe(202);
    const done = await pollJob(((await start.json()) as any).job.id);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const summary = (await (await req('GET', `/v1/renders/${done.result.renderId}`)).json()) as any;
    expect(summary.captions).toMatchObject({ mode: 'sidecar', burned: false, cues: 1, language: 'en' });
    const vtt = await req('GET', `/v1/renders/${done.result.renderId}/output?file=captions.vtt`);
    expect(vtt.headers.get('content-type')).toMatch(/^text\/vtt/);
    expect(await vtt.text()).toBe('WEBVTT\nLanguage: en\n\n00:00:00.500 --> 00:00:02.000\nHello reels\n');
    const link = new URL(summary.captions.files.find((f: any) => f.format === 'srt').downloadUrl);
    const viaLink = await req('GET', link.pathname + link.search, { key: null });
    expect(viaLink.status).toBe(200);
    expect(await viaLink.text()).toBe('1\n00:00:00,500 --> 00:00:02,000\nHello reels\n');
    await service.updateProject('sample-reel', { captions: { cues: null, language: null } });
  }, 120_000);

  it('rejects renders on unconfigured backends and runs on unconfigured providers', async () => {
    const lambda = await req('POST', '/v1/projects/sample-reel/renders', { body: { backend: 'remotion-lambda' } });
    expect(lambda.status).toBe(409);
    expect(((await lambda.json()) as any).error.code).toBe('backend_not_configured');
    const tts = await req('POST', '/v1/providers/elevenlabs/run', { body: { params: { text: 'Hi', voiceId: 'abc' } } });
    expect(tts.status).toBe(409);
    expect(((await tts.json()) as any).error.code).toBe('provider_not_configured');
  });

  it('configures providers over the API without ever returning key values (admin only)', async () => {
    const before = (await (await req('GET', '/v1/providers')).json()) as any;
    expect(before.providers[0]).toMatchObject({ id: 'elevenlabs', configured: false, settings: [{ name: 'ELEVENLABS_API_KEY', set: false, source: 'unset' }] });
    expect((await req('PUT', '/v1/providers/elevenlabs/config', { key: reader, body: { values: { ELEVENLABS_API_KEY: 'sk_secret_value_123' } } })).status).toBe(403);
    expect((await req('PUT', '/v1/providers/elevenlabs/config', { body: { values: { OTHER: 'x' } } })).status).toBe(400);
    const set = await req('PUT', '/v1/providers/elevenlabs/config', { body: { values: { ELEVENLABS_API_KEY: 'sk_secret_value_123' } } });
    expect(set.status).toBe(200);
    const setText = await set.text();
    expect(setText).not.toContain('sk_secret_value_123');
    expect(JSON.parse(setText)).toMatchObject({ configured: true, settings: [{ name: 'ELEVENLABS_API_KEY', set: true, source: 'api' }] });
    for (const path of ['/v1/providers', '/v1/capabilities']) expect(await (await req('GET', path)).text()).not.toContain('sk_secret_value_123');
    // Stored in the database (ProviderSetting), encrypted with REELFORGE_SECRET_KEY.
    const stored = (await service.repos.providerSettings.values()).ELEVENLABS_API_KEY!;
    expect(stored.scheme).toBe('aes-256-gcm');
    expect(stored.value).not.toContain('sk_secret_value_123');
    expect(providerEnv.ELEVENLABS_API_KEY).toBe('sk_secret_value_123');
    // Audit-logged without the value.
    const audit = await service.repos.audit.list({ limit: 5 });
    expect(audit[0]).toMatchObject({ action: 'provider.configure', actorType: 'api_key', targetId: 'elevenlabs', data: { settings: { ELEVENLABS_API_KEY: 'set' } } });
    expect(JSON.stringify(audit)).not.toContain('sk_secret_value_123');
    if (db.kind === 'sqlite') {
      const { statSync } = await import('node:fs');
      expect(statSync(join(config.dataDir, 'reelforge.db')).mode & 0o777).toBe(0o600);
    }
    // The provider is now configured: the call stops at the cost acknowledgement, not at configuration.
    const tts = await req('POST', '/v1/providers/elevenlabs/run', { body: { params: { text: 'Hi', voiceId: 'abc' } } });
    expect(((await tts.json()) as any).error.code).toBe('cost_acknowledgement_required');
    const cleared = (await (await req('PUT', '/v1/providers/elevenlabs/config', { body: { values: { ELEVENLABS_API_KEY: null } } })).json()) as any;
    expect(cleared).toMatchObject({ configured: false, settings: [{ set: false, source: 'unset' }] });
  });

  it('reads the bootstrap key from REELFORGE_BOOTSTRAP_KEY_FILE', async () => {
    const { writeFileSync } = await import('node:fs');
    const f = join(dir, 'bootstrap.key');
    writeFileSync(f, 'rf_fromAfile_7Qx2Lm9Vb4Nc8Zr1Ty6Hp3Kw5Dj0Gs\n');
    expect(loadConfig({ REELFORGE_BOOTSTRAP_KEY_FILE: f }).bootstrapKey).toBe('rf_fromAfile_7Qx2Lm9Vb4Nc8Zr1Ty6Hp3Kw5Dj0Gs');
    expect(loadConfig({ REELFORGE_BOOTSTRAP_KEY: 'rf_envWins_8Rt3Yu6Io9Pa2Sd5Fg7Hj1Kl4Zx0Cv', REELFORGE_BOOTSTRAP_KEY_FILE: f }).bootstrapKey).toBe('rf_envWins_8Rt3Yu6Io9Pa2Sd5Fg7Hj1Kl4Zx0Cv');
    expect(() => loadConfig({ REELFORGE_BOOTSTRAP_KEY_FILE: join(dir, 'missing') })).toThrow(/BOOTSTRAP_KEY_FILE/);
  });

  it('cancels a job', async () => {
    const { job } = (await (await req('POST', '/v1/projects/sample-reel/preview', { body: { scale: 0.25 } })).json()) as any;
    const r = await req('POST', `/v1/jobs/${job.id}/cancel`);
    expect(r.status).toBe(200);
    const done = await pollJob(job.id);
    expect(['cancelled', 'succeeded']).toContain(done.status);
  });

  it('limits JSON body size', async () => {
    const r = await req('PATCH', '/v1/projects/sample-reel', { body: { title: 'x'.repeat(100 * 1024) } });
    expect(r.status).toBe(413);
  });

  it('deletes projects', async () => {
    expect((await req('DELETE', '/v1/projects/sample-reel')).status).toBe(204);
    expect((await req('GET', '/v1/projects/sample-reel')).status).toBe(404);
  });
});

describe('output variants over REST (#287)', () => {
  it('VAR-10 POST /renders on a manifest with variants: one job per variant, one batch id; variant renders one', async () => {
    const manifest = {
      schemaVersion: '0.2',
      projectId: 'rest-variants',
      title: 'variants',
      output: { width: 216, height: 384, fps: 30, format: 'mp4' },
      variants: [
        { id: 'vertical', width: 216, height: 384 },
        { id: 'wide', width: 384, height: 216 },
      ],
      scenes: [{ id: 'hook', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'Two formats' } }],
    };
    expect((await req('POST', '/v1/projects', { body: manifest })).status).toBe(201);
    const start = await req('POST', '/v1/projects/rest-variants/renders', { body: {} });
    expect(start.status).toBe(202);
    const r = (await start.json()) as any;
    expect(r.jobs).toHaveLength(2);
    expect(r.job.id).toBe(r.jobs[0].id);
    expect(r.jobs.map((j: any) => [j.params.variant, j.params.batchId])).toEqual([
      ['vertical', r.batchId],
      ['wide', r.batchId],
    ]);
    const done = await Promise.all(r.jobs.map((j: any) => pollJob(j.id)));
    expect(done.map((d) => [d.status, d.result.width, d.result.height])).toEqual([
      ['succeeded', 216, 384],
      ['succeeded', 384, 216],
    ]);
    const one = (await (await req('POST', '/v1/projects/rest-variants/renders', { body: { variant: 'wide' } })).json()) as any;
    expect(one.jobs).toBeUndefined();
    expect(one.job.params.variant).toBe('wide');
    const unknown = await req('POST', '/v1/projects/rest-variants/renders', { body: { variant: 'square' } });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).error.details.variants).toEqual(['vertical', 'wide']);
    expect((await req('DELETE', '/v1/projects/rest-variants')).status).toBe(204);
  }, 120_000);
});
