import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  deployments,
  githubInstallations,
  migrateUp,
  webhookDeliveries,
  type Database,
} from "@tapeci/database";
import { computeWebhookSignature } from "@tapeci/github";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";
import { realIntegrationEnabled } from "../../../scripts/real-integrations/common.js";

const enabled = realIntegrationEnabled();
const dbAvailable = enabled ? await databaseAvailable() : false;

function runId(): string {
  return `tapeci-real-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

const RUN_ID = runId();
const SECRET = randomBytes(32).toString("hex");
const INSTALLATION_ID = 8_200_000_000 + randomBytes(3).readUIntBE(0, 3);
const ACCOUNT_ID = INSTALLATION_ID + 1;
const REPOSITORY_ID = INSTALLATION_ID + 2;
const COMMIT_SHA = "a".repeat(40);

const env: ApiEnv = {
  databaseUrl: "ephemeral",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: "real-integration-session-secret",
  devAuth: false,
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
  rateLimitDisabled: true,
  auditDisabled: true,
};

describe.skipIf(!enabled)("real GitHub webhook harness opt-in", () => {
  it("is enabled only through TAPECI_REAL_INTEGRATIONS=1", () => {
    expect(realIntegrationEnabled()).toBe(true);
  });
});

describe.skipIf(!enabled || !dbAvailable)("GitHub webhook delivery over HTTP and PostgreSQL", () => {
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

  function pushPayload(): string {
    return JSON.stringify({
      ref: "refs/heads/main",
      before: "0".repeat(40),
      after: COMMIT_SHA,
      created: false,
      deleted: false,
      forced: false,
      repository: {
        id: REPOSITORY_ID,
        name: "webhook-fixture",
        full_name: `tapeci-${RUN_ID}/webhook-fixture`,
        owner: { id: ACCOUNT_ID, login: `tapeci-${RUN_ID}` },
        default_branch: "main",
      },
      installation: { id: INSTALLATION_ID },
      pusher: { name: "tapeci-real-integration" },
    });
  }

  function installationPayload(
    action: "created" | "suspend" | "unsuspend" | "deleted" | "new_permissions_accepted",
    suspendedAt: string | null = null,
  ): string {
    return JSON.stringify({
      action,
      installation: {
        id: INSTALLATION_ID,
        account: {
          id: ACCOUNT_ID,
          login: `tapeci-${RUN_ID}`,
          type: "Organization",
        },
        suspended_at: suspendedAt,
      },
    });
  }

  async function post(
    event: "push" | "installation",
    body: string,
    deliveryId: string,
    options: { readonly signature?: string } = {},
  ) {
    return app.inject({
      method: "POST",
      url: "/v1/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256":
          options.signature ?? computeWebhookSignature(SECRET, body),
      },
      payload: body,
    });
  }

  it("creates an installation and persists its lifecycle through real HTTP", async () => {
    const created = await post(
      "installation",
      installationPayload("created"),
      `${RUN_ID}-installation-created`,
    );
    expect(created.statusCode).toBe(202);

    const [inserted] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, INSTALLATION_ID));
    expect(inserted).toMatchObject({
      installationId: INSTALLATION_ID,
      githubAccountId: ACCOUNT_ID,
      suspendedAt: null,
      deletedAt: null,
    });

    const suspendedAt = new Date().toISOString();
    expect(
      (
        await post(
          "installation",
          installationPayload("suspend", suspendedAt),
          `${RUN_ID}-installation-suspend`,
        )
      ).statusCode,
    ).toBe(202);
    const [suspended] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, INSTALLATION_ID));
    expect(suspended?.suspendedAt?.toISOString()).toBe(suspendedAt);

    expect(
      (
        await post(
          "installation",
          installationPayload("unsuspend"),
          `${RUN_ID}-installation-unsuspend`,
        )
      ).statusCode,
    ).toBe(202);
    const [unsuspended] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, INSTALLATION_ID));
    expect(unsuspended?.suspendedAt).toBeNull();

    expect(
      (
        await post(
          "installation",
          installationPayload("deleted"),
          `${RUN_ID}-installation-deleted`,
        )
      ).statusCode,
    ).toBe(202);
    const [deleted] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, INSTALLATION_ID));
    expect(deleted?.deletedAt).not.toBeNull();
  });

  it("rejects a bad signature without persisting a delivery", async () => {
    const response = await post(
      "installation",
      installationPayload("new_permissions_accepted"),
      `${RUN_ID}-bad-signature`,
      { signature: "sha256=deadbeef" },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_WEBHOOK_SIGNATURE" },
    });
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.githubDeliveryId, `${RUN_ID}-bad-signature`));
    expect(rows).toHaveLength(0);
  });

  it("records an installation delivery exactly once when replayed", async () => {
    const body = installationPayload("new_permissions_accepted");
    const deliveryId = `${RUN_ID}-installation-replay`;
    const first = await post("installation", body, deliveryId);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ duplicate: false, accepted: true });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const replay = await post("installation", body, deliveryId);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ duplicate: true, accepted: true });
    }

    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.githubDeliveryId, deliveryId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "installation",
      accepted: true,
      githubInstallationNumericId: INSTALLATION_ID,
    });
  });

  it("rejects a push whose installation has no authorized project", async () => {
    const body = pushPayload();
    const response = await post("push", body, `${RUN_ID}-push-unowned`);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      accepted: false,
      errorCode: "REPOSITORY_NOT_AUTHORIZED",
    });

    const [delivery] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.githubDeliveryId, `${RUN_ID}-push-unowned`));
    expect(delivery).toMatchObject({
      eventType: "push",
      accepted: false,
      errorCode: "REPOSITORY_NOT_AUTHORIZED",
      githubInstallationNumericId: INSTALLATION_ID,
      githubRepositoryId: REPOSITORY_ID,
      commitSha: COMMIT_SHA,
    });
    expect(await db.select().from(deployments)).toHaveLength(0);
  });

  it("accepts the same signed payload concurrently and records one delivery", async () => {
    const body = pushPayload();
    const deliveryId = `${RUN_ID}-push-concurrent`;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => post("push", body, deliveryId)),
    );
    expect(responses.filter((response) => response.statusCode === 422)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(4);
    expect(
      responses.filter(
        (response) => (response.json() as { duplicate: boolean }).duplicate,
      ),
    ).toHaveLength(4);

    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.githubDeliveryId, deliveryId));
    expect(rows).toHaveLength(1);
  });

  it("uses a random, non-production delivery namespace", () => {
    expect(RUN_ID).toMatch(/^tapeci-real-[0-9]+-[0-9a-f]{12}$/);
    expect(randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
