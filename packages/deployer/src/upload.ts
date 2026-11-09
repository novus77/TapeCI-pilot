import { getAddress, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from "viem";
import {
  CHUNK_MAX,
  TapeCiError,
  bytesToHex,
  chunkBytes,
  sha256Hex,
  type ArtifactFile,
  type UploadResult,
} from "@tapeci/shared";
import type { ChainConfig } from "@tapeci/config";
import {
  readFileBytesAt,
  readFileInfo,
  retryPinnedRead,
  siteRegistryAbi,
  verifyFileRead,
  waitForBlock,
  type WaitForBlockOptions,
} from "@tapeci/chain";

/** One on-chain write the upload engine wants to perform. */
export interface UploadTransactionRequest {
  readonly container: Hex;
  readonly operation: "putFile" | "appendChunk";
  readonly path: string;
  /** 0 for putFile, 1..n for appendChunk. */
  readonly chunkIndex: number;
  readonly contentType: string;
  /** Declared whole-file SHA-256 (putFile carries it on chain). */
  readonly sha256: Hex;
  /** Exact chunk payload. */
  readonly data: Uint8Array;
  /** appendChunk only: the contract rejects any value != current chunkCount. */
  readonly expectIndex?: bigint;
}

export interface UploadTransactionResult {
  readonly hash: Hex;
  readonly gasUsed?: bigint;
  readonly blockNumber?: bigint;
}

/**
 * Sends one chunk and returns only after its receipt is a success. The default
 * implementation writes directly with the wallet client; P1-06 injects a journaled
 * sender that persists intent/nonce/tx hash before and after broadcast.
 */
export type UploadTransactionSender = (
  request: UploadTransactionRequest,
) => Promise<UploadTransactionResult>;

export interface UploadOptions {
  readonly client: PublicClient;
  readonly wallet: WalletClient;
  readonly config: ChainConfig;
  readonly container: Hex;
  readonly file: ArtifactFile;
  /** `conflict` refuses to overwrite a same-path/different-hash file; `replace` overwrites via putFile. */
  readonly mode?: "conflict" | "replace";
  /** Pin the pre-upload `fileInfo` read to a block (fork tests fix this). */
  readonly blockNumber?: bigint;
  /** Optional journaled sender (P1-06); defaults to a direct wallet write. */
  readonly send?: UploadTransactionSender;
  /** Explicit gas limit for the default sender (journaled senders manage their own). */
  readonly gas?: bigint;
  /**
   * Read-after-write guard for the post-upload verification: wait until the read
   * client has imported the last mined block, then read pinned at that block.
   */
  readonly readAfterWrite?: WaitForBlockOptions;
  /** Second independent RPC used to confirm a receipt when the primary lags. */
  readonly confirmClient?: PublicClient;
}

function registryOf(config: ChainConfig): Hex {
  const registry = config.registries[0];
  if (!registry) throw new TapeCiError("INTERNAL", "no SiteRegistry configured");
  return registry;
}

/** Direct, non-journaled sender (the P0/P1-05 behaviour). */
export function createDefaultUploadSender(options: {
  client: PublicClient;
  wallet: WalletClient;
  config: ChainConfig;
  gas?: bigint;
  confirmClient?: PublicClient;
}): UploadTransactionSender {
  const registry = registryOf(options.config);
  return async (request) => {
    let hash: Hex;
    if (request.operation === "putFile") {
      hash = await options.wallet.writeContract({
        address: registry,
        abi: siteRegistryAbi,
        functionName: "putFile",
        args: [request.container, request.path, request.contentType, request.sha256, bytesToHex(request.data)],
        chain: options.wallet.chain,
        account: options.wallet.account ?? null,
        ...(options.gas === undefined ? {} : { gas: options.gas }),
      });
    } else {
      if (request.expectIndex === undefined) {
        throw new TapeCiError("INTERNAL", "appendChunk request is missing expectIndex");
      }
      hash = await options.wallet.writeContract({
        address: registry,
        abi: siteRegistryAbi,
        functionName: "appendChunk",
        args: [request.container, request.path, request.expectIndex, bytesToHex(request.data)],
        chain: options.wallet.chain,
        account: options.wallet.account ?? null,
        ...(options.gas === undefined ? {} : { gas: options.gas }),
      });
    }
    const receipt = await waitForReceipt(hash, options.client, options.confirmClient);
    if (receipt.status !== "success") {
      throw new TapeCiError("INTERNAL", `transaction ${hash} reverted`, { details: { hash } });
    }
    return { hash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
  };
}

/**
 * Upload one file as 24,000-byte chunks.
 *
 * Safety rules implemented here (PRD §6.1):
 * - an existing file with identical bytes is verified and skipped;
 * - a partial file is only resumed when its on-chain prefix can be read back and
 *   matches the local prefix byte-for-byte; otherwise
 *   `RECOVERY_REQUIRES_RESTART` is returned instead of guessing;
 * - after the last chunk the full file is read back and SHA-256 verified; a
 *   successful receipt alone is never treated as success.
 */
/** Confirm a receipt on the primary RPC, falling back to a second operator. */
async function waitForReceipt(
  hash: Hex,
  primary: PublicClient,
  fallback: PublicClient | undefined,
): Promise<TransactionReceipt> {
  try {
    return await primary.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch (error) {
    if (fallback === undefined) throw error;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const receipt = await fallback.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt !== null) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw error;
  }
}

export async function uploadFile(options: UploadOptions): Promise<UploadResult> {
  const { client, config, container, file } = options;
  /**
   * What to do when the on-chain prefix is not ours.
   *
   * `replace` means "this file is meant to be overwritten" (the entry point after a
   * cutover), so an unrecognised prefix is re-put from chunk 0 rather than reported as a
   * conflict. `conflict` (the default for every other file) means an unrecognised prefix
   * is exactly the accidental-overwrite case and must stop the upload.
   */
  const mode = options.mode ?? "conflict";
  const registry = registryOf(config);
  const address = getAddress(container);
  const chunks = chunkBytes(file.bytes);
  const transactionHashes: Hex[] = [];
  let lastMinedBlock: bigint | null = null;
  const noteMined = (block: bigint | undefined): void => {
    if (block !== undefined && (lastMinedBlock === null || block > lastMinedBlock)) lastMinedBlock = block;
  };

  if (file.size !== file.bytes.length) {
    throw new TapeCiError("INVALID_ARTIFACT", `declared size ${file.size} != byte length ${file.bytes.length}`);
  }
  if (chunks.length > 350) {
    throw new TapeCiError("TOO_MANY_CHUNKS", `file needs ${chunks.length} chunks`);
  }

  const info = await readFileInfo(client, registry, address, file.path, options.blockNumber);

  if (info.exists && info.size === file.size && info.sha256.toLowerCase() === file.sha256.toLowerCase()) {
    const read = await readFileBytesAt(client, registry, address, file.path, {
      ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
      expectedSize: file.size,
    });
    const verification = verifyFileRead(file.path, read, { sha256: file.sha256, size: file.size });
    if (!verification.matched) {
      throw new TapeCiError("VERIFICATION_FAILED", `existing file ${file.path} does not verify`, {
        details: { ...verification },
      });
    }
    return { path: file.path, status: "UNCHANGED", transactionHashes, verified: true };
  }

  let nextIndex = 0;
  // §12.2 resume: reconcile the on-chain chunk prefix for **both** modes, because a
  // half-written file must continue from the chunk it reached whoever it belongs to. Keying
  // this on `mode === "conflict"` alone meant a half-written entry file (uploaded with
  // `replace`) restarted at chunk 0 while every other file resumed — the inconsistent-resume
  // bug P7-17 recorded.
  //
  // The mode then decides what an *unrecognised* prefix means: a conflict for `conflict`,
  // a deliberate overwrite for `replace`.
  if (info.exists && info.chunkCount > 0) {
    const reconciliation = await reconcilePrefix(client, registry, address, file, chunks, info, options.blockNumber);
    if (reconciliation.status === "CONFLICT" && mode === "conflict") {
      return {
        path: file.path,
        status: "CONFLICT",
        transactionHashes,
        verified: false,
        detail: reconciliation.detail,
      };
    }
    if (reconciliation.status === "RECOVERY_REQUIRES_RESTART" && mode === "conflict") {
      return {
        path: file.path,
        status: "RECOVERY_REQUIRES_RESTART",
        transactionHashes,
        verified: false,
        detail: reconciliation.detail,
      };
    }
    // Only continue from a prefix the reconciler accepted; in `replace` mode an
    // unrecognised prefix restarts from chunk 0 by design.
    nextIndex = reconciliation.status === "CONFLICT" || reconciliation.status === "RECOVERY_REQUIRES_RESTART"
      ? 0
      : reconciliation.nextIndex;
  }

  const send =
    options.send ??
    createDefaultUploadSender({
      client: options.client,
      wallet: options.wallet,
      config: options.config,
      ...(options.gas === undefined ? {} : { gas: options.gas }),
    });

  if (nextIndex === 0) {
    const first = chunks[0];
    if (!first) throw new TapeCiError("INTERNAL", "chunk 0 missing");
    const result = await send({
      container: address,
      operation: "putFile",
      path: file.path,
      chunkIndex: 0,
      contentType: file.contentType,
      sha256: file.sha256,
      data: first,
    });
    transactionHashes.push(result.hash);
    noteMined(result.blockNumber);
    nextIndex = 1;
  }

  for (let index = Math.max(1, nextIndex); index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) throw new TapeCiError("INTERNAL", `chunk ${index} missing`);
    const result = await send({
      container: address,
      operation: "appendChunk",
      path: file.path,
      chunkIndex: index,
      contentType: file.contentType,
      sha256: file.sha256,
      data: chunk,
      expectIndex: BigInt(index),
    });
    transactionHashes.push(result.hash);
    noteMined(result.blockNumber);
  }

  // Read-after-write: a receipt from one node does not mean the node serving this
  // read has the block yet (mainnet canary 2026-10-24, tx 0x6336c8da…09ad at block
  // 74087230 read back as "file does not exist"). Wait for the mined block and pin
  // the read to it; never read "latest" right after a write.
  let verifyBlock: bigint | undefined;
  const mined = lastMinedBlock as bigint | null;
  if (mined !== null) {
    await waitForBlock(client, mined, { label: "post-upload read client", ...(options.readAfterWrite ?? {}) });
    verifyBlock = mined;
  }
  const read = await retryPinnedRead(() =>
    readFileBytesAt(client, registry, address, file.path, {
      expectedSize: file.size,
      ...(verifyBlock === undefined ? {} : { blockNumber: verifyBlock }),
    }),
  );
  const verification = verifyFileRead(file.path, read, { sha256: file.sha256, size: file.size });
  if (!verification.matched) {
    throw new TapeCiError("VERIFICATION_FAILED", `file ${file.path} failed post-upload verification`, {
      details: { ...verification },
    });
  }
  return {
    path: file.path,
    status: "UPLOADED",
    transactionHashes,
    verified: true,
    ...(verifyBlock === undefined ? {} : { verifiedAtBlock: verifyBlock }),
  };
}

interface Reconciliation {
  readonly status: "RESUME" | "CONFLICT" | "RECOVERY_REQUIRES_RESTART";
  readonly nextIndex: number;
  readonly detail?: string;
}

async function reconcilePrefix(
  client: PublicClient,
  registry: Hex,
  container: Hex,
  file: ArtifactFile,
  chunks: readonly Uint8Array[],
  info: Awaited<ReturnType<typeof readFileInfo>>,
  blockNumber?: bigint,
): Promise<Reconciliation> {
  if (info.chunkCount > chunks.length) {
    return {
      status: "CONFLICT",
      nextIndex: 0,
      detail: `on-chain chunkCount ${info.chunkCount} exceeds planned ${chunks.length}`,
    };
  }
  // A partial write can only be resumed if the contract lets us read the bytes
  // already stored, and those bytes are exactly the prefix of our file.
  let onChainBytes: Uint8Array;
  try {
    const read = await readFileBytesAt(client, registry, container, file.path, {
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    onChainBytes = read.bytes;
  } catch (error) {
    return {
      status: "RECOVERY_REQUIRES_RESTART",
      nextIndex: 0,
      detail: `cannot read partially-written file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const completeChunks = info.chunkCount;
  const expectedPrefixLength = Math.min(completeChunks * CHUNK_MAX, file.size);
  if (onChainBytes.length !== expectedPrefixLength) {
    return {
      status: "RECOVERY_REQUIRES_RESTART",
      nextIndex: 0,
      detail: `on-chain read returned ${onChainBytes.length} bytes, expected prefix ${expectedPrefixLength}`,
    };
  }
  const localPrefix = file.bytes.subarray(0, onChainBytes.length);
  if (onChainBytes.length !== localPrefix.length || !equalBytes(onChainBytes, localPrefix)) {
    return {
      status: "CONFLICT",
      nextIndex: 0,
      detail: "on-chain prefix does not match the planned file bytes",
    };
  }
  return { status: "RESUME", nextIndex: completeChunks };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Re-read a file at a pinned block and verify its size + SHA-256. */
export async function verifyUploadedFile(
  client: PublicClient,
  config: ChainConfig,
  container: Hex,
  file: ArtifactFile,
  blockNumber?: bigint,
): Promise<boolean> {
  const registry = registryOf(config);
  const info = await readFileInfo(client, registry, container, file.path, blockNumber);
  if (!info.exists) return false;
  const read = await readFileBytesAt(client, registry, container, file.path, {
    ...(blockNumber === undefined ? {} : { blockNumber }),
    expectedSize: file.size,
  });
  const verification = verifyFileRead(file.path, read, { sha256: file.sha256, size: file.size });
  if (!verification.matched) return false;
  const rereadSha = sha256Hex(read.bytes);
  return rereadSha.toLowerCase() === file.sha256.toLowerCase();
}

export { CHUNK_MAX };
