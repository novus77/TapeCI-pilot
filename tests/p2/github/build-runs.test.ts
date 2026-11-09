/**
 * P4 acceptance — SPEC §15.1 row 10: `build-runs.test.ts`, the §11.3 build protocol.
 *
 * Required behaviour, in the order the SPEC lists it:
 * (a) start/fail 回报 — a `started` and a `failed` event move the attempt, and a failed
 *     attempt is not left `running`;
 * (b) 确定 SHA/config — `/v1/builds/context` serves the *stored* commit, config version and
 *     the three commands, and a body `targetSha`/`projectId`/`configVersion` is compared or
 *     ignored, never honoured;
 * (c) OIDC run 关联 — the OIDC token is the only authority, and another repository's token
 *     cannot reach this project's attempt;
 * (d) 同 SHA 新 attempt — a retry of the same SHA is a new row with `retryOf`, never a second
 *     dispatch of the old one;
 * (e) 重复 callback — a repeated event is idempotent: one row, one transition, no re-dated
 *     `finishedAt`;
 * (f) 历史 checkout SHA 与 workflow SHA 区分 — `commitSha` (target source) and
 *     `workflowCommitSha` (workflow that runs) are stored and returned as different values,
 *     and a body cannot set the workflow SHA.
 *
 * The implementation under test is the real one: `buildApp` (all routes), the real
 * `dispatchDeploymentBuild` trigger, the real `retryBuildAttempt`, the real state machine in
 * `routes/build-context.ts`, and PostgreSQL. Only the two external surfaces are injected:
 * `deps.verifyOidc` (so no GitHub OIDC exchange) and `deps.dispatchGithub` (so no dispatch
 * call leaves the process). No network, no real GitHub, no fork.
 *
 * §7.4 also names `POST /v1/projects/:id/builds` (the console trigger) and
 * `GET /v1/projects/:id/builds/:attemptId`. Neither route exists yet, so the trigger is
 * exercised through `dispatchDeploymentBuild` and the retry through `retryBuildAttempt` —
 * the same functions those routes would call. Reported as a gap, not worked around.
 *
 * Run from the repo root (package-dir Vitest is broken here, test-p0 §1.4):
 *   node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs exec vitest run tests/p2/github/build-runs.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { eq, sql } from "drizzle-orm";
import {
  buildAttempts,
  deploymentEvents,
  databaseAvailable,
  projects,
  type Database,
} from "@tapeci/database";
import type { GithubOidcClaims } from "@tapeci/github";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";
import {
  dispatchDeploymentBuild,
  type BuildDispatchGithub,
} from "../../../apps/api/src/build-dispatch.js";
import { retryBuildAttempt } from "../../../apps/api/src/build-attempts.js";
import {
  createMigratedTestDatabase,
  seedDeployment,
  seedProject,
  TEST_COMMIT_SHA,
  TEST_REPO_FULL_NAME,
  TEST_REPOSITORY_ID,
  type SeededProject,
  type TestDatabaseHandle,
} from "./helpers.js";

/** The historical source commit that is built (`$TARGET_SHA`, the deployment's sha). */
const SOURCE_SHA = TEST_COMMIT_SHA;
/** The workflow revision that runs; deliberately a *different* commit (§11.3). */
const WORKFLOW_SHA = "c".repeat(40);
/** The workflow revision after the branch moved on — used by the retry. */
const RETRY_WORKFLOW_SHA = "d".repeat(40);
const WRONG_SHA = "e".repeat(40);
const RUN_ID = "1234567890";
const RUN_ATTEMPT = 1;
/** A repository that is connected to TapeCI but is a different project. */
const OTHER_REPOSITORY_ID = 987_777;
const UNCONNECTED_REPOSITORY_ID = 999_999;

const available = await databaseAvailable();
const unavailableLabel =
  "P2 build-runs API [SKIPPED: PostgreSQL is unreachable; the suite needs the shared " +
  "PG service on 127.0.0.1:55432 (TAPECI_TEST_DATABASE_URL)]";

const env: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: "test-session-secret-123456",
  devAuth: true,
  objectStoreDir: ".tapeci/objects",
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: "test-webhook-secret",
  githubOidcAudience: "tapeci-artifact-upload",
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
  operatorPrivateKey: null,
  writeRpcUrl: null,
  journalDir: ".tapeci/journal",
  githubAppSlug: null,
  githubOAuthClientId: null,
  githubOAuthClientSecret: null,
  githubOAuthBaseUrl: "https://github.com",
  githubApiBaseUrl: "https://api.github.com",
  publicApiUrl: "http://127.0.0.1:8787",
  webUrl: "http://127.0.0.1:3000",
  sessionTtlSeconds: 604_800,
  // The audit log writes one JSON line per mutation to stdout; this suite asserts on the
  // protocol, so the noise is switched off rather than filtered.
  auditDisabled: true,
};

/** The OIDC claims for one token. `sha` is the run's head, i.e. the *workflow* revision. */
function oidcClaims(overrides: Partial<GithubOidcClaims> = {}): GithubOidcClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    issuer: env.githubOidcIssuer,
    audience: [env.githubOidcAudience],
    repository: TEST_REPO_FULL_NAME,
    repositoryId: TEST_REPOSITORY_ID,
    repositoryOwnerId: 424_242,
    repositoryOwner: "octocat",
    ref: "refs/heads/main",
    // A `workflow_dispatch` on the branch runs the branch head's workflow, which is a
    // different commit from the historical source this attempt builds.
    sha: WORKFLOW_SHA,
    workflowRef: `${TEST_REPO_FULL_NAME}/.github/workflows/tapeci.yml@refs/heads/main`,
    workflowSha: WORKFLOW_SHA,
    runId: RUN_ID,
    issuedAt: now,
    notBefore: now,
    expiresAt: now + 600,
    claims: { run_attempt: RUN_ATTEMPT },
    ...overrides,
  };
}

function jsonObject(response: LightMyRequestResponse): Record<string, unknown> {
  const body = response.json();
  expect(body).toBeTypeOf("object");
  expect(body).not.toBeNull();
  return body as Record<string, unknown>;
}

function errorCodeOf(response: LightMyRequestResponse): string {
  const body = jsonObject(response) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

function errorDetailsOf(response: LightMyRequestResponse): Record<string, unknown> {
  const body = jsonObject(response) as { error?: { details?: Record<string, unknown> } };
  return body.error?.details ?? {};
}

describe.skipIf(!available)(available ? "P2 §11.3 build-run protocol" : unavailableLabel, () => {
  let handle: TestDatabaseHandle;
  let db: Database;
  let app: FastifyInstance;
  let seeded: SeededProject;
  let otherProjectId = "";
  /** token string → the claims `deps.verifyOidc` answers with. No GitHub call is made. */
  const tokens = new Map<string, GithubOidcClaims>();
  let dispatchCount = 0;

  const github: BuildDispatchGithub = {
    installationToken: async () => "ghs_test_installation_token",
    // The workflow that will run is resolved from the ref, never guessed from the target.
    resolveRefSha: async () => WORKFLOW_SHA,
    dispatchWorkflow: async () => {
      dispatchCount += 1;
      return { dispatched: true, status: 204 };
    },
    findWorkflowRun: async () => null,
  };

  beforeAll(async () => {
    handle = await createMigratedTestDatabase();
    db = handle.db;
    seeded = await seedProject(db);

    // A second, genuinely connected project: the OIDC cross-repository test needs a
    // repository that *does* resolve to a project, or it would only prove the 403 branch.
    const [other] = await db
      .insert(projects)
      .values({
        ownerUserId: seeded.ownerUserId,
        githubInstallationId: seeded.installationRowId,
        githubRepositoryId: OTHER_REPOSITORY_ID,
        repoFullName: "octocat/other",
        defaultBranch: "main",
        containerId: seeded.containerId,
        buildEnabled: true,
      })
      .returning({ id: projects.id });
    if (other === undefined) throw new Error("failed to seed the second project");
    otherProjectId = other.id;

    tokens.set("token-main", oidcClaims());
    tokens.set("token-retry", oidcClaims({ workflowSha: RETRY_WORKFLOW_SHA, sha: RETRY_WORKFLOW_SHA }));
    tokens.set("token-other-repo", oidcClaims({ repositoryId: OTHER_REPOSITORY_ID, repository: "octocat/other" }));
    tokens.set(
      "token-unconnected",
      oidcClaims({ repositoryId: UNCONNECTED_REPOSITORY_ID, repository: "octocat/elsewhere" }),
    );
    tokens.set("token-wrong-workflow", oidcClaims({ workflowSha: WRONG_SHA }));

    const deps: ApiDeps = {
      db,
      env,
      dispatchGithub: github,
      verifyOidc: async (token) => {
        const claims = tokens.get(token);
        if (claims === undefined) throw new Error(`unexpected OIDC token in test: ${token}`);
        return claims;
      },
    };
    app = buildApp(deps);
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** A deployment for `commitSha`, dispatched through the real trigger, plus its attempt. */
  async function dispatchAttempt(): Promise<{
    readonly deploymentId: string;
    readonly attemptId: string;
    readonly correlationId: string;
  }> {
    const deploymentId = await seedDeployment(db, seeded, SOURCE_SHA);
    const outcome = await dispatchDeploymentBuild({ db, github }, { deploymentId });
    if (outcome.kind !== "dispatched") {
      throw new Error(`expected a dispatched attempt, got ${outcome.kind}`);
    }
    return {
      deploymentId,
      attemptId: outcome.attemptId,
      // `dispatchDeploymentBuild`'s default durable idempotency key (§11.3).
      correlationId: `deployment:${deploymentId}`,
    };
  }

  async function attemptRow(attemptId: string): Promise<typeof buildAttempts.$inferSelect> {
    const [row] = await db.select().from(buildAttempts).where(eq(buildAttempts.id, attemptId)).limit(1);
    if (row === undefined) throw new Error(`build attempt ${attemptId} is missing`);
    return row;
  }

  async function attemptEventCount(attemptId: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deploymentEvents)
      .where(sql`${deploymentEvents.payload} ->> 'attemptId' = ${attemptId}`);
    return row?.count ?? 0;
  }

  /** The attempt's transitions in the order they were written. */
  async function attemptEventTypes(attemptId: string): Promise<readonly string[]> {
    const rows = await db
      .select({ eventType: deploymentEvents.eventType })
      .from(deploymentEvents)
      .where(sql`${deploymentEvents.payload} ->> 'attemptId' = ${attemptId}`)
      .orderBy(deploymentEvents.id);
    return rows.map((row) => row.eventType);
  }

  function postContext(
    token: string,
    payload: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "POST",
      url: "/v1/builds/context",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload,
    });
  }

  function postEvent(
    token: string,
    payload: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "POST",
      url: "/v1/builds/events",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload,
    });
  }

  /** The event body a real workflow sends: run identity plus the attempt it echoes back. */
  function eventBody(
    correlationId: string,
    status: "started" | "failed" | "succeeded",
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      phase: "run",
      status,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      correlationId,
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // (a) start/fail 回报
  // -------------------------------------------------------------------------

  it("applies a started and a failed report and never leaves a failed attempt running", async () => {
    const { attemptId, correlationId } = await dispatchAttempt();
    expect((await attemptRow(attemptId)).state).toBe("dispatched");

    const started = await postEvent("token-main", eventBody(correlationId, "started"));
    expect(started.statusCode).toBe(200);
    expect(jsonObject(started)).toMatchObject({
      attemptId,
      state: "running",
      applied: true,
      duplicate: false,
      finishedAt: null,
    });
    expect((await attemptRow(attemptId)).state).toBe("running");

    const failed = await postEvent("token-main", eventBody(correlationId, "failed"));
    expect(failed.statusCode).toBe(200);
    const failedBody = jsonObject(failed);
    expect(failedBody).toMatchObject({ attemptId, state: "failed", applied: true, duplicate: false });
    // The transition, not just the response: the row is terminal and carries its finish time.
    const row = await attemptRow(attemptId);
    expect(row.state).toBe("failed");
    expect(row.finishedAt).not.toBeNull();
    expect(failedBody["finishedAt"]).toBe(row.finishedAt?.toISOString());
    // `build_attempts_terminal_check`: a finished attempt is never left live.
    expect(["succeeded", "failed", "canceled"]).toContain(row.state);
  });

  it("still accepts a report for an attempt whose project was disabled mid-flight", async () => {
    // AC-P4-20 / issue P4-11: `BUILD_DISABLED` is an admission switch on `/context`. Refusing
    // a failure *report* would strand a dispatched attempt live forever, so events are not
    // gated by it — while the context endpoint still is.
    const { attemptId, correlationId } = await dispatchAttempt();
    try {
      await db.update(projects).set({ buildEnabled: false }).where(eq(projects.id, seeded.projectId));

      const refusedContext = await postContext("token-main", {
        repository: TEST_REPO_FULL_NAME,
        headSha: WORKFLOW_SHA,
        correlationId,
      });
      expect(refusedContext.statusCode).toBe(403);
      expect(errorCodeOf(refusedContext)).toBe("BUILD_DISABLED");

      const reported = await postEvent("token-main", eventBody(correlationId, "failed"));
      expect(reported.statusCode).toBe(200);
      expect(jsonObject(reported)).toMatchObject({ attemptId, state: "failed", applied: true });
      expect((await attemptRow(attemptId)).state).toBe("failed");
    } finally {
      await db.update(projects).set({ buildEnabled: true }).where(eq(projects.id, seeded.projectId));
    }
  });

  // -------------------------------------------------------------------------
  // (b) 确定 SHA/config
  // -------------------------------------------------------------------------

  it("serves the stored commit, config version and commands, and ignores targetSha/projectId/configVersion in the body", async () => {
    const { attemptId, correlationId } = await dispatchAttempt();
    const stored = await attemptRow(attemptId);

    const response = await postContext("token-main", {
      repository: TEST_REPO_FULL_NAME,
      headSha: WORKFLOW_SHA,
      correlationId,
      // Everything below is a client assertion that must not become an input.
      targetSha: SOURCE_SHA,
      projectId: otherProjectId,
      configVersion: 99,
    });
    expect(response.statusCode).toBe(200);
    const body = jsonObject(response);
    expect(body).toMatchObject({
      attemptId,
      // The project comes from the token's repository, never from the body.
      projectId: seeded.projectId,
      commitSha: SOURCE_SHA,
      configVersion: stored.configVersion,
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDirectory: "dist",
    });

    // A body `targetSha` that disagrees is a 409 against the stored value, never a retarget.
    const mismatched = await postContext("token-main", {
      repository: TEST_REPO_FULL_NAME,
      correlationId,
      targetSha: WRONG_SHA,
    });
    expect(mismatched.statusCode).toBe(409);
    expect(errorCodeOf(mismatched)).toBe("TARGET_SHA_MISMATCH");
    const afterMismatch = await attemptRow(attemptId);
    expect(afterMismatch.commitSha).toBe(SOURCE_SHA);
    expect(afterMismatch.state).toBe("dispatched");
  });

  it("keeps serving the attempt's frozen configuration after the console saves a newer one", async () => {
    const { attemptId, correlationId } = await dispatchAttempt();
    const before = await attemptRow(attemptId);
    try {
      // A real console edit: new commands and a new `config_version` (§11.3, P4-14).
      await db
        .update(projects)
        .set({ buildCommand: "npm run build:v2", configVersion: before.configVersion + 1 })
        .where(eq(projects.id, seeded.projectId));

      const response = await postContext("token-main", {
        repository: TEST_REPO_FULL_NAME,
        headSha: WORKFLOW_SHA,
        correlationId,
      });
      expect(response.statusCode).toBe(200);
      // AC-P4-10: the attempt serves what it was dispatched with, not "whatever the
      // console says now", and `configChanged` reports the divergence instead.
      expect(jsonObject(response)).toMatchObject({
        configVersion: before.configVersion,
        buildCommand: "npm run build",
        configChanged: true,
      });
    } finally {
      await db
        .update(projects)
        .set({ buildCommand: "npm run build", configVersion: before.configVersion })
        .where(eq(projects.id, seeded.projectId));
    }
  });

  // -------------------------------------------------------------------------
  // (c) OIDC run 关联
  // -------------------------------------------------------------------------

  it("authorises by OIDC claims and refuses a token that cannot reach this attempt", async () => {
    const { attemptId, correlationId } = await dispatchAttempt();

    const anonymous = await app.inject({
      method: "POST",
      url: "/v1/builds/context",
      headers: { "content-type": "application/json" },
      payload: { correlationId },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(errorCodeOf(anonymous)).toBe("AUTH_REQUIRED");

    // A connected *other* project's token, naming this attempt explicitly: the attempt is
    // resolved inside the token's own project, so it must not be visible from there.
    const crossProject = await postContext("token-other-repo", {
      repository: "octocat/other",
      headSha: WORKFLOW_SHA,
      attemptId,
    });
    expect(crossProject.statusCode).toBe(404);
    expect(errorCodeOf(crossProject)).toBe("ATTEMPT_NOT_FOUND");

    const unconnected = await postContext("token-unconnected", {
      repository: "octocat/elsewhere",
      headSha: WORKFLOW_SHA,
      correlationId,
    });
    expect(unconnected.statusCode).toBe(403);
    expect(errorCodeOf(unconnected)).toBe("REPOSITORY_NOT_AUTHORIZED");

    // A forged body `repository` is a 409 against the signed claim, not a redirect.
    const forgedRepository = await postContext("token-main", {
      repository: "octocat/other",
      correlationId,
    });
    expect(forgedRepository.statusCode).toBe(409);
    expect(errorCodeOf(forgedRepository)).toBe("BUILD_CONTEXT_MISMATCH");

    // None of the refusals touched the attempt.
    expect((await attemptRow(attemptId)).state).toBe("dispatched");
    expect((await attemptRow(attemptId)).commitSha).toBe(SOURCE_SHA);
  });

  // -------------------------------------------------------------------------
  // (d) 同 SHA 新 attempt
  // -------------------------------------------------------------------------

  it("retries the same SHA as a new attempt with retryOf, not as a second dispatch of the old one", async () => {
    const { deploymentId, attemptId, correlationId } = await dispatchAttempt();
    expect((await postEvent("token-main", eventBody(correlationId, "started"))).statusCode).toBe(200);
    expect((await postEvent("token-main", eventBody(correlationId, "failed"))).statusCode).toBe(200);
    const finished = await attemptRow(attemptId);
    expect(finished.state).toBe("failed");

    const dispatchesBeforeRetry = dispatchCount;
    const retried = await retryBuildAttempt(
      { db },
      {
        previousAttemptId: attemptId,
        dispatchCorrelationId: `retry:${deploymentId}`,
        // Re-resolved before the new dispatch, and legitimately different from the old one.
        workflowCommitSha: RETRY_WORKFLOW_SHA,
      },
    );
    expect(retried.id).not.toBe(attemptId);
    expect(retried.retryOf).toBe(attemptId);
    expect(retried.attempt).toBe(finished.attempt + 1);
    // A retry is the same source revision by definition.
    expect(retried.commitSha).toBe(SOURCE_SHA);
    expect(retried.workflowCommitSha).toBe(RETRY_WORKFLOW_SHA);
    expect(retried.state).toBe("planned");
    // The retry *reserves* the new attempt; it does not dispatch it. A second dispatch of
    // the old attempt would show up here as an extra call.
    expect(dispatchCount).toBe(dispatchesBeforeRetry);

    // The previous attempt is not rewritten: its outcome and finish time stand.
    const previousAfter = await attemptRow(attemptId);
    expect(previousAfter.state).toBe("failed");
    expect(previousAfter.finishedAt?.toISOString()).toBe(finished.finishedAt?.toISOString());
    expect(previousAfter.dispatchCorrelationId).toBe(correlationId);

    const rows = await db
      .select({ id: buildAttempts.id })
      .from(buildAttempts)
      .where(eq(buildAttempts.deploymentId, deploymentId));
    expect(rows).toHaveLength(2);

    // Re-triggering the same deployment is a replay of the original dispatch: it returns
    // the stored attempt instead of dispatching a third one.
    const replay = await dispatchDeploymentBuild({ db, github }, { deploymentId });
    if (replay.kind !== "dispatched") throw new Error(`expected a replay, got ${replay.kind}`);
    expect(replay.attemptId).toBe(attemptId);
    // The replay is answered from the stored attempt: nothing is dispatched again.
    expect(dispatchCount).toBe(dispatchesBeforeRetry);
    const afterReplay = await db
      .select({ id: buildAttempts.id })
      .from(buildAttempts)
      .where(eq(buildAttempts.deploymentId, deploymentId));
    expect(afterReplay).toHaveLength(2);

    // Reusing the previous correlation id would name one dispatch twice — refused.
    await expect(
      retryBuildAttempt(
        { db },
        {
          previousAttemptId: attemptId,
          dispatchCorrelationId: correlationId,
          workflowCommitSha: RETRY_WORKFLOW_SHA,
        },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    // Only a finished attempt may be retried; a live one would put two runs behind it.
    await expect(
      retryBuildAttempt(
        { db },
        {
          previousAttemptId: retried.id,
          dispatchCorrelationId: `retry-again:${deploymentId}`,
          workflowCommitSha: RETRY_WORKFLOW_SHA,
        },
      ),
    ).rejects.toMatchObject({ code: "ATTEMPT_STATE_CONFLICT" });
  });

  // -------------------------------------------------------------------------
  // (e) 重复 callback
  // -------------------------------------------------------------------------

  it("applies a repeated callback once: one transition, no re-dated finishedAt", async () => {
    const { attemptId, correlationId } = await dispatchAttempt();
    expect((await postEvent("token-main", eventBody(correlationId, "started"))).statusCode).toBe(200);

    const first = await postEvent("token-main", eventBody(correlationId, "failed"));
    expect(first.statusCode).toBe(200);
    const firstBody = jsonObject(first);
    expect(firstBody).toMatchObject({ state: "failed", applied: true, duplicate: false });
    const finishedAt = firstBody["finishedAt"];
    const afterFirst = await attemptRow(attemptId);
    const eventsAfterFirst = await attemptEventCount(attemptId);
    // One row per transition: the dispatch, the start and the failure. Not two failures.
    expect(await attemptEventTypes(attemptId)).toEqual([
      "build_attempt_dispatched",
      "build_attempt_running",
      "build_attempt_failed",
    ]);
    expect(eventsAfterFirst).toBe(3);

    // The same callback again: acknowledged, but nothing is written a second time.
    const replay = await postEvent("token-main", eventBody(correlationId, "failed"));
    expect(replay.statusCode).toBe(200);
    expect(jsonObject(replay)).toMatchObject({
      attemptId,
      state: "failed",
      applied: false,
      duplicate: true,
      finishedAt,
    });

    const afterReplay = await attemptRow(attemptId);
    expect(afterReplay.state).toBe("failed");
    expect(afterReplay.finishedAt?.toISOString()).toBe(afterFirst.finishedAt?.toISOString());
    // A duplicate writes *nothing at all*: not even `updated_at`.
    expect(afterReplay.updatedAt.toISOString()).toBe(afterFirst.updatedAt.toISOString());
    expect(await attemptEventCount(attemptId)).toBe(eventsAfterFirst);

    // A late `started` for a closed attempt is a conflict, not a silent reopen.
    const lateStart = await postEvent("token-main", eventBody(correlationId, "started"));
    expect(lateStart.statusCode).toBe(409);
    expect(errorCodeOf(lateStart)).toBe("ATTEMPT_STATE_CONFLICT");
    expect((await attemptRow(attemptId)).state).toBe("failed");
  });

  // -------------------------------------------------------------------------
  // (f) 历史 checkout SHA 与 workflow SHA 区分
  // -------------------------------------------------------------------------

  it("stores and returns the target SHA and the workflow SHA as two different identities", async () => {
    const { attemptId, correlationId } = await dispatchAttempt();
    const stored = await attemptRow(attemptId);
    // Two columns, two values: the historical source that is built and the workflow that
    // runs. Collapsing them (a quiet `??`) is exactly what AC-P4-14 forbids.
    expect(stored.commitSha).toBe(SOURCE_SHA);
    expect(stored.workflowCommitSha).toBe(WORKFLOW_SHA);
    expect(stored.commitSha).not.toBe(stored.workflowCommitSha);

    const response = await postContext("token-main", {
      repository: TEST_REPO_FULL_NAME,
      headSha: WORKFLOW_SHA,
      correlationId,
    });
    expect(response.statusCode).toBe(200);
    const body = jsonObject(response);
    expect(body["commitSha"]).toBe(SOURCE_SHA);
    expect(body["workflowCommitSha"]).toBe(WORKFLOW_SHA);
    expect(body["commitSha"]).not.toBe(body["workflowCommitSha"]);

    // The run's own sha (the token's `sha`, which the workflow echoes as `headSha`) is the
    // *workflow* commit. Resolving by it alone must not find — or worse, rewrite — the
    // historical target: that is why the correlation id, not the run sha, names the attempt.
    const byRunShaOnly = await postContext("token-main", {
      repository: TEST_REPO_FULL_NAME,
      headSha: WORKFLOW_SHA,
    });
    expect(byRunShaOnly.statusCode).toBe(404);
    expect(errorCodeOf(byRunShaOnly)).toBe("ATTEMPT_NOT_FOUND");

    // A body claiming the workflow commit is the built target is refused.
    const retarget = await postContext("token-main", {
      repository: TEST_REPO_FULL_NAME,
      headSha: WORKFLOW_SHA,
      attemptId,
      commitSha: WORKFLOW_SHA,
    });
    expect(retarget.statusCode).toBe(409);
    expect(errorCodeOf(retarget)).toBe("TARGET_SHA_MISMATCH");

    // A body cannot set the workflow SHA either.
    const forgedWorkflowSha = await postEvent("token-main", {
      ...eventBody(correlationId, "started"),
      workflowCommitSha: WRONG_SHA,
    });
    expect(forgedWorkflowSha.statusCode).toBe(409);
    expect(errorCodeOf(forgedWorkflowSha)).toBe("BUILD_CONTEXT_MISMATCH");
    expect(errorDetailsOf(forgedWorkflowSha)["reason"]).toBe("workflow_sha_mismatch");

    // Nor can a token issued for another workflow revision: the identity is signed.
    const wrongWorkflowToken = await postContext("token-wrong-workflow", {
      repository: TEST_REPO_FULL_NAME,
      // The body `headSha` must still be the token's own `sha`; the mismatch under test is
      // the workflow identity, not the head.
      headSha: WORKFLOW_SHA,
      correlationId,
    });
    expect(wrongWorkflowToken.statusCode).toBe(409);
    expect(errorCodeOf(wrongWorkflowToken)).toBe("BUILD_CONTEXT_MISMATCH");
    expect(errorDetailsOf(wrongWorkflowToken)["reason"]).toBe("workflow_sha_mismatch");

    // Nothing above moved the attempt or its two SHAs.
    const after = await attemptRow(attemptId);
    expect(after.state).toBe("dispatched");
    expect(after.commitSha).toBe(SOURCE_SHA);
    expect(after.workflowCommitSha).toBe(WORKFLOW_SHA);
  });
});
