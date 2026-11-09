import type { Hex } from "@tapeci/shared";
import { CHUNK_MAX } from "../../shared/src/chunks.js";
import { MAX_PACK_INDEX_BYTES } from "./browser.js";

const PREFIX = "<!doctype html>\n<!--tapeci.pack-entry.v1\n";
const SUFFIX = "\n-->\n<meta charset=\"utf-8\"><title>Compressed TapeCI release</title><p>This release requires a compression-compatible TapeKit gateway.</p>";

export interface PackEntry {
  readonly schemaVersion: "tapeci.pack-entry.v1";
  readonly indexPath: string;
  readonly indexSha256: Hex;
  readonly indexBytes: number;
  readonly spaFallback: boolean;
}

export function buildPackEntry(input: PackEntry): Uint8Array {
  const descriptor = requireEntry(input);
  return new TextEncoder().encode(PREFIX + JSON.stringify({
    indexBytes: descriptor.indexBytes, indexPath: descriptor.indexPath,
    indexSha256: descriptor.indexSha256, schemaVersion: descriptor.schemaVersion, spaFallback: descriptor.spaFallback,
  }) + SUFFIX);
}

export function parsePackEntry(bytes: Uint8Array): PackEntry | null {
  if (new TextDecoder().decode(bytes.subarray(0, PREFIX.length)) !== PREFIX) return null;
  if (bytes.length > CHUNK_MAX) throw new Error("Pack entry byte limit exceeded");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith(SUFFIX)) throw new Error("Malformed packed entry");
  return requireEntry(JSON.parse(text.slice(PREFIX.length, -SUFFIX.length)));
}

function requireEntry(input: unknown): PackEntry {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid pack descriptor");
  const entry = input as Record<string, unknown>;
  const allowed = ["schemaVersion", "indexPath", "indexSha256", "indexBytes", "spaFallback"];
  if (Object.keys(entry).some(key => !allowed.includes(key)) || entry.schemaVersion !== "tapeci.pack-entry.v1") throw new Error("Unsupported pack descriptor schema");
  if (typeof entry.indexSha256 !== "string" || !/^0x[0-9a-f]{64}$/.test(entry.indexSha256)) throw new Error("Invalid pack index hash");
  if (entry.indexPath !== `tapeci-packs/${entry.indexSha256.slice(2)}.json`) throw new Error("Pack index path/hash mismatch");
  if (typeof entry.indexBytes !== "number" || !Number.isSafeInteger(entry.indexBytes) || entry.indexBytes < 1 || entry.indexBytes > MAX_PACK_INDEX_BYTES) throw new Error("Pack index size limit exceeded");
  if (typeof entry.spaFallback !== "boolean") throw new Error("Invalid pack fallback setting");
  return { schemaVersion: "tapeci.pack-entry.v1", indexSha256: entry.indexSha256 as Hex, indexPath: entry.indexPath, indexBytes: entry.indexBytes, spaFallback: entry.spaFallback };
}
