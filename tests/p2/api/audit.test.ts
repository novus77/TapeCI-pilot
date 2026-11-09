import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  auditEvents,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  migrateUp,
  type Database,
} from "@tapeci/database";
import { buildApp } from "../../../apps/api/src/app.js";
import { auditScopeResolveFailureCount, resolveAuditScope } from "../../../apps/api/src/audit.js";
import { backfillAuditScopes } from "../../../apps/api/src/audit-backfill.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";

const available = await databaseAvailable();

const env: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: "audit-test-session-secret-123",
  devAuth: true,
  objectStoreDir: ".tapeci/objects",
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: "webhook-secret",
  githubOidcAudience: "tapeci-artifact-upload",
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
  githubAppSlug: null,
  githubOAuthClientId: null,
  githubOAuthClientSecret: null,
  githubOAuthBaseUrl: "https://github.com",
  githubApiBaseUrl: "https://api.github.com",
  publicApiUrl: "http://127.0.0.1:8787",
  webUrl: "http://127.0.0.1:3000",
  sessionTtlSeconds: 3600,
  operatorPrivateKey: null,
  writeRpcUrl: null,
  journalDir: ".tapeci/journal",
  cookieDomain: null,
  maxGasPriceWei: null,
  metricsToken: null,
  rateLimitPerMinute: 600,
  rateLimitDisabled: false,
  auditDisabled: false,
};

describe.skipIf(!available)("API audit logging", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;
  const lines: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrateUp(database.url);
    handle = createDatabase(database.url);
    db = handle.db;
    app = buildApp({ db, env } satisfies ApiDeps);
    await app.ready();
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      lines.push(String(value));
    });
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await handle?.pool.end();
    await database?.drop();
  }, 30_000);

  it("counts resolver failures instead of hiding them", async () => {
    const before = auditScopeResolveFailureCount();
    const failing = {
      select: () => {
        throw new Error("db unavailable");
      },
    } as unknown as Database;
    const scope = await resolveAuditScope(failing, "/v1/projects/00000000-0000-4000-8000-000000000000");
    expect(scope).toEqual({ projectId: null, organizationId: null });
    expect(auditScopeResolveFailureCount()).toBe(before + 1);
  });

  it("backfills only rows that carry a path and reports unrepairable rows", async () => {
    await db.insert(auditEvents).values({
      event: "http_mutation",
      method: "PATCH",
      route: "/v1/projects/:id",
      path: "/v1/projects/00000000-0000-4000-8000-000000000000",
      status: 200,
      ip: "127.0.0.1",
      requestId: "backfill-path",
    });
    await db.insert(auditEvents).values({
      event: "http_mutation",
      method: "PATCH",
      route: "/v1/projects/:id",
      path: null,
      status: 200,
      ip: "127.0.0.1",
      requestId: "backfill-historical",
    });
    const dry = await backfillAuditScopes(db, { apply: false });
    expect(dry.scanned).toBeGreaterThanOrEqual(1);
    expect(dry.unresolved).toBeGreaterThanOrEqual(1);
    expect(dry.historicalWithoutPath).toBeGreaterThanOrEqual(1);
    expect(dry.updated).toBe(0);
  });

  it("emits one structured line for a mutation without bodies or cookies", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: {
        "x-tapeci-github-login": "audit-user",
        "x-tapeci-github-user-id": "7777",
        "user-agent": "audit-test/1.0",
      },
    });
    expect(response.statusCode).toBe(204);
    const record = lines
      .map((line) => JSON.parse(line) as { audit?: Record<string, unknown> })
      .find((entry) => entry.audit?.route === "/v1/auth/logout");
    expect(record?.audit).toMatchObject({
      event: "http_mutation",
      method: "POST",
      route: "/v1/auth/logout",
      status: 204,
      githubLogin: "audit-user",
      userAgent: "audit-test/1.0",
    });
    const [stored] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.route, "/v1/auth/logout"))
      .limit(1);
    expect(stored).toMatchObject({
      method: "POST",
      route: "/v1/auth/logout",
      status: 204,
      githubLogin: "audit-user",
      userAgent: "audit-test/1.0",
    });
    expect(stored?.actorUserId).not.toBeNull();

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("token");
  });
});
