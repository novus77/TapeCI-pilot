import { describe, expect, it } from "vitest";
import {
  APPROVAL_CHAIN_ID,
  APPROVAL_DOMAIN_NAME,
  APPROVAL_DOMAIN_VERSION,
  APPROVAL_PRIMARY_TYPE,
  APPROVAL_TYPES,
  approvalTypedDataDocument,
  describeSignatureProblem,
  detectInjectedWallet,
  formatApprovalPayloadJson,
  normalizeSignature,
} from "../../apps/web/lib/approval-signature.js";
import type { ApprovalTypedData } from "../../apps/web/lib/types.js";

const signature = `0x${"ab".repeat(65)}` as const;

const payload: ApprovalTypedData = {
  domain: {
    name: APPROVAL_DOMAIN_NAME,
    version: APPROVAL_DOMAIN_VERSION,
    chainId: APPROVAL_CHAIN_ID,
    verifyingContract: `0x${"11".repeat(20)}`,
  },
  types: APPROVAL_TYPES,
  primaryType: APPROVAL_PRIMARY_TYPE,
  message: {
    deploymentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    manifestHash: `0x${"22".repeat(32)}`,
    container: `0x${"33".repeat(20)}`,
    costCapWei: "1873613952000000",
    nonce: "nnnnnnnn-nnnn-4nnn-8nnn-nnnnnnnnnnnn",
    expiresAt: "1792862822",
  },
  approval: {
    manifestHash: `0x${"22".repeat(32)}`,
    container: `0x${"33".repeat(20)}`,
    costCapWei: "1873613952000000",
    nonce: "nnnnnnnn-nnnn-4nnn-8nnn-nnnnnnnnnnnn",
    expiresAt: "1792862822",
  },
  expectedSigner: `0x${"44".repeat(20)}`,
} as unknown as ApprovalTypedData;

describe("approval signature helpers", () => {
  it("accepts a 65-byte signature and trims whitespace", () => {
    expect(normalizeSignature(`  ${signature}  `)).toBe(signature);
    expect(describeSignatureProblem(signature)).toBeNull();
  });

  it("explains each malformed signature shape", () => {
    expect(describeSignatureProblem("")).toContain("Paste the 65-byte signature");
    expect(describeSignatureProblem("abcd")).toContain("starts with 0x");
    expect(describeSignatureProblem("0xdeadbeef")).toContain("130 hex characters");
    expect(normalizeSignature("0xdeadbeef")).toBeNull();
  });

  it("projects the payload onto the signed document only", () => {
    const doc = approvalTypedDataDocument(payload);
    expect(Object.keys(doc).sort()).toEqual(["domain", "message", "primaryType", "types"]);
    expect(doc.domain.chainId).toBe(196);
    const fields = doc.types.Approval;
    expect(fields).toBeDefined();
    expect(fields?.map((field) => field.name)).toEqual([
      "deploymentId",
      "manifestHash",
      "container",
      "costCapWei",
      "nonce",
      "expiresAt",
    ]);
  });

  it("formats stable JSON without the submit-only fields", () => {
    const json = formatApprovalPayloadJson(payload);
    expect(json).toContain('"primaryType": "Approval"');
    expect(json).toContain('"chainId": 196');
    expect(json).not.toContain("expectedSigner");
    expect(json).not.toContain('"approval"');
    expect(formatApprovalPayloadJson(payload)).toBe(json);
  });

  it("detects an injected wallet without assuming a shape", () => {
    expect(detectInjectedWallet({ ethereum: {} })).toBe(true);
    expect(detectInjectedWallet({})).toBe(false);
    expect(detectInjectedWallet(null)).toBe(false);
    expect(detectInjectedWallet("ethereum")).toBe(false);
  });
});
