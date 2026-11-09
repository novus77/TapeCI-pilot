/**
 * P3 §15.1 — the supplier/provider contract (SPEC §15.1 names this file).
 *
 * §15.1 asks this file to prove: **无来源 unavailable、真实来源交付契约、错误接收者、
 * 库存遗留授权、external_pending 返回页面不算成功**. Each `it` title starts with the
 * clause it covers.
 *
 * **There is no supplier.** SPEC §4 names `apps/api/src/provisioning/providers.ts`
 * ("供应接口和默认 unavailable") and that module does not exist; `GET
 * /v1/resources/offers` is the only supplier-facing surface and it answers
 * `available: false` with `SOURCE_UNAVAILABLE`; `POST /v1/resource-quotes` refuses
 * an `offerId` or a foreign `sourceId`. So the "real supplier" clauses are asserted
 * in the only two honest ways available:
 *
 * 1. **What the platform refuses** — no fabricated catalogue, no offer quote, no
 *    external step without a verified source+reference, no second step backed by
 *    the same supplier order, no confirmation from a browser return.
 * 2. **A contract assertion, labelled as such** — the shape a real supplier
 *    delivery must satisfy (`PreparedStepAction`'s `external` branch), checked at
 *    type-check time with `satisfies` and at runtime against the frozen §5 field
 *    list. It deliberately does **not** invent a fake supplier that pretends to be
 *    real: nothing here delivers a resource, and no test claims one was delivered.
 *
 * The `open` path is the only implemented paid path, so the "wrong recipient" and
 * "stale authorisation" clauses are exercised there: it is the platform's real
 * gate for a changed delivery wallet / changed price / resource taken since the
 * quote. The supplier-inventory variant of that clause is unimplemented and is
 * reported in `.superpowers/sdd/provisioning/dev-p7a.md`, not simulated here.
 *
 * Run from the repo root (test-p0 §1.4 — the package-dir form is broken):
 *   node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs exec vitest run tests/p2/provisioning/provider-contract.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { isNotNull, eq } from "drizzle-orm";
import { XLAYER_MAINNET } from "@tapeci/config";
import {
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  migrateUp,
  provisioningSteps,
  provisioningTransactions,
  resourceQuotes,
  type Database,
} from "@tapeci/database";
import type { PreparedStepAction, PreparationTask } from "@tapeci/shared";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";
import { ApiError } from "../../../apps/api/src/errors.js";
import { buildOpenQuote } from "../../../apps/api/src/provisioning/quotes.js";
import {
  createPreparationTask,
  loadPreparationTask,
  transitionStepInTransaction,
} from "../../../apps/api/src/provisioning/tasks.js";
import {
  prepareOpenIntent,
  recordTransactionHash,
  verifyOpenTransaction,
} from "../../../apps/api/src/provisioning/transactions.js";
import {
  FEE_WEI,
  OTHER_WALLET,
  OWNER,
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
  "P3 provider contract [SKIPPED: PostgreSQL is unreachable; the suite needs the shared " +
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

/** The frozen §5 field list of `PreparedStepAction`'s `external` branch. */
const EXTERNAL_ACTION_KEYS = [
  "expiresAt",
  "externalReference",
  "intentId",
  "kind",
  "quoteId",
  "sourceId",
  "stepId",
  "taskId",
  "url",
] as const;

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

/** The mismatch evidence stored on the step, or `null` when none was written. */
function mismatchField(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const mismatch = (result as Record<string, unknown>)["mismatch"];
  if (typeof mismatch !== "object" || mismatch === null) return null;
  const field = (mismatch as Record<string, unknown>)["field"];
  return typeof field === "string" ? field : null;
}

describe.skipIf(!available)(
  available ? "P3 §15.1 provider contract (no source, delivery shape, recipient, stale authorisation, external_pending)" : unavailableLabel,
  () => {
    let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
    let handle: ReturnType<typeof createDatabase>;
    let db: Database;
    let app: FastifyInstance;
    let userId: string;

    const headers = {
      "x-tapeci-github-login": "contract-holder",
      "x-tapeci-github-user-id": "9201",
      "content-type": "application/json",
    };

    beforeAll(async () => {
      testDatabase = await createTestDatabase();
      await migrateUp(testDatabase.url);
      handle = createDatabase(testDatabase.url);
      db = handle.db;
      userId = await seedUser(db, 9_201, "contract-holder");
      // The same user holds two verified wallets: the delivery wallet is a choice
      // the quote records, so a second one is needed to test a wrong recipient.
      await seedWallet(db, userId, OWNER);
      await seedWallet(db, userId, OTHER_WALLET);
      app = buildApp({ db, env, readClient: () => createFakeChain().client } satisfies ApiDeps);
      await app.ready();
    }, 90_000);

    afterAll(async () => {
      await app?.close();
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

    async function countQuotes(): Promise<number> {
      return (await db.select().from(resourceQuotes)).length;
    }

    /** Prepare + register a hash, i.e. a real `submitted` attempt to verify. */
    async function submittedAttempt(fake: FakeChain, txHash: `0x${string}`) {
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

    /** The real §9.1 transition into `external_pending`, with or without a source. */
    async function enterExternal(
      taskId: string,
      stepId: string,
      expectedVersion: number,
      external: { readonly sourceId: string; readonly reference: string } | null,
    ): Promise<PreparationTask> {
      return db.transaction(async (tx) =>
        transitionStepInTransaction(
          tx,
          {
            taskId,
            stepId,
            expectedVersion,
            to: "external_pending",
            ...(external === null ? {} : { external }),
          },
          NOW,
        ),
      );
    }

    /** The transition a "the page says the purchase succeeded" caller would try. */
    async function enterConfirmed(
      taskId: string,
      stepId: string,
      expectedVersion: number,
    ): Promise<PreparationTask> {
      return db.transaction(async (tx) =>
        transitionStepInTransaction(tx, { taskId, stepId, expectedVersion, to: "confirmed" }, NOW),
      );
    }

    // ── 1. 无来源 unavailable ────────────────────────────────────────────────

    it("无来源 unavailable: with no supplier configured the offers path is explicitly unavailable, never a mock success", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/resources/offers?chainId=196" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      // Sorted, because the response key order is not part of the contract.
      expect(Object.keys(body).sort()).toEqual([
        "available",
        "chainId",
        "guidance",
        "offers",
        "unavailableKind",
        "unavailableReason",
      ]);
      expect(body["chainId"]).toBe(196);
      expect(body["available"], "no supplier means available is false, not a happy path").toBe(false);
      expect(body["offers"], "an empty catalogue, never a fabricated offer").toEqual([]);

      // Measured on 2026-10-28: minted == supplyCap, so the reason is exhaustion rather
      // than "not configured" — a different fact that the client can act on differently.
      // See docs/superpowers/specs/2026-10-28-self-mint-spec.md §12.
      expect(body["unavailableReason"]).toBe("NO_PREPRICED_OFFERS");
      expect(body["unavailableKind"]).toBe("self_mint_available");

      // The response must point at the path that DOES work, not just report a dead end.
      const guidance = body["guidance"] as Record<string, unknown>;
      expect(guidance["kind"]).toBe("mint_from_protocol");
      expect(typeof guidance["hint"]).toBe("string");

      // Nothing in storage pretends an offer was ever priced.
      const pricedOffers = await db
        .select()
        .from(resourceQuotes)
        .where(isNotNull(resourceQuotes.offerId));
      expect(pricedOffers, "no quote may carry an offerId while no source exists").toHaveLength(0);
    });

    it("无来源 unavailable: an offer or a foreign source cannot be quoted, so no fabricated offer is payable", async () => {
      const before = await countQuotes();
      const offer = await app.inject({
        method: "POST",
        url: "/v1/resource-quotes",
        headers,
        payload: { recipient: OWNER, offerId: "offer-0001", resource: RESOURCE },
      });
      expect(offer.statusCode, offer.body).toBe(422);
      expect((offer.json() as { error: { code: string } }).error.code).toBe(
        "ACQUISITION_UNSUPPORTED",
      );

      const foreignSource = await app.inject({
        method: "POST",
        url: "/v1/resource-quotes",
        headers,
        payload: { recipient: OWNER, sourceId: "supplier-x", resource: RESOURCE },
      });
      expect(foreignSource.statusCode, foreignSource.body).toBe(422);
      expect((foreignSource.json() as { error: { code: string } }).error.code).toBe(
        "ACQUISITION_UNSUPPORTED",
      );

      expect(await countQuotes(), "a refused offer leaves no quote row").toBe(before);
    });

    // ── 2. 真实来源交付契约 ─────────────────────────────────────────────────

    it("真实来源交付契约: the shape a real supplier must satisfy, and the gate the platform enforces on it", async () => {
      // (a) CONTRACT ASSERTION, not an exercised supplier. There is no real source
      // to deliver anything (see the file header), so the delivery shape is pinned
      // against the frozen §5 DTO: `satisfies` makes a DTO rename a type-check
      // failure, and the key list makes a runtime drift visible here.
      const delivery = {
        kind: "external",
        intentId: "00000000-0000-4000-8000-000000000010",
        taskId: "00000000-0000-4000-8000-000000000011",
        stepId: "00000000-0000-4000-8000-000000000012",
        quoteId: "00000000-0000-4000-8000-000000000013",
        sourceId: "verified-supplier",
        externalReference: "order-42",
        url: "https://supplier.invalid/checkout/order-42",
        expiresAt: NOW.toISOString(),
      } satisfies PreparedStepAction;
      expect(delivery.kind).toBe("external");
      expect(Object.keys(delivery).sort()).toEqual([...EXTERNAL_ACTION_KEYS]);

      // (b) The platform's own gate: an external step cannot exist without a
      // verified source id *and* reference, so no delivery can be invented.
      const { task, stepId } = await taskOnce(chain());
      const beforeRefusal = await stepRow(stepId);
      const noSource = await captureApiError(enterExternal(task.id, stepId, task.version, null));
      expect(noSource.statusCode).toBe(409);
      expect(noSource.code).toBe("SOURCE_UNAVAILABLE");
      const afterRefusal = await stepRow(stepId);
      expect(afterRefusal?.state, "a refused delivery changes nothing").toBe(beforeRefusal?.state);
      expect(afterRefusal?.externalSourceId).toBeNull();
      expect(afterRefusal?.externalReference).toBeNull();

      // (c) With the pair, the supplier reference is recorded on the step, so a
      // later verification has something real to check against the supplier.
      const entered = await enterExternal(task.id, stepId, task.version, {
        sourceId: "verified-supplier",
        reference: "order-42",
      });
      expect(entered.steps[0]?.state).toBe("external_pending");
      expect(entered.state).toBe("running");
      expect(entered.steps[0]?.nextAction).toBe("complete_external_purchase");
      const stored = await stepRow(stepId);
      expect(stored?.externalSourceId).toBe("verified-supplier");
      expect(stored?.externalReference).toBe("order-42");

      // (d) One verified supplier order backs at most one step (§6): the same
      // source+reference cannot be replayed as a second delivery.
      const second = await taskOnce(chain(), "duplicate-order-key");
      const secondBefore = await stepRow(second.stepId);
      const duplicate = await enterExternal(second.task.id, second.stepId, second.task.version, {
        sourceId: "verified-supplier",
        reference: "order-42",
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(duplicate, "the same supplier order must not back two steps").not.toBeNull();
      const reason = [duplicate, ...causesOf(duplicate)].map((entry) => String(entry)).join(" | ");
      expect(reason).toMatch(/provisioning_steps_external_reference_key|duplicate key value/);
      expect((await stepRow(second.stepId))?.state).toBe(secondBefore?.state);
    });

    // ── 3. 错误接收者 ────────────────────────────────────────────────────────

    it("错误接收者: a quote for a wallet that does not hold the circuit is refused", async () => {
      const fake = chain({ owner: OWNER });
      const before = await countQuotes();
      const refusal = await captureApiError(
        buildOpenQuote(
          { db, client: fake.client, config: XLAYER_MAINNET, now: fixedClock(NOW) },
          { userId, recipient: OTHER_WALLET, resource: RESOURCE },
        ),
      );
      expect(refusal.statusCode, "a state conflict, not a token authorization failure").toBe(409);
      expect(refusal.code).toBe("NOT_CURRENT_OWNER");
      expect(refusal.details["recipient"]).toBe(OTHER_WALLET);
      expect(await countQuotes(), "no quote may name a recipient that cannot receive it").toBe(
        before,
      );
    });

    it("错误接收者: an identical payment from a wallet that is not the recorded recipient never confirms", async () => {
      const fake = chain();
      const { taskId, stepId, intentId, attempt } = await submittedAttempt(
        fake,
        `0x${"9a".repeat(32)}`,
      );
      // Same target, same value, same calldata — sent from another wallet.
      fake.state.tx = { ...transactionFromAttempt(attempt), from: OTHER_WALLET };
      fake.state.receipt = successReceipt();
      fake.state.opened = true;

      const outcome = await verifyOpenTransaction(txDeps(fake, { minConfirmations: 1 }), {
        taskId,
        stepId,
        intentId,
      });
      expect(outcome.kind, "another wallet's transaction is not our delivery").toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.errorCode).toBe("TRANSACTION_MISMATCH");
      }
      const after = await readTask(taskId);
      const step = after.steps.find((candidate) => candidate.id === stepId);
      expect(step?.state).toBe("failed");
      expect(step?.state).not.toBe("confirmed");
      expect(step?.errorCode).toBe("TRANSACTION_MISMATCH");
      expect(mismatchField((await stepRow(stepId))?.result), "the sender is what differs").toBe(
        "from",
      );
      expect((await countAttempts(stepId))[0]?.status).toBe("failed");
    });

    it("错误接收者: a circuit that changed hands after the quote cannot be prepared for the old recipient", async () => {
      const fake = chain({ owner: OWNER });
      const { task, stepId } = await taskOnce(fake);
      // Between the quote and the paid step the circuit moves to another wallet.
      fake.state.owner = OTHER_WALLET;

      const refusal = await captureApiError(
        prepareOpenIntent(txDeps(fake), {
          taskId: task.id,
          stepId,
          userId,
          expectedVersion: task.version,
        }),
      );
      expect(refusal.statusCode).toBe(403);
      expect(refusal.code).toBe("OWNER_REQUIRED");
      expect(refusal.details["recipient"]).toBe(OWNER);
      expect(refusal.details["owner"]).toBe(OTHER_WALLET);
      expect(await countAttempts(stepId), "a wrong delivery wallet gets no intent").toHaveLength(0);
      expect((await readTask(task.id)).steps[0]?.state).toBe("awaiting_signature");
    });

    // ── 4. 库存遗留授权 ─────────────────────────────────────────────────────

    it("库存遗留授权: a quote whose price moved is re-reviewed, not honoured", async () => {
      const fake = chain();
      const { task, stepId } = await taskOnce(fake);
      // The opener fee moves after the quote was accepted. The accepted quote is a
      // leftover authorisation at the old price and must not be executed (§9.3).
      fake.state.feeWei = FEE_WEI + 1n;

      const refusal = await captureApiError(
        prepareOpenIntent(txDeps(fake), {
          taskId: task.id,
          stepId,
          userId,
          expectedVersion: task.version,
        }),
      );
      expect(refusal.statusCode).toBe(409);
      expect(refusal.code).toBe("QUOTE_CHANGED");
      expect(refusal.details["quoteValueWei"]).toBe(FEE_WEI.toString(10));
      expect(refusal.details["currentValueWei"]).toBe((FEE_WEI + 1n).toString(10));
      expect(await countAttempts(stepId), "no intent is stored for a stale price").toHaveLength(0);
    });

    it("库存遗留授权: a circuit that was opened after the quote is not paid for again", async () => {
      const fake = chain();
      const { task, stepId } = await taskOnce(fake);
      // The stock is gone: someone (possibly the user) already opened it. P3-13
      // measured that a second `open` reverts without re-charging, so the honest
      // behaviour is to refuse the paid step rather than send it again.
      fake.state.opened = true;

      const refusal = await captureApiError(
        prepareOpenIntent(txDeps(fake), {
          taskId: task.id,
          stepId,
          userId,
          expectedVersion: task.version,
        }),
      );
      expect(refusal.statusCode).toBe(409);
      expect(refusal.code).toBe("ALREADY_OPENED");
      expect(await countAttempts(stepId), "no second paid attempt for gone stock").toHaveLength(0);
      expect((await readTask(task.id)).steps[0]?.state).toBe("awaiting_signature");
    });

    // ── 5. external_pending 返回页面不算成功 ─────────────────────────────────

    it("external_pending 返回页面不算成功: returning from the supplier page reconciles to external_pending, never confirmed", async () => {
      const fake = chain();
      const { task, stepId } = await taskOnce(fake);
      await enterExternal(task.id, stepId, task.version, {
        sourceId: "verified-supplier",
        reference: "order-return",
      });

      // The user comes back from the external purchase page and the page asks the
      // server to reconcile. A browser return is not a payment (§7.3).
      const response = await app.inject({
        method: "POST",
        url: `/v1/preparations/${task.id}/reconcile`,
        headers,
      });
      expect(response.statusCode, response.body).toBe(202);
      const body = response.json() as {
        task: PreparationTask;
        verifications: unknown[];
        reconciliationOnly: boolean;
      };
      expect(body.reconciliationOnly).toBe(true);
      expect(body.verifications, "no attempt exists, so nothing can be verified").toEqual([]);

      const step = body.task.steps.find((candidate) => candidate.id === stepId);
      expect(step?.state, "a return page keeps the step external_pending").toBe("external_pending");
      expect(step?.state).not.toBe("confirmed");
      expect(step?.nextAction).toBe("complete_external_purchase");
      expect(body.task.state).toBe("running");
      expect(body.task.state).not.toBe("completed");

      // The state machine itself refuses the "page says success" shortcut: a
      // confirmation needs a verified attempt of this step, which an external
      // order does not have.
      const shortcut = await captureApiError(
        enterConfirmed(task.id, stepId, body.task.version),
      );
      expect(shortcut.statusCode).toBe(409);
      expect(shortcut.code).toBe("DELIVERY_UNVERIFIED");
      expect((await stepRow(stepId))?.state).toBe("external_pending");

      // And a possible purchase cannot be abandoned, so no re-purchase is invited.
      const cancel = await app.inject({
        method: "POST",
        url: `/v1/preparations/${task.id}/cancel`,
        headers,
        payload: { expectedVersion: body.task.version },
      });
      expect(cancel.statusCode, cancel.body).toBe(409);
      expect((cancel.json() as { error: { code: string } }).error.code).toBe("TASK_UNRESOLVED");
      expect((await readTask(task.id)).state).toBe("running");
    });
  },
);
