/**
 * P7-07 — SPEC §12.2 integration test:
 * **部分 chunk 已写 → 授权过期 → 重签 → APPROVED → 恢复** (AC-P6-14).
 *
 * The mandated journey: an attempt that wrote part of its release, whose approval
 * then lapsed, must be recoverable **without re-planning**. `requestReapproval`
 * opens a continuation attempt at `AWAITING_APPROVAL` (deviation D-P6-1: the
 * transition table is authoritative, `APPROVAL_EXPIRED` is terminal and `APPROVED`
 * has no edge back), carrying the original `plan_json`, the journal identity, the
 * chunk progress and the recovery stage in `deployments.recovery_context`
 * (migration 0018). After the continuation is signed, the worker must continue the
 * *original* plan and journal instead of planning the already-written chunks again
 * (`UPLOAD_CONFLICT`, §12.2). This file observes the plan and the carried journal
 * identity; how the worker picks a journal *path* is a separate, source-level
 * finding (P7-16 in the P7-c report), not something asserted here.
 *
 * **What is not run here:** no worker process, no BullMQ job, no chain write and no
 * EIP-712 signature. The worker's plan selection is an inline expression in
 * `apps/api/src/worker/runtime.ts:668-683` and is **not** an exported seam, so
 * clause 4 is asserted through the only observable it has — the validated context
 * (`recoveryPlanJson`) plus the state (`APPROVED`, where the old
 * `state === "UPLOAD_INTERRUPTED"` branch cannot fire) — and through the rows the
 * worker reads. `.superpowers/sdd/provisioning/dev-p7c.md` records exactly which
 * clause is unobservable in-process and what was asserted instead.
 *
 * The chain is faked for the one read the reapproval pre-check performs
 * (`assertImplementationsAllowlisted` → EIP-1967 slot + proxy code); the clock is
 * pinned; the journal is written by the real `DeploymentJournal`. Every service
 * under test (`requestReapproval`, `requestResume`, `loadRecoveryCapability`,
 * `readRecoveryContext`, `recoveryPlanJson`, `transitionDeployment`) is the real
 * implementation against migration 0018 on a throwaway PostgreSQL database.
 *
 * Run from the repo root (test-p0 §1.4 — the package-dir form is broken):
 *   DATABASE_URL=postgres://tapeci:tapeci@127.0.0.1:55432/tapeci \
 *     node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs exec vitest run \
 *     tests/p2/provisioning/reapproval-resume.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import {
  approvals,
  containers,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  deploymentEvents,
  deployments,
  githubInstallations,
  migrateUp,
  operatorSessions,
  projectMembers,
  projects,
  releaseFiles,
  users,
  type Database,
} from "@tapeci/database";
import type { ReadClient } from "@tapeci/chain";
import { XLAYER_MAINNET } from "@tapeci/config";
import {
  DeploymentJournal,
  planFingerprint,
  planFromJson,
  planToJson,
  readJournalState,
  type ReleasePlan,
} from "@tapeci/deployer";
import { createOperatorSession, transitionDeployment } from "@tapeci/queue";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";
import { ApiError } from "../../../apps/api/src/errors.js";
import {
  loadRecoveryCapability,
  readRecoveryContext,
  recoveryPlanJson,
  requestReapproval,
  requestResume,
  type ReapprovalRequested,
  type ReapprovalResult,
  type RecoveryBlocked,
  type ResumeResult,
} from "../../../apps/api/src/recovery.js";
import { OWNER, fixedClock } from "./helpers.js";

const available = await databaseAvailable();
const unavailableLabel =
  "P7-07 §12.2 reapproval/resume [SKIPPED: PostgreSQL is unreachable; the suite needs " +
  "the shared PG service on 127.0.0.1:55432 (TAPECI_TEST_DATABASE_URL)]";

/** The pinned clock every capability decision is evaluated at. */
const NOW = new Date("2026-10-27T08:00:00.000Z");
/** The approval lapsed an hour before the recovery request (§授权过期). */
const EXPIRED_AT = new Date(NOW.getTime() - 60 * 60 * 1_000);
/** The signature the continuation is later approved with. */
const LIVE_UNTIL = new Date(NOW.getTime() + 60 * 60 * 1_000);

/** Read a config value, failing loudly instead of defaulting to a guessed address. */
function requireConfigValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`config: ${label} is missing`);
  return value;
}

const SITE_REGISTRY = requireConfigValue(
  XLAYER_MAINNET.registries[0],
  "XLAYER_MAINNET.registries[0]",
);

/** One manifest for the whole file: only one attempt per plan is half-written. */
const MANIFEST_HASH = `0x${"ab".repeat(32)}` as Hex;
/** `plan.files[].sha256` / `release_files.sha256` for the entry file. */
const SHA_INDEX = `0x${"a1".repeat(32)}` as Hex;
/** The second file: half the plan, zero chunks written. */
const SHA_APP_JS = `0x${"a2".repeat(32)}` as Hex;
const APPROVAL_COST_CAP_WEI = "1000000000000000";

/** The implementation each proxy answers with: the allowlisted one (§红线 pre-check). */
const ALLOWLISTED_IMPLEMENTATION = new Map<string, string>();
for (const entry of XLAYER_MAINNET.allowlist) {
  const implementation = entry.implementations[0];
  if (implementation !== undefined) {
    ALLOWLISTED_IMPLEMENTATION.set(entry.proxy.toLowerCase(), implementation.toLowerCase());
  }
}

/**
 * The only chain access `requestReapproval` performs: `assertImplementationsAllowlisted`
 * reads the EIP-1967 slot and the proxy bytecode. Answering with the allowlisted
 * implementation means the pre-check passes for the right reason (the real config,
 * the real assertion), not because the check was stubbed out.
 */
function allowlistedChain(): ReadClient {
  const requireProxy = (address: string): string => {
    const implementation = ALLOWLISTED_IMPLEMENTATION.get(address.toLowerCase());
    if (implementation === undefined) {
      throw new Error(`fake chain: ${address} is not a proxy in the implementation allowlist`);
    }
    return implementation;
  };
  return {
    getStorageAt: async (request: { address: string }) => {
      const implementation = requireProxy(request.address);
      return `0x${"0".repeat(24)}${implementation.slice(2)}` as Hex;
    },
    getCode: async (request: { address: string }) => {
      requireProxy(request.address);
      return "0x6080604052" as Hex;
    },
  } as unknown as ReadClient;
}

/** A bare-bones `ApiEnv`: only `journalDir` is read by the recovery module. */
function envFor(journalDir: string): ApiEnv {
  return {
    databaseUrl: "postgres://unused",
    redisUrl: "redis://127.0.0.1:56379",
    port: 0,
    host: "127.0.0.1",
    sessionSecret: "test-session-secret-123456",
    devAuth: true,
    objectStoreDir: join(journalDir, "objects"),
    artifactMaxBytes: 64 * 1024 * 1024,
    artifactTokenTtlSeconds: 900,
    githubAppId: null,
    githubAppPrivateKey: null,
    githubWebhookSecret: null,
    githubOidcAudience: "tapeci-artifact-upload",
    githubOidcIssuer: "https://token.actions.githubusercontent.com",
    githubAppSlug: null,
    githubOAuthClientId: null,
    githubOAuthClientSecret: null,
    githubOAuthBaseUrl: "https://github.com",
    githubApiBaseUrl: "https://api.github.com",
    publicApiUrl: "http://127.0.0.1:8787",
    webUrl: "http://127.0.0.1:3000",
    sessionTtlSeconds: 604_800,
    operatorPrivateKey: null,
    writeRpcUrl: null,
    journalDir,
  };
}

/** The JSON document stored in `deployments.plan_json`, plus its rehydrated form. */
interface PlanDocument {
  readonly json: unknown;
  readonly plan: ReleasePlan;
  readonly fingerprint: Hex;
}

/**
 * A plan for two files / five chunks, written as the JSON `planToJson` produces
 * (bigints as decimal strings) so `planFromJson` rehydrates it unchanged.
 */
function makePlan(input: {
  readonly container: Hex;
  readonly commitSha: string;
  readonly releaseId: string;
}): PlanDocument {
  const json = {
    schemaVersion: "tapeci.plan.v1",
    chainId: 196,
    container: input.container,
    siteRegistry: SITE_REGISTRY,
    commitSha: input.commitSha,
    releaseId: input.releaseId,
    artifactDigest: `0x${"d1".repeat(32)}`,
    releaseManifestHash: MANIFEST_HASH,
    entryPath: "index.html",
    pinnedBlockNumber: "74312700",
    pinnedBlockHash: `0x${"cd".repeat(32)}`,
    operators: ["okx", "drpc"],
    observedAt: "2026-10-26T08:00:00.000Z",
    files: [
      {
        path: "index.html",
        sourcePath: "index.html",
        action: "WRITE",
        reason: "missing on chain",
        size: 900,
        sha256: SHA_INDEX,
        chunks: 3,
        estimatedGas: "400000",
        onChain: null,
      },
      {
        path: "app.js",
        sourcePath: "assets/app.js",
        action: "WRITE",
        reason: "missing on chain",
        size: 334,
        sha256: SHA_APP_JS,
        chunks: 2,
        estimatedGas: "200000",
        onChain: null,
      },
    ],
    totals: { files: 2, writes: 2, unchanged: 0, conflicts: 0, chunks: 5, bytes: 1_234 },
    fees: {
      gasPriceWei: "1000000000",
      estimatedGas: "600000",
      estimatedCostWei: "600000000000000",
      marginBps: 2_000,
      recommendedCapWei: "720000000000000",
      costCapWei: null,
      withinBudget: true,
      overBudgetByWei: "0",
    },
    containerOwner: OWNER,
    containerOpened: true,
    signer: OWNER,
    signerIsHolder: true,
    signerBalanceWei: "1000000000000000000",
    sufficientBalance: true,
    blocked: false,
    blockedReasons: [],
    warnings: [],
  };
  const plan = planFromJson(json);
  return { json, plan, fingerprint: planFingerprint(plan) };
}

/** Every row this file seeds for one attempt, plus the journal it left behind. */
interface SeededAttempt {
  readonly deploymentId: string;
  readonly containerId: string;
  readonly projectId: string;
  readonly plan: PlanDocument;
  readonly journalPath: string;
  /** The journal bytes as the crash left them: a later append must be visible here. */
  readonly journalContent: string;
}

const describeLabel = available
  ? "P7-07 §12.2 部分 chunk 已写→授权过期→重签→APPROVED→恢复 (AC-P6-14)"
  : unavailableLabel;

describe.skipIf(!available)(describeLabel, () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let userId = "";
  let installationId = "";
  let journalDir = "";
  let sequence = 0;

  /** Every deployment id a recovery request asked the queue to deploy. */
  const enqueued: string[] = [];

  /** The journey under test: the half-written attempt, then its continuation. */
  let attempt: SeededAttempt;
  let continuationId = "";

  function deps(): ApiDeps {
    return {
      db,
      env: envFor(journalDir),
      now: fixedClock(NOW),
      readClient: () => allowlistedChain(),
      enqueueDeployment: async (deploymentId: string) => {
        enqueued.push(deploymentId);
      },
    };
  }

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await migrateUp(testDatabase.url);
    handle = createDatabase(testDatabase.url);
    db = handle.db;
    journalDir = await mkdtemp(join(tmpdir(), "tapeci-p7-07-journal-"));
    const [user] = await db
      .insert(users)
      .values({ githubUserId: 9_207, githubLogin: "p7-07-owner" })
      .returning();
    if (user === undefined) throw new Error("fixture: user insert failed");
    userId = user.id;
    const [installation] = await db
      .insert(githubInstallations)
      .values({ installationId: 9_207, githubAccountId: 4_242, accountLogin: "p7-07-org" })
      .returning();
    if (installation === undefined) throw new Error("fixture: installation insert failed");
    installationId = installation.id;
  }, 120_000);

  afterAll(async () => {
    await handle?.pool.end();
    await testDatabase?.drop();
    if (journalDir !== "") await rm(journalDir, { recursive: true, force: true });
  }, 30_000);

  // ── fixtures ───────────────────────────────────────────────────────────────

  /**
   * A deployment on its own container + project (the single-chain-writer index is
   * per container) with a stored plan, an approval that is **not** active, and a
   * live operator grant the reapproval has to revoke.
   *
   * `withProgress` writes 1 of 5 chunks as written (`index.html` chunk 0 mined in
   * the journal and recorded in `release_files`) — 部分 chunk 已写.
   */
  async function seedAttempt(input: {
    readonly state: "UPLOAD_INTERRUPTED" | "APPROVAL_EXPIRED";
    readonly withProgress: boolean;
  }): Promise<SeededAttempt> {
    sequence += 1;
    const containerAddress = `0x${(0x1000 + sequence).toString(16).padStart(40, "0")}` as Hex;
    const [container] = await db
      .insert(containers)
      .values({
        chainId: 196,
        factoryAddress: XLAYER_MAINNET.factory,
        processorIndex: 0,
        processorAddress: `0x${(0x2000 + sequence).toString(16).padStart(40, "0")}` as Hex,
        tokenId: String(sequence),
        containerAddress,
        registryAddress: SITE_REGISTRY,
        bindingAddress: XLAYER_MAINNET.binding,
        lastObservedOwner: OWNER,
      })
      .returning();
    if (container === undefined) throw new Error("fixture: container insert failed");
    const [project] = await db
      .insert(projects)
      .values({
        ownerUserId: userId,
        githubInstallationId: installationId,
        githubRepositoryId: 8_000 + sequence,
        repoFullName: `p7-07/site-${sequence}`,
        containerId: container.id,
      })
      .returning();
    if (project === undefined) throw new Error("fixture: project insert failed");
    await db
      .insert(projectMembers)
      .values({ projectId: project.id, userId, role: "owner" })
      .onConflictDoNothing();

    const commitSha = (randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")).slice(0, 40);
    const plan = makePlan({ container: containerAddress, commitSha, releaseId: `rel-${sequence}` });
    const [deployment] = await db
      .insert(deployments)
      .values({
        projectId: project.id,
        containerId: container.id,
        createdByUserId: userId,
        triggerKind: "webhook",
        commitSha,
        state: input.state,
        registryAddress: SITE_REGISTRY,
        artifactSha256: plan.plan.artifactDigest,
        manifestSha256: plan.plan.releaseManifestHash,
        planJson: plan.json,
        estimatedCostWei: APPROVAL_COST_CAP_WEI,
      })
      .returning();
    if (deployment === undefined) throw new Error("fixture: deployment insert failed");

    // The authorization that lapsed. It is a real row, so `observeApproval` reaches
    // its "expired" verdict from storage, not from a fact the test invents.
    await db.insert(approvals).values({
      deploymentId: deployment.id,
      signerAddress: OWNER,
      chainId: 196,
      manifestSha256: plan.plan.releaseManifestHash,
      approvalDigest: `0x${randomBytes(32).toString("hex")}`,
      // The EIP-712 signature is never verified on any path this file exercises;
      // the signature-bearing approve route is covered by approval-manual.test.ts.
      signature: `0x${"11".repeat(65)}`,
      approvedCostCapWei: APPROVAL_COST_CAP_WEI,
      nonce: randomUUID(),
      expiresAt: EXPIRED_AT,
    });
    // A live operator grant: a reapproval must revoke it, not leave a stale one.
    await createOperatorSession(db, {
      containerId: container.id,
      signerAddress: OWNER,
      ttlSeconds: 3_600,
      now: NOW,
    });

    if (input.withProgress) {
      await db.insert(releaseFiles).values([
        {
          deploymentId: deployment.id,
          targetPath: "index.html",
          sourceRelativePath: "index.html",
          sha256: SHA_INDEX,
          byteSize: 900,
          chunkCount: 3,
          contentType: "text/html; charset=utf-8",
          state: "WRITING",
          lastConfirmedChunkIndex: 0,
          updatedAt: NOW,
        },
        {
          deploymentId: deployment.id,
          targetPath: "app.js",
          sourceRelativePath: "assets/app.js",
          sha256: SHA_APP_JS,
          byteSize: 334,
          chunkCount: 2,
          contentType: "text/javascript; charset=utf-8",
          state: "PENDING",
          lastConfirmedChunkIndex: -1,
          updatedAt: NOW,
        },
      ]);
    }

    const journalPath = join(journalDir, `${deployment.id}.jsonl`);
    if (input.withProgress) await writeJournal(journalPath, deployment.id, plan);
    const journalContent = await readFile(journalPath, "utf8").catch(() => "");

    return {
      deploymentId: deployment.id,
      containerId: container.id,
      projectId: project.id,
      plan,
      journalPath,
      journalContent,
    };
  }

  /** The half-written attempt's journal, written by the real journal writer. */
  async function writeJournal(
    path: string,
    deploymentId: string,
    plan: PlanDocument,
  ): Promise<void> {
    const journal = await DeploymentJournal.open(path);
    try {
      await journal.append({
        type: "plan",
        deploymentId,
        planFingerprint: plan.fingerprint,
        releaseManifestHash: plan.plan.releaseManifestHash,
        artifactDigest: plan.plan.artifactDigest,
        chainId: 196,
        container: plan.plan.container,
        siteRegistry: plan.plan.siteRegistry,
        commitSha: plan.plan.commitSha,
        releaseId: plan.plan.releaseId,
        entryPath: plan.plan.entryPath,
        pinnedBlockNumber: plan.plan.pinnedBlockNumber.toString(10),
        planJson: plan.json,
      });
      const fingerprint = `0x${"e1".repeat(32)}` as Hex;
      const txHash = `0x${"f1".repeat(32)}` as Hex;
      await journal.append({
        type: "tx_intent",
        deploymentId,
        fingerprint,
        operation: "appendChunk",
        path: "index.html",
        chunkIndex: 0,
        nonce: "7",
        dataSha256: `0x${"1a".repeat(32)}` as Hex,
        dataBytes: 300,
        expectIndex: null,
      });
      await journal.append({ type: "tx_sent", deploymentId, fingerprint, txHash, nonce: "7" });
      await journal.append({
        type: "tx_mined",
        deploymentId,
        fingerprint,
        txHash,
        blockNumber: "74312701",
        blockHash: `0x${"b1".repeat(32)}` as Hex,
        gasUsed: "120000",
      });
    } finally {
      await journal.close();
    }
  }

  async function deploymentRow(deploymentId: string) {
    const [row] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);
    if (row === undefined) throw new Error(`fixture: deployment ${deploymentId} is missing`);
    return row;
  }

  /** Chunk progress as recorded, in a stable order. */
  function fileRows(deploymentId: string) {
    return db
      .select({
        targetPath: releaseFiles.targetPath,
        state: releaseFiles.state,
        chunkCount: releaseFiles.chunkCount,
        lastConfirmedChunkIndex: releaseFiles.lastConfirmedChunkIndex,
      })
      .from(releaseFiles)
      .where(eq(releaseFiles.deploymentId, deploymentId))
      .orderBy(releaseFiles.targetPath);
  }

  function eventsOf(deploymentId: string) {
    return db
      .select()
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deploymentId, deploymentId))
      .orderBy(deploymentEvents.id);
  }

  function continuationsOf(sourceDeploymentId: string) {
    return db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.sourceEventKey, `reapproval:${sourceDeploymentId}`));
  }

  async function pathExists(path: string): Promise<boolean> {
    return await stat(path).then(
      () => true,
      () => false,
    );
  }

  function requireReapproval(result: ReapprovalResult): ReapprovalRequested {
    if (result.kind !== "reapproval_requested") {
      throw new Error(`expected a reapproval continuation, got ${result.kind}: ${result.detail}`);
    }
    return result;
  }

  function requireBlocked(result: ResumeResult | ReapprovalResult): RecoveryBlocked {
    if (result.kind !== "blocked") {
      throw new Error(`expected the server to refuse the recovery, got ${result.kind}`);
    }
    return result;
  }

  async function captureApiError(run: Promise<unknown>): Promise<ApiError> {
    try {
      await run;
    } catch (error) {
      if (error instanceof ApiError) return error;
      throw error;
    }
    throw new Error("expected the call to be refused with an ApiError");
  }

  // ── 1 + 2. 部分 chunk 已写, 授权过期 ──────────────────────────────────────

  it("§12.2/§12.3: partial chunks with a lapsed approval resolve to reapproval, never to a resume", async () => {
    attempt = await seedAttempt({ state: "UPLOAD_INTERRUPTED", withProgress: true });

    // 部分 chunk 已写: 1 of 5 chunks recorded, the entry file mid-write.
    const files = await fileRows(attempt.deploymentId);
    expect(files.map((file) => [file.targetPath, file.state, file.lastConfirmedChunkIndex])).toEqual([
      ["app.js", "PENDING", -1],
      ["index.html", "WRITING", 0],
    ]);
    const journal = await readJournalState(attempt.journalPath);
    expect(journal.complete).toBe(false);
    expect(journal.transactions.size).toBe(1);

    // 授权过期: the stored approval is in the past, and the server says so.
    const capability = await loadRecoveryCapability(deps(), {
      deploymentId: attempt.deploymentId,
      userId,
    });
    expect(capability.state).toBe("UPLOAD_INTERRUPTED");
    expect(capability.capability.action).toBe("reapproval");
    expect(capability.capability.reason).toContain("expired");
    expect(capability.capability.reason).toContain("re-sign");

    // The signature gate is never skipped: the resume entry answers "re-sign first"
    // and does not touch the queue.
    enqueued.length = 0;
    const refused = requireBlocked(
      await requestResume(deps(), { deploymentId: attempt.deploymentId, userId }),
    );
    expect(refused.reason).toBe("REAPPROVAL_REQUIRED");
    expect(refused.capability.action).toBe("reapproval");
    expect(refused.state).toBe("UPLOAD_INTERRUPTED");
    expect(enqueued, "a lapsed approval must not enqueue the upload").toEqual([]);

    // A user who is not a member is refused before any continuation is opened, and
    // learns nothing about the attempt (§7.1/§7.4 role re-check on the entry point).
    const stranger = await captureApiError(
      requestReapproval(deps(), { deploymentId: attempt.deploymentId, userId: randomUUID() }),
    );
    expect(stranger.statusCode).toBe(404);
    expect(stranger.code).toBe("DEPLOYMENT_NOT_FOUND");
    expect(await continuationsOf(attempt.deploymentId)).toHaveLength(0);
  });

  // ── 3. 重签 ───────────────────────────────────────────────────────────────

  it("§12.2/D-P6-1: reapproval opens a continuation at AWAITING_APPROVAL and retires the superseded attempt", async () => {
    const preparedPin = `sha256/${"cd".repeat(32)}.tar`;
    const preparation_request = { schemaVersion: "tapeci.preparation.v1", mode: "gzip-grouped", spaFallback: true, gatewayId: "fixture" };
    await db.update(deployments).set({ prepared_artifact_key: preparedPin, preparation_request }).where(eq(deployments.id, attempt.deploymentId));
    const before = await deploymentRow(attempt.deploymentId);
    const progressBefore = await fileRows(attempt.deploymentId);
    enqueued.length = 0;

    const reapproval = requireReapproval(
      await requestReapproval(deps(), { deploymentId: attempt.deploymentId, userId }),
    );
    continuationId = reapproval.deploymentId;

    expect(continuationId).not.toBe(attempt.deploymentId);
    expect(reapproval.supersededDeploymentId).toBe(attempt.deploymentId);
    expect(reapproval.state).toBe("AWAITING_APPROVAL");
    expect(reapproval.created).toBe(true);
    expect(reapproval.previousAttemptRetired).toBe(true);
    // The old authorization is revoked, not deleted: the old signature is refused.
    expect(reapproval.revokedApprovals).toBe(1);
    expect(reapproval.revokedOperatorSessions).toBe(1);
    expect(reapproval.approvalRequest.manifestSha256).toBe(attempt.plan.plan.releaseManifestHash);
    expect(reapproval.approvalRequest.nonceSource).toBe("approval_payload_endpoint");
    expect(reapproval.next.approve).toBe(`/v1/deployments/${continuationId}/approve`);
    expect(enqueued, "reapproval must not dispatch an upload").toEqual([]);

    // The continuation: AWAITING_APPROVAL on the same container, plan copied verbatim.
    const successor = await deploymentRow(continuationId);
    expect(successor.state).toBe("AWAITING_APPROVAL");
    expect(successor.stateVersion).toBe(0);
    expect(successor.containerId).toBe(attempt.containerId);
    expect(successor.projectId).toBe(attempt.projectId);
    expect(successor.sourceEventKey).toBe(`reapproval:${attempt.deploymentId}`);
    expect(successor.triggerKind).toBe("manual");
    expect(successor.planJson).toEqual(attempt.plan.json);
    expect(successor.commitSha).toBe(attempt.plan.plan.commitSha);
    expect(successor.manifestSha256).toBe(attempt.plan.plan.releaseManifestHash);
    expect(successor.artifactSha256).toBe(attempt.plan.plan.artifactDigest);
    expect(successor.prepared_artifact_key).toBe(preparedPin);
    expect(successor.preparation_request).toEqual(preparation_request);
    expect(successor.estimatedCostWei).toBe(before.estimatedCostWei);

    // The superseded attempt is retired to CANCELED — not deleted, and only once.
    const retired = await deploymentRow(attempt.deploymentId);
    expect(retired.state).toBe("CANCELED");
    // The context is *created* by the reapproval: the half-written attempt never had
    // one, so the identity below is derived from its id, not inherited from a row.
    expect(retired.recoveryContext).toBeNull();
    expect(retired.stateVersion).toBe(before.stateVersion + 1);
    expect(await db.select().from(deployments).where(eq(deployments.id, attempt.deploymentId))).toHaveLength(1);
    const oldEvents = await eventsOf(attempt.deploymentId);
    const supersededEvent = oldEvents.find((event) => event.eventType === "superseded_by_reapproval");
    expect(supersededEvent?.newState).toBe("CANCELED");
    expect(supersededEvent?.payload).toMatchObject({ successorDeploymentId: continuationId });

    // Every non-revoked approval and every operator grant of the container is gone.
    const oldApprovals = await db
      .select()
      .from(approvals)
      .where(eq(approvals.deploymentId, attempt.deploymentId));
    expect(oldApprovals).toHaveLength(1);
    expect(oldApprovals[0]?.revokedAt?.getTime()).toBe(NOW.getTime());
    const sessions = await db
      .select()
      .from(operatorSessions)
      .where(eq(operatorSessions.containerId, attempt.containerId));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.revokedAt?.getTime()).toBe(NOW.getTime());

    // The audit trail carries provenance only (the plan lives in the row/column).
    const newEvents = await eventsOf(continuationId);
    const opened = newEvents.find((event) => event.eventType === "reapproval_opened");
    expect(opened?.newState).toBe("AWAITING_APPROVAL");
    expect(opened?.payload).toMatchObject({
      supersededDeploymentId: attempt.deploymentId,
      planFingerprint: attempt.plan.fingerprint,
      journalDeploymentId: attempt.deploymentId,
      stage: "uploading_assets",
    });

    // §12.2: the original plan, the journal identity and the recovery stage survive.
    const stored = await readRecoveryContext(db, continuationId);
    if (stored.kind !== "found") {
      throw new Error(`expected a stored recovery context, got ${stored.kind}`);
    }
    const context = stored.context;
    expect(reapproval.recovery).toEqual(context);
    expect(context.schemaVersion).toBe("tapeci.recovery.v1");
    expect(context.plan.planFingerprint).toBe(attempt.plan.fingerprint);
    expect(context.plan.releaseId).toBe(attempt.plan.plan.releaseId);
    expect(context.plan.artifactDigest).toBe(attempt.plan.plan.artifactDigest);
    expect(context.plan.commitSha).toBe(attempt.plan.plan.commitSha);
    expect(context.plan.container).toBe(attempt.plan.plan.container);
    expect(context.plan.siteRegistry).toBe(attempt.plan.plan.siteRegistry);
    expect(context.plan.entryPath).toBe("index.html");
    expect(context.plan.pinnedBlockNumber).toBe("74312700");
    expect(context.plan.totals).toEqual({ files: 2, writes: 2, chunks: 5, bytes: 1_234 });
    expect(context.planJson).toEqual(attempt.plan.json);
    // The journal key is the *half-written attempt*, never the new row's own id.
    expect(context.journal.deploymentId).toBe(attempt.deploymentId);
    expect(context.journal.planFingerprint).toBe(attempt.plan.fingerprint);
    expect(context.stage, "恢复阶段: the upload was interrupted mid-file").toBe("uploading_assets");
    expect(context.supersededDeploymentId).toBe(attempt.deploymentId);
    expect(context.recordedAt).toBe(NOW.toISOString());

    // Chunk progress is copied as recorded observations, never reset.
    const progressAfter = await fileRows(continuationId);
    expect(progressAfter).toEqual(progressBefore);
    expect(progressAfter).toHaveLength(2);
    expect(progressAfter.find((file) => file.targetPath === "index.html")?.lastConfirmedChunkIndex).toBe(0);
    expect(progressAfter.find((file) => file.targetPath === "app.js")?.lastConfirmedChunkIndex).toBe(-1);

    // Nothing was appended to the old journal, and no journal was started for the new row.
    expect(await readFile(attempt.journalPath, "utf8")).toBe(attempt.journalContent);
    expect(await pathExists(join(journalDir, `${continuationId}.jsonl`))).toBe(false);
  });

  it("§12.2: a repeat reapproval cannot open a second continuation (one row per source_event_key)", async () => {
    // This test continues the fixture chain: the previous test opened the continuation for
    // `attempt`, and the two tests after this one read it. `continuationsOf` is the guard
    // that the chain is intact rather than an assumption.
    const existing = await continuationsOf(attempt.deploymentId);
    expect(existing, "the previous test opened exactly one continuation").toHaveLength(1);
    const opened = existing[0];
    if (opened === undefined) throw new Error("unreachable: asserted one row above");

    // (a) The superseded attempt is terminal now, but a repeat must REPORT the continuation
    // it already opened rather than refusing (P7-18). Refusing was true of the source row
    // and useless to a caller who simply retried a request that succeeded — and it made the
    // contract's "same attempt on replay" promise false.
    const repeat = requireReapproval(
      await requestReapproval(deps(), { deploymentId: attempt.deploymentId, userId }),
    );
    expect(repeat.created, "a replay reports the attempt it found").toBe(false);
    expect(repeat.deploymentId, "the replay names the same continuation").toBe(opened.id);
    expect(repeat.supersededDeploymentId).toBe(attempt.deploymentId);
    expect(repeat.next.approvalPayload).toContain(repeat.deploymentId);
    // Still exactly one continuation: idempotency, not a second row.
    expect(await continuationsOf(attempt.deploymentId)).toHaveLength(1);

    // (b) The idempotent branch itself, on a source attempt that stays reapprovable:
    // `APPROVAL_EXPIRED` is terminal, so its row keeps its state and the second call
    // reaches `openContinuationAttempt` again with the same `reapproval:<old id>` key.
    const lapsed = await seedAttempt({ state: "APPROVAL_EXPIRED", withProgress: false });
    const first = requireReapproval(
      await requestReapproval(deps(), { deploymentId: lapsed.deploymentId, userId }),
    );
    const second = requireReapproval(
      await requestReapproval(deps(), { deploymentId: lapsed.deploymentId, userId }),
    );

    expect(first.created).toBe(true);
    expect(second.created, "a replayed reapproval reports the attempt it found").toBe(false);
    expect(second.deploymentId).toBe(first.deploymentId);
    expect(second.supersededDeploymentId).toBe(lapsed.deploymentId);
    // A replay changes nothing: the retirement and revocations already happened on the
    // first call, so reporting them again would claim work was done twice.
    expect(second.previousAttemptRetired).toBe(true);
    expect(second.revokedApprovals).toBe(0);
    expect(second.revokedOperatorSessions).toBe(0);
    // The replay reports the same carried context, not a freshly derived one.
    expect(second.recovery).toEqual(first.recovery);

    const rows = await continuationsOf(lapsed.deploymentId);
    expect(rows, "the same source_event_key must not create two rows").toHaveLength(1);
    expect(rows[0]?.id).toBe(first.deploymentId);
    // The context written by the first call is still the one the worker would read.
    const carried = await readRecoveryContext(db, first.deploymentId);
    if (carried.kind !== "found") throw new Error(`expected a stored context, got ${carried.kind}`);
    expect(carried.context.journal.deploymentId).toBe(lapsed.deploymentId);
    expect(carried.context.stage, "恢复阶段: the approval lapsed before any write").toBe("approved");
    // A terminal source attempt is never retired a second time.
    expect((await deploymentRow(lapsed.deploymentId)).state).toBe("APPROVAL_EXPIRED");
    expect((await deploymentRow(first.deploymentId)).state).toBe("AWAITING_APPROVAL");
  });

  // ── 4. APPROVED → 恢复: the original plan is what the worker selects ──────

  it("§12.2/AC-P6-14: once the continuation is APPROVED the worker still selects the original plan from the recovery context", async () => {
    const pending = await deploymentRow(continuationId);
    expect(pending.state).toBe("AWAITING_APPROVAL");
    const contextBeforeSignature = pending.recoveryContext;
    expect(contextBeforeSignature).not.toBeNull();

    // The signature step: an approval row plus the operator grant `/approve` records.
    // Producing the EIP-712 signature is out of scope here (see the file docblock);
    // what matters below is the storage state the worker reads.
    const [approval] = await db
      .insert(approvals)
      .values({
        deploymentId: continuationId,
        signerAddress: OWNER,
        chainId: 196,
        manifestSha256: attempt.plan.plan.releaseManifestHash,
        approvalDigest: `0x${randomBytes(32).toString("hex")}`,
        signature: `0x${"11".repeat(65)}`,
        approvedCostCapWei: APPROVAL_COST_CAP_WEI,
        nonce: randomUUID(),
        expiresAt: LIVE_UNTIL,
      })
      .returning();
    if (approval === undefined) throw new Error("fixture: approval insert failed");
    await createOperatorSession(db, {
      containerId: attempt.containerId,
      signerAddress: OWNER,
      ttlSeconds: 3_600,
      now: NOW,
      approvalId: approval.id,
    });
    const approved = await transitionDeployment(db, {
      deploymentId: continuationId,
      expectedVersion: pending.stateVersion,
      toState: "APPROVED",
      eventType: "approval_recorded",
      actorKind: "user",
      actorId: userId,
    });
    expect(approved.state).toBe("APPROVED");

    const signed = await deploymentRow(continuationId);
    expect(signed.state).toBe("APPROVED");
    expect(signed.stateVersion).toBe(pending.stateVersion + 1);
    // §12.2: the context survives `AWAITING_APPROVAL → APPROVED` because it lives
    // on the row the worker loads, not in a transient response.
    expect(signed.recoveryContext).toEqual(contextBeforeSignature);

    // The worker's selection (runtime.ts:668-683) is:
    //   recoveryPlanJson(deployment.recoveryContext)
    //     ?? (state === "UPLOAD_INTERRUPTED" ? planFromJson(plan_json) : planRelease(...))
    // It is not exported, so the observable assertion is: the state is APPROVED (the
    // state-keyed branch cannot fire) *and* the validated context yields a full plan.
    expect(signed.state).not.toBe("UPLOAD_INTERRUPTED");
    const selected = recoveryPlanJson(signed.recoveryContext);
    expect(selected, "a reapproved deployment must carry an executable plan").not.toBeNull();
    if (selected === null) throw new Error("unreachable: asserted non-null above");

    // 原计划继续生效: the selected document IS the pre-recovery plan, deep-equal.
    expect(selected).toEqual(attempt.plan.json);
    expect(selected).toEqual(planToJson(attempt.plan.plan));
    expect(planToJson(planFromJson(selected))).toEqual(attempt.plan.json);
    expect(planFingerprint(planFromJson(selected))).toBe(attempt.plan.fingerprint);
    // It is a copied document, never re-derived: it is byte-identical to the
    // superseded attempt's `plan_json`, and the injected chain implements only the
    // two allowlist reads, so a planning read on this path would have thrown.
    expect(selected).toEqual((await deploymentRow(attempt.deploymentId)).planJson);

    // With a live signature the server offers no recovery action at all: the next
    // step is `POST /execute`, which reaches this same plan selection.
    const capability = await loadRecoveryCapability(deps(), {
      deploymentId: continuationId,
      userId,
    });
    expect(capability.state).toBe("APPROVED");
    expect(capability.capability.action).toBe("none");
    expect(capability.capability.reason).toContain("POST /execute");
  });

  // ── 5. 原计划和 journal 继续生效, 无重复写入 ─────────────────────────────

  it("§12.2: the original journal continues to apply and no chunk is re-written", async () => {
    const signed = await deploymentRow(continuationId);
    expect(signed.state).toBe("APPROVED");

    // The recovery round trip appends nothing to the journal: byte-identical.
    const journalNow = await readFile(attempt.journalPath, "utf8");
    expect(journalNow, "reapproval/resume must not write journal events").toBe(attempt.journalContent);
    const journal = await readJournalState(attempt.journalPath);
    expect(journal.plan?.planFingerprint.toLowerCase()).toBe(attempt.plan.fingerprint.toLowerCase());
    expect(journal.complete).toBe(false);

    // Chunk 0 has exactly one intent: a rewrite would append a second one for the
    // same path, or reset the recorded index. Neither happened.
    const intents = [...journal.transactions.values()].filter(
      (record) => record.intent.path === "index.html",
    );
    expect(intents, "the half-written chunk has exactly one journal intent").toHaveLength(1);
    expect(intents[0]?.intent.chunkIndex).toBe(0);
    expect(intents[0]?.intent.operation).toBe("appendChunk");
    expect(intents[0]?.mined?.blockNumber).toBe("74312701");

    // The chunk index the attempt recorded is carried, not reset and not advanced.
    const progress = await fileRows(signed.id);
    expect(progress.map((file) => [file.targetPath, file.state, file.lastConfirmedChunkIndex])).toEqual([
      ["app.js", "PENDING", -1],
      ["index.html", "WRITING", 0],
    ]);
    expect(progress.find((file) => file.targetPath === "index.html")?.lastConfirmedChunkIndex).toBe(0);
    expect(progress.find((file) => file.targetPath === "app.js")?.lastConfirmedChunkIndex).toBe(-1);
    // The chunking is the plan's, unchanged: 3 + 2 chunks for the two files.
    expect(progress.map((file) => [file.targetPath, file.chunkCount])).toEqual([
      ["app.js", 2],
      ["index.html", 3],
    ]);
    // The superseded attempt's own rows are untouched observations, not resets.
    const supersededProgress = await fileRows(attempt.deploymentId);
    expect(supersededProgress.map((file) => [file.targetPath, file.state, file.lastConfirmedChunkIndex])).toEqual([
      ["app.js", "PENDING", -1],
      ["index.html", "WRITING", 0],
    ]);

    // The journal the worker resumes is still the original one: the path derived
    // from the carried identity is the half-written attempt's file.
    const stored = await readRecoveryContext(db, signed.id);
    if (stored.kind !== "found") throw new Error(`expected a stored context, got ${stored.kind}`);
    expect(stored.context.journal.deploymentId).toBe(attempt.deploymentId);
    expect(stored.context.plan.planFingerprint).toBe(attempt.plan.fingerprint);
    const resumeJournalPath = join(journalDir, `${stored.context.journal.deploymentId}.jsonl`);
    expect(resumeJournalPath).toBe(attempt.journalPath);
    expect(await pathExists(resumeJournalPath)).toBe(true);
    expect(await pathExists(join(journalDir, `${signed.id}.jsonl`))).toBe(false);
    expect(await pathExists(`${attempt.journalPath}.lock`)).toBe(false);
  });

  it("§12.2/P7-19: a continuation left without a context by a crash is repaired on retry", async () => {
    // The crash window: the successor row is INSERTed, then the process dies before the
    // `recovery_context` UPDATE. A retry takes the `created: false` branch, so without the
    // repair the context would never be written and the worker would re-plan a half-written
    // release (§12.2's UPLOAD_CONFLICT). The round-2 audit found this branch had no test.
    const source = await seedAttempt({ state: "UPLOAD_INTERRUPTED", withProgress: true });
    const opened = requireReapproval(
      await requestReapproval(deps(), { deploymentId: source.deploymentId, userId }),
    );

    // Simulate the crash: the row exists, the column is NULL.
    await db
      .update(deployments)
      .set({ recoveryContext: null })
      .where(eq(deployments.id, opened.deploymentId));
    const afterCrash = await readRecoveryContext(db, opened.deploymentId);
    expect(afterCrash.kind, "the fixture must actually be context-less").toBe("missing");

    // The retry must repair it rather than hand back the context-less row.
    const retried = requireReapproval(
      await requestReapproval(deps(), { deploymentId: source.deploymentId, userId }),
    );
    expect(retried.created).toBe(false);
    expect(retried.deploymentId).toBe(opened.deploymentId);

    const repaired = await readRecoveryContext(db, opened.deploymentId);
    if (repaired.kind !== "found") {
      throw new Error(`expected a repaired context, got ${repaired.kind}`);
    }
    // And it is the ORIGINAL plan/journal, not freshly derived.
    expect(repaired.context.journal.deploymentId).toBe(source.deploymentId);
    expect(repaired.context.plan.planFingerprint).toBe(source.plan.fingerprint);
  });
});
