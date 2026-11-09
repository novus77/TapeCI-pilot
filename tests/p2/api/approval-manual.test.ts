/**
 * Manual (no browser wallet) EIP-712 approval path.
 *
 * The wallet path signs the payload the API returns with the owner EOA; the manual
 * path (paste a signature / `scripts/p2/sign-approval.ts`) must be verified by the
 * exact same code. These tests sign with viem `signTypedData` over the raw JSON the
 * payload endpoint returns — decimal strings, no bigint conversion — and assert the
 * approve route accepts it for the container owner and rejects another key.
 */
import { randomBytes, randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData, verifyTypedData } from "viem";
import { approvalDigest, approvalTypedData } from "@tapeci/queue";
import {
  approvals,
  containers,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  deploymentEvents,
  deployments,
  githubInstallations,
  migrateUp,
  projectMembers,
  projects,
  type Database,
} from "@tapeci/database";
import type { Hex } from "@tapeci/shared";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps, ResolvedContainer } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";

const available = await databaseAvailable();
const CONTAINER = "0x25b20d3ea6b207506340eab2eb0f45edc800f6b3" as Hex;
const REGISTRY = "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6" as Hex;
const SESSION_SECRET = "test-session-secret-123456";
const WEBHOOK_SECRET = "test-webhook-secret";

/** Hardhat/Anvil account #1 — test-only key, never a real owner. */
const OWNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
/** Hardhat/Anvil account #0 — the "attacker"/wrong signer in these tests. */
const OTHER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

const env: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: SESSION_SECRET,
  devAuth: true,
  objectStoreDir: ".tapeci/objects",
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: WEBHOOK_SECRET,
  githubOidcAudience: "tapeci-artifact-upload",
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
  operatorPrivateKey: null,
  writeRpcUrl: null,
  journalDir: ".tapeci/journal",
  githubAppSlug: null,
  githubOAuthClientId: null,
  githubOAuthClientSecret: null,
  githubOAuthBaseUrl: "https://github.com",
  githubApiBaseUrl: "https://api.github.com",
  publicApiUrl: "http://127.0.0.1:8787",
  webUrl: "http://127.0.0.1:3000",
  sessionTtlSeconds: 604_800,
};

const resolved: ResolvedContainer = {
  address: CONTAINER,
  factory: "0x1f09daefa827f02cbb40967cc91b259763760761",
  opener: "0x536add8f30f03b69f6fbf29d425a816a0dc50106",
  registry: REGISTRY,
  binding: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
  processorIndex: 0,
  processor: "0x839bdd6fa7a66416a609a735e11de5411b98574e",
  tokenId: "2",
  owner: OWNER.address.toLowerCase() as Hex,
  opened: true,
};

const devHeaders = {
  "x-tapeci-github-login": "dev-user",
  "x-tapeci-github-user-id": "4242",
  "content-type": "application/json",
};

/** The JSON the payload route returns (decimal strings, as a browser/CLI sees it). */
interface PayloadBody {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: Hex;
  };
  readonly types: Readonly<Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>>;
  readonly primaryType: string;
  readonly message: {
    readonly deploymentId: string;
    readonly manifestHash: Hex;
    readonly container: Hex;
    readonly costCapWei: string;
    readonly nonce: string;
    readonly expiresAt: string;
  };
  readonly approval: {
    readonly manifestHash: Hex;
    readonly container: Hex;
    readonly costCapWei: string;
    readonly nonce: string;
    readonly expiresAt: string;
  };
  readonly expectedSigner: Hex | null;
}

/** Sign exactly what the API handed out, without reinterpreting number types. */
function signPayload(account: typeof OWNER, payload: PayloadBody) {
  return account.signTypedData({
    domain: payload.domain,
    types: payload.types,
    primaryType: "Approval",
    message: payload.message,
  } as Parameters<typeof account.signTypedData>[0]);
}

describe.skipIf(!available)("manual EIP-712 approval", () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;
  let userId = "";
  let installationId = "";

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await migrateUp(testDatabase.url);
    handle = createDatabase(testDatabase.url);
    db = handle.db;

    const deps: ApiDeps = {
      db,
      env,
      resolveContainer: async () => resolved,
      // Contract owners are not exercised here; a stub keeps the EIP-1271 fallback
      // from reaching the network when an EOA signature fails.
      verifyContractSignature: async () => false,
    };
    app = buildApp(deps);
    await app.ready();

    // Resolve the dev user; every seeded deployment gets its own project+container
    // because `deployments_one_chain_writer_per_container` allows only one
    // APPROVED/AWAITING deployment per container at a time.
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: devHeaders });
    expect(me.statusCode).toBe(200);
    userId = (me.json() as { id: string }).id;
    const [installation] = await db
      .insert(githubInstallations)
      .values({ installationId: 9001, githubAccountId: 4242, accountLogin: "dev-user" })
      .returning();
    if (installation === undefined) throw new Error("installation fixture failed");
    installationId = installation.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await handle?.pool.end();
    await testDatabase?.drop();
  }, 30_000);

  /**
   * A PLAN_READY deployment with a signed plan, ready for approval, on its own
   * project + container (the container owner is the test EOA).
   */
  async function seedDeployment(): Promise<{
    id: string;
    manifestSha256: Hex;
    containerAddress: Hex;
  }> {
    const manifestSha256 = `0x${"ab".repeat(32)}` as Hex;
    const containerAddress = `0x${randomBytes(20).toString("hex")}` as Hex;
    const [container] = await db
      .insert(containers)
      .values({
        chainId: 196,
        factoryAddress: resolved.factory,
        processorIndex: 0,
        processorAddress: `0x${randomBytes(20).toString("hex")}`,
        tokenId: String(randomInt(1, 1_000_000)),
        containerAddress,
        registryAddress: REGISTRY,
        bindingAddress: resolved.binding,
        lastObservedOwner: OWNER.address.toLowerCase(),
      })
      .returning();
    if (container === undefined) throw new Error("container fixture failed");
    const [project] = await db
      .insert(projects)
      .values({
        ownerUserId: userId,
        githubInstallationId: installationId,
        githubRepositoryId: randomInt(1, 2_000_000_000),
        repoFullName: `acme/site-${randomInt(1, 2_000_000_000)}`,
        containerId: container.id,
      })
      .returning();
    if (project === undefined) throw new Error("project fixture failed");
    await db
      .insert(projectMembers)
      .values({ projectId: project.id, userId, role: "owner" })
      .onConflictDoNothing();
    const [deployment] = await db
      .insert(deployments)
      .values({
        projectId: project.id,
        containerId: container.id,
        triggerKind: "manual",
        commitSha: randomBytes(20).toString("hex"),
        state: "PLAN_READY",
        registryAddress: REGISTRY,
        manifestSha256,
        planJson: {
          schemaVersion: "tapeci.plan.v1",
          fees: { recommendedCapWei: "240000000000000000" },
        },
      })
      .returning();
    if (deployment === undefined) throw new Error("deployment fixture failed");
    return { id: deployment.id, manifestSha256, containerAddress };
  }

  async function loadPayload(deploymentId: string): Promise<PayloadBody> {
    const response = await app.inject({
      method: "GET",
      url: `/v1/deployments/${deploymentId}/approval-payload`,
      headers: devHeaders,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as PayloadBody;
  }

  function approve(
    deploymentId: string,
    signerAddress: string,
    signature: string,
    approval: PayloadBody["approval"],
  ) {
    return app.inject({
      method: "POST",
      url: `/v1/deployments/${deploymentId}/approve`,
      headers: devHeaders,
      payload: { signerAddress, signature, approval },
    });
  }

  it("returns typed data the server verifies byte for byte", async () => {
    const { id, manifestSha256, containerAddress } = await seedDeployment();
    const payload = await loadPayload(id);

    expect(payload.domain).toEqual({
      name: "TapeCI",
      version: "1",
      chainId: 196,
      verifyingContract: REGISTRY,
    });
    expect(payload.primaryType).toBe("Approval");
    expect(payload.types.Approval?.map((field) => [field.name, field.type])).toEqual([
      ["deploymentId", "string"],
      ["manifestHash", "bytes32"],
      ["container", "address"],
      ["costCapWei", "uint256"],
      ["nonce", "string"],
      ["expiresAt", "uint256"],
    ]);

    // All six fields, decimal-string values, bound to this deployment/container.
    expect(payload.message.deploymentId).toBe(id);
    expect(payload.message.manifestHash).toBe(manifestSha256);
    expect(payload.message.container).toBe(containerAddress);
    expect(payload.message.costCapWei).toMatch(/^[0-9]+$/);
    expect(payload.message.nonce).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload.message.expiresAt).toMatch(/^[0-9]+$/);
    expect(Number(payload.message.expiresAt)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(payload.expectedSigner?.toLowerCase()).toBe(OWNER.address.toLowerCase());

    // `approval` mirrors message minus deploymentId (that is what the POST sends).
    expect(payload.approval).toEqual({
      manifestHash: payload.message.manifestHash,
      container: payload.message.container,
      costCapWei: payload.message.costCapWei,
      nonce: payload.message.nonce,
      expiresAt: payload.message.expiresAt,
    });

    // The digest of the handed-out JSON equals the digest the verifier recomputes.
    const fromJson = hashTypedData({
      domain: payload.domain,
      types: payload.types,
      primaryType: "Approval",
      message: payload.message,
    } as Parameters<typeof hashTypedData>[0]);
    const recomputed = approvalDigest(
      {
        deploymentId: id,
        manifestHash: manifestSha256,
        container: containerAddress,
        costCapWei: BigInt(payload.message.costCapWei),
        nonce: payload.message.nonce,
        expiresAt: BigInt(payload.message.expiresAt),
      },
      { verifyingContract: REGISTRY },
    );
    expect(fromJson).toBe(recomputed);

    // And it matches the canonical helper, i.e. string values sign identically.
    expect(
      hashTypedData(
        approvalTypedData(
          {
            deploymentId: id,
            manifestHash: manifestSha256,
            container: containerAddress,
            costCapWei: BigInt(payload.message.costCapWei),
            nonce: payload.message.nonce,
            expiresAt: BigInt(payload.message.expiresAt),
          },
          { verifyingContract: REGISTRY },
        ),
      ),
    ).toBe(recomputed);
  });

  it("accepts a manually produced signature from the container owner", async () => {
    const { id, manifestSha256, containerAddress } = await seedDeployment();
    const payload = await loadPayload(id);

    const signature = await signPayload(OWNER, payload);
    // Sanity: the signature really belongs to the owner over this exact data.
    await expect(
      verifyTypedData({
        address: OWNER.address,
        signature,
        domain: payload.domain,
        types: payload.types,
        primaryType: "Approval",
        message: payload.message,
      } as Parameters<typeof verifyTypedData>[0]),
    ).resolves.toBe(true);

    const approved = await approve(id, OWNER.address, signature, payload.approval);
    expect(approved.statusCode).toBe(200);
    const body = approved.json() as {
      state: string;
      approval: { digest: string; costCapWei: string };
      operatorSession: { signerAddress: string };
    };
    expect(body.state).toBe("APPROVED");
    expect(body.operatorSession.signerAddress).toBe(OWNER.address.toLowerCase());

    // The stored digest is the one we signed, and the approval row is bound to it.
    const expectedDigest = approvalDigest(
      {
        deploymentId: id,
        manifestHash: manifestSha256,
        container: containerAddress,
        costCapWei: BigInt(payload.message.costCapWei),
        nonce: payload.message.nonce,
        expiresAt: BigInt(payload.message.expiresAt),
      },
      { verifyingContract: REGISTRY },
    );
    expect(body.approval.digest).toBe(expectedDigest);

    const [row] = await db.select().from(approvals).where(eq(approvals.deploymentId, id)).limit(1);
    expect(row?.approvalDigest).toBe(expectedDigest);
    expect(row?.signerAddress).toBe(OWNER.address.toLowerCase());
    expect(row?.chainId).toBe(196);
    expect(row?.nonce).toBe(payload.message.nonce);

    // The state machine recorded the request + the approval.
    const events = await db
      .select()
      .from(deploymentEvents)
      .where(eq(deploymentEvents.deploymentId, id));
    expect(events.map((event) => event.newState)).toEqual(["AWAITING_APPROVAL", "APPROVED"]);
  });

  it("rejects a signature from another key with a clear code", async () => {
    const { id } = await seedDeployment();
    const payload = await loadPayload(id);

    // (a) A valid signature by a non-owner, claiming to be that non-owner.
    const otherSignature = await signPayload(OTHER, payload);
    const wrongSigner = await approve(id, OTHER.address, otherSignature, payload.approval);
    expect(wrongSigner.statusCode).toBe(403);
    expect((wrongSigner.json() as { error: { code: string } }).error.code).toBe(
      "NOT_CURRENT_OWNER",
    );

    // (b) A non-owner signature *claiming* to be the owner: the address check passes
    // and the EIP-712 recovery must fail with the signature-specific code.
    const spoofed = await approve(id, OWNER.address, otherSignature, payload.approval);
    expect(spoofed.statusCode).toBe(403);
    const spoofedBody = spoofed.json() as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(spoofedBody.error.code).toBe("APPROVAL_REQUIRED");
    expect(spoofedBody.error.details["reason"]).toBe("invalid_approval_signature");

    // Nothing was recorded. The deployment may sit in AWAITING_APPROVAL: the route
    // opens the approval window before verifying the signature (the wallet path does
    // the same), and that state is retryable — but it must never reach APPROVED.
    expect(await db.select().from(approvals).where(eq(approvals.deploymentId, id))).toHaveLength(0);
    const [row] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
    expect(row?.state).not.toBe("APPROVED");
    expect(["PLAN_READY", "AWAITING_APPROVAL"]).toContain(row?.state);
    expect(row?.approvedCostCapWei).toBeNull();

    // A correct owner signature still succeeds afterwards: the failed attempt is not
    // a dead end, and the nonce was never consumed.
    const retry = await approve(
      id,
      OWNER.address,
      await signPayload(OWNER, payload),
      payload.approval,
    );
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { state: string }).state).toBe("APPROVED");
  });

  it("rejects a signature over a tampered cost cap", async () => {
    const { id } = await seedDeployment();
    const payload = await loadPayload(id);
    const signature = await signPayload(OWNER, payload);

    // Raise the cap after signing: the digest no longer matches the signature.
    const tampered = { ...payload.approval, costCapWei: String(BigInt(payload.message.costCapWei) + 1n) };
    const rejected = await approve(id, OWNER.address, signature, tampered);
    expect(rejected.statusCode).toBe(403);
    expect((rejected.json() as { error: { code: string } }).error.code).toBe("APPROVAL_REQUIRED");

    // Malformed values are a 400, not a 500 from a raw BigInt()/Number() throw.
    const garbage = await approve(id, OWNER.address, signature, {
      ...payload.approval,
      costCapWei: "1e18",
    });
    expect(garbage.statusCode).toBe(400);
    expect((garbage.json() as { error: { code: string } }).error.code).toBe("INVALID_BODY");

    const badExpiry = await approve(id, OWNER.address, signature, {
      ...payload.approval,
      expiresAt: "soon",
    });
    expect(badExpiry.statusCode).toBe(400);
    expect((badExpiry.json() as { error: { code: string } }).error.code).toBe("INVALID_BODY");
  });

  it("rejects a replayed manual signature", async () => {
    const { id } = await seedDeployment();
    const payload = await loadPayload(id);
    const signature = await signPayload(OWNER, payload);

    expect((await approve(id, OWNER.address, signature, payload.approval)).statusCode).toBe(200);
    // Same signed payload again: the deployment is no longer awaiting approval.
    const replay = await approve(id, OWNER.address, signature, payload.approval);
    expect(replay.statusCode).toBe(409);
    expect((replay.json() as { error: { code: string } }).error.code).toBe("APPROVAL_REQUIRED");
  });
});
