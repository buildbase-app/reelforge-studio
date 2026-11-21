/**
 * The one error type handlers throw. REST maps it to
 * `{ error: { code, message, details } }` with `status`; MCP returns the same
 * object as a tool error so agents can read `code` and fix their request.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) };
  }
}

export const notFound = (what: string, id: string, details?: unknown) =>
  new ApiError('not_found', 404, `${what} "${id}" not found`, details);
export const badRequest = (message: string, details?: unknown) => new ApiError('bad_request', 400, message, details);
export const conflict = (message: string, details?: unknown) => new ApiError('conflict', 409, message, details);
export const invalidManifest = (issues: unknown, message = 'the project manifest is invalid') =>
  new ApiError('invalid_manifest', 422, message, { issues });
