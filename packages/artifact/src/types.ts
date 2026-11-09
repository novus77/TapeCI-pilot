import type { Hex } from "@tapeci/shared";

/** Schema identifier mixed into every release manifest (PRD §5.1). */
export const MANIFEST_SCHEMA_VERSION = "tapeci.release.v1" as const;
export type ManifestSchemaVersion = typeof MANIFEST_SCHEMA_VERSION;

/** X Layer chain id; TapeOut is only deployed there for this MVP. */
export const TAPEOUT_CHAIN_ID = 196 as const;
export type TapeOutChainId = typeof TAPEOUT_CHAIN_ID;

/** Default prefix for immutable, versioned asset paths. */
export const DEFAULT_PATH_PREFIX = "releases";
/** Default entry document; the only path that is switched atomically. */
export const DEFAULT_ENTRY_PATH = "index.html";

/**
 * The subset of a scanned artifact file (see `@tapeci/validator` `ScannedFile`)
 * that the manifest builder needs. Structural typing keeps this package free of
 * a runtime dependency on the validator.
 */
export interface ManifestSourceFile {
  /** Canonical NFC source path inside the build output. */
  readonly path: string;
  readonly size: number;
  /** Raw SHA-256 of the exact bytes (never keccak256). */
  readonly sha256: Hex;
  readonly contentType: string;
  /** Optional: scanned files carry bytes; the manifest never hashes them. */
  readonly bytes?: Uint8Array;
  readonly sourceRelativePath?: string;
}

/** One immutable file row of a release manifest. */
export interface ManifestFile {
  /** Target path on chain (entry is unversioned, assets are versioned). */
  readonly path: string;
  /** Original canonical path in the build output. */
  readonly sourcePath: string;
  readonly size: number;
  readonly sha256: Hex;
  readonly contentType: string;
  /** Number of 24,000-byte chunks (minimum 1). */
  readonly chunks: number;
}

/** Deterministic release manifest v1 (PRD §5.1) — no timestamps, no gas estimates. */
export interface ReleaseManifest {
  readonly schemaVersion: ManifestSchemaVersion;
  readonly chainId: TapeOutChainId;
  readonly siteRegistry: Hex;
  readonly container: Hex;
  readonly repositoryId: number;
  readonly commitSha: string;
  readonly releaseId: string;
  readonly entryPath: string;
  readonly fallbackPath: string;
  /** Sorted by target path in UTF-8 byte order. */
  readonly files: readonly ManifestFile[];
}

export interface BuildManifestFilesOptions {
  /** Defaults to `index.html`; kept unversioned. */
  readonly entryPath?: string;
  /** Defaults to `releases`; versioned target prefix. */
  readonly pathPrefix?: string;
  readonly releaseId: string;
}

export interface BuildReleaseManifestInput {
  readonly chainId: number;
  readonly siteRegistry: Hex;
  readonly container: Hex;
  readonly repositoryId: number;
  /** Full 40-character lowercase hex Git commit SHA-1. */
  readonly commitSha: string;
  readonly entryPath?: string;
  readonly fallbackPath?: string;
  readonly files: readonly ManifestSourceFile[];
  /** Optional override; defaults to `deriveReleaseId(commitSha, artifactDigest)`. */
  readonly releaseId?: string;
  /** Optional versioned-path prefix, default `releases`. */
  readonly pathPrefix?: string;
}

export interface BuildReleaseManifestResult {
  readonly manifest: ReleaseManifest;
  /** SHA-256 of canonical JSON of sorted `{path,size,sha256}` source entries. */
  readonly artifactDigest: Hex;
  /** SHA-256 of canonical JSON of the manifest (no dynamic fields). */
  readonly releaseManifestHash: Hex;
  /** The exact canonical JSON that `releaseManifestHash` covers. */
  readonly canonicalJson: string;
}
