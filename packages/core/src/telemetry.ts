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
  /** Database queue: jobs handed back to the queue (reason: lease_expired, released). */
  jobsRequeued: Counter;
  /** Database queue: claim, heartbeat or recovery calls that failed (operation). */
  queueErrors: Counter;
  /** Requests refused by a resource limit (reason: LimitReason, a fixed set). */
  limitRejections: Counter;
  /** Enqueue to first claim of render and preview jobs, by type and priority only (bounded labels; D-103). */
  queueWait: Histogram;
  /** Claim attempts of the database queue, by what started them (trigger) and whether one got a job (result). */
  queueClaims: Counter;
  /** Dispatch (D-104): ready messages published (driver, reason). */
  dispatchPublished: Counter;
  /** Dispatch: outbox publishes that failed (driver). */
  dispatchPublishFailures: Counter;
  /** Dispatch: messages a worker received (driver, kind ready/claimed). */
  dispatchReceived: Counter;
  /** Dispatch: ready messages for a job id already waiting to be claimed here (driver). */
  dispatchDuplicates: Counter;
  /** Dispatch: jobs claimed by the fallback poll instead of a message (driver; reason fallback or degraded). */
  dispatchFallbackClaims: Counter;
}

const SECONDS_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
/** Queue wait: fine below a minute (preview SLO 60 s), coarse up to an hour (render SLO 300 s). */
const QUEUE_WAIT_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
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
      jobsRequeued: meter.createCounter('reelforge.jobs.requeued', { description: 'Database queue: jobs queued again, by reason (lease_expired: the worker stopped renewing its lease; released: a worker shut down).' }),
      queueErrors: meter.createCounter('reelforge.queue.errors', { description: 'Database queue: failed queue operations (claim, heartbeat, recover), e.g. while the database is unreachable.' }),
      limitRejections: meter.createCounter('reelforge.limits.rejections', {
        description:
          'Requests refused by a resource limit (D-090, D-091, D-103), by reason: render_limit, jobs_per_key, queue_full, queue_wait, render_quota, upload_too_large, provider_runs_per_key, provider_budget.',
      }),
      queueWait: meter.createHistogram('reelforge.job.queue_wait', {
        unit: 's',
        description:
          'Time from enqueue to the first claim of render and preview jobs, by type and priority (fan-out units and joins are not measured). Recorded by the instance that claims. SLO: p95 < 60 s for previews, < 300 s for renders.',
        advice: { explicitBucketBoundaries: QUEUE_WAIT_BUCKETS },
      }),
      queueClaims: meter.createCounter('reelforge.queue.claims', {
        description:
          'Database queue: claim attempts by trigger (poll: the idle poll; fallback: the dispatch fallback poll; wake: a dispatch message; local: this instance enqueued, a job finished or a lease was recovered) and result (job, empty).',
      }),
      dispatchPublished: meter.createCounter('reelforge.queue.dispatch.published', {
        description: 'Queue dispatch (D-104): ready messages published, by driver and reason (enqueue, requeue, release, fanout, join, outbox).',
      }),
      dispatchPublishFailures: meter.createCounter('reelforge.queue.dispatch.publish_failures', { description: 'Queue dispatch: outbox publishes to a broker that failed and will be retried, by driver.' }),
      dispatchReceived: meter.createCounter('reelforge.queue.dispatch.received', { description: 'Queue dispatch: messages received by this worker, by driver and kind (ready, claimed).' }),
      dispatchDuplicates: meter.createCounter('reelforge.queue.dispatch.duplicates', {
        description: 'Queue dispatch: ready messages for a job id this worker was already about to claim (duplicates are no-ops), by driver.',
      }),
      dispatchFallbackClaims: meter.createCounter('reelforge.queue.dispatch.fallback_claims', {
        description:
          'Queue dispatch: jobs claimed by the poll instead of a message, by driver and reason (fallback: the periodic fallback poll found work a message did not announce; degraded: the listener was disconnected).',
      }),
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
