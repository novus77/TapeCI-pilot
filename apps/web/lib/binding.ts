/**
 * Pure helpers shared by the container page (server), the bind server action and
 * the client form. No network, no React: everything here is safe on both sides.
 */

export const BIND_MONTHS_MIN = 1;
export const BIND_MONTHS_MAX = 120;
/** Longest whole name the on-chain validator accepts (matches `@tapeci/deployer`). */
export const BIND_NAME_MAX_LENGTH = 253;
/** Longest single dot-separated label (RFC 1035 / TapeKit validator). */
export const BIND_LABEL_MAX_LENGTH = 63;
/** TapeKit encodes the network area as the second label of every name. */
export const X_LAYER_AREA_CODE = 2;

/** The name TapeKit derives for a container: `<tokenId>.<area>.<processorIndex>.tape`. */
export function suggestedName(tokenId: string | number, area: number, processorIndex: number): string {
  return `${String(tokenId)}.${String(area)}.${String(processorIndex)}.tape`;
}

/**
 * Mirrors the on-chain requirement: lowercase, at least one dot, only
 * `a-z 0-9 - .`, no leading/trailing dot or hyphen, each dot-separated label
 * non-empty and at most 63 characters.
 */
export function validateBindName(value: string): string | null {
  if (value.length === 0) return "Enter an on-chain name.";
  if (value.length > BIND_NAME_MAX_LENGTH) return "Name is too long.";
  if (value !== value.toLowerCase()) return "Use a lowercase name.";
  if (!/^[a-z0-9.-]+$/.test(value)) return "Use only a-z, 0-9, dots and hyphens.";
  if (!value.includes(".")) return "The name must contain a dot.";
  if (value.startsWith(".") || value.endsWith(".") || value.startsWith("-") || value.endsWith("-")) {
    return "The name cannot start or end with a dot or hyphen.";
  }
  for (const label of value.split(".")) {
    if (label.length === 0) return "The name cannot contain an empty label.";
    if (label.length > BIND_LABEL_MAX_LENGTH) return "Each label must be at most 63 characters.";
  }
  return null;
}

export function parseBindMonths(value: string | number): number | null {
  const numeric = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(numeric)) return null;
  if (numeric < BIND_MONTHS_MIN || numeric > BIND_MONTHS_MAX) return null;
  return numeric;
}

/** `value = months × monthlyFee`. Returns `null` when the fee is unknown. */
export function bindValueWei(monthlyFeeWei: string | null, months: number): bigint | null {
  if (monthlyFeeWei === null || !/^\d+$/.test(monthlyFeeWei)) return null;
  if (!Number.isInteger(months) || months < BIND_MONTHS_MIN || months > BIND_MONTHS_MAX) return null;
  return BigInt(monthlyFeeWei) * BigInt(months);
}

/** `paidUntil` is unix seconds (uint40) on-chain; ISO-8601 is accepted for fixtures. */
export function paidUntilToIso(paidUntil: string | null): string | null {
  if (paidUntil === null || paidUntil.length === 0) return null;
  if (/^\d+$/.test(paidUntil)) {
    const seconds = Number(paidUntil);
    if (!Number.isSafeInteger(seconds)) return null;
    return new Date(seconds * 1000).toISOString();
  }
  const parsed = Date.parse(paidUntil);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * Derives the UI state. `isLive` (the exact read a gateway performs) wins; an
 * expired `paidUntil` is only reported when the binding is not live.
 */
export function bindingState(input: {
  readonly isLive: boolean;
  readonly paidUntil: string | null;
  readonly nowSeconds: number;
}): "ACTIVE" | "NOT_ACTIVATED" | "EXPIRED" {
  if (input.isLive) return "ACTIVE";
  const iso = paidUntilToIso(input.paidUntil);
  if (iso === null) return "NOT_ACTIVATED";
  const seconds = Math.floor(Date.parse(iso) / 1000);
  return seconds <= input.nowSeconds ? "EXPIRED" : "NOT_ACTIVATED";
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
