import { TapeCiError } from "@tapeci/shared";

/** Minimal surface needed to observe a node's head (any viem public client fits). */
export interface BlockHeadReader {
  getBlockNumber(options?: { cacheTime?: number }): Promise<bigint>;
}

export interface WaitForBlockOptions {
  /** Total time budget before failing closed (default 60 s). */
  readonly timeoutMs?: number;
  /** Delay between polls (default 1 s). */
  readonly intervalMs?: number;
  /** Label used in the error message (operator name, URL host…). */
  readonly label?: string;
  /** Injectable sleep for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Read-after-write guard: poll a node until its head is at or above `target`.
 *
 * A receipt from one node does not mean every node behind a load balancer (or a
 * second operator) has imported that block. Reading "latest" too early returns
 * pre-write state and looks exactly like a missing file. This waits with a
 * bounded budget and fails closed (`RPC_DISAGREEMENT`, retryable) instead of
 * reporting a false verification failure. Returns the observed head.
 */
export async function waitForBlock(
  client: BlockHeadReader,
  target: bigint,
  options: WaitForBlockOptions = {},
): Promise<bigint> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const started = now();
  let lastHead: bigint | null = null;
  let lastError: unknown = null;
  for (;;) {
    try {
      // cacheTime 0: viem otherwise serves a cached block number for ~4 s.
      const head = await client.getBlockNumber({ cacheTime: 0 });
      lastHead = head;
      if (head >= target) return head;
    } catch (error) {
      lastError = error;
    }
    if (now() - started >= timeoutMs) break;
    await sleep(intervalMs);
  }
  throw new TapeCiError(
    "RPC_DISAGREEMENT",
    `${options.label ?? "RPC"} did not reach block ${target} within ${timeoutMs} ms (last head ${
      lastHead === null ? "unknown" : lastHead.toString()
    })`,
    {
      retryable: true,
      ...(lastError === null ? {} : { cause: lastError }),
      details: {
        target: target.toString(),
        lastHead: lastHead === null ? null : lastHead.toString(),
        label: options.label ?? null,
      },
    },
  );
}

/** Wait until every reader has reached `target`; returns the lowest observed head. */
export async function waitForBlockOnAll(
  readers: readonly { readonly client: BlockHeadReader; readonly label?: string }[],
  target: bigint,
  options: Omit<WaitForBlockOptions, "label"> = {},
): Promise<bigint> {
  const heads = await Promise.all(
    readers.map((reader) =>
      waitForBlock(reader.client, target, {
        ...options,
        ...(reader.label === undefined ? {} : { label: reader.label }),
      }),
    ),
  );
  return heads.reduce((low, head) => (head < low ? head : low), heads[0] ?? target);
}

/**
 * Bounded retry for a read pinned at a block the node should already have.
 * Only transport/RPC errors (not TapeCiError verdicts) are retried, so a real
 * "file missing at the pinned block" still fails closed immediately.
 */
export async function retryPinnedRead<T>(
  read: () => Promise<T>,
  options: { readonly attempts?: number; readonly intervalMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (error instanceof TapeCiError) throw error;
      lastError = error;
      if (attempt < attempts) await sleep(options.intervalMs ?? 1_000);
    }
  }
  throw lastError;
}
