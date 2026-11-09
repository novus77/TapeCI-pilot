import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import {
  assertApprovalSubmissionAllowed,
  assertSignaturePathAllowed,
  maskAddress,
  parseApprovalTypedDataJson,
  parseSignature,
  readExternalSignatureCase,
  verifyApprovalTypedData,
  type ApprovalTypedDataJson,
} from "../../../scripts/real-integrations/wallet/harness.js";
import {
  inspectWalletPreflight,
  runWalletPreflight,
} from "../../../scripts/real-integrations/wallet/preflight.js";
import { buildBrowserChecklistReport } from "../../../scripts/real-integrations/wallet/browser-checklist.js";

const CONTAINER: Address = "0x1111111111111111111111111111111111111111";
const REGISTRY: Address = "0x2222222222222222222222222222222222222222";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const MANIFEST_HASH: Hex = `0x${"33".repeat(32)}`;

function typedData(): ApprovalTypedDataJson {
  return {
    domain: {
      name: "TapeCI",
      version: "1",
      chainId: 196,
      verifyingContract: REGISTRY,
    },
    types: {
      Approval: [
        { name: "deploymentId", type: "string" },
        { name: "manifestHash", type: "bytes32" },
        { name: "container", type: "address" },
        { name: "costCapWei", type: "uint256" },
        { name: "nonce", type: "string" },
        { name: "expiresAt", type: "uint256" },
      ],
    },
    primaryType: "Approval",
    message: {
      deploymentId: DEPLOYMENT_ID,
      manifestHash: MANIFEST_HASH,
      container: CONTAINER,
      costCapWei: "24000000000000000",
      nonce: "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
      expiresAt: "2000000000",
    },
  };
}

describe("real wallet approval parser", () => {
  it("parses the exact TapeCI approval document and normalizes uint256 values", () => {
    const parsed = parseApprovalTypedDataJson(JSON.stringify(typedData()));

    expect(parsed.primaryType).toBe("Approval");
    expect(parsed.domain).toEqual({
      name: "TapeCI",
      version: "1",
      chainId: 196,
      verifyingContract: REGISTRY,
    });
    expect(parsed.message.costCapWei).toBe(24_000_000_000_000_000n);
    expect(parsed.message.expiresAt).toBe(2_000_000_000n);
    expect(parsed.types.Approval).toHaveLength(6);
  });

  it.each([
    ["wrong chain", { domain: { ...typedData().domain, chainId: 1 } }],
    ["wrong domain name", { domain: { ...typedData().domain, name: "Other" } }],
    ["wrong primary type", { primaryType: "Transfer" }],
    ["extra message field", { message: { ...typedData().message, owner: CONTAINER } }],
    ["negative uint256", { message: { ...typedData().message, costCapWei: "-1" } }],
    ["malformed deployment id", { message: { ...typedData().message, deploymentId: "deployment" } }],
  ])("rejects %s", (_label, patch) => {
    expect(() =>
      parseApprovalTypedDataJson(JSON.stringify({ ...typedData(), ...patch })),
    ).toThrow();
  });

  it("rejects oversized input before parsing", () => {
    expect(() => parseApprovalTypedDataJson(" ".repeat(65_537))).toThrow(/too large/i);
  });
});

describe("real wallet signature safety", () => {
  it("accepts only a 65-byte ECDSA signature and never echoes the value in an error", () => {
    const valid = `0x${"ab".repeat(65)}`;
    expect(parseSignature(` ${valid}\n`)).toBe(valid);

    const invalid = `0x${"cd".repeat(10)}`;
    let message = "";
    try {
      parseSignature(invalid);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/65-byte/i);
    expect(message).not.toContain(invalid);
  });

  it("rejects signature paths inside the repository", () => {
    const repositoryRoot = join(tmpdir(), "tapeci-wallet-root");
    expect(() =>
      assertSignaturePathAllowed(join(repositoryRoot, ".tapeci", "signature.txt"), repositoryRoot),
    ).toThrow(/outside the repository/i);
    expect(() =>
      assertSignaturePathAllowed(join(tmpdir(), "tapeci-wallet-signature.txt"), repositoryRoot),
    ).not.toThrow();
  });

  it("requires owner-only permissions for a signature file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tapeci-wallet-permissions-"));
    const typedDataPath = join(directory, "typed-data.json");
    const signaturePath = join(directory, "signature.txt");
    try {
      await writeFile(typedDataPath, JSON.stringify(typedData()), "utf8");
      await writeFile(signaturePath, `0x${"ab".repeat(65)}\n`, "utf8");
      await chmod(signaturePath, 0o644);
      await expect(
        readExternalSignatureCase({
          TAPECI_REAL_WALLET_RUN: "1",
          TAPECI_REAL_WALLET_KIND: "injected",
          TAPECI_REAL_WALLET_TYPED_DATA_FILE: typedDataPath,
          TAPECI_REAL_WALLET_SIGNATURE_FILE: signaturePath,
          TAPECI_REAL_WALLET_SIGNER: CONTAINER,
          TAPECI_REAL_WALLET_REPO_ROOT: join(tmpdir(), "tapeci-wallet-root"),
        }),
      ).rejects.toThrow(/owner-only/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("real wallet EIP-712 verification", () => {
  it("verifies a signature created by an external-signing API without exposing key material", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const document = parseApprovalTypedDataJson(JSON.stringify(typedData()));
    const signature = await account.signTypedData(document);

    const result = await verifyApprovalTypedData({
      document,
      expectedSigner: account.address,
      signature,
    });

    expect(result.verified).toBe(true);
    expect(result.recoveredAddress).toBe(account.address);
    expect(result.recoveredAddress).not.toBeNull();
    expect(maskAddress(result.recoveredAddress!)).toMatch(
      /^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/,
    );
  });

  it("rejects a valid signature from the wrong signer and reports the recovered address", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const expected = privateKeyToAccount(generatePrivateKey());
    const document = parseApprovalTypedDataJson(JSON.stringify(typedData()));
    const signature = await signer.signTypedData(document);

    const result = await verifyApprovalTypedData({
      document,
      expectedSigner: expected.address,
      signature,
    });

    expect(result.verified).toBe(false);
    expect(result.recoveredAddress).toBe(signer.address);
  });
});

describe("opt-in external signer evidence", () => {
  it.skipIf(process.env.TAPECI_REAL_WALLET_RUN !== "1")(
    "verifies a signature produced by a real browser, WalletConnect or hardware wallet",
    async () => {
      const external = await readExternalSignatureCase(process.env);
      const result = await verifyApprovalTypedData({
        document: external.document,
        expectedSigner: external.expectedSigner,
        signature: external.signature,
      });

      expect(
        result.verified,
        `${external.walletKind} signature did not recover to the expected signer`,
      ).toBe(true);
    },
  );
});

describe("wallet preflight and approval submission gates", () => {
  it("reports configuration presence without leaking public ids or wallet addresses", () => {
    const projectId = "a".repeat(32);
    const signer = "0x1111111111111111111111111111111111111111";
    const report = inspectWalletPreflight({
      TAPECI_REAL_WALLET_RUN: "1",
      TAPECI_REAL_WALLET_KIND: "walletconnect",
      TAPECI_REAL_WALLET_SIGNER: signer,
      NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: projectId,
    });
    const serialized = JSON.stringify(report);

    expect(report.optIn).toBe(true);
    expect(report.walletKind).toBe("walletconnect");
    expect(report.walletConnect).toEqual({ configured: true, projectIdLength: 32 });
    expect(report.externalSignature.signerPresent).toBe(true);
    expect(serialized).not.toContain(projectId);
    expect(serialized).not.toContain(signer);
  });

  it("requires both the environment switch and an explicit CLI confirmation before submission", () => {
    expect(() =>
      assertApprovalSubmissionAllowed({ TAPECI_REAL_WALLET_SUBMIT: "1" }, false),
    ).toThrow(/confirm/i);
    expect(() => assertApprovalSubmissionAllowed({}, true)).toThrow(/SUBMIT=1/i);
    expect(() =>
      assertApprovalSubmissionAllowed({ TAPECI_REAL_WALLET_SUBMIT: "1" }, true),
    ).not.toThrow();
  });

  it("checks a loopback API only when real integration is explicitly requested", async () => {
    let calls = 0;
    const fetchHealth = async () => {
      calls += 1;
      return new Response("ok", { status: 200 });
    };

    const skipped = await runWalletPreflight({
      env: { TAPECI_REAL_WALLET_API_URL: "http://127.0.0.1:8787" },
      fetchHealth,
    });
    expect(skipped.apiCheck).toBe("skipped");
    expect(calls).toBe(0);

    const passed = await runWalletPreflight({
      env: {
        TAPECI_REAL_WALLET_RUN: "1",
        TAPECI_REAL_WALLET_API_URL: "http://127.0.0.1:8787",
      },
      fetchHealth,
    });
    expect(passed.apiCheck).toBe("passed");
    expect(calls).toBe(1);

    await expect(
      runWalletPreflight({
        env: {
          TAPECI_REAL_WALLET_RUN: "1",
          TAPECI_REAL_WALLET_API_URL: "https://ci.example.test",
        },
        fetchHealth,
      }),
    ).rejects.toThrow(/loopback/i);
  });
});

describe("approval submission request safety", () => {
  it("builds the documented API body while rejecting credential-bearing URLs", async () => {
    const { buildApprovalSubmissionRequest } = await import(
      "../../../scripts/real-integrations/wallet/submit-approval.js"
    );
    const approval = {
      manifestHash: MANIFEST_HASH,
      container: CONTAINER,
      costCapWei: "24000000000000000",
      nonce: "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
      expiresAt: "2000000000",
    };
    const request = buildApprovalSubmissionRequest({
      apiUrl: "http://127.0.0.1:8787",
      deploymentId: DEPLOYMENT_ID,
      signerAddress: CONTAINER,
      signature: `0x${"ab".repeat(65)}`,
      approval,
    });
    expect(request.url).toBe(
      `http://127.0.0.1:8787/v1/deployments/${DEPLOYMENT_ID}/approve`,
    );
    expect(JSON.parse(request.body)).toEqual({
      signerAddress: CONTAINER,
      signature: `0x${"ab".repeat(65)}`,
      approval,
    });
    expect(() =>
      buildApprovalSubmissionRequest({
        apiUrl: "https://user:password@ci.example.test",
        deploymentId: DEPLOYMENT_ID,
        signerAddress: CONTAINER,
        signature: `0x${"ab".repeat(65)}`,
        approval,
      }),
    ).toThrow(/credentials/i);
    expect(() =>
      buildApprovalSubmissionRequest({
        apiUrl: "https://ci.example.test",
        deploymentId: DEPLOYMENT_ID,
        signerAddress: CONTAINER,
        signature: `0x${"ab".repeat(65)}`,
        approval,
      }),
    ).toThrow(/external/i);
    expect(() =>
      buildApprovalSubmissionRequest({
        apiUrl: "https://ci.example.test",
        allowExternal: true,
        deploymentId: DEPLOYMENT_ID,
        signerAddress: CONTAINER,
        signature: `0x${"ab".repeat(65)}`,
        approval,
      }),
    ).not.toThrow();
  });
});

describe("browser checklist classification", () => {
  it("distinguishes WalletConnect availability from a manual-signing fallback", () => {
    expect(
      buildBrowserChecklistReport({
        injectedProvider: false,
        connectorLabels: ["WalletConnect"],
        chainId: null,
        expectedChainId: 196,
      }),
    ).toEqual({
      injectedProvider: false,
      walletConnectVisible: true,
      chainId: null,
      chainCorrect: false,
      manualSigningRequired: false,
    });

    expect(
      buildBrowserChecklistReport({
        injectedProvider: false,
        connectorLabels: ["Injected"],
        chainId: null,
        expectedChainId: 196,
      }).manualSigningRequired,
    ).toBe(true);
  });
});
