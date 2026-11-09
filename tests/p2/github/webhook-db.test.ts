import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  databaseAvailable,
  deploymentEvents,
  deployments,
  githubInstallations,
  webhookDeliveries,
} from "@tapeci/database";
import { handlePushWebhook } from "@tapeci/github";
import {
  TEST_COMMIT_SHA,
  TEST_DEFAULT_BRANCH,
  TEST_INSTALLATION_ID,
  TEST_REPOSITORY_ID,
  TEST_WEBHOOK_SECRET,
  createMigratedTestDatabase,
  makePushPayload,
  resetDatabase,
  seedProject,
  signPushRequest,
  type SeededProject,
  type TestDatabaseHandle,
} from "./helpers.js";

const dbAvailable = await databaseAvailable();

async function countRows(handle: TestDatabaseHandle, table: "deployments" | "deliveries"): Promise<number> {
  const selected =
    table === "deployments"
      ? handle.db.select({ count: sql<number>`count(*)::int` }).from(deployments)
      : handle.db.select({ count: sql<number>`count(*)::int` }).from(webhookDeliveries);
  const [row] = await selected;
  return row?.count ?? 0;
}

describe.skipIf(!dbAvailable)("handlePushWebhook (PostgreSQL)", () => {
  let handle: TestDatabaseHandle;
  let seeded: SeededProject;

  beforeAll(async () => {
    handle = await createMigratedTestDatabase();
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(handle.db);
    seeded = await seedProject(handle.db);
  });

  async function deliver(options: {
    readonly deliveryId: string;
    readonly payload?: Record<string, unknown>;
    readonly event?: string;
    readonly signSecret?: string;
    readonly mutateRawBody?: (rawBody: string) => string;
  }) {
    const payload = options.payload ?? makePushPayload();
    const request = signPushRequest(payload, {
      deliveryId: options.deliveryId,
      secret: options.signSecret ?? TEST_WEBHOOK_SECRET,
      ...(options.event === undefined ? {} : { event: options.event }),
    });
    return handlePushWebhook({
      db: handle.db,
      deliveryId: options.deliveryId,
      event: options.event ?? "push",
      headers: request.headers,
      rawBody:
        options.mutateRawBody === undefined
          ? request.rawBody
          : options.mutateRawBody(request.rawBody),
      secret: TEST_WEBHOOK_SECRET,
    });
  }

  it("creates a RECEIVED deployment and marks the delivery accepted", async () => {
    const result = await deliver({ deliveryId: "delivery-accepted-1" });
    expect(result).toMatchObject({ duplicate: false, accepted: true });
    expect(result.deploymentId).toBeTypeOf("string");

    const [deployment] = await handle.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, result.deploymentId ?? ""));
    expect(deployment).toBeDefined();
    expect(deployment?.state).toBe("RECEIVED");
    expect(deployment?.triggerKind).toBe("webhook");
    expect(deployment?.commitSha).toBe(TEST_COMMIT_SHA);
    expect(deployment?.projectId).toBe(seeded.projectId);
    expect(deployment?.containerId).toBe(seeded.containerId);
    expect(deployment?.registryAddress).toBe(seeded.registryAddress);
    expect(deployment?.sourceEventKey).toBe(
      `${TEST_REPOSITORY_ID}:${TEST_COMMIT_SHA}:${TEST_DEFAULT_BRANCH}`,
    );

    const [delivery] = await handle.db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({
      githubDeliveryId: "delivery-accepted-1",
      eventType: "push",
      accepted: true,
      errorCode: null,
      ref: `refs/heads/${TEST_DEFAULT_BRANCH}`,
      commitSha: TEST_COMMIT_SHA,
      githubInstallationNumericId: TEST_INSTALLATION_ID,
    });
    expect(delivery?.processedAt).not.toBeNull();
    expect(delivery?.id).toBe(deployment?.webhookDeliveryId);

    const events = await handle.db
      .select()
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deploymentId, result.deploymentId ?? ""));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "WEBHOOK_RECEIVED",
      actorKind: "webhook",
      newState: "RECEIVED",
      oldState: null,
    });
  });

  it("deduplicates 10 replays of the same delivery into one deployment", async () => {
    const results = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      results.push(await deliver({ deliveryId: "delivery-replayed" }));
    }
    expect(results[0]).toMatchObject({ duplicate: false, accepted: true });
    for (const replay of results.slice(1)) {
      expect(replay).toMatchObject({ duplicate: true, accepted: true });
      expect(replay.deploymentId).toBe(results[0]?.deploymentId);
    }
    expect(await countRows(handle, "deployments")).toBe(1);
    expect(await countRows(handle, "deliveries")).toBe(1);
  });

  it("deduplicates concurrent replays of the same delivery", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => deliver({ deliveryId: "delivery-concurrent" })),
    );
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(4);
    expect(new Set(results.map((result) => result.deploymentId)).size).toBe(1);
    expect(await countRows(handle, "deployments")).toBe(1);
    expect(await countRows(handle, "deliveries")).toBe(1);
  });

  it("deduplicates a second delivery of the same commit+branch via source_event_key", async () => {
    const first = await deliver({ deliveryId: "delivery-source-event-1" });
    const second = await deliver({ deliveryId: "delivery-source-event-2" });
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({
      duplicate: true,
      accepted: true,
      deploymentId: first.deploymentId,
    });
    expect(await countRows(handle, "deployments")).toBe(1);
    expect(await countRows(handle, "deliveries")).toBe(2);
    const deliveries = await handle.db.select().from(webhookDeliveries);
    expect(deliveries.every((row) => row.accepted)).toBe(true);
  });

  it("rejects a repository that has no authorized project", async () => {
    const result = await deliver({
      deliveryId: "delivery-unowned-repo",
      payload: makePushPayload({ repositoryId: 999_999 }),
    });
    expect(result).toEqual({
      duplicate: false,
      accepted: false,
      errorCode: "REPOSITORY_NOT_AUTHORIZED",
    });
    const [delivery] = await handle.db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({
      accepted: false,
      errorCode: "REPOSITORY_NOT_AUTHORIZED",
    });
    expect(delivery?.processedAt).not.toBeNull();
    expect(await countRows(handle, "deployments")).toBe(0);
  });

  it("rejects a push for a non-default branch", async () => {
    const result = await deliver({
      deliveryId: "delivery-other-branch",
      payload: makePushPayload({ ref: "refs/heads/feature/other" }),
    });
    expect(result.errorCode).toBe("REPOSITORY_NOT_AUTHORIZED");
    expect(await countRows(handle, "deployments")).toBe(0);
  });

  it("rejects a suspended installation with AUTH_REVOKED", async () => {
    await handle.db
      .update(githubInstallations)
      .set({ suspendedAt: new Date() })
      .where(eq(githubInstallations.id, seeded.installationRowId));
    const result = await deliver({ deliveryId: "delivery-suspended" });
    expect(result).toEqual({
      duplicate: false,
      accepted: false,
      errorCode: "AUTH_REVOKED",
    });
    expect(await countRows(handle, "deployments")).toBe(0);
  });

  it("rejects a deleted installation with AUTH_REVOKED", async () => {
    await handle.db
      .update(githubInstallations)
      .set({ deletedAt: new Date() })
      .where(eq(githubInstallations.id, seeded.installationRowId));
    const result = await deliver({ deliveryId: "delivery-deleted" });
    expect(result.errorCode).toBe("AUTH_REVOKED");
  });

  it("rejects a push from an installation that does not own the project", async () => {
    const result = await deliver({
      deliveryId: "delivery-wrong-installation",
      payload: makePushPayload({ installationId: 777_777 }),
    });
    expect(result.errorCode).toBe("AUTH_REVOKED");
  });

  it("records unsupported events without creating a deployment", async () => {
    const result = await deliver({
      deliveryId: "delivery-unsupported-event",
      event: "installation",
      payload: { action: "created" },
    });
    expect(result).toEqual({
      duplicate: false,
      accepted: false,
      errorCode: "UNSUPPORTED_EVENT",
    });
    const [delivery] = await handle.db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({ eventType: "installation", accepted: false });
  });

  it("records malformed push payloads without creating a deployment", async () => {
    const result = await deliver({
      deliveryId: "delivery-invalid-payload",
      payload: { ref: "refs/heads/main" },
    });
    expect(result).toEqual({
      duplicate: false,
      accepted: false,
      errorCode: "INVALID_PAYLOAD",
    });
    expect(await countRows(handle, "deployments")).toBe(0);
  });

  it("records deleted branch pushes without creating a deployment", async () => {
    const result = await deliver({
      deliveryId: "delivery-deleted-branch",
      payload: makePushPayload({ deleted: true }),
    });
    expect(result).toEqual({
      duplicate: false,
      accepted: false,
      errorCode: "PUSH_DELETED",
    });
    expect(await countRows(handle, "deployments")).toBe(0);
  });

  it("rejects a bad signature without writing a delivery row", async () => {
    const result = await deliver({
      deliveryId: "delivery-bad-signature",
      signSecret: "the-wrong-secret",
    });
    // Signed with "the-wrong-secret", verified against TEST_WEBHOOK_SECRET.
    expect(result).toEqual({
      duplicate: false,
      accepted: false,
      errorCode: "SIGNATURE_INVALID",
    });
    expect(await countRows(handle, "deliveries")).toBe(0);
  });
});
