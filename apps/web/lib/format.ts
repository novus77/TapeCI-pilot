/** Deterministic, UTC-only formatting. No locale data is loaded at runtime. */

const ISO_LIKE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

export function formatUtcDateTime(iso: string | null): string {
  if (iso === null) return "—";
  const match = ISO_LIKE.exec(iso);
  if (match === null) return iso;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC`;
}

export function formatUtcDate(iso: string | null): string {
  if (iso === null) return "—";
  const match = ISO_LIKE.exec(iso);
  if (match === null) return iso;
  const [, year, month, day] = match;
  return `${year}-${month}-${day}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  if (days > 0) return `${days}d ${hours}h`;
  if (totalHours > 0) return `${totalHours}h ${String(minutes).padStart(2, "0")}m`;
  if (totalMinutes > 0) return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatDurationBetween(startIso: string, endIso: string | null): string {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return "—";
  if (endIso === null) return "in progress";
  const end = Date.parse(endIso);
  if (Number.isNaN(end)) return "—";
  return formatDuration(end - start);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

export function shortValue(value: string | null, head = 8, tail = 6): string {
  if (value === null || value.length === 0) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatInteger(value: string | number): string {
  const text = typeof value === "number" ? String(Math.trunc(value)) : value;
  if (!/^\d+$/.test(text)) return text;
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The app-wide "unknown" marker for an amount. An unknown amount is never a
 * number, so it can never be read as zero or as a free operation.
 */
export const UNKNOWN_AMOUNT = "—";

const OKB_DECIMALS = 18;
const GWEI_DECIMALS = 9;
/** Common amounts keep the established width; tiny ones gain digits instead. */
const OKB_MIN_FRACTION_DIGITS = 4;
const GWEI_MIN_FRACTION_DIGITS = 2;

/**
 * Exact fixed-point rendering of a wei amount, computed from the BigInt alone.
 * Trailing zeros are trimmed, then the fraction is padded to at least
 * `minFractionDigits`. Nothing is rounded and nothing is truncated, so the
 * printed value is always the exact amount: a positive input keeps at least one
 * non-zero digit no matter how small it is.
 */
function formatScaled(wei: bigint, decimals: number, minFractionDigits: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = wei / scale;
  const trimmed = (wei % scale).toString().padStart(decimals, "0").replace(/0+$/u, "");
  const fraction = trimmed.padEnd(minFractionDigits, "0");
  return `${formatInteger(whole.toString())}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

/**
 * Format a base-10 wei string as OKB.
 *
 * Precision rule: convert from the BigInt directly — never through `Number` —
 * and print the exact amount with trailing zeros trimmed and at least four
 * fractional digits. A positive amount therefore always shows a non-zero digit:
 * values below `0.0001 OKB` simply gain digits (`1` wei →
 * `0.000000000000000001 OKB`) instead of collapsing to `0.0000 OKB`.
 * `null` and any non-decimal input mean unknown and render as `unknown`, never
 * as zero. The caller passes the localized label (SPEC §13 wants "not
 * estimated"); the default is the locale-neutral dash the rest of this module
 * uses for an absent value.
 */
export function formatWeiAsOkb(wei: string | null, unknown: string = UNKNOWN_AMOUNT): string {
  if (wei === null || !/^\d+$/u.test(wei)) return unknown;
  return `${formatScaled(BigInt(wei), OKB_DECIMALS, OKB_MIN_FRACTION_DIGITS)} OKB`;
}

/**
 * Format a base-10 wei gas price as gwei. Same rule as {@link formatWeiAsOkb}:
 * exact BigInt conversion, trailing zeros trimmed, at least two fractional
 * digits. `Number` is never involved, so a 24-digit gas price keeps every digit
 * instead of being rounded to 15 significant figures.
 */
export function formatGwei(wei: string | null, unknown: string = UNKNOWN_AMOUNT): string {
  if (wei === null || !/^\d+$/u.test(wei)) return unknown;
  return `${formatScaled(BigInt(wei), GWEI_DECIMALS, GWEI_MIN_FRACTION_DIGITS)} gwei`;
}

export function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export type TtlTone = "revoked" | "expired" | "critical" | "warning" | "healthy";

export interface TtlStatus {
  readonly tone: TtlTone;
  readonly label: string;
  readonly detail: string;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Operator sessions are temporary chain-write grants: after expiry the operator
 * can no longer write (fail closed). The copy is deliberately explicit instead
 * of relying on colour.
 */
export function ttlStatus(
  expiresAt: string,
  revokedAt: string | null,
  nowMs: number = Date.now(),
): TtlStatus {
  if (revokedAt !== null) {
    return {
      tone: "revoked",
      label: "Revoked",
      detail: `Revoked ${formatUtcDateTime(revokedAt)}. This signer can no longer write.`,
    };
  }
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) {
    return { tone: "warning", label: "Unknown expiry", detail: "The expiry timestamp is invalid." };
  }
  const remaining = expiresMs - nowMs;
  if (remaining <= 0) {
    return {
      tone: "expired",
      label: "Expired",
      detail: `Expired ${formatUtcDateTime(expiresAt)}. Writes are refused until a new approval is signed.`,
    };
  }
  const remainingText = formatDuration(remaining);
  if (remaining <= 6 * HOUR_MS) {
    return {
      tone: "critical",
      label: `Expires in ${remainingText}`,
      detail: `Critical: this session expires ${formatUtcDateTime(expiresAt)}. If a release is still writing then, it stops and needs a new approval.`,
    };
  }
  if (remaining <= 24 * HOUR_MS) {
    return {
      tone: "warning",
      label: `Expires in ${remainingText}`,
      detail: `Warning: this session expires ${formatUtcDateTime(expiresAt)}. Finish or re-approve before then.`,
    };
  }
  return {
    tone: "healthy",
    label: `Valid for ${remainingText}`,
    detail: `Expires ${formatUtcDateTime(expiresAt)}. Revoke it when the release is finished.`,
  };
}

export function severityLabel(tone: "info" | "warning" | "critical" | "success"): string {
  switch (tone) {
    case "critical":
      return "Critical";
    case "warning":
      return "Warning";
    case "success":
      return "OK";
    case "info":
      return "Info";
  }
}

const PAYLOAD_KEYS = [
  "errorCode",
  "errorMessage",
  "exitCode",
  "note",
  "txHash",
  "approvalDigest",
  "reason",
  "blockedReasons",
] as const;

/** Short, type-safe rendering of an event payload without dumping arbitrary JSON. */
export function summarizePayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of PAYLOAD_KEYS) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value)}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}=[${value.map((item) => String(item)).join(", ")}]`);
    }
  }
  return parts.join(" · ");
}
