import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  containers,
  githubInstallations,
  projectMembers,
  projects,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  migrateUp,
  organizationMembers,
  organizations,
  users,
  type Database,
} from "@tapeci/database";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";

const env: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: "test-session-secret-123456",
  devAuth: true,
  objectStoreDir: ".tapeci/objects",
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: "test-webhook-secret",
  githubOidcAudience: "tapeci-artifact-upload",
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
  operatorPrivateKey: null,
  writeRpcUrl: null,
  journalDir: ".tapeci/journal",
  githubAppSlug: null,
  githubOAuthClientId: null,
  githubOAuthClientSecret: null,
  githubOAuthBaseUrl: "https://github.com",
  githubApiBaseUrl: "https://api.github.com",
  publicApiUrl: "http://127.0.0.1:8787",
  webUrl: "http://127.0.0.1:3000",
  sessionTtlSeconds: 604_800,
};

/**
 * Organization member role change. DB-backed; skips cleanly without Postgres.
 * No network and no chain: the route only touches Postgres and audit_events.
 */

const available = await databaseAvailable();

const OWNER = { "x-tapeci-github-login": "owner-user", "x-tapeci-github-user-id": "9201" };
const ADMIN = { "x-tapeci-github-login": "admin-user", "x-tapeci-github-user-id": "9202" };
const MEMBER = { "x-tapeci-github-login": "member-user", "x-tapeci-github-user-id": "9203" };
const JSON_HEADERS = { "content-type": "application/json" };

describe.skipIf(!available)("organization member role", () => {
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let orgId: string;
  let ownerId: string;
  let adminId: string;
  let memberId: string;

  async function ensureUser(numeric: number, login: string): Promise<string> {
    const existing = await db.select().from(users).where(eq(users.githubLogin, login)).limit(1);
    if (existing[0] !== undefined) return existing[0].id;
    const [created] = await db
      .insert(users)
      .values({ githubLogin: login, githubUserId: numeric })
      .returning();
    if (created === undefined) throw new Error("user fixture missing");
    return created.id;
  }

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await migrateUp(testDatabase.url);
    handle = createDatabase(testDatabase.url);
    db = handle.db;
    ownerId = await ensureUser(9_201, "owner-user");
    adminId = await ensureUser(9_202, "admin-user");
    memberId = await ensureUser(9_203, "member-user");
    app = buildApp({ db, env } as ApiDeps);
    await app.ready();
  }, 120_000);

  beforeEach(async () => {
    await db.delete(auditEvents);
    await db.delete(organizationMembers);
    await db.delete(organizations);
    const [org] = await db
      .insert(organizations)
      .values({ name: "TapeCI maintainers", slug: "tapeci-group", ownerUserId: ownerId })
      .returning();
    if (org === undefined) throw new Error("org fixture missing");
    orgId = org.id;
    await db.insert(organizationMembers).values([
      { organizationId: orgId, userId: ownerId, role: "owner" },
      { organizationId: orgId, userId: adminId, role: "admin" },
      { organizationId: orgId, userId: memberId, role: "member" },
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await handle?.pool.end();
    await testDatabase?.drop();
  });

  const patch = (actor: Record<string, string>, userId: string, body: unknown) =>
    app.inject({
      method: "PATCH",
      url: `/v1/organizations/${orgId}/members/${userId}`,
      headers: { ...actor, ...JSON_HEADERS },
      payload: JSON.stringify(body),
    });

  it("lists effective project access and protects project role changes", async () => {
    const [installation] = await db.insert(githubInstallations).values({ installationId: 9981, githubAccountId: 9981, accountLogin: "member-test" }).returning();
    const address = `0x${"11".repeat(20)}`;
    const [container] = await db.insert(containers).values({ chainId: 196, factoryAddress: address, processorIndex: 0,
      processorAddress: address, tokenId: "9981", containerAddress: address, registryAddress: address, bindingAddress: address }).returning();
    if (installation === undefined || container === undefined) throw new Error("missing project fixture");
    const [project] = await db.insert(projects).values({ ownerUserId: ownerId, organizationId: orgId,
      githubInstallationId: installation.id, githubRepositoryId: 9981, repoFullName: "member-test/site", containerId: container.id }).returning();
    if (project === undefined) throw new Error("missing project");
    try {
      await db.insert(projectMembers).values([
        { projectId: project.id, userId: ownerId, role: "owner" },
        { projectId: project.id, userId: adminId, role: "member" },
      ]);
      await db.insert(auditEvents).values({ event: "member-test", method: "PATCH", route: "/test", path: "/test", status: 200,
        actorUserId: adminId, projectId: project.id, ip: "127.0.0.1", createdAt: new Date("2026-10-01T00:00:00Z") });
      const listing = await app.inject({ method: "GET", url: `/v1/projects/${project.id}/members`, headers: OWNER });
      expect(listing.statusCode).toBe(200);
      const body = listing.json();
      expect(body.protectedUserId).toBe(ownerId);
      expect(body.members).toHaveLength(3);
      expect(body.members).toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: ownerId, role: "owner", source: "direct", directRole: "owner", inheritedRole: "owner" }),
        expect.objectContaining({ userId: adminId, role: "maintainer", source: "inherited", directRole: "member", lastActivityAt: "2026-10-01T00:00:00.000Z" }),
        expect.objectContaining({ userId: memberId, role: "member", source: "inherited", directRole: null, lastActivityAt: null }),
      ]));
      await db.insert(projectMembers).values({ projectId: project.id, userId: memberId, role: "member" });
      const equalGrants = await app.inject({ method: "GET", url: `/v1/projects/${project.id}/members`, headers: OWNER });
      expect(equalGrants.json().members).toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: memberId, role: "member", source: "direct", directRole: "member", inheritedRole: "member", lastActivityAt: null }),
      ]));
      const removal = await app.inject({ method: "DELETE", url: `/v1/projects/${project.id}/members/${memberId}`, headers: OWNER });
      expect(removal.statusCode).toBe(204);
      const retained = await app.inject({ method: "GET", url: `/v1/projects/${project.id}/members`, headers: MEMBER });
      expect(retained.statusCode).toBe(200);
      expect(retained.json().members).toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: memberId, role: "member", source: "inherited", directRole: null, inheritedRole: "member" }),
      ]));
      const update = (actor: Record<string, string>, userId: string, role: string) => app.inject({ method: "PATCH",
        url: `/v1/projects/${project.id}/members/${userId}`, headers: { ...actor, ...JSON_HEADERS }, payload: { role } });
      expect((await update(ADMIN, adminId, "owner")).statusCode).toBe(403);
      expect((await update(OWNER, ownerId, "member")).statusCode).toBe(409);
      const ownerUpsert = await app.inject({ method: "POST", url: `/v1/projects/${project.id}/members`,
        headers: { ...OWNER, ...JSON_HEADERS }, payload: { githubLogin: "owner-user", role: "member" } });
      expect(ownerUpsert.statusCode).toBe(409);
      expect((await update(OWNER, adminId, "admin")).statusCode).toBe(400);
      expect((await update(OWNER, memberId, "owner")).statusCode).toBe(404);
      const promoted = await update(OWNER, adminId, "owner");
      expect(promoted.statusCode).toBe(200);
      expect(promoted.json().member.role).toBe("owner");
      const demoted = await update(OWNER, adminId, "member");
      expect(demoted.statusCode).toBe(200);
      expect((await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, adminId))))[0]?.role).toBe("member");
    } finally {
      await db.delete(auditEvents).where(eq(auditEvents.projectId, project.id));
      await db.delete(projectMembers).where(eq(projectMembers.projectId, project.id));
      await db.delete(projects).where(eq(projects.id, project.id));
      await db.delete(containers).where(eq(containers.id, container.id));
      await db.delete(githubInstallations).where(eq(githubInstallations.id, installation.id));
    }
  });

  it("promotes a member and records an audit event", async () => {
    const res = await patch(OWNER, memberId, { role: "admin" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).member.role).toBe("admin");
    const [row] = await db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, memberId)));
    expect(row?.role).toBe("admin");
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.event, "organization.member.role"));
    expect(audit).toBeDefined();
    expect((audit?.metadata as { from: string; to: string }).to).toBe("admin");
  });

  it("is idempotent when the role is unchanged", async () => {
    const first = await patch(OWNER, memberId, { role: "member" });
    const second = await patch(OWNER, memberId, { role: "member" });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.event, "organization.member.role"));
    expect(audits.length).toBe(0);
  });

  it("allows an admin to change another member's role", async () => {
    const res = await patch(ADMIN, memberId, { role: "admin" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects admin self-escalation without changing membership or recording a role event", async () => {
    const res = await patch(ADMIN, adminId, { role: "owner" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ORG_OWNER_REQUIRED");
    const [member] = await db.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, adminId)));
    expect(member?.role).toBe("admin");
    expect(await db.select().from(auditEvents).where(eq(auditEvents.event, "organization.member.role"))).toHaveLength(0);
  });

  it("allows designated and membership owners to grant owner authority", async () => {
    expect((await patch(OWNER, adminId, { role: "owner" })).statusCode).toBe(200);
    expect((await patch(ADMIN, memberId, { role: "owner" })).statusCode).toBe(200);
  });

  it("rejects admin changes to existing owners", async () => {
    expect((await patch(ADMIN, ownerId, { role: "member" })).statusCode).toBe(403);
    await patch(OWNER, memberId, { role: "owner" });
    expect((await patch(ADMIN, memberId, { role: "member" })).statusCode).toBe(403);
    expect((await patch(ADMIN, memberId, { role: "owner" })).statusCode).toBe(403);
    const upsert = await app.inject({ method: "POST", url: `/v1/organizations/${orgId}/members`,
      headers: { ...ADMIN, ...JSON_HEADERS }, payload: { githubLogin: "member-user", role: "member" } });
    expect(upsert.statusCode).toBe(403);
    const removal = await app.inject({ method: "DELETE", url: `/v1/organizations/${orgId}/members/${memberId}`, headers: ADMIN });
    expect(removal.statusCode).toBe(403);
  });

  it("exposes the designated protected owner and no invented activity", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/organizations/${orgId}`, headers: OWNER });
    expect(res.statusCode).toBe(200);
    expect(res.json().protectedUserId).toBe(ownerId);
    expect(res.json().members.every((member: { lastActivityAt: string | null }) => member.lastActivityAt === null)).toBe(true);
  });

  it("refuses a plain member", async () => {
    const res = await patch(MEMBER, adminId, { role: "member" });
    expect(res.statusCode).toBe(403);
  });

  it("protects the organization owner through the add-member route", async () => {
    const response = await app.inject({ method: "POST", url: `/v1/organizations/${orgId}/members`,
      headers: { ...ADMIN, ...JSON_HEADERS }, payload: { githubLogin: "owner-user", role: "member" } });
    expect(response.statusCode).toBe(409);
    const [owner] = await db.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, ownerId)));
    expect(owner?.role).toBe("owner");
  });

  it("refuses demoting the organization owner", async () => {
    const res = await patch(OWNER, ownerId, { role: "member" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("LAST_OWNER");
  });

  it("returns 404 for a user outside the organization", async () => {
    const res = await patch(OWNER, "00000000-0000-4000-8000-000000000000", { role: "member" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("rejects an unknown role value", async () => {
    const res = await patch(OWNER, memberId, { role: "superuser" });
    expect(res.statusCode).toBe(400);
  });

  it("refuses an actor who is not a member of the organization", async () => {
    // Dev auth maps a header-less request to `dev-user`, who is not seeded as a
    // member here, so the request must fail before any role check runs.
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${orgId}/members/${memberId}`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ role: "admin" }),
    });
    expect(res.statusCode).toBe(404);
    const [row] = await db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, memberId)));
    expect(row?.role).toBe("member");
  });
});
