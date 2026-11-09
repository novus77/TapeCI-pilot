import type { Hex } from "@tapeci/shared";

/** The all-zero hash means "no hash recorded"; it must never be reported as verified (PRD §3.2). */
export const ZERO_SHA256: Hex = `0x${"0".repeat(64)}`;

export interface DeclaredBytes {
  readonly sha256: Hex;
  readonly size: number;
}

export interface ActualBytes {
  readonly sha256: Hex;
  readonly size: number;
}

export interface FileMatch {
  readonly path: string;
  readonly expectedSha256: Hex;
  readonly actualSha256: Hex;
  readonly expectedSize: number;
  readonly actualSize: number;
  readonly matched: boolean;
}

export function isZeroSha256(value: Hex): boolean {
  return value.toLowerCase() === ZERO_SHA256;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return firstMismatchOffset(a, b) === null;
}

/**
 * Index of the first differing byte, or `null` when the buffers are identical.
 * A length difference reports the shorter length (the first missing byte).
 */
export function firstMismatchOffset(a: Uint8Array, b: Uint8Array): number | null {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index] !== b[index]) return index;
  }
  return a.length === b.length ? null : shared;
}

/**
 * Pure size + raw SHA-256 comparison (never Keccak-256). Used by `verifySite`
 * and by tests that simulate a wrong declared hash without any network writes.
 */
export function evaluateFileMatch(
  path: string,
  actual: ActualBytes,
  declared: DeclaredBytes,
): FileMatch {
  const matched =
    !isZeroSha256(declared.sha256) &&
    declared.size === actual.size &&
    actual.sha256.toLowerCase() === declared.sha256.toLowerCase();
  return {
    path,
    expectedSha256: declared.sha256,
    actualSha256: actual.sha256,
    expectedSize: declared.size,
    actualSize: actual.size,
    matched,
  };
}
