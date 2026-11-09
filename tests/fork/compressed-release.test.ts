import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { XLAYER_MAINNET } from "@tapeci/config";
import { readFileBytesAt } from "@tapeci/chain";
import { executeRelease, planRelease, compareReleaseCosts, uploadFile, type JournalEvent } from "@tapeci/deployer";
import { prepareCompressedRelease, prepareVersionedRelease, ReleaseStore, switchEntryToRelease, rollbackToStoredRelease } from "@tapeci/release";
import { analyzeCompression } from "../../packages/compression/src/index.js";
import { scanArtifactFiles } from "@tapeci/validator";
import { LocalObjectStore } from "@tapeci/github";
import { sha256Hex, type Hex } from "@tapeci/shared";
import { startAnvilFork, type AnvilFork } from "../../scripts/fork/anvil.js";
import { ONE_OKB, clientsFor, fundAndImpersonate, openNewContainer, walletFor, deployerPublicClient, seededBytes } from "../../scripts/fork/support.js";
import { freezePreparedArtifact, loadPreparedArtifact } from "../../apps/api/src/worker/prepared-artifact.js";

const enabled = process.env.TAPECI_COMPRESSION_FORK === "1";
describe.skipIf(!enabled)("compressed frozen release on an isolated Anvil fork", () => {
  let fork: AnvilFork;
  let root: string;
  let fixture: { client: ReturnType<typeof clientsFor>["publicClient"]; signer: Hex; wallet: ReturnType<typeof walletFor>; container: Hex };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tapeci-compressed-fork-"));
    fork = await startAnvilFork({ offset: 50 });
    expect(new URL(fork.url).hostname).toBe("127.0.0.1");
    const clients = clientsFor(fork);
    const opened = await openNewContainer({ fork, client: clients.publicClient, testClient: clients.testClient, opener: "0x1000000000000000000000000000000000000010" });
    await fundAndImpersonate(clients.testClient, opened.owner, 100n * ONE_OKB);
    fixture = { client: clients.publicClient, signer: opened.owner, wallet: walletFor(fork.url, opened.owner), container: opened.container };
  }, 240_000);
  afterAll(async () => { if (fork) await fork.stop(); if (root) await rm(root, { recursive: true, force: true }); });

  it("resumes exact prepared objects, switches entry last, preserves old assets and rolls back", async () => {
    const registry = XLAYER_MAINNET.registries[0]!;
    const operators = [{ operator: "isolated-fork", url: fork.url, endpoint: { url: fork.url, operator: "okx" as const, maxBatch: 10 }, client: fixture.client }];
    const events: JournalEvent[] = [];
    const store = new LocalObjectStore(join(root, "objects"));
    const source = (version: string) => scanArtifactFiles([
      { relativePath: "index.html", bytes: Buffer.from(`<html><body>${version}<script src="app.js"></script></body></html>`) },
      { relativePath: "app.js", bytes: Buffer.from('console.log("fork");'.repeat(1000)) },
      { relativePath: "data.bin", bytes: seededBytes(65_000, 196) },
    ]).files;
    const request = { schemaVersion: "tapeci.preparation.v1" as const, mode: "gzip-whole" as const, spaFallback: false, gatewayId: "isolated-fork-fixture" };
    const context = { projectId: "11111111-1111-4111-8111-111111111111", repositoryId: 1, commitSha: "a".repeat(40), chainId: 196 as const, siteRegistry: registry, container: fixture.container, sourceArtifactKey: `sha256/${"33".repeat(32)}.tar`, sourceArtifactSha256: `0x${"33".repeat(32)}` as Hex };
    const first = prepareCompressedRelease({ ...context, candidate: analyzeCompression(source("A")).candidates[2]! });
    const pin = await freezePreparedArtifact(store, { context, request, prepared: first, files: first.files.map(file => ({ sourcePath: file.sourceRelativePath, bytes: file.bytes })) });
    const frozen = await loadPreparedArtifact(store, pin.key, { context, request, manifestSha256: first.releaseManifestHash });
    const pinnedBlockNumber = await fixture.client.getBlockNumber();
    const plan = await planRelease({ manifest: frozen.prepared.manifest, files: frozen.files, operators, signer: fixture.signer, costCapWei: 10n * ONE_OKB, pinnedBlockNumber });
    const original = prepareVersionedRelease({ ...context, files: source("A") });
    const originalFiles = original.manifest.files.map(row => ({ sourcePath: row.sourcePath, bytes: row.path === "index.html" ? original.entryBytes : source("A").find(file => file.path === row.sourcePath)!.bytes }));
    const originalPlan = await planRelease({ manifest: original.manifest, files: originalFiles, operators, signer: fixture.signer, costCapWei: 10n * ONE_OKB, pinnedBlockNumber, gasPriceWei: plan.fees.gasPriceWei });
    const comparison = compareReleaseCosts({ original: originalPlan, compressed: plan });
    expect(comparison.automaticSelection).toBe("original");
    const options = { plan, manifest: frozen.prepared.manifest, files: frozen.files, client: fixture.client, wallet: fixture.wallet, config: XLAYER_MAINNET, journalPath: join(root, "release-a.jsonl"), signer: fixture.signer, onEvent: (event: JournalEvent) => events.push(event) };
    await expect(executeRelease({ ...options, maxTransactions: 2 })).rejects.toMatchObject({ code: "UPLOAD_INTERRUPTED" });
    const resumed = await loadPreparedArtifact(store, pin.key, { context, request, manifestSha256: first.releaseManifestHash });
    const complete = await executeRelease({ ...options, files: resumed.files });
    expect(complete.status).toBe("COMPLETE");
    expect((await executeRelease(options)).newTransactions).toBe(0);
    expect(events.filter(event => event.type === "tx_intent").at(-1)?.path).toBe("index.html");
    const entryA = sha256Hex((await readFileBytesAt(fixture.client, registry, fixture.container, "index.html")).bytes);
    expect(entryA).toBe(sha256Hex(first.entryBytes));
    const history = new ReleaseStore(join(root, "history"));
    await history.save(first);
    const second = prepareCompressedRelease({ ...context, commitSha: "b".repeat(40), candidate: analyzeCompression(source("B")).candidates[2]! });
    const hashes: Hex[] = [];
    for (const file of second.files.filter(file => file.path !== "index.html")) {
      const result = await uploadFile({ client: deployerPublicClient(fixture.client), wallet: fixture.wallet, config: XLAYER_MAINNET, container: fixture.container, file, mode: "conflict" });
      expect(result.verified).toBe(true);
      hashes.push(...result.transactionHashes);
    }
    expect(sha256Hex((await readFileBytesAt(fixture.client, registry, fixture.container, "index.html")).bytes)).toBe(entryA);
    const switched = await switchEntryToRelease({ manifest: second.manifest, entryBytes: second.entryBytes, client: fixture.client, wallet: fixture.wallet, config: XLAYER_MAINNET, operators, pinnedBlock: await fixture.client.getBlockNumber(), allowSingleOperator: true });
    expect(switched.transactionHashes).toHaveLength(1);
    expect(sha256Hex((await readFileBytesAt(fixture.client, registry, fixture.container, "index.html")).bytes)).toBe(sha256Hex(second.entryBytes));
    const rolled = await rollbackToStoredRelease({ store: history, releaseId: first.releaseId, client: fixture.client, wallet: fixture.wallet, config: XLAYER_MAINNET, operators, pinnedBlock: await fixture.client.getBlockNumber(), allowSingleOperator: true });
    expect(rolled.verified).toBe(true);
    expect(sha256Hex((await readFileBytesAt(fixture.client, registry, fixture.container, "index.html")).bytes)).toBe(entryA);
    for (const file of first.files.filter(file => file.path !== "index.html")) expect(sha256Hex((await readFileBytesAt(fixture.client, registry, fixture.container, file.path)).bytes)).toBe(file.sha256);
    const mined = events.filter(event => event.type === "tx_mined");
    const txHashes = [...new Set([...mined.map(event => event.txHash), ...hashes, ...switched.transactionHashes, ...rolled.transactionHashes])];
    const receipts = await Promise.all(txHashes.map(async hash => { const receipt = await fixture.client.getTransactionReceipt({ hash }); return { hash, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), feeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() }; }));
    await writeFile(process.env.TAPECI_COMPRESSION_FORK_EVIDENCE ?? join(tmpdir(), "tapeci-compression-fork.json"), JSON.stringify({ schemaVersion: "tapeci.compression-fork.v1", scope: "isolated-anvil-fork", mainnetWritesPerformed: false, independentRpcVerified: false, sourceHost: new URL(fork.sourceUrl).hostname, forkBlock: fork.forkBlockNumber.toString(), forkBlockHash: fork.forkBlockHash, writeTarget: fork.url, container: fixture.container, preparedKey: pin.key, manifestSha256: first.releaseManifestHash, interruptedAfterTransactions: 2, repeatNewTransactions: 0, rollbackVerified: true, comparison, receipts }, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
  }, 600_000);
});
