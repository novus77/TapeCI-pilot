import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  APPROVAL_PRIMARY_TYPE,
  APPROVAL_TYPES,
  OwnershipChangedError,
  OperatorAuthorizationError,
  approvalDigest,
  approvalTypedData,
  assertOperatorAuthorized,
  assertOwnerUnchanged,
  createOperatorSession,
  recordApproval,
  revokeOperatorSession,
  revokeOperatorSessionsForContainer,
  validateApproval,
  verifyApprovalSignature,
  type ApprovalPayload,
  type Database,
} from "@tapeci/queue";
import {
  detectServices,
  randomAddress,
  seedDeployment,
  setupTestDatabase,
  type SeededDeployment,
  type TestDatabaseHandle,
} from "./helpers.js";

const services = await detectServices();
const describeDb = services.database ? describe : describe.skip;

function randomAccount() {
  return privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
}

function unixNow(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000));
}

function buildApproval(
  seed: SeededDeployment,
  overrides: Partial<ApprovalPayload> = {},
): ApprovalPayload {
  return {
    deploymentId: seed.deploymentId,
    manifestHash: (seed.manifestSha256 ?? "0x") as `0x${string}`,
    container: seed.containerAddress as `0x${string}`,
    costCapWei: 5_000_000_000_000_000n,
    nonce: `0x${randomBytes(16).toString("hex")}`,
    expiresAt: unixNow() + 600n,
    ...overrides,
  };
}

function domain(seed: SeededDeployment) {
  return { chainId: 196, verifyingContract: seed.registryAddress };
}

describeDb("EIP-712 approval and temporary operator sessions", () => {
  let handle: TestDatabaseHandle | undefined;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
  });

  function db(): Database {
    if (handle === undefined) throw new Error("test database is not ready");
    return handle.db;
  }

  it("defines the fixed EIP-712 approval struct", () => {
    expect(APPROVAL_PRIMARY_TYPE).toBe("Approval");
    expect(APPROVAL_TYPES.Approval.map((field) => field.name)).toEqual([
      "deploymentId",
      "manifestHash",
      "container",
      "costCapWei",
      "nonce",
      "expiresAt",
    ]);
  });

  it("produces a deterministic digest bound to every approval field", async () => {
    const seed = await seedDeployment(db());
    const approval = buildApproval(seed);
    const digest = approvalDigest(approval, domain(seed));
    expect(approvalDigest(approval, domain(seed))).toBe(digest);

    const mutants: Partial<ApprovalPayload>[] = [
      { manifestHash: `0x${"11".repeat(32)}` },
      { container: randomAddress() },
      { costCapWei: approval.costCapWei + 1n },
      { nonce: `${approval.nonce}-x` },
      { expiresAt: approval.expiresAt + 1n },
    ];
    for (const mutant of mutants) {
      expect(approvalDigest({ ...approval, ...mutant }, domain(seed))).not.toBe(digest);
    }
    // Verification contract (registry) is part of the EIP-712 domain.
    expect(
      approvalDigest(approval, { chainId: 196, verifyingContract: randomAddress() }),
    ).not.toBe(digest);
  });

  it("verifies the EIP-712 signature and rejects tampered payloads/signers", async () => {
    const seed = await seedDeployment(db());
    const account = randomAccount();
    const approval = buildApproval(seed);
    const signature = await account.signTypedData(approvalTypedData(approval, domain(seed)));

    await expect(
      verifyApprovalSignature({
        approval,
        signature,
        signerAddress: account.address,
        domain: domain(seed),
      }),
    ).resolves.toBe(true);

    await expect(
      verifyApprovalSignature({
        approval: { ...approval, manifestHash: `0x${"22".repeat(32)}` },
        signature,
        signerAddress: account.address,
        domain: domain(seed),
      }),
    ).resolves.toBe(false);

    await expect(
      verifyApprovalSignature({
        approval,
        signature,
        signerAddress: randomAccount().address,
        domain: domain(seed),
      }),
    ).resolves.toBe(false);
  });

  it("validates digest, expiry, cost cap and scope binding", async () => {
    const seed = await seedDeployment(db());
    const account = randomAccount();
    const approval = buildApproval(seed);
    const digest = approvalDigest(approval, domain(seed));
    const signature = await account.signTypedData(approvalTypedData(approval, domain(seed)));

    const validated = await validateApproval({
      approval,
      signature,
      signerAddress: account.address,
      digest,
      domain: domain(seed),
      userCostCapWei: approval.costCapWei,
      expected: {
        deploymentId: seed.deploymentId,
        ...(seed.manifestSha256 === null ? {} : { manifestHash: seed.manifestSha256 }),
        container: seed.containerAddress,
      },
    });
    expect(validated.digest).toBe(digest);
    expect(validated.expiresAt.getTime()).toBe(Number(approval.expiresAt) * 1_000);

    await expect(
      validateApproval({
        approval,
        signature,
        signerAddress: account.address,
        digest: `0x${"33".repeat(32)}`,
        domain: domain(seed),
      }),
    ).rejects.toMatchObject({
      code: "PLAN_STALE",
      details: { reason: "approval_digest_mismatch" },
    });

    const expired = { ...approval, expiresAt: unixNow() - 10n };
    await expect(
      validateApproval({
        approval: expired,
        signature: await account.signTypedData(approvalTypedData(expired, domain(seed))),
        signerAddress: account.address,
        domain: domain(seed),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });

    await expect(
      validateApproval({
        approval,
        signature,
        signerAddress: account.address,
        domain: domain(seed),
        userCostCapWei: approval.costCapWei - 1n,
      }),
    ).rejects.toMatchObject({ code: "FEE_OVER_BUDGET" });

    await expect(
      validateApproval({
        approval,
        signature,
        signerAddress: account.address,
        domain: domain(seed),
        expected: { manifestHash: `0x${"44".repeat(32)}` },
      }),
    ).rejects.toMatchObject({
      code: "PLAN_STALE",
      details: { reason: "approval_manifest_mismatch" },
    });

    await expect(
      validateApproval({
        approval,
        signature,
        signerAddress: randomAccount().address,
        domain: domain(seed),
      }),
    ).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
      details: { reason: "invalid_approval_signature" },
    });
  });

  it("records approvals once and rejects digest/nonce replay", async () => {
    const seed = await seedDeployment(db());
    const account = randomAccount();
    const approval = buildApproval(seed);
    const digest = approvalDigest(approval, domain(seed));
    const signature = await account.signTypedData(approvalTypedData(approval, domain(seed)));

    const recorded = await recordApproval(db(), {
      deploymentId: seed.deploymentId,
      manifestSha256: seed.manifestSha256 ?? "",
      containerAddress: seed.containerAddress,
      registryAddress: seed.registryAddress,
      approval,
      signature,
      signerAddress: account.address,
      digest,
    });
    expect(recorded.approvalDigest).toBe(digest);
    expect(recorded.signerAddress).toBe(account.address.toLowerCase());
    expect(recorded.chainId).toBe(196);

    await expect(
      recordApproval(db(), {
        deploymentId: seed.deploymentId,
        manifestSha256: seed.manifestSha256 ?? "",
        containerAddress: seed.containerAddress,
        registryAddress: seed.registryAddress,
        approval,
        signature,
        signerAddress: account.address,
        digest,
      }),
    ).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
      details: { reason: "approval_digest_reused" },
    });
  });

  it("creates operator sessions with a bounded TTL and rejects expired grants", async () => {
    const seed = await seedDeployment(db());
    const signer = randomAccount().address;

    const session = await createOperatorSession(db(), {
      containerId: seed.containerId,
      signerAddress: signer,
      ttlSeconds: 120,
    });
    const sessionTtlMs = session.expiresAt.getTime() - session.createdAt.getTime();
    expect(sessionTtlMs).toBeGreaterThan(118_000);
    expect(sessionTtlMs).toBeLessThan(122_000);
    await expect(
      assertOperatorAuthorized(db(), {
        containerId: seed.containerId,
        signerAddress: signer,
      }),
    ).resolves.toMatchObject({ id: session.id, signerAddress: signer.toLowerCase() });

    await expect(
      createOperatorSession(db(), { containerId: seed.containerId, signerAddress: signer, ttlSeconds: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      createOperatorSession(db(), {
        containerId: seed.containerId,
        signerAddress: signer,
        ttlSeconds: 86_401,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("rejects revoked and expired operator sessions with a typed error", async () => {
    const seed = await seedDeployment(db());
    const signer = randomAccount().address;

    const expired = await createOperatorSession(db(), {
      containerId: seed.containerId,
      signerAddress: signer,
      ttlSeconds: 60,
      now: new Date(Date.now() - 120_000),
    });
    const expiredError = await assertOperatorAuthorized(db(), {
      containerId: seed.containerId,
      signerAddress: signer,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(expiredError).toBeInstanceOf(OperatorAuthorizationError);
    expect(expiredError).toMatchObject({
      requiredState: "AUTH_REVOKED",
      details: { reason: "operator_session_expired" },
    });

    const live = await createOperatorSession(db(), {
      containerId: seed.containerId,
      signerAddress: signer,
      ttlSeconds: 3_600,
    });
    await expect(revokeOperatorSession(db(), live.id)).resolves.toMatchObject({ id: live.id });
    const revokedError = await assertOperatorAuthorized(db(), {
      containerId: seed.containerId,
      signerAddress: signer,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(revokedError).toMatchObject({ details: { reason: "operator_session_revoked" } });

    const missingError = await assertOperatorAuthorized(db(), {
      containerId: seed.containerId,
      signerAddress: randomAccount().address,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(missingError).toMatchObject({ details: { reason: "no_operator_session" } });
    expect(expired.id).not.toBe(live.id);
  });

  it("revokes every live session for a container after an ownership change is detected", async () => {
    const seed = await seedDeployment(db());
    const signer = randomAccount().address;
    await createOperatorSession(db(), {
      containerId: seed.containerId,
      signerAddress: signer,
      ttlSeconds: 3_600,
    });
    const revoked = await revokeOperatorSessionsForContainer(db(), seed.containerId);
    expect(revoked).toBeGreaterThanOrEqual(1);
    await expect(
      assertOperatorAuthorized(db(), {
        containerId: seed.containerId,
        signerAddress: signer,
      }),
    ).rejects.toMatchObject({ details: { reason: "operator_session_revoked" } });
  });

  it("fails closed when the live container owner differs from the cached owner", () => {
    const owner = randomAddress();
    expect(() => assertOwnerUnchanged(owner, owner.toUpperCase().replace("0X", "0x"))).not.toThrow();

    let thrown: unknown;
    try {
      assertOwnerUnchanged(randomAddress(), owner);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OwnershipChangedError);
    expect(thrown).toMatchObject({
      code: "NOT_CURRENT_OWNER",
      requiredState: "OWNERSHIP_CHANGED",
    });

    expect(() => assertOwnerUnchanged(null, owner)).toThrow(OwnershipChangedError);
  });
});
