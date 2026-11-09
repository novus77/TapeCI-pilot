import { createHash } from "node:crypto";

export type Hex = `0x${string}`;

const HEX_RE = /^0x[0-9a-fA-F]*$/;

export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && HEX_RE.test(value) && value.length % 2 === 0;
}

export function hexToBytes(hex: Hex | string): Uint8Array {
  const raw = String(hex).startsWith("0x") ? String(hex).slice(2) : String(hex);
  if (raw.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(raw)) {
    throw new Error(`invalid hex: ${String(hex).slice(0, 20)}`);
  }
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out as Hex;
}

/**
 * Raw-byte SHA-256. TapeOut's SiteRegistry stores `sha256Hash` as the SHA-256 of the
 * exact file bytes, NOT the Ethereum Keccak-256 (TapeKit SPEC §5, verified on fork:
 * "hello" -> 0x2cf24dba…9824, not 0x1c8aff95…).
 */
export function sha256(bytes: Uint8Array): Uint8Array {
  return createHash("sha256").update(bytes).digest();
}

export function sha256Hex(bytes: Uint8Array): Hex {
  return bytesToHex(sha256(bytes));
}

export function sha256HexOfString(value: string): Hex {
  return sha256Hex(new TextEncoder().encode(value));
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
