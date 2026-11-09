import { registerDeploymentPreparationRoutes } from "./routes/deployment-preparation.js";
import Fastify, { type FastifyInstance } from "fastify";
import { resolveUser } from "./auth.js";
import type { ApiDeps } from "./deps.js";
import { ApiError, errorEnvelope, httpStatusFor } from "./errors.js";
import { registerApiMetrics } from "./api-metrics.js";
import { registerAudit } from "./audit.js";
import { registerRateLimit } from "./rate-limit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBuildContextRoutes } from "./routes/build-context.js";
import { registerBuildRoutes } from "./routes/builds.js";
import { registerContainerRoutes } from "./routes/containers.js";
import { registerWebhookRoutes } from "./routes/github-webhook.js";
import { registerDeploymentRoutes } from "./routes/deployments.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerGovernanceRoutes } from "./routes/governance.js";
import { registerOrganizationRoutes } from "./routes/organizations.js";
import { registerOperationsRoutes } from "./routes/operations.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerProjectDraftRoutes } from "./projects/drafts.js";
import { registerProvisioningRoutes } from "./routes/provisioning.js";
import { isPublicReadMethodAndPath } from "./resources.js";

/** Kept as a named export for tests; the single definition lives in `resources.ts`. */
export const isPublicResourcePath = isPublicReadMethodAndPath;
import { registerResourceRoutes } from "./routes/resources.js";
import { registerWalletRoutes } from "./routes/wallet.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}



export function buildApp(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: deps.env.trustProxy ?? false,
    bodyLimit: deps.env.artifactMaxBytes + 1024 * 1024,
  });

  // Keep the raw bytes for GitHub webhook HMAC verification while still giving
  // normal JSON routes a parsed body.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const buffer = body as Buffer;
      request.rawBody = buffer;
      if (buffer.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(buffer.toString("utf8")));
      } catch {
        done(new ApiError(400, "INVALID_JSON", "invalid JSON body"), undefined);
      }
    },
  );

  // Artifact bodies are raw tar bytes (the build token authenticates the call).
  for (const contentType of [
    "application/x-tar",
    "application/gzip",
    "application/x-gzip",
    "application/zstd",
    "application/octet-stream",
  ]) {
    app.addContentTypeParser(
      contentType,
      { parseAs: "buffer", bodyLimit: deps.env.artifactMaxBytes },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }

  registerRateLimit(app, {
    perMinute: deps.env.rateLimitPerMinute ?? 600,
    disabled: deps.env.rateLimitDisabled ?? false,
    backend: deps.env.rateLimitBackend ?? "memory",
    redisUrl: deps.env.redisUrl,
  });

  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (
      path === "/health" ||
      path === "/readyz" ||
      path === "/metrics" ||
      path === "/v1/github/webhook" ||
      path === "/v1/github/setup" ||
      path.startsWith("/v1/auth/github/") ||
      path.startsWith("/v1/builds/") ||
      isPublicReadMethodAndPath(request.method, path)
    ) {
      return;
    }
    request.user = await resolveUser(deps.db, deps.env, request);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("x-frame-options", "DENY");
    void reply.header("referrer-policy", "no-referrer");
    if (request.url.startsWith("/v1/")) {
      void reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const status = httpStatusFor(error);
    const envelope = errorEnvelope(error);
    void reply.code(status).send({ ...envelope, requestId: request.id });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: `no route for ${request.method} ${request.url}`,
        retryable: false,
        details: {},
      },
      requestId: request.id,
    });
  });

  app.get("/health", async () => ({ ok: true, service: "tapeci-api" }));

  registerAuthRoutes(app, deps);
  registerGithubRoutes(app, deps);
  registerWalletRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  registerBuildRoutes(app, deps);
  registerBuildContextRoutes(app, deps);
  registerApiMetrics(app, deps);
  registerAudit(app, { disabled: deps.env.auditDisabled ?? false, db: deps.db });
  registerProjectRoutes(app, deps);
  registerOperationsRoutes(app, deps);
  registerGovernanceRoutes(app, deps);
  registerOrganizationRoutes(app, deps);
  registerDeploymentRoutes(app, deps);
  registerDeploymentPreparationRoutes(app, deps);
  registerContainerRoutes(app, deps);
  registerResourceRoutes(app, deps, deps.resourceIndex === undefined ? {} : { index: deps.resourceIndex });
  registerProvisioningRoutes(app, deps);
  registerProjectDraftRoutes(app, deps);

  return app;
}
