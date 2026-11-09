import { TapeCiError, type Hex } from "@tapeci/shared";

/** TapeCI only ever targets X Layer mainnet (chain id 196). */
export const TAPECI_CHAIN_ID = 196 as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH32_RE = /^0x[0-9a-fA-F]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate and lowercase an EVM address (TapeCI stores addresses lowercase). */
export function normalizeAddress(value: string, field = "address"): Hex {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new TapeCiError("INVALID_CONFIG", `invalid EVM address for ${field}`, {
      details: { field },
    });
  }
  return value.toLowerCase() as Hex;
}

/** Validate a 0x-prefixed 32-byte hash and lowercase it. */
export function normalizeHash32(value: string, field = "hash"): Hex {
  if (typeof value !== "string" || !HASH32_RE.test(value)) {
    throw new TapeCiError("INVALID_CONFIG", `invalid 32-byte hash for ${field}`, {
      details: { field },
    });
  }
  return value.toLowerCase() as Hex;
}

export function assertChainId(chainId: number, field = "chainId"): 196 {
  if (chainId !== TAPECI_CHAIN_ID) {
    throw new TapeCiError("CHAIN_MISMATCH", `${field} ${String(chainId)} is not 196 (X Layer)`, {
      details: { field, chainId },
    });
  }
  return TAPECI_CHAIN_ID;
}

export function assertUuid(value: string, field = "id"): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new TapeCiError("INVALID_CONFIG", `invalid UUID for ${field}`, {
      details: { field },
    });
  }
  return value.toLowerCase();
}

export function assertNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TapeCiError("INVALID_CONFIG", `${field} must be a non-empty string`, {
      details: { field },
    });
  }
  return value;
}

/** True when two addresses are equal ignoring checksum casing. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** Parse a decimal wei string/bigint into a non-negative bigint. */
export function parseWei(value: bigint | string | number, field = "wei"): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TapeCiError("INVALID_CONFIG", `${field} number is not a safe integer`, {
        details: { field },
      });
    }
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^[0-9]+$/.test(value)) parsed = BigInt(value);
  else {
    throw new TapeCiError("INVALID_CONFIG", `${field} is not a decimal wei value`, {
      details: { field },
    });
  }
  if (parsed < 0n) {
    throw new TapeCiError("INVALID_CONFIG", `${field} must be >= 0`, { details: { field } });
  }
  return parsed;
}
