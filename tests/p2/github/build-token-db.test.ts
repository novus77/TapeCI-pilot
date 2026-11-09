import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildTokens, databaseAvailable } from "@tapeci/database";
import type { GithubError } from "@tapeci/github";
import {
  consumeBuildToken,
  issueBuildToken,
  registerBuildToken,
  verifyAndConsumeBuildToken,
  verifyBuildToken,
} from "@tapeci/github";
import {
  TEST_COMMIT_SHA,
  createMigratedTestDatabase,
  resetDatabase,
  seedDeployment,
  seedProject,
  type SeededProject,
  type TestDatabaseHandle,
} from "./helpers.js";

const dbAvailable = await databaseAvailable();
const BUILD_TOKEN_SECRET = "test-session-signing-secret-0001";
const REF = "refs/heads/main";

async function insertTokenRow(
  handle: TestDatabaseHandle,
  values: {
    readonly jti: string;
    readonly deploymentId: string;
    readonly repositoryId: number;
    readonly commitSha?: string;
    readonly ref?: string;
    readonly expiresAt?: Date;
  },
): Promise<void> {
  await handle.db.insert(buildTokens).values({
    jti: values.jti,
    deploymentId: values.deploymentId,
    repositoryId: values.repositoryId,
    commitSha: values.commitSha ?? TEST_COMMIT_SHA,
    ref: values.ref ?? REF,
    expiresAt: values.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
  });
}

describe.skipIf(!dbAvailable)("build token consumption (PostgreSQL)", () => {
  let handle: TestDatabaseHandle;
  let seeded: SeededProject;
  let deploymentId: string;

  beforeAll(async () => {
    handle = await createMigratedTestDatabase();
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(handle.db);
    seeded = await seedProject(handle.db);
    deploymentId = await seedDeployment(handle.db, seeded);
  });

  it("consumes a token exactly once and rejects replay", async () => {
    const jti = randomUUID();
    await insertTokenRow(handle, { jti, deploymentId, repositoryId: 987_001 });
    const consumed = await consumeBuildToken(handle.db, jti);
    expect(consumed.jti).toBe(jti);
    expect(consumed.deploymentId).toBe(deploymentId);
    expect(consumed.consumedAt).toBeInstanceOf(Date);

    const [row] = await handle.db.select().from(buildTokens).where(eq(buildTokens.jti, jti));
    expect(row?.consumedAt).not.toBeNull();

    await expect(consumeBuildToken(handle.db, jti)).rejects.toMatchObject({
      code: "BUILD_TOKEN_REPLAYED",
    });
  });

  it("consumes an issued token via verifyAndConsumeBuildToken and rejects replay", async () => {
    const issued = await issueBuildToken({
      deploymentId,
      repositoryId: 987_001,
      commitSha: TEST_COMMIT_SHA,
      ref: REF,
      secret: BUILD_TOKEN_SECRET,
    });
    await registerBuildToken(handle.db, issued.claims);
    const consumed = await verifyAndConsumeBuildToken(
      handle.db,
      issued.token,
      BUILD_TOKEN_SECRET,
    );
    expect(consumed.jti).toBe(issued.jti);
    await expect(
      verifyAndConsumeBuildToken(handle.db, issued.token, BUILD_TOKEN_SECRET),
    ).rejects.toMatchObject({ code: "BUILD_TOKEN_REPLAYED" });
  });

  it("does not resurrect a consumed row via registerBuildToken", async () => {
    const issued = await issueBuildToken({
      deploymentId,
      repositoryId: 987_001,
      commitSha: TEST_COMMIT_SHA,
      ref: REF,
      secret: BUILD_TOKEN_SECRET,
    });
    await registerBuildToken(handle.db, issued.claims);
    await consumeBuildToken(handle.db, issued.jti);
    await registerBuildToken(handle.db, issued.claims);
    await expect(consumeBuildToken(handle.db, issued.jti)).rejects.toMatchObject({
      code: "BUILD_TOKEN_REPLAYED",
    });
  });

  it("rejects expired token rows", async () => {
    const jti = randomUUID();
    await insertTokenRow(handle, {
      jti,
      deploymentId,
      repositoryId: 987_001,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(consumeBuildToken(handle.db, jti)).rejects.toMatchObject({
      code: "BUILD_TOKEN_EXPIRED",
    });
  });

  it("rejects unknown and malformed jtis", async () => {
    await expect(consumeBuildToken(handle.db, randomUUID())).rejects.toMatchObject({
      code: "BUILD_TOKEN_NOT_FOUND",
    });
    await expect(consumeBuildToken(handle.db, "not-a-uuid")).rejects.toMatchObject({
      code: "BUILD_TOKEN_INVALID",
    });
  });

  it("is race-safe: two concurrent consumptions yield exactly one success", async () => {
    const jti = randomUUID();
    await insertTokenRow(handle, { jti, deploymentId, repositoryId: 987_001 });
    const results = await Promise.allSettled([
      consumeBuildToken(handle.db, jti),
      consumeBuildToken(handle.db, jti),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as GithubError).code).toBe("BUILD_TOKEN_REPLAYED");
  });

  it("rejects a token whose claims do not match the issued row", async () => {
    const jti = randomUUID();
    await insertTokenRow(handle, {
      jti,
      deploymentId,
      repositoryId: 987_001,
      ref: REF,
    });
    const issued = await issueBuildToken({
      deploymentId,
      repositoryId: 987_001,
      commitSha: TEST_COMMIT_SHA,
      ref: "refs/heads/other",
      secret: BUILD_TOKEN_SECRET,
      jti,
    });
    await expect(
      verifyAndConsumeBuildToken(handle.db, issued.token, BUILD_TOKEN_SECRET),
    ).rejects.toMatchObject({ code: "BUILD_TOKEN_MISMATCH" });
    // A mismatched token must not burn the row.
    const [row] = await handle.db.select().from(buildTokens).where(eq(buildTokens.jti, jti));
    expect(row?.consumedAt).toBeNull();
  });

  it("rejects a token whose row was never issued", async () => {
    const issued = await issueBuildToken({
      deploymentId,
      repositoryId: 987_001,
      commitSha: TEST_COMMIT_SHA,
      ref: REF,
      secret: BUILD_TOKEN_SECRET,
    });
    await expect(
      verifyAndConsumeBuildToken(handle.db, issued.token, BUILD_TOKEN_SECRET),
    ).rejects.toMatchObject({ code: "BUILD_TOKEN_NOT_FOUND" });
    // The JWT itself is still cryptographically valid.
    await expect(
      verifyBuildToken({ token: issued.token, secret: BUILD_TOKEN_SECRET }),
    ).resolves.toMatchObject({ jti: issued.jti });
  });
});
