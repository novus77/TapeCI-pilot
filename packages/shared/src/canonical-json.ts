import { TapeCiError } from "./errors.js";
import { compareUtf8 } from "./path.js";
import { sha256HexOfString, type Hex } from "./hash.js";

/**
 * Deterministic JSON serialization used for release manifest hashing (PRD §5.1).
 * Object keys are sorted by UTF-8 byte order; strings are NFC-normalized; no
 * timestamps or non-deterministic fields may be present in the input.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TapeCiError("INTERNAL", "canonicalJson: non-finite number");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "object":
      break;
    default:
      throw new TapeCiError("INTERNAL", `canonicalJson: unsupported type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareUtf8);
  const parts: string[] = [];
  for (const key of keys) {
    const item = record[key];
    if (item === undefined) {
      throw new TapeCiError("INTERNAL", `canonicalJson: undefined field ${key}`);
    }
    parts.push(`${JSON.stringify(key.normalize("NFC"))}:${canonicalJson(item)}`);
  }
  return `{${parts.join(",")}}`;
}

export function canonicalJsonSha256Hex(value: unknown): Hex {
  return sha256HexOfString(canonicalJson(value));
}
