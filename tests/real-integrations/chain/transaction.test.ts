import { describe, expect, it } from "vitest";
import {
  evaluateTransactionEvidence,
  requireRealIntegrationOptIn,
  type TransactionExpectation,
  type TransactionObservation,
} from "../../../scripts/real-integrations/chain/transaction.js";
import { isTapeCiError } from "@tapeci/shared";

const HASH = `0x${"ab".repeat(32)}` as const;
const BLOCK_HASH = `0x${"cd".repeat(32)}` as const;
const FROM = "0x25063c2210a0bccce3e15d250573179483275f22";
const TO = "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6";
const FEE = 21_000n * 1_000_000_000n;

const expectation: TransactionExpectation = {
  chainId: 196,
  hash: HASH,
  from: FROM,
  to: TO,
  maxFeeWei: 30_000_000_000_000n,
  minConfirmations: 2,
};

function observation(
  operator: string,
  overrides: Partial<TransactionObservation> = {},
): TransactionObservation {
  return {
    operator,
    rpcHost: `${operator}.rpc.example`,
    chainId: 196,
    latestBlock: 101n,
    transaction: {
      hash: HASH,
      from: FROM,
      to: TO,
      valueWei: 0n,
    },
    receipt: {
      transactionHash: HASH,
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      status: "success",
      gasUsed: 21_000n,
      effectiveGasPriceWei: 1_000_000_000n,
    },
    balanceBeforeWei: 1_000_000_000_000_000_000n,
    balanceAfterWei: 1_000_000_000_000_000_000n - FEE,
    error: null,
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(isTapeCiError(error)).toBe(true);
    if (!isTapeCiError(error)) return;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("real integration opt-in", () => {
  it("is blocked unless TAPECI_REAL_INTEGRATION=1", () => {
    expectCode(() => requireRealIntegrationOptIn({}), "INVALID_CONFIG");
    expectCode(
      () => requireRealIntegrationOptIn({ TAPECI_REAL_INTEGRATION: "true" }),
      "INVALID_CONFIG",
    );
  });

  it("accepts the exact opt-in value", () => {
    expect(() => requireRealIntegrationOptIn({ TAPECI_REAL_INTEGRATION: "1" })).not.toThrow();
  });
});

describe("transaction evidence", () => {
  it("verifies a successful receipt, actual fee, and matching balance debit", () => {
    const evidence = evaluateTransactionEvidence(
      [observation("okx"), observation("drpc")],
      expectation,
    );

    expect(evidence.schema).toBe("tapeci.real-integration.transaction.v1");
    expect(evidence.readOnly).toBe(true);
    expect(evidence.writeActionsPerformed).toBe(false);
    expect(evidence.status).toBe("VERIFIED");
    expect(evidence.receipt?.confirmations).toBe(2);
    expect(evidence.receipt?.feeWei).toBe(FEE.toString());
    expect(evidence.balance?.debitWei).toBe(FEE.toString());
    expect(evidence.blockers).toEqual([]);
  });

  it("blocks chain mismatch and duplicate RPC operators", () => {
    const evidence = evaluateTransactionEvidence(
      [observation("okx", { chainId: 1 }), observation("okx")],
      expectation,
    );

    expect(evidence.status).toBe("BLOCKED");
    expect(evidence.blockers).toContain("operators.independent");
    expect(evidence.blockers).toContain("chainId:okx");
  });

  it("blocks a missing or reverted receipt", () => {
    const missing = evaluateTransactionEvidence(
      [
        observation("okx", { receipt: null }),
        observation("drpc", { receipt: null }),
      ],
      expectation,
    );
    expect(missing.status).toBe("BLOCKED");
    expect(missing.blockers).toContain("receipt.present");

    const reverted = evaluateTransactionEvidence(
      [
        observation("okx", {
          receipt: { ...observation("okx").receipt!, status: "reverted" },
        }),
        observation("drpc", {
          receipt: { ...observation("drpc").receipt!, status: "reverted" },
        }),
      ],
      expectation,
    );
    expect(reverted.status).toBe("BLOCKED");
    expect(reverted.blockers).toContain("receipt.status");
  });

  it("blocks insufficient confirmations and RPC receipt disagreement", () => {
    const evidence = evaluateTransactionEvidence(
      [
        observation("okx", { latestBlock: 100n }),
        observation("drpc", {
          receipt: { ...observation("drpc").receipt!, blockHash: `0x${"ef".repeat(32)}` },
        }),
      ],
      expectation,
    );

    expect(evidence.status).toBe("BLOCKED");
    expect(evidence.blockers).toContain("receipt.confirmations");
    expect(evidence.blockers).toContain("receipt.agreement");
  });

  it("blocks a fee above the authorized cap", () => {
    const evidence = evaluateTransactionEvidence(
      [observation("okx"), observation("drpc")],
      { ...expectation, maxFeeWei: FEE - 1n },
    );

    expect(evidence.status).toBe("BLOCKED");
    expect(evidence.blockers).toContain("fee.cap");
  });

  it("blocks when the observed balance debit does not equal fee plus value", () => {
    const evidence = evaluateTransactionEvidence(
      [
        observation("okx", { balanceAfterWei: 999_000_000_000_000_000n }),
        observation("drpc"),
      ],
      expectation,
    );

    expect(evidence.status).toBe("BLOCKED");
    expect(evidence.blockers).toContain("balance.debit");
  });

  it("does not serialize endpoint credentials", () => {
    const evidence = evaluateTransactionEvidence(
      [
        observation("okx", { rpcHost: "rpc.example.test?api_key=super-secret" }),
        observation("drpc"),
      ],
      expectation,
    );
    const json = JSON.stringify(evidence);
    expect(json).not.toContain("super-secret");
    expect(json).toContain("rpc.example.test");
  });
});
