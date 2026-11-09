import { randomBytes, randomInt } from "node:crypto";
import {
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  migrateUp,
} from "@tapeci/database";
import {
  checkRedisAvailable,
  type Database,
  type DeploymentQueue,
  type DeploymentState,
} from "@tapeci/queue";

export const TEST_REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:56379";

export interface ServiceAvailability {
  readonly database: boolean;
  readonly redis: boolean;
}

/** Probe local services once at module load so suites can skip cleanly. */
export async function detectServices(): Promise<ServiceAvailability> {
  const [database, redis] = await Promise.all([
    databaseAvailable(),
    checkRedisAvailable({ url: TEST_REDIS_URL, timeoutMs: 1_000 }),
  ]);
  return { database, redis };
}

export interface TestDatabaseHandle {
  readonly db: Database;
  readonly url: string;
  close(): Promise<void>;
}

/** Ephemeral PostgreSQL database with all migrations applied. */
export async function setupTestDatabase(): Promise<TestDatabaseHandle> {
  const ephemeral = await createTestDatabase();
  await migrateUp(ephemeral.url);
  const { db, pool } = createDatabase(ephemeral.url);
  return {
    db: db as Database,
    url: ephemeral.url,
    close: async () => {
      await pool.end();
      await ephemeral.drop();
    },
  };
}

export function randomAddress(): `0x${string}` {
  return `0x${randomBytes(20).toString("hex")}`;
}

export function randomHash32(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}`;
}

export function randomCommitSha(): string {
  return randomBytes(20).toString("hex");
}

export interface SeedDeploymentOptions {
  readonly state?: DeploymentState;
  readonly stateVersion?: number;
  readonly containerAddress?: string;
  readonly registryAddress?: string;
  readonly manifestSha256?: string | null;
  readonly commitSha?: string;
  readonly approvedCostCapWei?: string | null;
}

export interface SeededDeployment {
  readonly deploymentId: string;
  readonly containerId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly containerAddress: string;
  readonly registryAddress: string;
  readonly commitSha: string;
  readonly manifestSha256: string | null;
  readonly state: DeploymentState;
}

/**
 * Insert the minimal FK chain (user → installation → container → project →
 * deployment) needed by queue tests. Every call gets fresh addresses/ids, so
 * tests never share rows.
 */
export async function seedDeployment(
  db: Database,
  options: SeedDeploymentOptions = {},
): Promise<SeededDeployment> {
  const containerAddress = options.containerAddress ?? randomAddress();
  const registryAddress = options.registryAddress ?? randomAddress();
  const state = options.state ?? "RECEIVED";
  const commitSha = options.commitSha ?? randomCommitSha();
  const manifestSha256 = options.manifestSha256 ?? randomHash32();
  const githubUserId = randomInt(1, 2_000_000_000);
  const installationId = randomInt(1, 2_000_000_000);
  const repositoryId = randomInt(1, 2_000_000_000);
  const processorAddress = randomAddress();

  const user = await db.$client.query<{ id: string }>(
    "INSERT INTO users (github_user_id, github_login) VALUES ($1, $2) RETURNING id",
    [githubUserId, `test-user-${githubUserId}`],
  );
  const userId = user.rows[0]?.id;
  if (userId === undefined) throw new Error("seed: user insert failed");

  const installation = await db.$client.query<{ id: string }>(
    `INSERT INTO github_installations (installation_id, github_account_id, account_login)
     VALUES ($1, $2, $3) RETURNING id`,
    [installationId, githubUserId, `test-installation-${installationId}`],
  );
  const installationRowId = installation.rows[0]?.id;
  if (installationRowId === undefined) throw new Error("seed: installation insert failed");

  const container = await db.$client.query<{ id: string }>(
    `INSERT INTO containers
       (chain_id, factory_address, processor_index, processor_address, token_id,
        container_address, registry_address, binding_address)
     VALUES (196, $1, 0, $2, 1, $3, $4, $5)
     RETURNING id`,
    [randomAddress(), processorAddress, containerAddress, registryAddress, randomAddress()],
  );
  const containerId = container.rows[0]?.id;
  if (containerId === undefined) throw new Error("seed: container insert failed");

  const project = await db.$client.query<{ id: string }>(
    `INSERT INTO projects
       (owner_user_id, github_installation_id, github_repository_id, repo_full_name, container_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, installationRowId, repositoryId, `tapeci-test/${repositoryId}`, containerId],
  );
  const projectId = project.rows[0]?.id;
  if (projectId === undefined) throw new Error("seed: project insert failed");

  const deployment = await db.$client.query<{ id: string }>(
    `INSERT INTO deployments
       (project_id, container_id, trigger_kind, commit_sha, state, state_version,
        registry_address, manifest_sha256, approved_cost_cap_wei)
     VALUES ($1, $2, 'manual', $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      projectId,
      containerId,
      commitSha,
      state,
      options.stateVersion ?? 0,
      registryAddress,
      manifestSha256,
      options.approvedCostCapWei ?? null,
    ],
  );
  const deploymentId = deployment.rows[0]?.id;
  if (deploymentId === undefined) throw new Error("seed: deployment insert failed");

  return {
    deploymentId,
    containerId,
    projectId,
    userId,
    containerAddress: containerAddress.toLowerCase(),
    registryAddress: registryAddress.toLowerCase(),
    commitSha,
    manifestSha256,
    state,
  };
}

export interface SeedDeploymentRowOptions {
  readonly projectId: string;
  readonly containerId: string;
  readonly registryAddress: string;
  readonly state?: DeploymentState;
  readonly stateVersion?: number;
  readonly manifestSha256?: string | null;
  readonly commitSha?: string;
}

/**
 * Insert an extra deployment for an existing project/container (used for the
 * one-chain-writer-per-container partial unique index test).
 */
export async function seedDeploymentRow(
  db: Database,
  options: SeedDeploymentRowOptions,
): Promise<{ deploymentId: string; commitSha: string }> {
  const commitSha = options.commitSha ?? randomCommitSha();
  const result = await db.$client.query<{ id: string }>(
    `INSERT INTO deployments
       (project_id, container_id, trigger_kind, commit_sha, state, state_version,
        registry_address, manifest_sha256)
     VALUES ($1, $2, 'manual', $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      options.projectId,
      options.containerId,
      commitSha,
      options.state ?? "RECEIVED",
      options.stateVersion ?? 0,
      options.registryAddress,
      options.manifestSha256 ?? randomHash32(),
    ],
  );
  const deploymentId = result.rows[0]?.id;
  if (deploymentId === undefined) throw new Error("seed: deployment insert failed");
  return { deploymentId, commitSha };
}

export async function waitFor<T>(
  probe: () => Promise<T | null>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}

export interface FinishedJob {
  readonly jobId: string;
  readonly state: "completed" | "failed";
  readonly failedReason: string | null;
  readonly attemptsMade: number;
}

/** Poll a BullMQ queue until its job reaches a terminal state. */
export async function waitForJob(
  queue: DeploymentQueue,
  jobId: string,
  timeoutMs = 20_000,
): Promise<FinishedJob> {
  return waitFor(
    async () => {
      const job = await queue.getJob(jobId);
      if (job === undefined) return null;
      const state = await job.getState();
      if (state !== "completed" && state !== "failed") return null;
      return {
        jobId,
        state,
        failedReason: job.failedReason ?? null,
        attemptsMade: job.attemptsMade,
      };
    },
    { timeoutMs, intervalMs: 25 },
  );
}
