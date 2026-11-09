import Redis, { type RedisOptions } from "ioredis";

/** Local P2 development default; production must set `REDIS_URL`. */
export const DEFAULT_REDIS_URL = "redis://127.0.0.1:56379";

export function redisUrlFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env.REDIS_URL;
  return configured === undefined || configured.trim() === "" ? DEFAULT_REDIS_URL : configured;
}

/** Minimal structural view of an ioredis client, for injectable tests. */
export interface RedisLike {
  readonly status?: string;
  connect(): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  set(...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  disconnect(): unknown;
}

/**
 * Create an ioredis client suitable for BullMQ (blocking commands need
 * `maxRetriesPerRequest: null`).
 */
export function createRedisClient(url: string = DEFAULT_REDIS_URL, options: RedisOptions = {}): Redis {
  const client = new Redis(url, { maxRetriesPerRequest: null, ...options, replyMapping: "legacy" });
  // ioredis re-emits connection failures as EventEmitter errors; without a listener
  // Node would log an "Unhandled error event". Callers still add their own handlers.
  client.on("error", () => undefined);
  return client;
}

export interface CheckRedisOptions {
  readonly timeoutMs?: number;
  readonly url?: string;
}

/** Cheap liveness probe; tests use this to skip cleanly when Redis is unavailable. */
export async function checkRedisAvailable(options: CheckRedisOptions = {}): Promise<boolean> {
  const url = options.url ?? redisUrlFromEnv();
  const timeoutMs = options.timeoutMs ?? 1_000;
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    replyMapping: "legacy",
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}
