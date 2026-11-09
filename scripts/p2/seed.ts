/**
 * Seed the local TapeCI database for the API/web console.
 * Idempotent for the demo project: re-running replaces its deployments.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  approvals,
  chainTransactions,
  containers,
  createDatabase,
  deploymentEvents,
  deployments,
  githubInstallationUsers,
  githubInstallations,
  projectMembers,
  projects,
  releaseFiles,
  releases,
  users,
} from "@tapeci/database";
import type { Hex } from "@tapeci/shared";

const CONTAINER = "0x25b20d3ea6b207506340eab2eb0f45edc800f6b3" as Hex;
const REGISTRY = "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6" as Hex;

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const { db, pool } = createDatabase(databaseUrl);
try {
  const [user] = await db
    .insert(users)
    .values({ githubUserId: 4242, githubLogin: "dev-user" })
    .onConflictDoUpdate({ target: users.githubUserId, set: { githubLogin: "dev-user" } })
    .returning();
  if (user === undefined) throw new Error("could not seed user");

  const [installation] = await db
    .insert(githubInstallations)
    .values({ installationId: 9001, githubAccountId: 9001, accountLogin: "acme" })
    .onConflictDoUpdate({
      target: githubInstallations.installationId,
      set: { accountLogin: "acme", updatedAt: new Date() },
    })
    .returning();
  if (installation === undefined) throw new Error("could not seed installation");

  const [container] = await db
    .insert(containers)
    .values({
      chainId: 196,
      factoryAddress: "0x1f09daefa827f02cbb40967cc91b259763760761",
      processorIndex: 0,
      processorAddress: "0x839bdd6fa7a66416a609a735e11de5411b98574e",
      tokenId: "2",
      containerAddress: CONTAINER,
      registryAddress: REGISTRY,
      bindingAddress: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
      lastCheckedBlock: "73623612",
      lastObservedOwner: "0x571d447f4f24688ec35ccf07f1d6993655f6af15",
    })
    .onConflictDoUpdate({
      target: [containers.chainId, containers.containerAddress],
      set: { updatedAt: new Date() },
    })
    .returning();
  if (container === undefined) throw new Error("could not seed container");

  const [existing] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.githubRepositoryId, 9001),
        eq(projects.defaultBranch, "main"),
        eq(projects.containerId, container.id),
      ),
    )
    .limit(1);
  let project = existing;
  if (project === undefined) {
    const [created] = await db
      .insert(projects)
      .values({
        ownerUserId: user.id,
        githubInstallationId: installation.id,
        githubRepositoryId: 9001,
        repoFullName: "acme/demo-site",
        defaultBranch: "main",
        containerId: container.id,
      })
      .returning();
    project = created;
  }
  if (project === undefined) throw new Error("could not seed project");
  await db
    .insert(projectMembers)
    .values({ projectId: project.id, userId: user.id, role: "owner" })
    .onConflictDoNothing();
  await db
    .insert(githubInstallationUsers)
    .values({ installationId: installation.id, userId: user.id, role: "owner" })
    .onConflictDoNothing();

  const previous = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(eq(deployments.projectId, project.id));
  const ids = previous.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(approvals).where(inArray(approvals.deploymentId, ids));
    await db.delete(chainTransactions).where(inArray(chainTransactions.deploymentId, ids));
    await db.delete(releases).where(inArray(releases.deploymentId, ids));
    await db.delete(deploymentEvents).where(inArray(deploymentEvents.deploymentId, ids));
    await db.delete(releaseFiles).where(inArray(releaseFiles.deploymentId, ids));
    await db.delete(deployments).where(inArray(deployments.id, ids));
  }

  const now = Date.now();
  const commit = (char: string) => char.repeat(40);
  const states = [
    { state: "BUILD_FAILED" as const, commit: commit("1"), trigger: "webhook" },
    { state: "BUILT" as const, commit: commit("2"), trigger: "webhook" },
    { state: "VERIFYING_RELEASE" as const, commit: commit("3"), trigger: "manual" },
    { state: "LIVE" as const, commit: commit("4"), trigger: "manual" },
  ];
  const createdDeployments = [];
  for (let index = 0; index < states.length; index += 1) {
    const item = states[index];
    if (item === undefined) continue;
    const created = now - (states.length - index) * 3_600_000;
    const [deployment] = await db
      .insert(deployments)
      .values({
        projectId: project.id,
        containerId: container.id,
        triggerKind: item.trigger,
        commitSha: item.commit,
        state: item.state,
        stateVersion: item.state === "LIVE" ? 11 : index + 2,
        registryAddress: REGISTRY,
        manifestSha256: index >= 1 ? `0x${String(index + 1).repeat(64).slice(0, 64)}` : null,
        planJson: index >= 1 ? { schemaVersion: "tapeci.plan.v1", writes: 3, chunks: 4 } : null,
        requestedAt: new Date(created),
        finishedAt: item.state === "LIVE" || item.state === "BUILD_FAILED" ? new Date(created + 60_000) : null,
      })
      .returning();
    if (deployment === undefined) continue;
    createdDeployments.push(deployment);
    const timeline: Array<[string, string]> =
      item.state === "BUILD_FAILED"
        ? [["RECEIVED", "BUILDING"], ["BUILDING", "BUILD_FAILED"]]
        : item.state === "BUILT"
          ? [["RECEIVED", "BUILDING"], ["BUILDING", "BUILT"]]
          : item.state === "VERIFYING_RELEASE"
            ? [
                ["RECEIVED", "BUILDING"],
                ["BUILDING", "BUILT"],
                ["BUILT", "PLAN_READY"],
                ["PLAN_READY", "APPROVED"],
                ["APPROVED", "VERIFYING_RELEASE"],
              ]
            : [
                ["RECEIVED", "BUILDING"],
                ["BUILDING", "BUILT"],
                ["BUILT", "PLAN_READY"],
                ["PLAN_READY", "APPROVED"],
                ["APPROVED", "UPLOADING_ASSETS"],
                ["UPLOADING_ASSETS", "SWITCHING_ENTRY"],
                ["SWITCHING_ENTRY", "VERIFYING_RELEASE"],
                ["VERIFYING_RELEASE", "LIVE"],
              ];
    for (let step = 0; step < timeline.length; step += 1) {
      const [oldState, newState] = timeline[step] as [string, string];
      await db.insert(deploymentEvents).values({
        deploymentId: deployment.id,
        oldState: oldState as typeof deploymentEvents.$inferInsert.oldState,
        newState: newState as typeof deploymentEvents.$inferInsert.newState,
        eventType: newState.toLowerCase(),
        actorKind: step < 2 ? "webhook" : "worker",
        actorId: step < 2 ? "github" : "deploy-worker",
        payload: { step },
        createdAt: new Date(created + step * 5_000),
      });
    }
    if (item.state === "LIVE" || item.state === "VERIFYING_RELEASE") {
      await db.insert(releases).values({
        projectId: project.id,
        deploymentId: deployment.id,
        releaseId: `r-${item.commit.slice(0, 12)}-${item.commit.slice(12, 20)}`,
        commitSha: item.commit,
        manifestSha256: `0x${"ab".repeat(32)}`,
        entrySha256: `0x${"cd".repeat(32)}`,
        entryPath: "index.html",
        verifyReport: { status: "VERIFIED", releaseMatch: true, nodeOperators: ["okx", "drpc"] },
        verifiedBlockNumber: "73623612",
        isCurrent: item.state === "LIVE",
      });
      await db.insert(releaseFiles).values({
        deploymentId: deployment.id,
        targetPath: "index.html",
        sourceRelativePath: "index.html",
        sha256: `0x${"cd".repeat(32)}`,
        byteSize: 512,
        chunkCount: 1,
        contentType: "text/html; charset=utf-8",
        state: "VERIFIED",
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        userId: user.id,
        installationId: installation.id,
        containerId: container.id,
        projectId: project.id,
        deployments: createdDeployments.map((deployment) => ({
          id: deployment.id,
          state: deployment.state,
          commitSha: deployment.commitSha,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
