/**
 * Seed a BUILT deployment for an existing project without GitHub OIDC.
 * Used for the P2-10 mainnet canary when the Actions runner cannot reach the
 * local API. The artifact is a real tar; the worker's plan is still read-only.
 *
 *   tsx scripts/p2/seed-mainnet-deployment.ts <projectId> <commitSha>
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as tar from "tar";
import { eq } from "drizzle-orm";
import { createDatabase, containers, deployments, projects, users } from "@tapeci/database";
import { LocalObjectStore, objectKeyForSha256 } from "@tapeci/github";
import { sha256Hex } from "@tapeci/shared";
import { createDeploymentQueues, enqueueDeployment } from "@tapeci/queue";

const projectId = process.argv[2];
const commitSha = process.argv[3];
if (projectId === undefined || commitSha === undefined) throw new Error("usage: projectId commitSha");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:56379";
const objectDir = process.env.TAPECI_OBJECT_STORE_DIR ?? ".tapeci/objects";
const { db, pool } = createDatabase(databaseUrl);
const root = await mkdtemp(join(tmpdir(), "tapeci-mainnet-artifact-"));
try {
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), '<!doctype html><html><body><h1>TapeCI mainnet canary</h1><script src="./assets/app.js"></script></body></html>');
  await writeFile(join(root, "assets/app.js"), "console.log('tapeci mainnet canary');");
  const chunks: Buffer[] = [];
  for await (const chunk of tar.c({ cwd: root, portable: true }, ["index.html", "assets/app.js"])) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const sha = sha256Hex(new Uint8Array(bytes));
  const key = objectKeyForSha256(sha);
  await new LocalObjectStore(objectDir).put(key, new Uint8Array(bytes));

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (project === undefined) throw new Error("project not found");
  const [container] = await db.select().from(containers).where(eq(containers.id, project.containerId)).limit(1);
  if (container === undefined) throw new Error("container not found");
  const [user] = await db.select().from(users).where(eq(users.githubLogin, "novus77")).limit(1);
  const [deployment] = await db.insert(deployments).values({
    projectId: project.id,
    containerId: container.id,
    createdByUserId: user?.id ?? null,
    triggerKind: "manual",
    commitSha,
    state: "BUILT",
    stateVersion: 2,
    registryAddress: container.registryAddress,
    artifactStorageKey: key,
    artifactSha256: sha,
    sourceEventKey: `mainnet-canary:${randomUUID()}`,
  }).returning();
  if (deployment === undefined) throw new Error("deployment insert failed");
  const queues = createDeploymentQueues({ redisUrl });
  try {
    await enqueueDeployment(queues.plan, deployment.id);
  } finally {
    await queues.close();
  }
  console.log(JSON.stringify({ deploymentId: deployment.id, projectId, commitSha, artifactSha256: sha, key }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
  await pool.end();
}
