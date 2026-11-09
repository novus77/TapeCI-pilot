import { isGithubError } from "@tapeci/github";
import { TapeCiError, type TapeCiErrorCode } from "@tapeci/shared";

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: TapeCiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiError(
  statusCode: number,
  code: TapeCiErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ApiError {
  return new ApiError(statusCode, code, message, details);
}

const STATUS_BY_CODE: Partial<Record<TapeCiErrorCode, number>> = {
  INVALID_PATH: 422,
  INVALID_ARTIFACT: 422,
  INVALID_CONFIG: 422,
  FILE_TOO_LARGE: 413,
  TOO_MANY_CHUNKS: 422,
  CHAIN_MISMATCH: 409,
  IMPLEMENTATION_CHANGED: 409,
  NOT_CURRENT_OWNER: 409,
  CONTAINER_NOT_OPEN: 409,
  CONTAINER_NOT_TAPEOUT: 422,
  UPLOAD_CONFLICT: 409,
  UPLOAD_INTERRUPTED: 409,
  PLAN_STALE: 409,
  RPC_DISAGREEMENT: 409,
  VERIFICATION_FAILED: 422,
  SWITCH_FAILED: 409,
  APPROVAL_REQUIRED: 403,
  APPROVAL_EXPIRED: 403,
  INSUFFICIENT_BALANCE: 402,
  FEE_OVER_BUDGET: 402,
  BUILD_FAILED: 422,
  INTERNAL: 500,
};

const GITHUB_STATUS_BY_CODE: Readonly<Record<string, number>> = {
  SIGNATURE_INVALID: 401,
  MISSING_HEADERS: 400,
  INVALID_PAYLOAD: 422,
  UNSUPPORTED_EVENT: 422,
  UNSUPPORTED_REF: 422,
  PUSH_DELETED: 202,
  REPOSITORY_NOT_AUTHORIZED: 403,
  AUTH_REVOKED: 409,
  TAR_INVALID: 422,
  TAR_PATH_UNSAFE: 422,
  TAR_ENTRY_TYPE_FORBIDDEN: 422,
  TAR_LINK_FORBIDDEN: 422,
  TAR_SPECIAL_FILE_FORBIDDEN: 422,
  TAR_FILE_TOO_LARGE: 413,
  TAR_ARCHIVE_TOO_LARGE: 413,
  TAR_TOO_MANY_ENTRIES: 422,
  TAR_DUPLICATE_PATH: 422,
  OIDC_INVALID: 401,
  OIDC_INVALID_SIGNATURE: 401,
  OIDC_EXPIRED: 401,
  OIDC_INVALID_CLAIMS: 401,
  OIDC_MISMATCH: 401,
  BUILD_TOKEN_INVALID: 401,
  BUILD_TOKEN_EXPIRED: 401,
  BUILD_TOKEN_REPLAYED: 409,
  BUILD_TOKEN_NOT_FOUND: 401,
  BUILD_TOKEN_MISMATCH: 401,
  OBJECT_STORE_NOT_FOUND: 500,
  OBJECT_STORE_CONTENT_MISMATCH: 500,
  OBJECT_STORE_ERROR: 502,
  GITHUB_API_ERROR: 502,
  GITHUB_API_UNAUTHORIZED: 401,
  GITHUB_API_INVALID_RESPONSE: 502,
  GITHUB_INSTALLATION_NOT_FOUND: 404,
  GITHUB_APP_CONFIG_INVALID: 503,
  GITHUB_APP_KEY_INVALID: 503,
  GITHUB_APP_JWT_FAILED: 502,
};

export function httpStatusFor(error: unknown): number {
  if (error instanceof ApiError) return error.statusCode;
  if (error instanceof TapeCiError) return STATUS_BY_CODE[error.code] ?? 500;
  if (isGithubError(error)) return GITHUB_STATUS_BY_CODE[error.code] ?? 502;
  return 500;
}

export function errorEnvelope(error: unknown): {
  error: { code: string; message: string; retryable: boolean; details: Record<string, unknown> };
} {
  if (error instanceof ApiError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
    };
  }
  if (error instanceof TapeCiError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: { ...error.details },
      },
    };
  }
  if (isGithubError(error)) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: { ...error.details },
      },
    };
  }
  return {
    error: {
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      details: {},
    },
  };
}
