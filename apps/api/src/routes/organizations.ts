import type { FastifyInstance } from "fastify";
import type { TapeCiErrorCode } from "@tapeci/shared";
import { and, count, desc, eq, max, sql } from "drizzle-orm";
import {
  auditEvents,
  organizationBudgets,
  organizationMembers,
  organizations,
  projects,
  users,
} from "@tapeci/database";
import { requireUser } from "../auth.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { integerField, recordBody, stringField } from "../validation.js";
import { monthlySpendWei } from "./governance.js";

async function requireMember(deps: ApiDeps, orgId: string, userId: string) {
  const [row] = await deps.db
    .select({
      organization: organizations,
      role: organizationMembers.role,
      expiresAt: organizationMembers.expiresAt,
    })
    .from(organizations)
    .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
    .where(and(eq(organizations.id, orgId), eq(organizationMembers.userId, userId)))
    .limit(1);
  if (row === undefined) throw new ApiError(404, "ORGANIZATION_NOT_FOUND", "organization not found");
  // An expired grant is not a grant. This is enforced on read rather than by a
  // sweeper, because a sweeper can lag and a grant that outlives its expiry is a
  // security bug. The owner is never subject to expiry: they are the last resort.
  const expired = row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();
  if (expired && row.organization.ownerUserId !== userId) {
    throw new ApiError(403, "MEMBERSHIP_EXPIRED", "this organization membership has expired");
  }
  return { organization: row.organization, role: row.role ?? "member" };
}

/**
 * Owner/admin gate. `code` lets a route name the capability it needs (the role
 * change reports `ORG_ROLE_REQUIRED`) without duplicating the predicate.
 */
function requireManager(
  org: typeof organizations.$inferSelect,
  role: string,
  userId: string,
  code: TapeCiErrorCode = "FORBIDDEN",
): void {
  if (org.ownerUserId !== userId && role !== "owner" && role !== "admin") {
    throw new ApiError(403, code, "organization owner/admin role required");
  }
}

type OrganizationRole = "owner" | "admin" | "member";

/** Validate the role at the request boundary; anything else is a client error. */
function organizationRole(value: unknown): OrganizationRole {
  if (value === "owner" || value === "admin" || value === "member") return value;
  throw new ApiError(400, "INVALID_BODY", 'role must be "owner", "admin" or "member"');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function registerOrganizationRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/v1/organizations", async (request) => {
    const user = requireUser(request);
    const rows = await deps.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: organizationMembers.role,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
      .where(eq(organizationMembers.userId, user.id))
      .orderBy(desc(organizations.createdAt));
    return { organizations: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
  });

  app.post("/v1/organizations", async (request) => {
    const user = requireUser(request);
    const body = recordBody(request.body);
    const name = stringField(body, "name") ?? "";
    const slug = (stringField(body, "slug", { optional: true }) ?? slugify(name)).toLowerCase();
    if (!/^[a-z0-9-]{2,48}$/.test(slug)) {
      throw new ApiError(422, "INVALID_SLUG", "slug must be 2-48 lowercase letters, digits or dashes");
    }
    const [org] = await deps.db
      .insert(organizations)
      .values({ name, slug, ownerUserId: user.id })
      .returning();
    if (org === undefined) throw new ApiError(500, "INTERNAL", "organization insert failed");
    await deps.db
      .insert(organizationMembers)
      .values({ organizationId: org.id, userId: user.id, role: "owner" })
      .onConflictDoNothing();
    return { organization: { id: org.id, name: org.name, slug: org.slug, role: "owner" } };
  });

  app.get("/v1/organizations/:id", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "organization id is required");
    const { organization, role } = await requireMember(deps, params.id, user.id);
    const lastActivity = deps.db
      .select({
        actorUserId: auditEvents.actorUserId,
        lastActivityAt: max(auditEvents.createdAt).as("last_activity_at"),
      })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, organization.id))
      .groupBy(auditEvents.actorUserId)
      .as("last_activity");
    const members = await deps.db
      .select({
        userId: users.id,
        githubLogin: users.githubLogin,
        role: organizationMembers.role,
        createdAt: organizationMembers.createdAt,
        lastActivityAt: lastActivity.lastActivityAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(lastActivity, eq(lastActivity.actorUserId, users.id))
      .where(eq(organizationMembers.organizationId, organization.id))
      .orderBy(organizationMembers.createdAt);
    const projectRows = await deps.db
      .select({ id: projects.id, repoFullName: projects.repoFullName, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.organizationId, organization.id))
      .orderBy(desc(projects.createdAt));
    const [projectCount] = await deps.db
      .select({ value: count() })
      .from(projects)
      .where(eq(projects.organizationId, organization.id));
    return {
      organization: { id: organization.id, name: organization.name, slug: organization.slug },
      protectedUserId: organization.ownerUserId,
      role,
      canManage: organization.ownerUserId === user.id || role === "owner" || role === "admin",
      members: members.map((member) => ({
        ...member,
        createdAt: member.createdAt.toISOString(),
        lastActivityAt: member.lastActivityAt === null ? null : member.lastActivityAt.toISOString(),
      })),
      projects: projectRows,
      projectCount: projectCount?.value ?? 0,
    };
  });

  app.post("/v1/organizations/:id/members", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "organization id is required");
    const { organization, role } = await requireMember(deps, params.id, user.id);
    requireManager(organization, role, user.id);
    const body = recordBody(request.body);
    const login = stringField(body, "githubLogin") ?? "";
    const requestedRole = body.role === "admin" ? "admin" : "member";
    const [member] = await deps.db
      .select()
      .from(users)
      .where(sql`lower(${users.githubLogin}) = lower(${login})`)
      .limit(1);
    if (member === undefined) throw new ApiError(404, "USER_NOT_FOUND", `no TapeCI user has signed in as ${login}`);
    if (member.id === organization.ownerUserId) {
      throw new ApiError(409, "LAST_OWNER", "the organization owner must remain an owner");
    }
    const [existing] = await deps.db.select({ role: organizationMembers.role }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organization.id), eq(organizationMembers.userId, member.id))).limit(1);
    if (existing?.role === "owner" && organization.ownerUserId !== user.id && role !== "owner") {
      throw new ApiError(403, "ORG_OWNER_REQUIRED", "organization owner role required to change owners");
    }
    const [inserted] = await deps.db
      .insert(organizationMembers)
      .values({ organizationId: organization.id, userId: member.id, role: requestedRole })
      .onConflictDoUpdate({
        target: [organizationMembers.organizationId, organizationMembers.userId],
        set: { role: requestedRole },
      })
      .returning();
    return { member: { userId: member.id, githubLogin: member.githubLogin, role: inserted?.role ?? requestedRole } };
  });

  app.delete("/v1/organizations/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request);
    const params = request.params as { id?: string; userId?: string };
    if (params.id === undefined || params.userId === undefined) {
      throw new ApiError(400, "INVALID_PATH", "organization id and user id are required");
    }
    const { organization, role } = await requireMember(deps, params.id, user.id);
    requireManager(organization, role, user.id);
    if (params.userId === organization.ownerUserId) {
      throw new ApiError(409, "OWNER_REMOVAL", "the organization owner cannot be removed");
    }
    const [target] = await deps.db.select({ role: organizationMembers.role }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organization.id), eq(organizationMembers.userId, params.userId))).limit(1);
    if (target?.role === "owner" && organization.ownerUserId !== user.id && role !== "owner") {
      throw new ApiError(403, "ORG_OWNER_REQUIRED", "organization owner role required to change owners");
    }
    await deps.db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organization.id), eq(organizationMembers.userId, params.userId)));
    void reply.code(204).send();
  });
  app.patch("/v1/organizations/:id/members/:userId", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string; userId?: string };
    if (params.id === undefined || params.userId === undefined) {
      throw new ApiError(400, "INVALID_PATH", "organization id and user id are required");
    }
    const { organization, role } = await requireMember(deps, params.id, user.id);
    requireManager(organization, role, user.id, "ORG_ROLE_REQUIRED");
    const nextRole = organizationRole(recordBody(request.body).role);

    const updated = await deps.db.transaction(async (tx) => {
      // Lock this organization's membership rows so the "last owner" rule is
      // checked against the same rows the write replaces. Without it two owners
      // demoting each other concurrently could both pass the check and leave the
      // organization with no owner — an unrecoverable state through the UI.
      const memberships = await tx
        .select({ userId: organizationMembers.userId, role: organizationMembers.role })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, organization.id))
        .for("update");
      const target = memberships.find((row) => row.userId === params.userId);
      if (target === undefined) {
        throw new ApiError(404, "MEMBER_NOT_FOUND", "this user is not a member of the organization");
      }
      const actorRole = memberships.find((row) => row.userId === user.id)?.role;
      if ((nextRole === "owner" || target.role === "owner" || target.userId === organization.ownerUserId)
        && organization.ownerUserId !== user.id && actorRole !== "owner") {
        throw new ApiError(403, "ORG_OWNER_REQUIRED", "organization owner role required to grant or change owners");
      }
      // Idempotent: re-applying the current role is a no-op that still succeeds,
      // and it records no audit row because nothing changed.
      if (target.role === nextRole) return { userId: target.userId, role: nextRole, changed: false };

      if (target.role === "owner") {
        // `organizations.owner_user_id` is the authority every guard reads, so a
        // demotion that leaves it pointing at a non-owner would make the role
        // column disagree with the permissions actually granted.
        if (organization.ownerUserId === target.userId) {
          throw new ApiError(409, "LAST_OWNER", "the organization owner cannot be demoted");
        }
        const owners = memberships.filter((row) => row.role === "owner").length;
        if (owners <= 1) {
          throw new ApiError(409, "LAST_OWNER", "an organization needs at least one owner");
        }
      }

      await tx
        .update(organizationMembers)
        .set({ role: nextRole })
        .where(
          and(
            eq(organizationMembers.organizationId, organization.id),
            eq(organizationMembers.userId, target.userId),
          ),
        );
      // Same transaction as the write: the audit row can neither survive a
      // rolled-back role change nor be lost after a committed one.
      await tx.insert(auditEvents).values({
        event: "organization.member.role",
        actorUserId: user.id,
        githubLogin: user.githubLogin,
        method: "PATCH",
        route: "/v1/organizations/:id/members/:userId",
        path: `/v1/organizations/${organization.id}/members/${target.userId}`,
        status: 200,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
        requestId: request.id,
        projectId: null,
        organizationId: organization.id,
        metadata: { userId: target.userId, from: target.role, to: nextRole },
      });
      return { userId: target.userId, role: nextRole, changed: true };
    });

    const [member] = await deps.db
      .select({ githubLogin: users.githubLogin, createdAt: organizationMembers.createdAt })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.organizationId, organization.id),
          eq(organizationMembers.userId, updated.userId),
        ),
      )
      .limit(1);
    return {
      member: {
        userId: updated.userId,
        githubLogin: member?.githubLogin ?? null,
        role: updated.role,
        createdAt: member?.createdAt.toISOString() ?? null,
      },
      changed: updated.changed,
    };
  });
  app.get("/v1/organizations/:id/budget", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "organization id is required");
    const { organization } = await requireMember(deps, params.id, user.id);
    const [row] = await deps.db
      .select()
      .from(organizationBudgets)
      .where(eq(organizationBudgets.organizationId, organization.id))
      .limit(1);
    const projectRows = await deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.organizationId, organization.id));
    let spent = 0n;
    for (const project of projectRows) spent += await monthlySpendWei(deps, project.id);
    return {
      monthlyCapWei: row?.monthlyCapWei ?? null,
      spentThisMonthWei: spent.toString(),
      projectCount: projectRows.length,
    };
  });

  app.patch("/v1/organizations/:id/budget", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "organization id is required");
    const { organization, role } = await requireMember(deps, params.id, user.id);
    requireManager(organization, role, user.id);
    const body = recordBody(request.body);
    const cap = body.monthlyCapWei === null ? null : (stringField(body, "monthlyCapWei") ?? "");
    if (cap !== null && !/^\d+$/.test(cap)) {
      throw new ApiError(422, "INVALID_BUDGET", "monthlyCapWei must be an integer string");
    }
    const [row] = await deps.db
      .insert(organizationBudgets)
      .values({ organizationId: organization.id, monthlyCapWei: cap })
      .onConflictDoUpdate({
        target: organizationBudgets.organizationId,
        set: { monthlyCapWei: cap, updatedAt: new Date() },
      })
      .returning();
    return { monthlyCapWei: row?.monthlyCapWei ?? null };
  });

  app.get("/v1/organizations/:id/audit", async (request) => {
    const user = requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) throw new ApiError(400, "INVALID_PATH", "organization id is required");
    const { organization, role } = await requireMember(deps, params.id, user.id);
    if (organization.ownerUserId !== user.id && role !== "owner" && role !== "admin") {
      throw new ApiError(403, "FORBIDDEN", "organization owner/admin role required");
    }
    const query = request.query as Record<string, unknown>;
    const limit = query.limit === undefined ? 100 : Math.min(integerField(query, "limit"), 200);
    // Scope by the recorded organization (org routes plus its projects' events),
    // not by who happens to be a member now.
    const rows = await deps.db
      .select({ event: auditEvents, actorLogin: users.githubLogin })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(eq(auditEvents.organizationId, organization.id))
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
    return {
      events: rows.map(({ event, actorLogin }) => ({
        id: event.id,
        event: event.event,
        actorLogin,
        method: event.method,
        route: event.route,
        status: event.status,
        projectId: event.projectId,
        organizationId: event.organizationId,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  });

}
