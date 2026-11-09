/**
 * Preparation task lifecycle — SPEC §7.3, §9.1, §9.3, §6.
 *
 * A task is the durable record of one accepted quote: ordered steps, a CAS
 * `version` on both the task and each step, and an append-only acceptance log.
 * This module owns:
 *
 * - `createPreparationTask` — idempotent creation from a quote (`Idempotency-Key`
 *   + `request_digest`, §7.3/§6): a replay of the same request returns the same
 *   task, a different request under the same key is 409 `IDEMPOTENCY_CONFLICT`.
 * - `loadPreparationTask` — the `PreparationTask` DTO (§5) for its creator only.
 * - `acceptQuote` — a re-quote revision with CAS; confirmed/skipped steps keep
 *   their original quote (§9.3).
 * - `transitionStep` — the §9.1 transition table as code, with the guards that
 *   make a second paid attempt impossible while one intent is unresolved.
 * - `cancelPreparationTask` — only steps that never started are canceled (§7.3).
 *
 * Every mutation is `UPDATE … WHERE id = $1 AND version = $expected` inside one
 * transaction that first takes `FOR UPDATE` on the task and the step, so two
 * concurrent confirmations cannot both create a paid intent (§6).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@tapeci/database";
import {
  provisioningQuoteAcceptances,
  provisioningSteps,
  provisioningTasks,
  provisioningTransactions,
} from "@tapeci/database";
import {
  canonicalJsonSha256Hex,
  type Hex,
  type PreparationStepKind,
  type PreparationStepState,
  type PreparationTask,
  type ResourceRef,
} from "@tapeci/shared";
import { ApiError } from "../errors.js";
import {
  assertQuoteNotExpired,
  assertQuoteOwner,
  assertQuoteRecipient,
  loadQuote,
  type StoredQuote,
} from "./quotes.js";

/** v1 is single-network (§1). */
const CHAIN_ID = 196;

/** §9.1: attempt statuses that mean "this step's send is not resolved yet". */
export const LIVE_INTENT_STATUSES = ["prepared", "submitted", "unresolved"] as const;

type TaskRow = typeof provisioningTasks.$inferSelect;
type StepRow = typeof provisioningSteps.$inferSelect;
type TransactionRow = typeof provisioningTransactions.$inferSelect;

/** Drizzle handle or an open transaction: every read here works in both. */
type Reader = Pick<Database, "select">;

/** An open Drizzle transaction; `transactions.ts` shares it so intent + step move together. */
export type TaskTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type Tx = TaskTransaction;

export interface TaskDeps {
  readonly db: Database;
  /** Injectable clock; expiry and `updatedAt` are never implicit. */
  readonly now?: () => Date;
}

export interface CreateTaskInput {
  readonly userId: string;
  readonly quoteId: string;
  /** Client-supplied `Idempotency-Key`; scoped per user (§7.3). */
  readonly idempotencyKey: string;
}

export interface CreatedTask {
  readonly task: PreparationTask;
  /** `false` on a replay of the same request, so the route can answer 200 vs 201. */
  readonly created: boolean;
}

/**
 * Create (or replay) a task from a quote the user accepted (§7.3).
 *
 * The digest covers `quoteId`, recipient, chain and options — never the raw
 * header — so a retry with a different quote under the same key is a conflict
 * rather than a silently different purchase (§6).
 */
export async function createPreparationTask(
  deps: TaskDeps,
  input: CreateTaskInput,
): Promise<CreatedTask> {
  const now = deps.now?.() ?? new Date();
  const quote = await loadQuote(deps.db, input.quoteId);
  assertQuoteOwner(quote, input.userId);
  assertQuoteNotExpired(quote, now);
  const idempotencyKey = readIdempotencyKey(input.idempotencyKey);
  const digest = requestDigest(quote);

  return deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(provisioningTasks)
      .values({
        userId: input.userId,
        recipientAddress: quote.recipient,
        chainId: CHAIN_ID,
        initialQuoteId: quote.id,
        currentQuoteId: quote.id,
        idempotencyKey,
        requestDigest: digest,
        state: "waiting_user",
      })
      // A concurrent first request wins; the loser reads the winner's row below.
      .onConflictDoNothing({
        target: [provisioningTasks.userId, provisioningTasks.idempotencyKey],
      })
      .returning();

    const row = inserted[0];
    if (row === undefined) {
      const [existing] = await tx
        .select()
        .from(provisioningTasks)
        .where(
          and(
            eq(provisioningTasks.userId, input.userId),
            eq(provisioningTasks.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing === undefined) {
        throw new ApiError(500, "INTERNAL", "the preparation task could not be created");
      }
      if (existing.requestDigest !== digest) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "this Idempotency-Key was already used for a different request",
          { taskId: existing.id },
        );
      }
      return { task: await readTaskDto(tx, existing), created: false };
    }

    // First acceptance of the quote is part of creating the task (§7.3).
    await tx.insert(provisioningQuoteAcceptances).values({
      taskId: row.id,
      quoteId: quote.id,
      acceptedBy: input.userId,
    });

    // Steps are materialized from the quote's own step ids, so the id a client
    // sees in the quote is the id it prepares. Only the first step can be signed
    // immediately: every later step waits for its predecessor (§9.1).
    await tx.insert(provisioningSteps).values(
      quote.steps.map((step, index) => ({
        id: step.id,
        taskId: row.id,
        ordinal: step.ordinal,
        kind: step.kind,
        state: index === 0 ? ("awaiting_signature" as const) : ("waiting" as const),
        quoteId: quote.id,
        expectedResource: step.resource,
      })),
    );

    return { task: await readTaskDto(tx, row), created: true };
  });
}

/** The DTO for an already-loaded task row, inside a caller's transaction. */
export async function loadTaskInTransaction(
  tx: TaskTransaction,
  taskId: string,
): Promise<PreparationTask> {
  const [row] = await tx
    .select()
    .from(provisioningTasks)
    .where(and(eq(provisioningTasks.id, taskId), eq(provisioningTasks.chainId, CHAIN_ID)))
    .limit(1);
  if (row === undefined) {
    throw new ApiError(404, "TASK_NOT_FOUND", "preparation task not found");
  }
  return readTaskDto(tx, row);
}

/** One task with every step and attempt, for its creator only (§7.3, §10). */
export async function loadPreparationTask(
  deps: Pick<TaskDeps, "db">,
  input: { readonly taskId: string; readonly userId: string },
): Promise<PreparationTask> {
  const [row] = await deps.db
    .select()
    .from(provisioningTasks)
    .where(and(eq(provisioningTasks.id, input.taskId), eq(provisioningTasks.chainId, CHAIN_ID)))
    .limit(1);
  // A task that belongs to somebody else is 404, not 403: the id itself is private (§7.1).
  if (row === undefined || row.userId !== input.userId) {
    throw new ApiError(404, "TASK_NOT_FOUND", "preparation task not found");
  }
  return readTaskDto(deps.db, row);
}

/**
 * Accept a new quote revision (§7.3 `accept-quote`, §9.3).
 *
 * CAS on the task version. The recipient is immutable, the quote must belong to
 * the same user, and only steps that are still unfinished move to the new quote;
 * confirmed/skipped steps keep the quote they were paid under.
 */
export async function acceptQuote(
  deps: TaskDeps,
  input: {
    readonly taskId: string;
    readonly userId: string;
    readonly quoteId: string;
    readonly expectedVersion: number;
  },
): Promise<PreparationTask> {
  const now = deps.now?.() ?? new Date();
  const quote = await loadQuote(deps.db, input.quoteId);
  assertQuoteOwner(quote, input.userId);

  return deps.db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId, input.userId);
    assertTaskVersion(task, input.expectedVersion);
    assertTaskNotCanceled(task);
    assertQuoteRecipient(quote, task.recipientAddress as Hex);
    assertQuoteNotExpired(quote, now);

    const steps = await lockSteps(tx, task.id);
    const unfinished = steps.filter((step) => !isTerminalStepState(step.state));
    if (unfinished.length === 0) {
      throw new ApiError(
        409,
        "QUOTE_NOT_APPLICABLE",
        "every step of this task is already resolved; there is nothing to re-quote",
        { taskId: task.id },
      );
    }
    // Each unfinished step must have a counterpart of the same kind and ordinal in
    // the new quote; a revision may not drop or reshape a step the user already saw.
    for (const step of unfinished) {
      const replacement = quote.steps.find((candidate) => candidate.ordinal === step.ordinal);
      if (replacement === undefined || replacement.kind !== step.kind) {
        throw new ApiError(
          409,
          "QUOTE_NOT_APPLICABLE",
          "the new quote does not price every unfinished step of this task",
          { taskId: task.id, ordinal: step.ordinal, kind: step.kind },
        );
      }
    }

    await tx
      .insert(provisioningQuoteAcceptances)
      .values({ taskId: task.id, quoteId: quote.id, acceptedBy: input.userId })
      .onConflictDoNothing({
        target: [provisioningQuoteAcceptances.taskId, provisioningQuoteAcceptances.quoteId],
      });

    for (const step of unfinished) {
      const replacement = quote.steps.find((candidate) => candidate.ordinal === step.ordinal);
      if (replacement === undefined) continue;
      await tx
        .update(provisioningSteps)
        .set({
          quoteId: quote.id,
          expectedResource: replacement.resource,
          version: step.version + 1,
          updatedAt: now,
        })
        .where(and(eq(provisioningSteps.id, step.id), eq(provisioningSteps.version, step.version)));
    }

    await tx
      .update(provisioningTasks)
      .set({ currentQuoteId: quote.id, version: task.version + 1, updatedAt: now })
      .where(and(eq(provisioningTasks.id, task.id), eq(provisioningTasks.version, task.version)));

    return readTaskDto(tx, { ...task, currentQuoteId: quote.id, version: task.version + 1 });
  });
}

export interface StepTransitionInput {
  readonly taskId: string;
  readonly stepId: string;
  /**
   * The task's `version` as the client last read it (§5: `PreparationTask.version`
   * is "sent back as `expectedVersion`"). The step's own `version` is a per-row CAS
   * token read under lock, never a client-supplied value: `PreparationStep` has no
   * version field in the frozen DTO.
   */
  readonly expectedVersion: number;
  readonly to: PreparationStepState;
  /** Machine code (§5/§13); required when the step ends up needing a human. */
  readonly errorCode?: string | null;
  /** Evidence payload for the step; never provider prose shown as instruction. */
  readonly result?: Record<string, unknown> | null;
  /** Verified outcome of the step (the resource actually delivered/found). */
  readonly resolvedResource?: ResourceRef | null;
  /** External purchase reference; both halves are required together (§6). */
  readonly external?: { readonly sourceId: string; readonly reference: string } | null;
  /** The attempt this transition is about; required for `submitted`/`confirmed`. */
  readonly intentId?: string | null;
}

/**
 * Apply one §9.1 transition, or refuse it.
 *
 * The transition table is the whitelist below; every arrow out of it is
 * `INVALID_STEP_TRANSITION` (409). Three guards carry the payment-safety rules:
 *
 * 1. **No second paid attempt.** A step may only reach `awaiting_signature` when
 *    it has no live intent (`prepared`/`submitted`/`unresolved`) and every
 *    earlier step is `confirmed`/`skipped`. `submitted` has no arrow back to
 *    `awaiting_signature` at all, so a pending hash can never be re-signed.
 * 2. **`submitted` needs the intent.** The move to `submitted` requires the
 *    intent id that was just stored with its hash, so a step cannot be marked
 *    submitted without an attempt behind it.
 * 3. **`confirmed` needs a confirmed attempt.** The only way in is an attempt of
 *    this step whose own verification reached `confirmed`; a receipt alone is
 *    never enough (§9.2).
 */
export async function transitionStep(
  deps: TaskDeps,
  input: StepTransitionInput,
): Promise<PreparationTask> {
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => transitionStepInTransaction(tx, input, now));
}

/**
 * The same transition inside a caller's transaction, so `transactions.ts` can
 * write an attempt and move its step atomically. The step row is locked
 * `FOR UPDATE` first, which is what serializes two concurrent hash registrations.
 */
export async function transitionStepInTransaction(
  tx: TaskTransaction,
  input: StepTransitionInput,
  now: Date,
): Promise<PreparationTask> {
  const task = await lockTask(tx, input.taskId, null);
  assertTaskNotCanceled(task);
  assertTaskVersion(task, input.expectedVersion);
  const step = await lockStep(tx, task.id, input.stepId);

  const from = step.state as PreparationStepState;
  assertTransitionAllowed(from, input.to);
  await assertTransitionGuards(tx, { task, step, from, input });

  const [updated] = await tx
    .update(provisioningSteps)
    .set({
      state: input.to,
      errorCode: input.errorCode === undefined ? step.errorCode : input.errorCode,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.resolvedResource === undefined
        ? {}
        : { resolvedResource: input.resolvedResource }),
      ...(input.external === undefined || input.external === null
        ? {}
        : {
            externalSourceId: input.external.sourceId,
            externalReference: input.external.reference,
          }),
      version: step.version + 1,
      updatedAt: now,
    })
    .where(and(eq(provisioningSteps.id, step.id), eq(provisioningSteps.version, step.version)))
    .returning();
  if (updated === undefined) {
    // The row is locked, so this is unreachable; keep the CAS explicit anyway.
    throw new ApiError(409, "STEP_VERSION_CONFLICT", "the step changed since this request read it", {
      taskId: task.id,
      stepId: step.id,
    });
  }

  const next = await recomputeTaskState(tx, task, now);
  return readTaskDto(tx, next);
}

/**
 * §7.3 `cancel`: only steps that never started are canceled. A step with a live
 * intent (`submitted`/`external_pending`, or an attempt whose outcome is unknown)
 * blocks the cancel with 409 so the user cannot abandon a possible payment.
 */
export async function cancelPreparationTask(
  deps: TaskDeps,
  input: { readonly taskId: string; readonly userId: string; readonly expectedVersion: number },
): Promise<PreparationTask> {
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId, input.userId);
    assertTaskVersion(task, input.expectedVersion);
    if (task.state === "canceled") return readTaskDto(tx, task);
    if (task.state === "completed") {
      throw new ApiError(409, "TASK_COMPLETED", "a completed task cannot be canceled", {
        taskId: task.id,
      });
    }

    const steps = await lockSteps(tx, task.id);
    const blocking = steps.filter(
      (step) => step.state === "submitted" || step.state === "external_pending",
    );
    if (blocking.length > 0) {
      throw new ApiError(
        409,
        "TASK_UNRESOLVED",
        "a step is still submitted or awaiting external delivery; resolve it before canceling",
        { taskId: task.id, stepIds: blocking.map((step) => step.id) },
      );
    }
    const live = await readLiveIntents(tx, task.id);
    if (live.length > 0) {
      throw new ApiError(
        409,
        "TASK_UNRESOLVED",
        "an attempt of this task has an unknown outcome; verify it before canceling",
        { taskId: task.id, stepIds: live.map((intent) => intent.stepId) },
      );
    }

    for (const step of steps) {
      if (step.state !== "waiting" && step.state !== "awaiting_signature") continue;
      await tx
        .update(provisioningSteps)
        .set({ state: "skipped", errorCode: "TASK_CANCELED", version: step.version + 1, updatedAt: now })
        .where(and(eq(provisioningSteps.id, step.id), eq(provisioningSteps.version, step.version)));
    }

    const [updated] = await tx
      .update(provisioningTasks)
      .set({ state: "canceled", version: task.version + 1, updatedAt: now })
      .where(and(eq(provisioningTasks.id, task.id), eq(provisioningTasks.version, task.version)))
      .returning();
    if (updated === undefined) {
      throw new ApiError(409, "STEP_VERSION_CONFLICT", "the task changed since this request read it", {
        taskId: task.id,
      });
    }
    return readTaskDto(tx, updated);
  });
}

/**
 * Refuse when this step already has an attempt whose outcome is unknown (§3.3,
 * §9.1). `transactions.ts` calls it before storing a new intent, and
 * `transitionStep` calls it before any arrow into `awaiting_signature`.
 */
export async function assertNoLiveIntent(
  reader: Pick<Database, "select">,
  stepId: string,
  exceptIntentId: string | null = null,
): Promise<void> {
  const rows = await reader
    .select({
      id: provisioningTransactions.id,
      status: provisioningTransactions.status,
      intentId: provisioningTransactions.intentId,
    })
    .from(provisioningTransactions)
    .where(
      and(
        eq(provisioningTransactions.stepId, stepId),
        inArray(provisioningTransactions.status, [...LIVE_INTENT_STATUSES]),
      ),
    );
  const live = rows.find((row) => row.intentId !== exceptIntentId);
  if (live !== undefined) {
    throw new ApiError(
      409,
      "TRANSACTION_UNRESOLVED",
      "this step already has an attempt whose outcome is not resolved; verify it before sending again",
      { stepId, attemptId: live.id, status: live.status },
    );
  }
}

/** The step's live attempt, or `null`. */
export async function readLiveIntent(
  reader: Pick<Database, "select">,
  stepId: string,
): Promise<TransactionRow | null> {
  const [live] = await reader
    .select()
    .from(provisioningTransactions)
    .where(
      and(
        eq(provisioningTransactions.stepId, stepId),
        inArray(provisioningTransactions.status, [...LIVE_INTENT_STATUSES]),
      ),
    )
    .limit(1);
  return live ?? null;
}

/** §9.1: the only arrows that exist. Anything else is a programming error surfaced as 409. */
const ALLOWED_TRANSITIONS: Readonly<Record<PreparationStepState, readonly PreparationStepState[]>> = {
  // A waiting step is promoted once the quote is accepted and the identity/resource checks pass.
  waiting: ["awaiting_signature", "skipped", "external_pending"],
  awaiting_signature: ["submitted", "skipped", "external_pending", "awaiting_signature"],
  submitted: ["confirmed", "failed", "submitted"],
  external_pending: ["confirmed", "failed", "external_pending"],
  // A resolved attempt may be retried only through a new quote + explicit retry (§9.1).
  failed: ["awaiting_signature"],
  // Later verification can invalidate a confirmation; it goes back to re-checking (§9.1).
  confirmed: ["submitted", "external_pending"],
  skipped: [],
};

function assertTransitionAllowed(from: PreparationStepState, to: PreparationStepState): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new ApiError(
      409,
      "INVALID_STEP_TRANSITION",
      `a step in ${from} cannot move to ${to}`,
      { from, to, allowed },
    );
  }
}

async function assertTransitionGuards(
  tx: Tx,
  input: {
    readonly task: TaskRow;
    readonly step: StepRow;
    readonly from: PreparationStepState;
    readonly input: StepTransitionInput;
  },
): Promise<void> {
  const { task, step, from } = input;
  const to = input.input.to;

  if (to === "awaiting_signature") {
    // §9.1 row 1: every earlier step must already be resolved.
    const earlier = await tx
      .select({ id: provisioningSteps.id, ordinal: provisioningSteps.ordinal, state: provisioningSteps.state })
      .from(provisioningSteps)
      .where(
        and(
          eq(provisioningSteps.taskId, task.id),
          sql`${provisioningSteps.ordinal} < ${step.ordinal}`,
        ),
      );
    const blocked = earlier.filter(
      (candidate) => candidate.state !== "confirmed" && candidate.state !== "skipped",
    );
    if (blocked.length > 0) {
      throw new ApiError(
        409,
        "STEP_ORDER_VIOLATION",
        "an earlier step of this task is not confirmed yet",
        { taskId: task.id, stepId: step.id, blocking: blocked.map((candidate) => candidate.id) },
      );
    }
    // §9.1 row 1 + §3.3: no unresolved send may be re-signed, ever. The one
    // exception is the `prepared` attempt created by this very transaction: it
    // *is* the intent that makes this step signable, and any earlier `prepared`
    // attempt would have been replayed instead of reaching here.
    await assertNoLiveIntent(tx, step.id, input.input.intentId ?? null);
  }

  if (to === "submitted") {
    const intentId = input.input.intentId ?? null;
    if (intentId === null) {
      throw new ApiError(
        409,
        "INTENT_REQUIRED",
        "a step becomes submitted only by registering a hash for a stored intent",
        { taskId: task.id, stepId: step.id },
      );
    }
    const [attempt] = await tx
      .select({ id: provisioningTransactions.id, status: provisioningTransactions.status })
      .from(provisioningTransactions)
      .where(
        and(
          eq(provisioningTransactions.stepId, step.id),
          eq(provisioningTransactions.intentId, intentId),
        ),
      )
      .limit(1);
    if (attempt === undefined || attempt.status !== "submitted") {
      throw new ApiError(
        409,
        "TRANSACTION_MISMATCH",
        "the intent named for this step has no registered hash",
        { taskId: task.id, stepId: step.id, intentId },
      );
    }
  }

  if (to === "confirmed") {
    // §9.2: only a fully verified attempt of THIS step can confirm it.
    const [verified] = await tx
      .select({ id: provisioningTransactions.id })
      .from(provisioningTransactions)
      .where(
        and(
          eq(provisioningTransactions.stepId, step.id),
          eq(provisioningTransactions.status, "confirmed"),
        ),
      )
      .limit(1);
    if (verified === undefined) {
      throw new ApiError(
        409,
        "DELIVERY_UNVERIFIED",
        "no verified attempt of this step exists, so it cannot be confirmed",
        { taskId: task.id, stepId: step.id },
      );
    }
  }

  if (to === "failed") {
    if (input.input.errorCode === undefined || input.input.errorCode === null) {
      throw new ApiError(409, "ERROR_CODE_REQUIRED", "a failed step needs a machine error code", {
        taskId: task.id,
        stepId: step.id,
      });
    }
    // Leaving `submitted` is only truthful when the attempt itself is resolved.
    if (from === "submitted") {
      const [resolved] = await tx
        .select({ id: provisioningTransactions.id })
        .from(provisioningTransactions)
        .where(
          and(
            eq(provisioningTransactions.stepId, step.id),
            eq(provisioningTransactions.status, "failed"),
          ),
        )
        .limit(1);
      if (resolved === undefined) {
        throw new ApiError(
          409,
          "TRANSACTION_UNRESOLVED",
          "a submitted step fails only when its own attempt is proven failed",
          { taskId: task.id, stepId: step.id },
        );
      }
    }
  }

  if (to === "skipped") {
    // §9.1: skipping is a verified fact, and never while a send is in flight.
    await assertNoLiveIntent(tx, step.id);
    if (input.input.resolvedResource === undefined || input.input.resolvedResource === null) {
      throw new ApiError(
        409,
        "DELIVERY_UNVERIFIED",
        "a skipped step must name the verified resource that already satisfies it",
        { taskId: task.id, stepId: step.id },
      );
    }
  }

  if (to === "external_pending") {
    if (input.input.external === undefined || input.input.external === null) {
      throw new ApiError(
        409,
        "SOURCE_UNAVAILABLE",
        "an external step needs a verified source id and reference",
        { taskId: task.id, stepId: step.id },
      );
    }
  }
}

/**
 * Task state from its steps (§9.1 summary).
 *
 * Priority is deliberate: an unresolved send (`running`) and a step that needs a
 * human (`needs_action`) both outrank `waiting_user`, so a task with an unknown
 * transaction can never be rendered as "ready to pay again".
 */
function deriveTaskState(input: {
  readonly steps: readonly StepRow[];
  readonly unresolvedAttempt: boolean;
}): PreparationTask["state"] {
  const states = input.steps.map((step) => step.state as PreparationStepState);
  if (states.some((state) => state === "submitted" || state === "external_pending")) return "running";
  // A recorded reason on an `awaiting_signature` step is not a blocker: §9.1 keeps
  // the step signable after a wallet rejection. Only a resolved-failed step or an
  // unresolved send needs a human.
  const needsAction =
    input.unresolvedAttempt || input.steps.some((step) => step.state === "failed");
  if (needsAction) return "needs_action";
  if (states.length === 0) return "waiting_user";
  if (states.every((state) => state === "confirmed" || state === "skipped")) return "completed";
  return "waiting_user";
}

/** Recompute the summary from the current step rows, inside a caller's transaction. */
export async function recomputeTaskStateInTransaction(
  tx: TaskTransaction,
  taskId: string,
  now: Date,
): Promise<PreparationTask> {
  const [task] = await tx
    .select()
    .from(provisioningTasks)
    .where(and(eq(provisioningTasks.id, taskId), eq(provisioningTasks.chainId, CHAIN_ID)))
    .for("update");
  if (task === undefined) {
    throw new ApiError(404, "TASK_NOT_FOUND", "preparation task not found");
  }
  return readTaskDto(tx, await recomputeTaskState(tx, task, now));
}

async function recomputeTaskState(tx: Tx, task: TaskRow, now: Date): Promise<TaskRow> {
  const steps = await tx
    .select()
    .from(provisioningSteps)
    .where(eq(provisioningSteps.taskId, task.id))
    .orderBy(provisioningSteps.ordinal);
  const live = await readLiveIntents(tx, task.id);
  // A broadcast whose hash never came back is the "unknown send result" of §9.1.
  const unresolvedAttempt = live.some((intent) => intent.status === "unresolved");
  const state = deriveTaskState({ steps, unresolvedAttempt });
  const [updated] = await tx
    .update(provisioningTasks)
    .set({ state, version: task.version + 1, updatedAt: now })
    .where(and(eq(provisioningTasks.id, task.id), eq(provisioningTasks.version, task.version)))
    .returning();
  if (updated === undefined) {
    throw new ApiError(409, "STEP_VERSION_CONFLICT", "the task changed while it was being updated", {
      taskId: task.id,
    });
  }
  return updated;
}

async function lockTask(tx: Tx, taskId: string, userId: string | null): Promise<TaskRow> {
  const [task] = await tx
    .select()
    .from(provisioningTasks)
    .where(and(eq(provisioningTasks.id, taskId), eq(provisioningTasks.chainId, CHAIN_ID)))
    .for("update");
  if (task === undefined || (userId !== null && task.userId !== userId)) {
    throw new ApiError(404, "TASK_NOT_FOUND", "preparation task not found");
  }
  return task;
}

async function lockStep(tx: Tx, taskId: string, stepId: string): Promise<StepRow> {
  const [step] = await tx
    .select()
    .from(provisioningSteps)
    .where(and(eq(provisioningSteps.id, stepId), eq(provisioningSteps.taskId, taskId)))
    .for("update");
  if (step === undefined) {
    throw new ApiError(404, "STEP_NOT_FOUND", "preparation step not found", { taskId, stepId });
  }
  return step;
}

async function lockSteps(tx: Tx, taskId: string): Promise<StepRow[]> {
  return tx
    .select()
    .from(provisioningSteps)
    .where(eq(provisioningSteps.taskId, taskId))
    .orderBy(provisioningSteps.ordinal)
    .for("update");
}

async function readLiveIntents(tx: Tx, taskId: string): Promise<TransactionRow[]> {
  return tx
    .select()
    .from(provisioningTransactions)
    .where(
      and(
        eq(provisioningTransactions.taskId, taskId),
        inArray(provisioningTransactions.status, [...LIVE_INTENT_STATUSES]),
      ),
    );
}

function assertTaskVersion(task: TaskRow, expectedVersion: number): void {
  if (task.version !== expectedVersion) {
    throw new ApiError(
      409,
      "STEP_VERSION_CONFLICT",
      "the task changed since this request read it",
      { taskId: task.id, expectedVersion, version: task.version },
    );
  }
}

function assertTaskNotCanceled(task: TaskRow): void {
  if (task.state === "canceled") {
    throw new ApiError(409, "TASK_CANCELED", "this task was canceled", { taskId: task.id });
  }
}

function isTerminalStepState(state: string): boolean {
  return state === "confirmed" || state === "skipped";
}

function readIdempotencyKey(raw: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.length > 255) {
    throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 1–255 characters");
  }
  return value;
}

/** §6: SHA-256 over quoteId, recipient, chain and options — never the raw header. */
export function requestDigest(quote: StoredQuote): `0x${string}` {
  return canonicalJsonSha256Hex({
    quoteId: quote.id,
    recipient: quote.recipient,
    chainId: CHAIN_ID,
    options: quote.options,
  });
}

/**
 * The `PreparationTask` DTO (§5). `prepared` attempts are omitted from
 * `transactions` on purpose: they are intents without an observation yet, and
 * the step's `intentId` already tells the client one exists. `replaced` maps to
 * `unresolved` — the superseded attempt's own outcome is unknown, and the
 * replacement carries the real one (§5, §9.2).
 */
async function readTaskDto(reader: Reader, task: TaskRow): Promise<PreparationTask> {
  const steps = await reader
    .select()
    .from(provisioningSteps)
    .where(eq(provisioningSteps.taskId, task.id))
    .orderBy(provisioningSteps.ordinal);
  const attempts = await reader
    .select()
    .from(provisioningTransactions)
    .where(eq(provisioningTransactions.taskId, task.id));

  const dtoSteps = steps.map((step) => {
    const stepAttempts = attempts
      .filter((attempt) => attempt.stepId === step.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const live = stepAttempts.find(
      (attempt) =>
        attempt.status === "prepared" ||
        attempt.status === "submitted" ||
        attempt.status === "unresolved",
    );
    const latest = live ?? stepAttempts.at(-1);
    return {
      id: step.id,
      ordinal: step.ordinal,
      kind: step.kind as PreparationStepKind,
      state: step.state as PreparationStepState,
      resource: readResourceOrNull(step.expectedResource),
      quoteId: step.quoteId,
      intentId: latest?.intentId ?? null,
      transactions: stepAttempts
        .filter((attempt) => attempt.status !== "prepared")
        .map(toTransactionResult),
      errorCode: step.errorCode,
      retryable: isStepRetryable(step, live),
      nextAction: nextActionFor(step, live),
    };
  });

  return {
    id: task.id,
    state: task.state as PreparationTask["state"],
    recipient: (task.recipientAddress as Hex).toLowerCase() as Hex,
    chainId: CHAIN_ID,
    initialQuoteId: task.initialQuoteId,
    currentQuoteId: task.currentQuoteId,
    version: task.version,
    steps: dtoSteps,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function toTransactionResult(attempt: TransactionRow): PreparationTask["steps"][number]["transactions"][number] {
  return {
    id: attempt.id,
    intentId: attempt.intentId,
    chainId: CHAIN_ID,
    from: (attempt.sender as Hex).toLowerCase() as Hex,
    to: (attempt.target as Hex).toLowerCase() as Hex,
    valueWei: attempt.valueWei,
    txHash: attempt.txHash === null ? null : (attempt.txHash.toLowerCase() as Hex),
    status: transactionStatusOf(attempt.status),
    blockNumber: attempt.blockNumber,
    blockHash: attempt.blockHash === null ? null : (attempt.blockHash.toLowerCase() as Hex),
    gasUsed: attempt.gasUsed,
    effectiveGasPriceWei: attempt.effectiveGasPriceWei,
    replacementFor: attempt.replacementFor,
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString(),
  };
}

function transactionStatusOf(status: string): "submitted" | "confirmed" | "failed" | "unresolved" {
  if (status === "confirmed") return "confirmed";
  if (status === "failed") return "failed";
  if (status === "submitted") return "submitted";
  // `unresolved` and `replaced`: the outcome of this row is not established (§5).
  return "unresolved";
}

/**
 * `retryable` is true only for a step whose attempt is fully resolved (`failed`)
 * and whose predecessors allow another signature. A submitted or unknown attempt
 * is never retryable: that is exactly the double-payment the spec forbids (§9.1).
 */
function isStepRetryable(step: StepRow, live: TransactionRow | undefined): boolean {
  if (step.state !== "failed") return false;
  if (live !== undefined) return false;
  return true;
}

function nextActionFor(step: StepRow, live: TransactionRow | undefined): string | null {
  if (live !== undefined && live.status === "unresolved") return "verify_original_transaction";
  if (step.state === "awaiting_signature") return "sign_transaction";
  if (step.state === "submitted") return "wait_for_confirmation";
  if (step.state === "external_pending") return "complete_external_purchase";
  if (step.state === "failed") return "retry_step";
  return null;
}

function readResourceOrNull(value: unknown): ResourceRef | null {
  if (value === null || value === undefined) return null;
  const record = value as Record<string, unknown>;
  if (
    record["chainId"] !== CHAIN_ID ||
    typeof record["processor"] !== "string" ||
    typeof record["tokenId"] !== "string"
  ) {
    return null;
  }
  return {
    chainId: CHAIN_ID,
    processor: record["processor"].toLowerCase() as Hex,
    tokenId: record["tokenId"],
  };
}
