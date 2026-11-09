import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  INDEX_FILE,
  MAX_FILE_BYTES,
  TapeCiError,
  canonicalizeArtifactPath,
  isTapeCiError,
} from "@tapeci/shared";

/**
 * `.tapeci.json` — the per-project TapeCI configuration file (P1-02).
 *
 * The file is deliberately strict: unknown keys are rejected at every level, so a
 * typo such as `maxFileByte` fails loudly instead of silently keeping a default.
 * The schema version is pinned so a future breaking change cannot be mistaken for
 * the v1 layout.
 */
export const TAPECI_CONFIG_SCHEMA_VERSION = "tapeci.config.v1";

/** X Layer mainnet chain id. TapeCI does not support any other chain in v1. */
const TAPECI_CONFIG_CHAIN_ID = 196;

/** Upper bound on the config file size; anything larger is not a human-authored config. */
const MAX_CONFIG_BYTES = 1_000_000;

/** Command strings are passed to a shell verbatim, so keep them short and NUL-free. */
const MAX_COMMAND_LENGTH = 500;

const MAX_IGNORE_ENTRIES = 100;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 3_600;
const MIN_KEEP_VERSIONS = 1;
const MAX_KEEP_VERSIONS = 50;

/**
 * Canonical project configuration (PRD §5.1, P1-02). This is the shape consumed by
 * `tapeci plan/deploy`; the value returned by the loaders is always fully populated.
 */
export interface TapeCiProjectConfig {
  schemaVersion: typeof TAPECI_CONFIG_SCHEMA_VERSION;
  chainId: 196;
  site: {
    /** ERC-6551 container address; always normalized to lowercase on parse. */
    container: `0x${string}`;
    /**
     * Must be exactly `index.html`: the entry file is switched in one transaction
     * and every other asset is published under `release.pathPrefix` (PRD §5.2).
     */
    entryPath: "index.html";
    /** Canonical on-chain fallback path, relative to the container root. */
    fallbackPath: string;
  };
  build: {
    installCommand: string;
    buildCommand: string;
    /** Canonical directory, relative to the checked-out repository root. */
    outputDir: string;
    timeoutSeconds: number;
  };
  policy: {
    strictOnChain: boolean;
    /** Hard cap from TapeOut: 350 chunks × 24,000 bytes. */
    maxFileBytes: number;
    /** Canonical relative path prefixes/globs that are never published. */
    ignore: string[];
  };
  release: {
    /** Canonical path prefix for versioned assets, e.g. `releases`. */
    pathPrefix: string;
    keepVersions: number;
  };
}

/** Overrides accepted by `createTapeCiConfig` (`tapeci init`). */
export type TapeCiConfigOverrides = {
  container: string;
  schemaVersion?: TapeCiProjectConfig["schemaVersion"];
  chainId?: TapeCiProjectConfig["chainId"];
  site?: Partial<TapeCiProjectConfig["site"]>;
  build?: Partial<TapeCiProjectConfig["build"]>;
  policy?: Partial<TapeCiProjectConfig["policy"]>;
  release?: Partial<TapeCiProjectConfig["release"]>;
};

/**
 * Full default configuration. `site.container` is intentionally the empty string:
 * a container address has no safe default and must be provided by the user or by
 * `createTapeCiConfig`, so `parseTapeCiConfig(DEFAULT_TAPECI_CONFIG)` is rejected.
 */
export const DEFAULT_TAPECI_CONFIG: Readonly<TapeCiProjectConfig> = deepFreeze({
  schemaVersion: TAPECI_CONFIG_SCHEMA_VERSION,
  chainId: 196 as const,
  site: {
    container: "" as `0x${string}`,
    entryPath: INDEX_FILE,
    fallbackPath: INDEX_FILE,
  },
  build: {
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDir: "dist",
    timeoutSeconds: 900,
  },
  policy: {
    strictOnChain: true,
    maxFileBytes: MAX_FILE_BYTES,
    ignore: [],
  },
  release: {
    pathPrefix: "releases",
    keepVersions: 5,
  },
});

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;
const CONTAINER_RE = /^0x[0-9a-fA-F]{40}$/;

function isControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Canonicalize a path field that must stay inside the build output/container root.
 * `canonicalizeArtifactPath` normalizes NFC, collapses `//`, percent-decodes and
 * rejects `.`/`..` segments, backslashes and control characters. Absolute paths and
 * Windows drive paths are rejected here first because that function strips a leading
 * slash instead of failing.
 */
function canonicalRelativePath(raw: string, kind: "file" | "directory"): string {
  if (raw.length === 0) throw new Error("must be a non-empty string");
  if (raw.startsWith("/")) throw new Error("must be a relative path (leading '/' is not allowed)");
  if (WINDOWS_DRIVE_RE.test(raw)) throw new Error("must not be a Windows drive path");
  if (isControlCharacter(raw)) throw new Error("must not contain control characters");
  const candidate = kind === "directory" ? raw.replace(/\/+$/, "") : raw;
  if (candidate.length === 0) throw new Error("must not be empty");
  return canonicalizeArtifactPath(candidate);
}

function relativePathSchema(kind: "file" | "directory"): z.ZodPipe<z.ZodString, z.ZodTransform<string, string>> {
  return z
    .string()
    .superRefine((value, ctx) => {
      try {
        canonicalRelativePath(value, kind);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })
    .transform((value) => {
      // The refinement above already reported invalid input; parse() will throw.
      try {
        return canonicalRelativePath(value, kind);
      } catch {
        return value;
      }
    });
}

const containerSchema = z
  .string()
  .regex(CONTAINER_RE, "must be a 0x-prefixed 20-byte hex address (40 hex characters)")
  .transform((value) => value.toLowerCase() as `0x${string}`);

const commandSchema = z
  .string()
  .min(1, "must not be empty")
  .max(MAX_COMMAND_LENGTH, `must be at most ${MAX_COMMAND_LENGTH} characters`)
  .refine((value) => value.trim().length > 0, "must not be blank")
  .refine((value) => !value.includes("\u0000"), "must not contain a NUL byte");

const entryPathSchema = z.literal(INDEX_FILE);

const siteSchema = z.strictObject({
  container: containerSchema,
  entryPath: entryPathSchema.default(INDEX_FILE),
  fallbackPath: relativePathSchema("file").default(INDEX_FILE),
});

const buildSchema = z.strictObject({
  installCommand: commandSchema.default("npm ci"),
  buildCommand: commandSchema.default("npm run build"),
  outputDir: relativePathSchema("directory").default("dist"),
  timeoutSeconds: z
    .number()
    .int()
    .min(MIN_TIMEOUT_SECONDS)
    .max(MAX_TIMEOUT_SECONDS)
    .default(DEFAULT_TAPECI_CONFIG.build.timeoutSeconds),
});

const policySchema = z.strictObject({
  strictOnChain: z.boolean().default(DEFAULT_TAPECI_CONFIG.policy.strictOnChain),
  maxFileBytes: z.number().int().min(1).max(MAX_FILE_BYTES).default(MAX_FILE_BYTES),
  ignore: z.array(relativePathSchema("directory")).max(MAX_IGNORE_ENTRIES).default([]),
});

const releaseSchema = z.strictObject({
  pathPrefix: relativePathSchema("directory").default(DEFAULT_TAPECI_CONFIG.release.pathPrefix),
  keepVersions: z
    .number()
    .int()
    .min(MIN_KEEP_VERSIONS)
    .max(MAX_KEEP_VERSIONS)
    .default(DEFAULT_TAPECI_CONFIG.release.keepVersions),
});

const projectConfigSchema = z.strictObject({
  schemaVersion: z.literal(TAPECI_CONFIG_SCHEMA_VERSION),
  chainId: z.literal(TAPECI_CONFIG_CHAIN_ID),
  site: siteSchema,
  build: buildSchema.prefault({}),
  policy: policySchema.prefault({}),
  release: releaseSchema.prefault({}),
});

function issuePath(path: readonly PropertyKey[]): string[] {
  return path.map((segment) => String(segment));
}

function invalidConfigError(error: z.ZodError, details: Readonly<Record<string, unknown>> = {}): TapeCiError {
  const issues = error.issues.map((issue) => ({
    path: issuePath(issue.path),
    message: issue.message,
  }));
  const summary = issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
  return new TapeCiError("INVALID_CONFIG", `invalid TapeCI project config: ${summary}`, {
    details: { issues, ...details },
  });
}

/**
 * Parse and fully populate a `.tapeci.json` value. Throws `TapeCiError` with code
 * `INVALID_CONFIG` naming every failing path; it never returns a partial config.
 */
export function parseTapeCiConfig(input: unknown): TapeCiProjectConfig {
  const result = projectConfigSchema.safeParse(input);
  if (!result.success) throw invalidConfigError(result.error);
  return result.data;
}

/**
 * Read, parse and validate a `.tapeci.json` file. Filesystem and JSON syntax errors
 * are reported as `INVALID_CONFIG` (with the file path in `details`) rather than as
 * raw `ENOENT` / `SyntaxError`.
 */
export function loadTapeCiConfig(filePath: string): TapeCiProjectConfig {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new TapeCiError(
      "INVALID_CONFIG",
      `cannot read TapeCI config ${filePath}: ${errorMessage(error)}`,
      { details: { filePath, reason: errorMessage(error) }, cause: error },
    );
  }

  if (bytes.byteLength > MAX_CONFIG_BYTES) {
    throw new TapeCiError(
      "INVALID_CONFIG",
      `TapeCI config ${filePath} is ${bytes.byteLength} bytes, limit is ${MAX_CONFIG_BYTES}`,
      { details: { filePath, size: bytes.byteLength, max: MAX_CONFIG_BYTES } },
    );
  }

  // Tolerate a UTF-8 BOM written by some editors; JSON.parse would reject it.
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new TapeCiError(
      "INVALID_CONFIG",
      `invalid JSON in TapeCI config ${filePath}: ${errorMessage(error)}`,
      { details: { filePath, reason: errorMessage(error) }, cause: error },
    );
  }

  try {
    return parseTapeCiConfig(json);
  } catch (error) {
    if (isTapeCiError(error) && error.code === "INVALID_CONFIG") {
      throw new TapeCiError("INVALID_CONFIG", `${error.message} (${filePath})`, {
        details: { ...error.details, filePath },
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Build a complete config from defaults plus user overrides (`tapeci init`). The
 * result goes through the same validation as a loaded file, so an invalid container
 * or path is rejected immediately instead of being persisted.
 */
export function createTapeCiConfig(overrides: TapeCiConfigOverrides): TapeCiProjectConfig {
  const { container, site, build, policy, release, ...rest } = overrides;
  return parseTapeCiConfig({
    schemaVersion: rest.schemaVersion ?? TAPECI_CONFIG_SCHEMA_VERSION,
    chainId: rest.chainId ?? TAPECI_CONFIG_CHAIN_ID,
    site: { ...(site ?? {}), container },
    build,
    policy,
    release,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
}
