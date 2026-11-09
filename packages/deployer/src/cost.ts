import { CHUNK_MAX, TapeCiError } from "@tapeci/shared";

/**
 * Gas model for TapeOut chunk writes on X Layer.
 *
 * Calibration source (P0 evidence, `docs/evidence/fork-upload.json` and
 * `docs/abi-validation.md` §4):
 * - a 24,000-byte `putFile` consumed **5,490,912 gas** on an Anvil fork;
 * - a 1-byte `putFile` estimated **296,698 gas**;
 * - a 1-byte `appendChunk` estimated **166,903 gas**.
 *
 * Each chunk is deployed as contract code, so the dominant cost is
 * 200 gas/byte of code deposit plus 16 gas/byte of calldata for every file byte.
 * The fixed bases below are deliberately rounded up so the estimate does not
 * under-quote, and a separate safety margin is applied to the *cost cap*.
 */
export interface GasModel {
  readonly putFileBaseGas: bigint;
  readonly appendChunkBaseGas: bigint;
  readonly codeDepositGasPerByte: bigint;
  readonly calldataGasPerByte: bigint;
  readonly defaultMarginBps: number;
}

export const OBSERVED_XLAYER_GAS_MODEL: GasModel = {
  putFileBaseGas: 310_000n,
  appendChunkBaseGas: 180_000n,
  codeDepositGasPerByte: 200n,
  calldataGasPerByte: 16n,
  defaultMarginBps: 2_000,
};

export const MAX_MARGIN_BPS = 5_000;
export const BPS_DENOMINATOR = 10_000n;

/** Gas for one file: `putFile` for chunk 0 plus `appendChunk` for each later chunk. */
export function estimateFileGas(size: number, model: GasModel = OBSERVED_XLAYER_GAS_MODEL): bigint {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TapeCiError("INVALID_ARTIFACT", `invalid file size for gas estimate: ${String(size)}`);
  }
  const chunks = Math.max(1, Math.ceil(size / CHUNK_MAX));
  const perByte = model.codeDepositGasPerByte + model.calldataGasPerByte;
  return (
    model.putFileBaseGas +
    BigInt(chunks - 1) * model.appendChunkBaseGas +
    BigInt(size) * perByte
  );
}

/** Total gas for a set of file sizes (only files that will actually be written). */
export function estimateTotalGas(
  sizes: readonly number[],
  model: GasModel = OBSERVED_XLAYER_GAS_MODEL,
): bigint {
  return sizes.reduce((sum, size) => sum + estimateFileGas(size, model), 0n);
}

export function costWei(gas: bigint, gasPriceWei: bigint): bigint {
  if (gas < 0n || gasPriceWei < 0n) {
    throw new TapeCiError("INTERNAL", "gas and gas price must be non-negative");
  }
  return gas * gasPriceWei;
}

/** Ceiling of `cost × (1 + margin)`, used as the recommended approval cap. */
export function recommendedCapWei(estimatedCostWei: bigint, marginBps: number): bigint {
  assertMarginBps(marginBps);
  if (estimatedCostWei < 0n) throw new TapeCiError("INTERNAL", "cost must be non-negative");
  const scaled = estimatedCostWei * (BPS_DENOMINATOR + BigInt(marginBps));
  return (scaled + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

export function assertMarginBps(marginBps: number): void {
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps > MAX_MARGIN_BPS) {
    throw new TapeCiError(
      "INVALID_CONFIG",
      `marginBps must be an integer between 0 and ${MAX_MARGIN_BPS}, got ${String(marginBps)}`,
    );
  }
}

/**
 * `1234567890123456789n` → `"1.234567 OKB"` (display only; never use for accounting).
 *
 * A positive amount is **never** rendered as zero: if it is smaller than the
 * requested precision can express, the exact value is printed instead. The old
 * implementation sliced the fraction, so `123n` became `"0.00 OKB"` — a number
 * that reads as free (issue P1-04, same defect class as the web formatter).
 */
export function formatOkb(wei: bigint, fractionDigits = 6): string {
  if (wei < 0n) return `-${formatOkb(-wei, fractionDigits)}`;
  const scale = 10n ** 18n;
  const whole = wei / scale;
  const fraction = wei % scale;
  const digits = Math.max(0, fractionDigits);
  const padded = fraction.toString().padStart(18, "0").slice(0, digits);
  const rounded = `${whole.toString()}${digits > 0 ? `.${padded}` : ""}`;
  // Truncation is only acceptable when it loses nothing. If any non-zero digit was
  // cut, print the exact value: a truncated figure understates a fee, and an
  // all-zero one reads as free (issues P1-04 and its sibling in the web formatter).
  const truncated = fraction.toString().padStart(18, "0").slice(digits);
  const lostPrecision = /[1-9]/.test(truncated);
  if (lostPrecision) {
    const exact = fraction.toString().padStart(18, "0").replace(/0+$/, "");
    return `${whole.toString()}${exact.length > 0 ? `.${exact}` : ""} OKB`;
  }
  return `${rounded} OKB`;
}
