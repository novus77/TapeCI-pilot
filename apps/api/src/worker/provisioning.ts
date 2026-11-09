/**
 * The provisioning sweep (SPEC §4 `apps/api/src/worker/provisioning.ts`, §9.1, §9.2).
 *
 * Why this exists: a paid step moves to `submitted` when the wallet returns a hash, and
 * only a later chain read can move it to `confirmed` or `failed`. Without a worker that
 * read happens only when a user happens to open the page and press "check again", so a
 * payment that mined while nobody was looking stays unverified indefinitely — which is
 * exactly the gap P7-03 recorded.
 *
 * What it deliberately does **not** do:
 * - it never dispatches, signs, or re-sends anything. `verifyOpenTransaction` only reads;
 * - it never confirms without a configured policy, and it never turns "we could not read"
 *   into "failed" — that distinction is the whole point of §9.2;
 * - it never lets one broken attempt abort the sweep.
 */
import type { Database } from "@tapeci/database";
import { and, asc, eq, inArray } from "drizzle-orm";
import { provisioningTransactions } from "@tapeci/database";
import type { ChainConfig } from "@tapeci/config";
import type { ReadClient } from "@tapeci/chain";
import { ApiError } from "../errors.js";
import { verifyOpenTransaction, type TransactionDeps } from "../provisioning/transactions.js";

/** Attempts whose outcome still has to be verified (§3.3). */
export const UNRESOLVED_ATTEMPT_STATUSES = ["submitted", "unresolved"] as const;

/**
 * How often the sweep should run. Deliberately longer than a block: the sweep exists to
 * settle attempts nobody is watching, not to poll a fresh payment.
 */
export const PROVISIONING_SWEEP_INTERVAL_MS = 60_000;

/** The most attempts one sweep will look at, so a backlog cannot monopolise a worker. */
export const PROVISIONING_SWEEP_BATCH = 50;

export interface ProvisioningWorkerDeps {
  readonly db: Database;
  readonly client: ReadClient;
  readonly config: ChainConfig;
  /** A second, independent operator; divergence keeps the attempt unverified (§9.2). */
  readonly secondaryClient?: ReadClient;
  /** No default on purpose: see `TransactionDeps.minConfirmations`. */
  readonly minConfirmations?: number | "finalized";
  readonly now?: () => Date;
}

export interface SweepFailure {
  readonly taskId: string;
  readonly stepId: string;
  readonly intentId: string;
  readonly message: string;
}

export interface ReconcileSweepReport {
  /** Attempts the sweep attempted to verify. */
  readonly examined: number;
  readonly confirmed: number;
  /** Still waiting: no receipt, too few confirmations, or an unreadable node. */
  readonly pending: number;
  /** Read, but withheld — e.g. `CONFIRMATION_POLICY_UNCONFIGURED`. */
  readonly unverified: number;
  readonly failed: number;
  /** Per-attempt errors. One bad attempt must not stop the rest of the sweep. */
  readonly errors: readonly SweepFailure[];
}

export interface ReconcileSweepOptions {
  readonly limit?: number;
  /**
   * Injectable verifier. Production uses `verifyOpenTransaction`; a test injects a fake
   * so the sweep's own logic — selection, aggregation, per-attempt isolation — can be
   * checked without a chain. The verification rules themselves are covered by
   * `tests/p2/provisioning/{transactions,open}.test.ts`.
   */
  readonly verify?: (attempt: AttemptKey) => Promise<VerifyOutcome>;
}

type VerifyOutcome = Awaited<ReturnType<typeof verifyOpenTransaction>>;

export interface AttemptKey {
  readonly taskId: string;
  readonly stepId: string;
  readonly intentId: string;
}

function transactionDeps(deps: ProvisioningWorkerDeps): TransactionDeps {
  return {
    db: deps.db,
    client: deps.client,
    config: deps.config,
    ...(deps.secondaryClient === undefined ? {} : { secondaryClient: deps.secondaryClient }),
    ...(deps.minConfirmations === undefined ? {} : { minConfirmations: deps.minConfirmations }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
}

/**
 * Verify every attempt whose outcome is still open, oldest first.
 *
 * Idempotent: it reads and records; running it twice changes nothing that the first run
 * did not already decide, and it can never trigger a payment.
 */
export async function reconcileProvisioningAttempts(
  deps: ProvisioningWorkerDeps,
  options: ReconcileSweepOptions = {},
): Promise<ReconcileSweepReport> {
  const limit = options.limit ?? PROVISIONING_SWEEP_BATCH;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new ApiError(400, "INVALID_LIMIT", "limit must be a positive integer");
  }

  const rows = await deps.db
    .select({
      taskId: provisioningTransactions.taskId,
      stepId: provisioningTransactions.stepId,
      intentId: provisioningTransactions.intentId,
      createdAt: provisioningTransactions.createdAt,
      status: provisioningTransactions.status,
    })
    .from(provisioningTransactions)
    .where(inArray(provisioningTransactions.status, [...UNRESOLVED_ATTEMPT_STATUSES]))
    .orderBy(asc(provisioningTransactions.createdAt))
    .limit(limit);

  const seen = new Set<string>();
  const attempts: AttemptKey[] = [];
  for (const row of rows) {
    // One row per intent: a replacement chain would otherwise verify the same intent twice.
    const key = `${row.taskId}:${row.stepId}:${row.intentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attempts.push({ taskId: row.taskId, stepId: row.stepId, intentId: row.intentId });
  }

  const report = {
    examined: attempts.length,
    confirmed: 0,
    pending: 0,
    unverified: 0,
    failed: 0,
    errors: [] as SweepFailure[],
  };

  for (const attempt of attempts) {
    try {
      const outcome =
        options.verify === undefined
          ? await verifyOpenTransaction(transactionDeps(deps), attempt)
          : await options.verify(attempt);
      // `confirmed` is only ever reported by the verifier when every §9.2 check passed.
      if (outcome.kind === "confirmed") report.confirmed += 1;
      else if (outcome.kind === "failed") report.failed += 1;
      else if (outcome.kind === "pending") report.pending += 1;
      else report.unverified += 1;
    } catch (error) {
      // A single attempt that cannot be read (deleted task, malformed row, RPC fault)
      // is reported and skipped. Aborting the sweep would strand every later attempt,
      // including ones that are perfectly readable.
      report.errors.push({
        ...attempt,
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  return report;
}

/**
 * The BullMQ handler for the `provision` queue. It returns the sweep report so a failed
 * or empty sweep is visible in the job result rather than silent.
 */
export function createProvisioningHandler(
  deps: ProvisioningWorkerDeps,
): () => Promise<ReconcileSweepReport> {
  return async () => reconcileProvisioningAttempts(deps);
}

/** Whether a step of this attempt still needs the worker's attention (§9.1). */
export async function countUnresolvedAttempts(
  deps: Pick<ProvisioningWorkerDeps, "db">,
  taskId: string,
): Promise<number> {
  const rows = await deps.db
    .select({ intentId: provisioningTransactions.intentId })
    .from(provisioningTransactions)
    .where(
      and(
        eq(provisioningTransactions.taskId, taskId),
        inArray(provisioningTransactions.status, [...UNRESOLVED_ATTEMPT_STATUSES]),
      ),
    );
  return rows.length;
}
