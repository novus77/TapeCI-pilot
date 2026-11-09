/**
 * P3 acceptance — "open an existing circuit" (SPEC §15.1 names this file).
 *
 * **Numbering asserted here: `product-p3.md`'s zero-padded `AC-P3-01…37`.**
 * These are NOT `product-p0.md`'s unpadded `AC-P3-1…8` (issue P3-06); every id in
 * a test name below is the zero-padded one, and the phase-level gates are cited
 * as `AC-P3-N` only inside comments.
 *
 * The money-critical negatives come first, in the order P3-03 says they matter:
 * a pending hash may never buy a second paid attempt, a re-quote may never reset
 * a confirmed step, an invisible receipt is never a failure, a divergent RPC
 * picks no winner, and — the honest current state — an `open` never reaches
 * `confirmed` while no confirmation policy is configured (issue P3-01).
 *
 * Two layers are exercised:
 *
 * 1. **Service layer (green today).** `apps/api/src/provisioning/{quotes,tasks,
 *    transactions}.ts` is merged, so these assertions run against the real
 *    implementation with a fake `ReadClient` and PostgreSQL. They are the
 *    authoritative pins for the money rules.
 * 2. **HTTP layer (red today).** SPEC §7.3's route contract is being written
 *    concurrently (`apps/api/src/routes/provisioning.ts`, task T03-c). The
 *    route-contract block at the bottom asserts the contract; it is expected to
 *    fail with 404 until that file lands. It is deliberately **not** skipped:
 *    a missing route is a red test, never a passing skip.
 *
 * Run from the repo root (test-p0 §1.4 — the package-dir form is broken):
 *   node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs exec vitest run tests/p2/provisioning/open.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { decodeFunctionData, type Hex } from "viem";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  migrateUp,
  provisioningQuoteAcceptances,
  provisioningSteps,
  provisioningTransactions,
  resourceQuotes,
  type Database,
} from "@tapeci/database";
import { XLAYER_MAINNET } from "@tapeci/config";
import { openerAbi } from "@tapeci/chain";
import type { PreparationTask } from "@tapeci/shared";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";
import { ApiError } from "../../../apps/api/src/errors.js";
import {
  DEFAULT_QUOTE_TTL_SECONDS,
  buildOpenQuote,
} from "../../../apps/api/src/provisioning/quotes.js";
import {
  acceptQuote,
  createPreparationTask,
  loadPreparationTask,
} from "../../../apps/api/src/provisioning/tasks.js";
import {
  prepareOpenIntent,
  recordTransactionHash,
  verifyOpenTransaction,
} from "../../../apps/api/src/provisioning/transactions.js";
import {
  FEE_WEI,
  GAS_PRICE_WEI,
  OWNER,
  OTHER_WALLET,
  PROCESSOR,
  TOKEN_ID,
  createFakeChain,
  fixedClock,
  seedUser,
  seedWallet,
  successReceipt,
  transactionFromAttempt,
  type FakeChain,
} from "./helpers.js";

const available = await databaseAvailable();
const unavailableLabel =
  "P3 open journey [SKIPPED: PostgreSQL is unreachable; the suite needs the shared " +
  "PG service on 127.0.0.1:55432 (TAPECI_TEST_DATABASE_URL)]";

/** One instant for the whole suite: quotes are priced and read from the same clock. */
const NOW = new Date("2026-10-27T08:00:00.000Z");

const env: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: "p3-open-session-secret-value",
  devAuth: true,
  objectStoreDir: ".tapeci/objects",
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: "test-webhook-secret",
  githubOidcAudience: "tapeci-artifact-upload",
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
  githubAppSlug: null,
  githubOAuthClientId: null,
  githubOAuthClientSecret: null,
  githubOAuthBaseUrl: "https://github.com",
  githubApiBaseUrl: "https://api.github.com",
  publicApiUrl: "http://127.0.0.1:8787",
  webUrl: "http://127.0.0.1:3000",
  sessionTtlSeconds: 604_800,
  operatorPrivateKey: null,
  writeRpcUrl: null,
  journalDir: ".tapeci/journal",
};

const RESOURCE = {
  chainId: 196 as const,
  processor: PROCESSOR,
  tokenId: TOKEN_ID.toString(10),
};

/** Resolve the thrown `ApiError`, or fail loudly with whatever else was thrown. */
async function captureApiError(run: Promise<unknown>): Promise<ApiError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused with an ApiError");
}

describe.skipIf(!available)(available ? "P3 §7.2/§7.3 open journey (AC-P3-01…37)" : unavailableLabel, () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await migrateUp(testDatabase.url);
    handle = createDatabase(testDatabase.url);
    db = handle.db;
    userId = await seedUser(db, 9_001, "circuit-holder");
    otherUserId = await seedUser(db, 9_002, "someone-else");
    await seedWallet(db, userId, OWNER);
    await seedWallet(db, otherUserId, OTHER_WALLET);
  }, 90_000);

  afterAll(async () => {
    await handle?.pool.end();
    await testDatabase?.drop();
  }, 30_000);

  // ── fixture builders ───────────────────────────────────────────────────────

  function chain(overrides: Parameters<typeof createFakeChain>[0] = {}): FakeChain {
    return createFakeChain(overrides);
  }

  function quoteDeps(fake: FakeChain) {
    return {
      db,
      client: fake.client,
      config: XLAYER_MAINNET,
      now: fixedClock(NOW),
    };
  }

  function txDeps(fake: FakeChain, extra: { secondary?: FakeChain; minConfirmations?: number } = {}) {
    return {
      db,
      client: fake.client,
      config: XLAYER_MAINNET,
      now: fixedClock(NOW),
      ...(extra.secondary === undefined ? {} : { secondaryClient: extra.secondary.client }),
      ...(extra.minConfirmations === undefined ? {} : { minConfirmations: extra.minConfirmations }),
    };
  }

  async function quoteOnce(fake: FakeChain, asUser = userId, recipient: Hex = OWNER) {
    return buildOpenQuote(quoteDeps(fake), { userId: asUser, recipient, resource: RESOURCE });
  }

  /** A task with one `open` step, as `POST /v1/preparations` would leave it. */
  async function taskOnce(fake: FakeChain, key = `key-${Math.random()}`) {
    const quote = await quoteOnce(fake);
    const created = await createPreparationTask(
      { db, now: fixedClock(NOW) },
      { userId, quoteId: quote.id, idempotencyKey: key },
    );
    return { quote, task: created.task, stepId: created.task.steps[0]?.id ?? "" };
  }

  async function countAttempts(stepId: string) {
    return db
      .select()
      .from(provisioningTransactions)
      .where(eq(provisioningTransactions.stepId, stepId));
  }

  async function readTask(taskId: string): Promise<PreparationTask> {
    return loadPreparationTask({ db }, { taskId, userId });
  }

  async function countQuotes(): Promise<number> {
    return (await db.select().from(resourceQuotes)).length;
  }

  // ── 1. AC-P3-12 — a pending hash cannot produce a second paid attempt ──────

  it("AC-P3-12: a live submitted attempt refuses a second paid action and leaves exactly one intent row", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const prepared = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });

    // The intent is stored before the wallet is asked to sign (AC-P3-09).
    const beforeHash = await countAttempts(stepId);
    expect(beforeHash, "prepare must persist exactly one attempt").toHaveLength(1);
    expect(beforeHash[0]?.status).toBe("prepared");
    expect(beforeHash[0]?.txHash).toBeNull();
    expect(beforeHash[0]?.expectedDigest).toMatch(/^0x[0-9a-f]{64}$/);

    const txHash = `0x${"a1".repeat(32)}` as Hex;
    await recordTransactionHash(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      intentId: prepared.action.intentId,
      txHash,
    });

    // The money-critical assertion: a hash is pending, so no second signature.
    const afterVersion = (await readTask(task.id)).version;
    const refusal = await captureApiError(
      prepareOpenIntent(txDeps(fake), {
        taskId: task.id,
        stepId,
        userId,
        expectedVersion: afterVersion,
      }),
    );
    expect(refusal.code).toBe("TRANSACTION_UNRESOLVED");
    expect(refusal.statusCode).toBe(409);

    const attempts = await countAttempts(stepId);
    expect(attempts, "no second attempt may exist while one is live").toHaveLength(1);
    expect(["prepared", "submitted", "unresolved"]).toContain(attempts[0]?.status);
    expect(attempts[0]?.txHash).toBe(txHash);
  });

  it("AC-P3-12: two concurrent prepares mint exactly one intent (one wins, one is refused)", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const call = () =>
      prepareOpenIntent(txDeps(fake), {
        taskId: task.id,
        stepId,
        userId,
        expectedVersion: task.version,
      });
    const results = await Promise.allSettled([call(), call()]);
    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );

    expect(fulfilled, "exactly one concurrent prepare may store an intent").toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = rejected[0]?.reason;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("STEP_VERSION_CONFLICT");
    expect(await countAttempts(stepId)).toHaveLength(1);
  });

  // ── 2. AC-P3-14 — a re-quote cannot reset already-confirmed steps ─────────

  it("AC-P3-14: a re-quote leaves a confirmed step's state, quoteId, intentId and transactions untouched", async () => {
    // A one-step `open` quote is the only shape P3 produces, and `acceptQuote`
    // refuses when every step is terminal — so the §9.3 invariant is only
    // reachable with a second, still-unfinished step. It is added directly from
    // the real quote snapshot (only `id`/`ordinal` differ), not hand-built.
    const fake = chain();
    const first = await quoteOnce(fake);
    const created = await createPreparationTask(
      { db, now: fixedClock(NOW) },
      { userId, quoteId: first.id, idempotencyKey: `requote-${first.id}` },
    );
    const taskId = created.task.id;
    const stepZeroId = created.task.steps[0]?.id ?? "";

    const [firstRow] = await db
      .select()
      .from(resourceQuotes)
      .where(eq(resourceQuotes.id, first.id))
      .limit(1);
    if (firstRow === undefined) throw new Error("fixture: the quote row vanished");
    const snapshot = firstRow.stepsSnapshot as Record<string, unknown>[];
    const stepOneId = "6f1e6a2c-3a9e-4c2b-8d3a-1b0c2d3e4f50";
    const secondQuoteId = await insertDerivedQuote(firstRow, [
      snapshot[0] as Record<string, unknown>,
      { ...(snapshot[0] as Record<string, unknown>), id: stepOneId, ordinal: 1 },
    ]);
    await db.insert(provisioningSteps).values({
      id: stepOneId,
      taskId,
      ordinal: 1,
      kind: "open",
      state: "waiting",
      quoteId: first.id,
      expectedResource: RESOURCE,
    });

    // Take step 0 all the way to `confirmed` through the real verification path.
    // The depth here is TEST-ONLY (AC-P3-31 mechanics, product-p3 §5.3); the
    // default-closed behaviour is asserted separately in AC-P3-29/30.
    const prepared = await prepareOpenIntent(txDeps(fake), {
      taskId,
      stepId: stepZeroId,
      userId,
      expectedVersion: (await readTask(taskId)).version,
    });
    await recordTransactionHash(txDeps(fake), {
      taskId,
      stepId: stepZeroId,
      userId,
      intentId: prepared.action.intentId,
      txHash: `0x${"c1".repeat(32)}` as Hex,
    });
    const attempt = (await countAttempts(stepZeroId))[0];
    if (attempt === undefined) throw new Error("fixture: no attempt");
    fake.state.opened = true;
    fake.state.tx = transactionFromAttempt(attempt);
    fake.state.receipt = successReceipt();
    const verified = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
      taskId,
      stepId: stepZeroId,
      intentId: attempt.intentId,
    });
    expect(verified.kind, "the fixture needs a confirmed step 0").toBe("confirmed");

    const before = (await readTask(taskId)).steps.find((step) => step.id === stepZeroId);
    if (before === undefined) throw new Error("fixture: step 0 missing");
    expect(before.state).toBe("confirmed");
    const acceptancesBefore = await db
      .select()
      .from(provisioningQuoteAcceptances)
      .where(eq(provisioningQuoteAcceptances.taskId, taskId));

    const taskBefore = await readTask(taskId);
    const accepted = await acceptQuote(
      { db, now: fixedClock(NOW) },
      {
        taskId,
        userId,
        quoteId: secondQuoteId,
        expectedVersion: taskBefore.version,
      },
    );

    const after = accepted.steps.find((step) => step.id === stepZeroId);
    expect(after, "the confirmed step must still exist").toBeDefined();
    expect(after?.state, "a re-quote must not reset a confirmed step").toBe("confirmed");
    expect(after?.quoteId, "the paid step keeps the quote it was paid under").toBe(before.quoteId);
    expect(after?.intentId, "the paid intent must not be replaced").toBe(before.intentId);
    expect(after?.transactions).toEqual(before.transactions);

    // Only the task's current quote moves, and the acceptance log grows by one.
    expect(accepted.currentQuoteId).toBe(secondQuoteId);
    expect(accepted.initialQuoteId).toBe(first.id);
    const acceptancesAfter = await db
      .select()
      .from(provisioningQuoteAcceptances)
      .where(eq(provisioningQuoteAcceptances.taskId, taskId));
    expect(acceptancesAfter.length).toBe(acceptancesBefore.length + 1);

    // The still-unfinished step 1 does move to the new quote (§9.3).
    const stepOne = accepted.steps.find((step) => step.id === stepOneId);
    expect(stepOne?.quoteId).toBe(secondQuoteId);

    /** Insert a revision whose steps are clones of the real snapshot. */
    async function insertDerivedQuote(
      row: typeof resourceQuotes.$inferSelect,
      steps: Record<string, unknown>[],
    ): Promise<string> {
      const [inserted] = await db
        .insert(resourceQuotes)
        .values({
          userId: row.userId,
          recipientAddress: row.recipientAddress,
          chainId: row.chainId,
          sourceId: row.sourceId,
          offerId: row.offerId,
          resourceSnapshot: row.resourceSnapshot,
          options: row.options,
          stepsSnapshot: steps,
          pricesSnapshot: row.pricesSnapshot,
          observedBlock: row.observedBlock,
          expiresAt: new Date(NOW.getTime() + DEFAULT_QUOTE_TTL_SECONDS * 1_000),
          termsVersion: row.termsVersion,
          createdAt: NOW,
        })
        .returning();
      if (inserted === undefined) throw new Error("fixture: derived quote insert failed");
      return inserted.id;
    }
  });

  // ── 3. AC-P3-19 / AC-P3-20 — invisible receipt vs mined revert ────────────

  it("AC-P3-19: an invisible receipt stays submitted (running), never failed, and mints no second intent", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const prepared = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });
    const txHash = `0x${"d1".repeat(32)}` as Hex;
    await recordTransactionHash(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      intentId: prepared.action.intentId,
      txHash,
    });

    // The transaction is known, the receipt is not: the node simply has not
    // indexed it. §3.3: unknown, never a failure.
    fake.state.tx = transactionFromAttempt((await countAttempts(stepId))[0]!);
    fake.state.receipt = null;

    const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
      taskId: task.id,
      stepId,
      intentId: prepared.action.intentId,
    });
    expect(outcome.kind).toBe("pending");

    const taskAfter = await readTask(task.id);
    const step = taskAfter.steps.find((candidate) => candidate.id === stepId);
    expect(step?.state, "an invisible receipt must not become failed").toBe("submitted");
    expect(taskAfter.state, "the task is running, not needs_action").toBe("running");
    expect(step?.retryable, "a pending attempt is never retryable").toBe(false);
    expect(step?.errorCode).not.toBe("TRANSACTION_REVERTED");

    const attempts = await countAttempts(stepId);
    expect(attempts, "no second intent may be created").toHaveLength(1);
    expect(attempts[0]?.status).toBe("submitted");
    expect(attempts[0]?.txHash).toBe(txHash);
  });

  it("AC-P3-20: a mined revert is failed with a machine code, retryable, and the task needs_action", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const prepared = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });
    await recordTransactionHash(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      intentId: prepared.action.intentId,
      txHash: `0x${"d2".repeat(32)}` as Hex,
    });
    fake.state.tx = transactionFromAttempt((await countAttempts(stepId))[0]!);
    fake.state.receipt = { ...successReceipt(), status: "reverted" };

    const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
      taskId: task.id,
      stepId,
      intentId: prepared.action.intentId,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.errorCode).toBe("TRANSACTION_REVERTED");
    }

    const taskAfter = await readTask(task.id);
    const step = taskAfter.steps.find((candidate) => candidate.id === stepId);
    expect(step?.state).toBe("failed");
    expect(step?.errorCode).toBe("TRANSACTION_REVERTED");
    expect(step?.retryable, "a resolved revert may be retried explicitly").toBe(true);
    expect(taskAfter.state).toBe("needs_action");
    expect((await countAttempts(stepId))[0]?.status).toBe("failed");
  });

  // ── 4. AC-P3-22 — a divergent RPC picks no winner ─────────────────────────

  it("AC-P3-22: divergent operators leave the step submitted with RPC_DISAGREEMENT and no confirmed state", async () => {
    const primary = chain();
    const { task, stepId } = await taskOnce(primary);
    const prepared = await prepareOpenIntent(txDeps(primary), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });
    await recordTransactionHash(txDeps(primary), {
      taskId: task.id,
      stepId,
      userId,
      intentId: prepared.action.intentId,
      txHash: `0x${"e1".repeat(32)}` as Hex,
    });
    primary.state.tx = transactionFromAttempt((await countAttempts(stepId))[0]!);
    primary.state.receipt = successReceipt();

    // Operator B answers a different block hash at the same height. Neither
    // answer may be preferred (§9.2 "分歧保持待核验，不能选一个返回值继续付费").
    const secondary = chain({ blockHash: `0x${"b2".repeat(32)}` });

    const outcome = await verifyOpenTransaction(
      txDeps(primary, { secondary, minConfirmations: 1 }),
      { taskId: task.id, stepId, intentId: prepared.action.intentId },
    );
    expect(outcome.kind, "a disagreement must not confirm").toBe("unverified");
    if (outcome.kind === "unverified") {
      expect(outcome.reason).toBe("RPC_DISAGREEMENT");
    }

    const taskAfter = await readTask(task.id);
    const step = taskAfter.steps.find((candidate) => candidate.id === stepId);
    expect(step?.state, "the step stays where it was").toBe("submitted");
    expect(step?.state).not.toBe("confirmed");
    expect(taskAfter.state).toBe("running");
    expect((await countAttempts(stepId))[0]?.status, "no attempt is resolved by a disagreement").toBe(
      "submitted",
    );
  });

  // ── 5. AC-P3-29/30 — no confirmation policy, so no `open` reaches confirmed ─

  it("AC-P3-29/30: with no confirmation policy configured a real successful receipt never reaches confirmed", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const prepared = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });
    await recordTransactionHash(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      intentId: prepared.action.intentId,
      txHash: `0x${"f1".repeat(32)}` as Hex,
    });

    // Everything else is perfect: the exact intent on chain, a successful
    // receipt five blocks deep, the circuit verifiably opened at that block.
    const attempt = (await countAttempts(stepId))[0]!;
    fake.state.tx = transactionFromAttempt(attempt);
    fake.state.receipt = successReceipt();
    fake.state.opened = true;

    // No `minConfirmations` — the shipped default (issue P3-01).
    const outcome = await verifyOpenTransaction(txDeps(fake), {
      taskId: task.id,
      stepId,
      intentId: prepared.action.intentId,
    });

    expect(outcome.kind, "an unconfigured policy must not confirm").toBe("unverified");
    if (outcome.kind === "unverified") {
      expect(outcome.reason).toBe("CONFIRMATION_POLICY_UNCONFIGURED");
    }

    const taskAfter = await readTask(task.id);
    const step = taskAfter.steps.find((candidate) => candidate.id === stepId);
    // The negative stated explicitly: this is the honest current state.
    expect(step?.state).not.toBe("confirmed");
    expect(step?.state).toBe("submitted");
    expect(taskAfter.state, "an unconfirmed step keeps the task out of completed").not.toBe(
      "completed",
    );
    expect(taskAfter.state).toBe("running");
    expect(step?.retryable).toBe(false);
    // AC-P3-30: the reason must reach the step DTO, not only the reconcile response —
    // otherwise `/preparations/[id]` has nothing to name and the user sees a state with
    // no explanation.
    expect(step?.errorCode).toBe("CONFIRMATION_POLICY_UNCONFIGURED");

    // The receipt facts are still recorded, so the page can show what it has.
    const stored = (await countAttempts(stepId))[0]!;
    expect(stored.status).toBe("submitted");
    expect(stored.blockNumber, "the block number is recorded even when unconfirmed").toBe(
      successReceipt().blockNumber.toString(10),
    );
    expect(stored.blockHash).toBe(successReceipt().blockHash);

    // Re-running the check changes nothing: no policy, no confirmation, no resend.
    const again = await verifyOpenTransaction(txDeps(fake), {
      taskId: task.id,
      stepId,
      intentId: prepared.action.intentId,
    });
    expect(again.kind).toBe("unverified");
    expect((await countAttempts(stepId))).toHaveLength(1);
    expect((await readTask(task.id)).steps.find((s) => s.id === stepId)?.state).toBe("submitted");
  });

  it("AC-P3-31: a test-only depth changes the outcome to confirmed (mechanics only, never the default)", async () => {
    // product-p3 §5.3 allows exactly this and nothing more: a fork/test-only depth
    // proving the mechanics. The production default stays closed (AC-P3-29/30).
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const prepared = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });
    await recordTransactionHash(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      intentId: prepared.action.intentId,
      txHash: `0x${"f2".repeat(32)}` as Hex,
    });
    const attempt = (await countAttempts(stepId))[0]!;
    fake.state.tx = transactionFromAttempt(attempt);
    fake.state.receipt = successReceipt();
    fake.state.opened = true;

    const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
      taskId: task.id,
      stepId,
      intentId: prepared.action.intentId,
    });
    expect(outcome.kind).toBe("confirmed");

    // AC-P3-25: gas is recorded as gasUsed × effectiveGasPrice, separately from
    // the opener fee the user paid.
    const stored = (await countAttempts(stepId))[0]!;
    expect(stored.gasUsed).toBe(successReceipt().gasUsed.toString(10));
    expect(stored.effectiveGasPriceWei).toBe(GAS_PRICE_WEI.toString(10));
    expect(stored.valueWei, "the opener fee is its own column").toBe(FEE_WEI.toString(10));
    expect(
      BigInt(stored.valueWei) === BigInt(stored.gasUsed ?? "0") * BigInt(stored.effectiveGasPriceWei ?? "0"),
      "the fee line and the gas columns must not be the same number",
    ).toBe(false);
  });

  // ── 6. §8.6 — an unreadable read is never "not opened" ────────────────────

  it("AC-P3-07: an unavailable chain read is 503 with no quote row and no 'not opened' claim", async () => {
    const fake = chain({ failAt: "isOpened" });
    const before = await countQuotes();
    const error = await captureApiError(quoteOnce(fake));
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe("RESOURCE_READ_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    const body = `${error.message} ${JSON.stringify(error.details)}`;
    expect(body).not.toMatch(/not opened|no circuit/i);
    expect(await countQuotes(), "an unreadable chain leaves no quote behind").toBe(before);
  });

  it("AC-P3-01 (as merged): an already-opened circuit is refused a quote and writes no row", async () => {
    const fake = chain({ opened: true });
    const before = await countQuotes();
    const error = await captureApiError(quoteOnce(fake));
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("ALREADY_OPENED");
    expect(await countQuotes(), "no payable quote for an opened circuit").toBe(before);
  });

  it("AC-P3-06: a recipient who is not the current holder cannot create a quote", async () => {
    const fake = chain({ owner: OWNER });
    const before = await countQuotes();
    const error = await captureApiError(quoteOnce(fake, otherUserId, OTHER_WALLET));
    // AC-P3-06 as specified: a state conflict (409 NOT_CURRENT_OWNER), not an
    // authorization failure. `open` is permissionless on chain, so "only the holder
    // may open" is a product restriction — which is why refusing is a conflict with
    // current state rather than a 403 (issue P3-09, closed).
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("NOT_CURRENT_OWNER");
    expect(error.details["owner"]).toBe(OWNER);
    expect(await countQuotes()).toBe(before);
  });

  it("AC-P3-08: tokenId 0 is refused before any chain read, with no quote row", async () => {
    const fake = chain();
    const before = await countQuotes();
    const error = await captureApiError(
      buildOpenQuote(quoteDeps(fake), {
        userId,
        recipient: OWNER,
        resource: { ...RESOURCE, tokenId: "0" },
      }),
    );
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe("RESOURCE_TOKEN_ZERO_UNSUPPORTED");
    expect(fake.state.reads, "token 0 must not be priced from a chain read").toHaveLength(0);
    expect(await countQuotes()).toBe(before);
  });

  // ── §7.2 quote contents and the one open primitive ────────────────────────

  it("AC-P3-02/03/04: an unopened circuit yields one payable open step, an exact fee and a separate gas line", async () => {
    const fake = chain();
    const quote = await quoteOnce(fake);
    expect(quote.offerId, "no acquisition line is structural").toBeNull();
    expect(quote.resource).not.toBeNull();
    expect(quote.sourceId).toBe("builtin:open");
    expect(quote.chainId).toBe(196);
    expect(quote.steps).toHaveLength(1);
    expect(quote.steps[0]?.kind).toBe("open");
    expect(quote.steps[0]?.ordinal).toBe(0);
    expect(quote.prices.map((price) => price.kind).sort()).toEqual(["gas", "open"]);
    expect(quote.prices.some((price) => price.kind === "acquisition")).toBe(false);
    expect(quote.prices.some((price) => price.kind === "service")).toBe(false);

    const fee = quote.prices.find((price) => price.kind === "open");
    expect(fee?.amountWei, "the opener fee is the exact FEE() read").toBe(FEE_WEI.toString(10));
    expect(fee?.estimated, "the fee is never an estimate").toBe(false);
    expect(fee?.currency).toBe("OKB");
    expect(fee?.payer).toBe(OWNER);
    expect(fee?.payee).toBe(XLAYER_MAINNET.opener);

    const gas = quote.prices.find((price) => price.kind === "gas");
    expect(gas?.estimated, "gas is the estimate line").toBe(true);
    expect(gas?.payee, "gas has no payee; null means not-applicable here (product-p3 A2)").toBeNull();
    expect(BigInt(gas?.amountWei ?? "0")).toBeGreaterThan(0n);
    expect(new Date(quote.expiresAt).getTime(), "the quote expires in the future").toBeGreaterThan(
      NOW.getTime(),
    );
    expect(quote.observedBlock).toBe("74312700");
  });

  it("AC-P3-11: the prepared intent is open(address,uint256) with exactly (processor, tokenId)", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const prepared = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });
    const action = prepared.action;
    expect(action.to.toLowerCase()).toBe(XLAYER_MAINNET.opener.toLowerCase());
    expect(action.value).toBe(FEE_WEI.toString(10));
    expect(action.chainId).toBe(196);
    expect(action.data.slice(0, 10), "selector for open(address,uint256)").toBe("0x0a0e5c9d");

    const decoded = decodeFunctionData({ abi: openerAbi, data: action.data });
    expect(decoded.functionName).toBe("open");
    // viem's decoder returns a checksummed address; the *stored* calldata is
    // lowercase because `provisioning_transactions_calldata_check` requires it.
    expect(decoded.args?.length).toBe(2);
    expect((decoded.args?.[0] as string).toLowerCase()).toBe(PROCESSOR.toLowerCase());
    expect(decoded.args?.[1]).toBe(TOKEN_ID);
    expect(action.data, "the persisted calldata must satisfy the lowercase hex check").toBe(
      action.data.toLowerCase(),
    );
    // The cap is a cap, and the database arithmetic holds (AC-P3-05).
    expect(BigInt(action.maxGasCostWei)).toBeGreaterThanOrEqual(
      BigInt(action.gasLimit) * BigInt(action.gasPriceWei),
    );
    expect(BigInt(action.gasLimit)).toBeGreaterThan(0n);
  });

  it("AC-P3-10: prepare is idempotent — the same intentId and byte-identical calldata", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const first = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });
    const second = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: (await readTask(task.id)).version,
    });
    expect(second.action).toEqual(first.action);
    expect(await countAttempts(stepId)).toHaveLength(1);
  });

  it("AC-P3-16/17: registering a hash is not a completion, and a mismatched hash never confirms", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const prepared = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });
    const afterHash = await recordTransactionHash(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      intentId: prepared.action.intentId,
      txHash: `0x${"a2".repeat(32)}` as Hex,
    });
    const step = afterHash.steps.find((candidate) => candidate.id === stepId);
    expect(step?.state, "a hash moves the step to submitted, never confirmed").toBe("submitted");

    // A hash the chain does not know: still submitted, never failed, never confirmed.
    fake.state.tx = null;
    const unknown = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
      taskId: task.id,
      stepId,
      intentId: prepared.action.intentId,
    });
    expect(unknown.kind).toBe("pending");
    expect((await readTask(task.id)).steps.find((s) => s.id === stepId)?.state).toBe("submitted");

    // A transaction with the wrong value is not our payment.
    const stored = (await countAttempts(stepId))[0]!;
    fake.state.tx = { ...transactionFromAttempt(stored), value: FEE_WEI - 1n };
    fake.state.receipt = successReceipt();
    const mismatch = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
      taskId: task.id,
      stepId,
      intentId: prepared.action.intentId,
    });
    expect(mismatch.kind).toBe("failed");
    const after = (await readTask(task.id)).steps.find((s) => s.id === stepId);
    expect(after?.state).toBe("failed");
    expect(after?.errorCode).toBe("TRANSACTION_MISMATCH");
  });

  it("AC-P3-18: a hash already attributed to another task is not re-attributed", async () => {
    const fake = chain();
    const first = await taskOnce(fake, "hash-owner-key");
    const firstPrepared = await prepareOpenIntent(txDeps(fake), {
      taskId: first.task.id,
      stepId: first.stepId,
      userId,
      expectedVersion: first.task.version,
    });
    const sharedHash = `0x${"a3".repeat(32)}` as Hex;
    await recordTransactionHash(txDeps(fake), {
      taskId: first.task.id,
      stepId: first.stepId,
      userId,
      intentId: firstPrepared.action.intentId,
      txHash: sharedHash,
    });

    const second = await taskOnce(fake, "hash-thief-key");
    const secondPrepared = await prepareOpenIntent(txDeps(fake), {
      taskId: second.task.id,
      stepId: second.stepId,
      userId,
      expectedVersion: second.task.version,
    });
    const error = await captureApiError(
      recordTransactionHash(txDeps(fake), {
        taskId: second.task.id,
        stepId: second.stepId,
        userId,
        intentId: secondPrepared.action.intentId,
        txHash: sharedHash,
      }),
    );
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("TRANSACTION_MISMATCH");
    // The original attribution is untouched.
    expect((await countAttempts(first.stepId))[0]?.txHash).toBe(sharedHash);
    expect((await countAttempts(second.stepId))[0]?.txHash).toBeNull();
  });

  it("AC-P3-13: an expired quote cannot be prepared and creates no intent", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const later = new Date(NOW.getTime() + (DEFAULT_QUOTE_TTL_SECONDS + 1) * 1_000);
    const error = await captureApiError(
      prepareOpenIntent(
        { db, client: fake.client, config: XLAYER_MAINNET, now: () => later },
        { taskId: task.id, stepId, userId, expectedVersion: task.version },
      ),
    );
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("QUOTE_EXPIRED");
    expect(await countAttempts(stepId)).toHaveLength(0);
    expect((await readTask(task.id)).steps[0]?.state).toBe("awaiting_signature");
  });

  it("AC-P3-23: insufficient confirmation depth keeps the step submitted", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const prepared = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });
    await recordTransactionHash(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      intentId: prepared.action.intentId,
      txHash: `0x${"a4".repeat(32)}` as Hex,
    });
    const stored = (await countAttempts(stepId))[0]!;
    fake.state.tx = transactionFromAttempt(stored);
    fake.state.receipt = successReceipt();
    fake.state.opened = true;

    // The receipt is five blocks deep; a policy of 50 is not satisfied.
    const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 50 }), {
      taskId: task.id,
      stepId,
      intentId: prepared.action.intentId,
    });
    expect(outcome.kind).toBe("pending");
    const after = (await readTask(task.id)).steps.find((s) => s.id === stepId);
    expect(after?.state).toBe("submitted");
    expect(after?.state).not.toBe("confirmed");
  });

  it("AC-P3-24: a successful receipt that did not open the circuit is not a delivery", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    const prepared = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });
    await recordTransactionHash(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      intentId: prepared.action.intentId,
      txHash: `0x${"a5".repeat(32)}` as Hex,
    });
    const stored = (await countAttempts(stepId))[0]!;
    fake.state.tx = transactionFromAttempt(stored);
    fake.state.receipt = successReceipt();
    fake.state.opened = false; // the receipt succeeded, the circuit did not open

    const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
      taskId: task.id,
      stepId,
      intentId: prepared.action.intentId,
    });
    expect(outcome.kind).toBe("unverified");
    if (outcome.kind === "unverified") expect(outcome.reason).toBe("DELIVERY_UNVERIFIED");
    expect((await readTask(task.id)).steps.find((s) => s.id === stepId)?.state).toBe("submitted");
  });

  it("AC-P3-26: an unknown send result is never softened into 'you can pay again'", async () => {
    const fake = chain();
    const { task, stepId } = await taskOnce(fake);
    // A broadcast whose hash never came back: the intent exists with no hash.
    const prepared = await prepareOpenIntent(txDeps(fake), {
      taskId: task.id,
      stepId,
      userId,
      expectedVersion: task.version,
    });
    await db
      .update(provisioningTransactions)
      .set({ status: "unresolved" })
      .where(eq(provisioningTransactions.intentId, prepared.action.intentId));

    const outcome = await verifyOpenTransaction(txDeps(fake), {
      taskId: task.id,
      stepId,
      intentId: prepared.action.intentId,
    });
    expect(outcome.kind).toBe("unverified");

    const taskAfter = await readTask(task.id);
    expect(taskAfter.state, "an unknown send result outranks waiting_user").toBe("needs_action");
    expect(taskAfter.state).not.toBe("waiting_user");
    const step = taskAfter.steps.find((s) => s.id === stepId);
    expect(step?.nextAction, "the only offered action is to verify the original transaction").toBe(
      "verify_original_transaction",
    );
    expect(step?.retryable).toBe(false);
    // An unknown send result has its own reason; this is not the policy case.
    expect(step?.errorCode).toBe("TRANSACTION_UNRESOLVED");
  });

  // ── SPEC §7.3 HTTP contract ───────────────────────────────────────────────

  describe("SPEC §7.3 route contract", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = buildApp({ db, env, readClient: () => chain().client } satisfies ApiDeps);
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
    });

    const headers = {
      "x-tapeci-github-login": "circuit-holder",
      "x-tapeci-github-user-id": "9001",
      "content-type": "application/json",
    };

    const TASK = "00000000-0000-4000-8000-000000000000";
    const STEP = "00000000-0000-4000-8000-000000000001";

    /** The §7.3 routes, with the refusal each one owes an unknown task id. */
    const ROUTES = [
      {
        method: "POST" as const,
        url: "/v1/resource-quotes",
        payload: {},
        // No recipient/resource: the body is refused before any chain read.
        code: "INVALID_BODY",
      },
      {
        method: "POST" as const,
        url: "/v1/preparations",
        payload: {},
        code: "INVALID_BODY",
      },
      {
        method: "GET" as const,
        url: `/v1/preparations/${TASK}`,
        payload: undefined,
        code: "TASK_NOT_FOUND",
      },
      {
        method: "POST" as const,
        url: `/v1/preparations/${TASK}/requote`,
        payload: {},
        code: "TASK_NOT_FOUND",
      },
      {
        method: "POST" as const,
        url: `/v1/preparations/${TASK}/accept-quote`,
        payload: {},
        code: "INVALID_BODY",
      },
      {
        method: "POST" as const,
        url: `/v1/preparations/${TASK}/steps/${STEP}/prepare`,
        payload: {},
        code: "INVALID_BODY",
      },
      {
        method: "POST" as const,
        url: `/v1/preparations/${TASK}/steps/${STEP}/transactions`,
        payload: {},
        code: "INVALID_BODY",
      },
      {
        method: "POST" as const,
        url: `/v1/preparations/${TASK}/reconcile`,
        payload: {},
        code: "TASK_NOT_FOUND",
      },
      {
        method: "POST" as const,
        url: `/v1/preparations/${TASK}/cancel`,
        payload: {},
        code: "INVALID_BODY",
      },
    ];

    for (const route of ROUTES) {
      const label = `${route.method} ${route.url.replace(TASK, ":id").replace(STEP, ":stepId")}`;
      it(`§7.3 ${label} is registered and refuses an unknown request with ${route.code}`, async () => {
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers,
          ...(route.payload === undefined ? {} : { payload: route.payload }),
        });
        const body = response.json() as { error?: { code?: string; message?: string } };
        expect(
          body.error?.code,
          `${route.method} ${route.url} answered ${response.statusCode} ${response.body}. ` +
            "code NOT_FOUND means apps/api/src/routes/provisioning.ts is not registered yet (T03-c).",
        ).toBe(route.code);
        // §7.1: a 5xx here would mean an unhandled path, not a refusal.
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.statusCode).toBeLessThan(500);
        expect(body.error?.message, "the envelope carries a message").toBeTruthy();
        expect(response.headers["cache-control"], "§7.1 no-store on /v1").toBe("no-store");
      });
    }

    it("§7.1: every §7.3 route requires a session, so an anonymous call is 401", async () => {
      const anonymous = buildApp({
        db,
        env: { ...env, devAuth: false },
        readClient: () => chain().client,
      } satisfies ApiDeps);
      await anonymous.ready();
      try {
        for (const route of ROUTES) {
          const response = await anonymous.inject({
            method: route.method,
            url: route.url,
            ...(route.payload === undefined ? {} : { payload: route.payload }),
          });
          expect(
            response.statusCode,
            `anonymous ${route.method} ${route.url} must not be reachable`,
          ).toBe(401);
        }
      } finally {
        await anonymous.close();
      }
    });

    it("§7.3/AC-P3-16: registering a hash answers 202 and never 200/201 (a hash is not a completion)", async () => {
      const { task, stepId } = await taskOnce(chain());
      const prepared = await prepareOpenIntent(txDeps(chain()), {
        taskId: task.id,
        stepId,
        userId,
        expectedVersion: task.version,
      });
      const response = await app.inject({
        method: "POST",
        url: `/v1/preparations/${task.id}/steps/${stepId}/transactions`,
        headers,
        payload: {
          intentId: prepared.action.intentId,
          txHash: `0x${"9a".repeat(32)}`,
        },
      });
      expect(response.statusCode, response.body).toBe(202);
      const body = response.json() as { task?: PreparationTask };
      expect(body.task, "§7.3 returns { task }").toBeDefined();
      const step = body.task?.steps.find((candidate) => candidate.id === stepId);
      expect(step?.state, "202 means submitted, never confirmed").toBe("submitted");
      expect(step?.state).not.toBe("confirmed");
    });
  });
});
