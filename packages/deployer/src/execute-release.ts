import type { PublicClient, WalletClient } from "viem";
import type { Hex } from "viem";
import type { ReleaseManifest } from "@tapeci/artifact";
import type { ReadClient } from "@tapeci/chain";
import {
  assertImplementationsAllowlisted,
  readFileBytesAt,
  siteRegistryAbi,
  verifyFileRead,
} from "@tapeci/chain";
import type { ChainConfig } from "@tapeci/config";
import {
  TapeCiError,
  bytesToHex,
  canonicalJson,
  sha256Hex,
  sha256HexOfString,
  type ArtifactFile,
} from "@tapeci/shared";
import {
  DeploymentJournal,
  deriveDeploymentId,
  planFingerprint,
  type JournalEvent,
  type JournalEventInput,
} from "./journal.js";
import { NonceLock } from "./nonce.js";
import { reverifyMissingFiles } from "./reverify.js";
import { planToJson, type PlanFileBytes, type ReleasePlan } from "./release-plan.js";
import {
  uploadFile,
  type UploadTransactionRequest,
  type UploadTransactionSender,
} from "./upload.js";

/** Stable identity of one chunk write (used for idempotency/journal dedupe). */
export function operationFingerprint(request: UploadTransactionRequest): Hex {
  return sha256HexOfString(
    canonicalJson({
      chainId: 196,
      container: request.container.toLowerCase(),
      operation: request.operation,
      path: request.path,
      chunkIndex: request.chunkIndex,
      declaredSha256: request.sha256.toLowerCase(),
      dataSha256: sha256Hex(request.data),
      expectIndex: request.expectIndex === undefined ? null : request.expectIndex.toString(),
    }),
  );
}

export interface ExecuteReleaseOptions {
  readonly plan: ReleasePlan;
  readonly manifest: ReleaseManifest;
  readonly files: readonly PlanFileBytes[];
  readonly client: ReadClient;
  readonly wallet: WalletClient;
  readonly config: ChainConfig;
  readonly journalPath: string;
  readonly signer: Hex;
  /** Test/fault-injection hook: stop before sending transaction N+1. */
  readonly maxTransactions?: number;
  readonly onEvent?: (event: JournalEvent) => void;
  /** Independent RPC operators (second one is used for receipt fallback). */
  readonly operators?: readonly { readonly client: ReadClient }[];
}

export interface ExecutedFile {
  readonly path: string;
  readonly status: "UPLOADED" | "UNCHANGED";
  readonly verified: boolean;
}

export interface ExecuteReleaseResult {
  readonly deploymentId: string;
  readonly status: "COMPLETE";
  readonly journalPath: string;
  /** Transactions sent by this invocation (0 when an already-complete journal is replayed). */
  readonly newTransactions: number;
  /** Transactions recorded as mined in the journal. */
  readonly journalTransactions: number;
  readonly files: readonly ExecutedFile[];
}

function blockedError(plan: ReleasePlan): TapeCiError {
  if (plan.blockedReasons.includes("UPLOAD_CONFLICT")) {
    return new TapeCiError("UPLOAD_CONFLICT", "plan contains conflicting target paths");
  }
  if (plan.blockedReasons.includes("FEE_OVER_BUDGET")) {
    return new TapeCiError("FEE_OVER_BUDGET", "plan exceeds the approved cost cap");
  }
  if (plan.blockedReasons.includes("INSUFFICIENT_BALANCE")) {
    return new TapeCiError("INSUFFICIENT_BALANCE", "signer balance is below the estimated cost");
  }
  return new TapeCiError("INTERNAL", "plan is blocked");
}

async function receiptOrNull(
  client: ReadClient,
  hash: Hex,
): Promise<Awaited<ReturnType<ReadClient["getTransactionReceipt"]>> | null> {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch {
    return null;
  }
}

/**
 * Reconcile every `tx_sent` that has no terminal event by querying the chain.
 * Never guesses: an unresolved transaction aborts the resume until an operator
 * inspects it (PRD §6.3).
 */
export async function reconcileJournalTransactions(
  journal: DeploymentJournal,
  client: ReadClient,
): Promise<void> {
  for (const record of journal.unresolvedTransactions()) {
    const sent = record.sent;
    if (sent === undefined) continue;
    const receipt = await receiptOrNull(client, sent.txHash);
    if (receipt === null) {
      throw new TapeCiError(
        "UPLOAD_INTERRUPTED",
        `transaction ${sent.txHash} (nonce ${sent.nonce}) is neither mined nor dropped; refusing to guess`,
        { details: { txHash: sent.txHash, nonce: sent.nonce } },
      );
    }
    if (receipt.status === "success") {
      await journal.append({
        type: "tx_mined",
        deploymentId: journal.state.deploymentId ?? "",
        fingerprint: record.fingerprint,
        txHash: sent.txHash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed.toString(),
      });
    } else {
      await journal.append({
        type: "tx_failed",
        deploymentId: journal.state.deploymentId ?? "",
        fingerprint: record.fingerprint,
        txHash: sent.txHash,
        nonce: sent.nonce,
        errorCode: "TRANSACTION_REVERTED",
        message: `transaction ${sent.txHash} reverted (recovered from chain)`,
      });
    }
  }
}

function artifactFromManifest(
  manifest: ReleaseManifest,
  sourcePath: string,
  bytes: Uint8Array,
): ArtifactFile {
  const row = manifest.files.find((file) => file.sourcePath === sourcePath);
  if (row === undefined) {
    throw new TapeCiError("INVALID_ARTIFACT", `manifest has no file for ${sourcePath}`);
  }
  return {
    path: row.path,
    sourceRelativePath: row.sourcePath,
    contentType: row.contentType,
    size: row.size,
    sha256: row.sha256,
    bytes,
  };
}

function orderWrites(plan: ReleasePlan): ReleasePlan["files"][number][] {
  const writes = plan.files.filter((file) => file.action === "WRITE");
  const assets = writes.filter((file) => file.path !== plan.entryPath);
  const entry = writes.filter((file) => file.path === plan.entryPath);
  return [...assets, ...entry];
}

/**
 * Execute an approved plan with a crash-tolerant journal and serialized nonce
 * allocation. Assets are written first; the entry file is written last so a
 * crash can never point the live site at missing assets (PRD §5.2 / P1-06).
 *
 * Re-running with the same journal resumes: on-chain state is reconciled first,
 * completed files are skipped by `uploadFile`, and only missing chunks are sent.
 */
export async function executeRelease(options: ExecuteReleaseOptions): Promise<ExecuteReleaseResult> {
  const { plan, manifest, client, wallet, config } = options;
  if (plan.blocked) throw blockedError(plan);
  if (plan.chainId !== 196) throw new TapeCiError("CHAIN_MISMATCH", "plan is not for X Layer 196");
  if (plan.container.toLowerCase() !== manifest.container.toLowerCase()) {
    throw new TapeCiError("PLAN_STALE", "plan and manifest target different containers");
  }
  // Fail closed if the chain or the pinned implementations changed since planning.
  const chainId = await client.getChainId();
  if (chainId !== 196) {
    throw new TapeCiError("CHAIN_MISMATCH", `execution RPC reports chainId ${chainId}, expected 196`);
  }
  await assertImplementationsAllowlisted(client, config);

  const bytesBySource = new Map<string, Uint8Array>();
  for (const file of options.files) bytesBySource.set(file.sourcePath, file.bytes);
  for (const file of manifest.files) {
    const bytes = bytesBySource.get(file.sourcePath);
    if (bytes === undefined || bytes.length !== file.size || sha256Hex(bytes) !== file.sha256) {
      throw new TapeCiError(
        "INVALID_ARTIFACT",
        `bytes for ${file.sourcePath} are missing or do not match the manifest`,
      );
    }
  }

  const expectedFingerprint = planFingerprint(plan);
  const journal = await DeploymentJournal.open(options.journalPath);
  let newTransactions = 0;
  try {
    const record = async (input: JournalEventInput): Promise<JournalEvent> => {
      const event = await journal.append(input);
      options.onEvent?.(event);
      return event;
    };

    if (journal.state.plan !== null) {
      if (
        journal.state.plan.planFingerprint.toLowerCase() !== expectedFingerprint.toLowerCase() ||
        journal.state.plan.releaseManifestHash.toLowerCase() !== plan.releaseManifestHash.toLowerCase()
      ) {
        throw new TapeCiError(
          "PLAN_STALE",
          "journal belongs to a different plan; refusing to resume it",
          {
            details: {
              journalPlan: journal.state.plan.planFingerprint,
              requestedPlan: expectedFingerprint,
            },
          },
        );
      }
      await reconcileJournalTransactions(journal, client);
      if (journal.state.complete) {
        const registry = config.registries[0];
        if (registry === undefined) throw new TapeCiError("INTERNAL", "no registry configured");
        const files: ExecutedFile[] = [];
        for (const file of manifest.files) {
          const bytes = bytesBySource.get(file.sourcePath);
          if (bytes === undefined) throw new TapeCiError("INVALID_ARTIFACT", "bytes missing");
          const read = await readFileBytesAt(client, registry, plan.container, file.path);
          const verification = verifyFileRead(file.path, read, { sha256: file.sha256, size: file.size });
          if (!verification.matched) {
            throw new TapeCiError(
              "PLAN_STALE",
              `completed journal no longer matches on-chain file ${file.path}`,
            );
          }
          files.push({ path: file.path, status: "UNCHANGED", verified: true });
        }
        // A journal completed by an older build may lack file_verified for files
        // that were mined but not verified (mainnet canary 2026-10-24). Record real,
        // pinned re-verification evidence for them; no new transactions are sent.
        await reverifyMissingFiles({
          journal,
          manifest,
          registry,
          readers: [{ client, label: "execution RPC" }],
          recovered: true,
          record,
        });
        return {
          deploymentId: journal.state.deploymentId ?? deriveDeploymentId(plan),
          status: "COMPLETE",
          journalPath: options.journalPath,
          newTransactions: 0,
          journalTransactions: journal.state.transactions.size,
          files,
        };
      }
    } else {
      await record({
        type: "plan",
        deploymentId: deriveDeploymentId(plan),
        planFingerprint: expectedFingerprint,
        releaseManifestHash: plan.releaseManifestHash,
        artifactDigest: plan.artifactDigest,
        chainId: 196,
        container: plan.container,
        siteRegistry: plan.siteRegistry,
        commitSha: plan.commitSha,
        releaseId: plan.releaseId,
        entryPath: plan.entryPath,
        pinnedBlockNumber: plan.pinnedBlockNumber.toString(),
        planJson: planToJson(plan),
      });
    }

    const deploymentId = journal.state.deploymentId;
    if (deploymentId === null) throw new TapeCiError("INTERNAL", "journal has no deployment id");

    const nonceLock = new NonceLock({ client, signer: options.signer, journal });
    const registry = config.registries[0];
    if (registry === undefined) throw new TapeCiError("INTERNAL", "no registry configured");
    const maxTransactions = options.maxTransactions ?? Number.POSITIVE_INFINITY;

    const sender: UploadTransactionSender = async (request) => {
      const fingerprint = operationFingerprint(request);
      const existing = journal.state.transactions.get(fingerprint);

      if (existing?.mined !== undefined) {
        return {
          hash: existing.mined.txHash,
          gasUsed: BigInt(existing.mined.gasUsed),
          blockNumber: BigInt(existing.mined.blockNumber),
        };
      }
      if (existing?.failed !== undefined) {
        throw new TapeCiError(
          "UPLOAD_INTERRUPTED",
          `previous attempt for ${request.path} chunk ${request.chunkIndex} failed; refusing to retry blindly`,
          { details: { fingerprint, error: existing.failed.message } },
        );
      }
      if (existing?.sent !== undefined) {
        const receipt = await receiptOrNull(client, existing.sent.txHash);
        if (receipt === null) {
          throw new TapeCiError(
            "UPLOAD_INTERRUPTED",
            `transaction ${existing.sent.txHash} is unresolved; refusing to send a duplicate`,
          );
        }
        if (receipt.status === "success") {
          await record({
            type: "tx_mined",
            deploymentId,
            fingerprint,
            txHash: existing.sent.txHash,
            blockNumber: receipt.blockNumber.toString(),
            blockHash: receipt.blockHash,
            gasUsed: receipt.gasUsed.toString(),
          });
          return {
            hash: existing.sent.txHash,
            gasUsed: receipt.gasUsed,
            blockNumber: receipt.blockNumber,
          };
        }
        await record({
          type: "tx_failed",
          deploymentId,
          fingerprint,
          txHash: existing.sent.txHash,
          nonce: existing.sent.nonce,
          errorCode: "TRANSACTION_REVERTED",
          message: "previously sent transaction reverted",
        });
        throw new TapeCiError("UPLOAD_INTERRUPTED", "previous transaction reverted; inspect the journal");
      }
      if (newTransactions >= maxTransactions) {
        throw new TapeCiError(
          "UPLOAD_INTERRUPTED",
          `interrupted after ${newTransactions} transaction(s) (resume with the same journal)`,
          { details: { newTransactions, maxTransactions } },
        );
      }

      let nonce: bigint;
      if (existing?.intent !== undefined) {
        // Crash after intent, before broadcast: the nonce was never consumed.
        nonce = BigInt(existing.intent.nonce);
      } else {
        nonce = await nonceLock.allocate();
        await record({
          type: "tx_intent",
          deploymentId,
          fingerprint,
          operation: request.operation,
          path: request.path,
          chunkIndex: request.chunkIndex,
          nonce: nonce.toString(),
          dataSha256: sha256Hex(request.data),
          dataBytes: request.data.length,
          expectIndex: request.expectIndex === undefined ? null : request.expectIndex.toString(),
        });
      }

      let hash: Hex;
      try {
        if (request.operation === "putFile") {
          hash = await wallet.writeContract({
            address: registry,
            abi: siteRegistryAbi,
            functionName: "putFile",
            args: [request.container, request.path, request.contentType, request.sha256, bytesToHex(request.data)],
            chain: wallet.chain,
            account: wallet.account ?? null,
            nonce: Number(nonce),
          });
        } else {
          if (request.expectIndex === undefined) {
            throw new TapeCiError("INTERNAL", "appendChunk request is missing expectIndex");
          }
          hash = await wallet.writeContract({
            address: registry,
            abi: siteRegistryAbi,
            functionName: "appendChunk",
            args: [request.container, request.path, request.expectIndex, bytesToHex(request.data)],
            chain: wallet.chain,
            account: wallet.account ?? null,
            nonce: Number(nonce),
          });
        }
      } catch (error) {
        // Nothing was broadcast, so the nonce was not consumed and no terminal
        // failure is written: a later resume may safely retry this chunk.
        await record({
          type: "note",
          deploymentId,
          message: `send rejected before broadcast for ${request.path} chunk ${request.chunkIndex}: ${
            error instanceof Error ? error.message.slice(0, 300) : String(error)
          }`,
        });
        throw error;
      }

      await record({
        type: "tx_sent",
        deploymentId,
        fingerprint,
        txHash: hash,
        nonce: nonce.toString(),
      });
      let receipt;
      try {
        receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      } catch (error) {
        // The primary RPC can lag or drop the receipt while the tx is mined.
        // Ask the second independent operator before declaring an interruption.
        const fallback = options.operators?.[1]?.client;
        if (fallback !== undefined) {
          for (let attempt = 0; attempt < 60 && receipt === undefined; attempt += 1) {
            const candidate = await fallback.getTransactionReceipt({ hash }).catch(() => null);
            if (candidate !== null) receipt = candidate;
            else await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        if (receipt === undefined) {
          throw new TapeCiError(
            "UPLOAD_INTERRUPTED",
            `transaction ${hash} was broadcast but not confirmed; resume will reconcile it`,
            { cause: error, details: { txHash: hash } },
          );
        }
      }
      if (receipt.status !== "success") {
        await record({
          type: "tx_failed",
          deploymentId,
          fingerprint,
          txHash: hash,
          nonce: nonce.toString(),
          errorCode: "TRANSACTION_REVERTED",
          message: `transaction ${hash} reverted`,
        });
        throw new TapeCiError("INTERNAL", `transaction ${hash} reverted`, { details: { hash } });
      }
      await record({
        type: "tx_mined",
        deploymentId,
        fingerprint,
        txHash: hash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed.toString(),
      });
      newTransactions += 1;
      return { hash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
    };

    const executed: ExecutedFile[] = [];
    const uploadClient = client as unknown as PublicClient;
    for (const action of orderWrites(plan)) {
      const bytes = bytesBySource.get(action.sourcePath);
      if (bytes === undefined) {
        throw new TapeCiError("INVALID_ARTIFACT", `no bytes for ${action.sourcePath}`);
      }
      const file = artifactFromManifest(manifest, action.sourcePath, bytes);
      const result = await uploadFile({
        client: uploadClient,
        wallet,
        config,
        container: plan.container,
        file,
        mode: action.path === plan.entryPath ? "replace" : "conflict",
        send: sender,
        ...(options.operators?.[1] === undefined ? {} : { confirmClient: options.operators[1].client as unknown as PublicClient }),
      });
      if (result.status === "CONFLICT" || result.status === "RECOVERY_REQUIRES_RESTART") {
        throw new TapeCiError(
          "UPLOAD_CONFLICT",
          `file ${action.path} could not be written: ${result.status}`,
          { details: { detail: result.detail } },
        );
      }
      if (!result.verified) {
        throw new TapeCiError("VERIFICATION_FAILED", `file ${action.path} failed verification`);
      }
      await record({
        type: "file_verified",
        deploymentId,
        path: action.path,
        sha256: action.sha256,
        size: action.size,
        status: result.status === "UNCHANGED" ? "UNCHANGED" : "UPLOADED",
        transactionCount: result.transactionHashes.length,
      });
      executed.push({ path: action.path, status: result.status === "UNCHANGED" ? "UNCHANGED" : "UPLOADED", verified: true });
    }

    // Every manifest file needs evidence before completion: files planned as
    // UNCHANGED on resume (or mined in an earlier, interrupted run) are not in
    // orderWrites(), so verify them here at a pin >= the last mined write.
    const reverified = await reverifyMissingFiles({
      journal,
      manifest,
      registry,
      readers: [{ client, label: "execution RPC" }],
      recovered: false,
      record,
    });
    for (const file of reverified.verified) executed.push({ path: file.path, status: file.status, verified: true });

    await record({
      type: "deployment_complete",
      deploymentId,
      releaseManifestHash: plan.releaseManifestHash,
      verifiedFiles: journal.state.verifiedFiles.size,
      totalTransactions: journal.state.transactions.size,
    });

    return {
      deploymentId,
      status: "COMPLETE",
      journalPath: options.journalPath,
      newTransactions,
      journalTransactions: journal.state.transactions.size,
      files: executed,
    };
  } finally {
    await journal.close();
  }
}

/** Import-free constant re-export used by tests/CLI to locate a journal for a plan. */
export function journalPathForDirectory(directory: string, plan: ReleasePlan): string {
  return `${directory.replace(/\/+$/, "")}/${deriveDeploymentId(plan)}.jsonl`;
}
