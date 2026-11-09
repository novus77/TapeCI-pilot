import { expect } from "vitest";
import {
  containers,
  deployments,
  githubInstallations,
  projects,
  users,
  webhookDeliveries,
  type Database,
  type Deployment,
} from "@tapeci/database";

/** Deterministic, protocol-valid fixture values shared by the P2 database tests. */

const address = (byte: string): string => `0x${byte.repeat(20)}`;

export const FACTORY_ADDRESS = address("11");
export const PROCESSOR_ADDRESS = address("22");
export const CONTAINER_ADDRESS = address("33");
export const REGISTRY_ADDRESS = address("44");
export const BINDING_ADDRESS = address("55");
export const SIGNER_ADDRESS = address("66");
export const TO_ADDRESS = address("77");
export const WALLET_ADDRESS = address("88");

export const COMMIT_SHA = "a".repeat(40);
export const TX_HASH = `0x${"b".repeat(64)}`;
export const MANIFEST_SHA256 = `0x${"c".repeat(64)}`;
export const ENTRY_SHA256 = `0x${"d".repeat(64)}`;
export const OPERATION_FINGERPRINT = `0x${"e".repeat(64)}`;
export const APPROVAL_DIGEST = `0x${"f".repeat(64)}`;

/** First row of a result set, with a loud failure on empty results. */
export function firstRow<Row>(rows: readonly Row[]): Row {
  const [row] = rows;
  if (row === undefined) throw new Error("expected the statement to return a row");
  return row;
}

/** Alias used when the result is expected to come from an INSERT ... RETURNING. */
export const insertOne = firstRow;

export interface SeededCore {
  readonly userId: string;
  readonly installationId: string;
  readonly containerId: string;
  readonly projectId: string;
  readonly deliveryId: string;
  readonly deploymentId: string;
}

/**
 * Insert the minimum viable user -> installation -> container -> project ->
 * webhook delivery -> deployment chain used by most P2 database tests.
 */
export async function seedCore(db: Database): Promise<SeededCore> {
  const user = insertOne(
    await db
      .insert(users)
      .values({ githubUserId: 4_242, githubLogin: "octocat" })
      .returning({ id: users.id }),
  );
  const installation = insertOne(
    await db
      .insert(githubInstallations)
      .values({ installationId: 5_151, githubAccountId: 6_161, accountLogin: "octo-org" })
      .returning({ id: githubInstallations.id }),
  );
  const container = insertOne(
    await db
      .insert(containers)
      .values({
        chainId: 196,
        factoryAddress: FACTORY_ADDRESS,
        processorIndex: 0,
        processorAddress: PROCESSOR_ADDRESS,
        tokenId: "1",
        containerAddress: CONTAINER_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
        bindingAddress: BINDING_ADDRESS,
      })
      .returning({ id: containers.id }),
  );
  const project = insertOne(
    await db
      .insert(projects)
      .values({
        ownerUserId: user.id,
        githubInstallationId: installation.id,
        githubRepositoryId: 7_171,
        repoFullName: "octo-org/site",
        containerId: container.id,
      })
      .returning({ id: projects.id }),
  );
  const delivery = insertOne(
    await db
      .insert(webhookDeliveries)
      .values({
        githubDeliveryId: "delivery-1",
        githubInstallationNumericId: 5_151,
        githubRepositoryId: 7_171,
        eventType: "push",
        ref: "refs/heads/main",
        commitSha: COMMIT_SHA,
        accepted: true,
      })
      .returning({ id: webhookDeliveries.id }),
  );
  const deployment = insertOne(
    await db
      .insert(deployments)
      .values({
        projectId: project.id,
        containerId: container.id,
        createdByUserId: user.id,
        webhookDeliveryId: delivery.id,
        triggerKind: "webhook",
        commitSha: COMMIT_SHA,
        registryAddress: REGISTRY_ADDRESS,
      })
      .returning({ id: deployments.id }),
  );
  return {
    userId: user.id,
    installationId: installation.id,
    containerId: container.id,
    projectId: project.id,
    deliveryId: delivery.id,
    deploymentId: deployment.id,
  };
}

export type DeploymentState = Deployment["state"];

export interface DeploymentOverrides {
  readonly state?: DeploymentState;
  readonly commitSha?: string;
  readonly planJson?: unknown;
  readonly approvedCostCapWei?: string;
  readonly estimatedCostWei?: string;
}

/** Insert another deployment into the seeded project/container. */
export async function insertDeployment(
  db: Database,
  core: SeededCore,
  overrides: DeploymentOverrides = {},
): Promise<string> {
  const values: typeof deployments.$inferInsert = {
    projectId: core.projectId,
    containerId: core.containerId,
    triggerKind: "webhook",
    commitSha: overrides.commitSha ?? COMMIT_SHA,
    registryAddress: REGISTRY_ADDRESS,
    state: overrides.state ?? "RECEIVED",
  };
  if (overrides.planJson !== undefined) values.planJson = overrides.planJson;
  if (overrides.approvedCostCapWei !== undefined) {
    values.approvedCostCapWei = overrides.approvedCostCapWei;
  }
  if (overrides.estimatedCostWei !== undefined) values.estimatedCostWei = overrides.estimatedCostWei;
  const rows = await db.insert(deployments).values(values).returning({ id: deployments.id });
  return insertOne(rows).id;
}

/**
 * Extract the PostgreSQL SQLSTATE from an unknown thrown value (no `any`).
 * Drizzle wraps driver errors in `DrizzleQueryError`, so the raw pg error with
 * its `code` lives on the `cause` chain.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("code" in current && typeof current.code === "string") return current.code;
    if (!("cause" in current)) return undefined;
    current = current.cause;
  }
  return undefined;
}

/** Resolve to the thrown value, or `undefined` when the statement succeeds. */
export async function captureError(run: PromiseLike<unknown>): Promise<unknown> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Wait for `run` to reject and assert the rejection carries `code` as SQLSTATE. */
export async function expectPostgresError(
  run: PromiseLike<unknown>,
  code: string,
): Promise<void> {
  let captured: unknown;
  let rejected = false;
  try {
    await run;
  } catch (error) {
    captured = error;
    rejected = true;
  }
  expect(rejected, "expected the statement to be rejected").toBe(true);
  expect(postgresErrorCode(captured), `expected PostgreSQL error code ${code}`).toBe(code);
}
