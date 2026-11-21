import { context, ProxyTracerProvider, type Context, type Meter, type ObservableResult, type Span, type SpanOptions, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPLogExporter as OTLPLogExporterJson } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as OTLPLogExporterProto } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter as OTLPMetricExporterJson } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPMetricExporterProto } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter as OTLPTraceExporterJson } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPTraceExporterProto } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider, MetricReader, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, TracerProvider } from '@opentelemetry/sdk-trace';
import type { Config, LicenceStatus, ReelforgeService, Telemetry } from '@reelforge/core';
import type { LogsExporter, StructuredLogger } from './logger';

/**
 * Logs, metrics and traces with selectable exporters (issue #64, D-050..D-054).
 * Every observability.* setting is a runtime setting: `apply()` swaps
 * exporters while the server runs, so they can be changed by the config
 * file, env, or update_config / PATCH /v1/config.
 *
 * - Metrics: one MeterProvider for the life of the server with two readers:
 *   a pull reader serialised to the Prometheus text format on GET /metrics,
 *   and a push reader whose OTLP exporter and interval can be swapped.
 * - Traces: the service gets a Tracer that delegates to the current
 *   TracerProvider (none while tracing is off).
 * - Logs: the StructuredLogger gets an OpenTelemetry Logger while the logs
 *   exporter is `otlp`.
 */

export interface ObservabilitySettings {
  serviceName: string;
  serviceVersion: string;
  edition: string;
  logsExporter: LogsExporter;
  metricsExporter: 'prometheus' | 'otlp' | 'off';
  metricsToken?: string;
  exportIntervalSeconds: number;
  tracingExporter: 'otlp' | 'off';
  sampleRatio: number;
  otlp: { endpoint?: string; headers: Record<string, string>; protocol: 'http/protobuf' | 'http/json'; timeoutSeconds: number };
}

/** `name=value,name2=value2` (values may be URL-encoded), as OTEL_EXPORTER_OTLP_HEADERS. */
export function parseOtlpHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep it as written
    }
    if (name) out[name] = value;
  }
  return out;
}

export function observabilitySettings(c: Config, serviceVersion: string, edition: string): ObservabilitySettings {
  const o = c.observability;
  return {
    serviceName: o.serviceName,
    serviceVersion,
    edition,
    logsExporter: o.logs.exporter,
    metricsExporter: o.metrics.exporter,
    metricsToken: o.metrics.bearerToken,
    exportIntervalSeconds: o.metrics.exportIntervalSeconds,
    tracingExporter: o.tracing.exporter,
    sampleRatio: o.tracing.sampleRatio,
    otlp: { endpoint: o.otlp.endpoint, headers: parseOtlpHeaders(o.otlp.headers), protocol: o.otlp.protocol, timeoutSeconds: o.otlp.timeoutSeconds },
  };
}

/** Problems that keep a selected exporter from working (shown in the log and /readyz-style checks). */
export function settingsProblems(s: ObservabilitySettings): string[] {
  const need = [
    s.logsExporter === 'otlp' && 'observability.logs.exporter',
    s.metricsExporter === 'otlp' && 'observability.metrics.exporter',
    s.tracingExporter === 'otlp' && 'observability.tracing.exporter',
  ].filter(Boolean);
  return !s.otlp.endpoint && need.length ? [`${need.join(', ')} ${need.length > 1 ? 'are' : 'is'} "otlp" but observability.otlp.endpoint is not set: nothing is exported`] : [];
}

export type Signal = 'traces' | 'metrics' | 'logs';

/** How the last OTLP exports of one signal went (GET /readyz, D-053). */
export interface ExportHealth {
  /** null until the first export finished. */
  ok: boolean | null;
  endpoint: string;
  exported: number;
  failures: number;
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
}

/** A failing receiver is logged at most once a minute per signal (and once when it recovers). */
const FAILURE_LOG_INTERVAL_MS = 60_000;

/** Collects on demand for GET /metrics. */
class PullMetricReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

/** Pushes on a timer through an exporter that can be swapped at runtime. */
class PushMetricReader extends MetricReader {
  private exporter: PushMetricExporter | null = null;
  private timer: NodeJS.Timeout | null = null;

  async configure(exporter: PushMetricExporter | null, intervalMs: number): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const old = this.exporter;
    if (old) {
      await this.exportOnce().catch(() => undefined);
      await old.shutdown().catch(() => undefined);
    }
    this.exporter = exporter;
    if (exporter) {
      this.timer = setInterval(() => void this.exportOnce().catch(() => undefined), intervalMs);
      this.timer.unref();
    }
  }

  private async exportOnce(): Promise<void> {
    const exporter = this.exporter;
    if (!exporter) return;
    const { resourceMetrics } = await this.collect();
    await new Promise<void>((resolve) => exporter.export(resourceMetrics, () => resolve()));
  }

  protected async onForceFlush(): Promise<void> {
    await this.exportOnce();
  }
  protected async onShutdown(): Promise<void> {
    await this.configure(null, 0);
  }
}

/** A Tracer whose spans go to whatever TracerProvider is current. */
class SwitchTracer implements Tracer {
  constructor(private readonly current: () => Tracer) {}
  startSpan(name: string, options?: SpanOptions, ctx?: Context): Span {
    return this.current().startSpan(name, options, ctx);
  }
  startActiveSpan<F extends (span: Span) => unknown>(...args: unknown[]): ReturnType<F> {
    const t = this.current() as unknown as { startActiveSpan: (...a: unknown[]) => ReturnType<F> };
    return t.startActiveSpan(...args);
  }
}

/**
 * The Prometheus text serializer, with the unit suffix Prometheus expects for
 * seconds (`http_server_request_duration_seconds_bucket`), which the
 * OpenTelemetry serializer leaves out. Scope labels are dropped; target_info
 * carries service.name, service.version and reelforge.edition.
 */
function prometheusSerializer(): PrometheusSerializer {
  const serializer = new PrometheusSerializer(undefined, false, undefined, false, true);
  const patched = serializer as unknown as { _getPrometheusMetricName(m: { descriptor: { unit: string } }): string };
  const original = patched._getPrometheusMetricName.bind(serializer);
  patched._getPrometheusMetricName = (m) => {
    const name = original(m);
    return m.descriptor.unit === 's' && !/_seconds(_total)?$/.test(name) ? name.replace(/(_total)?$/, '_seconds$1') : name;
  };
  return serializer;
}

const NOOP_TRACER = new ProxyTracerProvider().getTracer('reelforge');
const LICENCE_STATES: LicenceStatus[] = ['valid', 'grace', 'invalid', 'unlicensed', 'checking'];
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

let contextManagerRegistered = false;
/** AsyncLocalStorage context, so spans started in a request are parents of the job and render spans. Once per process. */
function ensureContextManager(): void {
  if (contextManagerRegistered) return;
  contextManagerRegistered = context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()) || true;
}

export class Observability {
  readonly meterProvider: MeterProvider;
  readonly meter: Meter;
  readonly tracer: Tracer;
  readonly telemetry: Telemetry;
  settings: ObservabilitySettings;
  private readonly pull = new PullMetricReader();
  private readonly push = new PushMetricReader();
  private readonly serializer = prometheusSerializer();
  private readonly resource: Resource;
  private tracerProvider: TracerProvider | null = null;
  private loggerProvider: LoggerProvider | null = null;
  private currentTracer: Tracer = NOOP_TRACER;
  private applied: { tracing?: string; logs?: string; metrics?: string } = {};
  private detach: Array<() => void> = [];
  private health = new Map<Signal, ExportHealth>();
  private lastFailureLog = new Map<Signal, number>();
  readonly httpDuration;

  constructor(
    settings: ObservabilitySettings,
    readonly logger: StructuredLogger
  ) {
    ensureContextManager();
    this.settings = settings;
    this.resource = resourceFromAttributes({
      'service.name': settings.serviceName,
      'service.version': settings.serviceVersion,
      'reelforge.edition': settings.edition,
    });
    this.meterProvider = new MeterProvider({ resource: this.resource, readers: [this.pull, this.push] });
    this.meter = this.meterProvider.getMeter('reelforge', settings.serviceVersion);
    this.tracer = new SwitchTracer(() => this.currentTracer);
    this.telemetry = { tracer: this.tracer, meter: this.meter };
    this.httpDuration = this.meter.createHistogram('http.server.request.duration', {
      unit: 's',
      description: 'HTTP requests handled, by method, route template and status code (until the handler returned; streams continue after).',
      advice: { explicitBucketBoundaries: HTTP_BUCKETS },
    });
    this.meter
      .createObservableGauge('reelforge.build.info', { description: 'Always 1; the labels carry the version and edition.' })
      .addCallback((r) => r.observe(1, { 'service.version': settings.serviceVersion, 'reelforge.edition': settings.edition }));
    this.apply(settings);
  }

  /** Switch exporters to these settings (start-up and every runtime change). Never throws. */
  apply(next: ObservabilitySettings): void {
    this.settings = next;
    this.logger.exporter = next.logsExporter;
    const otlpKey = (signal: string) => JSON.stringify([next.otlp.endpoint, next.otlp.headers, next.otlp.protocol, next.otlp.timeoutSeconds, signal]);
    const tracing = next.tracingExporter === 'otlp' && next.otlp.endpoint ? `${otlpKey('traces')}|${next.sampleRatio}` : 'off';
    const logs = next.logsExporter === 'otlp' && next.otlp.endpoint ? otlpKey('logs') : 'off';
    const metrics = next.metricsExporter === 'otlp' && next.otlp.endpoint ? `${otlpKey('metrics')}|${next.exportIntervalSeconds}` : 'off';
    try {
      if (tracing !== this.applied.tracing) this.applyTracing(next, tracing !== 'off');
      if (logs !== this.applied.logs) this.applyLogs(next, logs !== 'off');
      if (metrics !== this.applied.metrics) void this.push.configure(metrics !== 'off' ? this.metricExporter(next) : null, next.exportIntervalSeconds * 1000);
    } catch (e) {
      this.logger.log('error', `could not apply the observability settings: ${(e as Error).message}`);
    }
    if (tracing !== this.applied.tracing || logs !== this.applied.logs || metrics !== this.applied.metrics) {
      const where = next.otlp.endpoint ? new URL(next.otlp.endpoint).origin : '(no endpoint)';
      this.logger.log('info', `observability: logs ${next.logsExporter}, metrics ${next.metricsExporter}, tracing ${next.tracingExporter}${[tracing, logs, metrics].some((x) => x !== 'off') ? ` → OTLP ${next.otlp.protocol} ${where}` : ''}`);
      for (const p of settingsProblems(next)) this.logger.log('warn', p);
    }
    for (const [signal, on] of [['traces', tracing], ['logs', logs], ['metrics', metrics]] as const) if (on === 'off') this.health.delete(signal);
    this.applied = { tracing, logs, metrics };
  }

  /** Exporter options shared by every signal: URL, headers and a timeout that bounds the built-in retries with backoff. */
  private exporterConfig(s: ObservabilitySettings, signal: Signal) {
    return { url: `${s.otlp.endpoint}/v1/${signal}`, headers: s.otlp.headers, timeoutMillis: s.otlp.timeoutSeconds * 1000 };
  }

  /** Count every export result of an exporter and keep the last error (for /readyz and the log). */
  private track<E extends { export(items: never, cb: (r: ExportResult) => void): void }>(signal: Signal, exporter: E, endpoint: string): E {
    const original = exporter.export.bind(exporter) as (items: unknown, cb: (r: ExportResult) => void) => void;
    const h: ExportHealth = { ok: null, endpoint: new URL(endpoint).origin, exported: 0, failures: 0, consecutiveFailures: 0 };
    this.health.set(signal, h);
    (exporter as unknown as { export: (items: unknown, cb: (r: ExportResult) => void) => void }).export = (items, cb) =>
      original(items, (r) => {
        try {
          this.record(signal, h, r);
        } finally {
          cb(r);
        }
      });
    return exporter;
  }

  private record(signal: Signal, h: ExportHealth, r: ExportResult) {
    const now = new Date().toISOString();
    if (r.code === ExportResultCode.SUCCESS) {
      if (h.consecutiveFailures > 0) this.logger.log('info', `OTLP ${signal} export to ${h.endpoint} works again after ${h.consecutiveFailures} failed attempt(s)`);
      h.ok = true;
      h.exported++;
      h.consecutiveFailures = 0;
      h.lastSuccessAt = now;
      this.lastFailureLog.delete(signal);
      return;
    }
    h.ok = false;
    h.failures++;
    h.consecutiveFailures++;
    h.lastErrorAt = now;
    h.lastError = this.logger.redactor.text(r.error?.message ?? 'export failed').slice(0, 300);
    const last = this.lastFailureLog.get(signal) ?? 0;
    if (Date.now() - last >= FAILURE_LOG_INTERVAL_MS) {
      this.lastFailureLog.set(signal, Date.now());
      this.logger.log('warn', `OTLP ${signal} export to ${h.endpoint} failed (${h.consecutiveFailures} in a row; data is dropped, the server keeps working): ${h.lastError}`);
    }
  }

  /** Exporter state per signal for GET /readyz: empty while nothing is exported over OTLP. */
  exportHealth(): Partial<Record<Signal, ExportHealth>> {
    return Object.fromEntries([...this.health].map(([k, v]) => [k, { ...v }]));
  }

  private applyTracing(s: ObservabilitySettings, on: boolean): void {
    const old = this.tracerProvider;
    this.tracerProvider = null;
    this.currentTracer = NOOP_TRACER;
    if (on) {
      const config = this.exporterConfig(s, 'traces');
      const exporter = this.track('traces', s.otlp.protocol === 'http/json' ? new OTLPTraceExporterJson(config) : new OTLPTraceExporterProto(config), config.url);
      this.tracerProvider = new TracerProvider({
        resource: this.resource,
        sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(s.sampleRatio) }),
        spanProcessors: [new BatchSpanProcessor({ exporter, scheduledDelayMillis: 2000, exportTimeoutMillis: config.timeoutMillis + 1000 })],
      });
      this.currentTracer = this.tracerProvider.getTracer('reelforge', s.serviceVersion);
    }
    if (old) void old.shutdown().catch(() => undefined);
  }

  private applyLogs(s: ObservabilitySettings, on: boolean): void {
    const old = this.loggerProvider;
    this.loggerProvider = null;
    this.logger.otlp = null;
    if (on) {
      const config = this.exporterConfig(s, 'logs');
      const exporter = this.track('logs', s.otlp.protocol === 'http/json' ? new OTLPLogExporterJson(config) : new OTLPLogExporterProto(config), config.url);
      this.loggerProvider = new LoggerProvider({
        resource: this.resource,
        processors: [new BatchLogRecordProcessor({ exporter, scheduledDelayMillis: 2000, exportTimeoutMillis: config.timeoutMillis + 1000 })],
      });
      this.logger.otlp = this.loggerProvider.getLogger('reelforge', s.serviceVersion);
    }
    if (old) void old.shutdown().catch(() => undefined);
  }

  private metricExporter(s: ObservabilitySettings): PushMetricExporter {
    const config = this.exporterConfig(s, 'metrics');
    return this.track('metrics', s.otlp.protocol === 'http/json' ? new OTLPMetricExporterJson(config) : new OTLPMetricExporterProto(config), config.url);
  }

  /** Gauges read from the running service: queue depth, running jobs, licence state. */
  observe(service: ReelforgeService): void {
    const queued = this.meter.createObservableGauge('reelforge.jobs.queued', { description: 'Jobs waiting for a render slot (queue depth; database queue: all instances, the scaling metric for workers).' });
    const running = this.meter.createObservableGauge('reelforge.jobs.running', { description: 'Jobs running now.' });
    const concurrency = this.meter.createObservableGauge('reelforge.jobs.concurrency', { description: 'Render slots (limits.renderConcurrency).' });
    const licence = this.meter.createObservableGauge('reelforge.licence.state', { description: '1 for the current licence state, 0 for the others.' });
    const role = this.meter.createObservableGauge('reelforge.server.role', { description: '1 for this instance\'s role (server.role: all, api, worker), 0 for the others.' });
    // A failing read (a service that is shutting down) must not break the collection.
    const safe = (f: (r: ObservableResult) => void) => (r: ObservableResult) => {
      try {
        f(r);
      } catch {
        // skip this observation
      }
    };
    const jobs = safe((r) => r.observe(service.jobs.stats().queued));
    const run = safe((r) => r.observe(service.jobs.stats().running));
    const slots = safe((r) => r.observe(service.jobs.concurrency));
    const lic = safe((r) => {
      const status = service.getLicence().status;
      for (const s of LICENCE_STATES) r.observe(s === status ? 1 : 0, { 'reelforge.licence.state': s });
    });
    const roles = safe((r) => {
      const current = service.settings.config.server.role;
      for (const x of ['all', 'api', 'worker'] as const) r.observe(x === current ? 1 : 0, { 'reelforge.role': x });
    });
    queued.addCallback(jobs);
    running.addCallback(run);
    concurrency.addCallback(slots);
    licence.addCallback(lic);
    role.addCallback(roles);
    this.detach.push(() => {
      role.removeCallback(roles);
      queued.removeCallback(jobs);
      running.removeCallback(run);
      concurrency.removeCallback(slots);
      licence.removeCallback(lic);
    });
  }

  /** The Prometheus text exposition of every metric (GET /metrics). */
  async prometheus(): Promise<string> {
    const { resourceMetrics, errors } = await this.pull.collect();
    for (const e of errors) this.logger.log('warn', `collecting metrics: ${String(e)}`);
    return this.serializer.serialize(resourceMetrics);
  }

  /** Flush and stop every exporter (shutdown). */
  async shutdown(): Promise<void> {
    // The last metrics push still reads the service gauges; detach them afterwards.
    await Promise.allSettled([this.tracerProvider?.shutdown(), this.loggerProvider?.shutdown(), this.meterProvider.shutdown()]);
    for (const d of this.detach.splice(0)) d();
    this.tracerProvider = null;
    this.loggerProvider = null;
    this.logger.otlp = null;
    this.currentTracer = NOOP_TRACER;
  }
}
