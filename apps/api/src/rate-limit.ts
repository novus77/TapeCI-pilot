/**
 * Fixed-window rate limiting.
 *
 * `memory` is per-process (single instance / tests). `redis` shares the window
 * across API instances via INCR + PEXPIRE in one Lua script. If Redis is
 * unavailable the request falls back to the in-process limiter and logs a
 * warning, so an outage degrades to per-instance protection instead of
 * failing the API open (documented trade-off).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { createRedisClient } from "@tapeci/queue";

type RedisClient = ReturnType<typeof createRedisClient>;

const SKIP_PREFIXES = ["/health", "/readyz", "/metrics", "/v1/github/webhook"];

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  readonly remaining: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  check(key: string, now = Date.now()): RateLimitDecision {
    const current = this.buckets.get(key);
    if (current === undefined || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.buckets.size > 10_000) this.prune(now);
      return { allowed: true, retryAfterSeconds: 0, remaining: this.limit - 1 };
    }
    if (current.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
        remaining: 0,
      };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0, remaining: this.limit - current.count };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

const REDIS_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if current == 1 or ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

export class RedisFixedWindowRateLimiter {
  constructor(
    private readonly client: RedisClient,
    readonly limit: number,
    readonly windowMs: number,
    private readonly prefix = "tapeci:ratelimit:",
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    const result = (await this.client.eval(
      REDIS_SCRIPT,
      1,
      `${this.prefix}${key}`,
      String(this.windowMs),
    )) as [number | string, number | string];
    const count = Number(result[0]);
    const ttlMs = Number(result[1]);
    if (count > this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
        remaining: 0,
      };
    }
    return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, this.limit - count) };
  }
}

export interface RateLimitOptions {
  readonly perMinute: number;
  readonly disabled: boolean;
  readonly backend: "memory" | "redis";
  readonly redisUrl: string;
}

export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions): void {
  if (options.disabled) return;
  const memory = new FixedWindowRateLimiter(options.perMinute, 60_000);
  let redisLimiter: RedisFixedWindowRateLimiter | null = null;
  let redisClient: RedisClient | null = null;
  if (options.backend === "redis") {
    redisClient = createRedisClient(options.redisUrl, { maxRetriesPerRequest: 1 });
    redisLimiter = new RedisFixedWindowRateLimiter(redisClient, options.perMinute, 60_000);
    app.addHook("onClose", async () => {
      await redisClient?.quit();
    });
  }
  let warned = false;

  app.addHook("onRequest", async (request, reply: FastifyReply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (SKIP_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return;
    const route = request.routeOptions?.url ?? path;
    const key = `${request.ip}|${route}`;
    let decision: RateLimitDecision;
    if (redisLimiter !== null) {
      try {
        decision = await redisLimiter.check(key);
      } catch (error) {
        if (!warned) {
          warned = true;
          console.error(
            JSON.stringify({
              event: "rate_limit_redis_fallback",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        decision = memory.check(key);
      }
    } else {
      decision = memory.check(key);
    }
    if (decision.allowed) return;
    void reply
      .code(429)
      .header("retry-after", String(decision.retryAfterSeconds))
      .send({
        error: {
          code: "RATE_LIMITED",
          message: "too many requests; retry later",
          retryable: true,
          details: { retryAfterSeconds: decision.retryAfterSeconds },
        },
        requestId: request.id,
      });
    return reply;
  });
}
