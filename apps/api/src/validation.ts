import { ApiError } from "./errors.js";

export function recordBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_BODY", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function stringField(
  record: Record<string, unknown>,
  name: string,
  options: { optional?: boolean; maxLength?: number } = {},
): string | undefined {
  const value = record[name];
  if (value === undefined || value === null) {
    if (options.optional === true) return undefined;
    throw new ApiError(400, "INVALID_BODY", `${name} is required`);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "INVALID_BODY", `${name} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (options.maxLength !== undefined && trimmed.length > options.maxLength) {
    throw new ApiError(400, "INVALID_BODY", `${name} is too long`);
  }
  return trimmed;
}

export function integerField(record: Record<string, unknown>, name: string): number {
  const value = record[name];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, "INVALID_BODY", `${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Parse a non-negative wei amount from a JSON body value. Rejects anything that is
 * not a decimal integer (or a safe-integer number) with a 400 instead of letting
 * `BigInt()`/`Number()` throw a raw SyntaxError that surfaces as a 500.
 */
export function positiveWei(value: unknown, name: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new ApiError(400, "INVALID_BODY", `${name} must be a non-negative wei amount`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ApiError(400, "INVALID_BODY", `${name} must be a non-negative wei amount`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new ApiError(400, "INVALID_BODY", `${name} must be a non-negative wei amount`);
}
