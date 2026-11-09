#!/usr/bin/env tsx
/**
 * P2-10 RC release tool — prepares a `PLAN_READY` deployment, nothing more.
 *
 *   tsx scripts/p2/mainnet-release.ts \
 *     --project <uuid> --dist <dir> --commit <40-hex> [--cap-wei <n>]
 *
 * It builds a deterministic, safe artifact tar (no `./` root, no AppleDouble
 * `._*`, no `.DS_Store`, no symlinks), stores it in the local content-addressed
 * object store, inserts the `BUILT` deployment, enqueues the read-only `plan`
 * job, waits for `PLAN_READY` (or a terminal state) and prints the deployment id,
 * artifact/manifest SHA-256, estimated/recommended cap and the EIP-712 approval
 * payload.
 *
 * It NEVER signs, approves or executes. Owner approval + execute stay manual
 * (`docs/P2-10_RC_RUNBOOK.md`).
 *
 * Exit codes: 0 = PLAN_READY within the cap guard; 1 = terminal failure, timeout
 * or `recommendedCapWei > --cap-wei`; 2 = usage/config error.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { TapeCiError, isTapeCiError, toErrorBody } from "@tapeci/shared";
import {
  DEFAULT_PLAN_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  buildArtifactTar,
  checkCap,
  collectArtifactEntries,
  parseReleaseArgs,
  readPlanFees,
  type ReleaseArgs,
} from "./mainnet-tooling.js";
import {
  approvalCostCapWei,
  createReadOnlyApiClient,
  enqueuePlanJob,
  fetchApprovalPayload,
  findUserIdByLogin,
  insertBuiltDeployment,
  loadDeployment,
  loadProjectContext,
  openDatabase,
  pollDeploymentState,
  readEnvironment,
  storeArtifact,
  type ApprovalPayload,
} from "./mainnet-runtime.js";

const USAGE = `TapeCI P2-10 RC release tool (prepares PLAN_READY; never signs or sends)

Usage:
  tsx scripts/p2/mainnet-release.ts --project <uuid> --dist <dir> --commit <40-hex> [options]

Options:
  --project <uuid>     project id (from GET /v1/projects)
  --dist <dir>         build output directory to publish
  --commit <40-hex>    lowercase Git commit SHA the artifact was built from
  --cap-wei <n>        local guard: fail when recommendedCapWei exceeds this
  --timeout-ms <n>     plan wait budget (default ${DEFAULT_PLAN_TIMEOUT_MS})
  --poll-ms <n>        poll interval (default ${DEFAULT_POLL_INTERVAL_MS})
  --help               show this text

Environment: DATABASE_URL, REDIS_URL, TAPECI_PUBLIC_API_URL, OBJECT_STORE_DIR,
TAPECI_DEV_GITHUB_LOGIN, TAPECI_DEV_GITHUB_USER_ID (dev headers for API reads).`;

export interface ReleaseResult {
  readonly status: "PLAN_READY" | "FAILED";
  readonly deploymentId: string;
  readonly projectId: string;
  readonly containerAddress: string;
  readonly commitSha: string;
  readonly artifactSha256: string;
  readonly artifactStorageKey: string;
  readonly artifactSizeBytes: number;
  readonly entryCount: number;
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly state: string;
  readonly stateVersion: number;
  readonly manifestSha256: string | null;
  readonly estimatedCostWei: string | null;
  readonly recommendedCapWei: string | null;
  readonly gasPriceWei: string | null;
  readonly capGuard: {
    readonly capWei: string | null;
    readonly ok: boolean;
    readonly overByWei: string;
  } | null;
  readonly approvalPayload: ApprovalPayload | null;
  readonly approvalCostCapWei: string | null;
}

function log(message: string): void {
  console.error(`[mainnet-release] ${message}`);
}

async function run(args: ReleaseArgs): Promise<number> {
  const environment = readEnvironment();
  const dist = resolve(args.dist);
  log(`project=${args.projectId} commit=${args.commitSha} dist=${dist}`);

  // 1. Safe artifact collection + deterministic tar (local filesystem only).
  const entries = await collectArtifactEntries(dist);
  for (const skip of entries.skipped) log(`skip ${skip.path} (${skip.reason})`);
  if (entries.files.length === 0) {
    throw new TapeCiError("INVALID_ARTIFACT", `no publishable files under ${dist}`, {
      details: { dist },
    });
  }
  if (!entries.files.includes("index.html")) {
    throw new TapeCiError("INVALID_ARTIFACT", "the entry document index.html is missing", {
      details: { dist, files: entries.files.slice(0, 20) },
    });
  }
  const artifact = await buildArtifactTar(dist, entries.files);
  log(
    `tar bytes=${artifact.bytes.length} sha256=${artifact.sha256} entries=${artifact.entryPaths.length}`,
  );

  // 2. Store + insert BUILT + enqueue plan (object store, DB, Redis writes).
  const database = openDatabase(environment.databaseUrl);
  try {
    const { project, container } = await loadProjectContext(database.db, args.projectId);
    log(`container=${container.containerAddress} registry=${container.registryAddress}`);

    const stored = await storeArtifact(environment.objectStoreDir, artifact.bytes, artifact.sha256);
    log(`stored ${stored.objectKey}`);

    // `created_by_user_id` is attribution only (the worker does not require it).
    const createdByUserId =
      environment.devLogin === null
        ? null
        : await findUserIdByLogin(database.db, environment.devLogin);
    if (createdByUserId === null) {
      log("warning: no local user row for TAPECI_DEV_GITHUB_LOGIN; createdByUserId will be null");
    }
    const deployment = await insertBuiltDeployment(database.db, {
      project,
      container,
      createdByUserId,
      commitSha: args.commitSha,
      artifactStorageKey: stored.objectKey,
      artifactSha256: artifact.sha256,
      sourceEventKey: `mainnet-rc:${randomUUID()}`,
    });
    log(
      `deployment=${deployment.id} state=${deployment.state} stateVersion=${deployment.stateVersion}`,
    );

    await enqueuePlanJob(environment.redisUrl, deployment.id);
    log("plan job enqueued (chain reads + plan_json write only)");

    const polled = await pollDeploymentState({
      timeoutMs: args.timeoutMs,
      intervalMs: args.pollMs,
      readState: async () => (await loadDeployment(database.db, deployment.id)).state,
    });
    log(`poll status=${polled.status} state=${polled.state}`);

    const final = await loadDeployment(database.db, deployment.id);
    const fees = readPlanFees(final.planJson);
    const capGuard = fees === null ? null : checkCap(fees.recommendedCapWei, args.capWei);

    let approvalPayload: ApprovalPayload | null = null;
    if (polled.status === "READY") {
      approvalPayload = await fetchApprovalPayload(
        createReadOnlyApiClient(environment),
        final.id,
      );
    }

    const withinGuard = capGuard === null || capGuard.ok;
    const result: ReleaseResult = {
      status: polled.status === "READY" && withinGuard ? "PLAN_READY" : "FAILED",
      deploymentId: final.id,
      projectId: final.projectId,
      containerAddress: container.containerAddress,
      commitSha: final.commitSha,
      artifactSha256: final.artifactSha256 ?? artifact.sha256,
      artifactStorageKey: final.artifactStorageKey ?? stored.objectKey,
      artifactSizeBytes: artifact.bytes.length,
      entryCount: artifact.entryPaths.length,
      skipped: entries.skipped,
      state: final.state,
      stateVersion: final.stateVersion,
      manifestSha256: final.manifestSha256,
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
      approvalPayload,
      approvalCostCapWei: approvalPayload === null ? null : approvalCostCapWei(approvalPayload),
    };
    console.log(JSON.stringify(result, null, 2));

    if (polled.status === "TERMINAL") {
      log(`terminal failure state=${final.state} code=${final.errorCode ?? ""}`);
      return 1;
    }
    if (polled.status === "TIMEOUT") {
      log(`timed out waiting for PLAN_READY (last state ${final.state}) deployment=${final.id}`);
      return 1;
    }
    if (fees === null) {
      log("PLAN_READY but plan_json has no fee block; refusing to report a cap");
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
      `PLAN_READY deployment=${final.id} manifest=${final.manifestSha256 ?? "(none)"} ` +
        `estimatedCostWei=${fees.estimatedCostWei} recommendedCapWei=${fees.recommendedCapWei}`,
    );
    log("next: owner signs the EIP-712 approval; this tool will not approve or execute");
    return 0;
  } finally {
    await database.close();
  }
}

async function main(): Promise<number> {
  const parsed = parseReleaseArgs(process.argv.slice(2));
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
  console.error(`tapeci mainnet-release: ${body.error.code}: ${body.error.message}`);
  if (isTapeCiError(error) && Object.keys(error.details).length > 0) {
    console.error(JSON.stringify({ details: body.error.details }));
  }
  process.exitCode = isTapeCiError(error) && error.code === "INVALID_CONFIG" ? 2 : 1;
}
