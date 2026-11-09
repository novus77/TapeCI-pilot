/**
 * P4-e: the GitHub workflow-dispatch client (SPEC §11.3).
 *
 * §11.3 needs three distinctions that a plain "call and throw" client cannot make:
 *
 * 1. **Two identities.** `workflowCommitSha` — the workflow that actually runs — and
 *    `commitSha` — the source the platform told the workflow to check out — are
 *    different facts and are stored separately. `findWorkflowRun` reports the run's
 *    own `head_sha`, which for a `workflow_dispatch` run is the commit whose ref tree
 *    supplied the workflow definition. It never derives that value from the target
 *    commit, and it never substitutes the SHA the caller asked about.
 * 2. **"We do not know" is not a failure.** A network error, a timeout, `408`, `429`
 *    or `5xx` means GitHub may or may not have accepted the dispatch. Those outcomes
 *    return `{ dispatched: false, reason: "unknown" }` and never throw, because the
 *    caller must read the run (`findWorkflowRun`) before it considers a second
 *    dispatch. This module performs no retry and no loop of its own.
 * 3. **A duplicate request must not reach GitHub twice.** `idempotencyKey` is sent as
 *    `Idempotency-Key` and is also held in a process-local ledger so an identical
 *    repeated request cannot produce a second `POST`. GitHub does not implement
 *    `Idempotency-Key` for this endpoint, so the durable guard is the
 *    `build_attempts.dispatch_correlation_id` row written *before* dispatch — the
 *    ledger here only covers the window a single process can see.
 *
 * The correlation id (§11.3 "传入关联标识") is **data**: callers put it in `inputs`
 * under the name their workflow declares, and this module forwards it as the request
 * body only. It is never an `authorization` value, and its presence proves nothing —
 * run identity is established afterwards from the authenticated run API and OIDC.
 *
 * Outcomes are deliberately split three ways:
 *
 * | GitHub answer | result |
 * | --- | --- |
 * | any `2xx` (`204` documented) | `{ dispatched: true, status }` |
 * | `408`, `429`, `5xx` | `{ dispatched: false, reason: "unknown", status }` |
 * | no response (network error, or the timeout aborts) | `{ dispatched: false, reason: "unknown", status: 0 }` |
 * | `401`/`403`, `404`, `422`, other `4xx` | throws `GithubError` — a refusal, nothing ran |
 *
 * A refusal is determinate, so it is an error carrying GitHub's own message. Only the
 * ambiguous outcomes are returned, and they are the only ones that can be `unknown`.
 */
import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  getInstallationToken,
  type GetInstallationTokenOptions,
  type GitHubFetch,
} from "./app.js";
import { GithubError } from "./errors.js";

/** One HTTP round trip; a hung dispatch would strand an attempt in `planned`. */
const REQUEST_TIMEOUT_MS = 15_000;
/** GitHub's maximum page size for `/actions/runs`. */
const RUNS_PAGE_SIZE = 100;
/** Pages examined per reconciliation, so a malformed list cannot loop forever. */
const RUNS_MAX_PAGES = 5;
/** Process-local idempotency ledger bound (FIFO eviction when exceeded). */
const LEDGER_LIMIT = 512;
/** `workflow_dispatch` accepts at most 10 inputs. */
const MAX_DISPATCH_INPUTS = 10;
/** Longest GitHub error message kept in an error's details/message. */
const MESSAGE_LIMIT = 300;
const HEX40_RE = /^[0-9a-f]{40}$/;
/** Header-safe token: an unsafe key would make `fetch` throw before anything is sent. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._~:+/=@-]{1,255}$/;
/** One path segment of the workflow URL: a numeric id or a file path. */
const WORKFLOW_SEGMENT_RE = /^[A-Za-z0-9._/-]{1,255}$/;
const REPOSITORY_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Git refs cannot contain whitespace (git's own rule); a control char breaks the URL. */
const REF_RE = /^\S{1,255}$/;

/**
 * Authentication for one call: a ready installation token, or the App credentials
 * needed to mint one. A mint failure throws *before* any dispatch request exists, so
 * it never means "unknown" — nothing could have been dispatched.
 */
export interface InstallationAuth {
  /** Installation access token (`ghs_…`). Never logged, never in an error. */
  readonly token?: string;
  /** App credentials; used only when `token` is absent. */
  readonly installation?: GetInstallationTokenOptions;
}

export interface DispatchWorkflowInput extends InstallationAuth {
  readonly owner: string;
  readonly repo: string;
  /** Numeric workflow id, or its file name (`.github/workflows/tapeci.yml`). */
  readonly workflowId?: string | number;
  /** Workflow file, e.g. `.github/workflows/tapeci.yml` or `tapeci.yml`. */
  readonly workflowFile?: string;
  /**
   * Git reference the workflow runs from (a branch or tag, per GitHub). It pins the
   * workflow *version*; the source commit is `inputs`/build-context business.
   */
  readonly ref: string;
  /** Workflow inputs. The correlation id travels here as data, never as a credential. */
  readonly inputs?: Readonly<Record<string, string>>;
  /** Makes a repeated identical request observable as `already_dispatched`. */
  readonly idempotencyKey?: string;
  readonly fetch?: GitHubFetch;
  readonly apiBaseUrl?: string;
  /** Per-request budget in ms (default {@link REQUEST_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
}

export type DispatchWorkflowResult =
  | { readonly dispatched: true; readonly status: number }
  | {
      readonly dispatched: false;
      readonly reason: "already_dispatched" | "unknown";
      readonly status: number;
      readonly detail: string;
    };

/** The run that reconciles one dispatch; `workflowSha` is the workflow's own commit. */
export interface WorkflowRunIdentity {
  readonly runId: string;
  readonly runAttempt: number;
  /**
   * The run's `head_sha`: the commit whose ref tree supplied the workflow file, i.e.
   * the value stored as `workflowCommitSha`. `null` when GitHub did not report a full
   * SHA for the match.
   */
  readonly workflowSha: string | null;
}

/**
 * Resolve a ref to the commit it points at, so the platform can record WHICH workflow
 * revision will run (§11.3's `workflowCommitSha`) before dispatching. The platform must
 * not guess this: a branch-history build legitimately runs an older workflow than the
 * target source commit, and collapsing the two identities is the defect AC-P4-14 names.
 */
export interface ResolveRefShaInput extends InstallationAuth {
  readonly owner: string;
  readonly repo: string;
  /** Branch or tag name, e.g. `main`. */
  readonly ref: string;
  readonly fetch?: GitHubFetch;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

export interface FindWorkflowRunInput extends InstallationAuth {
  readonly owner: string;
  readonly repo: string;
  /**
   * The commit the dispatch `ref` resolved to. Runs are queried by `head_sha`, so the
   * caller must resolve a branch/tag ref itself; this module will not guess it.
   */
  readonly headSha: string;
  /** Narrow to one workflow. Without it, any `workflow_dispatch` run at that SHA matches. */
  readonly workflowId?: string | number;
  readonly workflowFile?: string;
  /** Ignore runs created before this instant (e.g. the attempt's `createdAt`). */
  readonly createdAfter?: Date;
  readonly fetch?: GitHubFetch;
  readonly apiBaseUrl?: string;
  /** Budget in ms shared by all pages read (default {@link REQUEST_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
}

type LedgerOutcome = "pending" | "dispatched" | "unknown";

interface LedgerEntry {
  readonly outcome: LedgerOutcome;
  readonly status: number;
}

/**
 * Process-local record of what this process has already dispatched. Not durable, and
 * not the guard of record: the attempt row is written before dispatch and its
 * `dispatch_correlation_id` is unique. Eviction is FIFO, so a key can be forgotten —
 * that only ever re-opens the window, it never marks an unknown dispatch as sent.
 */
const dispatchLedger = new Map<string, LedgerEntry>();

/**
 * Dispatch one workflow run.
 *
 * `2xx` means dispatched. `408`/`429`/`5xx`/no-response mean **unknown** and are
 * returned, not thrown, so the caller can read the run first. Every other status is a
 * determinate refusal and throws `GithubError` with GitHub's message.
 */
export async function dispatchWorkflow(
  input: DispatchWorkflowInput,
): Promise<DispatchWorkflowResult> {
  const owner = requireSlug(input.owner, "owner");
  const repo = requireSlug(input.repo, "repo");
  const workflow = workflowSegment(input);
  const ref = requireRef(input.ref);
  const inputs = readDispatchInputs(input.inputs);
  const idempotencyKey =
    input.idempotencyKey === undefined ? null : requireIdempotencyKey(input.idempotencyKey);
  const ledgerKey =
    idempotencyKey === null ? null : `${owner}/${repo}/${workflow}@${ref}#${idempotencyKey}`;

  const previous = ledgerKey === null ? undefined : dispatchLedger.get(ledgerKey);
  if (previous !== undefined) return duplicateResult(previous);

  // Claim before the first await, so a concurrent duplicate cannot slip past the check
  // above while the installation token is being minted.
  if (ledgerKey !== null) remember(ledgerKey, { outcome: "pending", status: 0 });

  const fetchImpl = resolveFetch(input.fetch);
  let token: string;
  try {
    token = await resolveInstallationToken(input, fetchImpl, input.apiBaseUrl);
  } catch (cause) {
    // Nothing was sent, so the key is still free: a corrected call may dispatch.
    if (ledgerKey !== null) dispatchLedger.delete(ledgerKey);
    throw cause;
  }
  const url = `${apiBase(input.apiBaseUrl)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${workflow}/dispatches`;

  let response: Awaited<ReturnType<GitHubFetch>>;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "content-type": "application/json",
        ...(idempotencyKey === null ? {} : { "idempotency-key": idempotencyKey }),
      },
      body: JSON.stringify({ ref, inputs }),
      signal: timeoutSignal(input.timeoutMs),
    });
  } catch (cause) {
    if (ledgerKey !== null) remember(ledgerKey, { outcome: "unknown", status: 0 });
    return { dispatched: false, reason: "unknown", status: 0, detail: networkDetail(cause) };
  }

  if (response.ok) {
    if (ledgerKey !== null) remember(ledgerKey, { outcome: "dispatched", status: response.status });
    return { dispatched: true, status: response.status };
  }

  const status = response.status;
  const message = await readGithubMessage(response);
  if (ambiguousStatus(status)) {
    if (ledgerKey !== null) remember(ledgerKey, { outcome: "unknown", status });
    return {
      dispatched: false,
      reason: "unknown",
      status,
      detail: `GitHub answered HTTP ${status} for the dispatch, so whether the workflow started is unknown${suffix(message)}; read the run before dispatching again`,
    };
  }

  // A determinate refusal: nothing ran, so a corrected call may dispatch with this key.
  if (ledgerKey !== null) dispatchLedger.delete(ledgerKey);
  throw refusalError(status, message, owner, repo);
}

/**
 * Find the run that belongs to a dispatch, or `null` when GitHub reports none.
 *
 * Used to reconcile an `unknown` dispatch (never re-dispatch before this) and to read
 * the workflow's own commit. `null` means "GitHub answered and nothing matched", so it
 * is only safe to re-dispatch on `null` — every failure to *read* throws instead of
 * pretending there is no run.
 */
export async function findWorkflowRun(
  input: FindWorkflowRunInput,
): Promise<WorkflowRunIdentity | null> {
  const owner = requireSlug(input.owner, "owner");
  const repo = requireSlug(input.repo, "repo");
  const headSha = requireHeadSha(input.headSha);
  const workflow = runNarrowing(input);
  const createdAfter = input.createdAfter?.getTime() ?? null;
  if (createdAfter !== null && Number.isNaN(createdAfter)) {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "createdAfter must be a valid Date");
  }
  const fetchImpl = resolveFetch(input.fetch);
  const token = await resolveInstallationToken(input, fetchImpl, input.apiBaseUrl);
  const signal = timeoutSignal(input.timeoutMs);
  const base = `${apiBase(input.apiBaseUrl)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`;
  const candidates: WorkflowRunIdentity[] = [];

  for (let page = 1; page <= RUNS_MAX_PAGES; page += 1) {
    const rows = await readRunsPage(
      `${base}?event=workflow_dispatch&head_sha=${headSha}&per_page=${RUNS_PAGE_SIZE}&page=${page}`,
      token,
      signal,
      fetchImpl,
    );
    for (const row of rows) {
      if (!matchesRun(row, headSha, workflow, createdAfter)) continue;
      candidates.push(requireRunIdentity(row));
    }
    if (rows.length < RUNS_PAGE_SIZE) break;
  }

  if (candidates.length === 0) return null;
  // Runs are listed newest first, but sorting by id makes "newest" explicit rather
  // than dependent on response order.
  return candidates.reduce((newest, run) =>
    Number(run.runId) > Number(newest.runId) ? run : newest,
  );
}

// ---------------------------------------------------------------------------
// Dispatch body + refusal classification
// ---------------------------------------------------------------------------

function duplicateResult(entry: LedgerEntry): DispatchWorkflowResult {
  if (entry.outcome === "dispatched") {
    return {
      dispatched: false,
      reason: "already_dispatched",
      status: entry.status,
      detail: `this Idempotency-Key was already dispatched (HTTP ${entry.status}); dispatching again would start a second run`,
    };
  }
  // `pending` means another call in this process is still waiting on GitHub. It is
  // reported as `unknown` — we genuinely do not know yet — and never as dispatched.
  return {
    dispatched: false,
    reason: "unknown",
    status: entry.status,
    detail:
      entry.outcome === "pending"
        ? "a dispatch with this Idempotency-Key is still in flight in this process; wait for it and then read the run with findWorkflowRun"
        : "this Idempotency-Key was already used and its outcome is still unknown; read the run with findWorkflowRun before dispatching again",
  };
}

function ambiguousStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function refusalError(
  status: number,
  message: string | null,
  owner: string,
  repo: string,
): GithubError {
  const details: Record<string, unknown> =
    message === null ? { status } : { status, githubMessage: message };
  if (status === 401 || status === 403) {
    return new GithubError(
      "GITHUB_API_UNAUTHORIZED",
      `GitHub rejected the installation token for ${owner}/${repo} (HTTP ${status})${suffix(message)}`,
      { retryable: status === 403 && /rate limit|abuse/i.test(message ?? ""), details },
    );
  }
  return new GithubError(
    "GITHUB_API_ERROR",
    `GitHub refused the workflow dispatch for ${owner}/${repo} (HTTP ${status})${suffix(message)}`,
    { retryable: false, details },
  );
}

function networkDetail(cause: unknown): string {
  const raw = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return `no response from GitHub (${sanitize(raw, 200)}); the dispatch may or may not have been accepted, so read the run before dispatching again`;
}

function suffix(message: string | null): string {
  return message === null ? "" : `: ${message}`;
}

// ---------------------------------------------------------------------------
// Run matching
// ---------------------------------------------------------------------------

interface RunNarrowing {
  readonly workflowId: number | null;
  readonly fileName: string | null;
}

function matchesRun(
  row: unknown,
  headSha: string,
  workflow: RunNarrowing,
  createdAfter: number | null,
): row is Record<string, unknown> {
  if (!isRecord(row)) return false;
  const rowSha = row["head_sha"];
  // A row that does not state our commit cannot be the run this dispatch produced.
  if (typeof rowSha !== "string" || rowSha.toLowerCase() !== headSha) return false;
  const event = row["event"];
  if (typeof event === "string" && event !== "workflow_dispatch") return false;
  if (workflow.workflowId !== null && row["workflow_id"] !== workflow.workflowId) return false;
  if (workflow.fileName !== null && !pathMatchesFile(row["path"], workflow.fileName)) return false;
  if (createdAfter !== null) {
    const createdAt = row["created_at"];
    if (typeof createdAt === "string") {
      const parsed = new Date(createdAt).getTime();
      // An unreadable timestamp is not evidence that the run is old.
      if (!Number.isNaN(parsed) && parsed < createdAfter) return false;
    }
  }
  return true;
}

function requireRunIdentity(row: Record<string, unknown>): WorkflowRunIdentity {
  const id = row["id"];
  const runAttempt = row["run_attempt"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new GithubError(
      "GITHUB_API_INVALID_RESPONSE",
      "a matching workflow run is missing a usable id",
    );
  }
  if (typeof runAttempt !== "number" || !Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw new GithubError(
      "GITHUB_API_INVALID_RESPONSE",
      "a matching workflow run is missing a usable run_attempt",
    );
  }
  const sha = row["head_sha"];
  return {
    runId: String(id),
    runAttempt,
    // The run's own commit, never the SHA this call asked about.
    workflowSha: typeof sha === "string" && HEX40_RE.test(sha.toLowerCase()) ? sha.toLowerCase() : null,
  };
}

function pathMatchesFile(path: unknown, fileName: string): boolean {
  if (typeof path !== "string") return false;
  return path === fileName || path.endsWith(`/${fileName}`);
}

// ---------------------------------------------------------------------------
// Request inputs
// ---------------------------------------------------------------------------

/**
 * Resolve a branch or tag to its current commit SHA.
 *
 * Returns `null` only when GitHub answered and the ref does not exist; a failed read
 * throws, because "we could not ask" must never be treated as "there is no such ref"
 * and silently become a wrong `workflowCommitSha`.
 */
export async function resolveRefSha(input: ResolveRefShaInput): Promise<string | null> {
  const owner = requireSlug(input.owner, "owner");
  const repo = requireSlug(input.repo, "repo");
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (ref.length === 0) {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "ref is required");
  }
  const fetchImpl = resolveFetch(input.fetch);
  const token = await resolveInstallationToken(input, fetchImpl, input.apiBaseUrl);
  const signal = timeoutSignal(input.timeoutMs);
  const url = `${apiBase(input.apiBaseUrl)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;

  let response: Awaited<ReturnType<GitHubFetch>>;
  try {
    response = await fetchImpl(url, { method: "GET", headers: githubHeaders(token), signal });
  } catch (cause) {
    throw new GithubError("GITHUB_API_ERROR", "GitHub API request failed", {
      retryable: true,
      cause,
    });
  }
  if (response.status === 404 || response.status === 422) {
    // GitHub answered: the ref genuinely does not resolve.
    await response.text().catch(() => undefined);
    return null;
  }
  if (!response.ok) {
    const message = await readGithubMessage(response);
    throw new GithubError(
      response.status === 401 || response.status === 403
        ? "GITHUB_API_UNAUTHORIZED"
        : "GITHUB_API_ERROR",
      `GitHub returned HTTP ${response.status} while resolving the ref${suffix(message)}`,
      { retryable: response.status >= 500 },
    );
  }
  const body: unknown = await response.json().catch(() => null);
  const sha = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["sha"] : undefined;
  // Same 40-hex guard the run identity uses: anything else is not a commit SHA.
  return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha.toLowerCase())
    ? sha.toLowerCase()
    : null;
}

async function readRunsPage(
  url: string,
  token: string,
  signal: AbortSignal,
  fetchImpl: GitHubFetch,
): Promise<readonly unknown[]> {
  let response: Awaited<ReturnType<GitHubFetch>>;
  try {
    response = await fetchImpl(url, { method: "GET", headers: githubHeaders(token), signal });
  } catch (cause) {
    throw new GithubError("GITHUB_API_ERROR", "GitHub API request failed", {
      retryable: true,
      cause,
    });
  }
  if (!response.ok) {
    const message = await readGithubMessage(response);
    const details: Record<string, unknown> =
      message === null ? { status: response.status } : { status: response.status, githubMessage: message };
    throw new GithubError(
      response.status === 401 || response.status === 403
        ? "GITHUB_API_UNAUTHORIZED"
        : "GITHUB_API_ERROR",
      `GitHub returned HTTP ${response.status} while reading workflow runs${suffix(message)}`,
      {
        retryable: response.status >= 500 || response.status === 429 || response.status === 408,
        details,
      },
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new GithubError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub workflow runs response was not valid JSON",
      { cause },
    );
  }
  const rows = isRecord(body) ? body["workflow_runs"] : undefined;
  if (!Array.isArray(rows)) {
    throw new GithubError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub workflow runs response is missing workflow_runs",
    );
  }
  return rows;
}

async function readGithubMessage(response: Awaited<ReturnType<GitHubFetch>>): Promise<string | null> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const message = parsed["message"];
      if (typeof message === "string" && message.trim().length > 0) {
        return sanitize(message, MESSAGE_LIMIT);
      }
    }
  } catch {
    // Not JSON; the raw body is still the best description GitHub gave us.
  }
  return sanitize(raw, MESSAGE_LIMIT);
}

async function resolveInstallationToken(
  auth: InstallationAuth,
  fetchImpl: GitHubFetch,
  apiBaseUrl: string | undefined,
): Promise<string> {
  if (auth.token !== undefined) {
    const token = auth.token.trim();
    if (token.length > 0) return token;
  }
  if (auth.installation !== undefined) {
    // The injected fetch/base URL must reach the mint too, or a test would call GitHub.
    const { token } = await getInstallationToken({
      ...auth.installation,
      fetch: auth.installation.fetch ?? fetchImpl,
      ...(auth.installation.apiBaseUrl === undefined && apiBaseUrl !== undefined
        ? { apiBaseUrl }
        : {}),
    });
    return token;
  }
  throw new GithubError("GITHUB_API_UNAUTHORIZED", "installation token is required");
}

function resolveFetch(fetchImpl: GitHubFetch | undefined): GitHubFetch {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (typeof resolved !== "function") {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "no fetch implementation is available");
  }
  return resolved;
}

function apiBase(apiBaseUrl: string | undefined): string {
  return (apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "");
}

function timeoutSignal(timeoutMs: number | undefined): AbortSignal {
  const ms = timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "timeoutMs must be a positive integer");
  }
  return AbortSignal.timeout(ms);
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "tapeci-github-app",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

function requireSlug(value: string, field: "owner" | "repo"): string {
  const raw = value.trim();
  if (!REPOSITORY_SLUG_RE.test(raw)) {
    throw new GithubError(
      "GITHUB_APP_CONFIG_INVALID",
      field === "owner" ? "owner must be a GitHub account name" : "repo must be a GitHub repository name",
      { details: { field } },
    );
  }
  return raw;
}

function requireRef(value: string): string {
  const raw = value.trim();
  if (!REF_RE.test(raw) || hasControlChars(raw)) {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "ref must be a git branch or tag name");
  }
  return raw;
}

/**
 * A control character would make `fetch` throw before anything was sent; rejecting it
 * here keeps such a malformed input from being reported as an `unknown` dispatch.
 */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function requireHeadSha(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!HEX40_RE.test(raw)) {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "headSha must be a full 40-character commit SHA");
  }
  return raw;
}

function requireIdempotencyKey(value: string): string {
  const raw = value.trim();
  if (!IDEMPOTENCY_KEY_RE.test(raw)) {
    throw new GithubError(
      "GITHUB_APP_CONFIG_INVALID",
      "idempotencyKey must be 1-255 characters from [A-Za-z0-9._~:+/=@-] so it can be sent as a header",
      { details: { length: raw.length } },
    );
  }
  return raw;
}

function workflowSegment(input: {
  readonly workflowId?: string | number;
  readonly workflowFile?: string;
}): string {
  if (input.workflowId !== undefined) {
    if (typeof input.workflowId === "number") {
      if (!Number.isSafeInteger(input.workflowId) || input.workflowId <= 0) {
        throw new GithubError("GITHUB_APP_CONFIG_INVALID", "workflowId must be a positive integer");
      }
      return String(input.workflowId);
    }
    return workflowPath(input.workflowId, "workflowId");
  }
  if (input.workflowFile !== undefined) return workflowPath(input.workflowFile, "workflowFile");
  throw new GithubError("GITHUB_APP_CONFIG_INVALID", "workflowId or workflowFile is required");
}

/** Normalize `.github/workflows/x.yml` / `x.yml` into a URL-safe path segment. */
function workflowPath(value: string, field: string): string {
  const trimmed = value.trim();
  const path = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const segments = path.split("/");
  if (
    !WORKFLOW_SEGMENT_RE.test(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GithubError(
      "GITHUB_APP_CONFIG_INVALID",
      `${field} must be a workflow file name or path, without ".." or empty segments`,
      { details: { field } },
    );
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function runNarrowing(input: {
  readonly workflowId?: string | number;
  readonly workflowFile?: string;
}): RunNarrowing {
  if (input.workflowId !== undefined) {
    // A numeric string is an id here too, so both call shapes narrow the same way.
    const numeric = toWorkflowNumber(input.workflowId);
    if (numeric !== null) return { workflowId: numeric, fileName: null };
    return { workflowId: null, fileName: workflowPath(String(input.workflowId), "workflowId") };
  }
  if (input.workflowFile !== undefined) {
    return { workflowId: null, fileName: workflowPath(input.workflowFile, "workflowFile") };
  }
  return { workflowId: null, fileName: null };
}

/** `123` and `"123"` both mean workflow id 123; anything else is not an id. */
function toWorkflowNumber(value: string | number): number | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new GithubError("GITHUB_APP_CONFIG_INVALID", "workflowId must be a positive integer");
    }
    return value;
  }
  const raw = value.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readDispatchInputs(
  inputs: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (inputs === undefined) return {};
  const entries = Object.entries(inputs);
  if (entries.length > MAX_DISPATCH_INPUTS) {
    throw new GithubError(
      "GITHUB_APP_CONFIG_INVALID",
      `a workflow_dispatch accepts at most ${MAX_DISPATCH_INPUTS} inputs`,
      { details: { count: entries.length } },
    );
  }
  const body: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.trim().length === 0) {
      throw new GithubError("GITHUB_APP_CONFIG_INVALID", "dispatch input names must not be empty");
    }
    body[key] = value;
  }
  return body;
}

function remember(key: string, entry: LedgerEntry): void {
  dispatchLedger.set(key, entry);
  while (dispatchLedger.size > LEDGER_LIMIT) {
    const oldest = dispatchLedger.keys().next();
    if (oldest.done === true) break;
    dispatchLedger.delete(oldest.value);
  }
}

function sanitize(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
