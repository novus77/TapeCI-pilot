import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  approvalPolicies,
  deployments,
  notificationChannels,
  organizationBudgets,
  projectBudgets,
  projects,
} from "@tapeci/database";
import { requireUser } from "../auth.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { recordBody, stringField } from "../validation.js";
import { projectAccess } from "../project-access.js";
import { notifyProject } from "../notifications.js";

async function requireMembership(deps: ApiDeps, projectId: string, userId: string) {
  const access = await projectAccess(deps.db, projectId, userId);
  if (access === null) throw new ApiError(404, "PROJECT_NOT_FOUND", "project not found");
  return { project: access.project, role: access.role };
}

function requireOwner(project: typeof projects.$inferSelect, role: string, userId: string): void {
  if (project.ownerUserId !== userId && role !== "owner") {
    throw new ApiError(403, "FORBIDDEN", "only a project owner can change governance settings");
  }
}

export async function organizationBudgetStatus(
  deps: ApiDeps,
  organizationId: string,
): Promise<{ capWei: bigint | null; spentWei: bigint }> {
  const [budget] = await deps.db
    .select()
    .from(organizationBudgets)
    .where(eq(organizationBudgets.organizationId, organizationId))
    .limit(1);
  const projectRows = await deps.db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.organizationId, organizationId));
  let spent = 0n;
  for (const project of projectRows) spent += await monthlySpendWei(deps, project.id);
  return {
    capWei:
      budget?.monthlyCapWei === null || budget?.monthlyCapWei === undefined
        ? null
        : BigInt(budget.monthlyCapWei),
    spentWei: spent,
  };
}

export async function monthlySpendWei(deps: ApiDeps, projectId: string): Promise<bigint> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [row] = await deps.db
    .select({ total: sql<string>`coalesce(sum(${deployments.estimatedCostWei}), 0)::text` })
    .from(deployments)
    .where(and(eq(deployments.projectId, projectId), gte(deployments.requestedAt, monthStart)));
  return BigInt(row?.total ?? "0");
}

export function registerGovernanceRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/v1/projects/:id/budget", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const { project } = await requireMembership(deps, params.id, user.id);
    const [row] = await deps.db.select().from(projectBudgets).where(eq(projectBudgets.projectId, project.id)).limit(1);
    const spent = await monthlySpendWei(deps, project.id);
    return {
      monthlyCapWei: row?.monthlyCapWei ?? null,
      spentThisMonthWei: spent.toString(),
    };
  });

  app.patch("/v1/projects/:id/budget", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const { project, role } = await requireMembership(deps, params.id, user.id);
    requireOwner(project, role, user.id);
    const body = recordBody(request.body);
    const cap = body.monthlyCapWei === null ? null : (stringField(body, "monthlyCapWei") ?? "");
    if (cap !== null) {
      if (!/^\d+$/.test(cap)) throw new ApiError(422, "INVALID_BUDGET", "monthlyCapWei must be an integer string");
    }
    const [row] = await deps.db
      .insert(projectBudgets)
      .values({ projectId: project.id, monthlyCapWei: cap })
      .onConflictDoUpdate({ target: projectBudgets.projectId, set: { monthlyCapWei: cap, updatedAt: new Date() } })
      .returning();
    return { monthlyCapWei: row?.monthlyCapWei ?? null };
  });

  app.get("/v1/projects/:id/approval-policy", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const { project } = await requireMembership(deps, params.id, user.id);
    const [row] = await deps.db.select().from(approvalPolicies).where(eq(approvalPolicies.projectId, project.id)).limit(1);
    return {
      requiredRole: row?.requiredRole ?? "owner",
      maxCostCapWei: row?.maxCostCapWei ?? null,
      expiresInSeconds: row?.expiresInSeconds ?? 900,
    };
  });

  app.patch("/v1/projects/:id/approval-policy", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const { project, role } = await requireMembership(deps, params.id, user.id);
    requireOwner(project, role, user.id);
    const body = recordBody(request.body);
    const requiredRole = body.requiredRole === "member" || body.requiredRole === "maintainer" ? body.requiredRole : "owner";
    const expiresInSeconds = body.expiresInSeconds === undefined ? 900 : Number(body.expiresInSeconds);
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 86_400) {
      throw new ApiError(422, "INVALID_POLICY", "expiresInSeconds must be between 60 and 86400");
    }
    const maxCap = body.maxCostCapWei === null || body.maxCostCapWei === undefined ? null : String(body.maxCostCapWei);
    if (maxCap !== null && !/^\d+$/.test(maxCap)) {
      throw new ApiError(422, "INVALID_POLICY", "maxCostCapWei must be an integer string");
    }
    const [row] = await deps.db
      .insert(approvalPolicies)
      .values({ projectId: project.id, requiredRole, maxCostCapWei: maxCap, expiresInSeconds })
      .onConflictDoUpdate({
        target: approvalPolicies.projectId,
        set: { requiredRole, maxCostCapWei: maxCap, expiresInSeconds, updatedAt: new Date() },
      })
      .returning();
    return {
      requiredRole: row?.requiredRole ?? requiredRole,
      maxCostCapWei: row?.maxCostCapWei ?? maxCap,
      expiresInSeconds: row?.expiresInSeconds ?? expiresInSeconds,
    };
  });

  app.get("/v1/projects/:id/notification-channels", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const { project } = await requireMembership(deps, params.id, user.id);
    const rows = await deps.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.projectId, project.id))
      .orderBy(desc(notificationChannels.createdAt));
    return { channels: rows.map((row) => ({ id: row.id, kind: row.kind, target: row.target, enabled: row.enabled })) };
  });

  app.post("/v1/projects/:id/notification-channels", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const { project, role } = await requireMembership(deps, params.id, user.id);
    requireOwner(project, role, user.id);
    const body = recordBody(request.body);
    const kind = stringField(body, "kind") ?? "";
    const target = stringField(body, "target") ?? "";
    if (kind !== "slack" && kind !== "email") throw new ApiError(422, "INVALID_CHANNEL", "kind must be slack or email");
    if (kind === "slack" && !target.startsWith("https://hooks.slack.com/")) {
      throw new ApiError(422, "INVALID_CHANNEL", "Slack target must be a hooks.slack.com URL");
    }
    const [row] = await deps.db
      .insert(notificationChannels)
      .values({ projectId: project.id, kind, target })
      .returning();
    return { channel: { id: row?.id, kind, target } };
  });

  app.delete("/v1/projects/:id/notification-channels/:channelId", async (request, reply) => {
    const user = requireUser(request);
    const params = request.params as { id?: string; channelId?: string };
    if (params.id === undefined || params.channelId === undefined) {
      throw new ApiError(400, "INVALID_PATH", "project id and channel id are required");
    }
    const { project, role } = await requireMembership(deps, params.id, user.id);
    requireOwner(project, role, user.id);
    await deps.db
      .delete(notificationChannels)
      .where(and(eq(notificationChannels.projectId, project.id), eq(notificationChannels.id, params.channelId)));
    void reply.code(204).send();
  });

  app.post("/v1/projects/:id/notification-channels/test", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const { project } = await requireMembership(deps, params.id, user.id);
    const channels = await deps.db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.projectId, project.id), eq(notificationChannels.enabled, true)));
    if (channels.length === 0) throw new ApiError(409, "NO_CHANNELS", "no enabled notification channels");
    const results = await notifyProject(
      deps.db,
      deps.env,
      project.id,
      `TapeCI test notification for ${project.repoFullName}`,
      `TapeCI test notification for ${project.repoFullName}`,
    );
    return { results: results.map((result) => ({ id: result.channelId, ...result })) };
  });
}

/** Slack notification for deployment lifecycle events (best-effort, never blocks). */
export async function notifyDeploymentEvent(
  deps: ApiDeps,
  projectId: string,
  text: string,
): Promise<void> {
  await notifyProject(deps.db, deps.env, projectId, text, text);
}
