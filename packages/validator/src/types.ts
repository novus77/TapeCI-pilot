import type { Hex } from "@tapeci/shared";

/**
 * A single file presented to the scanner. `relativePath` is the path as it
 * appeared inside the (already safely extracted) build output; the scanner is
 * responsible for canonicalizing it.
 */
export interface ScanInputFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/** Options for both `scanArtifactFiles` and `scanArtifactDirectory`. */
export interface ScanOptions {
  /** Entry document path, relative to the artifact root. Defaults to `index.html`. */
  readonly entryPath?: string;
  /** Per-file byte limit. Defaults to the TapeOut hard limit (8,400,000). */
  readonly maxFileBytes?: number;
  /**
   * When true (default) any external `http(s)`/protocol-relative reference is a
   * hard error (TapeKit SPEC §8 "fully on-chain" policy). When false the
   * references are reported as warnings and `fullyOnChain` is false.
   */
  readonly strictOnChain?: boolean;
  /** Relative path prefixes to skip (files and whole directories), e.g. `node_modules`. */
  readonly ignore?: readonly string[];
  /** Extensions that imply a dynamic server runtime and are never publishable. */
  readonly unsupportedServerExtensions?: readonly string[];
}

/** Options after defaults have been resolved (internal, but exported for consumers). */
export interface ResolvedScanOptions {
  readonly entryPath: string;
  readonly maxFileBytes: number;
  readonly strictOnChain: boolean;
  readonly ignore: readonly string[];
  readonly unsupportedServerExtensions: readonly string[];
}

/** A scanned, canonicalized static file. */
export interface ScannedFile {
  /** Canonical NFC path (also the source path used by the release manifest). */
  readonly path: string;
  /** Canonicalized path as it appeared in the build output (equal to `path` after normalization). */
  readonly sourceRelativePath: string;
  readonly size: number;
  /** Raw SHA-256 of the exact bytes (never keccak256). */
  readonly sha256: Hex;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export type ExternalReferenceKind =
  | "html-attribute"
  | "html-meta-refresh"
  | "css-url"
  | "css-import";

/** One external reference found in a scanned HTML or CSS file. */
export interface ExternalReference {
  /** Canonical path of the file containing the reference. */
  readonly filePath: string;
  readonly kind: ExternalReferenceKind;
  /** Origin of the reference: `src`, `href`, `srcset`, `meta-refresh`, `url`, `@import`, … */
  readonly attribute: string;
  readonly url: string;
}

export interface ScanWarning {
  readonly code: "EXTERNAL_REFERENCE";
  readonly filePath: string;
  readonly message: string;
  readonly url: string;
}

/** Result of a successful artifact scan. */
export interface ScanResult {
  readonly entryPath: string;
  readonly entry: ScannedFile;
  /** Deterministically ordered by canonical path in UTF-8 byte order. */
  readonly files: readonly ScannedFile[];
  readonly totalBytes: number;
  readonly externalReferences: readonly ExternalReference[];
  readonly warnings: readonly ScanWarning[];
  /** True only when the strict policy was enforced and no external reference exists. */
  readonly fullyOnChain: boolean;
}
