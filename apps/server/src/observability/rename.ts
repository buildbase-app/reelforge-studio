import type { Attributes, Context } from '@opentelemetry/api';
import type { ResourceMetrics } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';

/**
 * Telemetry names during the rename (#412, docs/RENAMED.md): ReelForge is now
 * RenderWeld. In one place, at export time, so no instrument or span changes:
 *
 * - every metric named `reelforge.*` (Prometheus `reelforge_*`) is also
 *   exported as `renderweld.*` (`renderweld_*`) with the same data points;
 * - every `reelforge.*` attribute of a metric data point or span gets a
 *   `renderweld.*` twin with the same value, so both metric names carry
 *   identical labels.
 *
 * The old names stay for the deprecation window and are removed after a date
 * announced in the release notes.
 */
export const LEGACY_PREFIX = 'reelforge.';
export const PREFIX = 'renderweld.';

/** `reelforge.x` -> `renderweld.x`; undefined for other names. */
export function renamedTelemetryName(name: string): string | undefined {
  return name.startsWith(LEGACY_PREFIX) ? `${PREFIX}${name.slice(LEGACY_PREFIX.length)}` : undefined;
}

/** The attributes with a `renderweld.*` twin for every `reelforge.*` key (an existing twin is kept). */
export function twinAttributes(attributes: Attributes): Attributes {
  let out: Attributes | undefined;
  for (const [k, v] of Object.entries(attributes)) {
    const twin = renamedTelemetryName(k);
    if (twin && !(twin in attributes)) (out ??= { ...attributes })[twin] = v;
  }
  return out ?? attributes;
}

/** Collected metrics with every `reelforge.*` metric also under `renderweld.*`, and twinned attributes on every data point. */
export function twinResourceMetrics(rm: ResourceMetrics): ResourceMetrics {
  return {
    ...rm,
    scopeMetrics: rm.scopeMetrics.map((sm) => ({
      ...sm,
      metrics: sm.metrics.flatMap((m) => {
        const twinned = { ...m, dataPoints: m.dataPoints.map((p) => ({ ...p, attributes: twinAttributes(p.attributes) })) } as typeof m;
        const name = renamedTelemetryName(m.descriptor.name);
        return name ? [twinned, { ...twinned, descriptor: { ...m.descriptor, name } } as typeof m] : [twinned];
      }),
    })),
  };
}

/** Adds the `renderweld.*` twins to a span's attributes just before it ends (first in the processor list). */
export class RenameSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parent: Context): void {}
  onEnding(span: Span): void {
    const attributes = (span as unknown as ReadableSpan).attributes;
    const twinned = twinAttributes(attributes);
    if (twinned !== attributes) span.setAttributes(Object.fromEntries(Object.entries(twinned).filter(([k]) => !(k in attributes))));
  }
  onEnd(_span: ReadableSpan): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
