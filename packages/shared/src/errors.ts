/**
 * Typed error codes used across TapeCI. Codes mirror the PRD §9.3 standard error body
 * and the deployment state machine's terminal states (PRD §6.2).
 */
export type TapeCiErrorCode =
  | "INVALID_PATH"
  | "INVALID_ARTIFACT"
  | "INVALID_CONFIG"
  | "BUILD_FAILED"
  | "FILE_TOO_LARGE"
  | "TOO_MANY_CHUNKS"
  | "CHAIN_MISMATCH"
  | "IMPLEMENTATION_CHANGED"
  | "NOT_CURRENT_OWNER"
  | "BUILD_NOT_ENABLEABLE"
  | "ATTEMPT_NOT_FOUND"
  | "TARGET_SHA_MISMATCH"
  | "BUILD_CONTEXT_MISMATCH"
  | "ATTEMPT_STATE_CONFLICT"
  | "PROJECT_DRAFT"
  | "BUILD_DISABLED"
  | "CONTAINER_NOT_OPEN"
  | "CONTAINER_NOT_TAPEOUT"
  // A failed chain read is not "not opened": the caller must be able to retry.
  | "CONTAINER_READ_UNAVAILABLE"
  | "BIND_PENDING"
  // Resource discovery (SPEC §7.2). Public reads never widen the private API.
  | "UNSUPPORTED_CHAIN"
  | "PREPARED_ARTIFACT_UNAVAILABLE"
  | "PROCESSOR_SUPPLY_EXHAUSTED"
  | "PROCESSOR_NOT_REGISTERED"
  | "RESOURCE_READ_UNAVAILABLE"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_TOKEN_ZERO_UNSUPPORTED"
  | "SOURCE_UNAVAILABLE"
  | "INVALID_CURSOR"
  | "INVALID_LIMIT"
  // Provisioning (SPEC §7.3, §9.1, §9.2). Present here so the contract is typed
  // rather than relying on `ApiError.code` being a bare string (issue P3-10).
  | "QUOTE_EXPIRED"
  | "QUOTE_CHANGED"
  | "QUOTE_REQUIRED"
  | "TRANSACTION_UNRESOLVED"
  | "TRANSACTION_MISMATCH"
  | "DELIVERY_UNVERIFIED"
  | "OWNER_REQUIRED"
  | "WALLET_MISMATCH"
  | "WRONG_CHAIN"
  | "RESOURCE_SNAPSHOT_MISMATCH"
  | "CONFIRMATION_POLICY_UNCONFIGURED"
  | "TASK_UNRESOLVED"
  | "TASK_NOT_FOUND"
  | "STEP_VERSION_CONFLICT"
  | "PATH_ACKNOWLEDGEMENT_REQUIRED"
  | "DRAFT_CHECKS_FAILED"
  | "DRAFT_CHECKS_UNKNOWN"
  | "DRAFT_CHANGED"
  | "ALREADY_OPENED"
  | "ACQUISITION_UNSUPPORTED"
  | "UNSUPPORTED_OPTION"
  | "ORG_ROLE_REQUIRED"
  | "ORG_OWNER_REQUIRED"
  | "ALREADY_LIVE"
  | "APPROVAL_POLICY_CAP"
  | "APPROVAL_POLICY_EXPIRY"
  | "APPROVAL_POLICY_ROLE"
  | "ARTIFACT_UNAVAILABLE"
  | "AUTH_REQUIRED"
  | "BIND_FAILED"
  | "BIND_REVERTED"
  | "BUDGET_EXCEEDED"
  | "CONTAINER_NOT_FOUND"
  | "DEPLOYMENT_NOT_FOUND"
  | "DRAFT_ALREADY_FINALIZED"
  | "DRAFT_NOT_FOUND"
  | "ERROR_CODE_REQUIRED"
  | "FORBIDDEN"
  | "GITHUB_APP_NOT_CONFIGURED"
  | "GITHUB_OAUTH_FAILED"
  | "GITHUB_OAUTH_NOT_CONFIGURED"
  | "IDEMPOTENCY_CONFLICT"
  | "INSTALLATION_NOT_FOUND"
  | "INTENT_REQUIRED"
  | "INVALID_ARCHIVED"
  | "INVALID_BODY"
  | "INVALID_BUDGET"
  | "INVALID_CHANNEL"
  | "INVALID_COMPARE"
  | "INVALID_IDEMPOTENCY_KEY"
  | "INVALID_INSTALLATION"
  | "INVALID_INSTALL_STATE"
  | "INVALID_JSON"
  | "INVALID_MONTHS"
  | "INVALID_NAME"
  | "INVALID_OAUTH_STATE"
  | "INVALID_OUTPUT_DIRECTORY"
  | "INVALID_POLICY"
  | "INVALID_PROJECT_ID"
  | "INVALID_QUERY"
  | "INVALID_SLUG"
  | "INVALID_STEP_TRANSITION"
  | "INVALID_WEBHOOK_SIGNATURE"
  | "LAST_OWNER"
  | "MEMBERSHIP_EXPIRED"
  | "MEMBER_NOT_FOUND"
  | "MISSING_HEADERS"
  | "NO_CHANNELS"
  | "OBJECT_STORE_NOT_CONFIGURED"
  | "OPEN_WOULD_REVERT"
  | "OPERATOR_UNAVAILABLE"
  | "ORGANIZATION_BUDGET_EXCEEDED"
  | "ORGANIZATION_FORBIDDEN"
  | "ORGANIZATION_NOT_FOUND"
  | "OWNER_REMOVAL"
  | "PLAN_NOT_READY"
  | "PROJECT_ARCHIVED"
  | "PROJECT_EXISTS"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ROLE_REQUIRED"
  | "QUOTE_NOT_APPLICABLE"
  | "QUOTE_NOT_FOUND"
  | "RELEASE_NOT_FOUND"
  | "REPOSITORY_NOT_AUTHORIZED"
  | "STEP_KIND_UNSUPPORTED"
  | "STEP_NOT_FOUND"
  | "STEP_ORDER_VIOLATION"
  | "TASK_CANCELED"
  | "TASK_COMPLETED"
  | "TRANSACTION_NOT_FOUND"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "USER_NOT_FOUND"
  | "VERIFICATION_NOT_READY"
  | "WALLET_VERIFICATION_REQUIRED"
  | "WEBHOOK_CONFIG_INVALID"
  | "UPLOAD_CONFLICT"
  | "UPLOAD_INTERRUPTED"
  | "PLAN_STALE"
  | "RECOVERY_REQUIRES_RESTART"
  | "RPC_DISAGREEMENT"
  | "VERIFICATION_FAILED"
  | "SWITCH_FAILED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_EXPIRED"
  | "AUTH_REVOKED"
  | "INSUFFICIENT_BALANCE"
  | "FEE_OVER_BUDGET"
  | "INTERNAL";

export interface TapeCiErrorOptions {
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class TapeCiError extends Error {
  readonly code: TapeCiErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: TapeCiErrorCode, message: string, options: TapeCiErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TapeCiError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export function isTapeCiError(value: unknown): value is TapeCiError {
  return value instanceof TapeCiError;
}

/** Convert any thrown value into the PRD §9.3 error-body shape. */
export function toErrorBody(error: unknown): {
  error: { code: string; message: string; retryable: boolean; details: Record<string, unknown> };
} {
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
  return {
    error: {
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      details: {},
    },
  };
}
