import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { checkRedisAvailable } from "@tapeci/queue";
import {
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  migrateUp,
  type Database,
} from "@tapeci/database";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";

const available = await databaseAvailable();
const redisAvailable = await checkRedisAvailable({ url: "redis://127.0.0.1:56379" });

const env: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: "metrics-test-session-secret-123",
  devAuth: true,
  objectStoreDir: ".tapeci/objects",
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: "webhook-secret",
  githubOidcAudience: "tapeci-artifact-upload",
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
  githubAppSlug: null,
  githubOAuthClientId: null,
  githubOAuthClientSecret: null,
  githubOAuthBaseUrl: "https://github.com",
  githubApiBaseUrl: "https://api.github.com",
  publicApiUrl: "http://127.0.0.1:8787",
  webUrl: "http://127.0.0.1:3000",
  sessionTtlSeconds: 3600,
  operatorPrivateKey: null,
  writeRpcUrl: null,
  journalDir: ".tapeci/journal",
  cookieDomain: null,
  maxGasPriceWei: null,
  metricsToken: null,
};

describe.skipIf(!available)("API metrics and readiness", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;
  let secured: FastifyInstance;

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrateUp(database.url);
    handle = createDatabase(database.url);
    db = handle.db;
    app = buildApp({ db, env } satisfies ApiDeps);
    await app.ready();
    secured = buildApp({ db, env: { ...env, metricsToken: "secret-token" } } satisfies ApiDeps);
    await secured.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await secured?.close();
    await handle?.pool.end();
    await database?.drop();
  }, 30_000);

  it("serves Prometheus request metrics and readiness", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { "x-tapeci-github-login": "metrics-user", "x-tapeci-github-user-id": "8888" },
    });
    expect(me.statusCode).toBe(200);
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    const text = metrics.body;
    expect(text).toContain("tapeci_api_up 1");
    expect(text).toContain('tapeci_api_http_requests_total{method="GET",route="/v1/me",status="200"} 1');
    expect(text).toContain('tapeci_api_http_request_duration_seconds_count{method="GET",route="/v1/me"} 1');

    const ready = await app.inject({ method: "GET", url: "/readyz" });
    if (redisAvailable) {
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({
        status: "ready",
        checks: { database: true, redis: true },
      });
    } else {
      expect(ready.statusCode).toBe(503);
    }
  });

  it("enforces the optional metrics bearer token", async () => {
    expect((await secured.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    const allowed = await secured.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(allowed.statusCode).toBe(200);
  });
});
