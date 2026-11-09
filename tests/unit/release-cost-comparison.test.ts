import { describe, expect, it } from "vitest";
import { compareReleaseCosts, selectReleaseStrategy } from "../../packages/deployer/src/comparison.js";
import { diffReleasePlan, estimatePlanFees, type ReleasePlan } from "@tapeci/deployer";
import { prepareVersionedRelease, prepareCompressedRelease } from "@tapeci/release";
import { analyzeCompression } from "../../packages/compression/src/index.js";
import { scanArtifactFiles } from "@tapeci/validator";
const context = { chainId: 196 as const, container: `0x${"11".repeat(20)}` as const, siteRegistry: `0x${"22".repeat(20)}` as const, repositoryId: 1, commitSha: "a".repeat(40) };
function plans() {
  const files = scanArtifactFiles([{ relativePath: "index.html", bytes: Buffer.from('<script src="app.js"></script>') }, { relativePath: "app.js", bytes: Buffer.from('console.log("cost");'.repeat(2000)) }]).files;
  const original = prepareVersionedRelease({ ...context, files });
  const compressed = prepareCompressedRelease({ ...context, candidate: analyzeCompression(files).candidates[2]! });
  function plan(prepared: typeof original | typeof compressed): ReleasePlan {
    const diff = diffReleasePlan({ manifest: prepared.manifest, onChain: new Map() });
    return { schemaVersion: "tapeci.plan.v1", ...context, releaseId: prepared.releaseId, artifactDigest: prepared.artifactDigest, releaseManifestHash: prepared.releaseManifestHash, entryPath: "index.html", pinnedBlockNumber: 10n, pinnedBlockHash: `0x${"ab".repeat(32)}`, operators: ["a", "b"], observedAt: "2026-10-28T00:00:00Z", ...diff, fees: estimatePlanFees({ estimatedGas: diff.files.reduce((sum, file) => sum + file.estimatedGas, 0n), gasPriceWei: 2n, marginBps: 2000 }).fees, containerOwner: null, containerOpened: true, signer: null, signerIsHolder: null, signerBalanceWei: null, sufficientBalance: null, blocked: false, blockedReasons: [], warnings: [] };
  }
  return { original: plan(original), compressed: plan(compressed) };
}

it("compares complete physical plan costs and explicit fees without enabling automatic compression", () => {
  const p = plans();
  const result = compareReleaseCosts({ ...p, originalServiceFeeWei: 50n, compressedServiceFeeWei: 100n });
  expect(result.original.totalEstimatedCostWei).toBe(p.original.fees.estimatedCostWei + 50n);
  expect(result.compressed.totalEstimatedCostWei).toBe(p.compressed.fees.estimatedCostWei + 100n);
  expect(result.compressed.physicalFiles).toBe(p.compressed.totals.files);
  expect(result.quoteType).toBe("model-estimate");
  expect(result.modelCheaper).toBe("compressed");
  expect(result.automaticSelection).toBe("original");
});

describe("same-snapshot quote comparison", () => {
  it("rejects mixed block, price, operators and target contexts", () => {
    const p = plans();
    expect(() => compareReleaseCosts({ ...p, compressed: { ...p.compressed, pinnedBlockNumber: 11n } })).toThrow(/context/i);
    expect(() => compareReleaseCosts({ ...p, compressed: { ...p.compressed, fees: { ...p.compressed.fees, gasPriceWei: 3n } } })).toThrow(/context/i);
    expect(() => compareReleaseCosts({ ...p, compressed: { ...p.compressed, operators: ["a"] } })).toThrow(/context/i);
    expect(() => compareReleaseCosts({ ...p, compressed: { ...p.compressed, container: `0x${"33".repeat(20)}` } })).toThrow(/context/i);
  });
  it("does not compare blocked plans or negative service fees as valid quotes", () => {
    const p = plans();
    expect(() => compareReleaseCosts({ ...p, compressed: { ...p.compressed, blocked: true } })).toThrow(/blocked/i);
    expect(() => compareReleaseCosts({ ...p, compressedServiceFeeWei: -1n })).toThrow(/fee/i);
  });
});

describe("automatic strategy selection (SPEC §15)", () => {
  const qualified = { gatewayQualified: true, productionSimulation: true };

  it("requires a strictly cheaper compressed quote", () => {
    expect(selectReleaseStrategy({ costKnown: true, comparison: { modelCheaper: "compressed" }, qualification: qualified })).toEqual({
      strategy: "compressed",
      reason: "strictly-cheaper",
    });
    // Equality is not a saving.
    expect(selectReleaseStrategy({ costKnown: true, comparison: { modelCheaper: "equal" }, qualification: qualified })).toEqual({
      strategy: "original",
      reason: "not-strictly-cheaper",
    });
    expect(selectReleaseStrategy({ costKnown: true, comparison: { modelCheaper: "original" }, qualification: qualified })).toEqual({
      strategy: "original",
      reason: "not-strictly-cheaper",
    });
  });

  it("keeps original when the cost is unknown — never treats unknown as free", () => {
    expect(selectReleaseStrategy({ costKnown: false, comparison: null, qualification: qualified })).toEqual({
      strategy: "original",
      reason: "cost-unknown",
    });
  });

  it("keeps original without a qualified gateway", () => {
    expect(
      selectReleaseStrategy({
        costKnown: true,
        comparison: { modelCheaper: "compressed" },
        qualification: { gatewayQualified: false, productionSimulation: true },
      }),
    ).toEqual({ strategy: "original", reason: "gateway-not-qualified" });
  });

  it("keeps original without a production-compatible simulation", () => {
    // This is the production state today: the rule exists, but the gate that would let it pick
    // compression is closed.
    expect(
      selectReleaseStrategy({
        costKnown: true,
        comparison: { modelCheaper: "compressed" },
        qualification: { gatewayQualified: true, productionSimulation: false },
      }),
    ).toEqual({ strategy: "original", reason: "production-simulation-required" });
  });

  it("names the missing cost before the simulation gate", () => {
    expect(
      selectReleaseStrategy({
        costKnown: false,
        comparison: null,
        qualification: { gatewayQualified: true, productionSimulation: false },
      }),
    ).toEqual({ strategy: "original", reason: "cost-unknown" });
  });

  it("checks the gateway before the cost, so a cheap quote never overrides a missing gate", () => {
    expect(
      selectReleaseStrategy({
        costKnown: true,
        comparison: { modelCheaper: "compressed" },
        qualification: { gatewayQualified: false, productionSimulation: false },
      }),
    ).toEqual({ strategy: "original", reason: "gateway-not-qualified" });
  });
});
