/**
 * SPEC §11.3: a build attempt is written **before** dispatch (save-before-dispatch), so
 * a dispatch whose result is unknown is still recoverable. These tests pin the three
 * properties that make that true, against a real migrated PostgreSQL:
 *
 *   1. a repeat of the same correlation id returns the same attempt (no duplicate);
 *   2. `commitSha` and `workflowCommitSha` stay separate identities;
 *   3. a retry of the same SHA creates a NEW attempt (`retryOf` set), never mutating
 *      the previous one — and the attempt number is race-safe.
 */
import { describe, expect, it } from "vitest";

import { buildAttempts, eq, withMigratedTestDatabase } from "@tapeci/database";
import {
  createBuildAttempt,
  retryBuildAttempt,
  type BuildAttemptDeps,
} from "../../../apps/api/src/build-attempts.js";
import { COMMIT_SHA, seedCore, insertDeployment, postgresErrorCode } from "./helpers.js";

const CONFIG = {
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDirectory: "dist",
} as const;

// The service refuses an attempt whose target commit differs from its deployment's,
// so the target must be the deployment's own SHA; the workflow revision is a distinct
// identity and is free to differ (that is the §11.3 point).
const TARGET_SHA = COMMIT_SHA;
const WORKFLOW_SHA = "2".repeat(40);

function deps(db: BuildAttemptDeps["db"]): BuildAttemptDeps {
  // A pinned clock: `createdAt`/`finishedAt` must never be implicit.
  let tick = 0;
  return { db, now: () => new Date(Date.UTC(2026, 9, 27, 12, 0, tick++)) };
}

describe("§11.3 build attempts (real PostgreSQL)", () => {
  it("keeps commitSha and workflowCommitSha as separate identities", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await seedCore(db);
      const deploymentId = await insertDeployment(db, core);
      const attempt = await createBuildAttempt(deps(db), {
        deploymentId,
        commitSha: TARGET_SHA,
        workflowCommitSha: WORKFLOW_SHA,
        dispatchCorrelationId: "corr-separate",
        configVersion: 1,
        configSnapshot: CONFIG,
      });
      expect(attempt.commitSha).toBe(TARGET_SHA);
      expect(attempt.workflowCommitSha).toBe(WORKFLOW_SHA);
      // Collapsing them is the failure this guards: they are different commits.
      expect(attempt.commitSha).not.toBe(attempt.workflowCommitSha);
      expect(attempt.attempt).toBe(1);
    });
  });

  it("is idempotent on the correlation id: a repeat returns the same attempt", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await seedCore(db);
      const deploymentId = await insertDeployment(db, core);
      const input = {
        deploymentId,
        commitSha: TARGET_SHA,
        workflowCommitSha: WORKFLOW_SHA,
        dispatchCorrelationId: "corr-repeat",
        configVersion: 1,
        configSnapshot: CONFIG,
      } as const;
      const first = await createBuildAttempt(deps(db), input);
      const second = await createBuildAttempt(deps(db), input);
      // One dispatch must never become two attempts.
      expect(second.id).toBe(first.id);
      const rows = await db.select().from(buildAttempts);
      expect(rows).toHaveLength(1);
    });
  });

  it("a retry of the same SHA creates a NEW attempt pointing at the old one", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await seedCore(db);
      const deploymentId = await insertDeployment(db, core);
      const d = deps(db);
      const first = await createBuildAttempt(d, {
        deploymentId,
        commitSha: TARGET_SHA,
        workflowCommitSha: WORKFLOW_SHA,
        dispatchCorrelationId: "corr-first",
        configVersion: 1,
        configSnapshot: CONFIG,
      });
      // §11.3: only a FINISHED attempt may be retried — retrying an open one would
      // mean two live builds for one deployment. Drive the first to a terminal state.
      await db
        .update(buildAttempts)
        .set({ state: "failed", finishedAt: new Date(Date.UTC(2026, 9, 27, 12, 5)) })
        .where(eq(buildAttempts.id, first.id));
      const retried = await retryBuildAttempt(d, {
        deploymentId,
        previousAttemptId: first.id,
        commitSha: TARGET_SHA,
        workflowCommitSha: WORKFLOW_SHA,
        dispatchCorrelationId: "corr-retry",
        configVersion: 1,
      });
      expect(retried.id).not.toBe(first.id);
      expect(retried.retryOf).toBe(first.id);
      expect(retried.attempt).toBe(2);
      // The retry keeps the same frozen config, not the project's current one.
      expect(retried.configSnapshot).toEqual(CONFIG);
      type Rows = Awaited<ReturnType<typeof db.select>>;
      void (null as unknown as Rows);
    });
  });

  it("the database rejects a duplicate (deployment, attempt) pair", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await seedCore(db);
      const deploymentId = await insertDeployment(db, core);
      const base = {
        deploymentId,
        commitSha: TARGET_SHA,
        workflowCommitSha: WORKFLOW_SHA,
        configVersion: 1,
        configSnapshot: CONFIG,
        dispatchCorrelationId: "corr-a",
      } as const;
      await createBuildAttempt(deps(db), { ...base, dispatchCorrelationId: "corr-a" });
      // The unique index is the backstop for a race the read-then-write cannot cover.
      const error = await db
        .insert(buildAttempts)
        .values({
          deploymentId,
          attempt: 1,
          retryOf: null,
          commitSha: TARGET_SHA,
          workflowCommitSha: WORKFLOW_SHA,
          dispatchCorrelationId: "corr-b",
          configVersion: 1,
          configSnapshot: CONFIG,
          state: "planned",
        })
        .then(() => null)
        .catch((thrown: unknown) => thrown);
      expect(error).not.toBeNull();
      expect(postgresErrorCode(error)).toBe("23505");
    });
  });
});
