import type { ApprovalTypedData } from "./types";

/**
 * Pure helpers for the manual (no-wallet) approval fallback.
 *
 * The browser path signs with wagmi; the manual path must show exactly the
 * EIP-712 document the API will verify and validate the pasted signature before
 * it is sent. Nothing here touches `window`, the network or a private key, so it
 * is safe to import from client components and from unit tests.
 */

/** A 65-byte ECDSA signature: `0x` plus 130 hex characters. */
export const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

/** EIP-712 struct the API verifies (`packages/queue/src/approval.ts`). */
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
/** X Layer mainnet; approvals are always bound to this chain id. */
export const APPROVAL_CHAIN_ID = 196;

/** Signature length in bytes, used in the operator-facing validation message. */
const SIGNATURE_BYTES = 65;
const SIGNATURE_HEX_CHARACTERS = SIGNATURE_BYTES * 2;

/** The subset of the API payload that is actually signed (no `approval`/`expectedSigner`). */
export interface ApprovalTypedDataDocument {
  readonly domain: ApprovalTypedData["domain"];
  readonly types: ApprovalTypedData["types"];
  readonly primaryType: ApprovalTypedData["primaryType"];
  readonly message: ApprovalTypedData["message"];
}

/**
 * Project the API response onto the EIP-712 document that must be signed.
 * `approval` is only the submit body and `expectedSigner` is metadata, so they
 * are deliberately excluded from the copyable JSON.
 */
export function approvalTypedDataDocument(payload: ApprovalTypedData): ApprovalTypedDataDocument {
  return {
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message,
  };
}

/** Pretty-printed JSON for the copyable block; stable key order, no trailing newline. */
export function formatApprovalPayloadJson(payload: ApprovalTypedData): string {
  return JSON.stringify(approvalTypedDataDocument(payload), null, 2);
}

/** `null` when the trimmed value is not a 65-byte signature. */
export function normalizeSignature(value: string): string | null {
  const trimmed = value.trim();
  return SIGNATURE_PATTERN.test(trimmed) ? trimmed : null;
}

/** Operator-facing reason a pasted signature is rejected, or `null` when it is well formed. */
export function describeSignatureProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "Paste the 65-byte signature produced by the container owner key.";
  }
  if (!trimmed.startsWith("0x")) {
    return "A signature starts with 0x followed by 130 hex characters.";
  }
  if (!SIGNATURE_PATTERN.test(trimmed)) {
    return `A signature is 0x plus ${SIGNATURE_HEX_CHARACTERS} hex characters (${SIGNATURE_BYTES} bytes); this one has ${trimmed.length - 2}.`;
  }
  return null;
}

/**
 * Detect an injected EIP-1193 provider without assuming a global shape.
 * Call with `window`; the `in` check is safe even when no extension is installed.
 */
export function detectInjectedWallet(candidate: unknown): boolean {
  return typeof candidate === "object" && candidate !== null && "ethereum" in candidate;
}
