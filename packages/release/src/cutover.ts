import type { PublicClient, WalletClient } from "viem";
import type { ReleaseManifest } from "@tapeci/artifact";
import type { ReadClient } from "@tapeci/chain";
import { readFileBytesAt, readFileInfo, siteRegistryAbi } from "@tapeci/chain";
import type { ChainConfig } from "@tapeci/config";
import { uploadFile } from "@tapeci/deployer";
import {
  CHUNK_MAX,
  TapeCiError,
  bytesToHex,
  sha256Hex,
  type ArtifactFile,
  type Hex,
} from "@tapeci/shared";
import {
  matchReleaseFiles,
  verifySite,
  type OperatorClient,
  type ReleaseManifestView,
} from "@tapeci/verifier";
import { decodeEntryHtml, verifyEntryReferences } from "./entry-references.js";
import type { ReleaseStore } from "./store.js";

export interface ChainWriterOptions {
  readonly client: ReadClient;
  readonly wallet: WalletClient;
  readonly config: ChainConfig;
}

export interface SwitchEntryOptions extends ChainWriterOptions {
  readonly manifest: ReleaseManifest;
  /** Exact bytes to write as the entry document (already versioned-rewritten). */
  readonly entryBytes: Uint8Array;
  /** Independent operators used to verify the release assets before switching. */
  readonly operators: readonly OperatorClient[];
  readonly pinnedBlock?: bigint | number;
  /** Test-only: a local Anvil fork cannot provide two independent operators. */
  readonly allowSingleOperator?: boolean;
}

export interface SwitchEntryResult {
  readonly purpose: "switch" | "rollback";
  readonly releaseId: string;
  readonly entryPath: string;
  readonly entrySha256: Hex;
  readonly previousEntrySha256: Hex | null;
  readonly transactionHashes: readonly Hex[];
  readonly pinnedBlockNumber: number;
  readonly verified: true;
}

interface EntrySnapshot {
  readonly exists: boolean;
  readonly size: number;
  readonly sha256: Hex;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

function registryOf(config: ChainConfig): Hex {
  const registry = config.registries[0];
  if (registry === undefined) throw new TapeCiError("INTERNAL", "no SiteRegistry configured");
  return registry;
}

async function snapshotEntry(
  client: ReadClient,
  registry: Hex,
  container: Hex,
  entryPath: string,
  blockNumber?: bigint,
): Promise<EntrySnapshot> {
  const info = await readFileInfo(client, registry, container, entryPath, blockNumber);
  if (!info.exists) {
    return { exists: false, size: 0, sha256: `0x${"0".repeat(64)}`, contentType: "", bytes: new Uint8Array() };
  }
  const read = await readFileBytesAt(client, registry, container, entryPath, {
    ...(blockNumber === undefined ? {} : { blockNumber }),
    expectedSize: info.size,
  });
  return {
    exists: true,
    size: info.size,
    sha256: info.sha256,
    contentType: info.contentType,
    bytes: read.bytes,
  };
}

async function verifyReleaseAssets(
  options: SwitchEntryOptions,
): Promise<number | null> {
  const assets = options.manifest.files.filter(
    (file) => file.path !== options.manifest.entryPath,
  );
  if (assets.length === 0) {
    return options.pinnedBlock === undefined ? null : Number(options.pinnedBlock);
  }
  const report = await verifySite({
    container: options.manifest.container,
    paths: assets.map((file) => file.path),
    ...(options.pinnedBlock === undefined ? {} : { pinnedBlock: options.pinnedBlock }),
    config: options.config,
    operators: options.operators,
    ...(options.allowSingleOperator === true ? { allowSingleOperator: true } : {}),
  });
  if (report.status !== "VERIFIED") {
    throw new TapeCiError(
      "VERIFICATION_FAILED",
      `release assets are not verified before entry switch: ${report.status}`,
      { details: { status: report.status, disagreements: report.disagreements } },
    );
  }
  const view: ReleaseManifestView = {
    chainId: 196,
    container: options.manifest.container,
    siteRegistry: options.manifest.siteRegistry,
    commitSha: options.manifest.commitSha,
    releaseId: options.manifest.releaseId,
    entryPath: options.manifest.entryPath,
    fallbackPath: options.manifest.fallbackPath,
    files: assets,
  };
  const matches = matchReleaseFiles(view, report.checks);
  if (!matches.allMatched) {
    throw new TapeCiError(
      "VERIFICATION_FAILED",
      "release assets do not match the approved manifest before entry switch",
      {
        details: {
          mismatched: matches.files.filter((file) => !file.matched).map((file) => file.path),
          missing: matches.missing,
        },
      },
    );
  }
  return report.pin.pinnedBlockNumber;
}

function entryArtifact(
  manifest: ReleaseManifest,
  entryBytes: Uint8Array,
): ArtifactFile {
  const row = manifest.files.find((file) => file.path === manifest.entryPath);
  if (row === undefined) {
    throw new TapeCiError("INVALID_ARTIFACT", `manifest has no entry row ${manifest.entryPath}`);
  }
  const sha256 = sha256Hex(entryBytes);
  if (row.size !== entryBytes.length || row.sha256.toLowerCase() !== sha256.toLowerCase()) {
    throw new TapeCiError("INVALID_ARTIFACT", "entry bytes do not match the manifest entry row");
  }
  if (row.chunks !== 1 || entryBytes.length > CHUNK_MAX) {
    throw new TapeCiError(
      "INVALID_ARTIFACT",
      `entry ${manifest.entryPath} must be a single chunk of at most ${CHUNK_MAX} bytes`,
      { details: { size: entryBytes.length, chunks: row.chunks } },
    );
  }
  return {
    path: row.path,
    sourceRelativePath: row.sourcePath,
    contentType: row.contentType,
    size: row.size,
    sha256: row.sha256,
    bytes: entryBytes,
  };
}

async function writeEntry(
  options: SwitchEntryOptions,
  file: ArtifactFile,
): Promise<{ transactionHashes: Hex[] }> {
  const registry = registryOf(options.config);
  const account = options.wallet.account;
  if (account === null || account === undefined) {
    throw new TapeCiError("SWITCH_FAILED", "wallet client has no account for the entry switch");
  }
  // Simulate first so an authorization/limit revert is reported before broadcast.
  try {
    await options.client.simulateContract({
      address: registry,
      abi: siteRegistryAbi,
      functionName: "putFile",
      args: [
        options.manifest.container,
        file.path,
        file.contentType,
        file.sha256,
        bytesToHex(file.bytes),
      ],
      account,
    });
  } catch (error) {
    throw new TapeCiError(
      "SWITCH_FAILED",
      `entry putFile simulation failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
      { cause: error, details: { entryPath: file.path } },
    );
  }
  let result;
  try {
    result = await uploadFile({
      client: options.client as unknown as PublicClient,
      wallet: options.wallet,
      config: options.config,
      container: options.manifest.container,
      file,
      mode: "replace",
      gas: 8_000_000n,
    });
  } catch (error) {
    const hash = (error as { details?: { hash?: Hex } }).details?.hash;
    let reason = "";
    if (hash !== undefined) {
      try {
        const transaction = await options.client.getTransaction({ hash });
        await options.client.call({
          account: transaction.from,
          to: transaction.to ?? undefined,
          data: transaction.input,
          blockNumber: transaction.blockNumber === null ? undefined : transaction.blockNumber,
        });
      } catch (callError) {
        reason = callError instanceof Error ? callError.message.slice(0, 400) : String(callError);
      }
    }
    throw new TapeCiError(
      "SWITCH_FAILED",
      `entry upload failed${reason === "" ? "" : `: ${reason}`}`,
      { cause: error, details: { hash } },
    );
  }
  if (result.status !== "UPLOADED" && result.status !== "UNCHANGED") {
    throw new TapeCiError(
      "SWITCH_FAILED",
      `entry write did not complete: ${result.status}`,
      { details: { detail: result.detail } },
    );
  }
  if (!result.verified) {
    throw new TapeCiError("SWITCH_FAILED", "entry write did not verify after the transaction");
  }
  return { transactionHashes: [...result.transactionHashes] };
}

async function verifyEntryAtLatest(
  options: SwitchEntryOptions,
  expectedSha256: Hex,
  expectedSize: number,
): Promise<void> {
  const registry = registryOf(options.config);
  const read = await readFileBytesAt(
    options.client,
    registry,
    options.manifest.container,
    options.manifest.entryPath,
    { expectedSize },
  );
  if (read.actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new TapeCiError("VERIFICATION_FAILED", "entry bytes do not match the expected hash");
  }
}

async function restorePreviousEntry(
  options: SwitchEntryOptions,
  previous: EntrySnapshot,
): Promise<void> {
  if (!previous.exists) return;
  const file: ArtifactFile = {
    path: options.manifest.entryPath,
    sourceRelativePath: options.manifest.entryPath,
    contentType: previous.contentType,
    size: previous.size,
    sha256: previous.sha256,
    bytes: previous.bytes,
  };
  let result;
  try {
    result = await uploadFile({
      client: options.client as unknown as PublicClient,
      wallet: options.wallet,
      config: options.config,
      container: options.manifest.container,
      file,
      mode: "replace",
      gas: 8_000_000n,
    });
  } catch (error) {
    const hash = (error as { details?: { hash?: Hex } }).details?.hash;
    let reason = "";
    if (hash !== undefined) {
      try {
        const transaction = await options.client.getTransaction({ hash });
        await options.client.call({
          account: transaction.from,
          to: transaction.to ?? undefined,
          data: transaction.input,
          blockNumber: transaction.blockNumber === null ? undefined : transaction.blockNumber,
        });
      } catch (callError) {
        reason = callError instanceof Error ? callError.message.slice(0, 400) : String(callError);
      }
    }
    throw new TapeCiError(
      "SWITCH_FAILED",
      `entry upload failed${reason === "" ? "" : `: ${reason}`}`,
      { cause: error, details: { hash } },
    );
  }
  if (!result.verified || (result.status !== "UPLOADED" && result.status !== "UNCHANGED")) {
    throw new TapeCiError(
      "SWITCH_FAILED",
      "entry switch failed AND the previous entry could not be restored; operator intervention required",
      { details: { previousSha256: previous.sha256 } },
    );
  }
}

async function switchEntry(
  options: SwitchEntryOptions,
  purpose: "switch" | "rollback",
): Promise<SwitchEntryResult> {
  const registry = registryOf(options.config);
  const file = entryArtifact(options.manifest, options.entryBytes);
  const references = verifyEntryReferences(decodeEntryHtml(options.entryBytes), options.manifest);
  if (!references.ok) {
    throw new TapeCiError(
      "INVALID_ARTIFACT",
      `entry references files missing from the manifest: ${references.missing.join(", ")}`,
      { details: { missing: references.missing, external: references.external } },
    );
  }

  // 1. Every asset must be live and match the manifest BEFORE the entry changes.
  const assetPin = await verifyReleaseAssets(options);
  const pinnedBlockNumber =
    assetPin ?? Number(await options.client.getBlockNumber());
  const previous = await snapshotEntry(
    options.client,
    registry,
    options.manifest.container,
    options.manifest.entryPath,
    BigInt(pinnedBlockNumber),
  );
  if (previous.exists && (previous.size > CHUNK_MAX || previous.bytes.length > CHUNK_MAX)) {
    throw new TapeCiError(
      "SWITCH_FAILED",
      "previous entry is larger than one chunk; refusing a switch that cannot be rolled back in one transaction",
      { details: { previousSize: previous.size } },
    );
  }

  // 2. Single putFile transaction. A failed transaction leaves the old entry intact.
  const write = await writeEntry(options, file);
  try {
    await verifyEntryAtLatest(options, file.sha256, file.size);
  } catch (error) {
    if (previous.exists) {
      await restorePreviousEntry(options, previous);
    }
    throw new TapeCiError(
      "SWITCH_FAILED",
      previous.exists
        ? "entry switch verification failed; previous entry restored"
        : "entry switch verification failed; there was no previous entry to restore",
      { cause: error, details: { entrySha256: file.sha256 } },
    );
  }

  return {
    purpose,
    releaseId: options.manifest.releaseId,
    entryPath: options.manifest.entryPath,
    entrySha256: file.sha256,
    previousEntrySha256: previous.exists ? previous.sha256 : null,
    transactionHashes: write.transactionHashes,
    pinnedBlockNumber,
    verified: true,
  };
}

/**
 * Switch the root entry to a release whose assets are already on chain and
 * verified. The entry change is one `putFile` transaction; on a failed
 * post-write verification the previous entry is restored before throwing.
 */
export function switchEntryToRelease(options: SwitchEntryOptions): Promise<SwitchEntryResult> {
  return switchEntry(options, "switch");
}

export interface RollbackOptions extends ChainWriterOptions {
  readonly store: ReleaseStore;
  readonly releaseId: string;
  readonly operators: readonly OperatorClient[];
  readonly pinnedBlock?: bigint | number;
  readonly allowSingleOperator?: boolean;
}

/**
 * Roll back to a historical release from the local store. The target assets are
 * verified on chain first; if they are missing or mismatched, nothing is written
 * and the current entry stays live.
 */
export async function rollbackToStoredRelease(
  options: RollbackOptions,
): Promise<SwitchEntryResult> {
  const { record, entryBytes } = await options.store.load(options.releaseId);
  return switchEntry(
    {
      client: options.client,
      wallet: options.wallet,
      config: options.config,
      manifest: record.manifest,
      entryBytes,
      operators: options.operators,
      ...(options.pinnedBlock === undefined ? {} : { pinnedBlock: options.pinnedBlock }),
      ...(options.allowSingleOperator === true ? { allowSingleOperator: true } : {}),
    },
    "rollback",
  );
}
