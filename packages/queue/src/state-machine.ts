import type { Deployment } from "@tapeci/database";
import { TapeCiError } from "@tapeci/shared";
import {
  asPgError,
  getDeployment,
  mapDeploymentRow,
  withTransaction,
  type Database,
  type DbClient,
} from "./db.js";
import {
  isActorKind,
  isDeploymentState,
  isErrorTerminalState,
  isTerminalState,
  type ActorKind,
  type DeploymentState,
} from "./states.js";

/**
 * PRD §6.2 transition map. The happy path is:
 *
 * `RECEIVED → BUILDING → BUILT → VALIDATING → PLAN_READY → AWAITING_APPROVAL →
 *  APPROVED → UPLOADING_ASSETS → VERIFYING_ASSETS → SWITCHING_ENTRY →
 *  VERIFYING_RELEASE → LIVE`
 *
 * plus fail-closed/error endpoints. Every edge that is not listed here is invalid.
 * In particular there is no edge that lets a worker skip verification and jump to
 * `LIVE`, and `LIVE` is only reachable from `VERIFYING_RELEASE`.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<DeploymentState, readonly DeploymentState[]>> = {
  RECEIVED: ["BUILDING", "BUILD_FAILED", "CANCELED"],
  BUILDING: ["BUILT", "BUILD_FAILED", "CANCELED"],
  BUILT: ["VALIDATING", "PLAN_REJECTED", "CANCELED"],
  VALIDATING: ["PLAN_READY", "PLAN_REJECTED", "BUILD_FAILED", "CANCELED"],
  PLAN_READY: ["AWAITING_APPROVAL", "PLAN_REJECTED", "CANCELED"],
  AWAITING_APPROVAL: ["APPROVED", "APPROVAL_EXPIRED", "PLAN_REJECTED", "CANCELED"],
  APPROVED: [
    "UPLOADING_ASSETS",
    "APPROVAL_EXPIRED",
    "AUTH_REVOKED",
    "OWNERSHIP_CHANGED",
    "INSUFFICIENT_BALANCE",
    "FEE_OVER_BUDGET",
    "IMPLEMENTATION_CHANGED",
    "RPC_DISAGREEMENT",
    "UPLOAD_CONFLICT",
    "UPLOAD_INTERRUPTED",
    "CANCELED",
  ],
  UPLOADING_ASSETS: [
    "VERIFYING_ASSETS",
    "UPLOAD_CONFLICT",
    "UPLOAD_INTERRUPTED",
    "AUTH_REVOKED",
    "OWNERSHIP_CHANGED",
    "INSUFFICIENT_BALANCE",
    "FEE_OVER_BUDGET",
    "IMPLEMENTATION_CHANGED",
    "RPC_DISAGREEMENT",
    "CHAIN_REORG_PENDING",
  ],
  VERIFYING_ASSETS: [
    "SWITCHING_ENTRY",
    "VERIFY_FAILED",
    "RPC_DISAGREEMENT",
    "CHAIN_REORG_PENDING",
    "AUTH_REVOKED",
    "OWNERSHIP_CHANGED",
    "IMPLEMENTATION_CHANGED",
  ],
  SWITCHING_ENTRY: [
    "VERIFYING_RELEASE",
    "SWITCH_FAILED",
    "RPC_DISAGREEMENT",
    "CHAIN_REORG_PENDING",
    "AUTH_REVOKED",
    "OWNERSHIP_CHANGED",
    "IMPLEMENTATION_CHANGED",
  ],
  VERIFYING_RELEASE: [
    "LIVE",
    "VERIFY_FAILED",
    "RPC_DISAGREEMENT",
    "CHAIN_REORG_PENDING",
    "AUTH_REVOKED",
    "OWNERSHIP_CHANGED",
    "IMPLEMENTATION_CHANGED",
  ],
  LIVE: [],
  BUILD_FAILED: [],
  PLAN_REJECTED: [],
  // §12.2 reapproval starts a continuation attempt at AWAITING_APPROVAL (the same
  // pattern rollback uses) rather than leaving this worker-terminal state, so the
  // worker guard below stays absolute.
  APPROVAL_EXPIRED: [],
  AUTH_REVOKED: [],
  OWNERSHIP_CHANGED: [],
  INSUFFICIENT_BALANCE: [],
  FEE_OVER_BUDGET: [],
  RPC_DISAGREEMENT: [],
  CHAIN_REORG_PENDING: [],
  IMPLEMENTATION_CHANGED: [],
  UPLOAD_CONFLICT: [],
  UPLOAD_INTERRUPTED: ["UPLOADING_ASSETS", "CANCELED"],
  VERIFY_FAILED: [],
  SWITCH_FAILED: [],
  ROLLBACK_REQUIRED: [],
  CANCELED: [],
};

/** Transition edges leaving `from`, or an empty list for terminal states. */
export function allowedTransitions(from: DeploymentState): readonly DeploymentState[] {
  return ALLOWED_TRANSITIONS[from] ?? [];
}

export function canTransition(from: DeploymentState, to: DeploymentState): boolean {
  if (isTerminalState(from)) return false;
  return allowedTransitions(from).includes(to);
}

export interface TransitionDeploymentInput {
  readonly deploymentId: string;
  /** Optimistic-concurrency token: the `deployments.state_version` the caller observed. */
  readonly expectedVersion: number;
  readonly toState: DeploymentState;
  readonly eventType: string;
  readonly actorKind: ActorKind;
  readonly actorId?: string | null;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Stored in `deployments.error_code` for error endpoints; defaults to `toState`. */
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

function staleVersionError(
  deploymentId: string,
  expectedVersion: number,
  actualVersion: number,
  actualState: DeploymentState,
): TapeCiError {
  return new TapeCiError(
    "PLAN_STALE",
    `deployment ${deploymentId} state changed (expected version ${expectedVersion}, found ${actualVersion} in ${actualState})`,
    {
      retryable: true,
      details: { deploymentId, expectedVersion, actualVersion, actualState },
    },
  );
}

function invalidTransitionError(
  deploymentId: string,
  from: DeploymentState,
  to: DeploymentState,
  reason: "invalid_transition" | "terminal_state",
): TapeCiError {
  return new TapeCiError(
    "UPLOAD_CONFLICT",
    reason === "terminal_state"
      ? `deployment ${deploymentId} is in terminal state ${from}; no further transitions are allowed`
      : `deployment ${deploymentId} cannot transition from ${from} to ${to}`,
    {
      retryable: false,
      details: { deploymentId, from, to, reason, allowed: allowedTransitions(from) },
    },
  );
}

function notFoundError(deploymentId: string): TapeCiError {
  return new TapeCiError("PLAN_STALE", `deployment ${deploymentId} not found`, {
    retryable: false,
    details: { deploymentId, reason: "deployment_not_found" },
  });
}

const CHAIN_WRITER_CONSTRAINTS: ReadonlySet<string> = new Set([
  // migration 0001 uses the short index name; the Drizzle schema mirrors it with a prefix.
  "one_chain_writer_per_container",
  "deployments_one_chain_writer_per_container",
]);

function mapTransactionError(error: unknown, deploymentId: string): unknown {
  const pg = asPgError(error);
  if (pg?.code === "23505" && pg.constraint !== undefined && CHAIN_WRITER_CONSTRAINTS.has(pg.constraint)) {
    return new TapeCiError(
      "UPLOAD_CONFLICT",
      `another deployment already holds the chain-writer slot for this container (deployment ${deploymentId})`,
      {
        retryable: false,
        details: {
          deploymentId,
          reason: "container_chain_writer_conflict",
          constraint: pg.constraint,
        },
        cause: error,
      },
    );
  }
  return error;
}

/**
 * Apply one state transition as a single PostgreSQL transaction:
 *
 * 1. `SELECT ... FOR UPDATE` the deployment row (serialises concurrent CAS racers).
 * 2. Check the expected `state_version` (stale → `PLAN_STALE`, retryable).
 * 3. Check terminal-state and transition-map rules (`UPLOAD_CONFLICT`).
 * 4. `UPDATE ... SET state = to, state_version = state_version + 1 ... WHERE id AND version`.
 * 5. Append the matching `deployment_events` row.
 *
 * The partial unique index `one_chain_writer_per_container` is translated into a
 * typed `UPLOAD_CONFLICT` when two deployments race for the same container's
 * `APPROVED`/upload/switch states.
 *
 * The state machine never marks a deployment `LIVE` on its own: `LIVE` is only
 * reachable through the explicit `VERIFYING_RELEASE → LIVE` edge that the
 * verification worker takes after `verifyRelease(...).releaseMatch === true`.
 */
export async function transitionDeployment(
  db: Database,
  input: TransitionDeploymentInput,
): Promise<Deployment> {
  if (!isDeploymentState(input.toState)) {
    throw new TapeCiError("INVALID_CONFIG", `unknown deployment state ${String(input.toState)}`, {
      details: { toState: input.toState },
    });
  }
  if (!isActorKind(input.actorKind)) {
    throw new TapeCiError("INVALID_CONFIG", `unknown actor kind ${String(input.actorKind)}`, {
      details: { actorKind: input.actorKind },
    });
  }
  if (typeof input.eventType !== "string" || input.eventType.trim() === "") {
    throw new TapeCiError("INVALID_CONFIG", "transition eventType is required", {
      details: { deploymentId: input.deploymentId },
    });
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new TapeCiError("INVALID_CONFIG", "expectedVersion must be a non-negative integer", {
      details: { deploymentId: input.deploymentId, expectedVersion: input.expectedVersion },
    });
  }

  const { deploymentId, expectedVersion, toState } = input;

  try {
    return await withTransaction(db, async (client: DbClient) => {
      const currentResult = await client.query<Record<string, unknown>>(
        "SELECT * FROM deployments WHERE id = $1 FOR UPDATE",
        [deploymentId],
      );
      const currentRow = currentResult.rows[0];
      if (currentRow === undefined) throw notFoundError(deploymentId);

      const currentState = String(currentRow.state) as DeploymentState;
      const currentVersion = Number(currentRow.state_version);

      if (currentVersion !== expectedVersion) {
        throw staleVersionError(deploymentId, expectedVersion, currentVersion, currentState);
      }
      if (isTerminalState(currentState)) {
        throw invalidTransitionError(deploymentId, currentState, toState, "terminal_state");
      }
      if (!canTransition(currentState, toState)) {
        throw invalidTransitionError(deploymentId, currentState, toState, "invalid_transition");
      }

      const errorCode =
        input.errorCode ?? (isErrorTerminalState(toState) ? String(toState) : null);
      const errorMessage =
        input.errorMessage ?? (isErrorTerminalState(toState) ? `deployment ended in ${toState}` : null);

      const updateResult = await client.query<Record<string, unknown>>(
        `UPDATE deployments
            SET state = $3,
                state_version = state_version + 1,
                updated_at = now(),
                started_at = CASE
                  WHEN started_at IS NULL AND state = 'RECEIVED' THEN now()
                  ELSE started_at
                END,
                finished_at = CASE
                  WHEN $4 THEN now()
                  ELSE finished_at
                END,
                error_code = $5,
                error_message = $6
          WHERE id = $1 AND state_version = $2
          RETURNING *`,
        [
          deploymentId,
          expectedVersion,
          toState,
          // Terminal (including LIVE) or an error endpoint (a resumable
          // UPLOAD_INTERRUPTED is not terminal but still stopped).
          isTerminalState(toState) || isErrorTerminalState(toState),
          errorCode,
          errorMessage,
        ],
      );
      const updatedRow = updateResult.rows[0];
      if (updatedRow === undefined) {
        // The `FOR UPDATE` lock should make this unreachable, but keep the CAS explicit.
        throw staleVersionError(deploymentId, expectedVersion, currentVersion, currentState);
      }

      await client.query(
        `INSERT INTO deployment_events
           (deployment_id, old_state, new_state, event_type, actor_kind, actor_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          deploymentId,
          currentState,
          toState,
          input.eventType,
          input.actorKind,
          input.actorId ?? null,
          JSON.stringify(input.payload ?? {}),
        ],
      );

      return mapDeploymentRow(updatedRow);
    });
  } catch (error) {
    throw mapTransactionError(error, deploymentId);
  }
}

/** Read-only helper used by workers/tests when they only need `state`/`state_version`. */
export async function readDeploymentState(
  db: Database,
  deploymentId: string,
): Promise<{ readonly state: DeploymentState; readonly stateVersion: number } | null> {
  const deployment = await getDeployment(db, deploymentId);
  if (deployment === null) return null;
  return { state: deployment.state, stateVersion: deployment.stateVersion };
}
