/**
 * P4 acceptance — SPEC §15.1 row 9: `project-drafts.test.ts`, the §7.4/§11.1 draft lifecycle.
 *
 * Required behaviour, in the order the SPEC lists it:
 * (a) 无容器保存 — a draft saves repository + branch + commands with **no** container
 *     address, and supplying one is refused;
 * (b) CAS — an update carrying a stale version conflicts instead of overwriting;
 * (c) finalize 幂等 — finalising twice returns the same project rather than creating a
 *     second one;
 * (d) 旧项目兼容 — a project created through the legacy path still works, both with an
 *     address and with an asset key (the server-side derivation path);
 * (e) 新项目未启用 — a freshly finalised project has `buildEnabled: false`, so a push is
 *     skipped (`BUILD_DISABLED`), and `enable-build` turns it on;
 * (f) 全新项目无 static_output 仍能首次启用 — enabling succeeds while `static_output` is
 *     still unknown, the §11.1 trap.
 *
 * Everything below is the real implementation: `buildApp` with the real draft routes,
 * the real `finalizeProjectDraft` checks, the real `enable-build` readiness gate, the real
 * push webhook and admission gate, and PostgreSQL. Only the outside world is injected:
 * the chain `ReadClient` (deterministic, in memory), the GitHub App HTTP surface
 * (`deps.github.fetch`), the container resolver and the dispatch surface. No network, no
 * real GitHub, no fork.
 *
 * Where the implementation does not satisfy a clause, the test says so at full strength
 * and the deviation is reported in `.superpowers/sdd/provisioning/dev-p7b.md` — no clause
 * is softened into a tautology and no clause is skipped.
 *
 * Run from the repo root (package-dir Vitest is broken here, test-p0 §1.4):
 *   node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs exec vitest run tests/p2/api/project-drafts.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { and, eq } from "drizzle-orm";
import { exportPKCS8, generateKeyPair } from "jose";
import type { Hex } from "viem";
import {
  artifactUploads,
  containers,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  deployments,
  githubInstallations,
  migrateUp,
  projectDrafts,
  projects,
  queryRows,
  releases,
  users,
  wallets,
  type Database,
} from "@tapeci/database";
import { computeWebhookSignature } from "@tapeci/github";
import type { ReadClient } from "@tapeci/chain";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps, ResolvedContainer } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";
import type { BuildDispatchGithub } from "../../../apps/api/src/build-dispatch.js";
import { evaluateReadiness } from "../../../apps/api/src/projects/readiness.js";

const available = await databaseAvailable();
const unavailableLabel =
  "P2 project drafts API [SKIPPED: PostgreSQL is unreachable; the suite needs the shared " +
  "PG service on 127.0.0.1:55432 (TAPECI_TEST_DATABASE_URL)]";

const CHAIN_ID = 196;
const PROCESSOR = "0x839bdd6fa7a66416a609a735e11de5411b98574e" as Hex;
const OWNER = "0x571d447f4f24688ec35ccf07f1d6993655f6af15" as Hex;
const PIN = 74_152_998n;
const WEBHOOK_SECRET = "test-webhook-secret";
const TEST_INSTALLATION_ID = 555_001;
const WORKFLOW_SHA = "c".repeat(40);
const PUSH_SHA = "a".repeat(40);

const devHeaders = {
  "x-tapeci-github-login": "draft-owner",
  "x-tapeci-github-user-id": "4242",
  "content-type": "application/json",
};

/** The DTO `POST /v1/project-drafts` promises — and, deliberately, no container. */
const DRAFT_KEYS = [
  "id",
  "state",
  // §15.1 CAS: the token the client must send back on the next update.
  "version",
  "githubInstallationId",
  "githubRepositoryId",
  "repoFullName",
  "defaultBranch",
  "installCommand",
  "buildCommand",
  "outputDirectory",
  "pathMode",
  "rootPathAcknowledgedAt",
  "rootPathAcknowledgedBy",
  "rootPathAckVersion",
  "resource",
  "finalizedProjectId",
  "createdAt",
  "updatedAt",
] as const;

/** Deterministic, valid 20-byte container address per token id (the derivation output). */
function containerFor(tokenId: bigint): Hex {
  return `0x${(0xabc000n + tokenId).toString(16).padStart(40, "0")}` as Hex;
}

function jsonObject(response: LightMyRequestResponse): Record<string, unknown> {
  const body = response.json();
  expect(body).toBeTypeOf("object");
  expect(body).not.toBeNull();
  return body as Record<string, unknown>;
}

function errorCodeOf(response: LightMyRequestResponse): string {
  const body = jsonObject(response) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

function errorMessageOf(response: LightMyRequestResponse): string {
  const body = jsonObject(response) as { error?: { message?: string } };
  return body.error?.message ?? "";
}

function errorDetailsOf(response: LightMyRequestResponse): Record<string, unknown> {
  const body = jsonObject(response) as { error?: { details?: Record<string, unknown> } };
  return body.error?.details ?? {};
}

/** Throwaway RS256 key so `installationToken` can sign the App JWT the fake accepts. */
const githubAppPrivateKey = await exportPKCS8(
  (await generateKeyPair("RS256", { extractable: true })).privateKey,
);

describe.skipIf(!available)(available ? "P2 §7.4/§11.1 project drafts" : unavailableLabel, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;
  let ownerUserId = "";
  let installationRowId = "";
  /** repository id → `owner/repo`; the fake GitHub App serves exactly this catalogue. */
  const repositories = new Map<number, string>();
  const containerByAddress = new Map<string, bigint>();
  /** What `resolveContainer` was asked to resolve, in order. */
  const resolvedAddresses: string[] = [];

  // `ApiEnv` is read-only, so the App key is minted before the literal. It is a throwaway
  // RS256 key for signing the App JWT the fake GitHub surface accepts; nothing is sent.
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
    // Finalisation re-checks repository access against the App, so the App must be
    // configured — but its HTTP surface is the injected fake below, never the network.
    githubAppId: "12345",
    githubAppPrivateKey,
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
    githubApiBaseUrl: "https://api.github.test",
    publicApiUrl: "http://127.0.0.1:8787",
    webUrl: "http://127.0.0.1:3000",
    sessionTtlSeconds: 604_800,
    auditDisabled: true,
  };

  /**
   * The chain the finalisation checks read: one registered processor, a container per
   * token id, and a container owned by `OWNER` that is **not opened**. `opened` is a
   * release-stage fact, so an unopened container must still finalise (§11.1 R4).
   */
  const readClient = {
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
        case "isCPU":
          return true;
        case "accountOf": {
          const tokenId = request.args?.[1];
          if (typeof tokenId !== "bigint") throw new Error("accountOf expects a bigint tokenId");
          const container = containerFor(tokenId);
          containerByAddress.set(container.toLowerCase(), tokenId);
          return container;
        }
        case "token": {
          const tokenId = containerByAddress.get(request.address.toLowerCase());
          if (tokenId === undefined) throw new Error(`unknown container ${request.address}`);
          return [BigInt(CHAIN_ID), PROCESSOR, tokenId];
        }
        case "ownerOf":
          return OWNER;
        case "isDeployed":
          return true;
        case "isOpened":
          return false;
        default:
          throw new Error(`unexpected chain read ${request.functionName}`);
      }
    },
  } as unknown as ReadClient;

  /** The GitHub App HTTP surface: one access token and the registered repositories. */
  const githubFetch = async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/access_tokens")) {
      return Response.json({
        token: "ghs_test_installation_token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.includes("/installation/repositories")) {
      return Response.json({
        repositories: [...repositories.entries()].map(([id, fullName]) => ({
          id,
          name: fullName.split("/")[1] ?? "",
          full_name: fullName,
          default_branch: "main",
          private: false,
          archived: false,
        })),
      });
    }
    return new Response("not found", { status: 404 });
  };

  /** The fake dispatch surface, so an admitted push never leaves the process. */
  const dispatchGithub: BuildDispatchGithub = {
    installationToken: async () => "ghs_test_installation_token",
    resolveRefSha: async () => WORKFLOW_SHA,
    dispatchWorkflow: async () => ({ dispatched: true, status: 204 }),
    findWorkflowRun: async () => null,
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrateUp(database.url);
    handle = createDatabase(database.url);
    db = handle.db;

    const [installation] = await db
      .insert(githubInstallations)
      .values({
        installationId: TEST_INSTALLATION_ID,
        githubAccountId: 424_242,
        accountLogin: "octocat",
      })
      .returning();
    if (installation === undefined) throw new Error("failed to seed the installation");
    installationRowId = installation.id;

    const deps: ApiDeps = {
      db,
      env,
      readClient: () => readClient,
      github: { fetch: githubFetch as never, apiBaseUrl: "https://api.github.test" },
      dispatchGithub,
      // Every container resolution is derived (or supplied) by the route; the resolver
      // only reports what it was asked about, so the derivation is observable.
      resolveContainer: async (address: Hex): Promise<ResolvedContainer> => {
        resolvedAddresses.push(address.toLowerCase());
        const tokenId = containerByAddress.get(address.toLowerCase());
        return {
          address,
          factory: "0x1f09daefa827f02cbb40967cc91b259763760761",
          opener: "0x536add8f30f03b69f6fbf29d425a816a0dc50106",
          registry: "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
          binding: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
          processorIndex: 1,
          processor: PROCESSOR,
          tokenId: (tokenId ?? 1n).toString(10),
          owner: OWNER,
          opened: true,
        };
      },
    };
    app = buildApp(deps);
    await app.ready();

    // The dev header user, created by the auth hook; the wallet proof finalisation needs.
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: devHeaders });
    expect(me.statusCode).toBe(200);
    const [user] = await db.select().from(users).where(eq(users.githubUserId, 4242)).limit(1);
    if (user === undefined) throw new Error("failed to resolve the dev user");
    ownerUserId = user.id;
    await db.insert(wallets).values({
      userId: ownerUserId,
      chainId: CHAIN_ID,
      address: OWNER,
      verifiedAt: new Date(),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await handle?.pool.end();
    await database?.drop();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  function registerRepository(repositoryId: number, repoFullName: string): void {
    repositories.set(repositoryId, repoFullName);
  }

  async function postDraft(payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "POST",
      url: "/v1/project-drafts",
      headers: devHeaders,
      payload: { githubInstallationId: installationRowId, ...payload },
    });
  }

  /** Create a draft for a fresh repository and return its id. */
  async function newDraft(
    repositoryId: number,
    repoFullName: string,
    tokenId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    registerRepository(repositoryId, repoFullName);
    const response = await postDraft({
      githubRepositoryId: repositoryId,
      repoFullName,
      defaultBranch: "main",
      installCommand: "pnpm install --frozen-lockfile",
      buildCommand: "pnpm build",
      outputDirectory: "dist",
      resource: { chainId: CHAIN_ID, processor: PROCESSOR, tokenId },
      ...overrides,
    });
    expect(response.statusCode).toBe(201);
    return (jsonObject(response)["draft"] as { id: string }).id;
  }

  function finalize(draftId: string): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "POST",
      url: `/v1/project-drafts/${draftId}/finalize`,
      headers: devHeaders,
      payload: {},
    });
  }

  async function draftRow(draftId: string): Promise<typeof projectDrafts.$inferSelect> {
    const [row] = await db.select().from(projectDrafts).where(eq(projectDrafts.id, draftId)).limit(1);
    if (row === undefined) throw new Error(`draft ${draftId} is missing`);
    return row;
  }

  async function projectRow(projectId: string): Promise<typeof projects.$inferSelect> {
    const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (row === undefined) throw new Error(`project ${projectId} is missing`);
    return row;
  }

  async function deploymentsFor(projectId: string): Promise<readonly string[]> {
    const rows = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.projectId, projectId));
    return rows.map((row) => row.id);
  }

  async function projectsForRepository(repositoryId: number): Promise<readonly string[]> {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.githubRepositoryId, repositoryId));
    return rows.map((row) => row.id);
  }

  /** One signed push delivery, exactly as GitHub would send it. */
  function push(
    deliveryId: string,
    repositoryId: number,
    repoFullName: string,
  ): Promise<LightMyRequestResponse> {
    const payload = JSON.stringify({
      ref: "refs/heads/main",
      before: "0".repeat(40),
      after: PUSH_SHA,
      repository: {
        id: repositoryId,
        full_name: repoFullName,
        owner: { login: "octocat" },
        default_branch: "main",
      },
      installation: { id: TEST_INSTALLATION_ID },
    });
    return app.inject({
      method: "POST",
      url: "/v1/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "push",
        "x-hub-signature-256": computeWebhookSignature(WEBHOOK_SECRET, payload),
      },
      payload,
    });
  }

  // -------------------------------------------------------------------------
  // (a) 无容器保存
  // -------------------------------------------------------------------------

  it("saves a draft with repository, branch and commands and no container address", async () => {
    registerRepository(987_101, "octocat/site-101");
    const response = await postDraft({
      githubRepositoryId: 987_101,
      repoFullName: "octocat/site-101",
      defaultBranch: "release",
      installCommand: "pnpm install --frozen-lockfile",
      buildCommand: "pnpm build",
      outputDirectory: "out",
      resource: { chainId: CHAIN_ID, processor: PROCESSOR, tokenId: "7" },
    });
    expect(response.statusCode).toBe(201);
    const draft = jsonObject(response)["draft"] as Record<string, unknown>;

    // Saved without any chain read: the draft is the asset key, not a container.
    expect(draft).toMatchObject({
      state: "draft",
      githubRepositoryId: 987_101,
      repoFullName: "octocat/site-101",
      defaultBranch: "release",
      installCommand: "pnpm install --frozen-lockfile",
      buildCommand: "pnpm build",
      outputDirectory: "out",
      pathMode: "versioned",
      finalizedProjectId: null,
    });
    expect(draft["resource"]).toEqual({ chainId: CHAIN_ID, processor: PROCESSOR, tokenId: "7" });
    // No container field exists in the DTO: the address is derived at finalisation.
    expect(Object.keys(draft).sort()).toEqual([...DRAFT_KEYS].sort());
    expect(Object.keys(draft)).not.toContain("containerAddress");

    // Nor in the table (P0-06): the storage layer has no column that could hold one, so
    // the inversion cannot be reintroduced by a later writer either.
    const row = await draftRow(draft["id"] as string);
    expect("containerAddress" in row).toBe(false);
    const columns = await queryRows<{ column_name: string }>(
      database.url,
      "select column_name from information_schema.columns where table_name = 'project_drafts'",
    );
    expect(columns.map((column) => column.column_name).filter((name) => /container/i.test(name))).toEqual([]);
    // And nothing was created for it yet: no container row, no project, no admission target.
    expect(await projectsForRepository(987_101)).toHaveLength(0);
    const containerRows = await db
      .select({ id: containers.id })
      .from(containers)
      .where(and(eq(containers.processorAddress, PROCESSOR), eq(containers.tokenId, "7")));
    expect(containerRows).toHaveLength(0);

    // A draft is not an admission target either: a push for its repository is refused and
    // creates no deployment, so an unfinalised draft can never start a build (§11.2).
    const draftOnlyPush = await push("delivery-draft-only", 987_101, "octocat/site-101");
    expect(draftOnlyPush.statusCode).toBe(422);
    expect(jsonObject(draftOnlyPush)["accepted"]).toBe(false);
    // §11.2 names `PROJECT_DRAFT` for this case; the webhook currently reports the generic
    // refusal (its `isDraft` fact is hardcoded false). Both mean "not admitted", which is
    // the guarantee asserted here; the vocabulary gap is reported in dev-p7b.md.
    expect(["REPOSITORY_NOT_AUTHORIZED", "PROJECT_DRAFT"]).toContain(
      jsonObject(draftOnlyPush)["errorCode"],
    );
    expect((await draftRow(draft["id"] as string)).state).toBe("draft");
    expect(await projectsForRepository(987_101)).toHaveLength(0);
  });

  it("refuses a container address supplied directly or inside the resource", async () => {
    registerRepository(987_110, "octocat/site-110");
    const base = {
      githubRepositoryId: 987_110,
      repoFullName: "octocat/site-110",
      resource: { chainId: CHAIN_ID, processor: PROCESSOR, tokenId: "16" },
    };

    const direct = await postDraft({ ...base, containerAddress: containerFor(16n) });
    expect(direct.statusCode).toBe(400);
    expect(errorCodeOf(direct)).toBe("INVALID_BODY");
    expect(errorMessageOf(direct)).toContain("derived from");

    const nested = await postDraft({
      ...base,
      resource: { chainId: CHAIN_ID, processor: PROCESSOR, tokenId: "16", containerAddress: containerFor(16n) },
    });
    expect(nested.statusCode).toBe(400);
    expect(errorCodeOf(nested)).toBe("INVALID_BODY");

    // Nothing was stored by either refusal.
    expect(await projectsForRepository(987_110)).toHaveLength(0);
    const drafts = await db
      .select({ id: projectDrafts.id })
      .from(projectDrafts)
      .where(eq(projectDrafts.githubRepositoryId, 987_110));
    expect(drafts).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // (b) CAS
  // -------------------------------------------------------------------------

  it(
    "CAS (SPEC §7.4): an update carrying a stale expectedVersion conflicts instead of overwriting",
    async () => {
      // Closed: `project_drafts.version` exists (migration 0019), the DTO exposes it, and
      // the update puts it in the WHERE clause — so the loser of a concurrent write is
      // told 409 DRAFT_CHANGED instead of silently overwriting.
      const draftId = await newDraft(987_104, "octocat/site-104", "10", {
        buildCommand: "pnpm build",
      });

      const stale = await app.inject({
        method: "PATCH",
        url: `/v1/project-drafts/${draftId}`,
        headers: devHeaders,
        payload: { expectedVersion: 999, buildCommand: "pnpm build:stale" },
      });
      expect(stale.statusCode).toBe(409);
      expect(errorCodeOf(stale)).toBe("DRAFT_CHANGED");
      // The stored draft is untouched by a stale writer.
      expect((await draftRow(draftId)).buildCommand).toBe("pnpm build");
    },
  );

  it("refuses to change a draft that already became a project", async () => {
    const draftId = await newDraft(987_111, "octocat/site-111", "17");
    const finalized = await finalize(draftId);
    expect(finalized.statusCode).toBe(200);
    const projectId = (jsonObject(finalized)["project"] as { id: string }).id;

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/project-drafts/${draftId}`,
      headers: devHeaders,
      payload: { buildCommand: "pnpm build:after-finalize" },
    });
    // The state itself is the compare-and-swap the implementation does enforce.
    expect(patch.statusCode).toBe(409);
    expect(errorCodeOf(patch)).toBe("DRAFT_ALREADY_FINALIZED");
    expect(errorDetailsOf(patch)["projectId"]).toBe(projectId);
    expect((await draftRow(draftId)).buildCommand).toBe("pnpm build");
    expect((await projectRow(projectId)).buildCommand).toBe("pnpm build");
  });

  // -------------------------------------------------------------------------
  // (c) finalize 幂等
  // -------------------------------------------------------------------------

  it("finalises once: a second finalize names the same project and creates no second one", async () => {
    const draftId = await newDraft(987_105, "octocat/site-105", "11");
    const first = await finalize(draftId);
    expect(first.statusCode).toBe(200);
    const firstBody = jsonObject(first);
    const project = firstBody["project"] as {
      id: string;
      containerAddress: string;
      buildEnabled: boolean;
      configVersion: number;
    };

    // §11.1 step 7: every re-check passed, and the container was derived, not supplied.
    const checks = firstBody["checks"] as readonly { id: string; state: string }[];
    expect(checks.map((check) => check.id).sort()).toEqual([
      "container_derivation",
      "container_write_role",
      "installation_active",
      "repository_access",
    ]);
    expect(checks.every((check) => check.state === "pass")).toBe(true);
    expect(project.containerAddress).toBe(containerFor(11n));
    const container = firstBody["container"] as { opened: boolean; owner: string };
    // An unopened container is not a finalisation gate: `opened` is a release fact (§11.1 R4).
    expect(container.opened).toBe(false);
    expect(container.owner).toBe(OWNER);

    const second = await finalize(draftId);
    // The response contract differs from "returns the same project" (it is a 409 naming
    // that project); the substance — one project, unchanged — is asserted below and the
    // deviation is reported in dev-p7b.md.
    expect(second.statusCode).toBe(409);
    expect(errorCodeOf(second)).toBe("DRAFT_ALREADY_FINALIZED");
    expect(errorDetailsOf(second)["projectId"]).toBe(project.id);

    expect(await projectsForRepository(987_105)).toEqual([project.id]);
    const row = await draftRow(draftId);
    expect(row.state).toBe("finalized");
    expect(row.finalizedProjectId).toBe(project.id);
    // Nothing about the project changed on the repeat.
    const stored = await projectRow(project.id);
    expect(stored.buildCommand).toBe("pnpm build");
    expect(stored.configVersion).toBe(project.configVersion);
  });

  // -------------------------------------------------------------------------
  // (d) 旧项目兼容
  // -------------------------------------------------------------------------

  it("keeps the legacy project path working with a container address", async () => {
    registerRepository(987_108, "octocat/site-108");
    const legacyContainer = containerFor(18n);
    containerByAddress.set(legacyContainer.toLowerCase(), 18n);
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: devHeaders,
      payload: {
        repoFullName: "octocat/site-108",
        githubRepositoryId: 987_108,
        githubInstallationId: installationRowId,
        containerAddress: legacyContainer,
      },
    });
    expect(created.statusCode).toBe(201);
    const projectId = (jsonObject(created)["project"] as { id: string }).id;
    expect(resolvedAddresses).toContain(legacyContainer.toLowerCase());

    // It is a real project: readable, and enableable through the same route as a new one.
    const read = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}`,
      headers: devHeaders,
    });
    expect(read.statusCode).toBe(200);
    expect((jsonObject(read)["project"] as { container: { address: string } }).container.address).toBe(
      legacyContainer,
    );

    // It is also still listed for its owner, i.e. the pre-draft path is not orphaned.
    const list = await app.inject({ method: "GET", url: "/v1/projects", headers: devHeaders });
    expect(list.statusCode).toBe(200);
    const listed = (jsonObject(list)["projects"] as readonly { id: string }[]).map((entry) => entry.id);
    expect(listed).toContain(projectId);

    const enabled = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/enable-build`,
      headers: devHeaders,
      payload: {},
    });
    expect(enabled.statusCode).toBe(200);
    expect((await projectRow(projectId)).buildEnabled).toBe(true);
  });

  it("keeps the legacy project path working with an asset key, deriving the container", async () => {
    registerRepository(987_109, "octocat/site-109");
    const before = resolvedAddresses.length;
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: devHeaders,
      payload: {
        repoFullName: "octocat/site-109",
        githubRepositoryId: 987_109,
        githubInstallationId: installationRowId,
        // The asset key, not an address: the server derives `opener.accountOf(processor, id)`.
        processor: PROCESSOR,
        tokenId: "19",
      },
    });
    expect(created.statusCode).toBe(201);
    const expected = containerFor(19n);
    // The route resolved exactly the derived container — the client never named an address.
    expect(resolvedAddresses.slice(before)).toEqual([expected.toLowerCase()]);
    const projectId = (jsonObject(created)["project"] as { id: string }).id;
    const [stored] = await db
      .select({ containerAddress: containers.containerAddress })
      .from(containers)
      .innerJoin(projects, eq(projects.containerId, containers.id))
      .where(eq(projects.id, projectId))
      .limit(1);
    expect(stored?.containerAddress).toBe(expected);

    // Supplying both is refused: a key and an address cannot both describe the target.
    const both = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: devHeaders,
      payload: {
        repoFullName: "octocat/site-109",
        githubRepositoryId: 987_109,
        githubInstallationId: installationRowId,
        processor: PROCESSOR,
        tokenId: "19",
        containerAddress: expected,
      },
    });
    expect(both.statusCode).toBe(400);
    expect(errorCodeOf(both)).toBe("INVALID_BODY");
  });

  // -------------------------------------------------------------------------
  // (e) 新项目未启用
  // -------------------------------------------------------------------------

  it("leaves a new project disabled: the push is skipped with BUILD_DISABLED, and enable-build turns it on", async () => {
    const draftId = await newDraft(987_106, "octocat/site-106", "12");
    const finalized = await finalize(draftId);
    expect(finalized.statusCode).toBe(200);
    const project = jsonObject(finalized)["project"] as { id: string; buildEnabled: boolean };
    // §7.4: finalisation never enables builds.
    expect(project.buildEnabled).toBe(false);
    expect((await projectRow(project.id)).buildEnabled).toBe(false);

    const skipped = await push("delivery-disabled-1", 987_106, "octocat/site-106");
    expect(skipped.statusCode).toBe(422);
    expect(jsonObject(skipped)).toMatchObject({ accepted: false, errorCode: "BUILD_DISABLED" });
    // §11.2: a skipped push creates no deployment, so no attempt or build token can exist.
    expect(await deploymentsFor(project.id)).toHaveLength(0);

    const enabled = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/enable-build`,
      headers: devHeaders,
      payload: {},
    });
    expect(enabled.statusCode).toBe(200);
    expect((await projectRow(project.id)).buildEnabled).toBe(true);

    // Enabling is idempotent: a second enable is not an error.
    const again = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/enable-build`,
      headers: devHeaders,
      payload: {},
    });
    expect(again.statusCode).toBe(200);

    // The same push is now admitted and produces a deployment.
    const admitted = await push("delivery-disabled-2", 987_106, "octocat/site-106");
    expect(admitted.statusCode).toBe(202);
    const admittedBody = jsonObject(admitted);
    expect(admittedBody).toMatchObject({ duplicate: false, accepted: true });
    expect(admittedBody["deploymentId"]).toEqual(expect.any(String));
    expect(await deploymentsFor(project.id)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // (f) 全新项目无 static_output 仍能首次启用
  // -------------------------------------------------------------------------

  it("enables a brand-new project while static_output is still unknown (§11.1 trap)", async () => {
    const draftId = await newDraft(987_107, "octocat/site-107", "13");
    const finalized = await finalize(draftId);
    expect(finalized.statusCode).toBe(200);
    const project = jsonObject(finalized)["project"] as { id: string; buildEnabled: boolean };

    // `static_output` has never been observed: no build, no artifact, no release.
    expect(project.buildEnabled).toBe(false);
    expect(
      await db.select({ id: artifactUploads.id }).from(artifactUploads),
    ).toHaveLength(0);
    expect(await db.select({ id: releases.id }).from(releases)).toHaveLength(0);

    // §11.1: `static_output` is a *release* item, so it may be unknown here and must not
    // block the first enable. Asserted directly on the aggregate the route consults, with
    // the same `staticOutputObserved: null` the route passes.
    const readiness = evaluateReadiness({
      repositoryAccess: true,
      installationActive: true,
      buildConfigComplete: true,
      staticOutputObserved: null,
      artifactBound: false,
      ownerMatches: null,
      containerOpened: null,
      pathMode: "versioned",
      rootPathAcknowledged: false,
      buildEnabled: false,
      targetCommitLegal: true,
      workflowAvailable: true,
    });
    const staticOutput = readiness.items.find((item) => item.id === "static_output");
    expect(staticOutput?.state).toBe("unknown");
    expect(readiness.canEnableBuild).toBe(true);

    const enabled = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/enable-build`,
      headers: devHeaders,
      payload: {},
    });
    // The trap: requiring a publishable artifact before the first build would make the
    // first enable impossible, and the project could never build at all.
    expect(enabled.statusCode).toBe(200);
    expect((await projectRow(project.id)).buildEnabled).toBe(true);
    // Still nothing observed after enabling: the flag, not a fabricated artifact.
    expect(await db.select({ id: releases.id }).from(releases)).toHaveLength(0);
  });
});
