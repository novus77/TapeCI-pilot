#!/usr/bin/env tsx
/**
 * P2-10 rollback tool — creates a rollback deployment in `PLAN_READY`, nothing more.
 *
 *   tsx scripts/p2/mainnet-rollback.ts --project <uuid> --release <r-…|uuid> [--cap-wei <n>]
 *
 * It mirrors `POST /v1/projects/:id/rollback` (`apps/api/src/routes/projects.ts`)
 * but writes through the database helper so no HTTP write endpoint is involved:
 *
 * - `triggerKind = "rollback"`, `state = PLAN_READY`, `stateVersion = 0`;
 * - `rollbackTargetReleaseId` = the stored `releases.id` of the target release;
 * - `artifactStorageKey` / `artifactSha256` / `manifestSha256` copied from the
 *   target deployment (falling back to the newest `artifact_uploads` row, exactly
 *   like the route);
 * - `sourceEventKey = rollback:<releases.id>` so a repeated run is idempotent;
 * - `planJson` starts from the target deployment's plan (the worker re-plans from
 *   the release manifest anyway; `deployRollback` re-derives it).
 *
 * The `plan` job is only enqueued when the new row has no plan yet — the route
 * leaves a rollback deployment in `PLAN_READY` without a plan job, so we enqueue
 * one so the fees and approval payload exist before the owner signs.
 *
 * It NEVER signs, approves or executes.
 *
 * Exit codes: 0 = PLAN_READY within the cap guard; 1 = terminal failure, timeout
 * or `recommendedCapWei > --cap-wei`; 2 = usage/config error.
 */
import { desc, eq } from "drizzle-orm";
import { artifactUploads, deployments } from "@tapeci/database";
import { isTapeCiError, TapeCiError, toErrorBody } from "@tapeci/shared";
import {
  DEFAULT_PLAN_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  checkCap,
  parseRollbackArgs,
  readPlanFees,
  type RollbackArgs,
} from "./mainnet-tooling.js";
import {
  approvalCostCapWei,
  createReadOnlyApiClient,
  enqueuePlanJob,
  fetchApprovalPayload,
  loadDeployment,
  loadProjectContext,
  openDatabase,
  pollDeploymentState,
  readEnvironment,
  resolveRelease,
  type ApprovalPayload,
  type Database,
} from "./mainnet-runtime.js";

const USAGE = `TapeCI P2-10 rollback tool (creates a PLAN_READY rollback; never signs or sends)

Usage:
  tsx scripts/p2/mainnet-rollback.ts --project <uuid> --release <r-…|uuid> [options]

Options:
  --project <uuid>     project id (from GET /v1/projects)
  --release <id>       release to restore: public id (r-…) or release row UUID
  --cap-wei <n>        local guard: fail when recommendedCapWei exceeds this
  --timeout-ms <n>     plan wait budget (default ${DEFAULT_PLAN_TIMEOUT_MS})
  --poll-ms <n>        poll interval (default ${DEFAULT_POLL_INTERVAL_MS})
  --help               show this text

Environment: DATABASE_URL, REDIS_URL, TAPECI_PUBLIC_API_URL, OBJECT_STORE_DIR,
TAPECI_DEV_GITHUB_LOGIN, TAPECI_DEV_GITHUB_USER_ID (dev headers for API reads).`;

/** Mirrors the route's placeholder plan for a rollback with no target plan. */
const EMPTY_ROLLBACK_PLAN = {
  schemaVersion: "tapeci.plan.v1",
  totals: { files: 0, writes: 0, unchanged: 0, conflicts: 0, chunks: 0, bytes: 0 },
  fees: {
    gasPriceWei: "0",
    estimatedGas: "0",
    estimatedCostWei: "0",
    marginBps: 0,
    recommendedCapWei: "0",
    costCapWei: "0",
    withinBudget: true,
    overBudgetByWei: "0",
  },
  blocked: false,
  blockedReasons: [],
  warnings: [],
} as const;

export interface RollbackResult {
  readonly status: "PLAN_READY" | "ALREADY_APPLIED" | "FAILED";
  readonly deploymentId: string;
  readonly projectId: string;
  readonly containerAddress: string;
  readonly releaseId: string;
  readonly releaseRowId: string;
  readonly rollbackTargetReleaseId: string;
  readonly commitSha: string;
  readonly artifactStorageKey: string;
  readonly artifactSha256: string | null;
  readonly manifestSha256: string | null;
  readonly state: string;
  readonly stateVersion: number;
  readonly planEnqueued: boolean;
  /**
   * False when the target release has no stored plan, so the copied fee block is
   * the route's zero placeholder and there is no real estimate to cap.
   */
  readonly feeEstimateAvailable: boolean;
  readonly estimatedCostWei: string | null;
  readonly recommendedCapWei: string | null;
  readonly gasPriceWei: string | null;
  readonly capGuard: {
    readonly capWei: string | null;
    readonly ok: boolean;
    readonly overByWei: string;
  } | null;
  readonly warnings: readonly string[];
  readonly approvalPayload: ApprovalPayload | null;
  readonly approvalError: string | null;
  readonly approvalCostCapWei: string | null;
}

function log(message: string): void {
  console.error(`[mainnet-rollback] ${message}`);
}

interface CreatedRollback {
  readonly deploymentId: string;
  readonly created: boolean;
}

async function createRollbackDeployment(
  db: Database,
  input: {
    readonly projectId: string;
    readonly containerId: string;
    readonly registryAddress: string;
    readonly releaseRowId: string;
    readonly releasePublicId: string;
    readonly commitSha: string;
    readonly artifactStorageKey: string;
    readonly artifactSha256: string | null;
    readonly manifestSha256: string | null;
    readonly planJson: unknown;
  },
): Promise<CreatedRollback> {
  const sourceEventKey = `rollback:${input.releaseRowId}`;
  const [created] = await db
    .insert(deployments)
    .values({
      projectId: input.projectId,
      containerId: input.containerId,
      createdByUserId: null,
      triggerKind: "rollback",
      commitSha: input.commitSha,
      state: "PLAN_READY",
      registryAddress: input.registryAddress,
      sourceEventKey,
      rollbackTargetReleaseId: input.releaseRowId,
      artifactStorageKey: input.artifactStorageKey,
      artifactSha256: input.artifactSha256 as `0x${string}` | null,
      manifestSha256: input.manifestSha256 as `0x${string}` | null,
      planJson: input.planJson,
    })
    .onConflictDoNothing({ target: deployments.sourceEventKey })
    .returning();
  if (created !== undefined) return { deploymentId: created.id, created: true };

  // Idempotent re-run: reuse the existing rollback deployment for this release.
  const [existing] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.sourceEventKey, sourceEventKey))
    .limit(1);
  if (existing === undefined) {
    throw new TapeCiError("INTERNAL", "could not create or find the rollback deployment", {
      details: { sourceEventKey },
    });
  }
  return { deploymentId: existing.id, created: false };
}

async function run(args: RollbackArgs): Promise<number> {
  const environment = readEnvironment();
  log(`project=${args.projectId} release=${args.release}`);

  const database = openDatabase(environment.databaseUrl);
  try {
    const { project, container } = await loadProjectContext(database.db, args.projectId);
    const release = await resolveRelease(database.db, project.id, args.release);
    log(`release row=${release.id} public=${release.releaseId} commit=${release.commitSha}`);

    const [targetDeployment] = await database.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, release.deploymentId))
      .limit(1);
    if (targetDeployment === undefined) {
      throw new TapeCiError("INTERNAL", "the release target deployment is missing", {
        details: { releaseId: release.releaseId, deploymentId: release.deploymentId },
      });
    }

    // Same artifact fallback the API rollback route uses.
    let artifactStorageKey = targetDeployment.artifactStorageKey;
    if (artifactStorageKey === null) {
      const [upload] = await database.db
        .select()
        .from(artifactUploads)
        .where(eq(artifactUploads.deploymentId, targetDeployment.id))
        .orderBy(desc(artifactUploads.createdAt))
        .limit(1);
      artifactStorageKey = upload?.objectKey ?? null;
    }
    if (artifactStorageKey === null) {
      throw new TapeCiError("INVALID_CONFIG", "the target release artifact is no longer stored", {
        details: { releaseId: release.releaseId },
      });
    }
    log(`artifact=${artifactStorageKey}`);

    const created = await createRollbackDeployment(database.db, {
      projectId: project.id,
      containerId: project.containerId,
      registryAddress: container.registryAddress,
      releaseRowId: release.id,
      releasePublicId: release.releaseId,
      commitSha: release.commitSha,
      artifactStorageKey,
      artifactSha256: targetDeployment.artifactSha256,
      manifestSha256: release.manifestSha256,
      planJson: targetDeployment.planJson ?? EMPTY_ROLLBACK_PLAN,
    });
    log(
      created.created
        ? `rollback deployment=${created.deploymentId} created in PLAN_READY`
        : `rollback deployment=${created.deploymentId} already existed for this release`,
    );

    // `planDeployment` only runs for BUILT/VALIDATING, and the route already puts
    // rollback deployments in PLAN_READY, so a plan job is a no-op here. Enqueue
    // only if a future route change leaves the row in a plan-able state without a
    // fee block; otherwise say so instead of queueing dead work.
    const warnings: string[] = [];
    let planEnqueued = false;
    const before = await loadDeployment(database.db, created.deploymentId);
    const beforeFees = readPlanFees(before.planJson);
    if (beforeFees === null) {
      if (before.state === "BUILT" || before.state === "VALIDATING") {
        await enqueuePlanJob(environment.redisUrl, created.deploymentId);
        planEnqueued = true;
        log(`plan job enqueued (state=${before.state}, no fee block)`);
      } else {
        warnings.push(
          `deployment is ${before.state} with no fee block; the plan worker only runs for BUILT/VALIDATING, ` +
            "so no plan job was enqueued",
        );
        log(warnings[warnings.length - 1] ?? "");
      }
    } else {
      log("plan job not needed: rollback deployment already carries a plan");
    }

    const polled = await pollDeploymentState({
      timeoutMs: args.timeoutMs,
      intervalMs: args.pollMs,
      readState: async () => (await loadDeployment(database.db, created.deploymentId)).state,
    });
    log(`poll status=${polled.status} state=${polled.state}`);

    const final = await loadDeployment(database.db, created.deploymentId);
    const fees = readPlanFees(final.planJson);
    // The copied fee block (when it exists) describes the *target release* write,
    // not the entry-only rollback, and the route's placeholder is all zeros.
    const feeEstimateAvailable = fees !== null && fees.recommendedCapWei > 0n;
    if (!feeEstimateAvailable) {
      warnings.push(
        "no real rollback fee estimate: the stored plan is the route's zero placeholder; " +
          "the approval payload will suggest costCapWei=0 and --cap-wei cannot bound anything",
      );
    } else {
      warnings.push(
        "fee block was copied from the target release deployment; it over-estimates the entry-only rollback",
      );
    }
    const capGuard = feeEstimateAvailable
      ? checkCap(fees.recommendedCapWei, args.capWei)
      : null;

    let approvalPayload: ApprovalPayload | null = null;
    let approvalError: string | null = null;
    if (polled.status === "READY") {
      try {
        approvalPayload = await fetchApprovalPayload(
          createReadOnlyApiClient(environment),
          final.id,
        );
      } catch (error) {
        // The approval payload is evidence, not a precondition: report it and keep
        // the deployment id so the owner can still fetch it from the console.
        approvalError = error instanceof Error ? error.message : String(error);
        log(`warning: approval payload unavailable: ${approvalError}`);
        warnings.push(`approval payload unavailable: ${approvalError}`);
      }
    }

    const withinGuard = capGuard === null || capGuard.ok;
    // `LIVE` means this exact rollback already ran (the `rollback:<releaseId>`
    // source key makes a re-run reuse the row). Report it as a no-op, not a failure.
    const alreadyApplied = final.state === "LIVE" && !created.created;
    const result: RollbackResult = {
      status: alreadyApplied
        ? "ALREADY_APPLIED"
        : polled.status === "READY" && withinGuard
          ? "PLAN_READY"
          : "FAILED",
      deploymentId: final.id,
      projectId: final.projectId,
      containerAddress: container.containerAddress,
      releaseId: release.releaseId,
      releaseRowId: release.id,
      rollbackTargetReleaseId: final.rollbackTargetReleaseId ?? release.id,
      commitSha: final.commitSha,
      artifactStorageKey: final.artifactStorageKey ?? artifactStorageKey,
      artifactSha256: final.artifactSha256,
      manifestSha256: final.manifestSha256,
      state: final.state,
      stateVersion: final.stateVersion,
      planEnqueued,
      feeEstimateAvailable,
      estimatedCostWei: fees?.estimatedCostWei.toString() ?? null,
      recommendedCapWei: fees?.recommendedCapWei.toString() ?? null,
      gasPriceWei: fees?.gasPriceWei.toString() ?? null,
      capGuard:
        capGuard === null
          ? null
          : {
              capWei: capGuard.capWei?.toString() ?? null,
              ok: capGuard.ok,
              overByWei: capGuard.overByWei.toString(),
            },
      warnings,
      approvalPayload,
      approvalError,
      approvalCostCapWei: approvalPayload === null ? null : approvalCostCapWei(approvalPayload),
    };
    console.log(JSON.stringify(result, null, 2));

    if (polled.status === "TERMINAL") {
      if (alreadyApplied) {
        log(
          `this release was already restored by deployment=${final.id} (state LIVE); ` +
            "no new rollback deployment was created",
        );
        return 0;
      }
      log(`terminal failure state=${final.state} code=${final.errorCode ?? ""}`);
      return 1;
    }
    if (polled.status === "TIMEOUT") {
      log(`timed out waiting for PLAN_READY (last state ${final.state}) deployment=${final.id}`);
      return 1;
    }
    if (capGuard !== null && !capGuard.ok) {
      log(
        `recommendedCapWei=${capGuard.recommendedCapWei} exceeds --cap-wei=${String(
          capGuard.capWei,
        )} by ${capGuard.overByWei} wei; do not approve`,
      );
      return 1;
    }
    log(
      `PLAN_READY rollback deployment=${final.id} release=${release.releaseId} ` +
        `manifest=${final.manifestSha256 ?? "(none)"}`,
    );
    log("next: owner signs the EIP-712 approval; this tool will not approve or execute");
    return 0;
  } finally {
    await database.close();
  }
}

async function main(): Promise<number> {
  const parsed = parseRollbackArgs(process.argv.slice(2));
  if ("help" in parsed) {
    console.log(USAGE);
    return 0;
  }
  return run(parsed);
}

try {
  process.exitCode = await main();
} catch (error) {
  const body = toErrorBody(error);
  console.error(`tapeci mainnet-rollback: ${body.error.code}: ${body.error.message}`);
  if (isTapeCiError(error) && Object.keys(error.details).length > 0) {
    console.error(JSON.stringify({ details: body.error.details }));
  }
  process.exitCode = isTapeCiError(error) && error.code === "INVALID_CONFIG" ? 2 : 1;
}
