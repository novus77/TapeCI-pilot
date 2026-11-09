/**
 * Worker observability: a small Prometheus registry and an HTTP health server.
 *
 * Endpoints (default 127.0.0.1:8788):
 *   GET /healthz  liveness (process up; no dependencies)
 *   GET /readyz   readiness (Postgres + Redis + queue count probe)
 *   GET /metrics  Prometheus text exposition
 *
 * No external metrics library: the surface is intentionally small and auditable.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type QueueName = "plan" | "deploy" | "verify";
export const QUEUE_NAMES: readonly QueueName[] = ["plan", "deploy", "verify"];

export interface QueueCounts {
  readonly waiting: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly delayed: number;
  readonly paused: number;
}

export interface WorkerHealthChecks {
  readonly database: () => Promise<boolean>;
  readonly redis: () => Promise<boolean>;
  readonly queues: () => Promise<Readonly<Record<QueueName, QueueCounts>>>;
}

interface ReconcileStats {
  runs: number;
  failures: number;
  lastSuccessAt: number | null;
  lastDurationMs: number | null;
  listed: number | null;
  created: number | null;
  updated: number | null;
  markedDeleted: number | null;
  suspended: number | null;
}

interface QueueStats {
  started: number;
  completed: number;
  failed: number;
  durationMs: number;
  lastJobAt: number | null;
  readonly failuresByCode: Map<string, number>;
}

function emptyStats(): QueueStats {
  return { started: 0, completed: 0, failed: 0, durationMs: 0, lastJobAt: null, failuresByCode: new Map() };
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class WorkerMetrics {
  readonly startedAt = Date.now();
  private readonly stats: Record<QueueName, QueueStats> = {
    plan: emptyStats(),
    deploy: emptyStats(),
    verify: emptyStats(),
  };
  private readonly reconcile: ReconcileStats = {
    runs: 0,
    failures: 0,
    lastSuccessAt: null,
    lastDurationMs: null,
    listed: null,
    created: null,
    updated: null,
    markedDeleted: null,
    suspended: null,
  };

  recordStarted(queue: QueueName): void {
    this.stats[queue].started += 1;
  }

  recordCompleted(queue: QueueName, durationMs: number | null): void {
    const stats = this.stats[queue];
    stats.completed += 1;
    stats.lastJobAt = Date.now();
    if (durationMs !== null && Number.isFinite(durationMs) && durationMs >= 0) {
      stats.durationMs += durationMs;
    }
  }

  recordReconcileSuccess(
    result: {
      readonly listed: number;
      readonly created: number;
      readonly updated: number;
      readonly markedDeleted: number;
      readonly suspended: number;
    },
    durationMs: number,
  ): void {
    this.reconcile.runs += 1;
    this.reconcile.lastSuccessAt = Date.now();
    this.reconcile.lastDurationMs = durationMs;
    this.reconcile.listed = result.listed;
    this.reconcile.created = result.created;
    this.reconcile.updated = result.updated;
    this.reconcile.markedDeleted = result.markedDeleted;
    this.reconcile.suspended = result.suspended;
  }

  recordReconcileFailure(durationMs: number): void {
    this.reconcile.runs += 1;
    this.reconcile.failures += 1;
    this.reconcile.lastDurationMs = durationMs;
  }

  recordFailed(queue: QueueName, code: string): void {
    const stats = this.stats[queue];
    stats.failed += 1;
    stats.lastJobAt = Date.now();
    const safeCode = code.length === 0 ? "INTERNAL" : code;
    stats.failuresByCode.set(safeCode, (stats.failuresByCode.get(safeCode) ?? 0) + 1);
  }

  render(input: {
    readonly ready: boolean;
    readonly databaseReady: boolean;
    readonly redisReady: boolean;
    readonly queueCounts: Readonly<Record<QueueName, QueueCounts>>;
  }): string {
    const lines: string[] = [];
    const now = Date.now();
    const gauge = (name: string, help: string, value: number, labels = ""): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${labels} ${value}`);
    };
    const counter = (
      name: string,
      help: string,
      samples: readonly { labels: string; value: number }[],
    ): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const sample of samples) lines.push(`${name}${sample.labels} ${sample.value}`);
    };

    gauge("tapeci_worker_up", "Worker process is running", 1);
    gauge("tapeci_worker_start_time_seconds", "Worker process start time (unix)", this.startedAt / 1000);
    gauge("tapeci_worker_uptime_seconds", "Worker process uptime", (now - this.startedAt) / 1000);
    gauge("tapeci_worker_ready", "Worker readiness (dependencies reachable)", input.ready ? 1 : 0);
    gauge(
      "tapeci_worker_dependency_ready",
      "Dependency readiness",
      input.databaseReady ? 1 : 0,
      '{dependency="postgres"}',
    );
    gauge(
      "tapeci_worker_dependency_ready",
      "Dependency readiness",
      input.redisReady ? 1 : 0,
      '{dependency="redis"}',
    );

    const jobSamples: Array<{ labels: string; value: number }> = [];
    const durationSum: Array<{ labels: string; value: number }> = [];
    const durationCount: Array<{ labels: string; value: number }> = [];
    const lastJob: Array<{ labels: string; value: number }> = [];
    for (const queue of QUEUE_NAMES) {
      const stats = this.stats[queue];
      for (const [status, value] of [
        ["started", stats.started],
        ["completed", stats.completed],
        ["failed", stats.failed],
      ] as const) {
        jobSamples.push({
          labels: `{queue="${queue}",status="${status}"}`,
          value,
        });
      }
      durationSum.push({
        labels: `{queue="${queue}"}`,
        value: stats.durationMs / 1000,
      });
      durationCount.push({
        labels: `{queue="${queue}"}`,
        value: stats.completed,
      });
      if (stats.lastJobAt !== null) {
        lastJob.push({ labels: `{queue="${queue}"}`, value: stats.lastJobAt / 1000 });
      }
    }
    counter("tapeci_worker_jobs_total", "Worker jobs by queue and status", jobSamples);
    counter(
      "tapeci_worker_job_duration_seconds_sum",
      "Total job handling time by queue",
      durationSum,
    );
    counter(
      "tapeci_worker_job_duration_seconds_count",
      "Completed jobs by queue (duration count)",
      durationCount,
    );
    counter("tapeci_worker_last_job_timestamp_seconds", "Last finished job timestamp (unix)", lastJob);

    const failureSamples: Array<{ labels: string; value: number }> = [];
    for (const queue of QUEUE_NAMES) {
      for (const [code, value] of this.stats[queue].failuresByCode) {
        failureSamples.push({
          labels: `{queue="${queue}",code="${escapeLabel(code)}"}`,
          value,
        });
      }
    }
    counter("tapeci_worker_job_failures_total", "Failed jobs by queue and error code", failureSamples);

    counter("tapeci_worker_reconcile_runs_total", "Installation reconciliation runs", [
      { labels: "", value: this.reconcile.runs },
    ]);
    counter(
      "tapeci_worker_reconcile_failures_total",
      "Installation reconciliation failures",
      [{ labels: "", value: this.reconcile.failures }],
    );
    gauge(
      "tapeci_worker_reconcile_last_success_timestamp_seconds",
      "Last successful reconciliation (unix)",
      this.reconcile.lastSuccessAt === null ? 0 : this.reconcile.lastSuccessAt / 1000,
    );
    gauge(
      "tapeci_worker_reconcile_last_duration_seconds",
      "Last reconciliation duration",
      (this.reconcile.lastDurationMs ?? 0) / 1000,
    );
    for (const [name, value] of [
      ["listed", this.reconcile.listed],
      ["created", this.reconcile.created],
      ["updated", this.reconcile.updated],
      ["marked_deleted", this.reconcile.markedDeleted],
      ["suspended", this.reconcile.suspended],
    ] as const) {
      gauge(
        `tapeci_worker_reconcile_last_${name}`,
        `Reconciliation result: ${name}`,
        value ?? 0,
      );
    }

    const queueSamples: Array<{ labels: string; value: number }> = [];
    for (const queue of QUEUE_NAMES) {
      const counts = input.queueCounts[queue];
      for (const [state, value] of Object.entries(counts)) {
        queueSamples.push({ labels: `{queue="${queue}",state="${state}"}`, value });
      }
    }
    lines.push("# HELP tapeci_queue_jobs BullMQ queue job counts");
    lines.push("# TYPE tapeci_queue_jobs gauge");
    for (const sample of queueSamples) {
      lines.push(`tapeci_queue_jobs${sample.labels} ${sample.value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

export interface WorkerHealthServerOptions {
  readonly port: number;
  readonly host: string;
  readonly metrics: WorkerMetrics;
  readonly checks: WorkerHealthChecks;
}

export interface WorkerHealthServer {
  readonly url: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export async function startWorkerHealthServer(
  options: WorkerHealthServerOptions,
): Promise<WorkerHealthServer> {
  const emptyCounts: Record<QueueName, QueueCounts> = {
    plan: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 },
    deploy: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 },
    verify: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 },
  };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = request.url?.split("?")[0] ?? "/";
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "method not allowed" });
        return;
      }
      if (url === "/healthz") {
        sendJson(response, 200, {
          status: "ok",
          service: "tapeci-worker",
          uptimeSeconds: Math.floor((Date.now() - options.metrics.startedAt) / 1000),
        });
        return;
      }
      if (url === "/readyz") {
        const [databaseReady, redisReady, queueResult] = await Promise.all([
          withTimeout(options.checks.database()).then((value) => value === true),
          withTimeout(options.checks.redis()).then((value) => value === true),
          withTimeout(options.checks.queues()),
        ]);
        const ready = databaseReady && redisReady && queueResult !== null;
        sendJson(response, ready ? 200 : 503, {
          status: ready ? "ready" : "not_ready",
          checks: { database: databaseReady, redis: redisReady, queues: queueResult !== null },
        });
        return;
      }
      if (url === "/metrics") {
        const [databaseReady, redisReady, queueResult] = await Promise.all([
          withTimeout(options.checks.database()).then((value) => value === true),
          withTimeout(options.checks.redis()).then((value) => value === true),
          withTimeout(options.checks.queues()),
        ]);
        const ready = databaseReady && redisReady && queueResult !== null;
        const text = options.metrics.render({
          ready,
          databaseReady,
          redisReady,
          queueCounts: queueResult ?? emptyCounts,
        });
        response.writeHead(200, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "content-length": Buffer.byteLength(text),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(text);
        return;
      }
      sendJson(response, 404, { error: "not found" });
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: "internal error",
          detail: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    url: `http://${options.host}:${actualPort}`,
    port: actualPort,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
