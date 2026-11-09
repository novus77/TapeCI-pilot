/** Error body from docs/P2_API.md: `{ error: { code, message, retryable, details }, requestId }`. */

export interface ApiErrorOptions {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(message: string, options: ApiErrorOptions) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse an API error response body without trusting any field shape. */
export function apiErrorFromBody(
  status: number,
  body: unknown,
  fallbackRequestId: string | null,
): ApiError {
  if (isRecord(body) && isRecord(body["error"])) {
    const error = body["error"];
    const code = typeof error["code"] === "string" ? error["code"] : `HTTP_${status}`;
    const message =
      typeof error["message"] === "string" ? error["message"] : `Request failed with ${status}.`;
    const retryable = error["retryable"] === true;
    const requestId =
      typeof body["requestId"] === "string" ? body["requestId"] : fallbackRequestId;
    return new ApiError(message, {
      status,
      code,
      retryable,
      requestId,
      details: error["details"],
    });
  }
  return new ApiError(`Request failed with status ${status}.`, {
    status,
    code: `HTTP_${status}`,
    retryable: status >= 500,
    requestId: fallbackRequestId,
  });
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Operator-facing message. Never includes secrets or raw stack traces. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const suffix = error.requestId === null ? "" : ` (request ${error.requestId})`;
    return `${error.code}: ${error.message}${suffix}`;
  }
  if (error instanceof Error) return error.message;
  return "Unexpected error.";
}
