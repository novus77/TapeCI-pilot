import { extname } from "node:path";
import { gzipSync } from "node:zlib";
import { MAX_FILE_BYTES, assertCanonicalArtifactPath, canonicalJson, chunkCountFor, compareUtf8, sha256Hex } from "@tapeci/shared";
import type { ScannedFile } from "@tapeci/validator";
import { MAX_ANALYSIS_FILES, MAX_DECODED_BYTES, STRATEGIES, type AnalyzeOptions, type CompressionAnalysis, type CompressionCandidate, type PackFile, type PackIndex, type PackObject, type StoredObject, type Strategy } from "./types.js";

export function analyzeCompression(input: readonly ScannedFile[], options: AnalyzeOptions = {}): CompressionAnalysis {
  if (input.length === 0 || input.length > MAX_ANALYSIS_FILES) throw new Error("Invalid source file count");
  const files = [...input].sort((left, right) => compareUtf8(left.path, right.path));
  const seen = new Set<string>();
  files.forEach(file => {
    assertCanonicalArtifactPath(file.path);
    if (seen.has(file.path)) throw new Error(`Duplicate source path: ${file.path}`);
    seen.add(file.path);
    if (file.size !== file.bytes.length || file.size > MAX_FILE_BYTES) throw new Error(`Invalid source size: ${file.path}`);
    if (sha256Hex(file.bytes) !== file.sha256) throw new Error(`Source hash mismatch: ${file.path}`);
    if (file.contentType.trim() === "") throw new Error(`Missing content type: ${file.path}`);
  });
  const sourceBytes = files.reduce((total, file) => total + file.size, 0);
  if (sourceBytes > MAX_DECODED_BYTES) throw new Error("Source decoded byte limit exceeded");
  const entryPath = assertCanonicalArtifactPath(options.entryPath ?? "index.html");
  if (!seen.has(entryPath)) throw new Error(`Missing entry: ${entryPath}`);
  const sourceArtifactDigest = sourceDigest(files);
  const candidates = STRATEGIES.map(strategy => prepareCandidate(files, strategy, entryPath, sourceArtifactDigest));
  return {
    candidates: candidates.filter(candidate => candidate !== null),
    report: {
      schemaVersion: "tapeci.compression-analysis.v1", sourceArtifactDigest,
      sourceBytes, sourceFileCount: files.length, strictOnChain: options.strictOnChain ?? null,
      compatibility: "unverified", estimatedFeeWei: null, productionTotalBytes: null, reuseEvidence: "local-history-only",
      candidates: STRATEGIES.map((strategy, position) => {
        const candidate = candidates[position];
        if (!candidate) return {
          strategy, available: false, reason: "Stored object exceeds TapeOut per-file byte limit",
          candidateId: null, storedBytes: null, indexBytes: null, analysisBytes: null,
          payloadChunks: null, changedObjectBytes: null, reusedObjectBytes: null, objects: [],
        };
        const previous = options.previous?.candidates.find(item => item.strategy === strategy);
        const reusedObjectBytes = candidate.objects.filter(object => previous?.objects.some(old =>
          old.path === object.path && old.sha256 === object.sha256 && old.storedBytes === object.storedBytes,
        )).reduce((sum, object) => sum + object.storedBytes, 0);
        const storedBytes = candidate.objects.reduce((sum, object) => sum + object.storedBytes, 0);
        return {
          strategy, available: true, reason: null, candidateId: candidate.candidateId,
          storedBytes, indexBytes: candidate.indexBytes.length, analysisBytes: storedBytes + candidate.indexBytes.length,
          payloadChunks: candidate.objects.reduce((sum, object) => sum + chunkCountFor(object.storedBytes), 0),
          changedObjectBytes: storedBytes - reusedObjectBytes, reusedObjectBytes, objects: candidate.index.objects,
        };
      }),
    },
  };
}

export function sourceDigest(files: readonly Pick<PackFile, "path" | "size" | "sha256">[]) {
  return sha256Hex(Buffer.from(canonicalJson([...files].sort((left, right) => compareUtf8(left.path, right.path))
    .map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })))));
}

function prepareCandidate(files: readonly ScannedFile[], strategy: Strategy, entryPath: string, sourceArtifactDigest: PackIndex["sourceArtifactDigest"]): CompressionCandidate | null {
  const groups = new Map<string, ScannedFile[]>();
  files.forEach(file => {
    const extension = extname(file.path).toLowerCase();
    const key = strategy === "gzip-whole" ? "whole" : strategy !== "gzip-grouped" ? file.path
      : [".html", ".css"].includes(extension) ? "shell" : [".js", ".mjs"].includes(extension) ? "scripts" : "other";
    groups.set(key, [...(groups.get(key) ?? []), file]);
  });
  const objects = new Map<string, StoredObject>();
  const rows: PackFile[] = [];
  [...groups.entries()].sort(([left], [right]) => compareUtf8(left, right)).forEach(([, group]) => {
    const raw = Buffer.concat(group.map(file => file.bytes));
    const compressed = strategy === "original" ? raw : gzipSync(raw, { level: 9 });
    const encoding = strategy !== "original" && compressed.length < raw.length ? "gzip" : "identity";
    const bytes = encoding === "gzip" ? compressed : raw;
    const sha256 = sha256Hex(bytes);
    const path = `objects/${sha256.slice(2)}.${encoding === "gzip" ? "gz" : "bin"}`;
    objects.set(path, { path, sha256, encoding, storedBytes: bytes.length, decodedBytes: raw.length, bytes });
    let offset = 0;
    group.forEach(file => {
      rows.push({ path: file.path, contentType: file.contentType, size: file.size, sha256: file.sha256, objectPath: path, offset });
      offset += file.size;
    });
  });
  const stored = [...objects.values()].sort((left, right) => compareUtf8(left.path, right.path));
  if (stored.some(object => object.storedBytes > MAX_FILE_BYTES)) return null;
  const metadata: PackObject[] = stored.map(object => ({
    path: object.path, sha256: object.sha256, encoding: object.encoding, storedBytes: object.storedBytes, decodedBytes: object.decodedBytes,
  }));
  const index: PackIndex = {
    schemaVersion: "tapeci.pack-index.v1", strategy, sourceArtifactDigest, entryPath, groupingPolicy: "type-groups-v1",
    encoder: { name: strategy === "original" ? "identity" : "gzip", node: process.versions.node, zlib: process.versions.zlib ?? "unknown", level: strategy === "original" ? 0 : 9 },
    files: rows.sort((left, right) => compareUtf8(left.path, right.path)), objects: metadata,
  };
  const indexBytes = Buffer.from(canonicalJson(index));
  return { candidateId: sha256Hex(indexBytes), index, indexBytes, objects: stored };
}
