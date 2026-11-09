import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  containers,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  deployments,
  githubInstallations,
  migrateUp,
  projects,
  users,
  type Database,
} from "@tapeci/database";
import { loadEnv } from "../../../apps/api/src/env.js";
import { createWorkerRuntime, loadDeploymentArtifact } from "../../../apps/api/src/worker/runtime.js";

const available = await databaseAvailable();
const REGISTRY = "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6";
const CONTAINER = "0x25b20d3ea6b207506340eab2eb0f45edc800f6b3";

describe.skipIf(!available)("worker installation guard", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let objectStoreDir: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrateUp(database.url);
    handle = createDatabase(database.url);
    db = handle.db;
    objectStoreDir = await mkdtemp(join(tmpdir(), "tapeci-guard-"));
  }, 60_000);

  afterAll(async () => {
    await handle?.pool.end();
    await database?.drop();
    if (objectStoreDir !== undefined) await rm(objectStoreDir, { recursive: true, force: true });
  }, 30_000);

  async function fixture(suspended: boolean): Promise<{ deploymentId: string; containerId: string }> {
    const [user] = await db
      .insert(users)
      .values({ githubUserId: suspended ? 7001 : 7002, githubLogin: suspended ? "suspended" : "deleted" })
      .returning();
    const [installation] = await db
      .insert(githubInstallations)
      .values({
        installationId: suspended ? 7001 : 7002,
        githubAccountId: 70,
        accountLogin: "acme",
        suspendedAt: suspended ? new Date() : null,
        deletedAt: suspended ? null : new Date(),
      })
      .returning();
    const [container] = await db
      .insert(containers)
      .values({
        chainId: 196,
        factoryAddress: "0x1f09daefa827f02cbb40967cc91b259763760761",
        processorIndex: 0,
        processorAddress: suspended
          ? "0x839bdd6fa7a66416a609a735e11de5411b98574e"
          : "0x2222222222222222222222222222222222222222",
        tokenId: suspended ? "2" : "3",
        containerAddress: suspended ? CONTAINER : "0x1111111111111111111111111111111111111111",
        registryAddress: REGISTRY,
        bindingAddress: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
        lastObservedOwner: "0x571d447f4f24688ec35ccf07f1d6993655f6af15",
      })
      .returning();
    if (user === undefined || installation === undefined || container === undefined) {
      throw new Error("fixture insert failed");
    }
    const [project] = await db
      .insert(projects)
      .values({
        ownerUserId: user.id,
        githubInstallationId: installation.id,
        githubRepositoryId: suspended ? 7001 : 7002,
        repoFullName: suspended ? "acme/suspended" : "acme/deleted",
        defaultBranch: "main",
        containerId: container.id,
      })
      .returning();
    if (project === undefined) throw new Error("project insert failed");
    const [deployment] = await db
      .insert(deployments)
      .values({
        projectId: project.id,
        containerId: container.id,
        triggerKind: "manual",
        commitSha: (suspended ? "a" : "b").repeat(40),
        state: "BUILT",
        registryAddress: REGISTRY,
      })
      .returning();
    if (deployment === undefined) throw new Error("deployment insert failed");
    return { deploymentId: deployment.id, containerId: container.id };
  }

  it("refuses to load artifacts for a suspended installation", async () => {
    const { deploymentId } = await fixture(true);
    const env = loadEnv({
      DATABASE_URL: database.url,
      SESSION_SIGNING_SECRET: "guard-test-session-secret-123",
      OBJECT_STORE_DIR: objectStoreDir,
    });
    const runtime = createWorkerRuntime({ db, env, operators: [], objectStoreDir });
    await expect(loadDeploymentArtifact(runtime, deploymentId)).rejects.toMatchObject({
      code: "AUTH_REVOKED",
    });
  });

  it("refuses to load artifacts for a deleted installation", async () => {
    const { deploymentId } = await fixture(false);
    const env = loadEnv({
      DATABASE_URL: database.url,
      SESSION_SIGNING_SECRET: "guard-test-session-secret-123",
      OBJECT_STORE_DIR: objectStoreDir,
    });
    const runtime = createWorkerRuntime({ db, env, operators: [], objectStoreDir });
    await expect(loadDeploymentArtifact(runtime, deploymentId)).rejects.toMatchObject({
      code: "AUTH_REVOKED",
    });
  });
});
