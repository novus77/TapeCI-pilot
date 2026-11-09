/**
 * Live-mode console smoke backend.
 *
 * Starts a real Fastify API against an ephemeral PostgreSQL database seeded with
 * one verified/live project. The web console is then built with
 * NEXT_PUBLIC_API_URL pointing here (see apps/web/playwright.live.config.ts).
 *
 * This exercises the production data path (DB -> Fastify -> server components)
 * instead of the mock fixture store. No chain writes are performed.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chainTransactions,
  containers,
  createDatabase,
  createTestDatabase,
  deploymentEvents,
  deployments,
  githubInstallationUsers,
  githubInstallations,
  migrateUp,
  projectMembers,
  projects,
  releaseFiles,
  releases,
  users,
} from "@tapeci/database";
import type { Hex } from "@tapeci/shared";
import { privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../../apps/api/src/app.js";
import type { ApiDeps } from "../../apps/api/src/deps.js";
import type { ApiEnv } from "../../apps/api/src/env.js";

const PORT = Number(process.env.TAPECI_LIVE_API_PORT ?? "8788");
const CONTAINER = "0x25b20d3ea6b207506340eab2eb0f45edc800f6b3" as Hex;
const REGISTRY = "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6" as Hex;
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const OWNER = privateKeyToAccount(OWNER_KEY).address;
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONTAINER_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const PLAN_READY_DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const COMMIT = "f".repeat(40);
const MANIFEST_SHA = `0x${"ab".repeat(32)}` as Hex;
const ENTRY_SHA = `0x${"cd".repeat(32)}` as Hex;

const testDb = await createTestDatabase();
await migrateUp(testDb.url);
const { db, pool } = createDatabase(testDb.url);
const objectStoreDir = await mkdtemp(join(tmpdir(), "tapeci-live-objects-"));

const [user] = await db
  .insert(users)
  .values({ githubUserId: 4242, githubLogin: "dev-user" })
  .returning();
const [installation] = await db
  .insert(githubInstallations)
  .values({ installationId: 4242, githubAccountId: 4242, accountLogin: "acme" })
  .returning();
if (user === undefined || installation === undefined) throw new Error("seed user/installation failed");

await db.insert(containers).values({
  id: CONTAINER_ID,
  chainId: 196,
  factoryAddress: "0x1f09daefa827f02cbb40967cc91b259763760761",
  processorIndex: 0,
  processorAddress: "0x839bdd6fa7a66416a609a735e11de5411b98574e",
  tokenId: "2",
  containerAddress: CONTAINER,
  registryAddress: REGISTRY,
  bindingAddress: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
  lastCheckedBlock: "73623612",
  lastObservedOwner: OWNER,
});
await db.insert(projects).values({
  id: PROJECT_ID,
  ownerUserId: user.id,
  githubInstallationId: installation.id,
  githubRepositoryId: 4242,
  repoFullName: "acme/live-site",
  defaultBranch: "main",
  containerId: CONTAINER_ID,
});
await db.insert(projectMembers).values({ projectId: PROJECT_ID, userId: user.id, role: "owner" });
await db
  .insert(githubInstallationUsers)
  .values({ installationId: installation.id, userId: user.id, role: "owner" });

const planJson = {
  schemaVersion: "tapeci.plan.v1",
  chainId: 196,
  container: CONTAINER,
  siteRegistry: REGISTRY,
  commitSha: COMMIT,
  releaseId: "r-live",
  artifactDigest: `0x${"12".repeat(32)}`,
  releaseManifestHash: MANIFEST_SHA,
  entryPath: "index.html",
  pinnedBlockNumber: "48214990",
  pinnedBlockHash: `0x${"34".repeat(32)}`,
  operators: ["okx", "drpc"],
  observedAt: "2026-10-19T09:00:00.000Z",
  files: [
    {
      path: "index.html",
      sourcePath: "index.html",
      action: "WRITE",
      reason: "entry replacement (controlled cutover)",
      size: 512,
      sha256: ENTRY_SHA,
      chunks: 1,
      contentType: "text/html; charset=utf-8",
    },
  ],
  totals: { files: 2, writes: 2, unchanged: 0, conflicts: 0, chunks: 2, bytes: 4096 },
  fees: {
    gasPriceWei: "20000000",
    estimatedGas: "1850000",
    estimatedCostWei: "37000000000000",
    marginBps: 2000,
    recommendedCapWei: "44400000000000",
    costCapWei: "50000000000000",
    withinBudget: true,
    overBudgetByWei: "0",
  },
  containerOwner: OWNER,
  containerOpened: true,
  signer: OWNER,
  signerIsHolder: true,
  signerBalanceWei: "1000000000000000000",
  sufficientBalance: true,
  blocked: false,
  blockedReasons: [],
  warnings: [],
};

await db.insert(deployments).values({
  id: DEPLOYMENT_ID,
  projectId: PROJECT_ID,
  containerId: CONTAINER_ID,
  triggerKind: "webhook",
  commitSha: COMMIT,
  state: "LIVE",
  stateVersion: 11,
  registryAddress: REGISTRY,
  artifactSha256: `0x${"56".repeat(32)}`,
  artifactStorageKey: "sha256/live.tar",
  manifestSha256: MANIFEST_SHA,
  planJson,
  estimatedCostWei: "37000000000000",
  approvedCostCapWei: "50000000000000",
  requestedAt: new Date("2026-10-19T09:00:00Z"),
  startedAt: new Date("2026-10-19T09:01:00Z"),
  finishedAt: new Date("2026-10-19T09:06:00Z"),
});
const approvalPlanJson = {
  ...planJson,
  commitSha: "e".repeat(40),
  releaseId: "r-approval",
  releaseManifestHash: `0x${"ba".repeat(32)}`,
  fees: {
    ...planJson.fees,
    recommendedCapWei: "50000000000000",
    costCapWei: null,
  },
};
await db.insert(deployments).values({
  id: PLAN_READY_DEPLOYMENT_ID,
  projectId: PROJECT_ID,
  containerId: CONTAINER_ID,
  triggerKind: "manual",
  commitSha: "e".repeat(40),
  state: "PLAN_READY",
  stateVersion: 5,
  registryAddress: REGISTRY,
  manifestSha256: `0x${"ba".repeat(32)}`,
  planJson: approvalPlanJson,
  requestedAt: new Date("2026-10-19T10:00:00Z"),
});

const timeline: Array<[string, string, string]> = [
  ["RECEIVED", "BUILDING", "webhook"],
  ["BUILDING", "BUILT", "worker"],
  ["BUILT", "PLAN_READY", "worker"],
  ["PLAN_READY", "APPROVED", "user"],
  ["APPROVED", "UPLOADING_ASSETS", "worker"],
  ["UPLOADING_ASSETS", "VERIFYING_RELEASE", "worker"],
  ["VERIFYING_RELEASE", "LIVE", "worker"],
];
for (let index = 0; index < timeline.length; index += 1) {
  const [oldState, newState, actorKind] = timeline[index] as [string, string, string];
  await db.insert(deploymentEvents).values({
    deploymentId: DEPLOYMENT_ID,
    oldState: oldState as typeof deploymentEvents.$inferInsert.oldState,
    newState: newState as typeof deploymentEvents.$inferInsert.newState,
    eventType: newState.toLowerCase(),
    actorKind,
    actorId: actorKind === "worker" ? "tapeci-worker" : actorKind,
    payload: {},
    createdAt: new Date(Date.parse("2026-10-19T09:00:00Z") + index * 60_000),
  });
}

const releaseFilesRows = await db
  .insert(releaseFiles)
  .values([
    {
      deploymentId: DEPLOYMENT_ID,
      targetPath: "index.html",
      sourceRelativePath: "index.html",
      sha256: ENTRY_SHA,
      byteSize: 512,
      chunkCount: 1,
      contentType: "text/html; charset=utf-8",
      state: "VERIFIED",
      lastConfirmedChunkIndex: 0,
      verifiedAt: new Date("2026-10-19T09:05:00Z"),
    },
    {
      deploymentId: DEPLOYMENT_ID,
      targetPath: "releases/r-live/assets/app.js",
      sourceRelativePath: "assets/app.js",
      sha256: `0x${"ef".repeat(32)}`,
      byteSize: 2048,
      chunkCount: 1,
      contentType: "text/javascript",
      state: "VERIFIED",
      lastConfirmedChunkIndex: 0,
      verifiedAt: new Date("2026-10-19T09:05:00Z"),
    },
  ])
  .returning();
const entryFile = releaseFilesRows[0];
if (entryFile === undefined) throw new Error("seed release files failed");

const verifyReport = {
  chainId: 196,
  container: CONTAINER,
  registry: REGISTRY,
  pinnedBlockNumber: 48214990,
  observedAt: "2026-10-19T09:05:00Z",
  completedAt: "2026-10-19T09:06:00Z",
  durationMs: 12000,
  nodeOperators: ["okx", "drpc"],
  registryImplementation: `0x${"78".repeat(20)}`,
  bindingImplementation: `0x${"9a".repeat(20)}`,
  status: "VERIFIED",
  paths: ["index.html", "releases/r-live/assets/app.js"],
  fallbackPath: "index.html",
  pin: { pinnedBlockNumber: 48214990, pinnedBlockHash: planJson.pinnedBlockHash },
  implementations: [],
  checks: [],
  disagreements: [],
  releaseStatus: "VERIFIED",
  releaseMatch: true,
  manifest: {
    chainId: 196,
    container: CONTAINER,
    commitSha: COMMIT,
    releaseId: "r-live",
    entryPath: "index.html",
    fallbackPath: "index.html",
    artifactDigest: planJson.artifactDigest,
    releaseManifestHash: MANIFEST_SHA,
    fileCount: 2,
    entrySingleTransactionEligible: true,
  },
  files: [
    {
      path: "index.html",
      sourcePath: "index.html",
      expectedSha256: ENTRY_SHA,
      expectedSize: 512,
      actualSha256: ENTRY_SHA,
      actualSize: 512,
      chainDeclaredSha256: ENTRY_SHA,
      chainDeclaredSize: 512,
      operators: ["okx", "drpc"],
      operatorsAgree: true,
      manifestDeclarationMatchesChain: true,
      matched: true,
    },
  ],
  journal: {
    checked: true,
    deploymentId: DEPLOYMENT_ID,
    complete: true,
    verifiedFilesMatch: true,
    transactionsOk: true,
    allMinedBeforePin: true,
    entryWrittenLast: true,
    transactionCount: 3,
    totalGasUsed: "1200000",
    issues: [],
  },
  finality: {
    pinnedBlockNumber: 48214990,
    safeBlockNumber: 48214978,
    finalizedBlockNumber: 48214950,
    pinnedBlockIsSafe: true,
    pinnedBlockIsFinalized: true,
  },
  warnings: [],
};

await db.insert(releases).values({
  projectId: PROJECT_ID,
  deploymentId: DEPLOYMENT_ID,
  releaseId: "r-live",
  commitSha: COMMIT,
  manifestSha256: MANIFEST_SHA,
  entrySha256: ENTRY_SHA,
  entryPath: "index.html",
  verifyReport,
  verifiedBlockNumber: "48214990",
  isCurrent: true,
});

await db.insert(chainTransactions).values([
  {
    deploymentId: DEPLOYMENT_ID,
    releaseFileId: releaseFilesRows[1]?.id ?? null,
    chainId: 196,
    signerAddress: OWNER,
    toAddress: REGISTRY,
    operation: "putFile",
    operationFingerprint: `0x${"21".repeat(32)}`,
    nonce: "40",
    gasUsed: "640000",
    txHash: `0x${"31".repeat(32)}`,
    state: "INCLUDED",
    receiptBlockNumber: "48214988",
    receiptBlockHash: `0x${"41".repeat(32)}`,
  },
  {
    deploymentId: DEPLOYMENT_ID,
    releaseFileId: entryFile.id,
    chainId: 196,
    signerAddress: OWNER,
    toAddress: REGISTRY,
    operation: "putFile",
    operationFingerprint: `0x${"22".repeat(32)}`,
    nonce: "41",
    gasUsed: "98000",
    txHash: `0x${"32".repeat(32)}`,
    state: "INCLUDED",
    receiptBlockNumber: "48214989",
    receiptBlockHash: `0x${"42".repeat(32)}`,
  },
]);

const env: ApiEnv = {
  databaseUrl: testDb.url,
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:56379",
  port: PORT,
  host: "127.0.0.1",
  sessionSecret: "live-mode-smoke-secret-123456",
  devAuth: true,
  objectStoreDir,
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: "live-mode-webhook-secret",
  githubOidcAudience: "tapeci-artifact-upload",
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
  operatorPrivateKey: null,
  writeRpcUrl: null,
  journalDir: join(objectStoreDir, "journal"),
  githubAppSlug: null,
  githubOAuthClientId: null,
  githubOAuthClientSecret: null,
  githubOAuthBaseUrl: "https://github.com",
  githubApiBaseUrl: "https://api.github.com",
  publicApiUrl: "http://127.0.0.1:8787",
  webUrl: "http://127.0.0.1:3000",
  sessionTtlSeconds: 604_800,
};
const deps: ApiDeps = {
  db,
  env,
  resolveContainer: async () => ({
    address: CONTAINER,
    factory: "0x1f09daefa827f02cbb40967cc91b259763760761",
    opener: "0x536add8f30f03b69f6fbf29d425a816a0dc50106",
    registry: REGISTRY,
    binding: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
    processorIndex: 0,
    processor: "0x839bdd6fa7a66416a609a735e11de5411b98574e",
    tokenId: "2",
    owner: OWNER,
    opened: true,
  }),
};
const app = buildApp(deps);
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`live console API http://127.0.0.1:${PORT} project=${PROJECT_ID} deployment=${DEPLOYMENT_ID}`);

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await app.close();
  await pool.end();
  await testDb.drop();
};
process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
