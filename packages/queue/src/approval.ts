import { hashTypedData, verifyTypedData } from "viem";
import type { TypedDataDomain } from "viem";
import type { Approval, OperatorSession } from "@tapeci/database";
import { TapeCiError, type Hex } from "@tapeci/shared";
import {
  asPgError,
  mapApprovalRow,
  mapOperatorSessionRow,
  type Database,
} from "./db.js";
import {
  assertChainId,
  assertNonEmpty,
  assertUuid,
  normalizeAddress,
  normalizeHash32,
  parseWei,
  sameAddress,
  TAPECI_CHAIN_ID,
} from "./validation.js";

// ---------------------------------------------------------------------------
// EIP-712 approval (PRD §5.1 / §7.2 rule 4 / §9.2)
// ---------------------------------------------------------------------------

/** EIP-712 struct signed by the container owner's wallet for one deployment plan. */
export const APPROVAL_TYPES = {
  Approval: [
    { name: "deploymentId", type: "string" },
    { name: "manifestHash", type: "bytes32" },
    { name: "container", type: "address" },
    { name: "costCapWei", type: "uint256" },
    { name: "nonce", type: "string" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const APPROVAL_PRIMARY_TYPE = "Approval" as const;
export const APPROVAL_DOMAIN_NAME = "TapeCI";
export const APPROVAL_DOMAIN_VERSION = "1";

export interface ApprovalPayload {
  readonly deploymentId: string;
  readonly manifestHash: Hex;
  readonly container: Hex;
  readonly costCapWei: bigint;
  readonly nonce: string;
  /** Unix seconds. */
  readonly expiresAt: bigint;
}

export interface ApprovalDomainOptions {
  readonly chainId?: number;
  /** Bind the signature to the SiteRegistry (or whichever contract the API chooses). */
  readonly verifyingContract?: string;
  readonly name?: string;
  readonly version?: string;
}

export interface ApprovalTypedData {
  readonly domain: TypedDataDomain;
  readonly types: typeof APPROVAL_TYPES;
  readonly primaryType: typeof APPROVAL_PRIMARY_TYPE;
  readonly message: {
    readonly deploymentId: string;
    readonly manifestHash: Hex;
    readonly container: Hex;
    readonly costCapWei: bigint;
    readonly nonce: string;
    readonly expiresAt: bigint;
  };
}

export function normalizeApproval(payload: ApprovalPayload): ApprovalPayload {
  const expiresAt = parseWei(payload.expiresAt, "expiresAt");
  return {
    deploymentId: assertUuid(payload.deploymentId, "deploymentId"),
    manifestHash: normalizeHash32(payload.manifestHash, "manifestHash"),
    container: normalizeAddress(payload.container, "container"),
    costCapWei: parseWei(payload.costCapWei, "costCapWei"),
    nonce: assertNonEmpty(payload.nonce, "nonce"),
    expiresAt,
  };
}

export function approvalDomain(options: ApprovalDomainOptions = {}): TypedDataDomain {
  const domain: TypedDataDomain = {
    name: options.name ?? APPROVAL_DOMAIN_NAME,
    version: options.version ?? APPROVAL_DOMAIN_VERSION,
    chainId: assertChainId(options.chainId ?? TAPECI_CHAIN_ID),
  };
  if (options.verifyingContract !== undefined) {
    domain.verifyingContract = normalizeAddress(options.verifyingContract, "verifyingContract");
  }
  return domain;
}

export function approvalTypedData(
  payload: ApprovalPayload,
  options: ApprovalDomainOptions = {},
): ApprovalTypedData {
  const approval = normalizeApproval(payload);
  return {
    domain: approvalDomain(options),
    types: APPROVAL_TYPES,
    primaryType: APPROVAL_PRIMARY_TYPE,
    message: {
      deploymentId: approval.deploymentId,
      manifestHash: approval.manifestHash,
      container: approval.container,
      costCapWei: approval.costCapWei,
      nonce: approval.nonce,
      expiresAt: approval.expiresAt,
    },
  };
}

/** EIP-712 digest bound to chain id, manifest hash, container, cost cap, nonce and expiry. */
export function approvalDigest(
  payload: ApprovalPayload,
  options: ApprovalDomainOptions = {},
): Hex {
  return hashTypedData(approvalTypedData(payload, options));
}

export interface VerifyApprovalSignatureInput {
  readonly approval: ApprovalPayload;
  readonly signature: Hex | `0x${string}`;
  readonly signerAddress: string;
  readonly domain?: ApprovalDomainOptions;
}

export async function verifyApprovalSignature(
  input: VerifyApprovalSignatureInput,
): Promise<boolean> {
  const signerAddress = normalizeAddress(input.signerAddress, "signerAddress");
  try {
    return await verifyTypedData({
      address: signerAddress,
      signature: input.signature as Hex,
      ...approvalTypedData(input.approval, input.domain),
    });
  } catch {
    return false;
  }
}

export interface ApprovalExpectations {
  readonly deploymentId?: string;
  readonly manifestHash?: string;
  readonly container?: string;
}

export interface ContractSignatureVerifierInput {
  readonly approval: ApprovalPayload;
  readonly digest: Hex;
  readonly signature: Hex | `0x${string}`;
  readonly signerAddress: Hex;
}

/**
 * Optional EIP-1271 verifier. Called only when EOA `verifyTypedData` fails, so
 * Safe/multisig owners can approve through `isValidSignature`.
 */
export type ContractSignatureVerifier = (
  input: ContractSignatureVerifierInput,
) => Promise<boolean>;

export interface ValidateApprovalInput {
  readonly approval: ApprovalPayload;
  readonly signature: Hex | `0x${string}`;
  readonly signerAddress: string;
  /** Digest the client claims was signed; when provided it must match the recomputed one. */
  readonly digest?: Hex;
  readonly now?: Date;
  readonly domain?: ApprovalDomainOptions;
  /** Upper bound the user's wallet/account allows for this deployment. */
  readonly userCostCapWei?: bigint;
  /** Values the approval must be bound to (deployment, manifest, container). */
  readonly expected?: ApprovalExpectations;
  /** EIP-1271 fallback for contract owners (Safe, etc.). */
  readonly contractSignatureVerifier?: ContractSignatureVerifier;
}

export interface ValidatedApproval {
  readonly approval: ApprovalPayload;
  readonly digest: Hex;
  readonly signerAddress: Hex;
  readonly expiresAt: Date;
}

function planStale(message: string, reason: string, details: Record<string, unknown>): TapeCiError {
  return new TapeCiError("PLAN_STALE", message, {
    retryable: false,
    details: { reason, ...details },
  });
}

function approvalRequired(
  message: string,
  reason: string,
  details: Record<string, unknown>,
): TapeCiError {
  return new TapeCiError("APPROVAL_REQUIRED", message, {
    retryable: false,
    details: { reason, ...details },
  });
}

/**
 * Validate an EIP-712 approval before it is stored or executed:
 * recomputed digest match, expiry, cost cap, scope binding and signature.
 * Every failure is a typed, non-retryable `TapeCiError`.
 */
export async function validateApproval(input: ValidateApprovalInput): Promise<ValidatedApproval> {
  const approval = normalizeApproval(input.approval);
  const signerAddress = normalizeAddress(input.signerAddress, "signerAddress");
  const now = input.now ?? new Date();
  const digest = approvalDigest(approval, input.domain);

  if (input.digest !== undefined && input.digest.toLowerCase() !== digest.toLowerCase()) {
    throw planStale(
      `approval digest ${input.digest} does not match the recomputed digest (plan changed after approval)`,
      "approval_digest_mismatch",
      { expectedDigest: digest, receivedDigest: input.digest },
    );
  }

  const nowSeconds = BigInt(Math.floor(now.getTime() / 1_000));
  if (approval.expiresAt <= nowSeconds) {
    throw new TapeCiError(
      "APPROVAL_EXPIRED",
      `approval expired at ${new Date(Number(approval.expiresAt) * 1_000).toISOString()}`,
      {
        retryable: false,
        details: {
          reason: "approval_expired",
          expiresAt: Number(approval.expiresAt),
          now: nowSeconds.toString(),
        },
      },
    );
  }

  if (input.userCostCapWei !== undefined && approval.costCapWei > input.userCostCapWei) {
    throw new TapeCiError(
      "FEE_OVER_BUDGET",
      `approved cost cap ${approval.costCapWei} exceeds user cap ${input.userCostCapWei}`,
      {
        retryable: false,
        details: {
          reason: "cost_cap_exceeded",
          costCapWei: approval.costCapWei.toString(),
          userCostCapWei: input.userCostCapWei.toString(),
        },
      },
    );
  }

  const expected = input.expected;
  if (expected !== undefined) {
    if (expected.deploymentId !== undefined && expected.deploymentId.toLowerCase() !== approval.deploymentId) {
      throw planStale("approval is bound to a different deployment", "approval_deployment_mismatch", {
        expectedDeploymentId: expected.deploymentId,
        approvalDeploymentId: approval.deploymentId,
      });
    }
    if (
      expected.manifestHash !== undefined &&
      normalizeHash32(expected.manifestHash, "expected.manifestHash") !== approval.manifestHash
    ) {
      throw planStale(
        "approval manifest hash does not match the current plan manifest",
        "approval_manifest_mismatch",
        { expectedManifestHash: expected.manifestHash, approvalManifestHash: approval.manifestHash },
      );
    }
    if (expected.container !== undefined && !sameAddress(expected.container, approval.container)) {
      throw planStale("approval is bound to a different container", "approval_container_mismatch", {
        expectedContainer: expected.container,
        approvalContainer: approval.container,
      });
    }
  }

  let signatureValid = await verifyApprovalSignature({
    approval,
    signature: input.signature,
    signerAddress,
    ...(input.domain === undefined ? {} : { domain: input.domain }),
  });
  if (!signatureValid && input.contractSignatureVerifier !== undefined) {
    signatureValid = await input.contractSignatureVerifier({
      approval,
      digest,
      signature: input.signature,
      signerAddress,
    });
  }
  if (!signatureValid) {
    throw approvalRequired(
      `approval signature does not verify for signer ${signerAddress}`,
      "invalid_approval_signature",
      { signerAddress, digest },
    );
  }

  return {
    approval,
    digest,
    signerAddress,
    expiresAt: new Date(Number(approval.expiresAt) * 1_000),
  };
}

export interface RecordApprovalInput {
  readonly deploymentId: string;
  readonly manifestSha256: string;
  readonly containerAddress: string;
  readonly registryAddress: string;
  readonly approval: ApprovalPayload;
  readonly signature: Hex | `0x${string}`;
  readonly signerAddress: string;
  readonly digest?: Hex;
  readonly now?: Date;
  readonly userCostCapWei?: bigint;
  readonly domain?: ApprovalDomainOptions;
  /** EIP-1271 fallback for contract owners. */
  readonly contractSignatureVerifier?: ContractSignatureVerifier;
}

/**
 * Validate and persist one approval row. `approvals` is append-only for audit;
 * the unique digest/nonce constraints make a second approval for the same signed
 * payload fail closed instead of silently overwriting history.
 */
export async function recordApproval(
  db: Database,
  input: RecordApprovalInput,
): Promise<Approval> {
  const domain: ApprovalDomainOptions = {
    ...input.domain,
    verifyingContract: input.domain?.verifyingContract ?? input.registryAddress,
  };
  const validated = await validateApproval({
    approval: input.approval,
    signature: input.signature,
    signerAddress: input.signerAddress,
    ...(input.digest === undefined ? {} : { digest: input.digest }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.userCostCapWei === undefined ? {} : { userCostCapWei: input.userCostCapWei }),
    ...(input.contractSignatureVerifier === undefined
      ? {}
      : { contractSignatureVerifier: input.contractSignatureVerifier }),
    domain,
    expected: {
      deploymentId: input.deploymentId,
      manifestHash: input.manifestSha256,
      container: input.containerAddress,
    },
  });

  try {
    const result = await db.$client.query<Record<string, unknown>>(
      `INSERT INTO approvals
         (deployment_id, signer_address, chain_id, manifest_sha256, approval_digest,
          signature, approved_cost_cap_wei, nonce, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        validated.approval.deploymentId,
        validated.signerAddress,
        TAPECI_CHAIN_ID,
        validated.approval.manifestHash,
        validated.digest,
        input.signature,
        validated.approval.costCapWei.toString(),
        validated.approval.nonce,
        validated.expiresAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new TapeCiError("INTERNAL", "approval insert returned no row");
    return mapApprovalRow(row);
  } catch (error) {
    const pg = asPgError(error);
    if (pg?.code === "23505") {
      throw approvalRequired(
        "approval was already recorded (digest or nonce reused)",
        pg.constraint === "approvals_nonce_key" ? "approval_nonce_reused" : "approval_digest_reused",
        { deploymentId: input.deploymentId, constraint: pg.constraint ?? null },
      );
    }
    throw error;
  }
}

/** Revoke one approval (fail closed for any in-flight use). */
export async function revokeApproval(
  db: Database,
  approvalId: string,
  now: Date = new Date(),
): Promise<Approval | null> {
  const result = await db.$client.query<Record<string, unknown>>(
    "UPDATE approvals SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING *",
    [assertUuid(approvalId, "approvalId"), now],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapApprovalRow(row);
}

// ---------------------------------------------------------------------------
// Temporary operator sessions (PRD §7.2 rule 3 / §12 P2-08)
// ---------------------------------------------------------------------------

export const DEFAULT_OPERATOR_SESSION_TTL_SECONDS = 3_600;
/** Hard ceiling for a temporary operator grant: one day. */
export const MAX_OPERATOR_SESSION_TTL_SECONDS = 86_400;

export interface CreateOperatorSessionInput {
  readonly containerId: string;
  readonly signerAddress: string;
  readonly ttlSeconds?: number;
  readonly approvalId?: string | null;
  readonly now?: Date;
}

export async function createOperatorSession(
  db: Database,
  input: CreateOperatorSessionInput,
): Promise<OperatorSession> {
  const containerId = assertUuid(input.containerId, "containerId");
  const signerAddress = normalizeAddress(input.signerAddress, "signerAddress");
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_OPERATOR_SESSION_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TapeCiError("INVALID_CONFIG", "operator session ttlSeconds must be positive", {
      details: { ttlSeconds },
    });
  }
  if (ttlSeconds > MAX_OPERATOR_SESSION_TTL_SECONDS) {
    throw new TapeCiError(
      "INVALID_CONFIG",
      `operator session ttlSeconds must be <= ${MAX_OPERATOR_SESSION_TTL_SECONDS}`,
      { details: { ttlSeconds, maxTtlSeconds: MAX_OPERATOR_SESSION_TTL_SECONDS } },
    );
  }
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
  const approvalId =
    input.approvalId === undefined || input.approvalId === null
      ? null
      : assertUuid(input.approvalId, "approvalId");
  const result = await db.$client.query<Record<string, unknown>>(
    `INSERT INTO operator_sessions (container_id, signer_address, approval_id, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [containerId, signerAddress, approvalId, expiresAt],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new TapeCiError("INTERNAL", "operator session insert returned no row");
  }
  return mapOperatorSessionRow(row);
}

/**
 * Typed authorization failure for temporary operator grants. `TapeCiError.code` is
 * `APPROVAL_REQUIRED` because the shared error union has no `AUTH_REVOKED` code; the
 * required deployment state is exposed as `requiredState = "AUTH_REVOKED"`.
 */
export class OperatorAuthorizationError extends TapeCiError {
  readonly requiredState = "AUTH_REVOKED" as const;

  constructor(message: string, details: Readonly<Record<string, unknown>>) {
    super("APPROVAL_REQUIRED", message, {
      retryable: false,
      details: { ...details, requiredState: "AUTH_REVOKED" },
    });
    this.name = "OperatorAuthorizationError";
  }
}

export function isOperatorAuthorizationError(
  value: unknown,
): value is OperatorAuthorizationError {
  return value instanceof OperatorAuthorizationError;
}

export interface AssertOperatorAuthorizedInput {
  readonly containerId: string;
  readonly signerAddress: string;
  readonly now?: Date;
}

/**
 * Check that a live (non-revoked, non-expired) operator session exists for the
 * container + signer. Any miss is `AUTH_REVOKED`: chain writes must stop when the
 * temporary operator grant lapses (PRD §7.2 rule 3).
 */
export async function assertOperatorAuthorized(
  db: Database,
  input: AssertOperatorAuthorizedInput,
): Promise<OperatorSession> {
  const containerId = assertUuid(input.containerId, "containerId");
  const signerAddress = normalizeAddress(input.signerAddress, "signerAddress");
  const now = input.now ?? new Date();
  const result = await db.$client.query<Record<string, unknown>>(
    `SELECT * FROM operator_sessions
      WHERE container_id = $1
        AND signer_address = $2
        AND revoked_at IS NULL
        AND expires_at > $3
      ORDER BY expires_at DESC
      LIMIT 1`,
    [containerId, signerAddress, now],
  );
  const row = result.rows[0];
  if (row !== undefined) return mapOperatorSessionRow(row);

  const anyResult = await db.$client.query<Record<string, unknown>>(
    `SELECT * FROM operator_sessions
      WHERE container_id = $1 AND signer_address = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [containerId, signerAddress],
  );
  const existing = anyResult.rows[0];
  if (existing === undefined) {
    throw new OperatorAuthorizationError(
      "no operator session exists for this container signer",
      { reason: "no_operator_session", containerId, signerAddress },
    );
  }
  const session = mapOperatorSessionRow(existing);
  const reason = session.revokedAt !== null ? "operator_session_revoked" : "operator_session_expired";
  throw new OperatorAuthorizationError(`operator session is not usable (${reason})`, {
    reason,
    containerId,
    signerAddress,
    expiresAt: session.expiresAt.toISOString(),
    ...(session.revokedAt === null ? {} : { revokedAt: session.revokedAt.toISOString() }),
  });
}

/** Revoke one session immediately. Returns `null` if it was already revoked/absent. */
export async function revokeOperatorSession(
  db: Database,
  sessionId: string,
  now: Date = new Date(),
): Promise<OperatorSession | null> {
  const result = await db.$client.query<Record<string, unknown>>(
    "UPDATE operator_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING *",
    [assertUuid(sessionId, "sessionId"), now],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapOperatorSessionRow(row);
}

/** Revoke every live session for a container (e.g. NFT ownership transfer detected). */
export async function revokeOperatorSessionsForContainer(
  db: Database,
  containerId: string,
  now: Date = new Date(),
): Promise<number> {
  const result = await db.$client.query(
    `UPDATE operator_sessions SET revoked_at = $2
      WHERE container_id = $1 AND revoked_at IS NULL`,
    [assertUuid(containerId, "containerId"), now],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Dynamic ownership assertion (PRD §7.1 / §12 P2-07)
// ---------------------------------------------------------------------------

/**
 * Thrown when the live on-chain owner no longer matches the cached/observed owner.
 * The deployment state machine maps this to `OWNERSHIP_CHANGED` and all writes stop.
 *
 * `TapeCiError.code` stays `NOT_CURRENT_OWNER` (the shared typed code); the required
 * deployment state is exposed as `requiredState`.
 */
export class OwnershipChangedError extends TapeCiError {
  readonly requiredState = "OWNERSHIP_CHANGED" as const;
  readonly currentOwner: string | null;
  readonly cachedOwner: string | null;

  constructor(currentOwner: string | null, cachedOwner: string | null) {
    super("NOT_CURRENT_OWNER", "container owner changed since the deployment plan was approved", {
      retryable: false,
      details: {
        reason: "ownership_changed",
        currentOwner,
        cachedOwner,
        requiredState: "OWNERSHIP_CHANGED",
      },
    });
    this.name = "OwnershipChangedError";
    this.currentOwner = currentOwner;
    this.cachedOwner = cachedOwner;
  }
}

/**
 * Container ownership is read live before/while deploying; the DB cache is evidence
 * only and never an authorization source. Null/missing owners also fail closed.
 */
export function assertOwnerUnchanged(
  currentOwner: string | null | undefined,
  cachedOwner: string | null | undefined,
): void {
  if (currentOwner === null || currentOwner === undefined || cachedOwner === null || cachedOwner === undefined) {
    throw new OwnershipChangedError(
      currentOwner ?? null,
      cachedOwner ?? null,
    );
  }
  const current = normalizeAddress(currentOwner, "currentOwner");
  const cached = normalizeAddress(cachedOwner, "cachedOwner");
  if (current !== cached) {
    throw new OwnershipChangedError(current, cached);
  }
}
