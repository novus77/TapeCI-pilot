import {
  CHUNK_MAX,
  MAX_FILE_BYTES,
  TapeCiError,
  canonicalJson,
  canonicalizeArtifactPath,
  chunkCountFor,
  compareUtf8,
  sha256HexOfString,
  type Hex,
} from "@tapeci/shared";
import {
  DEFAULT_ENTRY_PATH,
  DEFAULT_PATH_PREFIX,
  MANIFEST_SCHEMA_VERSION,
  TAPEOUT_CHAIN_ID,
  type BuildManifestFilesOptions,
  type BuildReleaseManifestInput,
  type BuildReleaseManifestResult,
  type ManifestFile,
  type ManifestSourceFile,
  type ReleaseManifest,
} from "./types.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const RELEASE_ID_RE = /^r-[0-9a-f]{12}-[0-9a-f]{8}$/;
const SHA256_RE = /^0x[0-9a-fA-F]{64}$/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

const PREFIX_PROBE = "tapeci-path-prefix-probe.bin";
const PREFIX_PROBE_SUFFIX = `/${PREFIX_PROBE}`;

const MANIFEST_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "chainId",
  "siteRegistry",
  "container",
  "repositoryId",
  "commitSha",
  "releaseId",
  "entryPath",
  "fallbackPath",
  "files",
]);

const MANIFEST_FILE_KEYS: ReadonlySet<string> = new Set([
  "path",
  "sourcePath",
  "size",
  "sha256",
  "contentType",
  "chunks",
]);

function fail(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new TapeCiError("INVALID_ARTIFACT", message, { retryable: false, details });
}

/** Strict canonical artifact path: absolute/Windows paths are rejected, not silently rewritten. */
function canonicalArtifactPath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    fail("artifact path must be a non-empty string", { path: String(raw) });
  }
  if (raw.startsWith("/") || raw.startsWith("\\") || WINDOWS_DRIVE_RE.test(raw)) {
    fail(`artifact path must be relative to the build output: ${JSON.stringify(raw)}`, { path: raw });
  }
  try {
    return canonicalizeArtifactPath(raw);
  } catch (error) {
    if (error instanceof TapeCiError) fail(error.message, { path: raw, reason: error.code });
    throw error;
  }
}

function normalizeAddress(value: string, field: string): Hex {
  if (!ADDRESS_RE.test(value)) {
    fail(`${field} must be a 20-byte hex address, got ${JSON.stringify(value)}`, { field, value });
  }
  return value.toLowerCase() as Hex;
}

function assertChainId(value: number): typeof TAPEOUT_CHAIN_ID {
  if (value !== TAPEOUT_CHAIN_ID) {
    fail(`chainId must be ${TAPEOUT_CHAIN_ID} (X Layer), got ${String(value)}`, { chainId: value });
  }
  return TAPEOUT_CHAIN_ID;
}

function assertCommitSha(value: string): string {
  if (!COMMIT_SHA_RE.test(value)) {
    fail(`commitSha must be a 40-character lowercase hex commit SHA, got ${JSON.stringify(value)}`, {
      commitSha: value,
    });
  }
  return value;
}

function assertRepositoryId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`repositoryId must be a positive integer, got ${String(value)}`, { repositoryId: value });
  }
  return value;
}

function assertReleaseId(value: string): string {
  if (!RELEASE_ID_RE.test(value)) {
    fail(`releaseId must look like r-<12 lowercase hex>-<8 lowercase hex>, got ${JSON.stringify(value)}`, {
      releaseId: value,
    });
  }
  return value;
}

function normalizeSha256(value: string, field: string): Hex {
  if (!SHA256_RE.test(value)) {
    fail(`${field} must be a 32-byte hex SHA-256, got ${JSON.stringify(value)}`, { field });
  }
  return value.toLowerCase() as Hex;
}

function normalizeContentType(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("contentType must be a non-empty MIME type", { contentType: String(value) });
  }
  return value.trim();
}

function assertSize(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`file size must be a non-negative integer for ${path}, got ${String(value)}`, {
      path,
      size: value,
    });
  }
  if (value > MAX_FILE_BYTES) {
    throw new TapeCiError(
      "FILE_TOO_LARGE",
      `artifact file ${path} is ${value} bytes, TapeOut allows at most ${MAX_FILE_BYTES}`,
      { retryable: false, details: { path, size: value, max: MAX_FILE_BYTES } },
    );
  }
  return value;
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.trimStart().toLowerCase().startsWith("text/html");
}

interface NormalizedSource {
  readonly path: string;
  readonly size: number;
  readonly sha256: Hex;
  readonly contentType: string;
}

function normalizeSourceFiles(files: readonly ManifestSourceFile[]): NormalizedSource[] {
  if (files.length === 0) fail("artifact must contain at least one file", {});
  const byPath = new Map<string, NormalizedSource>();
  for (const file of files) {
    const path = canonicalArtifactPath(file.path);
    const size = assertSize(file.size, path);
    const sha256 = normalizeSha256(file.sha256, "sha256");
    const contentType = normalizeContentType(file.contentType);
    if (byPath.has(path)) fail(`duplicate artifact source path "${path}"`, { path });
    byPath.set(path, { path, size, sha256, contentType });
  }
  return [...byPath.values()].sort((left, right) => compareUtf8(left.path, right.path));
}

function canonicalPathPrefix(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) {
    fail("pathPrefix must be a non-empty relative path", { pathPrefix: raw });
  }
  if (value.startsWith("/") || value.startsWith("\\") || WINDOWS_DRIVE_RE.test(value)) {
    fail(`pathPrefix must be relative: ${JSON.stringify(raw)}`, { pathPrefix: raw });
  }
  const canonicalProbe = canonicalArtifactPath(`${value.replace(/\/+$/, "")}${PREFIX_PROBE_SUFFIX}`);
  if (!canonicalProbe.endsWith(PREFIX_PROBE_SUFFIX)) {
    fail(`pathPrefix could not be canonicalized: ${JSON.stringify(raw)}`, { pathPrefix: raw });
  }
  const prefix = canonicalProbe.slice(0, -PREFIX_PROBE_SUFFIX.length);
  if (prefix.length === 0) {
    fail(`pathPrefix must not be empty: ${JSON.stringify(raw)}`, { pathPrefix: raw });
  }
  return prefix;
}

function assertNoUnknownKeys(
  record: object,
  allowed: ReadonlySet<string>,
  what: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail(
        `${what} contains unexpected field "${key}"; release manifests must not include timestamps, gas estimates, or other dynamic data`,
        { field: key },
      );
    }
  }
}

/**
 * Deterministic SHA-256 over the artifact content: canonical JSON of
 * `{path,size,sha256}` rows sorted by UTF-8 path order. It deliberately ignores
 * input order, contentType, and chunking, so a re-mapped release (new paths) can
 * still be recognized as the same content.
 */
export function computeArtifactDigest(files: readonly ManifestSourceFile[]): Hex {
  const sources = normalizeSourceFiles(files);
  return sha256HexOfString(
    canonicalJson(sources.map((source) => ({ path: source.path, size: source.size, sha256: source.sha256 }))),
  );
}

/** `r-<12 hex commit>-<8 hex artifact digest>` (PRD §5.1 stable release id). */
export function deriveReleaseId(commitSha: string, artifactDigest: string): string {
  const commit = assertCommitSha(commitSha);
  const digest = normalizeSha256(artifactDigest, "artifactDigest");
  return `r-${commit.slice(0, 12)}-${digest.slice(2, 10)}`;
}

/**
 * Map scanned source files to manifest rows: `entryPath` stays unversioned and
 * immutable assets become `${pathPrefix}/${releaseId}/${sourcePath}`. Rows are
 * sorted by target path in UTF-8 byte order and target paths are unique.
 */
export function buildManifestFiles(
  scanFiles: readonly ManifestSourceFile[],
  options: BuildManifestFilesOptions,
): readonly ManifestFile[] {
  const entryPath = canonicalArtifactPath(options.entryPath ?? DEFAULT_ENTRY_PATH);
  const releaseId = assertReleaseId(options.releaseId);
  const pathPrefix = canonicalPathPrefix(options.pathPrefix ?? DEFAULT_PATH_PREFIX);
  const sources = normalizeSourceFiles(scanFiles);

  const entrySource = sources.find((source) => source.path === entryPath);
  if (entrySource === undefined) {
    fail(`entry file "${entryPath}" is missing from the artifact`, {
      entryPath,
      files: sources.map((source) => source.path),
    });
  }
  if (!isHtmlContentType(entrySource.contentType)) {
    fail(`entry file "${entryPath}" must be HTML, got content type ${entrySource.contentType}`, {
      entryPath,
      contentType: entrySource.contentType,
    });
  }
  if (entrySource.size > CHUNK_MAX) {
    fail(
      `entry file "${entryPath}" is ${entrySource.size} bytes; it must be <= ${CHUNK_MAX} bytes so it can be replaced in a single transaction`,
      { entryPath, size: entrySource.size, max: CHUNK_MAX },
    );
  }

  const rows: ManifestFile[] = sources.map((source) => ({
    path:
      source.path === entryPath
        ? entryPath
        : canonicalArtifactPath(`${pathPrefix}/${releaseId}/${source.path}`),
    sourcePath: source.path,
    size: source.size,
    sha256: source.sha256,
    contentType: source.contentType,
    chunks: chunkCountFor(source.size),
  }));
  rows.sort((left, right) => compareUtf8(left.path, right.path));

  const targets = new Set<string>();
  for (const row of rows) {
    if (targets.has(row.path)) {
      fail(`duplicate manifest target path "${row.path}"`, { path: row.path });
    }
    targets.add(row.path);
  }
  return rows;
}

function normalizeManifestFile(row: ManifestFile): ManifestFile {
  assertNoUnknownKeys(row, MANIFEST_FILE_KEYS, "manifest file row");
  const path = canonicalArtifactPath(row.path);
  const sourcePath = canonicalArtifactPath(row.sourcePath);
  const size = assertSize(row.size, path);
  const sha256 = normalizeSha256(row.sha256, "sha256");
  const contentType = normalizeContentType(row.contentType);
  const chunks = chunkCountFor(size);
  if (row.chunks !== chunks) {
    fail(`manifest file "${path}" declares ${row.chunks} chunk(s) but ${size} bytes require ${chunks}`, {
      path,
      chunks: row.chunks,
      expected: chunks,
    });
  }
  return { path, sourcePath, size, sha256, contentType, chunks };
}

/**
 * Deterministic hash of a release manifest (PRD §5.1). Only the v1 schema fields
 * are hashed; timestamps/gas or any other unknown dynamic field is rejected so
 * the same bytes always produce the same `releaseManifestHash`.
 */
export function releaseManifestHash(manifest: ReleaseManifest): Hex {
  assertNoUnknownKeys(manifest, MANIFEST_KEYS, "release manifest");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(`unsupported manifest schemaVersion: ${String(manifest.schemaVersion)}`, {
      schemaVersion: manifest.schemaVersion,
    });
  }
  const files = manifest.files
    .map((file) => normalizeManifestFile(file))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const targets = new Set<string>();
  for (const file of files) {
    if (targets.has(file.path)) fail(`duplicate manifest target path "${file.path}"`, { path: file.path });
    targets.add(file.path);
  }
  const entryPath = canonicalArtifactPath(manifest.entryPath);
  const entryRow = files.find((file) => file.path === entryPath);
  if (entryRow === undefined) {
    fail(`manifest entry file "${entryPath}" is not present in files`, { entryPath });
  }
  if (entryRow.chunks !== 1) {
    fail(`manifest entry file "${entryPath}" must occupy exactly one chunk`, {
      entryPath,
      chunks: entryRow.chunks,
    });
  }
  const normalized: ReleaseManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    chainId: assertChainId(manifest.chainId),
    siteRegistry: normalizeAddress(manifest.siteRegistry, "siteRegistry"),
    container: normalizeAddress(manifest.container, "container"),
    repositoryId: assertRepositoryId(manifest.repositoryId),
    commitSha: assertCommitSha(manifest.commitSha),
    releaseId: assertReleaseId(manifest.releaseId),
    entryPath,
    fallbackPath: canonicalArtifactPath(manifest.fallbackPath),
    files,
  };
  return sha256HexOfString(canonicalJson(normalized));
}

/**
 * Build the deterministic release manifest v1 and its two content hashes:
 * - `artifactDigest`: what content is being released (independent of paths policy)
 * - `releaseManifestHash`: what exact on-chain plan was approved (no dynamic fields)
 *
 * The approval digest (EIP-712) is intentionally *not* built here; it is the
 * deployer's concern once the cost ceiling and operator nonce are known.
 */
export function buildReleaseManifest(input: BuildReleaseManifestInput): BuildReleaseManifestResult {
  const chainId = assertChainId(input.chainId);
  const siteRegistry = normalizeAddress(input.siteRegistry, "siteRegistry");
  const container = normalizeAddress(input.container, "container");
  const repositoryId = assertRepositoryId(input.repositoryId);
  const commitSha = assertCommitSha(input.commitSha);
  const entryPath = canonicalArtifactPath(input.entryPath ?? DEFAULT_ENTRY_PATH);
  const fallbackPath = canonicalArtifactPath(input.fallbackPath ?? entryPath);
  const pathPrefix = canonicalPathPrefix(input.pathPrefix ?? DEFAULT_PATH_PREFIX);
  const artifactDigest = computeArtifactDigest(input.files);
  const releaseId =
    input.releaseId === undefined
      ? deriveReleaseId(commitSha, artifactDigest)
      : assertReleaseId(input.releaseId);
  const files = buildManifestFiles(input.files, { entryPath, pathPrefix, releaseId });
  const manifest: ReleaseManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    chainId,
    siteRegistry,
    container,
    repositoryId,
    commitSha,
    releaseId,
    entryPath,
    fallbackPath,
    files,
  };
  return {
    manifest,
    artifactDigest,
    releaseManifestHash: releaseManifestHash(manifest),
    canonicalJson: canonicalJson(manifest),
  };
}
