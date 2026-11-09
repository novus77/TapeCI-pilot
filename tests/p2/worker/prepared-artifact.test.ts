import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactUploads, containers, createDatabase, createTestDatabase, databaseAvailable, deployments, githubInstallations, migrateUp, projectMembers, projects, releases, users } from "@tapeci/database";
import { LocalObjectStore, objectKeyForSha256 } from "@tapeci/github";
import { sha256Hex } from "@tapeci/shared";
import { buildApp } from "../../../apps/api/src/app.js";
import { loadEnv } from "../../../apps/api/src/env.js";
import { createWorkerRuntime, loadDeploymentArtifact } from "../../../apps/api/src/worker/runtime.js";
import { freezePreparedArtifact } from "../../../apps/api/src/worker/prepared-artifact.js";
import { parsePreparationRequest } from "../../../apps/api/src/worker/preparation-policy.js";

const available = await databaseAvailable();
const REGISTRY = "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6";
const CONTAINER = "0x1111111111111111111111111111111111111111";

describe.skipIf(!available)("worker prepared artifact persistence", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let root: string;
  let projectId: string;
  let containerId: string;
  let store: LocalObjectStore;
  let archive: Uint8Array;
  let sourceKey: string;
  beforeAll(async () => {
    database = await createTestDatabase();
    await migrateUp(database.url);
    handle = createDatabase(database.url);
    root = await mkdtemp(join(tmpdir(), "tapeci-worker-prepared-"));
    store = new LocalObjectStore(join(root, "objects"));
    const [user] = await handle.db.insert(users).values({ githubUserId: 82001, githubLogin: "prepared-fixture" }).returning();
    const [installation] = await handle.db.insert(githubInstallations).values({ installationId: 82001, githubAccountId: 82001, accountLogin: "prepared-fixture" }).returning();
    const [container] = await handle.db.insert(containers).values({ chainId: 196, factoryAddress: "0x1f09daefa827f02cbb40967cc91b259763760761", processorIndex: 0, processorAddress: "0x2222222222222222222222222222222222222222", tokenId: "1", containerAddress: CONTAINER, registryAddress: REGISTRY, bindingAddress: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9", lastObservedOwner: "0x3333333333333333333333333333333333333333" }).returning();
    containerId = container!.id;
    const [project] = await handle.db.insert(projects).values({ ownerUserId: user!.id, githubInstallationId: installation!.id, githubRepositoryId: 82001, repoFullName: "fixture/prepared", defaultBranch: "main", containerId }).returning();
    projectId = project!.id;
    await handle.db.insert(projectMembers).values({ projectId, userId: user!.id, role: "owner" });
    await writeFile(join(root, "index.html"), '<html><script src="app.js"></script></html>');
    await writeFile(join(root, "app.js"), 'console.log("fixed");'.repeat(500));
    const { c } = await import("tar");
    await c({ cwd: root, file: join(root, "source.tar"), portable: true, noMtime: true }, ["index.html", "app.js"]);
    archive = await readFile(join(root, "source.tar"));
    sourceKey = objectKeyForSha256(sha256Hex(archive));
  }, 60_000);
  afterAll(async () => { await handle?.pool.end(); await database?.drop(); if (root) await rm(root, { recursive: true, force: true }); });

  function runtime(qualified = false) {
    return createWorkerRuntime({ db: handle.db, env: loadEnv({ DATABASE_URL: database.url, SESSION_SIGNING_SECRET: "prepared-fixture-signing-secret-value", OBJECT_STORE_DIR: join(root, "objects") }), objectStore: store, compressionGateways: qualified ? [{ id: "fixture", origin: "http://127.0.0.1:19001", chainId: 196, siteRegistry: REGISTRY, container: CONTAINER, adapterSha256: `0x${"ab".repeat(32)}`, serviceFeeWei: "0" }] : [] });
  }
  async function deployment(compressed = false) {
    await store.put(sourceKey, archive);
    const [row] = await handle.db.insert(deployments).values({ projectId, containerId, triggerKind: "manual", commitSha: "a".repeat(40), state: "BUILT", registryAddress: REGISTRY, artifactStorageKey: sourceKey, artifactSha256: sha256Hex(archive), preparation_request: compressed ? { schemaVersion: "tapeci.preparation.v1", mode: "gzip-grouped", spaFallback: true, gatewayId: "fixture" } : null }).returning();
    return row!;
  }

  it("keeps original prepared bytes after source deletion and project path changes", async () => {
    const row = await deployment();
    const initial = await loadDeploymentArtifact(runtime(), row.id);
    expect(initial.deployment.prepared_artifact_key).not.toBeNull();
    await handle.db.update(deployments).set({ manifestSha256: initial.prepared.releaseManifestHash }).where(eq(deployments.id, row.id));
    await store.delete(sourceKey);
    await handle.db.update(projects).set({ pathMode: "root" }).where(eq(projects.id, projectId));
    const loaded = await loadDeploymentArtifact(runtime(), row.id);
    expect(loaded.prepared.releaseManifestHash).toBe(initial.prepared.releaseManifestHash);
    expect(Buffer.from(loaded.prepared.entryBytes)).toEqual(Buffer.from(initial.prepared.entryBytes));
    expect(await store.has(sourceKey)).toBe(false);
  });

  it("pins compressed bytes, requires a qualified target and never recompresses on resume", async () => {
    const row = await deployment(true);
    await expect(loadDeploymentArtifact(runtime(), row.id)).rejects.toThrow(/not qualified/i);
    const initial = await loadDeploymentArtifact(runtime(true), row.id);
    expect(initial.prepared.entryHtml).toContain("tapeci.pack-entry.v1");
    await handle.db.update(deployments).set({ manifestSha256: initial.prepared.releaseManifestHash }).where(eq(deployments.id, row.id));
    await store.delete(sourceKey);
    const loaded = await loadDeploymentArtifact(runtime(true), row.id);
    expect(loaded.prepared.manifest).toEqual(initial.prepared.manifest);
    expect(loaded.files.map(file => Buffer.from(file.bytes))).toEqual(initial.files.map(file => Buffer.from(file.bytes)));
    await expect(loadDeploymentArtifact(runtime(), row.id)).rejects.toThrow(/not qualified/i);
    await handle.db.update(deployments).set({ preparation_request: { schemaVersion: "tapeci.preparation.v1", mode: "gzip-grouped", spaFallback: false, gatewayId: "fixture" } }).where(eq(deployments.id, row.id));
    await expect(loadDeploymentArtifact(runtime(true), row.id)).rejects.toThrow(/context|request/i);
  });

  it("fails closed on a missing frozen archive and does not rebuild from the original tar", async () => {
    const row = await deployment();
    const initial = await loadDeploymentArtifact(runtime(), row.id);
    await store.delete(initial.deployment.prepared_artifact_key!);
    expect(await store.has(sourceKey)).toBe(true);
    await expect(loadDeploymentArtifact(runtime(), row.id)).rejects.toThrow(/does not exist/i);
  });

  it("copies the immutable pin through rollback after raw source removal", async () => {
    const row = await deployment(true);
    const initial = await loadDeploymentArtifact(runtime(true), row.id);
    await handle.db.update(deployments).set({ manifestSha256: initial.prepared.releaseManifestHash, state: "LIVE" }).where(eq(deployments.id, row.id));
    const entry = initial.prepared.manifest.files.find(file => file.path === "index.html")!;
    await handle.db.insert(releases).values({ projectId, deploymentId: row.id, releaseId: initial.prepared.releaseId, commitSha: row.commitSha, manifestSha256: initial.prepared.releaseManifestHash, entrySha256: entry.sha256, verifyReport: { fixture: true }, verifiedBlockNumber: "1" });
    await store.delete(sourceKey);
    const app = buildApp({ db: handle.db, env: { ...runtime(true).env, devAuth: true } });
    try {
      const response = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/rollback`, headers: { "x-tapeci-github-login": "prepared-fixture", "x-tapeci-github-user-id": "82001" }, payload: { releaseId: initial.prepared.releaseId } });
      expect(response.statusCode).toBe(202);
      const result = response.json() as { deploymentId: string };
      const [rollback] = await handle.db.select().from(deployments).where(eq(deployments.id, result.deploymentId));
      expect(rollback?.prepared_artifact_key).toBe(initial.deployment.prepared_artifact_key);
      expect(rollback?.preparation_request).toEqual(row.preparation_request);
      expect((await loadDeploymentArtifact(runtime(true), result.deploymentId)).prepared.releaseManifestHash).toBe(initial.prepared.releaseManifestHash);
    } finally { await app.close(); }
  });

  it("exposes preparation identity without storage keys and creates a fresh idempotent plan only", async () => {
    const row = await deployment();
    const pinned = await loadDeploymentArtifact(runtime(), row.id);
    await handle.db.update(deployments).set({ state: "PLAN_READY", manifestSha256: pinned.prepared.releaseManifestHash }).where(eq(deployments.id, row.id));
    const queued: string[] = [];
    const app = buildApp({ db: handle.db, env: { ...runtime(true).env, devAuth: true, compressionGateways: runtime(true).compressionGateways }, objectStore: store, enqueuePlan: async id => { queued.push(id); } });
    const headers = { "x-tapeci-github-login": "prepared-fixture", "x-tapeci-github-user-id": "82001" };
    try {
      const read = await app.inject({ method: "GET", url: `/v1/deployments/${row.id}/preparation`, headers });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ request: { mode: "original" }, snapshotSha256: pinned.deployment.prepared_artifact_key!.slice(7, -4), canPrepare: true, gateways: [{ id: "fixture" }] });
      expect(read.body).not.toContain("sha256/");
      const payload = { requestId: "11111111-1111-4111-8111-111111111111", preparation: { schemaVersion: "tapeci.preparation.v1", mode: "gzip-whole", spaFallback: false, gatewayId: "fixture" } };
      const first = await app.inject({ method: "POST", url: `/v1/deployments/${row.id}/preparation`, headers, payload });
      expect(first.statusCode).toBe(202);
      const id = first.json().deploymentId as string;
      expect(id).not.toBe(row.id);
      const [created] = await handle.db.select().from(deployments).where(eq(deployments.id, id));
      expect(created).toMatchObject({ state: "BUILT", commitSha: row.commitSha, artifactStorageKey: sourceKey, preparation_request: payload.preparation, prepared_artifact_key: null, manifestSha256: null, planJson: null, approvedCostCapWei: null, recoveryContext: null });
      expect(queued).toEqual([id]);
      const prepared = await loadDeploymentArtifact(runtime(true), id);
      expect(prepared.prepared.entryHtml).toContain("tapeci.pack-entry.v1");
      expect(prepared.deployment.prepared_artifact_key).not.toBe(pinned.deployment.prepared_artifact_key);
      const retry = await app.inject({ method: "POST", url: `/v1/deployments/${row.id}/preparation`, headers, payload });
      expect(retry.json().deploymentId).toBe(id);
      const conflict = await app.inject({ method: "POST", url: `/v1/deployments/${row.id}/preparation`, headers, payload: { ...payload, preparation: { schemaVersion: "tapeci.preparation.v1", mode: "original", spaFallback: false } } });
      expect(conflict.statusCode).toBe(409);
      const [source] = await handle.db.select().from(deployments).where(eq(deployments.id, row.id));
      expect(source).toMatchObject({ state: "PLAN_READY", prepared_artifact_key: pinned.deployment.prepared_artifact_key, preparation_request: null });
      await handle.db.update(deployments).set({ state: "APPROVED" }).where(eq(deployments.id, row.id));
      await store.delete(sourceKey);
      const recovery = await app.inject({ method: "POST", url: `/v1/deployments/${row.id}/preparation`, headers, payload });
      expect(recovery.statusCode).toBe(202);
      expect(recovery.json().deploymentId).toBe(id);
      const revokedApp = buildApp({ db: handle.db, env: { ...runtime().env, devAuth: true }, objectStore: store, enqueuePlan: async () => { throw new Error("revoked gateway must not enqueue"); } });
      try {
        const recovered = await revokedApp.inject({ method: "POST", url: `/v1/deployments/${row.id}/preparation`, headers, payload });
        expect(recovered.statusCode).toBe(202);
        expect(recovered.json()).toMatchObject({ deploymentId: id, enqueued: false });
      } finally { await revokedApp.close(); }
      await handle.db.update(deployments).set({ state: "CANCELED" }).where(eq(deployments.id, row.id));
    } finally { await app.close(); }
  });

  it("rejects unqualified strategies and unavailable raw sources", async () => {
    const row = await deployment();
    await handle.db.update(deployments).set({ state: "PLAN_READY" }).where(eq(deployments.id, row.id));
    const app = buildApp({ db: handle.db, env: { ...runtime().env, devAuth: true }, objectStore: store, enqueuePlan: async () => { throw new Error("must not enqueue"); } });
    const headers = { "x-tapeci-github-login": "prepared-fixture", "x-tapeci-github-user-id": "82001" };
    const payload = { requestId: "22222222-2222-4222-8222-222222222222", preparation: { schemaVersion: "tapeci.preparation.v1", mode: "gzip-whole", spaFallback: false, gatewayId: "fixture" } };
    try {
      expect((await app.inject({ method: "POST", url: `/v1/deployments/${row.id}/preparation`, headers, payload })).statusCode).toBe(422);
      await store.delete(sourceKey);
      const read = await app.inject({ method: "GET", url: `/v1/deployments/${row.id}/preparation`, headers });
      expect(read.json()).toMatchObject({ canPrepare: false, unavailableReason: "SOURCE_ARTIFACT_UNAVAILABLE", gateways: [] });
      expect((await app.inject({ method: "POST", url: `/v1/deployments/${row.id}/preparation`, headers, payload: { ...payload, preparation: { schemaVersion: "tapeci.preparation.v1", mode: "original", spaFallback: false } } })).statusCode).toBe(409);
    } finally { await app.close(); }
  });

  it("refuses strategy selection for unauthorized users, viewers, archived projects and approved sources", async () => {
    const row = await deployment();
    await handle.db.update(deployments).set({ state: "APPROVED" }).where(eq(deployments.id, row.id));
    const app = buildApp({ db: handle.db, env: { ...runtime().env, devAuth: true }, objectStore: store });
    const headers = { "x-tapeci-github-login": "prepared-fixture", "x-tapeci-github-user-id": "82001" };
    try {
      const read = await app.inject({ method: "GET", url: `/v1/deployments/${row.id}/preparation`, headers });
      expect(read.json()).toMatchObject({ canPrepare: false, unavailableReason: "PREPARATION_STATE_LOCKED" });
      const forbidden = await app.inject({ method: "GET", url: `/v1/deployments/${row.id}/preparation`, headers: { "x-tapeci-github-login": "unrelated", "x-tapeci-github-user-id": "82009" } });
      expect(forbidden.statusCode).toBe(404);
      const [owner] = await handle.db.select().from(users).where(eq(users.githubUserId, 82001));
      await handle.db.update(deployments).set({ state: "PLAN_READY" }).where(eq(deployments.id, row.id));
      await handle.db.update(projectMembers).set({ role: "viewer" }).where(eq(projectMembers.userId, owner!.id));
      const viewer = await app.inject({ method: "POST", url: `/v1/deployments/${row.id}/preparation`, headers, payload: { requestId: "33333333-3333-4333-8333-333333333333", preparation: { schemaVersion: "tapeci.preparation.v1", mode: "original", spaFallback: false } } });
      expect(viewer.statusCode).toBe(403);
      await handle.db.update(projectMembers).set({ role: "owner" }).where(eq(projectMembers.userId, owner!.id));
      await handle.db.update(projects).set({ isArchived: true }).where(eq(projects.id, projectId));
      const archived = await app.inject({ method: "GET", url: `/v1/deployments/${row.id}/preparation`, headers });
      expect(archived.json()).toMatchObject({ canPrepare: false, unavailableReason: "PROJECT_ARCHIVED" });
      await handle.db.update(projects).set({ isArchived: false }).where(eq(projects.id, projectId));
    } finally { await app.close(); }
  });


  it("refuses a compressed record outside planning even when pin and manifest are both NULL", async () => {
    // The guard used to test `manifestSha256 !== null` as a proxy for "past planning", so a row
    // with BOTH null fell through to a source rebuild. The source tar is deliberately still
    // present here: a fallback would have succeeded, which is exactly why it must not happen.
    const row = await deployment(true);
    await handle.db
      .update(deployments)
      .set({ state: "APPROVED", prepared_artifact_key: null, manifestSha256: null })
      .where(eq(deployments.id, row.id));
    expect(await store.has(sourceKey)).toBe(true);
    await expect(loadDeploymentArtifact(runtime(true), row.id)).rejects.toThrow(
      /requires an immutable prepared pin/i,
    );
  });

  it("refuses rollback of a compressed release with no frozen artifact instead of answering 202", async () => {
    // The route used to answer 202 and let the worker fail later, so the caller polled a
    // deployment that could never succeed. The refusal belongs in the request.
    const row = await deployment(true);
    // A distinct commit so this release does not collide with the fixture's earlier one;
    // releaseId is derived from commit + artifact digest.
    await handle.db.update(deployments).set({ commitSha: "b".repeat(40) }).where(eq(deployments.id, row.id));
    const initial = await loadDeploymentArtifact(runtime(true), row.id);
    await handle.db
      .update(deployments)
      .set({ manifestSha256: initial.prepared.releaseManifestHash, state: "LIVE" })
      .where(eq(deployments.id, row.id));
    const entry = initial.prepared.manifest.files.find((file) => file.path === "index.html")!;
    await handle.db.insert(releases).values({
      projectId,
      deploymentId: row.id,
      releaseId: initial.prepared.releaseId,
      commitSha: row.commitSha,
      manifestSha256: initial.prepared.releaseManifestHash,
      entrySha256: entry.sha256,
      verifyReport: { fixture: true },
      verifiedBlockNumber: "1",
    });
    // A legacy compressed release whose pin was lost.
    await handle.db
      .update(deployments)
      .set({ prepared_artifact_key: null })
      .where(eq(deployments.id, row.id));
    const app = buildApp({ db: handle.db, env: { ...runtime(true).env, devAuth: true } });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/rollback`,
        headers: { "x-tapeci-github-login": "prepared-fixture", "x-tapeci-github-user-id": "82001" },
        payload: { releaseId: initial.prepared.releaseId },
      });
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        "PREPARED_ARTIFACT_UNAVAILABLE",
      );
    } finally {
      await app.close();
    }
  });


  it("refuses to freeze a compressed snapshot whose artifactDigest does not describe its rows", async () => {
    // The digest used to be written through with only a hex-shape check, so a snapshot could
    // claim an identity its own payload did not have (Stage C review F1). This freezes the
    // valid release with the digest replaced by zeroes and requires a refusal.
    const row = await deployment(true);
    const valid = await loadDeploymentArtifact(runtime(true), row.id);
    const gateway = {
      id: "fixture",
      origin: "http://127.0.0.1:19001",
      chainId: 196 as const,
      siteRegistry: REGISTRY as `0x${string}`,
      container: CONTAINER as `0x${string}`,
      adapterSha256: `0x${"ab".repeat(32)}` as `0x${string}`,
      serviceFeeWei: "0",
    };
    const context = {
      projectId,
      repositoryId: 82001,
      commitSha: row.commitSha,
      chainId: 196 as const,
      siteRegistry: REGISTRY.toLowerCase() as `0x${string}`,
      container: CONTAINER.toLowerCase() as `0x${string}`,
      sourceArtifactKey: sourceKey,
      sourceArtifactSha256: sha256Hex(archive) as `0x${string}`,
    };
    await expect(
      freezePreparedArtifact(store, {
        context,
        request: parsePreparationRequest(row.preparation_request),
        gateway,
        prepared: { ...valid.prepared, artifactDigest: `0x${"0".repeat(64)}` as `0x${string}` },
        files: valid.files.map((file) => ({ sourcePath: file.sourcePath, bytes: file.bytes })),
      }),
    ).rejects.toThrow(/artifact digest does not match/i);
  });


  it("loads a frozen snapshot when the row no longer names a raw artifact key", async () => {
    // The pin is self-contained: the archive it names is content-addressed by that key, so the
    // raw key column is a convenience. Requiring it first made a repaired or legacy pin-only row
    // unloadable (Stage C review F3).
    const row = await deployment(true);
    const initial = await loadDeploymentArtifact(runtime(true), row.id);
    await handle.db.delete(artifactUploads).where(eq(artifactUploads.deploymentId, row.id));
    await handle.db
      .update(deployments)
      .set({ artifactStorageKey: null })
      .where(eq(deployments.id, row.id));

    const loaded = await loadDeploymentArtifact(runtime(true), row.id);
    expect(loaded.prepared.releaseManifestHash).toBe(initial.prepared.releaseManifestHash);
    expect(loaded.files.map((file) => Buffer.from(file.bytes))).toEqual(
      initial.files.map((file) => Buffer.from(file.bytes)),
    );
  });


  it("refuses to freeze a compressed snapshot that omits its source artifact digest", async () => {
    // Falling back to `artifactDigest` would label the physical digest as the logical source
    // identity — the confusion the two fields exist to prevent (Stage C re-review, F1 residual).
    const row = await deployment(true);
    const valid = await loadDeploymentArtifact(runtime(true), row.id);
    const gateway = {
      id: "fixture",
      origin: "http://127.0.0.1:19001",
      chainId: 196 as const,
      siteRegistry: REGISTRY as `0x${string}`,
      container: CONTAINER as `0x${string}`,
      adapterSha256: `0x${"ab".repeat(32)}` as `0x${string}`,
      serviceFeeWei: "0",
    };
    const context = {
      projectId,
      repositoryId: 82001,
      commitSha: row.commitSha,
      chainId: 196 as const,
      siteRegistry: REGISTRY.toLowerCase() as `0x${string}`,
      container: CONTAINER.toLowerCase() as `0x${string}`,
      sourceArtifactKey: sourceKey,
      sourceArtifactSha256: sha256Hex(archive) as `0x${string}`,
    };
    await expect(
      freezePreparedArtifact(store, {
        context,
        request: parsePreparationRequest(row.preparation_request),
        gateway,
        // Deliberately no `sourceArtifactDigest`.
        prepared: {
          manifest: valid.prepared.manifest,
          artifactDigest: valid.prepared.artifactDigest,
          releaseManifestHash: valid.prepared.releaseManifestHash,
          entryBytes: valid.prepared.entryBytes,
        },
        files: valid.files.map((file) => ({ sourcePath: file.sourcePath, bytes: file.bytes })),
      }),
    ).rejects.toThrow(/requires a source artifact digest/i);
  });

  it("rolls back a pinned compressed release whose raw artifact key is gone", async () => {
    // The route used to resolve the raw key first and reject these rows with ARTIFACT_UNAVAILABLE,
    // even though the pin is self-contained (Stage C re-review, F3 residual).
    const row = await deployment(true);
    await handle.db.update(deployments).set({ commitSha: "c".repeat(40) }).where(eq(deployments.id, row.id));
    const initial = await loadDeploymentArtifact(runtime(true), row.id);
    await handle.db
      .update(deployments)
      .set({ manifestSha256: initial.prepared.releaseManifestHash, state: "LIVE" })
      .where(eq(deployments.id, row.id));
    const entry = initial.prepared.manifest.files.find((file) => file.path === "index.html")!;
    await handle.db.insert(releases).values({
      projectId,
      deploymentId: row.id,
      releaseId: initial.prepared.releaseId,
      commitSha: "c".repeat(40),
      manifestSha256: initial.prepared.releaseManifestHash,
      entrySha256: entry.sha256,
      verifyReport: { fixture: true },
      verifiedBlockNumber: "1",
    });
    await handle.db.delete(artifactUploads).where(eq(artifactUploads.deploymentId, row.id));
    await handle.db.update(deployments).set({ artifactStorageKey: null }).where(eq(deployments.id, row.id));

    const app = buildApp({ db: handle.db, env: { ...runtime(true).env, devAuth: true } });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/rollback`,
        headers: { "x-tapeci-github-login": "prepared-fixture", "x-tapeci-github-user-id": "82001" },
        payload: { releaseId: initial.prepared.releaseId },
      });
      expect(response.statusCode).toBe(202);
      const result = response.json() as { deploymentId: string };
      const loaded = await loadDeploymentArtifact(runtime(true), result.deploymentId);
      expect(loaded.prepared.releaseManifestHash).toBe(initial.prepared.releaseManifestHash);
    } finally {
      await app.close();
    }
  });


  it("reports the recorded plan's cost lines and why automatic selection stayed original", async () => {
    // §15: the strategy choice must be made against numbers, and the automatic rule must explain
    // itself. These come from the plan the worker already produced, not a fresh estimate.
    const row = await deployment();
    await handle.db
      .update(deployments)
      .set({
        state: "PLAN_READY",
        // The gateway filter matches on the target chain; without it the only configured gateway
        // is filtered out and the reason becomes `gateway-not-qualified`.
        targetChainId: 196,
        planJson: {
          totals: { files: 4, writes: 3, unchanged: 1, chunks: 9, bytes: 45_409 },
          fees: {
            estimatedGas: "11331376",
            estimatedCostWei: "22662752000",
            recommendedCapWei: "27195302400",
            costCapWei: "27195302400",
            withinBudget: true,
          },
        },
      })
      .where(eq(deployments.id, row.id));

    const app = buildApp({
      db: handle.db,
      env: { ...runtime(true).env, devAuth: true, compressionGateways: runtime(true).compressionGateways },
      objectStore: store,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/deployments/${row.id}/preparation`,
        headers: { "x-tapeci-github-login": "prepared-fixture", "x-tapeci-github-user-id": "82001" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        cost: Record<string, unknown> | null;
        automaticSelection: { strategy: string; reason: string };
      };
      expect(body.cost).toMatchObject({
        strategy: "original",
        physicalFiles: 4,
        writeFiles: 3,
        reusedFiles: 1,
        plannedBytes: 45_409,
        plannedChunks: 9,
        estimatedCostWei: "22662752000",
        costCapWei: "27195302400",
        withinBudget: true,
      });
      // A gateway is configured here, but no production simulation exists — so the rule keeps
      // original and says exactly that.
      expect(body.automaticSelection).toEqual({
        strategy: "original",
        reason: "production-simulation-required",
      });
    } finally {
      await app.close();
    }
  });

});
