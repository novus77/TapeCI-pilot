/**
 * P0-05 evidence: chunked upload, duplicate-append rejection, and interruption /
 * resume semantics on an Anvil fork of X Layer 196.
 *
 * Run standalone:
 *   corepack pnpm exec tsx scripts/fork/upload.ts
 * (or `corepack pnpm fork:upload`).
 *
 * Everything is executed with packages/deployer `uploadFile` against the local
 * fork; no mainnet transaction is ever broadcast.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Hex } from "viem";
import {
  createForkClients,
  readFileBytesAt,
  readFileInfo,
  siteRegistryAbi,
  type ReadClient,
} from "@tapeci/chain";
import { XLAYER_MAINNET, type ChainConfig } from "@tapeci/config";
import { uploadFile, verifyUploadedFile } from "@tapeci/deployer";
import {
  CHUNK_MAX,
  MAX_FILE_BYTES,
  TapeCiError,
  bytesToHex,
  chunkBytes,
  sha256Hex,
  type ArtifactFile,
} from "@tapeci/shared";
import { forkMetadata, startAnvilFork, type AnvilFork } from "./anvil.js";
import {
  appendChunkCallData,
  decodeFunctionDataFromTx,
  check,
  deployerPublicClient,
  expectRevert,
  fundAndImpersonate,
  makeArtifactFile,
  openNewContainer,
  registryOf,
  seededBytes,
  summarize,
  waitForSuccessTx,
  walletFor,
  writeEvidence,
  type CheckRecord,
  type ForkTestClient,
  type ForkWallet,
  type RejectionRecord,
  type ResultSummary,
  type TxRecord,
} from "./support.js";

export const UPLOAD_EVIDENCE_FILE = "fork-upload.json";
export const UPLOAD_OPENER_EOA: Hex = getAddress("0x2000000000000000000000000000000000000001");

interface TxSummary {
  readonly txHash: Hex;
  readonly functionName: string;
  readonly expectIndex: number | null;
  readonly dataBytes: number | null;
}

export interface UploadedFileRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: Hex;
  readonly expectedChunks: number;
  readonly status: string;
  readonly verified: boolean;
  readonly transactionHashes: readonly Hex[];
  readonly transactions: readonly TxSummary[];
  readonly onChain: {
    readonly exists: boolean;
    readonly size: number;
    readonly chunkCount: number;
    readonly sha256: Hex;
    /** Declared chunk payload sizes recovered from the transaction calldata. */
    readonly chunkDataBytes: readonly number[];
  };
  readonly readBack: {
    readonly readBlock: number;
    readonly size: number;
    readonly sha256: Hex;
    readonly matched: boolean;
  };
  readonly verifiedByDeployerAtReadBlock: boolean;
}

export interface PartialReadEvidence {
  readonly readBlock: number;
  readonly exists: boolean;
  readonly declaredSize: number;
  readonly chunkCount: number;
  readonly declaredSha256: Hex;
  readonly contractCanReadPartialFile: boolean;
  readonly readError: string | null;
  readonly bytesRead: number;
  readonly expectedPrefixBytes: number;
  readonly prefixMatches: boolean;
  readonly prefixSha256: Hex | null;
}

export interface ResumeEvidence {
  readonly path: string;
  readonly size: number;
  readonly sha256: Hex;
  readonly expectedChunks: number;
  readonly manualPutFileTx: TxRecord;
  readonly partial: PartialReadEvidence;
  readonly recoveryRequiresRestart: boolean;
  readonly resumeStatus: string;
  readonly resumeVerified: boolean;
  readonly resumeTransactionHashes: readonly Hex[];
  readonly resumeTransactions: readonly TxSummary[];
  readonly appendedIndices: readonly number[];
  readonly duplicatePutFileOnResume: boolean;
  readonly final: {
    readonly readBlock: number;
    readonly size: number;
    readonly chunkCount: number;
    readonly sha256: Hex;
    readonly matched: boolean;
  };
}

export interface TooLargeEvidence {
  readonly path: string;
  readonly declaredSize: number;
  readonly expectedErrorCode: "FILE_TOO_LARGE";
  readonly caughtErrorCode: string | null;
  readonly caughtMessage: string | null;
  readonly blockBefore: number;
  readonly blockAfter: number;
  readonly pathCountBefore: number;
  readonly pathCountAfter: number;
  readonly noBlockMined: boolean;
  readonly noPathAdded: boolean;
}

export interface UploadEvidence {
  readonly kind: "tapeci.fork.upload.v1";
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly fork: ReturnType<typeof forkMetadata>;
  readonly chain: {
    readonly chainId: number;
    readonly siteRegistry: Hex;
    readonly opener: Hex;
    readonly chunkMax: number;
    readonly maxFileBytes: number;
  };
  readonly container: {
    readonly tokenId: string;
    readonly container: Hex;
    readonly owner: Hex;
    readonly openerEoa: Hex;
    readonly openTx: TxRecord;
    readonly isOpened: boolean;
    readonly registryIsOpenedContainer: boolean;
  };
  readonly matrix: {
    readonly expected: Readonly<Record<string, number>>;
    readonly observed: Readonly<Record<string, number>>;
  };
  readonly readBlock: number;
  readonly files: readonly UploadedFileRecord[];
  readonly rejections: {
    readonly duplicateAppendChunk: RejectionRecord;
    readonly illegalExpectIndex: RejectionRecord;
  };
  readonly resume: ResumeEvidence;
  readonly tooLarge: TooLargeEvidence;
  readonly recoveryFinding: {
    readonly contractCanReadPartiallyWrittenFile: boolean;
    readonly recoveryRequiresRestart: boolean;
    readonly resumeUsedDuplicateAppends: boolean;
    readonly note: string;
  };
  readonly checks: readonly CheckRecord[];
  readonly result: ResultSummary;
}

interface ScenarioContext {
  readonly fork: AnvilFork;
  readonly client: ReadClient;
  readonly testClient: ForkTestClient;
  readonly config: ChainConfig;
  readonly registry: Hex;
  readonly container: Hex;
  readonly wallet: ForkWallet;
}

async function decodeTransactions(
  client: ReadClient,
  hashes: readonly Hex[],
): Promise<TxSummary[]> {
  const summaries: TxSummary[] = [];
  for (const hash of hashes) {
    const decoded = await decodeFunctionDataFromTx(client, hash);
    let expectIndex: number | null = null;
    let dataBytes: number | null = null;
    if (decoded.functionName === "appendChunk") {
      const args = decoded.args as readonly [Hex, string, bigint, Hex];
      expectIndex = Number(args[2]);
      dataBytes = (args[3].length - 2) / 2;
    } else if (decoded.functionName === "putFile") {
      const args = decoded.args as readonly [Hex, string, string, Hex, Hex];
      dataBytes = (args[4].length - 2) / 2;
    }
    summaries.push({ txHash: hash, functionName: decoded.functionName, expectIndex, dataBytes });
  }
  return summaries;
}

async function onChainFile(
  client: ReadClient,
  config: ChainConfig,
  container: Hex,
  path: string,
  blockNumber?: bigint,
): Promise<{ exists: boolean; size: number; chunkCount: number; sha256: Hex }> {
  const info = await readFileInfo(client, registryOf(config), container, path, blockNumber);
  return { exists: info.exists, size: info.size, chunkCount: info.chunkCount, sha256: info.sha256 };
}

async function uploadOne(
  context: ScenarioContext,
  file: ArtifactFile,
): Promise<UploadedFileRecord> {
  const result = await uploadFile({
    client: deployerPublicClient(context.client),
    wallet: context.wallet,
    config: context.config,
    container: context.container,
    file,
  });
  const transactions = await decodeTransactions(context.client, result.transactionHashes);
  const chunks = chunkBytes(file.bytes);
  const declaredChunkBytes = transactions
    .map((item) => item.dataBytes)
    .filter((value): value is number => value !== null);
  const info = await onChainFile(context.client, context.config, context.container, file.path);
  return {
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    expectedChunks: chunks.length,
    status: result.status,
    verified: result.verified,
    transactionHashes: result.transactionHashes,
    transactions,
    onChain: {
      exists: info.exists,
      size: info.size,
      chunkCount: info.chunkCount,
      sha256: info.sha256,
      chunkDataBytes: declaredChunkBytes,
    },
    readBack: { readBlock: 0, size: 0, sha256: `0x${"0".repeat(64)}`, matched: false },
    verifiedByDeployerAtReadBlock: false,
  };
}

async function readBackAt(
  context: ScenarioContext,
  record: UploadedFileRecord,
  file: ArtifactFile,
  readBlock: bigint,
): Promise<UploadedFileRecord> {
  const read = await readFileBytesAt(context.client, context.registry, context.container, file.path, {
    blockNumber: readBlock,
    expectedSize: file.size,
  });
  const actualSha = sha256Hex(read.bytes);
  const matched =
    read.bytes.length === file.size && actualSha.toLowerCase() === file.sha256.toLowerCase();
  const verifiedByDeployer = await verifyUploadedFile(
    deployerPublicClient(context.client),
    context.config,
    context.container,
    file,
    readBlock,
  );
  return {
    ...record,
    readBack: { readBlock: Number(readBlock), size: read.bytes.length, sha256: actualSha, matched },
    verifiedByDeployerAtReadBlock: verifiedByDeployer,
  };
}

function txSummaryIndices(transactions: readonly TxSummary[]): number[] {
  return transactions
    .filter((item) => item.functionName === "appendChunk" && item.expectIndex !== null)
    .map((item) => item.expectIndex as number);
}

/** Run the whole P0-05 upload matrix against a started fork. */
export async function runUploadScenario(
  fork: AnvilFork,
  options: { readonly generatedBy: string },
): Promise<UploadEvidence> {
  const config = XLAYER_MAINNET;
  const registry = registryOf(config);
  const { publicClient, testClient } = createForkClients(fork.url);

  const opened = await openNewContainer({
    fork,
    client: publicClient,
    testClient,
    config,
    opener: UPLOAD_OPENER_EOA,
  });
  await fundAndImpersonate(testClient, opened.owner);
  const ownerWallet = walletFor(fork.url, opened.owner);
  const context: ScenarioContext = {
    fork,
    client: publicClient,
    testClient,
    config,
    registry,
    container: opened.container,
    wallet: ownerWallet,
  };
  const checks: CheckRecord[] = [];

  // --- too-large file must be rejected before any transaction ---------------
  const tooLargePath = "p0-05/too-large-8400001.bin";
  const blockBefore = await publicClient.getBlockNumber();
  const pathCountBefore = Number(
    await publicClient.readContract({
      address: registry,
      abi: siteRegistryAbi,
      functionName: "pathCount",
      args: [opened.container],
    }),
  );
  const tooLargeFile = makeArtifactFile(tooLargePath, new Uint8Array(MAX_FILE_BYTES + 1));
  let caughtErrorCode: string | null = null;
  let caughtMessage: string | null = null;
  try {
    await uploadFile({
      client: deployerPublicClient(publicClient),
      wallet: ownerWallet,
      config,
      container: opened.container,
      file: tooLargeFile,
    });
    throw new Error("uploadFile accepted an 8,400,001-byte file (expected FILE_TOO_LARGE)");
  } catch (error) {
    if (!(error instanceof TapeCiError) || error.code !== "FILE_TOO_LARGE") throw error;
    caughtErrorCode = error.code;
    caughtMessage = error.message;
  }
  const blockAfterTooLarge = await publicClient.getBlockNumber();
  const pathCountAfterTooLarge = Number(
    await publicClient.readContract({
      address: registry,
      abi: siteRegistryAbi,
      functionName: "pathCount",
      args: [opened.container],
    }),
  );
  const tooLarge: TooLargeEvidence = {
    path: tooLargePath,
    declaredSize: MAX_FILE_BYTES + 1,
    expectedErrorCode: "FILE_TOO_LARGE",
    caughtErrorCode,
    caughtMessage,
    blockBefore: Number(blockBefore),
    blockAfter: Number(blockAfterTooLarge),
    pathCountBefore,
    pathCountAfter: pathCountAfterTooLarge,
    noBlockMined: blockBefore === blockAfterTooLarge,
    noPathAdded: pathCountBefore === pathCountAfterTooLarge,
  };
  checks.push(
    check(
      "UPLOAD-08",
      "an 8,400,001-byte file is rejected in the build phase before any transaction is sent",
      { errorCode: "FILE_TOO_LARGE", noBlockMined: true, noPathAdded: true },
      { errorCode: caughtErrorCode, noBlockMined: tooLarge.noBlockMined, noPathAdded: tooLarge.noPathAdded },
    ),
  );

  // --- upload matrix: 1 B, 24,000 B, 24,001 B, 65,000 B ---------------------
  const matrixFiles: readonly { readonly label: string; readonly file: ArtifactFile }[] = [
    { label: "1B", file: makeArtifactFile("p0-05/one-byte.bin", new Uint8Array([0x2a])) },
    {
      label: "24000B",
      file: makeArtifactFile("p0-05/24000-bytes.bin", seededBytes(CHUNK_MAX, 24_000)),
    },
    {
      label: "24001B",
      file: makeArtifactFile("p0-05/24001-bytes.bin", seededBytes(CHUNK_MAX + 1, 24_001)),
    },
    {
      label: "65000B",
      file: makeArtifactFile("p0-05/65000-bytes.bin", seededBytes(65_000, 65_000)),
    },
  ];
  const uploaded: UploadedFileRecord[] = [];
  for (const entry of matrixFiles) {
    const record = await uploadOne(context, entry.file);
    uploaded.push(record);
    if (record.status !== "UPLOADED" || !record.verified) {
      throw new Error(`upload of ${entry.label} did not verify: ${JSON.stringify(record)}`);
    }
  }
  const expectedChunks: Record<string, number> = { "1B": 1, "24000B": 1, "24001B": 2, "65000B": 3 };
  checks.push(
    check(
      "UPLOAD-01",
      "chunk counts for 1 B / 24,000 B / 24,001 B / 65,000 B are 1 / 1 / 2 / 3 on chain",
      expectedChunks,
      Object.fromEntries(
        matrixFiles.map((entry) => [
          entry.label,
          uploaded.find((record) => record.path === entry.file.path)?.onChain.chunkCount ?? -1,
        ]),
      ),
    ),
  );
  const expectedChunkBytes: Record<string, readonly number[]> = {
    "1B": [1],
    "24000B": [24_000],
    "24001B": [24_000, 1],
    "65000B": [24_000, 24_000, 17_000],
  };
  checks.push(
    check(
      "UPLOAD-02",
      "on-chain chunk sizes are exactly 24,000-byte boundaries (putFile + appendChunk payloads)",
      expectedChunkBytes,
      Object.fromEntries(
        matrixFiles.map((entry) => [
          entry.label,
          uploaded.find((record) => record.path === entry.file.path)?.onChain.chunkDataBytes ?? [],
        ]),
      ),
    ),
  );

  // --- read back at one fixed block -----------------------------------------
  const readBlock = await publicClient.getBlockNumber();
  const files: UploadedFileRecord[] = [];
  for (let index = 0; index < uploaded.length; index += 1) {
    const record = uploaded[index];
    const entry = matrixFiles[index];
    if (!record || !entry) throw new Error("internal: matrix/file index mismatch");
    files.push(await readBackAt(context, record, entry.file, readBlock));
  }
  checks.push(
    check(
      "UPLOAD-03",
      "every uploaded file read back at one pinned block matches the raw SHA-256 and size",
      { allMatched: true, allDeployerVerified: true },
      {
        allMatched: files.every((record) => record.readBack.matched),
        allDeployerVerified: files.every((record) => record.verifiedByDeployerAtReadBlock),
      },
    ),
  );

  // --- duplicate appendChunk with an already-consumed expectIndex -----------
  const duplicateTarget = matrixFiles[3];
  if (!duplicateTarget) throw new Error("internal: 65,000-byte matrix file missing");
  const duplicateChunks = chunkBytes(duplicateTarget.file.bytes);
  const lastChunk = duplicateChunks[duplicateChunks.length - 1];
  if (!lastChunk) throw new Error("internal: 65,000-byte file has no chunks");
  const beforeState = await onChainFile(publicClient, config, opened.container, duplicateTarget.file.path);
  const beforeRead = await readFileBytesAt(publicClient, registry, opened.container, duplicateTarget.file.path);
  const duplicateRejection = await expectRevert({
    case: "appendChunk with an already-consumed expectIndex (duplicate append)",
    forkUrl: fork.url,
    client: publicClient,
    config,
    wallet: ownerWallet,
    to: registry,
    container: opened.container,
    functionName: "appendChunk",
    argumentsSummary: {
      path: duplicateTarget.file.path,
      expectIndex: duplicateChunks.length - 1,
      currentChunkCount: beforeState.chunkCount,
      dataBytes: lastChunk.length,
    },
    data: appendChunkCallData(
      opened.container,
      duplicateTarget.file.path,
      BigInt(duplicateChunks.length - 1),
      bytesToHex(lastChunk),
    ),
    signer: opened.owner,
    gas: 1_000_000n,
    snapshotPaths: [duplicateTarget.file.path],
  });
  const afterDuplicate = await onChainFile(publicClient, config, opened.container, duplicateTarget.file.path);
  const afterDuplicateRead = await readFileBytesAt(publicClient, registry, opened.container, duplicateTarget.file.path);
  const duplicateBytesUnchanged =
    afterDuplicate.chunkCount === beforeState.chunkCount &&
    afterDuplicate.size === beforeState.size &&
    afterDuplicate.sha256.toLowerCase() === beforeState.sha256.toLowerCase() &&
    sha256Hex(afterDuplicateRead.bytes).toLowerCase() === sha256Hex(beforeRead.bytes).toLowerCase();
  checks.push(
    check(
      "UPLOAD-04",
      "duplicate appendChunk with a consumed expectIndex reverts and leaves the on-chain bytes unchanged",
      { reverted: true, transactionStatus: "reverted", stateUnchanged: true, bytesUnchanged: true },
      {
        reverted: duplicateRejection.ethCall.reverted,
        transactionStatus: duplicateRejection.transaction.receiptStatus,
        stateUnchanged: duplicateRejection.stateUnchanged,
        bytesUnchanged: duplicateBytesUnchanged,
      },
    ),
  );
  if (!duplicateBytesUnchanged) {
    throw new Error("duplicate appendChunk changed the on-chain file bytes");
  }

  // --- illegal expectIndex (5 when chunkCount is 1) -------------------------
  const illegalFile = matrixFiles[0];
  if (!illegalFile) throw new Error("internal: 1-byte matrix file missing");
  const illegalRejection = await expectRevert({
    case: "appendChunk with an illegal expectIndex (5 when chunkCount is 1)",
    forkUrl: fork.url,
    client: publicClient,
    config,
    wallet: ownerWallet,
    to: registry,
    container: opened.container,
    functionName: "appendChunk",
    argumentsSummary: {
      path: illegalFile.file.path,
      expectIndex: 5,
      currentChunkCount: 1,
      dataBytes: 1,
    },
    data: appendChunkCallData(opened.container, illegalFile.file.path, 5n, "0xff"),
    signer: opened.owner,
    gas: 1_000_000n,
    snapshotPaths: [illegalFile.file.path],
  });
  const illegalAfter = await onChainFile(publicClient, config, opened.container, illegalFile.file.path);
  const illegalBytesUnchanged =
    illegalAfter.chunkCount === 1 &&
    illegalAfter.size === 1 &&
    illegalAfter.sha256.toLowerCase() === illegalFile.file.sha256.toLowerCase();
  checks.push(
    check(
      "UPLOAD-05",
      "appendChunk with an illegal expectIndex (5 when chunkCount is 1) reverts without changing the file",
      { reverted: true, transactionStatus: "reverted", stateUnchanged: true, bytesUnchanged: true },
      {
        reverted: illegalRejection.ethCall.reverted,
        transactionStatus: illegalRejection.transaction.receiptStatus,
        stateUnchanged: illegalRejection.stateUnchanged,
        bytesUnchanged: illegalBytesUnchanged,
      },
    ),
  );

  // --- interruption: write chunk 0 only, then resume via uploadFile ---------
  const resumeBytes = seededBytes(50_000, 50_000);
  const resumeFile = makeArtifactFile("p0-05/resume-3chunks.bin", resumeBytes);
  const resumeChunks = chunkBytes(resumeBytes);
  const resumeFirstChunk = resumeChunks[0];
  if (!resumeFirstChunk) throw new Error("internal: resume file has no first chunk");
  const manualPutHash = await ownerWallet.writeContract({
    address: registry,
    abi: siteRegistryAbi,
    functionName: "putFile",
    args: [
      opened.container,
      resumeFile.path,
      resumeFile.contentType,
      resumeFile.sha256,
      bytesToHex(resumeFirstChunk),
    ],
    chain: ownerWallet.chain,
    account: ownerWallet.account ?? null,
  });
  const manualPutTx = await waitForSuccessTx(publicClient, manualPutHash);
  const partialBlock = BigInt(manualPutTx.blockNumber);
  const partialInfo = await onChainFile(publicClient, config, opened.container, resumeFile.path, partialBlock);
  let partialReadError: string | null = null;
  let bytesRead = 0;
  let prefixMatches = false;
  let prefixSha256: Hex | null = null;
  try {
    const partialRead = await readFileBytesAt(publicClient, registry, opened.container, resumeFile.path, {
      blockNumber: partialBlock,
    });
    bytesRead = partialRead.bytes.length;
    prefixSha256 = sha256Hex(partialRead.bytes);
    const expectedPrefix = resumeBytes.subarray(0, bytesRead);
    prefixMatches =
      bytesRead === resumeFirstChunk.length && bytesEqual(partialRead.bytes, expectedPrefix);
  } catch (error) {
    partialReadError = error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
  }
  const contractCanReadPartialFile = partialReadError === null;
  const expectedPrefixBytes = Math.min(partialInfo.chunkCount * CHUNK_MAX, resumeFile.size);
  const recoveryRequiresRestart = !contractCanReadPartialFile || !prefixMatches || bytesRead !== expectedPrefixBytes;
  checks.push(
    check(
      "UPLOAD-06",
      "a partially written file can be read back as a byte-exact prefix (resume is safe)",
      { contractCanReadPartialFile: true, prefixMatches: true, recoveryRequiresRestart: false },
      { contractCanReadPartialFile, prefixMatches, recoveryRequiresRestart },
    ),
  );

  const resumeResult = await uploadFile({
    client: deployerPublicClient(publicClient),
    wallet: ownerWallet,
    config,
    container: opened.container,
    file: resumeFile,
  });
  const resumeTransactions = await decodeTransactions(publicClient, resumeResult.transactionHashes);
  const appendedIndices = txSummaryIndices(resumeTransactions);
  const duplicatePutFileOnResume = resumeTransactions.some((item) => item.functionName === "putFile");
  const resumeReadBlock = await publicClient.getBlockNumber();
  const resumeRead = await readFileBytesAt(publicClient, registry, opened.container, resumeFile.path, {
    blockNumber: resumeReadBlock,
    expectedSize: resumeFile.size,
  });
  const resumeFinalInfo = await onChainFile(publicClient, config, opened.container, resumeFile.path, resumeReadBlock);
  const resumeMatched =
    resumeRead.bytes.length === resumeFile.size &&
    sha256Hex(resumeRead.bytes).toLowerCase() === resumeFile.sha256.toLowerCase();
  const expectedAppendedIndices = resumeChunks.length - 1;
  checks.push(
    check(
      "UPLOAD-07",
      "uploadFile resumes only the missing chunks, appends no duplicates, and the final hash matches",
      {
        status: "UPLOADED",
        appendedIndices: Array.from({ length: expectedAppendedIndices }, (_, index) => index + 1),
        duplicatePutFileOnResume: false,
        finalMatched: true,
      },
      {
        status: resumeResult.status,
        appendedIndices,
        duplicatePutFileOnResume,
        finalMatched: resumeMatched,
      },
    ),
  );
  const resume: ResumeEvidence = {
    path: resumeFile.path,
    size: resumeFile.size,
    sha256: resumeFile.sha256,
    expectedChunks: resumeChunks.length,
    manualPutFileTx: manualPutTx,
    partial: {
      readBlock: Number(partialBlock),
      exists: partialInfo.exists,
      declaredSize: partialInfo.size,
      chunkCount: partialInfo.chunkCount,
      declaredSha256: partialInfo.sha256,
      contractCanReadPartialFile,
      readError: partialReadError,
      bytesRead,
      expectedPrefixBytes,
      prefixMatches,
      prefixSha256,
    },
    recoveryRequiresRestart,
    resumeStatus: resumeResult.status,
    resumeVerified: resumeResult.verified,
    resumeTransactionHashes: resumeResult.transactionHashes,
    resumeTransactions,
    appendedIndices,
    duplicatePutFileOnResume,
    final: {
      readBlock: Number(resumeReadBlock),
      size: resumeFinalInfo.size,
      chunkCount: resumeFinalInfo.chunkCount,
      sha256: resumeFinalInfo.sha256,
      matched: resumeMatched,
    },
  };

  // --- final invariants -----------------------------------------------------
  const finalPaths = await publicClient.readContract({
    address: registry,
    abi: siteRegistryAbi,
    functionName: "paths",
    args: [opened.container],
  });
  const finalPathCount = Number(
    await publicClient.readContract({
      address: registry,
      abi: siteRegistryAbi,
      functionName: "pathCount",
      args: [opened.container],
    }),
  );
  const expectedPathCount = matrixFiles.length + 1; // four matrix files + resumed file
  const rejectedPathsAbsent = [tooLargePath].every((path) => !finalPaths.includes(path));
  checks.push(
    check(
      "UPLOAD-09",
      "only the uploaded files are registered; the rejected 8.4 MB path is absent",
      { pathCount: expectedPathCount, rejectedPathsAbsent: true },
      { pathCount: finalPathCount, rejectedPathsAbsent },
    ),
  );

  const evidence: UploadEvidence = {
    kind: "tapeci.fork.upload.v1",
    generatedBy: options.generatedBy,
    generatedAt: new Date().toISOString(),
    fork: forkMetadata(fork),
    chain: {
      chainId: fork.chainId,
      siteRegistry: registry,
      opener: config.opener,
      chunkMax: CHUNK_MAX,
      maxFileBytes: MAX_FILE_BYTES,
    },
    container: {
      tokenId: opened.fixture.tokenId.toString(),
      container: opened.container,
      owner: opened.owner,
      openerEoa: UPLOAD_OPENER_EOA,
      openTx: opened.openTx,
      isOpened: opened.isOpened,
      registryIsOpenedContainer: opened.registryIsOpenedContainer,
    },
    matrix: {
      expected: expectedChunks,
      observed: Object.fromEntries(
        matrixFiles.map((entry) => [
          entry.label,
          files.find((record) => record.path === entry.file.path)?.onChain.chunkCount ?? -1,
        ]),
      ),
    },
    readBlock: Number(readBlock),
    files,
    rejections: { duplicateAppendChunk: duplicateRejection, illegalExpectIndex: illegalRejection },
    resume,
    tooLarge,
    recoveryFinding: {
      contractCanReadPartiallyWrittenFile: contractCanReadPartialFile,
      recoveryRequiresRestart,
      resumeUsedDuplicateAppends: duplicatePutFileOnResume,
      note: contractCanReadPartialFile
        ? "SiteRegistry.read() returns the bytes already written for a partially written path, and they were a byte-exact prefix of the local file, so uploadFile reconciled the prefix and appended only the missing chunks. RECOVERY_REQUIRES_RESTART is therefore false for this implementation."
        : "SiteRegistry.read() did not return the partial bytes; a resumed upload cannot prove its prefix, so RECOVERY_REQUIRES_RESTART must be reported.",
    },
    checks,
    result: summarize(checks),
  };
  return evidence;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function renderSummary(evidence: UploadEvidence): string {
  const lines = [
    `P0-05 upload: ${evidence.result.pass ? "PASS" : "FAIL"} (${evidence.result.checks} checks)`,
    `fork block: ${evidence.fork.forkBlockNumber} (${evidence.fork.sourceUrl})`,
    `container: ${evidence.container.container} (token #${evidence.container.tokenId})`,
    `fixed read block: ${evidence.readBlock}`,
    `recovery: contractCanReadPartialFile=${evidence.recoveryFinding.contractCanReadPartiallyWrittenFile} recoveryRequiresRestart=${evidence.recoveryFinding.recoveryRequiresRestart}`,
  ];
  for (const item of evidence.checks) {
    lines.push(`  ${item.pass ? "PASS" : "FAIL"} ${item.id}: ${item.description}`);
  }
  if (!evidence.result.pass) lines.push(`failures: ${evidence.result.failures.join(", ")}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const fork = await startAnvilFork();
  let evidence: UploadEvidence | null = null;
  try {
    evidence = await runUploadScenario(fork, { generatedBy: "scripts/fork/upload.ts" });
    const path = writeEvidence(UPLOAD_EVIDENCE_FILE, evidence);
    console.log(renderSummary(evidence));
    console.log(`evidence written to ${path}`);
  } finally {
    await fork.stop();
  }
  if (evidence === null || !evidence.result.pass) process.exitCode = 1;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error("P0-05 fork upload FAILED:", error);
    process.exitCode = 1;
  });
}
