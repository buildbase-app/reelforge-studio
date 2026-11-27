import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, ElevenLabsTts, runInWorkspace, type WorkspaceRouter } from '@renderweld/core';
import { REST_ROUTES, TOOLS, startServer, type StartedServer } from '../src/index';
import { fakeEngine, makeTone, tempDir } from '../../../packages/core/test/helpers';
import { testDatabase } from './serverProcess';

/**
 * Workspaces (#304): the denial suite. Two workspaces, one admin key each. Every route of the shared route table
 * (REST_ROUTES) and every MCP tool (TOOLS) is called with workspace B's key against workspace A's resources; each
 * probe that names one of A's resources must get 404 (or 403), a list must not show anything of A, and A's rows and
 * files must be exactly as before. The table is iterated, so a new route or tool is probed without editing this file;
 * a new path parameter or tool argument fails here until it gets an entry in A_IDS / argFor.
 */
const { dir, cleanup } = tempDir('reelforge-ws-');
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
let server: StartedServer;
let repos: WorkspaceRouter;
let receiver: Server;
let rxUrl: string;
const received: Array<{ path: string; body: string }> = [];
let dropDb: () => Promise<void> = async () => undefined;

const THEME_TOKENS = { colors: { background: '#101010', surface: '#202020', text: '#ffffff', mutedText: '#bbbbbb', accent: '#22aaff', accent2: '#ffaa22' }, fontFamily: 'Arial, sans-serif' };
const A = 'alpha';
const B = 'beta';
const keyA: Record<string, string> = {};
let keyB: string;
let owner: string;
/** A's resources; every value is unique text, so finding one in a response to B is a leak. */
const a = { project: 'alpha-only-reel', theme: 'alpha-only-theme', scene: 'hook', job: '', run: '', asset: '', key: '', keyName: 'alpha-only-extra-key', webhook: '', delivery: '', event: '', renderEvent: '' };

async function rest(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${opts.key ?? keyB}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

async function connect(key: string) {
  const client = new Client({ name: 'reelforge-ws-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}
const text = (r: any) => r.content?.find((c: any) => c.type === 'text')?.text ?? '';

/** Everything of workspace A: rows (through the bundle bound to A) and files (under its storage prefix). */
async function snapshotA(opts: { audit?: boolean } = {}) {
  const r = repos.forWorkspace(A);
  const projects = await r.projects.list();
  const versions = await Promise.all(projects.map((p) => r.projects.listVersions(p.meta.id)));
  const endpoints = await r.webhooks.listEndpoints();
  const deliveries = await r.webhooks.listDeliveries({});
  return JSON.stringify({
    projects,
    versions,
    themes: await r.themes.list(),
    assets: await r.assets.list(),
    keys: (await r.keys.list()).map(({ lastUsedAt: _l, ...k }) => k),
    jobs: (await r.jobs.list()).map((j) => ({ id: j.id, status: j.status, result: j.result, error: j.error })),
    endpoints: endpoints.map((e) => ({ id: e.id, name: e.name, enabled: e.enabled, events: e.events, url: e.urlDisplay })),
    deliveries: deliveries.map((d) => ({ id: d.id, status: d.status, attempts: d.attempts })),
    audit: opts.audit === false ? null : (await r.audit.list({ limit: 1000 })).map((e) => e.id),
    files: (await server.service.storage.rootDriver.list(`workspaces/${A}/`)).map((o) => `${o.key}:${o.bytes}`).sort(),
  });
}

/** Lists whose entries are B's own records of what B asked for (its audit trail names the ids it probed). */
const OWN_RECORDS = new Set(['list_audit_events']);
const ALL_A = () => [a.project, a.theme, a.job, a.run, a.asset, a.key, a.webhook, a.delivery, a.event, a.renderEvent].join(' ');

/** The first of A's resources the text mentions, ignoring those the request named itself (a 404 may echo its id). */
function leaks(s: string, request = ''): string | null {
  for (const v of [a.project, a.theme, a.job, a.run, a.asset, a.key, a.keyName, a.webhook, a.delivery, a.event, a.renderEvent]) if (v && s.includes(v) && !request.includes(v)) return v;
  return null;
}

/**
 * A delivered event body (or a delivery with its payload) of B's: B's own audit entries (audit.entry, #66) name the
 * ids B asked for in its probes, so they must be by one of B's keys; every other event must not mention A at all.
 */
function eventLeak(body: string): string | null {
  const e = JSON.parse(body);
  if (e.type === 'audit.entry') {
    const by = e.data?.entry?.actorName as string | undefined;
    return by === undefined || by.startsWith('beta') ? null : `audit entry by ${by}`;
  }
  return leaks(body);
}

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  rxUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  await makeTone(join(dir, 'tone.mp3'), 1);
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas')).registerProvider(new ElevenLabsTts({}));
  const database = await testDatabase(dir);
  dropDb = database.drop;
  server = await startServer(
    { dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' },
    {
      registry,
      env: {
        ...database.env,
        REELFORGE_LICENCE_MODE: 'off',
        REELFORGE_RATE_LIMIT_PER_MINUTE: '0',
        REELFORGE_PRE_AUTH_RATE_LIMIT_PER_MINUTE: '0',
        REELFORGE_SECRET_KEY: 'workspaces-test-secret-key-0123456789',
        REELFORGE_WEBHOOKS_ALLOW_HTTP: 'true',
        REELFORGE_WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true',
        // Every audit entry is also an audit.entry event (#66): B's endpoint must get only B's.
        REELFORGE_AUDIT_SINKS: 'database,webhooks',
      },
      quiet: true,
    }
  );
  repos = server.service.repos as WorkspaceRouter;
  expect(repos.routing).toBe(true);
  for (const id of [A, B]) await repos.workspaces.create({ id, name: id, status: 'active', createdAt: new Date().toISOString() });
  repos.invalidateWorkspaces();
  owner = (await server.service.keys.create('owner', ['admin', 'owner'])).key;
  keyA.admin = (await runInWorkspace(A, () => server.service.keys.create('alpha-admin', ['admin']))).key;
  keyB = (await runInWorkspace(B, () => server.service.keys.create('beta-admin', ['admin']))).key;

  // B listens for every event first: none of A's may reach it.
  expect((await rest('POST', '/v1/webhooks', { body: { name: 'beta hook', url: `${rxUrl}/beta`, events: ['*', 'job.progress', 'audit.entry'] } })).status).toBe(201);

  // Workspace A: a project with two versions, a theme, an asset, a render, a webhook with a delivery and a second key.
  const as = { key: keyA.admin };
  expect((await rest('POST', '/v1/projects', { ...as, body: { manifest: { ...sample, projectId: a.project } } })).status).toBe(201);
  expect((await rest('PATCH', `/v1/projects/${a.project}`, { ...as, body: { title: 'Alpha v2' } })).status).toBe(200);
  expect((await rest('POST', '/v1/themes', { ...as, body: { id: a.theme, name: 'Alpha theme', tokens: THEME_TOKENS } })).status).toBe(201);
  const form = new FormData();
  form.set('file', new Blob([readFileSync(join(dir, 'tone.mp3'))], { type: 'audio/mpeg' }), 'tone.mp3');
  form.set('license', JSON.stringify({ name: 'CC0-1.0', redistributable: true }));
  const up = await fetch(`${server.url}/v1/assets`, { method: 'POST', headers: { authorization: `Bearer ${keyA.admin}` }, body: form });
  expect(up.status).toBe(201);
  a.asset = (await up.json()).asset.id;
  // A's endpoint also takes the terminal render events (#342): their dedupeKey is render:<jobId>.
  const hook = await rest('POST', '/v1/webhooks', { ...as, body: { name: 'alpha hook', url: `${rxUrl}/alpha`, events: ['job.*', 'render.*'] } });
  expect(hook.status).toBe(201);
  a.webhook = hook.json.webhook.id;
  const render = await rest('POST', `/v1/projects/${a.project}/renders`, { ...as, body: {} });
  expect(render.status).toBe(202);
  a.job = render.json.job.id;
  const done = await rest('GET', `/v1/jobs/${a.job}?wait=45`, as);
  expect(done.json.status).toBe('succeeded');
  a.run = done.json.result.renderId;
  const t = await rest('POST', `/v1/webhooks/${a.webhook}/test`, { ...as, body: { waitSeconds: 5 } });
  a.delivery = t.json.id ?? t.json.delivery?.id;
  expect(a.delivery).toMatch(/^dlv_/);
  const k = await rest('POST', '/v1/keys', { ...as, body: { name: a.keyName, scopes: ['read'] } });
  a.key = k.json.record.id;
  // A's event ids and the render's outcome (dedupeKey render:<job>), as A's delivery log has them.
  const aRepo = repos.forWorkspace(A).webhooks;
  a.event = (await aRepo.getDelivery(a.delivery))!.eventId;
  let outcome: Awaited<ReturnType<typeof aRepo.listDeliveries>> = [];
  for (let i = 0; i < 50 && !outcome.length; i++) {
    await server.service.webhooks.flush();
    outcome = await aRepo.listDeliveries({ dedupeKey: `render:${a.job}` });
    if (!outcome.length) await new Promise((r) => setTimeout(r, 100));
  }
  expect(outcome.length).toBeGreaterThan(0);
  a.renderEvent = outcome[0]!.eventId;
}, 120_000);

afterAll(async () => {
  await server?.close();
  receiver?.closeAllConnections();
  await new Promise((r) => receiver?.close(r));
  await dropDb();
  cleanup();
});

/** A path parameter -> A's resource, by the collection it follows. */
const A_IDS: Record<string, () => string> = {
  themes: () => a.theme,
  projects: () => a.project,
  scenes: () => a.scene,
  jobs: () => a.job,
  renders: () => a.run,
  assets: () => a.asset,
  keys: () => a.key,
  webhooks: () => a.webhook,
  deliveries: () => a.delivery,
  workspaces: () => A,
  // Providers are instance-level plugins, not workspace resources: the probe names A's project in the body.
  providers: () => 'elevenlabs',
  // Skills are instance-level documents (built in, or skills.dir), the same for every workspace.
  skills: () => 'av-sync',
};
/** Path collections that are not workspace resources (see A_IDS). */
const INSTANCE_LEVEL = new Set(['providers', 'skills']);

function fill(path: string): { path: string; names: string[] } {
  const segs = path.split('/');
  const names: string[] = [];
  const out = segs.map((s, i) => {
    if (s === ':method{scenes:reorder}') return 'scenes:reorder';
    if (!s.startsWith(':')) return s;
    const coll = segs[i - 1]!;
    const v = A_IDS[coll];
    if (!v) throw new Error(`no workspace-A value for parameter ${s} after "${coll}" in ${path}: add it to A_IDS`);
    names.push(coll);
    return v();
  });
  return { path: out.join('/'), names };
}

/** Routes that create-or-replace by id in the caller's workspace: probed for leaks and for A staying unchanged. */
const UPSERTS = new Set(['update_theme']);

/** Bodies that name A's resources wherever a body can (projectId, assetId, ...). */
function bodyFor(method: string, path: string): unknown {
  if (method === 'GET' || method === 'DELETE') return undefined;
  const base = { projectId: a.project, assetId: a.asset, jobId: a.job, keyId: a.key };
  if (path === '/v1/projects') return { manifest: { ...sample, projectId: 'beta-probe-reel' } };
  if (path === '/v1/themes' || path === '/v1/themes/:id') return { id: 'beta-probe-theme', name: 'B', tokens: THEME_TOKENS };
  if (path === '/v1/keys') return { name: 'beta-probe-key', scopes: ['read'] };
  if (path === '/v1/webhooks') return { name: 'beta probe', url: `${rxUrl}/beta-probe`, events: ['job.*'] };
  if (path === '/v1/assets') return { url: 'http://127.0.0.1:1/none.png', ...base };
  if (path.endsWith('/resend')) return { dedupeKey: `render:${a.job}` };
  if (path.startsWith('/v1/webhooks/')) return path.endsWith('/test') || path.endsWith('/rotate-secret') ? {} : { name: 'B was here' };
  // Valid bodies, so the probe reaches the project lookup rather than the input check.
  if (method === 'PATCH' && path.endsWith('/captions')) return { etag: 'stale-etag', mode: 'off', approve: true };
  if (path.endsWith('/captions/transcribe')) return {};
  if (path.endsWith('/run')) return { params: { text: 'hi', voiceId: 'v' }, acknowledgeCost: true, ...base };
  if (path.includes('scenes:reorder')) return { order: ['hook', 'steps'] };
  if (path.endsWith('/captions/import')) return { content: '1\n00:00:00,000 --> 00:00:01,000\nhi\n', format: 'srt' };
  return { ...base, scene: { id: 'x', engine: 'html', html: '<p>x</p>', durationSeconds: 1 }, theme: 'default', title: 'B was here' };
}

describe('workspaces: cross-workspace denial (#304)', () => {
  it('every REST route: 404/403 for A\'s resources, no A data in B\'s lists, A unchanged', async () => {
    const before = await snapshotA();
    const probed: string[] = [];
    let denied = 0;
    for (const r of REST_ROUTES) {
      const { path, names } = fill(r.path);
      // PUT /v1/themes/:id creates or replaces a theme of the caller's own workspace: B gets its own theme with that id.
      const targetsA = names.some((n) => !INSTANCE_LEVEL.has(n)) && !UPSERTS.has(r.tool);
      const res = await rest(r.method, path, { body: bodyFor(r.method, r.path) });
      const label = `${r.method} ${r.path} (${r.tool}) -> ${res.status} ${res.text.slice(0, 200)}`;
      if (targetsA || r.scope === 'owner') {
        expect([403, 404], label).toContain(res.status);
        denied++;
      } else {
        expect(res.status, label).toBeLessThan(500);
      }
      const echo = OWN_RECORDS.has(r.tool) ? ALL_A() : res.status >= 400 || UPSERTS.has(r.tool) ? `${path} ${JSON.stringify(bodyFor(r.method, r.path) ?? '')}` : '';
      // B's audit trail: every entry is by one of B's own keys, never by one of A's.
      if (OWN_RECORDS.has(r.tool)) expect(res.text, label).not.toMatch(/alpha-admin|alpha-only-extra-key/);
      expect(leaks(res.text, echo), label).toBeNull();
      // B's own theme of that id (the upsert) goes again, so later probes and lists see only A's.
      if (UPSERTS.has(r.tool)) await repos.forWorkspace(B).themes.delete(a.theme);
      probed.push(`${r.method} ${r.path}`);
    }
    expect(probed.length).toBe(REST_ROUTES.length);
    console.log(`[workspaces] REST: ${probed.length} routes probed, ${denied} refused with 404/403`);
    expect(denied).toBeGreaterThan(40);
    expect(await snapshotA()).toBe(before);
  }, 120_000);

  it('every MCP tool: not_found/forbidden for A\'s resources, no A data in results, A unchanged', async () => {
    const before = await snapshotA();
    const client = await connect(keyB);
    /** Arguments: A's resources by name, a plausible value for everything else that is required. */
    const resourceArgs: Record<string, () => string> = {
      projectId: () => a.project,
      themeId: () => a.theme,
      sceneId: () => a.scene,
      jobId: () => a.job,
      renderId: () => a.run,
      assetId: () => a.asset,
      keyId: () => a.key,
      webhookId: () => a.webhook,
      deliveryId: () => a.delivery,
      parentId: () => a.job,
      workspaceId: () => A,
    };
    /** Tools that take one of several resource arguments: probed once with each. */
    const ONE_OF: Record<string, string[]> = { get_captions: ['projectId', 'renderId'] };
    const filler: Record<string, unknown> = {
      id: 'beta-probe-theme', name: 'beta probe', tokens: THEME_TOKENS, manifest: { ...sample, projectId: 'beta-probe-reel-mcp' }, patch: { title: 'B' }, scene: { id: 'x', engine: 'html', html: '<p>x</p>', durationSeconds: 1 },
      order: ['hook', 'steps'], theme: 'default', audio: {}, content: '1\n00:00:00,000 --> 00:00:01,000\nhi\n', text: 'hi', voiceId: 'v', url: 'http://127.0.0.1:1/none.png',
      dataBase64: Buffer.from('not media').toString('base64'), etag: 'stale-etag', values: {}, settings: {}, params: { text: 'hi', voiceId: 'v' }, scopes: ['read'], events: ['job.*'], providerId: 'elevenlabs', planId: 'plan_000000000000000000000000',
    };
    const listFilters = new Set(['list_assets', 'list_jobs']);
    let probed = 0;
    let denied = 0;
    const probes = TOOLS.flatMap((t) => (ONE_OF[t.name] ?? [undefined]).map((only) => ({ t, skip: new Set((ONE_OF[t.name] ?? []).filter((k) => k !== only)) })));
    for (const { t, skip } of probes) {
      const shape = t.input as Record<string, { isOptional?: () => boolean }>;
      const args: Record<string, unknown> = {};
      let targetsA = false;
      for (const [k, s] of Object.entries(shape)) {
        if (skip.has(k)) continue;
        if (resourceArgs[k]) {
          args[k] = resourceArgs[k]!();
          targetsA = true;
        } else if (k in filler && (!s.isOptional?.() || k === 'patch')) {
          args[k] = filler[k];
        } else if (!s.isOptional?.()) {
          throw new Error(`no probe value for required argument ${t.name}.${k}: add it to filler`);
        }
      }
      if ('acknowledgeCost' in shape) args.acknowledgeCost = true;
      const r: any = await client.callTool({ name: t.name, arguments: args });
      probed++;
      const out = text(r);
      const label = `${t.name}(${JSON.stringify(args).slice(0, 160)}) -> ${out.slice(0, 200)}`;
      expect(leaks(out, r.isError || UPSERTS.has(t.name) ? JSON.stringify(args) : OWN_RECORDS.has(t.name) ? ALL_A() : ''), label).toBeNull();
      if (UPSERTS.has(t.name)) {
        await repos.forWorkspace(B).themes.delete(a.theme);
        continue;
      }
      if (targetsA && !(listFilters.has(t.name) && !r.isError)) {
        expect(r.isError, label).toBe(true);
        expect(['not_found', 'forbidden'], label).toContain(JSON.parse(out).error.code);
        denied++;
      } else if (t.scope === 'owner') {
        expect(JSON.parse(out).error?.code, label).toBe('forbidden');
        denied++;
      }
    }
    console.log(`[workspaces] MCP: ${probed} tools probed, ${denied} refused with not_found/forbidden`);
    expect(probed).toBe(probes.length);
    expect(probes.length).toBeGreaterThanOrEqual(TOOLS.length);
    expect(denied).toBeGreaterThan(40);
    // Resources and prompts read through the same scoped service.
    const listed = await client.listResources();
    expect(leaks(JSON.stringify(listed))).toBeNull();
    await expect(client.readResource({ uri: `reelforge://projects/${a.project}` })).rejects.toThrow();
    await expect(client.getPrompt({ name: 'review_reel', arguments: { projectId: a.project } })).rejects.toThrow();
    await client.close();
    expect(await snapshotA()).toBe(before);
  }, 120_000);

  it('webhook operations (#342): B\'s own endpoint cannot resend, replay or read A\'s deliveries, events or render outcomes', async () => {
    const before = await snapshotA();
    const bHook = (await rest('GET', '/v1/webhooks')).json.webhooks.find((w: any) => w.name === 'beta hook').id as string;
    // Every way resend_webhook names an event: A's delivery, A's event ids, A's render outcome.
    const names = [{ deliveryId: a.delivery }, { eventId: a.event }, { eventId: a.renderEvent }, { dedupeKey: `render:${a.job}` }];
    const client = await connect(keyB);
    try {
      for (const body of names) {
        const r = await rest('POST', `/v1/webhooks/${bHook}/resend`, { body });
        expect(r.status, `${JSON.stringify(body)} -> ${r.text.slice(0, 200)}`).toBe(404);
        expect(leaks(r.text, JSON.stringify(body))).toBeNull();
        const m: any = await client.callTool({ name: 'resend_webhook', arguments: { webhookId: bHook, ...body } });
        expect(m.isError, JSON.stringify(body)).toBe(true);
        expect(JSON.parse(text(m)).error.code).toBe('not_found');
        expect(leaks(text(m), JSON.stringify(body))).toBeNull();
      }
      // Replay names a delivery under B's own endpoint: still not found.
      const replay = await rest('POST', `/v1/webhooks/${bHook}/deliveries/${a.delivery}/replay`, { body: {} });
      expect(replay.status).toBe(404);
      const m: any = await client.callTool({ name: 'replay_webhook_delivery', arguments: { webhookId: bHook, deliveryId: a.delivery } });
      expect(JSON.parse(text(m)).error.code).toBe('not_found');
      // B's delivery log and deliveries (with payloads): only B's.
      const log = await rest('GET', `/v1/webhooks/${bHook}/log?limit=500`);
      expect(log.status).toBe(200);
      expect(leaks(log.text)).toBeNull();
      const withPayload = await rest('GET', `/v1/webhooks/${bHook}/deliveries?limit=500&includePayload=true`);
      expect(withPayload.status).toBe(200);
      expect(withPayload.json.deliveries.length).toBeGreaterThan(0);
      for (const d of withPayload.json.deliveries) {
        expect(eventLeak(JSON.stringify(d.payload)), JSON.stringify(d).slice(0, 200)).toBeNull();
        expect(leaks(JSON.stringify({ ...d, payload: null })), d.id).toBeNull();
      }
      for (const name of ['get_webhook_log', 'list_webhook_deliveries']) {
        const r: any = await client.callTool({ name, arguments: { webhookId: bHook, limit: 500 } });
        expect(r.isError, name).toBeFalsy();
        for (const d of JSON.parse(text(r)).deliveries) {
          if (d.payload) expect(eventLeak(JSON.stringify(d.payload)), name).toBeNull();
          expect(leaks(JSON.stringify({ ...d, payload: null })), name).toBeNull();
        }
      }
      // Rotating B's own secret leaves A's endpoint alone.
      expect((await rest('POST', `/v1/webhooks/${bHook}/rotate-secret`, { body: {} })).status).toBe(200);
    } finally {
      await client.close();
    }
    // Nothing of A's was queued for B, and A's rows are as they were.
    expect(await repos.forWorkspace(B).webhooks.listDeliveries({ dedupeKey: `render:${a.job}` })).toEqual([]);
    expect(await repos.forWorkspace(B).webhooks.listDeliveries({ eventId: a.event })).toEqual([]);
    expect(await snapshotA()).toBe(before);
  }, 60_000);

  it('dashboard reads (#344) and list filters see only the caller\'s workspace', async () => {
    const meB = await rest('GET', '/v1/me');
    expect(meB.status).toBe(200);
    expect(meB.json.name).toBe('beta-admin');
    expect(leaks(meB.text)).toBeNull();
    expect((await rest('GET', '/v1/me', { key: keyA.admin })).json.name).toBe('alpha-admin');
    // The jobs view (parentId: a render's units) and the library (projects, renders) filtered by A's ids: empty.
    for (const path of [`/v1/jobs?parentId=${a.job}&limit=200`, `/v1/jobs?projectId=${a.project}`, '/v1/jobs?limit=200', '/v1/projects?limit=50', '/v1/assets?limit=200']) {
      const r = await rest('GET', path);
      expect(r.status, path).toBe(200);
      expect(leaks(r.text, path), path).toBeNull();
    }
    const client = await connect(keyB);
    try {
      const r: any = await client.callTool({ name: 'list_jobs', arguments: { parentId: a.job } });
      expect(JSON.parse(text(r)).jobs).toEqual([]);
    } finally {
      await client.close();
    }
    // The library's storage location is instance-level: an owner key's, not a workspace admin's.
    expect((await rest('GET', '/v1/storage')).status).toBe(403);
    // The live job view: A's job stream, logs and output are not found for B.
    for (const path of [`/v1/jobs/${a.job}/events`, `/v1/jobs/${a.job}/logs?tail=300`, `/v1/renders/${a.run}/output?file=poster.png`, `/v1/renders/${a.run}/captions`]) {
      expect((await rest('GET', path)).status, path).toBe(404);
    }
  });

  it('analytics (#378) count only the caller\'s workspace: jobs, storage and webhook health, cached per workspace', async () => {
    // A first, so any cache an instance-wide summary kept would now hold A's figures.
    const aSum = await rest('GET', '/v1/analytics/summary', { key: keyA.admin });
    expect(aSum.status, aSum.text.slice(0, 300)).toBe(200);
    expect(aSum.json.totals.succeeded).toBeGreaterThanOrEqual(1);
    expect(aSum.json.storage).toMatchObject({ renders: { count: 1 }, assets: { objects: 1 } });
    expect(aSum.json.webhooks.endpoints.map((e: any) => e.id)).toContain(a.webhook);
    const bSum = await rest('GET', '/v1/analytics/summary');
    expect(bSum.status).toBe(200);
    expect(leaks(bSum.text)).toBeNull();
    const bJobs = (await repos.forWorkspace(B).jobs.list()).filter((j) => j.type === 'render' || j.type === 'preview');
    expect(bSum.json.totals.jobs).toBe(bJobs.length);
    expect(bSum.json.storage).toMatchObject({ renders: { count: 0 }, assets: { objects: 0 } });
    expect(bSum.json.storage.totalBytes).toBeLessThan(aSum.json.storage.totalBytes);
    expect(bSum.json.webhooks.endpoints.every((e: any) => e.name.startsWith('beta'))).toBe(true);
    const client = await connect(keyB);
    try {
      const r: any = await client.callTool({ name: 'get_analytics_summary', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(leaks(text(r))).toBeNull();
      expect(JSON.parse(text(r)).storage.renders.count).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('staged assets (#373) and audio (#346): B\'s manifest cannot name A\'s stored asset', async () => {
    const before = await snapshotA();
    // A v0.2 manifest of B's own (the sample is v0.1, which has no asset:// references), naming A's stored asset.
    expect((await rest('POST', '/v1/projects', { body: { manifest: { ...sample, projectId: 'beta-borrows-later' } } })).status).toBe(201);
    const own = (await rest('GET', '/v1/projects/beta-borrows-later')).json.manifest;
    const borrowed = [{ id: 'borrowed', uri: `asset://${a.asset}`, mediaType: 'audio' }];
    const manifest = { ...own, projectId: 'beta-borrows-asset', assets: borrowed };
    // Saving is allowed (drafts may name assets still to come); validating, previewing and rendering are not.
    expect((await rest('POST', '/v1/projects', { body: { manifest } })).status).toBe(201);
    const v = await rest('POST', '/v1/projects/beta-borrows-asset/validate', { body: {} });
    expect(v.text).toContain('is not in the asset store');
    for (const [path, body] of [['/v1/projects/beta-borrows-asset/renders', {}], ['/v1/projects/beta-borrows-asset/preview', { sceneId: own.scenes[0].id }]] as const) {
      const r = await rest('POST', path, { body });
      expect(r.status, `${path} -> ${r.text.slice(0, 300)}`).toBeGreaterThanOrEqual(400);
      expect(r.status, path).toBeLessThan(500);
      expect(r.text, path).toContain('is not in the asset store');
    }
    const client = await connect(keyB);
    try {
      for (const name of ['validate_project', 'render_project']) {
        const r: any = await client.callTool({ name, arguments: { projectId: 'beta-borrows-asset' } });
        expect(text(r), name).toContain('is not in the asset store');
      }
      // Background music (#346) is a project asset: one that is not in the project is refused.
      const audio = await rest('PATCH', '/v1/projects/beta-borrows-later/audio', { body: { music: { asset: a.asset } } });
      expect(audio.status, audio.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(audio.status).toBeLessThan(500);
    } finally {
      await client.close();
    }
    expect((await repos.forWorkspace(B).jobs.list({ projectId: 'beta-borrows-asset' })).length).toBe(0);
    expect(await snapshotA()).toBe(before);
  });

  it('events, audit and keys stay in their workspace', async () => {
    // B's endpoint subscribed to everything: none of A's job events, deliveries or audit entries reached it.
    // Something of B's own for its endpoint: a new key (key.created).
    expect((await rest('POST', '/v1/keys', { body: { name: 'beta-evented', scopes: ['read'] } })).status).toBe(201);
    for (let i = 0; i < 50 && !received.some((x) => x.path.startsWith('/beta')); i++) await new Promise((r) => setTimeout(r, 100));
    const toB = received.filter((x) => x.path.startsWith('/beta'));
    expect(toB.length).toBeGreaterThan(0);
    for (const x of toB) expect(eventLeak(x.body), x.body.slice(0, 200)).toBeNull();
    expect(received.some((x) => x.path.startsWith('/alpha') && x.body.includes(a.job))).toBe(true);
    // Audit: B sees its own entries only; A's list holds A's.
    const auditB = await rest('GET', '/v1/audit?limit=500');
    expect(auditB.status).toBe(200);
    const actorsB = new Set(auditB.json.events.map((e: any) => e.actorName).filter(Boolean));
    expect([...actorsB].every((n) => String(n).startsWith('beta')), JSON.stringify([...actorsB])).toBe(true);
    const auditA = await rest('GET', '/v1/audit?limit=500', { key: keyA.admin });
    expect(auditA.text).toContain(a.project);
    // Keys: each admin lists its own; the default workspace's owner key is in neither.
    const keysB = (await rest('GET', '/v1/keys')).json.keys.map((k: any) => k.name);
    expect(keysB).toContain('beta-admin');
    expect(keysB).not.toContain('owner');
    expect(keysB).not.toContain('alpha-admin');
  });

  it('the same ids in two workspaces are two resources (rows and files)', async () => {
    // B creates a project with A's project id: its own row, its own files; deleting it leaves A's alone.
    expect((await rest('POST', '/v1/projects', { body: { manifest: { ...sample, projectId: a.project, title: 'Beta copy' } } })).status).toBe(201);
    expect((await rest('GET', `/v1/projects/${a.project}`)).json.manifest.title).toBe('Beta copy');
    expect((await rest('GET', `/v1/projects/${a.project}`, { key: keyA.admin })).json.manifest.title).toBe('Alpha v2');
    const r = await rest('POST', `/v1/projects/${a.project}/renders`, { body: {} });
    const job = await rest('GET', `/v1/jobs/${r.json.job.id}?wait=45`);
    expect(job.json.status, job.text.slice(0, 500)).toBe('succeeded');
    const bRun = job.json.result.renderId as string;
    expect(existsSync(join(dir, 'data', 'workspaces', B, 'projects', a.project, 'renders', bRun, 'final.mp4'))).toBe(true);
    expect(existsSync(join(dir, 'data', 'workspaces', A, 'projects', a.project, 'renders', a.run, 'final.mp4'))).toBe(true);
    expect((await rest('GET', `/v1/projects/${a.project}/renders`)).json.renders.map((x: any) => x.renderId)).toEqual([bRun]);
    expect((await rest('DELETE', `/v1/projects/${a.project}`)).status).toBe(204);
    expect((await rest('GET', `/v1/projects/${a.project}`, { key: keyA.admin })).status).toBe(200);
    expect((await rest('GET', `/v1/renders/${a.run}`, { key: keyA.admin })).status).toBe(200);
    // Nothing of workspace A or B in the default workspace's root layout.
    expect(existsSync(join(dir, 'data', 'projects', a.project))).toBe(false);
  }, 120_000);

  it('signed download links name their workspace: they cannot be moved to another workspace or render', async () => {
    const out = await rest('GET', `/v1/renders/${a.run}`, { key: keyA.admin });
    expect(out.status, out.text.slice(0, 300)).toBe(200);
    const link = new URL(out.json.downloadUrl, server.url);
    expect(link.searchParams.get('ws')).toBe(A);
    const path = `${link.pathname}${link.search}`;
    expect((await fetch(`${server.url}${path}`)).status).toBe(200);
    // The same signature for workspace B, or without a workspace (the default one), is refused.
    for (const ws of [B, null]) {
      const u = new URL(link);
      if (ws) u.searchParams.set('ws', ws);
      else u.searchParams.delete('ws');
      expect((await fetch(`${server.url}${u.pathname}${u.search}`)).status, String(ws)).toBe(401);
    }
    // B's own link, pointed at A's render, is refused.
    const bProject = await rest('POST', '/v1/projects', { body: { manifest: { ...sample, projectId: 'beta-signed' } } });
    expect(bProject.status).toBe(201);
    const j = await rest('POST', '/v1/projects/beta-signed/renders', { body: {} });
    const bRun = (await rest('GET', `/v1/jobs/${j.json.job.id}?wait=45`)).json.result.renderId as string;
    const bLink = new URL((await rest('GET', `/v1/renders/${bRun}`)).json.downloadUrl, server.url);
    expect((await fetch(`${server.url}${bLink.pathname}${bLink.search}`)).status).toBe(200);
    expect((await fetch(`${server.url}${bLink.pathname.replace(bRun, a.run)}${bLink.search}`)).status).toBe(401);
    // B's key on A's render: not found.
    expect((await rest('GET', `/v1/renders/${a.run}/output`)).status).toBe(404);
  }, 120_000);

  it('a workspace admin cannot give out or touch owner keys, nor reach instance settings', async () => {
    const r = await rest('POST', '/v1/keys', { body: { name: 'escalate', scopes: ['admin', 'owner'] } });
    expect(r.status).toBe(403);
    for (const [m, p] of [['GET', '/v1/config'], ['PATCH', '/v1/config'], ['GET', '/v1/storage'], ['POST', '/v1/storage/cleanup'], ['POST', '/v1/licence'], ['DELETE', '/v1/licence']] as const) {
      expect((await rest(m, p, { body: m === 'GET' || m === 'DELETE' ? undefined : {} })).status, `${m} ${p}`).toBe(403);
    }
    // The owner key reaches them (in its own, default, workspace).
    expect((await rest('GET', '/v1/config', { key: owner })).status).toBe(200);
  });

  it('a suspended workspace\'s keys are refused (403 workspace_suspended); its data is untouched', async () => {
    // (The refused calls are audited in A as auth.denied; everything else stays as it was.)
    const before = await snapshotA({ audit: false });
    await repos.workspaces.update(A, { status: 'suspended', suspendedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    repos.invalidateWorkspaces();
    const r = await rest('GET', '/v1/projects', { key: keyA.admin });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('workspace_suspended');
    await repos.workspaces.update(A, { status: 'active', suspendedAt: null, updatedAt: new Date().toISOString() });
    repos.invalidateWorkspaces();
    expect((await rest('GET', '/v1/projects', { key: keyA.admin })).status).toBe(200);
    expect(await snapshotA({ audit: false })).toBe(before);
    expect((await repos.forWorkspace(A).audit.list({ action: 'auth.denied' })).length).toBeGreaterThan(0);
  });
});
