/**
 * Regression tests for the 2026-10-24 mainnet canary (container
 * 0xc0b4900262d0bc13f2c67c0fc4cf92c04e0ab814):
 *  1. post-upload read hit a node that had not imported the write block
 *     (tx 0x6336c8da…09ad, block 74087230) → false "file does not exist";
 *  2. final verification pinned at 74087825 while the entry write mined at
 *     74087826 → "mined after verification pin";
 *  3. a resumed run left style.css without file_verified → release MISMATCH.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex } from "viem";
import { XLAYER_MAINNET } from "@tapeci/config";
import { waitForBlock, type ReadClient } from "@tapeci/chain";
import {
  DeploymentJournal,
  maxMinedBlock,
  readJournalState,
  reverifyMissingFiles,
  uploadFile,
  type JournalPlanEvent,
} from "@tapeci/deployer";
import { pinAtLeast, type ReadRuntime } from "../../packages/cli/src/runtime.js";
import { TapeCiError, sha256Hex, utf8, type Hex } from "@tapeci/shared";
import { journalEvidenceFromState } from "@tapeci/verifier";

const CONTAINER = "0xc0b4900262d0bc13f2c67c0fc4cf92c04e0ab814" as Hex;
const DEPLOYMENT_ID = "dep-677c530e6635-4f2adf9d";
const STYLE = utf8("body{color:#111}\n");
const INDEX = utf8("<!doctype html><link rel=stylesheet href=style.css>\n");

interface FakeFile {
  readonly bytes: Uint8Array;
  readonly fromBlock: bigint;
}

/**
 * A node whose head advances by one per getBlockNumber call, whose "latest"
 * view lags `lag` blocks behind (load-balanced backend), and which errors on a
 * pinned read above its head (like real RPCs: "header not found").
 */
class FakeNode {
  head: bigint;
  readonly files = new Map<string, FakeFile>();
  readonly reads: { fn: string; blockNumber: bigint | undefined }[] = [];
  constructor(
    head: bigint,
    readonly lag = 0n,
    readonly step = 1n,
  ) {
    this.head = head;
  }
  client(): ReadClient {
    return {
      getBlockNumber: async () => {
        const current = this.head;
        this.head += this.step;
        return current;
      },
      readContract: async (request: { functionName: string; args: unknown[]; blockNumber?: bigint }) => {
        this.reads.push({ fn: request.functionName, blockNumber: request.blockNumber });
        const at = request.blockNumber ?? this.head - this.lag;
        if (request.blockNumber !== undefined && request.blockNumber > this.head) {
          throw new Error(`header not found for block ${request.blockNumber}`);
        }
        const path = request.args[1] as string;
        const file = this.files.get(path);
        const visible = file !== undefined && file.fromBlock <= at ? file : undefined;
        if (request.functionName === "fileInfo") {
          if (visible === undefined) return [0n, "", `0x${"00".repeat(32)}`, 0n, 0n];
          return [BigInt(visible.bytes.length), "text/css", sha256Hex(visible.bytes), 1n, 1n];
        }
        if (request.functionName === "read") return bytesToHex(visible?.bytes ?? new Uint8Array());
        throw new Error(`unexpected ${request.functionName}`);
      },
    } as unknown as ReadClient;
  }
}

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop() as string, { recursive: true, force: true });
});
const noSleep = async (): Promise<void> => undefined;

describe("waitForBlock (read-after-write guard)", () => {
  it("polls until the head reaches the target block", async () => {
    const node = new FakeNode(74087220n);
    const head = await waitForBlock(node.client(), 74087230n, { sleep: noSleep });
    expect(head).toBe(74087230n);
  });

  it("fails closed with a retryable RPC_DISAGREEMENT on timeout", async () => {
    const node = new FakeNode(10n, 0n, 0n);
    let clock = 0;
    const error = await waitForBlock(node.client(), 11n, {
      sleep: noSleep,
      timeoutMs: 5,
      now: () => (clock += 1),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TapeCiError);
    expect((error as TapeCiError).code).toBe("RPC_DISAGREEMENT");
    expect((error as TapeCiError).retryable).toBe(true);
  });
});

describe("bug 1: post-upload verification is pinned at the mined block", () => {
  const file = {
    path: "releases/r-677c530e6635-35a09ffa/style.css",
    sourceRelativePath: "style.css",
    contentType: "text/css",
    size: STYLE.length,
    sha256: sha256Hex(STYLE),
    bytes: STYLE,
  };

  it("verifies against a lagging node instead of reporting the file missing", async () => {
    // Node head is 74087229; its "latest" lags 3 blocks. Write mines at 74087230.
    const node = new FakeNode(74087229n, 3n);
    const result = await uploadFile({
      client: node.client() as never,
      wallet: {} as never,
      config: XLAYER_MAINNET,
      container: CONTAINER,
      file,
      send: async () => {
        node.files.set(file.path, { bytes: STYLE, fromBlock: 74087230n });
        return { hash: "0x6336c8da11cad93ff269f73c87ce86f72ea44ff1e47a28bb4a6a711a7d4109ad", gasUsed: 1n, blockNumber: 74087230n };
      },
      readAfterWrite: { sleep: noSleep },
    });
    expect(result.verified).toBe(true);
    expect(result.verifiedAtBlock).toBe(74087230n);
    const postWrite = node.reads.slice(1); // first read is the pre-write fileInfo
    expect(postWrite.length).toBeGreaterThan(0);
    expect(postWrite.every((read) => read.blockNumber === 74087230n)).toBe(true);
  });

  it("still fails closed when the file is genuinely absent at the mined block", async () => {
    const node = new FakeNode(74087229n);
    const error = await uploadFile({
      client: node.client() as never,
      wallet: {} as never,
      config: XLAYER_MAINNET,
      container: CONTAINER,
      file,
      send: async () => ({ hash: `0x${"ab".repeat(32)}` as Hex, gasUsed: 1n, blockNumber: 74087230n }),
      readAfterWrite: { sleep: noSleep },
    }).catch((e: unknown) => e);
    expect((error as TapeCiError).code).toBe("VERIFICATION_FAILED");
  });
});

describe("bug 2: verification pin is never below the last mined write", () => {
  it("waits for both operators and pins >= the entry write block", async () => {
    const okx = new FakeNode(74087825n);
    const drpc = new FakeNode(74087823n);
    const runtime = {
      operators: [
        { operator: "okx", url: "fake://okx", endpoint: {}, client: okx.client() },
        { operator: "drpc", url: "fake://drpc", endpoint: {}, client: drpc.client() },
      ],
      readClient: okx.client(),
      allowSingleOperator: false,
    } as unknown as ReadRuntime;
    const pin = await pinAtLeast(runtime, 74087826n, { sleep: noSleep });
    expect(pin).toBeGreaterThanOrEqual(74087826);
  });
});

function planInput(): Omit<JournalPlanEvent, "v" | "at"> {
  return {
    type: "plan",
    deploymentId: DEPLOYMENT_ID,
    planFingerprint: sha256Hex(utf8("plan")),
    releaseManifestHash: "0x35a09ffac39092782361301696e162a80c7e8698561988fc2bb4ef22c23a7847",
    artifactDigest: sha256Hex(utf8("artifact")),
    chainId: 196,
    container: CONTAINER,
    siteRegistry: XLAYER_MAINNET.registries[0] as Hex,
    commitSha: "677c530e66358b3a1e43f5776a04c32e5900c7ea",
    releaseId: "r-677c530e6635-35a09ffa",
    entryPath: "index.html",
    pinnedBlockNumber: "74087200",
    planJson: {},
  };
}

/** Rebuild the canary journal shape: both writes mined, only index.html verified, complete. */
async function canaryJournal(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tapeci-raw-"));
  tempDirs.push(dir);
  const path = join(dir, `${DEPLOYMENT_ID}.jsonl`);
  const journal = await DeploymentJournal.open(path);
  await journal.append(planInput());
  const writes = [
    { path: "releases/r-677c530e6635-35a09ffa/style.css", bytes: STYLE, nonce: "1", block: "74087230", tx: "0x6336c8da11cad93ff269f73c87ce86f72ea44ff1e47a28bb4a6a711a7d4109ad" },
    { path: "index.html", bytes: INDEX, nonce: "2", block: "74087826", tx: `0x8f1556${"00".repeat(27)}592a` },
  ];
  for (const write of writes) {
    const fingerprint = sha256Hex(utf8(write.path));
    await journal.append({ type: "tx_intent", deploymentId: DEPLOYMENT_ID, fingerprint, operation: "putFile", path: write.path, chunkIndex: 0, nonce: write.nonce, dataSha256: sha256Hex(write.bytes), dataBytes: write.bytes.length, expectIndex: null });
    await journal.append({ type: "tx_sent", deploymentId: DEPLOYMENT_ID, fingerprint, txHash: write.tx as Hex, nonce: write.nonce });
    await journal.append({ type: "tx_mined", deploymentId: DEPLOYMENT_ID, fingerprint, txHash: write.tx as Hex, blockNumber: write.block, blockHash: null, gasUsed: "1" });
  }
  await journal.append({ type: "file_verified", deploymentId: DEPLOYMENT_ID, path: "index.html", sha256: sha256Hex(INDEX), size: INDEX.length, status: "UPLOADED", transactionCount: 1 });
  await journal.append({ type: "deployment_complete", deploymentId: DEPLOYMENT_ID, releaseManifestHash: planInput().releaseManifestHash, verifiedFiles: 1, totalTransactions: 2 });
  await journal.close();
  return path;
}

const manifest = {
  container: CONTAINER,
  files: [
    { path: "releases/r-677c530e6635-35a09ffa/style.css", sha256: sha256Hex(STYLE), size: STYLE.length },
    { path: "index.html", sha256: sha256Hex(INDEX), size: INDEX.length },
  ],
} as never;

function chainWithFiles(head: bigint): FakeNode {
  const node = new FakeNode(head);
  node.files.set("releases/r-677c530e6635-35a09ffa/style.css", { bytes: STYLE, fromBlock: 74087230n });
  node.files.set("index.html", { bytes: INDEX, fromBlock: 74087826n });
  return node;
}

describe("bug 3: resume / repair re-verifies mined-but-unverified files", () => {
  it("journal rejects ordinary events after deployment_complete", async () => {
    const path = await canaryJournal();
    const journal = await DeploymentJournal.open(path);
    try {
      await expect(
        journal.append({ type: "file_verified", deploymentId: DEPLOYMENT_ID, path: "releases/r-677c530e6635-35a09ffa/style.css", sha256: sha256Hex(STYLE), size: STYLE.length, status: "UPLOADED", transactionCount: 1 }),
      ).rejects.toThrow(/after deployment_complete/);
      // recovered but pinned below the mined write: still rejected
      await expect(
        journal.append({ type: "file_verified", deploymentId: DEPLOYMENT_ID, path: "releases/r-677c530e6635-35a09ffa/style.css", sha256: sha256Hex(STYLE), size: STYLE.length, status: "UPLOADED", transactionCount: 1, recovered: true, verifiedAtBlock: "74087229" }),
      ).rejects.toThrow(/after deployment_complete/);
      // recovered UNCHANGED for a path that was written: rejected
      await expect(
        journal.append({ type: "file_verified", deploymentId: DEPLOYMENT_ID, path: "releases/r-677c530e6635-35a09ffa/style.css", sha256: sha256Hex(STYLE), size: STYLE.length, status: "UNCHANGED", transactionCount: 0, recovered: true, verifiedAtBlock: "74087900" }),
      ).rejects.toThrow(/after deployment_complete/);
      await expect(journal.append({ type: "note", deploymentId: DEPLOYMENT_ID, message: "x" })).rejects.toThrow();
    } finally {
      await journal.close();
    }
    const before = journalEvidenceFromState(await readJournalState(path));
    expect(before.verifiedFiles.map((f) => f.path)).toEqual(["index.html"]);
  });

  it("appends real evidence after both operators read matching bytes at pin >= max mined", async () => {
    const path = await canaryJournal();
    const okx = chainWithFiles(74087820n);
    const drpc = chainWithFiles(74087818n);
    const journal = await DeploymentJournal.open(path);
    let result;
    try {
      expect(maxMinedBlock(journal.state)).toBe(74087826n);
      result = await reverifyMissingFiles({
        journal,
        manifest,
        registry: XLAYER_MAINNET.registries[0] as Hex,
        readers: [
          { client: okx.client(), label: "okx" },
          { client: drpc.client(), label: "drpc" },
        ],
        recovered: true,
        wait: { sleep: noSleep },
      });
    } finally {
      await journal.close();
    }
    expect(result.pin).toBe(74087826n);
    expect(result.verified).toEqual([{ path: "releases/r-677c530e6635-35a09ffa/style.css", status: "UPLOADED" }]);
    for (const node of [okx, drpc]) {
      expect(node.reads.every((read) => read.blockNumber === 74087826n)).toBe(true);
    }
    const state = await readJournalState(path); // replay accepts the repaired journal
    const event = state.verifiedFiles.get("releases/r-677c530e6635-35a09ffa/style.css");
    expect(event?.recovered).toBe(true);
    expect(event?.operators).toEqual(["okx", "drpc"]);
    expect(event?.verifiedAtBlock).toBe("74087826");
    expect(journalEvidenceFromState(state).verifiedFiles).toHaveLength(2);
  });

  it("fails closed (appends nothing) when one operator disagrees", async () => {
    const path = await canaryJournal();
    const okx = chainWithFiles(74087830n);
    const drpc = chainWithFiles(74087830n);
    drpc.files.set("releases/r-677c530e6635-35a09ffa/style.css", { bytes: utf8("body{color:red}\n!"), fromBlock: 74087230n });
    const journal = await DeploymentJournal.open(path);
    try {
      await expect(
        reverifyMissingFiles({
          journal,
          manifest,
          registry: XLAYER_MAINNET.registries[0] as Hex,
          readers: [
            { client: okx.client(), label: "okx" },
            { client: drpc.client(), label: "drpc" },
          ],
          recovered: true,
          wait: { sleep: noSleep },
        }),
      ).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    } finally {
      await journal.close();
    }
    const state = await readJournalState(path);
    expect(state.verifiedFiles.has("releases/r-677c530e6635-35a09ffa/style.css")).toBe(false);
  });
});
