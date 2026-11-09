import { describe, expect, it } from "vitest";
import { approvalDigest, validateApproval } from "@tapeci/queue";
import type { Hex } from "@tapeci/shared";

const signer = "0x1111111111111111111111111111111111111111" as Hex;
const container = "0x2222222222222222222222222222222222222222" as Hex;
const manifestHash = `0x${"ab".repeat(32)}` as Hex;

function approval(expiresAt: bigint) {
  return {
    deploymentId: "11111111-1111-4111-8111-111111111111",
    manifestHash,
    container,
    costCapWei: 10n ** 18n,
    nonce: "contract-approval-nonce",
    expiresAt,
  };
}

describe("EIP-1271 contract approvals", () => {
  it("accepts an invalid EOA signature only when the contract verifier approves", async () => {
    const payload = approval(BigInt(Math.floor(Date.now() / 1000) + 900));
    const digest = approvalDigest(payload, { verifyingContract: container });

    const accepted = await validateApproval({
      approval: payload,
      signature: "0xdeadbeef",
      signerAddress: signer,
      domain: { verifyingContract: container },
      contractSignatureVerifier: async (input) => {
        expect(input.digest).toBe(digest);
        expect(input.signerAddress.toLowerCase()).toBe(signer);
        return true;
      },
    });
    expect(accepted.digest).toBe(digest);
    expect(accepted.signerAddress.toLowerCase()).toBe(signer);

    await expect(
      validateApproval({
        approval: payload,
        signature: "0xdeadbeef",
        signerAddress: signer,
        contractSignatureVerifier: async () => false,
        domain: { verifyingContract: container },
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });
});
