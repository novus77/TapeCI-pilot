/**
 * P4 task 4 — the SPEC §11.3 build protocol.
 *
 * `POST /v1/builds/context` hands a dispatched GitHub Actions run the configuration the
 * operator saved, and `POST /v1/builds/events` closes the attempt state machine from
 * authenticated run/job/attempt transitions.
 *
 * Authority model (§11.3, AC-P4-13…AC-P4-15)
 * ------------------------------------------
 * - The GitHub Actions OIDC token is the only authority. The project is resolved from the
 *   token's `repository_id`; a `projectId` in either request body is never read, so it can
 *   never authorise — or widen — anything.
 * - The target SHA, `configVersion` and `configSnapshot` are the values the server saved on
 *   the attempt *before* dispatch. A body `targetSha` is only an assertion to be compared
 *   with the stored `commitSha`: a mismatch is a 409, never an override, and it is never a
 *   lookup key. A body `headSha` is compared with the token's `sha`, which is the
 *   authenticated value.
 * - `commit_sha` (the source that is built) and `workflow_commit_sha` (the workflow that
 *   runs) are two identities. The token's `workflow_sha` must equal the stored
 *   `workflow_commit_sha`, and the token's `sha` is never treated as the built source: a
 *   branch-history build legitimately runs a newer workflow against an older source commit
 *   (AC-P4-14), so resolving "by run sha" alone would be wrong for exactly that case.
 * - A `dispatchCorrelationId` lets the dispatched workflow name the attempt it was
 *   dispatched for (§11.3 "传入关联标识"). It is a key into the token's own project, never a
 *   credential: the repository, the workflow revision and — for events — the run identity
 *   must still match, and it cannot reach another project's attempt.
 *
 * Idempotency
 * -----------
 * An event that resolves to the state the attempt already has is a no-op that writes
 * nothing: no second transition, no `finished_at`, no duplicate event row. A transition
 * the table below forbids is a 409, never a silent overwrite. Read-classify-apply happens
 * under one row lock, so two concurrent deliveries of the same event cannot both apply.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  buildAttempts,
  deploymentEvents,
  deployments,
  projects,
  type BuildAttempt,
  type Project,
} from "@tapeci/database";
import { verifyGitHubOidc, type GithubOidcClaims } from "@tapeci/github";
import type { TapeCiErrorCode } from "@tapeci/shared";
import type { ApiDeps } from "../deps.js";
import { UUID_PATTERN } from "../audit.js";
import { ApiError } from "../errors.js";
import { recordBody } from "../validation.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** GitHub run ids are decimal integers; kept as strings and never parsed into a float. */
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const MAX_FIELD_LENGTH = 255;

// ---------------------------------------------------------------------------
// §13 build-protocol error codes
// ---------------------------------------------------------------------------

/**
 * SPEC §13's 构建 row names `BUILD_DISABLED`, which is already in `TapeCiErrorCode`; the four
 * codes below it carry this protocol's attempt/mismatch semantics and are not in the shared
 * union yet. Widening `TapeCiErrorCode` is the integration lead's edit (it is shared with the
 * web app and the issue log), so the cast is confined to this one constructor instead of
 * being repeated at every throw site. Adding these four to the union makes the cast a no-op
 * that can then be deleted:
 *
 *   | "ATTEMPT_NOT_FOUND" | "TARGET_SHA_MISMATCH"
 *   | "BUILD_CONTEXT_MISMATCH" | "ATTEMPT_STATE_CONFLICT"
 */
type BuildProtocolErrorCode =
  | "BUILD_DISABLED"
  | "ATTEMPT_NOT_FOUND"
  | "TARGET_SHA_MISMATCH"
  | "BUILD_CONTEXT_MISMATCH"
  | "ATTEMPT_STATE_CONFLICT";

function buildError(
  statusCode: number,
  code: BuildProtocolErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ApiError {
  // No cast: `BuildProtocolErrorCode` is a subset of the shared union, and letting
  // this fail to compile is how a new code gets caught before it ships untyped.
  const shared: TapeCiErrorCode = code;
  return new ApiError(statusCode, shared, message, details);
}

// ---------------------------------------------------------------------------
// The attempt state machine (§11.3)
// ---------------------------------------------------------------------------

export const BUILD_ATTEMPT_STATES = [
  "planned",
  "dispatched",
  "dispatch_unknown",
  "running",
  "succeeded",
  "failed",
  "canceled",
] as const;

export type BuildAttemptState = (typeof BUILD_ATTEMPT_STATES)[number];

/**
 * `planned → dispatched` is the save-before-dispatch row being accepted by GitHub;
 * `dispatch_unknown` is "GitHub may have accepted it — re-read the run instead of
 * dispatching again" and may be resolved either way by a later verified event.
 *
 * A run can report a terminal outcome without the platform ever observing `started`, so
 * every live state may move straight to a terminal one. The reverse is forbidden: it would
 * reopen an attempt whose outcome is already recorded, and a same-SHA retry is a new
 * attempt with `retryOf`, never a rewrite of this one (§11.3, AC-P4-11).
 */
const ALLOWED_ATTEMPT_TRANSITIONS: Readonly<
  Record<BuildAttemptState, readonly BuildAttemptState[]>
> = {
  planned: ["dispatched", "dispatch_unknown", "running", "succeeded", "failed", "canceled"],
  dispatched: ["running", "succeeded", "failed", "canceled"],
  dispatch_unknown: ["dispatched", "running", "succeeded", "failed", "canceled"],
  running: ["succeeded", "failed", "canceled"],
  succeeded: [],
  failed: [],
  canceled: [],
};

export type AttemptTransitionVerdict = "apply" | "duplicate" | "illegal";

/**
 * Classify a requested transition: `apply` moves the attempt, `duplicate` means it is
 * already there (the idempotent case), `illegal` is a 409 — most importantly any attempt
 * to move out of a terminal state.
 */
export function classifyAttemptTransition(
  from: BuildAttemptState,
  to: BuildAttemptState,
): AttemptTransitionVerdict {
  if (from === to) return "duplicate";
  return ALLOWED_ATTEMPT_TRANSITIONS[from].includes(to) ? "apply" : "illegal";
}

export function isTerminalAttemptState(state: BuildAttemptState): boolean {
  return state === "succeeded" || state === "failed" || state === "canceled";
}

const RUN_PHASES = ["run", "job", "attempt"] as const;
const RUN_STATUSES = ["started", "failed", "succeeded"] as const;

type RunPhase = (typeof RUN_PHASES)[number];
type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Map an observed run/job/attempt transition onto the attempt state, or `null` when the
 * event can never close the attempt.
 *
 * `job: succeeded` returns `null` on purpose: one job succeeding says nothing about the
 * others, so only the run (or attempt) level may record a terminal outcome. It is an
 * acknowledged no-op rather than an illegal transition, so a repeated or late per-job
 * success can never turn a finished build into a running one.
 */
export function attemptStateForEvent(phase: RunPhase, status: RunStatus): BuildAttemptState | null {
  if (status === "failed") return "failed";
  if (status === "succeeded") return phase === "job" ? null : "succeeded";
  return "running";
}

// ---------------------------------------------------------------------------
// Authentication (§11.3): OIDC claims are the only authority
// ---------------------------------------------------------------------------

/** Same shape as `routes/builds.ts`; local because this task may not edit that file. */
function bearer(request: {
  readonly headers: Record<string, string | string[] | undefined>;
}): string {
  const raw = request.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !value.startsWith("Bearer ")) {
    throw new ApiError(401, "AUTH_REQUIRED", "Authorization: Bearer <token> is required");
  }
  return value.slice("Bearer ".length).trim();
}

async function verifyOidc(deps: ApiDeps, token: string): Promise<GithubOidcClaims> {
  if (deps.verifyOidc !== undefined) return deps.verifyOidc(token);
  return verifyGitHubOidc(token, {
    audience: deps.env.githubOidcAudience,
    issuer: deps.env.githubOidcIssuer,
    ...(deps.env.githubOidcJwksUrl === null || deps.env.githubOidcJwksUrl === undefined
      ? {}
      : { jwksUrl: deps.env.githubOidcJwksUrl }),
  });
}

interface AuthenticatedBuild {
  readonly claims: GithubOidcClaims;
  readonly project: Project;
}

/**
 * Verify the token and resolve the project from its `repository_id`. This is the only
 * project lookup in the file: no route ever resolves a project, deployment or attempt from
 * a request body.
 */
async function authenticateBuild(
  deps: ApiDeps,
  headers: Record<string, string | string[] | undefined>,
): Promise<AuthenticatedBuild> {
  const claims = await verifyOidc(deps, bearer({ headers }));
  const [project] = await deps.db
    .select()
    .from(projects)
    .where(eq(projects.githubRepositoryId, claims.repositoryId))
    .limit(1);
  if (project === undefined) {
    throw new ApiError(
      403,
      "REPOSITORY_NOT_AUTHORIZED",
      "this repository is not connected to TapeCI",
    );
  }
  return { claims, project };
}

/**
 * §11.2 admission: a project that is not enabled serves no build context, so a workflow in
 * an un-admitted repository cannot fetch the operator's configuration. Applied to the
 * context endpoint only — `build_enabled` is an admission switch, and refusing an *event*
 * for it would strand an attempt that was already dispatched (AC-P4-20).
 */
function requireBuildEnabled(project: Project): void {
  if (project.buildEnabled) return;
  throw buildError(403, "BUILD_DISABLED", "builds are not enabled for this project", {
    projectId: project.id,
    configVersion: project.configVersion,
  });
}

/** `owner/repo` from `workflow_ref`, e.g. `owner/repo/.github/workflows/x.yml@refs/heads/main`. */
function workflowRepository(workflowRef: string): string {
  return workflowRef.split("/").slice(0, 2).join("/");
}

/**
 * The running workflow must be the version this attempt was dispatched for (AC-P4-14). A
 * token without `workflow_sha` cannot prove which workflow revision is running, so it fails
 * closed rather than being accepted on its `workflow_ref` alone.
 */
function assertWorkflowIdentity(
  claims: GithubOidcClaims,
  project: Project,
  attempt: BuildAttempt,
): void {
  if (claims.workflowSha === undefined) {
    throw buildError(
      409,
      "BUILD_CONTEXT_MISMATCH",
      "the OIDC token carries no workflow_sha, so the running workflow version cannot be verified",
      { attemptId: attempt.id, reason: "workflow_sha_claim_missing" },
    );
  }
  if (claims.workflowSha.toLowerCase() !== attempt.workflowCommitSha) {
    throw buildError(
      409,
      "BUILD_CONTEXT_MISMATCH",
      "the running workflow is not the workflow version this attempt was dispatched for",
      {
        attemptId: attempt.id,
        reason: "workflow_sha_mismatch",
        storedWorkflowCommitSha: attempt.workflowCommitSha,
      },
    );
  }
  if (workflowRepository(claims.workflowRef).toLowerCase() !== project.repoFullName.toLowerCase()) {
    throw buildError(
      409,
      "BUILD_CONTEXT_MISMATCH",
      "the workflow belongs to a different repository than this build attempt",
      { attemptId: attempt.id, reason: "workflow_repository_mismatch" },
    );
  }
}

// ---------------------------------------------------------------------------
// Body admission: the body may identify, never widen
// ---------------------------------------------------------------------------

interface AttemptMatch {
  /** Client assertion naming the attempt it believes it was dispatched for. */
  readonly attemptId: string | null;
  readonly correlationId: string | null;
  /** Client assertion of the target source revision; compared, never used to select. */
  readonly targetSha: string | null;
}

interface ContextRequest {
  readonly repository: string | null;
  /** `$GITHUB_SHA`; compared with the token's own `sha`, which is the authenticated value. */
  readonly headSha: string | null;
  readonly match: AttemptMatch;
}

interface BuildEventRequest extends AttemptMatch {
  readonly phase: RunPhase;
  readonly status: RunStatus;
  readonly runId: string;
  readonly runAttempt: number;
  readonly workflowCommitSha: string | null;
}

function optionalString(
  body: Record<string, unknown>,
  name: string,
  maxLength: number,
): string | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "INVALID_BODY", `${name} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ApiError(400, "INVALID_BODY", `${name} is too long`);
  }
  return trimmed;
}

function optionalSha(body: Record<string, unknown>, name: string): string | null {
  const value = optionalString(body, name, 40);
  if (value === null) return null;
  const normalized = value.toLowerCase();
  if (!SHA_PATTERN.test(normalized)) {
    throw new ApiError(400, "INVALID_BODY", `${name} must be a 40-character commit sha`);
  }
  return normalized;
}

function attemptMatch(body: Record<string, unknown>): AttemptMatch {
  const attemptId = optionalString(body, "attemptId", 36);
  if (attemptId !== null && !UUID_PATTERN.test(attemptId)) {
    // Checked here, not left to PostgreSQL: a non-uuid would reach a `uuid` column and
    // surface as an internal error instead of a client mistake.
    throw new ApiError(400, "INVALID_BODY", "attemptId must be a UUID");
  }
  return {
    attemptId,
    correlationId: optionalString(body, "correlationId", MAX_FIELD_LENGTH),
    // `commitSha` is accepted as an alias because the response field a workflow echoes back
    // is named `commitSha`. Both are assertions; neither selects the attempt.
    targetSha: optionalSha(body, "targetSha") ?? optionalSha(body, "commitSha"),
  };
}

/**
 * The context body may name the repository, the run's head SHA and the attempt it believes
 * it belongs to. Nothing else is read: `projectId` in particular is ignored by design, so a
 * forged one can neither authorise nor redirect the request (§11.3).
 */
function readContextRequest(rawBody: unknown): ContextRequest {
  if (rawBody === undefined || rawBody === null) {
    return {
      repository: null,
      headSha: null,
      match: { attemptId: null, correlationId: null, targetSha: null },
    };
  }
  const body = recordBody(rawBody);
  return {
    repository: optionalString(body, "repository", MAX_FIELD_LENGTH),
    headSha: optionalSha(body, "headSha"),
    match: attemptMatch(body),
  };
}

function readEventRequest(rawBody: unknown): BuildEventRequest {
  const body = recordBody(rawBody);
  const phase = body["phase"];
  if (!RUN_PHASES.includes(phase as RunPhase)) {
    throw new ApiError(400, "INVALID_BODY", `phase must be one of ${RUN_PHASES.join(", ")}`);
  }
  const status = body["status"];
  if (!RUN_STATUSES.includes(status as RunStatus)) {
    throw new ApiError(400, "INVALID_BODY", `status must be one of ${RUN_STATUSES.join(", ")}`);
  }
  const runId = optionalString(body, "runId", 32);
  if (runId === null || !RUN_ID_PATTERN.test(runId)) {
    throw new ApiError(400, "INVALID_BODY", "runId must be GitHub's numeric run id as a string");
  }
  const runAttempt = body["runAttempt"];
  if (typeof runAttempt !== "number" || !Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw new ApiError(400, "INVALID_BODY", "runAttempt must be a positive integer");
  }
  return {
    ...attemptMatch(body),
    phase: phase as RunPhase,
    status: status as RunStatus,
    runId,
    runAttempt,
    workflowCommitSha: optionalSha(body, "workflowCommitSha"),
  };
}

function assertBodyRepository(claims: GithubOidcClaims, repository: string | null): void {
  if (repository === null) return;
  if (repository.toLowerCase() !== claims.repository.toLowerCase()) {
    throw buildError(
      409,
      "BUILD_CONTEXT_MISMATCH",
      "the body names a different repository than the OIDC token",
      { reason: "repository_mismatch", tokenRepository: claims.repository },
    );
  }
}

/** A forged `headSha` is a 409 against the signed claim, not an accepted override. */
function assertBodyHeadSha(claims: GithubOidcClaims, headSha: string | null): void {
  if (headSha === null || headSha === claims.sha) return;
  throw buildError(
    409,
    "TARGET_SHA_MISMATCH",
    "the requesting sha is not the sha the OIDC token was issued for",
    { reason: "head_sha_mismatch", field: "headSha", storedCommitSha: claims.sha },
  );
}

// ---------------------------------------------------------------------------
// Attempt resolution — always scoped to the token's project
// ---------------------------------------------------------------------------

/**
 * Resolve exactly one attempt that belongs to the token's project.
 *
 * Selection order: an explicit `attemptId`, then a `dispatchCorrelationId`, then the
 * token's own `sha`. All three are constrained by a join on `deployments.project_id`, so a
 * correlation id that belongs to another project resolves to "not found" rather than
 * confirming that it exists elsewhere.
 */
async function resolveAttempt(
  deps: ApiDeps,
  project: Project,
  claims: GithubOidcClaims,
  match: AttemptMatch,
  purpose: "context" | "event",
): Promise<BuildAttempt> {
  const attempt = await findAttempt(deps, project.id, claims, match);
  if (attempt === null) {
    throw buildError(404, "ATTEMPT_NOT_FOUND", "no build attempt exists for this request", {
      ...(match.attemptId === null ? {} : { attemptId: match.attemptId }),
      ...(match.correlationId === null ? {} : { correlationId: match.correlationId }),
      headSha: claims.sha,
    });
  }
  const state = requireAttemptState(attempt);
  if (purpose === "context" && isTerminalAttemptState(state)) {
    // A finished attempt already owns its outcome, so serving its config again would let a
    // re-run rebuild under an identity that is closed. §11.3's retry is a *new* attempt with
    // `retryOf`, so the resolution never silently falls back to an older live attempt either:
    // that would rewrite which attempt this SHA currently means.
    throw buildError(409, "ATTEMPT_STATE_CONFLICT", "this build attempt already finished", {
      attemptId: attempt.id,
      state,
      reason: "attempt_finished",
      remedy: "start a new attempt for this commit",
    });
  }
  if (match.targetSha !== null && match.targetSha !== attempt.commitSha) {
    // AC-P4-13: the body cannot choose the target; the response only ever echoes the
    // server-stored sha, and the attempt row is left untouched.
    throw buildError(
      409,
      "TARGET_SHA_MISMATCH",
      "the requested target sha is not the sha this attempt was admitted for",
      { reason: "target_sha_mismatch", attemptId: attempt.id, storedCommitSha: attempt.commitSha },
    );
  }
  return attempt;
}

async function findAttempt(
  deps: ApiDeps,
  projectId: string,
  claims: GithubOidcClaims,
  match: AttemptMatch,
): Promise<BuildAttempt | null> {
  const base = deps.db
    .select({ attempt: buildAttempts })
    .from(buildAttempts)
    .innerJoin(deployments, eq(deployments.id, buildAttempts.deploymentId));

  if (match.attemptId !== null) {
    const [row] = await base
      .where(and(eq(deployments.projectId, projectId), eq(buildAttempts.id, match.attemptId)))
      .limit(1);
    return row?.attempt ?? null;
  }
  if (match.correlationId !== null) {
    const [row] = await base
      .where(
        and(
          eq(deployments.projectId, projectId),
          eq(buildAttempts.dispatchCorrelationId, match.correlationId),
        ),
      )
      .limit(1);
    return row?.attempt ?? null;
  }
  const [row] = await base
    .where(and(eq(deployments.projectId, projectId), eq(buildAttempts.commitSha, claims.sha)))
    .orderBy(desc(buildAttempts.createdAt), desc(buildAttempts.attempt))
    .limit(1);
  return row?.attempt ?? null;
}

// ---------------------------------------------------------------------------
// The context response — server-saved config only
// ---------------------------------------------------------------------------

interface BuildConfigCommands {
  readonly installCommand: string;
  readonly buildCommand: string;
  readonly outputDirectory: string;
}

function configObject(snapshot: unknown, attemptId: string): Readonly<Record<string, unknown>> {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new ApiError(500, "INTERNAL", "the stored build config snapshot is not a JSON object", {
      attemptId,
    });
  }
  return snapshot as Readonly<Record<string, unknown>>;
}

/**
 * Read the commands the operator saved for this attempt. There is deliberately no fallback
 * to the project's current values: serving "whatever the console says now" is exactly the
 * divergence AC-P4-10 forbids, so an incomplete snapshot fails closed instead of guessing.
 */
function configCommands(
  snapshot: Readonly<Record<string, unknown>>,
  attemptId: string,
): BuildConfigCommands {
  const read = (field: string): string => {
    const value = snapshot[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ApiError(500, "INTERNAL", `the stored build config snapshot is missing ${field}`, {
        attemptId,
        field,
      });
    }
    return value;
  };
  return {
    installCommand: read("installCommand"),
    buildCommand: read("buildCommand"),
    outputDirectory: read("outputDirectory"),
  };
}

interface BuildContextResponse {
  readonly attemptId: string;
  readonly deploymentId: string;
  readonly projectId: string;
  readonly attempt: number;
  readonly state: string;
  /** The target source revision, as saved before dispatch; echoed only from the row. */
  readonly commitSha: string;
  /** The workflow revision that runs — a different identity from `commitSha` (§11.3). */
  readonly workflowCommitSha: string;
  readonly configVersion: number;
  readonly configSnapshot: Readonly<Record<string, unknown>>;
  readonly installCommand: string;
  readonly buildCommand: string;
  readonly outputDirectory: string;
  /** Informational: the console has saved a newer config; this attempt keeps its own. */
  readonly configChanged: boolean;
  readonly correlationId: string;
  readonly repository: string;
  readonly ref: string;
  readonly runId: string | null;
}

function buildContextResponse(
  claims: GithubOidcClaims,
  project: Project,
  attempt: BuildAttempt,
): BuildContextResponse {
  const snapshot = configObject(attempt.configSnapshot, attempt.id);
  return {
    attemptId: attempt.id,
    deploymentId: attempt.deploymentId,
    projectId: project.id,
    attempt: attempt.attempt,
    state: attempt.state,
    commitSha: attempt.commitSha,
    workflowCommitSha: attempt.workflowCommitSha,
    configVersion: attempt.configVersion,
    configSnapshot: snapshot,
    ...configCommands(snapshot, attempt.id),
    configChanged: project.configVersion > attempt.configVersion,
    correlationId: attempt.dispatchCorrelationId,
    repository: claims.repository,
    ref: claims.ref,
    runId: claims.runId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Events — one durable, idempotent state transition per attempt
// ---------------------------------------------------------------------------

interface BuildEventOutcome {
  readonly attempt: BuildAttempt;
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly reason: string | null;
}

interface RunIdentity {
  readonly runId: string | null;
  readonly runAttempt: number | null;
}

function requireAttemptState(attempt: BuildAttempt): BuildAttemptState {
  const state = BUILD_ATTEMPT_STATES.find((candidate) => candidate === attempt.state);
  if (state === undefined) {
    // The table CHECK constrains this column, so an unknown value means the row was written
    // around the schema: report it instead of guessing a transition.
    throw new ApiError(500, "INTERNAL", `build attempt ${attempt.id} has an unknown state`, {
      attemptId: attempt.id,
      state: attempt.state,
    });
  }
  return state;
}

/** The run identity a previous event for this attempt recorded, if any. */
function recordedRunIdentity(payload: unknown): RunIdentity {
  if (typeof payload !== "object" || payload === null) return { runId: null, runAttempt: null };
  const record = payload as Record<string, unknown>;
  return {
    runId: typeof record["runId"] === "string" ? record["runId"] : null,
    runAttempt: typeof record["runAttempt"] === "number" ? record["runAttempt"] : null,
  };
}

/**
 * `run_attempt` is an OIDC claim (`run_attempt`), so the preferred check is against the
 * signed value; `GithubOidcClaims` does not expose it as a field yet, and that module
 * belongs to another task, so it is read from the raw claim set without editing the package.
 */
function runAttemptClaim(claims: GithubOidcClaims): number | null {
  const raw = claims.claims["run_attempt"];
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1) return raw;
  if (typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw)) return Number(raw);
  return null;
}

/**
 * Verify the reporting run.
 *
 * `run_id` is signed into the OIDC token, so the body copy must equal it. `run_attempt` is an
 * OIDC claim too, and when the token carries it, the body copy must equal *that*.
 *
 * On top of the token check, the run identity already recorded for this attempt is enforced:
 * a different run may not report here (it is not the run the attempt was dispatched for), and
 * the same run may advance its attempt number — a re-run — but never go back, so a late event
 * from an earlier attempt cannot reopen a settled transition.
 */
function assertRunIdentity(
  claims: GithubOidcClaims,
  event: BuildEventRequest,
  recorded: RunIdentity,
): void {
  if (claims.runId === undefined) {
    throw buildError(
      409,
      "BUILD_CONTEXT_MISMATCH",
      "the OIDC token carries no run_id, so the reporting run cannot be verified",
      { reason: "run_id_claim_missing" },
    );
  }
  if (claims.runId !== event.runId) {
    throw buildError(
      409,
      "BUILD_CONTEXT_MISMATCH",
      "the body names a different run than the OIDC token",
      { reason: "run_id_mismatch", tokenRunId: claims.runId },
    );
  }
  const claimedAttempt = runAttemptClaim(claims);
  if (claimedAttempt !== null && claimedAttempt !== event.runAttempt) {
    throw buildError(
      409,
      "BUILD_CONTEXT_MISMATCH",
      "the body names a different run attempt than the OIDC token",
      { reason: "run_attempt_mismatch", tokenRunAttempt: claimedAttempt },
    );
  }
  if (recorded.runId !== null && recorded.runId !== event.runId) {
    throw buildError(
      409,
      "BUILD_CONTEXT_MISMATCH",
      "a different run has already reported for this attempt; a retry is a new attempt",
      { reason: "run_changed", recordedRunId: recorded.runId },
    );
  }
  if (recorded.runAttempt !== null && event.runAttempt < recorded.runAttempt) {
    throw buildError(
      409,
      "BUILD_CONTEXT_MISMATCH",
      "this event is from an earlier run attempt than one already applied",
      { reason: "stale_run_attempt", recordedRunAttempt: recorded.runAttempt },
    );
  }
}

async function applyBuildEvent(
  deps: ApiDeps,
  claims: GithubOidcClaims,
  attempt: BuildAttempt,
  event: BuildEventRequest,
): Promise<BuildEventOutcome> {
  const target = attemptStateForEvent(event.phase, event.status);
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => {
    // One row lock for the whole read-classify-apply, so two deliveries of the same event
    // cannot both pass the duplicate check.
    const [locked] = await tx
      .select()
      .from(buildAttempts)
      .where(eq(buildAttempts.id, attempt.id))
      .for("update");
    if (locked === undefined) {
      throw buildError(404, "ATTEMPT_NOT_FOUND", "this build attempt no longer exists", {
        attemptId: attempt.id,
      });
    }
    const [priorEvent] = await tx
      .select({ payload: deploymentEvents.payload })
      .from(deploymentEvents)
      .where(
        and(
          eq(deploymentEvents.deploymentId, locked.deploymentId),
          sql`${deploymentEvents.eventType} like 'build_attempt_%'`,
          sql`${deploymentEvents.payload} ->> 'attemptId' = ${locked.id}`,
        ),
      )
      .orderBy(desc(deploymentEvents.id))
      .limit(1);
    assertRunIdentity(claims, event, recordedRunIdentity(priorEvent?.payload));

    const current = requireAttemptState(locked);
    if (target === null) {
      // A per-job success: acknowledged, never terminal, nothing written.
      return {
        attempt: locked,
        applied: false,
        duplicate: false,
        reason: "job_succeeded_is_not_terminal",
      };
    }
    const verdict = classifyAttemptTransition(current, target);
    if (verdict === "duplicate") {
      // A repeated event writes nothing at all: no transition, and `finished_at` keeps the
      // value the original transition stored.
      return { attempt: locked, applied: false, duplicate: true, reason: null };
    }
    if (verdict === "illegal") {
      throw buildError(
        409,
        "ATTEMPT_STATE_CONFLICT",
        `build attempt is ${current} and cannot become ${target}`,
        {
          attemptId: locked.id,
          from: current,
          to: target,
          phase: event.phase,
          status: event.status,
        },
      );
    }

    const [updated] = await tx
      .update(buildAttempts)
      .set({
        state: target,
        updatedAt: now,
        // Only a terminal transition writes `finished_at`; a live one never clears it. The
        // table CHECK requires exactly that pairing.
        ...(isTerminalAttemptState(target) ? { finishedAt: now } : {}),
      })
      .where(eq(buildAttempts.id, locked.id))
      .returning();
    if (updated === undefined) {
      throw new ApiError(500, "INTERNAL", "could not store the build attempt transition", {
        attemptId: locked.id,
      });
    }
    await tx.insert(deploymentEvents).values({
      deploymentId: locked.deploymentId,
      eventType: `build_attempt_${target}`,
      actorKind: "webhook",
      actorId: "github-actions",
      payload: {
        attemptId: locked.id,
        phase: event.phase,
        status: event.status,
        runId: event.runId,
        runAttempt: event.runAttempt,
        correlationId: locked.dispatchCorrelationId,
        commitSha: locked.commitSha,
        workflowCommitSha: locked.workflowCommitSha,
      },
    });
    return { attempt: updated, applied: true, duplicate: false, reason: null };
  });
}

interface BuildEventResponse {
  readonly attemptId: string;
  readonly deploymentId: string;
  readonly state: string;
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly reason?: string;
  readonly finishedAt: string | null;
  readonly runId: string;
  readonly runAttempt: number;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerBuildContextRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post("/v1/builds/context", async (request) => {
    const { claims, project } = await authenticateBuild(deps, request.headers);
    requireBuildEnabled(project);
    const body = readContextRequest(request.body);
    assertBodyRepository(claims, body.repository);
    assertBodyHeadSha(claims, body.headSha);
    const attempt = await resolveAttempt(deps, project, claims, body.match, "context");
    assertWorkflowIdentity(claims, project, attempt);
    return buildContextResponse(claims, project, attempt);
  });

  /**
   * §11.3: an event is a *report*, not a request. `BUILD_DISABLED` is therefore
   * enforced on `/context` (which hands out config a project never authorized) but
   * deliberately NOT here: refusing a dispatched attempt's `failed`/`succeeded`
   * report would strand that attempt live forever, which is exactly the failure the
   * event path exists to prevent (AC-P4-20). The workflow identity and stored
   * attempt are still verified, so this is not an authorization bypass.
   */
  app.post("/v1/builds/events", async (request) => {
    const { claims, project } = await authenticateBuild(deps, request.headers);
    const event = readEventRequest(request.body);
    const attempt = await resolveAttempt(deps, project, claims, event, "event");
    assertWorkflowIdentity(claims, project, attempt);
    if (event.workflowCommitSha !== null && event.workflowCommitSha !== attempt.workflowCommitSha) {
      throw buildError(
        409,
        "BUILD_CONTEXT_MISMATCH",
        "the body names a different workflow version than this attempt was dispatched for",
        {
          reason: "workflow_sha_mismatch",
          attemptId: attempt.id,
          storedWorkflowCommitSha: attempt.workflowCommitSha,
        },
      );
    }
    const outcome = await applyBuildEvent(deps, claims, attempt, event);
    return {
      attemptId: outcome.attempt.id,
      deploymentId: outcome.attempt.deploymentId,
      state: outcome.attempt.state,
      applied: outcome.applied,
      duplicate: outcome.duplicate,
      ...(outcome.reason === null ? {} : { reason: outcome.reason }),
      finishedAt: outcome.attempt.finishedAt?.toISOString() ?? null,
      runId: event.runId,
      runAttempt: event.runAttempt,
    } satisfies BuildEventResponse;
  });
}
