/**
 * P3 persistence invariants — SPEC §15.1 names this file
 * ("`tests/p2/provisioning/persistence.test.ts` — 同键并发、不同请求冲突、重连、
 * restart、跨用户读取拒绝"), plus §6 and §9.1.
 *
 * **Numbering asserted here: `product-p3.md`'s zero-padded `AC-P3-01…37`**
 * (issue P3-06 — not `product-p0.md`'s unpadded `AC-P3-1…8`).
 *
 * Why this file is money-critical: `open` is permissionless on chain and a second
 * `open` on an already-opened circuit may charge `FEE()` again (issue P3-03,
 * product-p3 §8 F). Until a fork case records what a second `open` actually does,
 * the single-live-intent partial unique index
 * (`provisioning_transactions_live_intent_key`) may be the **only** thing between
 * a user and a double charge. So it is asserted here as a storage-layer fact —
 * with raw inserts that bypass the service guards entirely — not merely as
 * service behaviour.
 *
 * Every case runs against the real migration `0015` on a throwaway PostgreSQL
 * database (`createTestDatabase()` + `migrateUp`).
 *
 * Run from the repo root (test-p0 §1.4 — the package-dir form is broken):
 *   node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs exec vitest run tests/p2/provisioning/persistence.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Hex } from "viem";
import {
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  migrateUp,
  provisioningQuoteAcceptances,
  provisioningSteps,
  provisioningTasks,
  provisioningTransactions,
  resourceQuotes,
  type Database,
} from "@tapeci/database";
import { XLAYER_MAINNET } from "@tapeci/config";
import type { PreparationTask } from "@tapeci/shared";
import { ApiError } from "../../../apps/api/src/errors.js";
import { buildOpenQuote } from "../../../apps/api/src/provisioning/quotes.js";
import {
  acceptQuote,
  cancelPreparationTask,
  createPreparationTask,
  loadPreparationTask,
  transitionStep,
} from "../../../apps/api/src/provisioning/tasks.js";
import {
  prepareOpenIntent,
  recordTransactionHash,
} from "../../../apps/api/src/provisioning/transactions.js";
import { expectPostgresError } from "../db/helpers.js";
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
  type FakeChain,
} from "./helpers.js";

const available = await databaseAvailable();
const unavailableLabel =
  "P3 persistence [SKIPPED: PostgreSQL is unreachable; the suite needs the shared " +
  "PG service on 127.0.0.1:55432 (TAPECI_TEST_DATABASE_URL)]";

const NOW = new Date("2026-10-27T08:00:00.000Z");
const RESOURCE = { chainId: 196 as const, processor: PROCESSOR, tokenId: TOKEN_ID.toString(10) };
const CHAIN_ID = 196;

async function captureApiError(run: Promise<unknown>): Promise<ApiError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused with an ApiError");
}

describe.skipIf(!available)(
  available ? "P3 §6 persistence invariants (AC-P3-12/28, P3-03)" : unavailableLabel,
  () => {
    let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
    let handle: ReturnType<typeof createDatabase>;
    let db: Database;
    let userId: string;
    let otherUserId: string;
    let fake: FakeChain;

    beforeAll(async () => {
      testDatabase = await createTestDatabase();
      await migrateUp(testDatabase.url);
      handle = createDatabase(testDatabase.url);
      db = handle.db;
      userId = await seedUser(db, 9_101, "persistence-holder");
      otherUserId = await seedUser(db, 9_102, "persistence-other");
      await seedWallet(db, userId, OWNER);
      await seedWallet(db, otherUserId, OTHER_WALLET);
      // The same address may be a verified wallet of two users (§10): identity is
      // the session, ownership of the circuit is a separate chain fact.
      await seedWallet(db, otherUserId, OWNER);
      fake = createFakeChain();
    }, 90_000);

    afterAll(async () => {
      await handle?.pool.end();
      await testDatabase?.drop();
    }, 30_000);

    // ── fixtures ─────────────────────────────────────────────────────────────

    async function quoteOnce() {
      return buildOpenQuote(
        { db, client: fake.client, config: XLAYER_MAINNET, now: fixedClock(NOW) },
        { userId, recipient: OWNER, resource: RESOURCE },
      );
    }

    async function taskOnce(key: string) {
      const quote = await quoteOnce();
      const created = await createPreparationTask(
        { db, now: fixedClock(NOW) },
        { userId, quoteId: quote.id, idempotencyKey: key },
      );
      return { quote, task: created.task, created: created.created };
    }

    function txDeps() {
      return { db, client: fake.client, config: XLAYER_MAINNET, now: fixedClock(NOW) };
    }

    async function readTask(taskId: string): Promise<PreparationTask> {
      return loadPreparationTask({ db }, { taskId, userId });
    }

    /** A minimal valid attempt row: the shape `prepareOpenIntent` would write. */
    function attemptValues(input: {
      readonly taskId: string;
      readonly stepId: string;
      readonly quoteId: string;
      readonly intentId?: string;
      readonly status?: "prepared" | "submitted" | "unresolved" | "failed" | "confirmed";
      readonly txHash?: Hex | null;
    }) {
      return {
        taskId: input.taskId,
        stepId: input.stepId,
        quoteId: input.quoteId,
        intentId: input.intentId ?? randomUUID(),
        chainId: CHAIN_ID,
        sender: OWNER,
        target: XLAYER_MAINNET.opener as Hex,
        valueWei: FEE_WEI.toString(10),
        calldata: "0x0a0e5c9d",
        gasLimit: "200000",
        gasPriceWei: GAS_PRICE_WEI.toString(10),
        maxGasCostWei: (200_000n * GAS_PRICE_WEI).toString(10),
        expectedDigest: `0x${"11".repeat(32)}`,
        status: input.status ?? "prepared",
        txHash: input.txHash ?? null,
        ...(input.status === "confirmed"
          ? {
              blockNumber: "74312695",
              blockHash: `0x${"b1".repeat(32)}`,
              gasUsed: "169734",
            }
          : {}),
      };
    }

    // ── P3-03: the single-live-intent index is what stops a double charge ────

    it("P3-03/AC-P3-12: the live-intent partial unique index rejects a second unresolved attempt at the storage layer", async () => {
      const { task } = await taskOnce("live-intent-key");
      const stepIdOfTask = task.steps[0]?.id ?? "";

      // Insert the first live attempt directly: this is the row a real `prepare`
      // writes, and it is live because its status is in (prepared|submitted|unresolved).
      await db.insert(provisioningTransactions).values(
        attemptValues({ taskId: task.id, stepId: stepIdOfTask, quoteId: task.currentQuoteId }),
      );

      // A second live row for the same step must be impossible regardless of the
      // service guards. SQLSTATE 23505 is the unique violation.
      await expectPostgresError(
        db.insert(provisioningTransactions).values(
          attemptValues({ taskId: task.id, stepId: stepIdOfTask, quoteId: task.currentQuoteId }),
        ),
        "23505",
      );

      const rows = await db
        .select()
        .from(provisioningTransactions)
        .where(eq(provisioningTransactions.stepId, stepIdOfTask));
      expect(rows, "exactly one live intent may exist for a step").toHaveLength(1);
      expect(["prepared", "submitted", "unresolved"]).toContain(rows[0]?.status);

      // The index is partial on purpose: a *resolved* attempt is outside its
      // predicate, which is what makes an explicit retry possible (§9.1 row 10).
      // `provisioning_transactions_broadcast_hash_check` requires a hash on
      // anything that is not prepared/unresolved, so resolving the attempt means
      // recording the hash it was broadcast with — which is the real sequence.
      await db
        .update(provisioningTransactions)
        .set({ status: "failed", txHash: `0x${"3f".repeat(32)}` })
        .where(eq(provisioningTransactions.id, rows[0]!.id));
      await db.insert(provisioningTransactions).values(
        attemptValues({ taskId: task.id, stepId: stepIdOfTask, quoteId: task.currentQuoteId }),
      );
      const afterRetry = await db
        .select()
        .from(provisioningTransactions)
        .where(eq(provisioningTransactions.stepId, stepIdOfTask));
      expect(afterRetry, "a resolved attempt frees the slot for one retry").toHaveLength(2);
    });

    it("AC-P3-12: the intent-root index makes an intent id globally unique across tasks", async () => {
      const first = await taskOnce("root-intent-a");
      const second = await taskOnce("root-intent-b");
      const sharedIntentId = randomUUID();
      await db.insert(provisioningTransactions).values(
        attemptValues({
          taskId: first.task.id,
          stepId: first.task.steps[0]!.id,
          quoteId: first.task.currentQuoteId,
          intentId: sharedIntentId,
        }),
      );
      await expectPostgresError(
        db.insert(provisioningTransactions).values(
          attemptValues({
            taskId: second.task.id,
            stepId: second.task.steps[0]!.id,
            quoteId: second.task.currentQuoteId,
            intentId: sharedIntentId,
          }),
        ),
        "23505",
      );
    });

    it("AC-P3-18: a transaction hash cannot be attributed to two tasks", async () => {
      const first = await taskOnce("hash-a");
      const second = await taskOnce("hash-b");
      const sharedHash = `0x${"5a".repeat(32)}` as Hex;
      await db.insert(provisioningTransactions).values(
        attemptValues({
          taskId: first.task.id,
          stepId: first.task.steps[0]!.id,
          quoteId: first.task.currentQuoteId,
          status: "submitted",
          txHash: sharedHash,
        }),
      );
      await expectPostgresError(
        db.insert(provisioningTransactions).values(
          attemptValues({
            taskId: second.task.id,
            stepId: second.task.steps[0]!.id,
            quoteId: second.task.currentQuoteId,
            status: "submitted",
            txHash: sharedHash,
          }),
        ),
        "23505",
      );
    });

    it("AC-P3-05: the gas cap arithmetic is enforced by the table, not only by the service", async () => {
      const { task } = await taskOnce("gas-check");
      const stepId = task.steps[0]!.id;
      // maxGasCostWei < gasLimit * gasPriceWei must be rejected.
      await expectPostgresError(
        db.insert(provisioningTransactions).values({
          ...attemptValues({ taskId: task.id, stepId, quoteId: task.currentQuoteId }),
          maxGasCostWei: "1",
        }),
        "23514",
      );
      // gasLimit = 0 must be rejected.
      await expectPostgresError(
        db.insert(provisioningTransactions).values({
          ...attemptValues({ taskId: task.id, stepId, quoteId: task.currentQuoteId }),
          gasLimit: "0",
          maxGasCostWei: "0",
        }),
        "23514",
      );
    });

    // ── §15.1: same-key concurrency and different-request conflict ───────────

    it("§6: the same Idempotency-Key replays the same task, and a different request under it is a conflict", async () => {
      const quote = await quoteOnce();
      const key = `idem-${quote.id}`;
      const call = () =>
        createPreparationTask(
          { db, now: fixedClock(NOW) },
          { userId, quoteId: quote.id, idempotencyKey: key },
        );

      // 同键并发: two concurrent first requests must converge on one task.
      const results = await Promise.all([call(), call()]);
      expect(results[0]?.task.id).toBe(results[1]?.task.id);
      expect(results.filter((result) => result.created)).toHaveLength(1);

      const rows = await db
        .select()
        .from(provisioningTasks)
        .where(eq(provisioningTasks.idempotencyKey, key));
      expect(rows, "one key yields one task").toHaveLength(1);

      // 不同请求冲突: the same key with a different quote is 409, never a
      // silently different purchase.
      const otherQuote = await quoteOnce();
      const conflict = await captureApiError(
        createPreparationTask(
          { db, now: fixedClock(NOW) },
          { userId, quoteId: otherQuote.id, idempotencyKey: key },
        ),
      );
      expect(conflict.statusCode).toBe(409);
      expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(await db.select().from(provisioningTasks).where(eq(provisioningTasks.idempotencyKey, key)))
        .toHaveLength(1);
    });

    it("§6: the Idempotency-Key is scoped per user, so two users may use the same string", async () => {
      const quoteA = await buildOpenQuote(
        { db, client: fake.client, config: XLAYER_MAINNET, now: fixedClock(NOW) },
        { userId, recipient: OWNER, resource: RESOURCE },
      );
      const quoteB = await buildOpenQuote(
        { db, client: fake.client, config: XLAYER_MAINNET, now: fixedClock(NOW) },
        { userId: otherUserId, recipient: OWNER, resource: RESOURCE },
      );
      const sharedKey = "shared-key-across-users";
      const a = await createPreparationTask(
        { db, now: fixedClock(NOW) },
        { userId, quoteId: quoteA.id, idempotencyKey: sharedKey },
      );
      const b = await createPreparationTask(
        { db, now: fixedClock(NOW) },
        { userId: otherUserId, quoteId: quoteB.id, idempotencyKey: sharedKey },
      );
      expect(a.task.id).not.toBe(b.task.id);
      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
    });

    // ── CAS on `version` ─────────────────────────────────────────────────────

    it("§6/AC-P3-14: the task version is a CAS token — a stale expectedVersion is refused", async () => {
      const { task } = await taskOnce("cas-task");
      const staleVersion = task.version;

      // One successful mutation moves the version.
      const advanced = await acceptQuote(
        { db, now: fixedClock(NOW) },
        { taskId: task.id, userId, quoteId: task.currentQuoteId, expectedVersion: staleVersion },
      );
      expect(advanced.version).toBeGreaterThan(staleVersion);

      // The same expectedVersion may not be replayed.
      const conflict = await captureApiError(
        acceptQuote(
          { db, now: fixedClock(NOW) },
          { taskId: task.id, userId, quoteId: task.currentQuoteId, expectedVersion: staleVersion },
        ),
      );
      expect(conflict.statusCode).toBe(409);
      expect(conflict.code).toBe("STEP_VERSION_CONFLICT");

      const [row] = await db.select().from(provisioningTasks).where(eq(provisioningTasks.id, task.id));
      expect(row?.version, "the version advanced exactly once").toBe(advanced.version);
    });

    it("§6: the step version is a per-row CAS token, so a concurrent transition cannot double-apply", async () => {
      const { task } = await taskOnce("cas-step");
      const stepId = task.steps[0]!.id;

      // Two transitions read the same task version; only one may win.
      const race = await Promise.allSettled([
        transitionStep(
          { db, now: fixedClock(NOW) },
          {
            taskId: task.id,
            stepId,
            expectedVersion: task.version,
            to: "skipped",
            resolvedResource: RESOURCE,
          },
        ),
        transitionStep(
          { db, now: fixedClock(NOW) },
          {
            taskId: task.id,
            stepId,
            expectedVersion: task.version,
            to: "skipped",
            resolvedResource: RESOURCE,
          },
        ),
      ]);
      expect(race.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      const rejection = race.find((entry) => entry.status === "rejected");
      expect((rejection as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
      expect(((rejection as PromiseRejectedResult).reason as ApiError).code).toBe(
        "STEP_VERSION_CONFLICT",
      );

      const [step] = await db.select().from(provisioningSteps).where(eq(provisioningSteps.id, stepId));
      expect(step?.state).toBe("skipped");
      expect(step?.version, "the step version advanced exactly once").toBe(1);
    });

    it("§7.3: a canceled task refuses a prepare, so no paid intent can be minted after cancellation", async () => {
      const { task } = await taskOnce("cancel-task");
      const stepId = task.steps[0]!.id;
      const canceled = await cancelPreparationTask(
        { db, now: fixedClock(NOW) },
        { taskId: task.id, userId, expectedVersion: task.version },
      );
      expect(canceled.state).toBe("canceled");
      expect(canceled.steps[0]?.state, "an unstarted step is skipped on cancel").toBe("skipped");

      // The money-relevant guard: cancellation must not leave a path to a signature.
      const prepareRefusal = await captureApiError(
        prepareOpenIntent(txDeps(), {
          taskId: task.id,
          stepId,
          userId,
          expectedVersion: canceled.version,
        }),
      );
      expect(prepareRefusal.statusCode).toBe(409);
      expect(["TASK_CANCELED", "INVALID_STEP_TRANSITION"]).toContain(prepareRefusal.code);
      expect(
        await db
          .select()
          .from(provisioningTransactions)
          .where(eq(provisioningTransactions.stepId, stepId)),
        "a canceled task mints no intent",
      ).toHaveLength(0);
    });

    // ── §15.1: cross-user read refusal ───────────────────────────────────────

    it("§7.1/§10: another user cannot read the task, its quote, or its acceptances", async () => {
      const { quote, task } = await taskOnce("cross-user-task");

      // A task that belongs to somebody else is 404, not 403: the id is private.
      const taskRefusal = await captureApiError(
        loadPreparationTask({ db }, { taskId: task.id, userId: otherUserId }),
      );
      expect(taskRefusal.statusCode).toBe(404);
      expect(taskRefusal.code).toBe("TASK_NOT_FOUND");

      // Creating a task from somebody else's quote is the same 404.
      const quoteRefusal = await captureApiError(
        createPreparationTask(
          { db, now: fixedClock(NOW) },
          { userId: otherUserId, quoteId: quote.id, idempotencyKey: "cross-user-quote" },
        ),
      );
      expect(quoteRefusal.statusCode).toBe(404);
      expect(quoteRefusal.code).toBe("QUOTE_NOT_FOUND");

      // Mutating somebody else's task: `acceptQuote` resolves the quote before the
      // task, so a foreign quote is refused as QUOTE_NOT_FOUND. Either way the
      // answer is 404 and the id reveals nothing (§7.1).
      const mutateRefusal = await captureApiError(
        acceptQuote(
          { db, now: fixedClock(NOW) },
          {
            taskId: task.id,
            userId: otherUserId,
            quoteId: task.currentQuoteId,
            expectedVersion: task.version,
          },
        ),
      );
      expect(mutateRefusal.statusCode).toBe(404);
      expect(mutateRefusal.code).toBe("QUOTE_NOT_FOUND");

      // A mutation that names only the task is refused by the task guard.
      const cancelRefusal = await captureApiError(
        cancelPreparationTask(
          { db, now: fixedClock(NOW) },
          { taskId: task.id, userId: otherUserId, expectedVersion: task.version },
        ),
      );
      expect(cancelRefusal.statusCode).toBe(404);
      expect(cancelRefusal.code).toBe("TASK_NOT_FOUND");

      // Reading the step rows directly must also stay impossible through the API:
      // the DTO reader is the only path and it is owner-scoped.
      const [row] = await db.select().from(provisioningTasks).where(eq(provisioningTasks.id, task.id));
      expect(row?.version, "a refused cross-user mutation must not bump the version").toBe(
        task.version,
      );
      expect(row?.state).not.toBe("canceled");
    });

    // ── §15.1: reconnect and restart ─────────────────────────────────────────

    it("§3.3/AC-P3-28: a reconnect sees the same rows and the unfinished-task index finds them", async () => {
      const { task } = await taskOnce("reconnect-task");
      const prepared = await prepareOpenIntent(txDeps(), {
        taskId: task.id,
        stepId: task.steps[0]!.id,
        userId,
        expectedVersion: task.version,
      });
      await recordTransactionHash(txDeps(), {
        taskId: task.id,
        stepId: task.steps[0]!.id,
        userId,
        intentId: prepared.action.intentId,
        txHash: `0x${"7c".repeat(32)}` as Hex,
      });
      const before = await readTask(task.id);

      // 重连: a brand-new pool on the same database, as a restarted process would open.
      const reconnected = createDatabase(testDatabase.url);
      try {
        const after = await loadPreparationTask({ db: reconnected.db }, { taskId: task.id, userId });
        expect(after).toEqual(before);
        expect(after.state).toBe("running");
        expect(after.steps[0]?.state).toBe("submitted");
        expect(after.steps[0]?.intentId).toBe(prepared.action.intentId);

        // The worker's recovery query (§3.3) must find it.
        const unfinished = await reconnected.db
          .select({ id: provisioningTasks.id })
          .from(provisioningTasks)
          .where(
            sql`${provisioningTasks.state} not in ('completed','canceled')
              and ${provisioningTasks.id} = ${task.id}`,
          );
        expect(unfinished, "an unfinished task is discoverable after a reconnect").toHaveLength(1);
      } finally {
        await reconnected.pool.end();
      }
    });

    it("AC-P3-28: a restart with a submitted attempt keeps one intent and refuses a second send", async () => {
      const { task } = await taskOnce("restart-task");
      const stepId = task.steps[0]!.id;
      const prepared = await prepareOpenIntent(txDeps(), {
        taskId: task.id,
        stepId,
        userId,
        expectedVersion: task.version,
      });
      await recordTransactionHash(txDeps(), {
        taskId: task.id,
        stepId,
        userId,
        intentId: prepared.action.intentId,
        txHash: `0x${"7d".repeat(32)}` as Hex,
      });

      // Restart: a fresh pool, a fresh fake chain that knows nothing about the tx.
      // The attempt's outcome is therefore unknown — exactly the restart case.
      const restarted = createDatabase(testDatabase.url);
      const restartedChain = createFakeChain();
      try {
        const taskAfter = await loadPreparationTask(
          { db: restarted.db },
          { taskId: task.id, userId },
        );
        const stepAfter = taskAfter.steps.find((step) => step.id === stepId);
        expect(stepAfter?.state, "a restart never resolves a pending attempt").toBe("submitted");
        expect(stepAfter?.nextAction).toBe("wait_for_confirmation");
        expect(taskAfter.state).toBe("running");

        // The one thing a restart must never do: mint a second paid attempt.
        const refusal = await captureApiError(
          prepareOpenIntent(
            {
              db: restarted.db,
              client: restartedChain.client,
              config: XLAYER_MAINNET,
              now: fixedClock(NOW),
            },
            { taskId: task.id, stepId, userId, expectedVersion: taskAfter.version },
          ),
        );
        expect(refusal.statusCode).toBe(409);
        expect(refusal.code).toBe("TRANSACTION_UNRESOLVED");

        const attempts = await restarted.db
          .select()
          .from(provisioningTransactions)
          .where(eq(provisioningTransactions.stepId, stepId));
        expect(attempts, "exactly one intent survives a restart").toHaveLength(1);
        expect(attempts[0]?.txHash).toBe(`0x${"7d".repeat(32)}`);

        // The task cannot be canceled away from under a live attempt either.
        const cancelRefusal = await captureApiError(
          cancelPreparationTask(
            { db: restarted.db, now: fixedClock(NOW) },
            { taskId: task.id, userId, expectedVersion: taskAfter.version },
          ),
        );
        expect(cancelRefusal.statusCode).toBe(409);
        expect(cancelRefusal.code).toBe("TASK_UNRESOLVED");
      } finally {
        await restarted.pool.end();
      }
    });

    // ── the tables the P3 journey depends on ────────────────────────────────

    it("§6: the quote is immutable — no update path exists, and every acceptance is append-only", async () => {
      const { quote, task } = await taskOnce("immutable-quote");
      const [quoteRow] = await db.select().from(resourceQuotes).where(eq(resourceQuotes.id, quote.id));
      expect(quoteRow?.expiresAt.getTime()).toBe(new Date(quote.expiresAt).getTime());
      expect(quoteRow?.observedBlock).toBe(quote.observedBlock);

      // The initial acceptance is written with the task (§7.3).
      const acceptances = await db
        .select()
        .from(provisioningQuoteAcceptances)
        .where(eq(provisioningQuoteAcceptances.taskId, task.id));
      expect(acceptances).toHaveLength(1);
      expect(acceptances[0]?.quoteId).toBe(quote.id);
      expect(acceptances[0]?.acceptedBy).toBe(userId);

      // Re-accepting the same quote is idempotent (the PK is (task_id, quote_id)).
      await acceptQuote(
        { db, now: fixedClock(NOW) },
        {
          taskId: task.id,
          userId,
          quoteId: quote.id,
          expectedVersion: task.version,
        },
      );
      const again = await db
        .select()
        .from(provisioningQuoteAcceptances)
        .where(eq(provisioningQuoteAcceptances.taskId, task.id));
      expect(again, "the acceptance log does not grow for the same quote").toHaveLength(1);
    });

    it("§7.2: a quote carries exactly one of offerId / resource, and the table enforces it", async () => {
      const { quote } = await taskOnce("offer-xor-resource");
      const [row] = await db.select().from(resourceQuotes).where(eq(resourceQuotes.id, quote.id));
      expect(row?.offerId).toBeNull();
      expect(row?.resourceSnapshot).not.toBeNull();

      // Both set at once: `resource_quotes_offer_or_resource_check` is `<>` on the
      // two null-ness flags, so an acquisition line and a resource cannot coexist
      // (§7.2 "acquisition 与选定已有 resource 互斥；不能两个都收费").
      await expectPostgresError(
        db.insert(resourceQuotes).values({
          userId,
          recipientAddress: OWNER,
          chainId: CHAIN_ID,
          sourceId: "builtin:open",
          offerId: "offer-1",
          resourceSnapshot: RESOURCE,
          options: {},
          stepsSnapshot: [{ id: randomUUID(), ordinal: 0, kind: "open" }],
          pricesSnapshot: [],
          observedBlock: "1",
          expiresAt: new Date(NOW.getTime() + 60_000),
          termsVersion: "open.v1",
          createdAt: NOW,
        }),
        "23514",
      );

      // Neither set: nothing is priced, so there is nothing to pay for.
      await expectPostgresError(
        db.insert(resourceQuotes).values({
          userId,
          recipientAddress: OWNER,
          chainId: CHAIN_ID,
          sourceId: "builtin:open",
          offerId: null,
          resourceSnapshot: null,
          options: {},
          stepsSnapshot: [{ id: randomUUID(), ordinal: 0, kind: "open" }],
          pricesSnapshot: [],
          observedBlock: "1",
          expiresAt: new Date(NOW.getTime() + 60_000),
          termsVersion: "open.v1",
          createdAt: NOW,
        }),
        "23514",
      );
    });

    it("§9.1/P3-03: the deployed live-intent index predicate matches the service's live status set", async () => {
      // The protection against a double charge is split across two files: the
      // partial index in migration 0015 and `LIVE_INTENT_STATUSES` in tasks.ts.
      // If they drift, one of them silently protects a different set, so the
      // deployed definition is read back from PostgreSQL rather than assumed.
      const [index] = await db.execute<{ indexdef: string }>(
        sql`select indexdef from pg_indexes
            where schemaname = 'public'
              and tablename = 'provisioning_transactions'
              and indexname = 'provisioning_transactions_live_intent_key'`,
      ).then((result) => result.rows);
      expect(index, "the live-intent index must exist").toBeDefined();
      const definition = index?.indexdef ?? "";
      expect(definition).toMatch(/UNIQUE INDEX/i);
      for (const status of ["prepared", "submitted", "unresolved"]) {
        expect(definition, `the index predicate must cover ${status}`).toContain(`'${status}'`);
      }
      expect(definition, "a resolved status must stay outside the predicate").not.toContain(
        "'failed'",
      );
      expect(definition).not.toContain("'confirmed'");
    });
  },
);
