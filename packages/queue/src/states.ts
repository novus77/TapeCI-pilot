/**
 * Deployment state vocabulary (PRD §6.2 / `schema.sql` `deployment_state`).
 *
 * The Postgres enum is the source of truth at rest; this module mirrors it so the
 * queue package can be typechecked without a live database and so worker code can
 * reason about terminal states.
 */

export const DEPLOYMENT_STATES = [
  "RECEIVED",
  "BUILDING",
  "BUILT",
  "VALIDATING",
  "PLAN_READY",
  "AWAITING_APPROVAL",
  "APPROVED",
  "UPLOADING_ASSETS",
  "VERIFYING_ASSETS",
  "SWITCHING_ENTRY",
  "VERIFYING_RELEASE",
  "LIVE",
  "BUILD_FAILED",
  "PLAN_REJECTED",
  "APPROVAL_EXPIRED",
  "AUTH_REVOKED",
  "OWNERSHIP_CHANGED",
  "INSUFFICIENT_BALANCE",
  "FEE_OVER_BUDGET",
  "RPC_DISAGREEMENT",
  "CHAIN_REORG_PENDING",
  "IMPLEMENTATION_CHANGED",
  "UPLOAD_CONFLICT",
  "UPLOAD_INTERRUPTED",
  "VERIFY_FAILED",
  "SWITCH_FAILED",
  "ROLLBACK_REQUIRED",
  "CANCELED",
] as const;

export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

/**
 * Terminal / paused states from PRD §6.2. `LIVE` is the only success terminal state;
 * everything else is a fail-closed or cancelled endpoint. A *worker* must never leave
 * these states: a new deployment (or an explicit rollback deployment) is required.
 *
 * `APPROVAL_EXPIRED` stays here on purpose, and the distinction matters: the worker
 * guard is "no automatic progress", while §12.2's reapproval is a *user-initiated*
 * transition back to `AWAITING_APPROVAL` on the same deployment. `ALLOWED_TRANSITIONS`
 * carries that edge; only the reapproval entry point may use it. Removing the state
 * from this list would tell every worker that it may resume an expired approval, which
 * is the opposite of the signature gate.
 */
export const TERMINAL_STATES = [
  "LIVE",
  "BUILD_FAILED",
  "PLAN_REJECTED",
  "APPROVAL_EXPIRED",
  "AUTH_REVOKED",
  "OWNERSHIP_CHANGED",
  "INSUFFICIENT_BALANCE",
  "FEE_OVER_BUDGET",
  "RPC_DISAGREEMENT",
  "CHAIN_REORG_PENDING",
  "IMPLEMENTATION_CHANGED",
  "UPLOAD_CONFLICT",
  "VERIFY_FAILED",
  "SWITCH_FAILED",
  "ROLLBACK_REQUIRED",
  "CANCELED",
] as const satisfies readonly DeploymentState[];

export type TerminalState = (typeof TERMINAL_STATES)[number];

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_STATES);

export function isDeploymentState(value: unknown): value is DeploymentState {
  return typeof value === "string" && (DEPLOYMENT_STATES as readonly string[]).includes(value);
}

export function isTerminalState(state: DeploymentState): boolean {
  return TERMINAL_SET.has(state);
}

/**
 * Terminal states that carry an operational error, excluding `LIVE` and `CANCELED`.
 * `UPLOAD_INTERRUPTED` is resumable (not terminal) but still an error endpoint for
 * reporting: it must keep `error_code`/`finished_at` so operators can see it.
 */
export const ERROR_TERMINAL_STATES = [
  ...TERMINAL_STATES.filter((state) => state !== "LIVE" && state !== "CANCELED"),
  "UPLOAD_INTERRUPTED",
] as readonly DeploymentState[];

const ERROR_TERMINAL_SET: ReadonlySet<string> = new Set(ERROR_TERMINAL_STATES);

export function isErrorTerminalState(state: DeploymentState): boolean {
  return ERROR_TERMINAL_SET.has(state);
}

export const ACTOR_KINDS = ["user", "worker", "webhook", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export function isActorKind(value: unknown): value is ActorKind {
  return typeof value === "string" && (ACTOR_KINDS as readonly string[]).includes(value);
}
