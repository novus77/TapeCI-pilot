import { getAddress, type Hex } from "viem";
import { TapeCiError } from "@tapeci/shared";

export const REAL_INTEGRATION_SCHEMA_VERSION = 1 as const;
export const XLAYER_CHAIN_ID = 196 as const;

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\s+/gu, " ").slice(0, 500);
  }
  return String(error).replace(/\s+/gu, " ").slice(0, 500);
}

export function requireRealIntegrationOptIn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (env.TAPECI_REAL_INTEGRATION !== "1") {
    throw new TapeCiError(
      "INVALID_CONFIG",
      "real integration is disabled; set TAPECI_REAL_INTEGRATION=1 for read-only network evidence",
      {
        details: {
          requiredEnvironment: { TAPECI_REAL_INTEGRATION: "1" },
          writeActionsPerformed: false,
        },
      },
    );
  }
}

export function normalizeAddress(value: string, field: string): Hex {
  try {
    return getAddress(value);
  } catch {
    throw new TapeCiError("INVALID_CONFIG", `${field} must be a 20-byte hex address`, {
      details: { field },
    });
  }
}

export function normalizeHash(value: string, field: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new TapeCiError("INVALID_CONFIG", `${field} must be a 32-byte hex value`, {
      details: { field },
    });
  }
  return value.toLowerCase() as Hex;
}

export function safeUrlEvidence(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function safeRpcHost(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    url = new URL(`https://${raw}`);
  }
  return url.hostname;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function unixSecondsToIso(seconds: bigint): string | null {
  if (seconds <= 0n || seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) return null;
  return new Date(Number(seconds) * 1000).toISOString();
}
