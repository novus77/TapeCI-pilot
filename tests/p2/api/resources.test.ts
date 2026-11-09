/**
 * P2 acceptance — SPEC §7.2 public resource API (§15.1 row 4, plan T02-d).
 *
 * Required behaviour, in the order the SPEC lists it:
 * (a) anonymous wallet query returns public fields only;
 * (b) no private field (repo/project/member/order/wallet association) leaks,
 *     even for the owner's own address;
 * (c) a partial scan returns `complete: false`, never an empty "success";
 * (d) querying another user's address does not escalate or grant a paid capability;
 * (e) `tokenId = 0` is accepted on the read path and is not falsy-coerced.
 *
 * The chain is a deterministic in-memory `ReadClient` (the test-p0 classification
 * keeps P2 API tests on PostgreSQL only); the routes, discovery service, public
 * auth branch, DTO projection and `InMemoryResourceIndex` are the real ones. The
 * empty index is a genuine partial scan: no origin/checkpoint has been written,
 * which is exactly the state §8.4 says must not render as "no circuits".
 *
 * Run from the repo root (package-dir Vitest is broken here, test-p0 §1.4):
 *   node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs exec vitest run tests/p2/api/resources.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type Hex,
} from "viem";
import {
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  migrateUp,
  wallets,
  type Database,
} from "@tapeci/database";
import type { ReadClient } from "@tapeci/chain";
import { buildApp, isPublicResourcePath } from "../../../apps/api/src/app.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";

const PIN = 74_152_998n;
const PROCESSOR = "0x839bdd6fa7a66416a609a735e11de5411b98574e" as Hex;
const OWNER = "0x571d447f4f24688ec35ccf07f1d6993655f6af15" as Hex;
const OTHER_WALLET = "0x00000000000000000000000000000000000000b2" as Hex;
const UNKNOWN_PROCESSOR = "0x00000000000000000000000000000000000000cc" as Hex;
const TOKEN_ID = 2n;
const PRIVATE_LOGIN = "private-owner-login";

const available = await databaseAvailable();
const unavailableLabel =
  "P2 resources API [SKIPPED: PostgreSQL is unreachable; the suite needs the shared " +
  "PG service on 127.0.0.1:55432 (TAPECI_TEST_DATABASE_URL)]";

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

const headersFor = (login: string, githubUserId: number): Record<string, string> => ({
  "x-tapeci-github-login": login,
  "x-tapeci-github-user-id": String(githubUserId),
  "content-type": "application/json",
});

/**
 * What the fake chain answers. `verified_false` and `not_found` both start with
 * an undeployed container (`token()` returns no data); they differ only in the
 * circuit's `ownerOf`: existing → a real `false`; reverted → explicit absence.
 */
type Scenario = "verified" | "verified_false" | "not_found" | "unavailable";
let scenario: Scenario = "verified";

const containerByAddress = new Map<string, bigint>();

/** Deterministic, valid 20-byte container address per token id. */
function containerFor(tokenId: bigint): Hex {
  return `0x${(0xabc000n + tokenId).toString(16).padStart(40, "0")}` as Hex;
}

function zeroData(functionName: string): Error {
  const cause = new ContractFunctionZeroDataError({ functionName });
  return new ContractFunctionExecutionError(cause, {
    abi: [],
    args: [],
    contractAddress: PROCESSOR,
    functionName,
  });
}

function reverted(functionName: string): Error {
  const cause = new ContractFunctionRevertedError({
    abi: [],
    data: "0x4e487b71",
    functionName,
  });
  return new ContractFunctionExecutionError(cause, {
    abi: [],
    args: [],
    contractAddress: PROCESSOR,
    functionName,
  });
}

/** Only the members the discovery service touches; every read is keyed by function name. */
function fakeReadClient(): ReadClient {
  return {
    getBlockNumber: async () => PIN,
    readContract: async (request: {
      address: Hex;
      functionName: string;
      args?: readonly unknown[];
    }) => {
      switch (request.functionName) {
        case "cpuCount":
          return 1n;
        case "cpuAt":
          return PROCESSOR;
        case "accountOf": {
          const tokenId = request.args?.[1];
          if (typeof tokenId !== "bigint") throw new Error("accountOf expects a bigint tokenId");
          const container = containerFor(tokenId);
          containerByAddress.set(container.toLowerCase(), tokenId);
          return container;
        }
        case "isCPU":
          return true;
        case "token": {
          const tokenId = containerByAddress.get(request.address.toLowerCase());
          if (tokenId === undefined) throw zeroData("token");
          if (scenario === "unavailable") throw new Error("socket hang up while reading token()");
          if (scenario === "verified") return [196n, PROCESSOR, tokenId];
          throw zeroData("token");
        }
        case "ownerOf":
          if (scenario === "not_found") throw reverted("ownerOf");
          return OWNER;
        case "isDeployed":
          return scenario === "verified";
        case "isOpened":
          return scenario === "verified";
        default:
          throw new Error(`unexpected read ${request.functionName}`);
      }
    },
  } as unknown as ReadClient;
}

const RESOURCE_KEYS = [
  "resource",
  "processorIndex",
  "container",
  "owner",
  "deployed",
  "opened",
  "observedBlock",
  "readStatus",
] as const;
const RESOURCE_REF_KEYS = ["chainId", "processor", "tokenId"] as const;
const PAGE_KEYS = [
  "address",
  "chainId",
  "resources",
  "nextCursor",
  "syncStatus",
  "complete",
  "indexedThroughBlock",
  "observedBlock",
] as const;
const CATALOGUE_KEYS = [
  "chainId",
  "processors",
  "syncStatus",
  "complete",
  "indexedThroughBlock",
  "observedBlock",
] as const;
const PROCESSOR_REF_KEYS = ["processorIndex", "processor"] as const;
// `unavailableKind` and `guidance` were added when the reason became a measured fact
// (supply exhausted) rather than "not configured": a client can act on the kind without
// parsing prose, and the guidance points at the path that does work.
const OFFERS_KEYS = [
  "chainId",
  "offers",
  "available",
  "unavailableReason",
  "unavailableKind",
  "guidance",
] as const;

/** Private data a public payload must never carry (§7.2, §8.7). */
const PRIVATE_KEY_PATTERN =
  /(repo|member|order|project|installation|user|email|login|task|preparation|quote|price|calldata|capabilit)/i;

function assertExactKeys(value: unknown, allowed: readonly string[], label: string): void {
  expect(value, `${label} must be a JSON object`).toBeTypeOf("object");
  expect(value, `${label} must not be null`).not.toBeNull();
  expect(Object.keys(value as Record<string, unknown>).sort()).toEqual([...allowed].sort());
}

function assertNoPrivateKeys(value: unknown, label: string, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateKeys(entry, label, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    expect(PRIVATE_KEY_PATTERN.test(key), `${label} leaked private key ${path}.${key}`).toBe(false);
    assertNoPrivateKeys(child, label, `${path}.${key}`);
  }
}

function jsonObject(response: { json: () => unknown }): Record<string, unknown> {
  const body = response.json();
  expect(body).toBeTypeOf("object");
  expect(body).not.toBeNull();
  return body as Record<string, unknown>;
}

describe.skipIf(!available)(available ? "P2 §7.2 public resource API" : unavailableLabel, () => {
  let anonymousApp: FastifyInstance;
  let devApp: FastifyInstance;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let databaseHandle: ReturnType<typeof createDatabase>;
  let db: Database;
  let ownerUserId: string;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    database = testDatabase;
    await migrateUp(testDatabase.url);
    databaseHandle = createDatabase(testDatabase.url);
    db = databaseHandle.db;

    anonymousApp = buildApp({
      db,
      env: { ...env, devAuth: false },
      readClient: () => fakeReadClient(),
    } satisfies ApiDeps);
    devApp = buildApp({
      db,
      env,
      readClient: () => fakeReadClient(),
    } satisfies ApiDeps);
    await anonymousApp.ready();
    await devApp.ready();

    // A real private association: the queried address is a verified wallet of
    // this user. A public payload must not expose the link or the identity.
    const me = await devApp.inject({
      method: "GET",
      url: "/v1/me",
      headers: headersFor(PRIVATE_LOGIN, 4242),
    });
    expect(me.statusCode).toBe(200);
    ownerUserId = jsonObject(me)["id"] as string;
    expect(ownerUserId).toMatch(/^[0-9a-f-]{36}$/);
    await db.insert(wallets).values({
      userId: ownerUserId,
      chainId: 196,
      address: OWNER,
      verifiedAt: new Date(),
    });
  }, 90_000);

  afterAll(async () => {
    await anonymousApp?.close();
    await devApp?.close();
    await databaseHandle?.pool.end();
    await database?.drop();
  }, 30_000);

  it("serves every §7.2 public operation with no session, no cookie and no Authorization header", async () => {
    scenario = "verified";
    const cases = [
      { method: "GET" as const, url: "/v1/resources/processors?chainId=196" },
      { method: "GET" as const, url: `/v1/resources/wallets/${OWNER}?chainId=196` },
      {
        method: "POST" as const,
        url: "/v1/resources/inspect",
        payload: { chainId: 196, processor: PROCESSOR, tokenId: TOKEN_ID.toString(10) },
      },
      { method: "GET" as const, url: "/v1/resources/offers?chainId=196" },
    ];
    for (const request of cases) {
      const response = await anonymousApp.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(200);
      expect(response.headers["set-cookie"], `${request.url} must not mint a session`).toBeUndefined();
      assertNoPrivateKeys(jsonObject(response), `${request.method} ${request.url}`);
    }
  });

  it("keeps the authenticated sibling protected on the same server (§7.1 exact public branch)", async () => {
    // §7.1: the public branch must be exact, not a prefix. A prefix such as
    // `/v1/resource` would also swallow the authenticated `POST /v1/resource-quotes`
    // (P3) and let it through without a user.
    expect(isPublicResourcePath("POST", "/v1/resources/inspect")).toBe(true);
    expect(isPublicResourcePath("GET", "/v1/resources/processors")).toBe(true);
    expect(isPublicResourcePath("GET", `/v1/resources/wallets/${OWNER}`)).toBe(true);
    expect(isPublicResourcePath("POST", "/v1/resource-quotes")).toBe(false);
    expect(isPublicResourcePath("POST", "/v1/preparations")).toBe(false);
    expect(isPublicResourcePath("GET", "/v1/containers/0xabc")).toBe(false);

    const publicInspect = await inspectRequest(anonymousApp, TOKEN_ID.toString(10));
    expect(publicInspect.statusCode).toBe(200);

    // The existing private container route is not widened by the public branch.
    const privateContainer = await anonymousApp.inject({
      method: "GET",
      url: `/v1/containers/${OWNER}`,
    });
    expect(privateContainer.statusCode).toBe(401);
  });

  it("lists the trusted factory catalogue without ownership data", async () => {
    scenario = "verified";
    const response = await anonymousApp.inject({
      method: "GET",
      url: "/v1/resources/processors?chainId=196",
    });
    expect(response.statusCode).toBe(200);
    const body = jsonObject(response);
    assertExactKeys(body, CATALOGUE_KEYS, "processor catalogue");
    expect(body["chainId"]).toBe(196);
    expect(body["observedBlock"]).toBe(PIN.toString(10));
    const processors = body["processors"] as unknown[];
    expect(processors).toHaveLength(1);
    assertExactKeys(processors[0], PROCESSOR_REF_KEYS, "processor ref");
    expect(processors[0]).toEqual({ processorIndex: 0, processor: PROCESSOR });
    // No checkpoint/origin has been written: this is an incomplete catalogue.
    expect(body["complete"]).toBe(false);
    expect(body["syncStatus"]).toBe("partial");
  });

  it("returns offers as explicitly unavailable, never a fabricated catalogue", async () => {
    const response = await anonymousApp.inject({
      method: "GET",
      url: "/v1/resources/offers?chainId=196",
    });
    expect(response.statusCode).toBe(200);
    const body = jsonObject(response);
    assertExactKeys(body, OFFERS_KEYS, "offers");
    expect(body["offers"]).toEqual([]);
    expect(body["available"]).toBe(false);
    // Measured on 2026-10-28: minted == supplyCap on X Layer, so the honest reason is
    // exhaustion, not missing configuration.
    expect(body["unavailableReason"]).toBe("NO_PREPRICED_OFFERS");
    expect(body["unavailableKind"]).toBe("self_mint_available");
    expect(body["available"]).not.toBe(true);
  });

  it("never renders a partial scan as an empty list (§8.4)", async () => {
    scenario = "verified";
    const response = await anonymousApp.inject({
      method: "GET",
      url: `/v1/resources/wallets/${OWNER}?chainId=196`,
    });
    expect(response.statusCode).toBe(200);
    const body = jsonObject(response);
    assertExactKeys(body, PAGE_KEYS, "wallet page");
    expect(body["address"]).toBe(OWNER.toLowerCase());
    expect(body["chainId"]).toBe(196);
    expect(body["resources"]).toEqual([]);
    expect(body["nextCursor"]).toBeNull();
    expect(body["observedBlock"]).toBe(PIN.toString(10));
    expect(body["indexedThroughBlock"]).toBeNull();
    // An empty array is "no circuits" only when `complete === true`.
    expect(body["complete"]).toBe(false);
    expect(body["syncStatus"]).toBe("partial");
    expect(body["syncStatus"]).not.toBe("ready");
  });

  it("does not expose the wallet-to-user association even for the owner's own address", async () => {
    scenario = "verified";
    const anonymous = await anonymousApp.inject({
      method: "GET",
      url: `/v1/resources/wallets/${OWNER}?chainId=196`,
    });
    const asOwner = await devApp.inject({
      method: "GET",
      url: `/v1/resources/wallets/${OWNER}?chainId=196`,
      headers: headersFor(PRIVATE_LOGIN, 4242),
    });
    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.json()).toEqual(anonymous.json());
    const raw = JSON.stringify(asOwner.json());
    expect(raw).not.toContain(PRIVATE_LOGIN);
    expect(raw).not.toContain(ownerUserId);
    assertNoPrivateKeys(jsonObject(asOwner), "owner-address wallet page");
  });

  it("does not escalate when another identity queries the owner's address (§7.1, E04)", async () => {
    scenario = "verified";
    const anonymous = await anonymousApp.inject({
      method: "GET",
      url: `/v1/resources/wallets/${OWNER}?chainId=196`,
    });
    expect(await db.select().from(wallets)).toHaveLength(1);

    const asOther = await devApp.inject({
      method: "GET",
      url: `/v1/resources/wallets/${OWNER}?chainId=196`,
      headers: headersFor("other-user-login", 5252),
    });
    expect(asOther.statusCode).toBe(200);
    expect(asOther.json()).toEqual(anonymous.json());
    assertNoPrivateKeys(jsonObject(asOther), "other-identity wallet page");

    // No write path ran: the private association is still exactly one row.
    const after = await db.select().from(wallets);
    expect(after).toHaveLength(1);
  });

  it("inspect verifies a real chain answer with literal booleans", async () => {
    scenario = "verified";
    const response = await inspectRequest(anonymousApp, TOKEN_ID.toString(10));
    expect(response.statusCode).toBe(200);
    const body = jsonObject(response);
    assertExactKeys(body, RESOURCE_KEYS, "inspect resource");
    assertExactKeys(body["resource"], RESOURCE_REF_KEYS, "inspect resource ref");
    expect(body["readStatus"]).toBe("verified");
    expect(body["deployed"]).toBe(true);
    expect(body["opened"]).toBe(true);
    expect(body["observedBlock"]).toBe(PIN.toString(10));
    expect(body["resource"]).toEqual({ chainId: 196, processor: PROCESSOR, tokenId: TOKEN_ID.toString(10) });
    expect(JSON.stringify(body)).toContain('"opened":true');
  });

  it("preserves a real false as false, never null, on the verified-false path", async () => {
    scenario = "verified_false";
    const response = await inspectRequest(anonymousApp, TOKEN_ID.toString(10));
    expect(response.statusCode).toBe(200);
    const body = jsonObject(response);
    expect(body["readStatus"]).toBe("verified");
    expect(body["deployed"]).toBe(false);
    expect(body["opened"]).toBe(false);
    expect(body["deployed"]).not.toBeNull();
    expect(body["opened"]).not.toBeNull();
    expect(JSON.stringify(body)).toContain('"opened":false');
  });

  it("reports explicit absence as not_found with null facts", async () => {
    scenario = "not_found";
    const response = await inspectRequest(anonymousApp, TOKEN_ID.toString(10));
    expect(response.statusCode).toBe(200);
    const body = jsonObject(response);
    expect(body["readStatus"]).toBe("not_found");
    expect(body["deployed"]).toBeNull();
    expect(body["opened"]).toBeNull();
    expect(body["container"]).toBeNull();
    expect(JSON.stringify(body)).toContain('"opened":null');
  });

  it("reports a failed read as unavailable with null facts, never false", async () => {
    scenario = "unavailable";
    const response = await inspectRequest(anonymousApp, TOKEN_ID.toString(10));
    expect(response.statusCode).toBe(200);
    const body = jsonObject(response);
    expect(body["readStatus"]).toBe("unavailable");
    expect(body["deployed"]).toBeNull();
    expect(body["opened"]).toBeNull();
    expect(body["opened"]).not.toBe(false);
    expect(body["observedBlock"]).toBe(PIN.toString(10));
    expect(JSON.stringify(body)).toContain('"opened":null');
  });

  it("accepts tokenId 0 on the public inspect path and does not falsy-coerce it", async () => {
    scenario = "verified";
    const response = await inspectRequest(anonymousApp, "0");
    expect(response.statusCode).toBe(200);
    const body = jsonObject(response);
    expect(body["readStatus"]).toBe("verified");
    expect((body["resource"] as Record<string, unknown>)["tokenId"]).toBe("0");
    expect(body["container"]).not.toBeNull();
  });

  it("round-trips a tokenId above Number.MAX_SAFE_INTEGER as a string", async () => {
    scenario = "verified";
    const huge = "123456789012345678901234567890";
    const response = await inspectRequest(anonymousApp, huge);
    expect(response.statusCode).toBe(200);
    const body = jsonObject(response);
    expect((body["resource"] as Record<string, unknown>)["tokenId"]).toBe(huge);
    expect(JSON.stringify(body)).not.toMatch(/e\+/i);
  });

  it("rejects malformed token ids instead of coercing them", async () => {
    scenario = "verified";
    const invalidTokenIds: readonly unknown[] = ["-1", "1.5", "1e3", 0, null];
    for (const tokenId of invalidTokenIds) {
      const response = await anonymousApp.inject({
        method: "POST",
        url: "/v1/resources/inspect",
        payload: { chainId: 196, processor: PROCESSOR, tokenId },
      });
      expect(response.statusCode, `tokenId ${JSON.stringify(tokenId)}`).toBe(400);
      expect(jsonObject(response)["error"]).toMatchObject({ code: "INVALID_BODY" });
    }
  });

  it("rejects a processor outside the trusted factory catalogue with 422, not a widened catalogue", async () => {
    scenario = "verified";
    const response = await anonymousApp.inject({
      method: "POST",
      url: "/v1/resources/inspect",
      payload: { chainId: 196, processor: UNKNOWN_PROCESSOR, tokenId: "1" },
    });
    expect(response.statusCode).toBe(422);
    expect(jsonObject(response)["error"]).toMatchObject({ code: "PROCESSOR_NOT_REGISTERED" });
  });

  it("enforces the §7.2 limit range of 1–100", async () => {
    scenario = "verified";
    for (const limit of ["0", "101", "abc"]) {
      const response = await anonymousApp.inject({
        method: "GET",
        url: `/v1/resources/wallets/${OWNER}?chainId=196&limit=${limit}`,
      });
      expect(response.statusCode, `limit=${limit}`).toBe(400);
      expect(jsonObject(response)["error"]).toMatchObject({ code: "INVALID_LIMIT" });
    }
    for (const limit of ["1", "100"]) {
      const response = await anonymousApp.inject({
        method: "GET",
        url: `/v1/resources/wallets/${OWNER}?chainId=196&limit=${limit}`,
      });
      expect(response.statusCode, `limit=${limit}`).toBe(200);
    }
  });

  it("rejects an unsupported chain and a malformed wallet address", async () => {
    const chain = await anonymousApp.inject({
      method: "GET",
      url: "/v1/resources/processors?chainId=1",
    });
    expect(chain.statusCode).toBe(400);
    expect(jsonObject(chain)["error"]).toMatchObject({ code: "UNSUPPORTED_CHAIN" });

    const address = await anonymousApp.inject({
      method: "GET",
      url: "/v1/resources/wallets/not-an-address?chainId=196",
    });
    expect(address.statusCode).toBe(400);
    expect(jsonObject(address)["error"]).toMatchObject({ code: "INVALID_PATH" });
  });

  it("does not expose a private field in any public payload shape", async () => {
    scenario = "verified";
    const bodies: readonly [string, LightMyRequestResponse][] = [
      [
        "processors",
        await anonymousApp.inject({ method: "GET", url: "/v1/resources/processors?chainId=196" }),
      ],
      [
        "wallet page",
        await anonymousApp.inject({
          method: "GET",
          url: `/v1/resources/wallets/${OTHER_WALLET}?chainId=196`,
        }),
      ],
      ["inspect", await inspectRequest(anonymousApp, TOKEN_ID.toString(10))],
      ["offers", await anonymousApp.inject({ method: "GET", url: "/v1/resources/offers?chainId=196" })],
    ];
    for (const [label, response] of bodies) {
      assertNoPrivateKeys(jsonObject(response), label);
    }
  });
});

function inspectRequest(app: FastifyInstance, tokenId: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/v1/resources/inspect",
    payload: { chainId: 196, processor: PROCESSOR, tokenId },
  });
}
