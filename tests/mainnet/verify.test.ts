import { beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { OBSERVED_XLAYER_SITE, XLAYER_MAINNET } from "@tapeci/config";
import { createReadClient, readFileBytesAt } from "@tapeci/chain";
import { sha256Hex, type Hex } from "@tapeci/shared";
import {
  ZERO_SHA256,
  evaluateFileMatch,
  selectPinnedBlock,
  verifySite,
  type VerificationReport,
} from "@tapeci/verifier";

const LIVE_CONTAINER = OBSERVED_XLAYER_SITE.container;
const REGISTRY = XLAYER_MAINNET.registries[0] as Hex;

function flipFirstNibble(hash: Hex): Hex {
  const nibble = hash.slice(2, 3) === "0" ? "1" : "0";
  return `0x${nibble}${hash.slice(3)}` as Hex;
}

/**
 * P0-06 live acceptance: read-only, two independent operators, one pinned block.
 * All expected hashes/sizes are re-read from chain at the pinned block, so the
 * tests stay valid if the site's mutable contents change.
 */
describe("P0-06 multi-operator pinned-block verification on X Layer 196", () => {
  let report: VerificationReport;

  beforeAll(async () => {
    report = await verifySite({ container: LIVE_CONTAINER });
  });

  it("reads two distinct RPC operators and the same block header at the pin", async () => {
    expect(report.nodeOperators).toHaveLength(2);
    expect(new Set(report.nodeOperators).size).toBe(2);
    expect(new Set(report.pin.heads.map((head) => head.url)).size).toBe(2);
    for (const head of report.pin.heads) {
      expect(head.head).toBeTypeOf("number");
      expect(head.chainId).toBe(196);
    }
    expect(report.pin.pinnedBlockHash).not.toBeNull();

    // Independent direct re-read: both operator URLs must serve the same header
    // hash for the exact block the report pinned.
    const pinnedBlock = BigInt(report.pinnedBlockNumber as number);
    const headerHashes = await Promise.all(
      report.pin.heads.map(async (head) => {
        const client = createReadClient(head.url);
        const block = await client.getBlock({ blockNumber: pinnedBlock });
        return block.hash?.toLowerCase() ?? null;
      }),
    );
    expect(new Set(headerHashes).size).toBe(1);
    expect(headerHashes[0]).toBe((report.pin.pinnedBlockHash as string).toLowerCase());
  });

  it("pins one block: second-highest head minus offset", () => {
    expect(report.pin.strategy).toBe("second-highest-operator-head-minus-offset");
    expect(report.pin.offset).toBe(XLAYER_MAINNET.pin.offset);
    const { sortedHeads, secondHighestHead, offset, pinnedBlockNumber, divergenceBlocks, maxLagBlocks } =
      report.pin;
    expect(secondHighestHead).toBe(sortedHeads[1] ?? null);
    expect(pinnedBlockNumber).toBe((secondHighestHead as number) - offset);
    expect(report.pinnedBlockNumber).toBe(pinnedBlockNumber);
    expect(divergenceBlocks).not.toBeNull();
    expect(divergenceBlocks as number).toBeLessThanOrEqual(maxLagBlocks);
    for (const head of report.pin.heads) {
      expect(report.pinnedBlockNumber as number).toBeLessThanOrEqual(head.head as number);
    }
  });

  it("uses the same pin arithmetic as TapeKit (pure helper)", () => {
    const selection = selectPinnedBlock([1_000, 997], 2, 300);
    expect(selection.sortedHeads).toEqual([1_000, 997]);
    expect(selection.secondHighestHead).toBe(997);
    expect(selection.pinnedBlockNumber).toBe(995);
    expect(selection.divergenceBlocks).toBe(3);
    // 同运营方多域名只算一票由 oneEndpointPerOperator 保证；头部分歧过大拒绝 pin。
    expect(() => selectPinnedBlock([1_000, 100], 2, 300)).toThrow(/diverge/);
    expect(() => selectPinnedBlock([1_000, 999], 2, 0)).toThrow(/diverge/);
  });

  it("reports VERIFIED for the live site with matched per-file checks", () => {
    expect(report.status).toBe("VERIFIED");
    expect(report.chainId).toBe(196);
    expect(getAddress(report.container)).toBe(getAddress(LIVE_CONTAINER));
    expect(report.registry.toLowerCase()).toBe(REGISTRY.toLowerCase());
    expect(report.paths.length).toBeGreaterThan(0);
    expect(report.paths).toContain(OBSERVED_XLAYER_SITE.path);
    expect(report.checks.length).toBe(report.paths.length);
    expect(report.disagreements).toEqual([]);
    for (const check of report.checks) {
      expect(check.matched, `${check.path} failed: ${report.detail ?? ""}`).toBe(true);
      expect(check.expectedSize).toBe(check.actualSize);
      expect(check.expectedSha256.toLowerCase()).toBe(check.actualSha256.toLowerCase());
      expect(check.expectedSha256.toLowerCase()).not.toBe(ZERO_SHA256);
      expect(check.operatorsAgree).toBe(true);
      expect(check.errors).toEqual([]);
      for (const operator of report.nodeOperators) {
        const perOperatorSha = check.actualSha256ByOperator[operator];
        expect(perOperatorSha, `no ${operator} hash for ${check.path}`).toBeTruthy();
        expect((perOperatorSha as string).toLowerCase()).toBe(check.actualSha256.toLowerCase());
        expect(check.actualSizeByOperator[operator]).toBe(check.actualSize);
      }
    }
  });

  it("asserts both ERC-1967 implementations are allowlisted at the pinned block", () => {
    const registryImplementation = report.implementations.find(
      (entry) => entry.role === "siteRegistry",
    );
    const bindingImplementation = report.implementations.find(
      (entry) => entry.role === "domainBinding",
    );
    expect(registryImplementation).toBeDefined();
    expect(bindingImplementation).toBeDefined();
    expect(registryImplementation?.allowlisted).toBe(true);
    expect(bindingImplementation?.allowlisted).toBe(true);
    expect(registryImplementation?.operatorsAgree).toBe(true);
    expect(bindingImplementation?.operatorsAgree).toBe(true);
    expect(report.registryImplementation?.toLowerCase()).toBe(
      (XLAYER_MAINNET.allowlist.find((entry) => entry.role === "siteRegistry")?.implementations[0] ??
        "")?.toLowerCase(),
    );
    expect(report.bindingImplementation?.toLowerCase()).toBe(
      (XLAYER_MAINNET.allowlist.find((entry) => entry.role === "domainBinding")?.implementations[0] ??
        "")?.toLowerCase(),
    );
  });

  it("re-reads chain bytes at the pinned block and matches the declared raw SHA-256", async () => {
    const pinnedBlock = BigInt(report.pinnedBlockNumber as number);
    const okxUrl = XLAYER_MAINNET.rpcs[0]?.url;
    expect(okxUrl).toBeDefined();
    const client = createReadClient(okxUrl as string);
    const container = getAddress(report.container);
    for (const check of report.checks) {
      const read = await readFileBytesAt(client, REGISTRY, container, check.path, {
        blockNumber: pinnedBlock,
        expectedSize: check.expectedSize,
      });
      // Chain-declared hash equals the raw SHA-256 of the bytes served at that block.
      expect(read.info.sha256.toLowerCase()).toBe(check.expectedSha256.toLowerCase());
      expect(read.actualSha256.toLowerCase()).toBe(check.actualSha256.toLowerCase());
      expect(sha256Hex(read.bytes).toLowerCase()).toBe(check.actualSha256.toLowerCase());
      expect(read.bytes.length).toBe(check.actualSize);
    }
  });

  it("a deliberately wrong expected hash yields matched=false (no network write)", () => {
    const check = report.checks.find((candidate) => candidate.path === "index.html") ?? report.checks[0];
    expect(check).toBeDefined();
    if (check === undefined) return;
    const correct = evaluateFileMatch(
      check.path,
      { sha256: check.actualSha256, size: check.actualSize },
      { sha256: check.expectedSha256, size: check.expectedSize },
    );
    expect(correct.matched).toBe(true);

    const tampered = flipFirstNibble(check.expectedSha256);
    expect(tampered).not.toBe(check.expectedSha256);
    const wrongHash = evaluateFileMatch(
      check.path,
      { sha256: check.actualSha256, size: check.actualSize },
      { sha256: tampered, size: check.expectedSize },
    );
    expect(wrongHash.matched).toBe(false);
    expect(wrongHash.expectedSha256).toBe(tampered);

    const wrongSize = evaluateFileMatch(
      check.path,
      { sha256: check.actualSha256, size: check.actualSize },
      { sha256: check.expectedSha256, size: check.expectedSize + 1 },
    );
    expect(wrongSize.matched).toBe(false);

    const zeroHash = evaluateFileMatch(
      check.path,
      { sha256: check.actualSha256, size: check.actualSize },
      { sha256: ZERO_SHA256, size: check.expectedSize },
    );
    expect(zeroHash.matched).toBe(false);
  });
});
