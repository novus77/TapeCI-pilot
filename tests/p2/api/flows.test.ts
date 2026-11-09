import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import * as tar from "tar";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData } from "viem";
import {
  APPROVAL_TYPES,
} from "@tapeci/queue";
import {
  computeWebhookSignature,
  type GithubOidcClaims,
} from "@tapeci/github";
import {
  containers,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  deployments,
  githubInstallations,
  migrateUp,
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
const WEBHOOK_SECRET = "test-webhook-secret";
const SESSION_SECRET = "test-session-secret-123456";
const OWNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const OWNER = privateKeyToAccount(OWNER_KEY);
const OTHER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

const env: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: SESSION_SECRET,
  devAuth: true,
  objectStoreDir: join(tmpdir(), "tapeci-api-objects"),
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

async function makeTar(files: Record<string, string>): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), "tapeci-tar-fixture-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of tar.c({ cwd: root, portable: true }, Object.keys(files))) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(!available)("P2 API mutation flows", () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;
  const enqueued: string[] = [];
  const planEnqueued: string[] = [];
  let deploymentId = "";

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await migrateUp(testDatabase.url);
    handle = createDatabase(testDatabase.url);
    db = handle.db;
    const oidcClaims = (): GithubOidcClaims => ({
      issuer: env.githubOidcIssuer,
      audience: [env.githubOidcAudience],
      repository: "acme/site",
      repositoryId: 1234,
      repositoryOwnerId: 77,
      repositoryOwner: "acme",
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      workflowRef: "acme/site/.github/workflows/tapeci.yml@refs/heads/main",
      issuedAt: Math.floor(Date.now() / 1000),
      notBefore: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      claims: {},
    });
    const deps: ApiDeps = {
      db,
      env,
      resolveContainer: async () => resolved,
      verifyOidc: async () => oidcClaims(),
      enqueueDeployment: async (id) => {
        enqueued.push(id);
      },
      enqueuePlan: async (id) => {
        planEnqueued.push(id);
      },
    };
    app = buildApp(deps);
    await app.ready();
    process.env.TAPECI_TEST_OBJECTS = env.objectStoreDir;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await handle?.pool.end();
    await testDatabase?.drop();
  }, 30_000);

  it("challenges and verifies a wallet signature one time", async () => {
    const challenge = await app.inject({
      method: "POST",
      url: "/v1/auth/wallet/challenge",
      headers: devHeaders,
      payload: { address: OWNER.address },
    });
    expect(challenge.statusCode).toBe(200);
    const body = challenge.json() as { nonce: string; message: string };
    const signature = await OWNER.signMessage({ message: body.message });
    const verified = await app.inject({
      method: "POST",
      url: "/v1/auth/wallet/verify",
      headers: devHeaders,
      payload: { address: OWNER.address, signature, nonce: body.nonce },
    });
    expect(verified.statusCode).toBe(200);
    expect((verified.json() as { ok: boolean }).ok).toBe(true);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/wallet/verify",
      headers: devHeaders,
      payload: { address: OWNER.address, signature, nonce: body.nonce },
    });
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("creates a project, accepts a webhook once, issues a build token and ingests a tar", async () => {
    await app.inject({ method: "GET", url: "/v1/me", headers: devHeaders });
    const [installation] = await db
      .insert(githubInstallations)
      .values({ installationId: 9001, githubAccountId: 77, accountLogin: "acme" })
      .returning();
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: devHeaders,
      payload: {
        repoFullName: "acme/site",
        githubRepositoryId: 1234,
        defaultBranch: "main",
        containerAddress: CONTAINER,
        githubInstallationId: installation?.id,
      },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json() as { project: { id: string } };
    const [container] = await db.select().from(containers).limit(1);
    if (container === undefined) throw new Error("container missing");
    void container;

    // §11.2: a new project is NOT admitted until builds are explicitly enabled, so
    // the push below would be skipped with BUILD_DISABLED. Enabling is part of the
    // real flow this test covers, not a shortcut.
    const enabled = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.project.id}/enable-build`,
      headers: devHeaders,
      payload: {},
    });
    expect(enabled.statusCode).toBe(200);

    const payload = JSON.stringify({
      ref: "refs/heads/main",
      after: "a".repeat(40),
      repository: { id: 1234, full_name: "acme/site", owner: { login: "acme" } },
      installation: { id: 9001 },
    });
    const signature = computeWebhookSignature(WEBHOOK_SECRET, payload);
    const send = async (deliveryId: string) =>
      app.inject({
        method: "POST",
        url: "/v1/github/webhook",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": deliveryId,
          "x-github-event": "push",
          "x-hub-signature-256": signature,
        },
        payload,
      });
    const first = await send("delivery-1");
    expect(first.statusCode).toBe(202);
    deploymentId = (first.json() as { deploymentId: string }).deploymentId;
    for (let index = 0; index < 10; index += 1) {
      const replay = await send("delivery-1");
      expect(replay.statusCode).toBe(200);
      expect((replay.json() as { duplicate: boolean }).duplicate).toBe(true);
    }
    const deploymentsForProject = await db
      .select()
      .from(deployments)
      .where(eq(deployments.projectId, (await db.select().from(projects).limit(1))[0]?.id ?? ""));
    expect(deploymentsForProject).toHaveLength(1);

    const badSignature = await app.inject({
      method: "POST",
      url: "/v1/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-bad",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      payload,
    });
    expect(badSignature.statusCode).toBe(401);

    const tokenResponse = await app.inject({
      method: "POST",
      url: "/v1/builds/token",
      headers: { authorization: "Bearer fake-oidc-token" },
    });
    expect(tokenResponse.statusCode).toBe(200);
    const tokenBody = tokenResponse.json() as { token: string; deploymentId: string };
    expect(tokenBody.deploymentId).toBe(deploymentId);

    const tarBytes = await makeTar({
      "index.html": '<!doctype html><html><body><script src="./assets/app.js"></script></body></html>',
      "assets/app.js": "console.log('p2');",
    });
    const ingest = await app.inject({
      method: "POST",
      url: "/v1/builds/artifacts",
      headers: {
        authorization: `Bearer ${tokenBody.token}`,
        "content-type": "application/x-tar",
      },
      payload: tarBytes,
    });
    expect(ingest.statusCode).toBe(200);
    const ingested = ingest.json() as { state: string; fileCount: number; planQueued: boolean };
    expect(ingested.state).toBe("BUILT");
    expect(ingested.fileCount).toBe(2);
    expect(ingested.planQueued).toBe(true);
    expect(planEnqueued).toContain(deploymentId);
  });

  it("approves an EIP-712 plan and enqueues execution", async () => {
    const [project] = await db.select().from(projects).limit(1);
    const [container] = await db.select().from(containers).limit(1);
    if (project === undefined || container === undefined) throw new Error("fixtures missing");
    const manifestHash = `0x${"ab".repeat(32)}` as Hex;
    const [deployment] = await db
      .insert(deployments)
      .values({
        projectId: project.id,
        containerId: container.id,
        triggerKind: "manual",
        commitSha: "b".repeat(40),
        state: "PLAN_READY",
        registryAddress: REGISTRY,
        manifestSha256: manifestHash,
        planJson: { schemaVersion: "tapeci.plan.v1" },
      })
      .returning();
    if (deployment === undefined) throw new Error("deployment missing");

    const payloadResponse = await app.inject({
      method: "GET",
      url: `/v1/deployments/${deployment.id}/approval-payload`,
      headers: devHeaders,
    });
    expect(payloadResponse.statusCode).toBe(200);
    const payload = payloadResponse.json() as {
      domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
      message: {
        deploymentId: string;
        manifestHash: Hex;
        container: Hex;
        costCapWei: string;
        nonce: string;
        expiresAt: string;
      };
      approval: {
        manifestHash: Hex;
        container: Hex;
        costCapWei: string;
        nonce: string;
        expiresAt: string;
      };
      expectedSigner: Hex;
    };
    expect(payload.domain).toMatchObject({ name: "TapeCI", version: "1", chainId: 196 });
    expect(payload.domain.verifyingContract).toBe(REGISTRY);
    expect(payload.message.deploymentId).toBe(deployment.id);
    expect(payload.message.manifestHash).toBe(manifestHash);
    expect(payload.expectedSigner.toLowerCase()).toBe(OWNER.address.toLowerCase());

    const approval = {
      deploymentId: payload.message.deploymentId,
      manifestHash: payload.message.manifestHash,
      container: payload.message.container,
      costCapWei: BigInt(payload.message.costCapWei),
      nonce: payload.message.nonce,
      expiresAt: BigInt(payload.message.expiresAt),
    };
    const domain = payload.domain;
    expect(
      hashTypedData({ domain, types: APPROVAL_TYPES, primaryType: "Approval", message: approval }),
    ).toMatch(/^0x[0-9a-f]{64}$/);

    const wrongSignature = await OTHER.signTypedData({
      domain,
      types: APPROVAL_TYPES,
      primaryType: "Approval",
      message: approval,
    });
    const wrongSigner = await app.inject({
      method: "POST",
      url: `/v1/deployments/${deployment.id}/approve`,
      headers: devHeaders,
      payload: {
        signerAddress: OTHER.address,
        signature: wrongSignature,
        approval: payload.approval,
      },
    });
    expect(wrongSigner.statusCode).toBe(403);
    expect((wrongSigner.json() as { error: { code: string } }).error.code).toBe("NOT_CURRENT_OWNER");

    const signature = await OWNER.signTypedData({
      domain,
      types: APPROVAL_TYPES,
      primaryType: "Approval",
      message: approval,
    });
    const approved = await app.inject({
      method: "POST",
      url: `/v1/deployments/${deployment.id}/approve`,
      headers: devHeaders,
      payload: {
        signerAddress: OWNER.address,
        signature,
        approval: payload.approval,
      },
    });
    expect(approved.statusCode).toBe(200);
    const approvedBody = approved.json() as { state: string; operatorSession: { id: string } };
    expect(approvedBody.state).toBe("APPROVED");
    expect(approvedBody.operatorSession.id).toBeTruthy();

    const executed = await app.inject({
      method: "POST",
      url: `/v1/deployments/${deployment.id}/execute`,
      headers: devHeaders,
    });
    expect(executed.statusCode).toBe(202);
    expect(enqueued).toContain(deployment.id);
  });
  it("mints a new configVersion on a real config change and not on a no-op (§11.3)", async () => {
    // This lives inside the existing describe so it reuses the app and database that
    // beforeAll already set up, rather than standing up a second fixture.
    const [project] = await db.select().from(projects).limit(1);
    if (project === undefined) throw new Error("project missing");
    const before = project.configVersion;

    // Saving identical config must not invalidate in-flight attempts.
    const noop = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${project.id}`,
      headers: devHeaders,
      payload: { buildCommand: project.buildCommand },
    });
    expect(noop.statusCode).toBe(200);
    const [afterNoop] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(afterNoop?.configVersion).toBe(before);

    // A real change mints a new version so a build attempt can keep the config it was
    // dispatched with, and `/v1/builds/context` can report `configChanged` (AC-P4-10).
    const changed = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${project.id}`,
      headers: devHeaders,
      payload: { buildCommand: "npm run build:prod" },
    });
    expect(changed.statusCode).toBe(200);
    const [afterChange] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(afterChange?.configVersion).toBe(before + 1);
    expect(afterChange?.buildCommand).toBe("npm run build:prod");
  });


  it("§7.4 exposes readiness, build-settings and the attempt endpoints", async () => {
    const [project] = await db.select().from(projects).limit(1);
    if (project === undefined) throw new Error("project missing");

    // §7.4: readiness returns the three aggregates separately with per-check detail. It must
    // not collapse them into one boolean (§11.1).
    const readiness = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/readiness`,
      headers: devHeaders,
    });
    expect(readiness.statusCode).toBe(200);
    const body = readiness.json() as {
      canEnableBuild: boolean;
      canStartBuild: boolean;
      canPublish: boolean;
      checks: readonly { code: string; stage: string; status: string }[];
    };
    expect(typeof body.canEnableBuild).toBe("boolean");
    expect(typeof body.canStartBuild).toBe("boolean");
    expect(typeof body.canPublish).toBe("boolean");
    // All eight §11.1 items, each with a stage and a state.
    expect(body.checks.length).toBeGreaterThanOrEqual(8);
    for (const check of body.checks) {
      expect(["configuration", "build", "release"]).toContain(check.stage);
      expect(["pass", "fail", "unknown"]).toContain(check.status);
    }
    // §11.1's trap, asserted through the endpoint: an unbuilt project still has
    // static_output = unknown, and that must not block enabling.
    const staticOutput = body.checks.find((check) => check.code === "static_output");
    expect(staticOutput?.status).toBe("unknown");

    // §7.4 build-settings with a stale config version conflicts rather than reverting.
    const stale = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${project.id}/build-settings`,
      headers: devHeaders,
      payload: { enabled: true, expectedConfigVersion: project.configVersion + 99 },
    });
    expect(stale.statusCode).toBe(409);

    // Disabling is always allowed, and idempotent.
    const disabled = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${project.id}/build-settings`,
      headers: devHeaders,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect((disabled.json() as { project: { buildEnabled: boolean } }).project.buildEnabled).toBe(false);

    // And a disabled project cannot be asked to build (§11.2).
    const blocked = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/builds`,
      headers: devHeaders,
      payload: { commitSha: "a".repeat(40) },
    });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe("BUILD_DISABLED");

    // An unknown attempt is a 404, scoped to the project.
    const missing = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/builds/${crypto.randomUUID()}`,
      headers: devHeaders,
    });
    expect(missing.statusCode).toBe(404);
  });
});
