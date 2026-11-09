/**
 * P2-06 worker runtime: real plan / deploy / verify handlers.
 *
 * The BullMQ worker factory in `@tapeci/queue` owns queue mechanics, retries and
 * the per-container lock. This module owns the side effects:
 *
 *   artifact tar -> prepareVersionedRelease -> planRelease -> PLAN_READY
 *   approved plan + operator session -> executeRelease -> switchEntry -> VERIFYING_RELEASE
 *   verifyRelease (chain bytes + journal) -> LIVE only when releaseMatch === true
 *
 * No mainnet guard is bypassed here: production uses XLAYER_MAINNET, a funded
 * operator key from the environment, and the existing fail-closed checks.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { createWalletClient, http, keccak256, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { XLAYER_MAINNET, type ChainConfig } from "@tapeci/config";
import { waitForBlockOnAll, xLayerChain, type ReadClient } from "@tapeci/chain";
import type { Database } from "@tapeci/database";
import { recoveryJournalId, recoveryPlanJson } from "../recovery.js";
import { notifyProject } from "../notifications.js";
import {
  approvals,
  artifactUploads,
  chainTransactions,
  containers,
  deployments,
  githubInstallations,
  projects,
  releaseFiles,
  releases,
} from "@tapeci/database";
import {
  LocalObjectStore,
  ingestArtifactTar,
  type ObjectStore,
} from "@tapeci/github";
import { createObjectStore } from "../object-store.js";
import {
  assertOperatorAuthorized,
  createDeploymentQueues,
  enqueueDeployment,
  transitionDeployment,
  type WorkerHandlerMap,
} from "@tapeci/queue";
import { switchEntryToRelease, type PreparedRelease } from "@tapeci/release";
import { selectPinnedBlock } from "@tapeci/verifier";
import {
  executeRelease,
  planFromJson,
  planRelease,
  planToJson,
  readJournalState,
  type PlanFileBytes,
  type ReleasePlan,
} from "@tapeci/deployer";
import {
  createOperatorClients,
  journalEvidenceFromState,
  releaseReportToJson,
  verifyRelease,
  type OperatorClient,
} from "@tapeci/verifier";
import type { ReleaseManifest } from "@tapeci/artifact";
import { TapeCiError } from "@tapeci/shared";
import type { ApiEnv } from "../env.js";
import { freezePreparedArtifact, loadPreparedArtifact, type PreparedArtifactContext, type PreparedArtifactExpectedContext } from "./prepared-artifact.js";
import { parsePreparationRequest, requireCompressionGateway, type CompressionGatewayQualification } from "./preparation-policy.js";
import { prepareDeploymentRelease } from "./prepare-release.js";

export interface WorkerRuntimeOptions {
  readonly db: Database;
  readonly env: ApiEnv;
  readonly config?: ChainConfig;
  readonly operators?: readonly OperatorClient[];
  readonly wallet?: WalletClient;
  readonly signer?: Hex;
  readonly journalDir?: string;
  readonly objectStoreDir?: string;
  readonly objectStore?: ObjectStore;
  readonly allowSingleOperator?: boolean;
  /**
   * Pin for planning reads. Production leaves this unset (head - configured
   * offset). Fork tests set it after opening the container so the plan reads a
   * block where the container exists.
   */
  readonly planPinnedBlockNumber?: bigint | number;
  readonly enqueueVerify?: (deploymentId: string) => Promise<void>;
  readonly compressionGateways?: readonly CompressionGatewayQualification[];
}

export interface WorkerRuntime {
  readonly db: Database;
  readonly env: ApiEnv;
  readonly config: ChainConfig;
  readonly operators: readonly OperatorClient[];
  readonly wallet: WalletClient | null;
  readonly signer: Hex | null;
  readonly journalDir: string;
  readonly objectStore: ObjectStore;
  readonly allowSingleOperator: boolean;
  readonly planPinnedBlockNumber: bigint | null;
  readonly enqueueVerify: (deploymentId: string) => Promise<void>;
  readonly compressionGateways: readonly CompressionGatewayQualification[];
}

function defaultEnqueueVerify(env: ApiEnv): (deploymentId: string) => Promise<void> {
  return async (deploymentId: string): Promise<void> => {
    const queues = createDeploymentQueues({ redisUrl: env.redisUrl });
    try {
      await enqueueDeployment(queues.verify, deploymentId);
    } finally {
      await queues.close();
    }
  };
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const config = options.config ?? XLAYER_MAINNET;
  const operators = options.operators ?? createOperatorClients(config);
  let wallet = options.wallet ?? null;
  let signer = options.signer ?? null;
  if (wallet === null && options.env.operatorPrivateKey !== null) {
    const account = privateKeyToAccount(options.env.operatorPrivateKey as Hex);
    const writeUrl = options.env.writeRpcUrl ?? config.rpcs[0]?.url;
    if (writeUrl === undefined) {
      throw new TapeCiError("INVALID_CONFIG", "no write RPC URL configured for the worker");
    }
    wallet = createWalletClient({
      account,
      chain: xLayerChain,
      transport: http(writeUrl, { retryCount: 0, timeout: 60_000 }),
    });
    signer = account.address;
  }
  return {
    db: options.db,
    env: options.env,
    config,
    operators,
    wallet,
    signer,
    journalDir: options.journalDir ?? options.env.journalDir,
    objectStore:
      options.objectStore ??
      (options.objectStoreDir === undefined
        ? createObjectStore(options.env)
        : new LocalObjectStore(options.objectStoreDir)),
    allowSingleOperator: options.allowSingleOperator ?? false,
    planPinnedBlockNumber:
      options.planPinnedBlockNumber === undefined ? null : BigInt(options.planPinnedBlockNumber),
    enqueueVerify: options.enqueueVerify ?? defaultEnqueueVerify(options.env),
    compressionGateways: options.compressionGateways ?? options.env.compressionGateways ?? [],
  };
}

type DeploymentRow = typeof deployments.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type ContainerRow = typeof containers.$inferSelect;

interface LoadedArtifact {
  readonly deployment: DeploymentRow;
  readonly project: ProjectRow;
  readonly container: ContainerRow;
  readonly prepared: PreparedRelease;
  readonly files: readonly PlanFileBytes[];
  readonly cleanup: () => Promise<void>;
}

async function deploymentRow(db: Database, deploymentId: string): Promise<DeploymentRow> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, deploymentId)).limit(1);
  if (row === undefined) {
    throw new TapeCiError("INTERNAL", `deployment ${deploymentId} does not exist`);
  }
  return row;
}

async function projectRow(db: Database, projectId: string): Promise<ProjectRow> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (row === undefined) {
    throw new TapeCiError("INTERNAL", `project ${projectId} does not exist`);
  }
  return row;
}

async function containerRow(db: Database, containerId: string): Promise<ContainerRow> {
  const [row] = await db.select().from(containers).where(eq(containers.id, containerId)).limit(1);
  if (row === undefined) {
    throw new TapeCiError("INTERNAL", `container ${containerId} does not exist`);
  }
  return row;
}

/**
 * Load the stored artifact tar, safely re-extract it, and prepare the
 * deterministic versioned release. The entry row uses the rewritten HTML bytes.
 */
/**
 * Which journal this run must continue (SPEC §12.2, P7-16).
 *
 * A reapproved deployment continues the ORIGINAL attempt's journal, because that journal
 * holds the sent-but-unmined intents and nonces a fresh file cannot know about. Using the
 * continuation's own id would open an empty journal, write a fresh plan event, and lose
 * exactly the reconciliation the recovery context was preserved for.
 */
function journalPathFor(runtime: WorkerRuntime, deployment: DeploymentRow): string {
  const carried = recoveryJournalId(deployment.recoveryContext);
  const id = carried ?? deployment.id;
  return join(runtime.journalDir, `${id}.jsonl`);
}

export async function loadDeploymentArtifact(
  runtime: WorkerRuntime,
  deploymentId: string,
): Promise<LoadedArtifact> {
  const deployment = await deploymentRow(runtime.db, deploymentId);
  const project = await projectRow(runtime.db, deployment.projectId);
  const container = await containerRow(runtime.db, deployment.containerId);
  const [installation] = await runtime.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, project.githubInstallationId))
    .limit(1);
  if (installation === undefined || installation.deletedAt !== null) {
    throw new TapeCiError("AUTH_REVOKED", "the GitHub App installation was deleted");
  }
  if (installation.suspendedAt !== null) {
    throw new TapeCiError("AUTH_REVOKED", "the GitHub App installation is suspended");
  }
  let storageKey = deployment.artifactStorageKey;
  if (storageKey === null) {
    const [upload] = await runtime.db
      .select()
      .from(artifactUploads)
      .where(eq(artifactUploads.deploymentId, deployment.id))
      .orderBy(desc(artifactUploads.createdAt))
      .limit(1);
    storageKey = upload?.objectKey ?? null;
  }
  // A frozen snapshot is self-contained: if the row still carries its pin, the raw artifact key
  // is a convenience, not a requirement. Requiring it first made a pin-only row (manual repair,
  // or a legacy record whose upload rows were cleaned up) unloadable even though the archive it
  // names is complete (Stage C review F3).
  const pinned = deployment.prepared_artifact_key !== null;
  if (storageKey === null && !pinned) {
    throw new TapeCiError("INVALID_ARTIFACT", "deployment has no stored artifact to plan");
  }
  const sourceHash = storageKey === null ? null : /^sha256\/([0-9a-f]{64})\.tar$/.exec(storageKey)?.[1];
  if (storageKey !== null && !sourceHash) throw new TapeCiError("INVALID_ARTIFACT", "invalid source artifact key");
  const baseContext = {
    projectId: project.id, repositoryId: project.githubRepositoryId, commitSha: deployment.commitSha,
    chainId: 196 as const, siteRegistry: container.registryAddress.toLowerCase() as Hex,
    container: container.containerAddress.toLowerCase() as Hex,
  };
  const sourceArtifactSha256 =
    deployment.artifactSha256 !== null
      ? (deployment.artifactSha256.toLowerCase() as Hex)
      : sourceHash === null || sourceHash === undefined
        ? null
        : (`0x${sourceHash}` as Hex);
  const context: PreparedArtifactExpectedContext = {
    ...baseContext,
    sourceArtifactKey: storageKey,
    sourceArtifactSha256,
  };
  const request = parsePreparationRequest(deployment.preparation_request);
  const gateway = requireCompressionGateway(request, context, runtime.compressionGateways);
  if (gateway !== null && gateway.serviceFeeWei !== "0") throw new TapeCiError("INVALID_CONFIG", "nonzero gateway service fees require a separate approval flow");
  const expected = { context, request, gateway, manifestSha256: deployment.manifestSha256 as Hex | null };
  if (deployment.prepared_artifact_key !== null) {
    const frozen = await loadPreparedArtifact(runtime.objectStore, deployment.prepared_artifact_key, expected);
    return { deployment, project, container, ...frozen, cleanup: async () => undefined };
  }
  // A compressed release may only be built from source during PLANNING, where its job is to
  // produce the frozen snapshot. Every later phase must load that snapshot; rebuilding there
  // would publish bytes nobody approved.
  //
  // This used to test `manifestSha256 !== null` as a proxy for "past planning". That proxy
  // misses a record whose manifest is also NULL (a legacy or corrupt row in APPROVED), which
  // then fell through to a source rebuild. Phase is the invariant that actually holds: the
  // planning entry point is `planDeployment`, which returns unless the state is BUILT or
  // VALIDATING.
  const planningPhase = deployment.state === "BUILT" || deployment.state === "VALIDATING";
  if (request.mode !== "original" && !planningPhase) {
    throw new TapeCiError("PLAN_STALE", "a compressed release outside planning requires an immutable prepared pin");
  }
  if (storageKey === null || sourceArtifactSha256 === null) {
    throw new TapeCiError("INVALID_ARTIFACT", "deployment has no stored artifact to plan");
  }
  const strictContext: PreparedArtifactContext = { ...baseContext, sourceArtifactKey: storageKey, sourceArtifactSha256 };
  const bytes = await runtime.objectStore.get(storageKey);
  const workspace = await mkdtemp(join(tmpdir(), "tapeci-worker-"));
  try {
    const extractDir = join(workspace, "artifact");
    await mkdir(extractDir, { recursive: true });
    const ingest = await ingestArtifactTar({ bytes, destinationDir: extractDir,
      objectStore: new LocalObjectStore(join(workspace, "objects")),
      limits: { maxTotalBytes: runtime.env.artifactMaxBytes }, strictOnChain: project.strictDewebMode });
    if (ingest.sha256 !== sourceArtifactSha256) throw new TapeCiError("PLAN_STALE", "source artifact digest changed");
    const result = prepareDeploymentRelease({ context: strictContext, request, files: ingest.files, pathMode: project.pathMode, strictOnChain: project.strictDewebMode });
    if (deployment.manifestSha256 !== null && deployment.manifestSha256.toLowerCase() !== result.prepared.releaseManifestHash) throw new TapeCiError("PLAN_STALE", "source does not reproduce the stored manifest hash");
    const pin = await freezePreparedArtifact(runtime.objectStore, { context: strictContext, request, gateway, ...result });
    const [bound] = await runtime.db.update(deployments).set({ prepared_artifact_key: pin.key, artifactStorageKey: storageKey, artifactSha256: sourceArtifactSha256 })
      .where(and(eq(deployments.id, deployment.id), isNull(deployments.prepared_artifact_key), eq(deployments.stateVersion, deployment.stateVersion))).returning();
    const current = bound ?? await deploymentRow(runtime.db, deployment.id);
    if (current.prepared_artifact_key !== pin.key) throw new TapeCiError("PLAN_STALE", "prepared artifact changed concurrently");
    const frozen = await loadPreparedArtifact(runtime.objectStore, pin.key, expected);
    return { deployment: current, project, container, ...frozen, cleanup: async () => undefined };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function transition(
  runtime: WorkerRuntime,
  deploymentId: string,
  toState: Parameters<typeof transitionDeployment>[1]["toState"],
  eventType: string,
  payload: Readonly<Record<string, unknown>> = {},
  error?: { code: string; message: string },
): Promise<DeploymentRow> {
  const current = await deploymentRow(runtime.db, deploymentId);
  if (current.state === toState) return current;
  await transitionDeployment(runtime.db, {
    deploymentId,
    expectedVersion: current.stateVersion,
    toState,
    eventType,
    actorKind: "worker",
    actorId: "tapeci-worker",
    payload,
    ...(error === undefined ? {} : { errorCode: error.code, errorMessage: error.message }),
  });
  return deploymentRow(runtime.db, deploymentId);
}

async function persistPlan(
  runtime: WorkerRuntime,
  deployment: DeploymentRow,
  prepared: PreparedRelease,
  plan: ReleasePlan,
): Promise<void> {
  await runtime.db.transaction(async (tx) => {
    await tx.delete(releaseFiles).where(eq(releaseFiles.deploymentId, deployment.id));
    if (prepared.manifest.files.length > 0) {
      await tx.insert(releaseFiles).values(
        prepared.manifest.files.map((row) => ({
          deploymentId: deployment.id,
          targetPath: row.path,
          sourceRelativePath: row.sourcePath,
          sha256: row.sha256,
          byteSize: row.size,
          chunkCount: row.chunks,
          contentType: row.contentType,
          state: "PENDING" as const,
        })),
      );
    }
    await tx
      .update(deployments)
      .set({
        manifestSha256: prepared.releaseManifestHash,
        planJson: planToJson(plan),
        estimatedCostWei: plan.fees.estimatedCostWei.toString(),
        startedAt: deployment.startedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, deployment.id));
  });
}

/** Plan handler: BUILT -> VALIDATING -> PLAN_READY (or PLAN_REJECTED). */
export async function planDeployment(runtime: WorkerRuntime, deploymentId: string): Promise<void> {
  const deployment = await deploymentRow(runtime.db, deploymentId);
  if (deployment.state !== "BUILT" && deployment.state !== "VALIDATING") return;
  const loaded = await loadDeploymentArtifact(runtime, deploymentId);
  try {
    const plan = await planRelease({
      manifest: loaded.prepared.manifest,
      files: loaded.files,
      operators: runtime.operators,
      ...(runtime.signer === null ? {} : { signer: runtime.signer }),
      ...(runtime.planPinnedBlockNumber === null
        ? {}
        : { pinnedBlockNumber: runtime.planPinnedBlockNumber }),
    });
    const maxGasPriceWei = runtime.env.maxGasPriceWei ?? null;
    if (maxGasPriceWei !== null && plan.fees.gasPriceWei > maxGasPriceWei) {
      await persistPlan(runtime, loaded.deployment, loaded.prepared, plan);
      await transition(
        runtime,
        deploymentId,
        "PLAN_REJECTED",
        "plan_rejected_gas_price",
        {
          gasPriceWei: plan.fees.gasPriceWei.toString(),
          maxGasPriceWei: maxGasPriceWei.toString(),
        },
        { code: "FEE_OVER_BUDGET", message: "gas price exceeds TAPECI_MAX_GAS_PRICE_WEI" },
      );
      return;
    }
    await persistPlan(runtime, loaded.deployment, loaded.prepared, plan);
    if (plan.blocked) {
      await transition(
        runtime,
        deploymentId,
        "PLAN_REJECTED",
        "plan_rejected",
        { blockedReasons: plan.blockedReasons },
        { code: "PLAN_REJECTED", message: plan.blockedReasons.join(",") },
      );
      return;
    }
    if (loaded.deployment.state === "BUILT") {
      await transition(runtime, deploymentId, "VALIDATING", "artifact_validation_started", {
        pinnedBlock: plan.pinnedBlockNumber.toString(),
      });
    }
    await transition(runtime, deploymentId, "PLAN_READY", "plan_ready", {
      releaseId: plan.releaseId,
      releaseManifestHash: plan.releaseManifestHash,
      estimatedCostWei: plan.fees.estimatedCostWei.toString(),
      pinnedBlock: plan.pinnedBlockNumber.toString(),
    });
  } finally {
    await loaded.cleanup();
  }
}

async function activeApproval(
  runtime: WorkerRuntime,
  deployment: DeploymentRow,
): Promise<typeof approvals.$inferSelect> {
  const [approval] = await runtime.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.deploymentId, deployment.id),
        isNull(approvals.revokedAt),
        gt(approvals.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  if (approval === undefined) {
    throw new TapeCiError("APPROVAL_REQUIRED", "no active EIP-712 approval for this deployment");
  }
  return approval;
}

async function persistJournalTransactions(
  runtime: WorkerRuntime,
  deployment: DeploymentRow,
): Promise<void> {
  const journalPath = journalPathFor(runtime, deployment);
  const state = await readJournalState(journalPath);
  const rows = await runtime.db
    .select({ id: releaseFiles.id, targetPath: releaseFiles.targetPath })
    .from(releaseFiles)
    .where(eq(releaseFiles.deploymentId, deployment.id));
  const fileIdByPath = new Map(rows.map((row) => [row.targetPath, row.id]));
  const signer = runtime.signer;
  const walletAddress = runtime.wallet?.account?.address;
  const signerAddress = signer ?? walletAddress;
  if (signerAddress === undefined) return;
  const registry = runtime.config.registries[0];
  if (registry === undefined) return;
  for (const record of state.transactions.values()) {
    const intent = record.intent;
    const mined = record.mined;
    const sent = record.sent;
    await runtime.db
      .insert(chainTransactions)
      .values({
        deploymentId: deployment.id,
        releaseFileId: fileIdByPath.get(intent.path) ?? null,
        chainId: 196,
        signerAddress,
        toAddress: deployment.registryAddress,
        operation: intent.operation,
        operationFingerprint: intent.fingerprint,
        nonce: intent.nonce,
        gasLimit: null,
        gasUsed: mined?.gasUsed ?? null,
        effectiveGasPriceWei: null,
        txHash: sent?.txHash ?? null,
        state: mined !== undefined ? "INCLUDED" : record.failed !== undefined ? "FAILED" : "BROADCAST",
        receiptBlockNumber: mined?.blockNumber ?? null,
        receiptBlockHash: mined?.blockHash ?? null,
        errorCode: record.failed?.errorCode ?? null,
      })
      .onConflictDoUpdate({
        target: [
          chainTransactions.deploymentId,
          chainTransactions.operationFingerprint,
          chainTransactions.nonce,
        ],
        set: {
          gasUsed: mined?.gasUsed ?? null,
          txHash: sent?.txHash ?? null,
          state: mined !== undefined ? "INCLUDED" : record.failed !== undefined ? "FAILED" : "BROADCAST",
          receiptBlockNumber: mined?.blockNumber ?? null,
          receiptBlockHash: mined?.blockHash ?? null,
          errorCode: record.failed?.errorCode ?? null,
          updatedAt: new Date(),
        },
      });
  }
}

/**
 * Rollback handler: restore a stored release by switching the entry back to its
 * deterministic manifest. No artifact upload is needed; assets are verified on
 * chain by switchEntryToRelease before the entry write.
 */
async function deployRollback(runtime: WorkerRuntime, deployment: DeploymentRow): Promise<void> {
  if (["VERIFYING_RELEASE", "LIVE"].includes(deployment.state)) return;
  if (runtime.wallet === null) {
    throw new TapeCiError("INVALID_CONFIG", "worker has no operator wallet/private key configured");
  }
  if (deployment.rollbackTargetReleaseId === null) {
    throw new TapeCiError("INTERNAL", "rollback deployment has no target release");
  }
  const [targetRelease] = await runtime.db
    .select()
    .from(releases)
    .where(eq(releases.id, deployment.rollbackTargetReleaseId))
    .limit(1);
  if (targetRelease === undefined) {
    throw new TapeCiError("INTERNAL", "rollback target release no longer exists");
  }
  const loaded = await loadDeploymentArtifact(runtime, deployment.id);
  try {
    if (
      loaded.prepared.releaseManifestHash.toLowerCase() !== targetRelease.manifestSha256.toLowerCase()
    ) {
      throw new TapeCiError(
        "PLAN_STALE",
        "rollback artifact does not reproduce the target release manifest",
      );
    }
    const approval = await activeApproval(runtime, deployment);
    await assertOperatorAuthorized(runtime.db, {
      containerId: deployment.containerId,
      signerAddress: approval.signerAddress,
    });
    let current = deployment;
    if (current.state === "APPROVED") {
      current = await transition(runtime, deployment.id, "UPLOADING_ASSETS", "rollback_started", {
        rollbackTargetReleaseId: targetRelease.releaseId,
      });
    }
    if (current.state === "UPLOADING_ASSETS") {
      current = await transition(runtime, deployment.id, "VERIFYING_ASSETS", "rollback_assets_verified", {
        rollbackTargetReleaseId: targetRelease.releaseId,
      });
    }
    if (current.state === "VERIFYING_ASSETS") {
      current = await transition(runtime, deployment.id, "SWITCHING_ENTRY", "rollback_switch_started", {
        rollbackTargetReleaseId: targetRelease.releaseId,
      });
    }
    if (current.state === "SWITCHING_ENTRY") {
      const client = runtime.operators[0]?.client as unknown as ReadClient;
      if (client === undefined) throw new TapeCiError("INTERNAL", "no RPC operator client");
      const heads = await Promise.all(
        runtime.operators.map((operator) => operator.client.getBlockNumber()),
      );
      const pinnedBlock =
        runtime.operators.length >= 2
          ? BigInt(
              selectPinnedBlock(
                heads.map((head) => Number(head)),
                runtime.config.pin.offset,
                runtime.config.pin.maxLagBlocks,
              ).pinnedBlockNumber,
            )
          : (heads[0] ?? 0n) - BigInt(runtime.config.pin.offset);
      const switched = await switchEntryToRelease({
        manifest: loaded.prepared.manifest,
        entryBytes: loaded.prepared.entryBytes,
        client,
        wallet: runtime.wallet,
        config: runtime.config,
        operators: runtime.operators,
        pinnedBlock,
        ...(runtime.allowSingleOperator ? { allowSingleOperator: true } : {}),
      });
      await runtime.db.transaction(async (tx) => {
        await tx.delete(releaseFiles).where(eq(releaseFiles.deploymentId, deployment.id));
        if (loaded.prepared.manifest.files.length > 0) {
          await tx.insert(releaseFiles).values(
            loaded.prepared.manifest.files.map((row) => ({
              deploymentId: deployment.id,
              targetPath: row.path,
              sourceRelativePath: row.sourcePath,
              sha256: row.sha256,
              byteSize: row.size,
              chunkCount: row.chunks,
              contentType: row.contentType,
              state: "VERIFIED" as const,
              lastConfirmedChunkIndex: row.chunks - 1,
              verifiedAt: new Date(),
            })),
          );
        }
      });
      // The rollback writes the entry in one transaction; persist that real
      // transaction so a LIVE rollback has the same evidence as a normal deploy.
      for (const txHash of switched.transactionHashes) {
        const receipt = await client.getTransactionReceipt({ hash: txHash });
        const transaction = await client.getTransaction({ hash: txHash });
        await runtime.db
          .insert(chainTransactions)
          .values({
            deploymentId: deployment.id,
            releaseFileId: null,
            chainId: 196,
            signerAddress: runtime.signer as Hex,
            toAddress: deployment.registryAddress,
            operation: "putFile",
            operationFingerprint: keccak256(txHash),
            nonce: String(transaction.nonce),
            gasLimit: transaction.gas?.toString() ?? null,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
            txHash,
            receiptBlockNumber: receipt.blockNumber.toString(),
            receiptBlockHash: receipt.blockHash,
            state: "INCLUDED",
          })
          .onConflictDoNothing();
      }
      await transition(runtime, deployment.id, "VERIFYING_RELEASE", "rollback_entry_switched", {
        rollbackTargetReleaseId: targetRelease.releaseId,
      });
    }
    await runtime.enqueueVerify(deployment.id);
  } finally {
    await loaded.cleanup();
  }
}

/** Deploy handler: APPROVED -> chain writes -> switch entry -> VERIFYING_RELEASE. */
export async function deployDeployment(runtime: WorkerRuntime, deploymentId: string): Promise<void> {
  let deployment = await deploymentRow(runtime.db, deploymentId);
  if (deployment.triggerKind === "rollback") {
    await deployRollback(runtime, deployment);
    return;
  }
  if (["VERIFYING_RELEASE", "LIVE"].includes(deployment.state)) return;
  if (
    deployment.state !== "APPROVED" &&
    deployment.state !== "UPLOADING_ASSETS" &&
    deployment.state !== "SWITCHING_ENTRY" &&
    // A broadcast-but-unconfirmed transaction is recoverable from the journal;
    // executeRelease reconciles tx_sent against the chain on resume.
    deployment.state !== "UPLOAD_INTERRUPTED"
  ) {
    return;
  }
  if (runtime.wallet === null || runtime.signer === null) {
    throw new TapeCiError("INVALID_CONFIG", "worker has no operator wallet/private key configured");
  }
  const loaded = await loadDeploymentArtifact(runtime, deploymentId);
  try {
    const approval = await activeApproval(runtime, deployment);
    await assertOperatorAuthorized(runtime.db, {
      containerId: deployment.containerId,
      signerAddress: approval.signerAddress,
    });
    const costCapWei =
      deployment.approvedCostCapWei === null ? null : BigInt(deployment.approvedCostCapWei);
    // Resume must use the approved plan: re-planning against half-written files
    // reports UPLOAD_CONFLICT and can never recover.
    //
    // SPEC §12.2: an explicit recovery context outranks the state check. A reapproved
    // deployment sits in APPROVED, not UPLOAD_INTERRUPTED, so keying on the state alone
    // would re-plan exactly the resources that are already partly written.
    const recoveryPlan = recoveryPlanJson(deployment.recoveryContext);
    const plan =
      recoveryPlan !== null
        ? planFromJson(recoveryPlan)
        : deployment.state === "UPLOAD_INTERRUPTED" && deployment.planJson !== null
        ? planFromJson(deployment.planJson)
        : await planRelease({
            manifest: loaded.prepared.manifest,
            files: loaded.files,
            operators: runtime.operators,
            signer: runtime.signer,
            ...(costCapWei === null ? {} : { costCapWei }),
            ...(runtime.planPinnedBlockNumber === null
              ? {}
              : { pinnedBlockNumber: runtime.planPinnedBlockNumber }),
          });
    const maxGasPriceWei = runtime.env.maxGasPriceWei ?? null;
    if (maxGasPriceWei !== null && plan.fees.gasPriceWei > maxGasPriceWei) {
      throw new TapeCiError("FEE_OVER_BUDGET", "gas price exceeds TAPECI_MAX_GAS_PRICE_WEI", {
        details: {
          gasPriceWei: plan.fees.gasPriceWei.toString(),
          maxGasPriceWei: maxGasPriceWei.toString(),
        },
      });
    }
    // The signer may be an operator authorized with `setOperator` rather than the
    // holder, so `signerIsHolder === false` alone is not an ownership change.
    // Fail closed only when the chain owner differs from what the approval saw.
    if (plan.containerOwner !== null) {
      const [containerRow] = await runtime.db
        .select({ owner: containers.lastObservedOwner })
        .from(containers)
        .where(eq(containers.id, deployment.containerId))
        .limit(1);
      const recordedOwner = containerRow?.owner?.toLowerCase();
      if (recordedOwner !== undefined && recordedOwner !== plan.containerOwner.toLowerCase()) {
        throw new TapeCiError(
          "NOT_CURRENT_OWNER",
          "the container owner changed after the plan was approved",
          { details: { recordedOwner, planOwner: plan.containerOwner } },
        );
      }
    }
    if (plan.blocked) {
      throw new TapeCiError(
        plan.blockedReasons.includes("FEE_OVER_BUDGET") ? "FEE_OVER_BUDGET" : "UPLOAD_CONFLICT",
        `deploy plan is blocked: ${plan.blockedReasons.join(",")}`,
      );
    }
    if (costCapWei !== null && plan.fees.estimatedCostWei > costCapWei) {
      throw new TapeCiError("FEE_OVER_BUDGET", "estimated cost exceeds the approved cap", {
        details: {
          estimatedCostWei: plan.fees.estimatedCostWei.toString(),
          approvedCostCapWei: costCapWei.toString(),
        },
      });
    }

    if (deployment.state === "UPLOAD_INTERRUPTED") {
      deployment = await transition(runtime, deploymentId, "UPLOADING_ASSETS", "upload_resumed", {});
    }
    if (deployment.state === "APPROVED") {
      deployment = await transition(runtime, deploymentId, "UPLOADING_ASSETS", "chain_write_started", {
        releaseId: plan.releaseId,
        transactionCount: plan.totals.writes,
      });
    }
    if (deployment.state === "UPLOADING_ASSETS") {
      const client = runtime.operators[0]?.client as unknown as ReadClient;
      if (client === undefined) {
        throw new TapeCiError("INTERNAL", "no RPC operator client for chain writes");
      }
      await executeRelease({
        plan,
        manifest: loaded.prepared.manifest,
        files: loaded.files,
        client,
        wallet: runtime.wallet,
        config: runtime.config,
        journalPath: journalPathFor(runtime, deployment),
        signer: runtime.signer,
        operators: runtime.operators,
      });
      await persistJournalTransactions(runtime, deployment);
      await runtime.db
        .update(releaseFiles)
        .set({ state: "VERIFIED", verifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(releaseFiles.deploymentId, deploymentId));
      const fileRows = await runtime.db
        .select({ id: releaseFiles.id, chunkCount: releaseFiles.chunkCount })
        .from(releaseFiles)
        .where(eq(releaseFiles.deploymentId, deploymentId));
      for (const file of fileRows) {
        await runtime.db
          .update(releaseFiles)
          .set({ lastConfirmedChunkIndex: file.chunkCount - 1, updatedAt: new Date() })
          .where(eq(releaseFiles.id, file.id));
      }
      deployment = await transition(runtime, deploymentId, "VERIFYING_ASSETS", "assets_verified", {});
    }
    if (deployment.state === "VERIFYING_ASSETS") {
      deployment = await transition(runtime, deploymentId, "SWITCHING_ENTRY", "entry_switch_started", {});
    }
    if (deployment.state === "SWITCHING_ENTRY") {
      // executeRelease writes assets first and the entry last, so the entry switch
      // is the final write of the journaled execution. No second setEntry write.
      await transition(runtime, deploymentId, "VERIFYING_RELEASE", "entry_switched", {
        releaseId: loaded.prepared.releaseId,
        entryPath: loaded.prepared.manifest.entryPath,
      });
    }
    await runtime.enqueueVerify(deploymentId);
  } finally {
    await loaded.cleanup();
  }
}

/**
 * Verify handler: VERIFYING_RELEASE -> LIVE only when chain bytes + journal match.
 *
 * A mismatch can be a transient RPC read (fork/load-balanced endpoints). The BullMQ
 * attempt budget is used for bounded retries; only the final attempt moves the
 * deployment to VERIFY_FAILED. A genuine mismatch therefore still fails closed.
 */
export async function verifyDeployment(
  runtime: WorkerRuntime,
  deploymentId: string,
  retry?: { readonly attempt: number; readonly attempts: number },
): Promise<void> {
  const deployment = await deploymentRow(runtime.db, deploymentId);
  if (deployment.state !== "VERIFYING_RELEASE") return;
  const loaded = await loadDeploymentArtifact(runtime, deploymentId);
  try {
    const journalPath = journalPathFor(runtime, deployment);
    const isRollback = deployment.triggerKind === "rollback";
    const journalState = isRollback ? null : await readJournalState(journalPath);
    const manifest: ReleaseManifest & {
      artifactDigest: Hex;
      releaseManifestHash: Hex;
    } = {
      ...loaded.prepared.manifest,
      artifactDigest: loaded.prepared.artifactDigest,
      releaseManifestHash: loaded.prepared.releaseManifestHash,
    };
    const heads = await Promise.all(runtime.operators.map((operator) => operator.client.getBlockNumber()));
    const selectedPin =
      runtime.operators.length >= 2
        ? BigInt(
            selectPinnedBlock(
              heads.map((head) => Number(head)),
              runtime.config.pin.offset,
              runtime.config.pin.maxLagBlocks,
            ).pinnedBlockNumber,
          )
        : (heads[0] ?? 0n) - BigInt(runtime.config.pin.offset);
    // The verification pin must cover every mined write; otherwise a release that
    // finished at the tip looks like "mined after the pin" and fails falsely.
    const journalMaxMined = journalState === null
      ? 0n
      : [...journalState.transactions.values()].reduce((max, record) => {
          if (record.mined === undefined) return max;
          const block = BigInt(record.mined.blockNumber);
          return block > max ? block : max;
        }, 0n);
    const verifyPin = selectedPin > journalMaxMined ? selectedPin : journalMaxMined;
    // Every operator must have imported the pin before the pinned reads; otherwise
    // a lagging RPC answers from a state before the last write.
    await waitForBlockOnAll(
      runtime.operators.map((operator) => ({ client: operator.client as unknown as ReadClient, label: operator.url })),
      verifyPin,
      { timeoutMs: 120_000 },
    );
    const report = await verifyRelease({
      manifest,
      ...(journalState === null ? {} : { journal: journalEvidenceFromState(journalState) }),
      operators: runtime.operators,
      config: runtime.config,
      pinnedBlock: verifyPin,
      ...(runtime.allowSingleOperator ? { allowSingleOperator: true } : {}),
    });
    if (!report.releaseMatch) {
      const finalAttempt = retry === undefined || retry.attempt >= retry.attempts;
      if (!finalAttempt) {
        throw new TapeCiError(
          "VERIFICATION_FAILED",
          report.detail ?? "release verification did not match (will retry)",
          { retryable: true, details: { attempt: retry.attempt, attempts: retry.attempts } },
        );
      }
      await transition(
        runtime,
        deploymentId,
        "VERIFY_FAILED",
        "release_verification_failed",
        { report: releaseReportToJson(report) },
        { code: "VERIFICATION_FAILED", message: report.detail ?? "release verification did not match" },
      );
      return;
    }
    const entry = loaded.prepared.manifest.files.find(
      (file) => file.path === loaded.prepared.manifest.entryPath,
    );
    if (entry === undefined) {
      throw new TapeCiError("INVALID_ARTIFACT", "release manifest has no entry file");
    }
    const reportJson = releaseReportToJson(report);
    const rollbackTargetReleaseId = deployment.rollbackTargetReleaseId;
    if (isRollback && rollbackTargetReleaseId !== null) {
      await runtime.db.transaction(async (tx) => {
        await tx
          .update(releases)
          .set({ isCurrent: false })
          .where(and(eq(releases.projectId, deployment.projectId), eq(releases.isCurrent, true)));
        await tx
          .update(releases)
          .set({
            verifyReport: reportJson,
            verifiedBlockNumber: String(report.pinnedBlockNumber ?? 0),
            isCurrent: true,
            activatedAt: new Date(),
          })
          .where(eq(releases.id, rollbackTargetReleaseId));
      });
    } else {
      await runtime.db.transaction(async (tx) => {
        await tx
          .update(releases)
          .set({ isCurrent: false })
          .where(and(eq(releases.projectId, deployment.projectId), eq(releases.isCurrent, true)));
        await tx
          .insert(releases)
          .values({
            projectId: deployment.projectId,
            deploymentId: deployment.id,
            releaseId: loaded.prepared.releaseId,
            commitSha: deployment.commitSha,
            manifestSha256: loaded.prepared.releaseManifestHash,
            entrySha256: entry.sha256,
            entryPath: entry.path,
            verifyReport: reportJson,
            verifiedBlockNumber: String(report.pinnedBlockNumber ?? 0),
            isCurrent: true,
          })
          .onConflictDoUpdate({
            target: releases.deploymentId,
            set: {
              verifyReport: reportJson,
              verifiedBlockNumber: String(report.pinnedBlockNumber ?? 0),
              isCurrent: true,
              activatedAt: new Date(),
            },
          });
      });
    }
    await transition(runtime, deploymentId, "LIVE", "release_live", {
      releaseId: loaded.prepared.releaseId,
      pinnedBlock: report.pinnedBlockNumber,
    });
  } finally {
    await loaded.cleanup();
  }
}

const TERMINAL_NOTIFICATION_STATES = new Set([
  "LIVE",
  "BUILD_FAILED",
  "PLAN_REJECTED",
  "APPROVAL_EXPIRED",
  "AUTH_REVOKED",
  "OWNERSHIP_CHANGED",
  "INSUFFICIENT_BALANCE",
  "FEE_OVER_BUDGET",
  "RPC_DISAGREEMENT",
  "IMPLEMENTATION_CHANGED",
  "UPLOAD_CONFLICT",
  "UPLOAD_INTERRUPTED",
  "VERIFY_FAILED",
  "SWITCH_FAILED",
  "ROLLBACK_REQUIRED",
  "CANCELED",
]);

async function notifyLifecycle(runtime: WorkerRuntime, deploymentId: string): Promise<void> {
  const [row] = await runtime.db
    .select({
      state: deployments.state,
      projectId: deployments.projectId,
      repoFullName: projects.repoFullName,
    })
    .from(deployments)
    .innerJoin(projects, eq(projects.id, deployments.projectId))
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (row === undefined || !TERMINAL_NOTIFICATION_STATES.has(row.state)) return;
  await notifyProject(
    runtime.db,
    runtime.env,
    row.projectId,
    `TapeCI ${row.repoFullName}: ${row.state}`,
    `Deployment ${deploymentId} for ${row.repoFullName} is now ${row.state}.`,
  );
}

function withLifecycle(runtime: WorkerRuntime, handler: (context: { readonly deploymentId: string; readonly attempt: number; readonly attempts: number }) => Promise<void>) {
  return async (context: { readonly deploymentId: string; readonly attempt: number; readonly attempts: number }): Promise<void> => {
    try {
      await handler(context);
    } finally {
      await notifyLifecycle(runtime, context.deploymentId).catch(() => undefined);
    }
  };
}

export function createWorkerHandlers(runtime: WorkerRuntime): Required<WorkerHandlerMap> {
  return {
    plan: withLifecycle(runtime, async (context) => {
      await planDeployment(runtime, context.deploymentId);
    }),
    deploy: withLifecycle(runtime, async (context) => {
      await deployDeployment(runtime, context.deploymentId);
    }),
    verify: withLifecycle(runtime, async (context) => {
      await verifyDeployment(runtime, context.deploymentId, {
        attempt: context.attempt,
        attempts: context.attempts,
      });
    }),
  };
}
