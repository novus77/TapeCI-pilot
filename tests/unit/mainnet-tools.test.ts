/**
 * P2-10 RC release / rollback tooling — pure unit tests.
 *
 * No network, no database, no Redis: only argument parsing/validation, tar path
 * filtering, plan-fee extraction, the `--cap-wei` guard and the poll classifier.
 * The tar tests touch a temporary directory so the AppleDouble/`.DS_Store`/
 * symlink exclusions are proven against a real filesystem walk.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isTapeCiError } from "@tapeci/shared";
import { DEPLOYMENT_STATES, TERMINAL_STATES } from "@tapeci/queue";
import {
  checkCap,
  collectArtifactEntries,
  buildArtifactTar,
  filterArtifactPaths,
  isIgnoredArtifactName,
  isSafeArtifactRelativePath,
  normalizeArtifactRelativePath,
  parseCapWei,
  parseFlags,
  parseReleaseArgs,
  parseRollbackArgs,
  parseWeiString,
  pollStatus,
  readPlanFees,
  shouldIncludeArtifactPath,
  type ReleaseArgs,
  type RollbackArgs,
} from "../../scripts/p2/mainnet-tooling.js";

const PROJECT = "8c784556-477a-4c7b-bb1b-51c8732c1d18";
const COMMIT = "147c0d8533c82c3f9ac5922a44122f5ce77080f7";
const RELEASE = "r-147c0d8533c8-0ad76bec";
const RELEASE_ROW = "a545709a-2629-441c-a0c1-e60ba2c6569e";

const temporaryDirectories: string[] = [];
async function tempDir(prefix = "tapeci-mainnet-tools-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}
afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

function expectConfigError(fn: () => unknown, fragment: string): void {
  try {
    fn();
  } catch (error) {
    expect(isTapeCiError(error)).toBe(true);
    if (!isTapeCiError(error)) return;
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain(fragment);
    return;
  }
  throw new Error(`expected an INVALID_CONFIG error containing ${JSON.stringify(fragment)}`);
}

describe("parseFlags", () => {
  const specs = [
    { name: "project", takesValue: true },
    { name: "cap-wei", takesValue: true },
    { name: "help", takesValue: false },
  ] as const;

  it("accepts space-separated and inline values, switches and a bare --", () => {
    const parsed = parseFlags(
      ["--", "--project", PROJECT, "--cap-wei=1000", "--help"],
      specs,
    );
    expect(parsed.values.get("project")).toBe(PROJECT);
    expect(parsed.values.get("cap-wei")).toBe("1000");
    expect(parsed.switches.has("help")).toBe(true);
  });

  it("rejects unknown flags, positionals, duplicates and missing values", () => {
    expectConfigError(() => parseFlags(["--nope", "x"], specs), "unknown flag --nope");
    expectConfigError(() => parseFlags(["dist"], specs), "unexpected positional argument");
    expectConfigError(
      () => parseFlags(["--project", PROJECT, "--project", PROJECT], specs),
      "duplicate flag --project",
    );
    expectConfigError(() => parseFlags(["--project"], specs), "missing value for --project");
    expectConfigError(
      () => parseFlags(["--project", "--help"], specs),
      "missing value for --project",
    );
    expectConfigError(() => parseFlags(["--help=1"], specs), "--help does not take a value");
    expectConfigError(() => parseFlags(["--project", "  "], specs), "empty value for --project");
  });
});

describe("release argument parsing", () => {
  it("parses the documented flag set", () => {
    const parsed = parseReleaseArgs([
      "--project",
      PROJECT,
      "--dist",
      "dist",
      "--commit",
      COMMIT,
      "--cap-wei",
      "2000000000000000",
    ]);
    expect("help" in parsed).toBe(false);
    const args = parsed as ReleaseArgs;
    expect(args.projectId).toBe(PROJECT);
    expect(args.dist).toBe("dist");
    expect(args.commitSha).toBe(COMMIT);
    expect(args.capWei).toBe(2_000_000_000_000_000n);
    expect(args.timeoutMs).toBe(180_000);
    expect(args.pollMs).toBe(2_000);
  });

  it("leaves the cap guard unset when --cap-wei is absent", () => {
    const parsed = parseReleaseArgs([
      "--project",
      PROJECT,
      "--dist",
      "dist",
      "--commit",
      COMMIT,
    ]);
    expect((parsed as ReleaseArgs).capWei).toBeNull();
  });

  it("accepts --help without the required flags", () => {
    expect(parseReleaseArgs(["--help"])).toEqual({ help: true });
  });

  it("requires project, dist and commit", () => {
    expectConfigError(() => parseReleaseArgs(["--dist", "d", "--commit", COMMIT]), "--project is required");
    expectConfigError(
      () => parseReleaseArgs(["--project", PROJECT, "--commit", COMMIT]),
      "--dist is required",
    );
    expectConfigError(
      () => parseReleaseArgs(["--project", PROJECT, "--dist", "d"]),
      "--commit is required",
    );
  });

  it("rejects malformed ids, commits and caps", () => {
    expectConfigError(
      () => parseReleaseArgs(["--project", "not-a-uuid", "--dist", "d", "--commit", COMMIT]),
      "--project must be a UUID",
    );
    expectConfigError(
      () =>
        parseReleaseArgs([
          "--project",
          PROJECT,
          "--dist",
          "d",
          "--commit",
          COMMIT.toUpperCase(),
        ]),
      "--commit must be a lowercase 40-character hex commit SHA",
    );
    expectConfigError(
      () => parseReleaseArgs(["--project", PROJECT, "--dist", "d", "--commit", COMMIT.slice(0, 39)]),
      "--commit must be a lowercase 40-character hex commit SHA",
    );
    expectConfigError(
      () =>
        parseReleaseArgs([
          "--project",
          PROJECT,
          "--dist",
          "d",
          "--commit",
          COMMIT,
          "--cap-wei",
          "0x10",
        ]),
      "--cap-wei must be a decimal wei value",
    );
    expectConfigError(
      () =>
        parseReleaseArgs([
          "--project",
          PROJECT,
          "--dist",
          "d",
          "--commit",
          COMMIT,
          "--cap-wei",
          "0",
        ]),
      "--cap-wei must be greater than zero",
    );
    expectConfigError(
      () =>
        parseReleaseArgs([
          "--project",
          PROJECT,
          "--dist",
          "d",
          "--commit",
          COMMIT,
          "--timeout-ms",
          "-1",
        ]),
      "--timeout-ms must be a positive integer",
    );
  });
});

describe("rollback argument parsing", () => {
  it("accepts a public release id", () => {
    const parsed = parseRollbackArgs(["--project", PROJECT, "--release", RELEASE]);
    const args = parsed as RollbackArgs;
    expect(args.release).toBe(RELEASE);
    expect(args.capWei).toBeNull();
    expect(args.timeoutMs).toBe(180_000);
  });

  it("accepts a release row UUID", () => {
    const parsed = parseRollbackArgs(["--project", PROJECT, "--release", RELEASE_ROW]);
    expect((parsed as RollbackArgs).release).toBe(RELEASE_ROW);
  });

  it("requires --release and validates its shape", () => {
    expectConfigError(() => parseRollbackArgs(["--project", PROJECT]), "--release is required");
    expectConfigError(
      () => parseRollbackArgs(["--project", PROJECT, "--release", "r-147c0d8533c8"]),
      "--release must be a release id",
    );
    expectConfigError(
      () => parseRollbackArgs(["--project", PROJECT, "--release", RELEASE, "--dist", "d"]),
      "unknown flag --dist",
    );
  });

  it("supports --help", () => {
    expect(parseRollbackArgs(["--help"])).toEqual({ help: true });
  });
});

describe("wei parsing and the cap guard", () => {
  it("parses decimal wei strings only", () => {
    expect(parseWeiString("15807936000000", "cap")).toBe(15_807_936_000_000n);
    expect(parseWeiString("0", "cap")).toBe(0n);
    expectConfigError(() => parseWeiString("1.5", "cap"), "must be a decimal wei string");
    expectConfigError(() => parseWeiString(15, "cap"), "must be a decimal wei string");
    expectConfigError(() => parseWeiString("-1", "cap"), "must be a decimal wei string");
  });

  it("treats an absent cap as no guard", () => {
    expect(parseCapWei(undefined)).toBeNull();
    expect(checkCap(15n, null)).toEqual({
      ok: true,
      capWei: null,
      recommendedCapWei: 15n,
      overByWei: 0n,
    });
  });

  it("fails exactly when the recommended cap exceeds --cap-wei", () => {
    expect(checkCap(100n, 100n).ok).toBe(true);
    expect(checkCap(100n, 100n).overByWei).toBe(0n);
    const over = checkCap(101n, 100n);
    expect(over.ok).toBe(false);
    expect(over.overByWei).toBe(1n);
    expect(checkCap(0n, 1n).ok).toBe(true);
  });
});

describe("plan fee extraction", () => {
  const plan = {
    fees: {
      gasPriceWei: "20000000",
      estimatedGas: "658664",
      estimatedCostWei: "13173280000000",
      marginBps: 2000,
      recommendedCapWei: "15807936000000",
      costCapWei: null,
      withinBudget: true,
      overBudgetByWei: "0",
    },
  };

  it("reads the fee block from a stored plan", () => {
    const fees = readPlanFees(plan);
    expect(fees).not.toBeNull();
    expect(fees?.estimatedCostWei).toBe(13_173_280_000_000n);
    expect(fees?.recommendedCapWei).toBe(15_807_936_000_000n);
    expect(fees?.marginBps).toBe(2000);
    expect(fees?.withinBudget).toBe(true);
  });

  it("returns null when there is no plan yet", () => {
    expect(readPlanFees(null)).toBeNull();
    expect(readPlanFees({})).toBeNull();
    expect(readPlanFees({ fees: null })).toBeNull();
  });

  it("refuses to guess a malformed fee block", () => {
    expectConfigError(
      () => readPlanFees({ fees: { ...plan.fees, recommendedCapWei: 15 } }),
      "recommendedCapWei must be a decimal wei string",
    );
    expectConfigError(
      () => readPlanFees({ fees: { ...plan.fees, marginBps: 12.5 } }),
      "marginBps is missing or invalid",
    );
  });
});

describe("poll classification", () => {
  it("classifies PLAN_READY, terminal and in-flight states", () => {
    expect(pollStatus("PLAN_READY", TERMINAL_STATES)).toBe("READY");
    expect(pollStatus("PLAN_REJECTED", TERMINAL_STATES)).toBe("TERMINAL");
    expect(pollStatus("FEE_OVER_BUDGET", TERMINAL_STATES)).toBe("TERMINAL");
    expect(pollStatus("VALIDATING", TERMINAL_STATES)).toBe("PENDING");
    expect(pollStatus("BUILT", TERMINAL_STATES)).toBe("PENDING");
  });

  it("never treats LIVE as a plan success", () => {
    expect(pollStatus("LIVE", TERMINAL_STATES)).toBe("TERMINAL");
  });

  it("uses the queue package as the single source of truth", () => {
    expect(TERMINAL_STATES).not.toContain("PLAN_READY");
    expect(TERMINAL_STATES).not.toContain("BUILT");
    expect(DEPLOYMENT_STATES).toContain("PLAN_READY");
  });
});

describe("tar path filtering", () => {
  it("strips the ./ root and duplicate slashes", () => {
    expect(normalizeArtifactRelativePath("./index.html")).toBe("index.html");
    expect(normalizeArtifactRelativePath(".//assets//app.js")).toBe("assets/app.js");
    expect(normalizeArtifactRelativePath("./")).toBe("");
    expect(normalizeArtifactRelativePath("/index.html")).toBe("index.html");
  });

  it("drops macOS metadata in any segment", () => {
    expect(isIgnoredArtifactName(".DS_Store")).toBe(true);
    expect(isIgnoredArtifactName("._index.html")).toBe(true);
    expect(isIgnoredArtifactName("app.js")).toBe(false);
    expect(shouldIncludeArtifactPath("./.DS_Store")).toBe(false);
    expect(shouldIncludeArtifactPath("assets/._app.js")).toBe(false);
    expect(shouldIncludeArtifactPath(".DS_Store")).toBe(false);
  });

  it("excludes the tar root marker and unsafe paths", () => {
    expect(shouldIncludeArtifactPath(".")).toBe(false);
    expect(shouldIncludeArtifactPath("./")).toBe(false);
    expect(shouldIncludeArtifactPath("")).toBe(false);
    expect(shouldIncludeArtifactPath("../escape.html")).toBe(false);
    expect(shouldIncludeArtifactPath("a/../b.html")).toBe(false);
    expect(shouldIncludeArtifactPath("a/./b.html")).toBe(false);
    expect(shouldIncludeArtifactPath("/etc/passwd")).toBe(false);
    expect(shouldIncludeArtifactPath("C:/windows.html")).toBe(false);
    expect(shouldIncludeArtifactPath("back\\slash.html")).toBe(false);
    expect(shouldIncludeArtifactPath("nul\u0000byte.html")).toBe(false);
    expect(isSafeArtifactRelativePath("index.html")).toBe(true);
    expect(isSafeArtifactRelativePath("assets/app.js")).toBe(true);
  });

  it("normalizes, dedupes and sorts deterministically", () => {
    const filtered = filterArtifactPaths([
      "./index.html",
      "assets/app.js",
      ".DS_Store",
      "assets/._app.js",
      "index.html",
      "sub/site.css",
      "../escape.html",
    ]);
    expect(filtered).toEqual(["assets/app.js", "index.html", "sub/site.css"]);
  });

  it("walks a real directory, skipping metadata and symlinks", async () => {
    const dist = await tempDir();
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(join(dist, "index.html"), "<html></html>");
    await writeFile(join(dist, "assets/app.js"), "console.log(1)");
    await writeFile(join(dist, ".DS_Store"), "junk");
    await writeFile(join(dist, "._index.html"), "junk");
    await writeFile(join(dist, "assets/._app.js"), "junk");
    await symlink("index.html", join(dist, "link.html"));

    const entries = await collectArtifactEntries(dist);
    expect(entries.files).toEqual(["assets/app.js", "index.html"]);
    expect(entries.skipped.map((entry) => entry.path).sort()).toEqual([
      ".DS_Store",
      "._index.html",
      "assets/._app.js",
      "link.html",
    ]);
    expect(entries.skipped.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("refuses a missing or symlinked dist directory", async () => {
    const root = await tempDir();
    const target = join(root, "real");
    await mkdir(target);
    await symlink(target, join(root, "link"));
    await expect(collectArtifactEntries(join(root, "missing"))).rejects.toThrow(/not readable/);
    await expect(collectArtifactEntries(join(root, "link"))).rejects.toThrow(/symbolic link/);
  });

  it("builds a deterministic tar with no ./ root entry", async () => {
    const dist = await tempDir();
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(join(dist, "index.html"), "<html></html>");
    await writeFile(join(dist, "assets/app.js"), "console.log(1)");

    const first = await buildArtifactTar(dist, ["./index.html", "assets/app.js"]);
    const second = await buildArtifactTar(dist, ["assets/app.js", "index.html"]);
    expect(first.sha256).toBe(second.sha256);
    expect(first.entryPaths).toEqual(["assets/app.js", "index.html"]);

    // Parse the archive back: entries must be exactly the two files, no "./" root.
    const tar = await import("tar");
    const seen: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const parser = new tar.Parser();
      parser.on("entry", (entry) => {
        seen.push(entry.path);
        entry.resume();
      });
      parser.on("end", () => resolve());
      parser.on("error", reject);
      parser.end(Buffer.from(first.bytes));
    });
    expect(seen.sort()).toEqual(["assets/app.js", "index.html"]);
    expect(seen.some((path) => path === "." || path === "./" || path.startsWith("./"))).toBe(false);
  });

  it("refuses to build an empty tar", async () => {
    const dist = await tempDir();
    await writeFile(join(dist, ".DS_Store"), "junk");
    await expect(buildArtifactTar(dist, [".DS_Store"])).rejects.toThrow(/would be empty/);
  });

  it("refuses non-NFC paths instead of archiving a different file", async () => {
    const dist = await tempDir();
    // `é` as e + combining acute is the non-NFC spelling of the same name.
    const decomposed = "cafe\u0301.html";
    await writeFile(join(dist, decomposed.normalize("NFC")), "<html></html>");
    await expect(buildArtifactTar(dist, [decomposed])).rejects.toThrow(/NFC-normalized/);
  });
});

describe("deterministic tar mode", () => {
  it("hashes identically for mode 0644 and 0755 inputs", async () => {
    const { buildArtifactTar } = await import("../../scripts/p2/mainnet-tooling.js");
    const { mkdtemp, mkdir, writeFile, chmod, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "tapeci-tar-mode-"));
    try {
      await mkdir(join(root, "assets"), { recursive: true });
      await writeFile(join(root, "index.html"), "<html>mode</html>");
      await writeFile(join(root, "assets/app.js"), "console.log(1);");
      const first = await buildArtifactTar(root, ["index.html", "assets/app.js"]);
      await chmod(join(root, "index.html"), 0o755);
      await chmod(join(root, "assets/app.js"), 0o755);
      const second = await buildArtifactTar(root, ["index.html", "assets/app.js"]);
      expect(second.sha256).toBe(first.sha256);
      expect(second.bytes.length).toBe(first.bytes.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
