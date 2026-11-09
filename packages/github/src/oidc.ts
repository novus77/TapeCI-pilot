/**
 * P2-04: GitHub Actions OIDC + one-time build tokens.
 *
 * 1. `verifyGitHubOidc` verifies the `Authorization: Bearer <oidc jwt>` token
 *    minted by GitHub Actions against GitHub's JWKS. Issuer, audience,
 *    `exp`/`nbf`, and the claims TapeCI relies on (`repository_id`, `ref`,
 *    `sha`, `workflow_ref`, `repository_owner_id`) are all required. The JWKS
 *    resolver is injectable so tests never touch the network.
 * 2. `issueBuildToken` / `verifyBuildToken` mint and verify a short-lived HS256
 *    JWT bound to one deployment (`SESSION_SIGNING_SECRET`).
 * 3. `consumeBuildToken` atomically burns the matching `build_tokens` row
 *    (`UPDATE … WHERE consumed_at IS NULL RETURNING`), so a replayed token is
 *    rejected even under concurrency. `verifyAndConsumeBuildToken` composes 2+3.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  SignJWT,
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { buildTokens, type Database } from "@tapeci/database";
import { GithubError } from "./errors.js";

export const GITHUB_OIDC_DEFAULT_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_DEFAULT_JWKS_URL =
  "https://token.actions.githubusercontent.com/.well-known/jwks";
/** Build tokens are signed by TapeCI itself (HS256), not by GitHub. */
export const BUILD_TOKEN_ISSUER = "tapeci";
export const BUILD_TOKEN_AUDIENCE = "tapeci-build";
export const DEFAULT_BUILD_TOKEN_TTL_SECONDS = 15 * 60;

const HEX40_RE = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Optional binding checks against the deployment being built. */
export interface ExpectedGithubOidcClaims {
  readonly repositoryId?: number;
  readonly repositoryOwnerId?: number;
  readonly ref?: string;
  readonly sha?: string;
}

export interface VerifyGithubOidcOptions {
  /** `GITHUB_OIDC_AUDIENCE` (e.g. `tapeci-artifact-upload`). */
  readonly audience: string;
  /** Defaults to `https://token.actions.githubusercontent.com`. */
  readonly issuer?: string;
  /** Defaults to GitHub's public JWKS URL. Ignored when `jwks` is provided. */
  readonly jwksUrl?: string;
  /** Injectable JWKS resolver (tests use `createLocalJWKSet`). */
  readonly jwks?: JWTVerifyGetKey;
  readonly clockToleranceSeconds?: number;
  readonly expected?: ExpectedGithubOidcClaims;
}

export interface GithubOidcClaims {
  readonly issuer: string;
  readonly audience: readonly string[];
  readonly subject?: string;
  readonly repository: string;
  /** `repository_id` claim, normalized to a number (GitHub sends a string). */
  readonly repositoryId: number;
  /** `repository_owner_id` claim, normalized to a number. */
  readonly repositoryOwnerId: number;
  readonly repositoryOwner: string;
  readonly ref: string;
  readonly sha: string;
  readonly workflowRef: string;
  readonly workflowSha?: string;
  readonly eventName?: string;
  readonly runId?: string;
  readonly jobWorkflowRef?: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly jti?: string;
  /** Raw JWT claims (public data; never contains the token itself). */
  readonly claims: Readonly<Record<string, unknown>>;
}

function toJoseError(error: unknown): GithubError {
  if (error instanceof GithubError) return error;
  if (error instanceof errors.JWTExpired) {
    return new GithubError("OIDC_EXPIRED", "GitHub OIDC token has expired", {
      cause: error,
      details: { claim: error.claim },
    });
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    return new GithubError(
      "OIDC_INVALID_CLAIMS",
      `GitHub OIDC token claim validation failed: ${error.claim} (${error.reason})`,
      { cause: error, details: { claim: error.claim, reason: error.reason } },
    );
  }
  if (
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys
  ) {
    return new GithubError("OIDC_INVALID_SIGNATURE", "GitHub OIDC token signature is invalid", {
      cause: error,
    });
  }
  return new GithubError("OIDC_INVALID", "GitHub OIDC token verification failed", {
    cause: error,
  });
}

function stringClaim(claims: JWTPayload, claim: string): string {
  const value = claims[claim];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GithubError("OIDC_INVALID_CLAIMS", `GitHub OIDC token is missing claim ${claim}`, {
      details: { claim },
    });
  }
  return value;
}

function optionalStringClaim(claims: JWTPayload, claim: string): string | undefined {
  const value = claims[claim];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numericIdClaim(claims: JWTPayload, claim: string): number {
  const value = claims[claim];
  const raw =
    typeof value === "number" ? String(value) : typeof value === "string" ? value : undefined;
  if (raw === undefined || !/^[1-9][0-9]{0,19}$/.test(raw)) {
    throw new GithubError("OIDC_INVALID_CLAIMS", `GitHub OIDC token has an invalid ${claim} claim`, {
      details: { claim },
    });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new GithubError("OIDC_INVALID_CLAIMS", `GitHub OIDC token ${claim} is out of range`, {
      details: { claim },
    });
  }
  return parsed;
}

function numericDateClaim(claims: JWTPayload, claim: string): number {
  const value = claims[claim];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GithubError("OIDC_INVALID_CLAIMS", `GitHub OIDC token is missing claim ${claim}`, {
      details: { claim },
    });
  }
  return value;
}

function audienceOf(claims: JWTPayload): readonly string[] {
  const aud = claims.aud;
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud) && aud.every((entry) => typeof entry === "string")) {
    return [...(aud as string[])];
  }
  throw new GithubError("OIDC_INVALID_CLAIMS", "GitHub OIDC token has an invalid aud claim", {
    details: { claim: "aud" },
  });
}

function assertExpected(
  actual: { readonly repositoryId: number; readonly repositoryOwnerId: number; readonly ref: string; readonly sha: string },
  expected: ExpectedGithubOidcClaims | undefined,
): void {
  if (expected === undefined) return;
  const mismatches: string[] = [];
  if (expected.repositoryId !== undefined && expected.repositoryId !== actual.repositoryId) {
    mismatches.push("repository_id");
  }
  if (
    expected.repositoryOwnerId !== undefined &&
    expected.repositoryOwnerId !== actual.repositoryOwnerId
  ) {
    mismatches.push("repository_owner_id");
  }
  if (expected.ref !== undefined && expected.ref !== actual.ref) mismatches.push("ref");
  if (expected.sha !== undefined && expected.sha !== actual.sha) mismatches.push("sha");
  if (mismatches.length > 0) {
    throw new GithubError(
      "OIDC_MISMATCH",
      `GitHub OIDC token does not match the expected build context: ${mismatches.join(", ")}`,
      { details: { mismatchedClaims: mismatches } },
    );
  }
}

/**
 * Verify a GitHub Actions OIDC token. The default JWKS resolver fetches GitHub's
 * public keys lazily; tests inject a local JWKS so no network is used.
 */
export async function verifyGitHubOidc(
  token: string,
  options: VerifyGithubOidcOptions,
): Promise<GithubOidcClaims> {
  if (typeof token !== "string" || token.length === 0) {
    throw new GithubError("OIDC_INVALID", "GitHub OIDC bearer token is missing");
  }
  if (options.audience.length === 0) {
    throw new GithubError("OIDC_INVALID", "GitHub OIDC audience is required");
  }
  const issuer = options.issuer ?? GITHUB_OIDC_DEFAULT_ISSUER;
  const jwks =
    options.jwks ??
    createRemoteJWKSet(new URL(options.jwksUrl ?? GITHUB_OIDC_DEFAULT_JWKS_URL));
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, jwks, {
      issuer,
      audience: options.audience,
      algorithms: ["RS256"],
      requiredClaims: [
        "exp",
        "iat",
        "nbf",
        "repository_id",
        "repository_owner_id",
        "ref",
        "sha",
        "workflow_ref",
      ],
      ...(options.clockToleranceSeconds === undefined
        ? {}
        : { clockTolerance: options.clockToleranceSeconds }),
    });
    payload = verified.payload;
  } catch (error) {
    throw toJoseError(error);
  }

  const ref = stringClaim(payload, "ref");
  if (!ref.startsWith("refs/")) {
    throw new GithubError("OIDC_INVALID_CLAIMS", "GitHub OIDC ref must start with refs/", {
      details: { claim: "ref" },
    });
  }
  const sha = stringClaim(payload, "sha");
  if (!HEX40_RE.test(sha)) {
    throw new GithubError("OIDC_INVALID_CLAIMS", "GitHub OIDC sha must be a 40-character commit sha", {
      details: { claim: "sha" },
    });
  }
  const claims: GithubOidcClaims = {
    issuer: stringClaim(payload, "iss"),
    audience: audienceOf(payload),
    repository: stringClaim(payload, "repository"),
    repositoryId: numericIdClaim(payload, "repository_id"),
    repositoryOwnerId: numericIdClaim(payload, "repository_owner_id"),
    repositoryOwner: stringClaim(payload, "repository_owner"),
    ref,
    sha,
    workflowRef: stringClaim(payload, "workflow_ref"),
    issuedAt: numericDateClaim(payload, "iat"),
    notBefore: numericDateClaim(payload, "nbf"),
    expiresAt: numericDateClaim(payload, "exp"),
    claims: { ...payload },
    ...optionalProperties({
      subject: optionalStringClaim(payload, "sub"),
      workflowSha: optionalStringClaim(payload, "workflow_sha"),
      eventName: optionalStringClaim(payload, "event_name"),
      runId: optionalStringClaim(payload, "run_id"),
      jobWorkflowRef: optionalStringClaim(payload, "job_workflow_ref"),
      jti: optionalStringClaim(payload, "jti"),
    }),
  };
  assertExpected(claims, options.expected);
  return claims;
}

/** Spread only present optional values (TS `exactOptionalPropertyTypes` friendly). */
interface OptionalClaimValues {
  readonly subject?: string | undefined;
  readonly workflowSha?: string | undefined;
  readonly eventName?: string | undefined;
  readonly runId?: string | undefined;
  readonly jobWorkflowRef?: string | undefined;
  readonly jti?: string | undefined;
}

function optionalProperties(
  values: OptionalClaimValues,
): {
  subject?: string;
  workflowSha?: string;
  eventName?: string;
  runId?: string;
  jobWorkflowRef?: string;
  jti?: string;
} {
  const out: {
    subject?: string;
    workflowSha?: string;
    eventName?: string;
    runId?: string;
    jobWorkflowRef?: string;
    jti?: string;
  } = {};
  if (values.subject !== undefined) out.subject = values.subject;
  if (values.workflowSha !== undefined) out.workflowSha = values.workflowSha;
  if (values.eventName !== undefined) out.eventName = values.eventName;
  if (values.runId !== undefined) out.runId = values.runId;
  if (values.jobWorkflowRef !== undefined) out.jobWorkflowRef = values.jobWorkflowRef;
  if (values.jti !== undefined) out.jti = values.jti;
  return out;
}

// ---------------------------------------------------------------------------
// One-time build tokens (HS256)
// ---------------------------------------------------------------------------

export interface BuildTokenClaims {
  readonly jti: string;
  readonly deploymentId: string;
  readonly repositoryId: number;
  readonly commitSha: string;
  readonly ref: string;
  /** Epoch seconds. */
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface IssueBuildTokenOptions {
  readonly deploymentId: string;
  readonly repositoryId: number;
  readonly commitSha: string;
  readonly ref: string;
  /** `SESSION_SIGNING_SECRET`. */
  readonly secret: string;
  readonly ttlSeconds?: number;
  readonly now?: () => Date;
  readonly jti?: string;
}

export interface IssuedBuildToken {
  readonly token: string;
  readonly jti: string;
  readonly expiresAt: Date;
  readonly claims: BuildTokenClaims;
}

export interface VerifyBuildTokenOptions {
  readonly token: string;
  /** `SESSION_SIGNING_SECRET`. */
  readonly secret: string;
  readonly now?: Date;
  readonly clockToleranceSeconds?: number;
}

export interface ConsumeBuildTokenOptions {
  readonly now?: Date;
}

export interface VerifiedBuildToken {
  readonly jti: string;
  readonly deploymentId: string;
  readonly repositoryId: number;
  readonly commitSha: string;
  readonly ref: string;
  readonly expiresAt: Date;
}

export interface ConsumedBuildToken extends VerifiedBuildToken {
  readonly consumedAt: Date;
}

function encodeSecret(secret: string): Uint8Array {
  if (secret.length === 0) {
    throw new GithubError("BUILD_TOKEN_INVALID", "build token signing secret is required");
  }
  return new TextEncoder().encode(secret);
}

function validateBuildClaims(claims: JWTPayload): BuildTokenClaims {
  try {
    return validateBuildClaimsUnchecked(claims);
  } catch (error) {
    if (error instanceof GithubError && error.code.startsWith("OIDC_")) {
      throw new GithubError(
        "BUILD_TOKEN_INVALID",
        `build token claim validation failed: ${error.message}`,
        { cause: error, details: error.details },
      );
    }
    throw error;
  }
}

function validateBuildClaimsUnchecked(claims: JWTPayload): BuildTokenClaims {
  const jti = stringClaim(claims, "jti");
  if (!UUID_RE.test(jti)) {
    throw new GithubError("BUILD_TOKEN_INVALID", "build token jti must be a UUID", {
      details: { claim: "jti" },
    });
  }
  const deploymentId = stringClaim(claims, "deploymentId");
  if (!UUID_RE.test(deploymentId)) {
    throw new GithubError("BUILD_TOKEN_INVALID", "build token deploymentId must be a UUID", {
      details: { claim: "deploymentId" },
    });
  }
  const repositoryId = numericIdClaim(claims, "repositoryId");
  const commitSha = stringClaim(claims, "commitSha");
  if (!HEX40_RE.test(commitSha)) {
    throw new GithubError(
      "BUILD_TOKEN_INVALID",
      "build token commitSha must be a 40-character commit sha",
      { details: { claim: "commitSha" } },
    );
  }
  const ref = stringClaim(claims, "ref");
  if (!ref.startsWith("refs/")) {
    throw new GithubError("BUILD_TOKEN_INVALID", "build token ref must start with refs/", {
      details: { claim: "ref" },
    });
  }
  return {
    jti,
    deploymentId,
    repositoryId,
    commitSha,
    ref,
    issuedAt: numericDateClaim(claims, "iat"),
    expiresAt: numericDateClaim(claims, "exp"),
  };
}

/** Mint a one-time, deployment-scoped build token (HS256). */
export async function issueBuildToken(options: IssueBuildTokenOptions): Promise<IssuedBuildToken> {
  const secretBytes = encodeSecret(options.secret);
  const deploymentId = options.deploymentId;
  if (!UUID_RE.test(deploymentId)) {
    throw new GithubError("BUILD_TOKEN_INVALID", "deploymentId must be a UUID");
  }
  if (!Number.isSafeInteger(options.repositoryId) || options.repositoryId <= 0) {
    throw new GithubError("BUILD_TOKEN_INVALID", "repositoryId must be a positive integer");
  }
  if (!HEX40_RE.test(options.commitSha)) {
    throw new GithubError("BUILD_TOKEN_INVALID", "commitSha must be a 40-character commit sha");
  }
  if (!options.ref.startsWith("refs/")) {
    throw new GithubError("BUILD_TOKEN_INVALID", "ref must start with refs/");
  }
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_BUILD_TOKEN_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 86_400) {
    throw new GithubError("BUILD_TOKEN_INVALID", "ttlSeconds must be between 1 and 86400");
  }
  const now = options.now?.() ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const jti = options.jti ?? randomUUID();
  if (!UUID_RE.test(jti)) {
    throw new GithubError("BUILD_TOKEN_INVALID", "jti must be a UUID");
  }
  const token = await new SignJWT({
    deploymentId,
    repositoryId: options.repositoryId,
    commitSha: options.commitSha,
    ref: options.ref,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(BUILD_TOKEN_ISSUER)
    .setAudience(BUILD_TOKEN_AUDIENCE)
    .setSubject(deploymentId)
    .setJti(jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(secretBytes);
  return {
    token,
    jti,
    expiresAt: new Date(expiresAt * 1000),
    claims: {
      jti,
      deploymentId,
      repositoryId: options.repositoryId,
      commitSha: options.commitSha,
      ref: options.ref,
      issuedAt,
      expiresAt,
    },
  };
}

/** Verify signature + claims of a build token (does not consume it). */
export async function verifyBuildToken(
  options: VerifyBuildTokenOptions,
): Promise<VerifiedBuildToken> {
  const secretBytes = encodeSecret(options.secret);
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(options.token, secretBytes, {
      algorithms: ["HS256"],
      issuer: BUILD_TOKEN_ISSUER,
      audience: BUILD_TOKEN_AUDIENCE,
      requiredClaims: ["jti", "exp", "iat", "deploymentId", "repositoryId", "commitSha", "ref"],
      ...(options.now === undefined ? {} : { currentDate: options.now }),
      ...(options.clockToleranceSeconds === undefined
        ? {}
        : { clockTolerance: options.clockToleranceSeconds }),
    });
    payload = verified.payload;
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      throw new GithubError("BUILD_TOKEN_EXPIRED", "build token has expired", { cause: error });
    }
    throw new GithubError("BUILD_TOKEN_INVALID", "build token is invalid", { cause: error });
  }
  const claims = validateBuildClaims(payload);
  return {
    jti: claims.jti,
    deploymentId: claims.deploymentId,
    repositoryId: claims.repositoryId,
    commitSha: claims.commitSha,
    ref: claims.ref,
    expiresAt: new Date(claims.expiresAt * 1000),
  };
}

function mapRowToConsumed(row: {
  readonly jti: string;
  readonly deploymentId: string;
  readonly repositoryId: number;
  readonly commitSha: string;
  readonly ref: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}): ConsumedBuildToken {
  if (row.consumedAt === null) {
    throw new GithubError("BUILD_TOKEN_INVALID", "build token row is not consumed");
  }
  return {
    jti: row.jti,
    deploymentId: row.deploymentId,
    repositoryId: row.repositoryId,
    commitSha: row.commitSha,
    ref: row.ref,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

/**
 * Atomically consume a one-time build token row. The `UPDATE … WHERE
 * consumed_at IS NULL AND expires_at > now RETURNING` makes replay and expiry
 * rejection race-free even with concurrent requests.
 */
export async function consumeBuildToken(
  db: Database,
  jti: string,
  options: ConsumeBuildTokenOptions = {},
): Promise<ConsumedBuildToken> {
  if (!UUID_RE.test(jti)) {
    throw new GithubError("BUILD_TOKEN_INVALID", "build token jti must be a UUID");
  }
  const now = options.now ?? new Date();
  const [consumed] = await db
    .update(buildTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(buildTokens.jti, jti),
        isNull(buildTokens.consumedAt),
        gt(buildTokens.expiresAt, now),
      ),
    )
    .returning();
  if (consumed !== undefined) return mapRowToConsumed(consumed);

  const [existing] = await db.select().from(buildTokens).where(eq(buildTokens.jti, jti)).limit(1);
  if (existing === undefined) {
    throw new GithubError("BUILD_TOKEN_NOT_FOUND", "build token was not issued");
  }
  if (existing.consumedAt !== null) {
    throw new GithubError("BUILD_TOKEN_REPLAYED", "build token has already been consumed");
  }
  throw new GithubError("BUILD_TOKEN_EXPIRED", "build token has expired");
}

/**
 * Persist the `build_tokens` row for a freshly issued token. Idempotent on
 * `jti` so a retried issue request cannot resurrect a consumed token.
 */
export async function registerBuildToken(
  db: Database,
  claims: BuildTokenClaims,
): Promise<void> {
  await db
    .insert(buildTokens)
    .values({
      jti: claims.jti,
      deploymentId: claims.deploymentId,
      repositoryId: claims.repositoryId,
      commitSha: claims.commitSha,
      ref: claims.ref,
      expiresAt: new Date(claims.expiresAt * 1000),
    })
    .onConflictDoNothing({ target: buildTokens.jti });
}

/**
 * Verify a build token, check it is bound to the same deployment context, then
 * consume it. This is the helper the artifact-upload route should call.
 */
export async function verifyAndConsumeBuildToken(
  db: Database,
  token: string,
  secret: string,
  options: ConsumeBuildTokenOptions = {},
): Promise<ConsumedBuildToken> {
  const verified = await verifyBuildToken({
    token,
    secret,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const [existing] = await db
    .select()
    .from(buildTokens)
    .where(eq(buildTokens.jti, verified.jti))
    .limit(1);
  if (existing === undefined) {
    throw new GithubError("BUILD_TOKEN_NOT_FOUND", "build token was not issued");
  }
  const mismatches: string[] = [];
  if (existing.deploymentId !== verified.deploymentId) mismatches.push("deploymentId");
  if (existing.repositoryId !== verified.repositoryId) mismatches.push("repositoryId");
  if (existing.commitSha !== verified.commitSha) mismatches.push("commitSha");
  if (existing.ref !== verified.ref) mismatches.push("ref");
  if (mismatches.length > 0) {
    throw new GithubError(
      "BUILD_TOKEN_MISMATCH",
      `build token does not match its issued row: ${mismatches.join(", ")}`,
      { details: { mismatchedClaims: mismatches } },
    );
  }
  return consumeBuildToken(db, verified.jti, options);
}
