import { parseCompressionGateways, type CompressionGatewayQualification } from "./worker/preparation-policy.js";

export interface ApiEnv {
  readonly compressionGateways?: readonly CompressionGatewayQualification[];
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly port: number;
  readonly host: string;
  readonly sessionSecret: string;
  readonly devAuth: boolean;
  readonly objectStoreDir: string;
  readonly artifactMaxBytes: number;
  readonly artifactTokenTtlSeconds: number;
  readonly githubAppId: string | null;
  readonly githubAppPrivateKey: string | null;
  readonly githubWebhookSecret: string | null;
  readonly githubOidcAudience: string;
  readonly githubOidcIssuer: string;
  /** Optional local/test JWKS URL (defaults to GitHub's remote JWKS). */
  readonly githubOidcJwksUrl?: string | null;
  /** GitHub App OAuth + install flow. */
  readonly githubAppSlug: string | null;
  readonly githubOAuthClientId: string | null;
  readonly githubOAuthClientSecret: string | null;
  readonly githubOAuthBaseUrl: string;
  readonly githubApiBaseUrl: string;
  readonly publicApiUrl: string;
  readonly webUrl: string;
  readonly sessionTtlSeconds: number;
  /** Optional parent cookie domain for split API/console hosts. */
  readonly cookieDomain?: string | null;
  /** Hard gas-price ceiling (wei) for plan/deploy; null disables the guard. */
  readonly maxGasPriceWei?: bigint | null;
  /** Worker health/metrics HTTP endpoint. */
  readonly workerPort?: number;
  readonly workerHost?: string;
  /** Object storage: local filesystem or S3-compatible (AWS/R2/MinIO). */
  readonly objectStoreKind?: "local" | "s3";
  readonly s3Bucket?: string | null;
  readonly s3Region?: string | null;
  readonly s3Endpoint?: string | null;
  readonly s3AccessKeyId?: string | null;
  readonly s3SecretAccessKey?: string | null;
  readonly s3Prefix?: string | null;
  readonly s3ForcePathStyle?: boolean;
  /** Installation reconciler (worker timer / CLI). */
  readonly reconcileEnabled?: boolean;
  readonly reconcileIntervalSeconds?: number;
  /**
   * How often the provisioning sweep re-verifies `submitted` attempts (SPEC §9.2).
   * `0` disables it. It exists because a payment that mines while nobody is watching
   * would otherwise stay unverified until a user pressed "check again" (P7-03).
   */
  readonly provisioningSweepIntervalMs?: number;
  /** Optional bearer token for /metrics; empty means no auth (loopback/sidecar). */
  readonly metricsToken?: string | null;
  /** Fixed-window public API rate limit. */
  readonly rateLimitPerMinute?: number;
  readonly rateLimitDisabled?: boolean;
  readonly rateLimitBackend?: "memory" | "redis";
  /** Structured mutation audit log (stdout). */
  readonly auditDisabled?: boolean;
  /** Fastify trustProxy: true / hop count; needed behind a reverse proxy. */
  readonly trustProxy?: boolean | string;
  /** GitHub logins allowed to read the global audit log (comma separated env). */
  readonly adminLogins?: readonly string[];
  /** SMTP connection URL for email notification channels (e.g. smtp://user:pass@host:587). */
  readonly auditBackfillIntervalMs?: number;
  readonly smtpUrl?: string | null;
  readonly smtpFrom?: string | null;
  /** P2-06 worker: signer key and write RPC (never logged). */
  readonly operatorPrivateKey: string | null;
  readonly writeRpcUrl: string | null;
  /**
   * Confirmation depth required before a paid provisioning transaction may be
   * reported as `confirmed` (SPEC §9.2: the policy "必须显式配置").
   *
   * Accepts an explicit depth in blocks, or `"finalized"` to require the chain's
   * own finalized tag — a consensus definition rather than a number we picked
   * (X Layer 196 supports it; measured to trail head by ~1,500 blocks).
   *
   * Deliberately nullable with NO default: §9.2 forbids guessing a safe depth, so
   * when this is null the verifier records the receipt facts and stops at
   * `unverified/CONFIRMATION_POLICY_UNCONFIGURED` instead of confirming.
   */
  readonly provisioningConfirmations?: number | "finalized" | null;
  readonly journalDir: string;
}

function parseWeiEnv(value: string, name: string): bigint {
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new Error(`${name} must be a decimal wei amount`);
  }
  return BigInt(value.trim());
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid integer environment value: ${value}`);
  }
  return parsed;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is required");
  }
  const secret = env.SESSION_SIGNING_SECRET;
  if (secret === undefined || secret.length < 16) {
    throw new Error("SESSION_SIGNING_SECRET must be at least 16 characters");
  }
  return {
    databaseUrl,
    compressionGateways: parseCompressionGateways(env.TAPECI_COMPRESSION_GATEWAYS_JSON),
    redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:56379",
    port: integer(env.TAPECI_API_PORT, 8787),
    host: env.TAPECI_API_HOST ?? "127.0.0.1",
    sessionSecret: secret,
    devAuth: env.TAPECI_DEV_AUTH === "1",
    objectStoreDir: env.OBJECT_STORE_DIR ?? ".tapeci/objects",
    artifactMaxBytes: integer(env.TAPECI_ARTIFACT_MAX_BYTES, 64 * 1024 * 1024),
    artifactTokenTtlSeconds: integer(env.TAPECI_ARTIFACT_TOKEN_TTL_SECONDS, 900),
    githubAppId: env.GITHUB_APP_ID === undefined || env.GITHUB_APP_ID === "" ? null : env.GITHUB_APP_ID,
    githubAppPrivateKey:
      env.GITHUB_APP_PRIVATE_KEY === undefined || env.GITHUB_APP_PRIVATE_KEY === ""
        ? null
        : env.GITHUB_APP_PRIVATE_KEY,
    githubWebhookSecret:
      env.GITHUB_WEBHOOK_SECRET === undefined || env.GITHUB_WEBHOOK_SECRET === ""
        ? null
        : env.GITHUB_WEBHOOK_SECRET,
    githubOidcAudience: env.GITHUB_OIDC_AUDIENCE ?? "tapeci-artifact-upload",
    githubOidcIssuer: env.GITHUB_OIDC_ISSUER ?? "https://token.actions.githubusercontent.com",
    githubOidcJwksUrl:
      env.GITHUB_OIDC_JWKS_URL === undefined || env.GITHUB_OIDC_JWKS_URL === ""
        ? null
        : env.GITHUB_OIDC_JWKS_URL,
    githubAppSlug:
      env.GITHUB_APP_SLUG === undefined || env.GITHUB_APP_SLUG === "" ? null : env.GITHUB_APP_SLUG,
    githubOAuthClientId:
      env.GITHUB_OAUTH_CLIENT_ID === undefined || env.GITHUB_OAUTH_CLIENT_ID === ""
        ? null
        : env.GITHUB_OAUTH_CLIENT_ID,
    githubOAuthClientSecret:
      env.GITHUB_OAUTH_CLIENT_SECRET === undefined || env.GITHUB_OAUTH_CLIENT_SECRET === ""
        ? null
        : env.GITHUB_OAUTH_CLIENT_SECRET,
    githubOAuthBaseUrl: (env.GITHUB_OAUTH_BASE_URL ?? "https://github.com").replace(/\/+$/, ""),
    githubApiBaseUrl: (env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    publicApiUrl: (env.TAPECI_PUBLIC_API_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, ""),
    webUrl: (env.TAPECI_WEB_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
    sessionTtlSeconds: integer(env.SESSION_TTL_SECONDS, 7 * 24 * 60 * 60),
    ...(env.NODE_ENV === "production" && env.TAPECI_DEV_AUTH === "1"
      ? (() => {
          throw new Error("TAPECI_DEV_AUTH must not be enabled when NODE_ENV=production");
        })()
      : {}),
    cookieDomain:
      env.SESSION_COOKIE_DOMAIN === undefined || env.SESSION_COOKIE_DOMAIN === ""
        ? null
        : env.SESSION_COOKIE_DOMAIN,
    maxGasPriceWei:
      env.TAPECI_MAX_GAS_PRICE_WEI === undefined || env.TAPECI_MAX_GAS_PRICE_WEI === ""
        ? null
        : parseWeiEnv(env.TAPECI_MAX_GAS_PRICE_WEI, "TAPECI_MAX_GAS_PRICE_WEI"),
    workerPort: integer(env.TAPECI_WORKER_PORT, 8788),
    workerHost: env.TAPECI_WORKER_HOST ?? "127.0.0.1",
    objectStoreKind: env.TAPECI_OBJECT_STORE === "s3" ? "s3" : "local",
    s3Bucket: env.S3_BUCKET ?? null,
    s3Region: env.S3_REGION ?? null,
    s3Endpoint: env.S3_ENDPOINT ?? null,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID ?? null,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY ?? null,
    s3Prefix: env.S3_PREFIX ?? null,
    ...(env.S3_FORCE_PATH_STYLE === undefined
      ? {}
      : { s3ForcePathStyle: env.S3_FORCE_PATH_STYLE !== "false" }),
    reconcileEnabled: env.TAPECI_RECONCILE_ENABLED !== "0",
    reconcileIntervalSeconds: integer(env.TAPECI_RECONCILE_INTERVAL_SECONDS, 900),
    provisioningSweepIntervalMs:
      env.TAPECI_PROVISIONING_SWEEP_INTERVAL_MS === undefined ||
      env.TAPECI_PROVISIONING_SWEEP_INTERVAL_MS === ""
        ? 60_000
        : integer(env.TAPECI_PROVISIONING_SWEEP_INTERVAL_MS, 0),
    metricsToken:
      env.TAPECI_METRICS_TOKEN === undefined || env.TAPECI_METRICS_TOKEN === ""
        ? null
        : env.TAPECI_METRICS_TOKEN,
    rateLimitPerMinute: integer(env.TAPECI_RATE_LIMIT_PER_MINUTE, 600),
    rateLimitDisabled: env.TAPECI_RATE_LIMIT_DISABLED === "1",
    rateLimitBackend: env.TAPECI_RATE_LIMIT_BACKEND === "redis" ? "redis" : "memory",
    auditDisabled: env.TAPECI_AUDIT_LOG === "0",
    auditBackfillIntervalMs:
      env.TAPECI_AUDIT_BACKFILL_INTERVAL_MS === undefined || env.TAPECI_AUDIT_BACKFILL_INTERVAL_MS === ""
        ? 0
        : Math.max(60_000, integer(env.TAPECI_AUDIT_BACKFILL_INTERVAL_MS, 0)),
    smtpUrl: env.SMTP_URL === undefined || env.SMTP_URL === "" ? null : env.SMTP_URL,
    smtpFrom: env.SMTP_FROM === undefined || env.SMTP_FROM === "" ? null : env.SMTP_FROM,
    adminLogins: (env.TAPECI_ADMIN_LOGINS ?? "")
      .split(",")
      .map((login) => login.trim().toLowerCase())
      .filter((login) => login.length > 0),
    trustProxy:
      env.TAPECI_TRUST_PROXY === undefined || env.TAPECI_TRUST_PROXY === ""
        ? false
        : env.TAPECI_TRUST_PROXY === "true" || env.TAPECI_TRUST_PROXY === "1"
          ? true
          : String(integer(env.TAPECI_TRUST_PROXY, 0)),
    operatorPrivateKey:
      env.TAPECI_OPERATOR_PRIVATE_KEY === undefined || env.TAPECI_OPERATOR_PRIVATE_KEY === ""
        ? null
        : env.TAPECI_OPERATOR_PRIVATE_KEY,
    writeRpcUrl:
      env.TAPECI_WRITE_RPC_URL === undefined || env.TAPECI_WRITE_RPC_URL === ""
        ? null
        : env.TAPECI_WRITE_RPC_URL,
    provisioningConfirmations:
      env.TAPECI_PROVISIONING_CONFIRMATIONS === undefined ||
      env.TAPECI_PROVISIONING_CONFIRMATIONS === ""
        ? null
        : env.TAPECI_PROVISIONING_CONFIRMATIONS.trim().toLowerCase() === "finalized"
          ? ("finalized" as const)
          : integer(env.TAPECI_PROVISIONING_CONFIRMATIONS, 0),
    journalDir: env.TAPECI_JOURNAL_DIR ?? ".tapeci/journal",
  };
}
