/**
 * P2-06 full pipeline on a local Anvil fork of X Layer 196:
 *
 *   GitHub webhook -> deployment RECEIVED
 *   GitHub OIDC -> one-time build token -> tar artifact upload -> BUILT
 *   BullMQ plan worker -> PLAN_READY
 *   (approval seeded directly; the EIP-712 route is covered by tests/p2/api/flows)
 *   API execute -> BullMQ deploy worker -> executeRelease + entry-last cutover
 *   BullMQ verify worker -> verifyRelease -> LIVE
 *   second release -> rollback API -> deploy worker switches the entry back -> LIVE
 *
 * The container owner is an impersonated fork account (no private key), so the
 * test injects an impersonated wallet into the worker runtime. No mainnet writes.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as tar from "tar";
import { eq } from "drizzle-orm";
import { XLAYER_MAINNET } from "@tapeci/config";
import { readFileBytesAt } from "@tapeci/chain";
import {
  approvals,
  chainTransactions,
  containers,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  deployments,
  githubInstallations,
  migrateUp,
  releaseFiles,
  releases,
  type Database,
} from "@tapeci/database";
import {
  createDeploymentQueues,
  createOperatorSession,
  enqueueDeployment,
  getDeployment,
  startWorkers,
  stopWorkers,
  transitionDeployment,
} from "@tapeci/queue";
import { computeWebhookSignature, type GithubOidcClaims } from "@tapeci/github";
import { sha256Hex } from "@tapeci/shared";
import { buildApp } from "../../apps/api/src/app.js";
import type { ApiDeps, ResolvedContainer } from "../../apps/api/src/deps.js";
import type { ApiEnv } from "../../apps/api/src/env.js";
import { createWorkerHandlers, createWorkerRuntime } from "../../apps/api/src/worker/runtime.js";
import { startAnvilFork, type AnvilFork } from "../../scripts/fork/anvil.js";
import {
  ONE_OKB,
  clientsFor,
  fundAndImpersonate,
  openNewContainer,
  walletFor,
} from "../../scripts/fork/support.js";

const available = await databaseAvailable();
const COMMIT = "c".repeat(40);
const WEBHOOK_SECRET = "fork-webhook-secret";
const SESSION_SECRET = "fork-session-secret-123456";

const env: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: SESSION_SECRET,
  devAuth: true,
  objectStoreDir: "",
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: WEBHOOK_SECRET,
  githubOidcAudience: "tapeci-artifact-upload",
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
  operatorPrivateKey: null,
  writeRpcUrl: null,
  journalDir: "",
  githubAppSlug: null,
  githubOAuthClientId: null,
  githubOAuthClientSecret: null,
  githubOAuthBaseUrl: "https://github.com",
  githubApiBaseUrl: "https://api.github.com",
  publicApiUrl: "http://127.0.0.1:8787",
  webUrl: "http://127.0.0.1:3000",
  sessionTtlSeconds: 604_800,
};

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 180_000,
  intervalMs = 750,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for pipeline state");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function makeTar(files: Record<string, string>): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), "tapeci-fork-tar-"));
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

describe.skipIf(!available)("P2-06 fork pipeline (API + BullMQ workers)", () => {
  let fork: AnvilFork;
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;
  let appDir: string;
  let journalDir: string;
  let queues: ReturnType<typeof createDeploymentQueues>;
  let workers: Awaited<ReturnType<typeof startWorkers>>;
  let containerAddress: `0x${string}`;
  let owner: `0x${string}`;
  let projectId = "";
  let planPinBlock: bigint;
  let oidcCommit = COMMIT;
  let releaseA: { id: string; releaseId: string; manifestSha256: string; entrySha256: string } | null =
    null;
  let entryASha = "";

  const headers = {
    "x-tapeci-github-login": "fork-user",
    "x-tapeci-github-user-id": "4343",
    "content-type": "application/json",
  };

  beforeAll(async () => {
    appDir = await mkdtemp(join(tmpdir(), "tapeci-fork-app-"));
    journalDir = await mkdtemp(join(tmpdir(), "tapeci-fork-journal-"));
    fork = await startAnvilFork({ offset: 60 });
    const clients = clientsFor(fork);
    const opened = await openNewContainer({
      fork,
      client: clients.publicClient,
      testClient: clients.testClient,
      opener: "0x1000000000000000000000000000000000000004",
    });
    containerAddress = opened.container;
    owner = opened.owner;
    await fundAndImpersonate(clients.testClient, owner, 100n * ONE_OKB);
    planPinBlock = await clients.publicClient.getBlockNumber();

    testDatabase = await createTestDatabase();
    await migrateUp(testDatabase.url);
    handle = createDatabase(testDatabase.url);
    db = handle.db;

    const testEnv: ApiEnv = { ...env, objectStoreDir: join(appDir, "objects"), journalDir };
    const resolved: ResolvedContainer = {
      address: containerAddress,
      factory: XLAYER_MAINNET.factory,
      opener: XLAYER_MAINNET.opener,
      registry: XLAYER_MAINNET.registries[0] as `0x${string}`,
      binding: XLAYER_MAINNET.binding,
      processorIndex: opened.fixture.processorIndex,
      processor: opened.fixture.processor,
      tokenId: opened.fixture.tokenId.toString(),
      owner,
      opened: true,
    };
    const prefix = `tapeci-fork-${randomUUID()}`;
    queues = createDeploymentQueues({ redisUrl: testEnv.redisUrl, prefix });
    const runtime = createWorkerRuntime({
      db,
      env: testEnv,
      operators: [
        {
          operator: "fork",
          url: fork.url,
          endpoint: { url: fork.url, operator: "okx", maxBatch: 10 },
          client: clients.publicClient,
        },
      ],
      wallet: walletFor(fork.url, owner),
      signer: owner,
      journalDir,
      objectStoreDir: testEnv.objectStoreDir,
      allowSingleOperator: true,
      planPinnedBlockNumber: planPinBlock,
      enqueueVerify: async (id: string) => {
        await enqueueDeployment(queues.verify, id);
      },
    });
    workers = await startWorkers({
      db,
      redisUrl: testEnv.redisUrl,
      prefix,
      handlers: createWorkerHandlers(runtime),
      concurrency: { plan: 1, deploy: 1, verify: 1 },
    });

    const claims = (): GithubOidcClaims => ({
      issuer: testEnv.githubOidcIssuer,
      audience: [testEnv.githubOidcAudience],
      repository: "acme/fork-site",
      repositoryId: 4242,
      repositoryOwnerId: 77,
      repositoryOwner: "acme",
      ref: "refs/heads/main",
      sha: oidcCommit,
      workflowRef: "acme/fork-site/.github/workflows/tapeci.yml@refs/heads/main",
      issuedAt: Math.floor(Date.now() / 1000),
      notBefore: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      claims: {},
    });
    const deps: ApiDeps = {
      db,
      env: testEnv,
      resolveContainer: async () => resolved,
      verifyOidc: async () => claims(),
      enqueuePlan: async (id: string) => {
        await enqueueDeployment(queues.plan, id);
      },
      enqueueDeployment: async (id: string) => {
        await enqueueDeployment(queues.deploy, id);
      },
    };
    app = buildApp(deps);
    await app.ready();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    if (workers !== undefined) await stopWorkers(workers);
    await queues?.close();
    await handle?.pool.end();
    await testDatabase?.drop();
    if (fork !== undefined) await fork.stop();
    if (appDir !== undefined) await rm(appDir, { recursive: true, force: true });
    if (journalDir !== undefined) await rm(journalDir, { recursive: true, force: true });
  }, 180_000);

  async function approveDeployment(targetDeploymentId: string, manifestSha: string): Promise<void> {
    const [container] = await db
      .select()
      .from(containers)
      .where(eq(containers.containerAddress, containerAddress.toLowerCase()))
      .limit(1);
    if (container === undefined) throw new Error("container row missing");
    const [approval] = await db
      .insert(approvals)
      .values({
        deploymentId: targetDeploymentId,
        signerAddress: owner,
        chainId: 196,
        manifestSha256: manifestSha,
        approvalDigest: `0x${randomBytes(32).toString("hex")}`,
        signature: "0xfork",
        approvedCostCapWei: ONE_OKB.toString(),
        nonce: `fork-approval-${targetDeploymentId}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    if (approval === undefined) throw new Error("approval insert failed");
    await createOperatorSession(db, {
      containerId: container.id,
      signerAddress: owner,
      approvalId: approval.id,
      ttlSeconds: 3_600,
    });
    await db
      .update(deployments)
      .set({ approvedCostCapWei: ONE_OKB.toString() })
      .where(eq(deployments.id, targetDeploymentId));
    const current = await getDeployment(db, targetDeploymentId);
    if (current === null) throw new Error("deployment missing");
    const awaiting = await transitionDeployment(db, {
      deploymentId: targetDeploymentId,
      expectedVersion: current.stateVersion,
      toState: "AWAITING_APPROVAL",
      eventType: "approval_requested",
      actorKind: "user",
    });
    await transitionDeployment(db, {
      deploymentId: targetDeploymentId,
      expectedVersion: awaiting.stateVersion,
      toState: "APPROVED",
      eventType: "approval_recorded",
      actorKind: "user",
    });
  }

  async function publishDeployment(commit: string, html: string, script: string): Promise<string> {
    oidcCommit = commit;
    const payload = JSON.stringify({
      ref: "refs/heads/main",
      after: commit,
      repository: { id: 4242, full_name: "acme/fork-site", owner: { login: "acme" } },
      installation: { id: 4242 },
    });
    const webhook = await app.inject({
      method: "POST",
      url: "/v1/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": `fork-${randomUUID()}`,
        "x-github-event": "push",
        "x-hub-signature-256": computeWebhookSignature(WEBHOOK_SECRET, payload),
      },
      payload,
    });
    expect(webhook.statusCode).toBe(202);
    const id = (webhook.json() as { deploymentId: string }).deploymentId;
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/v1/builds/token",
      headers: { authorization: "Bearer fork-oidc-token" },
    });
    expect(tokenResponse.statusCode).toBe(200);
    const token = (tokenResponse.json() as { token: string }).token;
    const tarBytes = await makeTar({ "index.html": html, "assets/app.js": script });
    const ingest = await app.inject({
      method: "POST",
      url: "/v1/builds/artifacts",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-tar" },
      payload: tarBytes,
    });
    expect(ingest.statusCode).toBe(200);
    await waitFor(async () => {
      const [row] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
      return row?.state === "PLAN_READY" ? row : null;
    });
    return id;
  }

  async function executeAndWaitLive(targetDeploymentId: string): Promise<void> {
    const executed = await app.inject({
      method: "POST",
      url: `/v1/deployments/${targetDeploymentId}/execute`,
      headers,
    });
    expect(executed.statusCode).toBe(202);
    try {
      await waitFor(async () => {
        const [row] = await db
          .select()
          .from(deployments)
          .where(eq(deployments.id, targetDeploymentId))
          .limit(1);
        return row?.state === "LIVE" ? row : null;
      }, 240_000);
    } catch (error) {
      const [row] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, targetDeploymentId))
        .limit(1);
      const job = await queues.deploy.getJob(targetDeploymentId);
      console.error(
        "LIVE TIMEOUT",
        targetDeploymentId,
        row?.state,
        row?.errorCode,
        row?.errorMessage,
        job === undefined ? "no-job" : await job.getState(),
        job?.failedReason,
      );
      throw error;
    }
  }

  async function createProject(): Promise<void> {
    await app.inject({ method: "GET", url: "/v1/me", headers });
    const [installation] = await db
      .insert(githubInstallations)
      .values({ installationId: 4242, githubAccountId: 4242, accountLogin: "acme" })
      .returning();
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers,
      payload: {
        repoFullName: "acme/fork-site",
        githubRepositoryId: 4242,
        defaultBranch: "main",
        containerAddress,
        githubInstallationId: installation?.id,
      },
    });
    expect(created.statusCode).toBe(201);
    projectId = (created.json() as { project: { id: string } }).project.id;
    // §11.2: a new project is NOT admitted until builds are explicitly enabled, so the
    // push below would be refused with BUILD_DISABLED. This is part of the real flow —
    // the pipeline test exists to exercise webhook -> LIVE, not to bypass the gate.
    const enabled = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/enable-build`,
      headers,
      payload: {},
    });
    expect(enabled.statusCode).toBe(200);
  }

  it("runs webhook -> artifact -> plan -> execute -> verify -> LIVE on the fork", async () => {
    await createProject();
    const deploymentId = await publishDeployment(
      COMMIT,
      '<!doctype html><html><body><script src="./assets/app.js"></script><h1>A</h1></body></html>',
      "console.log('release A');",
    );
    const [planned] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);
    if (planned?.manifestSha256 === null || planned?.manifestSha256 === undefined) {
      throw new Error("no manifest hash after planning");
    }
    await approveDeployment(deploymentId, planned.manifestSha256);
    await executeAndWaitLive(deploymentId);

    const [live] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);
    expect(live?.state).toBe("LIVE");
    expect(live?.finishedAt).not.toBeNull();

    const [release] = await db
      .select()
      .from(releases)
      .where(eq(releases.deploymentId, deploymentId))
      .limit(1);
    expect(release).toBeDefined();
    expect(release?.isCurrent).toBe(true);
    expect((release?.verifyReport as { releaseMatch?: boolean }).releaseMatch).toBe(true);
    if (release !== undefined) {
      releaseA = {
        id: release.id,
        releaseId: release.releaseId,
        manifestSha256: release.manifestSha256,
        entrySha256: release.entrySha256,
      };
    }

    const files = await db
      .select()
      .from(releaseFiles)
      .where(eq(releaseFiles.deploymentId, deploymentId));
    expect(files.length).toBeGreaterThan(0);
    const entry = files.find((file) => file.targetPath === "index.html");
    expect(entry).toBeDefined();
    const chainEntry = await readFileBytesAt(
      clientsFor(fork).publicClient,
      XLAYER_MAINNET.registries[0] as `0x${string}`,
      containerAddress,
      "index.html",
    );
    expect(chainEntry.bytes.length).toBe(entry?.byteSize);
    expect(sha256Hex(chainEntry.bytes)).toBe(entry?.sha256);
    entryASha = entry?.sha256 ?? "";

    const transactions = await db
      .select()
      .from(chainTransactions)
      .where(eq(chainTransactions.deploymentId, deploymentId));
    expect(transactions.length).toBeGreaterThan(0);
    expect(transactions.every((tx) => tx.state === "INCLUDED")).toBe(true);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/deployments/${deploymentId}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as {
      deployment: { state: string; releaseFiles: unknown[]; chainTransactions: unknown[] };
    };
    expect(detailBody.deployment.state).toBe("LIVE");
    expect(detailBody.deployment.releaseFiles.length).toBeGreaterThan(0);
    expect(detailBody.deployment.chainTransactions.length).toBeGreaterThan(0);
  }, 300_000);

  it("rolls a live project back to a stored release through the deploy worker", async () => {
    const firstRelease = releaseA;
    if (firstRelease === null || entryASha === "") throw new Error("first release not captured");

    const commitB = "d".repeat(40);
    const deploymentB = await publishDeployment(
      commitB,
      '<!doctype html><html><body><script src="./assets/app.js"></script><h1>B</h1></body></html>',
      "console.log('release B');",
    );
    const [plannedB] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentB))
      .limit(1);
    if (plannedB?.manifestSha256 === null || plannedB?.manifestSha256 === undefined) {
      throw new Error("release B was not planned");
    }
    await approveDeployment(deploymentB, plannedB.manifestSha256);
    await executeAndWaitLive(deploymentB);
    const [releaseB] = await db
      .select()
      .from(releases)
      .where(eq(releases.deploymentId, deploymentB))
      .limit(1);
    expect(releaseB?.isCurrent).toBe(true);

    const rollbackResponse = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/rollback`,
      headers,
      payload: { releaseId: firstRelease.releaseId },
    });
    expect(rollbackResponse.statusCode).toBe(202);
    const rollbackBody = rollbackResponse.json() as { deploymentId: string; state: string };
    expect(rollbackBody.state).toBe("PLAN_READY");
    await approveDeployment(rollbackBody.deploymentId, firstRelease.manifestSha256);
    await executeAndWaitLive(rollbackBody.deploymentId);

    const releaseRows = await db.select().from(releases);
    const target = releaseRows.find((row) => row.releaseId === firstRelease.releaseId);
    const previous = releaseRows.find((row) => row.releaseId === releaseB?.releaseId);
    expect(target?.isCurrent).toBe(true);
    expect(previous?.isCurrent).toBe(false);

    const chainEntry = await readFileBytesAt(
      clientsFor(fork).publicClient,
      XLAYER_MAINNET.registries[0] as `0x${string}`,
      containerAddress,
      "index.html",
    );
    expect(sha256Hex(chainEntry.bytes)).toBe(entryASha);

    const [rollbackRow] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, rollbackBody.deploymentId))
      .limit(1);
    expect(rollbackRow?.state).toBe("LIVE");
    expect(rollbackRow?.rollbackTargetReleaseId).toBe(target?.id);
  }, 300_000);
});
