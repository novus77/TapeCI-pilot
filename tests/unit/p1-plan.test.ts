import { describe, expect, it } from "vitest";
import { buildReleaseManifest } from "@tapeci/artifact";
import { XLAYER_MAINNET } from "@tapeci/config";
import {
  OBSERVED_XLAYER_GAS_MODEL,
  RELEASE_PLAN_SCHEMA_VERSION,
  diffReleasePlan,
  estimateFileGas,
  estimatePlanFees,
  estimateTotalGas,
  formatOkb,
  planToJson,
  recommendedCapWei,
  type PlanOnChainFile,
  type ReleasePlan,
} from "@tapeci/deployer";
import { TapeCiError, sha256Hex, utf8 } from "@tapeci/shared";

const CONTAINER = "0x25b20d3ea6b207506340eab2eb0f45edc800f6b3";
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

function makeManifest() {
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new Error("no registry");
  return buildReleaseManifest({
    chainId: 196,
    siteRegistry: registry,
    container: CONTAINER,
    repositoryId: 42,
    commitSha: COMMIT_SHA,
    entryPath: "index.html",
    fallbackPath: "index.html",
    pathPrefix: "releases",
    files: [
      {
        path: "index.html",
        size: 100,
        sha256: sha256Hex(utf8("x".repeat(100))),
        contentType: "text/html; charset=utf-8",
      },
      {
        path: "assets/app.js",
        size: 200,
        sha256: sha256Hex(utf8("y".repeat(200))),
        contentType: "text/javascript; charset=utf-8",
      },
    ],
  }).manifest;
}

function same(file: { size: number; sha256: string; contentType: string; chunks: number }): PlanOnChainFile {
  return {
    exists: true,
    size: file.size,
    sha256: file.sha256 as `0x${string}`,
    contentType: file.contentType,
    chunkCount: file.chunks,
  };
}

describe("P1-05 gas model and fee plan", () => {
  it("estimates chunk gas with the fork-calibrated model without under-quoting", () => {
    expect(estimateFileGas(0)).toBe(310_000n);
    expect(estimateFileGas(1)).toBe(310_216n);
    // P0-05 measured 5,490,912 gas for a 24,000-byte putFile on the fork.
    expect(estimateFileGas(24_000)).toBe(5_494_000n);
    expect(estimateFileGas(24_000)).toBeGreaterThanOrEqual(5_490_912n);
    expect(estimateFileGas(24_001)).toBe(310_000n + 180_000n + 24_001n * 216n);
    expect(estimateFileGas(65_000)).toBe(310_000n + 2n * 180_000n + 65_000n * 216n);
    expect(estimateTotalGas([1, 24_000])).toBe(estimateFileGas(1) + estimateFileGas(24_000));
    expect(OBSERVED_XLAYER_GAS_MODEL.defaultMarginBps).toBe(2_000);
  });

  it("computes cost, recommended cap and budget status", () => {
    const gasPriceWei = 20_000_001n;
    const gas = 1_000_000n;
    const cost = gas * gasPriceWei;
    const result = estimatePlanFees({ estimatedGas: gas, gasPriceWei, marginBps: 2_000 });
    expect(result.fees.estimatedCostWei).toBe(cost);
    expect(result.fees.recommendedCapWei).toBe(recommendedCapWei(cost, 2_000));
    expect(result.fees.recommendedCapWei).toBe((cost * 12_000n + 9_999n) / 10_000n);
    expect(result.fees.withinBudget).toBe(true);
    expect(result.sufficientBalance).toBeNull();

    expect(
      estimatePlanFees({ estimatedGas: gas, gasPriceWei, marginBps: 0, costCapWei: cost }).fees
        .withinBudget,
    ).toBe(true);
    const over = estimatePlanFees({
      estimatedGas: gas,
      gasPriceWei,
      marginBps: 0,
      costCapWei: cost - 1n,
    });
    expect(over.fees.withinBudget).toBe(false);
    expect(over.fees.overBudgetByWei).toBe(1n);

    expect(
      estimatePlanFees({
        estimatedGas: gas,
        gasPriceWei,
        marginBps: 0,
        signerBalanceWei: cost - 1n,
      }).sufficientBalance,
    ).toBe(false);
    expect(
      estimatePlanFees({
        estimatedGas: gas,
        gasPriceWei,
        marginBps: 0,
        signerBalanceWei: cost,
      }).sufficientBalance,
    ).toBe(true);

    expect(() =>
      estimatePlanFees({ estimatedGas: gas, gasPriceWei, marginBps: 6_000 }),
    ).toThrowError(TapeCiError);
  });

  it("formats wei as OKB for human review", () => {
    expect(formatOkb(0n)).toBe("0.000000 OKB");
    expect(formatOkb(1_500_000_000_000_000_000n)).toBe("1.500000 OKB");
    // A positive amount must never read as zero (issue P1-04). `123n` at 2 dp used
    // to render "0.00 OKB"; it now prints the exact value instead.
    expect(formatOkb(123n, 2)).toBe("0.000000000000000123 OKB");
    expect(formatOkb(1n)).toBe("0.000000000000000001 OKB");
    expect(formatOkb(0n, 2)).toBe("0.00 OKB");
    expect(formatOkb(999_999_999_999_999_999n, 2)).toBe("0.999999999999999999 OKB");
  });
});

describe("P1-05 on-chain diff", () => {
  it("classifies missing, identical, versioned-conflict and entry replacement", () => {
    const manifest = makeManifest();
    const entry = manifest.files.find((file) => file.path === "index.html");
    const asset = manifest.files.find((file) => file.path !== "index.html");
    if (entry === undefined || asset === undefined) throw new Error("manifest fixture incomplete");

    // Nothing on chain: both files are writes.
    const empty = diffReleasePlan({ manifest, onChain: new Map() });
    expect(empty.files.map((file) => file.action)).toEqual(["WRITE", "WRITE"]);
    expect(empty.totals).toMatchObject({ files: 2, writes: 2, unchanged: 0, conflicts: 0 });
    expect(empty.totals.chunks).toBe(2);
    expect(empty.totals.bytes).toBe(300);

    // Identical entry + missing asset: entry UNCHANGED, asset WRITE.
    const partial = diffReleasePlan({
      manifest,
      onChain: new Map([["index.html", same(entry)]]),
    });
    expect(partial.files.find((file) => file.path === "index.html")?.action).toBe("UNCHANGED");
    expect(partial.files.find((file) => file.path === asset.path)?.action).toBe("WRITE");
    expect(partial.totals).toMatchObject({ writes: 1, unchanged: 1, conflicts: 0 });

    // Entry differs: allowed controlled cutover -> WRITE, not CONFLICT.
    const entryChanged = diffReleasePlan({
      manifest,
      onChain: new Map([
        [
          "index.html",
          {
            ...same(entry),
            sha256: sha256Hex(utf8("old entry")),
            size: 9,
          },
        ],
      ]),
    });
    expect(entryChanged.files.find((file) => file.path === "index.html")?.action).toBe("WRITE");
    expect(entryChanged.files.find((file) => file.path === "index.html")?.reason).toContain(
      "controlled cutover",
    );

    // Versioned asset differs: CONFLICT and zero gas for it.
    const conflict = diffReleasePlan({
      manifest,
      onChain: new Map([
        ["index.html", same(entry)],
        [
          asset.path,
          {
            ...same(asset),
            sha256: sha256Hex(utf8("different")),
            size: 9,
          },
        ],
      ]),
    });
    const conflictAction = conflict.files.find((file) => file.path === asset.path);
    expect(conflictAction?.action).toBe("CONFLICT");
    expect(conflictAction?.estimatedGas).toBe(0n);
    expect(conflict.totals).toMatchObject({ writes: 0, unchanged: 1, conflicts: 1, chunks: 0, bytes: 0 });
  });

  it("serializes bigint fields to decimal strings for evidence", () => {
    const manifest = makeManifest();
    const diff = diffReleasePlan({ manifest, onChain: new Map() });
    const plan: ReleasePlan = {
      schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
      chainId: 196,
      container: CONTAINER as `0x${string}`,
      siteRegistry: manifest.siteRegistry,
      commitSha: COMMIT_SHA,
      releaseId: manifest.releaseId,
      artifactDigest: manifest.files[0]?.sha256 ?? ("0x" as `0x${string}`),
      releaseManifestHash: manifest.files[0]?.sha256 ?? ("0x" as `0x${string}`),
      entryPath: "index.html",
      pinnedBlockNumber: 73_623_612n,
      pinnedBlockHash: `0x${"ab".repeat(32)}`,
      operators: ["okx", "drpc"],
      observedAt: "2026-10-19T00:00:00.000Z",
      files: diff.files,
      totals: diff.totals,
      fees: {
        gasPriceWei: 20_000_001n,
        estimatedGas: 10n,
        estimatedCostWei: 200_000_010n,
        marginBps: 2_000,
        recommendedCapWei: 240_000_012n,
        costCapWei: null,
        withinBudget: true,
        overBudgetByWei: 0n,
      },
      containerOwner: "0x571d447f4f24688eC35Ccf07f1D6993655F6aF15",
      containerOpened: true,
      signer: null,
      signerIsHolder: null,
      signerBalanceWei: null,
      sufficientBalance: null,
      blocked: false,
      blockedReasons: [],
      warnings: [],
    };
    const json = planToJson(plan) as Record<string, unknown>;
    expect(json.pinnedBlockNumber).toBe("73623612");
    const fees = json.fees as Record<string, unknown>;
    expect(fees.gasPriceWei).toBe("20000001");
    const files = json.files as Array<Record<string, unknown>>;
    expect(files[0]?.estimatedGas).toBeTypeOf("string");
    expect(typeof JSON.stringify(json)).toBe("string");
  });
});
