/**
 * The provisioning sweep (P7-03): a `submitted` attempt must be settled by a worker, not
 * only when a user happens to press "check again".
 *
 * These tests target the sweep's own logic — which attempts it picks, how it aggregates
 * them, and how it isolates a broken one — with an injected verifier. The verification
 * rules themselves are covered by `tests/p2/provisioning/{transactions,open}.test.ts`;
 * duplicating them here would just re-assert the chain stubs.
 */
import { describe, expect, it } from "vitest";

import {
  countUnresolvedAttempts,
  reconcileProvisioningAttempts,
  PROVISIONING_SWEEP_BATCH,
} from "../../../apps/api/src/worker/provisioning.js";
import {
  provisioningSteps,
  provisioningTasks,
  provisioningTransactions,
  resourceQuotes,
  users,
  withMigratedTestDatabase,
  type Database,
} from "@tapeci/database";
import { postgresErrorCode } from "../db/helpers.js";

/**
 * Seed a task with `attempts` submitted intents.
 *
 * Built directly rather than through the services on purpose: this file tests the
 * sweep's selection and aggregation, so it wants rows in a known open state, not a
 * re-run of the quote/prepare flow that `open.test.ts` already covers.
 */
async function buildAttemptsSeed(
  db: Database,
  options: { readonly attempts: number },
): Promise<{ taskId: string; stepId: string; intentIds: string[] }> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const [user] = await db
    .insert(users)
    .values({ githubUserId: Number(`9${Date.now() % 100000}`), githubLogin: `sweep-${suffix}` })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("user insert failed");

  const now = new Date();
  const [quote] = await db
    .insert(resourceQuotes)
    .values({
      userId: user.id,
      recipientAddress: `0x${"11".repeat(20)}`,
      chainId: 196,
      sourceId: "opener",
      // `.tape` quotes carry a resource, never an offer: the table's CHECK requires
      // exactly one of the two, so leaving both null is rejected by design.
      resourceSnapshot: {
        chainId: 196,
        processor: `0x${"66".repeat(20)}`,
        tokenId: "4",
      },
      options: {},
      // The table requires a non-empty step array and a non-empty price array: a quote
      // with no priced step is not a quote.
      stepsSnapshot: [
        { kind: "open", ordinal: 0, resource: { chainId: 196, processor: `0x${"66".repeat(20)}`, tokenId: "4" } },
      ],
      pricesSnapshot: [
        {
          kind: "open",
          currency: "OKB",
          amountWei: "80000000000000000",
          estimated: false,
          payer: `0x${"11".repeat(20)}`,
          payee: `0x${"77".repeat(20)}`,
        },
      ],
      observedBlock: "74312700",
      expiresAt: new Date(now.getTime() + 900_000),
      termsVersion: "open.v1",
    })
    .returning({ id: resourceQuotes.id });
  if (quote === undefined) throw new Error("quote insert failed");

  const [task] = await db
    .insert(provisioningTasks)
    .values({
      userId: user.id,
      recipientAddress: `0x${"11".repeat(20)}`,
      chainId: 196,
      initialQuoteId: quote.id,
      currentQuoteId: quote.id,
      idempotencyKey: `sweep-${suffix}`,
      requestDigest: `0x${"22".repeat(32)}`,
      state: "running",
      version: 0,
    })
    .returning({ id: provisioningTasks.id });
  if (task === undefined) throw new Error("task insert failed");

  // One live intent per STEP: `provisioning_transactions_live_intent_key` enforces it,
  // and it is correct — a step must never have two sends in flight. So N attempts means
  // N steps, which is the real shape rather than a test-only exception.
  const intentIds: string[] = [];
  let firstStepId = "";
  for (let index = 0; index < options.attempts; index += 1) {
    const [step] = await db
      .insert(provisioningSteps)
      .values({
        taskId: task.id,
        ordinal: index,
        kind: "open",
        state: "submitted",
        quoteId: quote.id,
        version: 0,
      })
      .returning({ id: provisioningSteps.id });
    if (step === undefined) throw new Error("step insert failed");
    if (index === 0) firstStepId = step.id;

    const intentId = crypto.randomUUID();
    intentIds.push(intentId);
    {
      const copy = 0;
      await db.insert(provisioningTransactions).values({
        taskId: task.id,
        stepId: step.id,
        quoteId: quote.id,
        intentId,
        chainId: 196,
        sender: `0x${"33".repeat(20)}`,
        target: `0x${"44".repeat(20)}`,
        valueWei: "80000000000000000",
        calldata: "0xdeadbeef",
        gasLimit: "180000",
        gasPriceWei: "1000000000",
        maxGasCostWei: "180000000000000",
        expectedDigest: `0x${"55".repeat(32)}`,
        // Only one row may be live for a step; the extra copies are already resolved so
        // the sweep still sees one unresolved row per intent.
        status: copy === 0 ? "submitted" : "failed",
        txHash: `0x${(copy + index + 1).toString(16).padStart(64, "0")}`,
      });
    }
  }
  return { taskId: task.id, stepId: firstStepId, intentIds };
}

describe("the provisioning sweep", () => {
  it("verifies every unresolved attempt and aggregates the outcomes", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const { taskId, stepId, intentIds } = await buildAttemptsSeed(db, { attempts: 3 });
      const seen: string[] = [];

      const report = await reconcileProvisioningAttempts(
        { db, client: {} as never, config: {} as never },
        {
          verify: async (attempt) => {
            seen.push(attempt.intentId);
            // One of each outcome, so the aggregation is exercised.
            if (attempt.intentId === intentIds[0]) return { kind: "pending", task: {} as never };
            if (attempt.intentId === intentIds[1]) return { kind: "confirmed", task: {} as never };
            return {
              kind: "unverified",
              task: {} as never,
              reason: "CONFIRMATION_POLICY_UNCONFIGURED",
            };
          },
        },
      );

      expect(seen).toHaveLength(3);
      expect(report.examined).toBe(3);
      expect(report.pending).toBe(1);
      expect(report.confirmed).toBe(1);
      expect(report.unverified).toBe(1);
      expect(report.failed).toBe(0);
      expect(report.errors).toHaveLength(0);
      // `taskId`/`stepId` are the same for all three, which is the real shape.
      expect(seen.every((id) => intentIds.includes(id))).toBe(true);
      expect(taskId).toBeTruthy();
      expect(stepId).toBeTruthy();
    });
  });

  it("counts a failed attempt separately from an unverified one", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      await buildAttemptsSeed(db, { attempts: 1 });
      const report = await reconcileProvisioningAttempts(
        { db, client: {} as never, config: {} as never },
        {
          verify: async () => ({
            kind: "failed",
            task: {} as never,
            errorCode: "TRANSACTION_REVERTED",
          }),
        },
      );
      expect(report.failed).toBe(1);
      // A revert is a decision, not an unreadable node.
      expect(report.unverified).toBe(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  it("isolates a broken attempt instead of stranding the rest of the batch", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const { intentIds } = await buildAttemptsSeed(db, { attempts: 3 });
      const report = await reconcileProvisioningAttempts(
        { db, client: {} as never, config: {} as never },
        {
          verify: async (attempt) => {
            if (attempt.intentId === intentIds[1]) {
              throw new Error("RPC refused the read");
            }
            return { kind: "pending", task: {} as never };
          },
        },
      );

      // The sweep examined all three, settled two, and reported the third.
      expect(report.examined).toBe(3);
      expect(report.pending).toBe(2);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]?.intentId).toBe(intentIds[1]);
      expect(report.errors[0]?.message).toContain("RPC refused");
    });
  });

  it("relies on the schema guarantee that an intent has exactly one root attempt", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      // The sweep de-duplicates by intent defensively, but the schema is the real
      // guarantee: `provisioning_transactions_intent_root_key` makes a second root row for
      // the same intent impossible, so there is no multi-row case to aggregate.
      const { intentIds } = await buildAttemptsSeed(db, { attempts: 1 });
      const [task] = await db.select().from(provisioningTasks).limit(1);
      const [step] = await db.select().from(provisioningSteps).limit(1);
      if (task === undefined || step === undefined) throw new Error("seed missing");

      const duplicate = await db
        .insert(provisioningTransactions)
        .values({
          taskId: task.id,
          stepId: step.id,
          quoteId: task.currentQuoteId,
          intentId: intentIds[0] as string,
          chainId: 196,
          sender: `0x${"33".repeat(20)}`,
          target: `0x${"44".repeat(20)}`,
          valueWei: "1",
          calldata: "0xdeadbeef",
          gasLimit: "180000",
          gasPriceWei: "1000000000",
          maxGasCostWei: "180000000000000",
          expectedDigest: `0x${"55".repeat(32)}`,
          status: "submitted",
        })
        .then(() => null)
        .catch((thrown: unknown) => thrown);
      expect(duplicate).not.toBeNull();
      // The database refuses a second root attempt for one intent. Asserting the SQLSTATE
      // *class* (23 = integrity constraint violation) rather than one exact code keeps the
      // test honest about the guarantee without pinning which mechanism enforces it — the
      // tree has both a unique intent-root key and a check on the root/ replacement pair.
      expect(postgresErrorCode(duplicate)?.startsWith("23")).toBe(true);
    });
  });

  it("is idempotent: a second sweep re-reads and reports the same shape", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      await buildAttemptsSeed(db, { attempts: 2 });
      const verify = async (): Promise<{ kind: "pending"; task: never }> => ({
        kind: "pending",
        task: {} as never,
      });
      const deps = { db, client: {} as never, config: {} as never };
      const first = await reconcileProvisioningAttempts(deps, { verify });
      const second = await reconcileProvisioningAttempts(deps, { verify });
      // Nothing was dispatched or re-sent, so the second run sees the same work.
      expect(second.examined).toBe(first.examined);
      expect(second.pending).toBe(first.pending);
    });
  });

  it("never exceeds its batch size", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      await buildAttemptsSeed(db, { attempts: 5 });
      const report = await reconcileProvisioningAttempts(
        { db, client: {} as never, config: {} as never },
        { limit: 2, verify: async () => ({ kind: "pending", task: {} as never }) },
      );
      expect(report.examined).toBe(2);
      expect(PROVISIONING_SWEEP_BATCH).toBeGreaterThan(2);
    });
  });

  it("counts the attempts a task still has open", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const { taskId } = await buildAttemptsSeed(db, { attempts: 2 });
      // `countUnresolvedAttempts` is what a caller uses to decide whether to enqueue.
      expect(await countUnresolvedAttempts({ db }, taskId)).toBe(2);
    });
  });
});
