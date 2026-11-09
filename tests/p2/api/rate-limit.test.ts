import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
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
import { FixedWindowRateLimiter, RedisFixedWindowRateLimiter } from "../../../apps/api/src/rate-limit.js";
import { checkRedisAvailable, createRedisClient } from "@tapeci/queue";

const available = await databaseAvailable();
const redisAvailable = await checkRedisAvailable({ url: "redis://127.0.0.1:56379" });

const baseEnv: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: "rate-limit-test-secret-123456",
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
  rateLimitPerMinute: 2,
  rateLimitDisabled: false,
  auditDisabled: true,
};

describe("fixed window rate limiter", () => {
  it.skipIf(!redisAvailable)("shares the fixed window through Redis", async () => {
    const client = createRedisClient("redis://127.0.0.1:56379");
    try {
      const limiter = new RedisFixedWindowRateLimiter(client, 2, 60_000, "tapeci:test:rl:");
      const key = `unit-${Date.now()}-${Math.random()}`;
      expect((await limiter.check(key)).allowed).toBe(true);
      expect((await limiter.check(key)).allowed).toBe(true);
      const blocked = await limiter.check(key);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      await client.del(`tapeci:test:rl:${key}`);
    } finally {
      await client.quit();
    }
  });

  it("allows the limit then rejects with a retry hint", () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);
    expect(limiter.check("a", 1_000).allowed).toBe(true);
    expect(limiter.check("a", 1_000).allowed).toBe(true);
    const blocked = limiter.check("a", 1_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
    expect(limiter.check("b", 1_000).allowed).toBe(true);
    expect(limiter.check("a", 61_001).allowed).toBe(true);
  });
});

describe.skipIf(!available)("API rate limiting", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrateUp(database.url);
    handle = createDatabase(database.url);
    db = handle.db;
    app = buildApp({ db, env: baseEnv } satisfies ApiDeps);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await handle?.pool.end();
    await database?.drop();
  }, 30_000);

  it.skipIf(!redisAvailable)("uses the Redis backend across the app", async () => {
    const redis = createRedisClient("redis://127.0.0.1:56379");
    const keys = await redis.keys("tapeci:ratelimit:*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
    const redisApp = buildApp({
      db,
      env: { ...baseEnv, rateLimitBackend: "redis", rateLimitPerMinute: 1 },
    } satisfies ApiDeps);
    await redisApp.ready();
    try {
      // Unique user per run: the Redis fixed window survives across test runs.
      const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const headers = {
        "x-tapeci-github-login": `redis-rate-user-${unique}`,
        "x-tapeci-github-user-id": unique,
      };
      expect((await redisApp.inject({ method: "GET", url: "/v1/me", headers })).statusCode).toBe(200);
      const blocked = await redisApp.inject({ method: "GET", url: "/v1/me", headers });
      expect(blocked.statusCode).toBe(429);
    } finally {
      await redisApp.close();
    }
  });

  it("returns 429 after the per-route budget and skips health probes", async () => {
    const headers = {
      "x-tapeci-github-login": "rate-user",
      "x-tapeci-github-user-id": "9999",
    };
    expect((await app.inject({ method: "GET", url: "/v1/me", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/me", headers })).statusCode).toBe(200);
    const blocked = await app.inject({ method: "GET", url: "/v1/me", headers });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect((blocked.json() as { error: { code: string } }).error.code).toBe("RATE_LIMITED");

    for (let index = 0; index < 5; index += 1) {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    }
  });
});
