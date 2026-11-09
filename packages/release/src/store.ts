import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TapeCiError,
  sha256Hex,
  type Hex,
} from "@tapeci/shared";
import {
  releaseManifestHash as computeManifestHash,
  type ReleaseManifest,
} from "@tapeci/artifact";
import { decodeEntryHtml, verifyEntryReferences } from "./entry-references.js";

export const RELEASE_STORE_SCHEMA_VERSION = "tapeci.release-store.v1";
const RELEASE_ID_RE = /^r-[0-9a-f]{12}-[0-9a-f]{8}$/;

export interface StoredReleaseRecord {
  readonly schemaVersion: typeof RELEASE_STORE_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly manifest: ReleaseManifest;
  readonly artifactDigest: Hex;
  readonly releaseManifestHash: Hex;
  readonly entrySha256: Hex;
  readonly entrySize: number;
  readonly entryBase64: string;
  readonly storedAt: string;
}

export interface SavedReleaseInput {
  readonly manifest: ReleaseManifest;
  readonly artifactDigest: Hex;
  readonly releaseManifestHash: Hex;
  readonly entryBytes: Uint8Array;
}

export interface LoadedRelease {
  readonly record: StoredReleaseRecord;
  readonly entryBytes: Uint8Array;
}

function fail(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new TapeCiError("INVALID_ARTIFACT", message, { retryable: false, details });
}

function validateRecord(value: unknown): StoredReleaseRecord {
  if (typeof value !== "object" || value === null) fail("release record is not an object");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RELEASE_STORE_SCHEMA_VERSION) {
    fail(`unsupported release-store schema ${String(record.schemaVersion)}`);
  }
  if (typeof record.releaseId !== "string" || !RELEASE_ID_RE.test(record.releaseId)) {
    fail(`invalid stored releaseId ${String(record.releaseId)}`);
  }
  if (typeof record.manifest !== "object" || record.manifest === null) {
    fail("stored release has no manifest");
  }
  if (typeof record.entryBase64 !== "string" || record.entryBase64.length === 0) {
    fail("stored release has no entry bytes");
  }
  return value as StoredReleaseRecord;
}

/**
 * Local, file-based release history used for rollback. One JSON document per
 * release, containing the deterministic manifest and the exact entry bytes that
 * were written on chain (entry is <= 24,000 bytes, so base64 storage is small).
 */
export class ReleaseStore {
  constructor(readonly directory: string) {}

  private pathFor(releaseId: string): string {
    if (!RELEASE_ID_RE.test(releaseId)) {
      throw new TapeCiError("INVALID_ARTIFACT", `invalid release id: ${releaseId}`);
    }
    return join(this.directory, `${releaseId}.json`);
  }

  async save(input: SavedReleaseInput): Promise<StoredReleaseRecord> {
    const { manifest, entryBytes } = input;
    const entry = manifest.files.find((file) => file.path === manifest.entryPath);
    if (entry === undefined) fail(`manifest has no entry row ${manifest.entryPath}`);
    if (entry.size !== entryBytes.length || sha256Hex(entryBytes) !== entry.sha256) {
      fail("entry bytes do not match the manifest entry row");
    }
    if (computeManifestHash(manifest) !== input.releaseManifestHash) {
      fail("releaseManifestHash does not match the manifest");
    }
    const verification = verifyEntryReferences(decodeEntryHtml(entryBytes), manifest);
    if (!verification.ok) {
      fail(`entry references files missing from the manifest: ${verification.missing.join(", ")}`, {
        missing: verification.missing,
      });
    }
    const record: StoredReleaseRecord = {
      schemaVersion: RELEASE_STORE_SCHEMA_VERSION,
      releaseId: manifest.releaseId,
      manifest,
      artifactDigest: input.artifactDigest,
      releaseManifestHash: input.releaseManifestHash,
      entrySha256: entry.sha256,
      entrySize: entry.size,
      entryBase64: Buffer.from(entryBytes).toString("base64"),
      storedAt: new Date().toISOString(),
    };
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.pathFor(manifest.releaseId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
  }

  async load(releaseId: string): Promise<LoadedRelease> {
    let text: string;
    try {
      text = await readFile(this.pathFor(releaseId), "utf8");
    } catch (error) {
      throw new TapeCiError("INVALID_ARTIFACT", `release not found in store: ${releaseId}`, {
        cause: error,
      });
    }
    const record = validateRecord(JSON.parse(text) as unknown);
    if (record.releaseId !== releaseId) fail("stored release id does not match the file name");
    if (computeManifestHash(record.manifest) !== record.releaseManifestHash) {
      fail("stored manifest hash does not match the manifest");
    }
    const entryBytes = new Uint8Array(Buffer.from(record.entryBase64, "base64"));
    if (entryBytes.length !== record.entrySize || sha256Hex(entryBytes) !== record.entrySha256) {
      fail("stored entry bytes do not match the stored hash/size");
    }
    return { record, entryBytes };
  }

  async list(): Promise<Array<{ releaseId: string; commitSha: string; fileCount: number }>> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }
    const out: Array<{ releaseId: string; commitSha: string; fileCount: number }> = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const releaseId = name.slice(0, -".json".length);
      if (!RELEASE_ID_RE.test(releaseId)) continue;
      try {
        const loaded = await this.load(releaseId);
        out.push({
          releaseId,
          commitSha: loaded.record.manifest.commitSha,
          fileCount: loaded.record.manifest.files.length,
        });
      } catch {
        // A corrupt record is skipped from listings; load() still reports it directly.
      }
    }
    return out;
  }
}
