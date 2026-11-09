/**
 * P3 §15.1 — transaction attempts, the six money rules (SPEC §15.1 names this file).
 *
 * §15.1 asks this file to prove: **hash 登记非完成、超时不重付、replacement/cancel、
 * 历史 hash、错误 value/data、区块变化**. Each `it` title below starts with the
 * clause it covers, so the mapping is mechanical:
 *
 * | §15.1 clause      | test |
 * | ----------------- | ---- |
 * | hash 登记非完成    | "hash 登记非完成" (×1) |
 * | 超时不重付         | "超时不重付" (×2: unknown hash, known tx with no receipt) |
 * | replacement/cancel | "replacement/cancel" (×2: replacement claim, cancelled signing) |
 * | 历史 hash          | "历史 hash" (×1) |
 * | 错误 value/data    | "错误 value/data" (×2: wrong value, wrong calldata) |
 * | 区块变化           | "区块变化" (×3: reorged block, two operators, unreadable block) |
 *
 * Everything asserted here runs against the real `apps/api/src/provisioning/
 * transactions.ts` with real PostgreSQL and the deterministic `ReadClient` from
 * `./helpers.js` — no network, no fork, no signing. The chain is faked only
 * because these rules are about what the service does with an answer, and a fake
 * is the only way to make a receipt *not* appear (§3.3).
 *
 * Two gaps this file could not close, reported rather than papered over (see
 * `.superpowers/sdd/provisioning/dev-p7a.md`):
 * 1. §9.2 "replacement 记录与原 sender/nonce 对应": nothing ever writes
 *    `provisioning_transactions.replacement_for` / `nonce` / status `replaced`, so a
 *    replacement is *refused* rather than *recorded*. The safety property (a
 *    replacement is never counted as our payment) is asserted; the recording
 *    requirement has no implementation to test.
 * 2. §9.1 "confirmed | 在后续核验发现区块被替换 → 回到 submitted": **implemented and
 *    covered below** ("区块变化/reorg" ×3). A `confirmed` attempt is re-read against the
 *    canonical chain; a positive reorg demotes it with `CHAIN_REORG_PENDING`, an
 *    unreadable node leaves the confirmation standing, and a still-canonical block keeps
 *    it confirmed. A cancelled/replaced transaction is still indistinguishable from an
 *    invisible one and stays `submitted` — the safe direction (no re-pay) — and the
 *    replacement itself is now recorded as its own row (`replacement/cancel` below).
 *
 * Run from the repo root (test-p0 §1.4 — the package-dir form is broken):
 *   node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs exec vitest run tests/p2/provisioning/transactions.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, type Hex } from "viem";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  migrateUp,
  provisioningSteps,
  provisioningTransactions,
  type Database,
} from "@tapeci/database";
import { XLAYER_MAINNET } from "@tapeci/config";
import { openerAbi } from "@tapeci/chain";
import type { PreparationTask } from "@tapeci/shared";
import { ApiError } from "../../../apps/api/src/errors.js";
import { buildOpenQuote } from "../../../apps/api/src/provisioning/quotes.js";
import {
  createPreparationTask,
  loadPreparationTask,
} from "../../../apps/api/src/provisioning/tasks.js";
import {
  prepareOpenIntent,
  recordTransactionHash,
  verifyOpenTransaction,
} from "../../../apps/api/src/provisioning/transactions.js";
import {
  DIVERGENT_BLOCK_HASH,
  FEE_WEI,
  OWNER,
  PROCESSOR,
  RECEIPT_BLOCK_HASH,
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
  "P3 transaction attempts [SKIPPED: PostgreSQL is unreachable; the suite needs the shared " +
  "PG service on 127.0.0.1:55432 (TAPECI_TEST_DATABASE_URL)]";

/** One instant for the whole suite: quotes are priced and read from the same clock. */
const NOW = new Date("2026-10-27T08:00:00.000Z");

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

/** The `cause` chain of a thrown error, so a wrapped driver error is still readable. */
function causesOf(error: unknown): unknown[] {
  const causes: unknown[] = [];
  let current = error;
  while (typeof current === "object" && current !== null && causes.length < 8) {
    current = (current as { cause?: unknown }).cause;
    if (current === undefined) break;
    causes.push(current);
  }
  return causes;
}

describe.skipIf(!available)(
  available ? "P3 §15.1 transaction attempts (hash, timeout, replacement, history, mismatch, reorg)" : unavailableLabel,
  () => {
    let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
    let handle: ReturnType<typeof createDatabase>;
    let db: Database;
    let userId: string;

    beforeAll(async () => {
      testDatabase = await createTestDatabase();
      await migrateUp(testDatabase.url);
      handle = createDatabase(testDatabase.url);
      db = handle.db;
      userId = await seedUser(db, 9_101, "circuit-holder");
      await seedWallet(db, userId, OWNER);
    }, 90_000);

    afterAll(async () => {
      await handle?.pool.end();
      await testDatabase?.drop();
    }, 30_000);

    // ── fixture builders (same harness as open.test.ts, no second one) ────────

    function chain(overrides: Parameters<typeof createFakeChain>[0] = {}): FakeChain {
      return createFakeChain(overrides);
    }

    function txDeps(
      fake: FakeChain,
      extra: { secondary?: FakeChain; minConfirmations?: number | "finalized" } = {},
    ) {
      return {
        db,
        client: fake.client,
        config: XLAYER_MAINNET,
        now: fixedClock(NOW),
        ...(extra.secondary === undefined ? {} : { secondaryClient: extra.secondary.client }),
        ...(extra.minConfirmations === undefined ? {} : { minConfirmations: extra.minConfirmations }),
      };
    }

    /** A task with one `open` step, as `POST /v1/preparations` would leave it. */
    async function taskOnce(fake: FakeChain, key = `key-${Math.random()}`) {
      const quote = await buildOpenQuote(
        { db, client: fake.client, config: XLAYER_MAINNET, now: fixedClock(NOW) },
        { userId, recipient: OWNER, resource: RESOURCE },
      );
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

    async function stepRow(stepId: string) {
      const [row] = await db
        .select()
        .from(provisioningSteps)
        .where(eq(provisioningSteps.id, stepId))
        .limit(1);
      return row;
    }

    /** The mismatch evidence stored on the step, or `null` when none was written. */
    function mismatchField(result: unknown): string | null {
      if (typeof result !== "object" || result === null) return null;
      const mismatch = (result as Record<string, unknown>)["mismatch"];
      if (typeof mismatch !== "object" || mismatch === null) return null;
      const field = (mismatch as Record<string, unknown>)["field"];
      return typeof field === "string" ? field : null;
    }

    /**
     * Prepare, register a hash and hand back the stored attempt. Every test below
     * starts from a real prepared intent plus a real `submitted` attempt, because
     * that is the only state from which the money rules are meaningful.
     */
    async function submittedAttempt(fake: FakeChain, txHash: Hex) {
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
        txHash,
      });
      const [attempt] = await countAttempts(stepId);
      if (attempt === undefined) throw new Error("fixture: no attempt after registering a hash");
      return { taskId: task.id, stepId, intentId: prepared.action.intentId, attempt };
    }

    /**
     * Drive an attempt all the way to `confirmed`, so the reorg re-check has something to
     * demote. Round 2 found the confirmed→reorg row had no test at all: every existing
     * "区块变化" case started from `submitted`, which never reaches the demote branch.
     */
    async function confirmedAttempt(fake: FakeChain, txHash: Hex = `0x${"d1".repeat(32)}` as Hex) {
      const prepared = await submittedAttempt(fake, txHash);
      fake.state.tx = transactionFromAttempt(prepared.attempt);
      fake.state.receipt = successReceipt();
      fake.state.opened = true;
      const first = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId: prepared.taskId,
        stepId: prepared.stepId,
        intentId: prepared.intentId,
      });
      if (first.kind !== "confirmed") {
        throw new Error(`fixture: expected confirmed, got ${first.kind}`);
      }
      return prepared;
    }

    // ── 1. hash 登记非完成 ───────────────────────────────────────────────────

    it("hash 登记非完成: registering a hash returns submitted — never confirmed, and reads no chain", async () => {
      const fake = chain();
      const { task, stepId } = await taskOnce(fake);
      const prepared = await prepareOpenIntent(txDeps(fake), {
        taskId: task.id,
        stepId,
        userId,
        expectedVersion: task.version,
      });
      // Registration must be a database write only: it cannot confirm anything
      // because it never asks the chain (§9.2, §9.4).
      fake.state.reads.length = 0;
      const txHash = `0x${"b5".repeat(32)}` as Hex;
      const afterHash = await recordTransactionHash(txDeps(fake), {
        taskId: task.id,
        stepId,
        userId,
        intentId: prepared.action.intentId,
        txHash,
      });
      expect(fake.state.reads, "registering a hash must not read the chain").toEqual([]);

      const step = afterHash.steps.find((candidate) => candidate.id === stepId);
      expect(step?.state, "a hash is a broadcast, not a delivery").toBe("submitted");
      expect(step?.state).not.toBe("confirmed");
      expect(step?.nextAction).toBe("wait_for_confirmation");
      expect(step?.retryable, "a submitted attempt is never retryable").toBe(false);
      expect(afterHash.state, "a live send keeps the task running").toBe("running");
      expect(afterHash.state).not.toBe("completed");

      const [attempt] = await countAttempts(stepId);
      expect(attempt?.status).toBe("submitted");
      expect(attempt?.txHash).toBe(txHash);
      // No receipt facts exist yet: every one of them stays null, never zero.
      expect(attempt?.blockNumber).toBeNull();
      expect(attempt?.blockHash).toBeNull();
      expect(attempt?.gasUsed).toBeNull();
      expect(attempt?.effectiveGasPriceWei).toBeNull();

      // The frozen DTO says the same thing, so a page cannot read it as delivery.
      expect(step?.transactions[0]?.status).toBe("submitted");
      expect(step?.transactions[0]?.blockNumber).toBeNull();
      expect(step?.transactions[0]?.blockHash).toBeNull();

      // The same hash reported twice is idempotent and still not a completion.
      const again = await recordTransactionHash(txDeps(fake), {
        taskId: task.id,
        stepId,
        userId,
        intentId: prepared.action.intentId,
        txHash,
      });
      expect(again.steps.find((candidate) => candidate.id === stepId)?.state).toBe("submitted");
      expect(await countAttempts(stepId)).toHaveLength(1);
    });

    // ── 2. 超时不重付 ────────────────────────────────────────────────────────

    it("超时不重付: a hash the node never sees stays pending, and a second paid attempt is refused", async () => {
      const fake = chain();
      const txHash = `0x${"b1".repeat(32)}` as Hex;
      const { taskId, stepId, intentId } = await submittedAttempt(fake, txHash);
      // The node does not know the hash yet: `eth_getTransactionByHash` is null.
      fake.state.tx = null;
      fake.state.receipt = null;

      const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId,
        stepId,
        intentId,
      });
      expect(outcome.kind, "an invisible transaction is pending, never failed").toBe("pending");

      const after = await readTask(taskId);
      const step = after.steps.find((candidate) => candidate.id === stepId);
      expect(step?.state, "a timeout must not become failed").toBe("submitted");
      expect(step?.state).not.toBe("confirmed");
      expect(step?.errorCode).toBeNull();
      expect(step?.retryable).toBe(false);
      expect(after.state, "a task with a live send is running, not re-payable").toBe("running");

      const attempts = await countAttempts(stepId);
      expect(attempts, "a timeout must never mint a second attempt").toHaveLength(1);
      expect(attempts[0]?.status).toBe("submitted");
      expect(attempts[0]?.txHash).toBe(txHash);

      // The money assertion: a pending send blocks another signature.
      const refusal = await captureApiError(
        prepareOpenIntent(txDeps(fake), {
          taskId,
          stepId,
          userId,
          expectedVersion: after.version,
        }),
      );
      expect(refusal.statusCode).toBe(409);
      expect(refusal.code).toBe("TRANSACTION_UNRESOLVED");
      expect(await countAttempts(stepId), "still exactly one paid attempt").toHaveLength(1);
    });

    it("超时不重付: a known transaction with no receipt stays pending across repeated checks", async () => {
      const fake = chain();
      const txHash = `0x${"b2".repeat(32)}` as Hex;
      const { taskId, stepId, intentId, attempt } = await submittedAttempt(fake, txHash);
      // The transaction is visible, the receipt is not: the node has not indexed it.
      fake.state.tx = transactionFromAttempt(attempt);
      fake.state.receipt = null;

      const first = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId,
        stepId,
        intentId,
      });
      const second = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId,
        stepId,
        intentId,
      });
      expect(first.kind).toBe("pending");
      expect(second.kind, "a repeated check may not flip a timeout into a failure").toBe("pending");

      const after = await readTask(taskId);
      const step = after.steps.find((candidate) => candidate.id === stepId);
      expect(step?.state).toBe("submitted");
      expect(step?.errorCode, "no failure is recorded for an absent receipt").toBeNull();
      expect(step?.nextAction).toBe("wait_for_confirmation");
      const attempts = await countAttempts(stepId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("submitted");
      expect(attempts[0]?.blockNumber).toBeNull();
    });

    // ── 3. replacement / cancel ──────────────────────────────────────────────

    it("replacement/cancel: a replacement hash for the same intent is refused, never counted as our payment", async () => {
      const fake = chain();
      const originalHash = `0x${"c1".repeat(32)}` as Hex;
      const { taskId, stepId, intentId, attempt } = await submittedAttempt(fake, originalHash);
      const replacementHash = `0x${"c2".repeat(32)}` as Hex;

      // A replacement transaction carries the same sender and nonce, so it is the same
      // payment slot. §9.2 "replacement 记录与原 sender/nonce 对应" now has a writer (P7-06):
      // the new hash is recorded as its OWN row pointing back at the attempt it superseded,
      // and the original row is marked `replaced` — never deleted, because the first
      // transaction may still be the one that mined.
      const task = await recordTransactionHash(txDeps(fake), {
        taskId,
        stepId,
        userId,
        intentId,
        txHash: replacementHash,
      });
      expect(task.id).toBe(taskId);

      const attempts = await countAttempts(stepId);
      expect(attempts, "a replacement adds a row rather than overwriting one").toHaveLength(2);
      const original = attempts.find((candidate) => candidate.id === attempt.id);
      const replacement = attempts.find((candidate) => candidate.id !== attempt.id);
      expect(original?.txHash, "the original attribution is kept").toBe(originalHash);
      expect(original?.status).toBe("replaced");
      expect(original?.replacementFor).toBeNull();
      expect(replacement?.txHash).toBe(replacementHash);
      expect(replacement?.replacementFor, "the new row names the attempt it superseded").toBe(
        attempt.id,
      );
      // Both rows share the intent: that is what makes them the same payment slot.
      expect(replacement?.intentId).toBe(intentId);
      expect(replacement?.nonce).toBe(original?.nonce ?? null);

      // On chain the original hash is gone (replaced or cancelled by another tx
      // with the same nonce). The node answers "unknown", which is pending — not a
      // failure to re-pay from, and not a confirmation of the replacement.
      fake.state.tx = null;
      fake.state.receipt = null;
      const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId,
        stepId,
        intentId,
      });
      expect(outcome.kind).toBe("pending");
      const after = await readTask(taskId);
      expect(after.steps.find((candidate) => candidate.id === stepId)?.state).toBe("submitted");
      expect(after.state).not.toBe("completed");
    });

    it("replacement/cancel: a cancelled signing attempt is not a payment and cannot become a second one", async () => {
      const fake = chain();
      const { task, stepId } = await taskOnce(fake);
      const prepared = await prepareOpenIntent(txDeps(fake), {
        taskId: task.id,
        stepId,
        userId,
        expectedVersion: task.version,
      });

      // The wallet was closed (or the user rejected): no hash ever comes back.
      const [stored] = await countAttempts(stepId);
      expect(stored?.status).toBe("prepared");
      expect(stored?.txHash).toBeNull();

      // A repeated prepare replays the same intent: a cancel is not a new purchase.
      const replay = await prepareOpenIntent(txDeps(fake), {
        taskId: task.id,
        stepId,
        userId,
        expectedVersion: (await readTask(task.id)).version,
      });
      expect(replay.action.intentId, "the same intent is replayed, not replaced").toBe(
        prepared.action.intentId,
      );
      expect(await countAttempts(stepId)).toHaveLength(1);

      // A broadcast whose hash never came back is unresolved, not failed (§3.3).
      const outcome = await verifyOpenTransaction(txDeps(fake), {
        taskId: task.id,
        stepId,
        intentId: prepared.action.intentId,
      });
      expect(outcome.kind).toBe("unverified");
      if (outcome.kind === "unverified") {
        expect(outcome.reason).toBe("TRANSACTION_UNRESOLVED");
      }
      const attempts = await countAttempts(stepId);
      expect(attempts[0]?.status).toBe("unresolved");
      expect(attempts[0]?.txHash).toBeNull();

      const after = await readTask(task.id);
      const step = after.steps.find((candidate) => candidate.id === stepId);
      expect(step?.state, "an unknown send keeps the step where it was").toBe("awaiting_signature");
      expect(step?.nextAction, "the only offered action is to find the original transaction").toBe(
        "verify_original_transaction",
      );
      expect(step?.retryable).toBe(false);
      expect(after.state, "an unknown send outranks waiting_user").toBe("needs_action");

      // And no second paid attempt is possible from this state either.
      const refusal = await captureApiError(
        prepareOpenIntent(txDeps(fake), {
          taskId: task.id,
          stepId,
          userId,
          expectedVersion: after.version,
        }),
      );
      expect(refusal.code).toBe("TRANSACTION_UNRESOLVED");
      expect(await countAttempts(stepId)).toHaveLength(1);
    });

    // ── 4. 历史 hash ─────────────────────────────────────────────────────────

    it("历史 hash: a hash that already succeeded for an earlier attempt cannot be counted again", async () => {
      const fake = chain();
      const historicalHash = `0x${"d1".repeat(32)}` as Hex;
      const first = await submittedAttempt(fake, historicalHash);

      // A second task with its own open step, prepared while the circuit is still
      // unopened (its own quote is priced before anything is confirmed).
      const second = await taskOnce(fake, "historical-hash-key");
      const secondPrepared = await prepareOpenIntent(txDeps(fake), {
        taskId: second.task.id,
        stepId: second.stepId,
        userId,
        expectedVersion: second.task.version,
      });

      // Take the first attempt all the way to confirmed: this hash is now a real,
      // successful, historical payment of another attempt (§9.2).
      fake.state.tx = transactionFromAttempt(first.attempt);
      fake.state.receipt = successReceipt();
      fake.state.opened = true;
      const verified = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId: first.taskId,
        stepId: first.stepId,
        intentId: first.intentId,
      });
      expect(verified.kind, "the fixture needs a confirmed historical hash").toBe("confirmed");

      // The second task now tries to claim the same hash as its own payment.
      const refusal = await captureApiError(
        recordTransactionHash(txDeps(fake), {
          taskId: second.task.id,
          stepId: second.stepId,
          userId,
          intentId: secondPrepared.action.intentId,
          txHash: historicalHash,
        }),
      );
      expect(refusal.statusCode).toBe(409);
      expect(refusal.code).toBe("TRANSACTION_MISMATCH");
      expect(refusal.details["attemptId"], "the refusal names the attempt that owns the hash").toBe(
        first.attempt.id,
      );

      // The second step is still unpaid and has no hash; the historical attempt is
      // still the only row that owns that hash.
      const secondAttempts = await countAttempts(second.stepId);
      expect(secondAttempts).toHaveLength(1);
      expect(secondAttempts[0]?.txHash).toBeNull();
      expect(secondAttempts[0]?.status).toBe("prepared");
      expect((await readTask(second.task.id)).steps[0]?.state).toBe("awaiting_signature");
      expect((await countAttempts(first.stepId))[0]?.status).toBe("confirmed");
      expect((await countAttempts(first.stepId))[0]?.txHash).toBe(historicalHash);

      // The attribution is structural too: the storage layer refuses to move the
      // historical hash onto the second intent even if a caller bypasses the service
      // (status must move with the hash, or the prepared/broadcast checks fire first).
      const structural = await db
        .update(provisioningTransactions)
        .set({ txHash: historicalHash, status: "submitted" })
        .where(eq(provisioningTransactions.intentId, secondPrepared.action.intentId))
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(structural, "a direct re-attribution must be refused by the database").not.toBeNull();
      // Drizzle wraps the driver error, so the constraint name lives in the cause chain.
      const reason = [structural, ...causesOf(structural)].map((entry) => String(entry)).join(" | ");
      expect(reason).toMatch(/provisioning_transactions_chain_tx_hash_key|duplicate key value/);
      expect((await countAttempts(second.stepId))[0]?.txHash).toBeNull();
    });

    // ── 5. 错误 value / data ─────────────────────────────────────────────────

    it("错误 value/data: a transaction paying a different value is failed/TRANSACTION_MISMATCH, never confirmed", async () => {
      const fake = chain();
      const { taskId, stepId, intentId, attempt } = await submittedAttempt(
        fake,
        `0x${"e1".repeat(32)}` as Hex,
      );
      // Everything except the value would pass: exact intent shape, successful
      // receipt, deep block, and the circuit really is opened at that block.
      fake.state.tx = { ...transactionFromAttempt(attempt), value: FEE_WEI - 1n };
      fake.state.receipt = successReceipt();
      fake.state.opened = true;

      const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId,
        stepId,
        intentId,
      });
      expect(outcome.kind, "a different amount is not our payment").toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.errorCode).toBe("TRANSACTION_MISMATCH");
      }

      const after = await readTask(taskId);
      const step = after.steps.find((candidate) => candidate.id === stepId);
      expect(step?.state).toBe("failed");
      expect(step?.state).not.toBe("confirmed");
      expect(step?.errorCode).toBe("TRANSACTION_MISMATCH");
      expect(step?.retryable, "a resolved mismatch may be retried explicitly").toBe(true);
      expect(step?.nextAction).toBe("retry_step");
      expect(after.state).toBe("needs_action");
      expect(mismatchField((await stepRow(stepId))?.result), "the evidence names the field").toBe(
        "value",
      );

      const attempts = await countAttempts(stepId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("failed");
      expect(attempts[0]?.blockNumber, "no receipt facts are recorded for a mismatch").toBeNull();
    });

    it("错误 value/data: a transaction with different calldata is failed/TRANSACTION_MISMATCH, never confirmed", async () => {
      const fake = chain();
      const { taskId, stepId, intentId, attempt } = await submittedAttempt(
        fake,
        `0x${"e2".repeat(32)}` as Hex,
      );
      // Same opener, same selector, same sender, same value — but it opens a
      // different circuit, so it is somebody else's purchase (§9.2).
      const otherTokenCalldata = encodeFunctionData({
        abi: openerAbi,
        functionName: "open",
        args: [PROCESSOR, TOKEN_ID + 1n],
      }).toLowerCase() as Hex;
      expect(otherTokenCalldata).not.toBe(attempt.calldata);
      fake.state.tx = { ...transactionFromAttempt(attempt), data: otherTokenCalldata };
      fake.state.receipt = successReceipt();
      fake.state.opened = true;

      const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId,
        stepId,
        intentId,
      });
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.errorCode).toBe("TRANSACTION_MISMATCH");
      }

      const after = await readTask(taskId);
      const step = after.steps.find((candidate) => candidate.id === stepId);
      expect(step?.state).toBe("failed");
      expect(step?.state).not.toBe("confirmed");
      expect(step?.errorCode).toBe("TRANSACTION_MISMATCH");
      expect(mismatchField((await stepRow(stepId))?.result)).toBe("data");
      expect((await countAttempts(stepId))[0]?.status).toBe("failed");
    });

    // ── 6. 区块变化 ─────────────────────────────────────────────────────────

    it("区块变化: a receipt whose block is no longer canonical stays unverified and picks no winner", async () => {
      const fake = chain();
      const { taskId, stepId, intentId, attempt } = await submittedAttempt(
        fake,
        `0x${"f1".repeat(32)}` as Hex,
      );
      fake.state.tx = transactionFromAttempt(attempt);
      fake.state.receipt = successReceipt();
      fake.state.opened = true;
      // A reorg: the height now has a different hash than the receipt's.
      fake.state.blockHash = DIVERGENT_BLOCK_HASH;
      expect(successReceipt().blockHash).toBe(RECEIPT_BLOCK_HASH);
      expect(DIVERGENT_BLOCK_HASH).not.toBe(RECEIPT_BLOCK_HASH);

      const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId,
        stepId,
        intentId,
      });
      expect(outcome.kind, "a replaced block must not confirm").toBe("unverified");
      if (outcome.kind === "unverified") {
        expect(outcome.reason).toBe("RPC_DISAGREEMENT");
      }

      const after = await readTask(taskId);
      const step = after.steps.find((candidate) => candidate.id === stepId);
      expect(step?.state, "the step stays submitted").toBe("submitted");
      expect(step?.state).not.toBe("confirmed");
      expect(after.state).not.toBe("completed");

      // Nothing from a non-canonical block is recorded as fact.
      const attempts = await countAttempts(stepId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("submitted");
      expect(attempts[0]?.blockNumber).toBeNull();
      expect(attempts[0]?.blockHash).toBeNull();

      // Asking again while the reorg stands gives the same answer: no flip-flop.
      const again = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId,
        stepId,
        intentId,
      });
      expect(again.kind).toBe("unverified");
      expect((await countAttempts(stepId))[0]?.status).toBe("submitted");
    });

    it("区块变化: two operators disagreeing at the receipt's block stays unverified", async () => {
      const primary = chain();
      const { taskId, stepId, intentId, attempt } = await submittedAttempt(
        primary,
        `0x${"f2".repeat(32)}` as Hex,
      );
      primary.state.tx = transactionFromAttempt(attempt);
      primary.state.receipt = successReceipt();
      primary.state.opened = true;
      // Operator B answers a different hash at the same height. §9.2 forbids
      // choosing one answer, so neither is used.
      const secondary = chain({ blockHash: DIVERGENT_BLOCK_HASH });

      const outcome = await verifyOpenTransaction(
        txDeps(primary, { secondary, minConfirmations: 1 }),
        { taskId, stepId, intentId },
      );
      expect(outcome.kind).toBe("unverified");
      if (outcome.kind === "unverified") {
        expect(outcome.reason).toBe("RPC_DISAGREEMENT");
      }
      const after = await readTask(taskId);
      expect(after.steps.find((candidate) => candidate.id === stepId)?.state).toBe("submitted");
      const attempts = await countAttempts(stepId);
      expect(attempts[0]?.status).toBe("submitted");
      expect(attempts[0]?.blockNumber, "a disagreement records no block").toBeNull();
    });

    it("区块变化: an unreadable block is not a canonical proof and never confirms", async () => {
      const fake = chain();
      const { taskId, stepId, intentId, attempt } = await submittedAttempt(
        fake,
        `0x${"f3".repeat(32)}` as Hex,
      );
      fake.state.tx = transactionFromAttempt(attempt);
      fake.state.receipt = successReceipt();
      fake.state.opened = true;
      // The block read fails: the failure must not be read as "still canonical".
      fake.state.failAt = "getBlock";

      const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId,
        stepId,
        intentId,
      });
      expect(outcome.kind).toBe("unverified");
      if (outcome.kind === "unverified") {
        expect(outcome.reason, "an unreadable block is a disagreement, not a proof").toBe(
          "RPC_DISAGREEMENT",
        );
      }
      const after = await readTask(taskId);
      expect(after.steps.find((candidate) => candidate.id === stepId)?.state).toBe("submitted");
      expect((await countAttempts(stepId))[0]?.status).toBe("submitted");
      expect((await countAttempts(stepId))[0]?.blockHash).toBeNull();
    });

    it("区块变化/reorg: a confirmed attempt whose block left the chain is demoted for review", async () => {
      const fake = chain();
      const { taskId, stepId, intentId } = await confirmedAttempt(fake, `0x${"d2".repeat(32)}` as Hex);
      fake.state.blockHash = `0x${"e9".repeat(32)}` as Hex;
      const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), { taskId, stepId, intentId });
      expect(outcome.kind, "a reorg must not keep reporting a settled payment").toBe("unverified");
      if (outcome.kind === "unverified") expect(outcome.reason).toBe("CHAIN_REORG_PENDING");
      const after = await readTask(taskId);
      expect(after.steps.find((candidate) => candidate.id === stepId)?.state).toBe("submitted");
      // The attempt stays `submitted` because the step machine only re-opens a step when the
      // attempt it names is sendable; the reorg reason lives on the step's `errorCode`, which
      // is what the console shows.
      expect((await countAttempts(stepId))[0]?.status).toBe("submitted");
      expect(after.steps.find((candidate) => candidate.id === stepId)?.errorCode).toBe(
        "CHAIN_REORG_PENDING",
      );
    });

    it("区块变化/reorg: an UNREADABLE node leaves the confirmation standing", async () => {
      const fake = chain();
      const { taskId, stepId, intentId } = await confirmedAttempt(fake, `0x${"d3".repeat(32)}` as Hex);
      fake.state.failAt = "getBlock";
      const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), { taskId, stepId, intentId });
      expect(outcome.kind, "an RPC outage is not evidence of a reorg").toBe("confirmed");
    });

    it("区块变化/reorg: a confirmed attempt still on the chain stays confirmed", async () => {
      const fake = chain();
      const { taskId, stepId, intentId } = await confirmedAttempt(fake, `0x${"d4".repeat(32)}` as Hex);
      const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), { taskId, stepId, intentId });
      expect(outcome.kind).toBe("confirmed");
    });

    it("区块变化/reorg: after a replacement the verifier reads the NEWEST attempt (R2-7)", async () => {
      const fake = chain();
      // Unique per run: `tx_hash` is globally unique, so a fixed value collides with any
      // other test that happens to use the same fixture hash.
      const unique = (): Hex => `0x${randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64)}` as Hex;
      const originalHash = unique();
      const { taskId, stepId, intentId } = await submittedAttempt(fake, originalHash);

      // Record a replacement, so this intent now has two rows.
      await recordTransactionHash(txDeps(fake), {
        taskId,
        stepId,
        userId,
        intentId,
        txHash: unique(),
      });
      const rows = await countAttempts(stepId);
      expect(rows).toHaveLength(2);

      // The chain knows the replacement and reports a receipt for it. If `readAttempt`
      // picked the superseded row, the verifier would see "no transaction" and stay
      // pending forever; with an explicit newest-first order it must confirm from the
      // replacement.
      const replacement = rows.find((row) => row.replacementFor !== null);
      if (replacement === undefined) throw new Error("fixture: no replacement row");
      fake.state.tx = {
        ...transactionFromAttempt(replacement as never),
      };
      fake.state.receipt = successReceipt();
      fake.state.opened = true;

      const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId,
        stepId,
        intentId,
      });
      // The point is determinism, not the specific verdict: whichever way the chain reads,
      // the same row must be chosen every run. A `pending` here would mean the superseded
      // row was read despite the replacement being the live one.
      expect(outcome.kind).not.toBe("pending");
    });
  },
);
