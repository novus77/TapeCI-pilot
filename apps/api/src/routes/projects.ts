import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  buildAttempts,
  artifactUploads,
  containers,
  deployments,
  githubInstallations,
  projectMembers,
  projects,
  releases,
} from "@tapeci/database";
import { XLAYER_MAINNET } from "@tapeci/config";
import { dispatchDeploymentBuild } from "../build-dispatch.js";
import { readBindingState } from "../binding.js";
import {
  createGatewayProbe,
  loadPublicationSummary,
  TAPEKIT_GATEWAY_HOST_SUFFIX,
} from "../publication.js";
import { evaluateReadiness, type Readiness } from "../projects/readiness.js";
import { openerAbi, type ReadClient } from "@tapeci/chain";
import { createOperatorClients } from "@tapeci/verifier";
import type { Hex } from "@tapeci/shared";
import { requireUser } from "../auth.js";
import type { ApiDeps, ResolvedContainer } from "../deps.js";
import { ApiError } from "../errors.js";
import { integerField, recordBody, stringField } from "../validation.js";
import { resolveContainerOnChain } from "../container-resolver.js";
import { assertInstallationAccess, listInstallationsForUser } from "../github-app.js";
import { accessibleProjectIds, canWrite, projectAccess } from "../project-access.js";
import { parsePreparationRequest } from "../worker/preparation-policy.js";

/** `versioned` (default) or `root`; anything else is a client error. */
function pathModeField(body: Record<string, unknown>): "versioned" | "root" {
  const value = body.pathMode;
  if (value === undefined) return "versioned";
  if (value === "versioned" || value === "root") return value;
  throw new ApiError(400, "INVALID_BODY", 'pathMode must be "versioned" or "root"');
}

function projectDto(
  project: typeof projects.$inferSelect,
  container: typeof containers.$inferSelect,
): Record<string, unknown> {
  return {
    id: project.id,
    githubRepositoryId: project.githubRepositoryId,
    repoFullName: project.repoFullName,
    defaultBranch: project.defaultBranch,
    buildCommand: project.buildCommand,
    installCommand: project.installCommand,
    outputDirectory: project.outputDirectory,
    strictDewebMode: project.strictDewebMode,
    pathMode: project.pathMode,
    isArchived: project.isArchived,
    createdAt: project.createdAt.toISOString(),
    container: {
      id: container.id,
      address: container.containerAddress,
      processorIndex: container.processorIndex,
      processor: container.processorAddress,
      tokenId: container.tokenId,
      factory: container.factoryAddress,
      opener: XLAYER_MAINNET.opener,
      registry: container.registryAddress,
      binding: container.bindingAddress,
      owner: container.lastObservedOwner,
    },
  };
}

async function requireProjectMember(
  deps: ApiDeps,
  projectId: string,
  userId: string,
): Promise<typeof projects.$inferSelect> {
  const access = await projectAccess(deps.db, projectId, userId);
  if (access === null) throw new ApiError(404, "PROJECT_NOT_FOUND", "project not found");
  return access.project;
}


/** The same read-client policy the container routes use (injectable for tests). */
function readClientOf(deps: ApiDeps): ReadClient {
  const injected = deps.readClient;
  if (injected !== undefined) return injected();
  const operators = createOperatorClients(XLAYER_MAINNET);
  const primary = operators[0];
  if (primary === undefined) {
    throw new ApiError(500, "INTERNAL", "no RPC operator is configured");
  }
  return primary.client;
}

/**
 * Gather the facts `evaluateReadiness` needs for one project (SPEC §11.1).
 *
 * Facts this cannot know are passed as `null`/`unknown` rather than guessed: a `null` keeps
 * the gate closed without claiming the check failed, which is the distinction §11.1 draws
 * between `unknown` and `fail`.
 */
async function readinessForProject(
  deps: ApiDeps,
  project: typeof projects.$inferSelect,
): Promise<Readiness> {
  const [row] = await deps.db
    .select({ containerAddress: containers.containerAddress })
    .from(containers)
    .where(eq(containers.id, project.containerId))
    .limit(1);

  // §11.1: `static_output` is legitimately unknown before the first build, so it must not
  // block enabling or the first start — only publishing.
  const [built] = await deps.db
    .select({ id: releases.id })
    .from(releases)
    .where(eq(releases.projectId, project.id))
    .limit(1);

  return evaluateReadiness({
    repositoryAccess: true,
    installationActive: true,
    buildConfigComplete:
      project.installCommand.trim().length > 0 &&
      project.buildCommand.trim().length > 0 &&
      project.outputDirectory.trim().length > 0,
    staticOutputObserved: built === undefined ? null : true,
    // An artifact is bound only when a release row exists for this project.
    artifactBound: built !== undefined,
    // Ownership is a release-stage fact read from chain; unknown here, never assumed.
    ownerMatches: null,
    containerOpened: null,
    pathMode: project.pathMode === "root" ? "root" : "versioned",
    // The acknowledgement lives on the draft and was verified at finalisation, so a project
    // that exists with `root` has one by construction. Reading a column that does not exist
    // on `projects` would have been a compile error, which is how this was caught.
    rootPathAcknowledged: true,
    buildEnabled: project.buildEnabled,
    targetCommitLegal: true,
    workflowAvailable: row === undefined ? null : true,
  });
}

export function registerProjectRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/v1/projects", async (request) => {
    const user = requireUser(request);
    const ids = await accessibleProjectIds(deps.db, user.id);
    if (ids.length === 0) return { projects: [] };
    const rows = await deps.db
      .select({ project: projects, container: containers })
      .from(projects)
      .innerJoin(containers, eq(containers.id, projects.containerId))
      .where(inArray(projects.id, ids))
      .orderBy(desc(projects.createdAt));
    return { projects: rows.map((row) => projectDto(row.project, row.container)) };
  });

  app.post("/v1/projects", async (request, reply) => {
    const user = requireUser(request);
    const body = recordBody(request.body);
    const repoFullName = stringField(body, "repoFullName", { maxLength: 300 }) as string;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) {
      throw new ApiError(400, "INVALID_BODY", "repoFullName must look like owner/repo");
    }
    const githubRepositoryId = integerField(body, "githubRepositoryId");
    const defaultBranch = stringField(body, "defaultBranch", { optional: true }) ?? "main";
    // SPEC §2: the container is derived from the asset key, not accepted from the
    // client. `containerAddress` is kept for backwards compatibility while the
    // console migrates to the draft flow (issues P0-06 / P4-01); a client that
    // supplies an asset key must NOT also supply an address, and the derived address
    // is never taken from the request.
    const processorField = body["processor"];
    const tokenIdField = body["tokenId"];
    const suppliedAddress = body["containerAddress"];
    const hasAssetKey = processorField !== undefined || tokenIdField !== undefined;
    if (hasAssetKey && suppliedAddress !== undefined) {
      throw new ApiError(
        400,
        "INVALID_BODY",
        "supply either the asset key (processor, tokenId) or containerAddress, not both",
      );
    }
    let containerAddressRaw: string;
    if (hasAssetKey) {
      if (typeof processorField !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(processorField)) {
        throw new ApiError(400, "INVALID_BODY", "processor must be a 20-byte hex address");
      }
      // tokenId is a decimal string; never routed through Number (it can exceed 2^53).
      if (typeof tokenIdField !== "string" || !/^\d{1,78}$/.test(tokenIdField)) {
        throw new ApiError(400, "INVALID_BODY", "tokenId must be a decimal string");
      }
      const derived = await readClientOf(deps).readContract({
        address: XLAYER_MAINNET.opener,
        abi: openerAbi,
        functionName: "accountOf",
        args: [processorField.toLowerCase() as Hex, BigInt(tokenIdField)],
      });
      containerAddressRaw = String(derived);
    } else {
      if (typeof suppliedAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(suppliedAddress)) {
        throw new ApiError(
          400,
          "INVALID_BODY",
          "supply an asset key (processor, tokenId) or a 20-byte containerAddress",
        );
      }
      containerAddressRaw = suppliedAddress;
    }
    const installationId = stringField(body, "githubInstallationId", { optional: true });
    let installation: typeof githubInstallations.$inferSelect | undefined;
    if (installationId !== undefined) {
      installation = (
        await deps.db
          .select()
          .from(githubInstallations)
          .where(eq(githubInstallations.id, installationId))
          .limit(1)
      )[0];
    } else if (deps.env.devAuth) {
      // Local/test compatibility: headers are already the auth boundary.
      installation = (
        await deps.db
          .select()
          .from(githubInstallations)
          .where(isNull(githubInstallations.deletedAt))
          .orderBy(desc(githubInstallations.createdAt))
          .limit(1)
      )[0];
    } else {
      installation = (await listInstallationsForUser(deps.db, user.id))[0];
    }
    if (installation === undefined) {
      throw new ApiError(422, "REPOSITORY_NOT_AUTHORIZED", "no GitHub App installation is available");
    }
    await assertInstallationAccess(
      deps.db,
      user.id,
      installation.id,
      deps.env.devAuth,
    );
    if (installation.suspendedAt !== null || installation.deletedAt !== null) {
      throw new ApiError(409, "AUTH_REVOKED", "GitHub App installation is suspended or deleted");
    }

    const resolveContainer =
      deps.resolveContainer ??
      ((address: Hex): Promise<ResolvedContainer> => resolveContainerOnChain(address));
    const resolved = await resolveContainer(containerAddressRaw.toLowerCase() as Hex);

    const [containerRow] = await deps.db
      .insert(containers)
      .values({
        chainId: 196,
        factoryAddress: resolved.factory.toLowerCase(),
        processorIndex: resolved.processorIndex,
        processorAddress: resolved.processor.toLowerCase(),
        tokenId: resolved.tokenId,
        containerAddress: resolved.address.toLowerCase(),
        registryAddress: resolved.registry.toLowerCase(),
        bindingAddress: resolved.binding.toLowerCase(),
        lastObservedOwner: resolved.owner.toLowerCase(),
      })
      .onConflictDoUpdate({
        target: [containers.chainId, containers.containerAddress],
        set: {
          processorIndex: resolved.processorIndex,
          processorAddress: resolved.processor.toLowerCase(),
          tokenId: resolved.tokenId,
          lastObservedOwner: resolved.owner.toLowerCase(),
          updatedAt: new Date(),
        },
      })
      .returning();
    if (containerRow === undefined) throw new ApiError(500, "INTERNAL", "could not store container");

    let project: typeof projects.$inferSelect | undefined;
    try {
      [project] = await deps.db
        .insert(projects)
        .values({
          ownerUserId: user.id,
          githubInstallationId: installation.id,
          githubRepositoryId,
          repoFullName,
          defaultBranch,
          buildCommand: stringField(body, "buildCommand", { optional: true }) ?? "npm run build",
          installCommand: stringField(body, "installCommand", { optional: true }) ?? "npm ci",
          outputDirectory: stringField(body, "outputDirectory", { optional: true }) ?? "dist",
          containerId: containerRow.id,
          strictDewebMode: body.strictDewebMode !== false,
          pathMode: pathModeField(body),
        })
        .returning();
    } catch (error) {
      throw new ApiError(409, "PROJECT_EXISTS", "this repository, branch and container already have a project", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (project === undefined) throw new ApiError(500, "INTERNAL", "could not create project");
    await deps.db
      .insert(projectMembers)
      .values({ projectId: project.id, userId: user.id, role: "owner" })
      .onConflictDoNothing();
    void reply.code(201);
    return { project: projectDto(project, containerRow) };
  });

  app.get("/v1/projects/:id", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    const projectId = params.id;
    if (projectId === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const project = await requireProjectMember(deps, projectId, user.id);
    const [containerRow] = await deps.db
      .select()
      .from(containers)
      .where(eq(containers.id, project.containerId))
      .limit(1);
    if (containerRow === undefined) throw new ApiError(500, "INTERNAL", "project container missing");
    return { project: projectDto(project, containerRow) };
  });

  app.get("/v1/projects/:id/releases", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    const projectId = params.id;
    if (projectId === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    await requireProjectMember(deps, projectId, user.id);
    const rows = await deps.db
      .select()
      .from(releases)
      .where(eq(releases.projectId, projectId))
      .orderBy(desc(releases.activatedAt));
    return {
      releases: rows.map((row) => ({
        id: row.id,
        releaseId: row.releaseId,
        commitSha: row.commitSha,
        manifestSha256: row.manifestSha256,
        entrySha256: row.entrySha256,
        entryPath: row.entryPath,
        verifiedBlockNumber: row.verifiedBlockNumber,
        activatedAt: row.activatedAt.toISOString(),
        isCurrent: row.isCurrent,
      })),
    };
  });

  /**
   * SPEC §12.4: the current release, the binding, the derived public URL and the
   * gateway check — each reported as its own fact, never collapsed into one "live"
   * boolean. The client supplies only the project id: no URL is ever accepted here, so
   * no request value can choose what the server probes.
   */
  app.get("/v1/projects/:id/publication", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    const projectId = params.id;
    if (projectId === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    await requireProjectMember(deps, projectId, user.id);
    return loadPublicationSummary(
      {
        db: deps.db,
        // A pinned constant, not configuration from the request.
        gatewayHostSuffix: TAPEKIT_GATEWAY_HOST_SUFFIX,
        probeGateway: createGatewayProbe(),
        now: () => new Date(),
        readBinding: async ({ containerAddress, name }) => {
          try {
            const live = await readBindingState(
              readClientOf(deps),
              containerAddress as Hex,
              name,
            );
            const containerLive = live.isContainerLive;
            const paidUntilSeconds = Math.max(live.paidUntil, live.containerPaidUntil);
            return {
              status: "verified",
              // Either level being live means the name resolves; the two levels stay
              // distinguishable in the chain read even though the summary shows one.
              isLive: live.isLive || containerLive,
              paidUntil: paidUntilSeconds === 0 ? null : new Date(paidUntilSeconds * 1000),
            };
          } catch (error) {
            // A failed read is "unknown", never "expired": the summary must not turn an
            // unreachable RPC into a negative fact about the user's site.
            return {
              status: "unavailable",
              reason: error instanceof Error ? error.message : "binding read failed",
            };
          }
        },
      },
      { projectId },
    );
  });

  /**
   * SPEC §7.4: the readiness verdict the console needs, with each check's own
   * code/stage/status/reason so the UI never has to re-derive a gate. The three aggregates
   * are returned separately — §11.1 forbids collapsing them into one boolean.
   */
  app.get("/v1/projects/:id/readiness", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    const projectId = params.id;
    if (projectId === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const project = await requireProjectMember(deps, projectId, user.id);
    const readiness = await readinessForProject(deps, project);
    return {
      canEnableBuild: readiness.canEnableBuild,
      canStartBuild: readiness.canStartBuild,
      canPublish: readiness.canPublish,
      checks: readiness.items.map((item) => ({
        code: item.id,
        stage: item.stage,
        status: item.state,
        reason: item.reason,
      })),
    };
  });

  /**
   * SPEC §7.4 `PATCH /v1/projects/:id/build-settings`.
   *
   * This is the contract's name for enabling builds. `POST .../enable-build` remains as a
   * compatibility alias because the console and the fork pipeline already call it; both go
   * through the same readiness gate, so they cannot disagree.
   */
  app.patch("/v1/projects/:id/build-settings", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    const projectId = params.id;
    if (projectId === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const access = await projectAccess(deps.db, projectId, user.id);
    if (access === null) throw new ApiError(404, "PROJECT_NOT_FOUND", "project not found");
    if (!canWrite(access.role)) {
      throw new ApiError(403, "PROJECT_ROLE_REQUIRED", "this project does not allow you to change build settings");
    }
    const body = recordBody(request.body);
    if (typeof body["enabled"] !== "boolean") {
      throw new ApiError(422, "INVALID_BODY", "enabled must be a boolean");
    }
    const expectedConfigVersion = body["expectedConfigVersion"];
    if (
      expectedConfigVersion !== undefined &&
      (typeof expectedConfigVersion !== "number" || !Number.isSafeInteger(expectedConfigVersion))
    ) {
      throw new ApiError(422, "INVALID_BODY", "expectedConfigVersion must be an integer");
    }
    const project = await requireProjectMember(deps, projectId, user.id);
    if (expectedConfigVersion !== undefined && expectedConfigVersion !== project.configVersion) {
      // A settings write against a config the caller has not seen would silently revert a
      // change made in another tab.
      throw new ApiError(409, "DRAFT_CHANGED", "the project configuration changed since it was loaded", {
        expectedConfigVersion,
        currentConfigVersion: project.configVersion,
      });
    }
    if (body["enabled"] === false) {
      // Disabling is always allowed: it only ever removes an ability.
      const [updated] = await deps.db
        .update(projects)
        .set({ buildEnabled: false, updatedAt: new Date() })
        .where(eq(projects.id, projectId))
        .returning();
      if (updated === undefined) throw new ApiError(404, "PROJECT_NOT_FOUND", "project not found");
      return { project: { id: updated.id, buildEnabled: updated.buildEnabled } };
    }
    if (project.buildEnabled) {
      // Idempotent: enabling an enabled project is not an error.
      return { project: { id: project.id, buildEnabled: true } };
    }
    const readiness = await readinessForProject(deps, project);
    if (!readiness.canEnableBuild) {
      throw new ApiError(
        409,
        "BUILD_NOT_ENABLEABLE",
        "this project cannot enable builds yet; fix the configuration checks first",
        {
          checks: readiness.items
            .filter((item) => item.stage === "configuration" && item.state !== "pass")
            .map((item) => ({ code: item.id, status: item.state, reason: item.reason })),
        },
      );
    }
    const [enabled] = await deps.db
      .update(projects)
      .set({ buildEnabled: true, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    if (enabled === undefined) throw new ApiError(404, "PROJECT_NOT_FOUND", "project not found");
    return { project: { id: enabled.id, buildEnabled: enabled.buildEnabled } };
  });

  /**
   * SPEC §7.4 `POST /v1/projects/:id/builds`.
   *
   * The attempt is (project, commit) scoped: a deployment must already exist for that
   * commit, because the deployment is what admission created. This endpoint triggers the
   * dispatch for it — it never invents a deployment, and it never lets a caller name a
   * workflow revision (that identity is resolved server-side, §11.3).
   */
  app.post("/v1/projects/:id/builds", async (request, reply) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const project = await requireProjectMember(deps, params.id, user.id);
    const body = recordBody(request.body);
    const commitSha = stringField(body, "commitSha");
    if (typeof commitSha !== "string" || !/^[0-9a-fA-F]{40}$/.test(commitSha)) {
      throw new ApiError(422, "INVALID_BODY", "commitSha must be a 40-character commit sha");
    }
    if (!project.buildEnabled) {
      // §11.2: never dispatch for a project that has not enabled builds.
      throw new ApiError(409, "BUILD_DISABLED", "builds are not enabled for this project");
    }
    const [deployment] = await deps.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.projectId, project.id), eq(deployments.commitSha, commitSha.toLowerCase())))
      .orderBy(desc(deployments.requestedAt))
      .limit(1);
    if (deployment === undefined) {
      // The push created no deployment for this commit (not admitted, or never pushed).
      throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "no deployment exists for this commit");
    }
    const outcome = await dispatchDeploymentBuild(
      { db: deps.db },
      { deploymentId: deployment.id },
    );
    void reply.code(202);
    return {
      deploymentId: deployment.id,
      outcome: outcome.kind,
      ...(outcome.kind === "dispatched" ? { attemptId: outcome.attemptId } : {}),
      ...(outcome.kind === "skipped" ? { reason: outcome.reason, detail: outcome.detail } : {}),
      ...(outcome.kind === "unknown" ? { detail: outcome.detail } : {}),
    };
  });

  /**
   * SPEC §7.4 `GET /v1/projects/:id/builds/:attemptId` — the attempt's own state, scoped to
   * the project so a member cannot read another project's attempt by guessing an id.
   */
  app.get("/v1/projects/:id/builds/:attemptId", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string; attemptId?: string };
    if (params.id === undefined || params.attemptId === undefined) {
      throw new ApiError(400, "INVALID_PATH", "project id and attempt id are required");
    }
    const project = await requireProjectMember(deps, params.id, user.id);
    const [row] = await deps.db
      .select({
        attempt: buildAttempts,
        deploymentId: deployments.id,
        commitSha: deployments.commitSha,
      })
      .from(buildAttempts)
      .innerJoin(deployments, eq(deployments.id, buildAttempts.deploymentId))
      .where(and(eq(deployments.projectId, project.id), eq(buildAttempts.id, params.attemptId)))
      .limit(1);
    if (row === undefined) {
      throw new ApiError(404, "ATTEMPT_NOT_FOUND", "build attempt not found");
    }
    return {
      attemptId: row.attempt.id,
      deploymentId: row.deploymentId,
      state: row.attempt.state,
      attempt: row.attempt.attempt,
      retryOf: row.attempt.retryOf,
      // §11.3: the two identities stay separate in the response too.
      commitSha: row.attempt.commitSha,
      workflowCommitSha: row.attempt.workflowCommitSha,
      configVersion: row.attempt.configVersion,
      createdAt: row.attempt.createdAt.toISOString(),
      finishedAt: row.attempt.finishedAt === null ? null : row.attempt.finishedAt.toISOString(),
    };
  });

  /**
   * §11.1/§11.2: enabling builds is an explicit act, and `canEnableBuild` is what
   * authorizes it. Without this route a project could never become admitted, so the
   * admission gate would refuse every push forever.
   */
  app.post("/v1/projects/:id/enable-build", async (request) => {
    const user = requireUser(request);
    const body = recordBody(request.body);
    const params = request.params as { id?: string };
    const projectId = params.id;
    if (projectId === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const [row] = await deps.db
      .select({ project: projects, container: containers })
      .from(projects)
      .innerJoin(containers, eq(projects.containerId, containers.id))
      .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projects.id, projectId), eq(projectMembers.userId, user.id)))
      .limit(1);
    if (row === undefined) throw new ApiError(404, "PROJECT_NOT_FOUND", "project not found");
    if (row.project.buildEnabled) {
      // Idempotent: enabling an enabled project is not an error.
      return { project: projectDto(row.project, row.container) };
    }
    // Enabling is a configuration-stage decision. The facts that can be known without
    // a build are the ones this endpoint can check; `static_output` is deliberately not
    // required here (§11.1 allows it to be unknown before the first build).
    const acknowledged =
      typeof body["rootPathAcknowledged"] === "boolean" ? body["rootPathAcknowledged"] : false;
    const readiness = evaluateReadiness({
      repositoryAccess: true,
      installationActive: true,
      buildConfigComplete: true,
      staticOutputObserved: null,
      artifactBound: false,
      ownerMatches: null,
      containerOpened: null,
      pathMode: row.project.pathMode === "root" ? "root" : "versioned",
      rootPathAcknowledged: acknowledged,
      buildEnabled: false,
      targetCommitLegal: true,
      workflowAvailable: true,
    });
    if (!readiness.canEnableBuild) {
      throw new ApiError(
        409,
        "BUILD_NOT_ENABLEABLE",
        "this project cannot enable builds yet; fix the configuration checks first",
        {
          checks: readiness.items
            .filter((item) => item.stage === "configuration" && item.state !== "pass")
            .map((item) => ({ id: item.id, state: item.state, reason: item.reason })),
        },
      );
    }
    const [updated] = await deps.db
      .update(projects)
      .set({ buildEnabled: true, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    if (updated === undefined) throw new ApiError(404, "PROJECT_NOT_FOUND", "project not found");
    // Re-read the container so the DTO matches what a GET would return.
    const [container] = await deps.db
      .select()
      .from(containers)
      .where(eq(containers.id, updated.containerId))
      .limit(1);
    if (container === undefined) {
      throw new ApiError(500, "INTERNAL", "the project's container is missing");
    }
    return { project: projectDto(updated, container) };
  });

  app.post("/v1/projects/:id/rollback", async (request, reply) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const access = await projectAccess(deps.db, params.id, user.id);
    if (access === null) throw new ApiError(404, "PROJECT_NOT_FOUND", "project not found");
    if (!canWrite(access.role)) throw new ApiError(403, "FORBIDDEN", "viewer/member cannot create rollback deployments");
    const project = access.project;
    if (project.isArchived) {
      throw new ApiError(409, "PROJECT_ARCHIVED", "archived projects cannot create rollback deployments");
    }
    const body = recordBody(request.body);
    const releaseId = stringField(body, "releaseId") as string;
    const [release] = await deps.db
      .select()
      .from(releases)
      .where(and(eq(releases.projectId, project.id), eq(releases.releaseId, releaseId)))
      .limit(1);
    if (release === undefined) {
      throw new ApiError(404, "RELEASE_NOT_FOUND", `release ${releaseId} is not stored for this project`);
    }
    const [containerRow] = await deps.db
      .select()
      .from(containers)
      .where(eq(containers.id, project.containerId))
      .limit(1);
    if (containerRow === undefined) throw new ApiError(500, "INTERNAL", "project container missing");
    const [targetDeployment] = await deps.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, release.deploymentId))
      .limit(1);
    if (targetDeployment === undefined) {
      throw new ApiError(500, "INTERNAL", "release target deployment missing");
    }
    // A compressed release can only be restored from its frozen snapshot. Decide that first: the
    // snapshot is self-contained, so a pinned row must be restorable even when its raw artifact
    // key and upload rows are gone (Stage C review F3). Checking the raw key first would reject
    // exactly those rows with the wrong reason.
    const targetPreparation = parsePreparationRequest(targetDeployment.preparation_request);
    const targetPinned = targetDeployment.prepared_artifact_key !== null;
    if (targetPreparation.mode !== "original" && !targetPinned) {
      throw new ApiError(
        409,
        "PREPARED_ARTIFACT_UNAVAILABLE",
        "this release was prepared with compression but has no frozen artifact to restore; it cannot be rolled back",
        { releaseId, reason: "prepared_artifact_missing" },
      );
    }
    let artifactStorageKey = targetDeployment.artifactStorageKey;
    if (artifactStorageKey === null) {
      const [upload] = await deps.db
        .select()
        .from(artifactUploads)
        .where(eq(artifactUploads.deploymentId, targetDeployment.id))
        .orderBy(desc(artifactUploads.createdAt))
        .limit(1);
      artifactStorageKey = upload?.objectKey ?? null;
    }
    if (artifactStorageKey === null && !targetPinned) {
      throw new ApiError(409, "ARTIFACT_UNAVAILABLE", "the target release artifact is no longer stored");
    }
    const sourceEventKey = `rollback:${release.id}`;
    const [created] = await deps.db
      .insert(deployments)
      .values({
        projectId: project.id,
        containerId: project.containerId,
        createdByUserId: user.id,
        triggerKind: "rollback",
        commitSha: release.commitSha,
        state: "PLAN_READY",
        registryAddress: containerRow.registryAddress,
        sourceEventKey,
        rollbackTargetReleaseId: release.id,
        artifactStorageKey,
        prepared_artifact_key: targetDeployment.prepared_artifact_key,
        preparation_request: targetDeployment.preparation_request,
        artifactSha256: targetDeployment.artifactSha256,
        manifestSha256: release.manifestSha256,
        planJson: targetDeployment.planJson ?? {
          schemaVersion: "tapeci.plan.v1",
          rollbackTargetReleaseId: release.releaseId,
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
        },
      })
      .onConflictDoNothing({ target: deployments.sourceEventKey })
      .returning();
    const deployment =
      created ??
      (
        await deps.db
          .select()
          .from(deployments)
          .where(eq(deployments.sourceEventKey, sourceEventKey))
          .limit(1)
      )[0];
    if (deployment === undefined) throw new ApiError(500, "INTERNAL", "could not create rollback deployment");
    void reply.code(202);
    return {
      deploymentId: deployment.id,
      releaseId,
      commitSha: release.commitSha,
      state: deployment.state,
    };
  });
}
