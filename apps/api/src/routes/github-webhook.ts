import type { FastifyInstance } from "fastify";
import { handlePushWebhook, type GitHubAppConfig } from "@tapeci/github";
import { ADMISSION_SKIP_CODES, decideAdmission } from "../build-admission.js";
import { dispatchDeploymentBuild } from "../build-dispatch.js";
import { handleInstallationWebhook } from "../installation-events.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";

function header(request: { headers: Record<string, string | string[] | undefined> }, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function registerWebhookRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post("/v1/github/webhook", async (request, reply) => {
    const secret = deps.env.githubWebhookSecret;
    if (secret === null) {
      throw new ApiError(500, "WEBHOOK_CONFIG_INVALID", "GITHUB_WEBHOOK_SECRET is not configured");
    }
    const deliveryId = header(request as never, "x-github-delivery");
    const event = header(request as never, "x-github-event");
    const rawBody = request.rawBody;
    if (deliveryId === undefined || event === undefined || rawBody === undefined) {
      throw new ApiError(400, "MISSING_HEADERS", "x-github-delivery, x-github-event and a raw body are required");
    }
    if (event === "installation") {
      const installation = await handleInstallationWebhook({
        db: deps.db,
        deliveryId,
        headers: request.headers as Record<string, string | string[] | undefined>,
        rawBody,
        secret,
        payload: request.body,
      });
      if (installation.errorCode === "SIGNATURE_INVALID") {
        throw new ApiError(401, "INVALID_WEBHOOK_SIGNATURE", "GitHub webhook signature is invalid");
      }
      if (installation.duplicate) {
        void reply.code(200);
        return { duplicate: true, accepted: installation.accepted };
      }
      if (!installation.accepted) {
        void reply.code(422);
        return {
          duplicate: false,
          accepted: false,
          errorCode: installation.errorCode ?? "REJECTED",
        };
      }
      void reply.code(202);
      return { duplicate: false, accepted: true };
    }

    const result = await handlePushWebhook({
      db: deps.db,
      // §11.2: the gate lives in the API (this layer may import it; the github
      // package may not), and it decides before any deployment row exists.
      admitPush: (facts) => {
        const decision = decideAdmission(facts);
        return decision.admit
          ? { admit: true }
          : {
              admit: false,
              errorCode: ADMISSION_SKIP_CODES[decision.reason],
              detail: decision.detail,
            };
      },
      deliveryId,
      event,
      headers: request.headers as Record<string, string | string[] | undefined>,
      rawBody,
      secret,
      payload: request.body,
    });
    if (result.errorCode === "SIGNATURE_INVALID") {
      throw new ApiError(401, "INVALID_WEBHOOK_SIGNATURE", "GitHub webhook signature is invalid");
    }
    if (result.duplicate) {
      void reply.code(200);
      return { duplicate: true, accepted: result.accepted, deploymentId: result.deploymentId ?? null };
    }
    if (!result.accepted) {
      void reply.code(422);
      return { duplicate: false, accepted: false, errorCode: result.errorCode ?? "REJECTED" };
    }
    // §11.2/§11.3: an admitted push becomes a build attempt and a dispatch. This runs
    // inline because the tree has no dispatch job type yet; a queue job is the
    // production answer for the latency, and the ordering (attempt saved before the
    // GitHub call) is what keeps it recoverable either way. A dispatch problem must
    // not turn an accepted delivery into an error: the deployment already exists, and
    // an unknown outcome is recorded on the attempt rather than lost.
    const dispatch =
      result.deploymentId === undefined
        ? null
        : await dispatchAfterAdmission(deps, result.deploymentId);
    void reply.code(202);
    return {
      duplicate: false,
      accepted: true,
      deploymentId: result.deploymentId ?? null,
      dispatch,
    };
  });
}

/**
 * Dispatch a build for an admitted delivery, reporting rather than throwing. The
 * webhook's contract is admission, not dispatch: a failure here leaves the deployment
 * in `RECEIVED` with (at most) a recoverable attempt, which is the state §3.3 wants
 * instead of a lost trigger.
 */
async function dispatchAfterAdmission(
  deps: ApiDeps,
  deploymentId: string,
): Promise<{ readonly kind: string; readonly detail?: string } | null> {
  try {
    const outcome = await dispatchDeploymentBuild(
      {
        db: deps.db,
        appConfig: () => appConfigFromEnv(deps),
        ...(deps.dispatchGithub === undefined ? {} : { github: deps.dispatchGithub }),
      },
      { deploymentId },
    );
    return outcome.kind === "skipped"
      ? { kind: outcome.kind, detail: outcome.detail }
      : { kind: outcome.kind };
  } catch (error) {
    // Recorded for the operator; the delivery itself already succeeded.
    return { kind: "error", detail: error instanceof Error ? error.message : "dispatch failed" };
  }
}

/** The App credentials dispatch needs; `null` means "not configured", not "misconfigured". */
function appConfigFromEnv(deps: ApiDeps): GitHubAppConfig | null {
  const appId = deps.env.githubAppId;
  const privateKey = deps.env.githubAppPrivateKey;
  if (appId === null || privateKey === null) return null;
  return {
    appId,
    privateKey,
    ...(deps.env.githubApiBaseUrl === null ? {} : { apiBaseUrl: deps.env.githubApiBaseUrl }),
  };
}
