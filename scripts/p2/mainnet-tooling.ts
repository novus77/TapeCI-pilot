/**
 * Pure helpers for the P2-10 RC release / rollback tools.
 *
 * Everything here is I/O-free except `collectArtifactEntries` / `buildArtifactTar`,
 * which only touch the local filesystem. No database, Redis, RPC or HTTP is used,
 * so the unit suite can exercise argument parsing, path filtering and fee
 * extraction without a running stack (`tests/unit/mainnet-tools.test.ts`).
 *
 * These tools never sign or broadcast a transaction: they prepare a deployment,
 * store a safe artifact tar, enqueue the read-only plan job and print the
 * approval payload for the owner to sign elsewhere.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { TapeCiError, compareUtf8, sha256Hex, type Hex } from "@tapeci/shared";
import * as tar from "tar";

/** Deployment state that means "the plan job finished; fees are final". */
export const PLAN_READY_STATE = "PLAN_READY" as const;

/** Poll budget for the read-only plan job (it makes RPC reads, no writes). */
export const DEFAULT_PLAN_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** macOS metadata that must never reach the artifact tar (TapeKit SPEC §6). */
export const IGNORED_ARTIFACT_NAMES: readonly string[] = [".DS_Store"];

/** AppleDouble resource-fork prefix (`._index.html`, `._assets`). */
export const APPLE_DOUBLE_PREFIX = "._";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const RELEASE_ID_RE = /^r-[0-9a-f]{12}-[0-9a-f]{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEI_RE = /^[0-9]+$/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

function configError(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new TapeCiError("INVALID_CONFIG", message, { retryable: false, details });
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface FlagSpec {
  /** Long flag without the `--` prefix, e.g. `cap-wei`. */
  readonly name: string;
  /** `true` when the flag consumes the next token (or `--flag=value`). */
  readonly takesValue: boolean;
}

export interface ParsedFlags {
  /** Flags that take a value, keyed by name. */
  readonly values: ReadonlyMap<string, string>;
  /** Boolean flags that were present. */
  readonly switches: ReadonlySet<string>;
}

/**
 * Parse `--flag value`, `--flag=value` and `--switch` tokens against an explicit
 * allowlist. A bare `--` (how `pnpm run … -- …` forwards arguments) is skipped.
 * Unknown flags, missing values, duplicate flags and positional arguments are
 * hard errors so a typo can never silently change what gets deployed.
 */
export function parseFlags(argv: readonly string[], specs: readonly FlagSpec[]): ParsedFlags {
  const byName = new Map<string, FlagSpec>();
  for (const spec of specs) byName.set(spec.name, spec);
  const values = new Map<string, string>();
  const switches = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") continue;
    if (!token.startsWith("--")) {
      configError(`unexpected positional argument: ${JSON.stringify(token)}`, { token });
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    const name = equals >= 0 ? body.slice(0, equals) : body;
    const inline = equals >= 0 ? body.slice(equals + 1) : undefined;
    const spec = byName.get(name);
    if (spec === undefined) {
      configError(`unknown flag --${name}`, { flag: `--${name}`, allowed: [...byName.keys()] });
    }
    if (!spec.takesValue) {
      if (inline !== undefined) {
        configError(`--${name} does not take a value`, { flag: `--${name}` });
      }
      if (switches.has(name)) configError(`duplicate flag --${name}`, { flag: `--${name}` });
      switches.add(name);
      continue;
    }
    if (values.has(name)) configError(`duplicate flag --${name}`, { flag: `--${name}` });
    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        configError(`missing value for --${name}`, { flag: `--${name}` });
      }
      value = next;
      index += 1;
    }
    if (value.trim() === "") configError(`empty value for --${name}`, { flag: `--${name}` });
    values.set(name, value);
  }

  return { values, switches };
}

function requireValue(parsed: ParsedFlags, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined) configError(`--${name} is required`, { flag: `--${name}` });
  return value;
}

function positiveInteger(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    configError(`--${flag} must be a positive integer`, { flag: `--${flag}`, value: raw });
  }
  const parsedNumber = Number(raw);
  if (!Number.isSafeInteger(parsedNumber)) {
    configError(`--${flag} is out of range`, { flag: `--${flag}`, value: raw });
  }
  return parsedNumber;
}

export const RELEASE_FLAGS: readonly FlagSpec[] = [
  { name: "project", takesValue: true },
  { name: "dist", takesValue: true },
  { name: "commit", takesValue: true },
  { name: "cap-wei", takesValue: true },
  { name: "timeout-ms", takesValue: true },
  { name: "poll-ms", takesValue: true },
  { name: "help", takesValue: false },
];

export const ROLLBACK_FLAGS: readonly FlagSpec[] = [
  { name: "project", takesValue: true },
  { name: "release", takesValue: true },
  { name: "cap-wei", takesValue: true },
  { name: "timeout-ms", takesValue: true },
  { name: "poll-ms", takesValue: true },
  { name: "help", takesValue: false },
];

export interface ReleaseArgs {
  readonly projectId: string;
  readonly dist: string;
  readonly commitSha: string;
  readonly capWei: bigint | null;
  readonly timeoutMs: number;
  readonly pollMs: number;
}

export type ParsedToolArgs<T> = T | { readonly help: true };

/** `--project <uuid> --dist <dir> --commit <40hex> [--cap-wei <n>]` */
export function parseReleaseArgs(argv: readonly string[]): ParsedToolArgs<ReleaseArgs> {
  const parsed = parseFlags(argv, RELEASE_FLAGS);
  if (parsed.switches.has("help")) return { help: true };
  return {
    projectId: assertProjectId(requireValue(parsed, "project")),
    dist: requireValue(parsed, "dist"),
    commitSha: assertCommitSha(requireValue(parsed, "commit")),
    capWei: parseCapWei(parsed.values.get("cap-wei")),
    timeoutMs: positiveInteger(
      parsed.values.get("timeout-ms"),
      "timeout-ms",
      DEFAULT_PLAN_TIMEOUT_MS,
    ),
    pollMs: positiveInteger(parsed.values.get("poll-ms"), "poll-ms", DEFAULT_POLL_INTERVAL_MS),
  };
}

export interface RollbackArgs {
  readonly projectId: string;
  /** Public release id (`r-…`) or the database row id. */
  readonly release: string;
  readonly capWei: bigint | null;
  readonly timeoutMs: number;
  readonly pollMs: number;
}

/** `--project <uuid> --release <r-…|uuid> [--cap-wei <n>]` */
export function parseRollbackArgs(argv: readonly string[]): ParsedToolArgs<RollbackArgs> {
  const parsed = parseFlags(argv, ROLLBACK_FLAGS);
  if (parsed.switches.has("help")) return { help: true };
  const release = requireValue(parsed, "release");
  if (!RELEASE_ID_RE.test(release) && !UUID_RE.test(release)) {
    configError("--release must be a release id (r-…) or a release row UUID", {
      flag: "--release",
      value: release,
    });
  }
  return {
    projectId: assertProjectId(requireValue(parsed, "project")),
    release,
    capWei: parseCapWei(parsed.values.get("cap-wei")),
    timeoutMs: positiveInteger(
      parsed.values.get("timeout-ms"),
      "timeout-ms",
      DEFAULT_PLAN_TIMEOUT_MS,
    ),
    pollMs: positiveInteger(parsed.values.get("poll-ms"), "poll-ms", DEFAULT_POLL_INTERVAL_MS),
  };
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

/** Bare lowercase 40-hex Git commit SHA (the `deployments.commit_sha` CHECK). */
export function assertCommitSha(value: string): string {
  if (!COMMIT_SHA_RE.test(value)) {
    configError("--commit must be a lowercase 40-character hex commit SHA", {
      field: "commit",
      value,
    });
  }
  return value;
}

export function assertProjectId(value: string): string {
  if (!UUID_RE.test(value)) {
    configError("--project must be a UUID", { field: "project", value });
  }
  return value.toLowerCase();
}

/** `r-<12 hex>-<8 hex>` — the release id shape from `@tapeci/artifact`. */
export function assertReleaseId(value: string): string {
  if (!RELEASE_ID_RE.test(value)) {
    configError("--release must look like r-<12 lowercase hex>-<8 lowercase hex>", {
      field: "release",
      value,
    });
  }
  return value;
}

/** Decimal wei string (`^[0-9]+$`), never hex, never a float. */
export function parseWeiString(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !WEI_RE.test(value)) {
    configError(`${field} must be a decimal wei string`, { field, value: String(value) });
  }
  return BigInt(value);
}

/** Optional `--cap-wei`; `null` means "no local guard". */
export function parseCapWei(raw: string | undefined): bigint | null {
  if (raw === undefined) return null;
  if (!WEI_RE.test(raw)) {
    configError("--cap-wei must be a decimal wei value", { flag: "--cap-wei", value: raw });
  }
  const capWei = BigInt(raw);
  if (capWei <= 0n) {
    configError("--cap-wei must be greater than zero", { flag: "--cap-wei", value: raw });
  }
  return capWei;
}

// ---------------------------------------------------------------------------
// Artifact path filtering (tar safety)
// ---------------------------------------------------------------------------

/**
 * True for names that must never be archived: macOS `.DS_Store` and AppleDouble
 * `._*` sidecars. These would otherwise become on-chain files (or duplicate a
 * canonical path after normalization).
 */
export function isIgnoredArtifactName(name: string): boolean {
  return IGNORED_ARTIFACT_NAMES.includes(name) || name.startsWith(APPLE_DOUBLE_PREFIX);
}

/**
 * Strip a leading `./`, collapse `//` and drop leading/trailing `/`, then
 * NFC-normalize. Backslashes are left untouched on purpose: they are never a
 * separator on chain, so `isSafeArtifactRelativePath` rejects them instead.
 */
export function normalizeArtifactRelativePath(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * A path is safe when it is relative, NFC, free of `.`/`..`/empty segments and
 * of anything the artifact validator would reject. Backslashes and Windows drive
 * paths are refused rather than rewritten.
 */
export function isSafeArtifactRelativePath(raw: string): boolean {
  if (raw.length === 0) return false;
  if (raw.includes("\u0000")) return false;
  if (raw.includes("\\")) return false;
  if (raw.startsWith("/")) return false;
  if (WINDOWS_DRIVE_RE.test(raw)) return false;
  if (hasControlCharacter(raw)) return false;
  if (raw !== raw.normalize("NFC")) return false;
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

/**
 * The single predicate behind the tar filter: normalize, require a safe relative
 * path, then reject ignored names in any segment. The root `./` and `.` are
 * excluded because they are not files.
 *
 * Absolute paths are rejected *before* normalization: silently stripping the
 * leading `/` would turn `/etc/passwd` into an innocuous-looking relative path.
 */
export function shouldIncludeArtifactPath(raw: string): boolean {
  const withoutDotSlash = raw.replace(/^(?:\.\/)+/, "");
  if (withoutDotSlash.startsWith("/") || withoutDotSlash.startsWith("\\")) return false;
  const normalized = normalizeArtifactRelativePath(raw);
  if (normalized === "" || normalized === ".") return false;
  if (!isSafeArtifactRelativePath(normalized)) return false;
  return !normalized.split("/").some((segment) => isIgnoredArtifactName(segment));
}

/** Normalize, filter and dedupe in deterministic UTF-8 byte order. */
export function filterArtifactPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const path of paths) {
    if (!shouldIncludeArtifactPath(path)) continue;
    const normalized = normalizeArtifactRelativePath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    kept.push(normalized);
  }
  return kept.sort(compareUtf8);
}

export interface SkippedArtifactPath {
  readonly path: string;
  readonly reason: string;
}

export interface ArtifactEntries {
  /** Safe relative file paths, deterministic UTF-8 byte order. */
  readonly files: readonly string[];
  /** Paths that were deliberately left out, with the reason. */
  readonly skipped: readonly SkippedArtifactPath[];
}

/**
 * Walk a build output directory and return the exact file list to archive.
 * Symlinks are never followed and never archived (the worker's tar ingest
 * rejects link entries, so a symlink would fail the plan anyway), non-regular
 * files are skipped, and ignored names are pruned before descending.
 */
export async function collectArtifactEntries(rootDir: string): Promise<ArtifactEntries> {
  const skipped: SkippedArtifactPath[] = [];
  const files: string[] = [];

  const walk = async (relativeDir: string): Promise<void> => {
    const absoluteDir = relativeDir === "" ? rootDir : join(rootDir, ...relativeDir.split("/"));
    const names = (await fs.readdir(absoluteDir)).sort(compareUtf8);
    for (const name of names) {
      const relativePath = relativeDir === "" ? name : `${relativeDir}/${name}`;
      if (isIgnoredArtifactName(name)) {
        skipped.push({ path: relativePath, reason: "macOS metadata" });
        continue;
      }
      const stats = await fs.lstat(join(absoluteDir, name));
      if (stats.isSymbolicLink()) {
        skipped.push({ path: relativePath, reason: "symlink" });
        continue;
      }
      if (stats.isDirectory()) {
        await walk(relativePath);
        continue;
      }
      if (!stats.isFile()) {
        skipped.push({ path: relativePath, reason: "not a regular file" });
        continue;
      }
      if (relativePath !== relativePath.normalize("NFC")) {
        skipped.push({ path: relativePath, reason: "path is not NFC-normalized" });
        continue;
      }
      if (!shouldIncludeArtifactPath(relativePath)) {
        skipped.push({ path: relativePath, reason: "unsafe artifact path" });
        continue;
      }
      files.push(relativePath);
    }
  };

  const stats = await fs.lstat(rootDir).catch((error: unknown) => {
    throw new TapeCiError("INVALID_CONFIG", `--dist is not readable: ${String(rootDir)}`, {
      details: { rootDir, reason: error instanceof Error ? error.message : String(error) },
    });
  });
  if (stats.isSymbolicLink()) {
    throw new TapeCiError("INVALID_CONFIG", "--dist must not be a symbolic link", {
      details: { rootDir },
    });
  }
  if (!stats.isDirectory()) {
    throw new TapeCiError("INVALID_CONFIG", "--dist must be a directory", { details: { rootDir } });
  }

  await walk("");
  return { files: files.sort(compareUtf8), skipped };
}

export interface ArtifactTar {
  readonly bytes: Uint8Array;
  /** SHA-256 of the exact tar bytes (`0x…`). */
  readonly sha256: Hex;
  /** Entry paths in the archive, in archive order. */
  readonly entryPaths: readonly string[];
}

/**
 * Build a deterministic, safe artifact tar from an explicit file list.
 * `portable` pins uid/gid/mode and `noMtime` removes timestamps, so the same
 * dist directory always produces the same SHA-256 (content-addressed storage).
 */
export async function buildArtifactTar(
  cwd: string,
  files: readonly string[],
): Promise<ArtifactTar> {
  const entryPaths = filterArtifactPaths(files);
  if (entryPaths.length === 0) {
    throw new TapeCiError("INVALID_ARTIFACT", "the artifact tar would be empty", {
      details: { cwd },
    });
  }
  // A non-NFC input would be archived under its normalized name, which does not
  // exist on disk: the tar would silently contain a different file (or fail).
  const nfcRenamed = files.filter((file) => file.normalize("NFC") !== file);
  if (nfcRenamed.length > 0) {
    throw new TapeCiError("INVALID_ARTIFACT", "artifact paths must already be NFC-normalized", {
      details: { paths: nfcRenamed.slice(0, 10) },
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of tar.c(
    {
      cwd,
      portable: true,
      noMtime: true,
      strict: true,
      // `portable` only strips uid/gid and clears group/other write bits; it keeps
      // the owner-exec bit. A chmod or a different umask would then change the tar
      // hash, the release id and every versioned on-chain path. Pin the mode.
      onWriteEntry: (entry) => {
        if (entry.stat !== undefined) entry.stat.mode = 0o644;
      },
    },
    [...entryPaths],
  )) {
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  return { bytes: new Uint8Array(bytes), sha256: sha256Hex(new Uint8Array(bytes)), entryPaths };
}

// ---------------------------------------------------------------------------
// Plan fees + cap guard
// ---------------------------------------------------------------------------

export interface PlanFeeSummary {
  readonly gasPriceWei: bigint;
  readonly estimatedGas: bigint;
  readonly estimatedCostWei: bigint;
  readonly marginBps: number;
  readonly recommendedCapWei: bigint;
  readonly withinBudget: boolean;
  readonly overBudgetByWei: bigint;
}

/**
 * Read the fee block out of a stored `plan_json`. Returns `null` when the
 * deployment has no plan yet and throws when a field is malformed: a plan whose
 * cap cannot be parsed must never be treated as "cheap".
 */
export function readPlanFees(planJson: unknown): PlanFeeSummary | null {
  if (typeof planJson !== "object" || planJson === null) return null;
  const fees = (planJson as { fees?: unknown }).fees;
  if (typeof fees !== "object" || fees === null) return null;
  const record = fees as Record<string, unknown>;
  const marginBps = record["marginBps"];
  if (typeof marginBps !== "number" || !Number.isInteger(marginBps) || marginBps < 0) {
    configError("plan fees.marginBps is missing or invalid", { marginBps: String(marginBps) });
  }
  const withinBudget = record["withinBudget"];
  return {
    gasPriceWei: parseWeiString(record["gasPriceWei"], "plan fees.gasPriceWei"),
    estimatedGas: parseWeiString(record["estimatedGas"], "plan fees.estimatedGas"),
    estimatedCostWei: parseWeiString(record["estimatedCostWei"], "plan fees.estimatedCostWei"),
    marginBps,
    recommendedCapWei: parseWeiString(record["recommendedCapWei"], "plan fees.recommendedCapWei"),
    withinBudget: withinBudget === true,
    overBudgetByWei: parseWeiString(record["overBudgetByWei"], "plan fees.overBudgetByWei"),
  };
}

export interface CapCheck {
  readonly ok: boolean;
  /** The local `--cap-wei` guard, or `null` when it was not supplied. */
  readonly capWei: bigint | null;
  readonly recommendedCapWei: bigint;
  /** `recommendedCapWei - capWei` when over, otherwise `0`. */
  readonly overByWei: bigint;
}

/** `--cap-wei` is a local ceiling: the tool refuses to hand over a bigger cap. */
export function checkCap(recommendedCapWei: bigint, capWei: bigint | null): CapCheck {
  if (capWei === null) {
    return { ok: true, capWei: null, recommendedCapWei, overByWei: 0n };
  }
  const overByWei = recommendedCapWei > capWei ? recommendedCapWei - capWei : 0n;
  return { ok: recommendedCapWei <= capWei, capWei, recommendedCapWei, overByWei };
}

// ---------------------------------------------------------------------------
// Deployment polling
// ---------------------------------------------------------------------------

export type PollStatus = "READY" | "TERMINAL" | "PENDING";

/**
 * Classify a deployment state while polling. The terminal vocabulary is passed
 * in from `@tapeci/queue` so this module never duplicates the state machine.
 */
export function pollStatus(state: string, terminalStates: readonly string[]): PollStatus {
  if (state === PLAN_READY_STATE) return "READY";
  if (terminalStates.includes(state)) return "TERMINAL";
  return "PENDING";
}
