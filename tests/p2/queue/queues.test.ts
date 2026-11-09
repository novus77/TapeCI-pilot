import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_OPTIONS,
  createDeploymentQueues,
  enqueueDeployment,
  enqueueDeploymentOn,
  type DeploymentQueues,
  type Job,
} from "@tapeci/queue";
import { detectServices, TEST_REDIS_URL } from "./helpers.js";

const services = await detectServices();
const describeRedis = services.redis ? describe : describe.skip;

describeRedis("BullMQ deployment queues", () => {
  const prefix = `tapeci-test-${randomUUID().slice(0, 8)}`;
  let queues: DeploymentQueues;

  beforeAll(() => {
    queues = createDeploymentQueues({ redisUrl: TEST_REDIS_URL, prefix });
  });

  afterEach(async () => {
    await Promise.allSettled([
      queues.plan.obliterate({ force: true }),
      queues.deploy.obliterate({ force: true }),
      queues.verify.obliterate({ force: true }),
    ]);
  });

  afterAll(async () => {
    await queues.close();
  });

  it("exposes plan/deploy/verify queues with retry and retention defaults", async () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
    expect(DEFAULT_JOB_OPTIONS.backoff).toMatchObject({ type: "exponential" });
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toMatchObject({ count: 1_000 });
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toMatchObject({ count: 5_000 });

    const deploymentId = randomUUID();
    await enqueueDeployment(queues.plan, deploymentId);
    const job = await queues.plan.getJob(deploymentId);
    expect(job).toBeDefined();
    expect(job?.name).toBe("deployment");
    expect(job?.data).toEqual({ deploymentId });
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toMatchObject({ type: "exponential" });
    expect(job?.opts.removeOnComplete).toMatchObject({ count: 1_000 });
    expect(job?.opts.removeOnFail).toMatchObject({ count: 5_000 });
  });

  it("is idempotent: adding the same deployment twice keeps one job", async () => {
    const deploymentId = randomUUID();
    const first: Job = await enqueueDeployment(queues.deploy, deploymentId);
    const second: Job = await enqueueDeployment(queues.deploy, deploymentId);

    expect(first.id).toBe(deploymentId);
    expect(second.id).toBe(deploymentId);
    const counts = await queues.deploy.getJobCounts("waiting", "delayed", "active", "completed");
    expect((counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0)).toBe(1);
    const jobs = await queues.deploy.getJobs(["waiting", "delayed", "active"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(deploymentId);
  });

  it("enqueues onto the requested queue by name", async () => {
    const planId = randomUUID();
    const verifyId = randomUUID();
    await enqueueDeploymentOn(queues, "plan", planId);
    await enqueueDeploymentOn(queues, "verify", verifyId);
    expect(await queues.plan.getJob(planId)).toBeDefined();
    expect(await queues.verify.getJob(verifyId)).toBeDefined();
    expect(await queues.deploy.getJob(planId)).toBeUndefined();
  });

  it("rejects a mismatched jobId and malformed deployment ids", async () => {
    const deploymentId = randomUUID();
    await expect(
      enqueueDeployment(queues.deploy, deploymentId, { jobId: "some-other-id" }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(enqueueDeployment(queues.deploy, "not-a-uuid")).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });
});
