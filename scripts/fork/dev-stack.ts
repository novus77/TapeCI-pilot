/**
 * Fork-mode "pseudo production" stack:
 *  - Anvil fork of X Layer 196 + a freshly opened container
 *  - real Fastify API on :8787 (dev auth) + real BullMQ worker (fork wallet)
 *  - ephemeral Postgres, content-addressed artifact store
 *  - project created through the API, deployment through a signed push webhook,
 *    artifact stored directly (no GitHub OIDC in fork mode), plan -> approve
 *    (seeded because the fork owner has no private key) -> execute -> verify LIVE
 *
 * The web console can then be started separately (see the printed command).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { eq } from "drizzle-orm";
import { XLAYER_MAINNET } from "@tapeci/config";
import {
  approvals,
  containers,
  createDatabase,
  createTestDatabase,
  deployments,
  githubInstallations,
  migrateUp,
} from "@tapeci/database";
import {
  computeWebhookSignature,
  LocalObjectStore,
  objectKeyForSha256,
} from "@tapeci/github";
import {
  createDeploymentQueues,
  createOperatorSession,
  enqueueDeployment,
  getDeployment,
  startWorkers,
  stopWorkers,
  transitionDeployment,
} from "@tapeci/queue";
import { sha256Hex } from "@tapeci/shared";
import { buildApp } from "../../apps/api/src/app.js";
import type { ApiDeps, ResolvedContainer } from "../../apps/api/src/deps.js";
import type { ApiEnv } from "../../apps/api/src/env.js";
import { createWorkerHandlers, createWorkerRuntime } from "../../apps/api/src/worker/runtime.js";
import { startAnvilFork } from "./anvil.js";
import { clientsFor, fundAndImpersonate, ONE_OKB, openNewContainer, walletFor } from "./support.js";

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "fork-dev-webhook-secret";
const COMMIT = "f".repeat(40);
const REPO_FULL_NAME = process.env.TAPECI_REPO_FULL_NAME ?? "acme/fork-site";
const REPO_ID = Number(process.env.TAPECI_REPO_ID ?? "4242");
const REPO_OWNER = REPO_FULL_NAME.split("/")[0] ?? "acme";
const REPO_OWNER_ID = Number(process.env.TAPECI_REPO_OWNER_ID ?? "77");
const INSTALLATION_ID = Number(process.env.TAPECI_INSTALLATION_ID ?? "4242");
const APP_DIR = await mkdtemp(join(tmpdir(), "tapeci-fork-stack-"));
const JOURNAL_DIR = join(APP_DIR, "journal");
const OBJECT_DIR = join(APP_DIR, "objects");
await mkdir(JOURNAL_DIR, { recursive: true });
await mkdir(OBJECT_DIR, { recursive: true });

const fork = await startAnvilFork({ port: Number(process.env.TAPECI_FORK_PORT ?? "8548"), offset: 60 });
const clients = clientsFor(fork);
const opened = await openNewContainer({
  fork,
  client: clients.publicClient,
  testClient: clients.testClient,
  opener: "0x1000000000000000000000000000000000000004",
});
await fundAndImpersonate(clients.testClient, opened.owner, 100n * ONE_OKB);
const planPin = await clients.publicClient.getBlockNumber();

const testDatabase = await createTestDatabase();
await migrateUp(testDatabase.url);
const { db, pool } = createDatabase(testDatabase.url);

const localOidc = process.env.TAPECI_OIDC_LOCAL !== "0";
const oidcKeys = localOidc ? await generateKeyPair("RS256", { extractable: true }) : null;
const oidcJwk = oidcKeys === null ? null : { ...(await exportJWK(oidcKeys.publicKey)), kid: "fork-oidc-key", alg: "RS256", use: "sig" };
let jwksServer: ReturnType<typeof createServer> | null = null;
let jwksUrl: string | null = null;
if (localOidc) {
  jwksServer = createServer((request, response) => {
    if (request.url === "/jwks") {
      const body = JSON.stringify({ keys: [oidcJwk] });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    jwksServer!.once("error", reject);
    jwksServer!.listen(8791, "127.0.0.1", () => resolve());
  });
  jwksUrl = "http://127.0.0.1:8791/jwks";
}

const env: ApiEnv = {
  databaseUrl: testDatabase.url,
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:56379",
  port: 8787,
  host: "127.0.0.1",
  sessionSecret: "fork-dev-session-secret-123456",
  devAuth: true,
  objectStoreDir: OBJECT_DIR,
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: WEBHOOK_SECRET,
  githubOidcAudience: "tapeci-artifact-upload",
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
  githubOidcJwksUrl: jwksUrl,
  githubAppSlug: null,
  githubOAuthClientId: null,
  githubOAuthClientSecret: null,
  githubOAuthBaseUrl: "https://github.com",
  githubApiBaseUrl: "https://api.github.com",
  publicApiUrl: process.env.TAPECI_PUBLIC_API_URL ?? "http://127.0.0.1:8787",
  webUrl: "http://127.0.0.1:3000",
  sessionTtlSeconds: 3600,
  operatorPrivateKey: null,
  writeRpcUrl: null,
  journalDir: JOURNAL_DIR,
  cookieDomain: null,
  maxGasPriceWei: null,
  metricsToken: null,
  rateLimitPerMinute: 600,
  rateLimitDisabled: false,
  auditDisabled: true,
};

const resolved: ResolvedContainer = {
  address: opened.container,
  factory: XLAYER_MAINNET.factory,
  opener: XLAYER_MAINNET.opener,
  registry: XLAYER_MAINNET.registries[0] as `0x${string}`,
  binding: XLAYER_MAINNET.binding,
  processorIndex: opened.fixture.processorIndex,
  processor: opened.fixture.processor,
  tokenId: opened.fixture.tokenId.toString(),
  owner: opened.owner,
  opened: true,
};

const prefix = `tapeci-fork-stack-${randomUUID()}`;
const queues = createDeploymentQueues({ redisUrl: env.redisUrl, prefix });
const runtime = createWorkerRuntime({
  db,
  env,
  operators: [
    {
      operator: "fork",
      url: fork.url,
      endpoint: { url: fork.url, operator: "okx", maxBatch: 10 },
      client: clients.publicClient,
    },
  ],
  wallet: walletFor(fork.url, opened.owner),
  signer: opened.owner,
  journalDir: JOURNAL_DIR,
  objectStoreDir: OBJECT_DIR,
  allowSingleOperator: true,
  planPinnedBlockNumber: planPin,
  enqueueVerify: async (id) => {
    await enqueueDeployment(queues.verify, id);
  },
});
const workers = await startWorkers({
  db,
  redisUrl: env.redisUrl,
  prefix,
  handlers: createWorkerHandlers(runtime),
  concurrency: { plan: 1, deploy: 1, verify: 1 },
});

const deps: ApiDeps = {
  db,
  env,
  resolveContainer: async () => resolved,
  enqueuePlan: async (id) => {
    await enqueueDeployment(queues.plan, id);
  },
  enqueueDeployment: async (id) => {
    await enqueueDeployment(queues.deploy, id);
  },
};
const app = buildApp(deps);
await app.listen({ port: env.port, host: env.host });

const devHeaders = {
  "x-tapeci-github-login": "dev-user",
  "x-tapeci-github-user-id": "4242",
  "content-type": "application/json",
};
await app.inject({ method: "GET", url: "/v1/me", headers: devHeaders });
const [installation] = await db
  .insert(githubInstallations)
  .values({ installationId: INSTALLATION_ID, githubAccountId: REPO_OWNER_ID, accountLogin: REPO_OWNER })
  .returning();
if (installation === undefined) throw new Error("installation seed failed");

const projectResponse = await app.inject({
  method: "POST",
  url: "/v1/projects",
  headers: devHeaders,
  payload: {
    repoFullName: REPO_FULL_NAME,
    githubRepositoryId: REPO_ID,
    defaultBranch: "main",
    containerAddress: opened.container,
    githubInstallationId: installation.id,
  },
});
if (projectResponse.statusCode !== 201) {
  throw new Error(`project creation failed: ${projectResponse.statusCode} ${projectResponse.body}`);
}
const project = (projectResponse.json() as { project: { id: string } }).project;

const payload = JSON.stringify({
  ref: "refs/heads/main",
  after: COMMIT,
  repository: { id: REPO_ID, full_name: REPO_FULL_NAME, owner: { login: REPO_OWNER } },
  installation: { id: INSTALLATION_ID },
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
const deploymentId = (webhook.json() as { deploymentId: string }).deploymentId;

// Store the artifact tar directly (fork mode has no GitHub OIDC exchange) and
// move the deployment to BUILT so the plan worker can pick it up.
const tarRoot = await mkdtemp(join(APP_DIR, "src-"));
await mkdir(join(tarRoot, "assets"), { recursive: true });
await writeFile(join(tarRoot, "index.html"), '<!doctype html><html><body><h1>Fork stack</h1><script src="./assets/app.js"></script></body></html>');
await writeFile(join(tarRoot, "assets/app.js"), "console.log('fork dev stack');");
const chunks: Buffer[] = [];
for await (const chunk of tar.c({ cwd: tarRoot, portable: true }, ["index.html", "assets/app.js"])) {
  chunks.push(Buffer.from(chunk));
}
const tarBytes = Buffer.concat(chunks);
const sha = sha256Hex(new Uint8Array(tarBytes));
const key = objectKeyForSha256(sha);
await new LocalObjectStore(OBJECT_DIR).put(key, new Uint8Array(tarBytes));
await db
  .update(deployments)
  .set({ artifactStorageKey: key, artifactSha256: sha, state: "BUILT", stateVersion: 2 })
  .where(eq(deployments.id, deploymentId));

// enqueue plan via the real API enqueue function
await deps.enqueuePlan?.(deploymentId);

const waitFor = async <T>(fn: () => Promise<T | null>, timeoutMs = 120_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for fork stack state");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};
const planned = await waitFor(async () => {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, deploymentId)).limit(1);
  return row?.state === "PLAN_READY" ? row : null;
});
const manifestSha = planned.manifestSha256;
if (manifestSha === null) throw new Error("plan has no manifest hash");
const [container] = await db
  .select()
  .from(containers)
  .where(eq(containers.containerAddress, opened.container.toLowerCase()))
  .limit(1);
if (container === undefined) throw new Error("container row missing");
const [approval] = await db
  .insert(approvals)
  .values({
    deploymentId,
    signerAddress: opened.owner,
    chainId: 196,
    manifestSha256: manifestSha,
    approvalDigest: `0x${randomBytes(32).toString("hex")}`,
    signature: "0xfork",
    approvedCostCapWei: ONE_OKB.toString(),
    nonce: `fork-dev-${deploymentId}`,
    expiresAt: new Date(Date.now() + 3_600_000),
  })
  .returning();
if (approval === undefined) throw new Error("approval seed failed");
await createOperatorSession(db, {
  containerId: container.id,
  signerAddress: opened.owner,
  approvalId: approval.id,
  ttlSeconds: 3_600,
});
await db.update(deployments).set({ approvedCostCapWei: ONE_OKB.toString() }).where(eq(deployments.id, deploymentId));
let current = await getDeployment(db, deploymentId);
if (current === null) throw new Error("deployment missing");
current = await transitionDeployment(db, {
  deploymentId,
  expectedVersion: current.stateVersion,
  toState: "AWAITING_APPROVAL",
  eventType: "approval_requested",
  actorKind: "user",
});
await transitionDeployment(db, {
  deploymentId,
  expectedVersion: current.stateVersion,
  toState: "APPROVED",
  eventType: "approval_recorded",
  actorKind: "user",
});
const executed = await app.inject({ method: "POST", url: `/v1/deployments/${deploymentId}/execute`, headers: devHeaders });
if (executed.statusCode !== 202) throw new Error(`execute failed: ${executed.statusCode} ${executed.body}`);
const live = await waitFor(async () => {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, deploymentId)).limit(1);
  return row?.state === "LIVE" ? row : null;
}, 180_000);

// --- local OIDC -> build token -> artifact upload -------------------------
let oidcSummary: Record<string, string> | null = null;
if (localOidc) {
const OIDC_COMMIT = "e".repeat(40);
const oidcPayload = JSON.stringify({
  ref: "refs/heads/main",
  after: OIDC_COMMIT,
  repository: { id: REPO_ID, full_name: REPO_FULL_NAME, owner: { login: REPO_OWNER } },
  installation: { id: INSTALLATION_ID },
});
const oidcWebhook = await app.inject({
  method: "POST",
  url: "/v1/github/webhook",
  headers: {
    "content-type": "application/json",
    "x-github-delivery": `fork-oidc-${randomUUID()}`,
    "x-github-event": "push",
    "x-hub-signature-256": computeWebhookSignature(WEBHOOK_SECRET, oidcPayload),
  },
  payload: oidcPayload,
});
const oidcDeploymentId = (oidcWebhook.json() as { deploymentId: string }).deploymentId;
const now = Math.floor(Date.now() / 1000);
const oidcToken = await new SignJWT({
  repository: REPO_FULL_NAME,
  repository_id: REPO_ID,
  repository_owner: REPO_OWNER,
  repository_owner_id: REPO_OWNER_ID,
  ref: "refs/heads/main",
  sha: OIDC_COMMIT,
  workflow_ref: `${REPO_FULL_NAME}/.github/workflows/tapeci.yml@refs/heads/main`,
  event_name: "push",
  run_id: "123456789",
})
  .setProtectedHeader({ alg: "RS256", kid: "fork-oidc-key" })
  .setIssuer(env.githubOidcIssuer)
  .setAudience(env.githubOidcAudience)
  .setIssuedAt(now)
  .setNotBefore(now - 5)
  .setExpirationTime(now + 300)
  .sign(oidcKeys!.privateKey);
const buildTokenResponse = await app.inject({
  method: "POST",
  url: "/v1/builds/token",
  headers: { authorization: `Bearer ${oidcToken}` },
});
if (buildTokenResponse.statusCode !== 200) {
  throw new Error(`build token failed: ${buildTokenResponse.statusCode} ${buildTokenResponse.body}`);
}
const buildToken = (buildTokenResponse.json() as { token: string }).token;
const oidcTarRoot = await mkdtemp(join(APP_DIR, "oidc-src-"));
await mkdir(join(oidcTarRoot, "assets"), { recursive: true });
await writeFile(join(oidcTarRoot, "index.html"), '<!doctype html><html><body><h1>OIDC artifact</h1></body></html>');
await writeFile(join(oidcTarRoot, "assets/app.js"), "console.log('oidc upload');");
const oidcChunks: Buffer[] = [];
for await (const chunk of tar.c({ cwd: oidcTarRoot, portable: true }, ["index.html", "assets/app.js"])) {
  oidcChunks.push(Buffer.from(chunk));
}
const oidcUpload = await app.inject({
  method: "POST",
  url: "/v1/builds/artifacts",
  headers: { authorization: `Bearer ${buildToken}`, "content-type": "application/x-tar" },
  payload: Buffer.concat(oidcChunks),
});
if (oidcUpload.statusCode !== 200) {
  throw new Error(`artifact upload failed: ${oidcUpload.statusCode} ${oidcUpload.body}`);
}
const oidcPlanned = await waitFor(async () => {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, oidcDeploymentId)).limit(1);
  return row?.state === "PLAN_READY" ? row : null;
});
oidcSummary = {
  oidcDeploymentId,
  oidcState: oidcPlanned.state,
  oidcBuildToken: "issued",
  oidcUpload: "ok",
};

}
console.log(
  JSON.stringify(
    {
      ready: true,
      api: "http://127.0.0.1:8787",
      web: "http://127.0.0.1:3000",
      forkUrl: fork.url,
      container: opened.container,
      owner: opened.owner,
      projectId: project.id,
      deploymentId,
      state: live.state,
      ...(oidcSummary ?? {}),
      webCommand:
        "NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 TAPECI_DEV_GITHUB_LOGIN=dev-user TAPECI_DEV_GITHUB_USER_ID=4242 corepack pnpm web:dev",
    },
    null,
    2,
  ),
);
console.log(`FORK_STACK_READY project=${project.id} deployment=${deploymentId}`);

const shutdown = async (): Promise<void> => {
  await app.close();
  await stopWorkers(workers);
  await queues.close();
  await pool.end();
  await testDatabase.drop();
  if (jwksServer !== null) {
    await new Promise<void>((resolve) => jwksServer!.close(() => resolve()));
  }
  await fork.stop();
  await rm(APP_DIR, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await new Promise<void>(() => undefined);
