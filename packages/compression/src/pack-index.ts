import { MAX_FILE_BYTES } from "../../shared/src/chunks.js";
import { assertCanonicalArtifactPath } from "../../shared/src/path.js";
import type { Hex } from "@tapeci/shared";
import { MAX_ANALYSIS_FILES, MAX_DECODED_BYTES, MAX_STORED_BYTES, STRATEGIES, type PackIndex, type PackObject, type PreviousAnalysis, type Strategy } from "./types.js";

export function parsePreviousAnalysis(input: unknown): PreviousAnalysis {
  const report = record(input);
  if (report.schemaVersion !== "tapeci.compression-analysis.v1") throw new Error("Unsupported previous analysis schema");
  const candidates = array(report.candidates, STRATEGIES.length).map(input => {
    const candidate = record(input);
    const strategy = parseStrategy(candidate.strategy);
    if (typeof candidate.available !== "boolean") throw new Error("Invalid previous candidate availability");
    const objects = parseObjects(candidate.objects);
    if (!candidate.available && objects.length !== 0) throw new Error("Unavailable candidate contains objects");
    return { strategy, objects };
  });
  if (new Set(candidates.map(candidate => candidate.strategy)).size !== candidates.length) throw new Error("Duplicate previous strategy");
  return { candidates };
}

export function parsePackIndex(input: unknown): PackIndex {
  const index = record(input);
  keys(index, ["schemaVersion", "strategy", "sourceArtifactDigest", "entryPath", "groupingPolicy", "encoder", "files", "objects"]);
  if (index.schemaVersion !== "tapeci.pack-index.v1") throw new Error("Unsupported pack index schema");
  const strategy = parseStrategy(index.strategy);
  if (index.groupingPolicy !== "type-groups-v1") throw new Error("Unsupported grouping policy");
  const encoder = record(index.encoder);
  keys(encoder, ["name", "node", "zlib", "level"]);
  if (encoder.name !== (strategy === "original" ? "identity" : "gzip") || encoder.level !== (strategy === "original" ? 0 : 9)) throw new Error("Unsupported encoder");
  const objects = parseObjects(index.objects);
  if (objects.reduce((sum, object) => sum + object.decodedBytes, 0) > MAX_DECODED_BYTES) throw new Error("Decoded byte limit exceeded");
  const files = array(index.files, MAX_ANALYSIS_FILES).map(input => {
    const file = record(input);
    keys(file, ["path", "contentType", "size", "sha256", "objectPath", "offset"]);
    return {
      path: assertCanonicalArtifactPath(string(file.path)), contentType: string(file.contentType),
      size: integer(file.size, MAX_FILE_BYTES), sha256: hash(file.sha256),
      objectPath: string(file.objectPath), offset: integer(file.offset, MAX_DECODED_BYTES),
    };
  });
  if (files.length === 0 || new Set(files.map(file => file.path)).size !== files.length) throw new Error("Empty or duplicate file paths");
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_DECODED_BYTES) throw new Error("Logical decoded byte limit exceeded");
  if (files.some(file => !objects.some(object => object.path === file.objectPath))) throw new Error("Missing mapped object");
  const entryPath = assertCanonicalArtifactPath(string(index.entryPath));
  if (!files.some(file => file.path === entryPath)) throw new Error("Missing entry file");
  return {
    schemaVersion: "tapeci.pack-index.v1", strategy, sourceArtifactDigest: hash(index.sourceArtifactDigest),
    groupingPolicy: "type-groups-v1", entryPath,
    encoder: { name: strategy === "original" ? "identity" : "gzip", level: strategy === "original" ? 0 : 9, node: string(encoder.node), zlib: string(encoder.zlib) },
    files, objects,
  };
}

function parseObjects(input: unknown): PackObject[] {
  const objects = array(input, MAX_ANALYSIS_FILES).map((input): PackObject => {
    const object = record(input);
    keys(object, ["path", "sha256", "encoding", "storedBytes", "decodedBytes"]);
    if (object.encoding !== "identity" && object.encoding !== "gzip") throw new Error("Unsupported object encoding");
    const encoding = object.encoding;
    const sha256 = hash(object.sha256);
    const path = string(object.path);
    if (path !== `objects/${sha256.slice(2)}.${encoding === "gzip" ? "gz" : "bin"}`) throw new Error("Object path/hash mismatch");
    return { path, sha256, encoding, storedBytes: integer(object.storedBytes, MAX_FILE_BYTES), decodedBytes: integer(object.decodedBytes, MAX_DECODED_BYTES) };
  });
  if (new Set(objects.map(object => object.path)).size !== objects.length) throw new Error("Duplicate object paths");
  // Bound the bytes a client is asked to FETCH, not just the bytes it decodes to. An absolute
  // cap alone still lets an index declare 64 MB of objects that decode to eight bytes; tying the
  // stored total to the decoded total (with one file's worth of slack for an incompressible unit)
  // keeps the two in proportion while accepting every candidate the analyzer can emit.
  const decodedTotal = objects.reduce((sum, object) => sum + object.decodedBytes, 0);
  const storedTotal = objects.reduce((sum, object) => sum + object.storedBytes, 0);
  if (storedTotal > Math.max(MAX_FILE_BYTES, decodedTotal) || storedTotal > MAX_STORED_BYTES) {
    throw new Error("Stored byte limit exceeded");
  }
  return objects;
}

function parseStrategy(input: unknown): Strategy {
  const strategy = STRATEGIES.find(strategy => strategy === input);
  if (!strategy) throw new Error("Unsupported compression strategy");
  return strategy;
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected index object");
  return input as Record<string, unknown>;
}
function keys(input: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Unknown index field");
}
function array(input: unknown, max: number): unknown[] {
  if (!Array.isArray(input) || input.length > max) throw new Error("Invalid array or count limit exceeded");
  return input;
}
function string(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new Error("Expected nonempty string");
  return input;
}
function integer(input: unknown, max: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 || input > max) throw new Error("Invalid size or offset limit");
  return input;
}
function hash(input: unknown): Hex {
  if (typeof input !== "string" || !/^0x[0-9a-f]{64}$/.test(input)) throw new Error("Invalid SHA-256 hash");
  return input as Hex;
}

export function validatePackCoverage(index: PackIndex): void {
  index.objects.forEach(object => {
    const intervals = index.files.filter(file => file.objectPath === object.path).sort((a, b) => a.offset - b.offset);
    if (intervals.length === 0) throw new Error(`Unreferenced object: ${object.path}`);
    let end = 0;
    intervals.forEach(file => {
      if (file.offset > end || file.offset + file.size > object.decodedBytes) throw new Error(`Invalid mapped range: ${object.path}`);
      end = Math.max(end, file.offset + file.size);
    });
    if (end !== object.decodedBytes) throw new Error(`Unmapped trailing decoded bytes: ${object.path}`);
  });
}
