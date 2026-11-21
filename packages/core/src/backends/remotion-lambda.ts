import { ApiError } from '../errors';
import type { RenderBackend } from '../plugins';

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
  readonly implemented = false;
  readonly env = [...REMOTION_LAMBDA_ENV];

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  configured(): boolean {
    return REMOTION_LAMBDA_ENV.every((k) => Boolean(this.environment[k]));
  }

  missing(): string[] {
    return REMOTION_LAMBDA_ENV.filter((k) => !this.environment[k]);
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
