import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReleaseManifest, type ReleaseManifest } from "@tapeci/artifact";
import { XLAYER_MAINNET } from "@tapeci/config";
import { readFileBytesAt, verifyFileRead } from "@tapeci/chain";
import {
  executeRelease,
  planRelease,
  readJournalState,
  type PlanFileBytes,
  type ReleasePlan,
} from "@tapeci/deployer";
import { type Hex } from "@tapeci/shared";
import { startAnvilFork, type AnvilFork } from "../../scripts/fork/anvil.js";
import {
  ONE_OKB,
  clientsFor,
  fundAndImpersonate,
  makeArtifactFile,
  openNewContainer,
  seededBytes,
  walletFor,
} from "../../scripts/fork/support.js";

const OPENER_EOA = "0x1000000000000000000000000000000000000002" as Hex;

let fork: AnvilFork;
let fixture: {
  client: ReturnType<typeof clientsFor>["publicClient"];
  signer: Hex;
  wallet: ReturnType<typeof walletFor>;
  container: Hex;
};
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  fork = await startAnvilFork({ offset: 60 });
  const { publicClient, testClient } = clientsFor(fork);
  const opened = await openNewContainer({ fork, client: publicClient, testClient, opener: OPENER_EOA });
  const signer = opened.owner;
  await fundAndImpersonate(testClient, signer, 100n * ONE_OKB);
  fixture = { client: publicClient, signer, wallet: walletFor(fork.url, signer), container: opened.container };
}, 180_000);

afterAll(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  if (fork !== undefined) await fork.stop();
}, 120_000);

interface Prepared {
  readonly journalPath: string;
  readonly plan: ReleasePlan;
  readonly manifest: ReleaseManifest;
  readonly files: readonly PlanFileBytes[];
}

async function prepare(fileCount: number): Promise<Prepared> {
  const artifacts = [];
  for (let i = 0; i < fileCount; i += 1) {
    const path = i === 0 ? "index.html" : i === 1 ? "assets/large.bin" : `assets/f${i}.txt`;
    const size = i === 0 ? 512 : i === 1 ? 24_001 : 1_000 + i;
    const contentType = i === 0 ? "text/html; charset=utf-8" : "application/octet-stream";
    artifacts.push(makeArtifactFile(path, seededBytes(size, i + 1), contentType));
  }
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new Error("no registry");
  const { manifest } = buildReleaseManifest({
    chainId: 196,
    siteRegistry: registry,
    container: fixture.container,
    repositoryId: 1,
    commitSha: "f".repeat(40),
    entryPath: "index.html",
    fallbackPath: "index.html",
    pathPrefix: "releases",
    files: artifacts.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      contentType: file.contentType,
    })),
  });
  const files: PlanFileBytes[] = artifacts.map((file) => ({ sourcePath: file.path, bytes: file.bytes }));
  const head = await fixture.client.getBlockNumber();
  const plan = await planRelease({
    manifest,
    files,
    operators: [
      {
        operator: "fork",
        url: fork.url,
        endpoint: { url: fork.url, operator: "okx", maxBatch: 10 },
        client: fixture.client,
      },
    ],
    signer: fixture.signer,
    costCapWei: 10n * ONE_OKB,
    pinnedBlockNumber: head,
  });
  const dir = await mkdtemp(join(tmpdir(), "tapeci-fallback-"));
  temporaryDirectories.push(dir);
  return { journalPath: join(dir, "deployment.jsonl"), plan, manifest, files };
}

describe("receipt confirmation fallback", () => {
  it("finishes when the primary RPC drops receipts and the second operator has them", async () => {
    const prepared = await prepare(24);
    const flaky = new Proxy(fixture.client, {
      get(target, property, receiver) {
        if (property === "waitForTransactionReceipt") {
          return async () => {
            throw new Error("primary RPC lost the receipt");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof fixture.client;
    const result = await executeRelease({
      plan: prepared.plan,
      manifest: prepared.manifest,
      files: prepared.files,
      client: flaky,
      wallet: fixture.wallet,
      config: XLAYER_MAINNET,
      journalPath: prepared.journalPath,
      signer: fixture.signer,
      operators: [{ client: flaky }, { client: fixture.client }],
    });
    expect(result.status).toBe("COMPLETE");
    expect(result.files.every((file) => file.verified)).toBe(true);
    const state = await readJournalState(prepared.journalPath);
    expect(state.complete).toBe(true);
    expect(state.verifiedFiles.size).toBe(24);
    const registry = XLAYER_MAINNET.registries[0];
    if (registry === undefined) throw new Error("no registry");
    for (const row of prepared.manifest.files) {
      const read = await readFileBytesAt(fixture.client, registry, prepared.plan.container, row.path);
      expect(verifyFileRead(row.path, read, { sha256: row.sha256, size: row.size }).matched, row.path).toBe(true);
    }
  }, 300_000);
});
