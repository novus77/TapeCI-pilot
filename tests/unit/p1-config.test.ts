import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TAPECI_CONFIG,
  TAPECI_CONFIG_SCHEMA_VERSION,
  createTapeCiConfig,
  loadTapeCiConfig,
  parseTapeCiConfig,
  type TapeCiProjectConfig,
} from "@tapeci/config";
import { MAX_FILE_BYTES, TapeCiError } from "@tapeci/shared";

const CHECKSUMMED_CONTAINER = "0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3";
const CONTAINER = CHECKSUMMED_CONTAINER.toLowerCase() as `0x${string}`;

interface ConfigIssue {
  readonly path: readonly string[];
  readonly message: string;
}

interface InvalidConfigError extends TapeCiError {
  readonly details: {
    readonly issues: readonly ConfigIssue[];
  } & Readonly<Record<string, unknown>>;
}

/** Minimal valid input: only the fields that cannot have a default are provided. */
function minimalConfig(): Record<string, unknown> {
  return {
    schemaVersion: TAPECI_CONFIG_SCHEMA_VERSION,
    chainId: 196,
    site: { container: CHECKSUMMED_CONTAINER },
  };
}

function catchInvalid(input: unknown): InvalidConfigError {
  let caught: unknown;
  try {
    parseTapeCiConfig(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TapeCiError);
  const error = caught as InvalidConfigError;
  expect(error.code).toBe("INVALID_CONFIG");
  expect(Array.isArray(error.details.issues)).toBe(true);
  return error;
}

function expectInvalidPath(input: unknown, path: readonly string[]): InvalidConfigError {
  const error = catchInvalid(input);
  expect(error.details.issues).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: [...path] })]),
  );
  return error;
}

function withBuild(build: Record<string, unknown>): Record<string, unknown> {
  const config = minimalConfig();
  return { ...config, build: { ...(config.build as Record<string, unknown> | undefined), ...build } };
}

function withPolicy(policy: Record<string, unknown>): Record<string, unknown> {
  return { ...minimalConfig(), policy };
}

const tempDirs: string[] = [];

function writeTempConfig(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tapeci-config-"));
  tempDirs.push(dir);
  const filePath = join(dir, name);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseTapeCiConfig — valid input and defaults", () => {
  it("fills every default from a minimal config and lowercases the container", () => {
    const config = parseTapeCiConfig(minimalConfig());

    expect(config).toEqual({
      ...DEFAULT_TAPECI_CONFIG,
      site: { ...DEFAULT_TAPECI_CONFIG.site, container: CONTAINER },
    });
    expect(config.schemaVersion).toBe(TAPECI_CONFIG_SCHEMA_VERSION);
    expect(config.chainId).toBe(196);
    expect(config.site.container).toBe(CONTAINER);
    expect(config.site.entryPath).toBe("index.html");
    expect(config.site.fallbackPath).toBe("index.html");
    expect(config.build).toEqual({
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDir: "dist",
      timeoutSeconds: 900,
    });
    expect(config.policy).toEqual({
      strictOnChain: true,
      maxFileBytes: MAX_FILE_BYTES,
      ignore: [],
    });
    expect(config.release).toEqual({ pathPrefix: "releases", keepVersions: 5 });
  });

  it("accepts a complete explicit config and round-trips through JSON", () => {
    const input = {
      schemaVersion: TAPECI_CONFIG_SCHEMA_VERSION,
      chainId: 196,
      site: {
        container: CHECKSUMMED_CONTAINER,
        entryPath: "index.html",
        fallbackPath: "404.html",
      },
      build: {
        installCommand: "pnpm install --frozen-lockfile",
        buildCommand: "pnpm build",
        outputDir: "build/site",
        timeoutSeconds: 600,
      },
      policy: {
        strictOnChain: false,
        maxFileBytes: 1_000_000,
        ignore: ["assets/maps"],
      },
      release: {
        pathPrefix: "releases",
        keepVersions: 10,
      },
    };

    const config = parseTapeCiConfig(input);
    const roundTripped = parseTapeCiConfig(JSON.parse(JSON.stringify(config)) as unknown);
    expect(roundTripped).toEqual(config);
    expect(config.site.container).toBe(CONTAINER);
    expect(config.build.installCommand).toBe("pnpm install --frozen-lockfile");
    expect(config.policy.ignore).toEqual(["assets/maps"]);
  });

  it("normalizes canonical path fields (trailing slash, NFD -> NFC, extra slashes)", () => {
    const config = parseTapeCiConfig({
      ...minimalConfig(),
      site: { container: CHECKSUMMED_CONTAINER, fallbackPath: "cafe\u0301.html" },
      build: { outputDir: "dist//client/" },
      policy: { ignore: ["assets/maps/", "**/*.map"] },
      release: { pathPrefix: "releases/" },
    });

    expect(config.site.fallbackPath).toBe("caf\u00e9.html");
    expect(config.build.outputDir).toBe("dist/client");
    expect(config.policy.ignore).toEqual(["assets/maps", "**/*.map"]);
    expect(config.release.pathPrefix).toBe("releases");
  });

  it("returns independent mutable objects (no shared default arrays)", () => {
    const first = parseTapeCiConfig(minimalConfig());
    const second = parseTapeCiConfig(minimalConfig());
    first.policy.ignore.push("dist");
    expect(second.policy.ignore).toEqual([]);
  });

  it("DEFAULT_TAPECI_CONFIG is deeply frozen and is not itself a valid config", () => {
    expect(Object.isFrozen(DEFAULT_TAPECI_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TAPECI_CONFIG.site)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TAPECI_CONFIG.policy.ignore)).toBe(true);
    expect(DEFAULT_TAPECI_CONFIG.site.container).toBe("");
    expectInvalidPath(DEFAULT_TAPECI_CONFIG, ["site", "container"]);
  });
});

describe("parseTapeCiConfig — rejected configs", () => {
  it("rejects a non-object config", () => {
    for (const input of [null, [], "tapeci", 42, true]) {
      catchInvalid(input);
    }
  });

  it("rejects an unknown key at the top level and in every section", () => {
    expect(catchInvalid({ ...minimalConfig(), extra: true }).details.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("extra") })]),
    );
    expect(catchInvalid({ ...minimalConfig(), site: { container: CONTAINER, extra: 1 } }).details.issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: ["site"] })]));
    expect(catchInvalid(withBuild({ extra: 1 })).details.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["build"] })]),
    );
    expect(catchInvalid(withPolicy({ extra: 1 })).details.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["policy"] })]),
    );
    expect(
      catchInvalid({ ...minimalConfig(), release: { keepVersions: 5, extra: 1 } }).details.issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["release"] })]));
  });

  it("rejects a wrong schemaVersion", () => {
    expectInvalidPath(
      { ...minimalConfig(), schemaVersion: "tapeci.config.v2" },
      ["schemaVersion"],
    );
    const missing = minimalConfig();
    delete missing.schemaVersion;
    expectInvalidPath(missing, ["schemaVersion"]);
  });

  it("rejects a chainId other than 196 (including the string form)", () => {
    expectInvalidPath({ ...minimalConfig(), chainId: 1 }, ["chainId"]);
    expectInvalidPath({ ...minimalConfig(), chainId: "196" }, ["chainId"]);
    const missing = minimalConfig();
    delete missing.chainId;
    expectInvalidPath(missing, ["chainId"]);
  });

  it("rejects a missing, malformed or non-hex container address", () => {
    expectInvalidPath({ ...minimalConfig(), site: {} }, ["site", "container"]);
    expectInvalidPath({ ...minimalConfig(), site: { container: "not-an-address" } }, [
      "site",
      "container",
    ]);
    expectInvalidPath({ ...minimalConfig(), site: { container: "0x1234" } }, ["site", "container"]);
    // 41 hex characters
    expectInvalidPath(
      { ...minimalConfig(), site: { container: `0x${"a".repeat(41)}` } },
      ["site", "container"],
    );
  });

  it("rejects entryPath when it is not exactly index.html", () => {
    expectInvalidPath(
      { ...minimalConfig(), site: { container: CONTAINER, entryPath: "main.html" } },
      ["site", "entryPath"],
    );
    expectInvalidPath(
      { ...minimalConfig(), site: { container: CONTAINER, entryPath: "index.HTML" } },
      ["site", "entryPath"],
    );
  });

  it("rejects absolute, traversal and Windows path fields", () => {
    expectInvalidPath(
      { ...minimalConfig(), site: { container: CONTAINER, fallbackPath: "../fallback.html" } },
      ["site", "fallbackPath"],
    );
    expectInvalidPath(withBuild({ outputDir: "../dist" }), ["build", "outputDir"]);
    expectInvalidPath(withBuild({ outputDir: "a/../../dist" }), ["build", "outputDir"]);
    expectInvalidPath(withBuild({ outputDir: "/tmp/dist" }), ["build", "outputDir"]);
    expectInvalidPath(withBuild({ outputDir: "C:/dist" }), ["build", "outputDir"]);
    expectInvalidPath(withBuild({ outputDir: "dist\\client" }), ["build", "outputDir"]);
    expectInvalidPath(
      { ...minimalConfig(), release: { pathPrefix: "../releases" } },
      ["release", "pathPrefix"],
    );
  });

  it("rejects empty outputDir and dot-segment outputDir", () => {
    expectInvalidPath(withBuild({ outputDir: "" }), ["build", "outputDir"]);
    expectInvalidPath(withBuild({ outputDir: "." }), ["build", "outputDir"]);
    expectInvalidPath(withBuild({ outputDir: "./dist" }), ["build", "outputDir"]);
    expectInvalidPath(withBuild({ outputDir: "/" }), ["build", "outputDir"]);
  });

  it("rejects maxFileBytes outside 1..8,400,000", () => {
    expectInvalidPath(withPolicy({ maxFileBytes: 0 }), ["policy", "maxFileBytes"]);
    expectInvalidPath(withPolicy({ maxFileBytes: -1 }), ["policy", "maxFileBytes"]);
    expectInvalidPath(withPolicy({ maxFileBytes: MAX_FILE_BYTES + 1 }), [
      "policy",
      "maxFileBytes",
    ]);
    expectInvalidPath(withPolicy({ maxFileBytes: 1.5 }), ["policy", "maxFileBytes"]);
    expect(parseTapeCiConfig(withPolicy({ maxFileBytes: MAX_FILE_BYTES })).policy.maxFileBytes).toBe(
      MAX_FILE_BYTES,
    );
    expect(parseTapeCiConfig(withPolicy({ maxFileBytes: 1 })).policy.maxFileBytes).toBe(1);
  });

  it("rejects timeoutSeconds outside 1..3600", () => {
    expectInvalidPath(withBuild({ timeoutSeconds: 0 }), ["build", "timeoutSeconds"]);
    expectInvalidPath(withBuild({ timeoutSeconds: 3_601 }), ["build", "timeoutSeconds"]);
    expectInvalidPath(withBuild({ timeoutSeconds: 1.5 }), ["build", "timeoutSeconds"]);
  });

  it("rejects keepVersions outside 1..50", () => {
    expectInvalidPath({ ...minimalConfig(), release: { keepVersions: 0 } }, [
      "release",
      "keepVersions",
    ]);
    expectInvalidPath({ ...minimalConfig(), release: { keepVersions: 51 } }, [
      "release",
      "keepVersions",
    ]);
    expectInvalidPath({ ...minimalConfig(), release: { keepVersions: 2.5 } }, [
      "release",
      "keepVersions",
    ]);
  });

  it("rejects empty, blank, NUL-containing and over-long commands", () => {
    expectInvalidPath(withBuild({ installCommand: "" }), ["build", "installCommand"]);
    expectInvalidPath(withBuild({ installCommand: "   " }), ["build", "installCommand"]);
    expectInvalidPath(withBuild({ installCommand: "npm ci\u0000rm -rf /" }), [
      "build",
      "installCommand",
    ]);
    expectInvalidPath(withBuild({ buildCommand: "x".repeat(501) }), [
      "build",
      "buildCommand",
    ]);
    expect(parseTapeCiConfig(withBuild({ buildCommand: "x".repeat(500) })).build.buildCommand).toBe(
      "x".repeat(500),
    );
  });

  it("rejects traversal, absolute and non-string ignore entries", () => {
    expectInvalidPath(withPolicy({ ignore: ["../secrets"] }), ["policy", "ignore", "0"]);
    expectInvalidPath(withPolicy({ ignore: ["assets/../../secrets"] }), [
      "policy",
      "ignore",
      "0",
    ]);
    expectInvalidPath(withPolicy({ ignore: ["/etc/passwd"] }), ["policy", "ignore", "0"]);
    expectInvalidPath(withPolicy({ ignore: ["ok", 42] }), ["policy", "ignore", "1"]);
  });

  it("rejects more than 100 ignore entries but accepts exactly 100", () => {
    const hundred = Array.from({ length: 100 }, (_unused, index) => `assets/${index}.js`);
    expect(parseTapeCiConfig(withPolicy({ ignore: hundred })).policy.ignore).toEqual(hundred);
    expectInvalidPath(withPolicy({ ignore: [...hundred, "one-too-many.js"] }), [
      "policy",
      "ignore",
    ]);
  });

  it("rejects non-boolean strictOnChain", () => {
    expectInvalidPath(withPolicy({ strictOnChain: "true" }), ["policy", "strictOnChain"]);
  });
});

describe("createTapeCiConfig (tapeci init)", () => {
  it("builds a full config from defaults", () => {
    const config = createTapeCiConfig({ container: CHECKSUMMED_CONTAINER });
    expect(config).toEqual({
      ...DEFAULT_TAPECI_CONFIG,
      site: { ...DEFAULT_TAPECI_CONFIG.site, container: CONTAINER },
    });
  });

  it("merges nested overrides over the defaults", () => {
    const config = createTapeCiConfig({
      container: CHECKSUMMED_CONTAINER,
      build: { buildCommand: "pnpm build" },
      policy: { strictOnChain: false },
      release: { keepVersions: 3, pathPrefix: "versions" },
    });

    expect(config.build).toEqual({
      installCommand: "npm ci",
      buildCommand: "pnpm build",
      outputDir: "dist",
      timeoutSeconds: 900,
    });
    expect(config.policy.strictOnChain).toBe(false);
    expect(config.policy.maxFileBytes).toBe(MAX_FILE_BYTES);
    expect(config.release).toEqual({ pathPrefix: "versions", keepVersions: 3 });
  });

  it("rejects an invalid container or invalid override", () => {
    expect(() => createTapeCiConfig({ container: "0xnothex" })).toThrowError(TapeCiError);
    expect(() => createTapeCiConfig({ container: CONTAINER, release: { keepVersions: 99 } })).toThrowError(
      TapeCiError,
    );
    expect(() => createTapeCiConfig({ container: CONTAINER, chainId: 1 as 196 })).toThrowError(
      TapeCiError,
    );
  });
});

describe("loadTapeCiConfig", () => {
  it("loads a valid file and produces the same config as parse", () => {
    const filePath = writeTempConfig("tapeci.json", JSON.stringify(minimalConfig(), null, 2));
    const loaded = loadTapeCiConfig(filePath);
    expect(loaded).toEqual(parseTapeCiConfig(minimalConfig()));
  });

  it("tolerates a UTF-8 BOM", () => {
    const filePath = writeTempConfig(
      "tapeci-bom.json",
      `\uFEFF${JSON.stringify(minimalConfig(), null, 2)}`,
    );
    expect(loadTapeCiConfig(filePath)).toEqual(parseTapeCiConfig(minimalConfig()));
  });

  it("turns invalid JSON into INVALID_CONFIG with the file path", () => {
    const filePath = writeTempConfig("broken.json", "{ not json ");
    let caught: unknown;
    try {
      loadTapeCiConfig(filePath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TapeCiError);
    const error = caught as TapeCiError;
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("invalid JSON");
    expect(error.details.filePath).toBe(filePath);
  });

  it("turns a missing file into INVALID_CONFIG", () => {
    const missing = join(tmpdir(), `tapeci-missing-${process.pid}-${Date.now()}.json`);
    let caught: unknown;
    try {
      loadTapeCiConfig(missing);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TapeCiError);
    const error = caught as TapeCiError;
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("cannot read");
    expect(error.details.filePath).toBe(missing);
  });

  it("reports schema errors with the offending path and the file path", () => {
    const filePath = writeTempConfig(
      "bad-chain.json",
      JSON.stringify({ ...minimalConfig(), chainId: 1 }),
    );
    let caught: unknown;
    try {
      loadTapeCiConfig(filePath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TapeCiError);
    const error = caught as InvalidConfigError;
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.details.filePath).toBe(filePath);
    expect(error.details.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["chainId"] })]),
    );
  });

  it("rejects JSON that is not an object", () => {
    const filePath = writeTempConfig("array.json", "[]");
    expect(() => loadTapeCiConfig(filePath)).toThrowError(TapeCiError);
  });

  it("rejects a config whose container address is empty", () => {
    const filePath = writeTempConfig("empty-container.json", JSON.stringify(DEFAULT_TAPECI_CONFIG));
    expect(() => loadTapeCiConfig(filePath)).toThrowError(TapeCiError);
  });
});

describe("TapeCiProjectConfig type contract", () => {
  it("exposes the documented shape", () => {
    const config: TapeCiProjectConfig = createTapeCiConfig({ container: CONTAINER });
    const keys: Array<keyof TapeCiProjectConfig> = [
      "schemaVersion",
      "chainId",
      "site",
      "build",
      "policy",
      "release",
    ];
    expect(Object.keys(config).sort()).toEqual([...keys].sort());
    expect(config.site.container).toBe(CONTAINER);
  });
});
