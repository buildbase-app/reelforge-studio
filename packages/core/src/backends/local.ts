import type { BackendContext, RenderBackend, RenderOutcome, RenderRequest } from '../plugins';

/** Renders in this server process (the default). */
export class LocalBackend implements RenderBackend {
  readonly id = 'local';
  readonly displayName = 'Local (in-process)';
  readonly implemented = true;
  readonly env: string[] = [];

  constructor(private readonly runner: (req: RenderRequest, ctx: BackendContext) => Promise<RenderOutcome>) {}

  configured(): boolean {
    return true;
  }

  submit(req: RenderRequest, ctx: BackendContext): Promise<RenderOutcome> {
    return this.runner(req, ctx);
  }

  async cancel(): Promise<void> {
    // Cancellation is delivered through ctx.signal by the job runner.
  }
}
