import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditEvents,
  deploymentNotificationReads,
  deployments,
  githubInstallations,
  organizationMembers,
  githubInstallationUsers,
  projectMembers,
  projects,
  releaseFiles,
  releases,
  users,
  webhookDeliveries,
} from "@tapeci/database";
import { requireUser } from "../auth.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { integerField, recordBody, stringField } from "../validation.js";
import { projectAccess } from "../project-access.js";
import { UUID_PATTERN } from "../audit.js";

const NEEDS_ATTENTION = [
  "PLAN_READY",
  "AWAITING_APPROVAL",
  "APPROVED",
  "BUILD_FAILED",
  "PLAN_REJECTED",
  "APPROVAL_EXPIRED",
  "AUTH_REVOKED",
  "OWNERSHIP_CHANGED",
  "INSUFFICIENT_BALANCE",
  "FEE_OVER_BUDGET",
  "RPC_DISAGREEMENT",
  "UPLOAD_CONFLICT",
  "UPLOAD_INTERRUPTED",
  "VERIFY_FAILED",
  "SWITCH_FAILED",
  "ROLLBACK_REQUIRED",
] as const;

async function membership(
  deps: ApiDeps,
  projectId: string,
  userId: string,
): Promise<{ project: typeof projects.$inferSelect; role: string }> {
  const access = await projectAccess(deps.db, projectId, userId);
  if (access === null) throw new ApiError(404, "PROJECT_NOT_FOUND", "project not found");
  return { project: access.project, role: access.role };
}

function requireOwner(project: typeof projects.$inferSelect, role: string, userId: string): void {
  if (project.ownerUserId !== userId && role !== "owner") {
    throw new ApiError(403, "FORBIDDEN", "only a project owner can change settings or members");
  }
}

export function registerOperationsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  // ---------------------------------------------------------------- members
  app.get("/v1/projects/:id/members", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const { project, role } = await membership(deps, params.id, user.id);
    const rows = await deps.db
      .select({
        userId: users.id,
        githubLogin: users.githubLogin,
        avatarUrl: users.avatarUrl,
        role: projectMembers.role,
        createdAt: projectMembers.createdAt,
        expiresAt: projectMembers.expiresAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, project.id))
      .orderBy(projectMembers.createdAt);
    const inherited = project.organizationId === null ? [] : await deps.db
      .select({ userId: users.id, githubLogin: users.githubLogin, avatarUrl: users.avatarUrl,
        role: organizationMembers.role, createdAt: organizationMembers.createdAt,
        expiresAt: organizationMembers.expiresAt })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, project.organizationId));
    const activity = await deps.db
      .select({ userId: auditEvents.actorUserId, lastActivityAt: sql<Date | null>`max(${auditEvents.createdAt})`.mapWith(auditEvents.createdAt) })
      .from(auditEvents)
      .where(eq(auditEvents.projectId, project.id))
      .groupBy(auditEvents.actorUserId);
    const inheritedRole = { owner: "owner", admin: "maintainer", member: "member" };
    const rank: Record<string, number> = { viewer: 0, member: 1, maintainer: 2, owner: 3 };
    const direct = rows.map((row) => ({ ...row, source: "direct" as const, directRole: row.role }));
    // An expired organization grant confers nothing, so it must not appear as an
    // inherited project role either.
    const liveInherited = inherited.filter((row) => row.expiresAt === null || row.expiresAt.getTime() > Date.now());
    const combined = [...direct, ...liveInherited.filter((row) => !rows.some((directRow) => directRow.userId === row.userId))
      .map((row) => ({ ...row, role: inheritedRole[row.role as keyof typeof inheritedRole] ?? "member", source: "inherited" as const, directRole: null }))];
    return {
      members: combined.map((row) => {
        const organizationRole = inherited.find((member) => member.userId === row.userId)?.role;
        const effectiveInherited = organizationRole === undefined ? undefined : inheritedRole[organizationRole as keyof typeof inheritedRole];
        const inherits = effectiveInherited !== undefined && (rank[effectiveInherited] ?? 0) > (rank[row.role] ?? 0);
        // Source identifies the effective grant; both underlying grants remain explicit,
        // including equal roles whose inherited access survives direct removal.
        return { ...row, role: inherits ? effectiveInherited : row.role, source: inherits ? "inherited" : row.source,
          inheritedRole: effectiveInherited ?? null,
          createdAt: row.createdAt.toISOString(),
          lastActivityAt: activity.find((event) => event.userId === row.userId)?.lastActivityAt ?? null };
      }),
      canManage: project.ownerUserId === user.id || role === "owner",
      protectedUserId: project.ownerUserId,
    };
  });

  app.post("/v1/projects/:id/members", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const { project, role } = await membership(deps, params.id, user.id);
    requireOwner(project, role, user.id);
    const body = recordBody(request.body);
    const githubLogin = (stringField(body, "githubLogin") ?? "").trim();
    const requestedRole = body.role === "owner" ? "owner" : "member";
    const [member] = await deps.db
      .select()
      .from(users)
      .where(sql`lower(${users.githubLogin}) = lower(${githubLogin})`)
      .limit(1);
    if (member === undefined) {
      throw new ApiError(404, "USER_NOT_FOUND", `no TapeCI user has signed in as ${githubLogin}`);
    }
    if (member.id === project.ownerUserId && requestedRole !== "owner") {
      throw new ApiError(409, "LAST_OWNER", "the project owner must remain an owner");
    }
    const [inserted] = await deps.db
      .insert(projectMembers)
      .values({ projectId: project.id, userId: member.id, role: requestedRole })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: requestedRole },
      })
      .returning();
    return {
      member: {
        userId: member.id,
        githubLogin: member.githubLogin,
        role: inserted?.role ?? requestedRole,
      },
    };
  });

  app.delete("/v1/projects/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request);
    const params = request.params as { id?: string; userId?: string };
    if (params.id === undefined || params.userId === undefined) {
      throw new ApiError(400, "INVALID_PATH", "project id and user id are required");
    }
    const { project, role } = await membership(deps, params.id, user.id);
    requireOwner(project, role, user.id);
    if (params.userId === project.ownerUserId) {
      throw new ApiError(409, "OWNER_REMOVAL", "the project owner cannot be removed");
    }
    await deps.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, params.userId)));
    void reply.code(204).send();
  });

  app.patch("/v1/projects/:id/members/:userId", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string; userId?: string };
    if (params.id === undefined || params.userId === undefined) {
      throw new ApiError(400, "INVALID_PATH", "project id and user id are required");
    }
    const { project, role } = await membership(deps, params.id, user.id);
    requireOwner(project, role, user.id);
    const body = recordBody(request.body);
    // Project membership only distinguishes owner/member (the add form and the
    // row select offer the same two), so anything else is a client error rather
    // than silently coerced to "member".
    const nextRole = body.role;
    if (nextRole !== "owner" && nextRole !== "member") {
      throw new ApiError(400, "INVALID_BODY", 'role must be "owner" or "member"');
    }

    const updated = await deps.db.transaction(async (tx) => {
      // Lock the membership rows so the "last owner" check and the write see the
      // same set; two owners demoting each other concurrently must not both pass.
      const memberships = await tx
        .select({ userId: projectMembers.userId, role: projectMembers.role })
        .from(projectMembers)
        .where(eq(projectMembers.projectId, project.id))
        .for("update");
      const target = memberships.find((row) => row.userId === params.userId);
      if (target === undefined) {
        throw new ApiError(404, "MEMBER_NOT_FOUND", "this user is not a member of the project");
      }
      if (target.role === nextRole) return { userId: target.userId, role: nextRole, changed: false };

      if (target.role === "owner") {
        if (project.ownerUserId === target.userId) {
          throw new ApiError(409, "LAST_OWNER", "the project owner cannot be demoted");
        }
        if (memberships.filter((row) => row.role === "owner").length <= 1) {
          throw new ApiError(409, "LAST_OWNER", "a project needs at least one owner");
        }
      }

      await tx
        .update(projectMembers)
        .set({ role: nextRole })
        .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, target.userId)));
      await tx.insert(auditEvents).values({
        event: "project.member.role",
        actorUserId: user.id,
        githubLogin: user.githubLogin,
        method: "PATCH",
        route: "/v1/projects/:id/members/:userId",
        path: `/v1/projects/${project.id}/members/${target.userId}`,
        status: 200,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
        requestId: request.id,
        projectId: project.id,
        organizationId: project.organizationId,
        metadata: { userId: target.userId, from: target.role, to: nextRole },
      });
      return { userId: target.userId, role: nextRole, changed: true };
    });

    const [member] = await deps.db
      .select({ githubLogin: users.githubLogin, avatarUrl: users.avatarUrl, createdAt: projectMembers.createdAt })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, updated.userId)))
      .limit(1);
    return {
      member: {
        userId: updated.userId,
        githubLogin: member?.githubLogin ?? null,
        avatarUrl: member?.avatarUrl ?? null,
        role: updated.role,
        createdAt: member?.createdAt.toISOString() ?? null,
      },
      changed: updated.changed,
    };
  });

  // --------------------------------------------------------------- settings
  app.patch("/v1/projects/:id", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const { project, role } = await membership(deps, params.id, user.id);
    requireOwner(project, role, user.id);
    const body = recordBody(request.body);
    const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
    if (body.pathMode !== undefined) {
      if (body.pathMode !== "versioned" && body.pathMode !== "root") {
        throw new ApiError(400, "INVALID_BODY", 'pathMode must be "versioned" or "root"');
      }
      patch.pathMode = body.pathMode;
    }
    if (body.buildCommand !== undefined) patch.buildCommand = stringField(body, "buildCommand");
    if (body.installCommand !== undefined) patch.installCommand = stringField(body, "installCommand");
    if (body.outputDirectory !== undefined) {
      const output = (stringField(body, "outputDirectory") ?? "").replace(/^\/+|\/+$/g, "");
      if (output.length === 0 || output.includes("..")) {
        throw new ApiError(422, "INVALID_OUTPUT_DIRECTORY", "output directory must stay inside the artifact");
      }
      patch.outputDirectory = output;
    }
    if (body.organizationId !== undefined) {
      if (body.organizationId === null) {
        patch.organizationId = null;
      } else {
        const organizationId = stringField(body, "organizationId") ?? "";
        const [membership] = await deps.db
          .select({ role: organizationMembers.role })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, organizationId),
              eq(organizationMembers.userId, user.id),
            ),
          )
          .limit(1);
        if (membership === undefined || (membership.role !== "owner" && membership.role !== "admin")) {
          throw new ApiError(403, "ORGANIZATION_FORBIDDEN", "organization owner/admin role required to assign a project");
        }
        patch.organizationId = organizationId;
      }
    }
    if (body.isArchived !== undefined) {
      if (typeof body.isArchived !== "boolean") {
        throw new ApiError(422, "INVALID_ARCHIVED", "isArchived must be a boolean");
      }
      patch.isArchived = body.isArchived;
    }
    // §11.3: a change to the build config mints a new `configVersion`, so a dispatched
    // attempt keeps the snapshot it was given and `/v1/builds/context` can report
    // `configChanged` for a project that has moved on (AC-P4-10). The three commands are
    // exactly what a `configSnapshot` carries; `pathMode` is deployment behaviour and is
    // deliberately not part of that identity, so changing it must not version the config.
    const buildConfigChanged =
      (patch.installCommand !== undefined && patch.installCommand !== project.installCommand) ||
      (patch.buildCommand !== undefined && patch.buildCommand !== project.buildCommand) ||
      (patch.outputDirectory !== undefined && patch.outputDirectory !== project.outputDirectory);
    if (buildConfigChanged) {
      patch.configVersion = project.configVersion + 1;
    }
    const [updated] = await deps.db.update(projects).set(patch).where(eq(projects.id, project.id)).returning();
    return {
      project: {
        id: updated?.id ?? project.id,
        buildCommand: updated?.buildCommand ?? project.buildCommand,
        installCommand: updated?.installCommand ?? project.installCommand,
        outputDirectory: updated?.outputDirectory ?? project.outputDirectory,
        isArchived: updated?.isArchived ?? project.isArchived,
      },
    };
  });

  // ----------------------------------------------------------------- audit
  app.get("/v1/audit", async (request) => {
    const user = requireUser(request);
    const query = request.query as Record<string, unknown>;
    const limit = query.limit === undefined ? 100 : Math.min(integerField(query, "limit"), 200);
    const status = query.status === undefined ? null : Number(query.status);
    const scope = query.scope === "all" ? "all" : "self";
    const isAdmin = (deps.env.adminLogins ?? []).includes(user.githubLogin.toLowerCase());
    // Authorize the scope before validating the filter, so a caller who may not
    // read the global log cannot use 422-vs-200 to probe filter parsing.
    if (scope === "all" && !isAdmin) {
      throw new ApiError(403, "FORBIDDEN", "the global audit log requires an admin account");
    }
    const rawProjectId = query.projectId;
    if (Array.isArray(rawProjectId)) {
      throw new ApiError(422, "INVALID_PROJECT_ID", "projectId must be a single UUID");
    }
    const projectId =
      typeof rawProjectId === "string" && rawProjectId.length > 0 ? rawProjectId : null;
    if (projectId !== null && !UUID_PATTERN.test(projectId)) {
      throw new ApiError(422, "INVALID_PROJECT_ID", "projectId must be a UUID");
    }
    if (projectId !== null && scope !== "all") {
      const access = await projectAccess(deps.db, projectId, user.id);
      if (access === null) throw new ApiError(404, "PROJECT_NOT_FOUND", "project not found");
    }
    const rows = await deps.db
      .select({ event: auditEvents, actorLogin: users.githubLogin })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(
        and(
          scope === "all" ? undefined : eq(auditEvents.actorUserId, user.id),
          projectId === null ? undefined : eq(auditEvents.projectId, projectId),
          status === null || Number.isNaN(status) ? undefined : eq(auditEvents.status, status),
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
    return {
      scope,
      projectId,
      events: rows.map(({ event, actorLogin }) => ({
        id: event.id,
        event: event.event,
        actorLogin,
        method: event.method,
        route: event.route,
        status: event.status,
        requestId: event.requestId,
        projectId: event.projectId,
        organizationId: event.organizationId,
        ip: event.ip,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  });

  // ----------------------------------------------------- webhook deliveries
  app.get("/v1/github/webhook-deliveries", async (request) => {
    const user = requireUser(request);
    const query = request.query as Record<string, unknown>;
    const limit = query.limit === undefined ? 100 : Math.min(integerField(query, "limit"), 200);
    const installationRows = await deps.db
      .select({ numericId: githubInstallations.installationId })
      .from(githubInstallationUsers)
      .innerJoin(
        githubInstallations,
        eq(githubInstallations.id, githubInstallationUsers.installationId),
      )
      .where(eq(githubInstallationUsers.userId, user.id));
    const numericIds = installationRows.map((row) => row.numericId);
    if (numericIds.length === 0) return { deliveries: [] };
    const rows = await deps.db
      .select()
      .from(webhookDeliveries)
      .where(inArray(webhookDeliveries.githubInstallationNumericId, numericIds))
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(limit);
    return {
      deliveries: rows.map((row) => ({
        id: row.id,
        deliveryId: row.githubDeliveryId,
        eventType: row.eventType,
        ref: row.ref,
        commitSha: row.commitSha,
        accepted: row.accepted,
        errorCode: row.errorCode,
        receivedAt: row.receivedAt.toISOString(),
        processedAt: row.processedAt?.toISOString() ?? null,
      })),
    };
  });

  // ----------------------------------------------------------- notifications
  app.get("/v1/notifications", async (request) => {
    const user = requireUser(request);
    const rows = await deps.db
      .select({
        id: deployments.id,
        projectId: projects.id,
        repoFullName: projects.repoFullName,
        state: deployments.state,
        commitSha: deployments.commitSha,
        requestedAt: deployments.requestedAt,
        errorCode: deployments.errorCode,
        readAt: deploymentNotificationReads.readAt,
      })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.projectId))
      .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .leftJoin(
        deploymentNotificationReads,
        and(
          eq(deploymentNotificationReads.userId, user.id),
          eq(deploymentNotificationReads.deploymentId, deployments.id),
        ),
      )
      .where(and(eq(projectMembers.userId, user.id), inArray(deployments.state, [...NEEDS_ATTENTION])))
      .orderBy(desc(deployments.requestedAt))
      .limit(20);
    return {
      unread: rows.filter((row) => row.readAt === null).length,
      notifications: rows.map((row) => ({
        deploymentId: row.id,
        projectId: row.projectId,
        repoFullName: row.repoFullName,
        state: row.state,
        commitSha: row.commitSha,
        requestedAt: row.requestedAt.toISOString(),
        errorCode: row.errorCode,
        readAt: row.readAt?.toISOString() ?? null,
      })),
    };
  });

  app.post("/v1/notifications/read", async (request) => {
    const user = requireUser(request);
    const body = recordBody(request.body);
    const requested = Array.isArray(body.deploymentIds)
      ? body.deploymentIds.filter((value): value is string => typeof value === "string").slice(0, 100)
      : [];
    const rows = await deps.db
      .select({ id: deployments.id })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.projectId))
      .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .where(
        and(
          eq(projectMembers.userId, user.id),
          inArray(deployments.state, [...NEEDS_ATTENTION]),
          requested.length === 0 ? undefined : inArray(deployments.id, requested),
        ),
      )
      .limit(100);
    if (rows.length > 0) {
      await deps.db
        .insert(deploymentNotificationReads)
        .values(rows.map((row) => ({ userId: user.id, deploymentId: row.id })))
        .onConflictDoNothing();
    }
    return { marked: rows.length };
  });

  // --------------------------------------------------------- release compare
  app.get("/v1/projects/:id/releases/compare", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "project id is required");
    const project = await membership(deps, params.id, user.id);
    const query = request.query as Record<string, unknown>;
    const baseId = typeof query.base === "string" ? query.base : "";
    const targetId = typeof query.target === "string" ? query.target : "";
    if (baseId === "" || targetId === "") {
      throw new ApiError(422, "INVALID_COMPARE", "base and target release ids are required");
    }
    const rows = await deps.db
      .select()
      .from(releases)
      .where(and(eq(releases.projectId, project.project.id), inArray(releases.releaseId, [baseId, targetId])));
    const base = rows.find((row) => row.releaseId === baseId);
    const target = rows.find((row) => row.releaseId === targetId);
    if (base === undefined || target === undefined) {
      throw new ApiError(404, "RELEASE_NOT_FOUND", "one or both releases are not stored for this project");
    }
    const files = await deps.db
      .select()
      .from(releaseFiles)
      .where(inArray(releaseFiles.deploymentId, [base.deploymentId, target.deploymentId]));
    const baseFiles = new Map(files.filter((file) => file.deploymentId === base.deploymentId).map((file) => [file.targetPath, file]));
    const targetFiles = new Map(files.filter((file) => file.deploymentId === target.deploymentId).map((file) => [file.targetPath, file]));
    const paths = [...new Set([...baseFiles.keys(), ...targetFiles.keys()])].sort();
    const changes = paths.map((path) => {
      const before = baseFiles.get(path);
      const after = targetFiles.get(path);
      const status = before === undefined ? "added" : after === undefined ? "removed" : before.sha256 === after.sha256 ? "unchanged" : "changed";
      return {
        path,
        status,
        baseSha256: before?.sha256 ?? null,
        targetSha256: after?.sha256 ?? null,
        baseBytes: before?.byteSize ?? null,
        targetBytes: after?.byteSize ?? null,
      };
    });
    return {
      base: { releaseId: base.releaseId, commitSha: base.commitSha, manifestSha256: base.manifestSha256 },
      target: { releaseId: target.releaseId, commitSha: target.commitSha, manifestSha256: target.manifestSha256 },
      changes,
    };
  });
}
