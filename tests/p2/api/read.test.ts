import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  auditEvents,
  containers,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  deploymentEvents,
  deployments,
  githubInstallations,
  migrateUp,
  organizations,
  projects,
  releases,
  users,
  type Database,
} from "@tapeci/database";
import type { Hex } from "@tapeci/shared";
import { resolveAuditScope } from "../../../apps/api/src/audit.js";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps, ResolvedContainer } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";

const CONTAINER = "0x25b20d3ea6b207506340eab2eb0f45edc800f6b3" as Hex;
const available = await databaseAvailable();

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

const resolved: ResolvedContainer = {
  address: CONTAINER,
  factory: "0x1f09daefa827f02cbb40967cc91b259763760761",
  opener: "0x536add8f30f03b69f6fbf29d425a816a0dc50106",
  registry: "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
  binding: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
  processorIndex: 0,
  processor: "0x839bdd6fa7a66416a609a735e11de5411b98574e",
  tokenId: "2",
  owner: "0x571d447f4f24688ec35ccf07f1d6993655f6af15",
  opened: true,
};

const devHeaders = {
  "x-tapeci-github-login": "dev-user",
  "x-tapeci-github-user-id": "4242",
  "content-type": "application/json",
};

/**
 * Distinct user-agent values act as per-request markers in audit rows: the row
 * has no field the caller can set, so a unique agent is the cheapest way to
 * pin a predicate to one specific request.
 */
const settingsPatchProbe = "tapeci-read-test/settings-patch";
const orgBudgetPatchProbe = "tapeci-read-test/org-budget-patch";
const forgedDrainProbe = "tapeci-read-test/forged-drain";

/**
 * The audit hook persists on `onResponse`, i.e. after the response has already
 * been delivered, so a test must wait for the row instead of racing it.
 */
async function waitForAuditRow(
  db: Database,
  predicate: (row: typeof auditEvents.$inferSelect) => boolean,
): Promise<typeof auditEvents.$inferSelect> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await db.select().from(auditEvents);
    const match = rows.findLast(predicate);
    if (match !== undefined) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("audit row did not appear within 5s");
}

describe.skipIf(!available)("P2 API read routes", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let databaseHandle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    database = testDatabase;
    await migrateUp(testDatabase.url);
    databaseHandle = createDatabase(testDatabase.url);
    db = databaseHandle.db;
    const deps: ApiDeps = { db, env, resolveContainer: async () => resolved };
    app = buildApp(deps);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await databaseHandle?.pool.end();
    await database?.drop();
  }, 30_000);

  it("health is public and /v1/me resolves the dev user", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true, service: "tapeci-api" });
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["x-frame-options"]).toBe("DENY");
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: devHeaders });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ githubLogin: "dev-user" });
    expect(me.headers["cache-control"]).toBe("no-store");
  });

  it("creates a project from a resolved container and lists it", async () => {
    await app.inject({ method: "GET", url: "/v1/me", headers: devHeaders });
    const [installation] = await db
      .insert(githubInstallations)
      .values({ installationId: 77, githubAccountId: 77, accountLogin: "acme" })
      .returning();
    const create = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: devHeaders,
      payload: {
        repoFullName: "acme/site",
        githubRepositoryId: 1234,
        defaultBranch: "main",
        containerAddress: CONTAINER,
        githubInstallationId: installation?.id,
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { project: { id: string } };

    const list = await app.inject({ method: "GET", url: "/v1/projects", headers: devHeaders });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { projects: unknown[] }).projects).toHaveLength(1);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/projects/${created.project.id}`,
      headers: devHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { project: { repoFullName: string } }).project.repoFullName).toBe(
      "acme/site",
    );

    const members = await app.inject({
      method: "GET",
      url: `/v1/projects/${created.project.id}/members`,
      headers: devHeaders,
    });
    expect(members.statusCode).toBe(200);
    expect((members.json() as { canManage: boolean }).canManage).toBe(true);

    const settings = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${created.project.id}`,
      headers: { ...devHeaders, "user-agent": settingsPatchProbe },
      payload: { outputDirectory: "public", buildCommand: "npm run build:site" },
    });
    expect(settings.statusCode).toBe(200);
    expect((settings.json() as { project: { outputDirectory: string } }).project.outputDirectory).toBe("public");

    // Three PATCHes hit `/v1/projects/:id` with status 200 in this test, so the
    // predicate must key on something unique to this request (its user-agent)
    // instead of route+status, or it silently matches a later mutation.
    const settingsEvent = await waitForAuditRow(
      db,
      (row) => row.route === "/v1/projects/:id" && row.userAgent === settingsPatchProbe,
    );
    expect(settingsEvent.projectId).toBe(created.project.id);
    expect(settingsEvent.organizationId).toBeNull();

    const audit = await app.inject({ method: "GET", url: "/v1/audit", headers: devHeaders });
    expect(audit.statusCode).toBe(200);
    expect(Array.isArray((audit.json() as { events: unknown[] }).events)).toBe(true);

    // A malformed filter must be a client error, not a Postgres uuid cast 500.
    const badFilter = await app.inject({
      method: "GET",
      url: "/v1/audit?projectId=not-a-uuid",
      headers: devHeaders,
    });
    expect(badFilter.statusCode).toBe(422);
    expect((badFilter.json() as { error: { code: string } }).error.code).toBe("INVALID_PROJECT_ID");

    // A repeated parameter parses to an array; it must not silently fall back
    // to the unfiltered list (that would return other projects' events).
    const arrayFilter = await app.inject({
      method: "GET",
      url: `/v1/audit?projectId=${created.project.id}&projectId=not-a-uuid`,
      headers: devHeaders,
    });
    expect(arrayFilter.statusCode).toBe(422);
    expect((arrayFilter.json() as { error: { code: string } }).error.code).toBe("INVALID_PROJECT_ID");

    const notifications = await app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: devHeaders,
    });
    expect(notifications.statusCode).toBe(200);
    expect(Array.isArray((notifications.json() as { notifications: unknown[] }).notifications)).toBe(true);

    const deliveries = await app.inject({
      method: "GET",
      url: "/v1/github/webhook-deliveries",
      headers: devHeaders,
    });
    expect(deliveries.statusCode).toBe(200);

    const compare = await app.inject({
      method: "GET",
      url: `/v1/projects/${created.project.id}/releases/compare`,
      headers: devHeaders,
    });
    expect(compare.statusCode).toBe(422);

    const allAudit = await app.inject({
      method: "GET",
      url: "/v1/audit?scope=all",
      headers: devHeaders,
    });
    expect(allAudit.statusCode).toBe(403);

    const read = await app.inject({
      method: "POST",
      url: "/v1/notifications/read",
      headers: devHeaders,
      payload: { deploymentIds: [] },
    });
    expect(read.statusCode).toBe(200);

    const archived = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${created.project.id}`,
      headers: devHeaders,
      payload: { isArchived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect((archived.json() as { project: { isArchived: boolean } }).project.isArchived).toBe(true);

    const rollback = await app.inject({
      method: "POST",
      url: `/v1/projects/${created.project.id}/rollback`,
      headers: devHeaders,
      payload: { releaseId: "missing" },
    });
    expect(rollback.statusCode).toBe(409);
    expect((rollback.json() as { error: { code: string } }).error.code).toBe("PROJECT_ARCHIVED");

    const budget = await app.inject({
      method: "GET",
      url: `/v1/projects/${created.project.id}/budget`,
      headers: devHeaders,
    });
    expect(budget.statusCode).toBe(200);
    const budgetSet = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${created.project.id}/budget`,
      headers: devHeaders,
      payload: { monthlyCapWei: "1000000000000000" },
    });
    expect(budgetSet.statusCode).toBe(200);

    const policy = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${created.project.id}/approval-policy`,
      headers: devHeaders,
      payload: { requiredRole: "owner", expiresInSeconds: 600, maxCostCapWei: "1000000000000000" },
    });
    expect(policy.statusCode).toBe(200);

    const badChannel = await app.inject({
      method: "POST",
      url: `/v1/projects/${created.project.id}/notification-channels`,
      headers: devHeaders,
      payload: { kind: "slack", target: "https://example.com/hook" },
    });
    expect(badChannel.statusCode).toBe(422);

    const channel = await app.inject({
      method: "POST",
      url: `/v1/projects/${created.project.id}/notification-channels`,
      headers: devHeaders,
      payload: { kind: "slack", target: "https://hooks.slack.com/services/T000/B000/XXX" },
    });
    expect(channel.statusCode).toBe(200);
    const channelId = (channel.json() as { channel: { id: string } }).channel.id;
    const channels = await app.inject({
      method: "GET",
      url: `/v1/projects/${created.project.id}/notification-channels`,
      headers: devHeaders,
    });
    expect((channels.json() as { channels: unknown[] }).channels).toHaveLength(1);
    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${created.project.id}/notification-channels/${channelId}`,
      headers: devHeaders,
    });
    expect(removed.statusCode).toBe(204);
    const testEmpty = await app.inject({
      method: "POST",
      url: `/v1/projects/${created.project.id}/notification-channels/test`,
      headers: devHeaders,
    });
    expect(testEmpty.statusCode).toBe(409);

    const org = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: devHeaders,
      payload: { name: "Acme Platform" },
    });
    expect(org.statusCode).toBe(200);
    const orgId = (org.json() as { organization: { id: string } }).organization.id;
    const orgList = await app.inject({ method: "GET", url: "/v1/organizations", headers: devHeaders });
    expect((orgList.json() as { organizations: unknown[] }).organizations).toHaveLength(1);
    const orgDetail = await app.inject({ method: "GET", url: `/v1/organizations/${orgId}`, headers: devHeaders });
    expect(orgDetail.statusCode).toBe(200);
    expect((orgDetail.json() as { canManage: boolean }).canManage).toBe(true);
    // Adding the organization's own owner is refused (their role is fixed), so
    // seed a second person and add them instead.
    await db.insert(users).values({ githubUserId: 5_501, githubLogin: "org-teammate" });
    const orgMember = await app.inject({
      method: "POST",
      url: `/v1/organizations/${orgId}/members`,
      headers: devHeaders,
      payload: { githubLogin: "org-teammate", role: "admin" },
    });
    expect(orgMember.statusCode).toBe(200);

    // An organization-scoped mutation (not a project one) must record the org.
    const orgBudget = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${orgId}/budget`,
      headers: { ...devHeaders, "user-agent": orgBudgetPatchProbe },
      payload: { monthlyCapWei: "1000000000000000" },
    });
    expect(orgBudget.statusCode).toBe(200);
    const orgBudgetEvent = await waitForAuditRow(
      db,
      (row) => row.route === "/v1/organizations/:id/budget" && row.userAgent === orgBudgetPatchProbe,
    );
    expect(orgBudgetEvent).toMatchObject({
      method: "PATCH",
      status: 200,
      projectId: null,
      organizationId: orgId,
    });

    const [userB] = await db
      .insert(users)
      .values({ githubUserId: 5555, githubLogin: "bob" })
      .returning();
    if (userB === undefined) throw new Error("user seed failed");
    await app.inject({
      method: "POST",
      url: `/v1/organizations/${orgId}/members`,
      headers: devHeaders,
      payload: { githubLogin: "bob", role: "member" },
    });
    const assigned = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${created.project.id}`,
      headers: devHeaders,
      payload: { organizationId: orgId },
    });
    expect(assigned.statusCode).toBe(200);

    // The PATCH that assigned the project to the org must record both ids.
    const assignmentEvent = await waitForAuditRow(
      db,
      (row) =>
        row.route === "/v1/projects/:id" &&
        row.projectId === created.project.id &&
        row.organizationId === orgId,
    );
    expect(assignmentEvent).toMatchObject({
      method: "PATCH",
      projectId: created.project.id,
      organizationId: orgId,
    });

    const projectAudit = await app.inject({
      method: "GET",
      url: `/v1/audit?projectId=${created.project.id}`,
      headers: devHeaders,
    });
    expect(projectAudit.statusCode).toBe(200);
    const projectAuditBody = projectAudit.json() as {
      projectId: string | null;
      events: Array<{ projectId: string | null; organizationId: string | null }>;
    };
    expect(projectAuditBody.projectId).toBe(created.project.id);
    expect(projectAuditBody.events.length).toBeGreaterThan(0);
    expect(projectAuditBody.events.every((row) => row.projectId === created.project.id)).toBe(true);

    // A second project's events must not leak into the first project's filter.
    const [containerRow] = await db.select().from(containers).limit(1);
    if (containerRow === undefined) throw new Error("container fixture missing");
    const [installationRow] = await db.select().from(githubInstallations).limit(1);
    if (installationRow === undefined) throw new Error("installation fixture missing");
    const [otherProject] = await db
      .insert(projects)
      .values({
        ownerUserId: userB.id,
        githubInstallationId: installationRow.id,
        githubRepositoryId: 9_999,
        repoFullName: "acme/other",
        containerId: containerRow.id,
      })
      .returning();
    if (otherProject === undefined) throw new Error("second project seed failed");
    const [otherAudit] = await db
      .insert(auditEvents)
      .values({
        event: "http_mutation",
        actorUserId: userB.id,
        githubLogin: "bob",
        method: "PATCH",
        route: "/v1/projects/:id",
        status: 200,
        ip: "127.0.0.1",
        projectId: otherProject.id,
        organizationId: null,
      })
      .returning();
    if (otherAudit === undefined) throw new Error("other audit seed failed");
    const scopeAdminApp = buildApp({
      db,
      env: { ...env, adminLogins: ["dev-user"] },
      resolveContainer: async () => resolved,
    });
    await scopeAdminApp.ready();
    try {
      const filtered = await scopeAdminApp.inject({
        method: "GET",
        url: `/v1/audit?scope=all&projectId=${created.project.id}`,
        headers: devHeaders,
      });
      expect(filtered.statusCode).toBe(200);
      const filteredEvents = (filtered.json() as { events: Array<{ projectId: string | null }> })
        .events;
      expect(filteredEvents.length).toBeGreaterThan(0);
      expect(filteredEvents.every((row) => row.projectId === created.project.id)).toBe(true);
      expect(filteredEvents.some((row) => row.projectId === otherProject.id)).toBe(false);
    } finally {
      await scopeAdminApp.close();
    }

    // Org audit must contain a known event for this org and exclude an event
    // belonging to a different org. `every(organizationId === orgId)` would be
    // tautological with the WHERE clause: a mutation that recorded NULL scope
    // is simply absent from the result set and every() still passes.
    const [otherOrg] = await db
      .insert(organizations)
      .values({ name: "Other Platform", slug: "other-platform", ownerUserId: userB.id })
      .returning();
    if (otherOrg === undefined) throw new Error("second organization seed failed");
    const [otherOrgAudit] = await db
      .insert(auditEvents)
      .values({
        event: "http_mutation",
        actorUserId: userB.id,
        githubLogin: "bob",
        method: "PATCH",
        route: "/v1/organizations/:id/budget",
        status: 200,
        ip: "127.0.0.1",
        projectId: null,
        organizationId: otherOrg.id,
      })
      .returning();
    if (otherOrgAudit === undefined) throw new Error("other org audit seed failed");
    const orgAudit = await app.inject({
      method: "GET",
      url: `/v1/organizations/${orgId}/audit`,
      headers: devHeaders,
    });
    expect(orgAudit.statusCode).toBe(200);
    const orgEventIds = (orgAudit.json() as { events: Array<{ id: string }> }).events.map((row) => row.id);
    // Present: the org's own PATCH and the project event assigned to it.
    expect(orgEventIds).toContain(orgBudgetEvent.id);
    expect(orgEventIds).toContain(assignmentEvent.id);
    // Absent: a different org's event, and a project event with no org scope.
    expect(orgEventIds).not.toContain(otherOrgAudit.id);
    expect(orgEventIds).not.toContain(otherAudit.id);
    // Negative limit is a client error, not a Postgres 500.
    const badLimit = await app.inject({
      method: "GET",
      url: `/v1/organizations/${orgId}/audit?limit=-1`,
      headers: devHeaders,
    });
    expect(badLimit.statusCode).toBe(400);
    expect((badLimit.json() as { error: { code: string } }).error.code).toBe("INVALID_BODY");
    const bobHeaders = {
      "x-tapeci-github-login": "bob",
      "x-tapeci-github-user-id": "5555",
      "content-type": "application/json",
    };
    const inheritedRead = await app.inject({
      method: "GET",
      url: `/v1/projects/${created.project.id}`,
      headers: bobHeaders,
    });
    expect(inheritedRead.statusCode).toBe(200);
    const inheritedList = await app.inject({ method: "GET", url: "/v1/projects", headers: bobHeaders });
    expect((inheritedList.json() as { projects: unknown[] }).projects).toHaveLength(1);
    const unrelatedAudit = await app.inject({
      method: "GET",
      url: `/v1/audit?projectId=${created.project.id}`,
      headers: { "x-tapeci-github-login": "other-user", "x-tapeci-github-user-id": "6666" },
    });
    expect(unrelatedAudit.statusCode).toBe(404);
    const inheritedWrite = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${created.project.id}`,
      headers: bobHeaders,
      payload: { isArchived: true },
    });
    expect(inheritedWrite.statusCode).toBe(403);

    // Unmatched routes must not create audit rows (cross-tenant forgery): the
    // raw path names a real project id, so scope resolution would bind the row
    // to it even though no route ran. The 404 envelope echoes the request id,
    // which makes the absence check exact instead of route-string matching.
    const forged = await app.inject({
      method: "POST",
      url: `/v1/projects/${created.project.id}/definitely-not-a-route`,
      headers: devHeaders,
    });
    expect(forged.statusCode).toBe(404);
    const forgedRequestId = (forged.json() as { requestId: string }).requestId;
    expect(forgedRequestId.length).toBeGreaterThan(0);

    // Drain with a *known* audited write issued after the forged request: once
    // its row lands, the hook has demonstrably run past the forged request too,
    // so a later read can prove no row was written for it.
    const drain = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { ...devHeaders, "user-agent": forgedDrainProbe },
    });
    expect(drain.statusCode).toBe(204);
    await waitForAuditRow(db, (row) => row.userAgent === forgedDrainProbe);
    // Poll rather than read once, so a write still in flight cannot slip past.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const forgedRows = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.requestId, forgedRequestId));
      expect(forgedRows).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const adminApp = buildApp({
      db,
      env: { ...env, adminLogins: ["dev-user"] },
      resolveContainer: async () => resolved,
    });
    await adminApp.ready();
    try {
      const me = await adminApp.inject({ method: "GET", url: "/v1/me", headers: devHeaders });
      expect((me.json() as { isAdmin: boolean }).isAdmin).toBe(true);
      const adminAudit = await adminApp.inject({
        method: "GET",
        url: "/v1/audit?scope=all",
        headers: devHeaders,
      });
      expect(adminAudit.statusCode).toBe(200);
      expect((adminAudit.json() as { scope: string }).scope).toBe("all");
    } finally {
      await adminApp.close();
    }
  });

  it("serves deployment list/detail/events/plan/verification only to members", async () => {
    await app.inject({ method: "GET", url: "/v1/me", headers: devHeaders });
    const insertedContainers = await db
      .insert(containers)
      .values({
        chainId: 196,
        factoryAddress: resolved.factory,
        processorIndex: 0,
        processorAddress: resolved.processor,
        tokenId: "2",
        containerAddress: CONTAINER,
        registryAddress: resolved.registry,
        bindingAddress: resolved.binding,
        lastObservedOwner: resolved.owner,
      })
      .onConflictDoNothing()
      .returning();
    const container =
      insertedContainers[0] ??
      (
        await db
          .select()
          .from(containers)
          .where(eq(containers.containerAddress, CONTAINER))
          .limit(1)
      )[0];
    const [project] = await db.select().from(projects).limit(1);
    if (project === undefined || container === undefined) throw new Error("project fixture missing");

    const [deployment] = await db
      .insert(deployments)
      .values({
        projectId: project.id,
        containerId: container.id,
        triggerKind: "manual",
        commitSha: "a".repeat(40),
        state: "PLAN_READY",
        registryAddress: resolved.registry,
        planJson: { schemaVersion: "tapeci.plan.v1" },
        manifestSha256: `0x${"11".repeat(32)}`,
      })
      .returning();
    if (deployment === undefined) throw new Error("deployment fixture missing");
    await db.insert(deploymentEvents).values({
      deploymentId: deployment.id,
      oldState: "VALIDATING",
      newState: "PLAN_READY",
      eventType: "plan_ready",
      actorKind: "worker",
      payload: { writes: 1 },
    });
    await db.insert(releases).values({
      projectId: project.id,
      deploymentId: deployment.id,
      releaseId: "r-aaaaaaaaaaaa-11111111",
      commitSha: "a".repeat(40),
      manifestSha256: `0x${"11".repeat(32)}`,
      entrySha256: `0x${"22".repeat(32)}`,
      entryPath: "index.html",
      verifyReport: { status: "VERIFIED", releaseMatch: true },
      verifiedBlockNumber: "123",
      isCurrent: true,
    });

    const list = await app.inject({ method: "GET", url: "/v1/deployments", headers: devHeaders });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { deployments: Array<{ id: string }> }).deployments[0]?.id).toBe(
      deployment.id,
    );

    const events = await app.inject({
      method: "GET",
      url: `/v1/deployments/${deployment.id}/events`,
      headers: devHeaders,
    });
    expect((events.json() as { events: unknown[] }).events).toHaveLength(1);

    const plan = await app.inject({
      method: "GET",
      url: `/v1/deployments/${deployment.id}/plan`,
      headers: devHeaders,
    });
    expect(plan.statusCode).toBe(200);

    const verification = await app.inject({
      method: "GET",
      url: `/v1/deployments/${deployment.id}/verification`,
      headers: devHeaders,
    });
    expect(verification.statusCode).toBe(200);
    expect((verification.json() as { releaseId: string }).releaseId).toBe(
      "r-aaaaaaaaaaaa-11111111",
    );

    const otherHeaders = {
      "x-tapeci-github-login": "other-user",
      "x-tapeci-github-user-id": "6666",
    };
    const forbidden = await app.inject({
      method: "GET",
      url: `/v1/deployments/${deployment.id}`,
      headers: otherHeaders,
    });
    expect(forbidden.statusCode).toBe(404);

    // Deployment-scoped mutations inherit the owning project's scope.
    expect(await resolveAuditScope(db, `/v1/deployments/${deployment.id}/approve`)).toEqual({
      projectId: project.id,
      organizationId: project.organizationId,
    });
    // Unknown ids and unrelated routes record no scope instead of failing.
    expect(await resolveAuditScope(db, "/v1/deployments/00000000-0000-0000-0000-000000000000/execute"))
      .toEqual({ projectId: null, organizationId: null });
    expect(await resolveAuditScope(db, "/v1/notifications/read")).toEqual({
      projectId: null,
      organizationId: null,
    });
  });
});
