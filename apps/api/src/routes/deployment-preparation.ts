import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { containers, deployments } from "@tapeci/database";
import { createDeploymentQueues, enqueueDeployment } from "@tapeci/queue";
import { requireUser } from "../auth.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { createObjectStore } from "../object-store.js";
import { canWrite, projectAccess } from "../project-access.js";
import { recordBody, stringField } from "../validation.js";
import { parsePreparationRequest, requireCompressionGateway } from "../worker/preparation-policy.js";
import { selectReleaseStrategy } from "@tapeci/deployer";

export function registerDeploymentPreparationRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const store = deps.objectStore ?? createObjectStore(deps.env);
  async function load(id: string, userId: string) {
    const [deployment] = await deps.db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
    if (deployment === undefined) throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "deployment not found");
    const access = await projectAccess(deps.db, deployment.projectId, userId);
    if (access === null) throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "deployment not found");
    const [container] = await deps.db.select().from(containers).where(eq(containers.id, deployment.containerId)).limit(1);
    if (container === undefined) throw new ApiError(500, "INTERNAL", "deployment container missing");
    const unavailableReason = !canWrite(access.role) ? "PREPARATION_ROLE_REQUIRED"
      : access.project.isArchived ? "PROJECT_ARCHIVED"
      : !["PLAN_READY", "AWAITING_APPROVAL"].includes(deployment.state) || deployment.rollbackTargetReleaseId !== null ? "PREPARATION_STATE_LOCKED"
      : access.project.containerId !== deployment.containerId ? "PREPARATION_TARGET_CHANGED"
      : deployment.artifactStorageKey === null || deployment.artifactSha256 === null || !await store.has(deployment.artifactStorageKey) ? "SOURCE_ARTIFACT_UNAVAILABLE"
      : null;
    const gateways = (deps.env.compressionGateways ?? []).filter(profile => profile.chainId === deployment.targetChainId && profile.siteRegistry.toLowerCase() === deployment.registryAddress.toLowerCase() && profile.container.toLowerCase() === container.containerAddress.toLowerCase() && profile.serviceFeeWei === "0");
    return { deployment, access, container, unavailableReason, gateways };
  }

  app.get<{ Params: { id: string } }>("/v1/deployments/:id/preparation", async request => {
    const loaded = await load(request.params.id, requireUser(request).id);
    const preparation = parsePreparationRequest(loaded.deployment.preparation_request);
    // §15: show the recorded plan's own cost lines beside the strategy choice. These come from
    // the plan the worker already produced, so they are measurements of that plan rather than a
    // fresh estimate, and every field is a string because wei does not survive JSON as a number.
    const plan = loaded.deployment.planJson as {
      totals?: { files?: number; writes?: number; unchanged?: number; chunks?: number; bytes?: number };
      fees?: { estimatedGas?: string; estimatedCostWei?: string; recommendedCapWei?: string; costCapWei?: string; withinBudget?: boolean };
    } | null;
    const cost = plan === null || plan.totals === undefined || plan.fees === undefined ? null : {
      strategy: preparation.mode,
      physicalFiles: plan.totals.files ?? 0,
      writeFiles: plan.totals.writes ?? 0,
      reusedFiles: plan.totals.unchanged ?? 0,
      plannedBytes: plan.totals.bytes ?? 0,
      plannedChunks: plan.totals.chunks ?? 0,
      estimatedGas: plan.fees.estimatedGas ?? "0",
      estimatedCostWei: plan.fees.estimatedCostWei ?? "0",
      recommendedCapWei: plan.fees.recommendedCapWei ?? "0",
      costCapWei: plan.fees.costCapWei ?? "0",
      withinBudget: plan.fees.withinBudget ?? false,
    };
    // The gate that would let automatic selection choose compression is closed: there is no
    // production-compatible simulation yet. The rule runs anyway, so its reason is the real one
    // rather than a hardcoded constant (§15).
    const automaticSelection = selectReleaseStrategy({
      costKnown: cost !== null,
      comparison: null,
      qualification: { gatewayQualified: loaded.gateways.length > 0, productionSimulation: false },
    });
    return {
      request: preparation,
      snapshotSha256: loaded.deployment.prepared_artifact_key?.slice(7, -4) ?? null,
      manifestSha256: loaded.deployment.manifestSha256,
      canPrepare: loaded.unavailableReason === null,
      unavailableReason: loaded.unavailableReason,
      gateways: loaded.gateways.map(profile => ({ id: profile.id, origin: profile.origin, adapterSha256: profile.adapterSha256 })),
      cost,
      automaticSelection,
      quoteType: "model-estimate",
    };
  });

  app.post<{ Params: { id: string } }>("/v1/deployments/:id/preparation", async (request, reply) => {
    const user = requireUser(request);
    const loaded = await load(request.params.id, user.id);
    if (!canWrite(loaded.access.role)) throw new ApiError(403, "FORBIDDEN", "maintainer or owner role required");
    const body = recordBody(request.body);
    if (Object.keys(body).some(key => !["requestId", "preparation"].includes(key)) || body.preparation === undefined) throw new ApiError(422, "INVALID_BODY", "requestId and preparation are required");
    const requestId = stringField(body, "requestId")!;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new ApiError(422, "INVALID_IDEMPOTENCY_KEY", "requestId must be a UUID v4");
    const preparation = (() => {
      try { return parsePreparationRequest(body.preparation); }
      catch { throw new ApiError(422, "INVALID_BODY", "invalid preparation request"); }
    })();
    const sourceEventKey = `preparation:${loaded.deployment.id}:${requestId.toLowerCase()}`;
    const [previous] = await deps.db.select().from(deployments).where(eq(deployments.sourceEventKey, sourceEventKey)).limit(1);
    if (previous !== undefined && JSON.stringify(parsePreparationRequest(previous.preparation_request)) !== JSON.stringify(preparation)) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "requestId already names a different preparation");
    const gatewayAvailable = (() => {
      try {
        const gateway = requireCompressionGateway(preparation, { chainId: loaded.deployment.targetChainId, siteRegistry: loaded.deployment.registryAddress, container: loaded.container.containerAddress }, deps.env.compressionGateways ?? []);
        return gateway === null || gateway.serviceFeeWei === "0";
      } catch { return false; }
    })();
    if (previous === undefined && !gatewayAvailable) throw new ApiError(422, "INVALID_BODY", "unqualified target gateway or unsupported service fee");
    if (previous === undefined && loaded.unavailableReason !== null) throw new ApiError(409, "PLAN_STALE", loaded.unavailableReason);
    // A fresh strategy owns a fresh approval and journal. Never copy an existing pin.
    const [created] = previous === undefined ? await deps.db.insert(deployments).values({
      projectId: loaded.deployment.projectId,
      containerId: loaded.deployment.containerId,
      createdByUserId: user.id,
      triggerKind: "manual",
      commitSha: loaded.deployment.commitSha,
      state: "BUILT",
      targetChainId: loaded.deployment.targetChainId,
      registryAddress: loaded.deployment.registryAddress,
      artifactStorageKey: loaded.deployment.artifactStorageKey,
      artifactSha256: loaded.deployment.artifactSha256,
      preparation_request: preparation,
      sourceEventKey,
    }).onConflictDoNothing({ target: deployments.sourceEventKey }).returning() : [];
    const deployment = previous ?? created ?? (await deps.db.select().from(deployments).where(and(eq(deployments.sourceEventKey, sourceEventKey), eq(deployments.projectId, loaded.deployment.projectId))).limit(1))[0];
    if (deployment === undefined) throw new ApiError(500, "INTERNAL", "could not create preparation plan");
    if (JSON.stringify(parsePreparationRequest(deployment.preparation_request)) !== JSON.stringify(preparation)) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "requestId already names a different preparation");
    // Recover the existing ID even after source eligibility changes. Requeue only
    // when the separate attempt still has usable bytes and current target permission.
    const enqueueEligible = deployment.state === "BUILT" && gatewayAvailable &&
      !loaded.access.project.isArchived && loaded.access.project.containerId === deployment.containerId &&
      (deployment.prepared_artifact_key !== null || (deployment.artifactStorageKey !== null && await store.has(deployment.artifactStorageKey)));
    if (enqueueEligible) {
      const enqueue = deps.enqueuePlan ?? (async (id: string) => {
        const queues = createDeploymentQueues({ redisUrl: deps.env.redisUrl });
        try { await enqueueDeployment(queues.plan, id); } finally { await queues.close(); }
      });
      await enqueue(deployment.id);
    }
    void reply.code(202);
    return { deploymentId: deployment.id, state: deployment.state, approvalRequired: true, enqueued: enqueueEligible };
  });
}
