import { describe, expect, it } from "vitest";
import { planFromJson, planToJson, type ReleasePlan } from "@tapeci/deployer";
import type { Hex } from "@tapeci/shared";

const plan: ReleasePlan = {
  schemaVersion: 1,
  chainId: 196,
  container: `0x${"11".repeat(20)}` as Hex,
  siteRegistry: `0x${"22".repeat(20)}` as Hex,
  commitSha: "a".repeat(40),
  releaseId: "r-test",
  artifactDigest: `0x${"33".repeat(32)}` as Hex,
  releaseManifestHash: `0x${"44".repeat(32)}` as Hex,
  entryPath: "index.html",
  pinnedBlockNumber: 123n,
  pinnedBlockHash: `0x${"55".repeat(32)}` as Hex,
  operators: ["okx", "drpc"],
  observedAt: "2026-10-25T00:00:00.000Z",
  files: [
    {
      path: "index.html",
      sourcePath: "index.html",
      action: "WRITE",
      reason: "missing on chain",
      size: 10,
      sha256: `0x${"66".repeat(32)}` as Hex,
      chunks: 1,
      estimatedGas: 1000n,
      onChain: null,
    },
  ],
  totals: { files: 1, writes: 1, unchanged: 0, conflicts: 0, chunks: 1, bytes: 10 },
  fees: {
    gasPriceWei: 20_000_000n,
    estimatedGas: 1000n,
    estimatedCostWei: 20_000_000_000n,
    marginBps: 2000,
    recommendedCapWei: 24_000_000_000n,
    costCapWei: null,
    withinBudget: true,
    overBudgetByWei: 0n,
  },
  containerOwner: null,
  containerOpened: true,
  signer: null,
  signerIsHolder: null,
  signerBalanceWei: null,
  sufficientBalance: null,
  blocked: false,
  blockedReasons: [],
  warnings: [],
} as unknown as ReleasePlan;

describe("planFromJson", () => {
  it("round-trips a stored plan with bigint fields intact", () => {
    const restored = planFromJson(planToJson(plan));
    expect(restored.pinnedBlockNumber).toBe(123n);
    expect(restored.fees.estimatedCostWei).toBe(20_000_000_000n);
    expect(restored.fees.recommendedCapWei).toBe(24_000_000_000n);
    expect(restored.fees.costCapWei).toBeNull();
    expect(restored.files[0]?.estimatedGas).toBe(1000n);
    expect(restored.releaseId).toBe("r-test");
    expect(restored.blocked).toBe(false);
  });
});
