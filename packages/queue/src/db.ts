import type {
  Approval,
  Database as DrizzleDatabase,
  Deployment,
  DeploymentEvent,
  OperatorSession,
  WalletChallenge,
} from "@tapeci/database";
import type { Pool, PoolClient } from "pg";
import type { DeploymentState } from "./states.js";

/**
 * Drizzle database handle plus its underlying `pg` pool. `@tapeci/database`'s
 * `createDatabase()` returns this intersection, but the exported `Database` alias
 * drops `$client`; queue code uses raw pooled SQL for CAS operations.
 */
export type Database = DrizzleDatabase & { readonly $client: Pool };

/** A checked-out `pg` client from the Drizzle pool (`db.$client`). */
export type DbClient = PoolClient;

type Row = Record<string, unknown>;

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value));
}

function asNullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

/**
 * Run `fn` inside a single PostgreSQL transaction on one pooled connection.
 *
 * The queue package deliberately uses explicit SQL instead of the Drizzle query
 * builder: state transitions and challenge consumption are compare-and-swap
 * operations whose correctness depends on `FOR UPDATE` / `UPDATE ... WHERE`
 * ordering, which is easier to audit as SQL. The pool itself is shared with
 * `@tapeci/database` consumers.
 */
export async function withTransaction<T>(
  db: Database,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await db.$client.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

export function mapDeploymentRow(row: Row): Deployment {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    containerId: asString(row.container_id),
    createdByUserId: asNullableString(row.created_by_user_id),
    webhookDeliveryId: asNullableString(row.webhook_delivery_id),
    rollbackTargetReleaseId: asNullableString(row.rollback_target_release_id),
    idempotencyKey: asNullableString(row.idempotency_key),
    sourceEventKey: asNullableString(row.source_event_key),
    triggerKind: asString(row.trigger_kind),
    commitSha: asString(row.commit_sha),
    state: asString(row.state) as DeploymentState,
    stateVersion: Number(row.state_version),
    targetChainId: Number(row.target_chain_id),
    registryAddress: asString(row.registry_address),
    artifactSha256: asNullableString(row.artifact_sha256),
    artifactStorageKey: asNullableString(row.artifact_storage_key),
    prepared_artifact_key: asNullableString(row.prepared_artifact_key),
    preparation_request: row.preparation_request ?? null,
    manifestSha256: asNullableString(row.manifest_sha256),
    planJson: row.plan_json ?? null,
    // §12.2: read by the resume path so a reapproved deployment continues the original
    // plan instead of re-planning half-written resources.
    recoveryContext: row.recovery_context ?? null,
    errorCode: asNullableString(row.error_code),
    errorMessage: asNullableString(row.error_message),
    approvedCostCapWei: asNullableString(row.approved_cost_cap_wei),
    estimatedCostWei: asNullableString(row.estimated_cost_wei),
    requestedAt: asDate(row.requested_at),
    startedAt: asNullableDate(row.started_at),
    finishedAt: asNullableDate(row.finished_at),
    updatedAt: asDate(row.updated_at),
  };
}

export function mapDeploymentEventRow(row: Row): DeploymentEvent {
  return {
    id: Number(row.id),
    deploymentId: asString(row.deployment_id),
    oldState: row.old_state === null || row.old_state === undefined
      ? null
      : (asString(row.old_state) as DeploymentState),
    newState: row.new_state === null || row.new_state === undefined
      ? null
      : (asString(row.new_state) as DeploymentState),
    eventType: asString(row.event_type),
    actorKind: asString(row.actor_kind),
    actorId: asNullableString(row.actor_id),
    payload: row.payload ?? {},
    createdAt: asDate(row.created_at),
  };
}

export function mapWalletChallengeRow(row: Row): WalletChallenge {
  return {
    id: asString(row.id),
    address: asString(row.address),
    chainId: Number(row.chain_id),
    nonce: asString(row.nonce),
    message: asString(row.message),
    expiresAt: asDate(row.expires_at),
    consumedAt: asNullableDate(row.consumed_at),
    createdAt: asDate(row.created_at),
  };
}

export function mapApprovalRow(row: Row): Approval {
  return {
    id: asString(row.id),
    deploymentId: asString(row.deployment_id),
    signerAddress: asString(row.signer_address),
    chainId: Number(row.chain_id),
    manifestSha256: asString(row.manifest_sha256),
    approvalDigest: asString(row.approval_digest),
    signature: asString(row.signature),
    approvedCostCapWei: asString(row.approved_cost_cap_wei),
    nonce: asString(row.nonce),
    expiresAt: asDate(row.expires_at),
    createdAt: asDate(row.created_at),
    revokedAt: asNullableDate(row.revoked_at),
  };
}

export function mapOperatorSessionRow(row: Row): OperatorSession {
  return {
    id: asString(row.id),
    containerId: asString(row.container_id),
    signerAddress: asString(row.signer_address),
    approvalId: asNullableString(row.approval_id),
    expiresAt: asDate(row.expires_at),
    revokedAt: asNullableDate(row.revoked_at),
    createdAt: asDate(row.created_at),
  };
}

export async function getDeployment(db: Database, deploymentId: string): Promise<Deployment | null> {
  const result = await db.$client.query<Row>("SELECT * FROM deployments WHERE id = $1", [
    deploymentId,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : mapDeploymentRow(row);
}

export interface DeploymentWithContainer {
  readonly deployment: Deployment;
  readonly containerAddress: string;
}

export async function getDeploymentWithContainer(
  db: Database,
  deploymentId: string,
): Promise<DeploymentWithContainer | null> {
  const result = await db.$client.query<Row>(
    `SELECT d.*, c.container_address AS container_address_value
       FROM deployments d
       JOIN containers c ON c.id = d.container_id
      WHERE d.id = $1`,
    [deploymentId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    deployment: mapDeploymentRow(row),
    containerAddress: asString(row.container_address_value),
  };
}

export async function listDeploymentEvents(
  db: Database,
  deploymentId: string,
  options: { readonly afterId?: number; readonly limit?: number } = {},
): Promise<DeploymentEvent[]> {
  const limit = options.limit ?? 1_000;
  const result =
    options.afterId === undefined
      ? await db.$client.query<Row>(
          "SELECT * FROM deployment_events WHERE deployment_id = $1 ORDER BY id ASC LIMIT $2",
          [deploymentId, limit],
        )
      : await db.$client.query<Row>(
          "SELECT * FROM deployment_events WHERE deployment_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3",
          [deploymentId, options.afterId, limit],
        );
  return result.rows.map(mapDeploymentEventRow);
}

/** PostgreSQL error shape used by the CAS error mapper (no `pg` runtime import needed). */
export interface PgErrorLike {
  readonly code?: string;
  readonly constraint?: string;
  readonly detail?: string;
}

export function asPgError(value: unknown): PgErrorLike | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { code?: unknown; constraint?: unknown; detail?: unknown };
  if (typeof candidate.code !== "string") return null;
  return {
    code: candidate.code,
    ...(typeof candidate.constraint === "string" ? { constraint: candidate.constraint } : {}),
    ...(typeof candidate.detail === "string" ? { detail: candidate.detail } : {}),
  };
}
