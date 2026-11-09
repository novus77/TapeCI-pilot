import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import {
  CHUNK_MAX,
  MAX_FILE_BYTES,
  TapeCiError,
  canonicalizeArtifactPath,
  compareUtf8,
  sha256Hex,
  utf8Decode,
} from "@tapeci/shared";
import {
  contentTypeForPath,
  extensionOfPath,
  isCssContentType,
  isHtmlContentType,
} from "./content-type.js";
import { scanCssReferences, scanHtmlReferences } from "./references.js";
import type {
  ExternalReference,
  ResolvedScanOptions,
  ScanInputFile,
  ScanOptions,
  ScanResult,
  ScanWarning,
  ScannedFile,
} from "./types.js";

/** Default entry document. Must stay `index.html` for TapeOut directory resolution. */
export const DEFAULT_ENTRY_PATH = "index.html";
/** Default per-file limit: the TapeOut hard cap (350 × 24,000 bytes). */
export const DEFAULT_MAX_FILE_BYTES = MAX_FILE_BYTES;
export const DEFAULT_STRICT_ON_CHAIN = true;

/**
 * Extensions that only make sense with a dynamic server runtime. A static
 * on-chain artifact must never contain them (TapeKit SPEC §8).
 */
export const DEFAULT_UNSUPPORTED_SERVER_EXTENSIONS: readonly string[] = [
  ".php",
  ".php3",
  ".php4",
  ".php5",
  ".phtml",
  ".jsp",
  ".jspx",
  ".asp",
  ".aspx",
  ".cgi",
  ".pl",
  ".py",
  ".rb",
];

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

function fail(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new TapeCiError("INVALID_ARTIFACT", message, { retryable: false, details });
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Strict relative-artifact-path canonicalization: reject absolute paths and
 * Windows drive/UNC prefixes explicitly (the shared canonicalizer strips a
 * leading `/`, which would silently turn `/etc/passwd` into a valid path), then
 * delegate to `@tapeci/shared` for NFC / percent / `..` / control handling.
 */
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

function normalizeIgnorePrefix(raw: string): string {
  let value = raw.replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/^\/+/, "").replace(/\/+$/, "");
  return value.normalize("NFC");
}

function isIgnored(path: string, ignore: readonly string[]): boolean {
  for (const prefix of ignore) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** Ignore matching used by the fs walker before any lstat (so ignored symlinks are skipped). */
function matchesIgnore(relativePath: string, ignore: readonly string[]): boolean {
  if (isIgnored(relativePath.normalize("NFC"), ignore)) return true;
  try {
    return isIgnored(canonicalizeArtifactPath(relativePath), ignore);
  } catch {
    return false;
  }
}

export function resolveScanOptions(options: ScanOptions = {}): ResolvedScanOptions {
  const entryPath = canonicalArtifactPath(options.entryPath ?? DEFAULT_ENTRY_PATH);
  const requestedMax = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(requestedMax) || requestedMax <= 0) {
    fail(`maxFileBytes must be a positive integer, got ${String(requestedMax)}`, {
      maxFileBytes: requestedMax,
    });
  }
  const strictOnChain = options.strictOnChain ?? DEFAULT_STRICT_ON_CHAIN;
  const ignore = (options.ignore ?? [])
    .map(normalizeIgnorePrefix)
    .filter((prefix) => prefix.length > 0);
  const unsupported = options.unsupportedServerExtensions ?? DEFAULT_UNSUPPORTED_SERVER_EXTENSIONS;
  const unsupportedServerExtensions = unsupported.map((extension) => {
    const normalized = extension.trim().toLowerCase();
    return normalized.startsWith(".") ? normalized : `.${normalized}`;
  });
  return {
    entryPath,
    // The hard cap always wins, even if a caller asks for a larger limit.
    maxFileBytes: Math.min(requestedMax, MAX_FILE_BYTES),
    strictOnChain,
    ignore,
    unsupportedServerExtensions,
  };
}

function assertSupportedPath(path: string, resolved: ResolvedScanOptions): void {
  const extension = extensionOfPath(path);
  if (extension.length > 0 && resolved.unsupportedServerExtensions.includes(extension)) {
    fail(
      `server-side file extension "${extension}" is not supported in a static artifact: ${path}`,
      { path, extension },
    );
  }
}

function toScannedFile(
  item: ScanInputFile,
  path: string,
  resolved: ResolvedScanOptions,
): ScannedFile {
  if (!(item.bytes instanceof Uint8Array)) {
    fail(`artifact file contents must be a Uint8Array: ${path}`, { path });
  }
  const size = item.bytes.length;
  if (size > resolved.maxFileBytes) {
    throw new TapeCiError(
      "FILE_TOO_LARGE",
      `artifact file ${path} is ${size} bytes, maximum is ${resolved.maxFileBytes}`,
      { retryable: false, details: { path, size, max: resolved.maxFileBytes } },
    );
  }
  assertSupportedPath(path, resolved);
  return {
    path,
    sourceRelativePath: path,
    size,
    sha256: sha256Hex(item.bytes),
    contentType: contentTypeForPath(path),
    bytes: item.bytes,
  };
}

function decodeUtf8(file: ScannedFile): string {
  try {
    return utf8Decode(file.bytes);
  } catch (error) {
    fail(
      `artifact file ${file.path} is not valid UTF-8 although its content type is ${file.contentType}`,
      { path: file.path, contentType: file.contentType, cause: failureMessage(error) },
    );
  }
}

function finalizeScan(files: readonly ScannedFile[], resolved: ResolvedScanOptions): ScanResult {
  const entry = files.find((file) => file.path === resolved.entryPath);
  if (entry === undefined) {
    fail(`entry file "${resolved.entryPath}" is missing from the artifact`, {
      entryPath: resolved.entryPath,
      files: files.map((file) => file.path),
    });
  }
  if (!isHtmlContentType(entry.contentType)) {
    fail(`entry file "${entry.path}" must be HTML, got content type ${entry.contentType}`, {
      entryPath: entry.path,
      contentType: entry.contentType,
    });
  }
  if (entry.size > CHUNK_MAX) {
    fail(
      `entry file "${entry.path}" is ${entry.size} bytes; it must be <= ${CHUNK_MAX} bytes so it can be replaced in a single transaction`,
      { entryPath: entry.path, size: entry.size, max: CHUNK_MAX },
    );
  }

  const externalReferences: ExternalReference[] = [];
  for (const file of files) {
    const html = isHtmlContentType(file.contentType);
    const css = isCssContentType(file.contentType);
    if (!html && !css) continue;
    const text = decodeUtf8(file);
    externalReferences.push(
      ...(html ? scanHtmlReferences(text, file.path) : scanCssReferences(text, file.path)),
    );
  }

  const warnings: ScanWarning[] = externalReferences.map((reference) => ({
    code: "EXTERNAL_REFERENCE",
    filePath: reference.filePath,
    message: `external reference in ${reference.filePath} (${reference.attribute}): ${reference.url}`,
    url: reference.url,
  }));

  if (resolved.strictOnChain && externalReferences.length > 0) {
    const first = externalReferences[0];
    fail(
      `strict on-chain policy rejected ${externalReferences.length} external reference(s); first: ${first === undefined ? "unknown" : first.url}`,
      {
        references: externalReferences.map((reference) => ({
          filePath: reference.filePath,
          attribute: reference.attribute,
          url: reference.url,
        })),
      },
    );
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return {
    entryPath: resolved.entryPath,
    entry,
    files,
    totalBytes,
    externalReferences,
    warnings,
    // Per the P1-03 contract: only a strict, reference-free scan is "fully on chain".
    fullyOnChain: resolved.strictOnChain && externalReferences.length === 0,
  };
}

/**
 * Pure in-memory artifact scan: canonicalizes and validates every path, enforces
 * the size/server-extension policies, checks the entry document, and applies the
 * external-reference policy. Deterministic: output order is UTF-8 byte order.
 */
export function scanArtifactFiles(
  input: readonly ScanInputFile[],
  options: ScanOptions = {},
): ScanResult {
  const resolved = resolveScanOptions(options);
  const firstSource = new Map<string, string>();
  const files: ScannedFile[] = [];
  for (const item of input) {
    if (typeof item.relativePath !== "string") {
      fail("artifact path must be a string", { relativePath: String(item.relativePath) });
    }
    const path = canonicalArtifactPath(item.relativePath);
    if (isIgnored(path, resolved.ignore)) continue;
    const first = firstSource.get(path);
    if (first !== undefined) {
      fail(
        `duplicate canonical artifact path "${path}" (from "${first}" and "${item.relativePath}")`,
        { path, first, duplicate: item.relativePath },
      );
    }
    firstSource.set(path, item.relativePath);
    files.push(toScannedFile(item, path, resolved));
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  return finalizeScan(files, resolved);
}

async function walkDirectory(
  rootDir: string,
  relativeDir: string,
  resolved: ResolvedScanOptions,
  out: ScanInputFile[],
): Promise<void> {
  const absoluteDir = relativeDir === "" ? rootDir : nodePath.join(rootDir, ...relativeDir.split("/"));
  const names = (await fs.readdir(absoluteDir)).sort(compareUtf8);
  for (const name of names) {
    const relativePath = relativeDir === "" ? name : `${relativeDir}/${name}`;
    // Ignore before lstat so an ignored directory containing symlinks cannot fail the scan.
    if (matchesIgnore(relativePath, resolved.ignore)) continue;
    const absolutePath = nodePath.join(absoluteDir, name);
    const stats = await fs.lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      fail(`symbolic links are not allowed in artifacts: ${relativePath}`, { path: relativePath });
    }
    if (stats.isDirectory()) {
      await walkDirectory(rootDir, relativePath, resolved, out);
      continue;
    }
    if (!stats.isFile()) {
      fail(`only regular files are allowed in artifacts: ${relativePath}`, { path: relativePath });
    }
    if (stats.size > resolved.maxFileBytes) {
      throw new TapeCiError(
        "FILE_TOO_LARGE",
        `artifact file ${relativePath} is ${stats.size} bytes, maximum is ${resolved.maxFileBytes}`,
        { retryable: false, details: { path: relativePath, size: stats.size, max: resolved.maxFileBytes } },
      );
    }
    const canonical = canonicalArtifactPath(relativePath);
    assertSupportedPath(canonical, resolved);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fs.readFile(absolutePath));
    } catch (error) {
      fail(`cannot read artifact file ${relativePath}: ${failureMessage(error)}`, {
        path: relativePath,
      });
    }
    out.push({ relativePath: canonical, bytes });
  }
}

/**
 * Filesystem variant of `scanArtifactFiles`: walks `rootDir` with `lstat`,
 * rejects symlinks and non-regular files, ignores configured prefixes, and
 * produces the same deterministic result.
 */
export async function scanArtifactDirectory(
  rootDir: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const resolved = resolveScanOptions(options);
  const root = nodePath.resolve(rootDir);
  const rootStats = await fs.lstat(root).catch((error: unknown) => {
    fail(`artifact directory does not exist or is not accessible: ${JSON.stringify(rootDir)}`, {
      rootDir,
      cause: failureMessage(error),
    });
  });
  if (rootStats.isSymbolicLink()) {
    fail(`artifact root must not be a symbolic link: ${JSON.stringify(rootDir)}`, { rootDir });
  }
  if (!rootStats.isDirectory()) {
    fail(`artifact root must be a directory: ${JSON.stringify(rootDir)}`, { rootDir });
  }
  const input: ScanInputFile[] = [];
  await walkDirectory(root, "", resolved, input);
  return scanArtifactFiles(input, options);
}
