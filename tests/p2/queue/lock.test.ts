import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ContainerLock,
  containerLockKey,
  createRedisClient,
  withContainerLock,
  type ContainerLockHandle,
} from "@tapeci/queue";
import { detectServices, randomAddress, TEST_REDIS_URL } from "./helpers.js";

const services = await detectServices();
const describeRedis = services.redis ? describe : describe.skip;

describeRedis("per-container Redis lock", () => {
  const lock = new ContainerLock({ redisUrl: TEST_REDIS_URL });
  const cleanupRedis = createRedisClient(TEST_REDIS_URL);
  const containers: string[] = [];

  beforeAll(async () => {
    await cleanupRedis.ping();
  });

  afterAll(async () => {
    const keys = containers.map((container) => containerLockKey(container));
    if (keys.length > 0) await cleanupRedis.del(...keys);
    await cleanupRedis.quit();
    await lock.close();
  });

  function freshContainer(): string {
    const container = randomAddress();
    containers.push(container);
    return container;
  }

  it("builds the contract key with a lowercase address", () => {
    const mixed = "0xABCdef0123456789ABCDEF0123456789abcdef01";
    expect(containerLockKey(mixed)).toBe(
      "tapeci:container:0xabcdef0123456789abcdef0123456789abcdef01:lock",
    );
  });

  it("grants mutual exclusion: exactly one of two parallel acquires wins", async () => {
    const container = freshContainer();
    const results = await Promise.allSettled([
      lock.acquire(container, { ttlMs: 5_000, timeoutMs: 200, retryIntervalMs: 10 }),
      lock.acquire(container, { ttlMs: 5_000, timeoutMs: 200, retryIntervalMs: 10 }),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<ContainerLockHandle> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = fulfilled[0];
    if (winner === undefined) throw new Error("expected one lock winner");
    await expect(winner.value.release()).resolves.toBe(true);

    // After release the same container can be locked again.
    const again = await lock.acquire(container, { ttlMs: 5_000, timeoutMs: 200 });
    await expect(again.release()).resolves.toBe(true);
  });

  it("times out with a retryable UPLOAD_INTERRUPTED when already locked", async () => {
    const container = freshContainer();
    const held = await lock.acquire(container, { ttlMs: 5_000, timeoutMs: 1_000 });
    try {
      await expect(
        lock.acquire(container, { ttlMs: 5_000, timeoutMs: 150, retryIntervalMs: 10 }),
      ).rejects.toMatchObject({ code: "UPLOAD_INTERRUPTED", retryable: true });
    } finally {
      await held.release();
    }
  });

  it("releases only with the owning token (stale holder cannot delete a new lock)", async () => {
    const container = freshContainer();
    const first = await lock.acquire(container, { ttlMs: 5_000, timeoutMs: 1_000 });

    // Simulate lease expiry + re-acquisition by another worker.
    await cleanupRedis.del(containerLockKey(container));
    const second = await lock.acquire(container, { ttlMs: 5_000, timeoutMs: 1_000 });

    await expect(first.release()).resolves.toBe(false);
    await expect(first.refresh()).resolves.toBe(false);
    await expect(second.refresh()).resolves.toBe(true);
    await expect(second.release()).resolves.toBe(true);
  });

  it("refreshes the lease TTL only for the owner", async () => {
    const container = freshContainer();
    const handle = await lock.acquire(container, { ttlMs: 1_000, timeoutMs: 1_000 });
    try {
      await expect(handle.refresh(10_000)).resolves.toBe(true);
      const ttl = await cleanupRedis.pttl(containerLockKey(container));
      expect(ttl).toBeGreaterThan(5_000);
    } finally {
      await handle.release();
    }
  });

  it("withContainerLock releases on success and on throw", async () => {
    const successContainer = freshContainer();
    await expect(
      withContainerLock(lock, successContainer, async () => "ok", {
        ttlMs: 5_000,
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("ok");
    const afterSuccess = await lock.acquire(successContainer, { ttlMs: 5_000, timeoutMs: 200 });
    await afterSuccess.release();

    const failureContainer = freshContainer();
    await expect(
      withContainerLock(
        lock,
        failureContainer,
        async () => {
          throw new Error("handler exploded");
        },
        { ttlMs: 5_000, timeoutMs: 1_000, autoRefresh: false },
      ),
    ).rejects.toThrow("handler exploded");
    const afterFailure = await lock.acquire(failureContainer, { ttlMs: 5_000, timeoutMs: 200 });
    await afterFailure.release();
  });

  it("rejects malformed container addresses", async () => {
    await expect(lock.acquire("0xnot-an-address")).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });
});
