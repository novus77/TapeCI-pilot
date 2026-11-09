import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { exportPKCS8, generateKeyPair } from "jose";
import {
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  githubInstallations,
  migrateUp,
  type Database,
} from "@tapeci/database";
import { loadEnv } from "../../../apps/api/src/env.js";
import { reconcileInstallations } from "../../../apps/api/src/github-reconcile.js";

const available = await databaseAvailable();

describe.skipIf(!available)("installation reconciliation", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let env: ReturnType<typeof loadEnv>;
  let mode: "ok" | "error" = "ok";

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrateUp(database.url);
    handle = createDatabase(database.url);
    db = handle.db;
    const pair = await generateKeyPair("RS256", { extractable: true });
    const privateKey = await exportPKCS8(pair.privateKey);
    env = loadEnv({
      DATABASE_URL: database.url,
      SESSION_SIGNING_SECRET: "reconcile-test-session-secret-123",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_API_BASE_URL: "https://api.github.test",
    });
    await db.insert(githubInstallations).values([
      {
        installationId: 1,
        githubAccountId: 1,
        accountLogin: "old-suspended",
        suspendedAt: new Date("2026-01-01T00:00:00Z"),
      },
      { installationId: 2, githubAccountId: 2, accountLogin: "active" },
      { installationId: 3, githubAccountId: 3, accountLogin: "deleted-upstream" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await handle?.pool.end();
    await database?.drop();
  }, 30_000);

  const fetch = async (input: string | URL | Request): Promise<Response> => {
    if (mode === "error") {
      return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    }
    const url = String(input);
    if (url.startsWith("https://api.github.test/app/installations")) {
      return Response.json([
        {
          id: 1,
          account: { id: 1, login: "old-suspended", type: "Organization" },
          suspended_at: "2026-01-02T00:00:00Z",
        },
        { id: 2, account: { id: 2, login: "renamed-active", type: "User" }, suspended_at: null },
      ]);
    }
    return new Response("not found", { status: 404 });
  };

  async function row(id: number) {
    const [installation] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, id))
      .limit(1);
    return installation;
  }

  it("mirrors GitHub state and soft-deletes missing installations", async () => {
    const result = await reconcileInstallations({
      db,
      env,
      fetch: fetch as typeof globalThis.fetch,
      apiBaseUrl: "https://api.github.test",
      now: () => new Date("2026-10-19T12:00:00Z"),
    });
    expect(result).toMatchObject({
      listed: 2,
      created: 0,
      updated: 2,
      markedDeleted: 1,
      suspended: 1,
    });
    expect((await row(1))?.suspendedAt?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect((await row(2))?.accountLogin).toBe("renamed-active");
    expect((await row(2))?.suspendedAt).toBeNull();
    expect((await row(3))?.deletedAt).not.toBeNull();

    const second = await reconcileInstallations({
      db,
      env,
      fetch: fetch as typeof globalThis.fetch,
      apiBaseUrl: "https://api.github.test",
    });
    expect(second).toMatchObject({ markedDeleted: 0, updated: 2, created: 0 });
  });

  it("does not change state when GitHub fails", async () => {
    mode = "error";
    try {
      await expect(
        reconcileInstallations({
          db,
          env,
          fetch: fetch as typeof globalThis.fetch,
          apiBaseUrl: "https://api.github.test",
        }),
      ).rejects.toMatchObject({ code: "GITHUB_API_ERROR" });
      expect((await row(2))?.deletedAt).toBeNull();
    } finally {
      mode = "ok";
    }
  });
});
