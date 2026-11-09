import { describe, expect, it } from "vitest";
import {
  evaluatePreflightEvidence,
  type PreflightExpectation,
  type PreflightObservation,
} from "../../../scripts/real-integrations/chain/preflight.js";

const CONTAINER = "0xc0b4900262d0bc13f2c67c0fc4cf92c04e0ab814";
const OWNER = "0x25063c2210a0bccce3e15d250573179483275f22";
const CAP = 2_000_000_000_000_000n;

const expectation: PreflightExpectation = {
  chainId: 196,
  container: CONTAINER,
  owner: OWNER,
  signer: OWNER,
  budgetCapWei: CAP,
};

function operator(
  name: string,
  overrides: Partial<PreflightObservation> = {},
): PreflightObservation {
  return {
    operator: name,
    rpcHost: `${name}.rpc.example`,
    chainId: 196,
    head: 74_153_000n,
    pinnedBlock: 74_152_998n,
    blockHash: `0x${"ab".repeat(32)}`,
    gasPriceWei: 20_000_001n,
    signerBalanceWei: 10_000_000_000_000_000_000n,
    container: {
      address: CONTAINER,
      tokenChainId: 196n,
      derivedMatches: true,
      isProcessor: true,
      owner: OWNER,
      opened: true,
      readStatus: "verified",
    },
    error: null,
    ...overrides,
  };
}

describe("mainnet preflight evidence", () => {
  it("passes only when two operators agree on chain, pin, owner, container, and budget", () => {
    const evidence = evaluatePreflightEvidence(
      [operator("okx"), operator("drpc")],
      expectation,
    );

    expect(evidence.schema).toBe("tapeci.real-integration.preflight.v1");
    expect(evidence.status).toBe("READY");
    expect(evidence.readOnly).toBe(true);
    expect(evidence.writeActionsPerformed).toBe(false);
    expect(evidence.blockers).toEqual([]);
  });

  it("blocks owner mismatch, unopened container, and insufficient balance", () => {
    const evidence = evaluatePreflightEvidence(
      [
        operator("okx", {
          signerBalanceWei: CAP - 1n,
          container: {
            ...operator("okx").container,
            owner: "0x0000000000000000000000000000000000000001",
            opened: false,
          },
        }),
        operator("drpc", {
          container: {
            ...operator("drpc").container,
            owner: "0x0000000000000000000000000000000000000001",
            opened: false,
          },
        }),
      ],
      expectation,
    );

    expect(evidence.status).toBe("BLOCKED");
    expect(evidence.blockers).toContain("container.owner");
    expect(evidence.blockers).toContain("container.opened");
    expect(evidence.blockers).toContain("signer.balance");
  });

  it("blocks duplicate operators, chain mismatch, and RPC pin disagreement", () => {
    const evidence = evaluatePreflightEvidence(
      [
        operator("okx", { chainId: 1 }),
        operator("okx", {
          pinnedBlock: 74_152_997n,
          blockHash: `0x${"cd".repeat(32)}`,
        }),
      ],
      expectation,
    );

    expect(evidence.status).toBe("BLOCKED");
    expect(evidence.blockers).toContain("operators.independent");
    expect(evidence.blockers).toContain("chainId:okx");
    expect(evidence.blockers).toContain("rpc.pinAgreement");
  });

  it("blocks when a single 100k-gas retry cannot fit the authorized budget", () => {
    const evidence = evaluatePreflightEvidence(
      [operator("okx", { gasPriceWei: 30_000_000_000n }), operator("drpc")],
      expectation,
    );
    expect(evidence.blockers).toContain("gasPrice.budget");
  });
});
