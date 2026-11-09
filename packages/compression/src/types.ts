import type { Hex } from "@tapeci/shared";

export const STRATEGIES = ["original", "gzip-individual", "gzip-whole", "gzip-grouped"] as const;
export type Strategy = (typeof STRATEGIES)[number];
export const MAX_ANALYSIS_FILES = 4096;
export const MAX_DECODED_BYTES = 64 * 1024 * 1024;
/**
 * Aggregate bound on the *stored* (compressed) bytes an index may claim.
 *
 * Each object is individually capped at MAX_FILE_BYTES (8.4 MB), but 4,096 of them is ~34 GB —
 * so a hostile index could make a browser fetch tens of gigabytes before any decoded-size check
 * fires (Stage C review F4). A legitimate candidate cannot exceed the decoded bound either: a
 * gzip unit is only used when it is *smaller*, and identity units store exactly the decoded
 * bytes, so `storedBytes <= decodedBytes` per object and the total is bounded by the same 64 MiB.
 */
export const MAX_STORED_BYTES = MAX_DECODED_BYTES;

export interface PackObject {
  readonly path: string;
  readonly sha256: Hex;
  readonly encoding: "gzip" | "identity";
  readonly storedBytes: number;
  readonly decodedBytes: number;
}
export interface StoredObject extends PackObject {
  readonly bytes: Uint8Array;
}
export interface PackFile {
  readonly path: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: Hex;
  readonly objectPath: string;
  readonly offset: number;
}
export interface PackIndex {
  readonly schemaVersion: "tapeci.pack-index.v1";
  readonly strategy: Strategy;
  readonly sourceArtifactDigest: Hex;
  readonly entryPath: string;
  readonly groupingPolicy: "type-groups-v1";
  readonly encoder: { readonly name: "identity" | "gzip"; readonly node: string; readonly zlib: string; readonly level: 0 | 9 };
  readonly files: readonly PackFile[];
  readonly objects: readonly PackObject[];
}
export interface CompressionCandidate {
  readonly candidateId: Hex;
  readonly index: PackIndex;
  readonly indexBytes: Uint8Array;
  readonly objects: readonly StoredObject[];
}
export interface PreviousAnalysis {
  readonly candidates: readonly { readonly strategy: Strategy; readonly objects: readonly PackObject[] }[];
}
export interface CandidateSummary {
  readonly strategy: Strategy;
  readonly available: boolean;
  readonly reason: string | null;
  readonly candidateId: Hex | null;
  readonly storedBytes: number | null;
  readonly indexBytes: number | null;
  readonly analysisBytes: number | null;
  readonly payloadChunks: number | null;
  readonly changedObjectBytes: number | null;
  readonly reusedObjectBytes: number | null;
  readonly objects: readonly PackObject[];
}
export interface AnalysisReport {
  readonly schemaVersion: "tapeci.compression-analysis.v1";
  readonly sourceArtifactDigest: Hex;
  readonly sourceFileCount: number;
  readonly sourceBytes: number;
  readonly strictOnChain: boolean | null;
  readonly compatibility: "unverified";
  readonly estimatedFeeWei: null;
  readonly productionTotalBytes: null;
  readonly reuseEvidence: "local-history-only";
  readonly candidates: readonly CandidateSummary[];
}
export interface CompressionAnalysis {
  readonly report: AnalysisReport;
  readonly candidates: readonly CompressionCandidate[];
}
export interface AnalyzeOptions {
  readonly entryPath?: string;
  readonly previous?: PreviousAnalysis;
  readonly strictOnChain?: boolean;
}
