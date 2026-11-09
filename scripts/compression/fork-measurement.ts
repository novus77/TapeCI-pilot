import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { XLAYER_MAINNET } from "@tapeci/config";
import { computeArtifactDigest } from "@tapeci/artifact";
import { executeRelease, planRelease, type JournalEvent } from "@tapeci/deployer";
import { scanArtifactFiles } from "@tapeci/validator";
import { sha256Hex, type Hex } from "@tapeci/shared";
import { prepareDeploymentRelease } from "../../apps/api/src/worker/prepare-release.js";
import { STRATEGIES } from "../../packages/compression/src/types.js";
import type { TapeKitFile, TapeKitSite } from "../../packages/compression/src/tapekit.js";
import { rpcRequest, startAnvilFork } from "../fork/anvil.js";
import { ONE_OKB, clientsFor, fundAndImpersonate, openNewContainer, seededBytes, walletFor } from "../fork/support.js";
import { verifyMeasuredResponse, summarizeForkReceipts } from "./measurement.js";
import { prepareTapeKitOverlay } from "./tapekit-overlay.js";

export async function runCompressionForkMeasurement(options: { sourceDir: string; outputPath: string }) {
  if (!options.sourceDir) throw new Error("A pinned TapeKit source directory is required");
  const root = await mkdtemp(join(tmpdir(), "tapeci-fork-measure-"));
  const fork = await startAnvilFork({ offset: 50 }).catch(async error => { await rm(root, { recursive: true, force: true }); throw error; });
  try {
    if (new URL(fork.url).hostname !== "127.0.0.1") throw new Error("Benchmark writes require an isolated loopback fork");
    const overlay = await prepareTapeKitOverlay({ sourceDir: options.sourceDir, outputDir: join(root, "tapekit") });
    const kernel = await import(pathToFileURL(join(overlay.outputDir, "kernel/src/index.js")).href) as {
      XLAYER_MAINNET: Record<string, unknown>;
      createChainKernel(options: { network: Record<string, unknown>; rpcUrls: string[]; quorum: number }): { openSite(res: { container: Hex; block: Hex }): Promise<TapeKitSite> };
    };
    const adapter = await import(pathToFileURL(join(overlay.outputDir, "sw-gateway/compression.js")).href) as { openPackedSite(site: TapeKitSite): Promise<TapeKitSite> };
    const serve = await import(pathToFileURL(join(overlay.outputDir, "sw-gateway/serve.js")).href) as { SITE_CSP: string; fileResponse(file: TapeKitFile, headers: Record<string, string>, mode: string): Response };
    const clients = clientsFor(fork);
    const opened = await openNewContainer({ fork, client: clients.publicClient, testClient: clients.testClient, opener: "0x1000000000000000000000000000000000000020" });
    await fundAndImpersonate(clients.testClient, opened.owner, 100n * ONE_OKB);
    const wallet = walletFor(fork.url, opened.owner);
    const source = scanArtifactFiles([
      { relativePath: "index.html", bytes: Buffer.from('<html><link rel="stylesheet" href="styles.css"><script src="app.js"></script><body>Measurement</body></html>') },
      { relativePath: "app.js", bytes: Buffer.from('console.log("measurement");'.repeat(600)) },
      { relativePath: "styles.css", bytes: Buffer.from('body{color:green;background:white}'.repeat(150)) },
      { relativePath: "data.bin", bytes: seededBytes(24_001, 196) },
    ]).files;
    const registry = XLAYER_MAINNET.registries[0]!;
    const baseline = await clients.publicClient.getBlock({ blockTag: "latest" });
    const quoteGasPriceWei = await clients.publicClient.getGasPrice();
    const operators = [{ operator: "isolated-fork", url: fork.url, endpoint: { url: fork.url, operator: "okx" as const, maxBatch: 10 }, client: clients.publicClient }];
    const measurements = [];
    for (const strategy of STRATEGIES) {
      const snapshot = await rpcRequest(fork.url, "evm_snapshot", []);
      try {
        const before = await clients.publicClient.getBlock({ blockTag: "latest" });
        if (before.hash !== baseline.hash) throw new Error("Candidate baseline state was not restored");
        const context = { projectId: "11111111-1111-4111-8111-111111111111", repositoryId: 1, commitSha: "a".repeat(40), chainId: 196 as const, siteRegistry: registry, container: opened.container, sourceArtifactKey: `sha256/${"33".repeat(32)}.tar`, sourceArtifactSha256: `0x${"33".repeat(32)}` as Hex };
        const release = prepareDeploymentRelease({ context, request: { schemaVersion: "tapeci.preparation.v1", mode: strategy, spaFallback: strategy !== "original", ...(strategy === "original" ? {} : { gatewayId: "isolated-fork-source-overlay" }) }, files: source, pathMode: "versioned", strictOnChain: true });
        const plan = await planRelease({ manifest: release.prepared.manifest, files: release.files, operators, signer: opened.owner, pinnedBlockNumber: baseline.number, gasPriceWei: quoteGasPriceWei, costCapWei: 10n * ONE_OKB });
        if (plan.blocked || plan.totals.unchanged !== 0 || plan.totals.conflicts !== 0) throw new Error("Expected an unblocked fresh-target plan");
        const events: JournalEvent[] = [];
        const execution = await executeRelease({ plan, manifest: release.prepared.manifest, files: release.files, client: clients.publicClient, wallet, config: XLAYER_MAINNET, signer: opened.owner, journalPath: join(root, `${strategy}.jsonl`), onEvent: event => events.push(event) });
        if (execution.status !== "COMPLETE") throw new Error("Incomplete benchmark publication");
        const hashes = events.filter(event => event.type === "tx_mined").map(event => event.txHash);
        const receipts = await Promise.all(hashes.map(async hash => {
          const receipt = await clients.publicClient.getTransactionReceipt({ hash });
          return { hash, status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice };
        }));
        const accounting = summarizeForkReceipts(receipts, execution.newTransactions, quoteGasPriceWei);
        if (accounting.transactions !== plan.totals.chunks) throw new Error("Release transaction coverage differs from full physical plan");
        const published = await clients.publicClient.getBlock({ blockTag: "latest" });
        const physical = await kernel.createChainKernel({ network: kernel.XLAYER_MAINNET, rpcUrls: [fork.url], quorum: 1 }).openSite({ container: opened.container, block: `0x${published.number.toString(16)}` });
        for (const row of release.prepared.manifest.files) {
          const file = await physical.get(row.path);
          if (!file?.verified || !file.bytes || sha256Hex(file.bytes) !== row.sha256) throw new Error(`TapeKit physical byte mismatch: ${row.path}`);
        }
        const logical = await adapter.openPackedSite(physical);
        for (const file of source) {
          const path = strategy === "original" ? release.prepared.manifest.files.find(row => row.sourcePath === file.path)!.path : file.path;
          const decoded = await logical.get(path);
          const expected = strategy === "original" && file.path === "index.html" ? release.prepared.entryBytes : file.bytes;
          if (!decoded?.verified || !decoded.bytes || sha256Hex(decoded.bytes) !== sha256Hex(expected)) throw new Error(`TapeKit logical byte mismatch: ${path}`);
          const response = serve.fileResponse(decoded, {}, "server");
          await verifyMeasuredResponse(response, { bytes: expected, contentType: file.contentType, sha256: sha256Hex(expected), csp: serve.SITE_CSP });
        }
        measurements.push({ strategy, baselineBlockHash: before.hash, manifestSha256: release.prepared.releaseManifestHash, physicalFiles: plan.totals.files, physicalBytes: plan.totals.bytes, physicalChunks: plan.totals.chunks, modelEstimatedGas: plan.fees.estimatedGas, accounting, receipts, gateway: { readBlock: published.number, readBlockHash: published.hash, quorum: 1, directFixtureContainer: true, verifiedPhysicalFiles: release.prepared.manifest.files.length, logicalFilesMatched: source.length, originalResponseHeadersPreserved: true } });
      } finally {
        await restoreSnapshot(fork.url, snapshot);
      }
    }
    const report = { schemaVersion: "tapeci.compression-measurement.v1", complete: true, scope: "isolated-anvil-fork", mainnetWritesPerformed: false, productionGatewayQualified: false, independentRpcVerified: false, automaticSelection: "original", source: { files: source.length, bytes: source.reduce((sum, file) => sum + file.size, 0), digest: computeArtifactDigest(source) }, fork: { sourceHost: new URL(fork.sourceUrl).hostname, sourceBlock: fork.forkBlockNumber, sourceBlockHash: fork.forkBlockHash, writeTarget: fork.url, container: opened.container, baselineBlock: baseline.number, baselineBlockHash: baseline.hash }, tapeKit: overlay.manifest, setupFeesIncluded: false, l2SpecificFeesIncluded: false, measurements };
    await writeFile(options.outputPath, JSON.stringify(report, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2), { flag: "wx" });
    return report;
  } finally { await fork.stop(); await rm(root, { recursive: true, force: true }); }
}

async function restoreSnapshot(url: string, snapshot: unknown) {
  if (await rpcRequest(url, "evm_revert", [snapshot]) !== true) throw new Error("Could not restore candidate baseline");
}
