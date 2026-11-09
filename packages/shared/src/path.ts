import { TapeCiError } from "./errors.js";
import { INDEX_FILE } from "./types.js";

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
const DRIVE_RE = /^[A-Za-z]:/;

function fail(message: string, code: "INVALID_PATH" | "INVALID_ARTIFACT" = "INVALID_PATH"): never {
  throw new TapeCiError(code, message, { retryable: false });
}

/**
 * Canonicalize a single path per TapeKit SPEC §6:
 * strip query/fragment, percent-decode, NFC normalize, collapse `//`, strip the
 * leading `/`, then reject control characters and `.` / `..` segments.
 */
function canonicalizeBase(raw: string, kind: "site" | "artifact"): string {
  if (typeof raw !== "string") fail("path must be a string");
  if (raw.length === 0) {
    if (kind === "artifact") fail("artifact path must be a non-empty string", "INVALID_ARTIFACT");
    return INDEX_FILE;
  }
  if (raw.includes("\u0000")) fail("path contains a NUL byte");
  if (raw.includes("\\")) fail(`path must use '/' separators: ${raw}`);

  let value = raw;
  if (kind === "site") value = stripQueryAndFragment(value);

  // Malformed percent escapes must be rejected rather than guessed at.
  try {
    value = decodeURIComponent(value);
  } catch {
    fail(`malformed percent-encoding in path: ${raw}`);
  }
  if (value.includes("%")) {
    // decodeURIComponent leaves a lone '%' intact; such a path is not canonical.
    fail(`malformed percent-encoding in path: ${raw}`);
  }

  value = normalizeUnicode(value);
  if (hasControlCharacter(value)) fail("path contains a control character");
  if (DRIVE_RE.test(value)) fail(`path must not be a Windows drive path: ${raw}`);
  if (value.includes("\\")) fail("path must use '/' separators after decoding");

  value = value.replace(/\/+/g, "/");
  if (value.startsWith("/")) value = value.replace(/^\/+/, "");

  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") fail(`path must not contain '.' or '..' segments: ${raw}`);
  }

  if (kind === "site") {
    if (value === "" || value.endsWith("/")) {
      value += INDEX_FILE;
    }
  } else {
    if (value === "" || value.endsWith("/")) {
      fail(`artifact path must name a file: ${raw}`, "INVALID_ARTIFACT");
    }
    if (value === "." || value === "..") fail(`invalid artifact path: ${raw}`, "INVALID_ARTIFACT");
  }

  return value;
}

function stripQueryAndFragment(value: string): string {
  const query = value.indexOf("?");
  const fragment = value.indexOf("#");
  let cut = value.length;
  if (query >= 0) cut = Math.min(cut, query);
  if (fragment >= 0) cut = Math.min(cut, fragment);
  return value.slice(0, cut);
}

function normalizeUnicode(value: string): string {
  return value.normalize("NFC");
}

/** Canonical on-chain path for a site request (SPEC §6). Empty or directory paths become `<dir>/index.html`. */
export function canonicalizeSitePath(raw: string): string {
  return canonicalizeBase(raw, "site");
}

/** Canonical path for an artifact file relative to the build output directory. */
export function canonicalizeArtifactPath(raw: string): string {
  return canonicalizeBase(raw, "artifact");
}

/** UTF-8 byte-order comparator used for deterministic manifest ordering. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Validate a path that is already supposed to be canonical (e.g. from a manifest). */
export function assertCanonicalSitePath(path: string): string {
  const canonical = canonicalizeSitePath(path);
  if (canonical !== path) {
    throw new TapeCiError("INVALID_PATH", `path is not canonical: ${path} -> ${canonical}`);
  }
  return path;
}

/** Validate an already-canonical artifact path. */
export function assertCanonicalArtifactPath(path: string): string {
  const canonical = canonicalizeArtifactPath(path);
  if (canonical !== path) {
    throw new TapeCiError("INVALID_ARTIFACT", `artifact path is not canonical: ${path} -> ${canonical}`);
  }
  return path;
}
