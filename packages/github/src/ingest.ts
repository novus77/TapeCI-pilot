/**
 * P2-05: safe tar artifact ingest + content-addressed object store.
 *
 * Ingest runs in two independent phases:
 * 1. A strict header-only pass (`tar.Parser`) that rejects unsafe paths
 *    (absolute, `..`, backslashes), links, devices/FIFOs, oversized entries,
 *    oversized archives and too many entries *before* anything is written.
 * 2. Extraction into a throw-away temp directory, followed by
 *    `scanArtifactDirectory` reading the real bytes with `lstat` — entry
 *    metadata is never trusted for sizes, types or paths. The scanned byte
 *    total and file count are then cross-checked against the header claims.
 *
 * Only after validation succeeds is the original tar stored in the
 * content-addressed `LocalObjectStore` (`sha256/<hex>.tar`).
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Parser, x as extractTar, type ReadEntry } from "tar";
import {
  MAX_FILE_BYTES,
  isTapeCiError,
  sha256Hex,
  type Hex,
} from "@tapeci/shared";
import {
  scanArtifactDirectory,
  type ScanResult,
  type ScannedFile,
} from "@tapeci/validator";
import { GithubError, isGithubError } from "./errors.js";

/** Hard per-file cap from TapeOut (8,400,000 bytes). */
export const MAX_ARTIFACT_FILE_BYTES = MAX_FILE_BYTES;
/** Hard total extracted-size cap for one uploaded artifact (64 MiB). */
export const MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024;
/** Hard entry-count cap for one uploaded artifact. */
export const MAX_ARTIFACT_ENTRIES = 5_000;

export interface ArtifactLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
}

export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = {
  maxFileBytes: MAX_ARTIFACT_FILE_BYTES,
  maxTotalBytes: MAX_ARTIFACT_TOTAL_BYTES,
  maxEntries: MAX_ARTIFACT_ENTRIES,
};

/** Minimal content-addressed object store contract. */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

const OBJECT_KEY_RE = /^sha256\/([0-9a-f]{64})\.tar$/;

/** `sha256/<lowercase-hex-without-0x>.tar`, derived from the raw archive hash. */
export function objectKeyForSha256(hash: Hex | string): string {
  const hex = String(hash).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new GithubError("OBJECT_STORE_KEY_INVALID", "object key requires a SHA-256 hash");
  }
  return `sha256/${hex}.tar`;
}

function parseObjectKey(key: string): { readonly hex: string; readonly relativePath: string } {
  const match = OBJECT_KEY_RE.exec(key);
  if (match === null || match[1] === undefined) {
    throw new GithubError(
      "OBJECT_STORE_KEY_INVALID",
      "object key must look like sha256/<64 lowercase hex>.tar",
    );
  }
  return { hex: match[1], relativePath: `sha256/${match[1]}.tar` };
}

/**
 * Filesystem object store rooted at `rootDir`. Keys are content addressed, so
 * `put` refuses bytes that do not hash to the key and `get` re-verifies the
 * content hash (corruption is reported, not silently served).
 */
export class LocalObjectStore implements ObjectStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
      throw new GithubError("OBJECT_STORE_KEY_INVALID", "object store root directory is required");
    }
    this.rootDir = resolve(rootDir);
  }

  /** Absolute path of an object key; rejects anything outside the root. */
  pathFor(key: string): string {
    const { relativePath } = parseObjectKey(key);
    const full = resolve(this.rootDir, relativePath);
    if (full !== join(this.rootDir, relativePath) || !full.startsWith(`${this.rootDir}${sep}`)) {
      throw new GithubError("OBJECT_STORE_KEY_INVALID", "object key escapes the object store root");
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const { hex } = parseObjectKey(key);
    if (sha256Hex(bytes) !== (`0x${hex}` as Hex)) {
      throw new GithubError(
        "OBJECT_STORE_CONTENT_MISMATCH",
        "object bytes do not match the content-addressed key",
      );
    }
    const target = this.pathFor(key);
    await fs.mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const { hex } = parseObjectKey(key);
    const target = this.pathFor(key);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new GithubError("OBJECT_STORE_NOT_FOUND", "object does not exist");
      }
      throw error;
    }
    if (sha256Hex(bytes) !== (`0x${hex}` as Hex)) {
      throw new GithubError(
        "OBJECT_STORE_CONTENT_MISMATCH",
        "stored object is corrupted (content hash mismatch)",
      );
    }
    return bytes;
  }

  async has(key: string): Promise<boolean> {
    const target = this.pathFor(key);
    try {
      const stats = await fs.lstat(target);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.pathFor(key), { force: true });
  }
}

export interface IngestArtifactTarInput {
  /** Raw tar bytes (uncompressed tar, or gzip/brotli/zstd detected by `tar`). */
  readonly bytes?: Uint8Array;
  /** Alternative streaming input; buffered with a hard cap before validation. */
  readonly stream?: AsyncIterable<Uint8Array>;
  /** Parent directory for the per-ingest temp workspace (caller-owned, not deleted). */
  readonly destinationDir: string;
  readonly objectStore: ObjectStore;
  /** Tighter/looser limits; per-file is clamped to the 8.4 MB hard cap. */
  readonly limits?: Partial<ArtifactLimits>;
  readonly entryPath?: string;
  /** Defaults to true (TapeCI "fully on-chain" policy). */
  readonly strictOnChain?: boolean;
}

export interface IngestArtifactResult {
  /** Content-addressed key of the stored tar (`sha256/<hex>.tar`). */
  readonly objectKey: string;
  /** SHA-256 of the uploaded tar bytes (0x-prefixed). */
  readonly sha256: Hex;
  /** Uploaded archive size in bytes. */
  readonly sizeBytes: number;
  /** Sum of extracted file sizes. */
  readonly totalBytes: number;
  /** Entries seen in the tar headers (files + directories). */
  readonly entryCount: number;
  /** Files surviving the scan (the `release_files` / manifest input set). */
  readonly fileCount: number;
  readonly scan: ScanResult;
  /** Scanned files (canonical paths, hashes, content types, bytes). */
  readonly files: readonly ScannedFile[];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GithubError("TAR_INVALID", `${name} must be a positive integer`);
  }
  return value;
}

function resolveLimits(overrides: Partial<ArtifactLimits> | undefined): ArtifactLimits {
  const maxFileBytes = positiveInteger(
    overrides?.maxFileBytes ?? DEFAULT_ARTIFACT_LIMITS.maxFileBytes,
    "limits.maxFileBytes",
  );
  const maxTotalBytes = positiveInteger(
    overrides?.maxTotalBytes ?? DEFAULT_ARTIFACT_LIMITS.maxTotalBytes,
    "limits.maxTotalBytes",
  );
  const maxEntries = positiveInteger(
    overrides?.maxEntries ?? DEFAULT_ARTIFACT_LIMITS.maxEntries,
    "limits.maxEntries",
  );
  return {
    // The 8.4 MB hard cap always wins, mirroring the validator.
    maxFileBytes: Math.min(maxFileBytes, MAX_ARTIFACT_FILE_BYTES),
    maxTotalBytes,
    maxEntries,
  };
}

interface TarEntryPath {
  /** Canonical-ish relative path (trailing separator stripped, NFC). */
  readonly path: string;
  readonly isDirectory: boolean;
}

function validateTarEntryPath(raw: string): TarEntryPath {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new GithubError("TAR_PATH_UNSAFE", "tar entry has an empty path", {
      details: { path: String(raw).slice(0, 120) },
    });
  }
  if (raw.includes("\u0000")) {
    throw new GithubError("TAR_PATH_UNSAFE", "tar entry path contains a NUL byte");
  }
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:/.test(raw)) {
    throw new GithubError("TAR_PATH_UNSAFE", `tar entry path must be relative: ${JSON.stringify(raw)}`, {
      details: { path: raw.slice(0, 200) },
    });
  }
  if (raw.includes("\\")) {
    throw new GithubError("TAR_PATH_UNSAFE", "tar entry path must use '/' separators", {
      details: { path: raw.slice(0, 200) },
    });
  }
  const isDirectory = raw.endsWith("/");
  const stripped = isDirectory ? raw.slice(0, -1) : raw;
  if (stripped.length === 0) {
    throw new GithubError("TAR_PATH_UNSAFE", "tar entry path is empty");
  }
  for (const segment of stripped.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new GithubError(
        "TAR_PATH_UNSAFE",
        `tar entry path contains an unsafe segment: ${JSON.stringify(raw)}`,
        { details: { path: raw.slice(0, 200) } },
      );
    }
  }
  return { path: stripped.normalize("NFC"), isDirectory };
}

function assertEntryType(entry: ReadEntry, safePath: string): void {
  switch (entry.type) {
    case "File":
    case "OldFile":
    case "ContiguousFile":
    case "Directory":
      return;
    case "SymbolicLink":
    case "Link":
      throw new GithubError("TAR_LINK_FORBIDDEN", `links are not allowed in artifacts: ${safePath}`, {
        details: { path: safePath, type: entry.type },
      });
    case "CharacterDevice":
    case "BlockDevice":
    case "FIFO":
      throw new GithubError(
        "TAR_SPECIAL_FILE_FORBIDDEN",
        `special files are not allowed in artifacts: ${safePath}`,
        { details: { path: safePath, type: entry.type } },
      );
    default:
      throw new GithubError(
        "TAR_ENTRY_TYPE_FORBIDDEN",
        `unsupported tar entry type ${entry.type}: ${safePath}`,
        { details: { path: safePath, type: entry.type } },
      );
  }
}

interface TarInspection {
  readonly entryCount: number;
  readonly fileCount: number;
  readonly declaredTotalBytes: number;
}

function inspectTar(bytes: Uint8Array, limits: ArtifactLimits): Promise<TarInspection> {
  return new Promise<TarInspection>((resolvePromise, rejectPromise) => {
    const parser = new Parser({ strict: true });
    const seen = new Set<string>();
    let settled = false;
    let entryCount = 0;
    let fileCount = 0;
    let declaredTotalBytes = 0;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      const wrapped =
        isGithubError(error)
          ? error
          : new GithubError("TAR_INVALID", "tar archive is invalid", { cause: error });
      try {
        parser.abort(wrapped);
      } catch {
        // The parser may already be finished; the rejection below is authoritative.
      }
      rejectPromise(wrapped);
    };

    parser.on("entry", (entry: ReadEntry) => {
      if (settled) {
        entry.resume();
        return;
      }
      try {
        if (!entry.meta) {
          entryCount += 1;
          if (entryCount > limits.maxEntries) {
            throw new GithubError(
              "TAR_TOO_MANY_ENTRIES",
              `tar archive has more than ${limits.maxEntries} entries`,
              { details: { maxEntries: limits.maxEntries } },
            );
          }
          const safePath = validateTarEntryPath(entry.path);
          assertEntryType(entry, safePath.path);
          if (seen.has(safePath.path)) {
            throw new GithubError("TAR_DUPLICATE_PATH", `duplicate tar entry path: ${safePath.path}`, {
              details: { path: safePath.path },
            });
          }
          seen.add(safePath.path);
          if (!safePath.isDirectory) {
            fileCount += 1;
            const size = entry.size;
            if (!Number.isSafeInteger(size) || size < 0) {
              throw new GithubError("TAR_INVALID", `tar entry has an invalid size: ${safePath.path}`, {
                details: { path: safePath.path },
              });
            }
            if (size > limits.maxFileBytes) {
              throw new GithubError(
                "TAR_FILE_TOO_LARGE",
                `artifact file ${safePath.path} is ${size} bytes, maximum is ${limits.maxFileBytes}`,
                { details: { path: safePath.path, size, max: limits.maxFileBytes } },
              );
            }
            declaredTotalBytes += size;
            if (declaredTotalBytes > limits.maxTotalBytes) {
              throw new GithubError(
                "TAR_ARCHIVE_TOO_LARGE",
                `artifact archive exceeds the ${limits.maxTotalBytes}-byte total limit`,
                {
                  details: {
                    declaredTotalBytes,
                    maxTotalBytes: limits.maxTotalBytes,
                  },
                },
              );
            }
          }
        }
        entry.resume();
      } catch (error) {
        fail(error);
      }
    });
    parser.on("error", (error: Error) => {
      fail(new GithubError("TAR_INVALID", "tar archive could not be parsed", { cause: error }));
    });
    parser.on("end", () => {
      if (settled) return;
      settled = true;
      resolvePromise({ entryCount, fileCount, declaredTotalBytes });
    });
    parser.write(Buffer.from(bytes));
    parser.end();
  });
}

async function readArtifactBytes(
  input: IngestArtifactTarInput,
  maxArchiveBytes: number,
): Promise<Uint8Array> {
  if (input.bytes !== undefined && input.stream !== undefined) {
    throw new GithubError("TAR_INVALID", "provide either bytes or stream, not both");
  }
  if (input.bytes !== undefined) return input.bytes;
  if (input.stream === undefined) {
    throw new GithubError("TAR_INVALID", "artifact upload is empty");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of input.stream) {
    if (!(chunk instanceof Uint8Array)) {
      throw new GithubError("TAR_INVALID", "artifact stream produced a non-byte chunk");
    }
    total += chunk.length;
    if (total > maxArchiveBytes) {
      throw new GithubError(
        "TAR_ARCHIVE_TOO_LARGE",
        "uploaded tar exceeds the maximum archive size",
        { details: { maxArchiveBytes } },
      );
    }
    chunks.push(chunk);
  }
  if (total === 0) {
    throw new GithubError("TAR_INVALID", "artifact upload is empty");
  }
  return Buffer.concat(chunks);
}

/**
 * Validate, extract, scan and store one tar artifact.
 *
 * Throws `GithubError` for unsafe/invalid archives and `TapeCiError` from the
 * validator for artifact-policy failures (missing entry, external references,
 * server-side extensions, …). Nothing is written to the object store unless
 * both phases succeed.
 */
export async function ingestArtifactTar(
  input: IngestArtifactTarInput,
): Promise<IngestArtifactResult> {
  const limits = resolveLimits(input.limits);
  const maxArchiveBytes = limits.maxTotalBytes + limits.maxEntries * 4096 + 1024;
  const bytes = await readArtifactBytes(input, maxArchiveBytes);
  const inspection = await inspectTar(bytes, limits);

  const destination = resolve(input.destinationDir);
  await fs.mkdir(destination, { recursive: true });
  const workspace = await fs.mkdtemp(join(destination, "tapeci-ingest-"));
  const archivePath = join(workspace, "artifact.tar");
  const extractDir = join(workspace, "extract");
  try {
    await fs.writeFile(archivePath, bytes);
    await fs.mkdir(extractDir, { recursive: true });
    try {
      await extractTar({
        file: archivePath,
        cwd: extractDir,
        strict: true,
        preservePaths: false,
        noMtime: true,
        chmod: false,
        maxDepth: 64,
      });
    } catch (error) {
      throw new GithubError("TAR_INVALID", "tar archive could not be extracted safely", {
        cause: error,
      });
    }

    const scan = await scanArtifactDirectory(extractDir, {
      maxFileBytes: limits.maxFileBytes,
      strictOnChain: input.strictOnChain ?? true,
      ...(input.entryPath === undefined ? {} : { entryPath: input.entryPath }),
    });

    // Never trust header metadata: compare real bytes against the header pass.
    if (scan.totalBytes > limits.maxTotalBytes) {
      throw new GithubError(
        "TAR_ARCHIVE_TOO_LARGE",
        `extracted artifact exceeds the ${limits.maxTotalBytes}-byte total limit`,
        { details: { totalBytes: scan.totalBytes, maxTotalBytes: limits.maxTotalBytes } },
      );
    }
    if (scan.files.length > limits.maxEntries) {
      throw new GithubError("TAR_TOO_MANY_ENTRIES", "extracted artifact has too many files", {
        details: { fileCount: scan.files.length, maxEntries: limits.maxEntries },
      });
    }
    if (
      scan.totalBytes !== inspection.declaredTotalBytes ||
      scan.files.length !== inspection.fileCount
    ) {
      throw new GithubError(
        "TAR_INVALID",
        "tar entry metadata does not match the extracted artifact",
        {
          details: {
            declaredTotalBytes: inspection.declaredTotalBytes,
            extractedTotalBytes: scan.totalBytes,
            declaredFiles: inspection.fileCount,
            extractedFiles: scan.files.length,
          },
        },
      );
    }

    const sha256 = sha256Hex(bytes);
    const objectKey = objectKeyForSha256(sha256);
    await input.objectStore.put(objectKey, bytes);
    return {
      objectKey,
      sha256,
      sizeBytes: bytes.length,
      totalBytes: scan.totalBytes,
      entryCount: inspection.entryCount,
      fileCount: scan.files.length,
      scan,
      files: scan.files,
    };
  } catch (error) {
    if (isGithubError(error) || isTapeCiError(error)) throw error;
    throw new GithubError("TAR_INVALID", "artifact ingest failed", { cause: error });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
