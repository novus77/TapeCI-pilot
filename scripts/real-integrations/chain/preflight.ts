import { getAddress } from "viem";
import { TapeCiError } from "@tapeci/shared";
import {
  REAL_INTEGRATION_SCHEMA_VERSION,
  errorMessage,
  normalizeAddress,
  safeRpcHost,
  uniqueStrings,
} from "./common.js";

export interface PreflightExpectation {
  readonly chainId: number;
  readonly container: string;
  readonly owner: string;
  readonly signer: string;
  readonly budgetCapWei: bigint;
}

export interface PreflightObservation {
  readonly operator: string;
  readonly rpcHost: string;
  readonly chainId: number;
  readonly head: bigint;
  readonly pinnedBlock: bigint;
  readonly blockHash: string;
  readonly gasPriceWei: bigint;
  readonly signerBalanceWei: bigint;
  readonly container: {
    readonly address: string;
    readonly tokenChainId: bigint;
    readonly derivedMatches: boolean;
    readonly isProcessor: boolean;
    readonly owner: string | null;
    /**
     * `null` when the read failed. Evidence must never carry `false` for an unknown
     * (§8.6); `evaluatePreflightEvidence` blocks on `null` and on `readStatus !== "verified"`.
     */
    readonly opened: boolean | null;
    readonly readStatus: "verified" | "not_found" | "unavailable";
  };
  readonly error: string | null;
}

export interface PreflightEvidence {
  readonly schema: "tapeci.real-integration.preflight.v1";
  readonly schemaVersion: typeof REAL_INTEGRATION_SCHEMA_VERSION;
  readonly observedAt: string;
  readonly readOnly: true;
  readonly writeActionsPerformed: false;
  readonly status: "READY" | "BLOCKED";
  readonly expected: {
    readonly chainId: number;
    readonly container: string;
    readonly owner: string;
    readonly signer: string;
    readonly budgetCapWei: string;
  };
  readonly operators: readonly {
    readonly operator: string;
    readonly rpcHost: string;
    readonly chainId: number;
    readonly head: string;
    readonly pinnedBlock: string;
    readonly blockHash: string | null;
    readonly gasPriceWei: string;
    readonly signerBalanceWei: string;
    readonly owner: string | null;
    /** `null` = the read failed; the evidence never records an unknown as `false`. */
    readonly opened: boolean | null;
    readonly readStatus: "verified" | "not_found" | "unavailable";
    readonly error: string | null;
  }[];
  readonly blockers: readonly string[];
}

function sameAddress(left: string | null, right: string): boolean {
  return left !== null && getAddress(left) === getAddress(right);
}

export function evaluatePreflightEvidence(
  observations: readonly PreflightObservation[],
  expectation: PreflightExpectation,
  observedAt = new Date().toISOString(),
): PreflightEvidence {
  const expected = {
    chainId: expectation.chainId,
    container: normalizeAddress(expectation.container, "container"),
    owner: normalizeAddress(expectation.owner, "owner"),
    signer: normalizeAddress(expectation.signer, "signer"),
    budgetCapWei: expectation.budgetCapWei,
  };
  if (expected.budgetCapWei <= 0n) {
    throw new TapeCiError("INVALID_CONFIG", "budgetCapWei must be greater than zero");
  }
  const operators = observations.map((entry) => entry.operator.trim());
  const blockers = new Set<string>();
  if (
    observations.length < 2 ||
    operators.some((operator) => operator.length === 0) ||
    uniqueStrings(operators).length !== operators.length
  ) {
    blockers.add("operators.independent");
  }

  for (const entry of observations) {
    if (entry.error !== null) blockers.add(`rpc:${entry.operator}`);
    if (entry.chainId !== expected.chainId) blockers.add(`chainId:${entry.operator}`);
    if (!sameAddress(entry.container.address, expected.container)) {
      blockers.add("container.address");
    }
    if (entry.container.tokenChainId !== BigInt(expected.chainId)) {
      blockers.add("container.tokenChainId");
    }
    if (!entry.container.isProcessor || !entry.container.derivedMatches) {
      blockers.add("container.derivation");
    }
    if (!sameAddress(entry.container.owner, expected.owner)) blockers.add("container.owner");
    if (entry.container.readStatus !== "verified") blockers.add(`container.readStatus:${entry.operator}`);
    // A failed read is not "not opened": it blocks the preflight on its own name.
    if (entry.container.opened === false) blockers.add("container.opened");
    if (entry.container.opened === null) blockers.add(`container.openedUnreadable:${entry.operator}`);
    if (entry.signerBalanceWei < expected.budgetCapWei) blockers.add("signer.balance");
    if (entry.gasPriceWei * 100_000n > expected.budgetCapWei) {
      blockers.add("gasPrice.budget");
    }
    if (entry.pinnedBlock > entry.head) blockers.add("rpc.pinAgreement");
  }

  const first = observations[0];
  if (
    first !== undefined &&
    observations.some(
      (entry) =>
        entry.pinnedBlock !== first.pinnedBlock ||
        entry.blockHash.toLowerCase() !== first.blockHash.toLowerCase() ||
        entry.container.opened !== first.container.opened ||
        entry.container.readStatus !== first.container.readStatus ||
        entry.container.derivedMatches !== first.container.derivedMatches ||
        entry.container.isProcessor !== first.container.isProcessor ||
        entry.container.tokenChainId !== first.container.tokenChainId ||
        !sameAddress(entry.container.owner, first.container.owner ?? "") ||
        !sameAddress(entry.container.address, first.container.address),
    )
  ) {
    blockers.add("rpc.pinAgreement");
  }

  return {
    schema: "tapeci.real-integration.preflight.v1",
    schemaVersion: REAL_INTEGRATION_SCHEMA_VERSION,
    observedAt,
    readOnly: true,
    writeActionsPerformed: false,
    status: blockers.size === 0 ? "READY" : "BLOCKED",
    expected: {
      chainId: expected.chainId,
      container: expected.container,
      owner: expected.owner,
      signer: expected.signer,
      budgetCapWei: expected.budgetCapWei.toString(),
    },
    operators: observations.map((entry) => ({
      operator: entry.operator,
      rpcHost: safeRpcHost(entry.rpcHost),
      chainId: entry.chainId,
      head: entry.head.toString(),
      pinnedBlock: entry.pinnedBlock.toString(),
      blockHash: /^0x[0-9a-fA-F]{64}$/u.test(entry.blockHash)
        ? entry.blockHash.toLowerCase()
        : null,
      gasPriceWei: entry.gasPriceWei.toString(),
      signerBalanceWei: entry.signerBalanceWei.toString(),
      owner: entry.container.owner === null ? null : normalizeAddress(entry.container.owner, "owner"),
      opened: entry.container.opened,
      readStatus: entry.container.readStatus,
      error: entry.error === null ? null : errorMessage(entry.error),
    })),
    blockers: [...blockers].sort(),
  };
}
