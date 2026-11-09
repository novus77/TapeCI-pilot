import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReleaseManifest } from "@tapeci/artifact";
import { XLAYER_MAINNET } from "@tapeci/config";
import {
  executeRelease,
  planRelease,
  readJournalState,
  type PlanFileBytes,
} from "@tapeci/deployer";
import { sha256Hex, utf8, type Hex } from "@tapeci/shared";
import {
  journalEvidenceFromState,
  verifyRelease,
  type ReleaseManifestView,
  type ReleaseVerificationReport,
} from "@tapeci/verifier";
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

const OPENER_EOA = "0x1000000000000000000000000000000000000003" as Hex;
const COMMIT_SHA = "d".repeat(40);

let fork: AnvilFork;
let client: ReturnType<typeof clientsFor>["publicClient"];
let signer: Hex;
let wallet: ReturnType<typeof walletFor>;
let container: Hex;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  fork = await startAnvilFork({ offset: 50 });
  const clients = clientsFor(fork);
  client = clients.publicClient;
  const opened = await openNewContainer({
    fork,
    client,
    testClient: clients.testClient,
    opener: OPENER_EOA,
  });
  container = opened.container;
  signer = opened.owner;
  await fundAndImpersonate(clients.testClient, signer, 100n * ONE_OKB);
  wallet = walletFor(fork.url, signer);
}, 180_000);

afterAll(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  if (fork !== undefined) await fork.stop();
}, 120_000);

function forkOperator() {
  return {
    operator: "fork",
    url: fork.url,
    endpoint: { url: fork.url, operator: "okx" as const, maxBatch: 10 },
    client,
  };
}

describe("P1-07 release verification on an Anvil fork", () => {
  it("verifies chain bytes plus journal evidence, and rejects a tampered manifest", async () => {
    const artifacts = [
      makeArtifactFile("assets/app.js", seededBytes(30_000, 21), "text/javascript"),
      makeArtifactFile("assets/style.css", seededBytes(400, 22), "text/css"),
      makeArtifactFile(
        "index.html",
        utf8("<!doctype html><html><head><link rel=stylesheet href=./assets/style.css></head><body>verify<script src=./assets/app.js></script></body></html>"),
        "text/html; charset=utf-8",
      ),
    ];
    const registry = XLAYER_MAINNET.registries[0];
    if (registry === undefined) throw new Error("no registry");
    const { manifest } = buildReleaseManifest({
      chainId: 196,
      siteRegistry: registry,
      container,
      repositoryId: 7,
      commitSha: COMMIT_SHA,
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
    const planningHead = await client.getBlockNumber();
    const plan = await planRelease({
      manifest,
      files,
      operators: [forkOperator()],
      signer,
      costCapWei: 10n * ONE_OKB,
      pinnedBlockNumber: planningHead,
    });

    const dir = await mkdtemp(join(tmpdir(), "tapeci-verify-release-"));
    temporaryDirectories.push(dir);
    const journalPath = join(dir, "deployment.jsonl");
    await executeRelease({
      plan,
      manifest,
      files,
      client,
      wallet,
      config: XLAYER_MAINNET,
      journalPath,
      signer,
    });

    const verificationHead = await client.getBlockNumber();
    const journalEvidence = journalEvidenceFromState(await readJournalState(journalPath));
    const manifestView: ReleaseManifestView = manifest;
    const report: ReleaseVerificationReport = await verifyRelease({
      manifest: manifestView,
      journal: journalEvidence,
      pinnedBlock: verificationHead,
      operators: [forkOperator()],
      allowSingleOperator: true,
    });

    expect(report.status).toBe("VERIFIED");
    expect(report.releaseStatus).toBe("VERIFIED");
    expect(report.releaseMatch).toBe(true);
    expect(report.nodeOperators).toEqual(["fork"]);
    expect(report.files.every((file) => file.matched)).toBe(true);
    expect(report.journal?.complete).toBe(true);
    expect(report.journal?.verifiedFilesMatch).toBe(true);
    expect(report.journal?.transactionsOk).toBe(true);
    expect(report.journal?.allMinedBeforePin).toBe(true);
    expect(report.journal?.entryWrittenLast).toBe(true);
    expect(report.journal?.issues).toEqual([]);
    expect(report.finality.pinnedBlockNumber).toBe(Number(verificationHead));
    expect(report.warnings.some((warning) => warning.includes("single operator"))).toBe(true);

    // A manifest whose entry hash does not match the chain bytes must be rejected even
    // though both (here: one) operators read the same bytes.
    const tampered: ReleaseManifestView = {
      ...manifestView,
      files: manifestView.files.map((file) =>
        file.path === manifestView.entryPath
          ? { ...file, sha256: sha256Hex(utf8("tampered-entry")) }
          : file,
      ),
    };
    const badReport = await verifyRelease({
      manifest: tampered,
      journal: journalEvidence,
      pinnedBlock: verificationHead,
      operators: [forkOperator()],
      allowSingleOperator: true,
    });
    expect(badReport.releaseMatch).toBe(false);
    expect(badReport.releaseStatus).toBe("MISMATCH");
    const entryCheck = badReport.files.find((file) => file.path === manifestView.entryPath);
    expect(entryCheck?.matched).toBe(false);
  }, 240_000);
});
