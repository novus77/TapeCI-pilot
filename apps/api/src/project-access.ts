import { and, eq, inArray } from "drizzle-orm";
import {
  organizationMembers,
  projectMembers,
  projects,
  type Database,
} from "@tapeci/database";

export type ProjectRole = "viewer" | "member" | "maintainer" | "owner";

const RANK: Record<string, number> = { viewer: 0, member: 1, maintainer: 2, owner: 3 };
const ORG_ROLE: Record<string, ProjectRole> = {
  owner: "owner",
  admin: "maintainer",
  member: "member",
};

export interface ProjectAccess {
  readonly project: typeof projects.$inferSelect;
  readonly role: ProjectRole;
  readonly via: "project" | "organization";
}

/** Highest project role from explicit membership and (if assigned) organization membership. */
export async function projectAccess(
  db: Database,
  projectId: string,
  userId: string,
): Promise<ProjectAccess | null> {
  const [row] = await db
    .select({ project: projects, role: projectMembers.role })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .where(eq(projects.id, projectId))
    .limit(1);
  if (row === undefined) return null;

  let role = (row.role ?? null) as ProjectRole | null;
  let via: "project" | "organization" = "project";
  if (row.project.organizationId !== null) {
    const [orgRow] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, row.project.organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    if (orgRow !== undefined) {
      const inherited = ORG_ROLE[orgRow.role] ?? "member";
      if (role === null || (RANK[inherited] ?? 0) > (RANK[role] ?? 0)) {
        role = inherited;
        via = "organization";
      }
    }
  }
  if (role === null) return null;
  return { project: row.project, role, via };
}

export async function accessibleProjectIds(db: Database, userId: string): Promise<string[]> {
  const direct = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));
  const inherited = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(organizationMembers, eq(organizationMembers.organizationId, projects.organizationId))
    .where(eq(organizationMembers.userId, userId));
  return [...new Set([...direct, ...inherited].map((row) => row.id))];
}

export function canWrite(role: ProjectRole): boolean {
  return (RANK[role] ?? 0) >= 2;
}

export function isOwner(role: ProjectRole): boolean {
  return role === "owner";
}

export async function projectAccessByIds(
  db: Database,
  projectIds: readonly string[],
  userId: string,
): Promise<ProjectAccess[]> {
  if (projectIds.length === 0) return [];
  const rows = await db.select().from(projects).where(inArray(projects.id, [...projectIds]));
  const result: ProjectAccess[] = [];
  for (const project of rows) {
    const access = await projectAccess(db, project.id, userId);
    if (access !== null) result.push(access);
  }
  return result;
}
