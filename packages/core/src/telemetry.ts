import {
  ProxyTracerProvider,
  SpanStatusCode,
  context,
  createNoopMeter,
  trace,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type SpanKind,
  type Tracer,
} from '@opentelemetry/api';

/**
 * Traces and metrics of the core (D-050). The core only uses the vendor-neutral
 * OpenTelemetry API; the server decides where the data goes (Prometheus, OTLP
 * or nowhere) by giving the service a Tracer and a Meter. Without them every
 * call here is a no-op, so tests, the CLI and scripts/spike.ts pay nothing.
 *
 * Attribute values must never hold secrets, prompts or file contents: ids,
 * engine names, sizes and outcomes only (docs/PRIVACY.md).
 */
export interface Telemetry {
  tracer: Tracer;
  meter: Meter;
}

const NOOP_TRACER: Tracer = new ProxyTracerProvider().getTracer('reelforge');

export const NOOP_TELEMETRY: Telemetry = Object.freeze({ tracer: NOOP_TRACER, meter: createNoopMeter() });

/** Instruments the core records into. Names follow OpenTelemetry conventions; Prometheus names are in docs/OBSERVABILITY.md. */
export interface CoreInstruments {
  jobsFinished: Counter;
  jobDuration: Histogram;
  sceneDuration: Histogram;
  framesRendered: Counter;
  renderFps: Histogram;
  providerCalls: Counter;
}

const SECONDS_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
const FPS_BUCKETS = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 240];

const cache = new WeakMap<Meter, CoreInstruments>();

/** The core's instruments on this meter (created once per meter). */
export function coreInstruments(meter: Meter): CoreInstruments {
  let i = cache.get(meter);
  if (!i) {
    i = {
      jobsFinished: meter.createCounter('reelforge.jobs.finished', { description: 'Jobs that reached a final state, by type and status.' }),
      jobDuration: meter.createHistogram('reelforge.job.duration', {
        unit: 's',
        description: 'Run time of jobs from start to final state, by type and status.',
        advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
      }),
      sceneDuration: meter.createHistogram('reelforge.render.scene.duration', {
        unit: 's',
        description: 'Time an engine took to render one scene, by engine and outcome.',
        advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
      }),
      framesRendered: meter.createCounter('reelforge.render.frames', { description: 'Frames rendered by the engines, by engine.' }),
      renderFps: meter.createHistogram('reelforge.render.fps', {
        description: 'Frames per second of wall-clock time for each scene render, by engine.',
        advice: { explicitBucketBoundaries: FPS_BUCKETS },
      }),
      providerCalls: meter.createCounter('reelforge.provider.calls', { description: 'Provider runs (TTS, ...), by provider and outcome (ok, cached, error).' }),
    };
    cache.set(meter, i);
  }
  return i;
}

/**
 * Run `fn` inside a span that is a child of the active span (or of `parent`).
 * Errors set the span status and are re-thrown; the span always ends.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  opts: { kind?: SpanKind; parent?: Context } = {}
): Promise<T> {
  const parent = opts.parent ?? context.active();
  const span = tracer.startSpan(name, { attributes, ...(opts.kind !== undefined ? { kind: opts.kind } : {}) }, parent);
  try {
    return await context.with(trace.setSpan(parent, span), () => fn(span));
  } catch (e) {
    const err = e as Error;
    span.recordException({ name: err.name, message: err.message });
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message.slice(0, 500) });
    throw e;
  } finally {
    span.end();
  }
}
