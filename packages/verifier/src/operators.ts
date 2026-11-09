import { createPublicClient, http } from "viem";
import { oneEndpointPerOperator } from "@tapeci/config";
import type { ChainConfig, RpcEndpoint } from "@tapeci/config";
import { xLayerChain, type ReadClient } from "@tapeci/chain";
import { TapeCiError } from "@tapeci/shared";

/**
 * One client per independent RPC *operator* (not per hostname): OKX runs two
 * hostnames and thirdweb's X Layer node is counted as OKX by TapeKit, so they
 * are all one vote. A second vote must come from a different operator (dRPC).
 */
export interface OperatorClient {
  readonly operator: string;
  readonly url: string;
  readonly endpoint: RpcEndpoint;
  readonly client: ReadClient;
}

/**
 * Apply `TAPECI_RPC_OKX` / `TAPECI_RPC_DRPC` overrides (same semantics as
 * `resolveRpcEndpoints` in packages/config) to an arbitrary chain config.
 */
function endpointsWithEnvOverrides(
  config: ChainConfig,
  env: Readonly<Record<string, string | undefined>>,
): readonly RpcEndpoint[] {
  const okxOverride = env.TAPECI_RPC_OKX?.trim();
  const drpcOverride = env.TAPECI_RPC_DRPC?.trim();
  let okxReplaced = false;
  return config.rpcs.map((endpoint) => {
    if (endpoint.operator === "okx" && okxOverride !== undefined && okxOverride !== "" && !okxReplaced) {
      okxReplaced = true;
      return { ...endpoint, url: okxOverride };
    }
    if (endpoint.operator === "drpc" && drpcOverride !== undefined && drpcOverride !== "") {
      return { ...endpoint, url: drpcOverride };
    }
    return endpoint;
  });
}

/**
 * Build the read clients for one report.
 *
 * `batchSize` comes from the operator metadata in `packages/config`: dRPC's
 * public X Layer endpoint answers HTTP 500 to JSON-RPC batches larger than 3
 * (observed 2026-10-19), while OKX accepts 10. The pinned block is passed with
 * every call, so batching is only a transport detail.
 */
export function createOperatorClients(
  config: ChainConfig,
  env?: Readonly<Record<string, string | undefined>>,
): OperatorClient[] {
  const endpoints = oneEndpointPerOperator(
    endpointsWithEnvOverrides(config, env === undefined ? process.env : { ...process.env, ...env }),
  );
  if (endpoints.length < 2) {
    throw new TapeCiError(
      "INTERNAL",
      `multi-operator verification needs at least two independent RPC operators, got ${endpoints.length}`,
      { details: { endpoints: endpoints.map((endpoint) => endpoint.url) } },
    );
  }
  return endpoints.map((endpoint) => ({
    operator: endpoint.operator,
    url: endpoint.url,
    endpoint,
    client: createPublicClient({
      chain: xLayerChain,
      transport: http(endpoint.url, {
        batch: { wait: 0, batchSize: Math.max(1, endpoint.maxBatch) },
        retryCount: 2,
        timeout: 20_000,
      }),
    }),
  }));
}

export interface PinSelection {
  readonly sortedHeads: readonly number[];
  readonly secondHighestHead: number;
  readonly pinnedBlockNumber: number;
  readonly maxHead: number;
  readonly divergenceBlocks: number;
  readonly pinLagBlocks: number;
}

/**
 * TapeKit SPEC §4.2 pin arithmetic, as a pure function so it can be tested
 * without network access:
 *
 *   sortedHeads      = operator heads, highest first
 *   secondHighest    = sortedHeads[1]
 *   pinnedBlock      = secondHighest - offset
 *
 * With one vote per operator, both operators must have the block, and the two
 * blocks on top absorb a possible reorg. If the operators' heads differ by more
 * than `maxLagBlocks` the pin is not trustworthy: fail closed instead of
 * picking a block from a possibly stale or lying node.
 */
export function selectPinnedBlock(
  heads: readonly number[],
  offset: number,
  maxLagBlocks: number,
): PinSelection {
  if (heads.length < 2) {
    throw new TapeCiError("INTERNAL", "pinning requires at least two operator heads", {
      details: { heads },
    });
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TapeCiError("INTERNAL", `invalid pin offset ${offset}`);
  }
  for (const head of heads) {
    if (!Number.isSafeInteger(head) || head < 0) {
      throw new TapeCiError("RPC_DISAGREEMENT", `invalid operator head ${head}`, {
        details: { heads },
      });
    }
  }
  const sortedHeads = [...heads].sort((a, b) => b - a);
  const maxHead = sortedHeads[0] as number;
  const secondHighestHead = sortedHeads[1] as number;
  const divergenceBlocks = maxHead - secondHighestHead;
  if (divergenceBlocks > maxLagBlocks) {
    throw new TapeCiError(
      "RPC_DISAGREEMENT",
      `operator heads diverge by ${divergenceBlocks} blocks (max ${maxLagBlocks}); refusing to pin`,
      { details: { heads, sortedHeads, divergenceBlocks, maxLagBlocks } },
    );
  }
  const pinnedBlockNumber = secondHighestHead - offset;
  if (pinnedBlockNumber < 0) {
    throw new TapeCiError(
      "RPC_DISAGREEMENT",
      `pinned block ${pinnedBlockNumber} is negative (heads too low for offset ${offset})`,
      { details: { heads, offset } },
    );
  }
  return {
    sortedHeads,
    secondHighestHead,
    pinnedBlockNumber,
    maxHead,
    divergenceBlocks,
    pinLagBlocks: maxHead - pinnedBlockNumber,
  };
}
