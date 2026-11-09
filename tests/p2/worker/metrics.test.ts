import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  QUEUE_NAMES,
  WorkerMetrics,
  startWorkerHealthServer,
  type QueueCounts,
  type QueueName,
  type WorkerHealthServer,
} from "../../../apps/api/src/worker/metrics.js";

const counts: Readonly<Record<QueueName, QueueCounts>> = {
  plan: { waiting: 1, active: 0, completed: 4, failed: 0, delayed: 0, paused: 0 },
  deploy: { waiting: 0, active: 1, completed: 2, failed: 1, delayed: 0, paused: 0 },
  verify: { waiting: 2, active: 0, completed: 0, failed: 0, delayed: 1, paused: 0 },
};

describe("worker health + metrics", () => {
  let metrics: WorkerMetrics;
  let health: WorkerHealthServer;
  let databaseReady = true;
  let redisReady = true;

  beforeAll(async () => {
    metrics = new WorkerMetrics();
    metrics.recordStarted("plan");
    metrics.recordCompleted("plan", 1_500);
    metrics.recordStarted("deploy");
    metrics.recordFailed("deploy", "FEE_OVER_BUDGET");
    metrics.recordReconcileSuccess(
      { listed: 3, created: 0, updated: 2, markedDeleted: 1, suspended: 1 },
      250,
    );
    metrics.recordReconcileFailure(50);
    health = await startWorkerHealthServer({
      port: 0,
      host: "127.0.0.1",
      metrics,
      checks: {
        database: async () => databaseReady,
        redis: async () => redisReady,
        queues: async () => counts,
      },
    });
  });

  afterAll(async () => {
    await health?.close();
  });

  it("serves liveness without touching dependencies", async () => {
    databaseReady = false;
    redisReady = false;
    const response = await fetch(`${health.url}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("tapeci-worker");
    databaseReady = true;
    redisReady = true;
  });

  it("reports readiness and dependency failures", async () => {
    const ready = await fetch(`${health.url}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ready" });

    databaseReady = false;
    const notReady = await fetch(`${health.url}/readyz`);
    expect(notReady.status).toBe(503);
    expect((await notReady.json()) as { checks: { database: boolean } }).toMatchObject({
      status: "not_ready",
      checks: { database: false },
    });
    databaseReady = true;
  });

  it("renders Prometheus counters, durations, failures and queue state", async () => {
    const response = await fetch(`${health.url}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    expect(text).toContain("tapeci_worker_up 1");
    expect(text).toContain('tapeci_worker_jobs_total{queue="plan",status="completed"} 1');
    expect(text).toContain('tapeci_worker_jobs_total{queue="deploy",status="failed"} 1');
    expect(text).toContain('tapeci_worker_job_duration_seconds_sum{queue="plan"} 1.5');
    expect(text).toContain(
      'tapeci_worker_job_failures_total{queue="deploy",code="FEE_OVER_BUDGET"} 1',
    );
    expect(text).toContain('tapeci_queue_jobs{queue="verify",state="waiting"} 2');
    expect(text).toContain('tapeci_worker_dependency_ready{dependency="postgres"} 1');
    expect(text).toContain("tapeci_worker_reconcile_runs_total 2");
    expect(text).toContain("tapeci_worker_reconcile_failures_total 1");
    expect(text).toContain("tapeci_worker_reconcile_last_listed 3");
    expect(text).toContain("tapeci_worker_reconcile_last_marked_deleted 1");
    expect(text).toContain("tapeci_worker_reconcile_last_duration_seconds 0.05");
    expect(text).toContain("tapeci_queue_jobs");
    // Every queue appears in the gauge.
    for (const queue of QUEUE_NAMES) {
      expect(text).toContain(`queue="${queue}"`);
    }
  });

  it("returns 404/405 for unknown routes and methods", async () => {
    expect((await fetch(`${health.url}/nope`)).status).toBe(404);
    expect((await fetch(`${health.url}/healthz`, { method: "POST" })).status).toBe(405);
  });
});
