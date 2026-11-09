import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  and,
  approvals,
  artifactUploads,
  buildTokens,
  chainTransactions,
  containers,
  databaseAvailable,
  deploymentEvents,
  deployments,
  eq,
  operatorSessions,
  projectMembers,
  projects,
  queryRows,
  releaseFiles,
  releases,
  sql,
  users,
  walletChallenges,
  wallets,
  webhookDeliveries,
  withMigratedTestDatabase,
} from "@tapeci/database";
import {
  APPROVAL_DIGEST,
  COMMIT_SHA,
  CONTAINER_ADDRESS,
  ENTRY_SHA256,
  MANIFEST_SHA256,
  OPERATION_FINGERPRINT,
  REGISTRY_ADDRESS,
  SIGNER_ADDRESS,
  TO_ADDRESS,
  TX_HASH,
  WALLET_ADDRESS,
  expectPostgresError,
  firstRow,
  insertDeployment,
  insertOne,
  seedCore,
} from "./helpers.js";

const databaseAvailableNow = await databaseAvailable();

describe.skipIf(!databaseAvailableNow)("P2-01 drizzle schema", () => {
  it("round-trips baseline entities with server-side defaults", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await seedCore(db);

      const wallet = insertOne(
        await db
          .insert(wallets)
          .values({
            userId: core.userId,
            chainId: 196,
            address: WALLET_ADDRESS,
            verifiedAt: new Date("2026-10-19T00:00:00Z"),
          })
          .returning(),
      );
      expect(wallet.address).toBe(WALLET_ADDRESS);
      expect(wallet.verifiedAt).toBeInstanceOf(Date);

      const member = insertOne(
        await db
          .insert(projectMembers)
          .values({ projectId: core.projectId, userId: core.userId })
          .returning(),
      );
      expect(member.role).toBe("owner");

      const user = firstRow(await db.select().from(users).where(eq(users.id, core.userId)));
      expect(user.githubLogin).toBe("octocat");
      expect(user.githubUserId).toBe(4_242);
      expect(typeof user.githubUserId).toBe("number");
      expect(user.avatarUrl).toBeNull();
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toBeInstanceOf(Date);

      const container = firstRow(
        await db.select().from(containers).where(eq(containers.id, core.containerId)),
      );
      expect(container.chainId).toBe(196);
      expect(container.containerAddress).toBe(CONTAINER_ADDRESS);
      // numeric(78,0) is returned as a decimal string by the pg driver.
      expect(container.tokenId).toBe("1");
      expect(typeof container.tokenId).toBe("string");
      expect(container.lastCheckedBlock).toBeNull();

      const project = firstRow(
        await db.select().from(projects).where(eq(projects.id, core.projectId)),
      );
      expect(project.defaultBranch).toBe("main");
      expect(project.buildCommand).toBe("npm run build");
      expect(project.installCommand).toBe("npm ci");
      expect(project.outputDirectory).toBe("dist");
      expect(project.strictDewebMode).toBe(true);
      expect(project.isArchived).toBe(false);
      expect(project.createdAt).toBeInstanceOf(Date);

      const deployment = firstRow(
        await db.select().from(deployments).where(eq(deployments.id, core.deploymentId)),
      );
      expect(deployment.state).toBe("RECEIVED");
      expect(deployment.targetChainId).toBe(196);
      expect(deployment.stateVersion).toBe(0);
      expect(deployment.triggerKind).toBe("webhook");
      expect(deployment.commitSha).toBe(COMMIT_SHA);
      expect(deployment.planJson).toBeNull();
      expect(deployment.approvedCostCapWei).toBeNull();
      expect(deployment.requestedAt).toBeInstanceOf(Date);

      const delivery = firstRow(
        await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, core.deliveryId)),
      );
      expect(delivery.githubDeliveryId).toBe("delivery-1");
      expect(delivery.accepted).toBe(true);
      expect(delivery.processedAt).toBeNull();
    });
  });

  it("persists jsonb plans, numeric wei values as strings and enum states", async () => {
    await withMigratedTestDatabase(async ({ db, url }) => {
      const core = await seedCore(db);

      const plan = {
        chainId: 196,
        entry: "index.html",
        steps: [{ operation: "appendChunk", target: "0xabc", index: 0 }],
      };
      const deploymentId = await insertDeployment(db, core, {
        planJson: plan,
        approvedCostCapWei: "123456789012345678901234567890",
        estimatedCostWei: "900000000000000000",
      });

      const deployment = firstRow(
        await db.select().from(deployments).where(eq(deployments.id, deploymentId)),
      );
      expect(deployment.planJson).toEqual(plan);
      expect(typeof deployment.approvedCostCapWei).toBe("string");
      expect(deployment.approvedCostCapWei).toBe("123456789012345678901234567890");
      expect(deployment.estimatedCostWei).toBe("900000000000000000");

      const file = insertOne(
        await db
          .insert(releaseFiles)
          .values({
            deploymentId,
            targetPath: "index.html",
            sourceRelativePath: "index.html",
            sha256: MANIFEST_SHA256,
            byteSize: 12,
            chunkCount: 1,
            contentType: "text/html",
          })
          .returning(),
      );
      expect(file.state).toBe("PENDING");
      expect(file.lastConfirmedChunkIndex).toBe(-1);
      expect(file.byteSize).toBe(12);

      const updated = insertOne(
        await db
          .update(deployments)
          .set({ state: "BUILDING", startedAt: new Date(), stateVersion: 1 })
          .where(eq(deployments.id, deploymentId))
          .returning(),
      );
      expect(updated.state).toBe("BUILDING");
      expect(updated.stateVersion).toBe(1);
      expect(updated.startedAt).toBeInstanceOf(Date);

      const event = insertOne(
        await db
          .insert(deploymentEvents)
          .values({
            deploymentId,
            oldState: "RECEIVED",
            newState: "BUILDING",
            eventType: "state_changed",
            actorKind: "worker",
            actorId: "worker-1",
            payload: { note: "build started" },
          })
          .returning(),
      );
      expect(typeof event.id).toBe("number");
      expect(event.id).toBeGreaterThan(0);
      expect(event.oldState).toBe("RECEIVED");
      expect(event.newState).toBe("BUILDING");
      expect(event.payload).toEqual({ note: "build started" });

      const transaction = insertOne(
        await db
          .insert(chainTransactions)
          .values({
            deploymentId,
            releaseFileId: file.id,
            chainId: 196,
            signerAddress: SIGNER_ADDRESS,
            toAddress: TO_ADDRESS,
            operation: "appendChunk",
            operationFingerprint: OPERATION_FINGERPRINT,
            nonce: "7",
            gasLimit: "500000",
            effectiveGasPriceWei: "20000000000",
            txHash: TX_HASH,
            state: "PREPARED",
          })
          .returning(),
      );
      expect(transaction.nonce).toBe("7");
      expect(typeof transaction.nonce).toBe("string");
      expect(transaction.gasLimit).toBe("500000");
      expect(transaction.state).toBe("PREPARED");

      const approval = insertOne(
        await db
          .insert(approvals)
          .values({
            deploymentId,
            signerAddress: SIGNER_ADDRESS,
            chainId: 196,
            manifestSha256: MANIFEST_SHA256,
            approvalDigest: APPROVAL_DIGEST,
            signature: "0xdeadbeef",
            approvedCostCapWei: "1000000000000000000",
            nonce: "approval-nonce-1",
            expiresAt: new Date(Date.now() + 3_600_000),
          })
          .returning(),
      );
      expect(approval.approvedCostCapWei).toBe("1000000000000000000");
      expect(approval.revokedAt).toBeNull();

      // The database enum (not just TypeScript) rejects unknown state labels.
      await expectPostgresError(
        queryRows(
          url,
          `INSERT INTO deployments
             (project_id, container_id, trigger_kind, commit_sha, registry_address, state)
           VALUES ($1, $2, 'webhook', $3, $4, 'NOT_A_STATE')`,
          [core.projectId, core.containerId, COMMIT_SHA, REGISTRY_ADDRESS],
        ),
        "22P02",
      );
    });
  });

  it("enforces webhook delivery dedup and the unique keys of the ledger", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await seedCore(db);

      await expectPostgresError(
        db
          .insert(webhookDeliveries)
          .values({ githubDeliveryId: "delivery-1", eventType: "push" }),
        "23505",
      );

      await expectPostgresError(
        db.insert(users).values({ githubUserId: 4_242, githubLogin: "duplicate" }),
        "23505",
      );

      // A webhook delivery row may back at most one deployment.
      await expectPostgresError(
        db.insert(deployments).values({
          projectId: core.projectId,
          containerId: core.containerId,
          webhookDeliveryId: core.deliveryId,
          triggerKind: "webhook",
          commitSha: COMMIT_SHA,
          registryAddress: REGISTRY_ADDRESS,
        }),
        "23505",
      );

      const secondDeployment = await insertDeployment(db, core);
      await db.insert(chainTransactions).values({
        deploymentId: core.deploymentId,
        chainId: 196,
        signerAddress: SIGNER_ADDRESS,
        toAddress: TO_ADDRESS,
        operation: "appendChunk",
        operationFingerprint: OPERATION_FINGERPRINT,
        nonce: "1",
        txHash: TX_HASH,
      });

      // UNIQUE (chain_id, tx_hash): one chain tx may only be recorded once.
      await expectPostgresError(
        db.insert(chainTransactions).values({
          deploymentId: secondDeployment,
          chainId: 196,
          signerAddress: SIGNER_ADDRESS,
          toAddress: TO_ADDRESS,
          operation: "appendChunk",
          operationFingerprint: OPERATION_FINGERPRINT,
          nonce: "1",
          txHash: TX_HASH,
        }),
        "23505",
      );

      // UNIQUE (deployment_id, operation_fingerprint, nonce): no double broadcast
      // of the same operation at the same nonce.
      await expectPostgresError(
        db.insert(chainTransactions).values({
          deploymentId: core.deploymentId,
          chainId: 196,
          signerAddress: SIGNER_ADDRESS,
          toAddress: TO_ADDRESS,
          operation: "appendChunk",
          operationFingerprint: OPERATION_FINGERPRINT,
          nonce: "1",
          txHash: `0x${"1".repeat(64)}`,
        }),
        "23505",
      );

      // Nullable nonce: PostgreSQL treats NULLs as distinct, so the same
      // fingerprint may be prepared more than once before nonce assignment.
      await db.insert(chainTransactions).values({
        deploymentId: secondDeployment,
        chainId: 196,
        signerAddress: SIGNER_ADDRESS,
        toAddress: TO_ADDRESS,
        operation: "appendChunk",
        operationFingerprint: `0x${"2".repeat(64)}`,
        nonce: null,
        txHash: `0x${"3".repeat(64)}`,
      });
      await db.insert(chainTransactions).values({
        deploymentId: secondDeployment,
        chainId: 196,
        signerAddress: SIGNER_ADDRESS,
        toAddress: TO_ADDRESS,
        operation: "appendChunk",
        operationFingerprint: `0x${"2".repeat(64)}`,
        nonce: null,
        txHash: `0x${"4".repeat(64)}`,
      });

      // replacement_for is a self-referencing FK to chain_transactions(id).
      await expectPostgresError(
        db.insert(chainTransactions).values({
          deploymentId: secondDeployment,
          chainId: 196,
          signerAddress: SIGNER_ADDRESS,
          toAddress: TO_ADDRESS,
          operation: "appendChunk",
          operationFingerprint: `0x${"6".repeat(64)}`,
          nonce: "9",
          txHash: `0x${"5".repeat(64)}`,
          replacementFor: randomUUID(),
        }),
        "23503",
      );
    });
  });

  it("allows at most one chain-writing deployment per container", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await seedCore(db);

      // Planning may run concurrently: multiple non-writing states are fine.
      const waiting = await insertDeployment(db, core, { state: "RECEIVED" });
      const approved = await insertDeployment(db, core, { state: "APPROVED" });

      // A second writer for the same container is rejected by the partial index.
      await expectPostgresError(insertDeployment(db, core, { state: "APPROVED" }), "23505");
      await expectPostgresError(
        db
          .update(deployments)
          .set({ state: "UPLOADING_ASSETS" })
          .where(eq(deployments.id, waiting)),
        "23505",
      );

      // Once the writer finishes, the container lock is released.
      await db.update(deployments).set({ state: "LIVE" }).where(eq(deployments.id, approved));
      const promoted = insertOne(
        await db
          .update(deployments)
          .set({ state: "APPROVED" })
          .where(eq(deployments.id, waiting))
          .returning(),
      );
      expect(promoted.state).toBe("APPROVED");

      const writers = await db
        .select()
        .from(deployments)
        .where(
          and(eq(deployments.containerId, core.containerId), eq(deployments.state, "APPROVED")),
        );
      expect(writers).toHaveLength(1);
    });
  });

  it("allows at most one current release per project", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await seedCore(db);
      const firstDeployment = await insertDeployment(db, core);
      const secondDeployment = await insertDeployment(db, core);
      const thirdDeployment = await insertDeployment(db, core);

      const verifyReport = { ok: true, releaseMatch: true };
      const releaseValues = (deploymentId: string, releaseId: string, isCurrent: boolean) => ({
        projectId: core.projectId,
        deploymentId,
        releaseId,
        commitSha: COMMIT_SHA,
        manifestSha256: MANIFEST_SHA256,
        entrySha256: ENTRY_SHA256,
        verifyReport,
        verifiedBlockNumber: "100",
        isCurrent,
      });

      const first = insertOne(
        await db.insert(releases).values(releaseValues(firstDeployment, "rel-1", true)).returning(),
      );
      expect(first.isCurrent).toBe(true);
      expect(first.verifyReport).toEqual(verifyReport);
      expect(first.verifiedBlockNumber).toBe("100");
      expect(typeof first.verifiedBlockNumber).toBe("string");

      // A second current release for the same project is rejected.
      await expectPostgresError(
        db.insert(releases).values(releaseValues(secondDeployment, "rel-2", true)),
        "23505",
      );

      // Non-current releases are unbounded.
      const second = insertOne(
        await db.insert(releases).values(releaseValues(secondDeployment, "rel-2", false)).returning(),
      );
      expect(second.isCurrent).toBe(false);

      // UNIQUE (project_id, release_id) is still enforced.
      await expectPostgresError(
        db.insert(releases).values(releaseValues(thirdDeployment, "rel-1", false)),
        "23505",
      );

      const current = await db
        .select()
        .from(releases)
        .where(and(eq(releases.projectId, core.projectId), eq(releases.isCurrent, true)));
      expect(current).toHaveLength(1);
      // A server-side aggregate (drizzle `sql`) sees the same single current row.
      const currentCount = firstRow(
        await db
          .select({ count: sql<number>`count(*)::int` })
          .from(releases)
          .where(and(eq(releases.projectId, core.projectId), eq(releases.isCurrent, true))),
      ).count;
      expect(currentCount).toBe(1);

      // Switching the current release is a two-step update, never two current rows.
      await db.update(releases).set({ isCurrent: false }).where(eq(releases.id, first.id));
      const switched = insertOne(
        await db
          .update(releases)
          .set({ isCurrent: true })
          .where(eq(releases.id, second.id))
          .returning(),
      );
      expect(switched.isCurrent).toBe(true);
    });
  });

  it("round-trips the P2 extension tables", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await seedCore(db);
      const expiresAt = new Date(Date.now() + 300_000);

      const challenge = insertOne(
        await db
          .insert(walletChallenges)
          .values({
            address: WALLET_ADDRESS,
            chainId: 196,
            nonce: "challenge-nonce-1",
            message: "Sign in to TapeCI",
            expiresAt,
          })
          .returning(),
      );
      expect(challenge.chainId).toBe(196);
      expect(challenge.consumedAt).toBeNull();
      const consumed = insertOne(
        await db
          .update(walletChallenges)
          .set({ consumedAt: new Date() })
          .where(eq(walletChallenges.id, challenge.id))
          .returning(),
      );
      expect(consumed.consumedAt).toBeInstanceOf(Date);

      const buildToken = insertOne(
        await db
          .insert(buildTokens)
          .values({
            jti: randomUUID(),
            deploymentId: core.deploymentId,
            repositoryId: 7_171,
            commitSha: COMMIT_SHA,
            ref: "refs/heads/main",
            expiresAt,
          })
          .returning(),
      );
      expect(buildToken.consumedAt).toBeNull();

      const upload = insertOne(
        await db
          .insert(artifactUploads)
          .values({
            deploymentId: core.deploymentId,
            objectKey: "objects/abc.tar",
            sha256: MANIFEST_SHA256,
            sizeBytes: 1_024,
            expiresAt,
          })
          .returning(),
      );
      expect(upload.sizeBytes).toBe(1_024);
      expect(typeof upload.sizeBytes).toBe("number");

      await expectPostgresError(
        db.insert(artifactUploads).values({
          deploymentId: core.deploymentId,
          objectKey: "objects/abc.tar",
          sha256: ENTRY_SHA256,
          sizeBytes: 2_048,
          expiresAt,
        }),
        "23505",
      );

      const session = insertOne(
        await db
          .insert(operatorSessions)
          .values({
            containerId: core.containerId,
            signerAddress: SIGNER_ADDRESS,
            expiresAt,
          })
          .returning(),
      );
      expect(session.approvalId).toBeNull();
      expect(session.revokedAt).toBeNull();
    });
  });

  it("enforces check constraints at the database boundary", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await seedCore(db);

      // Addresses are stored lowercase; the wallet CHECK rejects uppercase hex.
      await expectPostgresError(
        db.insert(wallets).values({
          userId: core.userId,
          chainId: 196,
          address: `0x${"AB".repeat(20)}`,
          verifiedAt: new Date(),
        }),
        "23514",
      );

      // X Layer chain id is pinned in the schema.
      await expectPostgresError(
        db.insert(deployments).values({
          projectId: core.projectId,
          containerId: core.containerId,
          triggerKind: "webhook",
          commitSha: COMMIT_SHA,
          registryAddress: REGISTRY_ADDRESS,
          targetChainId: 1,
        }),
        "23514",
      );

      await expectPostgresError(
        db.insert(deployments).values({
          projectId: core.projectId,
          containerId: core.containerId,
          triggerKind: "webhook",
          commitSha: COMMIT_SHA,
          registryAddress: REGISTRY_ADDRESS,
          stateVersion: -1,
        }),
        "23514",
      );

      await expectPostgresError(
        db.insert(releaseFiles).values({
          deploymentId: core.deploymentId,
          targetPath: "index.html",
          sourceRelativePath: "index.html",
          sha256: MANIFEST_SHA256,
          byteSize: 10,
          chunkCount: 0,
          contentType: "text/html",
        }),
        "23514",
      );

      await expectPostgresError(
        db
          .insert(deploymentEvents)
          .values({
            deploymentId: core.deploymentId,
            eventType: "state_changed",
            actorKind: "robot",
          }),
        "23514",
      );
    });
  });
});
