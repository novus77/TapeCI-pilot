import { getAddress, type Hex } from "viem";
import { TapeCiError } from "@tapeci/shared";
import {
  REAL_INTEGRATION_SCHEMA_VERSION,
  errorMessage,
  normalizeAddress,
  normalizeHash,
  safeRpcHost,
  uniqueStrings,
} from "./common.js";

export { requireRealIntegrationOptIn } from "./common.js";

export interface TransactionExpectation {
  readonly chainId: number;
  readonly hash: Hex;
  readonly from: Hex;
  readonly to: Hex;
  readonly maxFeeWei: bigint;
  readonly minConfirmations: number;
}

export interface TransactionObservation {
  readonly operator: string;
  readonly rpcHost: string;
  readonly chainId: number;
  readonly latestBlock: bigint;
  readonly transaction: {
    readonly hash: Hex;
    readonly from: Hex;
    readonly to: Hex | null;
    readonly valueWei: bigint;
  } | null;
  readonly receipt: {
    readonly transactionHash: Hex;
    readonly blockNumber: bigint;
    readonly blockHash: Hex;
    readonly status: "success" | "reverted";
    readonly gasUsed: bigint;
    readonly effectiveGasPriceWei: bigint;
  } | null;
  readonly balanceBeforeWei: bigint | null;
  readonly balanceAfterWei: bigint | null;
  readonly error: string | null;
}

export interface TransactionEvidence {
  readonly schema: "tapeci.real-integration.transaction.v1";
  readonly schemaVersion: typeof REAL_INTEGRATION_SCHEMA_VERSION;
  readonly observedAt: string;
  readonly readOnly: true;
  readonly writeActionsPerformed: false;
  readonly status: "VERIFIED" | "BLOCKED";
  readonly expected: {
    readonly chainId: number;
    readonly hash: Hex;
    readonly from: Hex;
    readonly to: Hex;
    readonly maxFeeWei: string;
    readonly minConfirmations: number;
  };
  readonly operators: readonly {
    readonly operator: string;
    readonly rpcHost: string;
    readonly chainId: number | null;
    readonly latestBlock: string | null;
    readonly blockNumber: string | null;
    readonly blockHash: Hex | null;
    readonly receiptStatus: string | null;
    readonly gasUsed: string | null;
    readonly effectiveGasPriceWei: string | null;
    readonly feeWei: string | null;
    readonly error: string | null;
  }[];
  readonly receipt: {
    readonly blockNumber: string;
    readonly blockHash: Hex;
    readonly confirmations: number;
    readonly gasUsed: string;
    readonly effectiveGasPriceWei: string;
    readonly feeWei: string;
  } | null;
  readonly balance: {
    readonly beforeWei: string;
    readonly afterWei: string;
    readonly debitWei: string;
    readonly expectedDebitWei: string;
  } | null;
  readonly blockers: readonly string[];
}

interface NormalizedObservation {
  readonly operator: string;
  readonly rpcHost: string;
  readonly chainId: number;
  readonly latestBlock: bigint;
  readonly transaction: TransactionObservation["transaction"];
  readonly receipt: TransactionObservation["receipt"];
  readonly balanceBeforeWei: bigint | null;
  readonly balanceAfterWei: bigint | null;
  readonly error: string | null;
}

function normalizeObservation(observation: TransactionObservation): NormalizedObservation {
  return {
    operator: observation.operator.trim(),
    rpcHost: safeRpcHost(observation.rpcHost),
    chainId: observation.chainId,
    latestBlock: observation.latestBlock,
    transaction:
      observation.transaction === null
        ? null
        : {
            hash: normalizeHash(observation.transaction.hash, "transaction.hash"),
            from: normalizeAddress(observation.transaction.from, "transaction.from"),
            to:
              observation.transaction.to === null
                ? null
                : normalizeAddress(observation.transaction.to, "transaction.to"),
            valueWei: observation.transaction.valueWei,
          },
    receipt:
      observation.receipt === null
        ? null
        : {
            transactionHash: normalizeHash(
              observation.receipt.transactionHash,
              "receipt.transactionHash",
            ),
            blockNumber: observation.receipt.blockNumber,
            blockHash: normalizeHash(observation.receipt.blockHash, "receipt.blockHash"),
            status: observation.receipt.status,
            gasUsed: observation.receipt.gasUsed,
            effectiveGasPriceWei: observation.receipt.effectiveGasPriceWei,
          },
    balanceBeforeWei: observation.balanceBeforeWei,
    balanceAfterWei: observation.balanceAfterWei,
    error: observation.error,
  };
}

function sameAddress(left: string, right: string): boolean {
  return getAddress(left) === getAddress(right);
}

function sameReceipt(
  left: NonNullable<TransactionObservation["receipt"]>,
  right: NonNullable<TransactionObservation["receipt"]>,
): boolean {
  return (
    left.transactionHash === right.transactionHash &&
    left.blockNumber === right.blockNumber &&
    left.blockHash === right.blockHash &&
    left.status === right.status &&
    left.gasUsed === right.gasUsed &&
    left.effectiveGasPriceWei === right.effectiveGasPriceWei
  );
}

export function evaluateTransactionEvidence(
  observations: readonly TransactionObservation[],
  expectation: TransactionExpectation,
  observedAt = new Date().toISOString(),
): TransactionEvidence {
  const expected = {
    chainId: expectation.chainId,
    hash: normalizeHash(expectation.hash, "expected.hash"),
    from: normalizeAddress(expectation.from, "expected.from"),
    to: normalizeAddress(expectation.to, "expected.to"),
    maxFeeWei: expectation.maxFeeWei,
    minConfirmations: expectation.minConfirmations,
  };
  if (expected.maxFeeWei < 0n) {
    throw new TapeCiError("INVALID_CONFIG", "expected.maxFeeWei must be non-negative");
  }
  if (!Number.isSafeInteger(expected.minConfirmations) || expected.minConfirmations < 1) {
    throw new TapeCiError("INVALID_CONFIG", "expected.minConfirmations must be a positive integer");
  }

  const normalized = observations.map(normalizeObservation);
  const blockers = new Set<string>();
  const operators = normalized.map((observation) => observation.operator);
  if (
    normalized.length < 2 ||
    uniqueStrings(operators).length !== normalized.length ||
    operators.some((operator) => operator.length === 0)
  ) {
    blockers.add("operators.independent");
  }

  for (const observation of normalized) {
    if (observation.error !== null) blockers.add(`rpc:${observation.operator}`);
    if (observation.chainId !== expected.chainId) blockers.add(`chainId:${observation.operator}`);
    if (observation.transaction === null) {
      blockers.add("transaction.present");
    } else {
      if (observation.transaction.hash !== expected.hash) blockers.add("transaction.hash");
      if (!sameAddress(observation.transaction.from, expected.from)) {
        blockers.add("transaction.from");
      }
      if (
        observation.transaction.to === null ||
        !sameAddress(observation.transaction.to, expected.to)
      ) {
        blockers.add("transaction.to");
      }
    }
  }

  const receipts = normalized
    .map((observation) => observation.receipt)
    .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== null);
  if (receipts.length !== normalized.length || receipts.length === 0) {
    blockers.add("receipt.present");
  }
  if (receipts.length === 0 || receipts.some((receipt) => receipt.status !== "success")) {
    blockers.add("receipt.status");
  }
  if (receipts.some((receipt) => receipt.transactionHash !== expected.hash)) {
    blockers.add("receipt.hash");
  }
  if (receipts.length > 1 && !receipts.every((receipt) => sameReceipt(receipts[0]!, receipt))) {
    blockers.add("receipt.agreement");
  }

  const firstReceipt = receipts[0] ?? null;
  const confirmations =
    firstReceipt === null
      ? 0
      : Math.min(
          ...normalized.map((observation) =>
            observation.latestBlock >= firstReceipt.blockNumber
              ? Number(observation.latestBlock - firstReceipt.blockNumber + 1n)
              : 0,
          ),
        );
  if (firstReceipt !== null && confirmations < expected.minConfirmations) {
    blockers.add("receipt.confirmations");
  }

  const feeWei =
    firstReceipt === null ? null : firstReceipt.gasUsed * firstReceipt.effectiveGasPriceWei;
  if (feeWei !== null && feeWei > expected.maxFeeWei) blockers.add("fee.cap");
  if (
    receipts.some(
      (receipt) => receipt.gasUsed * receipt.effectiveGasPriceWei > expected.maxFeeWei,
    )
  ) {
    blockers.add("fee.cap");
  }

  const balance = normalized[0] ?? null;
  const balanceDebit =
    balance?.balanceBeforeWei === null || balance?.balanceBeforeWei === undefined
      ? null
      : balance.balanceAfterWei === null
        ? null
        : balance.balanceBeforeWei - balance.balanceAfterWei;
  const valueWei = normalized[0]?.transaction?.valueWei ?? 0n;
  const expectedDebit = feeWei === null ? null : feeWei + valueWei;
  if (balanceDebit === null || expectedDebit === null || balanceDebit !== expectedDebit) {
    blockers.add("balance.debit");
  }

  return {
    schema: "tapeci.real-integration.transaction.v1",
    schemaVersion: REAL_INTEGRATION_SCHEMA_VERSION,
    observedAt,
    readOnly: true,
    writeActionsPerformed: false,
    status: blockers.size === 0 ? "VERIFIED" : "BLOCKED",
    expected: {
      chainId: expected.chainId,
      hash: expected.hash,
      from: expected.from,
      to: expected.to,
      maxFeeWei: expected.maxFeeWei.toString(),
      minConfirmations: expected.minConfirmations,
    },
    operators: normalized.map((observation) => {
      const receipt = observation.receipt;
      return {
        operator: observation.operator,
        rpcHost: observation.rpcHost,
        chainId: observation.chainId,
        latestBlock: observation.latestBlock.toString(),
        blockNumber: receipt?.blockNumber.toString() ?? null,
        blockHash: receipt?.blockHash ?? null,
        receiptStatus: receipt?.status ?? null,
        gasUsed: receipt?.gasUsed.toString() ?? null,
        effectiveGasPriceWei: receipt?.effectiveGasPriceWei.toString() ?? null,
        feeWei:
          receipt === null
            ? null
            : (receipt.gasUsed * receipt.effectiveGasPriceWei).toString(),
        error: observation.error === null ? null : errorMessage(observation.error),
      };
    }),
    receipt:
      firstReceipt === null
        ? null
        : {
            blockNumber: firstReceipt.blockNumber.toString(),
            blockHash: firstReceipt.blockHash,
            confirmations,
            gasUsed: firstReceipt.gasUsed.toString(),
            effectiveGasPriceWei: firstReceipt.effectiveGasPriceWei.toString(),
            feeWei: (firstReceipt.gasUsed * firstReceipt.effectiveGasPriceWei).toString(),
          },
    balance:
      balance?.balanceBeforeWei === null ||
      balance?.balanceBeforeWei === undefined ||
      balance.balanceAfterWei === null ||
      balanceDebit === null ||
      expectedDebit === null
        ? null
        : {
            beforeWei: balance.balanceBeforeWei.toString(),
            afterWei: balance.balanceAfterWei.toString(),
            debitWei: balanceDebit.toString(),
            expectedDebitWei: expectedDebit.toString(),
          },
    blockers: [...blockers].sort(),
  };
}
