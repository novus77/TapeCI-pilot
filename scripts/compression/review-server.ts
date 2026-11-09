/** Local UI integration fixture: real API/database/storage, no RPC or chain writes.
 * The plan queue stops after artifact preparation; this is not a cost-plan simulation.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c } from "tar";
import { containers, createDatabase, createTestDatabase, deployments, githubInstallations, migrateUp, projectMembers, projects, users } from "@tapeci/database";
import { LocalObjectStore, objectKeyForSha256 } from "@tapeci/github";
import { sha256Hex } from "@tapeci/shared";
import { buildApp } from "../../apps/api/src/app.js";
import { loadEnv } from "../../apps/api/src/env.js";
import { createWorkerRuntime, loadDeploymentArtifact } from "../../apps/api/src/worker/runtime.js";

const database = await createTestDatabase();
await migrateUp(database.url);
const handle = createDatabase(database.url);
const root = await mkdtemp(join(tmpdir(), "tapeci-compression-review-"));
const store = new LocalObjectStore(join(root, "objects"));
const container = "0x1111111111111111111111111111111111111111";
const registry = "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6";
const env = loadEnv({ DATABASE_URL: database.url, SESSION_SIGNING_SECRET: "compression-local-fixture-only-secret", TAPECI_DEV_AUTH: "1", OBJECT_STORE_DIR: join(root, "objects"), TAPECI_COMPRESSION_GATEWAYS_JSON: JSON.stringify([{ id: "local-fixture", origin: "http://127.0.0.1:3192", chainId: 196, siteRegistry: registry, container, adapterSha256: `0x${"ab".repeat(32)}`, serviceFeeWei: "0" }]) });
const [user] = await handle.db.insert(users).values({ githubUserId: 82031, githubLogin: "compression-review" }).returning();
const [installation] = await handle.db.insert(githubInstallations).values({ installationId: 82031, githubAccountId: 82031, accountLogin: "compression-review" }).returning();
const [target] = await handle.db.insert(containers).values({ chainId: 196, factoryAddress: "0x1f09daefa827f02cbb40967cc91b259763760761", processorIndex: 0, processorAddress: "0x2222222222222222222222222222222222222222", tokenId: "1", containerAddress: container, registryAddress: registry, bindingAddress: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9", lastObservedOwner: "0x3333333333333333333333333333333333333333" }).returning();
const [project] = await handle.db.insert(projects).values({ ownerUserId: user!.id, githubInstallationId: installation!.id, githubRepositoryId: 82031, repoFullName: "fixture/compression-review", defaultBranch: "main", containerId: target!.id }).returning();
await handle.db.insert(projectMembers).values({ projectId: project!.id, userId: user!.id, role: "owner" });
await writeFile(join(root, "index.html"), '<html><script src="app.js"></script></html>');
await writeFile(join(root, "app.js"), 'console.log("compression-review");'.repeat(200));
await c({ cwd: root, file: join(root, "source.tar"), portable: true, noMtime: true }, ["index.html", "app.js"]);
const archive = await readFile(join(root, "source.tar"));
const key = objectKeyForSha256(sha256Hex(archive));
await store.put(key, archive);
await handle.db.insert(deployments).values({ id: "33333333-3333-4333-8333-333333333333", projectId: project!.id, containerId: target!.id, triggerKind: "manual", commitSha: "a".repeat(40), state: "PLAN_READY", registryAddress: registry, artifactStorageKey: key, artifactSha256: sha256Hex(archive) });
await handle.db.insert(deployments).values({ id: "44444444-4444-4444-8444-444444444444", projectId: project!.id, containerId: target!.id, triggerKind: "manual", commitSha: "b".repeat(40), state: "PLAN_READY", registryAddress: registry, artifactStorageKey: key, artifactSha256: sha256Hex(archive), preparation_request: { schemaVersion: "tapeci.preparation.v1", mode: "gzip-whole", spaFallback: false, gatewayId: "removed-gateway" } });
const runtime = createWorkerRuntime({ db: handle.db, env, objectStore: store });
const app = buildApp({ db: handle.db, env, objectStore: store, enqueuePlan: async id => { await loadDeploymentArtifact(runtime, id); } });
await app.listen({ host: "127.0.0.1", port: 8793 });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await handle.pool.end();
  await database.drop();
  await rm(root, { recursive: true, force: true });
}
process.on("SIGTERM", () => void close().then(() => process.exit(0)));
process.on("SIGINT", () => void close().then(() => process.exit(0)));
