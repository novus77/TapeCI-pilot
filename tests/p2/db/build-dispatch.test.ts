/**
 * The dispatch trigger (SPEC §11.2, §11.3) against a real migrated PostgreSQL and a
 * fake GitHub surface.
 *
 * The three properties that make this safe are ordering properties, so they are the
 * assertions: the attempt exists **before** GitHub is called, "we do not know" never
 * becomes a failure, and a replay never dispatches twice.
 */
import { describe, expect, it } from "vitest";

import { buildAttempts, eq, projects, withMigratedTestDatabase } from "@tapeci/database";
import {
  dispatchDeploymentBuild,
  type BuildDispatchGithub,
} from "../../../apps/api/src/build-dispatch.js";
import { seedCore, insertDeployment } from "./helpers.js";

const TARGET_SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);

interface FakeGithub extends BuildDispatchGithub {
  readonly calls: {
    resolve: number;
    dispatch: number;
    find: number;
    dispatchedInputs: (Readonly<Record<string, string>> | null)[];
  };
}

/**
 * A GitHub surface that records how it was used. Overrides receive the call counters so
 * an override still counts itself — otherwise a test can assert a call that "happened"
 * only because the counting default was replaced.
 */
function fakeGithub(
  overrides: (calls: FakeGithub["calls"]) => Partial<BuildDispatchGithub> = () => ({}),
): FakeGithub {
  const calls = {
    resolve: 0,
    dispatch: 0,
    find: 0,
    dispatchedInputs: [] as (Readonly<Record<string, string>> | null)[],
  };
  return {
    calls,
    resolveRefSha: async () => {
      calls.resolve += 1;
      return WORKFLOW_SHA;
    },
    dispatchWorkflow: async (input) => {
      calls.dispatch += 1;
      calls.dispatchedInputs.push(input.inputs);
      return { dispatched: true, status: 204 };
    },
    findWorkflowRun: async () => {
      calls.find += 1;
      return null;
    },
    installationToken: async () => "ghs_test_token",
    ...overrides(calls),
  };
}

/** Seeded core with builds enabled, since admission is a separate gate. */
async function enabledCore(db: Parameters<typeof seedCore>[0]) {
  const core = await seedCore(db);
  await db.update(projects).set({ buildEnabled: true }).where(eq(projects.id, core.projectId));
  return core;
}

describe("§11.3 dispatch trigger", () => {
  it("saves the attempt before calling GitHub", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await enabledCore(db);
      const deploymentId = await insertDeployment(db, core);
      let rowsAtDispatch = -1;
      const github = fakeGithub((calls) => ({
        dispatchWorkflow: async () => {
          calls.dispatch += 1;
          // The whole protocol depends on this row existing first: an ambiguous
          // dispatch must have something to be matched against.
          rowsAtDispatch = (await db.select().from(buildAttempts)).length;
          return { dispatched: true, status: 204 };
        },
      }));
      const outcome = await dispatchDeploymentBuild({ db, github }, { deploymentId });
      expect(outcome.kind).toBe("dispatched");
      expect(rowsAtDispatch).toBe(1);
    });
  });

  it("records commitSha and workflowCommitSha as separate identities", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await enabledCore(db);
      const deploymentId = await insertDeployment(db, core);
      await dispatchDeploymentBuild({ db, github: fakeGithub() }, { deploymentId });
      const [attempt] = await db.select().from(buildAttempts);
      expect(attempt?.commitSha).toBe(TARGET_SHA);
      expect(attempt?.workflowCommitSha).toBe(WORKFLOW_SHA);
      expect(attempt?.commitSha).not.toBe(attempt?.workflowCommitSha);
      expect(attempt?.state).toBe("dispatched");
    });
  });

  it("passes the correlation id as workflow data, never as the target", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await enabledCore(db);
      const deploymentId = await insertDeployment(db, core);
      const github = fakeGithub();
      await dispatchDeploymentBuild({ db, github }, { deploymentId });
      const inputs = github.calls.dispatchedInputs[0] ?? {};
      expect(inputs["targetSha"]).toBe(TARGET_SHA);
      expect(inputs["correlationId"]).toBe(`deployment:${deploymentId}`);
    });
  });

  it("treats an unconfirmed dispatch as unknown and reconciles instead of failing", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await enabledCore(db);
      const deploymentId = await insertDeployment(db, core);
      // 5xx: GitHub did not confirm. The attempt must stay recoverable, never `failed`.
      const github = fakeGithub((calls) => ({
        dispatchWorkflow: async () => {
          calls.dispatch += 1;
          return { dispatched: false, reason: "unknown", status: 503, detail: "5xx" };
        },
        findWorkflowRun: async () => {
          calls.find += 1;
          return null;
        },
      }));
      const outcome = await dispatchDeploymentBuild({ db, github }, { deploymentId });
      expect(outcome.kind).toBe("unknown");
      const [attempt] = await db.select().from(buildAttempts);
      expect(attempt?.state).not.toBe("failed");
      expect(github.calls.find).toBe(1);
    });
  });

  it("refuses to dispatch when builds are disabled, and writes no attempt", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await seedCore(db); // buildEnabled defaults to false
      const deploymentId = await insertDeployment(db, core);
      const github = fakeGithub();
      const outcome = await dispatchDeploymentBuild({ db, github }, { deploymentId });
      expect(outcome.kind).toBe("skipped");
      expect(outcome.kind === "skipped" ? outcome.reason : null).toBe("build_disabled");
      expect(github.calls.dispatch).toBe(0);
      expect(await db.select().from(buildAttempts)).toHaveLength(0);
    });
  });

  it("refuses to write an attempt when the workflow revision cannot be resolved", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await enabledCore(db);
      const deploymentId = await insertDeployment(db, core);
      const github = fakeGithub(() => ({ resolveRefSha: async () => null }));
      const outcome = await dispatchDeploymentBuild({ db, github }, { deploymentId });
      expect(outcome.kind).toBe("skipped");
      // Guessing a workflow revision would corrupt the AC-P4-14 distinction.
      expect(await db.select().from(buildAttempts)).toHaveLength(0);
      expect(github.calls.dispatch).toBe(0);
    });
  });

  it("does not dispatch twice for a replayed trigger", async () => {
    await withMigratedTestDatabase(async ({ db }) => {
      const core = await enabledCore(db);
      const deploymentId = await insertDeployment(db, core);
      const github = fakeGithub();
      const first = await dispatchDeploymentBuild({ db, github }, { deploymentId });
      const second = await dispatchDeploymentBuild({ db, github }, { deploymentId });
      expect(first.kind).toBe("dispatched");
      expect(second.kind).toBe("dispatched");
      // One trigger, one attempt, one POST — a duplicate must not double-build.
      expect(github.calls.dispatch).toBe(1);
      expect(await db.select().from(buildAttempts)).toHaveLength(1);
    });
  });
});
