/**
 * Pure planner for TapeOut `DomainBinding.bind` — no RPC, no clock, no signing.
 *
 * Every function here is total on its declared input type and fails loudly on
 * nonsense (non-integer months, negative wei) instead of silently clamping: the
 * CLI, the API and the browser all build the same call, so a hidden correction in
 * one place would make the three disagree about what gets signed.
 *
 * Contract facts (verified on X Layer 196, 2026-10-25):
 * - `bind(string name, address container, uint256 months) payable`, months 1..120.
 * - `msg.value` must equal `months * monthlyFee()`; `monthlyFee()` reads 0 today,
 *   so the current cost of activation is gas only — the value is still computed
 *   from the live fee, never hard-coded.
 * - Only the container's effective holder may call it; the name must be lowercase
 *   and contain a dot.
 */

/** Longest name the on-chain validator accepts (whole name, dots included). */
export const MAX_NAME_LENGTH = 253;
/** Longest single dot-separated label (RFC 1035 / TapeKit validator). */
export const MAX_LABEL_LENGTH = 63;
/** `bind` accepts 1..120 months inclusive. */
export const MIN_MONTHS = 1;
export const MAX_MONTHS = 120;

export const NAME_LABEL_PATTERN = /^[a-z0-9-]+$/;

export type NameValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type BindNameValidation = NameValidation;
export type MonthsValidation = NameValidation;

/**
 * Validate an on-chain (TapeKit) name: lowercase ASCII, at least one dot, every
 * label 1..63 chars of `[a-z0-9-]` with no leading/trailing hyphen, and at most
 * 253 characters overall.
 *
 * The checks are ordered so the reported reason is the most actionable one: a
 * name that is simply a different case is called out as such before the generic
 * charset failure, and an empty label (`a..tape`, `.tape`, `tape.`) is reported
 * as an empty label rather than as a dot in the wrong place.
 */
export function validateOnChainName(name: string): NameValidation {
  if (typeof name !== "string") {
    return { ok: false, reason: "name must be a string" };
  }
  if (name.length === 0) {
    return { ok: false, reason: "name is empty" };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      reason: `name is ${name.length} characters; the maximum is ${MAX_NAME_LENGTH}`,
    };
  }
  if (name !== name.toLowerCase()) {
    return { ok: false, reason: "name must be lowercase (the contract rejects uppercase)" };
  }
  if (!name.includes(".")) {
    return { ok: false, reason: "name must contain at least one dot (e.g. 10.2.4.tape)" };
  }
  const labels = name.split(".");
  for (const [index, label] of labels.entries()) {
    if (label.length === 0) {
      return { ok: false, reason: `name has an empty label at position ${index}` };
    }
    if (label.length > MAX_LABEL_LENGTH) {
      return {
        ok: false,
        reason: `label "${label.slice(0, 16)}…" is ${label.length} characters; the maximum is ${MAX_LABEL_LENGTH}`,
      };
    }
    if (!NAME_LABEL_PATTERN.test(label)) {
      return {
        ok: false,
        reason: `label "${label}" may only contain a-z, 0-9 and "-"`,
      };
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return { ok: false, reason: `label "${label}" may not start or end with "-"` };
    }
  }
  return { ok: true };
}

/** `months` must be an integer in 1..120 (the contract's accepted range). */
export function validateMonths(months: number): MonthsValidation {
  if (typeof months !== "number" || !Number.isInteger(months)) {
    return { ok: false, reason: `months must be an integer, got ${String(months)}` };
  }
  if (months < MIN_MONTHS || months > MAX_MONTHS) {
    return {
      ok: false,
      reason: `months must be between ${MIN_MONTHS} and ${MAX_MONTHS}, got ${months}`,
    };
  }
  return { ok: true };
}

export interface BindPlanInput {
  readonly name: string;
  readonly months: number;
  /** Live `DomainBinding.monthlyFee()` in wei. */
  readonly monthlyFeeWei: bigint;
  /** Live gas price in wei (used only for the cost preview). */
  readonly gasPriceWei: bigint;
  /** `estimateGas` result for the exact `bind` call. */
  readonly estimatedGas: bigint;
}

export interface BindPlan {
  /** `msg.value` to send: `months * monthlyFeeWei`. */
  readonly valueWei: bigint;
  /** `estimatedGas * gasPriceWei` — the non-refunded cost of the transaction. */
  readonly estimatedCostWei: bigint;
  readonly months: number;
  readonly name: string;
}

/**
 * Fee maths for one `bind` call. Throws on invalid months or negative inputs:
 * a wrong `msg.value` is rejected by the contract, and a negative "cost" would
 * fabricate a budget headroom that does not exist.
 */
export function planBind(input: BindPlanInput): BindPlan {
  const { name, months, monthlyFeeWei, gasPriceWei, estimatedGas } = input;
  const monthsCheck = validateMonths(months);
  if (!monthsCheck.ok) throw new Error(`invalid bind plan: ${monthsCheck.reason}`);
  assertNonNegative("monthlyFeeWei", monthlyFeeWei);
  assertNonNegative("gasPriceWei", gasPriceWei);
  assertNonNegative("estimatedGas", estimatedGas);
  return {
    valueWei: BigInt(months) * monthlyFeeWei,
    estimatedCostWei: estimatedGas * gasPriceWei,
    months,
    name,
  };
}

function assertNonNegative(label: string, value: bigint): void {
  if (typeof value !== "bigint") throw new Error(`invalid bind plan: ${label} must be a bigint`);
  if (value < 0n) throw new Error(`invalid bind plan: ${label} must be non-negative, got ${value}`);
}

export type BindDecision = "BIND" | "RENEW" | "ALREADY_LIVE";

export interface BindDecisionInput {
  /** `DomainBinding.isLive(name, container)`. */
  readonly isLive: boolean;
  /** `DomainBinding.isContainerLive(container)`. */
  readonly isContainerLive: boolean;
  /** `containerPaidUntil(container)` (unix seconds; 0 when never paid). */
  readonly paidUntil: number;
  /** Current unix time in seconds (injected: this module never reads the clock). */
  readonly nowSeconds: number;
}

/**
 * What to do for this (name, container) pair.
 *
 * - activation already covers `nowSeconds` → `ALREADY_LIVE` (idempotent no-op);
 * - a name-level record exists but has expired → `RENEW`;
 * - otherwise (never bound, or expired container-level activation) → `BIND`.
 *
 * An expired `isLive` flag is deliberately not trusted: `isLive` may still read
 * true while `paidUntil` is in the past, so the timestamp is the authority for
 * "still covered".
 */
export function bindDecision(input: BindDecisionInput): BindDecision {
  const { isLive, isContainerLive, paidUntil, nowSeconds } = input;
  if (!Number.isFinite(paidUntil) || !Number.isFinite(nowSeconds)) {
    throw new Error("bindDecision requires finite unix-second timestamps");
  }
  if (paidUntil > nowSeconds && (isLive || isContainerLive)) return "ALREADY_LIVE";
  // A record whose window closed strictly before now is a renewal (same name,
  // same container): the caller pays again instead of "first binding".
  if (paidUntil > 0 && paidUntil < nowSeconds) return "RENEW";
  return "BIND";
}

/** `keccak256(utf8(name))`-shaped name hash is read-side only; exported for callers that need the same key. */
export function normalizeBindName(name: string): string {
  return name.trim();
}
