import { timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { ApiError, TERMINAL, hasScope, type AuthContext, type ReelforgeService, type Scope } from '@reelforge/core';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import type { ServerConfig } from './config';
import { handleMcp, serverCard } from './mcp';
import { httpTelemetry } from './observability/http';
import { StructuredLogger } from './observability/logger';
import { Observability, observabilitySettings } from './observability/telemetry';
import { RateLimiter } from './rateLimit';
import { readiness } from './readiness';

export type Env = { Variables: { auth: AuthContext; requestId: string } };

export interface AppDeps {
  service: ReelforgeService;
  config: ServerConfig;
  /** Logs, metrics and traces (startServer makes one from the observability settings; default: metrics only, no log output). */
  observability?: Observability;
}

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function bearer(c: Context): string | null {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

/** Strip the port and brackets from a Host header value. */
export function hostName(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0]!;
}

export function createApp({ service, config, observability }: AppDeps) {
  const app = new Hono<Env>();
  const obs =
    observability ??
    new Observability(
      observabilitySettings(config.resolved.config, service.serverVersion ?? '0.1.0', config.resolved.build.edition),
      new StructuredLogger({ level: () => config.logLevel, quiet: true })
    );
  // config is the live object: runtime settings (PATCH /v1/config) change it while the server runs.
  const limiter = new RateLimiter(() => config.rateLimitPerMinute);

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.code, err.message, err.details), err.status as 400);
    const status = (err as { status?: number }).status;
    if (status === 413) return c.json(errorBody('too_large', 'request body is too large'), 413);
    obs.logger.log('error', `unhandled error on ${c.req.method} ${c.req.path}`, { error: err, request_id: c.get('requestId') });
    return c.json(errorBody('internal', 'internal server error'), 500);
  });
  app.notFound((c) => c.json(errorBody('not_found', `no route for ${c.req.method} ${c.req.path}`), 404));

  app.use('*', httpTelemetry(obs));
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  const authenticate: MiddlewareHandler<Env> = async (c, next) => {
    // Signed download links (get_render_output's downloadUrl) work without a key,
    // for exactly one file of one render, until they expire.
    const signed = /^\/v1\/renders\/([^/]+)\/output$/.exec(c.req.path);
    if (signed && c.req.method === 'GET' && c.req.query('sig')) {
      const ok = service.verifySignedDownload(signed[1]!, c.req.query('file') ?? 'final.mp4', Number(c.req.query('expires')), c.req.query('sig')!);
      if (!ok) return c.json(errorBody('unauthorized', 'the download link is invalid or has expired; get a new one with get_render_output'), 401);
      c.set('auth', { keyId: 'signed-url', name: 'signed download link', scopes: ['read'] });
      return next();
    }
    const token = bearer(c);
    const auth = token ? await service.keys.verify(token) : null;
    if (!auth) {
      c.header('WWW-Authenticate', 'Bearer realm="reelforge"');
      return c.json(errorBody('unauthorized', 'missing or invalid API key: send "Authorization: Bearer rf_..."'), 401);
    }
    const wait = limiter.take(auth.keyId);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(errorBody('rate_limited', `too many requests for this key; retry in ${wait}s`), 429);
    }
    c.set('auth', auth);
    await next();
  };

  const need =
    (scope: Scope): MiddlewareHandler<Env> =>
    async (c, next) => {
      if (!hasScope(c.get('auth'), scope)) {
        return c.json(errorBody('forbidden', `this API key lacks the "${scope}" scope`), 403);
      }
      await next();
    };

  const json: MiddlewareHandler<Env> = (c, next) =>
    bodyLimit({ maxSize: config.maxJsonBytes, onError: (c) => c.json(errorBody('too_large', `JSON body larger than ${config.maxJsonBytes} bytes`), 413) })(c, next);
  const upload: MiddlewareHandler<Env> = (c, next) =>
    bodyLimit({ maxSize: config.maxUploadBytes + 64 * 1024, onError: (c) => c.json(errorBody('too_large', `upload larger than ${config.maxUploadBytes} bytes`), 413) })(c, next);
  const actor = (c: Context<Env>) => ({ actorType: 'api_key' as const, actorId: c.get('auth').keyId });
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const text = await c.req.text();
    if (!text.trim()) return {};
    try {
      const v = JSON.parse(text);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
      return v as Record<string, unknown>;
    } catch {
      throw new ApiError('bad_request', 400, 'body must be a JSON object');
    }
  };
  const expectedVersion = (c: Context, b?: Record<string, unknown>): number | undefined => {
    const raw = c.req.header('if-match')?.replace(/"/g, '') ?? c.req.query('expectedVersion') ?? b?.expectedVersion;
    if (raw === undefined || raw === null || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new ApiError('bad_request', 400, 'expectedVersion / If-Match must be a positive integer');
    return n;
  };
  const project = (stored: { meta: unknown; manifest: unknown; warnings?: unknown }) => stored;

  // Storage health for /readyz, cached briefly so frequent probes do not hit the bucket every time.
  let healthCache: { at: number; value: { ok: boolean; message?: string } } | null = null;
  const storageHealth = async () => {
    if (healthCache && Date.now() - healthCache.at < 10_000) return healthCache.value;
    const value = await service.storage.driver.health().catch((e: Error) => ({ ok: false, message: e.message }));
    healthCache = { at: Date.now(), value };
    return value;
  };

  // ---- health (no auth) -------------------------------------------------------
  app.get('/healthz', (c) => c.json({ ok: true, version: service.serverVersion }));
  app.get('/readyz', async (c) => {
    const r = await readiness(service, obs, storageHealth);
    return c.json(r, r.ok ? 200 : 503);
  });
  // Prometheus scrape endpoint (observability.metrics.exporter "prometheus"); optional bearer token (D-052).
  app.get('/metrics', async (c) => {
    const s = obs.settings;
    if (s.metricsExporter !== 'prometheus') {
      return c.json(errorBody('not_found', `metrics are not served on /metrics: observability.metrics.exporter is "${s.metricsExporter}"`), 404);
    }
    if (s.metricsToken) {
      const given = Buffer.from(bearer(c) ?? '');
      const want = Buffer.from(s.metricsToken);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        c.header('WWW-Authenticate', 'Bearer realm="reelforge-metrics"');
        return c.json(errorBody('unauthorized', 'send "Authorization: Bearer <observability.metrics.bearerToken>"'), 401);
      }
    }
    return c.body(await obs.prometheus(), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
  });
  app.get('/.well-known/mcp.json', (c) => c.json(serverCard(service, config)));

  // ---- MCP ------------------------------------------------------------------------
  app.all('/mcp', async (c) => {
    // DNS-rebinding protection: the Host (and Origin, when a browser sends one) must be ours.
    const host = hostName(c.req.header('host'));
    if (!config.allowedHosts.includes(host)) {
      return c.json(errorBody('forbidden_host', `host "${host}" is not allowed; set REELFORGE_PUBLIC_URL or REELFORGE_ALLOWED_HOSTS`), 403);
    }
    const origin = c.req.header('origin');
    if (origin) {
      let originHost = '';
      try {
        originHost = hostName(new URL(origin).host);
      } catch {
        // invalid origin
      }
      if (!config.allowedHosts.includes(originHost)) {
        return c.json(errorBody('forbidden_origin', `origin "${origin}" is not allowed`), 403);
      }
    }
    const token = bearer(c);
    const auth = token ? await service.keys.verify(token) : null;
    if (!auth) {
      c.header('WWW-Authenticate', 'Bearer realm="reelforge"');
      return c.json(errorBody('unauthorized', 'missing or invalid API key: send "Authorization: Bearer rf_..."'), 401);
    }
    const wait = limiter.take(auth.keyId);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(errorBody('rate_limited', `too many requests for this key; retry in ${wait}s`), 429);
    }
    c.set('auth', auth);
    return handleMcp(c.req.raw, auth, service, config);
  });

  // ---- REST v1 ---------------------------------------------------------------------
  const v1 = new Hono<Env>();
  v1.use('*', authenticate);

  v1.get('/capabilities', need('read'), (c) => c.json(service.capabilities()));
  v1.get('/schema/project', need('read'), (c) => c.json(service.projectSchema()));
  v1.get('/templates', need('read'), (c) => c.json({ templates: service.listTemplates(c.req.query('engine')) }));

  v1.get('/themes', need('read'), async (c) => c.json({ themes: await service.listThemes() }));
  v1.post('/themes', need('write'), json, async (c) => c.json(await service.createTheme(await body(c)), 201));
  v1.get('/themes/:id', need('read'), async (c) => c.json(await service.getTheme(c.req.param('id'))));
  v1.put('/themes/:id', need('write'), json, async (c) => c.json(await service.putTheme(c.req.param('id'), await body(c))));
  v1.delete('/themes/:id', need('write'), async (c) => {
    await service.deleteTheme(c.req.param('id'));
    return c.body(null, 204);
  });

  v1.get('/projects', need('read'), async (c) => c.json({ projects: await service.listProjects() }));
  v1.post('/projects', need('write'), json, async (c) => {
    const b = await body(c);
    const manifest = 'manifest' in b && typeof b.manifest === 'object' ? b.manifest : b;
    return c.json(project(await service.createProject(manifest)), 201);
  });
  v1.get('/projects/:id', need('read'), async (c) => {
    const v = c.req.query('version');
    if (v) return c.json({ manifest: await service.projects.getVersion(c.req.param('id'), Number(v)), version: Number(v) });
    return c.json(await service.getProject(c.req.param('id')));
  });
  v1.get('/projects/:id/versions', need('read'), async (c) => c.json({ versions: await service.listProjectVersions(c.req.param('id')) }));
  v1.patch('/projects/:id', need('write'), json, async (c) => {
    const b = await body(c);
    const ev = expectedVersion(c);
    return c.json(project(await service.updateProject(c.req.param('id'), b, ev)));
  });
  v1.delete('/projects/:id', need('write'), async (c) => {
    await service.deleteProject(c.req.param('id'));
    return c.body(null, 204);
  });
  v1.post('/projects/:id/validate', need('read'), async (c) => c.json(await service.validateProject(c.req.param('id'))));

  v1.post('/projects/:id/scenes', need('write'), json, async (c) => {
    const b = await body(c);
    const scene = 'scene' in b ? b.scene : b;
    const index = typeof b.index === 'number' ? b.index : c.req.query('index') ? Number(c.req.query('index')) : undefined;
    return c.json(project(await service.addScene(c.req.param('id'), scene, { index, expectedVersion: expectedVersion(c) })), 201);
  });
  // "scenes:reorder" (Google-style custom method); the colon is matched literally.
  v1.post('/projects/:id/:method{scenes:reorder}', need('write'), json, async (c) => {
    const b = await body(c);
    return c.json(project(await service.reorderScenes(c.req.param('id'), b.order, expectedVersion(c, b))));
  });
  v1.patch('/projects/:id/scenes/:sceneId', need('write'), json, async (c) => {
    return c.json(project(await service.updateScene(c.req.param('id'), c.req.param('sceneId'), await body(c), expectedVersion(c))));
  });
  v1.delete('/projects/:id/scenes/:sceneId', need('write'), async (c) => {
    return c.json(project(await service.removeScene(c.req.param('id'), c.req.param('sceneId'), expectedVersion(c))));
  });
  v1.put('/projects/:id/theme', need('write'), json, async (c) => {
    const b = await body(c);
    return c.json(project(await service.setTheme(c.req.param('id'), b.theme, expectedVersion(c, b))));
  });
  v1.patch('/projects/:id/audio', need('write'), json, async (c) => {
    return c.json(project(await service.setAudio(c.req.param('id'), await body(c), expectedVersion(c))));
  });

  v1.post('/projects/:id/preview', need('render'), json, async (c) => {
    const b = await body(c);
    const job = await service.preview(c.req.param('id'), {
      sceneId: typeof b.sceneId === 'string' ? b.sceneId : undefined,
      scale: typeof b.scale === 'number' ? b.scale : undefined,
    });
    return c.json({ job }, 202);
  });
  v1.post('/projects/:id/renders', need('render'), json, async (c) => {
    const b = await body(c);
    const job = await service.startRender(c.req.param('id'), { backend: typeof b.backend === 'string' ? b.backend : undefined });
    return c.json({ job }, 202);
  });
  v1.get('/projects/:id/renders', need('read'), async (c) => c.json({ renders: await service.listRenders(c.req.param('id')) }));

  v1.get('/jobs', need('read'), async (c) => c.json({ jobs: await service.listJobs({ projectId: c.req.query('projectId') }) }));
  v1.get('/jobs/:id', need('read'), async (c) => {
    // ?wait=N long-polls up to N seconds (max 50) for the job to finish.
    const wait = Number(c.req.query('wait') ?? 0);
    return c.json(await service.waitForJob(c.req.param('id'), Number.isFinite(wait) ? wait : 0));
  });
  v1.post('/jobs/:id/cancel', need('render'), async (c) => c.json(await service.cancelJob(c.req.param('id'))));
  v1.post('/jobs/:id/retry', need('render'), async (c) => c.json({ job: await service.retryJob(c.req.param('id')) }, 202));
  v1.get('/jobs/:id/logs', need('read'), async (c) => {
    const tail = c.req.query('tail') ? Number(c.req.query('tail')) : undefined;
    const lines = await service.jobLogs(c.req.param('id'), tail);
    if ((c.req.header('accept') ?? '').includes('text/plain')) return c.text(lines.join('\n') + '\n');
    return c.json({ lines });
  });
  v1.get('/jobs/:id/events', need('read'), async (c) => {
    const id = c.req.param('id');
    const first = await service.getJob(id);
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'status', data: JSON.stringify(first) });
      if (TERMINAL.includes(first.status)) return;
      await new Promise<void>((resolve) => {
        const off = service.jobs.subscribe(id, (e) => {
          void stream.writeSSE({ event: e.type, data: JSON.stringify(e.type === 'log' ? { line: e.line } : e.job) });
          if (e.type === 'status' && TERMINAL.includes(e.job.status)) {
            off();
            resolve();
          }
        });
        stream.onAbort(() => {
          off();
          resolve();
        });
      });
    });
  });

  v1.get('/renders/:id', need('read'), async (c) => c.json(await service.getRender(c.req.param('id'))));
  v1.get('/renders/:id/output', need('read'), async (c) => {
    const file = c.req.query('file') ?? 'final.mp4';
    const o = await service.renderObject(c.req.param('id'), file);
    return sendStored(c, service, o, file.split('/').pop()!);
  });

  v1.get('/assets', need('read'), async (c) => c.json({ assets: await service.listAssets({ projectId: c.req.query('projectId') }) }));
  v1.get('/assets/:id', need('read'), async (c) => c.json(await service.getAsset(c.req.param('id'))));
  v1.post(
    '/assets',
    need('write'),
    upload,
    async (c) => {
      const type = c.req.header('content-type') ?? '';
      if (type.startsWith('multipart/form-data')) {
        const form = await c.req.parseBody();
        const file = form.file;
        if (!(file instanceof File)) throw new ApiError('bad_request', 400, 'multipart upload needs a "file" field');
        const license = typeof form.license === 'string' && form.license ? parseLicense(form.license) : undefined;
        const r = await service.uploadAsset(Buffer.from(await file.arrayBuffer()), {
          filename: file.name,
          contentType: file.type,
          projectId: typeof form.projectId === 'string' && form.projectId ? form.projectId : undefined,
          assetId: typeof form.assetId === 'string' && form.assetId ? form.assetId : undefined,
          license,
        });
        return c.json(r, 201);
      }
      const b = await body(c);
      if (typeof b.url !== 'string') throw new ApiError('bad_request', 400, 'send multipart/form-data with a "file" field, or JSON {"url": "https://..."}');
      const r = await service.addAssetFromUrl(b.url, {
        projectId: typeof b.projectId === 'string' ? b.projectId : undefined,
        assetId: typeof b.assetId === 'string' ? b.assetId : undefined,
        license: b.license as never,
      });
      return c.json(r, 201);
    }
  );

  v1.get('/providers', need('read'), (c) => c.json({ providers: service.listProviders() }));
  v1.put('/providers/:id/config', need('admin'), json, async (c) => {
    const b = await body(c);
    return c.json(await service.configureProvider(c.req.param('id'), b.values, actor(c)));
  });
  v1.post('/providers/:id/run', need('render'), json, async (c) => {
    const b = await body(c);
    const r = await service.runProvider(c.req.param('id'), b.params ?? {}, {
      projectId: typeof b.projectId === 'string' ? b.projectId : undefined,
      acknowledgeCost: b.acknowledgeCost === true,
      attachAs: b.attachAs === 'none' ? 'none' : undefined,
      assetId: typeof b.assetId === 'string' ? b.assetId : undefined,
    });
    return c.json(r, 201);
  });

  v1.get('/config', need('admin'), (c) => c.json(service.getConfig({ prefix: c.req.query('prefix') || undefined })));
  v1.patch('/config', need('admin'), json, async (c) => {
    const b = await body(c);
    // { "settings": { "limits.rateLimitPerMinute": 120 } }; a bare object of settings works too.
    const patch = 'settings' in b && b.settings && typeof b.settings === 'object' ? b.settings : b;
    return c.json(await service.updateConfig(patch, actor(c)));
  });

  v1.get('/licence', need('read'), (c) => c.json(service.getLicence()));
  v1.post('/licence', need('admin'), json, async (c) => {
    const b = await body(c);
    return c.json(await service.activateLicence(b.key, actor(c)));
  });
  v1.delete('/licence', need('admin'), async (c) => c.json(await service.deactivateLicence(actor(c))));

  v1.get('/storage', need('admin'), async (c) => c.json(await service.getStorage()));
  v1.post('/storage/cleanup', need('admin'), json, async (c) => {
    const b = await body(c);
    return c.json(await service.runStorageCleanup({ dryRun: b.dryRun ?? (c.req.query('dryRun') === 'true' ? true : undefined), renderDays: b.renderDays, keepLastRendersPerProject: b.keepLastRendersPerProject }, actor(c)));
  });

  v1.get('/keys', need('admin'), async (c) => c.json({ keys: await service.listKeys() }));
  v1.post('/keys', need('admin'), json, async (c) => {
    const b = await body(c);
    const scopes = Array.isArray(b.scopes) ? (b.scopes as Scope[]) : ['read', 'write', 'render'];
    const r = await service.createKey(typeof b.name === 'string' ? b.name : '', scopes as Scope[]);
    return c.json({ ...r, note: 'store this key now; it is not shown again' }, 201);
  });
  v1.delete('/keys/:id', need('admin'), async (c) => {
    if (c.req.param('id') === c.get('auth').keyId) throw new ApiError('conflict', 409, 'refusing to delete the key used for this request');
    await service.deleteKey(c.req.param('id'));
    return c.body(null, 204);
  });

  app.route('/v1', v1);
  return app;
}

function parseLicense(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    throw new ApiError('bad_request', 400, 'license must be JSON, e.g. {"name":"CC0-1.0","redistributable":true}');
  }
}

/** Stream a stored file through the server, with Range support (video players seek); works on every storage driver. */
async function sendStored(c: Context, service: ReelforgeService, o: { key: string; contentType: string; bytes: number }, name: string) {
  const size = o.bytes;
  const headers: Record<string, string> = {
    'Content-Type': o.contentType,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename="${name}"`,
    'Cache-Control': 'private, max-age=0',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
    const stream = Readable.toWeb(await service.storage.driver.get(o.key, { start, end })) as ReadableStream;
    return c.body(stream, 206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
  }
  const stream = Readable.toWeb(await service.storage.driver.get(o.key)) as ReadableStream;
  return c.body(stream, 200, { ...headers, 'Content-Length': String(size) });
}
