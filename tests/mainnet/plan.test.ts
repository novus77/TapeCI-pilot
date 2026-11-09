import { describe, expect, it } from "vitest";
import { buildReleaseManifest } from "@tapeci/artifact";
import { XLAYER_MAINNET } from "@tapeci/config";
import { planRelease, planToJson } from "@tapeci/deployer";
import { scanArtifactDirectory } from "@tapeci/validator";
import { createOperatorClients } from "@tapeci/verifier";

const FIXTURE_DIR = "tests/fixtures/static-site";
const CONTAINER = "0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3";
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const ZERO_BALANCE_SIGNER = "0x1000000000000000000000000000000000000001";

async function buildFixtureManifest() {
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new Error("no registry configured");
  const scan = await scanArtifactDirectory(FIXTURE_DIR, {
    entryPath: "index.html",
    maxFileBytes: 8_400_000,
    strictOnChain: true,
  });
  const built = buildReleaseManifest({
    chainId: 196,
    siteRegistry: registry,
    container: CONTAINER,
    repositoryId: 123_456,
    commitSha: COMMIT_SHA,
    entryPath: "index.html",
    fallbackPath: "index.html",
    pathPrefix: "releases",
    files: scan.files,
  });
  return { scan, built };
}

describe("P1-05 live chain plan (read-only)", () => {
  it("pins one block across two operators and plans a real release", async () => {
    const { scan, built } = await buildFixtureManifest();
    const operators = createOperatorClients(XLAYER_MAINNET);
    expect(operators.length).toBeGreaterThanOrEqual(2);
    expect(new Set(operators.map((operator) => operator.operator)).size).toBeGreaterThanOrEqual(2);

    const plan = await planRelease({
      manifest: built.manifest,
      files: scan.files.map((file) => ({ sourcePath: file.path, bytes: file.bytes })),
      operators,
      costCapWei: 10n ** 18n, // 1 OKB is far above the expected cost of this small site
    });

    expect(plan.schemaVersion).toBe("tapeci.plan.v1");
    expect(plan.chainId).toBe(196);
    expect(plan.container).toBe(CONTAINER.toLowerCase());
    expect(plan.pinnedBlockNumber).toBeGreaterThan(0n);
    expect(plan.pinnedBlockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(plan.operators.length).toBeGreaterThanOrEqual(2);
    expect(plan.files).toHaveLength(scan.files.length);

    // The fixture differs from the live site's entry, so the entry is a controlled WRITE.
    const entry = plan.files.find((file) => file.path === "index.html");
    expect(entry?.action).toBe("WRITE");
    expect(entry?.reason).toContain("controlled cutover");

    expect(plan.totals.writes).toBeGreaterThan(0);
    expect(plan.totals.conflicts).toBe(0);
    expect(plan.totals.chunks).toBeGreaterThan(0);
    expect(plan.fees.estimatedGas).toBeGreaterThan(0n);
    expect(plan.fees.estimatedCostWei).toBeGreaterThan(0n);
    expect(plan.fees.recommendedCapWei).toBeGreaterThanOrEqual(plan.fees.estimatedCostWei);
    expect(plan.blocked).toBe(false);
    expect(plan.blockedReasons).toEqual([]);

    // The pin must be at or behind every operator head.
    for (const operator of operators) {
      const head = await operator.client.getBlockNumber();
      expect(plan.pinnedBlockNumber).toBeLessThanOrEqual(head);
    }

    const json = planToJson(plan) as Record<string, unknown>;
    expect(typeof json.pinnedBlockNumber).toBe("string");
    expect(typeof (json.fees as Record<string, unknown>).estimatedCostWei).toBe("string");
  }, 120_000);

  it("fails closed when the cap is below the estimated cost", async () => {
    const { scan, built } = await buildFixtureManifest();
    const plan = await planRelease({
      manifest: built.manifest,
      files: scan.files.map((file) => ({ sourcePath: file.path, bytes: file.bytes })),
      operators: createOperatorClients(XLAYER_MAINNET),
      costCapWei: 1n,
    });
    expect(plan.blocked).toBe(true);
    expect(plan.blockedReasons).toContain("FEE_OVER_BUDGET");
    expect(plan.fees.overBudgetByWei).toBeGreaterThan(0n);
  }, 120_000);

  it("fails closed when the signer cannot pay the estimated cost", async () => {
    const { scan, built } = await buildFixtureManifest();
    const plan = await planRelease({
      manifest: built.manifest,
      files: scan.files.map((file) => ({ sourcePath: file.path, bytes: file.bytes })),
      operators: createOperatorClients(XLAYER_MAINNET),
      signer: ZERO_BALANCE_SIGNER,
      costCapWei: 10n ** 18n,
    });
    expect(plan.sufficientBalance).toBe(false);
    expect(plan.blocked).toBe(true);
    expect(plan.blockedReasons).toContain("INSUFFICIENT_BALANCE");
  }, 120_000);
});
