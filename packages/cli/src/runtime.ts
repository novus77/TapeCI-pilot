import { waitForBlockOnAll, type WaitForBlockOptions } from "@tapeci/chain";
import type { Hex } from "viem";
import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createImpersonatedWalletClient,
  createReadClient,
  xLayerChain,
  type ReadClient,
} from "@tapeci/chain";
import { XLAYER_MAINNET } from "@tapeci/config";
import { TapeCiError } from "@tapeci/shared";
import { createOperatorClients, type OperatorClient } from "@tapeci/verifier";
import { flagString, requireFlag, type ParsedArgs } from "./args.js";

export interface ReadRuntime {
  readonly operators: readonly OperatorClient[];
  readonly allowSingleOperator: boolean;
  readonly readClient: ReadClient;
  readonly forkUrl: string | null;
}

/** Build read clients: two independent operators, or one explicit Anvil fork. */
export function readRuntime(parsed: ParsedArgs): ReadRuntime {
  const forkUrl = flagString(parsed, "fork-url");
  if (forkUrl !== undefined) {
    const client = createReadClient(forkUrl);
    return {
      operators: [
        {
          operator: "fork",
          url: forkUrl,
          endpoint: { url: forkUrl, operator: "okx", maxBatch: 10 },
          client,
        },
      ],
      allowSingleOperator: true,
      readClient: client,
      forkUrl,
    };
  }
  const operators = createOperatorClients(XLAYER_MAINNET);
  const primary = operators[0];
  if (primary === undefined) throw new TapeCiError("INTERNAL", "no RPC operator configured");
  return {
    operators,
    allowSingleOperator: false,
    readClient: primary.client,
    forkUrl: null,
  };
}

/** The highest block all operators can serve (used as an explicit verification pin). */
export async function latestPin(runtime: ReadRuntime): Promise<number> {
  const heads = await Promise.all(
    runtime.operators.map((operator) => operator.client.getBlockNumber()),
  );
  const min = heads.reduce((low, head) => (head < low ? head : low), heads[0] as bigint);
  return Number(min);
}

export interface SignerRuntime {
  readonly wallet: WalletClient;
  readonly signer: Hex;
}

/**
 * Resolve the write signer.
 * - Anvil fork: `--fork-url` + `--signer <address>` (impersonation; never on mainnet).
 * - Mainnet: `TAPECI_PRIVATE_KEY` in the environment (never logged, never stored).
 */
export function signerRuntime(parsed: ParsedArgs): SignerRuntime {
  const forkUrl = flagString(parsed, "fork-url");
  if (forkUrl !== undefined) {
    const address = requireFlag(parsed, "signer") as Hex;
    return {
      wallet: createImpersonatedWalletClient(forkUrl, address),
      signer: address,
    };
  }
  const privateKey = process.env.TAPECI_PRIVATE_KEY;
  if (privateKey === undefined || privateKey === "") {
    throw new TapeCiError(
      "INVALID_CONFIG",
      "writing needs either --fork-url + --signer (local fork) or TAPECI_PRIVATE_KEY in the environment",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new TapeCiError("INVALID_CONFIG", "TAPECI_PRIVATE_KEY is not a 32-byte hex private key");
  }
  const account = privateKeyToAccount(privateKey as Hex);
  const rpc =
    flagString(parsed, "rpc") ?? process.env.TAPECI_RPC_DEPLOY ?? XLAYER_MAINNET.rpcs[0]?.url;
  if (rpc === undefined) throw new TapeCiError("INTERNAL", "no deploy RPC configured");
  const wallet = createWalletClient({
    chain: xLayerChain,
    transport: http(rpc),
    account,
  });
  return { wallet, signer: account.address };
}

/**
 * Verification pin that can see every mined write: wait (bounded) until all
 * operators reach `minBlock`, then pin at max(min operator head, minBlock).
 * Using plain latestPin right after a deploy can pin *below* the entry write
 * (mainnet canary 2026-10-24: pin 74087825, entry mined at 74087826).
 */
export async function pinAtLeast(
  runtime: ReadRuntime,
  minBlock: bigint | null,
  wait: Omit<WaitForBlockOptions, "label"> = {},
): Promise<number> {
  if (minBlock !== null) {
    await waitForBlockOnAll(
      runtime.operators.map((operator) => ({ client: operator.client, label: operator.operator })),
      minBlock,
      wait,
    );
  }
  const head = BigInt(await latestPin(runtime));
  const pin = minBlock !== null && minBlock > head ? minBlock : head;
  return Number(pin);
}
