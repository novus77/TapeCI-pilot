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
import { utf8, type Hex } from "@tapeci/shared";
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
  testClient: ReturnType<typeof clientsFor>["testClient"];
  signer: Hex;
  wallet: ReturnType<typeof walletFor>;
  container: Hex;
};
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  fork = await startAnvilFork({ offset: 50 });
  const { publicClient, testClient } = clientsFor(fork);
  const opened = await openNewContainer({
    fork,
    client: publicClient,
    testClient,
    opener: OPENER_EOA,
  });
  const signer = opened.owner;
  await fundAndImpersonate(testClient, signer, 100n * ONE_OKB);
  fixture = {
    client: publicClient,
    testClient,
    signer,
    wallet: walletFor(fork.url, signer),
    container: opened.container,
  };
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

async function prepare(seed: number, commitSha: string): Promise<Prepared> {
  const artifacts = [
    makeArtifactFile("assets/app.js", seededBytes(30_000, seed), "text/javascript"),
    makeArtifactFile("assets/style.css", seededBytes(500, seed + 1), "text/css"),
    makeArtifactFile(
      "index.html",
      utf8(
        `<!doctype html><html><head><link rel=stylesheet href=./assets/style.css></head><body>seed ${String(seed)}<script src=./assets/app.js></script></body></html>`,
      ),
      "text/html; charset=utf-8",
    ),
  ];
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new Error("no registry");
  const { manifest } = buildReleaseManifest({
    chainId: 196,
    siteRegistry: registry,
    container: fixture.container,
    repositoryId: 1,
    commitSha,
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
  const files: PlanFileBytes[] = artifacts.map((file) => ({
    sourcePath: file.path,
    bytes: file.bytes,
  }));
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
  const dir = await mkdtemp(join(tmpdir(), "tapeci-fork-journal-"));
  temporaryDirectories.push(dir);
  return { journalPath: join(dir, "deployment.jsonl"), plan, manifest, files };
}

function executionOptions(prepared: Prepared) {
  return {
    plan: prepared.plan,
    manifest: prepared.manifest,
    files: prepared.files,
    client: fixture.client,
    wallet: fixture.wallet,
    config: XLAYER_MAINNET,
    journalPath: prepared.journalPath,
    signer: fixture.signer,
  };
}

describe("P1-06 journaled execution on an Anvil fork", () => {
  it("resumes after an interruption without duplicate appends and writes the entry last", async () => {
    const prepared = await prepare(7, "a".repeat(40));
    const baseOptions = executionOptions(prepared);

    await expect(
      executeRelease({ ...baseOptions, maxTransactions: 2 }),
    ).rejects.toMatchObject({ code: "UPLOAD_INTERRUPTED" });

    const interrupted = await readJournalState(prepared.journalPath);
    expect(interrupted.complete).toBe(false);
    expect(interrupted.transactions.size).toBe(2);
    // The first asset (app.js, two chunks) completed before the interruption.
    expect(
      interrupted.verifiedFiles.get(`releases/${prepared.plan.releaseId}/assets/app.js`),
    ).toBeDefined();

    const resumed = await executeRelease(baseOptions);
    expect(resumed.status).toBe("COMPLETE");
    expect(resumed.newTransactions).toBe(2);
    expect(resumed.files.every((file) => file.verified)).toBe(true);

    const state = await readJournalState(prepared.journalPath);
    expect(state.complete).toBe(true);
    expect(state.transactions.size).toBe(4);
    expect(state.verifiedFiles.size).toBe(prepared.manifest.files.length);

    // Every manifest file reads back byte-for-byte at the same pin after execution.
    const registry = XLAYER_MAINNET.registries[0];
    if (registry === undefined) throw new Error("no registry");
    for (const row of prepared.manifest.files) {
      const read = await readFileBytesAt(fixture.client, registry, prepared.plan.container, row.path);
      const verification = verifyFileRead(row.path, read, { sha256: row.sha256, size: row.size });
      expect(verification.matched, row.path).toBe(true);
    }

    // Nonces are unique and strictly increasing; each transaction hash is distinct.
    const records = [...state.transactions.values()];
    const nonces = records
      .map((record) => BigInt(record.intent.nonce))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(new Set(nonces.map(String)).size).toBe(nonces.length);
    const hashes = records
      .map((record) => record.mined?.txHash)
      .filter((hash): hash is Hex => hash !== undefined);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(records.every((record) => record.mined !== undefined)).toBe(true);

    // Assets were mined before the controlled entry replacement.
    const entry = records.find((record) => record.intent.path === "index.html");
    const assets = records.filter((record) => record.intent.path !== "index.html");
    expect(entry).toBeDefined();
    const entryBlock = BigInt(entry?.mined?.blockNumber ?? "0");
    for (const asset of assets) {
      expect(entryBlock > BigInt(asset.mined?.blockNumber ?? "0")).toBe(true);
    }

    // Replaying a completed journal must not send anything.
    const replay = await executeRelease(baseOptions);
    expect(replay.newTransactions).toBe(0);
    expect(replay.journalTransactions).toBe(4);
  }, 240_000);

  it("refuses to resume a journal with a different plan", async () => {
    const prepared = await prepare(9, "c".repeat(40));
    const baseOptions = executionOptions(prepared);
    // Writes the plan event, then stops before any transaction.
    await expect(
      executeRelease({ ...baseOptions, maxTransactions: 0 }),
    ).rejects.toMatchObject({ code: "UPLOAD_INTERRUPTED" });

    const differentPlan: ReleasePlan = { ...prepared.plan, commitSha: "b".repeat(40) };
    await expect(
      executeRelease({ ...baseOptions, plan: differentPlan }),
    ).rejects.toMatchObject({ code: "PLAN_STALE" });
  }, 240_000);
});
