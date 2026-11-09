/**
 * API observability: request counters/latency + readiness + Prometheus output.
 *
 * `/metrics` is public by default for a loopback/sidecar deployment; set
 * TAPECI_METRICS_TOKEN to require `Authorization: Bearer <token>` when the API is
 * reachable from a broader network. Labels are route patterns, never raw URLs.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { checkRedisAvailable } from "@tapeci/queue";
import type { ApiDeps } from "./deps.js";
import { ApiError } from "./errors.js";
import { auditScopeResolveFailureCount } from "./audit.js";

const SKIP_ROUTES = new Set(["/metrics", "/readyz", "/health"]);

interface RequestKey {
  readonly method: string;
  readonly route: string;
  readonly status: string;
}

interface RequestStats {
  count: number;
  durationMs: number;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class ApiMetrics {
  readonly startedAt = Date.now();
  private readonly requests = new Map<string, RequestStats>();
  private inFlight = 0;

  begin(request: FastifyRequest): void {
    this.inFlight += 1;
    request.metricsStartedAt = process.hrtime.bigint();
  }

  end(request: FastifyRequest, reply: FastifyReply): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const route = request.routeOptions?.url;
    if (route === undefined || SKIP_ROUTES.has(route)) return;
    const started = request.metricsStartedAt;
    const durationMs =
      started === undefined ? 0 : Number(process.hrtime.bigint() - started) / 1_000_000;
    const key: RequestKey = {
      method: request.method,
      route,
      status: String(reply.statusCode),
    };
    const id = `${key.method}|${key.route}|${key.status}`;
    const stats = this.requests.get(id) ?? { count: 0, durationMs: 0 };
    stats.count += 1;
    stats.durationMs += durationMs;
    this.requests.set(id, stats);
  }

  render(input: { readonly ready: boolean; readonly databaseReady: boolean; readonly redisReady: boolean }): string {
    const now = Date.now();
    const lines: string[] = [];
    const gauge = (name: string, help: string, value: number, labels = ""): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${labels} ${value}`);
    };
    gauge("tapeci_api_up", "API process is running", 1);
    gauge("tapeci_api_start_time_seconds", "API process start time (unix)", this.startedAt / 1000);
    gauge("tapeci_api_uptime_seconds", "API process uptime", (now - this.startedAt) / 1000);
    gauge("tapeci_api_ready", "API readiness (dependencies reachable)", input.ready ? 1 : 0);
    gauge(
      "tapeci_api_dependency_ready",
      "API dependency readiness",
      input.databaseReady ? 1 : 0,
      '{dependency="postgres"}',
    );
    gauge(
      "tapeci_api_dependency_ready",
      "API dependency readiness",
      input.redisReady ? 1 : 0,
      '{dependency="redis"}',
    );
    gauge("tapeci_api_http_in_flight", "Requests currently being handled", this.inFlight);
    gauge(
      "tapeci_audit_scope_resolve_failures_total",
      "Audit rows whose project/organization scope could not be resolved",
      auditScopeResolveFailureCount(),
    );

    const total: string[] = ["# HELP tapeci_api_http_requests_total HTTP requests by route and status"];
    total.push("# TYPE tapeci_api_http_requests_total counter");
    const durationSum: string[] = [
      "# HELP tapeci_api_http_request_duration_seconds_sum Total request handling time",
      "# TYPE tapeci_api_http_request_duration_seconds_sum counter",
    ];
    const durationCount: string[] = [
      "# HELP tapeci_api_http_request_duration_seconds_count Requests by route (duration count)",
      "# TYPE tapeci_api_http_request_duration_seconds_count counter",
    ];
    for (const [id, stats] of [...this.requests.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [method, route, status] = id.split("|") as [string, string, string];
      const labels = `{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${escapeLabel(status)}"}`;
      total.push(`tapeci_api_http_requests_total${labels} ${stats.count}`);
      const routeLabels = `{method="${escapeLabel(method)}",route="${escapeLabel(route)}"}`;
      durationSum.push(`tapeci_api_http_request_duration_seconds_sum${routeLabels} ${stats.durationMs / 1000}`);
      durationCount.push(`tapeci_api_http_request_duration_seconds_count${routeLabels} ${stats.count}`);
    }
    lines.push(...total, ...durationSum, ...durationCount);
    return `${lines.join("\n")}\n`;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    metricsStartedAt?: bigint;
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

function metricsAuthorized(request: FastifyRequest, token: string | null | undefined): boolean {
  if (token === null || token === undefined || token.length === 0) return true;
  const header = request.headers.authorization;
  return header === `Bearer ${token}`;
}

export function registerApiMetrics(app: FastifyInstance, deps: ApiDeps): void {
  const metrics = new ApiMetrics();
  app.addHook("onRequest", async (request) => {
    metrics.begin(request);
  });
  app.addHook("onResponse", async (request, reply) => {
    metrics.end(request, reply);
  });

  const checks = async (): Promise<{ databaseReady: boolean; redisReady: boolean }> => {
    const [database, redis] = await Promise.all([
      withTimeout(deps.db.$client.query("select 1")).then((result) => result !== null),
      withTimeout(checkRedisAvailable({ url: deps.env.redisUrl, timeoutMs: 1_000 })).then(
        (result) => result === true,
      ),
    ]);
    return { databaseReady: database, redisReady: redis };
  };

  app.get("/readyz", async (_request, reply) => {
    const { databaseReady, redisReady } = await checks();
    const ready = databaseReady && redisReady;
    void reply.code(ready ? 200 : 503);
    return {
      status: ready ? "ready" : "not_ready",
      checks: { database: databaseReady, redis: redisReady },
    };
  });

  app.get("/metrics", async (request, reply) => {
    if (!metricsAuthorized(request, deps.env.metricsToken)) {
      throw new ApiError(401, "AUTH_REQUIRED", "metrics token required");
    }
    const { databaseReady, redisReady } = await checks();
    const text = metrics.render({
      ready: databaseReady && redisReady,
      databaseReady,
      redisReady,
    });
    void reply
      .code(200)
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .header("cache-control", "no-store");
    return text;
  });
}
