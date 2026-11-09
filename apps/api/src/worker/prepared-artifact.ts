import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, compareUtf8, sha256Hex, TapeCiError, type Hex } from "@tapeci/shared";
import { computeArtifactDigest, deriveReleaseId, releaseManifestHash, type ReleaseManifest } from "@tapeci/artifact";
import { collectEntryReferences, decodeEntryHtml, type PreparedRelease } from "@tapeci/release";
import { ingestArtifactTar, LocalObjectStore, objectKeyForSha256, type ObjectStore } from "@tapeci/github";
import { parsePreparationRequest, type PreparationRequest, type CompressionGatewayQualification } from "./preparation-policy.js";

const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const STUB = "<!doctype html><title>Prepared artifact data</title>";

export interface PreparedArtifactContext {
  readonly projectId: string;
  readonly repositoryId: number;
  readonly commitSha: string;
  readonly chainId: 196;
  readonly siteRegistry: Hex;
  readonly container: Hex;
  readonly sourceArtifactKey: string;
  readonly sourceArtifactSha256: Hex;
}
export interface PreparedArtifactInput {
  readonly context: PreparedArtifactContext;
  readonly request: PreparationRequest;
  readonly gateway?: CompressionGatewayQualification | null;
  readonly prepared: Pick<PreparedRelease, "manifest" | "artifactDigest" | "releaseManifestHash" | "entryBytes"> & { readonly sourceArtifactDigest?: Hex };
  readonly files: readonly { readonly sourcePath: string; readonly bytes: Uint8Array }[];
}
export type PreparedArtifactExpectedContext = Omit<
  PreparedArtifactContext,
  "sourceArtifactKey" | "sourceArtifactSha256"
> & {
  /**
   * `null` when the deployment row no longer names a raw artifact. The pin is then the root of
   * trust: the archive it names is content-addressed by that key, so its own context is what
   * the row committed to. Every other field is still compared exactly.
   */
  readonly sourceArtifactKey: string | null;
  readonly sourceArtifactSha256: Hex | null;
};

export interface PreparedArtifactExpected {
  readonly context: PreparedArtifactExpectedContext;
  readonly request: PreparationRequest;
  readonly gateway?: CompressionGatewayQualification | null;
  readonly manifestSha256: Hex | null;
}

export async function freezePreparedArtifact(store: ObjectStore, input: PreparedArtifactInput) {
  const manifest = input.prepared.manifest;
  const manifestHash = releaseManifestHash(manifest);
  if (manifestHash !== input.prepared.releaseManifestHash) fail("prepared manifest hash mismatch");
  assertManifestContext(manifest, input.context);
  const rows = [...manifest.files].sort((a, b) => compareUtf8(a.path, b.path));
  if (rows.length > MAX_FILES || new Set(input.files.map(file => file.sourcePath)).size !== input.files.length || input.files.length !== rows.length) fail("invalid prepared file coverage");
  const bySource = new Map(input.files.map(file => [file.sourcePath, file.bytes]));
  const payloads = rows.map(row => {
    const bytes = bySource.get(row.sourcePath);
    if (!bytes || bytes.length !== row.size || sha256Hex(bytes) !== row.sha256) fail("prepared bytes do not match manifest");
    return bytes;
  });
  if (payloads.reduce((total, bytes) => total + bytes.length, 0) > MAX_PAYLOAD_BYTES) fail("prepared payload limit exceeded");
  const entry = rows.find(row => row.path === manifest.entryPath);
  if (!entry || sha256Hex(input.prepared.entryBytes) !== entry.sha256) fail("prepared entry mismatch");
  assertPreparedDigests(rows, input.request, input.context.commitSha, input.prepared.artifactDigest, manifest.releaseId);
  const request = parsePreparationRequest(input.request);
  // For a compressed snapshot the source digest must be supplied by the caller: falling back to
  // `artifactDigest` would label the *physical* digest as the *logical* source identity, which is
  // precisely the confusion the two fields exist to prevent. Original mode is the one case where
  // they are the same value by definition.
  const sourceArtifactDigest =
    input.prepared.sourceArtifactDigest ??
    (request.mode === "original" ? input.prepared.artifactDigest : null);
  if (sourceArtifactDigest === null) fail("compressed prepared artifact requires a source artifact digest");
  const metadata = Buffer.from(canonicalJson({
    schemaVersion: "tapeci.prepared-artifact.v1", context: input.context,
    request, gateway: input.gateway ?? null,
    manifest, releaseManifestHash: manifestHash, artifactDigest: input.prepared.artifactDigest,
    sourceArtifactDigest,
  }));
  if (metadata.length > MAX_METADATA_BYTES) fail("prepared metadata limit exceeded");
  const temporary = await mkdtemp(join(tmpdir(), "tapeci-freeze-"));
  try {
    await mkdir(join(temporary, "files"));
    await writeFile(join(temporary, "index.html"), STUB);
    await writeFile(join(temporary, "prepared.json"), metadata);
    for (const [position, bytes] of payloads.entries()) await writeFile(join(temporary, payloadPath(position)), bytes, { mode: 0o644 });
    const { c } = await import("tar");
    const archive = join(temporary, "prepared.tar");
    const entries = ["index.html", "prepared.json", ...payloads.map((_, position) => payloadPath(position))];
    await Promise.all(entries.map(path => chmod(join(temporary, path), 0o644)));
    await c({ cwd: temporary, file: archive, portable: true, noMtime: true }, entries);
    const bytes = await readFile(archive);
    const hash = sha256Hex(bytes);
    const key = objectKeyForSha256(hash);
    await store.put(key, bytes);
    return { key, sha256: hash, manifestSha256: manifestHash };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function loadPreparedArtifact(store: ObjectStore, key: string, expected: PreparedArtifactExpected) {
  const archive = await store.get(key);
  if (objectKeyForSha256(sha256Hex(archive)) !== key) fail("prepared archive identity mismatch");
  const temporary = await mkdtemp(join(tmpdir(), "tapeci-thaw-"));
  try {
    const ingested = await ingestArtifactTar({ bytes: archive, destinationDir: join(temporary, "extracted"), objectStore: new LocalObjectStore(join(temporary, "objects")), strictOnChain: false, limits: { maxEntries: MAX_FILES + 4, maxTotalBytes: MAX_PAYLOAD_BYTES + MAX_METADATA_BYTES + STUB.length } });
    const metadataFile = ingested.files.find(file => file.path === "prepared.json");
    if (!metadataFile || metadataFile.size > MAX_METADATA_BYTES) fail("missing or oversized prepared metadata");
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataFile.bytes));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid prepared metadata");
    const metadata = raw as Record<string, unknown>;
    if (metadata.schemaVersion !== "tapeci.prepared-artifact.v1" || Object.keys(metadata).some(key => !["schemaVersion", "context", "request", "gateway", "manifest", "releaseManifestHash", "artifactDigest", "sourceArtifactDigest"].includes(key))) fail("unsupported prepared metadata");
    if (!contextMatches(expected.context, metadata.context as PreparedArtifactContext) || canonicalJson(metadata.gateway) !== canonicalJson(expected.gateway ?? null)) fail("prepared context mismatch");
    if (canonicalJson(parsePreparationRequest(metadata.request)) !== canonicalJson(expected.request)) fail("prepared request context mismatch");
    const manifest = metadata.manifest as ReleaseManifest;
    const manifestHash = releaseManifestHash(manifest);
    if (metadata.releaseManifestHash !== manifestHash || (expected.manifestSha256 !== null && expected.manifestSha256 !== manifestHash)) fail("prepared manifest identity mismatch");
    assertManifestContext(manifest, expected.context);
    const rows = [...manifest.files].sort((a, b) => compareUtf8(a.path, b.path));
    if (rows.length > MAX_FILES || ingested.files.length !== rows.length + 2) fail("prepared archive file coverage mismatch");
    const byPath = new Map(ingested.files.map(file => [file.path, file]));
    if (new TextDecoder().decode(byPath.get("index.html")?.bytes) !== STUB) fail("invalid prepared archive stub");
    const files = rows.map((row, position) => {
      const file = byPath.get(payloadPath(position));
      if (!file || file.size !== row.size || file.sha256 !== row.sha256) fail("prepared physical file mismatch");
      return { sourcePath: row.sourcePath, bytes: new Uint8Array(file.bytes) };
    });
    const entryPosition = rows.findIndex(row => row.path === manifest.entryPath);
    const entryBytes = files[entryPosition]?.bytes;
    if (!entryBytes) fail("prepared entry missing");
    const entryHtml = decodeEntryHtml(entryBytes);
    if (typeof metadata.artifactDigest !== "string" || !/^0x[0-9a-f]{64}$/.test(metadata.artifactDigest) || typeof metadata.sourceArtifactDigest !== "string" || !/^0x[0-9a-f]{64}$/.test(metadata.sourceArtifactDigest)) fail("invalid prepared artifact digests");
    assertPreparedDigests(rows, expected.request, expected.context.commitSha, metadata.artifactDigest as Hex, manifest.releaseId);
    const prepared: PreparedRelease = { manifest, artifactDigest: metadata.artifactDigest as Hex, releaseManifestHash: manifestHash, releaseId: manifest.releaseId, entryBytes, entryHtml, references: collectEntryReferences(entryHtml, manifest.entryPath).references };
    return { prepared, files, sourceArtifactDigest: metadata.sourceArtifactDigest as Hex };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * A compressed snapshot's claimed `artifactDigest` must be the digest OF ITS OWN ROWS.
 *
 * Without this the value was only shape-checked, so a stale or buggy freeze could carry
 * `0x0000…` while the payload hashed to something else, and that value then flows into the
 * verification report. The frozen bytes are what get published either way — which is why this
 * is P1 and not P0 — but an identity that does not describe its own content is exactly the
 * sort of thing Stage D would build a cost decision on.
 *
 * Only enforced for compressed snapshots: for original mode `artifactDigest` and `releaseId`
 * are computed over the raw source *before* the entry rewrite, so recomputing them from the
 * post-rewrite manifest rows does not generally match — it only coincides in root mode, where
 * no rewrite happens (a pre-existing inconsistency recorded as F7 in the Stage C review, not
 * something this check should paper over).
 */
function assertPreparedDigests(
  rows: readonly ReleaseManifest["files"][number][],
  request: PreparationRequest,
  commitSha: string,
  claimedArtifactDigest: Hex,
  manifestReleaseId: string,
): void {
  if (request.mode === "original") return;
  const computed = computeArtifactDigest(rows);
  if (computed.toLowerCase() !== claimedArtifactDigest.toLowerCase()) {
    fail("prepared artifact digest does not match its own manifest rows");
  }
  if (deriveReleaseId(commitSha, computed) !== manifestReleaseId) {
    fail("prepared release id does not derive from its artifact digest");
  }
}

/** Exact match on every field, except the two source fields when the row no longer knows them. */
function contextMatches(expected: PreparedArtifactExpectedContext, actual: PreparedArtifactContext): boolean {
  return (
    expected.projectId === actual.projectId &&
    expected.repositoryId === actual.repositoryId &&
    expected.commitSha === actual.commitSha &&
    expected.chainId === actual.chainId &&
    expected.siteRegistry.toLowerCase() === actual.siteRegistry.toLowerCase() &&
    expected.container.toLowerCase() === actual.container.toLowerCase() &&
    (expected.sourceArtifactKey === null || expected.sourceArtifactKey === actual.sourceArtifactKey) &&
    (expected.sourceArtifactSha256 === null ||
      expected.sourceArtifactSha256.toLowerCase() === actual.sourceArtifactSha256.toLowerCase())
  );
}

function payloadPath(position: number) { return `files/${String(position).padStart(8, "0")}.bin`; }
function assertManifestContext(manifest: ReleaseManifest, context: PreparedArtifactExpectedContext) {
  if (manifest.repositoryId !== context.repositoryId || manifest.commitSha !== context.commitSha || manifest.chainId !== context.chainId || manifest.container.toLowerCase() !== context.container.toLowerCase() || manifest.siteRegistry.toLowerCase() !== context.siteRegistry.toLowerCase()) fail("prepared manifest context mismatch");
}
function fail(message: string): never { throw new TapeCiError("PLAN_STALE", message, { retryable: false }); }
