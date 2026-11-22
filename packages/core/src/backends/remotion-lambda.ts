import { ApiError } from '../errors';
import type { BackendCapabilities, BackendEstimate, EstimateRequest, RenderBackend } from '../plugins';
import { estimateUnits } from './estimate';

export const REMOTION_LAMBDA_ENV = ['REMOTION_LAMBDA_REGION', 'REMOTION_LAMBDA_FUNCTION_NAME', 'REMOTION_LAMBDA_SERVE_URL'] as const;

/**
 * Skeleton for rendering Remotion scenes on the operator's own Remotion
 * Lambda deployment. v0.1 implements only the configuration check so
 * capabilities are honest; submitting a render fails with a clear error.
 * Nothing is faked.
 */
export class RemotionLambdaBackend implements RenderBackend {
  readonly id = 'remotion-lambda';
  readonly displayName = 'Remotion Lambda (operator AWS account)';
  readonly kind = 'managed' as const;
  readonly implemented = false;
  readonly env = [...REMOTION_LAMBDA_ENV];

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  configured(): boolean {
    return REMOTION_LAMBDA_ENV.every((k) => Boolean(this.environment[k]));
  }

  missing(): string[] {
    return REMOTION_LAMBDA_ENV.filter((k) => !this.environment[k]);
  }

  /**
   * What the backend is designed to offer once it is implemented (#157); with
   * `implemented: false` nothing is rendered here. Remotion scenes only; Lambda
   * caps one invocation at 15 minutes (Remotion's Lambda docs, read 2026-11-22),
   * and Remotion Lambda splits a scene into frame ranges.
   */
  capabilities(): BackendCapabilities {
    return { engines: ['remotion'], maxUnitSeconds: 900, frameRanges: true, scaleToZero: true };
  }

  estimate(req: EstimateRequest): BackendEstimate {
    return {
      backend: this.id,
      ...estimateUnits(req),
      seconds: null,
      costUsd: null,
      note: 'Not implemented in this version: no render runs on Remotion Lambda and no estimate is made. Once built, it is billed by AWS (Lambda, S3) in your account plus Remotion\'s licence fee.',
    };
  }

  async submit(): Promise<never> {
    if (!this.configured()) {
      throw new ApiError('backend_not_configured', 409, `render backend "remotion-lambda" is not configured; set ${this.missing().join(', ')}`);
    }
    throw new ApiError(
      'not_implemented',
      501,
      'render backend "remotion-lambda" is not implemented in v0.1; use backend "local". The configuration check passed, but no render was started.'
    );
  }

  async cancel(): Promise<void> {}
}
