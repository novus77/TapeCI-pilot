/**
 * Typed errors for the GitHub App / webhook / OIDC / artifact-ingest boundary.
 *
 * Every failure that callers (Fastify routes, workers) are expected to handle is
 * reported as a `GithubError` with a stable `code`. Error messages and details
 * never include secrets: no App private key material, no App JWT, no installation
 * token, no webhook secret, no build-token signing secret.
 */
export type GitHubErrorCode =
  // GitHub App authentication (P2-02)
  | "GITHUB_APP_CONFIG_INVALID"
  | "GITHUB_APP_KEY_INVALID"
  | "GITHUB_APP_JWT_FAILED"
  | "GITHUB_API_UNAUTHORIZED"
  | "GITHUB_INSTALLATION_NOT_FOUND"
  | "GITHUB_API_ERROR"
  | "GITHUB_API_INVALID_RESPONSE"
  // Webhook delivery (P2-03)
  | "WEBHOOK_CONFIG_INVALID"
  | "SIGNATURE_INVALID"
  | "MISSING_HEADERS"
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_EVENT"
  | "UNSUPPORTED_REF"
  | "PUSH_DELETED"
  | "REPOSITORY_NOT_AUTHORIZED"
  | "AUTH_REVOKED"
  // GitHub Actions OIDC + one-time build tokens (P2-04)
  | "OIDC_INVALID"
  | "OIDC_INVALID_SIGNATURE"
  | "OIDC_EXPIRED"
  | "OIDC_INVALID_CLAIMS"
  | "OIDC_MISMATCH"
  | "BUILD_TOKEN_INVALID"
  | "BUILD_TOKEN_EXPIRED"
  | "BUILD_TOKEN_REPLAYED"
  | "BUILD_TOKEN_NOT_FOUND"
  | "BUILD_TOKEN_MISMATCH"
  // Artifact tar ingest + object store (P2-05)
  | "TAR_INVALID"
  | "TAR_PATH_UNSAFE"
  | "TAR_ENTRY_TYPE_FORBIDDEN"
  | "TAR_LINK_FORBIDDEN"
  | "TAR_SPECIAL_FILE_FORBIDDEN"
  | "TAR_FILE_TOO_LARGE"
  | "TAR_ARCHIVE_TOO_LARGE"
  | "TAR_TOO_MANY_ENTRIES"
  | "TAR_DUPLICATE_PATH"
  | "OBJECT_STORE_KEY_INVALID"
  | "OBJECT_STORE_NOT_FOUND"
  | "OBJECT_STORE_CONTENT_MISMATCH"
  | "OBJECT_STORE_ERROR";

export interface GitHubErrorOptions {
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class GithubError extends Error {
  readonly code: GitHubErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: GitHubErrorCode, message: string, options: GitHubErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "GithubError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export function isGithubError(value: unknown): value is GithubError {
  return value instanceof GithubError;
}
