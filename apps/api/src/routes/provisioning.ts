/**
 * Preparation HTTP routes — SPEC §7.3 (all nine rows) under the §7.1 common rules.
 *
 * Boundaries this module keeps:
 * - Every route calls `requireUser`, and none of these paths is in the public
 *   allowlist (`resources.ts`), so `app.ts`'s `onRequest` rejects an anonymous
 *   caller before a handler runs (§7.1 "身份使用已有 session cookie"). A quote
 *   and a task are per-user records; a task id that belongs to somebody else is
 *   404, not 403, because the id itself is private.
 * - The route validates the *shape* of a request once at the boundary, then calls
 *   the service modules. It never re-prices, re-derives calldata or remaps a
 *   service refusal: `quotes.ts`, `tasks.ts` and `transactions.ts` own every
 *   semantic code, so a code is always reported with the status it was thrown
 *   with.
 * - Mutations are audited by the global `onResponse` hook in `audit.ts`; these
 *   paths are not public, so every POST below leaves one audit row.
 *
 * The two status codes that carry meaning beyond "it worked":
 * - `202` on `transactions` and `reconcile`: registered and queued, not
 *   confirmed. A hash is evidence of a broadcast, never of delivery (§9.2), and
 *   reconcile may only read the chain (§7.3 "不能自动签名/重发").
 * - `409` from `cancel` while any send is unresolved: abandoning a possible
 *   payment is the double-spend window §7.3 closes.
 *
 * There is no purchase surface here: `offerId` and a foreign `sourceId` are
 * refused, so a quote can only price opening a circuit the caller already holds
 * (§0.3, AC-P3-34).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { XLAYER_MAINNET, type ChainConfig } from "@tapeci/config";
import type { ReadClient } from "@tapeci/chain";
import { provisioningTransactions, wallets } from "@tapeci/database";
import type {
  Hex,
  PreparedStepAction,
  PreparationTask,
  ResourceRef,
} from "@tapeci/shared";
import { createOperatorClients } from "@tapeci/verifier";
import { UUID_PATTERN } from "../audit.js";
import { requireUser } from "../auth.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { recordBody, stringField } from "../validation.js";
import {
  OPEN_SOURCE_ID,
  assertQuoteOwner,
  buildOpenQuote,
  loadQuote,
  type OpenQuoteDeps,
} from "../provisioning/quotes.js";
import {
  acceptQuote,
  cancelPreparationTask,
  createPreparationTask,
  loadPreparationTask,
  type TaskDeps,
} from "../provisioning/tasks.js";
import {
  prepareOpenIntent,
  recordTransactionHash,
  verifyOpenTransaction,
  type TransactionDeps,
  type VerifyOutcome,
} from "../provisioning/transactions.js";

/** §7.1: v1 is single-network. */
const CHAIN_ID = 196;

/** The only attempt statuses reconcile may touch: broadcast, outcome not settled. */
const UNRESOLVED_ATTEMPT_STATUSES = ["submitted", "unresolved"] as const;

/** One attempt's verification result, so the page can say *why* it is not done. */
interface ReconcileReport {
  readonly intentId: string;
  readonly stepId: string;
  readonly outcome: VerifyOutcome["kind"];
  /** Machine code behind a non-confirming outcome; `null` when there is none. */
  readonly code: string | null;
}

export function registerProvisioningRoutes(app: FastifyInstance, deps: ApiDeps): void {
  // §7.2 row 5 / §7.3: the payable quote. Server re-reads and re-prices; a
  // preview amount is never trusted because no preview amount is accepted.
  /**
   * SPEC §7.2 `POST /v1/resource-quotes/preview` — public, non-binding.
   *
   * It reads the chain and prices the step exactly as the payable route does, but persists
   * nothing and returns an id that `POST /v1/preparations` cannot accept. That is the
   * difference between "an estimate someone can look at" and "an authorisation".
   *
   * No wallet is required: a visitor who has not connected one may still ask what an open
   * would cost, and `recipient` is what the price is denominated in. A recipient that is not
   * the current holder is reported as `NOT_CURRENT_OWNER` by the same code path the payable
   * route uses, so the two cannot disagree.
   */
  app.post("/v1/resource-quotes/preview", async (request) => {
    const body = recordBody(request.body);
    const recipient = addressField(body, "recipient");
    assertOpenSourceOnly(body);
    const resource = resourceField(body);
    const quote = await buildOpenQuote(quoteDeps(deps), {
      // A preview is not a task, so there is no user to attribute it to. The quote builder
      // only uses this for ownership, which the payable route checks separately.
      userId: "preview",
      recipient,
      resource,
      persist: false,
    });
    return { quote, binding: false };
  });

  app.post("/v1/resource-quotes", async (request, reply) => {
    const user = requireUser(request);
    const body = recordBody(request.body);
    const recipient = addressField(body, "recipient");
    assertOpenSourceOnly(body);
    const resource = resourceField(body);
    const quote = await buildOpenQuote(quoteDeps(deps), {
      userId: user.id,
      recipient,
      resource,
    });
    void reply.code(201);
    return { quote };
  });

  // §7.3 row 1: create (201) or replay (200) a task from an accepted quote.
  app.post("/v1/preparations", async (request, reply) => {
    const user = requireUser(request);
    const body = recordBody(request.body);
    const quoteId = uuidField(body, "quoteId");
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (idempotencyKey === undefined) {
      throw new ApiError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency-Key header is required to create a preparation task",
      );
    }
    const quote = await loadQuote(deps.db, quoteId);
    assertQuoteOwner(quote, user.id);
    // §7.3 row 1: the quote belongs to the caller *and* its delivery wallet is
    // still verified for them. The quote was priced only after that proof, but a
    // wallet can be removed between the two calls.
    await assertVerifiedRecipient(deps, user.id, quote.recipient);
    const created = await createPreparationTask(taskDeps(deps), {
      userId: user.id,
      quoteId,
      idempotencyKey,
    });
    void reply.code(created.created ? 201 : 200);
    return { task: created.task };
  });

  // §7.3 row 2: the creator only; P3 does not share a task with project members.
  app.get("/v1/preparations/:id", async (request) => {
    const user = requireUser(request);
    const taskId = taskIdOf(request);
    return { task: await loadPreparationTask({ db: deps.db }, { taskId, userId: user.id }) };
  });

  // §7.3 row 3: a fresh quote for review. Recipient and chain are fixed, only
  // unfinished steps are re-priced, and a signed-but-unresolved send blocks it.
  app.post("/v1/preparations/:id/requote", async (request, reply) => {
    const user = requireUser(request);
    const taskId = taskIdOf(request);
    const body = optionalBody(request);
    assertSupportedOptions(body["options"]);
    const task = await loadPreparationTask({ db: deps.db }, { taskId, userId: user.id });
    assertRecipientUnchanged(body, task.recipient);
    assertRequotable(task);
    const quote = await buildOpenQuote(quoteDeps(deps), {
      userId: user.id,
      recipient: task.recipient,
      resource: repriceableResource(task),
    });
    void reply.code(201);
    return { quote };
  });

  // §7.3 row 4: accept a quote revision under CAS. Confirmed/skipped steps keep
  // the quote they were paid under (`acceptQuote`).
  app.post("/v1/preparations/:id/accept-quote", async (request) => {
    const user = requireUser(request);
    const taskId = taskIdOf(request);
    const body = recordBody(request.body);
    const quoteId = uuidField(body, "quoteId");
    const expectedVersion = versionField(body);
    return {
      task: await acceptQuote(taskDeps(deps), {
        taskId,
        userId: user.id,
        quoteId,
        expectedVersion,
      }),
    };
  });

  // §7.3 row 5: persist the intent first, then hand the wallet the exact call.
  // A repeat returns the same intent (the service replays it), never a second one.
  app.post("/v1/preparations/:id/steps/:stepId/prepare", async (request) => {
    const user = requireUser(request);
    const taskId = taskIdOf(request);
    const stepId = stepIdOf(request);
    const expectedVersion = versionField(recordBody(request.body));
    const prepared = await prepareOpenIntent(transactionDeps(deps), {
      taskId,
      stepId,
      userId: user.id,
      expectedVersion,
    });
    // P3 prepares `open` only, so the action is always the transaction branch of
    // the frozen `PreparedStepAction` union (§5).
    const action: PreparedStepAction = { kind: "transaction", transaction: prepared.action };
    return { action };
  });

  // §7.3 row 6: register the hash the wallet returned. 202 — queued for
  // verification, never `confirmed` (§9.2, AC-P3-16).
  app.post("/v1/preparations/:id/steps/:stepId/transactions", async (request, reply) => {
    const user = requireUser(request);
    const taskId = taskIdOf(request);
    const stepId = stepIdOf(request);
    const body = recordBody(request.body);
    const intentId = uuidField(body, "intentId");
    const txHash = hashField(body, "txHash");
    const task = await recordTransactionHash(transactionDeps(deps), {
      taskId,
      stepId,
      userId: user.id,
      intentId,
      txHash,
    });
    void reply.code(202);
    return { task };
  });

  // §7.3 row 7: re-verify what was already broadcast, and recover a resource that
  // appeared externally. It reads and moves state only; nothing is signed or sent.
  app.post("/v1/preparations/:id/reconcile", async (request, reply) => {
    const user = requireUser(request);
    const taskId = taskIdOf(request);
    // Ownership before any chain read: another user's task is 404, not a probe.
    await loadPreparationTask({ db: deps.db }, { taskId, userId: user.id });
    const attempts = await deps.db
      .select({
        intentId: provisioningTransactions.intentId,
        stepId: provisioningTransactions.stepId,
      })
      .from(provisioningTransactions)
      .where(
        and(
          eq(provisioningTransactions.taskId, taskId),
          inArray(provisioningTransactions.status, [...UNRESOLVED_ATTEMPT_STATUSES]),
        ),
      )
      .orderBy(provisioningTransactions.createdAt);
    // Sequential on purpose: one attempt at a time keeps the RPC load and the
    // write order predictable, and a task normally has one live attempt.
    const verifications: ReconcileReport[] = [];
    for (const attempt of attempts) {
      const outcome = await verifyOpenTransaction(transactionDeps(deps), {
        taskId,
        stepId: attempt.stepId,
        intentId: attempt.intentId,
      });
      verifications.push(describeOutcome(attempt, outcome));
    }
    void reply.code(202);
    // 202 means "verification was requested and the outcome is reported below",
    // NOT "the task advanced". §7.3's status code is about the request, not the
    // payment, so the payload says so explicitly instead of letting a caller read
    // 202 as a confirmation (issue P3-11).
    return {
      task: await loadPreparationTask({ db: deps.db }, { taskId, userId: user.id }),
      verifications,
      /** True when no attempt could be confirmed by this call. */
      reconciliationOnly: true,
      note:
        "Reconciliation is synchronous and its result is not a confirmation. " +
        "An attempt becomes confirmed only when the receipt, the canonical block, " +
        "the configured confirmation policy and the on-chain delivery all pass.",
    };
  });

  // §7.3 row 8: cancel only what never started. `cancelPreparationTask` refuses
  // with 409 TASK_UNRESOLVED while a step is submitted/external_pending or any
  // attempt is prepared/submitted/unresolved — an unknown send cannot be abandoned.
  app.post("/v1/preparations/:id/cancel", async (request) => {
    const user = requireUser(request);
    const taskId = taskIdOf(request);
    const expectedVersion = versionField(recordBody(request.body));
    return {
      task: await cancelPreparationTask(taskDeps(deps), {
        taskId,
        userId: user.id,
        expectedVersion,
      }),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Request boundary
 * ------------------------------------------------------------------ */

/**
 * §7.1: an id that cannot name a task is not found, with the same code a missing
 * task yields — a malformed id must not become a 500 from the uuid column and
 * must not tell a stranger whether the id exists.
 */
function taskIdOf(request: FastifyRequest): string {
  const params = request.params as { id?: string };
  const taskId = params.id;
  if (taskId === undefined || !UUID_PATTERN.test(taskId)) {
    throw new ApiError(404, "TASK_NOT_FOUND", "preparation task not found");
  }
  return taskId;
}

function stepIdOf(request: FastifyRequest): string {
  const params = request.params as { stepId?: string };
  const stepId = params.stepId;
  if (stepId === undefined || !UUID_PATTERN.test(stepId)) {
    throw new ApiError(404, "STEP_NOT_FOUND", "preparation step not found");
  }
  return stepId;
}

/** A body is optional only where §7.3 says "无或明确准备选项" (requote). */
function optionalBody(request: FastifyRequest): Record<string, unknown> {
  if (request.body === undefined || request.body === null) return {};
  return recordBody(request.body);
}

/** `stringField` already throws on a missing value; this narrows it for the readers below. */
function requiredString(record: Record<string, unknown>, name: string): string {
  const value = stringField(record, name);
  if (value === undefined) throw new ApiError(400, "INVALID_BODY", `${name} is required`);
  return value;
}

function addressField(record: Record<string, unknown>, name: string): Hex {
  const value = requiredString(record, name).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(value)) {
    throw new ApiError(400, "INVALID_BODY", `${name} must be a 20-byte hex address`);
  }
  return value as Hex;
}

function uuidField(record: Record<string, unknown>, name: string): string {
  const value = requiredString(record, name);
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError(400, "INVALID_BODY", `${name} must be a UUID`);
  }
  return value;
}

function hashField(record: Record<string, unknown>, name: string): Hex {
  const value = requiredString(record, name).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new ApiError(400, "INVALID_BODY", `${name} must be 0x + 64 hex characters`);
  }
  return value as Hex;
}

/**
 * §7.3: `expectedVersion` is the task `version` the client last read. `0` is a
 * real version on a fresh task, so this deliberately does not reuse
 * `integerField` (which requires a positive integer).
 */
function versionField(record: Record<string, unknown>): number {
  const value = record["expectedVersion"];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(
      400,
      "INVALID_BODY",
      "expectedVersion must be the non-negative task version this request read",
    );
  }
  return parsed;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * §7.2/§0.3: only an existing circuit is priced in P3. An `offerId` (or a source
 * that is not the built-in one) would be an acquisition line, which the quote
 * table forbids structurally, so it is refused rather than silently dropped.
 */
function assertOpenSourceOnly(body: Record<string, unknown>): void {
  const offerId = body["offerId"];
  if (offerId !== undefined && offerId !== null && offerId !== "") {
    throw new ApiError(
      422,
      "ACQUISITION_UNSUPPORTED",
      "P3 prices opening a circuit the caller already holds; offers are not quotable",
      { offerId },
    );
  }
  const sourceId = body["sourceId"];
  if (sourceId !== undefined && sourceId !== null && sourceId !== OPEN_SOURCE_ID) {
    throw new ApiError(
      422,
      "ACQUISITION_UNSUPPORTED",
      `only the built-in ${OPEN_SOURCE_ID} source is priced`,
      { sourceId },
    );
  }
  assertSupportedOptions(body["options"]);
}

/**
 * §7.2 first-phase options. `buildOpenQuote` freezes these, so a caller asking
 * for activation would otherwise receive a quote that silently ignores the
 * request; refusing it keeps every priced line visible (§3.1).
 */
function assertSupportedOptions(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "options must be a JSON object");
  }
  const options = value as Record<string, unknown>;
  if (options["prepareContainer"] !== undefined && options["prepareContainer"] !== true) {
    throw new ApiError(
      422,
      "UNSUPPORTED_OPTION",
      "P3 always prepares the container; prepareContainer=false is not priced",
      { field: "prepareContainer" },
    );
  }
  for (const field of ["activateName", "activationMonths", "activationName"]) {
    const supplied = options[field];
    if (supplied === undefined || supplied === null || supplied === false) continue;
    throw new ApiError(
      422,
      "UNSUPPORTED_OPTION",
      "domain activation is not priced in P3; it stays on the container activation path",
      { field },
    );
  }
}

/**
 * The `resource` object of a quote request. Validated here so an unknown or
 * malformed `tokenId` can never reach a chain read: `buildOpenQuote` derives a
 * container and calls `inspectContainer`, and that must only happen for a token
 * id the request actually named (§8.5).
 */
function resourceField(body: Record<string, unknown>): ResourceRef {
  const raw = body["resource"];
  if (raw === undefined || raw === null) {
    throw new ApiError(400, "INVALID_BODY", "resource is required to price an open step");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "INVALID_BODY", "resource must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const chainId = record["chainId"];
  if (chainId !== undefined && chainId !== null && chainId !== CHAIN_ID && chainId !== String(CHAIN_ID)) {
    // §7.1/§7.2: only chain 196 exists in v1.
    throw new ApiError(400, "UNSUPPORTED_CHAIN", `only chain ${CHAIN_ID} is supported`);
  }
  const processor = addressField(record, "processor");
  const tokenId = requiredString(record, "tokenId");
  if (!/^(0|[1-9][0-9]*)$/.test(tokenId)) {
    throw new ApiError(
      400,
      "INVALID_BODY",
      'tokenId must be a base-10 integer string; tokenId "0" is accepted and refused later',
    );
  }
  return { chainId: CHAIN_ID, processor, tokenId };
}

/* ------------------------------------------------------------------ *
 * Task-side preconditions the services do not own
 * ------------------------------------------------------------------ */

/** §7.3 row 1: the quote's delivery wallet is still a verified wallet of the caller. */
async function assertVerifiedRecipient(deps: ApiDeps, userId: string, recipient: Hex): Promise<void> {
  const [wallet] = await deps.db
    .select({ address: wallets.address })
    .from(wallets)
    .where(
      and(eq(wallets.userId, userId), eq(wallets.chainId, CHAIN_ID), eq(wallets.address, recipient)),
    )
    .limit(1);
  if (wallet === undefined) {
    throw new ApiError(
      403,
      "WALLET_VERIFICATION_REQUIRED",
      "the quote's delivery wallet is not verified by this user",
      { recipient },
    );
  }
}

/** §9.3/AC-P3-15: a re-quote may never move the delivery wallet. */
function assertRecipientUnchanged(body: Record<string, unknown>, recipient: Hex): void {
  const requested = body["recipient"];
  if (requested === undefined || requested === null) return;
  if (typeof requested !== "string" || requested.toLowerCase() !== recipient.toLowerCase()) {
    throw new ApiError(
      409,
      "WALLET_MISMATCH",
      "a re-quote cannot change the delivery wallet of the task",
      { taskRecipient: recipient, requested },
    );
  }
}

/**
 * §7.3: re-quote must not be used to bypass an intent that may already be signed.
 * A broadcast attempt whose outcome is unknown blocks it until reconcile settles
 * it, exactly like `cancel` (§9.1 row 8).
 */
function assertRequotable(task: PreparationTask): void {
  if (task.state === "canceled") {
    throw new ApiError(409, "TASK_CANCELED", "this task was canceled", { taskId: task.id });
  }
  const pending = task.steps.filter(
    (step) =>
      step.state === "submitted" ||
      step.state === "external_pending" ||
      step.transactions.some(
        (attempt) => attempt.status === "submitted" || attempt.status === "unresolved",
      ),
  );
  if (pending.length > 0) {
    throw new ApiError(
      409,
      "TRANSACTION_UNRESOLVED",
      "a signed transaction of this task is still unresolved; verify it before re-quoting",
      { taskId: task.id, stepIds: pending.map((step) => step.id) },
    );
  }
}

/** The circuit of the first unfinished step — the only thing P3 can re-price. */
function repriceableResource(task: PreparationTask): ResourceRef {
  const step = task.steps.find(
    (candidate) => candidate.state !== "confirmed" && candidate.state !== "skipped",
  );
  if (step === undefined) {
    throw new ApiError(
      409,
      "QUOTE_NOT_APPLICABLE",
      "every step of this task is already resolved; there is nothing to re-quote",
      { taskId: task.id },
    );
  }
  if (step.kind !== "open" || step.resource === null) {
    throw new ApiError(
      422,
      "STEP_KIND_UNSUPPORTED",
      "P3 re-prices an open step whose circuit is known",
      { taskId: task.id, stepId: step.id, kind: step.kind },
    );
  }
  return step.resource;
}

/* ------------------------------------------------------------------ *
 * Service dependencies
 * ------------------------------------------------------------------ */

interface ChainAccess {
  readonly client: ReadClient;
  readonly config: ChainConfig;
  /** Absent when only one client was injected; verification then has no second opinion. */
  readonly secondaryClient?: ReadClient;
}

/**
 * §9.2 wants two independent operators for a paid decision. In production both
 * are configured; a test injects one deterministic client, and in that case the
 * verifier must not pretend a second operator agreed, so `secondaryClient` stays
 * absent and a single read can never be reported as agreement.
 */
function chainAccess(deps: ApiDeps): ChainAccess {
  const config = XLAYER_MAINNET;
  const injected = deps.readClient;
  if (injected !== undefined) return { client: injected(), config };
  const operators = operatorClients(config);
  const primary = operators[0];
  if (primary === undefined) {
    throw new ApiError(
      503,
      "RESOURCE_READ_UNAVAILABLE",
      "no RPC operator is configured for provisioning",
      {},
      true,
    );
  }
  const secondary = operators[1];
  return secondary === undefined
    ? { client: primary.client, config }
    : { client: primary.client, config, secondaryClient: secondary.client };
}

/** A missing operator pair is a dependency failure (503), not an internal bug. */
function operatorClients(config: ChainConfig) {
  try {
    return createOperatorClients(config);
  } catch {
    throw new ApiError(
      503,
      "RESOURCE_READ_UNAVAILABLE",
      "two independent RPC operators are required before a paid preparation can be verified",
      {},
      true,
    );
  }
}

/** `now` is forwarded only when the host injected a clock (`exactOptionalPropertyTypes`). */
function nowOf(deps: ApiDeps): { readonly now?: () => Date } {
  return deps.now === undefined ? {} : { now: deps.now };
}

function taskDeps(deps: ApiDeps): TaskDeps {
  return { db: deps.db, ...nowOf(deps) };
}

function quoteDeps(deps: ApiDeps): OpenQuoteDeps {
  const chain = chainAccess(deps);
  return { db: deps.db, client: chain.client, config: chain.config, ...nowOf(deps) };
}

/**
 * The confirmation policy is read from `TAPECI_PROVISIONING_CONFIRMATIONS` and has
 * **no default** (SPEC §9.2 forbids inventing a depth). The variable accepts a
 * block count or the string `finalized`, which asks the chain for its own finalized
 * tag instead of trusting a number we chose. When it is unset,
 * `verifyOpenTransaction` reports `CONFIRMATION_POLICY_UNCONFIGURED` and leaves the
 * attempt `submitted` — the interim behaviour §5.3 requires. Configuring the
 * variable is a deliberate act, and the value must be backed by evidence.
 */
function transactionDeps(deps: ApiDeps): TransactionDeps {
  const chain = chainAccess(deps);
  const depth = deps.env.provisioningConfirmations;
  return {
    db: deps.db,
    client: chain.client,
    config: chain.config,
    ...(chain.secondaryClient === undefined ? {} : { secondaryClient: chain.secondaryClient }),
    ...(depth === undefined || depth === null ? {} : { minConfirmations: depth }),
    ...nowOf(deps),
  };
}

function describeOutcome(
  attempt: { readonly intentId: string; readonly stepId: string },
  outcome: VerifyOutcome,
): ReconcileReport {
  return {
    intentId: attempt.intentId,
    stepId: attempt.stepId,
    outcome: outcome.kind,
    code:
      outcome.kind === "failed"
        ? outcome.errorCode
        : outcome.kind === "unverified"
          ? outcome.reason
          : null,
  };
}
