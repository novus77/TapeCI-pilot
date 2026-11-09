import { randomBytes } from "node:crypto";
import type Redis from "ioredis";
import { TapeCiError } from "@tapeci/shared";
import { createRedisClient, redisUrlFromEnv } from "./redis.js";
import { normalizeAddress } from "./validation.js";

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 50;

/** Release only if we still own the token (atomic token-checked delete). */
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Extend TTL only if we still own the token. */
const REFRESH_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

export interface ContainerLockOptions {
  /** Redis URL; ignored when `redis` is injected. Defaults to `REDIS_URL`. */
  readonly redisUrl?: string;
  /** Injected ioredis client (caller keeps ownership; `close()` will not quit it). */
  readonly redis?: Redis;
  /** Redis key namespace. Defaults to `tapeci`. */
  readonly keyPrefix?: string;
  readonly defaultTtlMs?: number;
  readonly defaultAcquireTimeoutMs?: number;
  readonly defaultRetryIntervalMs?: number;
}

export interface AcquireLockOptions {
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly retryIntervalMs?: number;
}

export interface ContainerLockHandle {
  readonly container: string;
  readonly key: string;
  readonly token: string;
  readonly ttlMs: number;
  /** Renew the lease. Returns `false` when the lock was lost/expired. */
  refresh(ttlMs?: number): Promise<boolean>;
  /** Release the lease if still owned. Returns `true` when this call deleted it. */
  release(): Promise<boolean>;
}

/** Minimal lock surface consumed by workers; `ContainerLock` implements it. */
export interface ContainerLockLike {
  acquire(container: string, options?: AcquireLockOptions): Promise<ContainerLockHandle>;
}

/** `tapeci:container:<lowercase-address>:lock` per P2 API contract. */
export function containerLockKey(container: string, keyPrefix = "tapeci"): string {
  return `${keyPrefix}:container:${normalizeAddress(container, "container").toLowerCase()}:lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function evalSucceeded(result: unknown): boolean {
  return Number(result) === 1;
}

function lockBackendError(error: unknown, container: string): TapeCiError {
  if (error instanceof TapeCiError) return error;
  return new TapeCiError("UPLOAD_INTERRUPTED", `container lock backend unavailable for ${container}`, {
    retryable: true,
    details: { container },
    cause: error,
  });
}

class RedisLockHandle implements ContainerLockHandle {
  constructor(
    private readonly redis: Redis,
    readonly container: string,
    readonly key: string,
    readonly token: string,
    readonly ttlMs: number,
  ) {}

  async refresh(ttlMs: number = this.ttlMs): Promise<boolean> {
    const result = await this.redis.eval(REFRESH_SCRIPT, 1, this.key, this.token, String(ttlMs));
    return evalSucceeded(result);
  }

  async release(): Promise<boolean> {
    const result = await this.redis.eval(RELEASE_SCRIPT, 1, this.key, this.token);
    return evalSucceeded(result);
  }
}

/**
 * Per-container mutual exclusion for chain-mutating work (PRD §6.2, §8).
 *
 * - acquire: `SET key <token> NX PX <ttl>`
 * - refresh / release: token-checked Lua, so a stale holder can never release or
 *   extend a lock now owned by somebody else.
 *
 * Acquisition waits up to `timeoutMs`; failure is a retryable `UPLOAD_INTERRUPTED`.
 */
export class ContainerLock {
  private readonly redis: Redis;
  private readonly ownsConnection: boolean;
  private readonly keyPrefix: string;
  private readonly defaultTtlMs: number;
  private readonly defaultAcquireTimeoutMs: number;
  private readonly defaultRetryIntervalMs: number;

  constructor(options: ContainerLockOptions = {}) {
    this.ownsConnection = options.redis === undefined;
    this.redis = options.redis ?? createRedisClient(options.redisUrl ?? redisUrlFromEnv());
    this.keyPrefix = options.keyPrefix ?? "tapeci";
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.defaultAcquireTimeoutMs = options.defaultAcquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    this.defaultRetryIntervalMs = options.defaultRetryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  }

  /** Underlying client (for tests / graceful shutdown). */
  get client(): Redis {
    return this.redis;
  }

  async acquire(container: string, options: AcquireLockOptions = {}): Promise<ContainerLockHandle> {
    const address = normalizeAddress(container, "container");
    const key = containerLockKey(address, this.keyPrefix);
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    const timeoutMs = options.timeoutMs ?? this.defaultAcquireTimeoutMs;
    const retryIntervalMs = options.retryIntervalMs ?? this.defaultRetryIntervalMs;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new TapeCiError("INVALID_CONFIG", "container lock ttlMs must be a positive integer", {
        details: { ttlMs },
      });
    }
    const token = randomBytes(32).toString("hex");
    const deadline = Date.now() + Math.max(0, timeoutMs);

    try {
      await this.ensureReady();
      for (;;) {
        const result = await this.redis.set(key, token, "PX", ttlMs, "NX");
        if (result === "OK") {
          return new RedisLockHandle(this.redis, address, key, token, ttlMs);
        }
        if (Date.now() >= deadline) {
          throw new TapeCiError(
            "UPLOAD_INTERRUPTED",
            `container ${address} is locked by another deployment (lock ${key})`,
            {
              retryable: true,
              details: { container: address, key, timeoutMs },
            },
          );
        }
        await sleep(retryIntervalMs);
      }
    } catch (error) {
      throw lockBackendError(error, address);
    }
  }

  async close(): Promise<void> {
    if (!this.ownsConnection) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  private async ensureReady(): Promise<void> {
    const status = this.redis.status;
    if (status === "ready") return;
    if (status === "wait") {
      await this.redis.connect();
      return;
    }
    if (status === "connecting" || status === "connect" || status === "reconnecting") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("timed out waiting for Redis connection"));
        }, 5_000);
        const cleanup = (): void => {
          clearTimeout(timer);
          this.redis.off("ready", onReady);
          this.redis.off("error", onError);
        };
        const onReady = (): void => {
          cleanup();
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        this.redis.once("ready", onReady);
        this.redis.once("error", onError);
      });
      return;
    }
    throw new Error(`Redis client is ${status}`);
  }
}

export interface WithContainerLockOptions extends AcquireLockOptions {
  /** Keep the lease alive while the handler runs. Default `true`. */
  readonly autoRefresh?: boolean;
  /** Refresh cadence; defaults to half the lease TTL (minimum 1s). */
  readonly refreshIntervalMs?: number;
}

/**
 * Run `fn` while holding the per-container lock, releasing it in `finally`.
 * The lease is refreshed in the background so long chain-write batches do not
 * lose exclusivity mid-flight.
 */
export async function withContainerLock<T>(
  lock: ContainerLockLike,
  container: string,
  fn: () => Promise<T>,
  options: WithContainerLockOptions = {},
): Promise<T> {
  const handle = await lock.acquire(container, options);
  const autoRefresh = options.autoRefresh ?? true;
  const intervalMs = Math.max(1_000, options.refreshIntervalMs ?? Math.floor(handle.ttlMs / 2));
  let timer: NodeJS.Timeout | undefined;
  let lost = false;
  if (autoRefresh) {
    timer = setInterval(() => {
      if (lost) return;
      handle.refresh().then(
        (renewed) => {
          if (!renewed) lost = true;
        },
        () => {
          lost = true;
        },
      );
    }, intervalMs);
    timer.unref();
  }
  try {
    return await fn();
  } finally {
    if (timer !== undefined) clearInterval(timer);
    await handle.release().catch(() => false);
  }
}
