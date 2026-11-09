import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  containerEvents,
  containers,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  githubInstallations,
  migrateUp,
  projectBudgets,
  projectMembers,
  projects,
  provisioningQuoteAcceptances,
  provisioningSteps,
  provisioningTasks,
  provisioningTransactions,
  resourceQuotes,
  users,
  wallets,
  type Database,
} from "@tapeci/database";
import type { Hex } from "@tapeci/shared";
import { buildApp } from "../../../apps/api/src/app.js";
import { createChainBindingPort, type BindingChainReads } from "../../../apps/api/src/binding.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";

/**
 * DomainBinding API tests. No network: the route's chain seam is a fake
 * `ReadClient`/`WalletClient` pair injected through `ApiDeps`, so nothing in this
 * file can reach mainnet.
 */

const available = await databaseAvailable();

const CONTAINER = "0x25b20d3ea6b207506340eab2eb0f45edc800f6b3" as Hex;
const UNKNOWN_CONTAINER = "0x00000000000000000000000000000000000000ff" as Hex;
const OWNER_WALLET = "0x571d447f4f24688ec35ccf07f1d6993655f6af15";
const OTHER_WALLET = "0x00000000000000000000000000000000000000a1";
const OPERATOR = "0x00000000000000000000000000000000000000ab" as Hex;
const NAME = "2.0.0.tape";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const OWNER_HEADERS = {
  "content-type": "application/json",
  "x-tapeci-github-login": "owner-user",
  "x-tapeci-github-user-id": "9101",
};

const env: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: "test-session-secret-123456",
  devAuth: true,
  objectStoreDir: ".tapeci/objects",
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: "test-webhook-secret",
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

interface SentBind {
  readonly name: string;
  readonly container: Hex;
  readonly months: number;
  readonly value: bigint;
  readonly gas?: bigint;
}

/** Fake chain: mutable read state, call counters and a recorded `bind` call. */
function fakeChain(initial: Partial<BindingChainReads> = {}) {
  const reads: BindingChainReads = {
    isLive: false,
    isContainerLive: false,
    paidUntil: 0,
    containerPaidUntil: 0,
    monthlyFeeWei: 0n,
    ...initial,
  };
  const calls = { read: 0, simulate: 0, send: 0, gasPrice: 0 };
  // Unique per fake so tests can query their own row without another test's tx.
  const txHash = `0x${randomBytes(32).toString("hex")}` as Hex;
  const sent: SentBind[] = [];
  let revertWith: Error | null = null;
  let receiptStatus: "success" | "reverted" = "success";
  /** `true` makes `waitForTransactionReceipt` behave like a 120 s timeout. */
  let receiptPending = false;

  const client = {
    getGasPrice: async () => {
      calls.gasPrice += 1;
      return 1_000_000_000n;
    },
    simulateContract: async () => {
      calls.simulate += 1;
      if (revertWith !== null) throw revertWith;
      return { request: {} };
    },
    estimateContractGas: async () => 187_763n,
    waitForTransactionReceipt: async () => {
      if (receiptPending) {
        // viem's own timeout error shape; the route must treat it as "unknown",
        // never as a failed bind.
        const error = new Error("timed out while waiting for transaction receipt");
        error.name = "WaitForTransactionReceiptTimeoutError";
        throw error;
      }
      return {
        status: receiptStatus,
        blockNumber: 73_623_480n,
        gasUsed: 187_763n,
        effectiveGasPrice: 1_000_000_000n,
      };
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.read += 1;
      switch (functionName) {
        case "isLive":
          return reads.isLive;
        case "isContainerLive":
          return reads.isContainerLive;
        case "paidUntil":
          return reads.paidUntil;
        case "containerPaidUntil":
          return reads.containerPaidUntil;
        case "monthlyFee":
          return reads.monthlyFeeWei;
        default:
          throw new Error(`fake chain: unexpected read ${functionName}`);
      }
    },
  };

  const wallet = {
    account: { address: OPERATOR, type: "json-rpc" as const },
    writeContract: async (args: { args: readonly [string, Hex, bigint]; value: bigint; gas?: bigint }) => {
      calls.send += 1;
      const [name, container, months] = args.args;
      sent.push({
        name,
        container,
        months: Number(months),
        value: args.value,
        ...(args.gas === undefined ? {} : { gas: args.gas }),
      });
      return txHash;
    },
  };

  const port = createChainBindingPort({
    client: client as never,
    wallet: () => wallet as never,
  });

  return {
    txHash,
    reads,
    calls,
    sent,
    port,
    client,
    wallet,
    setRevert: (error: Error | null) => {
      revertWith = error;
    },
    setReceiptStatus: (status: "success" | "reverted") => {
      receiptStatus = status;
    },
    setReceiptPending: (pending: boolean) => {
      receiptPending = pending;
    },
  };
}

describe.skipIf(!available)("DomainBinding API (bind)", () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;
  let chain: ReturnType<typeof fakeChain>;
  let projectId = "";

  async function ensureUser(githubUserId: number, login: string): Promise<string> {
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.githubUserId, githubUserId))
      .limit(1);
    if (existing !== undefined) return existing.id;
    const [created] = await db.insert(users).values({ githubUserId, githubLogin: login }).returning();
    if (created === undefined) throw new Error("user fixture missing");
    return created.id;
  }

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await migrateUp(testDatabase.url);
    handle = createDatabase(testDatabase.url);
    db = handle.db;

    const [installation] = await db
      .insert(githubInstallations)
      .values({ installationId: 9_201, githubAccountId: 77, accountLogin: "acme" })
      .returning();
    if (installation === undefined) throw new Error("installation fixture missing");

    const [container] = await db
      .insert(containers)
      .values({
        chainId: 196,
        factoryAddress: "0x1f09daefa827f02cbb40967cc91b259763760761",
        processorIndex: 0,
        processorAddress: "0x839bdd6fa7a66416a609a735e11de5411b98574e",
        tokenId: "2",
        containerAddress: CONTAINER,
        registryAddress: "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
        bindingAddress: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
        lastObservedOwner: OWNER_WALLET,
      })
      .returning();
    if (container === undefined) throw new Error("container fixture missing");

    const ownerId = await ensureUser(9_101, "owner-user");
    const [project] = await db
      .insert(projects)
      .values({
        ownerUserId: ownerId,
        githubInstallationId: installation.id,
        githubRepositoryId: 1_234,
        repoFullName: "acme/site",
        containerId: container.id,
      })
      .returning();
    if (project === undefined) throw new Error("project fixture missing");
    projectId = project.id;
    await db.insert(projectMembers).values({ projectId, userId: ownerId, role: "owner" });
    await db.insert(wallets).values({
      userId: ownerId,
      chainId: 196,
      address: OWNER_WALLET,
      verifiedAt: NOW,
    });
    await ensureUser(9_102, "stranger");
  }, 120_000);

  beforeEach(async () => {
    chain = fakeChain();
    // The closures read `chain` when a request runs, not when the app is built,
    // so a test may swap in a fake with different chain read state.
    const deps: ApiDeps = {
      db,
      env,
      readClient: () => chain.client as never,
      operatorWallet: () => chain.wallet as never,
      now: () => NOW,
    };
    await app?.close();
    app = buildApp(deps);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.pool.end();
    await testDatabase?.drop();
  }, 30_000);

  it("returns the live activation state for a name", async () => {
    chain = fakeChain({ isLive: true, paidUntil: NOW_SECONDS + 86_400 });
    const response = await app.inject({
      method: "GET",
      url: `/v1/containers/${CONTAINER}/binding?name=${NAME}`,
      headers: OWNER_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      name: string;
      isLive: boolean;
      isContainerLive: boolean;
      paidUntil: string | null;
      containerPaidUntil: string | null;
      monthlyFeeWei: string;
      suggestedName: string;
      decision: string;
    };
    expect(body.name).toBe(NAME);
    expect(body.isLive).toBe(true);
    expect(body.isContainerLive).toBe(false);
    expect(body.paidUntil).toBe(new Date((NOW_SECONDS + 86_400) * 1000).toISOString());
    expect(body.containerPaidUntil).toBeNull();
    expect(body.monthlyFeeWei).toBe("0");
    expect(body.suggestedName).toBe("2.2.0.tape");
    expect(body.decision).toBe("ALREADY_LIVE");
  });

  it("defaults to the canonical <tokenId>.<area>.<processorIndex>.tape name", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/containers/${CONTAINER}/binding`,
      headers: OWNER_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { name: string; suggestedName: string; isLive: boolean };
    expect(body.suggestedName).toBe("2.2.0.tape");
    expect(body.name).toBe("2.2.0.tape");
    expect(body.isLive).toBe(false);
  });

  it("treats a container-wide activation as covering the name (later window wins)", async () => {
    chain = fakeChain({ isContainerLive: true, containerPaidUntil: NOW_SECONDS + 86_400 });
    const response = await app.inject({
      method: "GET",
      url: `/v1/containers/${CONTAINER}/binding?name=${NAME}`,
      headers: OWNER_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { decision: string; isLive: boolean; isContainerLive: boolean };
    // isLive is false for this name, but the gateway looks at both flags.
    expect(body.isLive).toBe(false);
    expect(body.isContainerLive).toBe(true);
    expect(body.decision).toBe("ALREADY_LIVE");
  });

  it("rejects an invalid name on read", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/containers/${CONTAINER}/binding?name=Foo.tape`,
      headers: OWNER_HEADERS,
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe("INVALID_NAME");
  });

  it("returns 404 for a container it does not know", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/containers/${UNKNOWN_CONTAINER}/binding`,
      headers: OWNER_HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe("CONTAINER_NOT_FOUND");
  });

  it("requires a session (401)", async () => {
    // devAuth is on, so a present-but-forged cookie is the only unauthenticated path.
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: { "content-type": "application/json", cookie: "tapeci_session=forged" },
      payload: { name: NAME, months: 1 },
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code).toBe("AUTH_REQUIRED");
  });

  it("rejects an invalid name", async () => {
    for (const name of ["nodot", "UPPER.tape", "a..tape", ""]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/containers/${CONTAINER}/bind`,
        headers: OWNER_HEADERS,
        payload: { name, months: 1 },
      });
      expect(response.statusCode, `name ${JSON.stringify(name)}`).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe("INVALID_NAME");
    }
    expect(chain.calls.send).toBe(0);
  });

  it("rejects invalid months", async () => {
    for (const months of [0, 121, 1.5, "abc", null]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/containers/${CONTAINER}/bind`,
        headers: OWNER_HEADERS,
        payload: { name: NAME, months },
      });
      expect(response.statusCode, `months ${JSON.stringify(months)}`).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe("INVALID_MONTHS");
    }
    expect(chain.calls.send).toBe(0);
  });

  it("returns 409 ALREADY_LIVE and sends nothing", async () => {
    chain = fakeChain({ isLive: true, paidUntil: NOW_SECONDS + 30 * 86_400 });
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe("ALREADY_LIVE");
    expect(chain.calls.simulate).toBe(0);
    expect(chain.calls.send).toBe(0);
  });

  it("returns 409 ALREADY_LIVE when the container-level activation covers now", async () => {
    chain = fakeChain({ isContainerLive: true, containerPaidUntil: NOW_SECONDS + 86_400 });
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe("ALREADY_LIVE");
    expect(chain.calls.send).toBe(0);
  });

  it("returns 409 BIND_REVERTED with the decoded reason", async () => {
    chain.setRevert(Object.assign(new Error("reverted"), { functionName: "NotOwner", args: [] }));
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 1 },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { code: string; details: { revertsWith?: string } } };
    expect(body.error.code).toBe("BIND_REVERTED");
    expect(body.error.details.revertsWith).toBe("NotOwner");
    expect(chain.calls.send).toBe(0);
  });

  it("binds through the operator wallet and records container_events + audit", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 3 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      ok: boolean;
      txHash: string;
      blockNumber: string;
      paidUntil: string | null;
      gasUsed: string;
      valueWei: string;
    };
    expect(body.ok).toBe(true);
    expect(body.txHash).toBe(chain.txHash);
    expect(body.blockNumber).toBe("73623480");
    expect(body.gasUsed).toBe("187763");
    expect(body.valueWei).toBe("0");

    // Simulated before sending, with the exact months and msg.value.
    expect(chain.calls.simulate).toBe(1);
    expect(chain.calls.send).toBe(1);
    expect(chain.sent[0]).toMatchObject({ name: NAME, container: CONTAINER, months: 3, value: 0n });

    const events = await db.select().from(containerEvents).where(eq(containerEvents.txHash, chain.txHash));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      containerAddress: CONTAINER,
      eventType: "bind",
      name: NAME,
      months: 3,
      valueWei: "0",
      blockNumber: "73623480",
      gasUsed: "187763",
    });

    const audit = (
      await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.event, "container.bind"), eq(auditEvents.projectId, projectId)))
    ).filter((row) => (row.metadata as { txHash?: string }).txHash === chain.txHash);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ name: NAME, months: 3, txHash: chain.txHash, valueWei: "0" });
  });

  it("computes msg.value from the live monthlyFee", async () => {
    chain = fakeChain({ monthlyFeeWei: 1_000_000_000_000_000n });
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(chain.sent[0]?.value).toBe(2_000_000_000_000_000n);
    const rows = await db
      .select()
      .from(containerEvents)
      .where(and(eq(containerEvents.name, NAME), eq(containerEvents.valueWei, "2000000000000000")));
    expect(rows).toHaveLength(1);

    // AC-P3-32 / P3-05: activation is NOT a provisioning action. A bind must leave every
    // `provisioning_*` table empty, otherwise the activation path would look like a paid
    // preparation step and the two lifecycles would start sharing state.
    expect(await db.select().from(provisioningTasks)).toHaveLength(0);
    expect(await db.select().from(provisioningSteps)).toHaveLength(0);
    expect(await db.select().from(provisioningTransactions)).toHaveLength(0);
    expect(await db.select().from(provisioningQuoteAcceptances)).toHaveLength(0);
    expect(await db.select().from(resourceQuotes)).toHaveLength(0);
  });

  it("enforces the project budget cap (409 FEE_OVER_BUDGET)", async () => {
    await db
      .insert(projectBudgets)
      .values({ projectId, monthlyCapWei: "1", updatedAt: NOW })
      .onConflictDoUpdate({ target: projectBudgets.projectId, set: { monthlyCapWei: "1" } });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/containers/${CONTAINER}/bind`,
        headers: OWNER_HEADERS,
        payload: { name: NAME, months: 1 },
      });
      expect(response.statusCode).toBe(409);
      const body = response.json() as { error: { code: string; details: Record<string, string> } };
      expect(body.error.code).toBe("FEE_OVER_BUDGET");
      expect(body.error.details.monthlyCapWei).toBe("1");
      expect(body.error.details.requestedWei).toBeDefined();
      expect(body.error.details.spentThisMonthWei).toBeDefined();
      expect(chain.calls.send).toBe(0);
    } finally {
      await db.delete(projectBudgets).where(eq(projectBudgets.projectId, projectId));
    }
  });

  it("forbids a member without a write role on the only project (403 PROJECT_ROLE_REQUIRED)", async () => {
    const memberId = await ensureUser(9_104, "plain-member");
    await db.insert(projectMembers).values({ projectId, userId: memberId, role: "member" });
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: {
        "content-type": "application/json",
        "x-tapeci-github-login": "plain-member",
        "x-tapeci-github-user-id": "9104",
      },
      payload: { name: NAME, months: 1 },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe("PROJECT_ROLE_REQUIRED");
    expect(chain.calls.send).toBe(0);
  });

  it("forbids a non-member whose wallet is not the owner (403 OWNER_REQUIRED)", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: {
        "content-type": "application/json",
        "x-tapeci-github-login": "stranger",
        "x-tapeci-github-user-id": "9102",
      },
      payload: { name: NAME, months: 1 },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe("OWNER_REQUIRED");
    expect(chain.calls.send).toBe(0);
  });

  it("forbids a project viewer (403 PROJECT_ROLE_REQUIRED)", async () => {
    const viewerId = await ensureUser(9_103, "viewer");
    await db.insert(projectMembers).values({ projectId, userId: viewerId, role: "viewer" });
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: {
        "content-type": "application/json",
        "x-tapeci-github-login": "viewer",
        "x-tapeci-github-user-id": "9103",
      },
      payload: { name: NAME, months: 1 },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe("PROJECT_ROLE_REQUIRED");
    expect(chain.calls.send).toBe(0);
  });

  it("returns 400 for a malformed container address", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/containers/0xnothex/bind",
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 1 },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe("INVALID_PATH");
  });

  it("reports a mined-but-reverted bind as BIND_FAILED", async () => {
    chain.setReceiptStatus("reverted");
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe("BIND_FAILED");
  });

  it("counts the owner wallet only after the container has no project", async () => {
    // A second container with no project: the owner wallet is the only gate.
    const orphan = "0x00000000000000000000000000000000000000b2" as Hex;
    const [container] = await db
      .insert(containers)
      .values({
        chainId: 196,
        factoryAddress: "0x1f09daefa827f02cbb40967cc91b259763760761",
        processorIndex: 1,
        processorAddress: "0x839bdd6fa7a66416a609a735e11de5411b98574e",
        tokenId: "3",
        containerAddress: orphan,
        registryAddress: "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
        bindingAddress: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
        lastObservedOwner: OWNER_WALLET,
      })
      .returning();
    expect(container).toBeDefined();

    const allowed = await app.inject({
      method: "GET",
      url: `/v1/containers/${orphan}/binding`,
      headers: OWNER_HEADERS,
    });
    expect(allowed.statusCode).toBe(200);
    const body = allowed.json() as { name: string; suggestedName: string };
    expect(body.suggestedName).toBe("3.2.1.tape");

    const strangerId = await ensureUser(9_102, "stranger");
    await db.insert(wallets).values({
      userId: strangerId,
      chainId: 196,
      address: OTHER_WALLET,
      verifiedAt: NOW,
    });
    const denied = await app.inject({
      method: "GET",
      url: `/v1/containers/${orphan}/binding`,
      headers: {
        "content-type": "application/json",
        "x-tapeci-github-login": "stranger",
        "x-tapeci-github-user-id": "9102",
      },
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe("OWNER_REQUIRED");
  });

  // -------------------------------------------------------------------------
  // P1 additions: multi-address owner match and hash-before-receipt tracking
  // (§3.3, §9.4, AC-P1-2, AC-P3-7)
  // -------------------------------------------------------------------------

  it("accepts the owner when it is the second of two verified wallets", async () => {
    // AC-P1-2: the old query took the first verified wallet with no ORDER BY, so
    // a legitimate holder was refused whenever that arbitrary row was not it.
    // This container has no project, so only wallet ownership can authorize.
    const twoWallets = "0x00000000000000000000000000000000000000c1" as Hex;
    const holder = "0x00000000000000000000000000000000000000c2";
    const [container] = await db
      .insert(containers)
      .values({
        chainId: 196,
        factoryAddress: "0x1f09daefa827f02cbb40967cc91b259763760761",
        processorIndex: 7,
        processorAddress: "0x839bdd6fa7a66416a609a735e11de5411b98574e",
        tokenId: "77",
        containerAddress: twoWallets,
        registryAddress: "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
        bindingAddress: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
        lastObservedOwner: holder,
      })
      .returning();
    expect(container).toBeDefined();

    const userId = await ensureUser(9_105, "two-wallets");
    // Deliberately insert the non-holder FIRST: a first-row-wins query fails here.
    await db.insert(wallets).values([
      { userId, chainId: 196, address: OTHER_WALLET, verifiedAt: NOW },
      { userId, chainId: 196, address: holder, verifiedAt: NOW },
    ]);

    const headers = {
      "content-type": "application/json",
      "x-tapeci-github-login": "two-wallets",
      "x-tapeci-github-user-id": "9105",
    };
    const allowed = await app.inject({
      method: "GET",
      url: `/v1/containers/${twoWallets}/binding`,
      headers,
    });
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json() as { binding: { canWrite: boolean } }).binding.canWrite).toBe(true);

    // The same user is still refused for a container whose owner is neither wallet.
    const otherOwner = "0x00000000000000000000000000000000000000c3" as Hex;
    await db
      .insert(containers)
      .values({
        chainId: 196,
        factoryAddress: "0x1f09daefa827f02cbb40967cc91b259763760761",
        processorIndex: 8,
        processorAddress: "0x839bdd6fa7a66416a609a735e11de5411b98574e",
        tokenId: "78",
        containerAddress: otherOwner,
        registryAddress: "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
        bindingAddress: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
        lastObservedOwner: "0x00000000000000000000000000000000000000c4",
      })
      .returning();
    const denied = await app.inject({
      method: "GET",
      url: `/v1/containers/${otherOwner}/binding`,
      headers,
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe("OWNER_REQUIRED");
  });

  it("records the hash before waiting for the receipt", async () => {
    // AC-P3-7: `send()` used to await the receipt, so a timeout inside the wait
    // lost both the hash and the row. The row must exist while the wait is still
    // outstanding.
    chain.setReceiptPending(true);
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 2 },
    });

    // 202, not 409: a receipt timeout is "unknown", never "failed".
    expect(response.statusCode).toBe(202);
    const body = response.json() as { ok: boolean; state: string; txHash: string; blockNumber: null };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("pending");
    expect(body.txHash).toBe(chain.txHash);
    expect(body.blockNumber).toBeNull();

    // The intent and hash are persisted even though no receipt exists.
    const rows = await db
      .select()
      .from(containerEvents)
      .where(eq(containerEvents.txHash, chain.txHash));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: NAME, months: 2, gasUsed: null });

    // The binding read reports it as pending so a refresh keeps the state and the
    // console offers a re-check instead of a second send.
    const read = await app.inject({
      method: "GET",
      url: `/v1/containers/${CONTAINER}/binding?name=${NAME}`,
      headers: OWNER_HEADERS,
    });
    expect(read.statusCode).toBe(200);
    const readBody = read.json() as {
      pendingSubmission: { txHash: string; state: string } | null;
      recentEvents: { txHash: string; state: string }[];
    };
    expect(readBody.pendingSubmission).toMatchObject({ txHash: chain.txHash, state: "pending" });
    expect(readBody.recentEvents.some((event) => event.txHash === chain.txHash)).toBe(true);

    // A second bind while one is pending is a new attempt, not a duplicate of the
    // stored one: the hash is unique per broadcast.
    chain.setReceiptPending(false);
  });

  it("confirms the stored hash once the receipt lands", async () => {
    chain.setReceiptPending(true);
    const pending = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 1 },
    });
    expect(pending.statusCode).toBe(202);

    // Re-registering the same hash is idempotent and now sees the receipt.
    chain.setReceiptPending(false);
    const confirmed = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind/submissions`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 1, txHash: chain.txHash },
    });
    expect(confirmed.statusCode).toBe(200);
    const body = confirmed.json() as { state: string; duplicate: boolean };
    expect(body.state).toBe("confirmed");
    expect(body.duplicate).toBe(true);

    const rows = await db
      .select()
      .from(containerEvents)
      .where(eq(containerEvents.txHash, chain.txHash));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gasUsed).toBe("187763");
    expect(rows[0]?.blockNumber).toBe("73623480");
  });

  it("records a hash the user's own wallet broadcast", async () => {
    // The direct-wallet path: the browser signs, so the server only ever sees the
    // hash. Before this route the bind left no row at all.
    const walletHash = `0x${randomBytes(32).toString("hex")}`;
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind/submissions`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 3, txHash: walletHash },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { state: string; submission: { txHash: string; name: string; months: number } };
    expect(body.state).toBe("confirmed");
    expect(body.submission).toMatchObject({ txHash: walletHash, name: NAME, months: 3 });

    const rows = await db.select().from(containerEvents).where(eq(containerEvents.txHash, walletHash));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: "bind", name: NAME, months: 3, containerAddress: CONTAINER });
  });

  it("keeps a wallet-supplied hash pending when no receipt exists", async () => {
    chain.setReceiptPending(true);
    const walletHash = `0x${randomBytes(32).toString("hex")}`;
    const response = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind/submissions`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 1, txHash: walletHash },
    });
    // 202: the hash is accepted and recorded, the outcome is unknown (§9.4).
    expect(response.statusCode).toBe(202);
    expect((response.json() as { state: string }).state).toBe("pending");
    // A supplied hash alone never confirms: the row exists, the activation does not.
    const rows = await db.select().from(containerEvents).where(eq(containerEvents.txHash, walletHash));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gasUsed).toBeNull();
    chain.setReceiptPending(false);
  });

  it("refuses to re-attribute a recorded hash to a different name", async () => {
    const walletHash = `0x${randomBytes(32).toString("hex")}`;
    const first = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind/submissions`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 1, txHash: walletHash },
    });
    expect(first.statusCode).toBe(200);

    const conflicting = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind/submissions`,
      headers: OWNER_HEADERS,
      payload: { name: "9.2.0.tape", months: 1, txHash: walletHash },
    });
    expect(conflicting.statusCode).toBe(409);
    expect((conflicting.json() as { error: { code: string } }).error.code).toBe(
      "TRANSACTION_MISMATCH",
    );
    // The original attribution is untouched.
    const rows = await db.select().from(containerEvents).where(eq(containerEvents.txHash, walletHash));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(NAME);
  });

  it("rejects a malformed or unauthorized hash registration", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind/submissions`,
      headers: OWNER_HEADERS,
      payload: { name: NAME, months: 1, txHash: "0x1234" },
    });
    expect(malformed.statusCode).toBe(400);
    expect((malformed.json() as { error: { code: string } }).error.code).toBe("INVALID_BODY");

    // Registration is authorized exactly like the bind route: a stranger cannot
    // attach a hash to someone else's container.
    const stranger = await app.inject({
      method: "POST",
      url: `/v1/containers/${CONTAINER}/bind/submissions`,
      headers: {
        "content-type": "application/json",
        "x-tapeci-github-login": "stranger",
        "x-tapeci-github-user-id": "9102",
      },
      payload: { name: NAME, months: 1, txHash: `0x${randomBytes(32).toString("hex")}` },
    });
    expect(stranger.statusCode).toBe(403);
    expect((stranger.json() as { error: { code: string } }).error.code).toBe("OWNER_REQUIRED");
  });
});
