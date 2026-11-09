/**
 * The dispatch trigger: turns an admitted deployment into a build attempt and asks
 * GitHub to run the workflow for it (SPEC §11.2, §11.3).
 *
 * The order is fixed and matters:
 *
 *   1. resolve the workflow revision (`workflowCommitSha`) — a *different* identity
 *      from the target source commit, and one the platform must never guess;
 *   2. write the attempt, so an ambiguous dispatch is still recoverable;
 *   3. dispatch, and treat "we do not know" as unknown rather than as failure;
 *   4. reconcile an unknown dispatch against the authenticated run API before ever
 *      concluding anything, and never re-dispatch inside this function.
 *
 * Nothing here retries a dispatch. A caller that wants a retry must go through
 * `retryBuildAttempt`, which creates a new attempt with `retryOf` set.
 */
import type { Database } from "@tapeci/database";
import {
  dispatchWorkflow,
  findWorkflowRun,
  getInstallationToken,
  resolveRefSha,
  type DispatchWorkflowResult,
  type GitHubAppConfig,
  type WorkflowRunIdentity,
} from "@tapeci/github";
import { and, eq, isNull } from "drizzle-orm";
import {
  deployments,
  githubInstallations,
  projects,
  type BuildAttempt,
} from "@tapeci/database";
import { ApiError } from "./errors.js";
import {
  createBuildAttempt,
  reconcileDispatch,
  recordAttemptState,
  type BuildConfigSnapshot,
} from "./build-attempts.js";

/** Where the platform's own workflow lives. The console may not override this. */
export const TAPECI_WORKFLOW_FILE = ".github/workflows/tapeci.yml";

/** The GitHub operations this module needs, so tests never touch the network. */
export interface BuildDispatchGithub {
  readonly resolveRefSha: (input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly ref: string;
  }) => Promise<string | null>;
  readonly dispatchWorkflow: (input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly workflowFile: string;
    readonly ref: string;
    readonly inputs: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }) => Promise<DispatchWorkflowResult>;
  readonly findWorkflowRun: (input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly headSha: string;
    readonly workflowFile: string;
    readonly createdAfter?: Date;
  }) => Promise<WorkflowRunIdentity | null>;
  readonly installationToken: (installationId: number) => Promise<string>;
}

export interface BuildDispatchDeps {
  readonly db: Database;
  readonly now?: () => Date;
  /** Injectable GitHub surface; production builds it from the App credentials. */
  readonly github?: BuildDispatchGithub;
  /** App credentials, only needed to build the default `github` surface. */
  readonly appConfig?: () => GitHubAppConfig | null;
}

export interface DispatchDeploymentInput {
  readonly deploymentId: string;
  /**
   * Durable idempotency key. Defaults to a per-deployment key, so a duplicate trigger
   * for the same deployment returns the attempt that already exists instead of
   * dispatching twice.
   */
  readonly correlationId?: string;
}

export type DispatchOutcome =
  | {
      readonly kind: "dispatched";
      readonly attemptId: string;
      readonly runId: string | null;
    }
  | {
      /** Dispatched, but GitHub did not confirm it. Recoverable, never a failure. */
      readonly kind: "unknown";
      readonly attemptId: string;
      readonly detail: string;
    }
  | {
      readonly kind: "skipped";
      readonly attemptId: string | null;
      readonly reason:
        | "build_disabled"
        | "workflow_revision_unresolved"
        | "no_installation"
        | "no_app_credentials";
      readonly detail: string;
    };

export async function dispatchDeploymentBuild(
  deps: BuildDispatchDeps,
  input: DispatchDeploymentInput,
): Promise<DispatchOutcome> {
  const github = deps.github ?? defaultGithub(deps);
  const now = deps.now?.() ?? new Date();

  const context = await loadContext(deps, input.deploymentId);

  // Re-check admission here as well: the webhook gate decides what becomes a
  // deployment, but a project can be disabled between the push and this call, and a
  // deployment must not become a build after someone turned builds off (§11.2).
  if (!context.buildEnabled) {
    return {
      kind: "skipped",
      attemptId: null,
      reason: "build_disabled",
      detail: "builds are not enabled for this project; nothing was dispatched",
    };
  }
  if (context.installationId === null) {
    return {
      kind: "skipped",
      attemptId: null,
      reason: "no_installation",
      detail: "the GitHub App installation for this repository is gone",
    };
  }

  const token = await github.installationToken(context.installationId);

  // §11.3: the workflow revision is its own identity. Resolve it before the attempt is
  // written, because the attempt's whole purpose is to record what will actually run.
  const workflowCommitSha = await github.resolveRefSha({
    token,
    owner: context.owner,
    repo: context.repo,
    ref: context.ref,
  });
  if (workflowCommitSha === null) {
    return {
      kind: "skipped",
      attemptId: null,
      reason: "workflow_revision_unresolved",
      detail: `the ref ${context.ref} did not resolve to a commit; no attempt was written`,
    };
  }

  const correlationId = input.correlationId ?? `deployment:${input.deploymentId}`;
  const attempt: BuildAttempt = await createBuildAttempt(
    { db: deps.db, now: () => now },
    {
      deploymentId: input.deploymentId,
      commitSha: context.commitSha,
      workflowCommitSha,
      dispatchCorrelationId: correlationId,
      configVersion: context.configVersion,
      configSnapshot: context.configSnapshot,
    },
  );

  // A replay of this trigger finds the attempt already dispatched: report it rather
  // than dispatching a second time.
  if (attempt.state !== "planned") {
    return { kind: "dispatched", attemptId: attempt.id, runId: null };
  }

  const result = await github.dispatchWorkflow({
    token,
    owner: context.owner,
    repo: context.repo,
    workflowFile: TAPECI_WORKFLOW_FILE,
    ref: context.ref,
    inputs: {
      // Data for the workflow to echo back, never a credential (§11.3).
      correlationId,
      targetSha: context.commitSha,
      attemptId: attempt.id,
    },
    idempotencyKey: correlationId,
  });

  if (result.dispatched) {
    await recordAttemptState(
      { db: deps.db, now: () => now },
      { attemptId: attempt.id, state: "dispatched" },
    );
    // The run id is not known until the run exists; the event/context path records it.
    return { kind: "dispatched", attemptId: attempt.id, runId: null };
  }

  if (result.reason === "already_dispatched") {
    return { kind: "dispatched", attemptId: attempt.id, runId: null };
  }

  // Unknown: ask the authenticated run API before concluding anything, exactly once.
  // No loop, no re-dispatch (§11.3).
  const run = await github.findWorkflowRun({
    token,
    owner: context.owner,
    repo: context.repo,
    headSha: workflowCommitSha,
    workflowFile: TAPECI_WORKFLOW_FILE,
    createdAfter: new Date(attempt.createdAt),
  });
  const reconciled = await reconcileDispatch(
    { db: deps.db, now: () => now },
    {
      attemptId: attempt.id,
      run:
        run === null
          ? null
          : { runId: run.runId, runAttempt: run.runAttempt, outcome: "queued" },
    },
  );
  if (reconciled.state === "dispatched" || reconciled.state === "running") {
    // `reconciled` proves the run exists, but the run id lives on the attempt row's
    // own columns; the event/context path records it when GitHub reports the run.
    return { kind: "dispatched", attemptId: attempt.id, runId: null };
  }
  return {
    kind: "unknown",
    attemptId: attempt.id,
    detail:
      "GitHub did not confirm the dispatch and no run was visible yet; the attempt is " +
      "recoverable and will be reconciled rather than re-dispatched",
  };
}

interface DispatchContext {
  readonly commitSha: string;
  readonly buildEnabled: boolean;
  readonly configVersion: number;
  readonly configSnapshot: BuildConfigSnapshot;
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly installationId: number | null;
}

async function loadContext(
  deps: BuildDispatchDeps,
  deploymentId: string,
): Promise<DispatchContext> {
  const [row] = await deps.db
    .select({
      commitSha: deployments.commitSha,
      buildEnabled: projects.buildEnabled,
      configVersion: projects.configVersion,
      installCommand: projects.installCommand,
      buildCommand: projects.buildCommand,
      outputDirectory: projects.outputDirectory,
      repoFullName: projects.repoFullName,
      defaultBranch: projects.defaultBranch,
      installationNumericId: githubInstallations.installationId,
    })
    .from(deployments)
    .innerJoin(projects, eq(projects.id, deployments.projectId))
    .leftJoin(
      githubInstallations,
      and(
        eq(githubInstallations.id, projects.githubInstallationId),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (row === undefined) {
    throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "deployment not found");
  }
  const [owner, repo] = row.repoFullName.split("/");
  if (owner === undefined || repo === undefined) {
    // A malformed stored name is a data fault, not a user error.
    throw new ApiError(500, "INTERNAL", "the project's repository name is malformed");
  }
  return {
    commitSha: row.commitSha,
    buildEnabled: row.buildEnabled,
    configVersion: row.configVersion,
    configSnapshot: {
      installCommand: row.installCommand,
      buildCommand: row.buildCommand,
      outputDirectory: row.outputDirectory,
    },
    owner,
    repo,
    ref: row.defaultBranch,
    installationId: row.installationNumericId,
  };
}

/**
 * The production GitHub surface. Built lazily so a test never needs App credentials,
 * and so a missing credential is a clear refusal rather than a network attempt.
 */
function defaultGithub(deps: BuildDispatchDeps): BuildDispatchGithub {
  const config = deps.appConfig?.() ?? null;
  if (config === null) {
    throw new ApiError(
      503,
      "GITHUB_APP_NOT_CONFIGURED",
      "GitHub App credentials are required to dispatch a build",
      {},
      true,
    );
  }
  return {
    resolveRefSha: (input) => resolveRefSha({ ...config, ...input }),
    dispatchWorkflow: (input) => dispatchWorkflow({ ...config, ...input }),
    findWorkflowRun: (input) => findWorkflowRun({ ...config, ...input }),
    installationToken: async (installationId) =>
      (await getInstallationToken({ ...config, installationId })).token,
  };
}
