/**
 * Reusable Anvil-fork helper for the P0-04 / P0-05 evidence runs.
 *
 * Safety rules (PRD §7.2, AGENTS.md red lines):
 * - only ever starts `anvil` locally, forked from a pinned X Layer block;
 * - never broadcasts to a public chain (Anvil is the only writer);
 * - fixed fork block captured once per start (head - offset, or `TAPECI_FORK_BLOCK`);
 * - unique port per instance, readiness polled over JSON-RPC;
 * - the child process is always killed on `stop()`, on process exit, and on a
 *   failed startup, so repeated test runs cannot leak Anvil children.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { Hex } from "viem";

/** Public X Layer RPC used as the read-only fork source. Override with TAPECI_FORK_RPC_URL. */
export const XLAYER_FORK_RPC_URL = "https://rpc.xlayer.tech";
export const XLAYER_CHAIN_ID = 196;
/** Fork this many blocks behind the source head so the pin is stable while tests run. */
export const DEFAULT_FORK_OFFSET = 50;

export interface JsonRpcErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** JSON-RPC call failure that preserves `error.data` (used to capture revert bytes). */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, error: JsonRpcErrorShape) {
    super(`${method} failed: ${error.code} ${error.message}`);
    this.name = "JsonRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: JsonRpcErrorShape;
}

/** Minimal JSON-RPC call used for readiness probes and raw `eth_call` revert capture. */
export async function rpcRequest(
  url: string,
  method: string,
  params: readonly unknown[] = [],
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${method} -> HTTP ${response.status} from ${url}`);
    }
    const body = (await response.json()) as JsonRpcResponse;
    if (body.error) throw new JsonRpcError(method, body.error);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export function toHexQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}

function toBigIntQuantity(value: unknown): bigint {
  if (typeof value !== "string") throw new Error(`expected hex quantity, got ${typeof value}`);
  return BigInt(value);
}

/** Latest source-chain block (read only; never used to broadcast). */
export async function fetchSourceHead(sourceUrl: string): Promise<bigint> {
  return toBigIntQuantity(await rpcRequest(sourceUrl, "eth_blockNumber"));
}

export async function fetchSourceChainId(sourceUrl: string): Promise<number> {
  return Number(toBigIntQuantity(await rpcRequest(sourceUrl, "eth_chainId")));
}

async function findFreePort(host: string): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (port <= 0) throw new Error("could not allocate a free TCP port for Anvil");
  return port;
}

function readAnvilVersion(): string {
  try {
    const output = execFileSync("anvil", ["--version"], { encoding: "utf8" });
    return output.split("\n")[0]?.trim() ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface StartAnvilForkOptions {
  /** Source RPC URL (default: TAPECI_FORK_RPC_URL or the public X Layer RPC). */
  readonly sourceUrl?: string;
  /** Hard-pin the fork block (default: source head - offset). */
  readonly forkBlockNumber?: bigint;
  /** Distance behind the source head when `forkBlockNumber` is not given. */
  readonly offset?: number;
  readonly host?: string;
  /** Explicit port; a free ephemeral port is chosen when omitted. */
  readonly port?: number;
  readonly startupTimeoutMs?: number;
  readonly extraArgs?: readonly string[];
}

export interface AnvilFork {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly chainId: number;
  readonly sourceUrl: string;
  /** Source-chain head observed before the fork was started. */
  readonly sourceHeadAtStart: bigint;
  readonly requestedForkBlock: bigint;
  /** Block number the node reported once ready (normally === requestedForkBlock). */
  readonly forkBlockNumber: bigint;
  readonly forkBlockHash: Hex;
  readonly forkBlockTimestamp: bigint;
  readonly anvilVersion: string;
  readonly pid: number | null;
  /** Captured stderr/stdout tail (never contains secrets; fork URL is public). */
  readonly stderrTail: () => string;
  readonly stop: () => Promise<void>;
}

interface RpcBlockShape {
  readonly hash?: unknown;
  readonly timestamp?: unknown;
}

function isChildRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (!isChildRunning(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function spawnAnvil(
  args: readonly string[],
): { readonly child: ChildProcessWithoutNullStreams; readonly tail: () => string } {
  const child = spawn("anvil", [...args]);
  let tail = "";
  const append = (chunk: string): void => {
    tail = `${tail}${chunk}`;
    if (tail.length > 16_384) tail = tail.slice(-16_384);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { child, tail: () => tail.trim() };
}

function resolveSourceUrl(options: StartAnvilForkOptions): string {
  const fromEnv = process.env.TAPECI_FORK_RPC_URL?.trim();
  if (options.sourceUrl && options.sourceUrl.trim().length > 0) return options.sourceUrl.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return XLAYER_FORK_RPC_URL;
}

function resolveForkBlockOverride(options: StartAnvilForkOptions): bigint | null {
  if (options.forkBlockNumber !== undefined) return options.forkBlockNumber;
  const fromEnv = process.env.TAPECI_FORK_BLOCK?.trim();
  if (fromEnv && fromEnv.length > 0) return BigInt(fromEnv);
  return null;
}

/**
 * Start a local Anvil fork of X Layer 196 and wait until it is ready.
 * The caller must always `await fork.stop()` (tests use afterAll; scripts use finally).
 */
export async function startAnvilFork(
  options: StartAnvilForkOptions = {},
): Promise<AnvilFork> {
  const sourceUrl = resolveSourceUrl(options);
  const chainId = XLAYER_CHAIN_ID;
  const sourceChainId = await fetchSourceChainId(sourceUrl);
  if (sourceChainId !== chainId) {
    throw new Error(
      `fork source ${sourceUrl} reports chainId ${sourceChainId}, expected ${chainId}`,
    );
  }
  const sourceHeadAtStart = await fetchSourceHead(sourceUrl);
  const offset = options.offset ?? DEFAULT_FORK_OFFSET;
  const override = resolveForkBlockOverride(options);
  const requestedForkBlock = override ?? sourceHeadAtStart - BigInt(offset);
  if (requestedForkBlock <= 0n || requestedForkBlock > sourceHeadAtStart) {
    throw new Error(
      `invalid fork block ${requestedForkBlock} (source head ${sourceHeadAtStart}, offset ${offset})`,
    );
  }
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? (await findFreePort(host));
  const startupTimeoutMs = options.startupTimeoutMs ?? 90_000;
  const anvilVersion = readAnvilVersion();
  const args: string[] = [
    "--fork-url",
    sourceUrl,
    "--fork-block-number",
    requestedForkBlock.toString(),
    "--chain-id",
    String(chainId),
    "--auto-impersonate",
    "--host",
    host,
    "--port",
    String(port),
    ...(options.extraArgs ?? []),
  ];
  const { child, tail } = spawnAnvil(args);
  const killOnExit = (): void => {
    if (isChildRunning(child)) child.kill("SIGKILL");
  };
  process.once("exit", killOnExit);

  const url = `http://${host}:${port}`;
  const deadline = Date.now() + startupTimeoutMs;
  try {
    for (;;) {
      if (!isChildRunning(child)) {
        throw new Error(`anvil exited during startup (code ${child.exitCode}):\n${tail()}`);
      }
      try {
        const observedChainId = Number(
          toBigIntQuantity(await rpcRequest(url, "eth_chainId")),
        );
        if (observedChainId === chainId) {
          const observedBlock = toBigIntQuantity(await rpcRequest(url, "eth_blockNumber"));
          if (observedBlock >= requestedForkBlock) break;
        }
      } catch {
        // Node not accepting requests yet; retry until the deadline.
      }
      if (Date.now() > deadline) {
        throw new Error(
          `anvil fork did not become ready within ${startupTimeoutMs}ms:\n${tail()}`,
        );
      }
      await delay(100);
    }
    const forkBlockNumber = toBigIntQuantity(await rpcRequest(url, "eth_blockNumber"));
    const rawBlock = (await rpcRequest(url, "eth_getBlockByNumber", [
      toHexQuantity(forkBlockNumber),
      false,
    ])) as RpcBlockShape | null;
    if (!rawBlock || typeof rawBlock.hash !== "string" || typeof rawBlock.timestamp !== "string") {
      throw new Error(`could not read fork block ${forkBlockNumber} from ${url}`);
    }
    const forkBlockHash = rawBlock.hash as Hex;
    const forkBlockTimestamp = toBigIntQuantity(rawBlock.timestamp);
    let stopped: Promise<void> | null = null;
    const stop = async (): Promise<void> => {
      if (stopped) return stopped;
      stopped = (async (): Promise<void> => {
        process.off("exit", killOnExit);
        if (isChildRunning(child)) {
          child.kill("SIGTERM");
          const exited = await waitForExit(child, 5_000);
          if (!exited) {
            child.kill("SIGKILL");
            await waitForExit(child, 5_000);
          }
        }
        if (isChildRunning(child)) {
          throw new Error(`anvil pid ${child.pid ?? "?"} did not exit after SIGKILL`);
        }
      })();
      return stopped;
    };
    return {
      url,
      host,
      port,
      chainId,
      sourceUrl,
      sourceHeadAtStart,
      requestedForkBlock,
      forkBlockNumber,
      forkBlockHash,
      forkBlockTimestamp,
      anvilVersion,
      pid: child.pid ?? null,
      stderrTail: tail,
      stop,
    };
  } catch (error) {
    process.off("exit", killOnExit);
    if (isChildRunning(child)) {
      child.kill("SIGKILL");
      await waitForExit(child, 5_000);
    }
    throw error;
  }
}

/** Fork metadata in the JSON-safe shape written to docs/evidence. */
export interface ForkMetadata {
  readonly sourceUrl: string;
  readonly sourceHeadAtStart: number;
  readonly requestedForkBlock: number;
  readonly forkBlockNumber: number;
  readonly forkBlockHash: Hex;
  readonly forkBlockTimestamp: number;
  readonly forkBlockTimeIso: string;
  readonly chainId: number;
  readonly anvilVersion: string;
  readonly host: string;
  readonly port: number;
}

export function forkMetadata(fork: AnvilFork): ForkMetadata {
  return {
    sourceUrl: fork.sourceUrl,
    sourceHeadAtStart: Number(fork.sourceHeadAtStart),
    requestedForkBlock: Number(fork.requestedForkBlock),
    forkBlockNumber: Number(fork.forkBlockNumber),
    forkBlockHash: fork.forkBlockHash,
    forkBlockTimestamp: Number(fork.forkBlockTimestamp),
    forkBlockTimeIso: new Date(Number(fork.forkBlockTimestamp) * 1000).toISOString(),
    chainId: fork.chainId,
    anvilVersion: fork.anvilVersion,
    host: fork.host,
    port: fork.port,
  };
}
