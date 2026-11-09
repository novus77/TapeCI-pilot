import { describe, expect, it } from "vitest";
import { XLAYER_MAINNET } from "@tapeci/config";
import { readFileInfo, pathsAt } from "@tapeci/chain";
import { sha256Hex, utf8, type Hex } from "@tapeci/shared";
import {
  createOperatorClients,
  selectPinnedBlock,
  verifyRelease,
  type ReleaseManifestFile,
  type ReleaseManifestView,
} from "@tapeci/verifier";

const CONTAINER = "0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3" as Hex;

/**
 * Builds a manifest from what the chain currently declares at the pinned block.
 * This is a legacy/external site (entry > 24,000 bytes), used only as a read-only
 * target to exercise the release-verification path against two real operators.
 */
async function buildManifestAtPin(pin: number): Promise<ReleaseManifestView> {
  const operators = createOperatorClients(XLAYER_MAINNET);
  const primary = operators[0];
  if (primary === undefined) throw new Error("no operator");
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new Error("no registry");
  const paths = await pathsAt(primary.client, registry, CONTAINER, BigInt(pin));
  if (paths.length === 0) throw new Error("live container has no files at the pin");
  const files: ReleaseManifestFile[] = [];
  for (const path of paths) {
    const info = await readFileInfo(primary.client, registry, CONTAINER, path, BigInt(pin));
    files.push({
      path,
      sourcePath: path,
      size: info.size,
      sha256: info.sha256,
      contentType: info.contentType,
      chunks: info.chunkCount,
    });
  }
  return {
    chainId: 196,
    container: CONTAINER,
    siteRegistry: registry,
    commitSha: "e".repeat(40),
    releaseId: "r-eeeeeeeeeeee-00000000",
    entryPath: "index.html",
    fallbackPath: "index.html",
    files,
  };
}

describe("P1-07 live release verification (read-only, two operators)", () => {
  it("verifies a real X Layer site against its manifest at one pinned block", async () => {
    const operators = createOperatorClients(XLAYER_MAINNET);
    expect(operators.length).toBeGreaterThanOrEqual(2);
    const heads = await Promise.all(operators.map((operator) => operator.client.getBlockNumber()));
    const pin = selectPinnedBlock(
      heads.map(Number),
      XLAYER_MAINNET.pin.offset,
      XLAYER_MAINNET.pin.maxLagBlocks,
    ).pinnedBlockNumber;
    expect(pin).toBeGreaterThan(0);

    const manifest = await buildManifestAtPin(pin);
    const report = await verifyRelease({ manifest, pinnedBlock: pin });

    expect(report.status).toBe("VERIFIED");
    expect(report.releaseStatus).toBe("VERIFIED");
    expect(report.releaseMatch).toBe(true);
    expect(report.nodeOperators.length).toBeGreaterThanOrEqual(2);
    expect(report.pin.pinnedBlockNumber).toBe(pin);
    expect(report.files).toHaveLength(manifest.files.length);
    expect(report.files.every((file) => file.matched)).toBe(true);
    expect(report.journal).toBeNull();
    expect(report.warnings.some((warning) => warning.includes("no journal"))).toBe(true);
    // The live site predates the 24,000-byte single-transaction entry policy.
    if (manifest.files.some((file) => file.path === "index.html" && file.size > 24_000)) {
      expect(
        report.warnings.some((warning) => warning.includes("single-transaction cutover")),
      ).toBe(true);
      expect(report.manifest.entrySingleTransactionEligible).toBe(false);
    }

    // Tampering with the expected entry hash must fail the release match while the
    // raw chain report itself remains VERIFIED (operators agree on the bytes).
    const tampered: ReleaseManifestView = {
      ...manifest,
      files: manifest.files.map((file) =>
        file.path === manifest.entryPath
          ? { ...file, sha256: sha256Hex(utf8("tampered-live-entry")) }
          : file,
      ),
    };
    const bad = await verifyRelease({ manifest: tampered, pinnedBlock: pin });
    expect(bad.status).toBe("VERIFIED");
    expect(bad.releaseMatch).toBe(false);
    expect(bad.releaseStatus).toBe("MISMATCH");
  }, 180_000);
});
