import { randomUUID } from 'node:crypto';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, trace, type TextMapGetter } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { Context, MiddlewareHandler } from 'hono';
import type { Observability } from './telemetry';

const propagator = new W3CTraceContextPropagator();
const headerGetter: TextMapGetter<Headers> = {
  keys: (h) => [...h.keys()],
  get: (h, key) => h.get(key) ?? undefined,
};

/** A caller's X-Request-Id is kept when it is short and plain; otherwise a new one is made. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Infrastructure endpoints probed every few seconds: logged at debug, not info. */
const QUIET = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * The route template of a handled request (`/v1/projects/:id`), never the raw
 * path: metric labels and span names stay low-cardinality and carry no ids.
 */
export function routeOf(c: Context): string {
  const last = c.req.matchedRoutes.at(-1)?.path ?? '';
  if (!last || last.endsWith('*')) return 'unmatched';
  return last.replace(/:\w+\{([^}]+)\}/g, '$1');
}

/**
 * Per request (D-051, D-052): a request id (X-Request-Id, echoed), a server
 * span continuing a W3C `traceparent`, the http.server.request.duration
 * histogram, and one access log line with request id, key id (never the key),
 * method, route, status and duration.
 */
export function httpTelemetry(obs: Observability): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    const given = c.req.header('x-request-id');
    const requestId = given && REQUEST_ID.test(given) ? given : randomUUID();
    const method = c.req.method;
    const parent = propagator.extract(ROOT_CONTEXT, c.req.raw.headers, headerGetter);
    const span = obs.tracer.startSpan(method, { kind: SpanKind.SERVER, attributes: { 'http.request.method': method, 'url.path': c.req.path, 'reelforge.request_id': requestId } }, parent);
    c.set('requestId' as never, requestId as never);
    c.header('X-Request-Id', requestId);
    try {
      await context.with(trace.setSpan(parent, span), () => next());
    } finally {
      try {
        c.header('X-Request-Id', requestId);
      } catch {
        // immutable response headers
      }
      const route = routeOf(c);
      const status = c.res.status;
      const seconds = (performance.now() - started) / 1000;
      const keyId = (c.get('auth' as never) as { keyId?: string } | undefined)?.keyId;
      span.updateName(`${method} ${route}`);
      span.setAttribute('http.route', route);
      span.setAttribute('http.response.status_code', status);
      if (keyId) span.setAttribute('reelforge.key_id', keyId);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      obs.httpDuration.record(seconds, { 'http.request.method': method, 'http.route': route, 'http.response.status_code': status });
      const level = status >= 500 ? 'warn' : QUIET.has(c.req.path) ? 'debug' : 'info';
      context.with(trace.setSpan(parent, span), () =>
        obs.logger.log(level, `${method} ${route} ${status}`, {
          request_id: requestId,
          ...(keyId ? { key_id: keyId } : {}),
          method,
          route,
          status,
          duration_ms: Math.round(seconds * 10000) / 10,
        })
      );
      span.end();
    }
  };
}
