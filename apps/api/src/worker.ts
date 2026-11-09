/**
 * Long-running P2 worker process. Run with `pnpm worker:dev`.
 *
 * Requires DATABASE_URL, REDIS_URL, SESSION_SIGNING_SECRET and (for chain
 * writes) TAPECI_OPERATOR_PRIVATE_KEY. Workers are fail-closed: no key means
 * plan/verify still work, deploy fails with INVALID_CONFIG.
 */
import { createDatabase } from "@tapeci/database";
import {
  QUEUE_NAMES,
  checkRedisAvailable,
  createDeploymentQueues,
  startWorkers,
  stopWorkers,
} from "@tapeci/queue";
import { isTapeCiError } from "@tapeci/shared";
import { loadEnv } from "./env.js";
import { WorkerMetrics, startWorkerHealthServer, type QueueCounts, type QueueName } from "./worker/metrics.js";
import { reconcileInstallationsIfConfigured } from "./github-reconcile.js";
import { createWorkerHandlers, createWorkerRuntime } from "./worker/runtime.js";
import { backfillAuditScopes } from "./audit-backfill.js";
import { reconcileProvisioningAttempts } from "./worker/provisioning.js";

const env = loadEnv();
const { db, pool } = createDatabase(env.databaseUrl);
const runtime = createWorkerRuntime({ db, env });
const workers = await startWorkers({
  db,
  redisUrl: env.redisUrl,
  handlers: createWorkerHandlers(runtime),
});

const metrics = new WorkerMetrics();
for (const name of QUEUE_NAMES) {
  const worker = workers.workers[name];
  worker.on("active", () => {
    metrics.recordStarted(name);
  });
  worker.on("completed", (job) => {
    const duration =
      job.processedOn !== undefined && job.finishedOn !== undefined
        ? job.finishedOn - job.processedOn
        : null;
    metrics.recordCompleted(name, duration);
  });
  worker.on("failed", (_job, error) => {
    metrics.recordFailed(name, isTapeCiError(error) ? error.code : "INTERNAL");
  });
}

const queues = createDeploymentQueues({ redisUrl: env.redisUrl });
const queueChecks = async (): Promise<Record<QueueName, QueueCounts>> => {
  const entries = await Promise.all(
    QUEUE_NAMES.map(async (name) => {
      const queue = queues.get(name);
      const [counts, paused] = await Promise.all([
        queue.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
        queue.isPaused(),
      ]);
      return [
        name,
        {
          waiting: counts["waiting"] ?? 0,
          active: counts["active"] ?? 0,
          completed: counts["completed"] ?? 0,
          failed: counts["failed"] ?? 0,
          delayed: counts["delayed"] ?? 0,
          paused: paused ? 1 : 0,
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<QueueName, QueueCounts>;
};

const health = await startWorkerHealthServer({
  port: env.workerPort ?? 8788,
  host: env.workerHost ?? "127.0.0.1",
  metrics,
  checks: {
    database: async () => {
      await pool.query("select 1");
      return true;
    },
    redis: () => checkRedisAvailable({ url: env.redisUrl, timeoutMs: 1_000 }),
    queues: queueChecks,
  },
});

console.log(
  JSON.stringify({
    service: "tapeci-worker",
    queues: ["plan", "deploy", "verify"],
    operators: runtime.operators.map((operator) => operator.operator),
    signerConfigured: runtime.signer !== null,
    singleOperator: runtime.allowSingleOperator,
    journalDir: runtime.journalDir,
    health: health.url,
  }),
);

let shuttingDown = false;
const reconcileEnabled =
  env.reconcileEnabled !== false &&
  env.githubAppId !== null &&
  env.githubAppPrivateKey !== null;
let reconcileTimer: NodeJS.Timeout | null = null;
const runReconcile = async (): Promise<void> => {
  const startedAt = Date.now();
  try {
    const result = await reconcileInstallationsIfConfigured({ db, env });
    if (result !== null) {
      metrics.recordReconcileSuccess(result, Date.now() - startedAt);
      console.log(JSON.stringify({ service: "tapeci-worker", event: "reconcile", ...result }));
    }
  } catch (error) {
    metrics.recordReconcileFailure(Date.now() - startedAt);
    console.error(
      JSON.stringify({
        service: "tapeci-worker",
        event: "reconcile_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
};
if (reconcileEnabled) {
  void runReconcile();
  const intervalSeconds = Math.max(60, env.reconcileIntervalSeconds ?? 900);
  reconcileTimer = setInterval(() => {
    void runReconcile();
  }, intervalSeconds * 1_000);
  reconcileTimer.unref();
}

let backfillTimer: NodeJS.Timeout | null = null;
let backfillRunning = false;
const runAuditBackfill = async (): Promise<void> => {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    const result = await backfillAuditScopes(db, { apply: true });
    console.log(JSON.stringify({ service: "tapeci-worker", event: "audit_backfill", ...result }));
  } catch (error) {
    console.error(
      JSON.stringify({
        service: "tapeci-worker",
        event: "audit_backfill_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    backfillRunning = false;
  }
};
if ((env.auditBackfillIntervalMs ?? 0) > 0) {
  void runAuditBackfill();
  backfillTimer = setInterval(() => {
    void runAuditBackfill();
  }, env.auditBackfillIntervalMs);
  backfillTimer.unref();
}

/**
 * The provisioning sweep (P7-03). Without it a `submitted` payment settles only when a
 * user happens to open the page and press "check again", so one that mined while nobody
 * watched stays unverified indefinitely.
 *
 * Deliberately an in-process timer rather than a BullMQ repeatable job: the sweep is
 * global and idempotent, so a missing job (Redis blip, worker restart) must never mean a
 * payment is never checked. The timer is unref'd so it cannot hold the process open.
 */
let sweepTimer: NodeJS.Timeout | null = null;
let sweepRunning = false;
const runProvisioningSweep = async (): Promise<void> => {
  if (sweepRunning) return;
  sweepRunning = true;
  const primary = runtime.operators[0];
  try {
    if (primary === undefined) {
      console.error(
        JSON.stringify({ service: "tapeci-worker", event: "provisioning_sweep_skipped", reason: "no_operator" }),
      );
      return;
    }
    const report = await reconcileProvisioningAttempts({
      db,
      client: primary.client,
      config: runtime.config,
      ...(runtime.operators[1] === undefined ? {} : { secondaryClient: runtime.operators[1].client }),
      ...(env.provisioningConfirmations === undefined || env.provisioningConfirmations === null
        ? {}
        : { minConfirmations: env.provisioningConfirmations }),
    });
    // Logged every tick because an empty sweep and a broken one must be distinguishable.
    console.log(JSON.stringify({ service: "tapeci-worker", event: "provisioning_sweep", ...report }));
  } catch (error) {
    console.error(
      JSON.stringify({
        service: "tapeci-worker",
        event: "provisioning_sweep_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    sweepRunning = false;
  }
};
const sweepIntervalMs = env.provisioningSweepIntervalMs ?? 0;
if (sweepIntervalMs > 0) {
  void runProvisioningSweep();
  sweepTimer = setInterval(() => {
    void runProvisioningSweep();
  }, sweepIntervalMs);
  sweepTimer.unref();
}

const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconcileTimer !== null) clearInterval(reconcileTimer);
  if (backfillTimer !== null) clearInterval(backfillTimer);
  if (sweepTimer !== null) clearInterval(sweepTimer);
  await health.close();
  await queues.close();
  await stopWorkers(workers);
  await pool.end();
};
process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
