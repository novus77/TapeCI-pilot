import { gunzipSync } from "node:zlib";
import { sha256Hex } from "@tapeci/shared";
import type { ScannedFile } from "@tapeci/validator";
import { sourceDigest } from "./analyze.js";
import { parsePackIndex, validatePackCoverage } from "./pack-index.js";
export { parsePreviousAnalysis } from "./pack-index.js";

export function decodeCandidate(input: unknown, objectBytes: ReadonlyMap<string, Uint8Array>): ScannedFile[] {
  const index = parsePackIndex(input);
  if (objectBytes.size !== index.objects.length) throw new Error("Unexpected or missing objects");
  const decoded = new Map(index.objects.map(object => {
    const bytes = objectBytes.get(object.path);
    if (!bytes || bytes.length !== object.storedBytes) throw new Error(`Missing object or size mismatch: ${object.path}`);
    if (sha256Hex(bytes) !== object.sha256) throw new Error(`Stored object hash mismatch: ${object.path}`);
    const raw = object.encoding === "gzip" ? gunzipSync(bytes, { maxOutputLength: Math.max(1, object.decodedBytes) }) : bytes;
    if (raw.length !== object.decodedBytes) throw new Error(`Decoded object size mismatch: ${object.path}`);
    return [object.path, raw] as const;
  }));
  const files = index.files.map(file => {
    const raw = decoded.get(file.objectPath);
    if (!raw || file.offset + file.size > raw.length) throw new Error(`Invalid file range: ${file.path}`);
    const bytes = raw.slice(file.offset, file.offset + file.size);
    if (sha256Hex(bytes) !== file.sha256) throw new Error(`Decoded file hash mismatch: ${file.path}`);
    return { path: file.path, sourceRelativePath: file.path, size: file.size, contentType: file.contentType, sha256: file.sha256, bytes };
  });
  validatePackCoverage(index);
  if (sourceDigest(files) !== index.sourceArtifactDigest) throw new Error("Source artifact digest mismatch");
  return files;
}
