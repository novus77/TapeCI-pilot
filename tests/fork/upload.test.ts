/**
 * P0-05: chunked upload / duplicate-append / resume matrix on an Anvil fork of
 * X Layer 196, exercised through packages/deployer `uploadFile`.
 *
 * The scenario itself is scripts/fork/upload.ts (shared with the standalone
 * evidence script). Tests assert the recorded on-chain evidence and then read
 * the fork again directly at a fixed block.
 */
import "./evidence-dir.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createForkClients,
  readFileBytesAt,
  readFileInfo,
  siteRegistryAbi,
  type ReadClient,
} from "@tapeci/chain";
import { XLAYER_MAINNET } from "@tapeci/config";
import { sha256Hex, type Hex } from "@tapeci/shared";
import { startAnvilFork, type AnvilFork } from "../../scripts/fork/anvil.js";
import {
  UPLOAD_EVIDENCE_FILE,
  runUploadScenario,
  type UploadEvidence,
} from "../../scripts/fork/upload.js";
import { EVIDENCE_DIR, writeEvidence, type ForkClients } from "../../scripts/fork/support.js";

const EXPECTED_CHECK_IDS = [
  "UPLOAD-01",
  "UPLOAD-02",
  "UPLOAD-03",
  "UPLOAD-04",
  "UPLOAD-05",
  "UPLOAD-06",
  "UPLOAD-07",
  "UPLOAD-08",
  "UPLOAD-09",
] as const;

const EXPECTED_CHUNKS: Readonly<Record<string, number>> = {
  "1B": 1,
  "24000B": 1,
  "24001B": 2,
  "65000B": 3,
};

describe("P0-05 fork: 1 B / 24,000 B / 24,001 B / 65,000 B upload matrix", () => {
  let fork: AnvilFork | null = null;
  let clients: ForkClients | null = null;
  let evidence: UploadEvidence | null = null;

  beforeAll(async () => {
    fork = await startAnvilFork();
    clients = createForkClients(fork.url);
    evidence = await runUploadScenario(fork, { generatedBy: "tests/fork/upload.test.ts" });
    writeEvidence(UPLOAD_EVIDENCE_FILE, evidence);
  });

  afterAll(async () => {
    if (fork) await fork.stop();
  });

  function requireEvidence(): UploadEvidence {
    if (!evidence) {
      throw new Error("P0-05 fork scenario did not produce evidence (see the beforeAll error above)");
    }
    return evidence;
  }

  function requireClient(): ReadClient {
    if (!clients) throw new Error("fork clients are not initialized");
    return clients.publicClient;
  }

  function requireFork(): AnvilFork {
    if (!fork) throw new Error("fork is not initialized");
    return fork;
  }

  function registry(): Hex {
    const address = XLAYER_MAINNET.registries[0];
    if (!address) throw new Error("no SiteRegistry configured");
    return address;
  }

  it("runs against a local Anvil fork of X Layer 196 pinned to one fork block", () => {
    const activeFork = requireFork();
    const run = requireEvidence();
    expect(activeFork.chainId).toBe(196);
    expect(activeFork.forkBlockNumber).toBe(activeFork.requestedForkBlock);
    expect(run.fork.chainId).toBe(196);
    expect(run.chain.chunkMax).toBe(24_000);
    expect(run.chain.maxFileBytes).toBe(8_400_000);
    expect(run.container.isOpened).toBe(true);
    expect(run.container.registryIsOpenedContainer).toBe(true);
  });

  it("records chunk counts 1 / 1 / 2 / 3 for 1 B / 24,000 B / 24,001 B / 65,000 B", () => {
    const run = requireEvidence();
    expect(run.matrix.expected).toEqual(EXPECTED_CHUNKS);
    expect(run.matrix.observed).toEqual(EXPECTED_CHUNKS);
    expect(run.files).toHaveLength(4);
  });

  it("records exact on-chain chunk payload sizes at 24,000-byte boundaries", () => {
    const run = requireEvidence();
    expect(run.files[0]?.onChain.chunkDataBytes).toEqual([1]);
    expect(run.files[1]?.onChain.chunkDataBytes).toEqual([24_000]);
    expect(run.files[2]?.onChain.chunkDataBytes).toEqual([24_000, 1]);
    expect(run.files[3]?.onChain.chunkDataBytes).toEqual([24_000, 24_000, 17_000]);
  });

  for (const checkId of EXPECTED_CHECK_IDS) {
    it(`${checkId}: scenario check passes`, () => {
      const run = requireEvidence();
      const recorded = run.checks.find((item) => item.id === checkId);
      expect(recorded, `missing check ${checkId}`).toBeDefined();
      expect(recorded?.pass, `${checkId}: ${recorded?.description ?? ""}`).toBe(true);
    });
  }

  it("read-backs all four files at the single pinned block with matching raw SHA-256 and size", async () => {
    const run = requireEvidence();
    const publicClient = requireClient();
    const readBlock = BigInt(run.readBlock);
    for (const record of run.files) {
      const read = await readFileBytesAt(publicClient, registry(), run.container.container as Hex, record.path, {
        blockNumber: readBlock,
        expectedSize: record.size,
      });
      expect(read.bytes.length, record.path).toBe(record.size);
      expect(sha256Hex(read.bytes).toLowerCase(), record.path).toBe(record.sha256.toLowerCase());
      const info = await readFileInfo(publicClient, registry(), run.container.container as Hex, record.path, readBlock);
      expect(info.chunkCount, record.path).toBe(EXPECTED_CHUNKS[recordLabel(record.path, run)]);
    }
  });

  it("rejects a duplicate appendChunk with the consumed expectIndex and keeps bytes unchanged", async () => {
    const run = requireEvidence();
    const rejection = run.rejections.duplicateAppendChunk;
    expect(rejection.ethCall.reverted).toBe(true);
    expect(rejection.ethCall.selector).toMatch(/^0x[0-9a-f]{8}$/);
    expect(rejection.transaction.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rejection.transaction.receiptStatus).toBe("reverted");
    expect(rejection.stateUnchanged).toBe(true);
    const target = run.files[3];
    expect(target).toBeDefined();
    if (!target) return;
    const publicClient = requireClient();
    const info = await readFileInfo(publicClient, registry(), run.container.container as Hex, target.path);
    expect(info.chunkCount).toBe(3);
    expect(info.size).toBe(65_000);
    expect(info.sha256.toLowerCase()).toBe(target.sha256.toLowerCase());
  });

  it("rejects an illegal expectIndex (5 when chunkCount is 1) with a reverted receipt", () => {
    const run = requireEvidence();
    const rejection = run.rejections.illegalExpectIndex;
    expect(rejection.ethCall.reverted).toBe(true);
    expect(rejection.ethCall.rawData).toMatch(/^0x[0-9a-f]+$/);
    expect(rejection.transaction.receiptStatus).toBe("reverted");
    expect(rejection.stateUnchanged).toBe(true);
    expect(rejection.stateBefore.files["p0-05/one-byte.bin"]?.chunkCount).toBe(1);
  });

  it("recovers an interrupted 3-chunk upload: partial bytes readable, only missing chunks appended", async () => {
    const run = requireEvidence();
    const resume = run.resume;
    expect(resume.partial.contractCanReadPartialFile).toBe(true);
    expect(resume.partial.bytesRead).toBe(24_000);
    expect(resume.partial.prefixMatches).toBe(true);
    expect(resume.recoveryRequiresRestart).toBe(false);
    expect(resume.resumeStatus).toBe("UPLOADED");
    expect(resume.resumeVerified).toBe(true);
    expect(resume.appendedIndices).toEqual([1, 2]);
    expect(resume.duplicatePutFileOnResume).toBe(false);
    expect(resume.resumeTransactions.map((tx) => tx.functionName)).toEqual([
      "appendChunk",
      "appendChunk",
    ]);
    expect(resume.final.size).toBe(50_000);
    expect(resume.final.chunkCount).toBe(3);
    expect(resume.final.matched).toBe(true);
    const publicClient = requireClient();
    const info = await readFileInfo(publicClient, registry(), run.container.container as Hex, resume.path);
    expect(info.size).toBe(50_000);
    expect(info.sha256.toLowerCase()).toBe(resume.sha256.toLowerCase());
    expect(run.recoveryFinding.contractCanReadPartiallyWrittenFile).toBe(true);
    expect(run.recoveryFinding.recoveryRequiresRestart).toBe(false);
    expect(run.recoveryFinding.resumeUsedDuplicateAppends).toBe(false);
  });

  it("rejects the 8,400,001-byte file before any transaction", () => {
    const run = requireEvidence();
    expect(run.tooLarge.declaredSize).toBe(8_400_001);
    expect(run.tooLarge.caughtErrorCode).toBe("FILE_TOO_LARGE");
    expect(run.tooLarge.noBlockMined).toBe(true);
    expect(run.tooLarge.noPathAdded).toBe(true);
    expect(run.tooLarge.blockBefore).toBe(run.tooLarge.blockAfter);
  });

  it("all recorded checks pass and the evidence JSON on disk matches the run", () => {
    const run = requireEvidence();
    expect(run.result.pass).toBe(true);
    expect(run.checks).toHaveLength(EXPECTED_CHECK_IDS.length);
    expect(run.result.failures).toEqual([]);
    // Read from wherever this run actually wrote it: the fork suites redirect evidence to a
    // temp directory (P7-11) so a test run cannot rewrite the tracked record. Comparing
    // against `EVIDENCE_DIR` would compare a fresh run with a historical pin.
    const evidenceDir = process.env["TAPECI_EVIDENCE_DIR"] ?? EVIDENCE_DIR;
    const onDisk = JSON.parse(
      readFileSync(join(evidenceDir, UPLOAD_EVIDENCE_FILE), "utf8"),
    ) as UploadEvidence;
    expect(onDisk.kind).toBe("tapeci.fork.upload.v1");
    expect(onDisk.fork.forkBlockNumber).toBe(run.fork.forkBlockNumber);
    expect(onDisk.container.container).toBe(run.container.container);
    expect(onDisk.recoveryFinding).toEqual(run.recoveryFinding);
    expect(onDisk.result.pass).toBe(true);
  });

  it("registers exactly the uploaded paths on chain", async () => {
    const run = requireEvidence();
    const publicClient = requireClient();
    const pathCount = await publicClient.readContract({
      address: registry(),
      abi: siteRegistryAbi,
      functionName: "pathCount",
      args: [run.container.container as Hex],
    });
    expect(Number(pathCount)).toBe(run.files.length + 1);
  });
});

function recordLabel(path: string, run: UploadEvidence): string {
  const index = run.files.findIndex((record) => record.path === path);
  const labels = Object.keys(EXPECTED_CHUNKS);
  const label = labels[index];
  if (!label) throw new Error(`no matrix label for ${path}`);
  return label;
}
