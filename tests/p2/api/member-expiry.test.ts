import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
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

/**
 * Access expiry is enforced on READ, not by a sweeper: a grant that outlives its
 * expiry would be a security bug, and a background job can always lag.
 */

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

const OWNER = { "x-tapeci-github-login": "exp-owner", "x-tapeci-github-user-id": "9301" };
const MEMBER = { "x-tapeci-github-login": "exp-member", "x-tapeci-github-user-id": "9302" };

describe.skipIf(!available)("member access expiry", () => {
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let orgId: string;
  let ownerId: string;
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
    ownerId = await ensureUser(9_301, "exp-owner");
    memberId = await ensureUser(9_302, "exp-member");
    app = buildApp({ db, env } as ApiDeps);
    await app.ready();
    const [org] = await db
      .insert(organizations)
      .values({ name: "Expiry org", slug: "expiry-org", ownerUserId: ownerId })
      .returning();
    if (org === undefined) throw new Error("org fixture missing");
    orgId = org.id;
    await db.insert(organizationMembers).values([
      { organizationId: orgId, userId: ownerId, role: "owner" },
      { organizationId: orgId, userId: memberId, role: "member" },
    ]);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await handle?.pool.end();
    await testDatabase?.drop();
  });

  const get = (actor: Record<string, string>) =>
    app.inject({ method: "GET", url: `/v1/organizations/${orgId}`, headers: actor });

  it("grants access while the membership has not expired", async () => {
    await db
      .update(organizationMembers)
      .set({ expiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(organizationMembers.userId, memberId));
    const response = await get(MEMBER);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).members).toHaveLength(2);
  });

  it("refuses access once the membership has expired", async () => {
    // A past expiry violates the CHECK constraint, so write a just-passed date by
    // temporarily moving created_at into the past as well.
    const past = new Date(Date.now() - 60_000);
    await db
      .update(organizationMembers)
      .set({ createdAt: new Date(Date.now() - 172_800_000), expiresAt: past })
      .where(eq(organizationMembers.userId, memberId));
    const response = await get(MEMBER);
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe("MEMBERSHIP_EXPIRED");
  });

  it("never expires the organization owner", async () => {
    // The owner is the last resort; expiring them would lock the organization out.
    await db
      .update(organizationMembers)
      .set({ createdAt: new Date(Date.now() - 172_800_000), expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(organizationMembers.userId, ownerId));
    const response = await get(OWNER);
    expect(response.statusCode).toBe(200);
  });
});
