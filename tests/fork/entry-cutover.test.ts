import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XLAYER_MAINNET } from "@tapeci/config";
import { readFileBytesAt } from "@tapeci/chain";
import { uploadFile } from "@tapeci/deployer";
import {
  ReleaseStore,
  prepareVersionedRelease,
  rollbackToStoredRelease,
  switchEntryToRelease,
  type PreparedRelease,
} from "@tapeci/release";
import { TapeCiError, sha256Hex, utf8, type ArtifactFile, type Hex } from "@tapeci/shared";
import { startAnvilFork, type AnvilFork } from "../../scripts/fork/anvil.js";
import {
  ONE_OKB,
  clientsFor,
  deployerPublicClient,
  fundAndImpersonate,
  makeArtifactFile,
  openNewContainer,
  seededBytes,
  walletFor,
} from "../../scripts/fork/support.js";

const OPENER_EOA = "0x1000000000000000000000000000000000000004" as Hex;
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

async function uploadAssetsFor(release: PreparedRelease, files: readonly ArtifactFile[]): Promise<void> {
  for (const row of release.manifest.files) {
    if (row.path === release.manifest.entryPath) continue;
    const source = files.find((file) => file.path === row.sourcePath);
    if (source === undefined) throw new Error(`missing source for ${row.sourcePath}`);
    const result = await uploadFile({
      client: deployerPublicClient(client),
      wallet,
      config: XLAYER_MAINNET,
      container,
      file: {
        path: row.path,
        sourceRelativePath: row.sourcePath,
        contentType: row.contentType,
        size: row.size,
        sha256: row.sha256,
        bytes: source.bytes,
      },
      mode: "conflict",
    });
    expect(result.verified).toBe(true);
  }
}

async function entryShaOnChain(): Promise<Hex> {
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new Error("no registry");
  const read = await readFileBytesAt(client, registry, container, "index.html");
  return sha256Hex(read.bytes);
}

describe("P1-08 entry cutover and rollback on an Anvil fork", () => {
  it("switches in one transaction, keeps the old release accessible, and rolls back safely", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tapeci-cutover-"));
    temporaryDirectories.push(dir);
    const store = new ReleaseStore(dir);

    // --- release A: upload assets, then cut over to A -------------------------------
    const filesA = [
      makeArtifactFile("index.html", utf8("<!doctype html><body>A</body>"), "text/html; charset=utf-8"),
      makeArtifactFile("assets/app.js", seededBytes(30_000, 100), "text/javascript"),
      makeArtifactFile("assets/app.css", seededBytes(300, 101), "text/css"),
      makeArtifactFile("assets/logo.svg", seededBytes(200, 102), "image/svg+xml"),
    ];
    const releaseA = prepareVersionedRelease({
      files: filesA,
      chainId: 196,
      siteRegistry: XLAYER_MAINNET.registries[0] as Hex,
      container,
      repositoryId: 99,
      commitSha: "a".repeat(40),
      pathPrefix: "releases",
    });
    await uploadAssetsFor(releaseA, filesA);
    const pinA = await client.getBlockNumber();
    const switchA = await switchEntryToRelease({
      manifest: releaseA.manifest,
      entryBytes: releaseA.entryBytes,
      client,
      wallet,
      config: XLAYER_MAINNET,
      operators: [forkOperator()],
      pinnedBlock: pinA,
      allowSingleOperator: true,
    });
    expect(switchA.verified).toBe(true);
    expect(switchA.transactionHashes).toHaveLength(1);
    expect(switchA.previousEntrySha256).toBeNull();
    const entryA = await entryShaOnChain();
    expect(entryA).toBe(releaseA.manifest.files.find((file) => file.path === "index.html")?.sha256);

    await store.save({
      manifest: releaseA.manifest,
      artifactDigest: releaseA.artifactDigest,
      releaseManifestHash: releaseA.releaseManifestHash,
      entryBytes: releaseA.entryBytes,
    });

    // --- release B: upload assets; the old entry must still be live -------------------
    const filesB = [
      makeArtifactFile("index.html", utf8("<!doctype html><body>B</body>"), "text/html; charset=utf-8"),
      makeArtifactFile("assets/app.js", seededBytes(30_000, 200), "text/javascript"),
      makeArtifactFile("assets/app.css", seededBytes(300, 201), "text/css"),
      makeArtifactFile("assets/logo.svg", seededBytes(200, 202), "image/svg+xml"),
    ];
    const releaseB = prepareVersionedRelease({
      files: filesB,
      chainId: 196,
      siteRegistry: XLAYER_MAINNET.registries[0] as Hex,
      container,
      repositoryId: 99,
      commitSha: "b".repeat(40),
      pathPrefix: "releases",
    });
    await uploadAssetsFor(releaseB, filesB);
    expect(await entryShaOnChain()).toBe(entryA);

    const pinB = await client.getBlockNumber();
    const switchB = await switchEntryToRelease({
      manifest: releaseB.manifest,
      entryBytes: releaseB.entryBytes,
      client,
      wallet,
      config: XLAYER_MAINNET,
      operators: [forkOperator()],
      pinnedBlock: pinB,
      allowSingleOperator: true,
    });
    expect(switchB.transactionHashes).toHaveLength(1);
    expect(switchB.previousEntrySha256).toBe(entryA);
    const entryB = await entryShaOnChain();
    expect(entryB).toBe(releaseB.manifest.files.find((file) => file.path === "index.html")?.sha256);

    // Old release assets are still on chain and readable while B is live.
    const registry = XLAYER_MAINNET.registries[0];
    if (registry === undefined) throw new Error("no registry");
    const oldAssetRow = releaseA.manifest.files.find((file) => file.path.includes("assets/app.js"));
    if (oldAssetRow === undefined) throw new Error("no old asset row");
    const oldRead = await readFileBytesAt(client, registry, container, oldAssetRow.path);
    expect(sha256Hex(oldRead.bytes)).toBe(oldAssetRow.sha256);

    // --- rollback to A ---------------------------------------------------------------
    const pinRollback = await client.getBlockNumber();
    const rollback = await rollbackToStoredRelease({
      store,
      releaseId: releaseA.releaseId,
      client,
      wallet,
      config: XLAYER_MAINNET,
      operators: [forkOperator()],
      pinnedBlock: pinRollback,
      allowSingleOperator: true,
    });
    expect(rollback.purpose).toBe("rollback");
    expect(rollback.transactionHashes).toHaveLength(1);
    expect(rollback.previousEntrySha256).toBe(entryB);
    expect(await entryShaOnChain()).toBe(entryA);

    // --- a release whose assets are missing must not switch the entry ----------------
    const filesC = [
      makeArtifactFile("index.html", utf8("<!doctype html><body>C</body>"), "text/html; charset=utf-8"),
      makeArtifactFile("assets/app.js", seededBytes(500, 300), "text/javascript"),
    ];
    const releaseC = prepareVersionedRelease({
      files: filesC,
      chainId: 196,
      siteRegistry: XLAYER_MAINNET.registries[0] as Hex,
      container,
      repositoryId: 99,
      commitSha: "c".repeat(40),
      pathPrefix: "releases",
    });
    // Assets intentionally not uploaded.
    await expect(
      switchEntryToRelease({
        manifest: releaseC.manifest,
        entryBytes: releaseC.entryBytes,
        client,
        wallet,
        config: XLAYER_MAINNET,
        operators: [forkOperator()],
        pinnedBlock: await client.getBlockNumber(),
        allowSingleOperator: true,
      }),
    ).rejects.toBeInstanceOf(TapeCiError);
    expect(await entryShaOnChain()).toBe(entryA);
  }, 300_000);
});

