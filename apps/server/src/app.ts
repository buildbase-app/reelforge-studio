import { timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  ApiError,
  DEFAULT_WORKSPACE_ID,
  TERMINAL,
  currentRequest,
  hasScope,
  normalizeIp,
  requestIdFrom,
  runInWorkspace,
  runWithRequest,
  type AuthContext,
  type KeyOptions,
  type ReelforgeService,
  type RequestContext,
  type Scope,
} from '@renderweld/core';
import busboy from 'busboy';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { isDatabaseOverload, overloadedResponse } from './overload';
import type { ServerConfig } from './config';
import { auditAction, auditTarget, matchRoute, restArgs, resultOf } from './audit';
import { mountDashboard } from './dashboard';
import { handleMcp, serverCard } from './mcp';
import { httpTelemetry } from './observability/http';
import { StructuredLogger } from './observability/logger';
import { Observability, observabilitySettings } from './observability/telemetry';
import { OAuthVerifier, looksLikeJwt, protectedResourceMetadata, resourceMetadataUrl } from './oauth';
import { PreAuthGuard } from './authGuard';
import { DatabaseRateLimiter, RateLimiter, rateLimitHeaders, type RateDecision } from './rateLimit';
import { publicReadiness, readiness } from './readiness';

export type Env = { Variables: { auth: AuthContext; requestId: string } };

export interface AppDeps {
  service: ReelforgeService;
  config: ServerConfig;
  /** Logs, metrics and traces (startServer makes one from the observability settings; default: metrics only, no log output). */
  observability?: Observability;
  /** HTTP client for the OAuth issuer's metadata and JWKS (tests: a local mock issuer). */
  fetch?: typeof fetch;
}

/** Most messages in one JSON-RPC batch on /mcp; each costs one rate-limit unit. */
export const MCP_MAX_BATCH = 10;

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function bearer(c: Context): string | null {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

/**
 * The client address: the TCP peer, or with server.trustProxy the last
 * X-Forwarded-For entry (the address your reverse proxy saw).
 */
export function clientIp(c: Context, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const last = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return normalizeIp(last);
  }
  try {
    const a = getConnInfo(c).remote.address;
    return a ? normalizeIp(a) : undefined;
  } catch {
    return undefined; // not served by @hono/node-server (app.request in tests)
  }
}

/** Strip the port and brackets from a Host header value. */
export function hostName(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0]!;
}

/**
 * Whether a browser Origin may call /mcp (DNS-rebinding protection, SEC-09):
 * scheme, host and port must match the public URL's origin, or the origin the
 * request was sent to (an allowed Host header, port included, with http or
 * https). Before, only the host name was compared.
 */
export function originAllowed(origin: string, hostHeader: string | undefined, config: Pick<ServerConfig, 'allowedHosts' | 'publicUrl'>): boolean {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
  const want = o.origin.toLowerCase();
  if (config.publicUrl) {
    try {
      if (new URL(config.publicUrl).origin.toLowerCase() === want) return true;
    } catch {
      // invalid public URL: ignore
    }
  }
  const host = (hostHeader ?? '').trim().toLowerCase();
  if (host && config.allowedHosts.includes(hostName(host)) && (want === `http://${host}` || want === `https://${host}`)) return true;
  return false;
}

export function createApp(deps: AppDeps) {
  const { service, config, observability } = deps;
  const app = new Hono<Env>();
  const obs =
    observability ??
    new Observability(
      observabilitySettings(config.resolved.config, service.serverVersion ?? '0.1.0', config.resolved.build.edition),
      new StructuredLogger({ level: () => config.logLevel, quiet: true })
    );
  // config is the live object: runtime settings (PATCH /v1/config) change it while the server runs.
  const store = config.resolved.config.limits.rateLimitStore;
  const limiter =
    store === 'database' || (store === 'auto' && service.jobs?.mode === 'database')
      ? new DatabaseRateLimiter(
          (key, windowStart, previousStart) => service.repos.rateLimits.slide(key, windowStart, previousStart),
          () => config.rateLimitPerMinute,
          (line) => obs.logger.log('warn', line)
        )
      : new RateLimiter(() => config.rateLimitPerMinute);
  // Before the key lookup (#305): per client address, and a lockout after repeated failed authentications.
  const limitSettings = () => service.settings?.current.config.limits ?? config.resolved.config.limits;
  const guard = new PreAuthGuard(() => {
    const l = limitSettings();
    return { perMinute: l.preAuthPerMinute, failuresPerMinute: l.authFailuresPerMinute, lockoutSeconds: l.authLockoutSeconds, lockoutMaxSeconds: l.authLockoutMaxSeconds };
  });

  // MCP OAuth (D-112): JWT access tokens of the configured issuer on /mcp, next to API keys.
  const oauthCfg = config.resolved.config.security.oauth;
  const oauth = oauthCfg.issuer
    ? new OAuthVerifier({ issuer: oauthCfg.issuer, audience: oauthCfg.audience ?? `${config.publicUrl}/mcp`, ...(oauthCfg.jwksUrl ? { jwksUrl: oauthCfg.jwksUrl } : {}) }, deps.fetch)
    : null;
  /** The 401 challenge: with OAuth on, it points MCP clients at the protected-resource metadata (RFC 9728). */
  const challenge = (c: Context, mcp: boolean, error?: { error: string; description: string; scope?: string }) => {
    const parts = ['realm="reelforge"'];
    if (oauth && mcp) parts.push(`resource_metadata="${resourceMetadataUrl(oauth.settings.audience)}"`);
    if (error) parts.push(`error="${error.error}"`, `error_description="${error.description.replace(/["\\]/g, "'")}"`);
    if (error?.scope) parts.push(`scope="${error.scope}"`);
    c.header('WWW-Authenticate', `Bearer ${parts.join(', ')}`);
  };

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      // Limits that clear by themselves (job caps, quotas, provider caps) say when to come back.
      const retry = (err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      if (err.status === 429 && typeof retry === 'number' && retry > 0) c.header('Retry-After', String(Math.ceil(retry)));
      return c.json(errorBody(err.code, err.message, err.details), err.status as 400);
    }
    const status = (err as { status?: number }).status;
    if (status === 413) return c.json(errorBody('too_large', 'request body is too large'), 413);
    // No database connection or transaction in time: the server is overloaded, nothing was written (#307).
    if (isDatabaseOverload(err)) return overloadedResponse('the database is busy; retry after the Retry-After seconds');
    obs.logger.log('error', `unhandled error on ${c.req.method} ${c.req.path}`, { error: err, request_id: c.get('requestId') });
    return c.json(errorBody('internal', 'internal server error'), 500);
  });
  app.notFound((c) => c.json(errorBody('not_found', `no route for ${c.req.method} ${c.req.path}`), 404));

  app.use('*', httpTelemetry(obs));
  app.use('*', async (c, next) => {
    // Request context for the audit log and quotas (D-055): request id, client address, user agent.
    const ctx: RequestContext = {
      requestId: requestIdFrom(c.req.header('x-request-id')),
      ip: clientIp(c, service.settings?.current.config.server.trustProxy ?? false),
      userAgent: c.req.header('user-agent'),
      via: c.req.path === '/mcp' ? 'mcp' : 'rest',
    };
    await runWithRequest(ctx, () => next());
    c.header('X-Request-Id', ctx.requestId);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  /** A 429 with the RateLimit-* and Retry-After fields, and a body that says which limit and what to do (#305). */
  const limited = (c: Context, scope: 'key' | 'workspace' | 'client_ip' | 'auth_failures', d: RateDecision): Response => {
    for (const [k, v] of Object.entries(rateLimitHeaders(d))) c.header(k, v);
    const retry = Math.max(1, Math.ceil(d.retryAfterSeconds));
    const text = {
      workspace: { message: `too many requests for this workspace; retry in ${retry}s`, hint: 'Every key of the workspace shares this budget (limits.rateLimitPerMinute of the workspace, or workspaces.rateLimitPerMinute); the instance owner can raise it with update_workspace.' },
      key: { message: `too many requests for this key; retry in ${retry}s`, hint: 'Slow down to the limit in RateLimit-Limit (per 60 s, sliding) and retry after Retry-After seconds; an admin can raise this key\'s rateLimitPerMinute or limits.rateLimitPerMinute.' },
      client_ip: { message: `too many requests from this address; retry in ${retry}s`, hint: 'Every request from one address counts before the key is checked (limits.preAuthPerMinute). Retry after Retry-After seconds; behind a proxy, set server.trustProxy so each client is counted on its own.' },
      auth_failures: { message: `too many failed authentications from this address; retry in ${retry}s`, hint: 'Check the API key (Authorization: Bearer rf_...). Each further run of failures doubles the lockout (limits.authFailuresPerMinute, limits.authLockoutSeconds).' },
    }[scope];
    return c.json(errorBody('rate_limited', text.message, { scope, hint: text.hint, limit: d.limit, retryAfterSeconds: retry }), 429);
  };

  /**
   * Check the client address budget, then the bearer key (expiry, revocation, IP allowlist) or, on /mcp with
   * OAuth on, the access token; then the per-key (or per OAuth subject) rate limit and the workspace's budget.
   *
   * OAuth access tokens (D-112) act in the default workspace, unless security.oauth.workspaceClaim names the claim
   * that carries their workspace (#479): then the token must name an existing workspace, a suspended one is refused
   * as for its keys, and AuthContext.workspaceId scopes every call the token makes.
   */
  const workspaceClaim = config.resolved.config.security.oauth.workspaceClaim;
  const tokenWorkspace = async (claims: Record<string, unknown>): Promise<{ workspaceId: string } | { status: 401 | 403; code: string; message: string }> => {
    const raw = claims[workspaceClaim!];
    if (typeof raw !== 'string' || !raw || raw.length > 64) return { status: 401, code: 'invalid_token', message: `the token has no "${workspaceClaim}" claim naming its workspace` };
    const status = await service.workspaceStatus(raw);
    if (status === null || status === 'deleted') return { status: 401, code: 'invalid_token', message: `the token names workspace "${raw}", which does not exist` };
    if (status === 'suspended') return { status: 403, code: 'workspace_suspended', message: `the workspace of this token (${raw}) is suspended; ask the instance owner` };
    return { workspaceId: raw };
  };
  const authorize = async (c: Context, opts: { oauth?: boolean } = {}): Promise<{ auth: AuthContext } | { response: Response }> => {
    const ctx = currentRequest();
    // Before any database work: a flood or a key-guessing run from one address stops here (#305).
    const pre = guard.check(ctx?.ip);
    if (!pre.allowed) return { response: limited(c, pre.scope, pre.decision) };
    const token = bearer(c);
    if (opts.oauth && oauth && token && !token.startsWith('rf_') && looksLikeJwt(token)) {
      const v = await oauth.verify(token);
      if (!v.ok) {
        // A refused token counts towards the address lockout like a wrong API key (#305).
        if (v.error !== 'insufficient_scope') {
          const lockout = guard.failure(ctx?.ip);
          if (lockout) obs.logger.log('warn', `auth: ${ctx?.ip} locked out for ${lockout}s after repeated failed authentications`, { request_id: ctx?.requestId });
        }
        challenge(c, true, { error: v.error, description: v.description, ...(v.error === 'insufficient_scope' ? { scope: 'reelforge:read' } : {}) });
        return { response: c.json(errorBody(v.error, `access token refused: ${v.description}`), v.error === 'insufficient_scope' ? 403 : 401) };
      }
      // A blocked subject (#479) is refused before its token expires; the list is a runtime setting, read live.
      if (service.settings.current.config.security.oauth.blockedSubjects.includes(v.subject)) {
        const message = 'this token\'s subject is blocked on this server (security.oauth.blockedSubjects)';
        challenge(c, true, { error: 'invalid_token', description: message });
        return { response: c.json(errorBody('invalid_token', `access token refused: ${message}`), 401) };
      }
      if (workspaceClaim) {
        const ws = await tokenWorkspace(v.claims);
        if (!('workspaceId' in ws)) {
          if (ws.status === 401) challenge(c, true, { error: 'invalid_token', description: ws.message });
          return { response: c.json(errorBody(ws.code, `access token refused: ${ws.message}`), ws.status) };
        }
        return limit(c, { ...v.auth, workspaceId: ws.workspaceId });
      }
      return limit(c, v.auth);
    }
    const r = token ? await service.keys.authenticate(token, { ip: ctx?.ip }) : null;
    if (!r || !r.ok) {
      // ip_not_allowed is a real key used from the wrong place, not a guess: it does not count towards the lockout.
      if (r?.reason !== 'ip_not_allowed') {
        const lockout = guard.failure(ctx?.ip);
        if (lockout) obs.logger.log('warn', `auth: ${ctx?.ip} locked out for ${lockout}s after repeated failed authentications`, { request_id: ctx?.requestId });
      }
      if (r && r.key && r.reason !== 'unknown') {
        // A real key that may not be used (revoked, expired, wrong address): worth an audit entry.
        // In the key's own workspace (#304): its admins see the refusals.
        await runInWorkspace(r.key.workspaceId, () =>
          service.audit({ actorType: 'api_key', actorId: r.key!.id, actorName: r.key!.name, action: 'auth.denied', targetType: 'key', targetId: r.key!.id, result: 'denied', data: { reason: r.reason } })
        );
      }
      if (r?.reason === 'ip_not_allowed') return { response: c.json(errorBody('ip_not_allowed', r.message), 403) };
      if (r?.reason === 'workspace_suspended') return { response: c.json(errorBody('workspace_suspended', r.message), 403) };
      challenge(c, Boolean(opts.oauth));
      const message = r && r.reason !== 'unknown' ? `${r.message}; ask an admin for a new key` : 'missing or invalid API key: send "Authorization: Bearer rf_..."';
      return { response: c.json(errorBody(r?.reason === 'expired' ? 'key_expired' : r?.reason === 'revoked' ? 'key_revoked' : 'unauthorized', message), 401) };
    }
    return limit(c, r.auth);
  };

  /** The per-key (or per OAuth subject) rate limit; every limited response carries the budget (draft-ietf-httpapi-ratelimit-headers). */
  const limit = async (c: Context, auth: AuthContext): Promise<{ auth: AuthContext } | { response: Response }> => {
    const d = await limiter.take(auth.keyId, auth.rateLimitPerMinute);
    if (!d.allowed) return { response: limited(c, 'key', d) };
    // The workspace's own budget across all its keys (optional; unlimited unless the owner sets one, #304).
    const wsLimit = auth.workspaceId ? await service.workspaceAdmin?.rateLimitOf(auth.workspaceId) : undefined;
    if (wsLimit) {
      const w = await limiter.take(`workspace:${auth.workspaceId}`, wsLimit);
      if (!w.allowed) return { response: limited(c, 'workspace', w) };
    }
    // Every limited response carries the key's budget (draft-ietf-httpapi-ratelimit-headers).
    for (const [k, v] of Object.entries(rateLimitHeaders(d))) c.header(k, v);
    const ctx = currentRequest();
    if (ctx) ctx.auth = auth;
    return { auth };
  };

  const authenticate: MiddlewareHandler<Env> = async (c, next) => {
    // Signed download links (get_render_output's downloadUrl) work without a key,
    // for exactly one file of one render, until they expire.
    const signed = /^\/v1\/renders\/([^/]+)\/output$/.exec(c.req.path);
    if (signed && c.req.method === 'GET' && c.req.query('sig')) {
      const pre = guard.check(currentRequest()?.ip);
      if (!pre.allowed) return limited(c, pre.scope, pre.decision);
      // The link signs its workspace (#304): it opens that render of that workspace only, under its storage prefix.
      const ws = c.req.query('ws') ?? DEFAULT_WORKSPACE_ID;
      const ok = service.verifySignedDownload(signed[1]!, c.req.query('file') ?? 'final.mp4', Number(c.req.query('expires')), c.req.query('sig')!, ws);
      if (!ok) return c.json(errorBody('unauthorized', 'the download link is invalid or has expired; get a new one with get_render_output'), 401);
      const auth: AuthContext = { keyId: 'signed-url', name: 'signed download link', scopes: ['read'], workspaceId: ws };
      c.set('auth', auth);
      const ctx = currentRequest();
      if (ctx) ctx.auth = auth;
      return next();
    }
    const a = await authorize(c);
    if ('response' in a) return a.response;
    c.set('auth', a.auth);
    await next();
    if (c.req.header('idempotency-key') && currentRequest()?.idempotentReplay) c.header('Idempotent-Replayed', 'true');
    await auditRest(c);
  };

  /** One audit entry per admin or write REST call, unless the service already wrote one (D-055). */
  const auditRest = async (c: Context<Env>) => {
    const ctx = currentRequest();
    if (!ctx || ctx.audited) return;
    const route = matchRoute(c.req.method, c.req.path);
    if (!route || route.entry.scope === 'read') return;
    const args = restArgs(route.entry.path, route.params);
    const status = c.res.status;
    const err = c.error instanceof ApiError ? c.error.code : status === 403 ? 'forbidden' : status >= 400 ? `http_${status}` : undefined;
    // Created ids (project, key, job, theme) come from the JSON answer of a successful call.
    let result: unknown;
    if (status < 400 && (c.res.headers.get('content-type') ?? '').startsWith('application/json')) result = await c.res.clone().json().catch(() => undefined);
    const { targetType, targetId, data } = auditTarget(route.entry.tool, args, result);
    try {
      await service.audit({
        actorType: 'api_key',
        actorId: c.get('auth').keyId,
        action: auditAction(route.entry.tool),
        ...(targetType ? { targetType } : {}),
        ...(targetId ? { targetId } : {}),
        result: resultOf(status),
        data: { ...data, status, ...(err ? { error: err } : {}), ...(ctx.idempotentReplay ? { idempotentReplay: true } : {}) },
      });
    } catch (e) {
      console.error('[renderweld] audit write failed', (e as Error).message);
    }
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
  // Multipart uploads are never buffered (hono's bodyLimit would hold a chunked body in memory): a declared
  // Content-Length above the limit is refused at once, and the file part is streamed to a temporary file
  // that stops at limits.maxUploadBytes (D-090). Anything else (JSON {url}) gets the JSON limit.
  const upload: MiddlewareHandler<Env> = async (c, next) => {
    if (!(c.req.header('content-type') ?? '').startsWith('multipart/form-data')) return json(c, next);
    const declared = Number(c.req.header('content-length') ?? 0);
    const max = service.assets.limits.maxBytes;
    if (declared > max + 64 * 1024) {
      await service.recordLimitRejection('upload_too_large', { limit: 'limits.maxUploadBytes', max });
      return c.json(errorBody('too_large', `upload larger than ${max} bytes (limits.maxUploadBytes)`, { limit: 'limits.maxUploadBytes', max }), 413);
    }
    await next();
  };
  const actor = (c: Context<Env>) => ({ actorType: 'api_key' as const, actorId: c.get('auth').keyId });
  /** The Idempotency-Key header (create and render calls, D-057). */
  const idemKey = (c: Context) => c.req.header('idempotency-key') || undefined;
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
  // Anonymous callers (probes) get only the status of each dependency; an admin
  // key gets paths, versions, free space and error text too (D-088).
  app.get('/readyz', async (c) => {
    const r = await readiness(service, obs, storageHealth);
    let admin = false;
    const token = bearer(c);
    // A probe that sends a key is answered anonymously while its address is over the pre-auth limits (no key lookup).
    if (token?.startsWith('rf_') && guard.check(currentRequest()?.ip).allowed) {
      const a = await service.keys.authenticate(token, { ip: currentRequest()?.ip }).catch(() => null);
      admin = Boolean(a?.ok && hasScope(a.auth, 'owner'));
      if (!a?.ok && a?.reason !== 'ip_not_allowed') guard.failure(currentRequest()?.ip); // a guess here counts like one on /v1
    }
    c.header('Cache-Control', 'no-store');
    return c.json(admin ? r : publicReadiness(r), r.ok ? 200 : 503);
  });
  // Prometheus scrape endpoint (observability.metrics.exporter "prometheus"). Needs the
  // bearer token; without one configured only observability.metrics.allowAnonymous opens it (D-088).
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
    } else if (!s.metricsAllowAnonymous) {
      c.header('WWW-Authenticate', 'Bearer realm="reelforge-metrics"');
      return c.json(
        errorBody(
          'unauthorized',
          '/metrics needs a token: set observability.metrics.bearerToken (REELFORGE_METRICS_TOKEN) and send "Authorization: Bearer <token>", or set observability.metrics.allowAnonymous (REELFORGE_METRICS_ALLOW_ANONYMOUS=true) for a scraper on a private network'
        ),
        401
      );
    }
    return c.body(await obs.prometheus(), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
  });
  if (config.resolved.config.server.role === 'worker') {
    // A worker renders from the database queue and serves nothing else (D-076).
    app.all('*', (c) =>
      c.json(errorBody('not_found', `this instance is a worker (server.role "worker"): it renders jobs and serves only /healthz, /readyz and /metrics; send REST and MCP calls to an api instance`), 404)
    );
    return app;
  }
  app.get('/.well-known/mcp.json', (c) => c.json(serverCard(service, config)));
  // RFC 9728 protected-resource metadata for /mcp (D-112): only with OAuth on. The path form names the resource.
  const metadata = (c: Context) => (oauth ? c.json(protectedResourceMetadata(oauth.settings)) : c.json(errorBody('not_found', 'OAuth is not configured for /mcp (security.oauth.issuer); use an API key'), 404));
  app.get('/.well-known/oauth-protected-resource', metadata);
  app.get('/.well-known/oauth-protected-resource/mcp', metadata);

  // ---- MCP ------------------------------------------------------------------------
  /** Charge `n` more rate-limit units to a key (and its workspace): the extra messages of a JSON-RPC batch on /mcp. */
  const charge = async (c: Context, auth: AuthContext, n: number): Promise<Response | undefined> => {
    const wsLimit = auth.workspaceId ? await service.workspaceAdmin?.rateLimitOf(auth.workspaceId) : undefined;
    for (let i = 0; i < n; i++) {
      const d = await limiter.take(auth.keyId, auth.rateLimitPerMinute);
      if (!d.allowed) return limited(c, 'key', d);
      if (wsLimit) {
        const w = await limiter.take(`workspace:${auth.workspaceId}`, wsLimit);
        if (!w.allowed) return limited(c, 'workspace', w);
      }
    }
    return undefined;
  };

  app.all('/mcp', async (c) => {
    // DNS-rebinding protection: the Host (and Origin, when a browser sends one) must be ours.
    const host = hostName(c.req.header('host'));
    if (!config.allowedHosts.includes(host)) {
      return c.json(errorBody('forbidden_host', `host "${host}" is not allowed; set REELFORGE_PUBLIC_URL or REELFORGE_ALLOWED_HOSTS`), 403);
    }
    const origin = c.req.header('origin');
    if (origin && !originAllowed(origin, c.req.header('host'), config)) {
      return c.json(errorBody('forbidden_origin', `origin "${origin}" is not allowed`), 403);
    }
    const a = await authorize(c, { oauth: true });
    if ('response' in a) return a.response;
    const auth = a.auth;
    c.set('auth', auth); // access log key id (#64)
    // The JSON body limit applies to /mcp exactly as to REST (limits.maxJsonBytes, runtime; #321): the MCP SDK's own
    // 4 MiB cap would otherwise be the only bound. A declared Content-Length is checked at once; a chunked body is
    // cut off while it streams. GET (SSE) and DELETE have no body.
    if (c.req.method !== 'POST') return handleMcp(c.req.raw, auth, service, config);
    let answered: Response | undefined;
    const refused = await json(c, async () => {
      // A JSON-RPC batch runs one call per message, so it costs one rate-limit unit per message, not one per HTTP
      // request; authorize() took the first. Batches are capped (MCP 2025-06-18 dropped batching; older clients
      // may still send them).
      const text = await c.req.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (Array.isArray(parsed)) {
        if (parsed.length > MCP_MAX_BATCH) {
          answered = c.json(errorBody('batch_too_large', `a JSON-RPC batch on /mcp holds at most ${MCP_MAX_BATCH} messages (got ${parsed.length}); send them in several requests`), 400);
          return;
        }
        const over = parsed.length > 1 ? await charge(c, auth, parsed.length - 1) : undefined;
        if (over) {
          answered = over;
          return;
        }
      }
      // Not JSON: the transport reads the text again and answers with its JSON-RPC parse error.
      const req = parsed === undefined ? new Request(c.req.raw.url, { method: 'POST', headers: c.req.raw.headers, body: text }) : c.req.raw;
      answered = await handleMcp(req, auth, service, config, parsed);
    });
    return answered ?? refused ?? c.res;
  });

  // ---- REST v1 ---------------------------------------------------------------------
  const v1 = new Hono<Env>();
  v1.use('*', authenticate);

  v1.get('/capabilities', need('read'), (c) => c.json(service.capabilities()));
  v1.get('/me', need('read'), async (c) => c.json(await service.getMe(c.get('auth'))));
  v1.get('/schema/project', need('read'), (c) => c.json(service.projectSchema()));
  v1.get('/templates', need('read'), (c) => c.json({ templates: service.listTemplates(c.req.query('engine')) }));

  v1.get('/themes', need('read'), async (c) => c.json({ themes: await service.listThemes() }));
  v1.post('/themes', need('write'), json, async (c) => {
    const b = await body(c);
    return c.json(await service.idempotent(idemKey(c), 'create_theme', b, () => service.createTheme(b)), 201);
  });
  v1.get('/themes/:id', need('read'), async (c) => c.json(await service.getTheme(c.req.param('id'))));
  v1.put('/themes/:id', need('write'), json, async (c) => c.json(await service.putTheme(c.req.param('id'), await body(c))));
  v1.delete('/themes/:id', need('write'), async (c) => {
    await service.deleteTheme(c.req.param('id'));
    return c.body(null, 204);
  });

  // Lists are pages (D-102): ?limit= (default 50, max 200) and ?cursor= (nextCursor of the previous page).
  const page = (c: { req: { query(k: string): string | undefined } }) => ({ limit: c.req.query('limit'), cursor: c.req.query('cursor') });
  v1.get('/projects', need('read'), async (c) => c.json(await service.listProjects(page(c))));
  v1.post('/projects', need('write'), json, async (c) => {
    const b = await body(c);
    const manifest = 'manifest' in b && typeof b.manifest === 'object' ? b.manifest : b;
    return c.json(project(await service.idempotent(idemKey(c), 'create_project', { manifest }, () => service.createProject(manifest))), 201);
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
    const ev = expectedVersion(c);
    const projectId = c.req.param('id');
    return c.json(
      project(await service.idempotent(idemKey(c), 'add_scene', { projectId, scene, index, expectedVersion: ev }, () => service.addScene(projectId, scene, { index, expectedVersion: ev }))),
      201
    );
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
  v1.post('/projects/:id/captions/import', need('write'), json, async (c) => {
    const b = await body(c);
    const r = await service.importCaptions(c.req.param('id'), b, expectedVersion(c, b));
    return c.json({ ...project(r), imported: r.imported });
  });
  v1.get('/projects/:id/captions', need('read'), async (c) => {
    const language = c.req.query('language');
    return c.json(await service.getCaptions({ projectId: c.req.param('id'), ...(language ? { language } : {}) }));
  });
  v1.patch('/projects/:id/captions', need('write'), json, async (c) => {
    // The captions etag comes in the body or as If-Match (not a project version here); expectedVersion in the body or query.
    const { expectedVersion: ev, ...b } = await body(c);
    const etag = b.etag ?? c.req.header('if-match');
    const v = ev ?? c.req.query('expectedVersion');
    const version = v === undefined ? undefined : Number(v);
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new ApiError('bad_request', 400, 'expectedVersion must be a positive integer');
    return c.json(await service.updateCaptions(c.req.param('id'), { ...b, ...(etag !== undefined ? { etag } : {}) }, version));
  });
  v1.post('/projects/:id/captions/transcribe', need('render'), json, async (c) => {
    const { expectedVersion: _ev, ...b } = await body(c);
    return c.json(await service.transcribeCaptions(c.req.param('id'), b, expectedVersion(c, { expectedVersion: _ev })));
  });

  v1.post('/projects/:id/preview', need('render'), json, async (c) => {
    const b = await body(c);
    const projectId = c.req.param('id');
    const opts = {
      sceneId: typeof b.sceneId === 'string' ? b.sceneId : undefined,
      scale: typeof b.scale === 'number' ? b.scale : undefined,
      ...(b.variant !== undefined ? { variant: b.variant } : {}),
      ...(b.priority !== undefined ? { priority: b.priority } : {}),
    };
    return c.json(await service.idempotent(idemKey(c), 'preview_scene', { projectId, ...opts }, async () => ({ job: await service.preview(projectId, opts) })), 202);
  });
  v1.post('/projects/:id/renders', need('render'), json, async (c) => {
    const b = await body(c);
    const projectId = c.req.param('id');
    const opts = { backend: typeof b.backend === 'string' ? b.backend : undefined, ...(b.variant !== undefined ? { variant: b.variant } : {}), ...(b.priority !== undefined ? { priority: b.priority } : {}), ...(b.captions !== undefined ? { captions: b.captions } : {}), ...(b.audio !== undefined ? { audio: b.audio } : {}) };
    return c.json(await service.idempotent(idemKey(c), 'render_project', { projectId, ...opts }, () => service.renderProject(projectId, opts)), 202);
  });
  v1.get('/projects/:id/renders', need('read'), async (c) => c.json({ renders: await service.listRenders(c.req.param('id')) }));

  v1.get('/jobs', need('read'), async (c) => c.json(await service.listJobs({ projectId: c.req.query('projectId'), parentId: c.req.query('parentId') }, page(c))));
  v1.get('/jobs/:id', need('read'), async (c) => {
    // ?wait=N long-polls up to N seconds (max 50) for the job to finish.
    const wait = Number(c.req.query('wait') ?? 0);
    return c.json(await service.waitForJob(c.req.param('id'), Number.isFinite(wait) ? wait : 0));
  });
  v1.post('/jobs/:id/cancel', need('render'), async (c) => c.json(await service.cancelJob(c.req.param('id'))));
  v1.post('/jobs/:id/retry', need('render'), async (c) => {
    const jobId = c.req.param('id');
    return c.json(await service.idempotent(idemKey(c), 'retry_job', { jobId }, async () => ({ job: await service.retryJob(jobId) })), 202);
  });
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
  v1.get('/renders/:id/captions', need('read'), async (c) => {
    const language = c.req.query('language');
    return c.json(await service.getCaptions({ renderId: c.req.param('id'), ...(language ? { language } : {}) }));
  });
  v1.get('/renders/:id/output', need('read'), async (c) => {
    // Without ?file= the render's output, in whatever format it was rendered (#302).
    const o = await service.renderObject(c.req.param('id'), c.req.query('file'));
    return sendStored(c, service, o, o.file.split('/').pop()!);
  });

  v1.get('/assets', need('read'), async (c) => c.json(await service.listAssets({ projectId: c.req.query('projectId') }, page(c))));
  v1.get('/assets/:id', need('read'), async (c) => c.json(await service.getAsset(c.req.param('id'))));
  v1.post(
    '/assets',
    need('write'),
    upload,
    async (c) => {
      const type = c.req.header('content-type') ?? '';
      if (type.startsWith('multipart/form-data')) return c.json(await multipartUpload(c, service), 201);
      const b = await body(c);
      if (typeof b.url !== 'string') throw new ApiError('bad_request', 400, 'send multipart/form-data with a "file" field, or JSON {"url": "https://..."}');
      const url = b.url;
      const opts = { projectId: typeof b.projectId === 'string' ? b.projectId : undefined, assetId: typeof b.assetId === 'string' ? b.assetId : undefined, license: b.license as never };
      return c.json(await service.idempotent(idemKey(c), 'add_asset_from_url', { url, ...opts }, () => service.addAssetFromUrl(url, opts)), 201);
    }
  );

  v1.get('/providers', need('read'), (c) => c.json({ providers: service.listProviders() }));
  v1.put('/providers/:id/config', need('owner'), json, async (c) => {
    const b = await body(c);
    return c.json(await service.configureProvider(c.req.param('id'), b.values, actor(c)));
  });
  v1.post('/providers/:id/run', need('render'), json, async (c) => {
    const b = await body(c);
    const providerId = c.req.param('id');
    const params = (b.params ?? {}) as Record<string, unknown>;
    const opts = {
      projectId: typeof b.projectId === 'string' ? b.projectId : undefined,
      acknowledgeCost: b.acknowledgeCost === true,
      attachAs: b.attachAs === 'none' ? ('none' as const) : undefined,
      assetId: typeof b.assetId === 'string' ? b.assetId : undefined,
    };
    return c.json(await service.idempotent(idemKey(c), 'run_provider', { providerId, params, ...opts }, () => service.runProvider(providerId, params, opts)), 201);
  });

  v1.get('/config', need('owner'), (c) => c.json(service.getConfig({ prefix: c.req.query('prefix') || undefined })));
  v1.patch('/config', need('owner'), json, async (c) => {
    const b = await body(c);
    // { "settings": { "limits.rateLimitPerMinute": 120 } }; a bare object of settings works too.
    const patch = 'settings' in b && b.settings && typeof b.settings === 'object' ? b.settings : b;
    return c.json(await service.updateConfig(patch, actor(c)));
  });

  v1.get('/licence', need('read'), (c) => c.json(service.getLicence()));
  v1.post('/licence', need('owner'), json, async (c) => {
    const b = await body(c);
    return c.json(await service.activateLicence(b.key, actor(c)));
  });
  v1.delete('/licence', need('owner'), async (c) => c.json(await service.deactivateLicence(actor(c))));

  // Analytics (#292): aggregates over a bounded range, read from jobs, render manifests, storage usage and the webhook outbox.
  v1.get('/analytics/summary', need('read'), async (c) => c.json(await service.analyticsSummary(c.req.query())));
  v1.get('/storage', need('owner'), async (c) => c.json(await service.getStorage()));
  v1.post('/storage/cleanup', need('owner'), json, async (c) => {
    const b = await body(c);
    return c.json(await service.runStorageCleanup({ dryRun: b.dryRun ?? (c.req.query('dryRun') === 'true' ? true : undefined), renderDays: b.renderDays, keepLastRendersPerProject: b.keepLastRendersPerProject }, actor(c)));
  });

  v1.get('/keys', need('admin'), async (c) => c.json({ keys: await service.listKeys() }));
  v1.post('/keys', need('admin'), json, async (c) => {
    const b = await body(c);
    const scopes = Array.isArray(b.scopes) ? (b.scopes as Scope[]) : ['read', 'write', 'render'];
    const r = await service.createKey(typeof b.name === 'string' ? b.name : '', scopes as Scope[], keyOptions(b), actor(c));
    return c.json({ ...r, note: 'store this key now; it is not shown again' }, 201);
  });
  v1.get('/keys/:id', need('admin'), async (c) => c.json(await service.getKey(c.req.param('id'))));
  v1.patch('/keys/:id', need('admin'), json, async (c) => {
    const b = await body(c);
    return c.json(await service.updateKey(c.req.param('id'), { ...keyOptions(b), ...(b.name !== undefined ? { name: b.name as string } : {}) }, actor(c)));
  });
  v1.post('/keys/:id/rotate', need('admin'), json, async (c) => {
    const b = await body(c);
    const r = await service.rotateKey(c.req.param('id'), { graceHours: b.graceHours as number | undefined }, actor(c));
    return c.json({ ...r, note: 'store the new key now; it is not shown again. The old one works until record.previousSecretExpiresAt' });
  });
  v1.post('/keys/:id/revoke', need('admin'), async (c) => c.json(await service.revokeKey(c.req.param('id'), actor(c))));
  v1.delete('/keys/:id', need('admin'), async (c) => {
    await service.deleteKey(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });

  // ---- workspaces (#304) -------------------------------------------------------------
  v1.get('/workspace', need('read'), async (c) => c.json(await service.getWorkspace()));
  v1.get('/workspaces', need('owner'), async (c) => c.json(await service.listWorkspaces()));
  v1.post('/workspaces', need('owner'), json, async (c) => {
    const r = await service.createWorkspace(await body(c), actor(c));
    return c.json(r.key ? { ...r, note: 'store the admin key now; it is not shown again' } : r, 201);
  });
  v1.patch('/workspaces/:id', need('owner'), json, async (c) => c.json(await service.updateWorkspace(c.req.param('id'), await body(c), actor(c))));
  v1.delete('/workspaces/:id', need('owner'), async (c) => c.json(await service.deleteWorkspace(c.req.param('id'), actor(c))));
  v1.post('/workspaces/:id/restore', need('owner'), async (c) => c.json(await service.restoreWorkspace(c.req.param('id'), actor(c))));

  // ---- outbound events (#66): webhooks, chat and email channels ---------------------
  v1.get('/webhooks', need('admin'), async (c) => c.json(await service.listWebhooks()));
  v1.post('/webhooks', need('admin'), json, async (c) => c.json(await service.createWebhook(await body(c), actor(c)), 201));
  v1.get('/webhooks/:id', need('admin'), async (c) => c.json(await service.getWebhook(c.req.param('id'))));
  v1.patch('/webhooks/:id', need('admin'), json, async (c) => c.json(await service.updateWebhook(c.req.param('id'), await body(c), actor(c))));
  v1.delete('/webhooks/:id', need('admin'), async (c) => c.json(await service.deleteWebhook(c.req.param('id'), actor(c))));
  v1.post('/webhooks/:id/test', need('admin'), json, async (c) => {
    const b = await body(c);
    const wait = b.waitSeconds ?? c.req.query('wait');
    return c.json(await service.testWebhook(c.req.param('id'), { waitSeconds: wait === undefined ? undefined : Number(wait) }, actor(c)), 202);
  });
  v1.get('/webhooks/:id/deliveries', need('admin'), async (c) => c.json(await service.listWebhookDeliveries(c.req.param('id'), c.req.query())));
  v1.post('/webhooks/:id/deliveries/:deliveryId/replay', need('admin'), async (c) =>
    c.json(await service.replayWebhookDelivery(c.req.param('id'), c.req.param('deliveryId'), actor(c)), 202)
  );
  // Webhooks for operations (#306): resend, secret rotation with overlap, and the delivery log for read keys.
  v1.post('/webhooks/:id/resend', need('admin'), json, async (c) => c.json(await service.resendWebhook(c.req.param('id'), await body(c), actor(c)), 202));
  v1.post('/webhooks/:id/rotate-secret', need('admin'), json, async (c) => c.json(await service.rotateWebhookSecret(c.req.param('id'), await body(c), actor(c))));
  v1.get('/webhooks/:id/log', need('read'), async (c) => c.json(await service.getWebhookLog(c.req.param('id'), c.req.query())));

  v1.get('/audit', need('admin'), async (c) => {
    const query = c.req.query();
    const format = query.format ?? (/(text\/csv)/.test(c.req.header('accept') ?? '') ? 'csv' : /ndjson|jsonl/.test(c.req.header('accept') ?? '') ? 'jsonl' : 'json');
    if (format === 'json') return c.json(await service.listAuditEvents(query));
    // Streamed one database page at a time: a large export never sits in memory.
    const exp = service.streamAuditEvents(query, format);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await exp.chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(enc.encode(next.value));
        } catch (e) {
          controller.error(e);
        }
      },
      async cancel() {
        await exp.chunks.return(undefined);
      },
    });
    return c.body(stream, 200, { 'Content-Type': exp.contentType, 'Content-Disposition': `attachment; filename="${exp.filename}"`, 'Cache-Control': 'no-store' });
  });

  app.route('/v1', v1);
  mountDashboard(app, service, config); // GET /dashboard (dashboard.enabled, D-115)
  return app;
}

/** Key lifecycle options from a JSON body (create_key / update_key). expiresInDays is a shortcut for expiresAt. */
function keyOptions(b: Record<string, unknown>): KeyOptions {
  const o: KeyOptions = {};
  for (const k of ['expiresAt', 'rateLimitPerMinute', 'rendersPerDay', 'rendersPerMonth', 'ipAllowlist', 'maxPriority'] as const) {
    if (k in b) (o as Record<string, unknown>)[k] = b[k];
  }
  if (b.expiresInDays !== undefined) {
    const d = Number(b.expiresInDays);
    if (!(d > 0 && d <= 3650)) throw new ApiError('bad_request', 400, 'expiresInDays must be a number from 0 to 3650');
    o.expiresAt = new Date(Date.now() + d * 86_400_000).toISOString();
  }
  return o;
}

/**
 * A multipart upload, streamed (D-090): the "file" part goes to a temporary
 * file as it arrives (stopped at limits.maxUploadBytes), the other fields
 * (projectId, assetId, license) are read as they come, before or after it.
 */
async function multipartUpload(c: Context, service: ReelforgeService) {
  const body = c.req.raw.body;
  if (!body) throw new ApiError('bad_request', 400, 'multipart upload needs a "file" field');
  let bb: busboy.Busboy;
  try {
    bb = busboy({ headers: { 'content-type': c.req.header('content-type') ?? '' }, limits: { files: 1, fields: 20, fieldSize: 64 * 1024, parts: 30 } });
  } catch (e) {
    throw new ApiError('bad_request', 400, `invalid multipart request: ${(e as Error).message}`);
  }
  const fields: Record<string, string> = {};
  const src = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
  let upload: ReturnType<ReelforgeService['uploadAssetStream']> | undefined;
  let fail!: (e: unknown) => void;
  const failed = new Promise<never>((_, reject) => (fail = reject));
  failed.catch(() => undefined);
  const closed = new Promise<void>((resolve, reject) => {
    bb.on('close', resolve);
    bb.on('error', (e: Error) => reject(new ApiError('bad_request', 400, `invalid multipart body: ${e.message}`)));
  });
  closed.catch(() => undefined);
  bb.on('field', (name: string, value: string) => {
    fields[name] = value;
  });
  bb.on('file', (name: string, stream: Readable, info: busboy.FileInfo) => {
    if (name !== 'file' || upload) {
      stream.resume();
      return;
    }
    upload = service.uploadAssetStream(stream, async () => {
      await closed; // every field has arrived
      return {
        filename: info.filename,
        contentType: info.mimeType,
        projectId: fields.projectId || undefined,
        assetId: fields.assetId || undefined,
        license: fields.license ? parseLicense(fields.license) : undefined,
      };
    });
    upload.catch((e) => {
      // Stop reading the request at once (too large, unsupported type, ...).
      src.unpipe(bb);
      src.destroy();
      fail(e);
    });
  });
  src.on('error', (e) => bb.destroy(e));
  src.pipe(bb);
  await Promise.race([closed, failed]);
  if (!upload) throw new ApiError('bad_request', 400, 'multipart upload needs a "file" field');
  return upload;
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
