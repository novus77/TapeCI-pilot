import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import {
  artifactUploads,
  deployments,
  projects,
  releaseFiles,
} from "@tapeci/database";
import {
  ingestArtifactTar,
  issueBuildToken,
  registerBuildToken,
  verifyAndConsumeBuildToken,
  verifyGitHubOidc,
} from "@tapeci/github";
import { createDeploymentQueues, enqueueDeployment, transitionDeployment } from "@tapeci/queue";
import { createObjectStore } from "../object-store.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";

function bearer(request: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = request.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !value.startsWith("Bearer ")) {
    throw new ApiError(401, "AUTH_REQUIRED", "Authorization: Bearer <token> is required");
  }
  return value.slice("Bearer ".length).trim();
}

export function registerBuildRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post("/v1/builds/token", async (request) => {
    const oidcToken = bearer(request as never);
    const claims =
      deps.verifyOidc === undefined
        ? await verifyGitHubOidc(oidcToken, {
            audience: deps.env.githubOidcAudience,
            issuer: deps.env.githubOidcIssuer,
            ...(deps.env.githubOidcJwksUrl === null || deps.env.githubOidcJwksUrl === undefined
              ? {}
              : { jwksUrl: deps.env.githubOidcJwksUrl }),
          })
        : await deps.verifyOidc(oidcToken);

    const [project] = await deps.db
      .select()
      .from(projects)
      .where(eq(projects.githubRepositoryId, claims.repositoryId))
      .limit(1);
    if (project === undefined) {
      throw new ApiError(403, "REPOSITORY_NOT_AUTHORIZED", "this repository is not connected to TapeCI");
    }
    const [deployment] = await deps.db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, project.id),
          eq(deployments.commitSha, claims.sha),
        ),
      )
      .orderBy(desc(deployments.requestedAt))
      .limit(1);
    if (deployment === undefined) {
      throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "no deployment exists for this commit");
    }
    const issued = await issueBuildToken({
      deploymentId: deployment.id,
      repositoryId: claims.repositoryId,
      commitSha: claims.sha,
      ref: claims.ref,
      secret: deps.env.sessionSecret,
      ttlSeconds: deps.env.artifactTokenTtlSeconds,
    });
    await registerBuildToken(deps.db, issued.claims);
    return {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      deploymentId: deployment.id,
    };
  });

  app.post("/v1/builds/artifacts", async (request) => {
    const token = bearer(request as never);
    const claims = await verifyAndConsumeBuildToken(deps.db, token, deps.env.sessionSecret);
    const [deployment] = await deps.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, claims.deploymentId))
      .limit(1);
    if (deployment === undefined) {
      throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "deployment for this build token no longer exists");
    }
    if (!["RECEIVED", "BUILDING", "BUILT"].includes(deployment.state)) {
      throw new ApiError(409, "PLAN_STALE", `deployment is already ${deployment.state}`);
    }
    const [project] = await deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, deployment.projectId))
      .limit(1);
    if (project === undefined) throw new ApiError(500, "INTERNAL", "deployment project missing");
    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "artifact body must be an uncompressed tar");
    }

    const workspace = await mkdtemp(join(tmpdir(), "tapeci-artifact-"));
    try {
      const store = deps.objectStore ?? createObjectStore(deps.env);
      const result = await ingestArtifactTar({
        bytes: new Uint8Array(body),
        destinationDir: workspace,
        objectStore: store,
        limits: { maxTotalBytes: deps.env.artifactMaxBytes },
        strictOnChain: project.strictDewebMode,
      });

      let current = deployment;
      if (current.state === "RECEIVED") {
        current = await transitionDeployment(deps.db, {
          deploymentId: current.id,
          expectedVersion: current.stateVersion,
          toState: "BUILDING",
          eventType: "build_started",
          actorKind: "webhook",
          actorId: "github-actions",
        });
      }
      current = await transitionDeployment(deps.db, {
        deploymentId: current.id,
        expectedVersion: current.stateVersion,
        toState: "BUILT",
        eventType: "artifact_ingested",
        actorKind: "webhook",
        actorId: "github-actions",
        payload: { fileCount: result.fileCount, totalBytes: result.totalBytes },
      });

      await deps.db
        .update(deployments)
        .set({
          artifactSha256: result.sha256,
          artifactStorageKey: result.objectKey,
          updatedAt: new Date(),
        })
        .where(eq(deployments.id, current.id));

      await deps.db
        .delete(releaseFiles)
        .where(eq(releaseFiles.deploymentId, current.id));
      if (result.files.length > 0) {
        await deps.db.insert(releaseFiles).values(
          result.files.map((file) => ({
            deploymentId: current.id,
            targetPath: file.path,
            sourceRelativePath: file.path,
            sha256: file.sha256,
            byteSize: file.size,
            chunkCount: Math.max(1, Math.ceil(file.size / 24_000)),
            contentType: file.contentType,
            state: "PENDING" as const,
          })),
        );
      }

      await deps.db
        .insert(artifactUploads)
        .values({
          deploymentId: current.id,
          objectKey: result.objectKey,
          sha256: result.sha256,
          sizeBytes: result.sizeBytes,
          expiresAt: new Date(Date.now() + deps.env.artifactTokenTtlSeconds * 1_000),
        })
        .onConflictDoNothing({ target: artifactUploads.objectKey });

      let planQueued = true;
      let planWarning: string | null = null;
      try {
        const enqueuePlan =
          deps.enqueuePlan ??
          (async (deploymentId: string): Promise<void> => {
            const queues = createDeploymentQueues({ redisUrl: deps.env.redisUrl });
            try {
              await enqueueDeployment(queues.plan, deploymentId);
            } finally {
              await queues.close();
            }
          });
        await enqueuePlan(current.id);
      } catch (error) {
        // The artifact is safely stored and BUILD state is durable; a queue outage
        // must not consume the one-time token without persisting the build.
        planQueued = false;
        planWarning = error instanceof Error ? error.message : String(error);
      }

      return {
        deploymentId: current.id,
        state: current.state,
        artifactSha256: result.sha256,
        objectKey: result.objectKey,
        fileCount: result.fileCount,
        planQueued,
        ...(planWarning === null ? {} : { planWarning }),
        files: result.files.map((file) => ({
          path: file.path,
          size: file.size,
          sha256: file.sha256,
          contentType: file.contentType,
        })),
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
