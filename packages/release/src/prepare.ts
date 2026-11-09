import type { ArtifactFile } from "@tapeci/shared";
import {
  CHUNK_MAX,
  TapeCiError,
  canonicalizeArtifactPath,
  chunkCountFor,
  compareUtf8,
  sha256Hex,
  type Hex,
} from "@tapeci/shared";
import {
  computeArtifactDigest,
  deriveReleaseId,
  releaseManifestHash,
  type ManifestFile,
  type ReleaseManifest,
} from "@tapeci/artifact";
import {
  decodeEntryHtml,
  encodeEntryHtml,
  rewriteEntryReferences,
  verifyEntryReferences,
  type EntryReference,
} from "./entry-references.js";

export interface PrepareReleaseInput {
  /** Scanned build files (canonical paths + raw bytes). */
  readonly files: readonly ArtifactFile[];
  readonly chainId: 196;
  readonly siteRegistry: Hex;
  readonly container: Hex;
  readonly repositoryId: number;
  readonly commitSha: string;
  readonly entryPath?: string;
  readonly fallbackPath?: string;
  /**
   * Directory prefix for versioned assets. `"releases"` (default) keeps every
   * release immutable at /releases/<id>/..., which is safe but incompatible with
   * sites that load files at runtime or use relative paths across pages. `""`
   * publishes files at their own paths (root mode) so a plain multi-page or SPA
   * build works unchanged; such a release overwrites the previous one in place.
   */
  readonly pathPrefix?: string;
}

export interface PreparedRelease {
  readonly manifest: ReleaseManifest;
  /** Digest of the *source* build (entry before reference rewriting). */
  readonly artifactDigest: Hex;
  readonly releaseManifestHash: Hex;
  readonly releaseId: string;
  /** Entry bytes after versioned-reference rewriting — this is what goes on chain. */
  readonly entryBytes: Uint8Array;
  readonly entryHtml: string;
  readonly references: readonly EntryReference[];
}

function defaultReleaseId(commitSha: string, artifactDigest: Hex): string {
  return deriveReleaseId(commitSha, artifactDigest);
}

/**
 * Prepare a release whose entry document references versioned asset paths.
 *
 * The release id is derived from the **source** build digest (so it is stable and
 * cannot depend on itself); the entry HTML is then rewritten to
 * `/${pathPrefix}/${releaseId}/${sourcePath}`, the rewritten entry is hashed and
 * becomes the `index.html` manifest row.
 */
export function prepareVersionedRelease(input: PrepareReleaseInput): PreparedRelease {
  const entryPath = canonicalizeArtifactPath(input.entryPath ?? "index.html");
  const fallbackPath = canonicalizeArtifactPath(input.fallbackPath ?? entryPath);
  const rawPrefix = input.pathPrefix ?? "releases";
  const rootMode = rawPrefix.trim() === "";
  const pathPrefix = rootMode ? "" : canonicalizeArtifactPath(rawPrefix);
  const entryFile = input.files.find((file) => file.path === entryPath);
  if (entryFile === undefined) {
    throw new TapeCiError("INVALID_ARTIFACT", `entry file ${entryPath} is missing`);
  }
  if (!entryFile.contentType.toLowerCase().startsWith("text/html")) {
    throw new TapeCiError(
      "INVALID_ARTIFACT",
      `entry file ${entryPath} must be HTML, got ${entryFile.contentType}`,
    );
  }
  const sourceFiles = input.files.map((file) => ({
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    contentType: file.contentType,
  }));
  const artifactDigest = computeArtifactDigest(sourceFiles);
  const releaseId = defaultReleaseId(input.commitSha, artifactDigest);

  const entryHtml = decodeEntryHtml(entryFile.bytes);
  const rewritten = rootMode
    ? { html: entryHtml, references: [], unresolved: [] as string[] }
    : rewriteEntryReferences({
        html: entryHtml,
        entryPath,
        releaseId,
        pathPrefix,
        sourcePaths: input.files.map((file) => file.path),
      });
  const entryBytes = encodeEntryHtml(rewritten.html);
  if (entryBytes.length > CHUNK_MAX) {
    throw new TapeCiError(
      "INVALID_ARTIFACT",
      `rewritten entry ${entryPath} is ${entryBytes.length} bytes, above the ${CHUNK_MAX}-byte single-transaction limit`,
      { details: { size: entryBytes.length } },
    );
  }
  const entrySha256 = sha256Hex(entryBytes);

  const rows: ManifestFile[] = input.files.map((file) => {
    const isEntry = file.path === entryPath;
    return {
      path: isEntry
        ? entryPath
        : rootMode
          ? file.path
          : canonicalizeArtifactPath(`${pathPrefix}/${releaseId}/${file.path}`),
      sourcePath: file.path,
      size: isEntry ? entryBytes.length : file.size,
      sha256: isEntry ? entrySha256 : file.sha256,
      contentType: file.contentType,
      chunks: isEntry ? 1 : chunkCountFor(file.size),
    };
  });
  rows.sort((left, right) => compareUtf8(left.path, right.path));

  const manifest: ReleaseManifest = {
    schemaVersion: "tapeci.release.v1",
    chainId: 196,
    siteRegistry: input.siteRegistry.toLowerCase() as Hex,
    container: input.container.toLowerCase() as Hex,
    repositoryId: input.repositoryId,
    commitSha: input.commitSha,
    releaseId,
    entryPath,
    fallbackPath,
    files: rows,
  };
  const verification = verifyEntryReferences(rewritten.html, manifest);
  if (!verification.ok) {
    throw new TapeCiError(
      "INVALID_ARTIFACT",
      `rewritten entry references files missing from the manifest: ${verification.missing.join(", ")}`,
      { details: { missing: verification.missing, external: verification.external } },
    );
  }
  return {
    manifest,
    artifactDigest,
    releaseManifestHash: releaseManifestHash(manifest),
    releaseId,
    entryBytes,
    entryHtml: rewritten.html,
    references: rewritten.references,
  };
}
