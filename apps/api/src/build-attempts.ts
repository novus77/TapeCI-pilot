/**
 * Build attempts — SPEC §11.3, the write side.
 *
 * `routes/build-context.ts` *serves* an attempt and *closes* it from authenticated
 * run events. This module *creates* the row and reconciles an outcome the platform
 * could not observe. It is the only place that inserts into `build_attempts`, so the
 * numbering, the two SHA identities and the frozen configuration are decided once.
 *
 * ## Two identities, never one (AC-P4-14)
 * `commitSha` is the source revision that is built; `workflowCommitSha` is the
 * revision of the workflow that runs. They are separate required inputs and neither
 * is ever derived, defaulted or rewritten from the other: building a historical
 * commit with today's workflow is a legitimate case (§11.3), so a quiet fallback
 * would erase exactly the distinction the column pair exists to record. For the same
 * reason `retryBuildAttempt` takes `workflowCommitSha` from its caller — it is
 * re-resolved before every dispatch — while `commitSha` is the previous attempt's by
 * definition of "retry the same SHA".
 *
 * Both are normalised to lower case on the way in, because `routes/build-context.ts`
 * compares the OIDC token's `workflow_sha`/`sha` (lower-cased) and the body's
 * `targetSha` (lower-cased) with these columns byte for byte.
 *
 * ## The attempt number
 * `(deployment_id, attempt)` is unique and `attempt >= 1`. The number is `max + 1`
 * for that deployment, made race-safe in two layers:
 *
 * 1. the creating transaction takes `SELECT … FOR UPDATE` on the parent `deployments`
 *    row, so two dispatches for one deployment are serialised and the second reads a
 *    `max` that already includes the first;
 * 2. the insert is `ON CONFLICT (deployment_id, attempt) DO NOTHING` and recomputes
 *    the maximum on a miss, so a writer that bypasses the lock (another service, a
 *    future job) can cost a retry but can never corrupt the sequence or surface a
 *    unique violation to the caller.
 *
 * The read-then-write maximum is therefore never the guarantee; the unique index is.
 *
 * ## Idempotency without replaying a webhook
 * `dispatch_correlation_id` is unique and identifies exactly one dispatch. A repeat
 * of the same dispatch request returns the stored row; a repeat that disagrees about
 * the deployment, either SHA, the config version or the retried attempt is a 409
 * `IDEMPOTENCY_CONFLICT` rather than a silent second history. This is what lets a
 * caller answer a duplicate `Idempotency-Key` request without dispatching again
 * (AC-P4-18) and, crucially, without replaying the webhook: a same-SHA retry creates
 * a **new** row through `retryBuildAttempt` and never touches `webhook_deliveries`
 * or `deployments.source_event_key`, which would otherwise hand back the original
 * deployment (§11.3, AC-P4-12).
 *
 * ## Reconciliation, not optimistic failure
 * `reconcileDispatch` records what a verified GitHub run read actually said. A run
 * that was found moves the attempt along its own state machine; a run that was *not*
 * found leaves the attempt recoverable (`dispatch_unknown`) and is never recorded as
 * `failed` — "GitHub did not answer" is not "the build failed", and turning it into a
 * failure would invite the dispatch loop §11.3 forbids.
 *
 * ## Scope
 * No `@tapeci/github` import and no dispatch client: the run facts arrive as plain
 * values that the caller obtained from the authenticated run API. No DB, network or
 * clock of its own beyond the injected `db`/`now`, so the module is testable without
 * an environment or a running GitHub App. Admission (§11.2) is *not* re-decided here:
 * `build-admission.ts` answers that before a caller ever reaches this module, and
 * re-gating a dispatch that is already saved would strand it.
 */
import { eq, sql } from "drizzle-orm";
import {
  buildAttempts,
  deploymentEvents,
  deployments,
  type BuildAttempt,
  type Database,
} from "@tapeci/database";
import { ApiError } from "./errors.js";
import {
  BUILD_ATTEMPT_STATES,
  attemptStateForEvent,
  classifyAttemptTransition,
  isTerminalAttemptState,
  type BuildAttemptState,
} from "./routes/build-context.js";

/** Drizzle handle or an open transaction: every read here works in both. */
type Reader = Pick<Database, "select">;

/** An open Drizzle transaction, so a transition and its event commit together. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface BuildAttemptDeps {
  readonly db: Database;
  /** Injectable clock; `createdAt`/`finishedAt` are never implicit. Tests pin it. */
  readonly now?: () => Date;
}

/**
 * The frozen per-attempt configuration, and **exactly** the shape
 * `routes/build-context.ts` reads back (`configCommands`): three non-empty strings
 * under these three keys. The reader deliberately has no fallback to the project's
 * current values, so a snapshot missing one of them fails closed at context time —
 * which is why this module validates all three before the row is written. Extra
 * fields are not added here: the reader ignores them, and a field nobody reads is a
 * field that will drift out of date silently.
 */
export interface BuildConfigSnapshot {
  readonly installCommand: string;
  readonly buildCommand: string;
  readonly outputDirectory: string;
}

export interface CreateBuildAttemptInput {
  /** The deployment admission this attempt belongs to (§11.3 save-before-dispatch). */
  readonly deploymentId: string;
  /** Target source revision chosen by the user; never rewritten from a run claim. */
  readonly commitSha: string;
  /** Revision of the workflow that will actually run; a different identity. */
  readonly workflowCommitSha: string;
  /** Passed to the dispatched workflow; unique, so one dispatch has one attempt. */
  readonly dispatchCorrelationId: string;
  /** The project `config_version` this attempt was dispatched with; `>= 1`. */
  readonly configVersion: number;
  /** What `/v1/builds/context` must keep serving for this attempt (AC-P4-10). */
  readonly configSnapshot: BuildConfigSnapshot;
}

export interface RetryBuildAttemptInput {
  /** The attempt being retried; it must already be finished and is never mutated. */
  readonly previousAttemptId: string;
  /**
   * A **new** correlation id. Reusing the previous attempt's id would name one
   * dispatch twice and is refused; this is what makes a retry a new dispatch rather
   * than a second reading of the original one.
   */
  readonly dispatchCorrelationId: string;
  /** Re-resolved before dispatch; never inherited from the previous attempt. */
  readonly workflowCommitSha: string;
  /**
   * Where the new attempt lives. Omitted means the previous attempt's deployment,
   * which is the ordinary "same deployment and SHA, attempt 2" case. A caller whose
   * retry creates a fresh deployment admission (AC-P4-12: the retry's deployment id
   * differs from the original) passes the new id; it must already belong to the same
   * project and commit, which the insert proves under lock.
   */
  readonly deploymentId?: string;
  /**
   * An **assertion**, not an override: a retry is the same source revision by
   * definition, so a caller that names a different commit is refused rather than
   * silently rerouted. Omitted means "the previous attempt's `commitSha`".
   */
  readonly commitSha?: string;
  /**
   * An **assertion** too: the retry serves the previous attempt's frozen snapshot, so
   * naming a different `configVersion` would describe a configuration this row does
   * not contain (§11.3, AC-P4-10). Omitted means "the previous attempt's version".
   */
  readonly configVersion?: number;
}

/** A verified GitHub run read, in the platform's own vocabulary. */
export const RUN_OUTCOMES = ["queued", "started", "succeeded", "failed", "canceled"] as const;

export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export interface AttemptRunFacts {
  /** GitHub's numeric run id, kept as a string and never parsed into a float. */
  readonly runId: string;
  readonly runAttempt: number;
  readonly outcome: RunOutcome;
}

export interface ReconcileDispatchInput {
  readonly attemptId: string;
  /**
   * The run the authenticated run API returned, or `null` when no run exists for
   * this attempt's correlation id. `null` never produces `failed`.
   */
  readonly run: AttemptRunFacts | null;
}

export interface RecordAttemptStateInput {
  readonly attemptId: string;
  readonly state: BuildAttemptState;
  /** When the transition came from a verified run, record the identity with it. */
  readonly run?: AttemptRunFacts;
}

/** The column values one attempt insert needs, already validated. */
interface AttemptFacts {
  readonly deploymentId: string;
  readonly commitSha: string;
  readonly workflowCommitSha: string;
  readonly dispatchCorrelationId: string;
  readonly configVersion: number;
  readonly configSnapshot: BuildConfigSnapshot;
  readonly retryOf: string | null;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
/** `build_attempts_dispatch_correlation_check`: 1…255 characters. */
const MAX_CORRELATION_ID_LENGTH = 255;
/** `project_drafts_commands_check` uses the same bound for a command. */
const MAX_COMMAND_LENGTH = 1024;
/** How many `(deployment_id, attempt)` collisions a single insert may absorb. */
const MAX_ATTEMPT_COLLISIONS = 5;

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Save the attempt **before** GitHub is called (§11.3), so an accepted dispatch has
 * a row to be matched against and a failed one has a row to be closed.
 *
 * A repeat of the same `dispatchCorrelationId` returns the stored row untouched —
 * that is the idempotent path, not an error. A repeat that disagrees with what was
 * stored is a conflict, because one correlation id that names two dispatches would
 * mix two results into one history.
 */
export async function createBuildAttempt(
  deps: BuildAttemptDeps,
  input: CreateBuildAttemptInput,
): Promise<BuildAttempt> {
  return insertAttempt(deps, {
    deploymentId: requireUuid(input.deploymentId, "deploymentId"),
    commitSha: requireSha(input.commitSha, "commitSha"),
    workflowCommitSha: requireSha(input.workflowCommitSha, "workflowCommitSha"),
    dispatchCorrelationId: requireCorrelationId(input.dispatchCorrelationId),
    configVersion: requireConfigVersion(input.configVersion),
    configSnapshot: requireSnapshot(input.configSnapshot),
    retryOf: null,
  });
}

/**
 * A retry of one SHA: a **new** attempt that keeps the previous attempt's frozen
 * configuration and points at it through `retry_of` (§11.3, AC-P4-11).
 *
 * Three things this deliberately does not do:
 * - it never updates the previous row, so its state, outcome and `finishedAt` stay
 *   exactly as recorded;
 * - it never reuses the previous `dispatchCorrelationId`, so the retry cannot be
 *   mistaken for the original dispatch or adopt its run;
 * - it never reads or writes `webhook_deliveries` or `deployments.source_event_key`,
 *   so a retry is not a webhook replay. Replaying the delivery is what §11.3 rules
 *   out: `source_event_key` is unique, so a replayed webhook would hand back the
 *   *original* deployment and the retry would silently run under an identity that
 *   owns another attempt. A caller that needs a fresh admission passes a new
 *   `deploymentId` (AC-P4-12); the default reuses the previous attempt's deployment,
 *   which is the same-SHA "attempt 2" case and still creates a new attempt row.
 *
 * Only a finished attempt may be retried: retrying a live one would put two runs
 * behind one deployment, and retrying a `dispatch_unknown` one would duplicate a
 * dispatch that may already have been accepted. That state is resolved by
 * `reconcileDispatch` first — the recovery order §11.3 asks for.
 */
export async function retryBuildAttempt(
  deps: BuildAttemptDeps,
  input: RetryBuildAttemptInput,
): Promise<BuildAttempt> {
  const previousAttemptId = requireUuid(input.previousAttemptId, "previousAttemptId");
  const dispatchCorrelationId = requireCorrelationId(input.dispatchCorrelationId);
  const workflowCommitSha = requireSha(input.workflowCommitSha, "workflowCommitSha");

  const previous = await loadAttempt(deps.db, previousAttemptId);
  if (previous === null) {
    throw new ApiError(404, "ATTEMPT_NOT_FOUND", "the build attempt being retried does not exist", {
      attemptId: previousAttemptId,
    });
  }
  const previousState = storedState(previous);
  if (!isTerminalAttemptState(previousState)) {
    throw new ApiError(
      409,
      "ATTEMPT_STATE_CONFLICT",
      "only a finished build attempt can be retried; the previous attempt is still open",
      {
        attemptId: previous.id,
        state: previousState,
        remedy:
          previousState === "dispatch_unknown"
            ? "reconcile the dispatch outcome before retrying"
            : "wait for the attempt to finish",
      },
    );
  }
  if (dispatchCorrelationId === previous.dispatchCorrelationId) {
    throw new ApiError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "a retry must dispatch under a new correlation id; reusing the previous one would replay the original dispatch",
      { attemptId: previous.id, dispatchCorrelationId },
    );
  }
  // The retry keeps the previous attempt's snapshot, and re-reading it here proves
  // the retried attempt will be servable from `/v1/builds/context` rather than
  // failing at the workflow's first request (§11.3, AC-P4-10).
  const snapshot = readSnapshot(previous.configSnapshot);
  if (!snapshot.ok) {
    throw new ApiError(
      500,
      "INTERNAL",
      "the stored config snapshot cannot be served to a retried attempt",
      { attemptId: previous.id, field: snapshot.field, reason: snapshot.reason },
    );
  }
  // `commitSha` and `configVersion` may be named by the caller but only to agree: a
  // retry that changed either would not be a retry of this attempt.
  assertSameIdentity(
    "commitSha",
    // Only assert when the caller named it; absence is not a mismatch.
    input.commitSha === undefined ? previous.commitSha : requireSha(input.commitSha, "commitSha"),
    previous.commitSha,
    previous.id,
  );
  assertSameIdentity(
    "configVersion",
    input.configVersion === undefined
      ? previous.configVersion
      : requireConfigVersion(input.configVersion),
    previous.configVersion,
    previous.id,
  );

  return insertAttempt(deps, {
    deploymentId:
      input.deploymentId === undefined
        ? previous.deploymentId
        : requireUuid(input.deploymentId, "deploymentId"),
    // A retry is the same source revision by definition: `commitSha` is carried from
    // the attempt it supersedes, and never from `workflowCommitSha`.
    commitSha: previous.commitSha,
    workflowCommitSha,
    dispatchCorrelationId,
    configVersion: requireConfigVersion(previous.configVersion),
    configSnapshot: snapshot.snapshot,
    retryOf: previous.id,
  });
}

/**
 * A retry input that disagrees with the attempt it retries is a client error.
 * `undefined` means "not asserted", not "no value": a caller that omits the field
 * accepts the stored one instead of replacing it.
 */
function assertSameIdentity(
  field: string,
  asserted: string | number | undefined,
  stored: string | number,
  attemptId: string,
): void {
  if (asserted === undefined || asserted === stored) return;
  throw new ApiError(
    409,
    "ATTEMPT_STATE_CONFLICT",
    `a retry cannot change ${field}; it re-attempts the same source revision and configuration`,
    { attemptId, field, asserted, stored },
  );
}

// ---------------------------------------------------------------------------
// Reconciliation and transitions
// ---------------------------------------------------------------------------

/**
 * Record the outcome of a dispatch whose GitHub result was unknown (§11.3: "调用
 * GitHub 结果未知时先核对 run，不自动循环 dispatch").
 *
 * - a run was found → the attempt moves to the state that run proves (`queued` is
 *   `dispatched`, `started` is `running`, a conclusion is terminal);
 * - no run was found → the attempt stays recoverable. A `planned` attempt becomes
 *   `dispatch_unknown`, which is the state that says "re-read the run, do not
 *   dispatch again"; any other state is left exactly as it is.
 *
 * An illegal move is a 409, never a rewrite: reconciling a `succeeded` attempt with
 * a later `failed` observation must not turn a finished build into a failed one.
 */
export async function reconcileDispatch(
  deps: BuildAttemptDeps,
  input: ReconcileDispatchInput,
): Promise<BuildAttempt> {
  const attemptId = requireUuid(input.attemptId, "attemptId");
  const run = requireRunFacts(input.run);
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => {
    const locked = await lockAttempt(tx, attemptId);
    return applyTransition(tx, locked, reconciliationTarget(storedState(locked), run), run, now);
  });
}

/**
 * Apply one transition of the §11.3 attempt state machine.
 *
 * `classifyAttemptTransition` decides: `duplicate` writes nothing at all (no second
 * transition, no `finished_at`, no duplicate event), `illegal` is a 409 rather than
 * an overwrite, and only `apply` touches the row. Read-classify-apply happens under
 * one row lock, so two concurrent writers cannot both pass the check.
 */
export async function recordAttemptState(
  deps: BuildAttemptDeps,
  input: RecordAttemptStateInput,
): Promise<BuildAttempt> {
  const attemptId = requireUuid(input.attemptId, "attemptId");
  const target = inputState(input.state);
  const run = requireRunFacts(input.run ?? null);
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => {
    const locked = await lockAttempt(tx, attemptId);
    return applyTransition(tx, locked, target, run, now);
  });
}

/**
 * The state a reconciliation proves. `null` means "no run": only a `planned`
 * attempt learns that its dispatch result is unknown, and no input can make the
 * absence of a run terminal.
 */
function reconciliationTarget(
  current: BuildAttemptState,
  run: AttemptRunFacts | null,
): BuildAttemptState {
  if (run === null) return current === "planned" ? "dispatch_unknown" : current;
  return stateForRunOutcome(run.outcome);
}

/**
 * `queued` and `canceled` have no event status of their own, so they are named here;
 * the three shared statuses come from the same mapping the event endpoint uses, so
 * the two paths can never disagree about `started`/`succeeded`/`failed`.
 */
function stateForRunOutcome(outcome: RunOutcome): BuildAttemptState {
  if (outcome === "queued") return "dispatched";
  if (outcome === "canceled") return "canceled";
  const mapped = attemptStateForEvent("run", outcome);
  if (mapped === null) {
    throw new ApiError(500, "INTERNAL", `run outcome ${outcome} has no build attempt state`);
  }
  return mapped;
}

async function applyTransition(
  tx: Tx,
  locked: BuildAttempt,
  target: BuildAttemptState,
  run: AttemptRunFacts | null,
  now: Date,
): Promise<BuildAttempt> {
  const current = storedState(locked);
  const verdict = classifyAttemptTransition(current, target);
  // A repeated observation writes nothing: `finished_at` keeps the value the original
  // transition stored, and a late event cannot reopen or re-date a closed attempt.
  if (verdict === "duplicate") return locked;
  if (verdict === "illegal") {
    throw new ApiError(
      409,
      "ATTEMPT_STATE_CONFLICT",
      `build attempt is ${current} and cannot become ${target}`,
      {
        attemptId: locked.id,
        from: current,
        to: target,
        ...(run === null ? {} : { runId: run.runId, runAttempt: run.runAttempt }),
      },
    );
  }

  const [updated] = await tx
    .update(buildAttempts)
    .set({
      state: target,
      updatedAt: now,
      // Only a terminal transition writes `finished_at`; a live one never clears it,
      // which is exactly the pairing `build_attempts_terminal_check` requires.
      ...(isTerminalAttemptState(target) ? { finishedAt: now } : {}),
    })
    .where(eq(buildAttempts.id, locked.id))
    .returning();
  if (updated === undefined) {
    throw new ApiError(500, "INTERNAL", "could not store the build attempt transition", {
      attemptId: locked.id,
    });
  }

  // Same event shape `routes/build-context.ts` writes, so its run-identity check also
  // reads a reconciled run: after this, an event from a different run is refused.
  await tx.insert(deploymentEvents).values({
    deploymentId: locked.deploymentId,
    eventType: `build_attempt_${target}`,
    actorKind: "system",
    actorId: "build-attempts",
    payload: {
      attemptId: locked.id,
      from: current,
      to: target,
      correlationId: locked.dispatchCorrelationId,
      commitSha: locked.commitSha,
      workflowCommitSha: locked.workflowCommitSha,
      ...(run === null ? {} : { runId: run.runId, runAttempt: run.runAttempt }),
    },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// The insert itself: numbering, idempotency, and the unique-index backstop
// ---------------------------------------------------------------------------

async function insertAttempt(deps: BuildAttemptDeps, facts: AttemptFacts): Promise<BuildAttempt> {
  const now = deps.now?.() ?? new Date();
  const replay = await findByCorrelationId(deps.db, facts.dispatchCorrelationId);
  if (replay !== null) return assertSameDispatch(replay, facts);
  try {
    return await deps.db.transaction((tx) => insertAttemptInTransaction(tx, facts, now));
  } catch (error) {
    // A concurrent request may have committed this correlation id between the read
    // above and the insert. The unique index decides who wins; the loser returns the
    // winner's row, because the caller's request was already satisfied.
    if (!isUniqueViolation(error)) throw error;
    const winner = await findByCorrelationId(deps.db, facts.dispatchCorrelationId);
    if (winner === null) throw error;
    return assertSameDispatch(winner, facts);
  }
}

async function insertAttemptInTransaction(
  tx: Tx,
  facts: AttemptFacts,
  now: Date,
): Promise<BuildAttempt> {
  // Serialise numbering per deployment for the duration of the insert, and prove the
  // attempt and its deployment describe the same commit while both are held.
  const deployment = await lockDeployment(tx, facts.deploymentId);
  if (deployment.commitSha !== facts.commitSha) {
    throw new ApiError(
      409,
      "TARGET_SHA_MISMATCH",
      "this build attempt targets a different commit than the deployment it belongs to",
      {
        deploymentId: facts.deploymentId,
        deploymentCommitSha: deployment.commitSha,
        commitSha: facts.commitSha,
      },
    );
  }

  for (let collision = 0; collision < MAX_ATTEMPT_COLLISIONS; collision += 1) {
    const [inserted] = await tx
      .insert(buildAttempts)
      .values({
        deploymentId: facts.deploymentId,
        attempt: await nextAttemptNumber(tx, facts.deploymentId),
        retryOf: facts.retryOf,
        commitSha: facts.commitSha,
        workflowCommitSha: facts.workflowCommitSha,
        dispatchCorrelationId: facts.dispatchCorrelationId,
        configVersion: facts.configVersion,
        configSnapshot: facts.configSnapshot,
        // Save-before-dispatch: the row exists as `planned` before GitHub is called.
        state: "planned",
        createdAt: now,
        updatedAt: now,
      })
      // The backstop, not the numbering: a writer that did not take the deployment
      // lock above can only make this insert lose one round, never duplicate a number.
      .onConflictDoNothing({ target: [buildAttempts.deploymentId, buildAttempts.attempt] })
      .returning();
    if (inserted !== undefined) return inserted;
  }

  throw new ApiError(
    500,
    "INTERNAL",
    "could not reserve the next attempt number for this deployment",
    { deploymentId: facts.deploymentId, collisions: MAX_ATTEMPT_COLLISIONS },
    true,
  );
}

/** `max + 1`, with the deployment row already locked by the caller. */
async function nextAttemptNumber(tx: Tx, deploymentId: string): Promise<number> {
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${buildAttempts.attempt}) + 1, 1)` })
    .from(buildAttempts)
    .where(eq(buildAttempts.deploymentId, deploymentId));
  return row?.next ?? 1;
}

interface LockedDeployment {
  readonly commitSha: string;
}

async function lockDeployment(tx: Tx, deploymentId: string): Promise<LockedDeployment> {
  const [row] = await tx
    .select({ commitSha: deployments.commitSha })
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1)
    .for("update");
  if (row === undefined) {
    throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "no deployment exists for this build attempt", {
      deploymentId,
    });
  }
  return { commitSha: row.commitSha };
}

async function lockAttempt(tx: Tx, attemptId: string): Promise<BuildAttempt> {
  const [row] = await tx
    .select()
    .from(buildAttempts)
    .where(eq(buildAttempts.id, attemptId))
    .limit(1)
    .for("update");
  if (row === undefined) {
    throw new ApiError(404, "ATTEMPT_NOT_FOUND", "no build attempt exists with this id", {
      attemptId,
    });
  }
  return row;
}

async function loadAttempt(db: Reader, attemptId: string): Promise<BuildAttempt | null> {
  const [row] = await db
    .select()
    .from(buildAttempts)
    .where(eq(buildAttempts.id, attemptId))
    .limit(1);
  return row ?? null;
}

async function findByCorrelationId(
  db: Reader,
  dispatchCorrelationId: string,
): Promise<BuildAttempt | null> {
  const [row] = await db
    .select()
    .from(buildAttempts)
    .where(eq(buildAttempts.dispatchCorrelationId, dispatchCorrelationId))
    .limit(1);
  return row ?? null;
}

/**
 * A repeat of the same dispatch is the stored row. Anything that disagrees is a
 * different dispatch wearing the same correlation id, so it is refused instead of
 * being merged into — or replacing — the recorded one.
 */
function assertSameDispatch(existing: BuildAttempt, facts: AttemptFacts): BuildAttempt {
  const differences = [
    existing.deploymentId === facts.deploymentId ? null : "deploymentId",
    existing.commitSha === facts.commitSha ? null : "commitSha",
    existing.workflowCommitSha === facts.workflowCommitSha ? null : "workflowCommitSha",
    existing.configVersion === facts.configVersion ? null : "configVersion",
    existing.retryOf === facts.retryOf ? null : "retryOf",
  ].filter((field): field is string => field !== null);
  if (differences.length === 0) return existing;
  throw new ApiError(
    409,
    "IDEMPOTENCY_CONFLICT",
    "this dispatch correlation id already belongs to a different build attempt",
    {
      attemptId: existing.id,
      dispatchCorrelationId: facts.dispatchCorrelationId,
      differences,
    },
  );
}

// ---------------------------------------------------------------------------
// Admission of the values this module writes
// ---------------------------------------------------------------------------

function requireUuid(value: string, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    // Checked here, not left to PostgreSQL: a non-uuid would reach a `uuid` column
    // and surface as an internal error instead of a client mistake.
    throw new ApiError(400, "INVALID_BODY", `${field} must be a UUID`, { field });
  }
  return value;
}

/**
 * One SHA, on its own. There is deliberately no `?? otherSha`: an attempt whose two
 * identities were collapsed is exactly the record AC-P4-14 forbids, so a missing
 * value is an error rather than an opportunity to guess.
 */
function requireSha(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "INVALID_BODY", `${field} is required`, { field });
  }
  const normalised = value.trim().toLowerCase();
  if (!SHA_PATTERN.test(normalised)) {
    throw new ApiError(400, "INVALID_BODY", `${field} must be a 40-character commit sha`, {
      field,
    });
  }
  return normalised;
}

function requireCorrelationId(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "INVALID_BODY", "dispatchCorrelationId is required", {
      field: "dispatchCorrelationId",
    });
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_CORRELATION_ID_LENGTH) {
    throw new ApiError(
      400,
      "INVALID_BODY",
      `dispatchCorrelationId must be at most ${MAX_CORRELATION_ID_LENGTH} characters`,
      { field: "dispatchCorrelationId" },
    );
  }
  return trimmed;
}

function requireConfigVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_CONFIG", "configVersion must be a positive integer", {
      field: "configVersion",
      value,
    });
  }
  return value;
}

function requireSnapshot(value: unknown): BuildConfigSnapshot {
  const read = readSnapshot(value);
  if (!read.ok) {
    throw new ApiError(400, "INVALID_CONFIG", `the build config snapshot is invalid: ${read.field} ${read.reason}`, {
      field: read.field,
      reason: read.reason,
    });
  }
  return read.snapshot;
}

function requireRunFacts(run: AttemptRunFacts | null): AttemptRunFacts | null {
  if (run === null) return null;
  if (typeof run.runId !== "string" || !RUN_ID_PATTERN.test(run.runId)) {
    throw new ApiError(400, "INVALID_BODY", "run.runId must be GitHub's numeric run id as a string", {
      field: "run.runId",
    });
  }
  if (!Number.isSafeInteger(run.runAttempt) || run.runAttempt < 1) {
    throw new ApiError(400, "INVALID_BODY", "run.runAttempt must be a positive integer", {
      field: "run.runAttempt",
    });
  }
  if (!RUN_OUTCOMES.includes(run.outcome)) {
    throw new ApiError(400, "INVALID_BODY", `run.outcome must be one of ${RUN_OUTCOMES.join(", ")}`, {
      field: "run.outcome",
    });
  }
  return { runId: run.runId, runAttempt: run.runAttempt, outcome: run.outcome };
}

/** A target state a caller may ask for; anything else is a client mistake. */
function inputState(value: string): BuildAttemptState {
  const state = BUILD_ATTEMPT_STATES.find((candidate) => candidate === value);
  if (state === undefined) {
    throw new ApiError(400, "INVALID_BODY", `state must be one of ${BUILD_ATTEMPT_STATES.join(", ")}`, {
      field: "state",
      value,
    });
  }
  return state;
}

/**
 * The state a stored row carries. `build_attempts_state_check` constrains the column,
 * so an unknown value means the row was written around the schema: report it rather
 * than guessing a transition from it.
 */
function storedState(attempt: BuildAttempt): BuildAttemptState {
  const state = BUILD_ATTEMPT_STATES.find((candidate) => candidate === attempt.state);
  if (state === undefined) {
    throw new ApiError(500, "INTERNAL", `build attempt ${attempt.id} has an unknown state`, {
      attemptId: attempt.id,
      state: attempt.state,
    });
  }
  return state;
}

// ---------------------------------------------------------------------------
// The config snapshot — the exact shape `routes/build-context.ts` reads
// ---------------------------------------------------------------------------

type SnapshotRead =
  | { readonly ok: true; readonly snapshot: BuildConfigSnapshot }
  | { readonly ok: false; readonly field: string; readonly reason: string };

/**
 * Validate the snapshot on the way in and, for a retry, on the way back out of the
 * previous row. Every rule mirrors either `configCommands` in
 * `routes/build-context.ts` (three non-empty strings) or the column checks that will
 * be enforced on insert anyway (`jsonb_typeof = 'object'`, canonical output dir).
 */
function readSnapshot(value: unknown): SnapshotRead {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, field: "configSnapshot", reason: "must be a JSON object" };
  }
  const record = value as Record<string, unknown>;
  const installCommand = nonEmptyString(record["installCommand"], MAX_COMMAND_LENGTH);
  if (installCommand === null) {
    return {
      ok: false,
      field: "installCommand",
      reason: `must be a non-empty string of at most ${MAX_COMMAND_LENGTH} characters`,
    };
  }
  const buildCommand = nonEmptyString(record["buildCommand"], MAX_COMMAND_LENGTH);
  if (buildCommand === null) {
    return {
      ok: false,
      field: "buildCommand",
      reason: `must be a non-empty string of at most ${MAX_COMMAND_LENGTH} characters`,
    };
  }
  const outputDirectory = canonicalOutputDirectory(record["outputDirectory"]);
  if (outputDirectory === null) {
    return {
      ok: false,
      field: "outputDirectory",
      reason:
        "must be a relative canonical directory: no leading or trailing slash, no empty or `..` segment, and no backslash",
    };
  }
  return { ok: true, snapshot: { installCommand, buildCommand, outputDirectory } };
}

function nonEmptyString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * The same rule as `project_drafts_output_directory_check`: relative, no absolute
 * path, no `.` / `..` / empty segment, no trailing slash and no backslash. It is
 * validated, never rewritten — quietly changing the directory would alter what the
 * workflow builds behind the user's back.
 */
function canonicalOutputDirectory(value: unknown): string | null {
  const directory = nonEmptyString(value, MAX_COMMAND_LENGTH);
  if (directory === null) return null;
  if (directory.startsWith("/") || directory.endsWith("/")) return null;
  if (directory.includes("\\") || directory.includes("\0")) return null;
  const segments = directory.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return directory;
}

// ---------------------------------------------------------------------------
// Driver error classification
// ---------------------------------------------------------------------------

/** PostgreSQL unique violation (23505) anywhere on the driver error's cause chain. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === "23505") return true;
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}
