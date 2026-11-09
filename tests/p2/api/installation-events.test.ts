import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  githubInstallations,
  migrateUp,
  type Database,
} from "@tapeci/database";
import { computeWebhookSignature } from "@tapeci/github";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";

const available = await databaseAvailable();
const SECRET = "installation-webhook-secret";

const env: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: "installation-test-session-secret-123",
  devAuth: true,
  objectStoreDir: ".tapeci/objects",
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: SECRET,
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
};

describe.skipIf(!available)("GitHub installation webhook events", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrateUp(database.url);
    handle = createDatabase(database.url);
    db = handle.db;
    app = buildApp({ db, env } satisfies ApiDeps);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await handle?.pool.end();
    await database?.drop();
  }, 30_000);

  function payload(action: string, suspendedAt: string | null = null): string {
    return JSON.stringify({
      action,
      installation: {
        id: 9001,
        account: { id: 77, login: "acme", type: "Organization" },
        suspended_at: suspendedAt,
      },
    });
  }

  async function post(
    body: string,
    deliveryId: string,
    signature = computeWebhookSignature(SECRET, body),
  ) {
    return app.inject({
      method: "POST",
      url: "/v1/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signature,
      },
      payload: body,
    });
  }

  async function row() {
    const [installation] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, 9001))
      .limit(1);
    return installation;
  }

  it("creates, suspends, unsuspends and soft-deletes an installation", async () => {
    expect((await post(payload("created"), "evt-1")).statusCode).toBe(202);
    expect(await row()).toMatchObject({ accountLogin: "acme", suspendedAt: null, deletedAt: null });

    const suspendedAt = new Date().toISOString();
    expect((await post(payload("suspend", suspendedAt), "evt-2")).statusCode).toBe(202);
    expect((await row())?.suspendedAt).not.toBeNull();

    expect((await post(payload("unsuspend"), "evt-3")).statusCode).toBe(202);
    expect((await row())?.suspendedAt).toBeNull();

    expect((await post(payload("deleted"), "evt-4")).statusCode).toBe(202);
    expect((await row())?.deletedAt).not.toBeNull();
  });

  it("deduplicates a delivery id and rejects bad signatures/actions", async () => {
    const body = payload("suspend", new Date().toISOString());
    expect((await post(body, "evt-5")).statusCode).toBe(202);
    const duplicate = await post(body, "evt-5");
    expect(duplicate.statusCode).toBe(200);
    expect((duplicate.json() as { duplicate: boolean }).duplicate).toBe(true);

    expect((await post(body, "evt-6", "sha256=deadbeef")).statusCode).toBe(401);
    expect((await post(payload("renamed-random"), "evt-7")).statusCode).toBe(422);
  });
});
