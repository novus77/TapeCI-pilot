/**
 * Provisioning transaction attempts — SPEC §7.3, §9.1, §9.2, §9.4, §3.3.
 *
 * The only safe order for a wallet-broadcast call is **intent → hash → verify**,
 * because the broadcast and the database are not one transaction (`binding.ts`
 * established the same pattern for `bind`). This module therefore exposes
 * exactly those three steps and nothing that skips one:
 *
 * 1. `prepareOpenIntent` — validate the step, re-check the quote, the recipient,
 *    the chain state and the predecessor steps, then store the attempt with
 *    `status = 'prepared'` and no hash. The returned `PreparedStepTransaction` is
 *    what the wallet signs; a repeated prepare returns the same intent (§7.3).
 * 2. `recordTransactionHash` — attach a hash the wallet returned. The attempt
 *    becomes `submitted` and the step follows in the same transaction. This
 *    never confirms anything: a hash is evidence of a broadcast, not a receipt.
 * 3. `verifyOpenTransaction` — read the transaction, the receipt and the target
 *    resource from two independent RPC operators, compare every field against
 *    the stored intent, and only then move the attempt to `confirmed`. A timeout
 *    leaves it `submitted`; a divergence leaves it unverified; a mined revert
 *    makes it `failed`.
 *
 * Nothing here can produce a second paid attempt while an attempt is unresolved:
 * `prepareOpenIntent` refuses when the step has a live attempt or when its state
 * has no arrow into `awaiting_signature` (§9.1), and the `provisioning_transactions`
 * partial unique index enforces the same rule at the storage layer.
 */
import { randomUUID } from "node:crypto";
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  isAddressEqual,
  type Address,
} from "viem";
import { and, desc, eq } from "drizzle-orm";
import type { ChainConfig } from "@tapeci/config";
import { inspectContainer, openerAbi, type ReadClient } from "@tapeci/chain";
import {
  provisioningSteps,
  provisioningTasks,
  provisioningTransactions,
  resourceQuotes,
  type Database,
} from "@tapeci/database";
import {
  canonicalJsonSha256Hex,
  type Hex,
  type PreparationStepState,
  type PreparationTask,
  type PreparedStepTransaction,
  type ResourceRef,
} from "@tapeci/shared";
import { ApiError } from "../errors.js";
import {
  assertQuoteNotExpired,
  assertQuoteOwner,
  assertQuoteRecipient,
  loadQuote,
  openStepOf,
  readStoredQuote,
  type OpenStepTerms,
  type StoredQuote,
} from "./quotes.js";
import {
  loadPreparationTask,
  loadTaskInTransaction,
  readLiveIntent,
  recomputeTaskStateInTransaction,
  transitionStepInTransaction,
  type TaskTransaction,
} from "./tasks.js";

const CHAIN_ID = 196;

/**
 * The only step states that may produce a new signature (§9.1):
 * - `waiting` is promoted by preparing its first intent;
 * - `awaiting_signature` is re-prepared after a wallet rejection (the old
 *   `prepared` intent is replayed, not duplicated);
 * - `failed` is the explicit retry row of §9.1 ("原尝试已解决…新增 intent"). It is
 *   safe only because a failed step has no live attempt left: `readLiveIntent`
 *   returns `null` for it, so the retry cannot bypass an unresolved send.
 *
 * `submitted`, `external_pending`, `confirmed` and `skipped` have no arrow into a
 * signature, which is what makes a second paid attempt impossible.
 */
const PREPARE_STEP_STATES: ReadonlySet<PreparationStepState> = new Set([
  "waiting",
  "awaiting_signature",
  "failed",
]);

type AttemptRow = typeof provisioningTransactions.$inferSelect;

export interface TransactionDeps {
  readonly db: Database;
  readonly client: ReadClient;
  readonly config: ChainConfig;
  /** Optional second, independent operator; divergence keeps the attempt unverified (§9.2). */
  readonly secondaryClient?: ReadClient;
  /**
   * Required confirmation depth before an attempt may become `confirmed` (§9.2,
   * §13). It is **not** defaulted: with no configured policy `verifyOpenTransaction`
   * refuses to confirm and leaves the attempt `submitted`, because inventing a
   * "safe" depth for a paid write is exactly what §9.2 forbids. The lead wires
   * this from `TAPECI_PROVISIONING_CONFIRMATIONS`.
   */
  /**
   * Confirmation policy (SPEC §9.2). Either an explicit depth in blocks, or the
   * string `"finalized"` to require the chain's own finalized tag.
   *
   * `"finalized"` is preferred where the chain supports it: it is a consensus
   * definition, not a number we guessed. X Layer 196 does support it (measured:
   * the tag trails head by ~1500 blocks).
   */
  readonly minConfirmations?: number | "finalized";
  readonly now?: () => Date;
}

export interface PrepareOpenInput {
  readonly taskId: string;
  readonly stepId: string;
  readonly userId: string;
  /**
   * The task's `version` the client last read (§5/§7.3: the step DTO carries no
   * version, so the task's CAS token is what the client sends back).
   */
  readonly expectedVersion: number;
}

/**
 * Store (or replay) the intent for one `open` step (§7.3 `prepare`).
 *
 * Everything the wallet is about to sign is re-derived here from the stored
 * quote and re-checked on chain: the recipient still holds the circuit, the
 * circuit is still unopened, the quote has not expired and the price has not
 * moved. A change is `QUOTE_CHANGED`, which forces a re-quote and a fresh
 * review instead of silently sending a different amount (§9.3).
 */
export async function prepareOpenIntent(
  deps: TransactionDeps,
  input: PrepareOpenInput,
): Promise<{ readonly action: PreparedStepTransaction; readonly task: PreparationTask }> {
  requireXLayer(deps.config);
  const now = deps.now?.() ?? new Date();

  // Phase 1 — read-only preflight outside any lock: no row is held while an RPC
  // answers, so a slow node cannot block another request's transaction.
  const preflight = await readPreparePreflight(deps, input, now);

  // Phase 2 — one short transaction that re-checks what could have changed while
  // phase 1 was reading, then stores the intent and makes the step signable.
  return deps.db.transaction(async (tx) => {
    const task = await lockTaskForUser(tx, input.taskId, input.userId);
    assertTaskVersion(task, input.expectedVersion);
    const step = await lockStep(tx, task.id, input.stepId);
    const state = step.state as PreparationStepState;
    assertPreparable(state, step, task.id);
    if (step.kind !== "open") {
      // P3 is `open` only: no acquisition, no activation through this path (§0.3).
      throw new ApiError(
        422,
        "STEP_KIND_UNSUPPORTED",
        `this module prepares open steps only, got ${step.kind}`,
        { taskId: task.id, stepId: step.id, kind: step.kind },
      );
    }

    // §9.1: a replay returns the same intent; a live broadcast is never replaced.
    const live = await readLiveIntent(tx, step.id);
    if (live !== null) {
      if (live.status === "prepared") {
        const liveQuote = await loadQuoteInTransaction(tx, live.quoteId);
        return {
          action: toPreparedTransaction(live, openStepOf(liveQuote, step.id).expiresAt),
          task: await loadTaskInTransaction(tx, task.id),
        };
      }
      throw new ApiError(
        409,
        "TRANSACTION_UNRESOLVED",
        "this step already has a broadcast attempt whose outcome is not resolved",
        { taskId: task.id, stepId: step.id, attemptId: live.id, status: live.status },
      );
    }

    const quote = await loadQuoteInTransaction(tx, step.quoteId);
    assertQuoteOwner(quote, input.userId);
    assertQuoteRecipient(quote, task.recipientAddress as Hex);
    assertQuoteNotExpired(quote, now);
    const terms = openStepOf(quote, step.id);
    if (terms.expiresAt !== quote.expiresAt.toISOString()) {
      throw new ApiError(500, "INTERNAL", "the quote step expiry disagrees with the quote");
    }
    // The quote read in phase 1 priced the preflight; a different quote now means
    // the task was re-priced while we were checking, so the preflight is stale.
    if (terms.id !== preflight.terms.id || terms.valueWei !== preflight.terms.valueWei) {
      throw new ApiError(
        409,
        "QUOTE_CHANGED",
        "the task was re-quoted while preparing; review the new quote and prepare again",
        { taskId: task.id, stepId: step.id },
      );
    }
    await assertPredecessorsResolved(tx, task.id, step.ordinal, step.id);

    const intentId = randomUUID();
    const [attempt] = await tx
      .insert(provisioningTransactions)
      .values({
        taskId: task.id,
        stepId: step.id,
        quoteId: quote.id,
        intentId,
        chainId: CHAIN_ID,
        sender: task.recipientAddress.toLowerCase(),
        target: terms.to,
        valueWei: terms.valueWei,
        calldata: terms.data,
        gasLimit: terms.gasLimit,
        gasPriceWei: terms.gasPriceWei,
        maxGasCostWei: terms.maxGasCostWei,
        expectedDigest: intentDigest({
          chainId: CHAIN_ID,
          from: task.recipientAddress as Hex,
          to: terms.to,
          valueWei: terms.valueWei,
          data: terms.data,
          gasLimit: terms.gasLimit,
          gasPriceWei: terms.gasPriceWei,
        }),
        status: "prepared",
      })
      .returning();
    if (attempt === undefined) {
      throw new ApiError(500, "INTERNAL", "the transaction intent could not be stored");
    }

    // The step becomes signable only after the intent exists, so a crash between
    // these two writes leaves a step that still shows "prepare", never a signed
    // transaction the database never saw (§9.4).
    const taskDto = await transitionStepInTransaction(
      tx,
      {
        taskId: task.id,
        stepId: step.id,
        // The task row is locked here, so its version is the current one; the
        // helper re-reads it and CAS-increments it in the same transaction.
        expectedVersion: task.version,
        to: "awaiting_signature",
        intentId,
      },
      now,
    );
    return { action: toPreparedTransaction(attempt, terms.expiresAt), task: taskDto };
  });
}

/**
 * Read-only prepare preflight (§7.3: "prepare 前重新查登录、wallet proof、当前 owner、
 * network、quote expiry、前序步骤、价格及已解决交易"). Every check that needs the
 * chain happens here, before any lock is taken.
 */
async function readPreparePreflight(
  deps: TransactionDeps,
  input: PrepareOpenInput,
  now: Date,
): Promise<{ readonly terms: OpenStepTerms }> {
  const [task] = await deps.db
    .select()
    .from(provisioningTasks)
    .where(and(eq(provisioningTasks.id, input.taskId), eq(provisioningTasks.chainId, CHAIN_ID)))
    .limit(1);
  if (task === undefined || task.userId !== input.userId) {
    throw new ApiError(404, "TASK_NOT_FOUND", "preparation task not found");
  }
  if (task.state === "canceled") {
    throw new ApiError(409, "TASK_CANCELED", "this task was canceled", { taskId: task.id });
  }
  const [step] = await deps.db
    .select()
    .from(provisioningSteps)
    .where(and(eq(provisioningSteps.id, input.stepId), eq(provisioningSteps.taskId, task.id)))
    .limit(1);
  if (step === undefined) {
    throw new ApiError(404, "STEP_NOT_FOUND", "preparation step not found", {
      taskId: task.id,
      stepId: input.stepId,
    });
  }
  assertTaskVersion(task, input.expectedVersion);
  assertPreparable(step.state as PreparationStepState, step, task.id);
  if (step.kind !== "open") {
    throw new ApiError(
      422,
      "STEP_KIND_UNSUPPORTED",
      `this module prepares open steps only, got ${step.kind}`,
      { taskId: task.id, stepId: step.id, kind: step.kind },
    );
  }
  const live = await readLiveIntent(deps.db, step.id);
  if (live !== null) {
    // A prepared intent is replayable; a broadcast one is not. Phase 2 returns the
    // replay, so nothing is written here.
    if (live.status !== "prepared") {
      throw new ApiError(
        409,
        "TRANSACTION_UNRESOLVED",
        "this step already has a broadcast attempt whose outcome is not resolved",
        { taskId: task.id, stepId: step.id, attemptId: live.id, status: live.status },
      );
    }
    const quote = await loadQuote(deps.db, live.quoteId);
    return { terms: openStepOf(quote, step.id) };
  }

  const quote = await loadQuote(deps.db, step.quoteId);
  assertQuoteOwner(quote, input.userId);
  assertQuoteRecipient(quote, task.recipientAddress as Hex);
  assertQuoteNotExpired(quote, now);
  const terms = openStepOf(quote, step.id);
  await recheckOpenPreconditions(deps, {
    resource: terms.resource,
    recipient: task.recipientAddress as Hex,
    terms,
    now,
  });
  return { terms };
}

function assertTaskVersion(
  task: typeof provisioningTasks.$inferSelect,
  expectedVersion: number,
): void {
  if (task.version !== expectedVersion) {
    throw new ApiError(
      409,
      "STEP_VERSION_CONFLICT",
      "the task changed since this request read it",
      { taskId: task.id, expectedVersion, version: task.version },
    );
  }
}

/** Only `waiting` and `awaiting_signature` may produce a new signature (§9.1). */
function assertPreparable(
  state: PreparationStepState,
  step: typeof provisioningSteps.$inferSelect,
  taskId: string,
): void {
  if (PREPARE_STEP_STATES.has(state)) return;
  // §9.1: submitted / external_pending / confirmed / skipped have no arrow into a
  // new signature. `failed` needs an explicit retry (a new intent), never a silent
  // re-prepare of the old one.
  throw new ApiError(
    409,
    state === "submitted" || state === "external_pending"
      ? "TRANSACTION_UNRESOLVED"
      : "INVALID_STEP_TRANSITION",
    `a step in ${state} cannot prepare another transaction`,
    { taskId, stepId: step.id, state },
  );
}

async function lockStep(
  tx: TaskTransaction,
  taskId: string,
  stepId: string,
): Promise<typeof provisioningSteps.$inferSelect> {
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

/** §9.1: every earlier step must already be confirmed/skipped. */
async function assertPredecessorsResolved(
  tx: TaskTransaction,
  taskId: string,
  ordinal: number,
  stepId: string,
): Promise<void> {
  const steps = await tx
    .select({ id: provisioningSteps.id, ordinal: provisioningSteps.ordinal, state: provisioningSteps.state })
    .from(provisioningSteps)
    .where(eq(provisioningSteps.taskId, taskId));
  const blocking = steps.filter(
    (candidate) =>
      candidate.ordinal < ordinal &&
      candidate.state !== "confirmed" &&
      candidate.state !== "skipped",
  );
  if (blocking.length > 0) {
    throw new ApiError(
      409,
      "STEP_ORDER_VIOLATION",
      "an earlier step of this task is not confirmed yet",
      { taskId, stepId, blocking: blocking.map((candidate) => candidate.id) },
    );
  }
}

export interface RecordHashInput {
  readonly taskId: string;
  readonly stepId: string;
  readonly userId: string;
  readonly intentId: string;
  readonly txHash: Hex;
}

/**
 * Register the hash a wallet returned (§7.3 `transactions`).
 *
 * The attempt moves to `submitted` and the step to `submitted` in one
 * transaction. Registration is deliberately not confirmation: the response is
 * 202 semantics and the caller must not treat it as delivery (§9.2, §9.4).
 */
export async function recordTransactionHash(
  deps: TransactionDeps,
  input: RecordHashInput,
): Promise<PreparationTask> {
  const now = deps.now?.() ?? new Date();
  const txHash = readHash(input.txHash);

  return deps.db.transaction(async (tx) => {
    const task = await lockTaskForUser(tx, input.taskId, input.userId);
    const [step] = await tx
      .select()
      .from(provisioningSteps)
      .where(and(eq(provisioningSteps.id, input.stepId), eq(provisioningSteps.taskId, task.id)))
      .for("update");
    if (step === undefined) {
      throw new ApiError(404, "STEP_NOT_FOUND", "preparation step not found", {
        taskId: task.id,
        stepId: input.stepId,
      });
    }

    const [attempt] = await tx
      .select()
      .from(provisioningTransactions)
      .where(
        and(
          eq(provisioningTransactions.taskId, task.id),
          eq(provisioningTransactions.stepId, step.id),
          eq(provisioningTransactions.intentId, input.intentId),
        ),
      )
      .for("update");
    if (attempt === undefined) {
      // A hash is never attributed to an intent the task did not store (§9.2).
      throw new ApiError(
        409,
        "TRANSACTION_MISMATCH",
        "this task has no intent with that id",
        { taskId: task.id, stepId: step.id, intentId: input.intentId },
      );
    }

    // The same hash reported twice is idempotent.
    if (attempt.txHash !== null) {
      if (attempt.txHash.toLowerCase() === txHash) {
        return loadTaskInTransaction(tx, task.id);
      }
      // §9.2 "replacement 记录与原 sender/nonce 对应": a *different* hash for the same
      // intent is a replacement, and it is recorded as its own row pointing back at the
      // attempt it superseded — never by overwriting the first hash, because the first
      // transaction may still be mined and the record of it must survive.
      await recordReplacementAttempt(tx, {
        previous: attempt,
        txHash,
        stepId: step.id,
        now,
      });
      return loadTaskInTransaction(tx, task.id);
    }

    // A hash that already belongs to another attempt cannot be re-attributed: that
    // is how a historical transaction gets claimed as a new payment (§9.2).
    const [duplicate] = await tx
      .select({ id: provisioningTransactions.id, taskId: provisioningTransactions.taskId })
      .from(provisioningTransactions)
      .where(
        and(
          eq(provisioningTransactions.chainId, CHAIN_ID),
          eq(provisioningTransactions.txHash, txHash),
        ),
      )
      .limit(1);
    if (duplicate !== undefined) {
      throw new ApiError(
        409,
        "TRANSACTION_MISMATCH",
        "this hash is already recorded for another attempt",
        { txHash, attemptId: duplicate.id, taskId: duplicate.taskId },
      );
    }

    const [updatedAttempt] = await tx
      .update(provisioningTransactions)
      .set({ txHash, status: "submitted", updatedAt: now })
      .where(eq(provisioningTransactions.id, attempt.id))
      .returning();
    if (updatedAttempt === undefined) {
      throw new ApiError(500, "INTERNAL", "the transaction hash could not be recorded");
    }

    return transitionStepInTransaction(
      tx,
      {
        taskId: task.id,
        stepId: step.id,
        expectedVersion: task.version,
        to: "submitted",
        intentId: attempt.intentId,
      },
      now,
    );
  });
}

export type VerifyOutcome =
  | { readonly kind: "confirmed"; readonly task: PreparationTask }
  | { readonly kind: "failed"; readonly task: PreparationTask; readonly errorCode: string }
  | { readonly kind: "pending"; readonly task: PreparationTask }
  | { readonly kind: "unverified"; readonly task: PreparationTask; readonly reason: string };

export interface VerifyInput {
  readonly taskId: string;
  readonly stepId: string;
  readonly intentId: string;
}

/**
 * Verify one broadcast attempt (§9.2 checklist), then move it.
 *
 * The order is fixed, and every read happens **outside** the database
 * transaction so no lock is held while an RPC answers:
 * 1. read the transaction (`eth_getTransactionByHash`) and compare chain/from/to/
 *    value/data against the stored intent — a mismatch is never "our" payment;
 * 2. read the receipt; no receipt yet is `pending`, not a failure;
 * 3. a reverted receipt is `failed` — the attempt is resolved and provably did
 *    not deliver;
 * 4. require the receipt's block to still be canonical and, when a second
 *    operator is configured, require both to agree; disagreement leaves the
 *    attempt unverified instead of choosing a value;
 * 5. re-read the target resource at the receipt's block and require the opener to
 *    report it opened — a successful receipt alone is not delivery.
 *
 * The confirmation depth is a configured policy (`minConfirmations`), never a
 * guessed "safe" number: below it the attempt stays `submitted` (§9.2, §13).
 */
export async function verifyOpenTransaction(
  deps: TransactionDeps,
  input: VerifyInput,
): Promise<VerifyOutcome> {
  const now = deps.now?.() ?? new Date();
  const confirmations = confirmationsPolicy(deps);
  const attempt = await readAttempt(deps.db, input);
  if (attempt.status === "confirmed") {
    // §9.1 row 12: a confirmed attempt is not automatically settled forever. If the block
    // it was confirmed in has since left the canonical chain, the record of "this payment
    // landed" is no longer true and the attempt must go back for review rather than keep
    // asserting a success that the chain no longer supports.
    //
    // Only a *positive* reorg demotes it: an unreadable node leaves the confirmation
    // standing, because turning "we could not check" into "the payment vanished" would be
    // the same false-negative this codebase already forbids for pending reads.
    if (attempt.blockNumber !== null && attempt.blockHash !== null) {
      const verdict = await canonicalVerdict(
        deps,
        BigInt(attempt.blockNumber),
        attempt.blockHash as Hex,
      );
      // Only a POSITIVE reorg demotes a confirmation. `unreadable` leaves it standing: an
      // RPC outage must never erase the record of a payment that did land, which is exactly
      // the false negative the round-2 audit found here.
      if (verdict === "reorged") {
        return applyVerification(deps, input, now, {
          kind: "unverified",
          // `submitted`, not `unresolved`: the step is being re-opened for review, and the
          // step machine only accepts that when the attempt it names is itself `submitted`.
          // The reason travels on the step (`CHAIN_REORG_PENDING`), which is what the
          // console shows, so nothing is lost by keeping the attempt in the sendable state.
          status: "submitted",
          step: "submitted",
          errorCode: "CHAIN_REORG_PENDING",
          result: { reorgDetectedAtBlock: attempt.blockNumber },
        });
      }
    }
    return {
      kind: "confirmed",
      task: await loadTaskDto(deps.db, attempt.taskId),
    };
  }
  if (attempt.status === "failed") {
    return {
      kind: "failed",
      task: await loadTaskDto(deps.db, attempt.taskId),
      errorCode: "TRANSACTION_REVERTED",
    };
  }

  if (attempt.txHash === null) {
    // Broadcast without a returned hash: the user may still supply it, so nothing
    // is re-sent, the step keeps its state and the task becomes `needs_action`
    // (§3.3 "结果待核验"). Marking it failed would invite a second paid attempt.
    return applyVerification(deps, input, now, {
      kind: "unverified",
      status: "unresolved",
      step: null,
      errorCode: "TRANSACTION_UNRESOLVED",
    });
  }

  const txHash = attempt.txHash as Hex;
  const chainTx = await readTransaction(deps, txHash);
  if (chainTx === null) {
    // The node does not know the hash yet. Pending, not failed (§3.3).
    return { kind: "pending", task: await loadTaskDto(deps.db, attempt.taskId) };
  }
  const mismatch = intentMismatch(attempt, chainTx);
  if (mismatch !== null) {
    // Someone else's transaction, a different amount or different calldata: this
    // attempt is resolved as a failure and its payment is not ours (§9.2).
    return applyVerification(deps, input, now, {
      kind: "failed",
      status: "failed",
      step: "failed",
      errorCode: "TRANSACTION_MISMATCH",
      result: { mismatch },
    });
  }

  const receipt = await readReceipt(deps, txHash);
  if (receipt === null) {
    // No receipt yet: keep `submitted`. A timeout is never a failure (§9.2).
    return { kind: "pending", task: await loadTaskDto(deps.db, attempt.taskId) };
  }
  if (receipt.status !== "success") {
    return applyVerification(deps, input, now, {
      kind: "failed",
      status: "failed",
      step: "failed",
      errorCode: "TRANSACTION_REVERTED",
      receipt,
    });
  }

  if (confirmations === null) {
    // No configured depth: record the receipt facts but never claim confirmation.
    return applyVerification(deps, input, now, {
      kind: "unverified",
      status: "submitted",
      step: null,
      receipt,
      errorCode: "CONFIRMATION_POLICY_UNCONFIGURED",
    });
  }
  const confirmedEnough = await meetsPolicy(deps, receipt.blockNumber, confirmations);
  if (!confirmedEnough) {
    // Mined but not deep enough under the configured policy: still `submitted`.
    return applyVerification(deps, input, now, {
      kind: "pending",
      status: "submitted",
      step: null,
      receipt,
    });
  }

  if (!(await isCanonical(deps, receipt.blockNumber, receipt.blockHash))) {
    // The block was replaced or the operators disagree: keep the attempt
    // unverified rather than choosing a value (§9.2).
    return {
      kind: "unverified",
      task: await loadTaskDto(deps.db, attempt.taskId),
      reason: "RPC_DISAGREEMENT",
    };
  }

  const resource = await readStepResource(deps.db, attempt.stepId);
  if (resource === null) {
    return {
      kind: "unverified",
      task: await loadTaskDto(deps.db, attempt.taskId),
      reason: "DELIVERY_UNVERIFIED",
    };
  }
  const delivered = await readDelivery(deps, resource, receipt.blockNumber);
  if (delivered === null) {
    // A successful receipt that did not open the right circuit is not delivery.
    return {
      kind: "unverified",
      task: await loadTaskDto(deps.db, attempt.taskId),
      reason: "DELIVERY_UNVERIFIED",
    };
  }

  return applyVerification(deps, input, now, {
    kind: "confirmed",
    status: "confirmed",
    step: "confirmed",
    receipt,
    result: { delivered },
  });
}

interface VerificationResult {
  /** The `VerifyOutcome` this write should report. */
  readonly kind: "confirmed" | "failed" | "pending" | "unverified";
  readonly status: "submitted" | "confirmed" | "failed" | "unresolved";
  /** The step state to move to, or `null` to leave the step where it is. */
  readonly step: PreparationStepState | null;
  readonly errorCode?: string;
  readonly result?: Record<string, unknown>;
  readonly receipt?: ChainReceipt;
}

/**
 * The only writer of attempt status, kept in one short transaction so the attempt
 * row and its step always agree. Re-reads both rows under lock: a concurrent
 * reconcile may have moved them while the reads above were in flight.
 */
/**
 * Record a replacement attempt (§9.2).
 *
 * The replaced row is marked `replaced` and the new one carries `replacement_for`, so the
 * history of both transactions survives. The new row reuses the intent's sender/nonce by
 * construction: it is the same wallet, the same intent, and only the hash differs.
 */
async function recordReplacementAttempt(
  tx: TaskTransaction,
  input: {
    readonly previous: typeof provisioningTransactions.$inferSelect;
    readonly txHash: Hex;
    readonly stepId: string;
    readonly now: Date;
  },
): Promise<void> {
  await tx
    .update(provisioningTransactions)
    .set({ status: "replaced", updatedAt: input.now })
    .where(eq(provisioningTransactions.id, input.previous.id));
  await tx.insert(provisioningTransactions).values({
    taskId: input.previous.taskId,
    stepId: input.stepId,
    quoteId: input.previous.quoteId,
    // A replacement is the same intent: only the hash and the row identity differ, which
    // is what lets the verifier attribute the mined transaction to this payment.
    intentId: input.previous.intentId,
    chainId: input.previous.chainId,
    sender: input.previous.sender,
    target: input.previous.target,
    valueWei: input.previous.valueWei,
    calldata: input.previous.calldata,
    gasLimit: input.previous.gasLimit,
    gasPriceWei: input.previous.gasPriceWei,
    maxGasCostWei: input.previous.maxGasCostWei,
    expectedDigest: input.previous.expectedDigest,
    ...(input.previous.nonce === null ? {} : { nonce: input.previous.nonce }),
    txHash: input.txHash,
    replacementFor: input.previous.id,
    status: "submitted",
    updatedAt: input.now,
  });
}

async function applyVerification(
  deps: TransactionDeps,
  input: VerifyInput,
  now: Date,
  outcome: VerificationResult,
): Promise<VerifyOutcome> {
  return deps.db.transaction(async (tx) => {
    // No user check here: this path is called by the reconcile worker, which is
    // not acting for a session user. Route-level authorization is the caller's.
    const task = await lockTask(tx, input.taskId);
    const step = await lockStep(tx, input.taskId, input.stepId);
    const [attempt] = await tx
      .select()
      .from(provisioningTransactions)
      .where(
        and(
          eq(provisioningTransactions.taskId, input.taskId),
          eq(provisioningTransactions.stepId, input.stepId),
          eq(provisioningTransactions.intentId, input.intentId),
        ),
      )
      .for("update");
    if (attempt === undefined) {
      throw new ApiError(404, "TRANSACTION_NOT_FOUND", "no attempt with that intent id", {
        taskId: input.taskId,
        stepId: input.stepId,
        intentId: input.intentId,
      });
    }
    // A resolved attempt is never rewritten by a later read of the same hash — with one
    // exception: a reorg finding is new information about a confirmation that is no longer
    // true, so it is allowed to demote the attempt back to `unresolved` for review (§9.1
    // row 12). Every other later read of a confirmed hash stays a no-op.
    if (attempt.status === "confirmed" && outcome.errorCode !== "CHAIN_REORG_PENDING") {
      return { kind: "confirmed", task: await loadTaskInTransaction(tx, input.taskId) };
    }
    if (attempt.status === "failed") {
      return {
        kind: "failed",
        task: await loadTaskInTransaction(tx, input.taskId),
        errorCode: "TRANSACTION_REVERTED",
      };
    }

    await tx
      .update(provisioningTransactions)
      .set({
        status: outcome.status,
        ...(outcome.receipt === undefined
          ? {}
          : {
              blockNumber: outcome.receipt.blockNumber.toString(10),
              blockHash: outcome.receipt.blockHash,
              gasUsed: outcome.receipt.gasUsed.toString(10),
              effectiveGasPriceWei: outcome.receipt.effectiveGasPriceWei?.toString(10) ?? null,
            }),
        updatedAt: now,
      })
      .where(eq(provisioningTransactions.id, attempt.id));

    if (outcome.step === null) {
      // The step stays put, but the task summary must still reflect an unresolved
      // send, so it can never read as "ready to pay again" (§9.1).
      //
      // AC-P3-30: the *reason* must survive on the step, not only in the reconcile
      // response. Otherwise `/preparations/[id]` can name neither the unconfigured
      // confirmation policy nor any other withheld confirmation — the user would see a
      // state with no explanation, and that is exactly the honesty gap §12.4 forbids.
      if (outcome.kind === "unverified" && outcome.errorCode !== undefined) {
        await tx
          .update(provisioningSteps)
          .set({ errorCode: outcome.errorCode, version: step.version + 1, updatedAt: now })
          .where(eq(provisioningSteps.id, step.id));
      }
      const taskDto = await recomputeTaskStateInTransaction(tx, input.taskId, now);
      if (outcome.kind === "pending") return { kind: "pending" as const, task: taskDto };
      return {
        kind: "unverified" as const,
        task: taskDto,
        reason: outcome.errorCode ?? "TRANSACTION_UNRESOLVED",
      };
    }

    const taskDto = await transitionStepInTransaction(
      tx,
      {
        taskId: input.taskId,
        stepId: step.id,
        expectedVersion: task.version,
        to: outcome.step,
        // A demotion back to `submitted` is only legal when the transition names the
        // stored intent (§9.1 row 1: a step becomes submitted only by registering a hash
        // for a stored intent). The reorg branch is the one path that returns to
        // `submitted` from a later state, so it must carry the intent it is re-opening.
        ...(outcome.step === "submitted" ? { intentId: input.intentId } : {}),
        ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
      },
      now,
    );

    if (outcome.kind === "confirmed") return { kind: "confirmed" as const, task: taskDto };
    if (outcome.kind === "failed") {
      return {
        kind: "failed" as const,
        task: taskDto,
        errorCode: outcome.errorCode ?? "TRANSACTION_REVERTED",
      };
    }
    return {
      kind: "unverified" as const,
      task: taskDto,
      reason: outcome.errorCode ?? "TRANSACTION_UNRESOLVED",
    };
  });
}

async function readAttempt(
  db: Database,
  input: VerifyInput,
): Promise<AttemptRow> {
  // §9.2 replacement chains: one intent can have an original row and one or more
  // `replacement_for` rows. Without an explicit order `.limit(1)` returns whichever row
  // the planner happens to produce, so "which hash is this payment" would be undefined —
  // the round-2 audit (R2-7) found exactly that. Newest first, because the newest
  // transaction is the one a sender actually mined last; ties break on id so the answer is
  // stable even when created_at collides inside one transaction.
  const [attempt] = await db
    .select()
    .from(provisioningTransactions)
    .where(
      and(
        eq(provisioningTransactions.taskId, input.taskId),
        eq(provisioningTransactions.stepId, input.stepId),
        eq(provisioningTransactions.intentId, input.intentId),
      ),
    )
    .orderBy(desc(provisioningTransactions.createdAt), desc(provisioningTransactions.id))
    .limit(1);
  if (attempt === undefined) {
    throw new ApiError(404, "TRANSACTION_NOT_FOUND", "no attempt with that intent id", {
      taskId: input.taskId,
      stepId: input.stepId,
      intentId: input.intentId,
    });
  }
  return attempt;
}

/** The DTO read without a surrounding transaction, for the read-only outcomes. */
async function loadTaskDto(db: Database, taskId: string): Promise<PreparationTask> {
  const [row] = await db
    .select()
    .from(provisioningTasks)
    .where(eq(provisioningTasks.id, taskId))
    .limit(1);
  if (row === undefined) {
    throw new ApiError(404, "TASK_NOT_FOUND", "preparation task not found");
  }
  return loadPreparationTask({ db }, { taskId: row.id, userId: row.userId });
}

/**
 * Store the intent's canonical digest so a later read can prove the on-chain
 * transaction is the one this row describes (§9.2). Kept as a pure function so
 * the verifier and the writer cannot drift.
 */
export function intentDigest(input: {
  readonly chainId: number;
  readonly from: Hex;
  readonly to: Hex;
  readonly valueWei: string;
  readonly data: Hex;
  readonly gasLimit: string;
  readonly gasPriceWei: string;
}): Hex {
  return canonicalJsonSha256Hex({
    chainId: input.chainId,
    from: input.from.toLowerCase(),
    to: input.to.toLowerCase(),
    value: input.valueWei,
    data: input.data.toLowerCase(),
    gasLimit: input.gasLimit,
    gasPrice: input.gasPriceWei,
  });
}

/**
 * The stored intent as the frozen DTO (§5). `expiresAt` is the accepted quote's
 * expiry — the intent inherits it and cannot outlive the price the user reviewed
 * (§7.2, §9.3); it is never derived from the row's creation time.
 */
function toPreparedTransaction(attempt: AttemptRow, expiresAt: string): PreparedStepTransaction {
  return {
    intentId: attempt.intentId,
    taskId: attempt.taskId,
    stepId: attempt.stepId,
    quoteId: attempt.quoteId,
    chainId: CHAIN_ID,
    from: (attempt.sender as Hex).toLowerCase() as Hex,
    to: (attempt.target as Hex).toLowerCase() as Hex,
    value: attempt.valueWei,
    // A built-in `open` step sends a fixed opener fee, so the cap equals the value.
    // The field exists so a variable-price source can set it higher later (§7.2).
    maxValueWei: attempt.valueWei,
    data: attempt.calldata as Hex,
    gasLimit: attempt.gasLimit,
    gasPriceWei: attempt.gasPriceWei,
    maxGasCostWei: attempt.maxGasCostWei,
    expiresAt,
  };
}

interface ChainTransaction {
  /** `null` when the node omits it; treated as a mismatch, never as "close enough". */
  readonly chainId: number | null;
  readonly from: Hex;
  readonly to: Hex | null;
  readonly value: bigint;
  readonly input: Hex;
}

interface ChainReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly gasUsed: bigint;
  readonly effectiveGasPriceWei: bigint | null;
}

/** `null` when the node has no such transaction yet (pending, not failed). */
async function readTransaction(
  deps: TransactionDeps,
  txHash: Hex,
): Promise<ChainTransaction | null> {
  try {
    const tx = await deps.client.getTransaction({ hash: txHash });
    if (tx === null) return null;
    return {
      chainId: tx.chainId ?? null,
      from: tx.from.toLowerCase() as Hex,
      to: tx.to === null ? null : (tx.to.toLowerCase() as Hex),
      value: tx.value,
      input: tx.input,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw unavailable("the transaction", error);
  }
}

/** `null` when the node has no receipt yet; a timeout is "unknown", not "failed". */
async function readReceipt(
  deps: TransactionDeps,
  txHash: Hex,
): Promise<ChainReceipt | null> {
  try {
    const receipt = await deps.client.getTransactionReceipt({ hash: txHash });
    return {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed,
      effectiveGasPriceWei: receipt.effectiveGasPrice === undefined ? null : receipt.effectiveGasPrice,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw unavailable("the receipt", error);
  }
}

/**
 * Field-by-field comparison against the stored intent (§9.2). Returns the first
 * mismatch, or `null` when the transaction is the stored intent.
 */
function intentMismatch(
  attempt: AttemptRow,
  chainTx: ChainTransaction,
): Record<string, unknown> | null {
  if (chainTx.chainId !== CHAIN_ID) {
    return { field: "chainId", expected: CHAIN_ID, actual: chainTx.chainId };
  }
  if (chainTx.to === null || !isAddressEqual(chainTx.to as Address, attempt.target as Address)) {
    return { field: "to", expected: attempt.target, actual: chainTx.to };
  }
  if (!isAddressEqual(chainTx.from as Address, attempt.sender as Address)) {
    return { field: "from", expected: attempt.sender, actual: chainTx.from };
  }
  if (chainTx.value.toString(10) !== attempt.valueWei) {
    return { field: "value", expected: attempt.valueWei, actual: chainTx.value.toString(10) };
  }
  if (chainTx.input.toLowerCase() !== attempt.calldata.toLowerCase()) {
    return { field: "data", expected: attempt.calldata, actual: chainTx.input };
  }
  // The digest is recomputed rather than trusted, so a row edited after the fact
  // cannot pass: it must hash back to the fields the chain actually shows.
  const digest = intentDigest({
    chainId: CHAIN_ID,
    from: chainTx.from,
    to: chainTx.to,
    valueWei: chainTx.value.toString(10),
    data: chainTx.input,
    gasLimit: attempt.gasLimit,
    gasPriceWei: attempt.gasPriceWei,
  });
  if (digest !== attempt.expectedDigest) {
    return { field: "digest", expected: attempt.expectedDigest, actual: digest };
  }
  return null;
}

/**
 * `false` when the block at that height no longer has this hash (§9.2). With a
 * second operator configured, both must report the same hash at that height; a
 * disagreement is not canonical, so the attempt stays unverified.
 */
/**
 * Is the block still on the canonical chain?
 *
 * Three outcomes, not two, because "we could not read it" is not evidence of a reorg:
 *
 * - `canonical`    — every readable operator reports the expected hash;
 * - `reorged`      — an operator answered and the hash differs;
 * - `unreadable`   — no operator could answer, so nothing is proven either way.
 *
 * Collapsing `unreadable` into `false` is what made an RPC outage demote a confirmed
 * payment (round-2 finding on P7-06). The distinction only matters where a negative answer
 * spends money — i.e. demoting a confirmation — but the function is shared, so it is
 * modelled honestly and each caller decides.
 */
type CanonicalVerdict = "canonical" | "reorged" | "unreadable";

async function canonicalVerdict(
  deps: TransactionDeps,
  blockNumber: bigint,
  blockHash: Hex,
): Promise<CanonicalVerdict> {
  const readHashAt = async (client: ReadClient): Promise<Hex | null> => {
    try {
      const block = await client.getBlock({ blockNumber });
      return block.hash.toLowerCase() as Hex;
    } catch {
      return null;
    }
  };
  const expected = blockHash.toLowerCase();
  const clients =
    deps.secondaryClient === undefined ? [deps.client] : [deps.client, deps.secondaryClient];
  const answers = await Promise.all(clients.map(readHashAt));
  const readable = answers.filter((answer): answer is Hex => answer !== null);
  if (readable.length === 0) return "unreadable";
  // Any operator that answered with a different hash is a disagreement: §9.2 says do not
  // pick a winner, and a reorg is the safest reading of two different blocks at one height.
  return readable.every((answer) => answer === expected) ? "canonical" : "reorged";
}

/** Boolean view for callers where `unreadable` and `reorged` are both "do not proceed". */
async function isCanonical(
  deps: TransactionDeps,
  blockNumber: bigint,
  blockHash: Hex,
): Promise<boolean> {
  return (await canonicalVerdict(deps, blockNumber, blockHash)) === "canonical";
}

/**
 * Re-read the target resource at the receipt's block and require `isOpened` to
 * be true. A receipt success is not delivery (§9.2, §9.4).
 */
/** The resource the step expects; `null` when the snapshot is not a readable ref. */
async function readStepResource(db: Database, stepId: string): Promise<ResourceRef | null> {
  const [step] = await db
    .select({ expectedResource: provisioningSteps.expectedResource })
    .from(provisioningSteps)
    .where(eq(provisioningSteps.id, stepId))
    .limit(1);
  return readResource(step?.expectedResource ?? null);
}

async function readDelivery(
  deps: TransactionDeps,
  resource: ResourceRef,
  blockNumber: bigint,
): Promise<Record<string, unknown> | null> {
  const tokenId = BigInt(resource.tokenId);

  const readAt = async (client: ReadClient): Promise<{ container: Hex; opened: boolean }> => {
    const container = await client.readContract({
      address: deps.config.opener,
      abi: openerAbi,
      functionName: "accountOf",
      args: [resource.processor, tokenId],
      blockNumber,
    });
    const opened = await client.readContract({
      address: deps.config.opener,
      abi: openerAbi,
      functionName: "isOpened",
      args: [resource.processor, tokenId],
      blockNumber,
    });
    return { container: container.toLowerCase() as Hex, opened };
  };

  let primary: { container: Hex; opened: boolean };
  try {
    primary = await readAt(deps.client);
  } catch {
    return null;
  }
  if (!primary.opened) return null;

  const inspection = await inspectContainer(deps.client, deps.config, primary.container, blockNumber);
  if (inspection.readStatus !== "verified" || !inspection.opened) return null;
  if (inspection.tokenId !== tokenId) return null;

  if (deps.secondaryClient !== undefined) {
    // §9.2: two independent operators must agree; divergence stays unverified.
    const secondary = await readAt(deps.secondaryClient).catch(() => null);
    if (secondary === null) return null;
    if (!secondary.opened || secondary.container !== primary.container) return null;
  }

  return {
    container: primary.container,
    processor: resource.processor,
    tokenId: resource.tokenId,
    openedAtBlock: blockNumber.toString(10),
  };
}

/** Re-check the quote's preconditions immediately before storing an intent (§7.3). */
async function recheckOpenPreconditions(
  deps: TransactionDeps,
  input: {
    readonly resource: ResourceRef;
    readonly recipient: Hex;
    readonly terms: OpenStepTerms;
    readonly now: Date;
  },
): Promise<void> {
  const tokenId = BigInt(input.resource.tokenId);
  const blockNumber = await deps.client.getBlockNumber();
  const container = await deps.client
    .readContract({
      address: deps.config.opener,
      abi: openerAbi,
      functionName: "accountOf",
      args: [input.resource.processor, tokenId],
      blockNumber,
    })
    .catch((error: unknown) => {
      // A revert means the opener has no account for this token: the resource is
      // gone (422). Only a transport failure is "unavailable" (503).
      if (isExplicitContractAnswer(error)) {
        throw new ApiError(422, "RESOURCE_NOT_FOUND", "the opener has no container for this circuit", {
          processor: input.resource.processor,
          tokenId: input.resource.tokenId,
        });
      }
      throw unavailable("the container derivation", error);
    });
  const inspection = await inspectContainer(deps.client, deps.config, container, blockNumber);
  if (inspection.readStatus === "unavailable") {
    throw new ApiError(
      503,
      "RESOURCE_READ_UNAVAILABLE",
      `could not re-read the circuit before preparing: ${inspection.failure.message}`,
      { stage: inspection.failure.stage, observedBlock: blockNumber.toString(10) },
      true,
    );
  }
  if (inspection.readStatus === "not_found") {
    throw new ApiError(422, "RESOURCE_NOT_FOUND", "the circuit no longer exists", {
      reason: inspection.reason,
    });
  }
  if (inspection.opened) {
    // Someone (possibly the user) already opened it: no paid step is needed.
    throw new ApiError(
      409,
      "ALREADY_OPENED",
      "this circuit is already opened; refresh the task instead of sending another open",
      { container: inspection.container, observedBlock: blockNumber.toString(10) },
    );
  }
  if (inspection.owner.toLowerCase() !== input.recipient.toLowerCase()) {
    // §3.1 step 3: a transfer between quote and prepare invalidates the quote.
    throw new ApiError(
      403,
      "OWNER_REQUIRED",
      "the delivery wallet no longer holds this circuit",
      {
        container: inspection.container,
        owner: inspection.owner,
        recipient: input.recipient,
        observedBlock: blockNumber.toString(10),
      },
    );
  }
  const fee = await deps.client
    .readContract({
      address: deps.config.opener,
      abi: openerAbi,
      functionName: "FEE",
      blockNumber,
    })
    .catch((error: unknown) => {
      throw unavailable("the opener fee", error);
    });
  if (fee.toString(10) !== input.terms.valueWei) {
    // §9.3: the price moved, so the user must review a new quote.
    throw new ApiError(
      409,
      "QUOTE_CHANGED",
      "the opener fee changed since this quote was priced",
      { quoteValueWei: input.terms.valueWei, currentValueWei: fee.toString(10) },
    );
  }
}

/**
 * The confirmation-depth policy, or `null` when none is configured.
 *
 * A missing policy is not "assume 1": the caller then reports the attempt as
 * unverified-with-reason instead of confirming it. `TAPECI_PROVISIONING_CONFIRMATIONS`
 * is not in `env.ts` yet, so production must wire it before any mainnet `open`
 * can reach `confirmed` (§9.2, §13).
 */

/**
 * Does a receipt at `blockNumber` satisfy the confirmation policy?
 *
 * A numeric policy compares depth. `"finalized"` asks the chain itself: the block
 * must be at or below the `finalized` tag, which is a consensus fact rather than a
 * number we chose (SPEC §9.2 forbids guessing a safe depth). A node that does not
 * support the tag cannot satisfy the policy, so this fails closed.
 */
async function meetsPolicy(
  deps: TransactionDeps,
  blockNumber: bigint,
  policy: bigint | "finalized",
): Promise<boolean> {
  if (policy !== "finalized") {
    const head = await deps.client.getBlockNumber();
    return head - blockNumber >= policy;
  }
  try {
    const finalized = await deps.client.getBlock({ blockTag: "finalized" });
    if (finalized.number === null) return false;
    return blockNumber <= finalized.number;
  } catch {
    // The tag is unavailable: the attempt stays `submitted` rather than being
    // confirmed on a weaker basis.
    return false;
  }
}

function confirmationsPolicy(deps: TransactionDeps): bigint | "finalized" | null {
  const configured = deps.minConfirmations;
  if (configured === undefined) return null;
  if (configured === "finalized") return configured;
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new ApiError(
      500,
      "INVALID_CONFIG",
      "the provisioning confirmation policy must be a positive integer or 'finalized'",
    );
  }
  return BigInt(configured);
}

async function loadQuoteInTransaction(
  tx: TaskTransaction,
  quoteId: string,
): Promise<StoredQuote> {
  const [row] = await tx
    .select()
    .from(resourceQuotes)
    .where(eq(resourceQuotes.id, quoteId))
    .limit(1);
  if (row === undefined) {
    throw new ApiError(404, "QUOTE_NOT_FOUND", "quote not found");
  }
  // Reuse the public reader so a stored snapshot is parsed exactly once.
  return readStoredQuote(row);
}

async function lockTask(
  tx: TaskTransaction,
  taskId: string,
): Promise<typeof provisioningTasks.$inferSelect> {
  const [task] = await tx
    .select()
    .from(provisioningTasks)
    .where(and(eq(provisioningTasks.id, taskId), eq(provisioningTasks.chainId, CHAIN_ID)))
    .for("update");
  if (task === undefined) {
    throw new ApiError(404, "TASK_NOT_FOUND", "preparation task not found");
  }
  return task;
}

async function lockTaskForUser(
  tx: TaskTransaction,
  taskId: string,
  userId: string,
): Promise<typeof provisioningTasks.$inferSelect> {
  const [task] = await tx
    .select()
    .from(provisioningTasks)
    .where(and(eq(provisioningTasks.id, taskId), eq(provisioningTasks.chainId, CHAIN_ID)))
    .for("update");
  if (task === undefined || task.userId !== userId) {
    throw new ApiError(404, "TASK_NOT_FOUND", "preparation task not found");
  }
  return task;
}

function readHash(raw: Hex): Hex {
  const value = raw.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new ApiError(400, "INVALID_BODY", "txHash must be 0x + 64 hex characters");
  }
  return value as Hex;
}

function readResource(value: unknown): ResourceRef | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    record["chainId"] !== CHAIN_ID ||
    typeof record["processor"] !== "string" ||
    typeof record["tokenId"] !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(record["tokenId"])
  ) {
    return null;
  }
  return {
    chainId: CHAIN_ID,
    processor: record["processor"].toLowerCase() as Hex,
    tokenId: record["tokenId"],
  };
}

function requireXLayer(config: ChainConfig): void {
  if (config.chainId !== CHAIN_ID) {
    throw new ApiError(
      500,
      "INVALID_CONFIG",
      `provisioning supports chain ${CHAIN_ID} only, got ${config.chainId}`,
    );
  }
}

function unavailable(what: string, error: unknown): ApiError {
  return new ApiError(
    503,
    "RESOURCE_READ_UNAVAILABLE",
    `could not read ${what}`,
    { stage: what, reason: describeError(error) },
    true,
  );
}

/** `true` only when the chain answered (a revert or an empty return), never a timeout. */
function isExplicitContractAnswer(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError,
    ) !== null
  );
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { readonly name?: string; readonly code?: string } | null;
  if (candidate === null || typeof candidate !== "object") return false;
  return (
    candidate.name === "TransactionNotFoundError" ||
    candidate.name === "TransactionReceiptNotFoundError" ||
    candidate.name === "BlockNotFoundError" ||
    candidate.code === "NOT_FOUND"
  );
}

function describeError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}
