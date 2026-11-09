/**
 * P3 provisioning fixtures — a deterministic in-memory `ReadClient` plus the
 * quote/task rows the `open` journey needs.
 *
 * The chain is faked because P3 must be runnable on PostgreSQL alone (the same
 * classification `tests/p2/api/resources.test.ts` uses); every service under
 * test — `buildOpenQuote`, `createPreparationTask`, `prepareOpenIntent`,
 * `recordTransactionHash`, `verifyOpenTransaction`, `acceptQuote` — is the real
 * implementation. Only `ReadClient` and the clock are injected.
 *
 * The fake reproduces the exact call shape `inspectContainer` and the
 * provisioning services issue, including the *distinction the money rules
 * depend on*: a transport error is `unavailable` (never `opened: false`) and a
 * zero-data/revert answer is an explicit "no such token" (§8.6, P1-07).
 */
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type Hex,
} from "viem";
import { XLAYER_MAINNET } from "@tapeci/config";
import type { ReadClient } from "@tapeci/chain";
import { users, wallets, type Database } from "@tapeci/database";

/** P0-03 pin: `FEE()` = 0.08 OKB. */
export const FEE_WEI = 80_000_000_000_000_000n;
/** A fixed gas price so `maxGasCostWei` is arithmetic, never a live read. */
export const GAS_PRICE_WEI = 1_000_000_000n;
/** The gas the fork measured for a real `open` (`fork-authorization.json`). */
export const ESTIMATED_GAS = 169_734n;
/** Pinned head the fixtures price against. */
export const HEAD = 74_312_700n;
/** Receipt height: deep enough that a test-only depth of 1 is satisfied. */
export const RECEIPT_BLOCK = HEAD - 5n;
export const RECEIPT_BLOCK_HASH = `0x${"b1".repeat(32)}` as Hex;
/** A different hash at the same height: what a divergent operator reports. */
export const DIVERGENT_BLOCK_HASH = `0x${"b2".repeat(32)}` as Hex;

export const PROCESSOR: Hex = "0x839bdd6fa7a66416a609a735e11de5411b98574e";
export const OWNER: Hex = "0x571d447f4f24688ec35ccf07f1d6993655f6af15";
export const OTHER_WALLET: Hex = "0x00000000000000000000000000000000000000b2";
export const CONTAINER: Hex = `0x${"c0".repeat(20)}`;
export const TOKEN_ID = 4n;
export const FACTORY = XLAYER_MAINNET.factory;
export const OPENER = XLAYER_MAINNET.opener;

export interface FakeTransaction {
  readonly from: Hex;
  readonly to: Hex | null;
  readonly value: bigint;
  readonly data: Hex;
}

export interface FakeReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
}

export interface FakeChainState {
  head: bigint;
  feeWei: bigint;
  gasPriceWei: bigint;
  estimatedGas: bigint;
  owner: Hex;
  opened: boolean;
  deployed: boolean;
  /** Function name whose read throws a transport error (→ `unavailable`). */
  failAt: string | null;
  /** Function name whose read throws a zero-data answer (→ explicit absence). */
  absentAt: string | null;
  tx: FakeTransaction | null;
  receipt: FakeReceipt | null;
  /** Hash this operator reports at `RECEIPT_BLOCK`. */
  blockHash: Hex;
  /** Every `readContract` function name, in call order — proves which reads ran. */
  readonly reads: string[];
}

export interface FakeChain {
  readonly client: ReadClient;
  readonly state: FakeChainState;
}

/**
 * One operator. `blockHash` is what this operator answers for
 * `eth_getBlockByNumber`, so a second instance can disagree with the first
 * without either lying about anything else (§9.2).
 */
export function createFakeChain(overrides: Partial<FakeChainState> = {}): FakeChain {
  const state: FakeChainState = {
    head: HEAD,
    feeWei: FEE_WEI,
    gasPriceWei: GAS_PRICE_WEI,
    estimatedGas: ESTIMATED_GAS,
    owner: OWNER,
    opened: false,
    deployed: false,
    failAt: null,
    absentAt: null,
    tx: null,
    receipt: null,
    blockHash: RECEIPT_BLOCK_HASH,
    reads: [],
    ...overrides,
  };

  const client = {
    getBlockNumber: async () => {
      state.reads.push("getBlockNumber");
      if (state.failAt === "getBlockNumber") throw transportFailure("getBlockNumber");
      return state.head;
    },
    getGasPrice: async () => {
      state.reads.push("getGasPrice");
      if (state.failAt === "getGasPrice") throw transportFailure("getGasPrice");
      return state.gasPriceWei;
    },
    estimateContractGas: async () => {
      state.reads.push("estimateContractGas");
      if (state.failAt === "estimateContractGas") throw transportFailure("estimateContractGas");
      return state.estimatedGas;
    },
    getBlock: async () => {
      state.reads.push("getBlock");
      if (state.failAt === "getBlock") throw transportFailure("getBlock");
      return { hash: state.blockHash, number: RECEIPT_BLOCK };
    },
    getTransaction: async () => {
      state.reads.push("getTransaction");
      if (state.failAt === "getTransaction") throw transportFailure("getTransaction");
      if (state.tx === null) throw notFound("TransactionNotFoundError", "transaction not found");
      return {
        chainId: 196,
        from: state.tx.from,
        to: state.tx.to,
        value: state.tx.value,
        input: state.tx.data,
        nonce: 7,
      };
    },
    getTransactionReceipt: async () => {
      state.reads.push("getTransactionReceipt");
      if (state.failAt === "getTransactionReceipt") throw transportFailure("getTransactionReceipt");
      if (state.receipt === null) {
        // A node that has not indexed the hash yet: `null`, not a failure (§3.3).
        throw notFound("TransactionReceiptNotFoundError", "receipt not found");
      }
      return {
        status: state.receipt.status,
        blockNumber: state.receipt.blockNumber,
        blockHash: state.receipt.blockHash,
        gasUsed: state.receipt.gasUsed,
        effectiveGasPrice: state.receipt.effectiveGasPrice,
      };
    },
    readContract: async (request: {
      address: Hex;
      functionName: string;
      args?: readonly unknown[];
    }) => {
      const name = request.functionName;
      state.reads.push(name);
      if (state.failAt === name) throw transportFailure(name);
      if (state.absentAt === name) throw zeroData(name);
      const target = request.address.toLowerCase();
      if (target === FACTORY.toLowerCase()) {
        if (name === "cpuCount") return 1n;
        if (name === "cpuAt") return PROCESSOR;
        if (name === "isCPU") return true;
      }
      if (target === OPENER.toLowerCase()) {
        if (name === "accountOf") return CONTAINER;
        if (name === "FEE") return state.feeWei;
        if (name === "isOpened") return state.opened;
        if (name === "isDeployed") return state.deployed;
      }
      if (target === PROCESSOR.toLowerCase()) {
        if (name === "ownerOf") return state.owner;
      }
      if (target === CONTAINER.toLowerCase()) {
        if (name === "token") return [196n, PROCESSOR, TOKEN_ID] as const;
      }
      throw new Error(`fake chain: unexpected read ${name} on ${target}`);
    },
  } as unknown as ReadClient;

  return { client, state };
}

/** A plain transport failure: never an explicit contract answer (§8.6). */
export function transportFailure(stage: string): Error {
  return new Error(`socket hang up while reading ${stage}`);
}

/** A node that does not know a hash. Matched by `name` in the services. */
export function notFound(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

/** The chain answering "there is no such token": a revert or an empty return. */
export function zeroData(functionName: string): Error {
  const cause = new ContractFunctionZeroDataError({ functionName });
  return new ContractFunctionExecutionError(cause, {
    abi: [],
    args: [],
    contractAddress: OPENER,
    functionName,
  });
}

/** The chain answering "this reverted": still an explicit answer, not a read failure. */
export function reverted(functionName: string): Error {
  const cause = new ContractFunctionRevertedError({ abi: [], data: "0x4e487b71", functionName });
  return new ContractFunctionExecutionError(cause, {
    abi: [],
    args: [],
    contractAddress: OPENER,
    functionName,
  });
}

/**
 * The on-chain transaction that *is* the stored attempt: the fixture every
 * mismatch test perturbs by exactly one field.
 */
export function transactionFromAttempt(attempt: {
  readonly sender: string;
  readonly target: string;
  readonly valueWei: string;
  readonly calldata: string;
}): FakeTransaction {
  return {
    from: attempt.sender as Hex,
    to: attempt.target as Hex,
    value: BigInt(attempt.valueWei),
    data: attempt.calldata as Hex,
  };
}

/** A successful, deep, canonical receipt for the fixture transaction. */
export function successReceipt(): FakeReceipt {
  return {
    status: "success",
    blockNumber: RECEIPT_BLOCK,
    blockHash: RECEIPT_BLOCK_HASH,
    gasUsed: 169_734n,
    effectiveGasPrice: GAS_PRICE_WEI,
  };
}

export async function seedUser(
  db: Database,
  githubUserId: number,
  githubLogin: string,
): Promise<string> {
  const [row] = await db.insert(users).values({ githubUserId, githubLogin }).returning();
  if (row === undefined) throw new Error("fixture: user insert failed");
  return row.id;
}

export async function seedWallet(
  db: Database,
  userId: string,
  address: Hex,
): Promise<void> {
  await db.insert(wallets).values({ userId, chainId: 196, address, verifiedAt: new Date() });
}

/** A clock the services take as `now`, so expiry is deterministic. */
export function fixedClock(at: Date): () => Date {
  return () => at;
}
