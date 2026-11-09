import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TapeCiError } from "@tapeci/shared";
import {
  ContainerLock,
  createDeploymentQueues,
  enqueueDeployment,
  getDeployment,
  listDeploymentEvents,
  startWorkers,
  stopWorkers,
  type Database,
  type DeploymentQueues,
  type DeploymentWorkerSet,
} from "@tapeci/queue";
import {
  detectServices,
  seedDeployment,
  setupTestDatabase,
  TEST_REDIS_URL,
  waitForJob,
  type TestDatabaseHandle,
} from "./helpers.js";

const services = await detectServices();
const describeWorkers = services.database && services.redis ? describe : describe.skip;

describeWorkers("BullMQ deployment workers", () => {
  const prefix = `tapeci-test-${randomUUID().slice(0, 8)}`;
  let handle: TestDatabaseHandle | undefined;
  let queues: DeploymentQueues;
  let workers: DeploymentWorkerSet | undefined;

  beforeAll(async () => {
    handle = await setupTestDatabase();
    queues = createDeploymentQueues({ redisUrl: TEST_REDIS_URL, prefix });
  });

  afterEach(async () => {
    if (workers !== undefined) {
      await stopWorkers(workers);
      workers = undefined;
    }
    await Promise.allSettled([
      queues.plan.obliterate({ force: true }),
      queues.deploy.obliterate({ force: true }),
      queues.verify.obliterate({ force: true }),
    ]);
  });

  afterAll(async () => {
    await queues.close();
    if (handle !== undefined) await handle.close();
  });

  function db(): Database {
    if (handle === undefined) throw new Error("test database is not ready");
    return handle.db;
  }

  async function start(
    handlers: NonNullable<Parameters<typeof startWorkers>[0]["handlers"]>,
  ): Promise<DeploymentWorkerSet> {
    workers = await startWorkers({
      db: db(),
      redisUrl: TEST_REDIS_URL,
      prefix,
      handlers,
    });
    return workers;
  }

  it("processes a job once across a retry simulation", async () => {
    const seed = await seedDeployment(db(), { state: "RECEIVED" });
    let calls = 0;
    await start({
      plan: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TapeCiError("INTERNAL", "transient planning error", { retryable: true });
        }
      },
    });

    await enqueueDeployment(queues.plan, seed.deploymentId, {
      attempts: 2,
      backoff: { type: "fixed", delay: 10 },
    });
    const finished = await waitForJob(queues.plan, seed.deploymentId);
    expect(finished.state).toBe("completed");
    // `attemptsMade` is incremented by BullMQ while it moves the failed job back
    // to the queue, so the completed snapshot can observe 1 or 2. The handler
    // call count is the deterministic proof that the retry actually ran.
    expect(finished.attemptsMade).toBeGreaterThanOrEqual(1);
    expect(calls).toBe(2);
    // The fake handler does not apply success states; the worker must not invent one.
    const deployment = await getDeployment(db(), seed.deploymentId);
    expect(deployment?.state).toBe("RECEIVED");
    expect(await listDeploymentEvents(db(), seed.deploymentId)).toHaveLength(0);
  });

  it("idempotent enqueue: duplicate jobId is processed once", async () => {
    const seed = await seedDeployment(db(), { state: "RECEIVED" });
    let calls = 0;
    await enqueueDeployment(queues.plan, seed.deploymentId);
    await enqueueDeployment(queues.plan, seed.deploymentId);
    await start({
      plan: async () => {
        calls += 1;
      },
    });

    const finished = await waitForJob(queues.plan, seed.deploymentId);
    expect(finished.state).toBe("completed");
    expect(calls).toBe(1);
  });

  it("skips terminal deployments instead of replaying work", async () => {
    const seed = await seedDeployment(db(), { state: "LIVE" });
    let calls = 0;
    await start({
      deploy: async () => {
        calls += 1;
      },
    });

    await enqueueDeployment(queues.deploy, seed.deploymentId);
    const finished = await waitForJob(queues.deploy, seed.deploymentId);
    expect(finished.state).toBe("completed");
    expect(calls).toBe(0);

    const job = await queues.deploy.getJob(seed.deploymentId);
    expect(job?.returnvalue).toMatchObject({ status: "SKIPPED", state: "LIVE" });
  });

  it("deploy worker holds the per-container lock while handling", async () => {
    const seed = await seedDeployment(db(), { state: "APPROVED" });
    const probe = new ContainerLock({ redisUrl: TEST_REDIS_URL });
    let observedLocked = false;
    try {
      await start({
        deploy: async () => {
          try {
            const stolen = await probe.acquire(seed.containerAddress, {
              ttlMs: 5_000,
              timeoutMs: 100,
              retryIntervalMs: 10,
            });
            await stolen.release();
          } catch (error) {
            if (error instanceof TapeCiError && error.code === "UPLOAD_INTERRUPTED") {
              observedLocked = true;
              return;
            }
            throw error;
          }
          throw new TapeCiError("INTERNAL", "worker did not hold the container lock", {
            retryable: false,
          });
        },
      });

      await enqueueDeployment(queues.deploy, seed.deploymentId);
      const finished = await waitForJob(queues.deploy, seed.deploymentId);
      expect(finished.state).toBe("completed");
      expect(observedLocked).toBe(true);

      // The lock is released after the handler returns.
      const after = await probe.acquire(seed.containerAddress, { ttlMs: 5_000, timeoutMs: 500 });
      await expect(after.release()).resolves.toBe(true);
    } finally {
      await probe.close();
    }
  });

  it("maps a non-retryable handler error to the failure state and appends an event", async () => {
    const seed = await seedDeployment(db(), { state: "APPROVED" });
    await start({
      deploy: async () => {
        throw new TapeCiError("FEE_OVER_BUDGET", "estimated cost above approved cap", {
          retryable: false,
        });
      },
    });

    await enqueueDeployment(queues.deploy, seed.deploymentId);
    const finished = await waitForJob(queues.deploy, seed.deploymentId);
    expect(finished.state).toBe("failed");
    expect(finished.attemptsMade).toBe(1);

    const deployment = await getDeployment(db(), seed.deploymentId);
    expect(deployment?.state).toBe("FEE_OVER_BUDGET");
    expect(deployment?.errorCode).toBe("FEE_OVER_BUDGET");
    expect(deployment?.finishedAt).not.toBeNull();

    const events = await listDeploymentEvents(db(), seed.deploymentId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      oldState: "APPROVED",
      newState: "FEE_OVER_BUDGET",
      eventType: "worker.deploy.failed",
      actorKind: "worker",
      payload: { errorCode: "FEE_OVER_BUDGET", retryable: false },
    });
  });

  it("maps exhausted retryable errors to the queue's fallback failure state", async () => {
    const seed = await seedDeployment(db(), { state: "UPLOADING_ASSETS" });
    await start({
      deploy: async () => {
        throw new TapeCiError("INTERNAL", "RPC unavailable", { retryable: true });
      },
    });

    await enqueueDeployment(queues.deploy, seed.deploymentId, {
      attempts: 2,
      backoff: { type: "fixed", delay: 10 },
    });
    const finished = await waitForJob(queues.deploy, seed.deploymentId);
    expect(finished.state).toBe("failed");
    expect(finished.attemptsMade).toBe(2);

    const deployment = await getDeployment(db(), seed.deploymentId);
    expect(deployment?.state).toBe("UPLOAD_INTERRUPTED");
    const events = await listDeploymentEvents(db(), seed.deploymentId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("worker.deploy.failed");
  });
});
