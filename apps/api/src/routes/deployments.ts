import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, gt, isNull } from "drizzle-orm";
import {
  approvalPolicies,
  approvals,
  chainTransactions,
  containers,
  deployments,
  deploymentEvents,
  projectBudgets,
  projectMembers,
  projects,
  releaseFiles,
  releases,
} from "@tapeci/database";
import { createDeploymentQueues, enqueueDeployment } from "@tapeci/queue";
import {
  APPROVAL_PRIMARY_TYPE,
  APPROVAL_TYPES,
  approvalDomain,
  assertOperatorAuthorized,
  createOperatorSession,
  recordApproval,
  transitionDeployment,
} from "@tapeci/queue";
import { requireUser } from "../auth.js";
import { positiveWei, recordBody, stringField } from "../validation.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { loadRecoveryCapability, requestReapproval, requestResume } from "../recovery.js";
import { verifyEip1271Signature } from "../eip1271.js";
import { monthlySpendWei, notifyDeploymentEvent, organizationBudgetStatus } from "./governance.js";
import { projectAccess } from "../project-access.js";

async function requireDeployment(
  deps: ApiDeps,
  deploymentId: string,
  userId: string,
): Promise<typeof deployments.$inferSelect> {
  const [row] = await deps.db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (row === undefined) throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "deployment not found");
  const access = await projectAccess(deps.db, row.projectId, userId);
  if (access === null) throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "deployment not found");
  return row;
}

async function projectRole(
  deps: ApiDeps,
  projectId: string,
  userId: string,
): Promise<string> {
  const [row] = await deps.db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return row?.role ?? "member";
}

function roleSatisfies(actual: string, required: string): boolean {
  const rank: Record<string, number> = { member: 1, maintainer: 2, owner: 3 };
  return (rank[actual] ?? 0) >= (rank[required] ?? 3);
}

function deploymentDto(row: typeof deployments.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    containerId: row.containerId,
    triggerKind: row.triggerKind,
    commitSha: row.commitSha,
    state: row.state,
    stateVersion: row.stateVersion,
    artifactSha256: row.artifactSha256,
    manifestSha256: row.manifestSha256,
    estimatedCostWei: row.estimatedCostWei,
    approvedCostCapWei: row.approvedCostCapWei,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    requestedAt: row.requestedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    hasPlan: row.planJson !== null,
  };
}

export function registerDeploymentRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/v1/deployments", async (request) => {
    const user = requireUser(request);
    const query = request.query as {
      projectId?: string;
      state?: string;
      limit?: string;
      page?: string;
      pageSize?: string;
      sort?: string;
      dir?: string;
    };

    // `limit` predates paging and stays supported: it maps to pageSize when
    // pageSize is absent, so existing callers keep their contract.
    // `Number("0") || 50` would silently turn an explicit 0 into the default 50,
    // so parse first and only fall back when the value is absent or not finite.
    const parseBounded = (raw: string | undefined, fallback: number, min: number, max: number): number => {
      if (raw === undefined) return fallback;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(Math.max(Math.trunc(parsed), min), max);
    };
    const pageSize = parseBounded(query.pageSize ?? query.limit, 50, 1, 200);
    const page = parseBounded(query.page, 1, 1, Number.MAX_SAFE_INTEGER);

    const SORT_COLUMNS = {
      requestedAt: deployments.requestedAt,
      state: deployments.state,
      project: projects.repoFullName,
    } as const;
    type SortKey = keyof typeof SORT_COLUMNS;
    const requestedSort = query.sort ?? "requestedAt";
    if (!Object.prototype.hasOwnProperty.call(SORT_COLUMNS, requestedSort)) {
      throw new ApiError(400, "INVALID_QUERY", `sort must be one of ${Object.keys(SORT_COLUMNS).join(", ")}`);
    }
    const sortKey = requestedSort as SortKey;
    const dir = query.dir ?? "desc";
    if (dir !== "asc" && dir !== "desc") {
      throw new ApiError(400, "INVALID_QUERY", "dir must be asc or desc");
    }

    const conditions = [eq(projectMembers.userId, user.id)];
    if (query.projectId !== undefined) conditions.push(eq(deployments.projectId, query.projectId));
    if (query.state !== undefined) {
      conditions.push(eq(deployments.state, query.state as typeof deployments.$inferSelect.state));
    }
    const where = and(...conditions);

    const rows = await deps.db
      .select({ deployment: deployments })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.projectId))
      .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .where(where)
      .orderBy(dir === "asc" ? asc(SORT_COLUMNS[sortKey]) : desc(SORT_COLUMNS[sortKey]))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    // The total MUST use the same FROM/JOIN/WHERE as the page query: counting
    // without the membership join would disclose deployments the caller cannot
    // read, and counting without the filters would disagree with the page.
    const [counted] = await deps.db
      .select({ value: count() })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.projectId))
      .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .where(where);
    const total = counted?.value ?? 0;
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);

    return {
      deployments: rows.map((row) => deploymentDto(row.deployment)),
      page,
      pageSize,
      total,
      totalPages,
    };
  });

  app.get("/v1/deployments/:id", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "deployment id is required");
    const deployment = await requireDeployment(deps, params.id, user.id);
    const [files, transactions] = await Promise.all([
      deps.db
        .select()
        .from(releaseFiles)
        .where(eq(releaseFiles.deploymentId, deployment.id))
        .orderBy(asc(releaseFiles.targetPath)),
      deps.db
        .select()
        .from(chainTransactions)
        .where(eq(chainTransactions.deploymentId, deployment.id))
        .orderBy(asc(chainTransactions.createdAt)),
    ]);
    return {
      deployment: {
        ...deploymentDto(deployment),
        releaseFiles: files,
        chainTransactions: transactions,
      },
    };
  });

  app.get("/v1/deployments/:id/events", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "deployment id is required");
    await requireDeployment(deps, params.id, user.id);
    const query = request.query as { after?: string };
    const after = Number(query.after ?? "0");
    const conditions = [eq(deploymentEvents.deploymentId, params.id)];
    if (Number.isSafeInteger(after) && after > 0) conditions.push(gt(deploymentEvents.id, after));
    const rows = await deps.db
      .select()
      .from(deploymentEvents)
      .where(and(...conditions))
      .orderBy(asc(deploymentEvents.id))
      .limit(500);
    return {
      events: rows.map((row) => ({
        id: row.id,
        oldState: row.oldState,
        newState: row.newState,
        eventType: row.eventType,
        actorKind: row.actorKind,
        actorId: row.actorId,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  app.get("/v1/deployments/:id/plan", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "deployment id is required");
    const deployment = await requireDeployment(deps, params.id, user.id);
    if (deployment.planJson === null) {
      throw new ApiError(409, "PLAN_NOT_READY", "this deployment has no plan yet");
    }
    return { deploymentId: deployment.id, plan: deployment.planJson };
  });

  app.get("/v1/deployments/:id/verification", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "deployment id is required");
    const deployment = await requireDeployment(deps, params.id, user.id);
    let [release] = await deps.db
      .select()
      .from(releases)
      .where(eq(releases.deploymentId, params.id))
      .limit(1);
    // A rollback does not create a new release row: it re-verifies and re-activates
    // the target release. Surface that report instead of a misleading 409.
    if (release === undefined && deployment.rollbackTargetReleaseId !== null) {
      [release] = await deps.db
        .select()
        .from(releases)
        .where(eq(releases.id, deployment.rollbackTargetReleaseId))
        .limit(1);
    }
    if (release === undefined) {
      throw new ApiError(409, "VERIFICATION_NOT_READY", "no verification report for this deployment");
    }
    return {
      deploymentId: params.id,
      releaseId: release.releaseId,
      rollbackTargetReleaseId: deployment.rollbackTargetReleaseId,
      verifyReport: release.verifyReport,
    };
  });

  app.get("/v1/deployments/:id/approval-payload", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "deployment id is required");
    const deployment = await requireDeployment(deps, params.id, user.id);
    const manifestHash = deployment.manifestSha256;
    if (manifestHash === null || deployment.planJson === null) {
      throw new ApiError(409, "PLAN_NOT_READY", "the deployment has no signed plan yet");
    }
    const [container] = await deps.db
      .select()
      .from(containers)
      .where(eq(containers.id, deployment.containerId))
      .limit(1);
    if (container === undefined) throw new ApiError(500, "INTERNAL", "deployment container missing");
    const plan = deployment.planJson as { fees?: { recommendedCapWei?: unknown } };
    const recommended = plan.fees?.recommendedCapWei;
    const recommendedCapWei =
      typeof recommended === "string" || typeof recommended === "number"
        ? BigInt(recommended)
        : (deployment.approvedCostCapWei === null ? 0n : BigInt(deployment.approvedCostCapWei));
    const [policy] = await deps.db
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.projectId, deployment.projectId))
      .limit(1);
    // The signed cap must bind: never exceed the project policy ceiling. Without a
    // policy the recommendation (estimate + margin) is the only ceiling.
    const policyCapWei =
      policy?.maxCostCapWei === null || policy?.maxCostCapWei === undefined
        ? null
        : BigInt(policy.maxCostCapWei);
    const costCapWei = String(
      policyCapWei === null || recommendedCapWei < policyCapWei ? recommendedCapWei : policyCapWei,
    );
    const nonce = randomUUID();
    const expiresAt = String(
      Math.floor(Date.now() / 1000) + (policy?.expiresInSeconds ?? 900),
    );
    return {
      // Same helpers the verifier uses, so the handed-out typed data cannot drift
      // from what `recordApproval` recomputes (name/version/chainId 196/registry).
      domain: approvalDomain({ verifyingContract: deployment.registryAddress }),
      types: APPROVAL_TYPES,
      primaryType: APPROVAL_PRIMARY_TYPE,
      message: {
        deploymentId: deployment.id,
        manifestHash,
        container: container.containerAddress,
        costCapWei,
        nonce,
        expiresAt,
      },
      approval: {
        manifestHash,
        container: container.containerAddress,
        costCapWei,
        nonce,
        expiresAt,
      },
      expectedSigner: container.lastObservedOwner,
    };
  });

  /**
   * SPEC §12.2: the only reapproval entry point. It never signs, never executes and
   * never enqueues — it opens a fresh approval window for the same recoverable plan
   * and reports the resulting attempt. A refusal carries the capability that explains
   * it so the UI can show why instead of offering a dead button.
   */
  app.post("/v1/deployments/:id/reapproval", async (request, reply) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "deployment id is required");
    const result = await requestReapproval(deps, {
      deploymentId: params.id,
      userId: user.id,
    });
    if (result.kind === "blocked") {
      void reply.code(409);
      return {
        blocked: true,
        state: result.state,
        capability: result.capability,
      };
    }
    void reply.code(result.created ? 201 : 200);
    return {
      blocked: false,
      created: result.created,
      // A continuation attempt gets its own id; the UI must approve THAT one.
      deploymentId: result.deploymentId,
      supersededDeploymentId: result.supersededDeploymentId,
      state: result.state,
      stateVersion: result.stateVersion,
      revokedApprovals: result.revokedApprovals,
      previousAttemptRetired: result.previousAttemptRetired,
    };
  });

  /**
   * SPEC §12.3: public resume entry. It validates the original attempt and hands the
   * existing worker/journal recovery the job — it does not write to chain itself and
   * cannot plan, because the plan comes from the stored recovery context.
   * 202 means "requested", not "resumed": the worker still has to do the work.
   */
  app.post("/v1/deployments/:id/resume", async (request, reply) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "deployment id is required");
    const result = await requestResume(deps, { deploymentId: params.id, userId: user.id });
    if (result.kind === "blocked") {
      void reply.code(409);
      return { blocked: true, state: result.state, capability: result.capability };
    }
    void reply.code(202);
    return { blocked: false, requested: true, deploymentId: result.deploymentId };
  });

  /**
   * SPEC §12.2/§12.3 + AC-P6-17: the server states what it will actually accept, so the
   * UI never derives a button from the state string. The recovery capability comes from
   * the same pure function the reapproval/resume routes enforce, so a rendered button and
   * an accepted request cannot disagree.
   */
  app.get("/v1/deployments/:id/capabilities", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "deployment id is required");
    const deployment = await requireDeployment(deps, params.id, user.id);
    const recovery = await loadRecoveryCapability(deps, {
      deploymentId: params.id,
      userId: user.id,
    });
    const canExecute = deployment.state === "APPROVED";
    const canRollback = deployment.state === "LIVE";
    return {
      state: deployment.state,
      // The browser build holds no keys, so it can never produce an EIP-712 approval.
      canApprove: false,
      canExecute,
      canRollback,
      canResume: recovery.capability.action === "resume",
      canReapprove: recovery.capability.action === "reapproval",
      reasons: {
        approve:
          "EIP-712 wallet signing is not wired into the browser console yet. Approve with the CLI or the wallet integration.",
        execute: canExecute
          ? "Approved. Execute enqueues the deploy worker; the browser never signs."
          : "Execution requires an approved EIP-712 approval.",
        rollback: canRollback
          ? "Creates a rollback deployment in AWAITING_APPROVAL."
          : "Rollback is available for a Live deployment with a current release.",
        resume: recovery.capability.action === "resume" ? recovery.capability.reason : null,
        reapprove:
          recovery.capability.action === "reapproval" ? recovery.capability.reason : null,
      },
      /** Why nothing can be done, when the server offers no action at all. */
      blockedReason:
        recovery.capability.action === "none" ? recovery.capability.reason : null,
    };
  });

  app.post("/v1/deployments/:id/approve", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "deployment id is required");
    let deployment = await requireDeployment(deps, params.id, user.id);
    const manifestSha256 = deployment.manifestSha256;
    if (manifestSha256 === null) {
      throw new ApiError(409, "PLAN_NOT_READY", "deployment has no manifest to approve yet");
    }
    const body = recordBody(request.body);
    const approvalBody = body.approval;
    if (typeof approvalBody !== "object" || approvalBody === null) {
      throw new ApiError(400, "INVALID_BODY", "approval payload is required");
    }
    const approval = approvalBody as Record<string, unknown>;
    const signerAddress = stringField(body, "signerAddress") as string;
    const signature = stringField(body, "signature") as `0x${string}`;
    const [container] = await deps.db
      .select()
      .from(containers)
      .where(eq(containers.id, deployment.containerId))
      .limit(1);
    if (container === undefined) throw new ApiError(500, "INTERNAL", "deployment container missing");
    if (
      container.lastObservedOwner === null ||
      signerAddress.toLowerCase() !== container.lastObservedOwner.toLowerCase()
    ) {
      throw new ApiError(
        403,
        "NOT_CURRENT_OWNER",
        "the approval must be signed by the current container owner",
      );
    }

    if (deployment.state === "PLAN_READY") {
      deployment = await transitionDeployment(deps.db, {
        deploymentId: deployment.id,
        expectedVersion: deployment.stateVersion,
        toState: "AWAITING_APPROVAL",
        eventType: "approval_requested",
        actorKind: "user",
        actorId: user.id,
      });
    }
    if (deployment.state !== "AWAITING_APPROVAL") {
      throw new ApiError(409, "APPROVAL_REQUIRED", `deployment is ${deployment.state}, not awaiting approval`);
    }

    const role = await projectRole(deps, deployment.projectId, user.id);
    const [policy] = await deps.db
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.projectId, deployment.projectId))
      .limit(1);
    const requiredRole = policy?.requiredRole ?? "owner";
    if (!roleSatisfies(role, requiredRole)) {
      throw new ApiError(403, "APPROVAL_POLICY_ROLE", `approval requires the ${requiredRole} role`);
    }
    const estimated = BigInt(deployment.estimatedCostWei ?? "0");
    if (policy?.maxCostCapWei !== null && policy?.maxCostCapWei !== undefined) {
      if (estimated > BigInt(policy.maxCostCapWei)) {
        throw new ApiError(409, "APPROVAL_POLICY_CAP", "estimated cost exceeds the project approval policy cap");
      }
    }
    const requestedCap = positiveWei(approval.costCapWei ?? "0", "approval.costCapWei");
    if (policy?.maxCostCapWei !== null && policy?.maxCostCapWei !== undefined && requestedCap > BigInt(policy.maxCostCapWei)) {
      throw new ApiError(409, "APPROVAL_POLICY_CAP", "approval cost cap exceeds the project approval policy cap");
    }
    const requestedExpiry = positiveWei(approval.expiresAt ?? "0", "approval.expiresAt");
    const maxExpiry = BigInt(Math.floor(Date.now() / 1000) + (policy?.expiresInSeconds ?? 900));
    if (requestedExpiry <= BigInt(Math.floor(Date.now() / 1000)) || requestedExpiry > maxExpiry) {
      throw new ApiError(409, "APPROVAL_POLICY_EXPIRY", "approval expiry exceeds the project approval policy");
    }
    const [budget] = await deps.db
      .select()
      .from(projectBudgets)
      .where(eq(projectBudgets.projectId, deployment.projectId))
      .limit(1);
    if (budget?.monthlyCapWei !== null && budget?.monthlyCapWei !== undefined) {
      const spent = await monthlySpendWei(deps, deployment.projectId);
      if (spent + estimated > BigInt(budget.monthlyCapWei)) {
        throw new ApiError(409, "BUDGET_EXCEEDED", "monthly project budget would be exceeded");
      }
    }
    const [projectRow] = await deps.db
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, deployment.projectId))
      .limit(1);
    if (projectRow?.organizationId !== null && projectRow?.organizationId !== undefined) {
      const orgBudget = await organizationBudgetStatus(deps, projectRow.organizationId);
      if (orgBudget.capWei !== null && orgBudget.spentWei + estimated > orgBudget.capWei) {
        throw new ApiError(409, "ORGANIZATION_BUDGET_EXCEEDED", "organization monthly budget would be exceeded");
      }
    }
    const contractSignatureVerifier = async (input: {
      readonly digest: `0x${string}`;
      readonly signature: `0x${string}`;
      readonly signerAddress: `0x${string}`;
    }): Promise<boolean> => {
      if (deps.verifyContractSignature !== undefined) {
        return deps.verifyContractSignature(input);
      }
      return verifyEip1271Signature(input);
    };
    const recorded = await recordApproval(deps.db, {
      deploymentId: deployment.id,
      contractSignatureVerifier,
      manifestSha256,
      containerAddress: container.containerAddress,
      registryAddress: deployment.registryAddress,
      signerAddress,
      signature,
      approval: {
        deploymentId: deployment.id,
        manifestHash: (stringField(approval, "manifestHash") ?? manifestSha256) as `0x${string}`,
        container: (stringField(approval, "container") ?? container.containerAddress) as `0x${string}`,
        costCapWei: requestedCap,
        nonce: stringField(approval, "nonce") as string,
        expiresAt: requestedExpiry,
      },
      ...(body.digest === undefined ? {} : { digest: stringField(body, "digest") as `0x${string}` }),
      ...(body.userCostCapWei === undefined
        ? {}
        : { userCostCapWei: positiveWei(body.userCostCapWei, "userCostCapWei") }),
    });
    const session = await createOperatorSession(deps.db, {
      containerId: deployment.containerId,
      signerAddress,
      approvalId: recorded.id,
      ttlSeconds: 3_600,
    });
    await deps.db
      .update(deployments)
      .set({
        approvedCostCapWei: recorded.approvedCostCapWei,
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, deployment.id));
    const approved = await transitionDeployment(deps.db, {
      deploymentId: deployment.id,
      expectedVersion: deployment.stateVersion,
      toState: "APPROVED",
      eventType: "approval_recorded",
      actorKind: "user",
      actorId: user.id,
      payload: { approvalId: recorded.id, operatorSessionId: session.id },
    });
    void notifyDeploymentEvent(
      deps,
      deployment.projectId,
      `TapeCI: ${approved.id} approved (${approved.state})`,
    );
    return {
      deploymentId: approved.id,
      state: approved.state,
      stateVersion: approved.stateVersion,
      approval: {
        id: recorded.id,
        digest: recorded.approvalDigest,
        costCapWei: recorded.approvedCostCapWei,
        expiresAt: recorded.expiresAt.toISOString(),
      },
      operatorSession: {
        id: session.id,
        signerAddress: session.signerAddress,
        expiresAt: session.expiresAt.toISOString(),
      },
    };
  });

  app.post("/v1/deployments/:id/execute", async (request, reply) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "deployment id is required");
    const deployment = await requireDeployment(deps, params.id, user.id);
    if (deployment.state !== "APPROVED") {
      throw new ApiError(409, "APPROVAL_REQUIRED", `deployment is ${deployment.state}, not APPROVED`);
    }
    const now = new Date();
    const [approval] = await deps.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.deploymentId, deployment.id),
          isNull(approvals.revokedAt),
          gt(approvals.expiresAt, now),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(1);
    if (approval === undefined) {
      throw new ApiError(403, "APPROVAL_EXPIRED", "no active approval for this deployment");
    }
    await assertOperatorAuthorized(deps.db, {
      containerId: deployment.containerId,
      signerAddress: approval.signerAddress,
      now,
    });
    const enqueue =
      deps.enqueueDeployment ??
      (async (deploymentId: string): Promise<void> => {
        const queues = createDeploymentQueues({ redisUrl: deps.env.redisUrl });
        try {
          await enqueueDeployment(queues.deploy, deploymentId);
        } finally {
          await queues.close();
        }
      });
    const [budget] = await deps.db
      .select()
      .from(projectBudgets)
      .where(eq(projectBudgets.projectId, deployment.projectId))
      .limit(1);
    if (budget?.monthlyCapWei !== null && budget?.monthlyCapWei !== undefined) {
      const spent = await monthlySpendWei(deps, deployment.projectId);
      if (spent > BigInt(budget.monthlyCapWei)) {
        throw new ApiError(409, "BUDGET_EXCEEDED", "monthly project budget is already exhausted");
      }
    }
    const [projectRow] = await deps.db
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, deployment.projectId))
      .limit(1);
    if (projectRow?.organizationId !== null && projectRow?.organizationId !== undefined) {
      const orgBudget = await organizationBudgetStatus(deps, projectRow.organizationId);
      if (orgBudget.capWei !== null && orgBudget.spentWei > orgBudget.capWei) {
        throw new ApiError(409, "ORGANIZATION_BUDGET_EXCEEDED", "organization monthly budget is already exhausted");
      }
    }
    await enqueue(deployment.id);
    void notifyDeploymentEvent(deps, deployment.projectId, `TapeCI: ${deployment.id} queued for execution`);
    void reply.code(202);
    return { enqueued: true, deploymentId: deployment.id, queue: "deploy" };
  });
}
