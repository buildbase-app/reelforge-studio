import type { BackendCapabilities, BackendContext, BackendEstimate, EstimateRequest, RenderBackend, RenderOutcome, RenderRequest } from '../plugins';
import { estimateUnits } from './estimate';

/**
 * Renders on the worker that claimed the job (the default): this server with
 * role `all`, a pool of `worker` instances, or `worker --once` containers.
 */
export class LocalBackend implements RenderBackend {
  readonly id = 'local';
  readonly displayName = 'Local (the worker that claimed the job)';
  readonly kind = 'pool' as const;
  readonly implemented = true;
  readonly env: string[] = [];

  constructor(
    private readonly runner: (req: RenderRequest, ctx: BackendContext) => Promise<RenderOutcome>,
    /** Engine ids installed on this server (the registry's). */
    private readonly engines: () => string[] = () => [],
    /** Installed engines that render frame ranges (EngineCapabilities.frameRanges). */
    private readonly frameRangeEngines: () => string[] = () => []
  ) {}

  configured(): boolean {
    return true;
  }

  capabilities(): BackendCapabilities {
    // On the worker's own CPU; how many workers run (and whether the pool goes to zero) is the orchestrator's choice.
    // Frame ranges (render.fanOut: scenes+chunks) for the engines that declare them.
    return { engines: this.engines(), maxUnitSeconds: null, frameRanges: this.frameRangeEngines().length > 0, scaleToZero: false };
  }

  estimate(req: EstimateRequest): BackendEstimate {
    return {
      backend: this.id,
      ...estimateUnits(req),
      seconds: null,
      costUsd: 0,
      note: 'Renders on your own workers: no per-render charge. Render time depends on the machine and is not measured yet (#125); jobs wait while every worker slot is busy.',
    };
  }

  submit(req: RenderRequest, ctx: BackendContext): Promise<RenderOutcome> {
    return this.runner(req, ctx);
  }

  async cancel(): Promise<void> {
    // Cancellation is delivered through ctx.signal by the job runner.
  }
}
