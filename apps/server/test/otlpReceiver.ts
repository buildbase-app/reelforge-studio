import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal OTLP/HTTP receiver for tests (http/json only): records every
 * request by path. `mode` makes it answer 200, 503 (retryable) or never.
 */
export interface OtlpReceiver {
  url: string;
  mode: 'ok' | 'unavailable' | 'hang';
  requests: Array<{ path: string; headers: IncomingMessage['headers']; body: any; at: number }>;
  spans(): Array<{ traceId: string; spanId: string; parentSpanId?: string; name: string; attributes: Record<string, unknown>; status?: { code?: number } }>;
  logs(): Array<{ body: string; severityText?: string; attributes: Record<string, unknown>; traceId?: string }>;
  metricNames(): string[];
  resourceAttributes(): Record<string, unknown>;
  close(): Promise<void>;
}

function attrs(list: Array<{ key: string; value: Record<string, unknown> }> = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of list) {
    const v = a.value ?? {};
    out[a.key] = v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : undefined) ?? v.doubleValue ?? v.boolValue;
  }
  return out;
}

export async function startOtlpReceiver(): Promise<OtlpReceiver> {
  const hanging: Array<() => void> = [];
  const r: OtlpReceiver = {
    url: '',
    mode: 'ok',
    requests: [],
    spans: () =>
      r.requests
        .filter((q) => q.path === '/v1/traces')
        .flatMap((q) => q.body.resourceSpans ?? [])
        .flatMap((rs: any) => rs.scopeSpans ?? [])
        .flatMap((ss: any) => ss.spans ?? [])
        .map((s: any) => ({ ...s, attributes: attrs(s.attributes) })),
    logs: () =>
      r.requests
        .filter((q) => q.path === '/v1/logs')
        .flatMap((q) => q.body.resourceLogs ?? [])
        .flatMap((rl: any) => rl.scopeLogs ?? [])
        .flatMap((sl: any) => sl.logRecords ?? [])
        .map((l: any) => ({ ...l, body: l.body?.stringValue ?? '', attributes: attrs(l.attributes) })),
    metricNames: () => [
      ...new Set(
        r.requests
          .filter((q) => q.path === '/v1/metrics')
          .flatMap((q) => q.body.resourceMetrics ?? [])
          .flatMap((rm: any) => rm.scopeMetrics ?? [])
          .flatMap((sm: any) => sm.metrics ?? [])
          .map((m: any) => m.name as string)
      ),
    ],
    resourceAttributes: () => {
      const q = r.requests.find((x) => x.body?.resourceSpans || x.body?.resourceLogs || x.body?.resourceMetrics);
      const res = (q?.body.resourceSpans ?? q?.body.resourceLogs ?? q?.body.resourceMetrics)?.[0]?.resource;
      return attrs(res?.attributes);
    },
    close: () =>
      new Promise((ok) => {
        for (const h of hanging.splice(0)) h();
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      let body: unknown = null;
      try {
        body = JSON.parse(data);
      } catch {
        body = { raw: data.length };
      }
      r.requests.push({ path: req.url ?? '', headers: req.headers, body, at: Date.now() });
      if (r.mode === 'hang') {
        hanging.push(() => res.destroy());
        return;
      }
      if (r.mode === 'unavailable') {
        res.writeHead(503, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  r.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return r;
}

/** Parse the Prometheus text exposition format into samples (enough for the tests). */
export function parsePrometheus(text: string): Array<{ name: string; labels: Record<string, string>; value: number }> {
  const out: Array<{ name: string; labels: Record<string, string>; value: number }> = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)(\s+\d+)?$/.exec(line);
    if (!m) throw new Error(`not a Prometheus sample line: ${line}`);
    const labels: Record<string, string> = {};
    for (const l of (m[3] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]!] = l[2]!.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
    const value = m[4] === '+Inf' ? Infinity : m[4] === '-Inf' ? -Infinity : Number(m[4]);
    if (Number.isNaN(value) && m[4] !== 'NaN') throw new Error(`bad value in: ${line}`);
    out.push({ name: m[1]!, labels, value });
  }
  return out;
}
