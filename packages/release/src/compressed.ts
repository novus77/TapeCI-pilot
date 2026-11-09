import { buildPackEntry, decodeCandidate, type CompressionCandidate } from "@tapeci/compression";
import { computeArtifactDigest, deriveReleaseId, releaseManifestHash, type ReleaseManifest } from "@tapeci/artifact";
import { canonicalJson, chunkCountFor, compareUtf8, sha256Hex, type ArtifactFile, type Hex } from "@tapeci/shared";

export interface PrepareCompressedReleaseInput {
  readonly candidate: CompressionCandidate;
  readonly chainId: 196;
  readonly siteRegistry: Hex;
  readonly container: Hex;
  readonly repositoryId: number;
  readonly commitSha: string;
  readonly spaFallback?: boolean;
}

/** Offline physical-byte preparation only; this does not enable production compressed publishing. */
export function prepareCompressedRelease(input: PrepareCompressedReleaseInput) {
  const candidate = input.candidate;
  const canonicalBytes = Buffer.from(canonicalJson(candidate.index));
  if (!canonicalBytes.equals(Buffer.from(candidate.indexBytes)) || sha256Hex(canonicalBytes) !== candidate.candidateId) throw new Error("Candidate index identity mismatch");
  const sourceFiles = decodeCandidate(candidate.index, new Map(candidate.objects.map(object => [object.path, object.bytes])));
  if (candidate.index.entryPath !== "index.html") throw new Error("Compressed preparation currently requires index.html");
  if (sourceFiles.some(file => file.path === "sw.js" || file.path.startsWith(".tape/"))) throw new Error("Source path is reserved by the gateway");
  const indexPath = `tapeci-packs/${candidate.candidateId.slice(2)}.json`;
  const entryBytes = buildPackEntry({
    schemaVersion: "tapeci.pack-entry.v1", indexPath,
    indexSha256: candidate.candidateId, indexBytes: candidate.indexBytes.length,
    spaFallback: input.spaFallback ?? false,
  });
  const bytesByObject = new Map(candidate.objects.map(object => [object.path, object.bytes]));
  const files = [
    physicalFile("index.html", entryBytes, "text/html; charset=utf-8"),
    physicalFile(indexPath, candidate.indexBytes, "application/json"),
    ...candidate.index.objects.map(object => physicalFile(object.path, bytesByObject.get(object.path)!, "application/octet-stream")),
  ].sort((a, b) => compareUtf8(a.path, b.path));
  const artifactDigest = computeArtifactDigest(files);
  const releaseId = deriveReleaseId(input.commitSha, artifactDigest);
  const manifest: ReleaseManifest = {
    schemaVersion: "tapeci.release.v1", chainId: input.chainId,
    siteRegistry: input.siteRegistry.toLowerCase() as Hex, container: input.container.toLowerCase() as Hex,
    repositoryId: input.repositoryId, commitSha: input.commitSha, releaseId,
    entryPath: "index.html", fallbackPath: "index.html",
    files: files.map(file => ({ path: file.path, sourcePath: file.path, size: file.size, sha256: file.sha256, contentType: file.contentType, chunks: chunkCountFor(file.size) })),
  };
  return { manifest, files, entryBytes, releaseId, artifactDigest, sourceArtifactDigest: candidate.index.sourceArtifactDigest, packIndexHash: candidate.candidateId, releaseManifestHash: releaseManifestHash(manifest) };
}

function physicalFile(path: string, source: Uint8Array, contentType: string): ArtifactFile {
  const bytes = new Uint8Array(source);
  return { path, sourceRelativePath: path, bytes, contentType, size: bytes.length, sha256: sha256Hex(bytes) };
}
