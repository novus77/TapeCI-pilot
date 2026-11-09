import { randomBytes } from "node:crypto";
import { verifyMessage } from "viem";
import type { WalletChallenge } from "@tapeci/database";
import { TapeCiError, type Hex } from "@tapeci/shared";
import { mapWalletChallengeRow, type Database } from "./db.js";
import { assertChainId, normalizeAddress, TAPECI_CHAIN_ID } from "./validation.js";

export const WALLET_CHALLENGE_DOMAIN = "tapeci.app";
export const WALLET_CHALLENGE_URI = "https://tapeci.app";
export const WALLET_CHALLENGE_VERSION = "1" as const;
export const DEFAULT_WALLET_CHALLENGE_TTL_SECONDS = 300;
export const MAX_WALLET_CHALLENGE_TTL_SECONDS = 3_600;
export const DEFAULT_CHALLENGE_STATEMENT =
  "Sign in to TapeCI to link this wallet. This request authorizes no on-chain transaction.";

export interface WalletChallengeMessageInput {
  readonly address: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expirationTime: Date;
  readonly chainId?: number;
  readonly domain?: string;
  readonly uri?: string;
  readonly statement?: string;
}

function iso(date: Date): string {
  return date.toISOString();
}

/**
 * SIWE-style plain-text challenge (PRD §7.1). Binds domain, chain id 196, the
 * address, a one-time nonce, issued-at and expiration in a human-readable message
 * that is exactly what the wallet signs (and exactly what we store for re-verification).
 */
export function buildWalletChallengeMessage(input: WalletChallengeMessageInput): string {
  const address = normalizeAddress(input.address, "address");
  const chainId = assertChainId(input.chainId ?? TAPECI_CHAIN_ID);
  if (input.nonce.trim() === "") {
    throw new TapeCiError("INVALID_CONFIG", "wallet challenge nonce is required");
  }
  const domain = input.domain ?? WALLET_CHALLENGE_DOMAIN;
  const uri = input.uri ?? WALLET_CHALLENGE_URI;
  const statement = input.statement ?? DEFAULT_CHALLENGE_STATEMENT;
  return [
    `${domain} wants you to sign in with your X Layer account:`,
    address,
    "",
    statement,
    "",
    `URI: ${uri}`,
    `Version: ${WALLET_CHALLENGE_VERSION}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${iso(input.issuedAt)}`,
    `Expiration Time: ${iso(input.expirationTime)}`,
  ].join("\n");
}

export interface CreateWalletChallengeInput {
  readonly address: string;
  readonly chainId?: number;
  readonly ttlSeconds?: number;
  readonly domain?: string;
  readonly uri?: string;
  readonly statement?: string;
  /** Injectable clock for tests. */
  readonly now?: Date;
  /** Injectable nonce for deterministic tests. */
  readonly nonce?: string;
}

export async function createWalletChallenge(
  db: Database,
  input: CreateWalletChallengeInput,
): Promise<WalletChallenge> {
  const address = normalizeAddress(input.address, "address");
  const chainId = assertChainId(input.chainId ?? TAPECI_CHAIN_ID);
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_WALLET_CHALLENGE_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TapeCiError("INVALID_CONFIG", "wallet challenge ttlSeconds must be positive", {
      details: { ttlSeconds },
    });
  }
  if (ttlSeconds > MAX_WALLET_CHALLENGE_TTL_SECONDS) {
    throw new TapeCiError(
      "INVALID_CONFIG",
      `wallet challenge ttlSeconds must be <= ${MAX_WALLET_CHALLENGE_TTL_SECONDS}`,
      { details: { ttlSeconds, maxTtlSeconds: MAX_WALLET_CHALLENGE_TTL_SECONDS } },
    );
  }
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
  const nonce = input.nonce ?? `0x${randomBytes(16).toString("hex")}`;
  const message = buildWalletChallengeMessage({
    address,
    nonce,
    issuedAt: now,
    expirationTime: expiresAt,
    chainId,
    ...(input.domain === undefined ? {} : { domain: input.domain }),
    ...(input.uri === undefined ? {} : { uri: input.uri }),
    ...(input.statement === undefined ? {} : { statement: input.statement }),
  });

  const result = await db.$client.query<Record<string, unknown>>(
    `INSERT INTO wallet_challenges (address, chain_id, nonce, message, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [address, chainId, nonce, message, expiresAt],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new TapeCiError("INTERNAL", "wallet challenge insert returned no row");
  }
  return mapWalletChallengeRow(row);
}

export interface VerifyWalletSignatureInput {
  readonly address: string;
  readonly message: string;
  readonly signature: Hex | `0x${string}`;
}

/**
 * EOA signature check via viem `verifyMessage`. Never throws for a bad signature:
 * callers decide which typed error to raise (see `verifyAndConsumeWalletChallenge`).
 */
export async function verifyWalletSignature(input: VerifyWalletSignatureInput): Promise<boolean> {
  const address = normalizeAddress(input.address, "address");
  try {
    return await verifyMessage({
      address,
      message: input.message,
      signature: input.signature as Hex,
    });
  } catch {
    return false;
  }
}

function challengeLookupError(
  code: "APPROVAL_REQUIRED" | "APPROVAL_EXPIRED",
  reason: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): TapeCiError {
  return new TapeCiError(code, message, { retryable: false, details: { reason, ...details } });
}

async function findChallengeByNonce(
  db: Database,
  nonce: string,
): Promise<WalletChallenge | null> {
  const result = await db.$client.query<Record<string, unknown>>(
    "SELECT * FROM wallet_challenges WHERE nonce = $1",
    [nonce],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapWalletChallengeRow(row);
}

function diagnoseChallenge(
  challenge: WalletChallenge | null,
  nonce: string,
  address: string,
  now: Date,
): TapeCiError {
  if (challenge === null) {
    return challengeLookupError(
      "APPROVAL_REQUIRED",
      "challenge_not_found",
      `wallet challenge ${nonce} was not issued`,
      { nonce },
    );
  }
  if (challenge.address.toLowerCase() !== address) {
    return challengeLookupError(
      "APPROVAL_REQUIRED",
      "challenge_address_mismatch",
      `wallet challenge ${nonce} was issued for a different address`,
      { nonce },
    );
  }
  if (challenge.consumedAt !== null) {
    return challengeLookupError(
      "APPROVAL_REQUIRED",
      "challenge_already_consumed",
      `wallet challenge ${nonce} was already used (replay rejected)`,
      { nonce, consumedAt: challenge.consumedAt.toISOString() },
    );
  }
  if (challenge.expiresAt.getTime() <= now.getTime()) {
    return challengeLookupError(
      "APPROVAL_EXPIRED",
      "challenge_expired",
      `wallet challenge ${nonce} expired at ${challenge.expiresAt.toISOString()}`,
      { nonce, expiresAt: challenge.expiresAt.toISOString() },
    );
  }
  return challengeLookupError(
    "APPROVAL_REQUIRED",
    "challenge_not_consumable",
    `wallet challenge ${nonce} cannot be consumed`,
    { nonce },
  );
}

export interface ConsumeWalletChallengeOptions {
  readonly now?: Date;
}

/**
 * Atomically consume a challenge: exactly one concurrent caller wins because the
 * `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now RETURNING *` re-checks
 * the conditions after acquiring the row lock. Replays and expired challenges throw
 * typed errors (`APPROVAL_REQUIRED` / `APPROVAL_EXPIRED`).
 */
export async function consumeWalletChallenge(
  db: Database,
  nonce: string,
  address: string,
  options: ConsumeWalletChallengeOptions = {},
): Promise<WalletChallenge> {
  const normalizedAddress = normalizeAddress(address, "address");
  const now = options.now ?? new Date();
  const result = await db.$client.query<Record<string, unknown>>(
    `UPDATE wallet_challenges
        SET consumed_at = $3
      WHERE nonce = $1
        AND address = $2
        AND consumed_at IS NULL
        AND expires_at > $3
      RETURNING *`,
    [nonce, normalizedAddress, now],
  );
  const row = result.rows[0];
  if (row !== undefined) return mapWalletChallengeRow(row);
  const existing = await findChallengeByNonce(db, nonce);
  throw diagnoseChallenge(existing, nonce, normalizedAddress, now);
}

export interface VerifyAndConsumeWalletChallengeInput {
  readonly address: string;
  readonly signature: Hex | `0x${string}`;
  /** Challenge nonce. When omitted, the newest unconsumed challenge for the address is used. */
  readonly nonce?: string;
  readonly now?: Date;
}

/**
 * End-to-end wallet auth: locate the challenge, verify the EOA signature over the
 * stored message, then atomically consume it. A signature cannot be replayed because
 * consumption is one-shot (PRD §7.1 identity model).
 */
export async function verifyAndConsumeWalletChallenge(
  db: Database,
  input: VerifyAndConsumeWalletChallengeInput,
): Promise<WalletChallenge> {
  const address = normalizeAddress(input.address, "address");
  const now = input.now ?? new Date();
  let challenge: WalletChallenge | null;
  if (input.nonce !== undefined) {
    challenge = await findChallengeByNonce(db, input.nonce);
    if (
      challenge !== null &&
      (challenge.address.toLowerCase() !== address ||
        challenge.consumedAt !== null ||
        challenge.expiresAt.getTime() <= now.getTime())
    ) {
      throw diagnoseChallenge(challenge, input.nonce, address, now);
    }
  } else {
    const result = await db.$client.query<Record<string, unknown>>(
      `SELECT * FROM wallet_challenges
        WHERE address = $1 AND consumed_at IS NULL AND expires_at > $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [address, now],
    );
    const row = result.rows[0];
    challenge = row === undefined ? null : mapWalletChallengeRow(row);
  }
  if (challenge === null) {
    throw challengeLookupError(
      "APPROVAL_REQUIRED",
      "challenge_not_found",
      `no active wallet challenge for ${address}`,
      { address },
    );
  }

  const valid = await verifyWalletSignature({
    address,
    message: challenge.message,
    signature: input.signature,
  });
  if (!valid) {
    throw challengeLookupError(
      "APPROVAL_REQUIRED",
      "invalid_signature",
      `wallet signature for ${address} does not match the challenge`,
      { address, nonce: challenge.nonce },
    );
  }
  return consumeWalletChallenge(db, challenge.nonce, address, { now });
}
